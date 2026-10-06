import type { RunOutcomeEvent } from './runOutcome';

/**
 * 上报：worker 的原因码环形缓冲之外再送一份给后端，落进结构化日志 → Loki。
 *
 * 契约权威在 argoland：POST /telemetry/client-errors（docs/API_CONTRACTS.md）。送三种东西，全是稳定码、闭集与分桶
 * （RULE-GLOBAL-DATA-L1：服务端拒收扩展来的 message/stack/route）：
 *  · `diagnostic`：原因码与次数；数量码（`AI_ANSWERS_DRAFTED`）的次数就是数量——码里不再嵌数字（体检 11-4）；
 *    HTTP 失败另带那一次请求的 `x-request-id` 与状态码（体检 11-3），与服务端日志对得上；
 *  · `uncaught_error` / `unhandled_rejection`：入口处接住的异常，码是 `<入口>:<类名>`，从不带 message 或 stack；
 *  · `run_outcome`：每一轮自动填写怎么收场（lib/runOutcome.ts，体检 11-1）。单独成批送：服务端整批要么全收、要么全拒，
 *    后端还不认这一种时（400）丢的只是这几条，原因码照常；之后六小时不再送，不来回撞。
 *
 * 不带凭据：诊断常常正是登录态坏了时产生的，上报不能再去触发刷新。
 *
 * 不再「失败就丢」（体检 11-5）：待送的放在 storage.session 里（有上限），worker 被挂起、重启都不丢；断网、5xx、429 退避重试
 * （10 秒起、逐次加倍、封顶 10 分钟，照 Retry-After），一条最多送五次，丢掉的记成 `TELEMETRY_DROPPED` 的次数；400 一类的拒收
 * 不重试。同一条可能因为「送到了、答复丢了」再送一次：结局有 runId，服务端分得开；原因码多算一两次。
 */

const ENDPOINT_PATH = '/telemetry/client-errors';
/** 与服务端 ClientErrorEventDto.code 同一个模式；不像码的一律 MALFORMED_CODE，原文不出 worker。 */
const CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** 与服务端 requestId 同一个模式；不像请求号的不带。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const NAME_PATTERN = /^[A-Za-z0-9_]{1,40}$/;
const MAX_EVENTS_PER_REQUEST = 20;
/** 一个 worker 生命周期最多送这么多条码与异常：出错循环不能刷爆后端。 */
const MAX_EVENTS_PER_WORKER = 200;
/** 结局是用户一下一下按出来的，上限只防失控。 */
const MAX_RUNS_PER_WORKER = 100;
/** 队列里最多这么多种码与这么多轮结局（另留一格给 TELEMETRY_DROPPED）。 */
const MAX_QUEUED_SIGNALS = 200;
const MAX_QUEUED_RUNS = 50;
const MAX_COUNT = 10_000;
/** 攒一小会儿再送：MV3 worker 空闲约 30s 后会被挂起，10s 内能送出。 */
const FLUSH_DELAY_MS = 10_000;
/** 草稿（这一页还可能按「提交」）最多拿这么久，等不到终稿就照草稿送。 */
const RUN_HOLD_MS = 30 * 60_000;
const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 10 * 60_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;
const MAX_ATTEMPTS = 5;
/** 后端不认 run_outcome（还没上线那一版）：这么久之内不再送。 */
const RUNS_REJECTED_PAUSE_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DROPPED = 'TELEMETRY_DROPPED';

export type TelemetrySurface = 'background' | 'apply' | 'dock';
export type TelemetryErrorKind = 'uncaught_error' | 'unhandled_rejection';
type SignalKind = 'diagnostic' | TelemetryErrorKind;

/** 一次失败的 HTTP 请求：状态码与服务端回的 `x-request-id`（只在 worker 里取，见 httpFailure.ts）。 */
export interface HttpFailure {
  readonly httpStatus?: number;
  readonly requestId?: string;
}

export interface DiagnosticDetail {
  /** 次数；数量码就是数量。缺省 1。 */
  readonly count?: number;
  readonly surface?: TelemetrySurface;
  readonly http?: HttpFailure;
}

/** 队列的落脚处：worker 里是 storage.session 的一个键（扩展重载、浏览器重启时清空）。 */
export interface TelemetryQueueStore {
  get(): Promise<unknown>;
  set(value: unknown): Promise<void>;
}

