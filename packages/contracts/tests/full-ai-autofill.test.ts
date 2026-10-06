import { describe, expect, it } from 'vitest';

import {
  FULL_AI_FAILURES,
  FULL_AI_JOB_LIMITS,
  FULL_AI_LANES,
  FULL_AI_LIMITS,
  FULL_AI_PATH,
  FULL_AI_QUOTA_PATH,
  FULL_AI_REVISE_LIMITS,
  FULL_AI_REVISE_PATH,
  FULL_AI_STREAM_PATH,
  fullAiManualField,
  parseFullAiQuota,
  parseFullAiRequest,
  parseFullAiResponse,
  parseFullAiReviseRequest,
  parseFullAiReviseResponse,
  parseFullAiStreamEvent,
  isIgnorableFullAiStreamLine,
  type FullAiField,
  type FullAiRequest,
} from '../src/index.ts';

/**
 * Full AI 规划契约的消费方拷贝（权威在 argoland `contracts/fullAiAutofill.ts`）。
 *
 * 插件拿它做「AI 代答」，这里钉住插件依赖的那几条：请求只收不透明 id（不收选择器）、路径不带查询串、
 * 字段有上限；应答必须逐题对得上请求、选项 id 只能是请求里给过的、值不超过那一栏的长度上限；
 * 拒绝是闭集。夹具全是合成文字。
 */

const field = (id: string, extra: Partial<FullAiField> = {}): FullAiField => ({
  id,
  kind: 'textarea',
  label: 'Why do you want to work here?',
  context: '',
  autocomplete: '',
  required: true,
  hasValue: false,
  maxLength: null,
  options: [],
  optionsComplete: false,
  ...extra,
});

const request = (fields: FullAiField[] = [field('f0')]): FullAiRequest => ({
  schemaVersion: 1,
  requestId: '11111111-1111-4111-8111-111111111111',
  snapshotId: '22222222-2222-4222-8222-222222222222',
  page: { origin: 'https://job-boards.greenhouse.io', pathname: '/acme/jobs/1', title: 'Analyst at Acme' },
  fields,
});

describe('Full AI 规划：请求', () => {
  it('端点与上限照抄权威', () => {
    expect(FULL_AI_PATH).toBe('/api/v1/agent/full-ai-autofill/plan');
    expect(FULL_AI_LIMITS).toEqual({ fields: 120, options: 160, bytes: 96_000, value: 6_000 });
  });

  it('合法的请求原样收下', () => {
    const valid = request([
      field('f0'),
      field('f1', { kind: 'radio', label: 'Do you have experience with Kotlin?', options: [{ id: 'o0', label: 'Yes' }, { id: 'o1', label: 'No' }], optionsComplete: true }),
    ]);
    expect(parseFullAiRequest(valid)).toEqual(valid);
  });

  it.each([
    ['题号像选择器', () => request([field('#why')])],
    ['路径带查询串', () => ({ ...request(), page: { ...request().page, pathname: '/acme/jobs/1?gh_src=x' } })],
    ['多一个键', () => ({ ...request(), selector: 'textarea#why' })],
    ['一题都没有', () => request([])],
    ['超过 120 题', () => request(Array.from({ length: FULL_AI_LIMITS.fields + 1 }, (_, index) => field(`f${index}`)))],
    ['题面是空的', () => request([field('f0', { label: '   ' })])],
  ])('%s → 整份拒收', (_why, build) => {
    expect(parseFullAiRequest(build())).toBeNull();
  });
});

