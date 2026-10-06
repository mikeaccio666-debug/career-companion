/**
 * 代填第三刀（2026-09-24）——计划期：六类同意在每一种控件上怎么排进计划。
 *
 * 能力位 `sign-on-behalf`（运行时包放行 ∧ 用户在资料页同意过当前文案版本，由调用方合成）开着才排；
 * 关着一律 MANUAL_ONLY。每一类一个条目键，条目带类别（浮层据此写「已替你同意：…」）。
 * ARIA 代理题只认六类同意（条款同意／属实声明照旧交还本人），而且题干必须来自页面上的一个元素。
 * 题面全是合成的。
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyFormDescriptor, ScanRootOptions } from '../src/contracts';
import { SIGN_ON_BEHALF_COMBOBOX_ANSWERS } from '../src/dict/signOnBehalf';
import { buildApplyPlan } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';

const SMS = 'I agree to receive text messages from Acme about my application.';
const MARKETING = 'I would like to receive marketing emails from Acme.';
const FUTURE = 'I would like to be contacted about future job opportunities at Acme.';
const RECORDING = 'I consent to the recording and transcription of my interviews by an AI notetaker.';
const BACKGROUND = 'I authorize Acme to conduct a background check.';
const ARBITRATION = 'I have read and agree to the Mutual Arbitration Agreement.';

afterEach(() => { document.body.innerHTML = ''; });

function root() {
  return createScanRoot(document.querySelector('form')!, [], []);
}

function checkboxes(labels: readonly string[]): ApplyFormDescriptor {
  document.body.innerHTML = `<form>${labels
    .map((label, index) => `<label for="c${index}">${label}</label><input type="checkbox" id="c${index}" name="c${index}">`)
    .join('')}</form>`;
  const fields = labels.map((label, index) => {
    const element = document.getElementById(`c${index}`) as HTMLInputElement;
    return {
      kind: 'choice', element, key: null, label, required: true, confidence: 0,
      signature: { core: `form/input:${index}`, labelHint: `c${index}` },
      choice: { control: 'checkbox', options: [{ element, label }] },
    };
  });
  return { vendor: 'greenhouse', root: root(), fields } as never;
}

function radioGroup(question: string, options: readonly string[]): ApplyFormDescriptor {
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
  } as never;
}

function nativeSelect(question: string, options: readonly string[]): ApplyFormDescriptor {
  document.body.innerHTML = `<form><label for="s">${question}</label><select id="s" name="s"><option value=""></option>${options
    .map((option, index) => `<option value="v${index}">${option}</option>`)
    .join('')}</select></form>`;
  const element = document.getElementById('s') as HTMLSelectElement;
  return {
    vendor: 'greenhouse',
    root: root(),
    fields: [{ kind: 'select', element, key: null, label: question, required: true, confidence: 0, signature: { core: 'form/select:0', labelHint: 's' } }],
  } as never;
}

function listboxCombobox(question: string): ApplyFormDescriptor {
  document.body.innerHTML = `<form><label for="c">${question}</label><input id="c" role="combobox" aria-autocomplete="list" aria-expanded="false"></form>`;
  const element = document.getElementById('c') as HTMLInputElement;
  return {
    vendor: 'greenhouse',
    root: root(),
    fields: [{
      kind: 'combobox', element, key: null, label: question, required: true, confidence: 0,
      signature: { core: 'form/input:0', labelHint: 'c' },
      listbox: { triggerSelector: 'input[role="combobox"]' },
    }],
  } as never;
}

function plan(descriptor: ApplyFormDescriptor, on = true) {
  return buildApplyPlan(descriptor, {} as never, { fillEmptyOnly: true, capabilities: { 'sign-on-behalf': on } } as never);
}

describe('单个勾选框：每一类一个条目键', () => {
  it.each([
    [SMS, 'smsConsent', 'SMS_CONSENT'],
    [MARKETING, 'marketingConsent', 'MARKETING_CONSENT'],
    [FUTURE, 'futureContactConsent', 'FUTURE_CONTACT_CONSENT'],
    [RECORDING, 'aiRecordingConsent', 'AI_RECORDING_CONSENT'],
    [BACKGROUND, 'backgroundCheckConsent', 'BACKGROUND_CHECK_CONSENT'],
    [ARBITRATION, 'arbitrationAgreement', 'ARBITRATION_AGREEMENT'],
  ])('%s → %s', (label, key, kind) => {
    expect(plan(checkboxes([label])).entries).toEqual([
      expect.objectContaining({ kind: 'choice', key, value: label, signOnBehalf: kind }),
    ]);
  });

  it('能力位关着 → 六类一律 MANUAL_ONLY', () => {
    const result = plan(checkboxes([SMS, MARKETING, FUTURE, RECORDING, BACKGROUND, ARBITRATION]), false);
    expect(result.entries).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(Array(6).fill('MANUAL_ONLY'));
  });

  it('同一节里分开的几格（短信、营销）不是重复字段，一格都不丢', () => {
    expect(plan(checkboxes([SMS, MARKETING])).entries.map((entry) => entry.key)).toEqual(['smsConsent', 'marketingConsent']);
  });

  it.each([
    ['几类混在一起，还掺了为营销分享资料', 'I agree to receive marketing emails and text messages, and Acme may share my data with its partners for marketing.'],
    ['联系现任雇主', 'I authorize Acme to conduct a background check and contact my current employer.'],
    ['第三方出售资料', 'I consent to Acme selling my data to a third-party provider.'],
    ['否定句', 'I do not want to receive text messages.'],
  ])('%s：开着也不代填', (_why, label) => {
    const result = plan(checkboxes([label]));
    expect(result.entries).toEqual([]);
  });

  it.each([
    ['营销 + 短信', 'I agree to receive marketing emails and text messages from Acme.'],
    ['背景调查由第三方服务商做', 'I consent to a background check conducted by a third-party provider.'],
  ])('第五刀（2026-09-28）起，只由放行类别组成的混合按「混合」代填：%s', (_why, label) => {
    expect(plan(checkboxes([label])).entries).toEqual([
      expect.objectContaining({ key: 'combinedConsent', signOnBehalf: 'COMBINED_CONSENT' }),
    ]);
  });

  it('框已经勾着 → NOT_EMPTY，不动', () => {
    const descriptor = checkboxes([SMS]);
    (document.getElementById('c0') as HTMLInputElement).checked = true;
    expect(plan(descriptor).skipped).toEqual([expect.objectContaining({ key: 'smsConsent', reason: 'NOT_EMPTY' })]);
  });
});

describe('单选组与原生下拉', () => {
  it('背景调查是非题 → 选 Yes', () => {
    expect(plan(radioGroup('Do you consent to a background check?', ['Yes', 'No'])).entries).toEqual([
      expect.objectContaining({ kind: 'choice', key: 'backgroundCheckConsent', value: 'Yes', signOnBehalf: 'BACKGROUND_CHECK_CONSENT' }),
    ]);
  });

  it('人才库：Opt in / Opt out → 选 Opt in', () => {
    expect(plan(radioGroup('Would you like to join our talent community?', ['Opt in', 'Opt out'])).entries).toEqual([
      expect.objectContaining({ key: 'futureContactConsent', value: 'Opt in' }),
    ]);
  });

  it('仲裁：题面是标题、下拉里只有那一句同意 → 选那一句', () => {
    const statement = 'I understand and agree to the terms of the Agreement to Arbitrate set forth above.';
    expect(plan(nativeSelect('Agreement to Arbitrate', [statement])).entries).toEqual([
      expect.objectContaining({ kind: 'select', key: 'arbitrationAgreement', value: statement, resolvedOptionText: statement, signOnBehalf: 'ARBITRATION_AGREEMENT' }),
    ]);
  });

  it('仲裁：题面是标题、选项是 Yes/No → 不代填（标题不是同意）', () => {
    const result = plan(nativeSelect('Agreement to Arbitrate', ['Yes', 'No']));
    expect(result.entries).toEqual([]);
  });

  it('两项都是肯定回答 → 不猜', () => {
    expect(plan(radioGroup('Do you consent to a background check?', ['Yes', 'I agree'])).entries).toEqual([]);
  });
});

describe('listbox 组合框', () => {
  it.each([
    ['Do you consent to receive text messages about your application?', 'smsConsent', 'SMS_CONSENT'],
    ['Agreement to Arbitrate', 'arbitrationAgreement', 'ARBITRATION_AGREEMENT'],
    ['Please read the arbitration agreement below', 'arbitrationAgreement', 'ARBITRATION_AGREEMENT'],
  ])('%s → 排进计划（写入期按整道题重判）', (question, key, kind) => {
    expect(plan(listboxCombobox(question)).entries).toEqual([
      expect.objectContaining({ kind: 'combobox', key, signOnBehalf: kind, comboboxCandidates: SIGN_ON_BEHALF_COMBOBOX_ANSWERS }),
    ]);
  });

  it('题面是两类的标题 → 不排', () => {
    expect(plan(listboxCombobox('Arbitration Agreement and Background Check')).entries).toEqual([]);
  });
});

// —— ARIA 代理题（Ashby 的是非按钮） ——————————————————————————————————————————————

const REQUIRED_CLASS = 'hashed-required';
const SCAN_OPTIONS: ScanRootOptions = {
  readGeneratedContent: (element, pseudo) =>
    pseudo === '::after' && element.classList.contains(REQUIRED_CLASS) ? '"*"' : 'none',
};
const ASHBY_BACKGROUND =
  'We conduct thorough background checks as part of our hiring process. By selecting "Yes," you acknowledge and consent to a background check if you receive an offer.';
const ASHBY_TERMS = 'Do you agree to the Acme Terms of Service and Privacy Policy?';

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

function scanAshby(): ApplyFormDescriptor {
  const scanRoot = ashbyAdapter.resolveRoot(document, SCAN_OPTIONS);
  if (scanRoot === null) throw new Error('ashby root not found');
  return { vendor: 'ashby', root: scanRoot, fields: [...ashbyAdapter.scan(scanRoot, SCAN_OPTIONS)] };
}

describe('ARIA 代理题（Ashby 是非按钮）', () => {
  it('扫描记下题干元素：就是规则声明的那一行题干', () => {
    mountAshby(ASHBY_BACKGROUND);
    const field = scanAshby().fields.find((candidate) => candidate.kind === 'choice')!;
    expect(field.kind === 'choice' && field.choice.control === 'proxy' ? field.choice.question : undefined)
      .toBe(document.querySelector('.ashby-application-form-question-title'));
  });

  it('背景调查 → 能力位开着排进计划、选 Yes；关着 MANUAL_ONLY', () => {
    mountAshby(ASHBY_BACKGROUND);
    expect(plan(scanAshby()).entries).toEqual([
      expect.objectContaining({ kind: 'choice', key: 'backgroundCheckConsent', value: 'Yes', signOnBehalf: 'BACKGROUND_CHECK_CONSENT' }),
    ]);
    const off = plan(scanAshby(), false);
    expect(off.entries).toEqual([]);
    expect(off.skipped).toEqual([expect.objectContaining({ label: ASHBY_BACKGROUND, reason: 'MANUAL_ONLY', required: true })]);
  });

  it('条款同意在代理题上照旧交还本人（开着也不代填）', () => {
    mountAshby(ASHBY_TERMS);
    const result = plan(scanAshby());
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ label: ASHBY_TERMS, reason: 'MANUAL_ONLY' })]);
  });

  it('题干不是来自页面上的元素（没有 question）→ 不代填', () => {
    mountAshby(ASHBY_BACKGROUND);
    const descriptor = scanAshby();
    const fields = descriptor.fields.map((field) =>
      field.kind === 'choice' && field.choice.control === 'proxy' ? { ...field, choice: { ...field.choice, question: null } } : field);
    const result = plan({ ...descriptor, fields } as never);
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'MANUAL_ONLY' })]);
  });

  it('题干里混进联系现任雇主 → 不代填', () => {
    mountAshby('Do you consent to a background check, including contacting your current employer?');
    expect(plan(scanAshby()).entries).toEqual([]);
  });
});
