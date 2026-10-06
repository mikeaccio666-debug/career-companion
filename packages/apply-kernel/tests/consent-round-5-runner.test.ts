/**
 * 代填第五刀（2026-09-28）——写入期，真扫描 → 计划 → runner。
 *
 * 每一格写之前按类别再核一次（`signOnBehalfCurrent(kind)`）：同意过的那一版文案仍点名这一类吗；能不能联系雇主，
 * 资料里的回答仍是这一向吗。不成立就如实报 CAPABILITY_DISABLED，什么都不点、也不回落到属性写入。
 * 核实所填信息的勾选框经过真实的点击边界（点击策略按整句读验证码一类）。能不能联系雇主按方向点：
 * 「不可以」点 No（原生单选、Greenhouse 下拉、Ashby 是非按钮都是）。题面全是合成的。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplyFormDescriptor, ScanRootOptions } from '../src/contracts';
import {
  employerContactKinds,
  SIGNING_CONSENT_KINDS,
  type EmployerContactAnswer,
  type SignOnBehalfKind,
} from '../src/dict/signOnBehalf';
import { buildApplyPlan } from '../src/engine';
import { fieldSignature } from '../src/fieldIdentity';
import { mintAuthority, type HostWriteAuthority } from '../src/grant';
import { createBundledApplyPolicy } from '../src/policy';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testAuthority } from './helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function policy() {
  const base = createBundledApplyPolicy(Date.now());
  return {
    ...base,
    capabilities: { ...base.capabilities, 'set-text': true, 'set-select': true, 'set-combobox': true, 'sign-on-behalf': true },
  };
}

const kindsFor = (employerContact?: EmployerContactAnswer) =>
  new Set<SignOnBehalfKind>([...SIGNING_CONSENT_KINDS, ...employerContactKinds(employerContact)]);

async function run(
  descriptor: ApplyFormDescriptor,
  options: {
    employerContact?: EmployerContactAnswer;
    /** 写入那一刻仍成立的类别；不给就与计划时相同。 */
    current?: ReadonlySet<SignOnBehalfKind>;
    auth?: (fingerprint: string) => HostWriteAuthority;
  } = {},
) {
  const planned = kindsFor(options.employerContact);
  const plan = buildApplyPlan(descriptor, {} as never, {
    fillEmptyOnly: true,
    capabilities: { 'sign-on-behalf': true },
    signOnBehalfKinds: planned,
    ...(options.employerContact === undefined ? {} : { employerContact: options.employerContact }),
  } as never);
  const current = options.current ?? planned;
  const summary = await runApplyPlan({
    plan,
    auth: options.auth?.(plan.fingerprint) ??
      testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
    journal: createUndoJournal(),
    root: descriptor.root,
    policy: policy() as never,
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 5,
    signOnBehalfCurrent: (kind) => current.has(kind),
  });
  return { plan, summary };
}

const outcomes = (summary: Awaited<ReturnType<typeof runApplyPlan>>) =>
  summary.results.map((result) => [result.key, result.ok, result.ok ? null : result.reason]);

// —— 原生控件 ————————————————————————————————————————————————————————————————————

const VERIFY = 'I authorize Acme to verify my education and employment history.';
const EMPLOYER = 'May we contact your current employer?';

function mountNative() {
  document.body.innerHTML = `<form>
    <label for="verify">${VERIFY}</label><input type="checkbox" id="verify" name="verify">
    <fieldset><legend>${EMPLOYER}</legend>
      <label for="y">Yes</label><input type="radio" id="y" name="employer">
      <label for="n">No</label><input type="radio" id="n" name="employer">
    </fieldset>
    <label id="notice-label" for="notice">Applicant Privacy Notice</label>
    <select id="notice" name="notice"><option value=""></option><option value="y">Yes</option></select>
  </form>`;
  const verify = document.getElementById('verify') as HTMLInputElement;
  const yes = document.getElementById('y') as HTMLInputElement;
  const no = document.getElementById('n') as HTMLInputElement;
  const notice = document.getElementById('notice') as HTMLSelectElement;
  const root = createScanRoot(document.querySelector('form')!, [], []);
  const descriptor = {
    vendor: 'greenhouse',
    root,
    fields: [
      {
        kind: 'choice', element: verify, key: null, label: VERIFY, required: true, confidence: 0,
        signature: fieldSignature(verify, root),
        choice: { control: 'checkbox', options: [{ element: verify, label: VERIFY }] },
      },
      {
        kind: 'choice', element: yes, key: null, label: EMPLOYER, required: true, confidence: 0,
        signature: fieldSignature(yes, root),
        choice: { control: 'radio', options: [{ element: yes, label: 'Yes' }, { element: no, label: 'No' }] },
      },
      {
        kind: 'select', element: notice, key: null, label: 'Applicant Privacy Notice', required: true, confidence: 0,
        signature: fieldSignature(notice, root),
      },
    ],
  } as never as ApplyFormDescriptor;
  return { verify, yes, no, notice, descriptor };
}

