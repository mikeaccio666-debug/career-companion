import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDiagnosticsUploader,
  workerFailureCode,
  type TelemetryQueueStore,
} from '../lib/diagnosticsUploader';
import { createDockRunOutcome, parseDockRunOutcome, type RunOutcomeEvent } from '../lib/runOutcome';

/**
 * 上报：原因码、入口处的异常（只有类名）、每一轮自动填写的结局。只送稳定码、闭集与分桶（RULE-GLOBAL-DATA-L1），
 * 落到后端结构化日志 → Loki。契约权威在 argoland：POST /telemetry/client-errors（docs/API_CONTRACTS.md）。
 */
const T0 = Date.parse('2026-10-04T10:00:00.000Z');
let clock = T0;
const now = () => new Date(clock);
const accepted = () => vi.fn(async () => new Response(JSON.stringify({ received: 1 }), { status: 202 }));
type FetchMock = ReturnType<typeof vi.fn>;
const bodies = (fetchFn: FetchMock) =>
  fetchFn.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
const events = (fetchFn: FetchMock) => bodies(fetchFn).flatMap((body) => body.events);

function memoryStore(): TelemetryQueueStore & { value: unknown } {
  const store = {
    value: undefined as unknown,
    get: async () => store.value,
    set: async (value: unknown) => { store.value = JSON.parse(JSON.stringify(value)); },
  };
  return store;
}

const uploader = (fetchFn: unknown, extra: { store?: TelemetryQueueStore; onLocal?: (code: string) => void } = {}) =>
  createDiagnosticsUploader({
    apiBase: 'https://api.argoland.ai',
    release: '1.1.0+store',
    fetchFn: fetchFn as typeof fetch,
    now,
    random: () => 0.5,
    parseRun: (raw: unknown) => parseDockRunOutcome(createDockRunOutcome(raw as RunOutcomeEvent, true))?.event ?? null,
    ...extra,
  });

const run = (overrides: Partial<RunOutcomeEvent> = {}): RunOutcomeEvent => ({
  runId: '0123456789abcdef0123456789abcdef',
  vendor: 'lever',
  lane: 'host',
  outcome: 'FILLED_ALL',
  planned: '6-10',
  filled: '6-10',
  needsYou: '0',
  aiAnswered: '0',
  signedOnBehalf: '0',
  requiredEmptyOnPage: '0',
  fillRate: '100',
  durationBucket: '5_10S',
  chainPages: 0,
  submitOutcome: 'none',
  ...overrides,
});

