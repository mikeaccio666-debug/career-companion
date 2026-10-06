import { describe, expect, it, vi } from 'vitest';
import type { FullAiField, FullAiRequest } from '@edaix/contracts';

import { createAiAnswersClient, type AiStreamClientEvent } from '../lib/aiAnswersClient';
import {
  aiTimingCodes,
  createDockAiAnswersIntent,
  noEvidenceIds,
  parseDockAiAnswersIntent,
  parseDockAiAnswersReply,
  parseDockAiStreamMessage,
  usableAiFills,
  type DockAiStreamMessage,
} from '../lib/aiAnswersIntent';
import { AI_ANSWERS_SETTINGS_KEY, createAiAnswersProvider } from '../lib/aiAnswersProvider';

/**
 * 「AI 代答」的 worker 那一半（2026-09-23 负责人决定）。
 *
 *  · 消息：精确键集，题目按 argoland 的契约解析器全量校验（不透明题号、不带选择器与现值；岗位 job 可带、有上限）；
 *  · 开关：缺省开、按人存在本地；关着的时候一条请求都不发；
 *  · 客户端（2026-09-24 起只走 `plan/stream`）：402 是付费墙、429 只有服务端说 USAGE_EXHAUSTED 才算次数用完，其余是
 *    「这次没有」；流逐行按契约校验，一行不合格就不再读，已经交出去的照旧；
 *  · worker 把每一行筛成能写的答案按到达的先后交回，最后交代没拿到答案的题；
 *  · 能写的只有 fill、≥ 0.85、引了资料、不是拿「记住的答案」答的；只能本人答的题再挡一次；
 *  · 诊断只有码与个数。
 *
 * 夹具全是合成文字。
 */

const PAGE = ['https://job-boards.greenhouse.io', '/acme/jobs/12345'] as const;
const UUID = '11111111-1111-4111-8111-111111111111';

const field = (id: string, extra: Partial<FullAiField> = {}): FullAiField => ({
  id, kind: 'textarea', label: 'Why do you want to work here?', context: '', autocomplete: '', required: true,
  hasValue: false, maxLength: null, options: [], optionsComplete: false, ...extra,
});
const KOTLIN = field('f1', {
  kind: 'radio', label: 'Do you have experience with Kotlin?',
  options: [{ id: 'o0', label: 'Yes' }, { id: 'o1', label: 'No' }], optionsComplete: true,
});
const plan = (fields: FullAiField[] = [field('f0'), KOTLIN]) =>
  createDockAiAnswersIntent(...PAGE, { step: 'PLAN', title: 'Analyst at Acme', fields });

const request = (fields: FullAiField[]): FullAiRequest => ({
  schemaVersion: 1, requestId: UUID, snapshotId: UUID,
  page: { origin: PAGE[0], pathname: PAGE[1], title: 'Analyst at Acme' }, fields,
});
/** 流上的一行（合成）：按契约对得上请求。 */
const answersLine = (req: FullAiRequest, lane: 'direct' | 'fast' | 'long', instructions: unknown[]) => ({
  schemaVersion: 1, type: 'answers', requestId: req.requestId, snapshotId: req.snapshotId, lane, profileRevision: '3', deletionEpoch: '0',
  expiresAt: '2026-09-24T12:00:00.000Z', instructions,
});
const doneLine = (req: FullAiRequest, unanswered: { code: string; fieldIds: string[] }[] = []) => ({
  schemaVersion: 1, type: 'done', ok: true, requestId: req.requestId, unanswered,
  metrics: { planningMs: 1, fieldCount: req.fields.length, modelCalls: 1, fastMs: 1, longMs: null, model: 'test' },
});
/** NDJSON 应答：一行一个 JSON（字符串原样，用来造坏行）。 */
const ndjson = (lines: unknown[], status = 200, contentType = 'application/x-ndjson; charset=utf-8') =>
  new Response(lines.map((line) => `${typeof line === 'string' ? line : JSON.stringify(line)}\n`).join(''), { status, headers: { 'content-type': contentType } });
const instruction = (id: string, extra: Record<string, unknown> = {}) => ({
  id, action: 'fill', value: 'Because the product matches my experience.', optionIds: [], sourcePaths: ['experiences.0.summary'],
  confidence: 0.9, reason: 'DRAFT', ...extra,
});