describe('原生勾选框、单选组与下拉', () => {
  it('同意过 09-28、资料里答「不可以」：核实框勾上、联系雇主选 No、隐私声明选 Yes', async () => {
    const { verify, yes, no, notice, descriptor } = mountNative();
    const { plan, summary } = await run(descriptor, { employerContact: 'NO' });
    expect(plan.entries.map((entry) => [entry.key, entry.signOnBehalf])).toEqual([
      ['informationVerificationConsent', 'INFORMATION_VERIFICATION'],
      ['employerContactDeclined', 'EMPLOYER_CONTACT_NO'],
      ['privacyNoticeAcknowledgement', 'PRIVACY_NOTICE_TITLE'],
    ]);
    expect(outcomes(summary)).toEqual([
      ['informationVerificationConsent', true, null],
      ['employerContactDeclined', true, null],
      ['privacyNoticeAcknowledgement', true, null],
    ]);
    expect([verify.checked, yes.checked, no.checked, notice.value]).toEqual([true, false, true, 'y']);
  });

  it('写入那一刻代填授权不再成立（撤回了）：同意类 CAPABILITY_DISABLED、一格不动；联系雇主照答（它看资料里的回答）', async () => {
    const { verify, no, notice, descriptor } = mountNative();
    const { summary } = await run(descriptor, {
      employerContact: 'NO',
      current: new Set(employerContactKinds('NO')),
    });
    expect(outcomes(summary)).toEqual([
      ['informationVerificationConsent', false, 'CAPABILITY_DISABLED'],
      ['employerContactDeclined', true, null],
      ['privacyNoticeAcknowledgement', false, 'CAPABILITY_DISABLED'],
    ]);
    expect([verify.checked, no.checked, notice.value]).toEqual([false, true, '']);
  });

  it('写入那一刻资料里的回答不再是这一向：联系雇主 CAPABILITY_DISABLED，不点', async () => {
    const { yes, no, descriptor } = mountNative();
    const { summary } = await run(descriptor, { employerContact: 'NO', current: kindsFor('YES') });
    expect(summary.results[1]).toMatchObject({ key: 'employerContactDeclined', ok: false, reason: 'CAPABILITY_DISABLED' });
    expect([yes.checked, no.checked]).toEqual([false, false]);
  });

  it('计划之后核实框的文字被换成验证码 → 题面对不上（IDENTITY_CHANGED），不勾', async () => {
    const { verify, descriptor } = mountNative();
    document.querySelector('label[for="verify"]')!.textContent = 'I agree to verify my email address with a one-time code.';
    const { summary } = await run(descriptor, { employerContact: 'NO' });
    expect(summary.results[0]).toMatchObject({ key: 'informationVerificationConsent', ok: false, reason: 'IDENTITY_CHANGED' });
    expect(verify.checked).toBe(false);
  });
});

// —— Greenhouse react-select ————————————————————————————————————————————————————