describe('Full AI 规划：应答', () => {
  const ok = (instructions: unknown[]) => ({
    schemaVersion: 1,
    ok: true,
    requestId: request().requestId,
    snapshotId: request().snapshotId,
    profileRevision: '7',
    deletionEpoch: '0',
    expiresAt: '2026-09-23T12:00:00.000Z',
    instructions,
    metrics: { planningMs: 10, requestBytes: 100, fieldCount: 1, model: 'test' },
  });
  const fill = (extra: Record<string, unknown> = {}) => ({
    id: 'f0', action: 'fill', value: 'Because the product matches my work.', optionIds: [],
    sourcePaths: ['experiences.0.summary'], confidence: 0.9, reason: 'DRAFT', ...extra,
  });

  it('逐题对得上请求的应答收下', () => {
    expect(parseFullAiResponse(ok([fill()]), request())?.ok).toBe(true);
  });

  it('请求号对不上、题数对不上、值超过那一栏的上限、选项 id 不是请求里给的 → 整份不要', () => {
    expect(parseFullAiResponse({ ...ok([fill()]), requestId: '33333333-3333-4333-8333-333333333333' }, request())).toBeNull();
    expect(parseFullAiResponse(ok([]), request())).toBeNull();
    expect(parseFullAiResponse(ok([fill({ value: 'x'.repeat(21) })]), request([field('f0', { maxLength: 20 })]))).toBeNull();
    expect(parseFullAiResponse(ok([fill({ value: null, optionIds: ['o9'] })]), request())).toBeNull();
  });

  it('拒绝是闭集：付费墙与额度用完在里面，认不出的码整份不要', () => {
    expect(FULL_AI_FAILURES).toEqual(expect.arrayContaining(['PAYWALL_REQUIRED', 'QUOTA_EXCEEDED', 'FULL_AI_DISABLED', 'AUTH_REQUIRED']));
    expect(parseFullAiResponse({ schemaVersion: 1, ok: false, code: 'QUOTA_EXCEEDED' }, request())).toEqual({ schemaVersion: 1, ok: false, code: 'QUOTA_EXCEEDED' });
    expect(parseFullAiResponse({ schemaVersion: 1, ok: false, code: 'SOMETHING_ELSE' }, request())).toBeNull();
  });
});

describe('Full AI 规划：只能本人答的题', () => {
  it.each([
    'Are you legally authorized to work in the United States?',
    'Will you now or in the future require visa sponsorship?',
    'What is your gender?',
    'I agree to the privacy policy',
    'Please enter your password',
  ])('%s', (label) => {
    expect(fullAiManualField({ label, context: '', autocomplete: '' })).toBe(true);
  });

  it('开放题、技能题不在其内', () => {
    for (const label of ['Why do you want to work here?', 'Do you have experience with Kotlin?', 'Describe a project you are proud of.']) {
      expect(fullAiManualField({ label, context: '', autocomplete: '' }), label).toBe(false);
    }
  });
});

