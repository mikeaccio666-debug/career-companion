/**
 * 附上简历之后，宿主什么时候「安静下来」（2026-09-24）。
 *
 * 有的宿主收到简历之后自己解析，隔一两秒把别的栏改写掉：测试台 2026-09-24 量到 Rippling 把我们填好的
 * 姓名、邮箱、电话、LinkedIn 改成它从简历里读的，Lever 把我们填好的地点清空。计划把文件排在最后
 * （Greenhouse 收下文件会换掉上传控件、挪动后面的序号），所以这些回写全落在我们写完之后。手势路在
 * 附上简历之后先等宿主安静下来，再决定第二遍要不要重写、面板上怎么照实说。
 *
 * 「安静」= 表单范围里连续 `quietMs` 没有 DOM 变动，而且各栏的值也没变——受控框架改 `value` 属性
 * 不一定留下 MutationRecord，所以另外比一份值的指纹（只在内存里比，不落任何地方）。最多等 `capMs`；
 * 被叫停（用户按停止、页面换代）立刻返回。
 *
 * 后台标签页里定时器会被节流到约一秒一次：每一跳都按墙钟判，所以最迟晚一跳结束，不会无限等。
 * 不用 requestAnimationFrame——后台标签页里它根本不跑。
 */

export type HostQuietOutcome = 'QUIET' | 'CAPPED' | 'ABORTED';

export interface HostQuietResult {
  readonly outcome: HostQuietOutcome;
  /** 实际等了多久（毫秒，墙钟）。 */
  readonly waitedMs: number;
}

export interface HostQuietInput {
  /** 看哪几棵子树的变动（表单容器与它里面打开的 shadow root）。 */
  readonly targets: readonly Node[];
  /** 各栏值的指纹；两次不同就算「还在变」。 */
  readonly fingerprint?: () => string;
  readonly quietMs: number;
  readonly capMs: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /** 两次查看之间的间隔；缺省 100 毫秒。 */
  readonly tickMs?: number;
}

const DEFAULT_TICK_MS = 100;

export function waitForHostQuiet(input: HostQuietInput): Promise<HostQuietResult> {
  const now = input.now ?? (() => Date.now());
  const tickMs = input.tickMs ?? DEFAULT_TICK_MS;
  const started = now();
  // 指纹读不出来（宿主的 getter 抛了）就当它没变：那不是「还在变」的证据，墙钟上限照样兜底。
  const print = (): string => {
    try {
      return input.fingerprint?.() ?? '';
    } catch {
      return '';
    }
  };
  return new Promise<HostQuietResult>((resolve) => {
    let lastChange = started;
    let lastPrint = print();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let observer: MutationObserver | null = null;
    let done = false;
    const finish = (outcome: HostQuietOutcome): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      observer?.disconnect();
      input.signal?.removeEventListener('abort', onAbort);
      resolve({ outcome, waitedMs: Math.max(0, now() - started) });
    };
    const onAbort = (): void => finish('ABORTED');
    if (input.signal?.aborted) {
      finish('ABORTED');
      return;
    }
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      observer = new MutationObserver(() => {
        lastChange = now();
      });
      for (const target of input.targets) {
        observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
      }
    } catch {
      // 看不了变动（节点已不在、环境不给）：只比值的指纹，上限照旧兜底。
      observer?.disconnect();
      observer = null;
    }
    const tick = (): void => {
      if (done) return;
      const at = now();
      const current = print();
      if (current !== lastPrint) {
        lastPrint = current;
        lastChange = at;
      }
      if (at - lastChange >= input.quietMs) {
        finish('QUIET');
        return;
      }
      if (at - started >= input.capMs) {
        finish('CAPPED');
        return;
      }
      timer = setTimeout(tick, tickMs);
    };
    timer = setTimeout(tick, tickMs);
  });
}

/** 用户亲手动过哪些栏：只认浏览器标了 isTrusted 的编辑事件，我们自己派发的事件都不是。 */
export interface TrustedEditWatch {
  /** 这一栏（单选／复选按同名的一组算）从开始看到现在，用户亲手动过吗。 */
  readonly touched: (element: Element) => boolean;
  /** 停止监听；已经记下的照旧答得出来。 */
  readonly stop: () => void;
}

const EDIT_EVENTS = ['beforeinput', 'input', 'change'] as const;

export function watchTrustedEdits(doc: Document): TrustedEditWatch {
  const edited = new Set<Element>();
  const onEdit = (event: Event): void => {
    if (!event.isTrusted) return;
    // shadow 里的控件：文档层看到的 target 是宿主节点，composedPath 的第一个才是那个控件。
    const origin = event.composedPath()[0] ?? event.target;
    if (origin !== null && typeof origin === 'object' && (origin as Node).nodeType === 1) edited.add(origin as Element);
  };
  for (const type of EDIT_EVENTS) doc.addEventListener(type, onEdit, true);
  let stopped = false;
  return {
    touched: (element) => {
      if (edited.has(element)) return true;
      const type = element.getAttribute('type');
      const name = element.getAttribute('name');
      if ((type !== 'radio' && type !== 'checkbox') || name === null || name === '') return false;
      for (const other of edited) {
        if (other.getAttribute('type') === type && other.getAttribute('name') === name) return true;
      }
      return false;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const type of EDIT_EVENTS) doc.removeEventListener(type, onEdit, true);
    },
  };
}
