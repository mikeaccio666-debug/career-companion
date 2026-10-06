import { describe, expect, it, vi } from 'vitest';

import type { CoverLetterAttachmentClient } from '../lib/coverLetterAttachmentClient';
import { createDockCoverLetterIntent, parseDockCoverLetterIntent, parseDockCoverLetterReply } from '../lib/coverLetterIntent';
import { createCoverLetterProvider } from '../lib/coverLetterProvider';

/**
 * worker 这一侧的求职信（2026-09-27）：岗位库里的岗位已有一封就不碰计量的 prepare；不在库里的页面没读到职位描述
 * 就不写；读到了就带上它去写。重试沿用同一个请求号，写好之后下一次另起。
 */
const ARTIFACT = '00000000-0000-4000-8000-0000000000aa';
const GENERATED_AT = '2026-09-27T10:00:00.000Z';
const ORIGIN = 'https://job-boards.greenhouse.io';
const PATH = '/acme/jobs/123';
const PAGE_JOB = { schemaVersion: 1 as const, title: 'Business Analyst', company: 'Acme', description: 'Analyse sales data. '.repeat(20), source: 'JOB_POSTING' as const };

function client(over: Record<string, unknown> = {}) {
  const base = {
    lookup: vi.fn(async () => ({ ok: true as const, value: { schemaVersion: 1 as const, state: 'NONE' as const, jobSource: 'CATALOG' as const } })),
    prepare: vi.fn(async () => ({ ok: true as const, value: { schemaVersion: 1 as const, ok: true as const, coverLetter: { state: 'READY' as const, artifactId: ARTIFACT, generatedAt: GENERATED_AT }, generated: true } })),
    text: vi.fn(async () => ({ ok: true as const, value: 'Dear hiring team' })),
    pdf: vi.fn(async () => ({ ok: true as const, value: { fileName: 'Cover Letter.pdf', size: 4, sha256: 'sha256:x', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) } })),
  };
  return { ...base, ...over } as unknown as CoverLetterAttachmentClient;
}

const prepare = (pageJob?: typeof PAGE_JOB) =>
  createDockCoverLetterIntent(ORIGIN, PATH, pageJob === undefined ? { step: 'PREPARE' } : { step: 'PREPARE', pageJob })!;

