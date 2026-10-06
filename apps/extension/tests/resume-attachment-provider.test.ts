import { describe, expect, it, vi } from 'vitest';
import { createDockResumeAttachmentIntent } from '../lib/resumeAttachmentIntent';
import { createResumeAttachmentProvider } from '../lib/resumeAttachmentProvider';
import { decodeBase64 } from '../lib/binaryEncoding';

/**
 * worker 侧：PLAN / RELEASE 怎么变成对后端的问询与释出（P1-4）。
 *
 * 钉三件事：附哪一份（默认 → 唯一 → 拒，绝不替他挑）；收件人由 worker 自己
 * 从核对过的 origin/pathname 组、不收内容脚本另报的值；PLAN 的答复留一会儿而
 * 字节永远不留，worker 重启后 RELEASE 也能自己补问。
 */

const V1 = '2f1c8f3e-2a5b-4a1e-9d0b-1a2b3c4d5e6f';
const V2 = '9c7d6e5f-4a3b-42c1-8e9f-0a1b2c3d4e5f';
const ARTIFACT = '11111111-2222-4333-8444-555555555555';
const PAGE = ['https://boards.greenhouse.io', '/example/jobs/1/application'] as const;
const PDF = new Uint8Array(new TextEncoder().encode('%PDF-1.4 fixture'));

const item = (resumeVersionId: string, isDefault: boolean) => ({
  trackId: '00000000-0000-4000-8000-000000000001',
  trackName: 'General',
  resumeVersionId,
  label: null,
  fileName: 'taylor.pdf',
  mimeType: 'application/pdf',
  fileSize: PDF.byteLength,
  versionNumber: 1,
  contentRevision: '3',
  isDefault,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
});

const list = (items: ReturnType<typeof item>[], defaultResumeVersionId: string | null) => ({
  ok: true as const,
  value: { schemaVersion: 1 as const, libraryRevision: '4', defaultResumeVersionId, items } as never,
});

const planOf = (resumeVersionId: string) => ({
  schemaVersion: 1 as const,
  resumeVersionId,
  artifactId: ARTIFACT,
  contentRevision: '3',
  libraryRevision: '4',
  fileName: 'Taylor Kim.pdf',
  mimeType: 'application/pdf' as const,
  size: PDF.byteLength,
  label: null,
  createdAt: '2026-09-18T00:00:00.000Z',
});

function harness(over: {
  listResumes?: () => Promise<unknown>;
  plan?: (...args: unknown[]) => Promise<unknown>;
  release?: (...args: unknown[]) => Promise<unknown>;
  prepared?: (...args: unknown[]) => Promise<unknown>;
  now?: () => number;
  planTtlMs?: number;
} = {}) {
  const diagnostics: string[] = [];
  const listResumes = vi.fn(over.listResumes ?? (async () => list([item(V1, true)], V1)));
  const plan = vi.fn(over.plan ?? (async (request: { resumeVersionId: string }) => ({ ok: true, value: planOf(request.resumeVersionId) })));
  const release = vi.fn(over.release ?? (async () => ({ ok: true, value: { fileName: 'Taylor Kim.pdf', size: PDF.byteLength, bytes: PDF } })));
  // 默认「这一页没有为它准备好的简历」：走简历库默认版那条路。
  const prepared = vi.fn(over.prepared ?? (async () => ({ ok: true, value: { schemaVersion: 1, resumeVersionId: null } })));
  const provider = createResumeAttachmentProvider({
    listResumes: listResumes as never,
    client: { plan, release, prepared } as never,
    onDiagnostic: (code) => diagnostics.push(code),
    ...(over.now === undefined ? {} : { now: over.now }),
    ...(over.planTtlMs === undefined ? {} : { planTtlMs: over.planTtlMs }),
  });
  const ask = (step: 'PLAN' | 'RELEASE', sender = 'tab-1', page: readonly [string, string] = PAGE) =>
    provider.handle(createDockResumeAttachmentIntent(page[0], page[1], step)!, sender);
  return { ask, listResumes, plan, release, prepared, diagnostics };
}

