/**
 * 后台标签页里的「等一下」（2026-09-23 在真实 Chrome 里量到）。
 *
 * 用户按下「自动填写」之后切到别的标签页或别的应用（或者窗口被挡住、最小化），页面就是
 * `document.visibilityState === 'hidden'`。这时：
 *
 *  · `requestAnimationFrame` 整个停掉——等了 1.5 秒以上，一帧都没来；
 *  · 每个 `setTimeout` 都被压到约一秒一次——10 毫秒的计时器 1018 毫秒才到。
 *
 * 而 MessageChannel 的消息不受这两样影响（它不是计时器，也不跟着帧走）：React 的调度器自己就靠
 * 它在后台照常把更新刷完。所以这里只有一个原语——**宿主任务**：往一个 MessageChannel 里投一条
 * 消息，等它回来。其余三个都是它的用法：
 *
 *  · `scheduleHostStep`：结算排程里的一步。看得见时是一帧或一个 setTimeout(0)，与从前逐字相同；
 *    看不见时是一个宿主任务；等的途中页面变成看不见，撤掉那一帧／那个计时器，改等宿主任务。
 *  · `hostDelay`：轮询间隔（「隔 20 毫秒看一眼」）。看得见时就是 setTimeout(ms)；看不见时按墙钟
 *    一格一格地过宿主任务，直到时间到，不再被拖成一秒一格。
 *  · `nextHostTask`：跨一个任务边界，看得见与否都走宿主任务（runner 让 MutationObserver 送达）。
 *
 * ## 刻意**不**换的
 *
 * 延时复检那类窗口（`lateRecheckMs`）：它等的是「宿主自己排下的计时器跑完没有」。宿主的计时器在
 * 后台同样被压到一秒一次，按墙钟等 250 毫秒会在它们跑之前就去读——那一读什么也证明不了。那类窗口
 * 继续用 setTimeout，跟宿主走同一只（被节流的）钟：后台里慢一点，但读到的是真话。
 *
 * ## 代价
 *
 * 看不见时的 `hostDelay` 是一串连续的宿主任务，等多久就连着占多久主线程（每一格之间宿主照常插队
 * 跑它自己的任务）。所以它只替短的等待这么做（HIDDEN_DELAY_MAX_MS 以内）；更长的等待被节流也只
 * 多出不到一秒，照旧用计时器。另有一个按格数计的上限，只防时钟不走。
 */

type Cancel = () => void;

/** 这一刻内容脚本所在的那个文档；没有 DOM 的运行时没有文档（null），一律按「看得见」走原来的排程。 */
function currentDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/** 文档此刻是否看不见（后台标签页、最小化、被挡住）。 */
export function documentHidden(doc: Document | null = currentDocument()): boolean {
  return doc !== null && doc.visibilityState === 'hidden';
}

/**
 * 投一个宿主任务：MessageChannel 的一条消息，不受后台计时器节流，也不跟着帧停。没有
 * MessageChannel 的运行时退回 setTimeout(0)。返回的函数撤掉还没跑的那一个。
 */
export function postHostTask(callback: () => void): Cancel {
  if (typeof MessageChannel !== 'function') {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }
  const channel = new MessageChannel();
  let pending = true;
  const close = (): void => {
    pending = false;
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
  };
  channel.port1.onmessage = () => {
    if (!pending) return;
    close();
    callback();
  };
  channel.port2.postMessage(undefined);
  return () => {
    if (pending) close();
  };
}

/** 跨一个真的任务边界（宿主任务），不管页面看不看得见。 */
export function nextHostTask(): Promise<void> {
  return new Promise<void>((resolve) => {
    postHostTask(resolve);
  });
}

function requestFrame(callback: () => void): Cancel {
  if (typeof requestAnimationFrame === 'function') {
    const frame = requestAnimationFrame(callback);
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    };
  }
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

