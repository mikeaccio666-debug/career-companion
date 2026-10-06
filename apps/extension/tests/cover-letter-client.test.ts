// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { createCoverLetterAttachmentClient } from '../lib/coverLetterAttachmentClient';
import { createDockCoverLetterIntent } from '../lib/coverLetterIntent';
import { coverLetterPageJob } from '../lib/coverLetterPageJob';
import { createCoverLetterProvider } from '../lib/coverLetterProvider';
import { coverLetterFromWorker, shownLetterRefusal } from '../lib/coverLetterSeam';

/**
 * 求职信的网络一段（2026-09-27，argoland #653）与内容脚本那一段：按页面要、按页面交；PDF 要过名字、身份与摘要
 * 三道核对；不在岗位库里的页面，职位描述从这一页读（JobPosting 优先，其次是看得见的正文，不含申请表）。
 */
const TARGET = { canonicalOrigin: 'https://job-boards.greenhouse.io', jobId: '/acme/jobs/123' };
const ARTIFACT = '00000000-0000-4000-8000-0000000000aa';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function api(responses: Response[]) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')), headers: init?.headers as Record<string, string> });
    return responses.shift() ?? new Response('{}', { status: 500 });
  });
  const client = createCoverLetterAttachmentClient({
    apiBase: 'https://api.test.invalid', getAccessToken: async () => 'token', fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, calls };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const pdfResponse = (over: Record<string, string> = {}, bytes: Uint8Array = PDF) => new Response(bytes as unknown as BodyInit, {
  status: 200,
  headers: {
    'content-type': 'application/pdf',
    'X-Material-Artifact-Id': ARTIFACT,
    'X-Material-Sha256': sha(PDF),
    'content-disposition': "attachment; filename*=UTF-8''Cover%20Letter.pdf",
    ...over,
  },
});

describe('按页面要求职信的四条路', () => {
  it('lookup / prepare / text 发到契约点名的地址，收件人就是这一页', async () => {
    const { client, calls } = api([
      json({ schemaVersion: 1, state: 'NONE', jobSource: 'PAGE' }),
      json({ schemaVersion: 1, ok: true, coverLetter: { state: 'READY', artifactId: ARTIFACT, generatedAt: '2026-09-27T10:00:00.000Z' }, generated: true }),
      json({ schemaVersion: 1, artifactId: ARTIFACT, text: 'Dear hiring team' }),
    ]);
    expect((await client.lookup(TARGET)).ok).toBe(true);
    expect((await client.prepare(TARGET, { clientRequestId: '00000000-0000-4000-8000-000000000001' })).ok).toBe(true);
    expect(await client.text(TARGET, ARTIFACT)).toEqual({ ok: true, value: 'Dear hiring team' });
    expect(calls.map((call) => call.url.replace('https://api.test.invalid', ''))).toEqual([
      '/api/v1/agent/cover-letter-attachments/lookup',
      '/api/v1/agent/cover-letter-attachments/prepare',
      '/api/v1/agent/cover-letter-attachments/text',
    ]);
    expect(calls.every((call) => JSON.stringify((call.body as { target: unknown }).target) === JSON.stringify(TARGET))).toBe(true);
    expect(calls[0]!.headers.authorization).toBe('Bearer token');
  });

  it('失败分档：402 没额度、429 用完、403 收件网站被拒、404 那一封交不出、409 还在写、别的都是 UNAVAILABLE', async () => {
    const cases: [Response, string][] = [
      [json({ code: 'PAYWALL_REQUIRED' }, 402), 'PAYWALL_REQUIRED'],
      [json({ code: 'USAGE_EXHAUSTED' }, 429), 'USAGE_EXHAUSTED'],
      [json({ code: 'ATTACHMENT_TARGET_NOT_ALLOWED' }, 403), 'TARGET_NOT_ALLOWED'],
      [json({ code: 'COVER_LETTER_NOT_FOUND' }, 404), 'NOT_FOUND'],
      [json({ code: 'IDEMPOTENCY_ACTION_IN_PROGRESS' }, 409), 'BUSY'],
      [json({ code: 'AGENT_UNAVAILABLE' }, 503), 'UNAVAILABLE'],
    ];
    for (const [response, code] of cases) {
      const { client } = api([response]);
      expect(await client.text(TARGET, ARTIFACT), code).toMatchObject({ ok: false, code });
    }
  });

  it('PDF：名字、身份、摘要都对上才交；任何一样不对就不挂', async () => {
    expect(await api([pdfResponse()]).client.pdf(TARGET, ARTIFACT)).toMatchObject({ ok: true, value: { fileName: 'Cover Letter.pdf', size: PDF.byteLength } });
    expect(await api([pdfResponse({ 'X-Material-Artifact-Id': '00000000-0000-4000-8000-0000000000bb' })]).client.pdf(TARGET, ARTIFACT)).toMatchObject({ ok: false });
    expect(await api([pdfResponse({ 'X-Material-Sha256': sha(new Uint8Array([1])) })]).client.pdf(TARGET, ARTIFACT)).toMatchObject({ ok: false });
    expect(await api([pdfResponse({ 'content-disposition': 'attachment; filename="resume.pdf"' })]).client.pdf(TARGET, ARTIFACT)).toMatchObject({ ok: false });
  });
});

/**
 * 后端先发的加法（2026-09-28）：答复多一个字段，从前这一版整条求职信路停掉（lookup 解不出＝UNAVAILABLE）。
 * 现在多出来的不解释、不往下传；陌生的状态、岗位来源与失败码各有一个更保守的去处。
 */
describe('后端先发的加法：答复多一个字段，求职信照样附', () => {
  const GENERATED_AT = '2026-09-27T10:00:00.000Z';
  const LETTER = { state: 'READY', artifactId: ARTIFACT, generatedAt: GENERATED_AT };
  const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
  const intent = () => createDockCoverLetterIntent(TARGET.canonicalOrigin, TARGET.jobId, { step: 'PREPARE' })!;
  const paths = (calls: { url: string }[]) => calls.map((call) => call.url.replace('https://api.test.invalid/api/v1/agent/cover-letter-attachments/', ''));

  it('lookup / prepare / text 多出来的成员照样用、不往下传', async () => {
    const { client } = api([
      json({ schemaVersion: 1, state: 'NONE', jobSource: 'CATALOG', futureField: 1 }),
      json({ schemaVersion: 1, ok: true, coverLetter: { ...LETTER, futureField: 2 }, generated: true, futureField: 3 }),
      json({ schemaVersion: 1, artifactId: ARTIFACT, text: 'Dear hiring team', futureField: 4 }),
    ]);
    expect(await client.lookup(TARGET)).toEqual({ ok: true, value: { schemaVersion: 1, state: 'NONE', jobSource: 'CATALOG' } });
    expect(await client.prepare(TARGET, { clientRequestId: REQUEST_ID }))
      .toEqual({ ok: true, value: { schemaVersion: 1, ok: true, coverLetter: LETTER, generated: true } });
    expect(await client.text(TARGET, ARTIFACT)).toEqual({ ok: true, value: 'Dear hiring team' });
  });

  it('lookup 答了这一版不认识的状态：当作还没有，经 prepare 要（已有的那一封服务端免费交回），绝不直接当 READY 附', async () => {
    const { client, calls } = api([
      json({ schemaVersion: 1, state: 'EXPIRED', jobSource: 'CATALOG', artifactId: '00000000-0000-4000-8000-0000000000bb', generatedAt: GENERATED_AT }),
      json({ schemaVersion: 1, ok: true, coverLetter: LETTER, generated: false }),
    ]);
    const reply = await createCoverLetterProvider({ client, newRequestId: () => REQUEST_ID }).handle(intent(), '7');
    expect(reply).toEqual({ kind: 'COVER_LETTER_READY', artifactId: ARTIFACT, generated: false });
    expect(paths(calls)).toEqual(['lookup', 'prepare']);
  });

  it('lookup 答了这一版不认识的岗位来源：按 PAGE 走，已有的那一封也不直接附；没读到这一页的职位描述就不写', async () => {
    const { client, calls } = api([
      json({ schemaVersion: 1, state: 'READY', jobSource: 'MISSION', artifactId: ARTIFACT, generatedAt: GENERATED_AT }),
    ]);
    const reply = await createCoverLetterProvider({ client, newRequestId: () => REQUEST_ID }).handle(intent(), '7');
    expect(reply).toEqual({ kind: 'REFUSED', code: 'NEEDS_PAGE_JOB' });
    expect(paths(calls)).toEqual(['lookup']);
  });

  it('prepare 答了这一版不认识的失败码：是服务端说「写不出」，按笼统的 COVER_LETTER_UNAVAILABLE 记、浮层说暂时写不出', async () => {
    const diagnostics: string[] = [];
    const { client } = api([
      json({ schemaVersion: 1, state: 'NONE', jobSource: 'CATALOG' }),
      json({ schemaVersion: 1, ok: false, code: 'COVER_LETTER_QUOTA_PAUSED' }),
    ]);
    const provider = createCoverLetterProvider({ client, newRequestId: () => REQUEST_ID, onDiagnostic: (code) => diagnostics.push(code) });
    expect(await provider.handle(intent(), '7')).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    expect(diagnostics).toEqual(['COVER_LETTER_UNAVAILABLE']);
  });
});

describe('这一页的岗位', () => {
  const DESCRIPTION = 'We are looking for an analyst to own weekly sales reporting and forecasting. '.repeat(5);

  it('JobPosting 有描述：用它（JOB_POSTING）', () => {
    document.body.innerHTML = '<main><h1>Analyst</h1></main>';
    const job = coverLetterPageJob({ doc: document, job: { title: 'Business Analyst', company: 'Acme', description: DESCRIPTION }, card: { title: '', company: '' } });
    expect(job).toMatchObject({ source: 'JOB_POSTING', title: 'Business Analyst', company: 'Acme' });
  });

  it('没有 JobPosting：用看得见的正文（PAGE_TEXT），不含申请表、脚本、导航与藏起来的部分', () => {
    document.body.innerHTML = `
      <nav>Home Jobs Login</nav>
      <main><h1>Business Analyst</h1><div class="description"><p>${DESCRIPTION}</p></div>
        <div hidden>SECRET HIDDEN</div><script>var token = "x";</script>
        <form><label>First name</label><input value="Taylor" /><label>Cover letter</label><textarea></textarea></form>
      </main>`;
    const job = coverLetterPageJob({ doc: document, card: { title: 'Business Analyst', company: '' } });
    expect(job?.source).toBe('PAGE_TEXT');
    expect(job?.description).toContain('weekly sales reporting');
    for (const leaked of ['First name', 'Taylor', 'SECRET HIDDEN', 'token', 'Home Jobs Login']) expect(job?.description).not.toContain(leaked);
    expect(job?.company).toBe('');
  });

  it('读不出一段像样的描述：不交', () => {
    document.body.innerHTML = '<main><h1>Apply</h1><form><label>Cover letter</label><textarea></textarea></form></main>';
    expect(coverLetterPageJob({ doc: document, card: { title: 'Apply', company: '' } })).toBeNull();
  });

  it('只交纯文本：双向覆盖字符与控制字符去掉，按上限截断', () => {
    const job = coverLetterPageJob({ doc: document, job: { title: 'Analyst‮', company: 'Acme\u0007', description: 'x'.repeat(30_000) }, card: { title: '', company: '' } });
    expect(job?.title).toBe('Analyst');
    expect(job?.company).toBe('Acme');
    expect(job?.description.length).toBeLessThanOrEqual(20_000);
  });
});

describe('内容脚本把 worker 的答复接成交给内核的求职信', () => {
  const ready = { kind: 'COVER_LETTER_READY' as const, artifactId: ARTIFACT, generated: true };

  it('文字框要正文、上传栏要 PDF；PDF 等内核走到那一栏才要', async () => {
    const ask = vi.fn(async (request: { step: string }) => (
      request.step === 'PREPARE' ? ready
        : request.step === 'TEXT' ? { kind: 'COVER_LETTER_TEXT' as const, artifactId: ARTIFACT, text: 'Dear hiring team' }
          : { kind: 'COVER_LETTER_FILE' as const, artifactId: ARTIFACT, fileName: 'Cover Letter.pdf', size: 4, bytesBase64: 'JVBERg==' }));
    const outcome = await coverLetterFromWorker(ask as never, { text: true, file: true });
    expect(outcome.kind).toBe('MATERIAL');
    if (outcome.kind !== 'MATERIAL') return;
    expect(outcome.material.text).toBe('Dear hiring team');
    expect(ask.mock.calls.map((call) => call[0].step)).toEqual(['PREPARE', 'TEXT']);
    const file = await outcome.material.file!.resolve();
    expect(file?.name).toBe('Cover Letter.pdf');
    expect(file?.size).toBe(4);
  });

  it('交回来的不是那一封（id 对不上）：不挂', async () => {
    const ask = vi.fn(async (request: { step: string }) => (
      request.step === 'PREPARE' ? ready
        : { kind: 'COVER_LETTER_FILE' as const, artifactId: '00000000-0000-4000-8000-0000000000bb', fileName: 'Cover Letter.pdf', size: 4, bytesBase64: 'JVBERg==' }));
    const outcome = await coverLetterFromWorker(ask as never, { text: false, file: true });
    if (outcome.kind !== 'MATERIAL') throw new Error('expected material');
    expect(await outcome.material.file!.resolve()).toBeNull();
  });

  it('拒绝原样交回；浮层上 NOT_FOUND 与 BUSY 都说这次没写出来', async () => {
    const outcome = await coverLetterFromWorker(async () => ({ kind: 'REFUSED', code: 'NEEDS_PAGE_JOB' }), { text: true, file: false });
    expect(outcome).toEqual({ kind: 'REFUSED', code: 'NEEDS_PAGE_JOB' });
    expect(shownLetterRefusal('NOT_FOUND')).toBe('UNAVAILABLE');
    expect(shownLetterRefusal('BUSY')).toBe('UNAVAILABLE');
    expect(shownLetterRefusal('USAGE_EXHAUSTED')).toBe('USAGE_EXHAUSTED');
  });
});