export type DiagnosticsUploader = Readonly<{
  record(code: string, detail?: DiagnosticDetail): void;
  recordError(error: Readonly<{ surface: TelemetrySurface; kind: TelemetryErrorKind; code: string }>): void;
  /** `final: false` 是草稿：先拿着，同一个 runId 的终稿到了就换掉；最多拿半小时。 */
  recordRun(event: RunOutcomeEvent, final: boolean): void;
  flush(): Promise<void>;
}>;

interface SignalItem {
  readonly type: 'signal';
  readonly key: string;
  readonly kind: SignalKind;
  readonly code: string;
  readonly surface: TelemetrySurface;
  count: number;
  readonly occurredAt: string;
  requestId?: string;
  readonly httpStatus?: number;
  attempts: number;
}

interface RunItem {
  readonly type: 'run';
  readonly key: string;
  run: RunOutcomeEvent;
  readonly occurredAt: string;
  holdUntil: number;
  attempts: number;
}

type Item = SignalItem | RunItem;

interface QueueState {
  items: Item[];
  backoffUntil: number;
  failures: number;
  runsRejectedUntil: number;
}

type PostResult = 'SENT' | 'REJECTED' | Readonly<{ retryAfterMs: number }>;

export function createDiagnosticsUploader(input: Readonly<{
  apiBase: string;
  release: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  store?: TelemetryQueueStore;
  /** 只进本机环形缓冲与控制台、不上报的码（上报通道自己的毛病：再上报就会绕圈）。 */
  onLocal?: (code: string) => void;
  /** 退避的抖动（测试里固定）。 */
  random?: () => number;
  /**
   * 读回上一个 worker 没送完的结局时，按闭集再核一遍（lib/runOutcome.ts 的 parseDockRunOutcome）。没给就不读回结局：
   * Assistant 构建里没有手势路、不会有结局，解析器与那几张表不必进它的产物。
   */
  parseRun?: (raw: unknown) => RunOutcomeEvent | null;
}>): DiagnosticsUploader {
  const fetchFn = input.fetchFn ?? fetch;
  const nowMs = (): number => (input.now ?? (() => new Date()))().getTime();
  const random = input.random ?? Math.random;
  const local = (code: string): void => {
    try {
      input.onLocal?.(code);
    } catch {
      // 本机那一头记不下：这里没有第三条路。
    }
  };
  const state: QueueState = { items: [], backoffUntil: 0, failures: 0, runsRejectedUntil: 0 };
  /** 正在送的那几条：送成了就没了，没送成放回去。 */
  const sending = new Set<Item>();
  let sentSignals = 0;
  let sentRuns = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = Number.POSITIVE_INFINITY;
  let flushing: Promise<void> | null = null;
  let writeQueued = false;

  const persist = (): void => {
    const store = input.store;
    if (store === undefined || writeQueued) return;
    writeQueued = true;
    queueMicrotask(() => {
      writeQueued = false;
      const snapshot = { v: 1, items: state.items, backoffUntil: state.backoffUntil, failures: state.failures, runsRejectedUntil: state.runsRejectedUntil };
      let written: Promise<void>;
      try {
        written = store.set(snapshot);
      } catch {
        local('TELEMETRY_QUEUE_WRITE_FAILED');
        return;
      }
      written.catch(() => local('TELEMETRY_QUEUE_WRITE_FAILED'));
    });
  };

  const schedule = (delayMs: number): void => {
    const at = nowMs() + Math.max(0, delayMs);
    if (timer !== undefined && timerAt <= at) return;
    if (timer !== undefined) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = undefined;
      timerAt = Number.POSITIVE_INFINITY;
      void flush();
    }, Math.max(0, delayMs));
  };

  const signalCount = (): number => state.items.filter((item) => item.type === 'signal').length;
  const runCount = (): number => state.items.filter((item) => item.type === 'run').length;

  const addSignal = (signal: Omit<SignalItem, 'type' | 'key' | 'occurredAt' | 'attempts'>, occurredAt = new Date(nowMs()).toISOString()): void => {
    const key = `${signal.kind}|${signal.surface}|${signal.code}|${signal.httpStatus ?? ''}`;
    const existing = state.items.find((item): item is SignalItem => item.type === 'signal' && item.key === key && !sending.has(item));
    if (existing !== undefined) {
      existing.count = Math.min(MAX_COUNT, existing.count + signal.count);
      existing.requestId ??= signal.requestId;
      return;
    }
    if (signalCount() >= MAX_QUEUED_SIGNALS && signal.code !== DROPPED) {
      addDropped(1);
      return;
    }
    state.items.push({
      type: 'signal',
      key,
      kind: signal.kind,
      code: signal.code,
      surface: signal.surface,
      count: Math.min(MAX_COUNT, signal.count),
      occurredAt,
      ...(signal.requestId === undefined ? {} : { requestId: signal.requestId }),
      ...(signal.httpStatus === undefined ? {} : { httpStatus: signal.httpStatus }),
      attempts: 0,
    });
  };

  const addDropped = (count: number): void => {
    addSignal({ kind: 'diagnostic', code: DROPPED, surface: 'background', count });
  };

  const stableCode = (code: string): string => (CODE_PATTERN.test(code) ? code : 'MALFORMED_CODE');
  const cleanCount = (count: number | undefined): number =>
    count === undefined ? 1 : Number.isSafeInteger(count) && count > 0 ? Math.min(MAX_COUNT, count) : 1;

  const touched = (): void => {
    persist();
    const due = nextDue();
    if (due !== null) schedule(due - nowMs());
  };

  /** 读回上一个 worker 没送完的那些：形状不对的丢掉（storage.session 只有我们自己写，仍然当外来的读）。 */
  const restore = (saved: unknown): void => {
    if (typeof saved !== 'object' || saved === null) return;
    const record = saved as Record<string, unknown>;
    if (record.v !== 1 || !Array.isArray(record.items)) return;
    const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    state.backoffUntil = Math.max(state.backoffUntil, number(record.backoffUntil));
    state.failures = Math.max(state.failures, Math.min(32, number(record.failures)));
    state.runsRejectedUntil = Math.max(state.runsRejectedUntil, number(record.runsRejectedUntil));
    for (const raw of record.items.slice(0, MAX_QUEUED_SIGNALS + MAX_QUEUED_RUNS + 1)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const attempts = Math.min(MAX_ATTEMPTS, Math.max(0, Math.floor(number(item.attempts))));
      const occurredAt = typeof item.occurredAt === 'string' && !Number.isNaN(Date.parse(item.occurredAt)) ? item.occurredAt : null;
      if (occurredAt === null || attempts >= MAX_ATTEMPTS) continue;
      if (item.type === 'run') {
        const parsed = input.parseRun?.(item.run) ?? null;
        if (parsed === null || runCount() >= MAX_QUEUED_RUNS || state.items.some((one) => one.key === parsed.runId)) continue;
        state.items.push({ type: 'run', key: parsed.runId, run: parsed, occurredAt, holdUntil: number(item.holdUntil), attempts });
        continue;
      }
      const kind = item.kind;
      const surface = item.surface;
      if (item.type !== 'signal' || (kind !== 'diagnostic' && kind !== 'uncaught_error' && kind !== 'unhandled_rejection')) continue;
      if (surface !== 'background' && surface !== 'apply' && surface !== 'dock') continue;
      if (typeof item.code !== 'string' || !CODE_PATTERN.test(item.code)) continue;
      const http = cleanHttp({
        ...(typeof item.httpStatus === 'number' ? { httpStatus: item.httpStatus } : {}),
        ...(typeof item.requestId === 'string' ? { requestId: item.requestId } : {}),
      });
      const count = cleanCount(Math.floor(number(item.count)));
      const key = `${kind}|${surface}|${item.code}|${http.httpStatus ?? ''}`;
      // 读回来之前这个 worker 已经记了同一个码：合成一条。
      const twin = state.items.find((one): one is SignalItem => one.type === 'signal' && one.key === key);
      if (twin !== undefined) {
        twin.count = Math.min(MAX_COUNT, twin.count + count);
        twin.requestId ??= http.requestId;
        continue;
      }
      if (signalCount() >= MAX_QUEUED_SIGNALS) continue;
      state.items.push({ type: 'signal', key, kind, code: item.code, surface, count, occurredAt, ...http, attempts });
    }
  };

  const store = input.store;
  const loaded: Promise<void> = store === undefined
    ? Promise.resolve()
    : Promise.resolve()
      .then(() => store.get())
      .then(restore, () => local('TELEMETRY_QUEUE_READ_FAILED'))
      .then(() => {
        const due = nextDue();
        if (due !== null) schedule(due - nowMs());
      }, () => local('TELEMETRY_QUEUE_READ_FAILED'));

  const wire = (item: Item): Record<string, unknown> => item.type === 'run'
    ? { kind: 'run_outcome', code: item.run.outcome, surface: 'apply', occurredAt: item.occurredAt, run: item.run }
    : {
        kind: item.kind,
        code: item.code,
        surface: item.surface,
        count: item.count,
        occurredAt: item.occurredAt,
        ...(item.requestId === undefined ? {} : { requestId: item.requestId }),
        ...(item.httpStatus === undefined ? {} : { httpStatus: item.httpStatus }),
      };

  const post = async (batch: readonly Item[]): Promise<PostResult> => {
    let response: Response;
    try {
      const timeout = typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } : {};
      response = await fetchFn(new URL(ENDPOINT_PATH, input.apiBase).toString(), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'extension', release: input.release, events: batch.map(wire) }),
        ...timeout,
      });
    } catch {
      return { retryAfterMs: 0 };
    }
    if (response.ok) return 'SENT';
    if (response.status === 429) return { retryAfterMs: retryAfterMs(response.headers.get('retry-after'), nowMs()) };
    if (response.status >= 500) return { retryAfterMs: 0 };
    // 400、413、404（没有这条路由）……：再送也一样，丢掉。
    return 'REJECTED';
  };

  const remove = (batch: readonly Item[]): void => {
    const gone = new Set<Item>(batch);
    state.items = state.items.filter((item) => !gone.has(item));
  };

  /** 没送成：放回去（送的时候又来了同一个码，就合进那一条），送够五次的丢掉。 */
  const putBack = (batch: readonly Item[]): void => {
    let dropped = 0;
    for (const item of batch) {
      item.attempts += 1;
      if (item.attempts < MAX_ATTEMPTS) {
        if (item.type !== 'signal') continue;
        const twin = state.items.find((one): one is SignalItem => one !== item && one.type === 'signal' && one.key === item.key && !sending.has(one));
        if (twin === undefined) continue;
        twin.count = Math.min(MAX_COUNT, twin.count + item.count);
        twin.requestId ??= item.requestId;
        twin.attempts = Math.max(twin.attempts, item.attempts);
        remove([item]);
        continue;
      }
      remove([item]);
      dropped += item.type === 'signal' ? item.count : 1;
    }
    if (dropped > 0) addDropped(dropped);
  };

  const backoff = (retryAfter: number): number => {
    const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, state.failures - 1));
    const jittered = Math.round(base * (0.8 + 0.4 * random()));
    return Math.min(RETRY_AFTER_MAX_MS, Math.max(jittered, retryAfter));
  };

  /** 下一次该送的时刻；这个 worker 已经送到上限的那一类不算（留给下一个 worker），免得空转。 */
  function nextDue(): number | null {
    const t = nowMs();
    let due: number | null = null;
    for (const item of state.items) {
      if (item.type === 'signal' ? sentSignals >= MAX_EVENTS_PER_WORKER : sentRuns >= MAX_RUNS_PER_WORKER) continue;
      const at = item.type === 'run' && item.holdUntil > t ? item.holdUntil : t + FLUSH_DELAY_MS;
      due = due === null ? at : Math.min(due, at);
    }
    return due === null ? null : Math.max(due, state.backoffUntil);
  }

  async function run(): Promise<void> {
    await loaded;
    const t = nowMs();
    if (t < state.backoffUntil) {
      schedule(state.backoffUntil - t);
      return;
    }
    if (t < state.runsRejectedUntil) {
      // 后端还不认 run_outcome：攒着的也不送了。
      state.items = state.items.filter((item) => item.type !== 'run');
    }
    const signals = state.items.filter((item): item is SignalItem => item.type === 'signal')
      .slice(0, Math.max(0, MAX_EVENTS_PER_WORKER - sentSignals));
    const runs = state.items.filter((item): item is RunItem => item.type === 'run' && item.holdUntil <= t)
      .slice(0, Math.max(0, MAX_RUNS_PER_WORKER - sentRuns));
    const batches: Item[][] = [];
    for (let start = 0; start < signals.length; start += MAX_EVENTS_PER_REQUEST) batches.push(signals.slice(start, start + MAX_EVENTS_PER_REQUEST));
    for (let start = 0; start < runs.length; start += MAX_EVENTS_PER_REQUEST) batches.push(runs.slice(start, start + MAX_EVENTS_PER_REQUEST));
    for (const batch of batches) {
      for (const item of batch) sending.add(item);
      const result = await post(batch);
      for (const item of batch) sending.delete(item);
      const ofRuns = batch[0]?.type === 'run';
      if (result === 'SENT') {
        remove(batch);
        if (ofRuns) sentRuns += batch.length;
        else sentSignals += batch.length;
        state.failures = 0;
        continue;
      }
      if (result === 'REJECTED') {
        remove(batch);
        if (ofRuns) {
          state.runsRejectedUntil = nowMs() + RUNS_REJECTED_PAUSE_MS;
          state.items = state.items.filter((item) => item.type !== 'run');
          local('TELEMETRY_RUN_OUTCOME_REJECTED');
          addSignal({ kind: 'diagnostic', code: 'TELEMETRY_RUN_OUTCOME_REJECTED', surface: 'background', count: batch.length });
        } else {
          // 码这一批被拒：只记在本机，不再上报一条（被拒的多半就是它自己）。
          local('TELEMETRY_REJECTED');
        }
        continue;
      }
      putBack(batch);
      state.failures += 1;
      state.backoffUntil = nowMs() + backoff(result.retryAfterMs);
      break;
    }
    persist();
    const due = nextDue();
    if (due !== null) schedule(due - nowMs());
  }

  function flush(): Promise<void> {
    if (flushing !== null) return flushing;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    timerAt = Number.POSITIVE_INFINITY;
    flushing = run().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  return Object.freeze({
    record(code: string, detail?: DiagnosticDetail): void {
      if (sentSignals >= MAX_EVENTS_PER_WORKER) return;
      addSignal({
        kind: 'diagnostic',
        code: stableCode(code),
        surface: detail?.surface ?? 'background',
        count: cleanCount(detail?.count),
        ...cleanHttp(detail?.http),
      });
      touched();
    },
    recordError(error): void {
      if (sentSignals >= MAX_EVENTS_PER_WORKER) return;
      addSignal({ kind: error.kind, code: stableCode(error.code), surface: error.surface, count: 1 });
      touched();
    },
    recordRun(event: RunOutcomeEvent, final: boolean): void {
      const t = nowMs();
      if (t < state.runsRejectedUntil || sentRuns >= MAX_RUNS_PER_WORKER) return;
      const existing = state.items.find((item): item is RunItem => item.type === 'run' && item.key === event.runId && !sending.has(item));
      if (existing !== undefined) {
        existing.run = event;
        if (final) existing.holdUntil = 0;
      } else if (runCount() >= MAX_QUEUED_RUNS) {
        addDropped(1);
      } else {
        state.items.push({
          type: 'run',
          key: event.runId,
          run: event,
          occurredAt: new Date(t).toISOString(),
          holdUntil: final ? 0 : t + RUN_HOLD_MS,
          attempts: 0,
        });
      }
      touched();
    },
    flush,
  });
}

/** 状态码在 100–599、请求号像请求号才带；别的一律不带。 */
function cleanHttp(http: HttpFailure | undefined): { httpStatus?: number; requestId?: string } {
  if (http === undefined) return {};
  const status = http.httpStatus;
  return {
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
    ...(typeof http.requestId === 'string' && REQUEST_ID_PATTERN.test(http.requestId) ? { requestId: http.requestId } : {}),
  };
}

/** Retry-After：秒数或 HTTP 日期；读不出就是 0。 */
function retryAfterMs(header: string | null, now: number): number {
  if (header === null) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(RETRY_AFTER_MAX_MS, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 0 : Math.min(RETRY_AFTER_MAX_MS, Math.max(0, at - now));
}

/** worker 里未捕获的异常 / 未处理的 rejection → 环形缓冲里的稳定码（只在本机）。只取类名，从不取 message。 */
export function workerFailureCode(kind: 'error' | 'rejection', reason: unknown): string {
  const prefix = kind === 'error' ? 'worker:UNCAUGHT_ERROR' : 'worker:UNHANDLED_REJECTION';
  const name = reason instanceof Error ? reason.name : typeof reason;
  return `${prefix}:${NAME_PATTERN.test(name) ? name : 'Error'}`;
}