describe('消息', () => {
  it('造出来的 PLAN 在 worker 那一侧按契约收下，页面、题目与岗位原样带过去', () => {
    const intent = plan();
    expect(intent).not.toBeNull();
    const parsed = parseDockAiAnswersIntent(intent);
    expect(parsed).toMatchObject({ step: 'PLAN', origin: PAGE[0], pathname: PAGE[1], title: 'Analyst at Acme' });
    expect(parsed?.step === 'PLAN' ? parsed.fields : null).toEqual([field('f0'), KOTLIN]);
    const job = { title: 'Analyst', company: 'Acme', description: 'Build reporting.\nWork with finance.' };
    const withJob = parseDockAiAnswersIntent(createDockAiAnswersIntent(...PAGE, { step: 'PLAN', title: 'Analyst at Acme', fields: [field('f0')], job }));
    expect(withJob?.step === 'PLAN' ? withJob.job : null).toEqual(job);
  });

  it.each([
    ['题号像选择器', () => plan([field('textarea#why')])],
    ['题目带了现值之外的键', () => plan([{ ...field('f0'), value: 'x' } as never])],
    ['多一个键', () => ({ ...plan()!, selector: '#why' })],
    ['一题都没有', () => plan([])],
    ['岗位描述超过上限', () => createDockAiAnswersIntent(...PAGE, { step: 'PLAN', title: 'x', fields: [field('f0')], job: { description: 'x'.repeat(12_001) } })],
    ['岗位多一个键', () => createDockAiAnswersIntent(...PAGE, { step: 'PLAN', title: 'x', fields: [field('f0')], job: { salary: '1' } as never })],
  ])('%s → 整条作废', (_why, build) => {
    expect(parseDockAiAnswersIntent(build())).toBeNull();
  });

  it('开关、回报与计时：精确键集、闭集；计时只收毫秒与个数', () => {
    expect(parseDockAiAnswersIntent(createDockAiAnswersIntent(...PAGE, { step: 'SETTINGS_SET', enabled: false }))).toMatchObject({ step: 'SETTINGS_SET', enabled: false });
    expect(parseDockAiAnswersIntent({ ...createDockAiAnswersIntent(...PAGE, { step: 'SETTINGS_SET', enabled: false })!, enabled: 'no' })).toBeNull();
    expect(parseDockAiAnswersIntent(createDockAiAnswersIntent(...PAGE, { step: 'REPORT', outcome: 'APPLIED', count: 3 }))).toMatchObject({ outcome: 'APPLIED', count: 3 });
    expect(parseDockAiAnswersIntent({ ...createDockAiAnswersIntent(...PAGE, { step: 'REPORT', outcome: 'APPLIED', count: 3 })!, outcome: 'Why do you want to work here?' })).toBeNull();
    const marks = [{ at: 'SENT', ms: 850 }, { at: 'FAST', ms: 3_400 }, { at: 'WRITE', ms: 3_500, count: 4 }, { at: 'DONE', ms: 5_300 }] as const;
    expect(parseDockAiAnswersIntent(createDockAiAnswersIntent(...PAGE, { step: 'TIMING', marks }))).toMatchObject({ step: 'TIMING', marks });
    for (const bad of [
      [{ at: 'SENT', ms: -1 }],
      [{ at: 'SENT', ms: 1.5 }],
      [{ at: 'LABEL', ms: 10 }],
      [{ at: 'SENT', ms: 10, label: 'Why do you want to work here?' }],
      [{ at: 'WRITE', ms: 10 }],
      [],
    ]) expect(parseDockAiAnswersIntent(createDockAiAnswersIntent(...PAGE, { step: 'TIMING', marks: bad as never })), JSON.stringify(bad)).toBeNull();
    expect(aiTimingCodes([{ at: 'DONE', ms: 5_300 }, { at: 'SENT', ms: 850 }, { at: 'WRITE', ms: 3_500, count: 4 }, { at: 'READY', ms: 31_200, count: 1 }]))
      .toEqual(['AI_MS_SENT850_W3500X4_DONE5300_R31200X1']);
  });

  it('计时码与别的诊断码同一个形状（浮层与审计面板只摆 ^[A-Z0-9_]{3,64}$），一条放不下就接着下一条', () => {
    // 最长的一轮：五个时刻、十批写入、一次晚到，毫秒与个数都取到上限。
    const marks = [
      ...(['SENT', 'OPEN', 'FAST', 'LONG', 'DONE'] as const).map((at) => ({ at, ms: 600_000 })),
      ...Array.from({ length: 10 }, () => ({ at: 'WRITE' as const, ms: 600_000, count: 120 })),
      { at: 'READY' as const, ms: 600_000, count: 120 },
    ];
    const codes = aiTimingCodes(marks);
    expect(codes.length).toBeGreaterThan(1);
    for (const code of codes) expect(code).toMatch(/^AI_MS_[A-Z0-9_]+$/u);
    for (const code of codes) expect(code.length).toBeLessThanOrEqual(64);
    // 拆开再接回去，一个时刻都不丢、顺序不变。
    expect(codes.map((code) => code.slice('AI_MS_'.length)).join('_').split('_')).toHaveLength(marks.length);
    const typical = aiTimingCodes([
      { at: 'SENT', ms: 812 }, { at: 'OPEN', ms: 1_104 }, { at: 'FAST', ms: 3_420 }, { at: 'WRITE', ms: 3_560, count: 4 },
      { at: 'WRITE', ms: 4_010, count: 2 }, { at: 'LONG', ms: 6_880 }, { at: 'WRITE', ms: 6_950, count: 1 }, { at: 'DONE', ms: 9_120 },
    ]);
    expect(typical).toEqual(['AI_MS_SENT812_OPEN1104_FAST3420_W3560X4_W4010X2_LONG6880_W6950X1', 'AI_MS_DONE9120']);
  });

  it('长连接上的消息：答案逐条按上限校验，认不出的一条就是整条流到此为止', () => {
    expect(parseDockAiStreamMessage({ kind: 'AI_STREAM_ANSWERS', lane: 'fast', fills: [{ id: 'f0', value: 'x', optionIds: [] }], noEvidence: ['f1'] }))
      .toEqual({ kind: 'AI_STREAM_ANSWERS', lane: 'fast', fills: [{ id: 'f0', value: 'x', optionIds: [] }], noEvidence: ['f1'] });
    expect(parseDockAiStreamMessage({ kind: 'AI_STREAM_ANSWERS', lane: 'fast', fills: [{ id: 'f0', value: 'x'.repeat(6_001), optionIds: [] }], noEvidence: [] })).toBeNull();
    // 道只用来打时间点（2026-09-28）：这一版不认识的道照收，不像道名的照旧拒。
    expect(parseDockAiStreamMessage({ kind: 'AI_STREAM_ANSWERS', lane: 'rescue', fills: [], noEvidence: [] }))
      .toEqual({ kind: 'AI_STREAM_ANSWERS', lane: 'rescue', fills: [], noEvidence: [] });
    expect(parseDockAiStreamMessage({ kind: 'AI_STREAM_ANSWERS', lane: 'slow lane', fills: [], noEvidence: [] })).toBeNull();
    expect(parseDockAiStreamMessage({ kind: 'AI_STREAM_ANSWERS', lane: 'fast', fills: [], noEvidence: ['#why'] })).toBeNull();
    expect(parseDockAiStreamMessage({ kind: 'AI_STREAM_END', unanswered: ['f2'] })).toEqual({ kind: 'AI_STREAM_END', unanswered: ['f2'] });
    expect(parseDockAiStreamMessage({ kind: 'AI_STREAM_END', unanswered: ['f2'], documentPathname: '/x' })).toBeNull();
    expect(parseDockAiStreamMessage({ kind: 'AI_STREAM_OPEN' })).toEqual({ kind: 'AI_STREAM_OPEN' });
    expect(parseDockAiStreamMessage({ kind: 'REFUSED', code: 'QUOTA_EXCEEDED' })).toEqual({ kind: 'REFUSED', code: 'QUOTA_EXCEEDED' });
    expect(parseDockAiStreamMessage({ kind: 'REFUSED', code: 'FULL_AI_PROVIDER_FAILED' })).toBeNull();
    // 一次性的规划答复已经没有了：只剩改写、次数与开关。
    expect(parseDockAiAnswersReply({ kind: 'AI_ANSWERS', fills: [], noEvidence: [] })).toBeNull();
  });
});

