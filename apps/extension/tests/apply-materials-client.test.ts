import { describe, expect, it, vi } from 'vitest';
import { createApplyMaterialsClient } from '../lib/applyMaterialsClient';

/**
 * 两个读的失败语义。重点全在「不许塌缩成乐观默认值」这一条上：
 *
 * - 简历读不到 ≠ 用户没有简历。把前者显示成后者，等于当着一个上传过三版简历的
 *   人说他一份都没有。
 * - 求职信那一问读不到 ≠ 这个岗位不要求职信。塌缩成 NOT_REQUIRED 会让一份必须
 *   写求职信的申请直接走上 A 路，漏掉那一栏。
 */

const OK_RESUMES = {
  schemaVersion: 1,
  libraryRevision: '4',
  defaultResumeVersionId: '00000000-0000-4000-8000-000000000009',
  items: [{
    trackId: '00000000-0000-4000-8000-000000000001',
    trackName: 'General',
    resumeVersionId: '00000000-0000-4000-8000-000000000009',
    label: null,
    fileName: 'taylor.pdf',
    mimeType: 'application/pdf',
    fileSize: 1234,
    versionNumber: 2,
    contentRevision: '3',
    isDefault: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  }],
};

const OK_REQUIREMENT = {
  schemaVersion: 1,
  ok: true,
  context: {
    schemaVersion: 1,
    jobId: '00000000-0000-4000-8000-0000000000aa',
    canonicalJobId: '00000000-0000-4000-8000-0000000000bb',
    canonicalJobRevision: '7',
    requirement: 'REQUIRED',
    requirementRevision: '2',
  },
};