function requestMacrotask(callback: () => void): Cancel {
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

export type HostStepKind = 'frame' | 'macrotask';
/** 一步此刻在等什么；`task` 是宿主任务，`done` 是跑完了或撤掉了。 */
export type HostStepWait = HostStepKind | 'task' | 'done';

export interface HostStep {
  readonly waitingOn: () => HostStepWait;
  /**
   * 页面已经看不见、这一步还在等帧或计时器：撤掉它、改等一个宿主任务，返回 true。
   * `visibilitychange` 平时会自己触发这件事；它被页面拦下没送到时，调用方（看门狗）靠这个补上。
   */
  readonly moveToTaskIfHidden: () => boolean;
  readonly cancel: () => void;
}

/**
 * 结算排程里的一步。页面看得见：`frame` 是一帧（requestAnimationFrame，没有就 setTimeout(0)），
 * `macrotask` 是一个 setTimeout(0)——与从前逐字相同。看不见：一个宿主任务。看得见时排下的那一步，
 * 等的途中页面变成看不见，就撤掉它、改等宿主任务——帧在看不见的页面里永远不来。
 */
export function scheduleHostStep(
  kind: HostStepKind,
  callback: () => void,
  doc: Document | null = currentDocument(),
): HostStep {
  let waiting: HostStepWait = 'done';
  let cancelPending: Cancel | null = null;
  let listening = false;

  const stopListening = (): void => {
    if (!listening) return;
    listening = false;
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
  };
  const run = (): void => {
    if (waiting === 'done') return;
    waiting = 'done';
    cancelPending = null;
    stopListening();
    callback();
  };
  const moveToTaskIfHidden = (): boolean => {
    if ((waiting !== 'frame' && waiting !== 'macrotask') || !documentHidden(doc)) return false;
    cancelPending?.();
    stopListening();
    waiting = 'task';
    cancelPending = postHostTask(run);
    return true;
  };
  function onVisibilityChange(): void {
    moveToTaskIfHidden();
  }

  if (documentHidden(doc)) {
    waiting = 'task';
    cancelPending = postHostTask(run);
  } else {
    waiting = kind;
    cancelPending = kind === 'frame' ? requestFrame(run) : requestMacrotask(run);
    if (doc !== null) {
      doc.addEventListener('visibilitychange', onVisibilityChange);
      listening = true;
    }
  }

  return {
    waitingOn: () => waiting,
    moveToTaskIfHidden,
    cancel: () => {
      if (waiting === 'done') return;
      waiting = 'done';
      cancelPending?.();
      cancelPending = null;
      stopListening();
    },
  };
}

/**
 * 看不见时，多长以内的等待改成一格一格地过宿主任务。节流把计时器对齐到约一秒一次，对 20 毫秒的
 * 轮询是五十倍，对一秒以上的等待只多出不到一秒——后者照旧用计时器，不值得连着占主线程。
 */
export const HIDDEN_DELAY_MAX_MS = 1_000;

/**
 * 看不见时一次 `hostDelay` 最多过多少个宿主任务：每毫秒一千格（一个宿主任务在浏览器里远不止
 * 一微秒，所以正常的时钟永远先到）。只防时钟不走：那时靠它结束，而不是永远转下去。
 */
const HIDDEN_DELAY_HOPS_PER_MS = 1_000;

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * 轮询间隔：等 `ms` 毫秒。页面看得见：一个 setTimeout(ms)，与从前逐字相同。看不见（开始时就
 * 看不见，或等的途中变成看不见）：按墙钟一格一格地过宿主任务，至少一格，直到时间到——后台里的
 * setTimeout(ms) 会被拖到一秒以上。一格一格地过的途中页面又看得见了，剩下的时间交回 setTimeout。
 * 长于 HIDDEN_DELAY_MAX_MS 的等待不管看不看得见都只用计时器，见文件头「代价」。
 *
 * 到时返回 true；被 `signal` 叫停返回 false（不再等）。
 */
export function hostDelay(
  ms: number,
  signal?: AbortSignal,
  doc: Document | null = currentDocument(),
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  const duration = Number.isFinite(ms) && ms > 0 ? ms : 0;
  // 长的等待不看可见性：只用计时器。
  const watched = duration > HIDDEN_DELAY_MAX_MS ? null : doc;
  return new Promise<boolean>((resolve) => {
    const deadline = monotonicNow() + duration;
    const maxHops = Math.max(1, Math.ceil(duration)) * HIDDEN_DELAY_HOPS_PER_MS;
    let hops = 0;
    let mode: 'timer' | 'hopping' = 'timer';
    let done = false;
    let cancelPending: Cancel | null = null;

    const finish = (completed: boolean): void => {
      if (done) return;
      done = true;
      cancelPending?.();
      cancelPending = null;
      watched?.removeEventListener('visibilitychange', onVisibilityChange);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed && signal?.aborted !== true);
    };
    function onAbort(): void {
      finish(false);
    }
    const waitOnTimer = (remaining: number): void => {
      mode = 'timer';
      const timer = setTimeout(() => finish(true), remaining);
      cancelPending = () => clearTimeout(timer);
    };
    const postHop = (): void => {
      mode = 'hopping';
      hops += 1;
      cancelPending = postHostTask(afterHop);
    };
    function afterHop(): void {
      cancelPending = null;
      if (done) return;
      const remaining = deadline - monotonicNow();
      if (remaining <= 0 || hops >= maxHops) {
        finish(true);
        return;
      }
      if (!documentHidden(watched)) {
        waitOnTimer(remaining);
        return;
      }
      postHop();
    }
    function onVisibilityChange(): void {
      if (done || mode !== 'timer' || !documentHidden(watched)) return;
      // 看得见时排下的计时器在后台会被拖到一秒以上：撤掉它，剩下的时间改成一格一格地过。
      cancelPending?.();
      cancelPending = null;
      postHop();
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    watched?.addEventListener('visibilitychange', onVisibilityChange);
    if (documentHidden(watched)) postHop();
    else waitOnTimer(duration);
  });
}
