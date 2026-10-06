/**
 * 代填的选择题——计划期（第二刀，2026-09-23）。
 *
 * Greenhouse 上的条款同意与属实声明几乎都是必填的单选下拉（Yes／No、Consent、I agree、
 * Acknowledge/Confirm），不是勾选框。能力位开着时：
 *  · 单选组、原生下拉：选项在手上，`signOnBehalfAnswer` 恰好挑出一项才排进计划；
 *  · listbox 组合框：题面判得出就排，候选是肯定回答的闭集，写入期再撞真实菜单；
 *  · typeahead／分层菜单／多选的组合框不排（那几条写入路径不带代填标记）。
 * 关着：一律 MANUAL_ONLY，与从前逐字相同。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { SIGN_ON_BEHALF_COMBOBOX_ANSWERS } from '../src/dict/signOnBehalf';
import { createScanRoot } from '../src/scanRoot';

const ATTEST =
  'I certify that the information provided in this application is true and correct to the best of my knowledge. I understand that any false statements or omissions may result in disqualification from employment consideration or, if employed, in termination.';
const PRIVACY =
  "Do you consent to Acme processing your personal information for the purpose of assessing your candidacy for this position in accordance with Acme's Applicant Privacy Policy?";
const IN_OFFICE = 'This role requires in-office work three days per week. Do you acknowledge and agree to this requirement?';

function root() {
  return createScanRoot(document.querySelector('form')!, [], []);
}

function radioGroup(question: string, options: readonly string[]) {
  document.body.innerHTML = `<form><fieldset><legend>${question}</legend>${options
    .map((option, index) => `<label><input type="radio" name="q" id="o${index}">${option}</label>`)
    .join('')}</fieldset></form>`;
  const members = options.map((option, index) => ({ element: document.getElementById(`o${index}`) as HTMLInputElement, label: option }));
  return {
    vendor: 'greenhouse',
    root: root(),
    fields: [{
      kind: 'choice', element: members[0]!.element, key: null, label: question, required: true, confidence: 0,
      signature: { core: 'form/input:0', labelHint: 'q' },
      choice: { control: 'radio', options: members },
    }],
  };
}

function nativeSelect(question: string, options: readonly string[]) {
  document.body.innerHTML = `<form><label for="s">${question}</label><select id="s" name="s"><option value=""></option>${options
    .map((option, index) => `<option value="v${index}">${option}</option>`)
    .join('')}</select></form>`;
  const element = document.getElementById('s') as HTMLSelectElement;
  return {
    vendor: 'greenhouse',
    root: root(),
    fields: [{ kind: 'select', element, key: null, label: question, required: true, confidence: 0, signature: { core: 'form/select:0', labelHint: 's' } }],
  };
}

function listboxCombobox(question: string, binding: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  document.body.innerHTML = `<form><label for="c">${question}</label><input id="c" role="combobox" aria-autocomplete="list" aria-expanded="false"></form>`;
  const element = document.getElementById('c') as HTMLInputElement;
  return {
    vendor: 'greenhouse',
    root: root(),
    fields: [{
      kind: 'combobox', element, key: null, label: question, required: true, confidence: 0,
      signature: { core: 'form/input:0', labelHint: 'c' },
      listbox: { triggerSelector: 'input[role="combobox"]', ...binding },
      ...extra,
    }],
  };
}

function plan(descriptor: unknown, on = true) {
  return buildApplyPlan(descriptor as never, {} as never, {
    fillEmptyOnly: true,
    capabilities: { 'sign-on-behalf': on },
  } as never);
}

afterEach(() => { document.body.innerHTML = ''; });

describe('单选组', () => {
  it('属实声明 + Yes/No → 选 Yes，条目带类别', () => {
    expect(plan(radioGroup(ATTEST, ['Yes', 'No'])).entries).toEqual([
      expect.objectContaining({ kind: 'choice', key: 'truthAttestation', value: 'Yes', signOnBehalf: 'TRUTH_ATTESTATION' }),
    ]);
  });

  it('隐私同意 + I agree / I do not agree → 选 I agree', () => {
    expect(plan(radioGroup(PRIVACY, ['I agree', 'I do not agree'])).entries).toEqual([
      expect.objectContaining({ key: 'termsConsent', value: 'I agree', signOnBehalf: 'TERMS_CONSENT' }),
    ]);
  });

  it('题面判不出、选项本身是整句同意 → 选那一项', () => {
    const statement = 'I acknowledge that I have read and understood the terms of the Acme Candidate Privacy Notice.';
    expect(plan(radioGroup('Please review the linked document:', [statement, 'No'])).entries).toEqual([
      expect.objectContaining({ key: 'termsConsent', value: statement, signOnBehalf: 'TERMS_CONSENT' }),
    ]);
  });

  it('岗位要求（在办公室上班）不是条款：不代填，也不替他答', () => {
    const result = plan(radioGroup(IN_OFFICE, ['Yes', 'No']));
    expect(result.entries).toEqual([]);
  });

  it('能力位关着 → MANUAL_ONLY', () => {
    const result = plan(radioGroup(ATTEST, ['Yes', 'No']), false);
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'MANUAL_ONLY' })]);
  });

  it('已经有人选过 → NOT_EMPTY，不覆盖', () => {
    const descriptor = radioGroup(ATTEST, ['Yes', 'No']);
    (document.getElementById('o1') as HTMLInputElement).checked = true;
    const result = plan(descriptor);
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ key: 'truthAttestation', reason: 'NOT_EMPTY' })]);
  });
});

describe('原生下拉', () => {
  it('隐私同意 + 只有一项 Consent → 选 Consent', () => {
    expect(plan(nativeSelect(PRIVACY, ['Consent'])).entries).toEqual([
      expect.objectContaining({ kind: 'select', key: 'termsConsent', value: 'Consent', resolvedOptionText: 'Consent', signOnBehalf: 'TERMS_CONSENT' }),
    ]);
  });

  it('两项都是肯定回答 → 不选，交还本人', () => {
    const result = plan(nativeSelect(PRIVACY, ['Yes', 'Yes, I agree']));
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'MANUAL_ONLY' })]);
  });
});

describe('组合框', () => {
  it('listbox 部件、题面判得出 → 排进计划，候选是肯定回答的闭集', () => {
    expect(plan(listboxCombobox(PRIVACY)).entries).toEqual([
      expect.objectContaining({
        kind: 'combobox',
        key: 'termsConsent',
        signOnBehalf: 'TERMS_CONSENT',
        comboboxCandidates: SIGN_ON_BEHALF_COMBOBOX_ANSWERS,
      }),
    ]);
  });

  it.each([
    ['typeahead 部件', { typeahead: { optionSelector: 'div' } }, {}],
    ['分层菜单', { hierarchicalPrompt: { popupSelector: 'div' } }, {}],
    ['多选', {}, { multiple: true }],
  ])('%s → 不排', (_why, binding, extra) => {
    expect(plan(listboxCombobox(PRIVACY, binding, extra)).entries).toEqual([]);
  });

  it('没有 listbox 绑定（受控语义那条路）→ 不排', () => {
    const descriptor = listboxCombobox(PRIVACY);
    delete (descriptor.fields[0] as Record<string, unknown>).listbox;
    expect(plan(descriptor).entries).toEqual([]);
  });
});
