import { afterEach, describe, expect, it, vi } from 'vitest';

import { isCoverLetterField, isCoverLetterFileField } from '../src/dict/guards';
import { buildApplyPlan } from '../src/engine';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';
import {
  hasApprovedCoverLetterFileIdentity,
  hasApprovedResumeFileIdentity,
} from '../src/write/setFile';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * 求职信（2026-09-27 负责人：申请表上有求职信栏——必填、可选都算——就附上为这个岗位写的那一封；只给岗位库里的岗位写）。
 *
 * 内核这一侧两件事：
 * 1. 认得出更多写法的求职信栏。从前是锚定全等，「Cover letter (optional)」、Jobvite 的占位符「Type or paste your Cover
 *    Letter here」、Lever「Additional information」栏的「Add a cover letter or anything else you want to share.」都认不出。
 * 2. 求职信上传栏挂一份求职信 PDF。它与简历各走各的身份判据：求职信栏永远收不到简历，简历栏永远收不到求职信；
 *    一个文件栏同时要简历与求职信（「Resume or cover letter」）两样都不给，交还本人。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('认得出求职信文字框', () => {
  it.each([
    'Cover Letter',
    'Cover letter*',
    'Cover Letter (Optional)',
    'cover letter (optional)',
    'Covering letter',
    'Motivation letter',
    'Motivational Letter',
    'Letter of motivation',
    'Cover letter / Motivation letter',
    'Type or paste your Cover Letter here',
    'Paste your cover letter here',
    'Add a cover letter or anything else you want to share.',
    'Enter cover letter',
    '求职信',
  ])('%s', (label) => {
    expect(isCoverLetterField(label)).toBe(true);
  });

  it.each([
    'Why do you want to work here?',
    'Do you have a cover letter?',
    'Cover letter tips',
    'Resume/Cover letter',
    'Additional information',
    'Tell us about yourself',
    'What would you include in a cover letter for this role?',
    'Please describe your motivation for this role',
  ])('不是求职信栏：%s', (label) => {
    expect(isCoverLetterField(label)).toBe(false);
  });

  it('Lever 的「Additional information」靠占位符认出', () => {
    expect(isCoverLetterField('Additional information', ['comments', 'Add a cover letter or anything else you want to share.'])).toBe(true);
  });
});

describe('认得出求职信上传栏', () => {
  it.each([
    ['Cover Letter', []],
    ['Cover letter (optional)', []],
    ['Upload cover letter', []],
    ['Attach', ['cover_letter']],
    ['Attach', ['coverLetter']],
    ['Drop file here', ['input-cover-letter']],
    ['Motivation letter', []],
  ] as const)('%s %j', (label, identities) => {
    expect(isCoverLetterFileField(label, identities)).toBe(true);
  });

  it.each([
    ['Resume', []],
    ['Resume/CV', []],
    ['Resume or cover letter (one file)', []],
    ['Attach', ['resume']],
    ['Cover letter', ['resume']],
    ['Transcript', []],
    ['Portfolio or cover letter', []],
    ['Autofill from resume', []],
    ['Other attachments', []],
  ] as const)('不是：%s %j', (label, identities) => {
    expect(isCoverLetterFileField(label, identities)).toBe(false);
  });
});

function stubVisible(input: HTMLInputElement): void {
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
    width: 230, height: 40, top: 300, left: 0, right: 230, bottom: 340, x: 0, y: 300, toJSON: () => ({}),
  } as DOMRect);
}

