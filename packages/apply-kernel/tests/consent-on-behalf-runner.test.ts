/**
 * 代填第三刀（2026-09-24）——写入期，真扫描 → 计划 → runner。
 *
 * 每一种控件都要两把钥匙同时在：策略里 `sign-on-behalf` 开着、用户的同意此刻成立（`signOnBehalfCurrent`）。
 * 少一把就如实报 CAPABILITY_DISABLED，什么都不点、也不回落到属性写入。
 *  · 勾选框、单选：原生点击，每一下过点击策略；
 *  · 原生下拉：属性写入，写前要求控件旁的文字与计划时相同；
 *  · Greenhouse react-select：打开菜单后按整道题重判（题面 + 全部选项），恰好一项才点——仲裁题的题面
 *    只是标题，只点本身就是那一句同意的选项；
 *  · Ashby 是非按钮（ARIA 代理）：点那颗 Yes，点击策略每一下之前从题干元素把题干重读一遍；
 *    点击的防提交约束一条不松（按钮一旦有了表单归属，一下都不点）。
 * 题面全是合成的。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplyFormDescriptor, ScanRootOptions } from '../src/contracts';
import { buildApplyPlan } from '../src/engine';
import { SIGNING_CONSENT_KINDS } from '../src/dict/signOnBehalf';
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

function policyWith(signOnBehalf: boolean) {
  const base = createBundledApplyPolicy(Date.now());
  return {
    ...base,
    capabilities: { ...base.capabilities, 'set-text': true, 'set-select': true, 'set-combobox': true, 'sign-on-behalf': signOnBehalf },
  };
}

async function run(
  descriptor: ApplyFormDescriptor,
  options: { consent?: boolean; policyOn?: boolean; beforeRun?: () => void; auth?: (fingerprint: string) => HostWriteAuthority } = {},
) {
  const plan = buildApplyPlan(descriptor, {} as never, { fillEmptyOnly: true, capabilities: { 'sign-on-behalf': true }, signOnBehalfKinds: new Set(SIGNING_CONSENT_KINDS) } as never);
  options.beforeRun?.();
  const summary = await runApplyPlan({
    plan,
    auth: options.auth?.(plan.fingerprint) ??
      testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
    journal: createUndoJournal(),
    root: descriptor.root,
    policy: policyWith(options.policyOn ?? true) as never,
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 5,
    signOnBehalfCurrent: () => options.consent ?? true,
  });
  return { plan, summary };
}

const outcomes = (summary: Awaited<ReturnType<typeof runApplyPlan>>) =>
  summary.results.map((result) => [result.key, result.ok, result.ok ? null : result.reason]);

// —— 原生控件 ————————————————————————————————————————————————————————————————————

const SMS = 'I agree to receive text messages from Acme about my application.';
const ARBITRATION_STATEMENT = 'I understand and agree to the terms of the Agreement to Arbitrate set forth above.';

function mountNative() {
  document.body.innerHTML = `<form>
    <label for="sms">${SMS}</label><input type="checkbox" id="sms" name="sms">
    <fieldset><legend>Do you consent to a background check?</legend>
      <label for="y">Yes</label><input type="radio" id="y" name="bg">
      <label for="n">No</label><input type="radio" id="n" name="bg">
    </fieldset>
    <label id="arb-label" for="arb">Agreement to Arbitrate</label>
    <select id="arb" name="arb"><option value=""></option><option value="a">${ARBITRATION_STATEMENT}</option></select>
  </form>`;
  const sms = document.getElementById('sms') as HTMLInputElement;
  const yes = document.getElementById('y') as HTMLInputElement;
  const no = document.getElementById('n') as HTMLInputElement;
  const arbitration = document.getElementById('arb') as HTMLSelectElement;
  const root = createScanRoot(document.querySelector('form')!, [], []);
  const descriptor = {
    vendor: 'greenhouse',
    root,
    fields: [
      {
        kind: 'choice', element: sms, key: null, label: SMS, required: true, confidence: 0,
        signature: fieldSignature(sms, root),
        choice: { control: 'checkbox', options: [{ element: sms, label: SMS }] },
      },
      {
        kind: 'choice', element: yes, key: null, label: 'Do you consent to a background check?', required: true, confidence: 0,
        signature: fieldSignature(yes, root),
        choice: { control: 'radio', options: [{ element: yes, label: 'Yes' }, { element: no, label: 'No' }] },
      },
      {
        kind: 'select', element: arbitration, key: null, label: 'Agreement to Arbitrate', required: true, confidence: 0,
        signature: fieldSignature(arbitration, root),
      },
    ],
  } as never as ApplyFormDescriptor;
  return { sms, yes, no, arbitration, descriptor };
}

describe('原生勾选框、单选组与下拉', () => {
  it('两把钥匙都在：短信框勾上、背景调查选 Yes、仲裁下拉选那一句', async () => {
    const { sms, yes, no, arbitration, descriptor } = mountNative();
    const { plan, summary } = await run(descriptor);
    expect(plan.entries.map((entry) => [entry.key, entry.signOnBehalf])).toEqual([
      ['smsConsent', 'SMS_CONSENT'],
      ['backgroundCheckConsent', 'BACKGROUND_CHECK_CONSENT'],
      ['arbitrationAgreement', 'ARBITRATION_AGREEMENT'],
    ]);
    expect(outcomes(summary)).toEqual([
      ['smsConsent', true, null],
      ['backgroundCheckConsent', true, null],
      ['arbitrationAgreement', true, null],
    ]);
    expect([sms.checked, yes.checked, no.checked, arbitration.value]).toEqual([true, true, false, 'a']);
  });

  it('用户的同意此刻不成立 → 三格都 CAPABILITY_DISABLED，一格都不动（没有属性回落）', async () => {
    const { sms, yes, arbitration, descriptor } = mountNative();
    const { summary } = await run(descriptor, { consent: false });
    expect(summary.results.every((result) => !result.ok && result.reason === 'CAPABILITY_DISABLED')).toBe(true);
    expect([sms.checked, yes.checked, arbitration.value]).toEqual([false, false, '']);
  });

  it('策略里 sign-on-behalf 关着 → 同样一格都不写', async () => {
    const { sms, yes, arbitration, descriptor } = mountNative();
    const { summary } = await run(descriptor, { policyOn: false });
    expect(summary.results.every((result) => !result.ok && result.reason === 'CAPABILITY_DISABLED')).toBe(true);
    expect([sms.checked, yes.checked, arbitration.value]).toEqual([false, false, '']);
  });

  it('计划之后短信框的文字被换成营销短信 → 点击策略认不回来，不勾', async () => {
    const { sms, descriptor } = mountNative();
    const { summary } = await run(descriptor, {
      beforeRun: () => { document.querySelector('label[for="sms"]')!.textContent = 'I agree to receive marketing text messages from Acme.'; },
    });
    expect(summary.results[0]).toMatchObject({ key: 'smsConsent', ok: false });
    expect(sms.checked).toBe(false);
  });

  it('计划之后下拉旁的题面被换掉 → IDENTITY_CHANGED，不写', async () => {
    const { arbitration, descriptor } = mountNative();
    const { summary } = await run(descriptor, {
      beforeRun: () => { document.getElementById('arb-label')!.textContent = 'Background Check'; },
    });
    expect(summary.results[2]).toMatchObject({ key: 'arbitrationAgreement', ok: false, reason: 'IDENTITY_CHANGED' });
    expect(arbitration.value).toBe('');
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

describe('Greenhouse 下拉：打开菜单后按整道题重判', () => {
  it.each([
    ['Agreement to Arbitrate', [ARBITRATION_STATEMENT], ARBITRATION_STATEMENT],
    ['Please read the arbitration agreement below', ['I will read the arbitration agreement below.'], 'I will read the arbitration agreement below.'],
    ['Do you consent to receive text messages about your application?', ['Yes', 'No'], 'Yes'],
  ])('%s → 选「%s」里那一项', async (question, options, expected) => {
    mountGreenhouse(question, options);
    const { summary } = await run(scanGreenhouse(), { auth: fillAuthority });
    expect(summary.results).toEqual([expect.objectContaining({ ok: true })]);
    expect(chosen()).toBe(expected);
  });

  it.each([
    ['题面是标题、选项是 Yes/No', 'Agreement to Arbitrate', ['Yes', 'No']],
    ['题面是标题、两句同意', 'Agreement to Arbitrate', [ARBITRATION_STATEMENT, 'I have read the arbitration agreement.']],
    ['两项肯定回答', 'Do you consent to receive text messages about your application?', ['Yes', 'I agree']],
  ])('%s → 不点，交还本人', async (_why, question, options) => {
    mountGreenhouse(question, options);
    const { summary } = await run(scanGreenhouse(), { auth: fillAuthority });
    expect(summary.results).toEqual([expect.objectContaining({ ok: false, reason: 'MANUAL_ONLY' })]);
    expect(chosen()).toBeNull();
  });

  it('用户的同意此刻不成立 → 菜单都不打开', async () => {
    mountGreenhouse('Agreement to Arbitrate', [ARBITRATION_STATEMENT]);
    const { summary } = await run(scanGreenhouse(), { auth: fillAuthority, consent: false });
    expect(summary.results).toEqual([expect.objectContaining({ ok: false, reason: 'CAPABILITY_DISABLED' })]);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});

// —— Ashby 是非按钮（ARIA 代理） ————————————————————————————————————————————————————

const REQUIRED_CLASS = 'hashed-required';
const SCAN_OPTIONS: ScanRootOptions = {
  readGeneratedContent: (element, pseudo) =>
    pseudo === '::after' && element.classList.contains(REQUIRED_CLASS) ? '"*"' : 'none',
};
const BACKGROUND =
  'We conduct thorough background checks as part of our hiring process. By selecting "Yes," you acknowledge and consent to a background check if you receive an offer.';

function mountAshby(question: string): void {
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
}

/** 像 Ashby 那样的受控宿主：click 里改状态，下一个微任务才公布到 aria-pressed 上。 */
function ashbyHost() {
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
  it('两把钥匙都在：点 Yes 恰好一次，宿主翻了 aria-pressed 才算成功', async () => {
    mountAshby(BACKGROUND);
    const host = ashbyHost();
    const { summary } = await run(scanAshby());
    expect(outcomes(summary)).toEqual([['backgroundCheckConsent', true, null]]);
    expect(host.clicks).toEqual(['Yes']);
    expect(host.buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });

  it('用户的同意此刻不成立 → CAPABILITY_DISABLED，一下都不点', async () => {
    mountAshby(BACKGROUND);
    const host = ashbyHost();
    const { summary } = await run(scanAshby(), { consent: false });
    expect(outcomes(summary)).toEqual([['backgroundCheckConsent', false, 'CAPABILITY_DISABLED']]);
    expect(host.clicks).toEqual([]);
  });

  it('计划之后题干被换成「包括联系现任雇主」→ 点击策略认不回来，一下都不点', async () => {
    mountAshby(BACKGROUND);
    const host = ashbyHost();
    const { summary } = await run(scanAshby(), {
      beforeRun: () => {
        document.querySelector('.ashby-application-form-question-title')!.textContent =
          'Do you consent to a background check, including contacting your current employer?';
      },
    });
    expect(outcomes(summary)).toEqual([['backgroundCheckConsent', false, 'CLICK_DENIED']]);
    expect(host.clicks).toEqual([]);
  });

  it('计划之后按钮被挂到一张表单上（点了会提交）→ 一下都不点，也没有提交', async () => {
    mountAshby(BACKGROUND);
    document.body.insertAdjacentHTML('beforeend', '<form id="elsewhere"></form>');
    const host = ashbyHost();
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.addEventListener('submit', submitted, true);
    const { summary } = await run(scanAshby(), {
      beforeRun: () => { for (const button of host.buttons) button.setAttribute('form', 'elsewhere'); },
    });
    expect(summary.results[0]!.ok).toBe(false);
    expect(host.clicks).toEqual([]);
    expect(submitted).not.toHaveBeenCalled();
  });
});