describe('PREPARE', () => {
  it('岗位库里的岗位已有一封：直接交回，不碰计量的 prepare', async () => {
    const api = client({ lookup: vi.fn(async () => ({ ok: true as const, value: { schemaVersion: 1 as const, state: 'READY' as const, jobSource: 'CATALOG' as const, artifactId: ARTIFACT, generatedAt: GENERATED_AT } })) });
    const reply = await createCoverLetterProvider({ client: api }).handle(prepare(), '7');
    expect(reply).toEqual({ kind: 'COVER_LETTER_READY', artifactId: ARTIFACT, generated: false });
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('岗位库里的岗位还没有：去写，不带这一页的职位描述（服务端用核实过的）', async () => {
    const api = client();
    const reply = await createCoverLetterProvider({ client: api, newRequestId: () => '00000000-0000-4000-8000-000000000001' }).handle(prepare(PAGE_JOB), '7');
    expect(reply).toEqual({ kind: 'COVER_LETTER_READY', artifactId: ARTIFACT, generated: true });
    expect(api.prepare).toHaveBeenCalledWith({ canonicalOrigin: ORIGIN, jobId: PATH }, { clientRequestId: '00000000-0000-4000-8000-000000000001' });
  });

  it('不在岗位库里、又没读到职位描述：写不了，交还本人', async () => {
    const api = client({ lookup: vi.fn(async () => ({ ok: true as const, value: { schemaVersion: 1 as const, state: 'NONE' as const, jobSource: 'PAGE' as const } })) });
    expect(await createCoverLetterProvider({ client: api }).handle(prepare(), '7')).toEqual({ kind: 'REFUSED', code: 'NEEDS_PAGE_JOB' });
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('不在岗位库里、读到了职位描述：带上它去写（已有的那一封也经 prepare 按岗位认）', async () => {
    const api = client({ lookup: vi.fn(async () => ({ ok: true as const, value: { schemaVersion: 1 as const, state: 'READY' as const, jobSource: 'PAGE' as const, artifactId: ARTIFACT, generatedAt: GENERATED_AT } })) });
    await createCoverLetterProvider({ client: api, newRequestId: () => '00000000-0000-4000-8000-000000000002' }).handle(prepare(PAGE_JOB), '7');
    expect(api.prepare).toHaveBeenCalledWith({ canonicalOrigin: ORIGIN, jobId: PATH }, { clientRequestId: '00000000-0000-4000-8000-000000000002', pageJob: PAGE_JOB });
  });

  it('服务端的领域失败按浮层那几句话分档', async () => {
    const cases = [
      ['COVER_LETTER_JOB_NOT_IN_CATALOG', 'NEEDS_PAGE_JOB'],
      ['COVER_LETTER_UNSAFE_SOURCE', 'JOB_TEXT_UNUSABLE'],
      ['COVER_LETTER_INPUT_TOO_LARGE', 'JOB_TEXT_UNUSABLE'],
      ['COVER_LETTER_PROFILE_UNAVAILABLE', 'PROFILE_UNAVAILABLE'],
      ['COVER_LETTER_BUSY', 'BUSY'],
      ['COVER_LETTER_PROVIDER_FAILED', 'UNAVAILABLE'],
    ] as const;
    for (const [code, refusal] of cases) {
      const api = client({ prepare: vi.fn(async () => ({ ok: true as const, value: { schemaVersion: 1 as const, ok: false as const, code } })) });
      expect(await createCoverLetterProvider({ client: api }).handle(prepare(), '7'), code).toEqual({ kind: 'REFUSED', code: refusal });
    }
  });

  it('没有额度 / 次数用完 / 收件网站被拒：各自的码', async () => {
    for (const code of ['PAYWALL_REQUIRED', 'USAGE_EXHAUSTED', 'TARGET_NOT_ALLOWED', 'AUTH_REQUIRED'] as const) {
      const api = client({ prepare: vi.fn(async () => ({ ok: false as const, code })) });
      expect(await createCoverLetterProvider({ client: api }).handle(prepare(), '7')).toEqual({ kind: 'REFUSED', code });
    }
  });

  it('重试沿用同一个请求号（服务端重放、不重扣）；写好之后下一次另起一个', async () => {
    const ids = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'];
    let next = 0;
    const prepareFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'UNAVAILABLE' })
      .mockResolvedValueOnce({ ok: true, value: { schemaVersion: 1, ok: true, coverLetter: { state: 'READY', artifactId: ARTIFACT, generatedAt: GENERATED_AT }, generated: true } })
      .mockResolvedValueOnce({ ok: true, value: { schemaVersion: 1, ok: true, coverLetter: { state: 'READY', artifactId: ARTIFACT, generatedAt: GENERATED_AT }, generated: false } });
    const provider = createCoverLetterProvider({ client: client({ prepare: prepareFn }), newRequestId: () => ids[next++]! });
    await provider.handle(prepare(), '7');
    await provider.handle(prepare(), '7');
    await provider.handle(prepare(), '7');
    expect(prepareFn.mock.calls.map((call) => (call[1] as { clientRequestId: string }).clientRequestId)).toEqual([ids[0], ids[0], ids[1]]);
  });

  it('同一页同时要两次：合成一次', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prepareFn = vi.fn(async () => {
      await gate;
      return { ok: true as const, value: { schemaVersion: 1 as const, ok: true as const, coverLetter: { state: 'READY' as const, artifactId: ARTIFACT, generatedAt: GENERATED_AT }, generated: true } };
    });
    const provider = createCoverLetterProvider({ client: client({ prepare: prepareFn }) });
    const first = provider.handle(prepare(), '7');
    const second = provider.handle(prepare(), '7');
    release();
    expect(await first).toEqual(await second);
    expect(prepareFn).toHaveBeenCalledTimes(1);
  });
});

describe('TEXT / PDF', () => {
  it('正文与 PDF 交回来，PDF 走 base64', async () => {
    const provider = createCoverLetterProvider({ client: client() });
    expect(await provider.handle(createDockCoverLetterIntent(ORIGIN, PATH, { step: 'TEXT', artifactId: ARTIFACT })!, '7'))
      .toEqual({ kind: 'COVER_LETTER_TEXT', artifactId: ARTIFACT, text: 'Dear hiring team' });
    expect(await provider.handle(createDockCoverLetterIntent(ORIGIN, PATH, { step: 'PDF', artifactId: ARTIFACT })!, '7'))
      .toEqual({ kind: 'COVER_LETTER_FILE', artifactId: ARTIFACT, fileName: 'Cover Letter.pdf', size: 4, bytesBase64: 'JVBERg==' });
  });

  it('交不出来：照实拒', async () => {
    const provider = createCoverLetterProvider({ client: client({ pdf: vi.fn(async () => ({ ok: false as const, code: 'NOT_FOUND' as const })) }) });
    expect(await provider.handle(createDockCoverLetterIntent(ORIGIN, PATH, { step: 'PDF', artifactId: ARTIFACT })!, '7'))
      .toEqual({ kind: 'REFUSED', code: 'NOT_FOUND' });
  });
});

describe('内容脚本与 worker 之间的那条消息', () => {
  it('每一步的键是精确的：PREPARE 不带 artifactId，TEXT / PDF 必带', () => {
    const base = { kind: 'dock/cover-letter-intent', version: prepare().version, origin: ORIGIN, pathname: PATH };
    expect(parseDockCoverLetterIntent({ ...base, step: 'PREPARE' })).not.toBeNull();
    expect(parseDockCoverLetterIntent({ ...base, step: 'PREPARE', artifactId: ARTIFACT })).toBeNull();
    expect(parseDockCoverLetterIntent({ ...base, step: 'TEXT' })).toBeNull();
    expect(parseDockCoverLetterIntent({ ...base, step: 'TEXT', artifactId: 'not-a-uuid' })).toBeNull();
    expect(parseDockCoverLetterIntent({ ...base, step: 'PDF', artifactId: ARTIFACT, pageJob: PAGE_JOB })).toBeNull();
    expect(parseDockCoverLetterIntent({ ...base, step: 'PREPARE', pageJob: { ...PAGE_JOB, description: 'x‮y' } })).toBeNull();
    expect(parseDockCoverLetterIntent({ ...base, step: 'PREPARE', extra: 1 })).toBeNull();
  });

  it('答复：认不出的码、名字不对的 PDF、空正文一律不认', () => {
    expect(parseDockCoverLetterReply({ kind: 'REFUSED', code: 'SOMETHING_ELSE' })).toBeNull();
    expect(parseDockCoverLetterReply({ kind: 'COVER_LETTER_FILE', artifactId: ARTIFACT, fileName: 'resume.pdf', size: 4, bytesBase64: 'JVBERg==' })).toBeNull();
    expect(parseDockCoverLetterReply({ kind: 'COVER_LETTER_TEXT', artifactId: ARTIFACT, text: '   ' })).toBeNull();
    expect(parseDockCoverLetterReply({ kind: 'COVER_LETTER_READY', artifactId: ARTIFACT, generated: true })).toEqual({ kind: 'COVER_LETTER_READY', artifactId: ARTIFACT, generated: true });
  });
});