describe('能写的答案', () => {
  const req = request([field('f0', { maxLength: 400 }), KOTLIN, field('f2', { label: 'Portfolio notes' }), field('f3', { label: 'Tell us about yourself' }), field('f4', { label: 'Anything else?' })]);

  it('只收 fill、≥ 0.85、引了资料的；选择题带选项 id', () => {
    const fills = usableAiFills([
      instruction('f0'),
      instruction('f1', { value: null, optionIds: ['o0'], reason: 'PROFILE', sourcePaths: ['skills.3.name'] }),
      instruction('f2', { confidence: 0.84 }),
      instruction('f3', { action: 'review', reason: 'LOW_CONFIDENCE' }),
      instruction('f4', { sourcePaths: [] }),
    ] as never, req);
    expect(fills).toEqual([
      { id: 'f0', value: 'Because the product matches my experience.', optionIds: [] },
      { id: 'f1', value: null, optionIds: ['o0'] },
    ]);
  });

  it('拿「记住的答案」答的不收：那归答案记忆的开关管', () => {
    const one = request([field('f0')]);
    expect(usableAiFills([instruction('f0', { sourcePaths: ['confirmedAnswers.f0'], reason: 'PROFILE', confidence: 1 })] as never, one)).toEqual([]);
  });

  it('只能本人答的题（工作授权、同意条款）再挡一次，哪怕服务端给了 fill', () => {
    const risky = request([field('f0', { kind: 'radio', label: 'Are you legally authorized to work in the United States?', options: [{ id: 'o0', label: 'Yes' }], optionsComplete: true })]);
    expect(usableAiFills([instruction('f0', { value: null, optionIds: ['o0'], reason: 'PROFILE' })] as never, risky)).toEqual([]);
  });

  it('在资料里没找到依据的题：skip／review，理由是资料里没有或证据不够；只能本人答、控件不支持、选项读不全的不算', () => {
    const five = request([field('f0'), field('f1'), field('f2'), field('f3'), field('f4')]);
    expect(noEvidenceIds([
      instruction('f0', { action: 'skip', value: null, sourcePaths: [], confidence: 0, reason: 'MISSING_PROFILE' }),
      instruction('f1', { action: 'review', reason: 'LOW_CONFIDENCE', confidence: 0.6 }),
      instruction('f2', { action: 'review', value: null, reason: 'MANUAL_REQUIRED' }),
      instruction('f3', { action: 'review', value: null, reason: 'OPTIONS_UNAVAILABLE' }),
      instruction('f4'),
    ] as never, five)).toEqual(['f0', 'f1']);
  });
});

