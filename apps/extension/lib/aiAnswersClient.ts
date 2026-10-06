import {
  getFullAiAutofillQuota,
  isIgnorableFullAiStreamLine,
  parseFullAiQuota,
  parseFullAiReviseResponse,
  parseFullAiStreamEvent,
  reviseFullAiAutofill,
  streamFullAiAutofillPlan,
  type FullAiFailure,
  type FullAiQuota,
  type FullAiRequest,
  type FullAiReviseRequest,
  type FullAiStreamAnswers,
  type FullAiStreamDone,
} from '@edaix/contracts';

/**
 * 失败只落稳定码：服务端闭集里的那几个原样带回（诊断要分得清是开关关了、模型失败还是资料变了），
 * 传输层的另记几个。浮层只认其中四种（见 `aiAnswersRefusal`），其余一律当「这次没有」。
 */
export type AiAnswersClientFailure = FullAiFailure | 'RATE_LIMITED' | 'INVALID_RESPONSE' | 'TIMEOUT' | 'NETWORK';

export type AiReviseClientResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; code: AiAnswersClientFailure }>;

export type AiQuotaClientResult =
  | Readonly<{ ok: true; value: FullAiQuota }>
  | Readonly<{ ok: false; code: AiAnswersClientFailure }>;

/**
 * 流上发生的事，按到达的先后：响应头到了（`OPEN`），然后一行一行的 `answers`（已按契约逐行校验过）；`done` 在结局里。
 *
 * `SKIPPED`（2026-09-28）：后端先发、这一版不认识的东西被跳过了——`LINE_TYPE` 是整行（进度、心跳一类的新行），
 * `INSTRUCTION` 是某一题的指令用了这一版不认识的动作或理由（那一题算放出来了，但不替用户填，留给用户自己答）。
 * 只用来记稳定码；不带任何内容。
 */
export type AiStreamClientEvent =
  | Readonly<{ kind: 'OPEN' }>
  | Readonly<{ kind: 'LINE'; event: FullAiStreamAnswers }>
  | Readonly<{ kind: 'SKIPPED'; what: 'LINE_TYPE' | 'INSTRUCTION' }>;

/**
 * 一条流怎么结束的：读到了合格的 `done`（它自己可能是 ok:false）；或者没读到——`answered` 是在那之前已经交出去的
 * `answers` 行数（0 = 一行都没有，这时 `code` 就是整轮的结局：付费墙、额度、超时……）。
 */
export type AiStreamClientResult =
  | Readonly<{ ok: true; done: FullAiStreamDone }>
  | Readonly<{ ok: false; code: AiAnswersClientFailure; answered: number }>;

export interface AiAnswersClient {
  /**
   * 一次「自动填写」的规划（2026-09-24，argoland #620）：打 `plan/stream`，每一行按到达的先后交给 `onEvent`
   * （不合格的一行就不再读，已经交出去的照旧算数）。`signal` 断开就中止。
   */
  planStream(request: FullAiRequest, onEvent: (event: AiStreamClientEvent) => void, signal?: AbortSignal): Promise<AiStreamClientResult>;
  /** 用户按「生成」写／改写一道文本题（每按一次一个新的 requestId；同一份请求体重发会被当成同一次）。 */
  revise(request: FullAiReviseRequest): Promise<AiReviseClientResult>;
  /** 这个月的 AI 次数（plan 与 revise 共用）。 */
  quota(): Promise<AiQuotaClientResult>;
}

/** 服务端自己 75 秒超时；这里多等一点，超时是「这次没有」，不是挂着。 */
const DEFAULT_TIMEOUT_MS = 80_000;
/** 120 题、每题最多 6,000 字的上限远到不了；超过就是不对的应答（流也按整条算）。 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** 次数只是卡片上的一行字，等不了就不等。 */
const QUOTA_TIMEOUT_MS = 8_000;

type Call<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: AiAnswersClientFailure }>;
type Opened = Readonly<{ ok: true; response: Response }> | Readonly<{ ok: false; code: AiAnswersClientFailure }>;

/**
 * worker 里的 Full AI 客户端（「AI 代答」与「用 AI 写 / AI 改写」用）。与 AI 起草同一条边界：凭据只在 worker，
 * 401 刷新一次；402 是付费墙；429 只有服务端说的是 `USAGE_EXHAUSTED` 才算次数用完（平台限流是另一回事，不该对
 * 用户说「用完了」）；其余非 200 一律不可用（端点还没上线时的 404 也在这里）。应答按契约解析、对回这一份请求，
 * 对不上整份不要；流按行解析，一行对不上就不再读。
 */
