/**
 * 代填条款、声明与签名——写入期（2026-09-23）。
 *
 * 计划里有代填条目，还不够：runner 写之前再核一次「策略里 sign-on-behalf 仍开着 ∧ 用户的同意仍成立」，
 * 勾选框在每一下点击之前也核。核不过就如实报 CAPABILITY_DISABLED——框不勾，也**不**回落到属性写入
 * （那条路不经过点击策略，等于绕开了开关）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { SIGNING_CONSENT_KINDS } from '../src/dict/signOnBehalf';
import { fieldSignature } from '../src/fieldIdentity';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

const TERMS = 'By selecting the checkbox, you agree to our Terms and Conditions and Applicant Privacy Policy.';

function mount() {
  document.body.innerHTML = `<form>
    <label for="t">${TERMS}</label><input type="checkbox" id="t" name="t">
    <label for="s">Signature</label><input type="text" id="s" name="s">
  </form>`;
  const terms = document.getElementById('t') as HTMLInputElement;
  const signature = document.getElementById('s') as HTMLInputElement;
  const root = createScanRoot(document.querySelector('form')!, [], []);
  const descriptor = {
    vendor: 'greenhouse',
    root,
    fields: [
      {
        kind: 'choice', element: terms, key: null, label: TERMS, required: true, confidence: 0,
        // 真签名：runner 写之前按页面重算身份，手写的对不上会报 IDENTITY_CHANGED。
        signature: fieldSignature(terms, root),
        choice: { control: 'checkbox', options: [{ element: terms, label: TERMS }] },
      },
      {
        kind: 'text', element: signature, key: null, label: 'Signature', required: true, confidence: 0,
        signature: fieldSignature(signature, root),
      },
    ],
  };
  return { terms, signature, root, descriptor };
}

function policyWith(signOnBehalf: boolean) {
  const base = testApplyPolicy();
  return {
    ...base,
    capabilities: { ...base.capabilities, 'set-text': true, 'set-select': true, 'set-combobox': true, 'sign-on-behalf': signOnBehalf },
  };
}

async function run(options: { consent: boolean; policyOn?: boolean }) {
  const { terms, signature, root, descriptor } = mount();
  const plan = buildApplyPlan(descriptor as never, { firstName: 'Ada', lastName: 'Lovelace' } as never, {
    capabilities: { 'sign-on-behalf': true },
    signOnBehalfKinds: new Set(SIGNING_CONSENT_KINDS),
  } as never);
  expect(plan.entries.map((entry) => entry.key)).toEqual(['termsConsent', 'signatureName']);
  const summary = await runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
    journal: createUndoJournal(),
    root,
    policy: policyWith(options.policyOn ?? true) as never,
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 5,
    signOnBehalfCurrent: () => options.consent,
  });
  return { summary, terms, signature };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('写入期再核一次', () => {
  it('策略开着、用户同意着 → 原生点击勾上条款框，签上档案全名', async () => {
    const { summary, terms, signature } = await run({ consent: true });
    expect(summary.results.map((result) => [result.key, result.ok, result.ok ? null : result.reason]))
      .toEqual([['termsConsent', true, null], ['signatureName', true, null]]);
    expect(terms.checked).toBe(true);
    expect(signature.value).toBe('Ada Lovelace');
  });

  it('用户的同意此刻不成立 → 两格都 CAPABILITY_DISABLED；框不勾，没有属性回落', async () => {
    const { summary, terms, signature } = await run({ consent: false });
    expect(summary.results).toEqual([
      expect.objectContaining({ key: 'termsConsent', ok: false, reason: 'CAPABILITY_DISABLED' }),
      expect.objectContaining({ key: 'signatureName', ok: false, reason: 'CAPABILITY_DISABLED' }),
    ]);
    expect(terms.checked).toBe(false);
    expect(signature.value).toBe('');
  });

  it('策略里 sign-on-behalf 关着 → 同样一格都不写', async () => {
    const { summary, terms, signature } = await run({ consent: true, policyOn: false });
    expect(summary.results.every((result) => !result.ok && result.reason === 'CAPABILITY_DISABLED')).toBe(true);
    expect(terms.checked).toBe(false);
    expect(signature.value).toBe('');
  });
});

/**
 * 选择题（第二刀，2026-09-23）：单选组走原生点击、每一下过点击策略（选项得是肯定回答或整句同意）；
 * 原生下拉走属性写入，点击策略看不到题面，所以写之前要求控件旁的文字与计划时逐字相同。
 */
