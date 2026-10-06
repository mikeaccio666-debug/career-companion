import greenhouseRules from '@edaix/apply-rules/greenhouse.json';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { readApplyForm } from '../src/registry';
import { compileRuleAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { installBundledApplyAdapters } from '../src/bundledAdapters';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';
import type { ApplyFormDescriptor, ApplyPlan } from '../src/contracts';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();

/**
 * 写前身份漂移**不连坐**（2026-09-23）。
 *
 * 从前 runner 在一栏的结构身份（`fieldSignature.core`：标签名 | 类型 | name 形状 | 作用域 | 序号）
 * 写前对不上时，把它后面的每一栏都记成 ABORTED、整轮停手。Greenhouse 的 EEO 是动态的：答完
 * 「是否拉美裔」才插进种族那一题，Veteran 那一格序号一挪，排在计划最后的简历就被连带作废——
 * 64 页测试台批测里 Greenhouse 的简历 0/4，种族、退伍两题也一起没填。
 *
 * 现在只放弃那一栏，并在 `identityDrift` 里如实记数（调用方据此重扫补填）。本文件锁四件事：
 *  1. 中途一栏漂了，后面不相干的栏照常写、照常回读确认；
 *  2. 漂移之后，后面的栏除了结构身份，**题面文字**也要与计划时相同才写——
 *     换了题的格子一个字都不写，没换的照常写（简历在等字节时换了题面也算）；
 *  3. 求职信题面、富文本规则证明这两道写前闸也只放弃那一格；
 *  4. Greenhouse 形状的整页：答「是否拉美裔」插进种族题之后，后面每一栏都被走到、各自如实
 *     结算——序号挪了的题一个字不写，简历照常挂上；重扫之后同一份资料能把那几栏与新出现的题补齐。
 *
 * 夹具全部是合成文字，不含任何真实用户数据。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const resumeFile = () => new File([PDF_BYTES], 'Sample-Resume.pdf', { type: 'application/pdf' });

/** Greenhouse job-boards 的上传栏形状：原生 file input 藏在一个可见的 Attach 按钮后面。 */
const RESUME_FIELD = `
  <div class="field">
    <label id="resume-label" for="resume">Resume/CV</label>
    <div>
      <input id="resume" type="file" accept=".pdf,.doc,.docx" />
      <button type="button" class="attach">Attach</button>
    </div>
  </div>`;

/** happy-dom 没有布局：只给 Attach 按钮一个真实的盒子，写入器才认得出可见的触发器。 */
function showAttachButton(): void {
  const attach = document.querySelector<HTMLButtonElement>('button.attach')!;
  vi.spyOn(attach, 'getBoundingClientRect').mockReturnValue({
    width: 96, height: 36, top: 300, left: 40, right: 136, bottom: 336, x: 40, y: 300, toJSON: () => ({}),
  } as DOMRect);
}

function scan(): ApplyFormDescriptor {
  const form = readApplyForm('greenhouse');
  if (!form) throw new Error('Greenhouse fixture unexpectedly failed to scan');
  return form;
}

function run(plan: ApplyPlan, form: ApplyFormDescriptor, extra: Partial<Parameters<typeof runApplyPlan>[0]> = {}) {
  return runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
    journal: createUndoJournal(),
    root: form.root,
    policy: testApplyPolicy(),
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 5,
    ...extra,
  });
}

const byKey = (results: readonly { key: string; ok: boolean; reason?: string }[]) =>
  Object.fromEntries(results.map((result) => [result.key, result.ok ? 'ok' : result.reason]));

const inputValue = (id: string) => document.getElementById(id) as HTMLInputElement;