describe('用 AI 写 / AI 改写这一题，与 AI 次数（revise / quota）', () => {
  const revise = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    requestId: '44444444-4444-4444-8444-444444444444',
    page: { origin: 'https://job-boards.greenhouse.io', pathname: '/acme/jobs/1', title: 'Analyst at Acme' },
    field: field('f0', { maxLength: 300 }),
    currentValue: '',
    instruction: '',
    ...extra,
  });

  it('端点与上限照抄权威', () => {
    expect(FULL_AI_REVISE_PATH).toBe('/api/v1/agent/full-ai-autofill/revise');
    expect(FULL_AI_QUOTA_PATH).toBe('/api/v1/agent/full-ai-autofill/quota');
    expect(FULL_AI_REVISE_LIMITS).toEqual({ instruction: 1_000 });
  });

  it('请求：只收没有选项的文本题；要求最多 1000 字、可以是空；现值可以是空；只能本人答的题不收', () => {
    expect(parseFullAiReviseRequest(revise())).not.toBeNull();
    expect(parseFullAiReviseRequest(revise({ currentValue: 'I led a small team.', instruction: 'Make it shorter' }))).not.toBeNull();
    expect(parseFullAiReviseRequest(revise({ instruction: 'x'.repeat(1_001) }))).toBeNull();
    expect(parseFullAiReviseRequest(revise({ field: field('f0', { kind: 'radio', options: [{ id: 'o0', label: 'Yes' }], optionsComplete: true }) }))).toBeNull();
    expect(parseFullAiReviseRequest(revise({ field: field('f0', { kind: 'text', options: [{ id: 'o0', label: 'Yes' }] }) }))).toBeNull();
    expect(parseFullAiReviseRequest(revise({ field: field('f0', { label: 'Are you legally authorized to work in the United States?' }) }))).toBeNull();
    expect(parseFullAiReviseRequest(revise({ field: field('#why') }))).toBeNull();
    expect(parseFullAiReviseRequest({ ...revise(), selector: '#why' })).toBeNull();
  });

  it('应答：请求号对得上、不超过那一栏的上限；空字符串是「资料不够」且不引资料；拒绝是闭集', () => {
    const request = parseFullAiReviseRequest(revise())!;
    const ok = { schemaVersion: 1, ok: true, requestId: request.requestId, value: 'Because…', confidence: 0.9, sourcePaths: ['summary'] };
    expect(parseFullAiReviseResponse(ok, request)).toEqual(ok);
    expect(parseFullAiReviseResponse({ ...ok, value: '', sourcePaths: [] }, request)).toMatchObject({ ok: true, value: '' });
    expect(parseFullAiReviseResponse({ ...ok, value: '' }, request), '空答案还引资料是对不上的').toBeNull();
    expect(parseFullAiReviseResponse({ ...ok, value: 'x'.repeat(301) }, request)).toBeNull();
    expect(parseFullAiReviseResponse({ ...ok, requestId: '55555555-5555-4555-8555-555555555555' }, request)).toBeNull();
    expect(parseFullAiReviseResponse({ schemaVersion: 1, ok: false, code: 'QUOTA_EXCEEDED' }, request)).toEqual({ schemaVersion: 1, ok: false, code: 'QUOTA_EXCEEDED' });
    // 2026-09-28：这一版不认识的拒绝码（后端新加一种）读作「暂时不可用」——这一次确实没写成；不像码的照旧整份不要。
    expect(parseFullAiReviseResponse({ schemaVersion: 1, ok: false, code: 'NOPE' }, request)).toEqual({ schemaVersion: 1, ok: false, code: 'FULL_AI_UNAVAILABLE' });
    expect(parseFullAiReviseResponse({ schemaVersion: 1, ok: false, code: 'nope' }, request)).toBeNull();
    expect(parseFullAiReviseResponse({ schemaVersion: 1, ok: false, code: 42 }, request)).toBeNull();
  });

  it('次数：会员不限（三项都是 null），有上限的一定有剩余、不超过上限、带恢复时间', () => {
    expect(parseFullAiQuota({ schemaVersion: 1, unlimited: true, limit: null, remaining: null, resetsAt: null })).not.toBeNull();
    expect(parseFullAiQuota({ schemaVersion: 1, unlimited: false, limit: 10, remaining: 7, resetsAt: '2026-10-01T00:00:00.000Z' })).not.toBeNull();
    expect(parseFullAiQuota({ schemaVersion: 1, unlimited: false, limit: 10, remaining: -1, resetsAt: '2026-10-01T00:00:00.000Z' })).toBeNull();
    expect(parseFullAiQuota({ schemaVersion: 1, unlimited: false, limit: 10, remaining: 11, resetsAt: '2026-10-01T00:00:00.000Z' })).toBeNull();
    expect(parseFullAiQuota({ schemaVersion: 1, unlimited: false, limit: 10, remaining: 7, resetsAt: null })).toBeNull();
    expect(parseFullAiQuota({ schemaVersion: 1, unlimited: false, limit: 10, remaining: 7 })).toBeNull();
  });
});

