import { describe, expect, it, vi } from 'vitest';
import { createAnswerMemoryClient } from '../lib/answerMemoryClient';

/**
 * 答案记忆的两个读写（P1-6）。wire 是 argoland applicationQuestionAnswers.ts 那份：
 * GET 回 { schemaVersion, answers }，POST 收 { schemaVersion, answerKey, controlType, value }。
 */
const ANSWER = { answerKey: 'cat:relocation', categoryKey: 'relocation', controlType: 'SINGLE_CHOICE', value: { kind: 'CHOICES', optionTexts: ['Yes'] }, revision: '1', confirmedAt: '2026-09-21T00:00:00.000Z' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(responses: readonly (Response | Error)[], token: string | null = 'tok') {
  const fetchFn = vi.fn();
  for (const item of responses) {
    if (item instanceof Error) fetchFn.mockRejectedValueOnce(item);
    else fetchFn.mockResolvedValueOnce(item);
  }
  const client = createAnswerMemoryClient({ apiBase: 'https://api.example.test', getAccessToken: async () => token, fetchFn: fetchFn as unknown as typeof fetch });
  return { client, fetchFn };
}

describe('list', () => {
  it('GET 清单端点，逐条解析', async () => {
    const { client, fetchFn } = clientWith([json(200, { schemaVersion: 1, answers: [ANSWER] })]);
    expect(await client.list()).toEqual({ ok: true, value: [ANSWER] });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://api.example.test/api/v1/agent/application-question-answers');
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', cache: 'no-store', headers: expect.objectContaining({ authorization: 'Bearer tok' }) });
  });
  it('空清单是成功的答案；半份清单不要', async () => {
    expect(await clientWith([json(200, { schemaVersion: 1, answers: [] })]).client.list()).toEqual({ ok: true, value: [] });
    expect(await clientWith([json(200, { schemaVersion: 1, answers: [{ ...ANSWER, revision: 1 }] })]).client.list()).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
  /**
   * 后端先发、这个包还不认识的**种类**（2026-09-28）：新的题目类别、新的键方案、新的控件类型、
   * 新的取值种类。这一版根本产不出那样的键、也填不了那样的值，于是那一条对它等于不存在——
   * 跳过它，别的照常复用，记一个稳定码。在此之前一条新种类就让整份清单读不出，记忆复用全停。
   *
   * 「半份清单不要」对**认得的种类里坏掉的那一条**照旧成立：那才是「没记过」与「读不到」混淆的情形。
   */
  it('这一版不认识的种类跳过那一条、别的照常，记 ANSWER_MEMORY_UNKNOWN_KIND_SKIPPED', async () => {
    const future = [
      { ...ANSWER, answerKey: 'cat:start-date' },
      { ...ANSWER, answerKey: 'lbl:employer-question-42' },
      { ...ANSWER, answerKey: 'cat:visa-sponsorship', controlType: 'DATE', value: { kind: 'DATE', date: '2026-10-01' } },
      { ...ANSWER, answerKey: 'cat:salary-expectation', controlType: 'TEXT', value: { kind: 'RICH_TEXT', html: '<b>x</b>' } },
      { ...ANSWER, answerKey: 'cat:referral-source', value: { kind: 'CHOICES', optionTexts: ['LinkedIn'], optionIds: ['o3'] } },
    ];
    const codes: string[] = [];
    const fetchFn = vi.fn().mockResolvedValueOnce(json(200, { schemaVersion: 1, answers: [ANSWER, ...future], cursor: null }));
    const client = createAnswerMemoryClient({
      apiBase: 'https://api.example.test', getAccessToken: async () => 'tok',
      fetchFn: fetchFn as unknown as typeof fetch, onDiagnostic: (code) => codes.push(code),
    });
    expect(await client.list()).toEqual({ ok: true, value: [ANSWER] });
    expect(codes).toEqual(['ANSWER_MEMORY_UNKNOWN_KIND_SKIPPED']);
  });
  it('认得的种类里坏掉的一条：整份清单照旧不要', async () => {
    for (const broken of [
      { ...ANSWER, answerKey: 'txt:not-a-digest' },
      { ...ANSWER, value: { kind: 'CHOICES', optionTexts: [] } },
      { ...ANSWER, controlType: 'single choice' },
      { ...ANSWER, confirmedAt: null },
    ]) {
      expect(await clientWith([json(200, { schemaVersion: 1, answers: [ANSWER, broken] })]).client.list(), JSON.stringify(broken))
        .toEqual({ ok: false, code: 'UNAVAILABLE' });
    }
  });
  it.each([[401, 'AUTH_REQUIRED'], [402, 'PAYWALL_REQUIRED'], [403, 'PAYWALL_REQUIRED'], [500, 'UNAVAILABLE']] as const)('%s → %s', async (status, code) => {
    expect(await clientWith([json(status, {})]).client.list()).toEqual({ ok: false, code });
  });
  it('没有登录态零请求；断网 UNAVAILABLE', async () => {
    const none = clientWith([], null);
    expect(await none.client.list()).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    expect(none.fetchFn).not.toHaveBeenCalled();
    expect(await clientWith([new Error('offline')]).client.list()).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
});

describe('put', () => {
  const request = { schemaVersion: 1 as const, answerKey: 'cat:relocation', controlType: 'SINGLE_CHOICE' as const, value: { kind: 'CHOICES' as const, optionTexts: ['Yes'] } };
  it('POST 契约形状；200 ok → 键与版本', async () => {
    const { client, fetchFn } = clientWith([json(200, { schemaVersion: 1, ok: true, answerKey: 'cat:relocation', revision: '3' })]);
    expect(await client.put(request)).toEqual({ ok: true, value: { answerKey: 'cat:relocation', revision: '3' } });
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(request);
  });
  it('服务端拒（ok:false）→ REJECTED，与网络不可用分开', async () => {
    expect(await clientWith([json(200, { schemaVersion: 1, ok: false, code: 'ANSWER_MEMORY_KEY_INVALID' })]).client.put(request)).toEqual({ ok: false, code: 'REJECTED' });
    expect(await clientWith([json(503, {})]).client.put(request)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
});