function contactForm(extra = ''): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First Name</label>
      <input id="first_name" name="job_application[first_name]" type="text" />
      <label for="last_name">Last Name</label>
      <input id="last_name" name="job_application[last_name]" type="text" />
      <label id="email-label" for="email">Email</label>
      <input id="email" name="job_application[email]" type="email" />
      <label id="phone-label" for="phone">Phone</label>
      <input id="phone" name="job_application[phone]" type="tel" />
      ${extra}
    </form>`;
}

const CONTACT = {
  firstName: 'Sample',
  lastName: 'Person',
  email: 'sample.person@example.test',
  phone: '+1 415 555 0100',
};

/** 宿主在第一栏的 input 里同步改掉 Last Name 的 name：Last Name 的结构身份变了。 */
function driftLastNameOnFirstInput(): void {
  inputValue('first_name').addEventListener('input', () => {
    inputValue('last_name').setAttribute('name', 'job_application[answers_attributes][0][text_value]');
  }, { once: true });
}

function recordEvents(id: string): string[] {
  const events: string[] = [];
  for (const type of ['input', 'change', 'click']) {
    document.getElementById(id)!.addEventListener(type, () => events.push(type));
  }
  return events;
}

describe('写前身份漂移不连坐', () => {
  it('中途一栏身份漂了：只放弃那一栏，后面不相干的栏（含排在最后的简历）照常写、照常回读确认', async () => {
    contactForm(RESUME_FIELD);
    showAttachButton();
    const form = scan();
    const plan = buildApplyPlan(form, CONTACT, { resumeFileName: 'Sample-Resume.pdf', resumeHostConfirmed: true });
    expect(plan.entries.map((entry) => entry.key)).toEqual(['firstName', 'lastName', 'email', 'phone', 'resumeFile']);
    driftLastNameOnFirstInput();
    const lastNameEvents = recordEvents('last_name');
    const resolve = vi.fn(async () => resumeFile());

    const summary = await run(plan, form, { resolveResumeFile: resolve });

    expect(summary.results.map((result) => (result.ok ? `ok${result.unverified ? '/unverified' : ''}` : result.reason))).toEqual([
      'ok',
      'IDENTITY_CHANGED',
      'ok',
      'ok',
      'ok',
    ]);
    expect(summary.abortedBy).toBeNull();
    expect(summary.identityDrift).toBe(1);
    expect(summary.filled).toBe(4);
    // 身份变了的那一栏：零写入、零宿主事件。
    expect(inputValue('last_name').value).toBe('');
    expect(lastNameEvents).toEqual([]);
    // 后面的栏真的写进去了，而且回读确认过：整轮之后的复核仍然认它们。
    expect(inputValue('email').value).toBe('sample.person@example.test');
    expect(inputValue('phone').value).not.toBe('');
    expect(inputValue('resume').files?.[0]?.name).toBe('Sample-Resume.pdf');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(byKey(summary.recheck())).toMatchObject({ firstName: 'ok', email: 'ok', phone: 'ok', resumeFile: 'ok' });
  });
});

describe('漂移之后，题面文字也得与计划时相同才写', () => {
  it('漂移之后题面变了的栏不写（IDENTITY_CHANGED），题面没变的照常写', async () => {
    contactForm();
    const form = scan();
    const plan = buildApplyPlan(form, CONTACT);
    inputValue('first_name').addEventListener('input', () => {
      inputValue('last_name').setAttribute('name', 'job_application[answers_attributes][0][text_value]');
      // 同一次重渲染把 Email 那一格换成了另一道题：结构（标签名 / 类型 / name / 序号）一点没变。
      document.getElementById('email-label')!.textContent = 'Emergency contact email';
    }, { once: true });
    const emailEvents = recordEvents('email');

    const summary = await run(plan, form);

    expect(byKey(summary.results)).toEqual({
      firstName: 'ok',
      lastName: 'IDENTITY_CHANGED',
      email: 'IDENTITY_CHANGED',
      phone: 'ok',
    });
    expect(summary.identityDrift).toBe(2);
    expect(summary.abortedBy).toBeNull();
    expect(inputValue('email').value).toBe('');
    expect(emailEvents).toEqual([]);
    expect(inputValue('phone').value).not.toBe('');
  });

  it('对照：没有漂移时，题面文字的变化仍只是诊断计数，不挡写入', async () => {
    contactForm();
    const form = scan();
    const plan = buildApplyPlan(form, CONTACT);
    inputValue('first_name').addEventListener('input', () => {
      document.getElementById('email-label')!.textContent = 'Email This field is required';
    }, { once: true });

    const summary = await run(plan, form);

    expect(byKey(summary.results)).toEqual({ firstName: 'ok', lastName: 'ok', email: 'ok', phone: 'ok' });
    expect(summary.identityDrift).toBe(0);
    expect(summary.labelHintDrifted).toBe(1);
    expect(inputValue('email').value).toBe('sample.person@example.test');
  });

  it('简历在等字节时题面变了：这一轮漂移过就不挂；没漂移过照常挂', async () => {
    const attempt = async (withDrift: boolean) => {
      contactForm(RESUME_FIELD);
      showAttachButton();
      const form = scan();
      const plan = buildApplyPlan(form, CONTACT, { resumeFileName: 'Sample-Resume.pdf', resumeHostConfirmed: true });
      if (withDrift) driftLastNameOnFirstInput();
      const summary = await run(plan, form, {
        resolveResumeFile: async () => {
          // 宿主在这段等待里重渲染了上传栏的题面：仍是简历栏，只是文字变了。
          document.getElementById('resume-label')!.textContent = 'Resume/CV (PDF preferred)';
          return resumeFile();
        },
      });
      return { summary, files: inputValue('resume').files?.length ?? 0 };
    };

    const drifted = await attempt(true);
    expect(byKey(drifted.summary.results)).toMatchObject({ lastName: 'IDENTITY_CHANGED', resumeFile: 'IDENTITY_CHANGED' });
    expect(drifted.summary.identityDrift).toBe(2);
    expect(drifted.files).toBe(0);

    const steady = await attempt(false);
    expect(byKey(steady.summary.results)).toMatchObject({ lastName: 'ok', resumeFile: 'ok' });
    expect(steady.summary.identityDrift).toBe(0);
    expect(steady.files).toBe(1);
  });
});

/**
 * 其余几道写前身份闸从前也各自把后面整轮连坐成 ABORTED（求职信题面变了、富文本的规则证明不再成立）。
 * 它们护的都是**那一格**：只放弃那一格、记进 identityDrift，后面的栏各自写前重验。
 */
describe('其余写前身份闸同样只放弃那一栏', () => {
  it('求职信的题面变了：求职信一个字不写，后面的栏照常写', async () => {
    contactForm();
    document.querySelector('form')!.insertAdjacentHTML('afterbegin', `
      <label id="cover-label" for="cover_letter">Cover letter</label>
      <textarea id="cover_letter" name="cover_letter"></textarea>`);
    const form = scan();
    const plan = buildApplyPlan(form, CONTACT, {
      coverLetterText: 'A short synthetic cover letter.',
      coverLetterTargetVerified: true,
    });
    expect(plan.entries[0]?.key).toBe('coverLetter');
    // 审阅之后、写入之前，这一格换成了别的题（结构一点没变）。
    document.getElementById('cover-label')!.textContent = 'Anything else we should know?';
    const coverEvents = recordEvents('cover_letter');

    const summary = await run(plan, form);

    expect(byKey(summary.results)).toEqual({
      coverLetter: 'IDENTITY_CHANGED',
      firstName: 'ok',
      lastName: 'ok',
      email: 'ok',
      phone: 'ok',
    });
    expect(summary.identityDrift).toBe(1);
    expect(summary.abortedBy).toBeNull();
    expect((document.getElementById('cover_letter') as HTMLTextAreaElement).value).toBe('');
    expect(coverEvents).toEqual([]);
  });

  it('富文本的规则证明不再成立：那一格一个字不写，后面的栏照常写', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label id="cl">Cover letter</label>
        <div id="cover_letter" contenteditable="true" role="textbox" aria-labelledby="cl"></div>
        <label for="email">Email</label>
        <input id="email" name="job_application[email]" type="email" />
      </form>`;
    const rules = structuredClone(greenhouseRules) as Record<string, unknown>;
    (rules['keySteps'] as unknown[]).unshift({
      type: 'attrMap',
      attr: 'id',
      confidence: 1,
      map: { cover_letter: 'coverLetterPlainTextContenteditable' },
    });
    const parsed = parseVendorRuleset(rules);
    if (!parsed.ok) throw new Error(parsed.code);
    const adapter = compileRuleAdapter(parsed.value);
    const root = adapter.resolveRoot(document)!;
    const form = { vendor: 'greenhouse' as const, root, fields: [...adapter.scan(root)] };
    const plan = buildApplyPlan(form, { email: CONTACT.email }, {
      coverLetterText: 'A short synthetic cover letter.',
      coverLetterTargetVerified: true,
    });
    expect(plan.entries.map((entry) => [entry.key, entry.kind])).toEqual([['coverLetter', 'richtext'], ['email', 'text']]);
    const editor = document.getElementById('cover_letter')!;
    // 宿主给编辑器换了 id：结构身份（标签名 / 类型 / name / 序号）与题面都照旧，但规则认的那个
    // 精确目标（attrMap 的 id）已经不是它了——规则证明不再成立。
    editor.id = 'cover_letter_draft';
    const policy = testApplyPolicy();

    const summary = await run(plan, form as ApplyFormDescriptor, {
      policy: { ...policy, capabilities: { ...policy.capabilities, 'set-richtext': true } },
    });

    expect(byKey(summary.results)).toEqual({ coverLetter: 'IDENTITY_CHANGED', email: 'ok' });
    expect(summary.identityDrift).toBe(1);
    expect(summary.abortedBy).toBeNull();
    expect(editor.textContent).toBe('');
    expect(inputValue('email').value).toBe('sample.person@example.test');
  });
});