describe('岗位描述 job（argoland #620，2026-09-24）', () => {
  const job = {
    title: 'QA Automation Engineer',
    company: 'Acme',
    location: 'Athens, Greece',
    description: 'You will build Playwright suites.\n\n- 3+ years of automation',
  };

  it('可带可不带；plan 与 revise 都认；上限照抄权威', () => {
    expect(FULL_AI_JOB_LIMITS).toEqual({ title: 300, company: 200, location: 300, description: 12_000 });
    expect(parseFullAiRequest(request())).not.toBeNull();
    expect(parseFullAiRequest({ ...request(), job })).toMatchObject({ job });
    expect(parseFullAiRequest({ ...request(), job: { description: 'Only a description' } })).not.toBeNull();
    const revise = {
      schemaVersion: 1,
      requestId: '44444444-4444-4444-8444-444444444444',
      page: request().page,
      field: field('f0'),
      currentValue: '',
      instruction: '',
    };
    expect(parseFullAiReviseRequest({ ...revise, job })).toMatchObject({ job });
    expect(parseFullAiReviseRequest({ ...revise, job: { salary: '100k' } })).toBeNull();
  });

  it.each([
    ['多一个键', { ...job, applyUrl: 'https://acme.example/apply' }],
    ['描述超过 12,000 字', { description: 'x'.repeat(FULL_AI_JOB_LIMITS.description + 1) }],
    ['职位名超过 300 字', { title: 'x'.repeat(FULL_AI_JOB_LIMITS.title + 1) }],
    ['不是字符串', { company: 42 }],
    ['控制字符', { description: 'Great\u0000team' }],
    ['不是对象', 'QA Automation Engineer'],
    ['数组', [job]],
  ])('%s → 整份拒收（插件自己先截断）', (_why, value) => {
    expect(parseFullAiRequest({ ...request(), job: value })).toBeNull();
  });

  it('96 KB 只算题目：满长的 JD 不会把题目挤掉', () => {
    const big = { ...field('big'), label: 'x'.repeat(600), context: 'y'.repeat(600) };
    const fields = Array.from({ length: 66 }, (_, index) => ({ ...big, id: `f${index}` }));
    const longJob = { description: 'z'.repeat(FULL_AI_JOB_LIMITS.description) };
    expect(JSON.stringify(request(fields)).length).toBeLessThan(FULL_AI_LIMITS.bytes);
    expect(JSON.stringify({ ...request(fields), job: longJob }).length).toBeGreaterThan(FULL_AI_LIMITS.bytes);
    expect(parseFullAiRequest({ ...request(fields), job: longJob })).not.toBeNull();
  });
});

