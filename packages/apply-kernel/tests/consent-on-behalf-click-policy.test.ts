import { describe, expect, it } from 'vitest';

import { evaluateClickTarget, type ClickTargetFacts } from '../src/click/policy';

/**
 * 代填第三刀（2026-09-24）——点击当下的那道闸。
 *
 * 六类同意与前两刀同一套读法：标了类别、此刻读到的文字认得回来，才跳过「同意」「法律声明」两道分档
 * 拒绝；认不回来一律拒。绝对拒绝（提交、登录支付、验证码、密码、蜜罐……）一条不少。
 * ARIA 代理选项（Ashby 的是非按钮）另带题干：题干与选项各认一遍；代理题上的条款同意／属实声明一律拒；
 * 有表单归属、点了会提交的按钮照旧拒。
 */
const SMS = 'I agree to receive text messages from Acme about my application.';
const BACKGROUND =
  'We conduct thorough background checks as part of our hiring process. By selecting "Yes," you acknowledge and consent to a background check if you receive an offer.';

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

describe('勾选框与单选成员', () => {
  it('没有标记 → 照旧按「同意」拒', () => {
    expect(evaluateClickTarget(member(SMS))).toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it('标了 SMS_CONSENT、文字仍是短信同意 → 放行', () => {
    expect(evaluateClickTarget(member(SMS, { signOnBehalf: 'SMS_CONSENT' }))).toEqual({ allowed: true });
  });

  it.each([
    ['类别对不上（计划说营销，页面上是短信）', SMS, 'MARKETING_CONSENT'],
    ['类别对不上（计划说条款同意，页面上是短信）', SMS, 'TERMS_CONSENT'],
    ['文字换成了营销短信', 'I agree to receive marketing text messages from Acme.', 'SMS_CONSENT'],
    ['文字里混进联系现任雇主', 'I authorize a background check and contact with my current employer.', 'BACKGROUND_CHECK_CONSENT'],
  ] as const)('%s → 拒', (_why, label, kind) => {
    expect(evaluateClickTarget(member(label, { signOnBehalf: kind })).allowed).toBe(false);
  });

  it.each(['Yes', 'Opt in', 'I authorize', 'I understand'])('单选成员「%s」带同意类标记 → 放行', (label) => {
    expect(evaluateClickTarget(member(label, { choiceControl: 'radio', inputType: 'radio', signOnBehalf: 'BACKGROUND_CHECK_CONSENT' })))
      .toEqual({ allowed: true });
  });

  it('「Opt in」只对同意类算肯定回答：带条款同意的标记 → 拒', () => {
    expect(evaluateClickTarget(member('Opt in', { choiceControl: 'radio', inputType: 'radio', signOnBehalf: 'TERMS_CONSENT' })))
      .toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it.each(['No', 'Opt out', 'I do not consent'])('单选成员「%s」→ 拒', (label) => {
    expect(evaluateClickTarget(member(label, { choiceControl: 'radio', inputType: 'radio', signOnBehalf: 'SMS_CONSENT' })).allowed).toBe(false);
  });

  it('以动作名起头的同意句照旧按提交拒', () => {
    expect(evaluateClickTarget(member('Submit and agree to receive text messages', { signOnBehalf: 'SMS_CONSENT' })).allowed).toBe(false);
  });
});

describe('下拉：触发器与选项', () => {
  const trigger = (accessibleName: string, overrides: Partial<ClickTargetFacts> = {}) =>
    member(accessibleName, {
      kind: 'combobox-trigger', choiceControl: undefined, tagName: 'input', role: 'combobox', inputType: 'text',
      labelText: '', openedByTransaction: true, ...overrides,
    });
  const option = (label: string, overrides: Partial<ClickTargetFacts> = {}) =>
    member(label, {
      kind: 'transaction-option', choiceControl: undefined, tagName: 'div', role: 'option', inputType: undefined,
      accessibleName: '', labelText: label, openedByTransaction: true, ...overrides,
    });

  it('题面是仲裁的标题 → 触发器放行（只对同一类）', () => {
    expect(evaluateClickTarget(trigger('Agreement to Arbitrate', { signOnBehalf: 'ARBITRATION_AGREEMENT' }))).toEqual({ allowed: true });
    expect(evaluateClickTarget(trigger('Agreement to Arbitrate', { signOnBehalf: 'BACKGROUND_CHECK_CONSENT' })).allowed).toBe(false);
    expect(evaluateClickTarget(trigger('Agreement to Arbitrate', { signOnBehalf: 'TERMS_CONSENT' })).allowed).toBe(false);
  });

  it('没有标记：仲裁题的触发器照旧拒', () => {
    expect(evaluateClickTarget(trigger('Agreement to Arbitrate')).allowed).toBe(false);
  });

  it('选项本身是那一句同意 → 放行；换成别的授权 → 拒', () => {
    const statement = 'I understand and agree to the terms of the Agreement to Arbitrate set forth above.';
    expect(evaluateClickTarget(option(statement, { signOnBehalf: 'ARBITRATION_AGREEMENT' }))).toEqual({ allowed: true });
    expect(evaluateClickTarget(option('I agree to arbitration and to a background check.', { signOnBehalf: 'ARBITRATION_AGREEMENT' })).allowed)
      .toBe(false);
  });
});

describe('ARIA 代理选项', () => {
  function proxy(overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
    return {
      withinFormRoot: true,
      insideHtmlForm: false,
      kind: 'proxy-option',
      planned: true,
      openedByTransaction: false,
      tagName: 'BUTTON',
      role: undefined,
      inputType: undefined,
      buttonType: '',
      accessibleName: 'YesNo',
      labelText: 'Yes',
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
      signOnBehalf: 'BACKGROUND_CHECK_CONSENT',
      signingQuestion: BACKGROUND,
      ...overrides,
    };
  }

  it('Ashby：题干是背景调查、选项是 Yes → 放行', () => {
    expect(evaluateClickTarget(proxy())).toEqual({ allowed: true });
  });

  it('没有题干（读不到或不在表单根里，采集器给空串）→ 拒', () => {
    expect(evaluateClickTarget(proxy({ signingQuestion: '' }))).toEqual({ allowed: false, reason: 'CONSENT' });
    const { signingQuestion: _dropped, ...withoutQuestion } = proxy();
    expect(evaluateClickTarget(withoutQuestion)).toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it.each([
    ['题干被换成联系现任雇主', { signingQuestion: 'Do you consent to a background check, including contacting your current employer?' }],
    ['题干被换成别的一类', { signingQuestion: 'Do you consent to receive text messages about your application?' }],
    ['选项是 No', { labelText: 'No' }],
    ['题干只是标题、选项是 Yes', { signingQuestion: 'Background Check' }],
    ['代理题上的条款同意', { signOnBehalf: 'TERMS_CONSENT', signingQuestion: 'Do you agree to the Acme Terms of Service and Privacy Policy?' }],
  ] as const)('%s → 拒', (_why, overrides) => {
    expect(evaluateClickTarget(proxy(overrides as Partial<ClickTargetFacts>)).allowed).toBe(false);
  });

  it('防提交照旧：有表单归属、点了会提交的按钮 → SUBMIT_CONTROL；在表单里没写 type → IMPLICIT_SUBMIT_BUTTON', () => {
    expect(evaluateClickTarget(proxy({ formSubmitCapable: true }))).toEqual({ allowed: false, reason: 'SUBMIT_CONTROL' });
    expect(evaluateClickTarget(proxy({ insideHtmlForm: true }))).toEqual({ allowed: false, reason: 'IMPLICIT_SUBMIT_BUTTON' });
  });

  it('可读名里带着会被当成提交的动作名 → 照旧拒', () => {
    expect(evaluateClickTarget(proxy({ accessibleName: 'Submit application' })).allowed).toBe(false);
  });

  it('Workable 形状：role=radio、可读名是「题干 + 选项」→ 放行', () => {
    const question = 'Do you consent to a background check?';
    expect(evaluateClickTarget(proxy({
      tagName: 'DIV', role: 'radio', buttonType: null, proxyState: 'aria-checked', proxyCarrier: 'radio',
      accessibleName: `${question} YES`, labelText: 'YES', signingQuestion: question,
    }))).toEqual({ allowed: true });
  });

  it('单个 role=checkbox：选项自己没有字，题干就是那一句同意 → 放行；题干只是标题 → 拒', () => {
    const statement = 'I would like to be contacted about future job opportunities at Acme.';
    const lone = { tagName: 'DIV', role: 'checkbox', buttonType: null, proxyState: 'aria-checked', proxyCarrier: 'checkbox', labelText: '' } as const;
    expect(evaluateClickTarget(proxy({ ...lone, accessibleName: statement, signingQuestion: statement, signOnBehalf: 'FUTURE_CONTACT_CONSENT' })))
      .toEqual({ allowed: true });
    expect(evaluateClickTarget(proxy({ ...lone, accessibleName: 'Talent Community', signingQuestion: 'Talent Community', signOnBehalf: 'FUTURE_CONTACT_CONSENT' })).allowed)
      .toBe(false);
  });
});