beforeEach(() => {
  clock = T0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('原因码', () => {
  it('攒一小会儿后一次送出：路径是契约里的、不带凭据、release 是版本加构建形态', async () => {
    vi.useFakeTimers();
    const fetchFn = accepted();
    const subject = uploader(fetchFn);

    subject.record('intent:SIGN_IN_REQUIRED');
    subject.record('AUTH_REFRESH_FAILED');
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.argoland.ai/telemetry/client-errors');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(bodies(fetchFn)).toEqual([{
      source: 'extension',
      release: '1.1.0+store',
      events: [
        { kind: 'diagnostic', code: 'intent:SIGN_IN_REQUIRED', surface: 'background', count: 1, occurredAt: new Date(T0).toISOString() },
        { kind: 'diagnostic', code: 'AUTH_REFRESH_FAILED', surface: 'background', count: 1, occurredAt: new Date(T0).toISOString() },
      ],
    }]);
  });

  it('同一个码重复出现只算一条，带次数；数量码把数量加起来（码里不再嵌数字），封顶 10000', async () => {
    const fetchFn = accepted();
    const subject = uploader(fetchFn);
    for (let index = 0; index < 4; index += 1) subject.record('receipt:RECEIPT_UPLOAD_FAILED');
    subject.record('AI_ANSWERS_DRAFTED', { count: 3 });
    subject.record('AI_ANSWERS_DRAFTED', { count: 5 });
    subject.record('AI_SERVER_MODEL_CALLS', { count: 9_999 });
    subject.record('AI_SERVER_MODEL_CALLS', { count: 9_999 });
    await subject.flush();

    expect(events(fetchFn)).toEqual([
      expect.objectContaining({ code: 'receipt:RECEIPT_UPLOAD_FAILED', count: 4 }),
      expect.objectContaining({ code: 'AI_ANSWERS_DRAFTED', count: 8 }),
      expect.objectContaining({ code: 'AI_SERVER_MODEL_CALLS', count: 10_000 }),
    ]);
  });

  it('HTTP 失败带上 x-request-id 与状态码：不同状态分开算，不像请求号的不带', async () => {
    const fetchFn = accepted();
    const subject = uploader(fetchFn);
    subject.record('PROFILE_FETCH_FAILED', { http: { httpStatus: 503, requestId: 'req-0123456789' } });
    subject.record('PROFILE_FETCH_FAILED', { http: { httpStatus: 503, requestId: 'req-9999999999' } });
    subject.record('PROFILE_FETCH_FAILED', { http: { httpStatus: 404, requestId: 'https://evil.example/x?y' } });
    subject.record('PROFILE_FETCH_FAILED', { http: { httpStatus: 42 } });
    await subject.flush();

    expect(events(fetchFn)).toEqual([
      expect.objectContaining({ code: 'PROFILE_FETCH_FAILED', count: 2, httpStatus: 503, requestId: 'req-0123456789' }),
      { kind: 'diagnostic', code: 'PROFILE_FETCH_FAILED', surface: 'background', count: 1, httpStatus: 404, occurredAt: expect.any(String) },
      { kind: 'diagnostic', code: 'PROFILE_FETCH_FAILED', surface: 'background', count: 1, occurredAt: expect.any(String) },
    ]);
  });

  it('内容脚本与浮层的码按它们自己的 surface 送', async () => {
    const fetchFn = accepted();
    const subject = uploader(fetchFn);
    subject.record('SITE_KNOWLEDGE_UNAVAILABLE', { surface: 'apply' });
    subject.record('DOCK_COPY_FAILED', { surface: 'dock' });
    await subject.flush();
    expect(events(fetchFn).map(({ code, surface }) => ({ code, surface }))).toEqual([
      { code: 'SITE_KNOWLEDGE_UNAVAILABLE', surface: 'apply' },
      { code: 'DOCK_COPY_FAILED', surface: 'dock' },
    ]);
  });

  it('一次请求最多 20 条', async () => {
    const fetchFn = accepted();
    const subject = uploader(fetchFn);
    for (let index = 0; index < 25; index += 1) subject.record(`CODE_${index}`);
    await subject.flush();

    expect(bodies(fetchFn).map((body) => body.events.length)).toEqual([20, 5]);
  });

  it('一个 worker 生命周期里送出的条数有上限，出错循环也不会刷爆后端', async () => {
    const fetchFn = accepted();
    const subject = uploader(fetchFn);
    for (let round = 0; round < 3; round += 1) {
      for (let index = 0; index < 100; index += 1) subject.record(`LOOP_${round}_${index}`);
      await subject.flush();
    }

    expect(events(fetchFn)).toHaveLength(200);
  });

  it.each(['has spaces', 'https://boards.greenhouse.io/acme?token=x', 'x'.repeat(129), ''])(
    '不像稳定码的 %s 以 MALFORMED_CODE 送出，原文不出 worker',
    async (junk) => {
      const fetchFn = accepted();
      const subject = uploader(fetchFn);
      subject.record(junk);
      await subject.flush();

      expect(events(fetchFn)[0].code).toBe('MALFORMED_CODE');
      expect(JSON.stringify(bodies(fetchFn))).not.toContain('greenhouse');
    },
  );

  it('没有待送的码就不发请求', async () => {
    const fetchFn = accepted();
    await uploader(fetchFn).flush();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('入口处的异常：只有类名', () => {
  it('按 kind 与 surface 送，同一个码算次数', async () => {
    const fetchFn = accepted();
    const subject = uploader(fetchFn);
    subject.recordError({ surface: 'dock', kind: 'uncaught_error', code: 'DOCK_HANDLER_THREW:TypeError' });
    subject.recordError({ surface: 'dock', kind: 'uncaught_error', code: 'DOCK_HANDLER_THREW:TypeError' });
    subject.recordError({ surface: 'apply', kind: 'unhandled_rejection', code: 'GESTURE_RUN_THREW:RangeError' });
    subject.recordError({ surface: 'background', kind: 'uncaught_error', code: 'WORKER:Cannot read "x"' });
    await subject.flush();

    expect(events(fetchFn)).toEqual([
      { kind: 'uncaught_error', code: 'DOCK_HANDLER_THREW:TypeError', surface: 'dock', count: 2, occurredAt: expect.any(String) },
      { kind: 'unhandled_rejection', code: 'GESTURE_RUN_THREW:RangeError', surface: 'apply', count: 1, occurredAt: expect.any(String) },
      { kind: 'uncaught_error', code: 'MALFORMED_CODE', surface: 'background', count: 1, occurredAt: expect.any(String) },
    ]);
  });
});

describe('每一轮自动填写的结局', () => {
  it('单独一个请求送（不与原因码同批），code 是结局本身', async () => {
    const fetchFn = accepted();
    const subject = uploader(fetchFn);
    subject.record('AUTH_REFRESH_FAILED');
    subject.recordRun(run(), true);
    await subject.flush();

    expect(bodies(fetchFn)).toEqual([
      expect.objectContaining({ events: [expect.objectContaining({ kind: 'diagnostic' })] }),
      {
        source: 'extension',
        release: '1.1.0+store',
        events: [{ kind: 'run_outcome', code: 'FILLED_ALL', surface: 'apply', occurredAt: new Date(T0).toISOString(), run: run() }],
      },
    ]);
  });

  it('草稿先拿着；同一个 runId 的终稿到了换成终稿再送', async () => {
    const fetchFn = accepted();
    const subject = uploader(fetchFn);
    subject.recordRun(run(), false);
    await subject.flush();
    expect(fetchFn).not.toHaveBeenCalled();

    subject.recordRun(run({ submitOutcome: 'unconfirmed' }), false);
    subject.recordRun(run({ submitOutcome: 'confirmed' }), true);
    await subject.flush();
    expect(events(fetchFn)).toEqual([expect.objectContaining({ run: run({ submitOutcome: 'confirmed' }) })]);
  });

  it('草稿最多拿半小时，等不到终稿就照草稿送', async () => {
    const fetchFn = accepted();
    const subject = uploader(fetchFn);
    subject.recordRun(run({ outcome: 'NEEDS_YOU', needsYou: '2', fillRate: '75-99' }), false);
    clock += 29 * 60_000;
    await subject.flush();
    expect(fetchFn).not.toHaveBeenCalled();
    clock += 2 * 60_000;
    await subject.flush();
    expect(events(fetchFn)).toEqual([expect.objectContaining({ code: 'NEEDS_YOU' })]);
  });

  it('后端还不认这一种（400）：这一批安静丢掉、记一个码、六小时内不再送，原因码照常', async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) =>
      String(init.body).includes('run_outcome')
        ? new Response('{"message":"kind must be one of"}', { status: 400 })
        : new Response('{}', { status: 202 }));
    const local: string[] = [];
    const subject = uploader(fetchFn, { onLocal: (code) => local.push(code) });
    subject.recordRun(run(), true);
    await subject.flush();
    await subject.flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(events(fetchFn as never).at(-1)).toEqual(expect.objectContaining({ code: 'TELEMETRY_RUN_OUTCOME_REJECTED', count: 1 }));
    expect(local).toContain('TELEMETRY_RUN_OUTCOME_REJECTED');

    clock += 60 * 60_000;
    subject.recordRun(run({ runId: 'f'.repeat(32) }), true);
    subject.record('AUTH_REFRESH_FAILED');
    await subject.flush();
    expect(bodies(fetchFn as never).at(-1).events).toEqual([expect.objectContaining({ code: 'AUTH_REFRESH_FAILED' })]);
    expect(fetchFn).toHaveBeenCalledTimes(3);

    clock += 6 * 60 * 60_000;
    subject.recordRun(run({ runId: 'e'.repeat(32) }), true);
    await subject.flush();
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
});

describe('重试与持久化', () => {
  it.each([
    ['断网', () => { throw new TypeError('Failed to fetch'); }],
    ['5xx', () => new Response('{}', { status: 503 })],
    ['429', () => new Response('{}', { status: 429 })],
  ])('%s：留着，退避之后再送；送成了就不再送', async (_label, failure) => {
    let failing = true;
    const fetchFn = vi.fn(async () => (failing ? failure() : new Response('{}', { status: 202 })));
    const subject = uploader(fetchFn);
    subject.record('AUTH_REFRESH_TRANSPORT');

    await expect(subject.flush()).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await subject.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    failing = false;
    clock += 10_000;
    await subject.flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    clock += 60_000;
    await subject.flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('退避逐次加倍、有上限；照 Retry-After；五次都送不出就丢掉并记 TELEMETRY_DROPPED', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 503 }));
    const subject = uploader(fetchFn);
    subject.record('AUTH_REFRESH_TRANSPORT');
    const attemptsAfter = async (ms: number): Promise<number> => {
      clock += ms;
      await subject.flush();
      return fetchFn.mock.calls.length;
    };
    expect(await attemptsAfter(0)).toBe(1);
    expect(await attemptsAfter(9_000)).toBe(1);
    expect(await attemptsAfter(1_000)).toBe(2);
    expect(await attemptsAfter(19_000)).toBe(2);
    expect(await attemptsAfter(1_000)).toBe(3);
    expect(await attemptsAfter(40_000)).toBe(4);
    expect(await attemptsAfter(80_000)).toBe(5);
    fetchFn.mockImplementation(async () => new Response('{}', { status: 202 }));
    expect(await attemptsAfter(160_000)).toBe(6);
    expect(events(fetchFn).at(-1)).toEqual(expect.objectContaining({ code: 'TELEMETRY_DROPPED', count: 1 }));
  });

  it('429 带 Retry-After：至少等那么久', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
    const subject = uploader(fetchFn);
    subject.record('X_CODE');
    await subject.flush();
    clock += 60_000;
    await subject.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await subject.flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('400：这一批丢掉，不重试，不为它再报一条（免得循环）', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 400 }));
    const local: string[] = [];
    const subject = uploader(fetchFn, { onLocal: (code) => local.push(code) });
    subject.record('AUTH_REFRESH_TRANSPORT');
    await subject.flush();
    clock += 3_600_000;
    await subject.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(local).toEqual(['TELEMETRY_REJECTED']);
  });

  it('worker 重启：没送出的留在 storage.session，下一个 worker 接着送', async () => {
    const store = memoryStore();
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const first = uploader(offline, { store });
    first.record('AUTH_REFRESH_TRANSPORT');
    first.recordRun(run(), true);
    first.recordRun(run({ runId: 'a'.repeat(32), outcome: 'NEEDS_YOU', needsYou: '1', fillRate: '75-99' }), false);
    await first.flush();
    expect(offline).toHaveBeenCalled();

    const fetchFn = accepted();
    const second = uploader(fetchFn, { store });
    clock += 60_000;
    await second.flush();
    expect(events(fetchFn).map((event) => event.code)).toEqual(['AUTH_REFRESH_TRANSPORT', 'FILLED_ALL']);

    // 那份草稿还在拿着；终稿到了照样换掉。
    second.recordRun(run({ runId: 'a'.repeat(32), outcome: 'NEEDS_YOU', needsYou: '1', fillRate: '75-99', submitOutcome: 'rejected' }), true);
    await second.flush();
    expect(events(fetchFn).at(-1)).toEqual(expect.objectContaining({ code: 'NEEDS_YOU', run: expect.objectContaining({ submitOutcome: 'rejected' }) }));
  });

  it('存下来的队列有上限；读回来的坏条目丢掉', async () => {
    const store = memoryStore();
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const subject = uploader(offline, { store });
    for (let index = 0; index < 400; index += 1) subject.record(`CODE_${index}`);
    await subject.flush();
    const saved = store.value as { items: unknown[] };
    expect(saved.items.length).toBeLessThanOrEqual(201);

    store.value = { v: 1, items: [{ type: 'run', run: { runId: 'x', url: 'https://jobs.lever.co' } }, 'junk'], backoffUntil: 0, failures: 0, runsRejectedUntil: 0 };
    const fetchFn = accepted();
    const next = uploader(fetchFn, { store });
    next.record('AFTER_RESTART');
    await next.flush();
    expect(events(fetchFn).map((event) => event.code)).toEqual(['AFTER_RESTART']);
  });

  it('storage.session 读写出错：照样记、照样送（只是不跨重启）', async () => {
    const fetchFn = accepted();
    const local: string[] = [];
    const subject = uploader(fetchFn, {
      store: { get: async () => { throw new Error('no session'); }, set: async () => { throw new Error('quota'); } },
      onLocal: (code) => local.push(code),
    });
    subject.record('AUTH_REFRESH_TRANSPORT');
    await subject.flush();
    expect(events(fetchFn)).toEqual([expect.objectContaining({ code: 'AUTH_REFRESH_TRANSPORT' })]);
    expect(local).toEqual(expect.arrayContaining(['TELEMETRY_QUEUE_READ_FAILED']));
  });

  it('送的过程中又来了同一个码：那几次不丢', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchFn = vi.fn(async () => { await gate; return new Response('{}', { status: 202 }); });
    const subject = uploader(fetchFn);
    subject.record('AUTH_REFRESH_TRANSPORT');
    const sending = subject.flush();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    subject.record('AUTH_REFRESH_TRANSPORT');
    release();
    await sending;
    clock += 10_000;
    await subject.flush();
    expect(events(fetchFn).map((event) => event.count)).toEqual([1, 1]);
  });
});

describe('worker 未捕获的失败 → 稳定码', () => {
  it.each([
    [new TypeError('Cannot read properties of undefined (reading "value")'), 'error', 'worker:UNCAUGHT_ERROR:TypeError'],
    [new RangeError('x'), 'rejection', 'worker:UNHANDLED_REJECTION:RangeError'],
    ['plain string with page text', 'rejection', 'worker:UNHANDLED_REJECTION:string'],
    [undefined, 'error', 'worker:UNCAUGHT_ERROR:undefined'],
    [Object.assign(new Error('x'), { name: 'Weird name with spaces' }), 'error', 'worker:UNCAUGHT_ERROR:Error'],
  ] as const)('%s → %s', (reason, kind, code) => {
    expect(workerFailureCode(kind, reason)).toBe(code);
  });
});