describe('客户端：plan/stream', () => {
  const req = request([field('f0'), KOTLIN]);
  const client = (fetchFn: unknown, token: string | null = 'tok', refresh?: () => Promise<string | null>) =>
    createAiAnswersClient({ apiBase: 'https://api.argoland.ai', getAccessToken: async () => token, fetchFn: fetchFn as typeof fetch, ...(refresh ? { refreshAccessToken: refresh } : {}) });
  const collect = () => {
    const events: AiStreamClientEvent[] = [];
    return { events, onEvent: (event: AiStreamClientEvent) => events.push(event) };
  };

  it('打契约里的路径、带 bearer、要 NDJSON、不缓存；每行按到达的先后交出去，done 在结局里', async () => {
    const fetchFn = vi.fn(async () => ndjson([
      answersLine(req, 'fast', [instruction('f1', { value: null, optionIds: ['o0'], reason: 'PROFILE' })]),
      answersLine(req, 'long', [instruction('f0')]),
      doneLine(req),
    ]));
    const seen = collect();
    const result = await client(fetchFn).planStream(req, seen.onEvent);
    expect(result).toMatchObject({ ok: true, done: { type: 'done', ok: true } });
    expect(seen.events.map((event) => event.kind === 'LINE' ? event.event.lane : event.kind)).toEqual(['OPEN', 'fast', 'long']);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.argoland.ai/api/v1/agent/full-ai-autofill/plan/stream');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>).accept).toBe('application/x-ndjson');
    expect(init.cache).toBe('no-store');
    expect(JSON.parse(String(init.body))).toEqual(req);
  });

  it('一行不合格就不再读：已经交出去的照旧，结局是 INVALID_RESPONSE 与之前交出去的行数', async () => {
    const seen = collect();
    const result = await client(vi.fn(async () => ndjson([
      answersLine(req, 'fast', [instruction('f1', { value: null, optionIds: ['o0'], reason: 'PROFILE' })]),
      'not json',
      answersLine(req, 'long', [instruction('f0')]),
      doneLine(req),
    ]))).planStream(req, seen.onEvent);
    expect(result).toEqual({ ok: false, code: 'INVALID_RESPONSE', answered: 1 });
    expect(seen.events.filter((event) => event.kind === 'LINE')).toHaveLength(1);
    // 同一题放两次、对不上请求：同样到此为止。
    const twice = await client(vi.fn(async () => ndjson([
      answersLine(req, 'fast', [instruction('f0')]),
      answersLine(req, 'long', [instruction('f0')]),
    ]))).planStream(req, collect().onEvent);
    expect(twice).toEqual({ ok: false, code: 'INVALID_RESPONSE', answered: 1 });
  });

  /**
   * 后端先发的加法（2026-09-28）：流上多一种行（进度、心跳……）、一道新的道、一条用了新动作的指令。
   * 在此之前任何一样都让整条流判坏——计量的一轮白扣，答案一个都不要。现在：新行跳过，新道照收，
   * 新动作的那一题算放出来了但不交出去（留给用户自己答），都各记一个事件给 worker 记码。
   */
  it('这一版不认识的行、道与指令：跳过或不交出去，别的照常，结局照常读到 done', async () => {
    const seen = collect();
    const result = await client(vi.fn(async () => ndjson([
      { schemaVersion: 1, type: 'progress', percent: 30 },
      { ...answersLine(req, 'fast', [
        instruction('f1', { value: null, optionIds: ['o0'], reason: 'PROFILE' }),
        instruction('f0', { action: 'suggest' }),
      ]), lane: 'rescue', traceId: 't-1' },
      { schemaVersion: 1, type: 'heartbeat' },
      doneLine(req),
    ]))).planStream(req, seen.onEvent);
    expect(result).toMatchObject({ ok: true, done: { type: 'done', ok: true } });
    expect(seen.events.map((event) => event.kind === 'LINE'
      ? `LINE:${event.event.lane}:${event.event.instructions.map((one) => one.id).join(',')}`
      : event.kind === 'SKIPPED' ? `SKIPPED:${event.what}` : event.kind)).toEqual([
      'OPEN', 'SKIPPED:LINE_TYPE', 'SKIPPED:INSTRUCTION', 'LINE:rescue:f1', 'SKIPPED:LINE_TYPE',
    ]);
  });

  it('流断了却没有 done：已经交出去的照旧；200 却不是 NDJSON：一行都不读', async () => {
    expect(await client(vi.fn(async () => ndjson([answersLine(req, 'fast', [instruction('f0')])]))).planStream(req, collect().onEvent))
      .toEqual({ ok: false, code: 'INVALID_RESPONSE', answered: 1 });
    const html = collect();
    expect(await client(vi.fn(async () => ndjson(['<html>proxy</html>'], 200, 'text/html'))).planStream(req, html.onEvent))
      .toEqual({ ok: false, code: 'INVALID_RESPONSE', answered: 0 });
    expect(html.events).toEqual([]);
  });

  it.each([
    [402, {}, 'PAYWALL_REQUIRED'],
    [429, { code: 'USAGE_EXHAUSTED' }, 'QUOTA_EXCEEDED'],
    [429, { code: 'RATE_LIMITED' }, 'RATE_LIMITED'],
    [404, {}, 'FULL_AI_UNAVAILABLE'],
    [500, {}, 'FULL_AI_UNAVAILABLE'],
  ])('%s %j → %s（第一行之前）', async (status, body, code) => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    expect(await client(fetchFn).planStream(req, collect().onEvent)).toEqual({ ok: false, code, answered: 0 });
  });

  it('401 刷新一次；没有 token 不发请求；断网是 NETWORK；调用方断开是 FULL_AI_CANCELLED', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(ndjson([answersLine(req, 'fast', [instruction('f0')]), doneLine(req, [{ code: 'FULL_AI_PROVIDER_FAILED', fieldIds: ['f1'] }])]));
    expect((await client(fetchFn, 'old', async () => 'new').planStream(req, collect().onEvent)).ok).toBe(true);
    expect(((fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBe('Bearer new');
    const never = vi.fn();
    expect(await client(never, null).planStream(req, collect().onEvent)).toEqual({ ok: false, code: 'AUTH_REQUIRED', answered: 0 });
    expect(never).not.toHaveBeenCalled();
    expect(await client(vi.fn(async () => { throw new TypeError('offline'); })).planStream(req, collect().onEvent)).toEqual({ ok: false, code: 'NETWORK', answered: 0 });
    const gone = new AbortController();
    // 像真的 fetch 一样：信号已经断了就立刻拒绝，否则等它断。
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener('abort', abort);
    }));
    const pending = client(hanging).planStream(req, collect().onEvent, gone.signal);
    gone.abort();
    expect(await pending).toEqual({ ok: false, code: 'FULL_AI_CANCELLED', answered: 0 });
  });
});

