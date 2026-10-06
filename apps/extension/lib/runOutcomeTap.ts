import type {
  AutofillDockFieldRow,
  AutofillDockHandle,
  AutofillDockProgress,
  DockAdvanceOutcome,
  DockChainState,
  DockChainStop,
  DockRetireReason,
  DockRunOutcome,
  DockRunStep,
  DockSubmitOutcome,
} from './autofillDock';
import {
  RUN_MAX_CHAIN_PAGES,
  chainStopReason,
  countBucket,
  createDockRunOutcome,
  durationBucket,
  fillRateBucket,
  newRunId,
  runOutcomeConsistent,
  runReason,
  submitOutcomeOf,
  type DockRunOutcomeMessage,
  type RunLane,
  type RunOutcome,
  type RunOutcomeEvent,
  type RunReason,
  type RunSubmitOutcome,
  type RunVendor,
} from './runOutcome';

/**
 * 一轮自动填写怎么收场，从浮层上看（2026-10-04，前端体检 11-1）。
 *
 * 内容脚本把挂上的浮层包一层（`observe`）：这一轮给浮层的那几下收场——`finishRun`、`reportBlocked`、`retireRun`、
 * `setChain`（连填停在哪）、`autoAdvance`（连填替他翻页）——原样转给浮层，同时记下这一轮的结局。用户在浮层上看到什么，
 * 上报的就是什么；不必在填写那条长路的每一个出口另记一笔。浮层上看不到的两件事由调用方说：一轮开始（`begin`，带这一轮的
 * 「停止」信号）、他在浮层里按的「提交」（`pressed`）；页面要走了（`pageHidden`）。
 *
 * 数从这一轮最后交给浮层的那份单子里数（`beginRun` / `update`）：列出几栏、写上几栏（规则或 AI）、几项必填留给他、
 * AI 写了几栏、代填了几栏条款与签名；网页上还空着的必填现看一眼（只判断有没有值）。全部分桶，原文、标签、值一样都不出去。
 *
 * 什么时候交：
 *  · 这一页还可能在浮层里按「提交」（填过、没失败、没停、连填没翻走）：收场时先交一份草稿（`final: false`），worker 先拿着；
 *    他按了「提交」、新的一轮开始、离开页面时交终稿。按下去那一刻先交一份「按了」：整页跳走时 worker 手里至少有这一条。
 *  · 别的收场一次交终稿。
 *
 * 上报这一侧出了任何错都不碰浮层与填写：每一下先转给浮层，记录包在 try 里（错误交给 `onError`，只记一个码）。
 */
export interface RunOutcomeTapDeps {
  readonly send: (message: DockRunOutcomeMessage) => void;
  /** 这一页是哪一家、怎么认出来的（与扫描同一个判据）；收场那一刻问一次。 */
  readonly page: () => Readonly<{ vendor: RunVendor; lane: RunLane }>;
  /** 网页上那一栏此刻有没有值（只判断有没有）。 */
  readonly hasValue: (target: Element) => boolean;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly onError?: (error: unknown) => void;
}

export interface RunOutcomeTap {
  /**
   * 一轮开始（`runGestureFill`）。`continuesChain`：这一轮是连填翻到的下一页。`signal`：这一轮的「停止」；
   * `superseded`：停下那一刻问——是不是新的一轮把它顶掉了（不是他按的）。
   */
  begin(input: Readonly<{ continuesChain: boolean; signal: AbortSignal; superseded: () => boolean }>): void;
  /** 包一层挂上的浮层：收场的那几下照转，同时记下来。 */
  observe(dock: AutofillDockHandle): AutofillDockHandle;
  /** 接下来那一下 `retireRun('ADVANCED')` 的原因（连填翻到的这一页不能用那一轮的凭证写时，连填的停因）。 */
  note(reason: string): void;
  /**
   * 他在浮层里按了「提交」：结局归这一页刚收场的那一轮。名字刻意不叫 submit：随包 JS 里不许出现那个调用的字样
   * （RULE-EXT-NEVER-SUBMIT 的字节闸）。
   */
  pressed(pending: Promise<DockSubmitOutcome>): void;
  /** 页面要走了（整页跳走、关标签页、进往返缓存）：还开着的都交终稿。 */
  pageHidden(): void;
}

/** 准备时按了「停止」，浮层上不会再有收场的那一下：等这么久还没收场，就照「已停止」交。 */
const STOP_SETTLE_MS = 3_000;

type Phase = 'running' | 'advancing' | 'concluded' | 'sent';

interface Counts {
  readonly planned: number;
  readonly filled: number;
  readonly needsYou: number;
  readonly aiAnswered: number;
  readonly signedOnBehalf: number;
  readonly requiredEmptyOnPage: number;
}

