import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApplyPlan } from '../src/engine';
import { runApplyPlan } from '../src/runner';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * Greenhouse job-boards（2026-09-10 实测）：简历控件是 1×1、clip 掉的
 * `input#resume[type=file].visually-hidden`，旁边一个可见的 "Attach" 按钮；
 * 收到文件后宿主在 change 处理器里同步卸掉这个 input，换成文件名展示。
 * 几何蜜罐防线不该把这种标准写法当陷阱；文件目标的可见性由文件写入器的
 * 触发器检查负责；文件条目排在计划最后，卸掉它不影响其它字段的身份。
 */
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountGreenhouseWithHiddenResumeInput(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First name*</label>
      <input id="first_name" type="text" required />
      <label for="email">Email*</label>
      <input id="email" type="email" required />
      <div class="field">
        <label for="resume" class="visually-hidden">Resume</label>
        <div>
          <input id="resume" type="file" accept=".pdf,.doc,.docx" class="visually-hidden" />
          <button type="button">Attach</button>
        </div>
      </div>
      <label for="linkedin">LinkedIn Profile</label>
      <input id="linkedin" type="text" />
    </form>`;
}

const profile = { firstName: 'Avery', email: 'avery@example.test', linkedinUrl: 'https://www.linkedin.com/in/avery' };

const geometryOf = (element: Element) =>
  element instanceof HTMLInputElement && element.type === 'file'
    ? { width: 1, height: 1, left: 40, right: 41, clip: 'rect(0px, 0px, 0px, 0px)' }
    : { width: 240, height: 36, left: 40, right: 280 };

function planGreenhouse(readGeometry = geometryOf) {
  const root = greenhouseAdapter.resolveRoot(document)!;
  const plan = buildApplyPlan(
    { vendor: 'greenhouse', root, fields: [...greenhouseAdapter.scan(root)] },
    profile,
    { readGeometry, resumeFileName: 'resume.pdf', resumeHostConfirmed: true },
  );
  return { root, plan };
}

describe('visually hidden native file input behind a visible trigger', () => {
  it('is planned as the resume target, after every other field', () => {
    mountGreenhouseWithHiddenResumeInput();
    const { plan } = planGreenhouse();
    expect(plan.entries.map((entry) => entry.key)).toEqual(['firstName', 'email', 'linkedinUrl', 'resumeFile']);
    expect(plan.skipped.filter((item) => item.reason === 'HONEYPOT')).toEqual([]);
  });

  it('still treats a 1×1 text input as a honeypot', () => {
    mountGreenhouseWithHiddenResumeInput();
    const { plan } = planGreenhouse((element) => (element.id === 'first_name'
      ? { width: 1, height: 1, left: 40, right: 41 }
      : geometryOf(element)));
    expect(plan.skipped.find((item) => item.key === 'firstName')?.reason).toBe('HONEYPOT');
  });

  it('fills the resume and keeps every other field when the host swaps the input on change', async () => {
    mountGreenhouseWithHiddenResumeInput();
    const resume = document.getElementById('resume') as HTMLInputElement;
    const attach = resume.nextElementSibling as HTMLButtonElement;
    vi.spyOn(attach, 'getBoundingClientRect').mockReturnValue(
      { width: 96, height: 36, top: 0, left: 0, right: 96, bottom: 36, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    resume.addEventListener('change', () => {
      resume.parentElement!.replaceChildren(Object.assign(document.createElement('span'), { textContent: 'resume.pdf' }));
    }, { once: true });

    const { root, plan } = planGreenhouse();
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      resolveResumeFile: async () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'resume.pdf', { type: 'application/pdf' }),
    });

    expect(summary.results.map((result) => [result.key, result.ok])).toEqual([
      ['firstName', true], ['email', true], ['linkedinUrl', true], ['resumeFile', true],
    ]);
    expect(resume.isConnected).toBe(false);
  });
});