function clientWith(responses: readonly (Response | Error)[], token: string | null = 'tok') {
  const fetchFn = vi.fn();
  for (const item of responses) {
    if (item instanceof Error) fetchFn.mockRejectedValueOnce(item);
    else fetchFn.mockResolvedValueOnce(item);
  }
  const client = createApplyMaterialsClient({
    apiBase: 'https://api.example.test',
    getAccessToken: async () => token,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, fetchFn };
}

const json = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

describe('简历可选项', () => {
  it('读到就原样交出，并过一遍严格解码器', async () => {
    const { client } = clientWith([json(200, OK_RESUMES)]);
    const result = await client.listResumes();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toHaveLength(1);
  });

  it('空清单是一个成功的答案——他确实还没有', async () => {
    const { client } = clientWith([json(200, { ...OK_RESUMES, defaultResumeVersionId: null, items: [] })]);
    const result = await client.listResumes();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toEqual([]);
  });

  it('答复多一个字段（后端先发的加法，2026-09-28）：照样读到，交出去的只有认得的字段', async () => {
    const { client } = clientWith([json(200, {
      ...OK_RESUMES,
      futureField: 1,
      items: [{ ...OK_RESUMES.items[0], storageKey: 'private/taylor.pdf', futureField: 2 }],
    })]);
    const result = await client.listResumes();
    expect(result).toEqual({ ok: true, value: OK_RESUMES });
    expect(JSON.stringify(result)).not.toContain('futureField');
    expect(JSON.stringify(result)).not.toContain('private/taylor.pdf');
  });

  it('解不出的 body 归 UNAVAILABLE，不是空清单', async () => {
    // 半份清单比没有清单危险：用户会以为那就是他的全部简历。
    const { client } = clientWith([json(200, { schemaVersion: 1, items: 'nope' })]);
    expect(await client.listResumes()).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('没有登录态时压根不发请求', async () => {
    const { client, fetchFn } = clientWith([], null);
    expect(await client.listResumes()).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('抛错也归 UNAVAILABLE', async () => {
    const { client } = clientWith([new Error('offline')]);
    expect(await client.listResumes()).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('402/403 归 PAYWALL_REQUIRED——下一步在产品里', async () => {
    for (const status of [402, 403]) {
      const { client } = clientWith([json(status, { code: 'PAYWALL_REQUIRED' })]);
      expect(await client.listResumes()).toEqual({ ok: false, code: 'PAYWALL_REQUIRED' });
    }
  });

  it('带 Bearer，且不缓存', async () => {
    const { client, fetchFn } = clientWith([json(200, OK_RESUMES)]);
    await client.listResumes();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/v1/agent/resume-selection-options');
    expect(init.cache).toBe('no-store');
    expect(init.headers.authorization).toBe('Bearer tok');
  });
});

describe('求职信那一问', () => {
  it('读到就连 revision 一起交出——后续生成要原样带回', async () => {
    const { client } = clientWith([json(200, OK_REQUIREMENT)]);
    const result = await client.coverLetterRequirement('00000000-0000-4000-8000-0000000000aa');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requirement).toBe('REQUIRED');
      // 对不上后端答 COVER_LETTER_JOB_STALE，调用方不该自己去凑这几个值。
      expect(result.value.canonicalJobRevision).toBe('7');
      expect(result.value.requirementRevision).toBe('2');
    }
  });

  it('UNKNOWN 原样传出去，不替它做任何解释', async () => {
    const body = { ...OK_REQUIREMENT, context: { ...OK_REQUIREMENT.context, requirement: 'UNKNOWN' } };
    const { client } = clientWith([json(200, body)]);
    const result = await client.coverLetterRequirement('00000000-0000-4000-8000-0000000000aa');
    expect(result.ok && result.value.requirement).toBe('UNKNOWN');
  });

  it('读不到时绝不塌缩成 NOT_REQUIRED', async () => {
    // 塌缩的后果是一份必须写求职信的申请直接走上 A 路，漏掉那一栏。
    for (const response of [json(500, {}), json(200, { nope: true }), new Error('offline')]) {
      const { client } = clientWith([response]);
      const result = await client.coverLetterRequirement('00000000-0000-4000-8000-0000000000aa');
      expect(result).toEqual({ ok: false, code: 'UNAVAILABLE' });
    }
  });

  it('200 里带 ok:false 的失败体当成读不到', async () => {
    const { client } = clientWith([json(200, { schemaVersion: 1, ok: false, code: 'COVER_LETTER_UNAVAILABLE' })]);
    expect(await client.coverLetterRequirement('00000000-0000-4000-8000-0000000000aa'))
      .toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('404 单独成一档：这个岗位后端不认识', async () => {
    const { client } = clientWith([json(404, { code: 'NOT_FOUND' })]);
    expect(await client.coverLetterRequirement('00000000-0000-4000-8000-0000000000aa'))
      .toEqual({ ok: false, code: 'JOB_NOT_FOUND' });
  });

  it('空 jobId 不发请求', async () => {
    const { client, fetchFn } = clientWith([]);
    expect(await client.coverLetterRequirement('')).toEqual({ ok: false, code: 'JOB_NOT_FOUND' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('POST 带 jobId 的 body', async () => {
    const { client, fetchFn } = clientWith([json(200, OK_REQUIREMENT)]);
    await client.coverLetterRequirement('00000000-0000-4000-8000-0000000000aa');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/v1/agent/cover-letter/requirement');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ jobId: '00000000-0000-4000-8000-0000000000aa' });
  });
});

describe('401 之后换一次票再试', () => {
  it('换到票就重发，且用新票', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json(401, { code: 'LOGIN_REQUIRED' }))
      .mockResolvedValueOnce(json(200, OK_RESUMES));
    const client = createApplyMaterialsClient({
      apiBase: 'https://api.example.test',
      getAccessToken: async () => 'stale',
      refreshAccessToken: async () => 'fresh',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect((await client.listResumes()).ok).toBe(true);
    expect(fetchFn.mock.calls[1][1].headers.authorization).toBe('Bearer fresh');
  });

  it('换不到票就说 AUTH_REQUIRED，不无限重试', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json(401, { code: 'LOGIN_REQUIRED' }));
    const client = createApplyMaterialsClient({
      apiBase: 'https://api.example.test',
      getAccessToken: async () => 'stale',
      refreshAccessToken: async () => null,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(await client.listResumes()).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
