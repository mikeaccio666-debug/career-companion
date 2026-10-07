/**
 * 代填第五刀（2026-09-28）——计划期：同意了当前版本的代填授权才放行；能不能联系雇主按资料里的回答答。
 *
 * 能力位 `sign-on-behalf` 之外还有第二道：这一轮获准的类别（`signOnBehalfKinds`）。只有当前版本（2026-09-28）的同意
 * 算数：只放行本轮明确提供的类别；没提供类别、没同意（只同意过旧版本也一样），同意类一律 MANUAL_ONLY。
 * 能不能联系雇主不看同意书，只看资料里的回答及本轮类别；没答就交还本人。
 * 题面全是合成的（公司名一律 Acme）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyFormDescriptor, ScanRootOptions } from '../src/contracts';
import { employerContactKinds, SIGNING_CONSENT_KINDS, type EmployerContactAnswer, type SignOnBehalfKind } from '../src/dict/signOnBehalf';
import { buildApplyPlan, SIGN_ON_BEHALF_ENTRY_KEY } from '../src/engine';
import { createScanRoot } from '../src/scanRoot';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';

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

/** 同意了当前版本的代填授权（2026-09-28）。 */
const CONSENTED = new Set<SignOnBehalfKind>(SIGNING_CONSENT_KINDS);
/** 没同意代填授权（包括只同意过旧版本的：只有当前版本算数），这一轮只有资料里「不可以联系雇主」那一向。 */
const ANSWER_ONLY = new Set<SignOnBehalfKind>(employerContactKinds('NO'));

function plan(
  descriptor: ApplyFormDescriptor,
  options: { kinds?: ReadonlySet<SignOnBehalfKind>; employerContact?: EmployerContactAnswer; on?: boolean } = {},
) {
  return buildApplyPlan(descriptor, {} as never, {
    fillEmptyOnly: true,
    capabilities: { 'sign-on-behalf': options.on ?? true },
    ...(options.kinds === undefined ? {} : { signOnBehalfKinds: options.kinds }),
    ...(options.employerContact === undefined ? {} : { employerContact: options.employerContact }),
  } as never);
}

const WIDENED_CHECKBOXES = [
  ['RECRUITING_DATA_SHARING', 'I consent to Acme sharing my application data with its recruiting service providers for recruiting purposes.'],
  ['INFORMATION_VERIFICATION', 'I authorize Acme to verify my education and employment history.'],
  ['SCREENING_CONSENT', 'I authorize Acme to obtain a credit report as part of my application.'],
  ['AT_WILL_ACKNOWLEDGEMENT', 'I understand and agree that employment with Acme is at-will.'],
  ['ARBITRATION_WAIVER', 'I agree to the Arbitration Agreement, including its class and collective action waiver.'],
  ['AI_INTERVIEW_ANALYSIS', 'I consent to Acme recording my interview and using AI to evaluate my answers.'],
  ['CALL_NOTIFICATION_CONSENT', 'I agree to receive text messages and phone calls about my application.'],
  ['GROUP_FUTURE_CONTACT', 'I agree that Acme and its affiliates may contact me about future job opportunities.'],
  ['PRIVACY_NOTICE_TITLE', 'Applicant Privacy Notice'],
  ['COMBINED_CONSENT', 'I consent to a background check and agree to binding arbitration.'],
] as const;