describe('附哪一份', () => {
  it('默认那一份；收件人 = 核对过的 origin + pathname', async () => {
    const h = harness({ listResumes: async () => list([item(V2, false), item(V1, true)], V1) });
    expect(await h.ask('PLAN')).toEqual({ kind: 'RESUME_ATTACHMENT_PLAN', fileName: 'Taylor Kim.pdf', size: PDF.byteLength });
    expect(h.plan).toHaveBeenCalledWith({
      resumeVersionId: V1,
      target: { canonicalOrigin: PAGE[0], jobId: PAGE[1] },
    });
  });

  it('没有默认但只有一份，就是那一份', async () => {
    const h = harness({ listResumes: async () => list([item(V2, false)], null) });
    expect((await h.ask('PLAN')).kind).toBe('RESUME_ATTACHMENT_PLAN');
    expect(h.plan.mock.calls[0]?.[0]).toMatchObject({ resumeVersionId: V2 });
  });

  it('好几份又没有默认 → 拒（RESUME_CHOICE_REQUIRED），不替他挑', async () => {
    const h = harness({ listResumes: async () => list([item(V1, false), item(V2, false)], null) });
    expect(await h.ask('PLAN')).toEqual({ kind: 'REFUSED', code: 'RESUME_CHOICE_REQUIRED' });
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.diagnostics).toContain('RESUME_ATTACHMENT_RESUME_CHOICE_REQUIRED');
  });

  it('一份都没有 → NO_RESUME', async () => {
    const h = harness({ listResumes: async () => list([], null) });
    expect(await h.ask('PLAN')).toEqual({ kind: 'REFUSED', code: 'NO_RESUME' });
  });

  it('清单读不到 → 原样把那一档交回去，不当成「没有简历」', async () => {
    const h = harness({ listResumes: async () => ({ ok: false, code: 'AUTH_REQUIRED' }) });
    expect(await h.ask('PLAN')).toEqual({ kind: 'REFUSED', code: 'AUTH_REQUIRED' });
    const paywall = harness({ listResumes: async () => ({ ok: false, code: 'PAYWALL_REQUIRED' }) });
    expect(await paywall.ask('PLAN')).toEqual({ kind: 'REFUSED', code: 'PAYWALL_REQUIRED' });
  });
});

describe('问询被拒', () => {
  it('后端不许把简历交给这个域名 → TARGET_NOT_ALLOWED，且只记稳定码', async () => {
    const h = harness({ plan: async () => ({ ok: false, code: 'TARGET_NOT_ALLOWED' }) });
    expect(await h.ask('PLAN')).toEqual({ kind: 'REFUSED', code: 'TARGET_NOT_ALLOWED' });
    expect(h.diagnostics).toEqual(['RESUME_ATTACHMENT_DEFAULT_VERSION', 'RESUME_ATTACHMENT_PLAN_TARGET_NOT_ALLOWED']);
  });

  it('这一份此刻给不出 → RESUME_UNAVAILABLE，诊断码缀上服务端的码（还没渲染好 / 版本过期 / 找不到）', async () => {
    const h = harness({ plan: async () => ({ ok: false, code: 'RESUME_UNAVAILABLE', serverCode: 'VERSION_NOT_READY' }) });
    expect(await h.ask('PLAN')).toEqual({ kind: 'REFUSED', code: 'RESUME_UNAVAILABLE' });
    expect(h.diagnostics).toEqual(['RESUME_ATTACHMENT_DEFAULT_VERSION', 'RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE_VERSION_NOT_READY']);
    // 没带服务端码时照旧只有一段。
    const bare = harness({ plan: async () => ({ ok: false, code: 'RESUME_UNAVAILABLE' }) });
    await bare.ask('PLAN');
    expect(bare.diagnostics).toEqual(['RESUME_ATTACHMENT_DEFAULT_VERSION', 'RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE']);
  });

  it.each(['boards.greenhouse.io', 'EVIL:HOST', 'not a code', 'lowercase_code', 'X'.repeat(65)])(
    '服务端的码不是闭集形状（%s）：缀之前再核一次，不进诊断码（2026-10-04 体检 Data-L1）',
    async (serverCode) => {
      const planned = harness({ plan: async () => ({ ok: false, code: 'RESUME_UNAVAILABLE', serverCode }) });
      await planned.ask('PLAN');
      expect(planned.diagnostics).toEqual(['RESUME_ATTACHMENT_DEFAULT_VERSION', 'RESUME_ATTACHMENT_PLAN_RESUME_UNAVAILABLE']);
      const released = harness({ release: async () => ({ ok: false, code: 'UNAVAILABLE', serverCode }) });
      await released.ask('RELEASE');
      expect(released.diagnostics).toContain('RESUME_ATTACHMENT_RELEASE_UNAVAILABLE');
      expect(JSON.stringify([...planned.diagnostics, ...released.diagnostics])).not.toContain(serverCode);
    },
  );
});

