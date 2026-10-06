import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * 简历文件**从扫描一路通到真实写入**的可达性测试。
 *
 * 这个项目已经三次踩到"写好了没有调用方"（蜜罐守卫、推荐人守卫、JOB_DEPENDENT），
 * 每次都是单测全绿而真实页面上零效果。所以这里断言的不是某个函数的返回值，
 * 而是四件"接上了"的事实：分类器认得、引擎收窄到简历那一栏、能力集里有 set-file、
 * runner 真的把文件挂了上去。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function stubVisibleNativeFileInput(input: HTMLInputElement): void {
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
    width: 230,
    height: 40,
    top: 300,
    left: 0,
    right: 230,
    bottom: 340,
    x: 0,
    y: 300,
    toJSON: () => ({}),
  } as DOMRect);
}

/** 实测形状：一张表上常常不止一个 file 控件。这里放两个，只有一个是简历。 */
function mountFormWithUploads(): { root: ReturnType<typeof createScanRoot>; resume: HTMLInputElement } {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="email">Email</label><input id="email" type="email" />
      <label for="resume">Resume/CV</label>
      <input id="resume" type="file" accept=".pdf,.doc,.docx" />
      <label for="transcript">Transcript</label><input id="transcript" type="file" />
    </form>`;
  const form = document.querySelector('form') as HTMLFormElement;
  const resume = document.getElementById('resume') as HTMLInputElement;
  stubVisibleNativeFileInput(resume);
  return { root: createScanRoot(form, []), resume };
}

function plan(resumeFileName?: string) {
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单，断言等于空转').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    { email: 'ada@example.test' },
    { resumeFileName, resumeHostConfirmed: true },
  );
}

const pdf = () =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'Ada_Lovelace.pdf', {
    type: 'application/pdf',
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('简历文件路径可达性', () => {
  it('file 控件被判成 file kind，不是 unsupported', () => {
    mountFormWithUploads();
    const root = greenhouseAdapter.resolveRoot(document)!;
    const fields = greenhouseAdapter.scan(root);
    const resume = fields.find((field) => field.label.includes('Resume'));
    expect(resume?.kind, 'file 控件仍被当成不支持的控件').toBe('file');
  });

  /**
   * **只填简历那一栏。** 把简历挂到"成绩单"上比不挂糟得多——recruiter 会看到一份
   * 明显不对的附件，而用户以为自己传对了。
   */
  it('同一张表上的非简历上传栏不进计划', () => {
    mountFormWithUploads();
    const built = plan('Ada_Lovelace.pdf');
    const fileEntries = built.entries.filter((entry) => entry.kind === 'file');
    expect(fileEntries).toHaveLength(1);
    expect(fileEntries[0]?.label).toContain('Resume');
    expect(
      built.skipped.some((item) => item.label.includes('Transcript')),
      '成绩单那一栏没有被跳过',
    ).toBe(true);
  });

  it('非简历属性身份胜过过期的 resume id', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">Attach</label>
        <input id="resume" name="transcript" type="file" />
      </form>`;

    const built = plan('Ada_Lovelace.pdf');

    expect(built.entries.some((entry) => entry.kind === 'file')).toBe(false);
    expect(built.skipped.find((entry) => entry.label.includes('Attach'))?.reason).toBe(
      'UNSUPPORTED_CONTROL',
    );
  });

  it('没有简历时报缺资料，不报"不支持"', () => {
    mountFormWithUploads();
    const built = plan(undefined);
    const item = built.skipped.find((entry) => entry.label.includes('Resume'));
    expect(
      item?.reason,
      '没有简历应该是"去补资料"，不是"这个控件我们填不了"——两者的下一步动作不同',
    ).toBe('NO_VALUE');
  });

  it('用户已经挂了文件时不进计划', () => {
    const { resume } = mountFormWithUploads();
    const existing = new DataTransfer();
    existing.items.add(new File(['x'], 'user-tailored.pdf', { type: 'application/pdf' }));
    resume.files = existing.files;

    const built = plan('Ada_Lovelace.pdf');
    expect(built.entries.some((entry) => entry.kind === 'file')).toBe(false);
    expect(built.skipped.find((item) => item.label.includes('Resume'))?.reason).toBe('NOT_EMPTY');
  });

  it('含简历的计划会申请 set-file 能力（最小权限）', () => {
    mountFormWithUploads();
    const kinds = plan('Ada_Lovelace.pdf').entries.map((entry) => entry.kind);
    expect(kinds, '计划里没有文件条目，后面的断言就是空转').toContain('file');
    expect([...capabilitiesForKinds(kinds)]).toContain('set-file');
    expect([...capabilitiesForKinds(['text'])], '纯文本计划不该申请传文件的能力').toEqual([
      'set-text',
    ]);
  });

  it('runApplyPlan 真的把简历挂了上去', async () => {
    const { root, resume } = mountFormWithUploads();
    const built = plan('Ada_Lovelace.pdf');
    const changes: boolean[] = [];
    resume.addEventListener('change', () => changes.push(true));

    const journal = createUndoJournal();
    const auth = testAuthority(built.fingerprint, 'fill', [
      ...capabilitiesForKinds(built.entries.map((entry) => entry.kind)),
    ]);
    const resolver = vi.fn(async () => pdf());
    const summary = await runApplyPlan({
      plan: built,
      auth,
      journal,
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: resolver,
    });

    expect(resume.files?.length, '简历没有被挂上去 —— 这条路是断的').toBe(1);
    expect(resume.files?.[0]?.name).toBe('Ada_Lovelace.pdf');
    expect(changes.length, '宿主没有收到 change —— 很多站点靠它才认这个文件').toBe(1);

    const fileResult = summary.results.find((entry) => entry.key === 'resumeFile');
    expect(fileResult?.ok).toBe(true);
    expect(
      fileResult?.ok === true ? fileResult.unverified : 'no-result',
      '文件控件的回读是 input.files 的对象同一性，不是字符串比对：读得到就不该报"读不回"',
    ).toBeUndefined();
    expect(resolver).toHaveBeenCalledWith({
      authorityExpiresAt: auth.expiresAt,
      signal: undefined,
    });

    const undo = journal.undoAll(
      testAuthority(null, 'undo', [...journal.requiredUndoCapabilities()]),
    );
    expect(undo).toMatchObject({ restored: 2, remaining: 0 });
    expect(resume.files).toHaveLength(0);
    expect(changes.length, '撤销文件后宿主没有收到 change').toBe(2);
  });

  it('用户在 Fill 后换过文件时，Undo 保留用户文件并永久放弃旧票据', async () => {
    const { root, resume } = mountFormWithUploads();
    const built = plan('Ada_Lovelace.pdf');
    const journal = createUndoJournal();
    await runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', [
        ...capabilitiesForKinds(built.entries.map((entry) => entry.kind)),
      ]),
      journal,
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => pdf(),
    });
    const candidate = new File(['candidate'], 'job-tailored.pdf', { type: 'application/pdf' });
    const replacement = new DataTransfer();
    replacement.items.add(candidate);
    resume.files = replacement.files;

    const undo = journal.undoAll(
      testAuthority(null, 'undo', [...journal.requiredUndoCapabilities()]),
    );

    expect(resume.files?.[0]).toBe(candidate);
    expect(undo).toMatchObject({ restored: 1, skippedUserEdited: 1, remaining: 0 });
    expect(journal.canUndo()).toBe(false);
  });

  // 2026-09-23 起写前漂移只放弃那一栏（不连坐、不置 abortedBy），页面级信号记在 identityDrift。
  // 这两条护的是「等字节的时候目标变了就一个字节都不挂」，这一点一字没松。
  it('下载等待中字段改成非简历上传栏时，写前复核放弃这一栏、不挂文件，如实记一次漂移', async () => {
    const { root, resume } = mountFormWithUploads();
    const built = plan('Ada_Lovelace.pdf');
    const started = deferred<void>();
    const file = deferred<File>();
    const pending = runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', [
        ...capabilitiesForKinds(built.entries.map((entry) => entry.kind)),
      ]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => {
        started.resolve();
        return file.promise;
      },
    });
    await started.promise;
    document.querySelector('label[for="resume"]')!.textContent = 'Transcript';
    file.resolve(pdf());

    const summary = await pending;
    expect(resume.files).toHaveLength(0);
    expect(summary.identityDrift).toBe(1);
    expect(summary.abortedBy).toBeNull();
    expect(summary.results.find((entry) => entry.key === 'resumeFile')).toMatchObject({
      ok: false,
      reason: 'IDENTITY_CHANGED',
    });
  });

  it('下载等待中字段变成蜜罐时，写前复核放弃这一栏、不挂文件，如实记一次漂移', async () => {
    const { root, resume } = mountFormWithUploads();
    const built = plan('Ada_Lovelace.pdf');
    const started = deferred<void>();
    const file = deferred<File>();
    const pending = runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', [
        ...capabilitiesForKinds(built.entries.map((entry) => entry.kind)),
      ]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => {
        started.resolve();
        return file.promise;
      },
    });
    await started.promise;
    // `data-automation-id` 不在 fieldSignature.core 中；这条必须由
    // post-await live guard 自己重跑，不能偶然借 signature 挡住。
    resume.setAttribute('data-automation-id', 'beecatcher');
    file.resolve(pdf());

    const summary = await pending;
    expect(resume.files).toHaveLength(0);
    expect(summary.identityDrift).toBe(1);
    expect(summary.abortedBy).toBeNull();
    expect(summary.results.find((entry) => entry.key === 'resumeFile')).toMatchObject({
      ok: false,
      reason: 'IDENTITY_CHANGED',
    });
  });

  it('change 后宿主锁死回滚 setter 时，runner 不丢掉自身文件的 Undo', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">Resume/CV</label><input id="resume" type="file" />
      </form>`;
    const root = greenhouseAdapter.resolveRoot(document)!;
    const resume = document.getElementById('resume') as HTMLInputElement;
    stubVisibleNativeFileInput(resume);
    const built = plan('Ada_Lovelace.pdf');
    const journal = createUndoJournal();
    let retained: FileList | null = null;
    resume.addEventListener(
      'change',
      () => {
        retained = resume.files;
        resume.setAttribute('data-automation-id', 'beecatcher');
        Object.defineProperty(resume, 'files', {
          configurable: true,
          get: () => retained,
          set: () => {
            throw new Error('host locked the FileList after change');
          },
        });
      },
      { once: true },
    );

    const summary = await runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', [
        ...capabilitiesForKinds(built.entries.map((entry) => entry.kind)),
      ]),
      journal,
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => pdf(),
    });

    expect(summary.results.find((entry) => entry.key === 'resumeFile')).toMatchObject({
      ok: false,
      reason: 'IDENTITY_CHANGED',
    });
    expect(resume.files?.[0]?.name).toBe('Ada_Lovelace.pdf');
    expect(journal.size(), '自身文件仍在但 Undo 票据被放弃').toBe(1);
    expect([...journal.requiredUndoCapabilities()]).toEqual(['set-file']);
  });

  it('下载等待中宿主开始提交时，当前文件和后续字段都不再写', async () => {
    const { root, resume } = mountFormWithUploads();
    const built = plan('Ada_Lovelace.pdf');
    const started = deferred<void>();
    const file = deferred<File>();
    const pending = runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', [
        ...capabilitiesForKinds(built.entries.map((entry) => entry.kind)),
      ]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => {
        started.resolve();
        return file.promise;
      },
    });
    await started.promise;
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
    file.resolve(pdf());

    const summary = await pending;
    expect(resume.files).toHaveLength(0);
    expect(summary.abortedBy).toBe('HOST_SUBMITTED');
    expect(summary.results.find((entry) => entry.key === 'resumeFile')).toMatchObject({
      ok: false,
      reason: 'HOST_SUBMITTED',
    });
  });

  it('set-file kill switch closes before invoking the L1 resolver', async () => {
    const { root, resume } = mountFormWithUploads();
    const built = plan('Ada_Lovelace.pdf');
    const resolver = vi.fn(async () => pdf());
    const policy = testApplyPolicy();
    const summary = await runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', [
        ...capabilitiesForKinds(built.entries.map((entry) => entry.kind)),
      ]),
      journal: createUndoJournal(),
      root,
      policy: {
        ...policy,
        capabilities: { ...policy.capabilities, 'set-file': false },
      },
      resolveResumeFile: resolver,
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(resume.files).toHaveLength(0);
    expect(summary.results.find((entry) => entry.key === 'resumeFile')).toMatchObject({
      ok: false,
      reason: 'CAPABILITY_DISABLED',
    });
  });

  /** 取不到文件（未登录 / 没简历 / 下载失败）时整轮继续，只有这一项报缺资料。 */
  it('取件函数返回 null 时不中断整轮', async () => {
    const { root } = mountFormWithUploads();
    const built = plan('Ada_Lovelace.pdf');
    const summary = await runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', [
        ...capabilitiesForKinds(built.entries.map((entry) => entry.kind)),
      ]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => null,
    });

    const fileResult = summary.results.find((entry) => entry.key === 'resumeFile');
    expect(fileResult?.ok).toBe(false);
    expect(fileResult?.ok === false ? fileResult.reason : null).toBe('NO_VALUE');
    // 其余字段照常填。
    expect(summary.results.find((entry) => entry.key === 'email')?.ok).toBe(true);
  });
});