describe('选择题', () => {
  const ATTEST = 'I certify that the information provided in this application is true and correct to the best of my knowledge.';
  const PRIVACY = "Do you consent to Acme processing your personal information for the purpose of assessing your candidacy in accordance with Acme's Applicant Privacy Policy?";

  function mountChoices() {
    document.body.innerHTML = `<form>
      <fieldset><legend>${ATTEST}</legend>
        <label for="y">Yes</label><input type="radio" id="y" name="attest">
        <label for="n">No</label><input type="radio" id="n" name="attest">
      </fieldset>
      <label id="privacy-label" for="p">${PRIVACY}</label>
      <select id="p" name="p"><option value=""></option><option value="c">Consent</option></select>
    </form>`;
    const yes = document.getElementById('y') as HTMLInputElement;
    const no = document.getElementById('n') as HTMLInputElement;
    const privacy = document.getElementById('p') as HTMLSelectElement;
    const root = createScanRoot(document.querySelector('form')!, [], []);
    const descriptor = {
      vendor: 'greenhouse',
      root,
      fields: [
        {
          kind: 'choice', element: yes, key: null, label: ATTEST, required: true, confidence: 0,
          signature: fieldSignature(yes, root),
          choice: { control: 'radio', options: [{ element: yes, label: 'Yes' }, { element: no, label: 'No' }] },
        },
        { kind: 'select', element: privacy, key: null, label: PRIVACY, required: true, confidence: 0, signature: fieldSignature(privacy, root) },
      ],
    };
    return { yes, no, privacy, root, descriptor };
  }

  async function runChoices(beforeRun?: () => void) {
    const { yes, no, privacy, root, descriptor } = mountChoices();
    const plan = buildApplyPlan(descriptor as never, {} as never, { capabilities: { 'sign-on-behalf': true }, signOnBehalfKinds: new Set(SIGNING_CONSENT_KINDS) } as never);
    expect(plan.entries.map((entry) => [entry.key, entry.value, entry.signOnBehalf])).toEqual([
      ['truthAttestation', 'Yes', 'TRUTH_ATTESTATION'],
      ['termsConsent', 'Consent', 'TERMS_CONSENT'],
    ]);
    beforeRun?.();
    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint, 'fill', [...capabilitiesForKinds(plan.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root,
      policy: policyWith(true) as never,
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 5,
      signOnBehalfCurrent: () => true,
    });
    return { summary, yes, no, privacy };
  }

  it('单选组原生点击选 Yes；原生下拉选 Consent', async () => {
    const { summary, yes, no, privacy } = await runChoices();
    expect(summary.results.map((result) => [result.key, result.ok, result.ok ? null : result.reason]))
      .toEqual([['truthAttestation', true, null], ['termsConsent', true, null]]);
    expect([yes.checked, no.checked]).toEqual([true, false]);
    expect(privacy.value).toBe('c');
  });

  it('计划之后下拉旁的题面被换成营销同意 → 这一栏 IDENTITY_CHANGED，不写；别的栏照写', async () => {
    const { summary, yes, privacy } = await runChoices(() => {
      document.getElementById('privacy-label')!.textContent = 'I agree to receive marketing emails and text messages.';
    });
    expect(summary.results.map((result) => [result.key, result.ok, result.ok ? null : result.reason]))
      .toEqual([['truthAttestation', true, null], ['termsConsent', false, 'IDENTITY_CHANGED']]);
    expect(yes.checked).toBe(true);
    expect(privacy.value).toBe('');
  });
});