interface Run {
  readonly id: string;
  readonly startedAt: number;
  readonly continuesChain: boolean;
  phase: Phase;
  chainPage: number;
  chainStop: DockChainStop | null;
  progress: AutofillDockProgress | null;
  /** 浮层收到过这一轮的单子（扫出了表、开写了）。 */
  sawRun: boolean;
  /** 扫出了表（浮层走到「正在准备要填的内容」那一步）：这一页之后还可能在浮层里按「提交」。 */
  scanned: boolean;
  stop: 'USER' | 'SUPERSEDED' | null;
  stopAt: number | null;
  noted: string | null;
  /** 这一页填完的那一刻（连填交给翻页之前）。 */
  filledAt: number | null;
  counts: Counts | null;
  outcome: RunOutcome | null;
  reason: RunReason | undefined;
  endedAt: number;
  submit: RunSubmitOutcome;
}

const ZERO: Counts = Object.freeze({ planned: 0, filled: 0, needsYou: 0, aiAnswered: 0, signedOnBehalf: 0, requiredEmptyOnPage: 0 });

/** 一栏写上了没有（行态缺省时看 done）。 */
const written = (row: AutofillDockFieldRow): boolean =>
  row.state === undefined ? row.done : row.state === 'CONFIRMED' || row.state === 'UNVERIFIED';
/** 必填里算「不用他管」的：写上并确认过、网页上本来就有。与连填的 `requiredNeedsIn` 同一个口径。 */
const settled = (row: AutofillDockFieldRow): boolean =>
  row.state === undefined ? row.done : row.state === 'CONFIRMED' || row.state === 'PRESERVED';