describe('PLAN 与 RELEASE 配成一对', () => {
  it('同一个标签页、同一页：RELEASE 用 PLAN 钉下的计划，问询只发一次', async () => {
    const h = harness();
    await h.ask('PLAN');
    const released = await h.ask('RELEASE');
    expect(released.kind).toBe('RESUME_ATTACHMENT_FILE');
    if (released.kind !== 'RESUME_ATTACHMENT_FILE') return;
    expect(released.fileName).toBe('Taylor Kim.pdf');
    expect(released.size).toBe(PDF.byteLength);
    expect(decodeBase64(released.bytesBase64)).toEqual(PDF);
    expect(h.plan).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith(planOf(V1), { canonicalOrigin: PAGE[0], jobId: PAGE[1] });
    expect(h.diagnostics).toContain('RESUME_ATTACHMENT_RELEASED');
  });

  it('字节永远不留：再要一次就再释出一次', async () => {
    const h = harness();
    await h.ask('PLAN');
    await h.ask('RELEASE');
    await h.ask('RELEASE');
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.plan).toHaveBeenCalledTimes(1);
  });

  it('worker 重启后没有那份记录：RELEASE 自己先问一次', async () => {
    const h = harness();
    expect((await h.ask('RELEASE')).kind).toBe('RESUME_ATTACHMENT_FILE');
    expect(h.plan).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('另一个标签页有自己的计划，不共用', async () => {
    const h = harness();
    await h.ask('PLAN', 'tab-1');
    await h.ask('RELEASE', 'tab-2');
    expect(h.plan).toHaveBeenCalledTimes(2);
  });

  it('记录过期就重问', async () => {
    let t = 1_000;
    const h = harness({ now: () => t, planTtlMs: 100 });
    await h.ask('PLAN');
    t += 101;
    await h.ask('RELEASE');
    expect(h.plan).toHaveBeenCalledTimes(2);
  });

  it('记着的计划已经过期（用户刚换了版本）：重问一次再释出，只重问一次', async () => {
    const release = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'RESUME_UNAVAILABLE' })
      .mockResolvedValueOnce({ ok: true, value: { fileName: 'Taylor Kim.pdf', size: PDF.byteLength, bytes: PDF } });
    const h = harness({ release });
    await h.ask('PLAN');
    expect((await h.ask('RELEASE')).kind).toBe('RESUME_ATTACHMENT_FILE');
    expect(h.plan).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it('释出被拒 → 那一档原样交回，记稳定码', async () => {
    const h = harness({ release: async () => ({ ok: false, code: 'UNAVAILABLE' }) });
    expect(await h.ask('RELEASE')).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    expect(h.diagnostics).toContain('RESUME_ATTACHMENT_RELEASE_UNAVAILABLE');
  });
});

describe('先附为这个岗位准备好的那一版', () => {
  const PREPARED = '33333333-4444-4555-8666-777777777777';

  it('ArgoLand 说这一页有准备好的版本 → 附它，简历库清单的结果不用', async () => {
    // 清单与准备过的版本同时问（2026-09-23 测速：三次往返排队要一秒多），但有准备过的版本时
    // 附的就是它，清单里的默认版一眼都不看。
    const h = harness({ prepared: async () => ({ ok: true, value: { schemaVersion: 1, resumeVersionId: PREPARED } }) });
    expect((await h.ask('PLAN')).kind).toBe('RESUME_ATTACHMENT_PLAN');
    expect(h.prepared).toHaveBeenCalledWith({ canonicalOrigin: PAGE[0], jobId: PAGE[1] });
    expect(h.plan.mock.calls[0]?.[0]).toMatchObject({ resumeVersionId: PREPARED });
    expect(h.plan).toHaveBeenCalledTimes(1);
    expect(h.diagnostics).toEqual(['RESUME_ATTACHMENT_PREPARED_FOR_JOB']);
  });

  it('清单是同时问的：准备过的版本答得慢，清单不等它', async () => {
    let answerPrepared: (value: unknown) => void = () => {};
    const h = harness({ prepared: () => new Promise((resolve) => { answerPrepared = resolve as never; }) as never });
    const asked = h.ask('PLAN');
    await Promise.resolve();
    expect(h.listResumes, '不等「准备过的版本」答完就去要清单').toHaveBeenCalledTimes(1);
    answerPrepared({ ok: true, value: { schemaVersion: 1, resumeVersionId: null } });
    expect((await asked).kind).toBe('RESUME_ATTACHMENT_PLAN');
    expect(h.plan.mock.calls[0]?.[0]).toMatchObject({ resumeVersionId: V1 });
  });

  it('没有准备好的版本 → 默认版，并记下是默认版', async () => {
    const h = harness();
    expect((await h.ask('PLAN')).kind).toBe('RESUME_ATTACHMENT_PLAN');
    expect(h.plan.mock.calls[0]?.[0]).toMatchObject({ resumeVersionId: V1 });
    expect(h.diagnostics).toEqual(['RESUME_ATTACHMENT_DEFAULT_VERSION']);
  });

  it('问询本身失败不挡路：记码、退到默认版', async () => {
    const h = harness({ prepared: async () => ({ ok: false, code: 'UNAVAILABLE' }) });
    expect((await h.ask('PLAN')).kind).toBe('RESUME_ATTACHMENT_PLAN');
    expect(h.plan.mock.calls[0]?.[0]).toMatchObject({ resumeVersionId: V1 });
    expect(h.diagnostics).toEqual(['RESUME_ATTACHMENT_PREPARED_LOOKUP_UNAVAILABLE', 'RESUME_ATTACHMENT_DEFAULT_VERSION']);
  });
});

/**
 * 页面绑着用户在门户「开始申请」的任务（2026-09-24）：附的是任务钉住的那份定制简历，经任务的材料入口
 * 释出。手势路自己那两问（为这个岗位准备过的一版、简历库默认版）一次都不问——问出来的可能是另一版。
 */
describe('绑着任务的页：简历只从任务的材料入口来', () => {
  const mission = (over: { plan?: unknown; release?: unknown } = {}) => ({
    plan: vi.fn(async () => over.plan ?? { ok: true, fileName: 'Avery Resume.pdf', size: PDF.byteLength }),
    release: vi.fn(async () => over.release ?? { ok: true, fileName: 'Avery Resume.pdf', size: PDF.byteLength, bytes: PDF }),
  });
  function withMission(supply: ReturnType<typeof mission> | null | 'throws') {
    const diagnostics: string[] = [];
    const listResumes = vi.fn(async () => list([item(V1, true)], V1));
    const prepared = vi.fn(async () => ({ ok: true, value: { schemaVersion: 1, resumeVersionId: null } }));
    const plan = vi.fn(async (request: { resumeVersionId: string }) => ({ ok: true, value: planOf(request.resumeVersionId) }));
    const release = vi.fn(async () => ({ ok: true, value: { fileName: 'Taylor Kim.pdf', size: PDF.byteLength, bytes: PDF } }));
    const missionResume = vi.fn(async () => {
      if (supply === 'throws') throw new Error('binding read failed');
      return supply as never;
    });
    const provider = createResumeAttachmentProvider({
      listResumes: listResumes as never,
      client: { plan, release, prepared } as never,
      missionResume,
      onDiagnostic: (code) => diagnostics.push(code),
    });
    const ask = (step: 'PLAN' | 'RELEASE') => provider.handle(createDockResumeAttachmentIntent(PAGE[0], PAGE[1], step)!, 'tab-9');
    return { ask, listResumes, prepared, plan, release, missionResume, diagnostics };
  }

  it('PLAN 报任务那份的名字与大小，RELEASE 交它的字节；手势路的两问一次都不问', async () => {
    const supply = mission();
    const h = withMission(supply);

    await expect(h.ask('PLAN')).resolves.toEqual({ kind: 'RESUME_ATTACHMENT_PLAN', fileName: 'Avery Resume.pdf', size: PDF.byteLength });
    const file = await h.ask('RELEASE');
    expect(file.kind).toBe('RESUME_ATTACHMENT_FILE');
    if (file.kind === 'RESUME_ATTACHMENT_FILE') expect(decodeBase64(file.bytesBase64)).toEqual(PDF);

    expect(h.missionResume).toHaveBeenCalledWith('tab-9', { origin: PAGE[0], pathname: PAGE[1] });
    expect(h.prepared).not.toHaveBeenCalled();
    expect(h.listResumes).not.toHaveBeenCalled();
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.diagnostics).toEqual(['RESUME_ATTACHMENT_MISSION_MATERIAL', 'RESUME_ATTACHMENT_MISSION_RELEASED']);
  });

  it('任务那份此刻给不出 → 如实拒（RESUME_UNAVAILABLE），不退回准备过的一版或默认版', async () => {
    const h = withMission(mission({ plan: { ok: false, code: 'RESUME_UNAVAILABLE' } }));

    await expect(h.ask('PLAN')).resolves.toEqual({ kind: 'REFUSED', code: 'RESUME_UNAVAILABLE' });
    expect(h.prepared).not.toHaveBeenCalled();
    expect(h.listResumes).not.toHaveBeenCalled();
    expect(h.diagnostics).toEqual(['RESUME_ATTACHMENT_MISSION_PLAN_RESUME_UNAVAILABLE']);
  });

  it('没绑任务、或问归属本身失败 → 手势路原样（先问准备过的一版）', async () => {
    for (const supply of [null, 'throws'] as const) {
      const h = withMission(supply);
      expect((await h.ask('PLAN')).kind).toBe('RESUME_ATTACHMENT_PLAN');
      expect(h.prepared).toHaveBeenCalledTimes(1);
      expect(h.plan.mock.calls[0]?.[0]).toMatchObject({ resumeVersionId: V1 });
    }
  });
});
