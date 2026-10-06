import { describe, expect, it, vi } from 'vitest';
import { RESUME_ATS_ATTACHMENT_MAX_BYTES } from '@edaix/contracts';
import { createResumeAttachmentClient } from '../lib/resumeAttachmentClient';

/**
 * 把简历作为附件交给雇主的两个读（P1-4）。
 *
 * 重点在「拿到的必须就是问的那一份」：释出答复要过 content-type、回执头身份、
 * 字节数三道核对，任一不过一个字节都不交出去；失败一律显式、分档，不塌缩成 null。
 */

const RESUME_VERSION_ID = '2f1c8f3e-2a5b-4a1e-9d0b-1a2b3c4d5e6f';
const ARTIFACT_ID = '9c7d6e5f-4a3b-42c1-8e9f-0a1b2c3d4e5f';
const TARGET = { canonicalOrigin: 'https://job-boards.greenhouse.io', jobId: '/airtable/jobs/8586863002' } as const;
const PDF = new Uint8Array(new TextEncoder().encode('%PDF-1.4 fixture'));

const PLAN = {
  schemaVersion: 1,
  resumeVersionId: RESUME_VERSION_ID,
  artifactId: ARTIFACT_ID,
  contentRevision: '7',
  libraryRevision: '12',
  fileName: 'Taylor Kim.pdf',
  mimeType: 'application/pdf',
  size: PDF.byteLength,
  label: null,
  createdAt: '2026-09-18T00:00:00.000Z',
} as const;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function pdfResponse(bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string | null> = {}): Response {
  const base: Record<string, string> = {
    'content-type': 'application/pdf',
    'content-length': String(bytes.byteLength),
    'x-resume-release-id': '11111111-2222-4333-8444-555555555555',
    'x-resume-version-id': RESUME_VERSION_ID,
    'x-resume-artifact-id': ARTIFACT_ID,
    'content-disposition': `attachment; filename*=UTF-8''Taylor%20Kim.pdf`,
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return new Response(bytes, { status: 200, headers: base });
}

function clientWith(
  responses: readonly (Response | Error)[],
  extra: { token?: string | null; refresh?: () => Promise<string | null>; planTimeoutMs?: number } = {},
) {
  const fetchFn = vi.fn();
  for (const item of responses) {
    if (item instanceof Error) fetchFn.mockRejectedValueOnce(item);
    else fetchFn.mockResolvedValueOnce(item);
  }
  const client = createResumeAttachmentClient({
    apiBase: 'https://api.example.test',
    getAccessToken: async () => (extra.token === undefined ? 'tok' : extra.token),
    ...(extra.refresh === undefined ? {} : { refreshAccessToken: extra.refresh }),
    ...(extra.planTimeoutMs === undefined ? {} : { planTimeoutMs: extra.planTimeoutMs }),
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, fetchFn };
}

const planRequest = { resumeVersionId: RESUME_VERSION_ID, target: TARGET } as never;

describe('问询（plan）', () => {
  it('POST 到 plan 端点，带 bearer 与收件人；200 解成计划', async () => {
    const { client, fetchFn } = clientWith([json(200, PLAN)]);
    const result = await client.plan(planRequest);
    expect(result).toEqual({ ok: true, value: PLAN });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://api.example.test/api/v1/agent/resume-attachments/plan');
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      headers: expect.objectContaining({ authorization: 'Bearer tok', 'content-type': 'application/json' }),
    });
    expect(JSON.parse(String(init.body))).toEqual({ resumeVersionId: RESUME_VERSION_ID, target: TARGET });
  });

  it('答的不是问的那一份 → UNAVAILABLE，不做「差不多就行」', async () => {
    const { client } = clientWith([json(200, { ...PLAN, resumeVersionId: ARTIFACT_ID })]);
    expect(await client.plan(planRequest)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('形状解不出 → UNAVAILABLE', async () => {
    const { client } = clientWith([json(200, { ...PLAN, fileName: '../x.pdf' })]);
    expect(await client.plan(planRequest)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('没有登录态 → AUTH_REQUIRED，且不发请求', async () => {
    const { client, fetchFn } = clientWith([], { token: null });
    expect(await client.plan(planRequest)).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('401 续期一次再试；第二次仍 401 → AUTH_REQUIRED', async () => {
    const refresh = vi.fn(async () => 'tok2');
    const ok = clientWith([json(401, { code: 'LOGIN_REQUIRED' }), json(200, PLAN)], { refresh });
    expect((await ok.client.plan(planRequest)).ok).toBe(true);
    expect(ok.fetchFn.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer tok2' }) });

    const dead = clientWith([json(401, {}), json(401, {})], { refresh });
    expect(await dead.client.plan(planRequest)).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
  });

  it.each([
    ['402 付费墙', 402, {}, 'PAYWALL_REQUIRED'],
    ['403 收件域名被运营清单拒', 403, { code: 'ATTACHMENT_TARGET_NOT_ALLOWED' }, 'TARGET_NOT_ALLOWED'],
    ['403 其它（权限）', 403, { code: 'ACCESS_DENIED' }, 'PAYWALL_REQUIRED'],
    ['404 找不到这一版', 404, { code: 'RESUME_VERSION_NOT_FOUND' }, 'RESUME_UNAVAILABLE'],
    ['409 还没渲染好', 409, { code: 'VERSION_NOT_READY' }, 'RESUME_UNAVAILABLE'],
    ['409 版本过期', 409, { code: 'RESUME_VERSION_STALE' }, 'RESUME_UNAVAILABLE'],
    ['500', 500, {}, 'UNAVAILABLE'],
  ])('%s → %s', async (_why, status, body, code) => {
    const { client } = clientWith([json(status, body)]);
    // 服务端答复体里的稳定码一并带出（只进诊断码）：同一个 RESUME_UNAVAILABLE，
    // 「没上传」「还没渲染好」「版本过期」的下一步完全不同。
    const serverCode = (body as { code?: string }).code;
    expect(await client.plan(planRequest)).toEqual({ ok: false, code, ...(serverCode === undefined || status < 403 ? {} : { serverCode }) });
  });

  it('服务端码不是闭集形状就不带：答复体是不可信边界', async () => {
    const { client } = clientWith([json(409, { code: 'not a code: <script>' })]);
    expect(await client.plan(planRequest)).toEqual({ ok: false, code: 'RESUME_UNAVAILABLE' });
  });

  it.each([{ code: 'boards.greenhouse.io' }, { code: 'EVIL:HOST' }, { code: 'lower_case' }, { error: { code: 'jobs.lever.co' } }])(
    '像主机名、带冒号或点的码（%j）读的时候就不认，与求职信同一个判据',
    async (body) => {
      const { client } = clientWith([json(409, body)]);
      expect(await client.plan(planRequest)).toEqual({ ok: false, code: 'RESUME_UNAVAILABLE' });
    },
  );

  it('错误信封里的码（{ error: { code } }）也读，同一个判据', async () => {
    const { client } = clientWith([json(409, { error: { code: 'VERSION_NOT_READY' } })]);
    expect(await client.plan(planRequest)).toEqual({ ok: false, code: 'RESUME_UNAVAILABLE', serverCode: 'VERSION_NOT_READY' });
  });

  it('网络抛错与超时都是 UNAVAILABLE——不确定就说不确定', async () => {
    expect(await clientWith([new Error('offline')]).client.plan(planRequest)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    const never = vi.fn(() => new Promise<Response>(() => {}));
    const client = createResumeAttachmentClient({
      apiBase: 'https://api.example.test', getAccessToken: async () => 'tok',
      fetchFn: never as unknown as typeof fetch, planTimeoutMs: 20,
    });
    expect(await client.plan(planRequest)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
});

describe('释出（release）', () => {
  it('带着计划钉死的三个值去取；200 PDF + 身份头 + 大小相符 → 字节', async () => {
    const { client, fetchFn } = clientWith([pdfResponse(PDF)]);
    const result = await client.release(PLAN as never, TARGET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileName).toBe('Taylor Kim.pdf');
    expect(result.value.size).toBe(PDF.byteLength);
    expect(result.value.bytes).toEqual(PDF);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://api.example.test/api/v1/agent/resume-attachments');
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({ headers: expect.objectContaining({ accept: 'application/pdf' }) });
    expect(JSON.parse(String(init.body))).toEqual({
      resumeVersionId: RESUME_VERSION_ID,
      artifactId: ARTIFACT_ID,
      expectedContentRevision: '7',
      expectedLibraryRevision: '12',
      target: TARGET,
    });
  });

  it.each([
    ['content-type 不是 PDF', { 'content-type': 'application/octet-stream' }],
    ['缺 X-Resume-Version-Id', { 'x-resume-version-id': null }],
    ['X-Resume-Artifact-Id 对不上', { 'x-resume-artifact-id': '11111111-2222-4333-8444-555555555555' }],
    ['声明的长度超过计划', { 'content-length': String(PDF.byteLength + 1) }],
  ])('%s → UNAVAILABLE，一个字节都不交', async (_why, headers) => {
    const { client } = clientWith([pdfResponse(PDF, headers)]);
    expect(await client.release(PLAN as never, TARGET)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('字节数与计划不符（少了或多了）→ UNAVAILABLE', async () => {
    const short = clientWith([pdfResponse(PDF.subarray(0, 12) as Uint8Array<ArrayBuffer>, { 'content-length': null })]);
    expect(await short.client.release(PLAN as never, TARGET)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    const longer = new Uint8Array(PDF.byteLength + 4);
    const long = clientWith([pdfResponse(longer, { 'content-length': null })]);
    expect(await long.client.release(PLAN as never, TARGET)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('计划本身大过契约上限 → 不去取', async () => {
    const { client, fetchFn } = clientWith([pdfResponse(PDF)]);
    const result = await client.release({ ...PLAN, size: RESUME_ATS_ATTACHMENT_MAX_BYTES + 1 } as never, TARGET);
    expect(result).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['409 library 变了', 409, { code: 'LIBRARY_REVISION_MISMATCH' }, 'RESUME_UNAVAILABLE'],
    ['403 收件域名被拒', 403, { code: 'ATTACHMENT_TARGET_NOT_ALLOWED' }, 'TARGET_NOT_ALLOWED'],
    ['401 无登录态', 401, { code: 'LOGIN_REQUIRED' }, 'AUTH_REQUIRED'],
  ])('%s → %s', async (_why, status, body, code) => {
    const { client } = clientWith([json(status, body)]);
    const serverCode = (body as { code?: string }).code;
    expect(await client.release(PLAN as never, TARGET)).toEqual({ ok: false, code, ...(serverCode === undefined || status < 403 ? {} : { serverCode }) });
  });
});

describe('这一页有没有为它准备好的简历（prepared）', () => {
  const PREPARED = '33333333-4444-4555-8666-777777777777';

  it('POST 到 /resume-attachments/prepared，只交收件人；答有就是那一版的 id，答 null 就是 null', async () => {
    const { client, fetchFn } = clientWith([json(200, { schemaVersion: 1, resumeVersionId: PREPARED })]);
    expect(await client.prepared(TARGET)).toEqual({ ok: true, value: { schemaVersion: 1, resumeVersionId: PREPARED } });
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('https://api.example.test/api/v1/agent/resume-attachments/prepared');
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({ target: TARGET });
    const none = clientWith([json(200, { schemaVersion: 1, resumeVersionId: null })]);
    expect(await none.client.prepared(TARGET)).toEqual({ ok: true, value: { schemaVersion: 1, resumeVersionId: null } });
  });

  it.each([
    ['答复不成形', json(200, { schemaVersion: 1 }), 'UNAVAILABLE'],
    ['id 不是 uuid', json(200, { schemaVersion: 1, resumeVersionId: 'v1' }), 'UNAVAILABLE'],
    ['403 收件域名被拒', json(403, { code: 'ATTACHMENT_TARGET_NOT_ALLOWED' }), 'TARGET_NOT_ALLOWED'],
    ['401 无登录态', json(401, {}), 'AUTH_REQUIRED'],
    ['500', json(500, {}), 'UNAVAILABLE'],
  ])('%s', async (_why, response, code) => {
    const { client } = clientWith([response]);
    const result = await client.prepared(TARGET);
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe(code);
  });
});

/**
 * 后端先发的加法（2026-09-28）：答复多一个字段，从前整份答复解不出——prepared 解不出时悄悄退回简历库的
 * 默认版（附上的不是为这个岗位改过的那份），plan 解不出时简历附不上。现在多出来的不解释、不往下传。
 */
describe('答复多一个字段', () => {
  const PREPARED = '33333333-4444-4555-8666-777777777777';

  it('prepared：照样认出为这个岗位准备的那一版，不再退回默认版', async () => {
    const { client } = clientWith([json(200, { schemaVersion: 1, resumeVersionId: PREPARED, futureField: { preparedAt: '2026-09-28T00:00:00.000Z' } })]);
    expect(await client.prepared(TARGET)).toEqual({ ok: true, value: { schemaVersion: 1, resumeVersionId: PREPARED } });
  });

  it('plan：照样收下，交出去的只有认得的十项；答的是不是问的那一份照旧要对', async () => {
    const { client } = clientWith([json(200, { ...PLAN, futureField: 'x' })]);
    const result = await client.plan(planRequest);
    expect(result).toEqual({ ok: true, value: PLAN });
    expect(JSON.stringify(result)).not.toContain('futureField');
    const other = clientWith([json(200, { ...PLAN, resumeVersionId: ARTIFACT_ID, futureField: 'x' })]);
    expect(await other.client.plan(planRequest)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    const notPdf = clientWith([json(200, { ...PLAN, mimeType: 'application/msword', futureField: 'x' })]);
    expect(await notPdf.client.plan(planRequest)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
});