describe('worker 的开关与规划（流）', () => {
  const memoryStorage = (initial: Record<string, unknown> = {}) => {
    const data = { ...initial };
    return { data, get: async (key: string) => data[key], set: async (key: string, value: unknown) => { data[key] = value; } };
  };
  const streamed = (lines: (req: FullAiRequest) => unknown[]) =>
    vi.fn(async (req: FullAiRequest, onEvent: (event: AiStreamClientEvent) => void) => {
      onEvent({ kind: 'OPEN' });
      let done: unknown = null;
      for (const line of lines(req)) {
        const typed = line as { type: string };
        if (typed.type === 'done') done = line;
        else onEvent({ kind: 'LINE', event: line as never });
      }
      return done === null ? { ok: false as const, code: 'INVALID_RESPONSE' as const, answered: 1 } : { ok: true as const, done: done as never };
    });
  /** 与 worker 的环形缓冲同一个写法：数量码写成 `<码>_<数>`；只进本机的码另记在 `local` 里。 */
  const local: string[] = [];
  const provider = (planStream: unknown, diagnostics: string[] = [], storage = memoryStorage(), job?: unknown) =>
    ({
      provider: createAiAnswersProvider({
        client: { planStream: planStream as never, revise: vi.fn(), quota: vi.fn() }, storage, userId: async () => 'user-1', newId: () => UUID,
        onDiagnostic: (code, count) => diagnostics.push(count === undefined ? code : `${code}_${count}`),
        onLocalDiagnostic: (code) => local.push(code),
      }),
      intent: parseDockAiAnswersIntent(job === undefined ? plan() : createDockAiAnswersIntent(...PAGE, { step: 'PLAN', title: 'Analyst at Acme', fields: [field('f0'), KOTLIN], job: job as never }))!,
    });
  const run = async (planStream: unknown, diagnostics: string[] = [], storage = memoryStorage(), job?: unknown) => {
    const { provider: made, intent } = provider(planStream, diagnostics, storage, job);
    const messages: DockAiStreamMessage[] = [];
    await made.stream(intent, (message) => messages.push(message), new AbortController().signal);
    return messages;
  };

  it('缺省开：铸 requestId、带上岗位，每一行筛成能写的答案按到达的先后交回，最后交代没答上的题', async () => {
    const planStream = streamed((req) => [
      answersLine(req, 'fast', [instruction('f1', { value: null, optionIds: ['o1'], reason: 'PROFILE' })]),
      doneLine(req, [{ code: 'FULL_AI_PROVIDER_FAILED', fieldIds: ['f0'] }]),
    ]);
    const diagnostics: string[] = [];
    const job = { title: 'Analyst', company: 'Acme' };
    const messages = await run(planStream, diagnostics, memoryStorage(), job);
    expect(messages).toEqual([
      { kind: 'AI_STREAM_OPEN' },
      { kind: 'AI_STREAM_ANSWERS', lane: 'fast', fills: [{ id: 'f1', value: null, optionIds: ['o1'] }], noEvidence: [] },
      { kind: 'AI_STREAM_END', unanswered: ['f0'] },
    ]);
    const sent = planStream.mock.calls[0]![0];
    expect(sent).toMatchObject({ schemaVersion: 1, requestId: UUID, snapshotId: UUID, page: { origin: PAGE[0], pathname: PAGE[1] }, job });
    // 诊断只有码与个数：题面、答案、岗位一个字都不进。
    expect(diagnostics).toEqual([
      'AI_ANSWERS_DRAFTED_1',
      'AI_ANSWERS_UNANSWERED_1',
      'AI_SERVER_TIMING_LT2S',
      'AI_SERVER_MODEL_CALLS_1',
      'AI_ANSWERS_UNANSWERED_FULL_AI_PROVIDER_FAILED_1',
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/work here|Kotlin|Because|Acme|Analyst/);
  });

  it('后端先发的加法被跳过时各记一个码；被跳过指令的那一题当没答上，留给用户（2026-09-28）', async () => {
    const diagnostics: string[] = [];
    const planStream = vi.fn(async (req: FullAiRequest, onEvent: (event: AiStreamClientEvent) => void) => {
      onEvent({ kind: 'OPEN' });
      onEvent({ kind: 'SKIPPED', what: 'LINE_TYPE' });
      onEvent({ kind: 'SKIPPED', what: 'INSTRUCTION' });
      onEvent({ kind: 'LINE', event: answersLine(req, 'fast', [instruction('f1', { value: null, optionIds: ['o1'], reason: 'PROFILE' })]) as never });
      return { ok: true as const, done: doneLine(req) as never };
    });
    const messages = await run(planStream, diagnostics);
    expect(messages).toEqual([
      { kind: 'AI_STREAM_OPEN' },
      { kind: 'AI_STREAM_ANSWERS', lane: 'fast', fills: [{ id: 'f1', value: null, optionIds: ['o1'] }], noEvidence: [] },
      { kind: 'AI_STREAM_END', unanswered: ['f0'] },
    ]);
    expect(diagnostics).toEqual(expect.arrayContaining(['AI_ANSWERS_UNKNOWN_LINE_SKIPPED', 'AI_ANSWERS_UNKNOWN_INSTRUCTION_SKIPPED']));
  });

  it('资料里没找到依据的题号随那一批交回；诊断只记个数', async () => {
    const diagnostics: string[] = [];
    const messages = await run(streamed((req) => [
      answersLine(req, 'fast', [instruction('f1', { value: null, optionIds: ['o0'] })]),
      answersLine(req, 'long', [instruction('f0', { action: 'skip', value: null, sourcePaths: [], confidence: 0, reason: 'MISSING_PROFILE' })]),
      doneLine(req),
    ]), diagnostics);
    expect(messages.slice(1)).toEqual([
      { kind: 'AI_STREAM_ANSWERS', lane: 'fast', fills: [{ id: 'f1', value: null, optionIds: ['o0'] }], noEvidence: [] },
      { kind: 'AI_STREAM_ANSWERS', lane: 'long', fills: [], noEvidence: ['f0'] },
      { kind: 'AI_STREAM_END', unanswered: [] },
    ]);
    expect(diagnostics).toEqual(['AI_ANSWERS_DRAFTED_1', 'AI_ANSWERS_NO_EVIDENCE_1', 'AI_SERVER_TIMING_LT2S', 'AI_SERVER_MODEL_CALLS_1']);
    expect(local.at(-1)).toBe('AI_SERVER_MS_FAST1_LONGNA_ALL1_CALLS1');
  });

  it('服务端自己量的时刻（done 里的 metrics）：逐项那一串只进本机，上报的是固定的码与桶；只有数字，没有模型名；读不到 done 就不记', async () => {
    const diagnostics: string[] = [];
    local.length = 0;
    await run(streamed((req) => [
      answersLine(req, 'fast', [instruction('f1', { value: null, optionIds: ['o0'] })]),
      answersLine(req, 'long', [instruction('f0')]),
      { ...doneLine(req), metrics: { planningMs: 6_020, fieldCount: 2, modelCalls: 2, fastMs: 2_310, longMs: 5_980, model: 'claude-test' } },
    ]), diagnostics);
    expect(local).toContain('AI_SERVER_MS_FAST2310_LONG5980_ALL6020_CALLS2');
    expect(diagnostics).toEqual(expect.arrayContaining(['AI_SERVER_TIMING_LT10S', 'AI_SERVER_MODEL_CALLS_2']));
    expect(diagnostics.some((code) => code.startsWith('AI_SERVER_MS_'))).toBe(false);
    expect(diagnostics.every((code) => /^[A-Z0-9_]{3,64}$/.test(code))).toBe(true);
    expect(JSON.stringify([...diagnostics, ...local])).not.toContain('claude');
    const cut: string[] = [];
    await run(streamed((req) => [answersLine(req, 'fast', [instruction('f1', { value: null, optionIds: ['o0'] })])]), cut);
    expect(cut.some((code) => code.startsWith('AI_SERVER_MS_'))).toBe(false);
  });

  it('流半路断了：已经交回的照旧，其余当没答上；一行都没有就失败的，整轮拒绝', async () => {
    const diagnostics: string[] = [];
    expect(await run(streamed((req) => [answersLine(req, 'fast', [instruction('f1', { value: null, optionIds: ['o0'] })])]), diagnostics))
      .toEqual([
        { kind: 'AI_STREAM_OPEN' },
        { kind: 'AI_STREAM_ANSWERS', lane: 'fast', fills: [{ id: 'f1', value: null, optionIds: ['o0'] }], noEvidence: [] },
        { kind: 'AI_STREAM_END', unanswered: ['f0'] },
      ]);
    expect(diagnostics[0]).toBe('AI_ANSWERS_INVALID_RESPONSE');
    for (const [code, refusal] of [
      ['PAYWALL_REQUIRED', 'PAYWALL_REQUIRED'],
      ['QUOTA_EXCEEDED', 'QUOTA_EXCEEDED'],
      ['AUTH_REQUIRED', 'AUTH_REQUIRED'],
      ['TIMEOUT', 'UNAVAILABLE'],
    ] as const) {
      const seen: string[] = [];
      expect(await run(vi.fn(async () => ({ ok: false as const, code, answered: 0 })), seen)).toEqual([{ kind: 'REFUSED', code: refusal }]);
      expect(seen).toEqual([`AI_ANSWERS_${code}`]);
    }
    // 服务端的 done 说整轮失败（一行都没放）：同样是拒绝。
    const busy = await run(vi.fn(async () => ({ ok: true as const, done: { schemaVersion: 1, type: 'done', ok: false, code: 'FULL_AI_BUSY' } as never })));
    expect(busy).toEqual([{ kind: 'REFUSED', code: 'UNAVAILABLE' }]);
  });

  it('关掉之后一条请求都不发；开关按人存，别人的不受影响；一次性的 PLAN 消息不再发请求', async () => {
    const storage = memoryStorage();
    const planStream = vi.fn();
    let user = 'user-1';
    const made = createAiAnswersProvider({ client: { planStream, revise: vi.fn(), quota: vi.fn() }, storage, userId: async () => user, newId: () => UUID });
    const set = createDockAiAnswersIntent(...PAGE, { step: 'SETTINGS_SET', enabled: false });
    expect(await made.handle(parseDockAiAnswersIntent(set)!)).toEqual({ kind: 'AI_ANSWERS_SETTINGS', enabled: false });
    expect(storage.data[AI_ANSWERS_SETTINGS_KEY]).toEqual({ 'user-1': false });
    const messages: DockAiStreamMessage[] = [];
    await made.stream(parseDockAiAnswersIntent(plan())!, (message) => messages.push(message), new AbortController().signal);
    expect(messages).toEqual([{ kind: 'REFUSED', code: 'SWITCHED_OFF' }]);
    expect(planStream).not.toHaveBeenCalled();
    user = 'user-2';
    const get = parseDockAiAnswersIntent(createDockAiAnswersIntent(...PAGE, { step: 'SETTINGS_GET' }))!;
    expect(await made.handle(get)).toEqual({ kind: 'AI_ANSWERS_SETTINGS', enabled: true });
    expect(await made.handle(parseDockAiAnswersIntent(plan())!)).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    expect(planStream).not.toHaveBeenCalled();
  });

  it('回报与计时只落码与个数：码里不嵌数字（个数随码交出去，毫秒只上报桶），逐个时刻的那一串只进本机', async () => {
    const diagnostics: Array<[string, number | undefined]> = [];
    const localOnly: string[] = [];
    const made = createAiAnswersProvider({
      client: { planStream: vi.fn(), revise: vi.fn(), quota: vi.fn() }, storage: memoryStorage(), userId: async () => null,
      onDiagnostic: (one, count) => diagnostics.push([one, count]),
      onLocalDiagnostic: (one) => localOnly.push(one),
    });
    const report = parseDockAiAnswersIntent(createDockAiAnswersIntent(...PAGE, { step: 'REPORT', outcome: 'APPLIED', count: 2 }))!;
    expect(await made.handle(report)).toEqual({ kind: 'AI_ANSWERS_NOTED' });
    const timing = parseDockAiAnswersIntent(createDockAiAnswersIntent(...PAGE, {
      step: 'TIMING',
      marks: [{ at: 'SENT', ms: 812 }, { at: 'OPEN', ms: 1_104 }, { at: 'FAST', ms: 3_420 }, { at: 'WRITE', ms: 3_560, count: 4 }, { at: 'DONE', ms: 5_310 }],
    }))!;
    expect(await made.handle(timing)).toEqual({ kind: 'AI_ANSWERS_NOTED' });
    expect(diagnostics).toEqual([
      ['AI_ANSWERS_APPLIED', 2],
      ['AI_TIMING_FIRST_WRITE_LT5S', undefined],
      ['AI_TIMING_DONE_LT10S', undefined],
    ]);
    expect(localOnly).toEqual(['AI_MS_SENT812_OPEN1104_FAST3420_W3560X4_DONE5310']);
  });
});

/**
 * 「用 AI 写 / AI 改写」这一题与 AI 次数（2026-09-24 负责人决定）。argoland 的两个端点还没上线：照计划的形状
 * 写（draft 契约），调用失败（404 之类）一律当「暂时用不了」，别的都不受影响。
 */
describe('用 AI 写这一题（DRAFT 端点）', () => {
  const memoryStorage = () => {
    const data: Record<string, unknown> = {};
    return { data, get: async (key: string) => data[key], set: async (key: string, value: unknown) => { data[key] = value; } };
  };
  const reviseIntent = (extra: Partial<{ currentValue: string; instruction: string; field: FullAiField }> = {}) =>
    createDockAiAnswersIntent(...PAGE, { step: 'REVISE', title: 'Analyst at Acme', field: field('f0', { maxLength: 500 }), currentValue: '', instruction: 'Keep it short', ...extra });
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

  it('消息：只收文本题，要求不超过 1000 字', () => {
    expect(parseDockAiAnswersIntent(reviseIntent())).toMatchObject({ step: 'REVISE', currentValue: '', instruction: 'Keep it short' });
    expect(parseDockAiAnswersIntent(reviseIntent({ instruction: 'x'.repeat(1_001) }))).toBeNull();
    expect(parseDockAiAnswersIntent(reviseIntent({ field: KOTLIN }))).toBeNull();
  });

  it('开着：铸 requestId、把题、现值与要求交过去，答回的文字原样交回；空字符串也原样交回（资料不够）', async () => {
    const revise = vi.fn(async () => ({ ok: true as const, value: 'I built the billing service at a startup.' }));
    const diagnostics: string[] = [];
    const provider = createAiAnswersProvider({
      client: { planStream: vi.fn(), revise, quota: vi.fn() }, storage: memoryStorage(), userId: async () => 'user-1', newId: () => UUID,
      onDiagnostic: (code) => diagnostics.push(code),
    });
    expect(await provider.handle(parseDockAiAnswersIntent(reviseIntent({ currentValue: 'Draft text', instruction: 'Mention payments' }))!))
      .toEqual({ kind: 'AI_REVISED', value: 'I built the billing service at a startup.' });
    expect(revise).toHaveBeenCalledWith({
      schemaVersion: 1, requestId: UUID, page: { origin: PAGE[0], pathname: PAGE[1], title: 'Analyst at Acme' },
      field: field('f0', { maxLength: 500 }), currentValue: 'Draft text', instruction: 'Mention payments',
    });
    revise.mockResolvedValueOnce({ ok: true, value: '' });
    expect(await provider.handle(parseDockAiAnswersIntent(reviseIntent())!)).toEqual({ kind: 'AI_REVISED', value: '' });
    expect(diagnostics).toEqual(['AI_REVISE_DRAFTED', 'AI_REVISE_NOTHING_TO_WRITE']);
  });

  it('开关关着：卡片里的「生成」也不发', async () => {
    const storage = memoryStorage();
    storage.data.aiAnswersSettings = { 'user-1': false };
    const revise = vi.fn();
    const provider = createAiAnswersProvider({ client: { planStream: vi.fn(), revise, quota: vi.fn() }, storage, userId: async () => 'user-1', newId: () => UUID });
    expect(await provider.handle(parseDockAiAnswersIntent(reviseIntent())!)).toEqual({ kind: 'REFUSED', code: 'SWITCHED_OFF' });
    expect(revise).not.toHaveBeenCalled();
  });

  it('端点还没上线（404）→ 暂时用不了；次数用完 → QUOTA_EXCEEDED；打的是计划里的路径', async () => {
    const request = parseDockAiAnswersIntent(reviseIntent())!;
    const client = (fetchFn: unknown) => createAiAnswersClient({ apiBase: 'https://api.argoland.ai', getAccessToken: async () => 'tok', fetchFn: fetchFn as typeof fetch });
    const missing = respond(404, { statusCode: 404, message: 'Cannot POST' });
    const provider = createAiAnswersProvider({ client: client(missing), storage: memoryStorage(), userId: async () => 'user-1', newId: () => UUID });
    expect(await provider.handle(request)).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    expect((missing.mock.calls[0] as unknown as [string])[0]).toBe('https://api.argoland.ai/api/v1/agent/full-ai-autofill/revise');
    const usedUp = createAiAnswersProvider({ client: client(respond(200, { schemaVersion: 1, ok: false, code: 'QUOTA_EXCEEDED' })), storage: memoryStorage(), userId: async () => 'user-1', newId: () => UUID });
    expect(await usedUp.handle(request)).toEqual({ kind: 'REFUSED', code: 'QUOTA_EXCEEDED' });
  });

  it('次数：GET 计划里的路径；会员不限、免费用户剩几次；没上线就是「暂时用不了」', async () => {
    const quota = respond(200, { schemaVersion: 1, unlimited: false, limit: 10, remaining: 7, resetsAt: '2026-10-01T00:00:00.000Z' });
    const client = createAiAnswersClient({ apiBase: 'https://api.argoland.ai', getAccessToken: async () => 'tok', fetchFn: quota as never });
    const provider = createAiAnswersProvider({ client, storage: memoryStorage(), userId: async () => 'user-1' });
    const ask = parseDockAiAnswersIntent(createDockAiAnswersIntent(...PAGE, { step: 'QUOTA' }))!;
    expect(await provider.handle(ask)).toEqual({ kind: 'AI_QUOTA', quota: { unlimited: false, limit: 10, remaining: 7, resetsAt: '2026-10-01T00:00:00.000Z' } });
    const [url, init] = quota.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.argoland.ai/api/v1/agent/full-ai-autofill/quota');
    expect(init.method).toBe('GET');
    const shown = { unlimited: false, limit: 10, remaining: 7, resetsAt: '2026-10-01T00:00:00.000Z' };
    expect(parseDockAiAnswersReply({ kind: 'AI_QUOTA', quota: shown })).toEqual({ kind: 'AI_QUOTA', quota: shown });
    expect(parseDockAiAnswersReply({ kind: 'AI_QUOTA', quota: { ...shown, resetsAt: 'soon' } })).toBeNull();
    const missing = createAiAnswersProvider({
      client: createAiAnswersClient({ apiBase: 'https://api.argoland.ai', getAccessToken: async () => 'tok', fetchFn: respond(404, {}) as never }),
      storage: memoryStorage(), userId: async () => 'user-1',
    });
    expect(await missing.handle(ask)).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
  });
});