/**
 * Greenhouse 形状的 EEO（合成夹具）：答「Are you Hispanic/Latino?」选 No 之后，宿主在它下面插进
 * 「Please identify your race」，于是 Veteran / Disability 的序号都挪了。
 */
describe('Greenhouse 形状：答完是否拉美裔才插进种族题', () => {
  const radios = (name: string, legend: string, options: readonly string[]) => `
    <fieldset id="${name}-question">
      <legend>${legend}</legend>
      ${options.map((text, index) => `<label><input name="${name}" type="radio" value="${index}" /> ${text}</label>`).join('')}
    </fieldset>`;
  const RACE = radios('race', 'Please identify your race', [
    'American Indian or Alaska Native',
    'Asian',
    'Black or African American',
    'White',
    'Decline to self identify',
  ]);

  function mountGreenhouseEeo(): void {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name</label>
        <input id="first_name" name="job_application[first_name]" type="text" />
        <label for="email">Email</label>
        <input id="email" name="job_application[email]" type="email" />
        ${RESUME_FIELD}
        ${radios('gender', 'Gender', ['Male', 'Female', 'Decline to self identify'])}
        ${radios('hispanic', 'Are you Hispanic/Latino?', ['Yes', 'No', 'Decline to self identify'])}
        ${radios('veteran', 'Veteran Status', [
          'I identify as one or more of the classifications of a protected veteran',
          'I am not a protected veteran',
          "I don't wish to answer",
        ])}
        ${radios('disability', 'Disability Status', [
          'Yes, I have a disability, or have had one in the past',
          'No, I do not have a disability and have not had one in the past',
          'I do not want to answer',
        ])}
      </form>`;
    showAttachButton();
    // 宿主的行为：答「No」之后在这一题下面插进种族题（只插一次）。
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="hispanic"]')) {
      radio.addEventListener('change', () => {
        if (radio.value !== '1' || document.getElementById('race-question')) return;
        document.getElementById('hispanic-question')!.insertAdjacentHTML('afterend', RACE);
      });
    }
  }

  const PROFILE = {
    firstName: 'Sample',
    email: 'sample.person@example.test',
    eeoGender: 'FEMALE',
    eeoRace: 'ASIAN',
    eeoVeteran: 'NOT_PROTECTED_VETERAN',
    eeoDisability: 'NO',
  } as never;
  const OPTIONS = {
    capabilities: { 'set-self-identification': true },
    hispanicLatino: 'NO',
    resumeFileName: 'Sample-Resume.pdf',
    resumeHostConfirmed: true,
  } as never;
  const checked = (name: string) =>
    document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.parentElement?.textContent?.trim() ?? null;

  it('后面每一栏都被走到、各自如实结算：序号挪了的两题一个字都不写，排在最后的简历照常挂上', async () => {
    mountGreenhouseEeo();
    const form = scan();
    const plan = buildApplyPlan(form, PROFILE, OPTIONS);
    expect(plan.entries.map((entry) => entry.key)).toEqual([
      'firstName', 'email', 'eeoGender', 'eeoRace', 'eeoVeteran', 'eeoDisability', 'resumeFile',
    ]);
    const shiftedEvents: string[] = [];
    for (const radio of document.querySelectorAll('input[name="veteran"], input[name="disability"]')) {
      for (const type of ['input', 'change', 'click']) radio.addEventListener(type, () => shiftedEvents.push(type));
    }
    const resolve = vi.fn(async () => resumeFile());

    const summary = await run(plan, form, { resolveResumeFile: resolve });

    expect(document.getElementById('race-question'), '前置条件：答完这一题宿主真的插进了种族题').not.toBeNull();
    expect(byKey(summary.results)).toEqual({
      firstName: 'ok',
      email: 'ok',
      eeoGender: 'ok',
      eeoRace: 'ok',
      // 序号挪了一位（种族题插在它们前面）：身份对不上，一个字都不写——这正是要守住的那条。
      eeoVeteran: 'IDENTITY_CHANGED',
      eeoDisability: 'IDENTITY_CHANGED',
      // 从前在这里被连坐成 ABORTED：批测 Greenhouse 简历 0/4 的根因。
      resumeFile: 'ok',
    });
    expect(summary.results.some((result) => !result.ok && result.reason === 'ABORTED')).toBe(false);
    expect(summary.abortedBy).toBeNull();
    expect(summary.identityDrift).toBe(2);
    expect(checked('gender')).toBe('Female');
    expect(checked('hispanic')).toBe('No');
    expect(checked('veteran')).toBeNull();
    expect(checked('disability')).toBeNull();
    expect(shiftedEvents).toEqual([]);
    expect(inputValue('resume').files?.[0]?.name).toBe('Sample-Resume.pdf');
    expect(resolve).toHaveBeenCalledTimes(1);

    // 调用方据 identityDrift 重扫：同一份资料在新的一代 DOM 上只剩这三题要填，而且都填得上。
    const rescanned = scan();
    const second = buildApplyPlan(rescanned, PROFILE, OPTIONS);
    expect(second.entries.map((entry) => entry.key)).toEqual(['eeoRace', 'eeoVeteran', 'eeoDisability']);
    expect(second.entries[0]!.element.closest('fieldset')?.id).toBe('race-question');
    const secondSummary = await run(second, rescanned);
    expect(byKey(secondSummary.results)).toEqual({ eeoRace: 'ok', eeoVeteran: 'ok', eeoDisability: 'ok' });
    expect(secondSummary.identityDrift).toBe(0);
    expect(checked('race')).toBe('Asian');
    expect(checked('veteran')).toBe('I am not a protected veteran');
    expect(checked('disability')).toBe('No, I do not have a disability and have not had one in the past');
  });
});
