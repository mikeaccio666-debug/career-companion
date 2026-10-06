import { describe, expect, it } from 'vitest';

import { evaluateClickTarget, type ClickTargetFacts } from '../src/click/policy';

/**
 * 代填的目标在点击当下的那道闸（2026-09-23；第二刀扩到单选与下拉）。
 *
 * 计划里标了类别（signOnBehalf）、点击当下重新读到的文字认得回来，才跳过「同意」「法律声明」两道
 * 分档拒绝；带着标记却一段都认不回来，一律拒。认得回来的那一句按整句读提交与登录两条名字判据，
 * 其余绝对拒绝一条不少。
 */
const TERMS = 'By selecting the checkbox, you agree to our Terms and Conditions and Applicant Privacy Policy.';
const ATTEST = 'I certify that the information provided in this application is true and complete.';

function checkbox(label: string, overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
  return {
    withinFormRoot: true,
    insideHtmlForm: true,
    kind: 'choice-member',
    choiceControl: 'checkbox',
    planned: true,
    openedByTransaction: false,
    tagName: 'input',
    inputType: 'checkbox',
    buttonType: null,
    accessibleName: label,
    labelText: label,
    isHidden: false,
    isDisabled: false,
    isLikelyOffscreen: false,
    isLikelyHoneyPot: false,
    inPasswordContainer: false,
    inCaptcha: false,
    opensFileDialog: false,
    hasHref: false,
    hrefNavigates: false,
    ...overrides,
  } as ClickTargetFacts;
}