describe('新类别：同意了当前版本的代填授权才排', () => {
  it.each(WIDENED_CHECKBOXES)('%s：同意了当前版本 → 排进计划，条目带类别与自己的键', (kind, label) => {
    expect(plan(checkboxes([label]), { kinds: CONSENTED }).entries).toEqual([
      expect.objectContaining({ kind: 'choice', key: SIGN_ON_BEHALF_ENTRY_KEY[kind], value: label, signOnBehalf: kind }),
    ]);
  });

  it.each(WIDENED_CHECKBOXES)('%s：没同意代填授权（只同意过旧版本也一样）、这一轮只有资料里的回答 → MANUAL_ONLY', (_kind, label) => {
    const result = plan(checkboxes([label]), { kinds: ANSWER_ONLY });
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ label, reason: 'MANUAL_ONLY', required: true })]);
  });

  it.each(WIDENED_CHECKBOXES)('%s：调用方不给获准的类别 → 能力位不能替代授权，交还本人', (_kind, label) => {
    const result = plan(checkboxes([label]));
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ label, reason: 'MANUAL_ONLY', required: true })]);
  });

  it('旧类别同样只在同意了当前版本时排：没同意（只同意过旧版本也一样）就交还本人', () => {
    const label = 'I authorize Acme to conduct a background check.';
    expect(plan(checkboxes([label]), { kinds: CONSENTED }).entries).toEqual([
      expect.objectContaining({ key: 'backgroundCheckConsent', signOnBehalf: 'BACKGROUND_CHECK_CONSENT' }),
    ]);
    const result = plan(checkboxes([label]), { kinds: ANSWER_ONLY });
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ label, reason: 'MANUAL_ONLY' })]);
  });

  it('能力位关着：新版本的同意也不排', () => {
    const [kind, label] = WIDENED_CHECKBOXES[2];
    expect(kind).toBe('SCREENING_CONSENT');
    expect(plan(checkboxes([label]), { kinds: CONSENTED, on: false }).entries).toEqual([]);
  });

  it.each([
    ['出售资料', 'I consent to Acme selling my personal information.'],
    ['为营销分享', 'I consent to Acme sharing my information with its partners for marketing purposes.'],
    ['生物特征', 'I consent to Acme using facial recognition during video interviews.'],
    ['一般免责', 'I authorize a background check and release Acme from any liability.'],
    ['竞业', 'I agree to the Arbitration Agreement and to the non-compete terms.'],
    ['医疗', 'I consent to a medical examination before starting employment.'],
    ['否定句', 'I do not consent to a credit check.'],
  ])('%s：09-28 也不代填，交还本人', (_why, label) => {
    const result = plan(checkboxes([label]), { kinds: CONSENTED });
    expect(result.entries).toEqual([]);
  });

  it('单选组：题面是新类别的同意问句 → 选那一项肯定回答', () => {
    expect(plan(radioGroup('Do you consent to a credit check as part of our hiring process?', ['Yes', 'No']), { kinds: CONSENTED }).entries)
      .toEqual([expect.objectContaining({ kind: 'choice', key: 'screeningConsent', value: 'Yes', signOnBehalf: 'SCREENING_CONSENT' })]);
  });

  it('原生下拉：只有标题的隐私声明 + 一个 Yes → 选 Yes', () => {
    expect(plan(nativeSelect('Applicant Privacy Notice', ['Yes']), { kinds: CONSENTED }).entries).toEqual([
      expect.objectContaining({ kind: 'select', key: 'privacyNoticeAcknowledgement', value: 'Yes', signOnBehalf: 'PRIVACY_NOTICE_TITLE' }),
    ]);
    expect(plan(nativeSelect('Applicant Privacy Notice', ['Yes']), { kinds: ANSWER_ONLY }).entries).toEqual([]);
  });

  it('listbox 组合框：新类别的题面与标题都排（写入期按整道题重判）', () => {
    expect(plan(listboxCombobox('Do you authorize Acme to verify your education?'), { kinds: CONSENTED }).entries).toEqual([
      expect.objectContaining({ kind: 'combobox', key: 'informationVerificationConsent', signOnBehalf: 'INFORMATION_VERIFICATION' }),
    ]);
    expect(plan(listboxCombobox('E-Verify Acknowledgement'), { kinds: CONSENTED }).entries).toEqual([
      expect.objectContaining({ kind: 'combobox', key: 'informationVerificationConsent', signOnBehalf: 'INFORMATION_VERIFICATION' }),
    ]);
  });
});