/** Greenhouse 的真实形状：简历与求职信两个上传栏，外加邮箱。 */
function mountGreenhouseUploads(): { resume: HTMLInputElement; coverLetter: HTMLInputElement } {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="email">Email</label><input id="email" type="email" />
      <label for="resume">Resume/CV</label>
      <input id="resume" type="file" accept=".pdf,.doc,.docx" />
      <label for="cover_letter">Cover Letter</label>
      <input id="cover_letter" type="file" accept=".pdf,.doc,.docx" />
    </form>`;
  const resume = document.getElementById('resume') as HTMLInputElement;
  const coverLetter = document.getElementById('cover_letter') as HTMLInputElement;
  stubVisible(resume);
  stubVisible(coverLetter);
  return { resume, coverLetter };
}

const pdf = (name: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' });

function plan(options: { coverLetterFileName?: string; coverLetterTargetVerified?: boolean } = {}) {
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单，断言等于空转').not.toBeNull();
  return {
    root: root!,
    built: buildApplyPlan(
      { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
      { email: 'ada@example.test' },
      { resumeFileName: 'Ada_Lovelace.pdf', resumeHostConfirmed: true, ...options },
    ),
  };
}

describe('求职信上传栏的身份与简历互斥', () => {
  it('求职信栏认成求职信、不认成简历；简历栏反之', () => {
    const { resume, coverLetter } = mountGreenhouseUploads();
    const root = createScanRoot(document.querySelector('form')!, []);
    expect(hasApprovedCoverLetterFileIdentity(coverLetter, root)).toBe(true);
    expect(hasApprovedResumeFileIdentity(coverLetter, root)).toBe(false);
    expect(hasApprovedCoverLetterFileIdentity(resume, root)).toBe(false);
    expect(hasApprovedResumeFileIdentity(resume, root)).toBe(true);
  });
});

describe('计划：求职信上传栏', () => {
  it('有求职信、且这一页核过：简历与求职信各一条文件条目', () => {
    mountGreenhouseUploads();
    const { built } = plan({ coverLetterFileName: 'Cover Letter.pdf', coverLetterTargetVerified: true });
    const files = built.entries.filter((entry) => entry.kind === 'file').map((entry) => [entry.key, entry.label]);
    expect(files).toEqual([['resumeFile', 'Resume/CV'], ['coverLetter', 'Cover Letter']]);
  });

  it('还没有求职信：这一栏记成求职信（键 coverLetter），交给调用方说为什么', () => {
    mountGreenhouseUploads();
    const { built } = plan();
    const skipped = built.skipped.find((item) => item.label === 'Cover Letter');
    expect(skipped?.key).toBe('coverLetter');
    expect(skipped?.reason).toBe('UNSUPPORTED_CONTROL');
    expect(built.entries.some((entry) => entry.key === 'coverLetter')).toBe(false);
  });

  it('这一页没核过：HOST_UNCONFIRMED，不进计划', () => {
    mountGreenhouseUploads();
    const { built } = plan({ coverLetterFileName: 'Cover Letter.pdf' });
    expect(built.skipped.find((item) => item.label === 'Cover Letter')?.reason).toBe('HOST_UNCONFIRMED');
  });

  it('用户已经挂了文件：NOT_EMPTY', () => {
    const { coverLetter } = mountGreenhouseUploads();
    const existing = new DataTransfer();
    existing.items.add(new File(['x'], 'mine.pdf', { type: 'application/pdf' }));
    coverLetter.files = existing.files;
    const { built } = plan({ coverLetterFileName: 'Cover Letter.pdf', coverLetterTargetVerified: true });
    expect(built.skipped.find((item) => item.label === 'Cover Letter')?.reason).toBe('NOT_EMPTY');
  });
});

describe('写入：求职信 PDF 挂到求职信栏', () => {
  it('简历进简历栏、求职信进求职信栏，各取各的文件', async () => {
    const { resume, coverLetter } = mountGreenhouseUploads();
    const { built, root } = plan({ coverLetterFileName: 'Cover Letter.pdf', coverLetterTargetVerified: true });
    const resolveResumeFile = vi.fn(async () => pdf('Ada_Lovelace.pdf'));
    const resolveCoverLetterFile = vi.fn(async () => pdf('Cover Letter.pdf'));
    const summary = await runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', ['set-text', 'set-file']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile,
      resolveCoverLetterFile,
    });
    const byKey = Object.fromEntries(summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason]));
    expect(byKey).toMatchObject({ resumeFile: 'ok', coverLetter: 'ok' });
    expect(resume.files?.[0]?.name).toBe('Ada_Lovelace.pdf');
    expect(coverLetter.files?.[0]?.name).toBe('Cover Letter.pdf');
    expect(resolveResumeFile).toHaveBeenCalledTimes(1);
    expect(resolveCoverLetterFile).toHaveBeenCalledTimes(1);
  });

  it('取不到求职信：这一栏 NO_VALUE，简历照挂', async () => {
    const { resume, coverLetter } = mountGreenhouseUploads();
    const { built, root } = plan({ coverLetterFileName: 'Cover Letter.pdf', coverLetterTargetVerified: true });
    const summary = await runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', ['set-text', 'set-file']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => pdf('Ada_Lovelace.pdf'),
      resolveCoverLetterFile: async () => null,
    });
    const byKey = Object.fromEntries(summary.results.map((result) => [result.key, result.ok ? 'ok' : result.reason]));
    expect(byKey).toMatchObject({ resumeFile: 'ok', coverLetter: 'NO_VALUE' });
    expect(resume.files?.length).toBe(1);
    expect(coverLetter.files?.length).toBe(0);
  });

  it('没接求职信取件函数：NO_VALUE，绝不拿简历顶上', async () => {
    const { coverLetter } = mountGreenhouseUploads();
    const { built, root } = plan({ coverLetterFileName: 'Cover Letter.pdf', coverLetterTargetVerified: true });
    const summary = await runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', ['set-text', 'set-file']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => pdf('Ada_Lovelace.pdf'),
    });
    expect(summary.results.find((result) => result.key === 'coverLetter')).toMatchObject({ ok: false, reason: 'NO_VALUE' });
    expect(coverLetter.files?.length).toBe(0);
  });

  it('等字节的时候这一栏改成了简历栏：IDENTITY_CHANGED，不挂', async () => {
    const { coverLetter } = mountGreenhouseUploads();
    const { built, root } = plan({ coverLetterFileName: 'Cover Letter.pdf', coverLetterTargetVerified: true });
    const summary = await runApplyPlan({
      plan: built,
      auth: testAuthority(built.fingerprint, 'fill', ['set-text', 'set-file']),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => pdf('Ada_Lovelace.pdf'),
      resolveCoverLetterFile: async () => {
        document.querySelector('label[for="cover_letter"]')!.textContent = 'Resume';
        return pdf('Cover Letter.pdf');
      },
    });
    expect(summary.results.find((result) => result.key === 'coverLetter')).toMatchObject({ ok: false, reason: 'IDENTITY_CHANGED' });
    expect(coverLetter.files?.length).toBe(0);
  });
});

describe('表上有哪些求职信栏（调用方据此去要一封）', () => {
  it('上传栏与文字框都算，必填、可选都算；简历栏不算', async () => {
    const { coverLetterTargets } = await import('../src/engine');
    document.body.innerHTML = `
      <form id="application-form">
        <label for="resume">Resume/CV</label><input id="resume" type="file" />
        <label for="cover_letter">Cover Letter</label><input id="cover_letter" type="file" required />
        <label for="cl_text">Cover letter (optional)</label><textarea id="cl_text"></textarea>
        <label for="why">Why do you want to work here?</label><textarea id="why"></textarea>
      </form>`;
    const root = greenhouseAdapter.resolveRoot(document)!;
    const targets = coverLetterTargets({ vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] } as never);
    expect(targets.map((target) => [(target.element as HTMLElement).id, target.kind, target.required])).toEqual([
      ['cover_letter', 'file', true],
      ['cl_text', 'text', false],
    ]);
  });
});