describe('代填的勾选框', () => {
  it('没有代填标记 → 照旧按「同意」拒', () => {
    expect(evaluateClickTarget(checkbox(TERMS))).toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it('标了 TERMS_CONSENT、文字仍是条款同意 → 放行', () => {
    expect(evaluateClickTarget(checkbox(TERMS, { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: true });
  });

  it('标了 TRUTH_ATTESTATION、文字仍是属实声明（无障碍名与标签是同一句）→ 放行', () => {
    expect(evaluateClickTarget(checkbox(ATTEST, { signOnBehalf: 'TRUTH_ATTESTATION' }))).toEqual({ allowed: true });
  });

  it('文字变成了营销（页面在计划之后改了）→ 拒', () => {
    const marketing = 'I agree to receive marketing emails and accept the Privacy Policy';
    expect(evaluateClickTarget(checkbox(marketing, { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it('两段文字里有一段不是这一类 → 拒', () => {
    expect(evaluateClickTarget(checkbox(TERMS, { labelText: 'I agree to receive text messages', signOnBehalf: 'TERMS_CONSENT' })).allowed).toBe(false);
  });

  it('类别对不上（计划说属实声明，页面上是条款同意）→ 拒', () => {
    expect(evaluateClickTarget(checkbox(TERMS, { signOnBehalf: 'TRUTH_ATTESTATION' })).allowed).toBe(false);
  });

  it('别的种类带着标记（choice-label）→ 拒', () => {
    expect(evaluateClickTarget(checkbox(TERMS, { kind: 'choice-label', tagName: 'label', inputType: undefined, signOnBehalf: 'TERMS_CONSENT' }))).toEqual({
      allowed: false,
      reason: 'CONSENT',
    });
  });

  it('带着标记、文字却变成了不像同意的别的话 → 拒（普通判据会放行它）', () => {
    expect(evaluateClickTarget(checkbox('Remember me'))).toEqual({ allowed: true });
    expect(evaluateClickTarget(checkbox('Remember me', { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: false, reason: 'CONSENT' });
  });
});

describe('认得回来的那一句按整句读（第二刀）', () => {
  it.each([
    ['TERMS_CONSENT', 'By clicking submit, you agree to the Terms and Conditions'],
    ['TERMS_CONSENT', 'By submitting this form, you agree to our Terms of Use and Privacy Policy.'],
    ['TRUTH_ATTESTATION', 'By submitting this application, I certify that the information provided is true and complete.'],
    ['TRUTH_ATTESTATION', 'By signing below, I confirm that all information I have provided is accurate.'],
    ['TRUTH_ATTESTATION', 'I certify that all information submitted is true and complete.'],
  ] as const)('%s：%s → 放行', (kind, label) => {
    expect(evaluateClickTarget(checkbox(label, { signOnBehalf: kind }))).toEqual({ allowed: true });
  });

  it.each([
    ['以动作名起头', 'Submit my application and agree to the Terms and Conditions', 'SUBMIT_NAME'],
    ['星号后面以动作名起头', '* Submit and agree to the Terms and Conditions', 'SUBMIT_NAME'],
    ['登录', 'By signing in, you agree to the Terms of Service', 'LOGIN_OR_PAYMENT'],
    ['验证', 'I agree to the Terms and Conditions and to verify my identity', 'OTP_OR_VERIFICATION'],
  ] as const)('%s → 照旧拒（%s）', (_why, label, reason) => {
    expect(evaluateClickTarget(checkbox(label, { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: false, reason });
  });
});

describe('单选成员', () => {
  const radio = (label: string, overrides: Partial<ClickTargetFacts> = {}) =>
    checkbox(label, { choiceControl: 'radio', inputType: 'radio', ...overrides });

  it.each(['I agree', 'Yes', 'Acknowledge/Confirm', TERMS])('带标记的「%s」→ 放行', (label) => {
    expect(evaluateClickTarget(radio(label, { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: true });
  });

  it('没有标记的「I agree」→ 照旧按「同意」拒', () => {
    expect(evaluateClickTarget(radio('I agree'))).toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it.each(['No', 'I do not agree', 'Yes, and add me to your talent community'])('带标记的「%s」→ 拒', (label) => {
    expect(evaluateClickTarget(radio(label, { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: false, reason: 'CONSENT' });
  });
});

describe('下拉：触发器与选项', () => {
  const QUESTION =
    "Do you consent to Acme processing your personal information for the purpose of assessing your candidacy in accordance with Acme's Applicant Privacy Policy?";
  const trigger = (accessibleName: string, labelText: string, overrides: Partial<ClickTargetFacts> = {}) =>
    checkbox(accessibleName, {
      kind: 'combobox-trigger',
      choiceControl: undefined,
      tagName: 'input',
      role: 'combobox',
      inputType: 'text',
      labelText,
      openedByTransaction: true,
      ...overrides,
    });
  const option = (label: string, overrides: Partial<ClickTargetFacts> = {}) =>
    checkbox(label, {
      kind: 'transaction-option',
      choiceControl: undefined,
      tagName: 'div',
      role: 'option',
      inputType: undefined,
      accessibleName: '',
      labelText: label,
      openedByTransaction: true,
      ...overrides,
    });

  it('没有标记：题面带 consent → 触发器按「同意」拒（从前 Greenhouse 这一类必填题就停在这里）', () => {
    expect(evaluateClickTarget(trigger(QUESTION, ''))).toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it('带标记、题面认得回来 → 触发器放行', () => {
    expect(evaluateClickTarget(trigger(QUESTION, '', { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: true });
  });

  it('按钮式下拉：题面认得回来、按钮上显示的是「Select One」→ 放行；显示的是一句营销同意 → 拒', () => {
    expect(evaluateClickTarget(trigger(QUESTION, 'Select One', { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: true });
    expect(evaluateClickTarget(trigger(QUESTION, 'I agree to receive marketing emails', { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({
      allowed: false,
      reason: 'CONSENT',
    });
  });

  it('触发器上只有「Yes」：肯定回答在触发器上不算数 → 拒', () => {
    expect(evaluateClickTarget(trigger('Yes', '', { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it.each(['Consent', 'I agree', 'Acknowledge/Confirm', 'Yes'])('带标记的选项「%s」→ 放行', (label) => {
    expect(evaluateClickTarget(option(label, { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: true });
  });

  it('前缀撞中「Yes, and add me to your talent community」：没有标记时普通判据会放行，带标记 → 拒', () => {
    const label = 'Yes, and add me to your talent community';
    expect(evaluateClickTarget(option(label))).toEqual({ allowed: true });
    expect(evaluateClickTarget(option(label, { signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it('没进计划的框，带着标记也不放行 → NOT_PLANNED', () => {
    expect(evaluateClickTarget(checkbox(TERMS, { planned: false, signOnBehalf: 'TERMS_CONSENT' }))).toEqual({ allowed: false, reason: 'NOT_PLANNED' });
  });
});