describe('Full AI 规划的流（plan/stream，argoland #620）', () => {
  const two = (): FullAiRequest => request([
    field('pw', { kind: 'radio', label: 'Do you have 3 years of Playwright experience?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], optionsComplete: true }),
    field('why'),
  ]);
  const answers = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    type: 'answers',
    requestId: two().requestId,
    snapshotId: two().snapshotId,
    lane: 'fast',
    profileRevision: '7',
    deletionEpoch: '1',
    expiresAt: '2026-09-24T12:00:00.000Z',
    instructions: [{ id: 'pw', action: 'fill', value: null, optionIds: ['no'], sourcePaths: ['skills'], confidence: 0.9, reason: 'PROFILE' }],
    ...extra,
  });
  const done = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    type: 'done',
    ok: true,
    requestId: two().requestId,
    unanswered: [],
    metrics: { planningMs: 3100, fieldCount: 2, modelCalls: 2, fastMs: 2100, longMs: 3100, model: 'm' },
    ...extra,
  });

  it('路径与三条道照抄权威', () => {
    expect(FULL_AI_STREAM_PATH).toBe('/api/v1/agent/full-ai-autofill/plan/stream');
    expect(FULL_AI_LANES).toEqual(['direct', 'fast', 'long']);
  });

  it('每个字段整条流只放一次；done 要把其余字段逐一交代', () => {
    const released = new Set<string>();
    expect(parseFullAiStreamEvent(answers(), two(), released)).toMatchObject({ lane: 'fast' });
    expect([...released]).toEqual(['pw']);
    expect(parseFullAiStreamEvent(answers({ lane: 'long' }), two(), released), '同一题再放一次').toBeNull();
    expect(parseFullAiStreamEvent(done(), two(), released), '漏交代了 why').toBeNull();
    expect(parseFullAiStreamEvent(done({ unanswered: [{ code: 'FULL_AI_PROVIDER_FAILED', fieldIds: ['why', 'pw'] }] }), two(), released), '交代了已放过的').toBeNull();
    expect(parseFullAiStreamEvent(done({ unanswered: [{ code: 'FULL_AI_PROVIDER_FAILED', fieldIds: ['why'] }] }), two(), released)).toMatchObject({ ok: true });
  });

  it('ok:false 只能出现在一行 answers 都没放出去的时候', () => {
    const failed = { schemaVersion: 1, type: 'done', ok: false, code: 'FULL_AI_BUSY' };
    expect(parseFullAiStreamEvent(failed, two(), new Set())).toEqual(failed);
    expect(parseFullAiStreamEvent(failed, two(), new Set(['pw']))).toBeNull();
  });

  it.each([
    ['别的请求号', { requestId: '55555555-5555-4555-8555-555555555555' }],
    ['不像道名的道', { lane: 'slow lane' }],
    ['一条指令都没有', { instructions: [] }],
    ['请求里没有的题', { instructions: [{ id: 'other', action: 'fill', value: null, optionIds: ['no'], sourcePaths: ['skills'], confidence: 0.9, reason: 'PROFILE' }] }],
    ['这一题没有的选项', { instructions: [{ id: 'pw', action: 'fill', value: null, optionIds: ['maybe'], sourcePaths: ['skills'], confidence: 0.9, reason: 'PROFILE' }] }],
    ['不像动作的动作', { instructions: [{ id: 'pw', action: 'fill it', value: null, optionIds: ['no'], sourcePaths: ['skills'], confidence: 0.9, reason: 'PROFILE' }] }],
    ['少一个键', { lane: undefined }],
  ])('answers 行：%s → 这一行不合格，整条流到此为止', (_why, extra) => {
    const released = new Set<string>();
    const line = JSON.parse(JSON.stringify(answers(extra))) as unknown;
    expect(parseFullAiStreamEvent(line, two(), released)).toBeNull();
    expect(released.size).toBe(0);
  });

  it('认不出的行类型：解析器不收，但它是「可以跳过的一行」，不是坏行（2026-09-28）', () => {
    expect(parseFullAiStreamEvent({ schemaVersion: 1, type: 'progress' }, two(), new Set())).toBeNull();
    expect(isIgnorableFullAiStreamLine({ schemaVersion: 1, type: 'progress', percent: 40 })).toBe(true);
    for (const line of [answers(), done(), { schemaVersion: 2, type: 'progress' }, { schemaVersion: 1, type: 'not a type' }, { schemaVersion: 1 }, null, 'progress']) {
      expect(isIgnorableFullAiStreamLine(line), JSON.stringify(line)).toBe(false);
    }
  });
});

/**
 * 后端先发、这个包还不认识的**加法**（2026-09-28）。「AI 代答」是计量的：额度在 HTTP 200 那一刻就扣了，
 * 在此之前流上的一行多一个字段、多一种道、多一种理由或动作，旧包就把整条流判坏、一个答案都不要——
 * 钱花了，功能也停了。现在：
 *  · 多出来的成员不解释、不转发（解析结果只从认得的字段重建）；
 *  · 这一版不认识的行类型整行跳过（客户端用 `isIgnorableFullAiStreamLine` 判）；
 *  · 这一版不认识的道照收（道只用来打时间点）；
 *  · 指令用了这一版不认识的动作或理由：那一题算「放出来了」（`done` 的逐题交代照旧成立），但这条
 *    指令不交出去——这一版不知道它的意思，就不替用户填；
 *  · 这一版不认识的失败码读作 `FULL_AI_UNAVAILABLE`。
 * 不变的：请求号、快照号、档案版本绑定、题目与选项必须是请求里给的、每题只放一次、`done` 逐题交代。
 */