export function createAiAnswersClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}>): AiAnswersClient {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const bodyOf = async (response: Response): Promise<unknown> => {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };
  /** 带凭据发出去，把传输层的结局收成稳定码；200 才交回响应（正文还没读）。 */
  async function open(path: string, body: unknown, accept: string, signal: AbortSignal): Promise<Opened> {
    const send = (token: string): Promise<Response> =>
      fetchFn(new URL(path, input.apiBase).toString(), {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        signal,
        headers: {
          accept,
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    let token = await input.getAccessToken();
    if (token === null || token === '') return { ok: false, code: 'AUTH_REQUIRED' };
    let response = await send(token);
    if (response.status === 401 && input.refreshAccessToken !== undefined) {
      token = await input.refreshAccessToken();
      if (token === null || token === '') return { ok: false, code: 'AUTH_REQUIRED' };
      response = await send(token);
    }
    if (response.status === 401) return { ok: false, code: 'AUTH_REQUIRED' };
    if (response.status === 402) return { ok: false, code: 'PAYWALL_REQUIRED' };
    if (response.status === 429) {
      const error = await bodyOf(response);
      const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      return { ok: false, code: code === 'USAGE_EXHAUSTED' ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED' };
    }
    if (response.status !== 200) return { ok: false, code: 'FULL_AI_UNAVAILABLE' };
    return { ok: true, response };
  }
  /** 一次带凭据的调用：`parse` 返回 null 就是应答不对。 */
  async function call<T>(path: string, body: unknown, limitMs: number, parse: (raw: unknown) => Call<T> | null): Promise<Call<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    try {
      const opened = await open(path, body, 'application/json', controller.signal);
      if (!opened.ok) return opened;
      return parse(await bodyOf(opened.response)) ?? { ok: false, code: 'INVALID_RESPONSE' };
    } catch {
      return { ok: false, code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
    } finally {
      clearTimeout(timer);
    }
  }
  async function planStream(
    request: FullAiRequest,
    onEvent: (event: AiStreamClientEvent) => void,
    signal?: AbortSignal,
  ): Promise<AiStreamClientResult> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(cancel, timeoutMs);
    let answered = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const opened = await open(streamFullAiAutofillPlan.path, request, 'application/x-ndjson', controller.signal);
      if (!opened.ok) return { ...opened, answered };
      const { response } = opened;
      // 200 却不是 NDJSON（代理的错误页之类）：不读。
      if (!/^application\/x-ndjson\b/iu.test(response.headers.get('content-type') ?? '') || response.body === null) {
        return { ok: false, code: 'INVALID_RESPONSE', answered };
      }
      onEvent({ kind: 'OPEN' });
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const released = new Set<string>();
      let pending = '';
      let bytes = 0;
      /** 一行：解析、按契约对回这一份请求；不合格就是整条流到此为止。 */
      const consume = (line: string): FullAiStreamDone | 'INVALID' | null => {
        if (line.trim() === '') return null;
        let raw: unknown;
        try {
          raw = JSON.parse(line) as unknown;
        } catch {
          return 'INVALID';
        }
        // 这一版不认识的行类型：跳过，不当坏行（2026-09-28；契约里的 `isIgnorableFullAiStreamLine`）。
        if (isIgnorableFullAiStreamLine(raw)) {
          onEvent({ kind: 'SKIPPED', what: 'LINE_TYPE' });
          return null;
        }
        const releasedBefore = released.size;
        const event = parseFullAiStreamEvent(raw, request, released);
        if (event === null) return 'INVALID';
        if (event.type === 'done') return event;
        answered += 1;
        // 放出来的题比交出来的指令多：有的指令用了这一版不认识的动作或理由，契约解析器没交出来。
        if (released.size - releasedBefore > event.instructions.length) onEvent({ kind: 'SKIPPED', what: 'INSTRUCTION' });
        onEvent({ kind: 'LINE', event });
        return null;
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (value !== undefined) {
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) return { ok: false, code: 'INVALID_RESPONSE', answered };
          pending += decoder.decode(value, { stream: true });
        }
        if (done) pending += decoder.decode();
        const lines = pending.split('\n');
        pending = done ? '' : lines.pop() ?? '';
        for (const line of lines) {
          const outcome = consume(line);
          if (outcome === 'INVALID') return { ok: false, code: 'INVALID_RESPONSE', answered };
          if (outcome !== null) return { ok: true, done: outcome };
        }
        // 流断了却没有 `done`：已经交出去的照旧，其余当没答上。
        if (done) return { ok: false, code: 'INVALID_RESPONSE', answered };
      }
    } catch {
      return { ok: false, code: controller.signal.aborted ? (signal?.aborted ? 'FULL_AI_CANCELLED' : 'TIMEOUT') : 'NETWORK', answered };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      // 不再读的那一截：告诉服务端这一轮不要了（它据此停下还在跑的调用）。
      if (reader !== undefined) void reader.cancel().catch(() => undefined);
      controller.abort();
    }
  }
  return Object.freeze({
    planStream,
    revise: (request: FullAiReviseRequest) => call(reviseFullAiAutofill.path, request, timeoutMs, (raw) => {
      const parsed = parseFullAiReviseResponse(raw, request);
      return parsed === null ? null : parsed.ok ? { ok: true, value: parsed.value } : { ok: false, code: parsed.code };
    }),
    quota: () => call(getFullAiAutofillQuota.path, undefined, QUOTA_TIMEOUT_MS, (raw) => {
      const parsed = parseFullAiQuota(raw);
      return parsed === null ? null : { ok: true, value: parsed };
    }),
  });
}