export function createRunOutcomeTap(deps: RunOutcomeTapDeps): RunOutcomeTap {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => newRunId());
  let current: Run | null = null;

  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      try {
        deps.onError?.(error);
      } catch {
        // 上报通道自己坏了：浮层与填写照常，这里没有第二条路可报。
      }
    }
  };

  const countsOf = (run: Run): Counts => {
    const rows = run.progress?.rows ?? [];
    if (rows.length === 0) return ZERO;
    return {
      planned: rows.length,
      filled: rows.filter(written).length,
      needsYou: rows.filter((row) => row.required && !settled(row)).length,
      aiAnswered: rows.filter((row) => row.aiAnswered === true).length,
      signedOnBehalf: rows.filter((row) => row.signedOnBehalf !== undefined && written(row)).length,
      requiredEmptyOnPage: rows.filter((row) => row.required && row.target !== undefined && !deps.hasValue(row.target)).length,
    };
  };

  const eventOf = (run: Run): RunOutcomeEvent => {
    const counts = run.counts ?? ZERO;
    const { vendor, lane } = deps.page();
    let outcome = run.outcome as RunOutcome;
    let reason = run.reason;
    // 连填的结局要有页号；万一没有（不该发生），照非连填的说法交，免得服务端整批拒收。
    if ((outcome === 'CHAIN_ADVANCED' || outcome === 'CHAIN_STOPPED') && run.chainPage === 0) {
      outcome = outcome === 'CHAIN_ADVANCED' ? 'STOPPED' : 'FAILED';
      reason = outcome === 'STOPPED' ? undefined : reason ?? 'OTHER';
    }
    const event: RunOutcomeEvent = {
      runId: run.id,
      vendor,
      lane,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      planned: countBucket(counts.planned),
      filled: countBucket(counts.filled),
      needsYou: countBucket(counts.needsYou),
      aiAnswered: countBucket(counts.aiAnswered),
      signedOnBehalf: countBucket(counts.signedOnBehalf),
      requiredEmptyOnPage: countBucket(counts.requiredEmptyOnPage),
      fillRate: fillRateBucket(counts.filled, counts.planned),
      durationBucket: durationBucket(run.endedAt - run.startedAt),
      chainPages: Math.min(Math.max(0, run.chainPage), RUN_MAX_CHAIN_PAGES),
      submitOutcome: run.submit,
    };
    if (!runOutcomeConsistent(event)) throw new Error('RUN_OUTCOME_INCONSISTENT');
    return event;
  };

  const send = (run: Run, final: boolean): void => {
    guard(() => deps.send(createDockRunOutcome(eventOf(run), final)));
  };

  /** 这一页之后还可能在浮层里按「提交」：扫出了表、没失败、没停、连填没翻走。 */
  const submittable = (run: Run): boolean =>
    (run.scanned || run.sawRun) && (run.outcome === 'FILLED_ALL' || run.outcome === 'NEEDS_YOU' || run.outcome === 'NOTHING_FILLED' ||
      (run.outcome === 'CHAIN_STOPPED' && run.reason !== 'MOVED'));

  const conclude = (run: Run, outcome: RunOutcome, reason?: RunReason, at?: number): void => {
    if (run.phase === 'concluded' || run.phase === 'sent') return;
    run.counts ??= countsOf(run);
    run.outcome = outcome;
    run.reason = reason;
    run.endedAt = at ?? run.filledAt ?? now();
    if (submittable(run)) {
      run.phase = 'concluded';
      send(run, false);
    } else {
      run.phase = 'sent';
      send(run, true);
    }
  };

  const finalize = (run: Run): void => {
    if (run.phase !== 'concluded') return;
    run.phase = 'sent';
    send(run, true);
  };

  /** 连填停在这一页：按了「停止」就是已停止，别的是 CHAIN_STOPPED 与停因。 */
  const chainStopped = (run: Run, stop: DockChainStop, at?: number): void => {
    if (stop === 'STOPPED') conclude(run, 'STOPPED', undefined, at);
    else conclude(run, 'CHAIN_STOPPED', chainStopReason(stop), at);
  };

  const running = (): Run | null => (current?.phase === 'running' ? current : null);

  const onProgress = (progress: AutofillDockProgress): void => {
    const run = running();
    if (run === null) return;
    run.progress = progress;
    run.sawRun = true;
  };

  const onStep = (step: DockRunStep): void => {
    const run = running();
    if (run !== null && step === 'PLANNING') run.scanned = true;
  };

  const onChain = (state: DockChainState | null): void => {
    const run = current;
    if (run === null) return;
    if (run.phase === 'running') {
      if (state === null) return;
      run.chainPage = state.page;
      if (state.stop !== null) run.chainStop = state.stop;
      return;
    }
    // 连填正替他翻页：停下了（网站没翻、关卡、按不了）就是这一页的结局；没有停因的那一下是在报新的一页，不归这一轮。
    if (run.phase === 'advancing' && state !== null && state.stop !== null) chainStopped(run, state.stop);
  };

  const onAdvance = (pending: Promise<DockAdvanceOutcome>): void => {
    const run = running();
    if (run === null) return;
    // 这一页填完了：数与时长定在这一刻，翻页那几秒不算这一页的。
    run.counts = countsOf(run);
    run.filledAt = now();
    run.phase = 'advancing';
    const settle = (outcome: DockAdvanceOutcome): void => {
      if (run.phase !== 'advancing') return;
      if (outcome === 'ADVANCED' || outcome === 'ADVANCED_FILLING') conclude(run, 'CHAIN_ADVANCED');
      else conclude(run, 'CHAIN_STOPPED', outcome === 'NOT_ADVANCED' ? 'NOT_ADVANCED' : 'UNAVAILABLE');
    };
    pending.then((outcome) => guard(() => settle(outcome)), () => guard(() => settle('UNAVAILABLE')));
  };

  const onFinish = (outcome: DockRunOutcome): void => {
    const run = running();
    if (run === null) return;
    if (!outcome.started) {
      conclude(run, 'FAILED', runReason(outcome.code));
      return;
    }
    switch (outcome.outcome) {
      case 'FILLED':
        if (run.chainStop !== null) chainStopped(run, run.chainStop);
        else conclude(run, countsOf(run).needsYou > 0 ? 'NEEDS_YOU' : 'FILLED_ALL');
        return;
      case 'STOPPED':
        conclude(run, 'STOPPED', run.stop === 'SUPERSEDED' ? 'SUPERSEDED' : undefined);
        return;
      case 'NEEDS_USER_INPUT':
        conclude(run, 'NEEDS_YOU');
        return;
      case 'TIMED_OUT':
        conclude(run, 'FAILED', 'TIMED_OUT');
        return;
    }
  };

  const onBlocked = (code: string): void => {
    const run = running();
    if (run === null) return;
    // 连填翻过去、新一页上是关卡或认不出的一页（CHAIN_CAPTCHA……）。
    if (code.startsWith('CHAIN_') && run.chainPage > 0) conclude(run, 'CHAIN_STOPPED', runReason(code));
    else if (run.chainStop !== null) chainStopped(run, run.chainStop);
    // 半路抛了、或还没有单子（开始之前就被拒）：没能填这一页。跑完了一项没写上（有单子、或填写自己说「什么都没填上」）：
    // NOTHING_FILLED，原因是第一条拒绝。
    else if (code === 'RUN_FAILED') conclude(run, 'FAILED', 'RUN_FAILED');
    else if (code === 'NOTHING_FILLED') conclude(run, 'NOTHING_FILLED');
    else if (run.sawRun) conclude(run, 'NOTHING_FILLED', runReason(code));
    else conclude(run, 'FAILED', runReason(code));
  };

  const onRetire = (reason: DockRetireReason): void => {
    const run = running();
    if (run === null) return;
    const noted = run.noted;
    run.noted = null;
    if (reason === 'ADVANCED_EMPTY') {
      if (run.chainStop === 'REVIEW' && run.chainPage > 0) conclude(run, 'CHAIN_STOPPED', 'REVIEW');
      else conclude(run, 'NOTHING_FILLED', 'ADVANCED_EMPTY');
    } else if (reason === 'ADVANCED') {
      // 翻过去之后这一页封不住（一直在变），或连填翻到的这一页不能用那一轮的凭证写（调用方记下了停因）。
      const why = runReason(noted ?? 'NOT_SEALABLE');
      if (run.continuesChain && run.chainPage > 0) conclude(run, 'CHAIN_STOPPED', why);
      else conclude(run, 'FAILED', why);
    } else if (run.chainPage > 0) {
      conclude(run, 'CHAIN_STOPPED', 'MOVED');
    } else {
      conclude(run, 'STOPPED', 'PAGE_CHANGED');
    }
  };

  const tap: RunOutcomeTap = {
    begin(input) {
      guard(() => {
        const previous = current;
        let chainPage = 0;
        if (previous !== null) {
          if (previous.phase === 'advancing' && input.continuesChain) {
            chainPage = previous.chainPage + 1;
            conclude(previous, 'CHAIN_ADVANCED');
          } else if (previous.phase === 'running' || previous.phase === 'advancing') {
            conclude(previous, 'STOPPED', previous.stop === 'USER' ? undefined : 'SUPERSEDED', previous.stopAt ?? undefined);
          }
          finalize(previous);
          if (input.continuesChain && chainPage === 0) chainPage = previous.chainPage + 1;
        }
        const run: Run = {
          id: newId(),
          startedAt: now(),
          continuesChain: input.continuesChain,
          phase: 'running',
          chainPage,
          chainStop: null,
          progress: null,
          sawRun: false,
          scanned: false,
          stop: null,
          stopAt: null,
          noted: null,
          filledAt: null,
          counts: null,
          outcome: null,
          reason: undefined,
          endedAt: 0,
          submit: 'none',
        };
        current = run;
        const onAbort = (): void => guard(() => {
          if (run.phase !== 'running') return;
          run.stop = input.superseded() ? 'SUPERSEDED' : 'USER';
          run.stopAt = now();
          if (run.stop !== 'USER') return;
          // 准备时按了「停止」：浮层自己回到主页，不会再有收场的那一下。等一会儿还没收场就照「已停止」交。
          setTimeout(() => guard(() => {
            if (run.phase === 'running') conclude(run, 'STOPPED', undefined, run.stopAt ?? undefined);
          }), STOP_SETTLE_MS);
        });
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener('abort', onAbort, { once: true });
      });
    },

    observe(dock) {
      const tapped = <A extends unknown[]>(forward: (...args: A) => void, record: (...args: A) => void) => ({
        value: (...args: A): void => {
          forward(...args);
          guard(() => record(...args));
        },
        enumerable: true,
      });
      // 其余的方法从原来那个浮层继承（它是冻结的对象，展开或代理都会碰到不可改的属性），只在外面盖这几个。
      return Object.freeze(Object.create(dock, {
        beginRun: tapped(dock.beginRun, onProgress),
        update: tapped(dock.update, onProgress),
        setStep: tapped(dock.setStep, onStep),
        finishRun: tapped(dock.finishRun, onFinish),
        reportBlocked: tapped(dock.reportBlocked, (code: string) => onBlocked(code)),
        retireRun: tapped(dock.retireRun, onRetire),
        setChain: tapped(dock.setChain, onChain),
        autoAdvance: tapped(dock.autoAdvance, (pending: Promise<DockAdvanceOutcome>) => onAdvance(pending)),
      })) as AutofillDockHandle;
    },

    note(reason) {
      if (current?.phase === 'running') current.noted = reason;
    },

    pressed(pending) {
      guard(() => {
        const run = current;
        if (run === null || run.phase !== 'concluded') return;
        run.submit = 'unconfirmed';
        send(run, false);
        const settle = (outcome: RunSubmitOutcome): void => {
          if (run.phase !== 'concluded') return;
          run.submit = outcome;
          // 网站确认了就是终局；没收、按不了，他还可能改好再按一次，这一页的结局先不封。
          if (outcome === 'confirmed') finalize(run);
          else send(run, false);
        };
        pending.then(
          (outcome) => guard(() => settle(submitOutcomeOf(outcome))),
          () => guard(() => settle('unavailable')),
        );
      });
    },

    pageHidden() {
      guard(() => {
        const run = current;
        if (run === null) return;
        // 连填正替他翻页时整页跳走：那一下翻过去了。
        if (run.phase === 'advancing') conclude(run, 'CHAIN_ADVANCED');
        else if (run.phase === 'running') conclude(run, 'STOPPED', 'PAGE_LEFT');
        finalize(run);
      });
    },
  };
  return Object.freeze(tap);
}