describe('Full AI 的流与应答：后端先发的加法', () => {
  const two = (): FullAiRequest => request([
    field('pw', { kind: 'radio', label: 'Do you have 3 years of Playwright experience?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], optionsComplete: true }),
    field('why'),
  ]);
  const instruction = (extra: Record<string, unknown> = {}) =>
    ({ id: 'pw', action: 'fill', value: null, optionIds: ['no'], sourcePaths: ['skills'], confidence: 0.9, reason: 'PROFILE', ...extra });
  const answers = (extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1, type: 'answers', requestId: two().requestId, snapshotId: two().snapshotId, lane: 'fast',
    profileRevision: '7', deletionEpoch: '1', expiresAt: '2026-09-24T12:00:00.000Z', instructions: [instruction()], ...extra,
  });

  it('answers 行多出来的成员不拒、也不转发', () => {
    const released = new Set<string>();
    const parsed = parseFullAiStreamEvent(answers({ selector: '#pw', tokens: 120, instructions: [instruction({ rationale: 'x' })] }), two(), released);
    expect(parsed).toEqual(answers());
    expect(JSON.stringify(parsed)).not.toMatch(/selector|tokens|rationale/u);
    expect([...released]).toEqual(['pw']);
  });

  it('这一版不认识的道照收', () => {
    expect(parseFullAiStreamEvent(answers({ lane: 'rescue' }), two(), new Set())).toMatchObject({ lane: 'rescue' });
  });

  it('不认识的动作或理由：那一题算放出来了，但指令不交出去', () => {
    for (const extra of [{ action: 'suggest' }, { reason: 'JOB_DESCRIPTION' }]) {
      const released = new Set<string>();
      const parsed = parseFullAiStreamEvent(answers({ instructions: [instruction(extra)] }), two(), released);
      expect(parsed, JSON.stringify(extra)).toMatchObject({ type: 'answers', instructions: [] });
      expect([...released]).toEqual(['pw']);
      // done 照旧逐题交代：放出来的那题不用再交代。
      const done = { schemaVersion: 1, type: 'done', ok: true, requestId: two().requestId,
        unanswered: [{ code: 'FULL_AI_PROVIDER_FAILED', fieldIds: ['why'] }],
        metrics: { planningMs: 1, fieldCount: 2, modelCalls: 1, fastMs: 1, longMs: null, model: 'm' } };
      expect(parseFullAiStreamEvent(done, two(), released)).toMatchObject({ ok: true });
    }
  });

  it('done 行：多出来的成员与指标不拒；不认识的逐题原因与失败码读作 FULL_AI_UNAVAILABLE', () => {
    const released = new Set<string>(['pw']);
    const parsed = parseFullAiStreamEvent({
      schemaVersion: 1, type: 'done', ok: true, requestId: two().requestId, traceId: 't-1',
      unanswered: [{ code: 'FULL_AI_BUDGET_SPLIT', fieldIds: ['why'], retryAfterMs: 5 }],
      metrics: { planningMs: 1, fieldCount: 2, modelCalls: 1, fastMs: 1, longMs: null, model: 'm', cachedTokens: 9 },
    }, two(), released);
    expect(parsed).toEqual({
      schemaVersion: 1, type: 'done', ok: true, requestId: two().requestId,
      unanswered: [{ code: 'FULL_AI_UNAVAILABLE', fieldIds: ['why'] }],
      metrics: { planningMs: 1, fieldCount: 2, modelCalls: 1, fastMs: 1, longMs: null, model: 'm' },
    });
    expect(parseFullAiStreamEvent({ schemaVersion: 1, type: 'done', ok: false, code: 'FULL_AI_REGION_BLOCKED', hint: 'x' }, two(), new Set()))
      .toEqual({ schemaVersion: 1, type: 'done', ok: false, code: 'FULL_AI_UNAVAILABLE' });
  });

  it('改写与次数：多出来的成员不拒、不转发', () => {
    const revise = parseFullAiReviseRequest({
      schemaVersion: 1, requestId: '44444444-4444-4444-8444-444444444444',
      page: { origin: 'https://job-boards.greenhouse.io', pathname: '/acme/jobs/1', title: 'Analyst at Acme' },
      field: field('f0', { maxLength: 300 }), currentValue: '', instruction: '',
    })!;
    const ok = { schemaVersion: 1, ok: true, requestId: revise.requestId, value: 'Because…', confidence: 0.9, sourcePaths: ['summary'] };
    expect(parseFullAiReviseResponse({ ...ok, model: 'm', tokens: 3 }, revise)).toEqual(ok);
    const quota = { schemaVersion: 1, unlimited: false, limit: 10, remaining: 7, resetsAt: '2026-10-01T00:00:00.000Z' };
    expect(parseFullAiQuota({ ...quota, plan: 'pro' })).toEqual(quota);
  });
});