describe('能不能联系现在的雇主：按资料里的回答答', () => {
  const ASK = 'May we contact your current employer?';
  const both = (answer: EmployerContactAnswer) => new Set<SignOnBehalfKind>([...CONSENTED, ...employerContactKinds(answer)]);

  it('单选组：答「可以」选 Yes，答「不可以」选 No', () => {
    expect(plan(radioGroup(ASK, ['Yes', 'No']), { kinds: both('YES'), employerContact: 'YES' }).entries).toEqual([
      expect.objectContaining({ kind: 'choice', key: 'employerContactAllowed', value: 'Yes', signOnBehalf: 'EMPLOYER_CONTACT_YES' }),
    ]);
    expect(plan(radioGroup(ASK, ['Yes', 'No']), { kinds: both('NO'), employerContact: 'NO' }).entries).toEqual([
      expect.objectContaining({ kind: 'choice', key: 'employerContactDeclined', value: 'No', signOnBehalf: 'EMPLOYER_CONTACT_NO' }),
    ]);
  });

  it('不看同意书：同意了代填授权与没同意（只同意过旧版本也一样），答了都照答', () => {
    for (const kinds of [both('NO'), ANSWER_ONLY]) {
      expect(plan(radioGroup(ASK, ['Yes', 'No']), { kinds, employerContact: 'NO' }).entries).toEqual([
        expect.objectContaining({ value: 'No', signOnBehalf: 'EMPLOYER_CONTACT_NO' }),
      ]);
    }
  });

  it('没答 → 交还本人（与从前一样）', () => {
    const result = plan(radioGroup(ASK, ['Yes', 'No']), { kinds: CONSENTED });
    expect(result.entries).toEqual([]);
  });

  it('能力位关着 → 答了也不代填', () => {
    expect(plan(radioGroup(ASK, ['Yes', 'No']), { kinds: both('YES'), employerContact: 'YES', on: false }).entries).toEqual([]);
  });

  it('获准的类别里没有这一向 → 不代填（调用方与回答必须对得上）', () => {
    expect(plan(radioGroup(ASK, ['Yes', 'No']), { kinds: both('NO'), employerContact: 'YES' }).entries).toEqual([]);
  });

  it('原生下拉：选「不可以」那一项', () => {
    expect(plan(nativeSelect('Can we contact your employer to verify your employment?', ['Yes', 'No']), { kinds: both('NO'), employerContact: 'NO' }).entries)
      .toEqual([expect.objectContaining({ kind: 'select', key: 'employerContactDeclined', value: 'No', resolvedOptionText: 'No' })]);
  });

  it('单个勾选框：正面的授权、答「可以」才勾；答「不可以」交还本人', () => {
    const label = 'I authorize Acme to contact my current employer.';
    expect(plan(checkboxes([label]), { kinds: both('YES'), employerContact: 'YES' }).entries).toEqual([
      expect.objectContaining({ kind: 'choice', key: 'employerContactAllowed', value: label, signOnBehalf: 'EMPLOYER_CONTACT_YES' }),
    ]);
    const declined = plan(checkboxes([label]), { kinds: both('NO'), employerContact: 'NO' });
    expect(declined.entries).toEqual([]);
    expect(declined.skipped).toEqual([expect.objectContaining({ label, reason: 'MANUAL_ONLY' })]);
  });

  it('以前的雇主与推荐人：题目只问他们时照同一个回答答', () => {
    expect(plan(radioGroup('May we contact the references you listed?', ['Yes', 'No']), { kinds: both('YES'), employerContact: 'YES' }).entries)
      .toEqual([expect.objectContaining({ key: 'referenceContactAllowed', value: 'Yes', signOnBehalf: 'REFERENCE_CONTACT_YES' })]);
  });

  it('混进背景调查 → 交还本人', () => {
    expect(plan(radioGroup('May we contact your current employer and run a background check?', ['Yes', 'No']), {
      kinds: new Set([...CONSENTED, ...employerContactKinds('YES')]),
      employerContact: 'YES',
    }).entries).toEqual([]);
  });

  it('listbox 组合框：按回答的方向排（写入期按类别撞真实菜单）', () => {
    expect(plan(listboxCombobox(ASK), { kinds: both('NO'), employerContact: 'NO' }).entries).toEqual([
      expect.objectContaining({ kind: 'combobox', key: 'employerContactDeclined', value: 'No', signOnBehalf: 'EMPLOYER_CONTACT_NO' }),
    ]);
  });
});

// —— ARIA 代理题（Ashby 的是非按钮） ——————————————————————————————————————————————

const REQUIRED_CLASS = 'hashed-required';
const SCAN_OPTIONS: ScanRootOptions = {
  readGeneratedContent: (element, pseudo) =>
    pseudo === '::after' && element.classList.contains(REQUIRED_CLASS) ? '"*"' : 'none',
};

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
  it('新类别：同意了当前版本选 Yes；没同意交还本人', () => {
    mountAshby('Do you consent to a drug screening as part of our hiring process?');
    expect(plan(scanAshby(), { kinds: CONSENTED }).entries).toEqual([
      expect.objectContaining({ kind: 'choice', key: 'screeningConsent', value: 'Yes', signOnBehalf: 'SCREENING_CONSENT' }),
    ]);
    expect(plan(scanAshby(), { kinds: ANSWER_ONLY }).entries).toEqual([]);
  });

  it('能不能联系现在的雇主：答「不可以」选 No', () => {
    mountAshby('May we contact your current employer?');
    expect(plan(scanAshby(), {
      kinds: ANSWER_ONLY,
      employerContact: 'NO',
    }).entries).toEqual([expect.objectContaining({ kind: 'choice', key: 'employerContactDeclined', value: 'No', signOnBehalf: 'EMPLOYER_CONTACT_NO' })]);
  });
});
