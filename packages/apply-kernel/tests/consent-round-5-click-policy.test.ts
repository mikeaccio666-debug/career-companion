import { describe, expect, it } from 'vitest';

import { evaluateClickTarget, evaluateUnsignedClickTarget, type ClickTargetFacts } from '../src/click/policy';

/**
 * 代填第五刀（2026-09-28）——点击当下的那道闸。
 *
 * 新类别与前几刀同一套读法：标了类别、此刻读到的文字认得回来，才跳过「同意」「法律声明」两道分档拒绝；认不回来一律拒。
 * 核实所填信息放行了，所以认得回来的那一句按整句读验证码一类（verification code、verify your email、one-time、
 * passcode……照旧绝对拒绝），光秃秃的 verify 不再一刀切；认不回来的文字照旧整段判。
 * 能不能联系雇主：方向写在类别里，「不可以」那一向只认否定回答，「可以」那一向只认肯定回答。
 */
function member(label: string, overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
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

const radio = (label: string, overrides: Partial<ClickTargetFacts> = {}) =>
  member(label, { choiceControl: 'radio', inputType: 'radio', ...overrides });

const VERIFY = 'I authorize Acme to verify my education and employment history.';

describe('核实所填信息：认得回来的那一句按整句读验证码一类', () => {
  it('标了 INFORMATION_VERIFICATION、文字仍是核实同意 → 放行', () => {
    expect(evaluateClickTarget(member(VERIFY, { signOnBehalf: 'INFORMATION_VERIFICATION' }))).toEqual({ allowed: true });
  });

  it('没有标记 → 照旧按验证码一类整段拒', () => {
    expect(evaluateClickTarget(member(VERIFY))).toEqual({ allowed: false, reason: 'OTP_OR_VERIFICATION' });
  });

  it('扫描那一半的入口（不带判据）：带着标记也拒', () => {
    expect(evaluateUnsignedClickTarget(member(VERIFY, { signOnBehalf: 'INFORMATION_VERIFICATION' })).allowed).toBe(false);
  });

  it.each([
    'I agree to verify my email address with a one-time code.',
    'I consent to receive a verification code by text message.',
    'I authorize Acme to verify my education. Enter the passcode we sent you.',
  ])('验证码一类照旧绝对拒绝：%s', (label) => {
    expect(evaluateClickTarget(member(label, { signOnBehalf: 'INFORMATION_VERIFICATION' }))).toEqual({ allowed: false, reason: 'OTP_OR_VERIFICATION' });
  });

  it('认不回来的那一段（可读名换成了验证码）照旧整段拒', () => {
    expect(evaluateClickTarget(member(VERIFY, { accessibleName: 'Verify', signOnBehalf: 'INFORMATION_VERIFICATION' })))
      .toEqual({ allowed: false, reason: 'OTP_OR_VERIFICATION' });
  });

  it('类别对不上（计划说信用调查，页面上是核实）→ 拒', () => {
    expect(evaluateClickTarget(member(VERIFY, { signOnBehalf: 'SCREENING_CONSENT' })).allowed).toBe(false);
  });
});

describe('新类别的勾选框与单选成员', () => {
  it.each([
    ['SCREENING_CONSENT', 'I authorize Acme to obtain a credit report as part of my application.'],
    ['AT_WILL_ACKNOWLEDGEMENT', 'I understand that my employment will be at-will and that this application is not a contract of employment.'],
    ['CALL_NOTIFICATION_CONSENT', 'I agree to receive text messages and phone calls about my application.'],
    ['COMBINED_CONSENT', 'I consent to a background check and agree to binding arbitration.'],
    ['PRIVACY_NOTICE_TITLE', 'Applicant Privacy Notice'],
  ] as const)('%s ← %s → 放行', (kind, label) => {
    expect(evaluateClickTarget(member(label, { signOnBehalf: kind }))).toEqual({ allowed: true });
  });

  it('信用调查的是非题：Yes 放行，No 拒', () => {
    expect(evaluateClickTarget(radio('Yes', { signOnBehalf: 'SCREENING_CONSENT' }))).toEqual({ allowed: true });
    expect(evaluateClickTarget(radio('No', { signOnBehalf: 'SCREENING_CONSENT' })).allowed).toBe(false);
  });

  it.each([
    ['文字换成了营销分享', 'I consent to Acme sharing my information with its partners for marketing purposes.', 'RECRUITING_DATA_SHARING'],
    ['文字里混进免责', 'I authorize a background check and release Acme from any liability.', 'SCREENING_CONSENT'],
    ['文字换成了否定句', 'I do not consent to a credit check.', 'SCREENING_CONSENT'],
    ['文字换成了营销电话', 'I agree to receive marketing calls from Acme.', 'CALL_NOTIFICATION_CONSENT'],
  ] as const)('%s → 拒', (_why, label, kind) => {
    expect(evaluateClickTarget(member(label, { signOnBehalf: kind })).allowed).toBe(false);
  });

  it('以动作名起头的同意句照旧按提交拒', () => {
    expect(evaluateClickTarget(member('Submit to a drug test and agree to a credit check', { signOnBehalf: 'SCREENING_CONSENT' })).allowed).toBe(false);
  });
});

describe('能不能联系雇主：方向写在类别里', () => {
  const ASK = 'May we contact your current employer?';

  it('「不可以」：No 放行，Yes 拒', () => {
    expect(evaluateClickTarget(radio('No', { signOnBehalf: 'EMPLOYER_CONTACT_NO' }))).toEqual({ allowed: true });
    expect(evaluateClickTarget(radio('Yes', { signOnBehalf: 'EMPLOYER_CONTACT_NO' })).allowed).toBe(false);
  });

  it('「不可以」：一句正面许可的选项永远不算「不可以」的依据', () => {
    expect(evaluateClickTarget(radio('Yes, you may contact my current employer', { signOnBehalf: 'EMPLOYER_CONTACT_NO' })).allowed).toBe(false);
  });

  it('「可以」：Yes 与正面许可的整句放行，No 拒', () => {
    expect(evaluateClickTarget(radio('Yes', { signOnBehalf: 'EMPLOYER_CONTACT_YES' }))).toEqual({ allowed: true });
    expect(evaluateClickTarget(member('I authorize Acme to contact my current employer.', { signOnBehalf: 'EMPLOYER_CONTACT_YES' })))
      .toEqual({ allowed: true });
    expect(evaluateClickTarget(radio('No', { signOnBehalf: 'EMPLOYER_CONTACT_YES' })).allowed).toBe(false);
  });

  it('勾选框的话换成了「请不要联系」→ 拒', () => {
    expect(evaluateClickTarget(member('Please do not contact my current employer.', { signOnBehalf: 'EMPLOYER_CONTACT_YES' })).allowed).toBe(false);
  });

  it('下拉触发器：题面认得回来（同一个对象）才放行', () => {
    const trigger = (accessibleName: string, kind: ClickTargetFacts['signOnBehalf']) =>
      member(accessibleName, {
        kind: 'combobox-trigger', choiceControl: undefined, tagName: 'input', role: 'combobox', inputType: 'text',
        labelText: '', openedByTransaction: true, signOnBehalf: kind,
      });
    expect(evaluateClickTarget(trigger(ASK, 'EMPLOYER_CONTACT_NO'))).toEqual({ allowed: true });
    expect(evaluateClickTarget(trigger('May we contact your references?', 'EMPLOYER_CONTACT_NO')).allowed).toBe(false);
    expect(evaluateClickTarget(trigger(ASK, 'REFERENCE_CONTACT_NO')).allowed).toBe(false);
  });

  it('ARIA 代理选项（Ashby）：题干是这一问、选项与方向对得上才放行', () => {
    const proxy = (labelText: string, kind: ClickTargetFacts['signOnBehalf'], signingQuestion = ASK): ClickTargetFacts => ({
      withinFormRoot: true,
      insideHtmlForm: false,
      kind: 'proxy-option',
      planned: true,
      openedByTransaction: false,
      tagName: 'BUTTON',
      buttonType: '',
      accessibleName: 'YesNo',
      labelText,
      isHidden: false,
      isDisabled: false,
      isLikelyOffscreen: false,
      isLikelyHoneyPot: false,
      inPasswordContainer: false,
      inCaptcha: false,
      opensFileDialog: false,
      hasHref: false,
      hrefNavigates: false,
      proxyState: 'aria-pressed',
      formSubmitCapable: false,
      proxyCarrier: 'none',
      signOnBehalf: kind,
      signingQuestion,
    });
    expect(evaluateClickTarget(proxy('No', 'EMPLOYER_CONTACT_NO'))).toEqual({ allowed: true });
    expect(evaluateClickTarget(proxy('Yes', 'EMPLOYER_CONTACT_NO')).allowed).toBe(false);
    expect(evaluateClickTarget(proxy('No', 'EMPLOYER_CONTACT_NO', 'May we contact your current employer and run a background check?')).allowed)
      .toBe(false);
  });
});