function mountGreenhouse(question: string, options: readonly string[]): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="question_1">${question}*</label>
      <div class="select__container">
        <div class="select__control">
          <div class="select__value-container">
            <input id="question_1" type="text" role="combobox" aria-expanded="false"
              aria-autocomplete="list" aria-controls="react-select-question_1-listbox" />
          </div>
        </div>
      </div>
    </form>`;
  const trigger = document.getElementById('question_1') as HTMLInputElement;
  const container = trigger.closest('.select__container')!;
  const valueContainer = trigger.closest('.select__value-container')!;
  trigger.addEventListener('mousedown', () => {
    trigger.setAttribute('aria-expanded', 'true');
    const listbox = document.createElement('div');
    listbox.id = 'react-select-question_1-listbox';
    listbox.setAttribute('role', 'listbox');
    for (const text of options) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = text;
      option.addEventListener('click', () => {
        const chosen = document.createElement('div');
        chosen.className = 'select__single-value';
        chosen.textContent = text;
        valueContainer.prepend(chosen);
        listbox.remove();
        trigger.setAttribute('aria-expanded', 'false');
      });
      listbox.append(option);
    }
    container.append(listbox);
  });
}

function fillAuthority(fingerprint: string): HostWriteAuthority {
  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  shadowRoot.appendChild(button);
  const event = new Event('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  Object.defineProperty(event, 'composedPath', { value: () => [button, shadowRoot, host, document.body, document, window] });
  const minted = mintAuthority({ event, shadowRoot, purpose: 'fill', fingerprint, capabilities: new Set(['set-text', 'set-combobox']) });
  if (!minted.ok) throw new Error(minted.code);
  return minted.value;
}

function scanGreenhouse(): ApplyFormDescriptor {
  const scanRoot = greenhouseAdapter.resolveRoot(document)!;
  return { vendor: 'greenhouse', root: scanRoot, fields: [...greenhouseAdapter.scan(scanRoot)] };
}

const chosen = () => document.querySelector('.select__single-value')?.textContent ?? null;

describe('Greenhouse 下拉：打开菜单后按类别挑', () => {
  it.each([
    ['NO', ['Yes', 'No'], 'No'],
    ['YES', ['Yes', 'No', 'Yes, after an offer is made'], 'Yes'],
  ] as const)('能不能联系现在的雇主：答 %s → 选「%s」里的「%s」', async (answer, options, expected) => {
    mountGreenhouse(EMPLOYER, options);
    const { summary } = await run(scanGreenhouse(), { auth: fillAuthority, employerContact: answer });
    expect(summary.results).toEqual([expect.objectContaining({ ok: true })]);
    expect(chosen()).toBe(expected);
  });

  it('菜单里有两个否定回答 → 不猜，交还本人', async () => {
    mountGreenhouse(EMPLOYER, ['Yes', 'No', 'Not at this time']);
    const { summary } = await run(scanGreenhouse(), { auth: fillAuthority, employerContact: 'NO' });
    expect(summary.results).toEqual([expect.objectContaining({ ok: false, reason: 'MANUAL_ONLY' })]);
    expect(chosen()).toBeNull();
  });

  it('新类别：信用调查的同意问句 → 选 Yes', async () => {
    mountGreenhouse('Do you consent to a credit check as part of our hiring process?', ['Yes', 'No']);
    const { summary } = await run(scanGreenhouse(), { auth: fillAuthority });
    expect(summary.results).toEqual([expect.objectContaining({ key: 'screeningConsent', ok: true })]);
    expect(chosen()).toBe('Yes');
  });
});

// —— Ashby 是非按钮（ARIA 代理） ————————————————————————————————————————————————————

const REQUIRED_CLASS = 'hashed-required';
const SCAN_OPTIONS: ScanRootOptions = {
  readGeneratedContent: (element, pseudo) =>
    pseudo === '::after' && element.classList.contains(REQUIRED_CLASS) ? '"*"' : 'none',
};

function mountAshby(question: string): { buttons: HTMLButtonElement[]; clicks: string[] } {
  document.body.innerHTML = `
    <div class="ashby-application-form-container">
      <div class="ashby-application-form-field-entry" data-field-path="question_1">
        <label class="${REQUIRED_CLASS} ashby-application-form-question-title" for="question_1">${question}</label>
        <div class="ashby-application-form-input-yesno">
          <button class="ashby-application-form-input-yesno-option" aria-pressed="false">Yes</button>
          <button class="ashby-application-form-input-yesno-option" aria-pressed="false">No</button>
          <input type="checkbox" tabindex="-1" name="question_1">
        </div>
      </div>
    </div>`;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.ashby-application-form-input-yesno button')];
  const clicks: string[] = [];
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => {
      clicks.push(button.textContent ?? '');
      queueMicrotask(() => buttons.forEach((other, otherIndex) => other.setAttribute('aria-pressed', String(otherIndex === index))));
    });
  });
  return { buttons, clicks };
}

function scanAshby(): ApplyFormDescriptor {
  const scanRoot = ashbyAdapter.resolveRoot(document, SCAN_OPTIONS);
  if (scanRoot === null) throw new Error('ashby root not found');
  return { vendor: 'ashby', root: scanRoot, fields: [...ashbyAdapter.scan(scanRoot, SCAN_OPTIONS)] };
}

describe('Ashby 是非按钮', () => {
  it('能不能联系现在的雇主：答「不可以」→ 点 No 恰好一次', async () => {
    const host = mountAshby(EMPLOYER);
    const { summary } = await run(scanAshby(), { employerContact: 'NO' });
    expect(outcomes(summary)).toEqual([['employerContactDeclined', true, null]]);
    expect(host.clicks).toEqual(['No']);
    expect(host.buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('计划之后题干被换成「并做背景调查」→ 点击策略认不回来，一下都不点', async () => {
    const host = mountAshby(EMPLOYER);
    const descriptor = scanAshby();
    document.querySelector('.ashby-application-form-question-title')!.textContent =
      'May we contact your current employer and run a background check?';
    const { summary } = await run(descriptor, { employerContact: 'NO' });
    expect(outcomes(summary)).toEqual([['employerContactDeclined', false, 'CLICK_DENIED']]);
    expect(host.clicks).toEqual([]);
  });
});
