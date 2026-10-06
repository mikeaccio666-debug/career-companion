import { describe, expect, it } from 'vitest';

import {
  evaluateClickTarget,
  type ClickTargetFacts,
} from '../src/click/policy';

function target(overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
  return {
    withinFormRoot: true,
    insideHtmlForm: true,
    kind: 'combobox-trigger',
    planned: true,
    openedByTransaction: false,
    tagName: 'div',
    // 这套「全给齐」的底座是 `REQUIRED_FACTS_BY_KIND` 那道闸逼出来的：
    // 缺席的事实是 `undefined`，等于对应的 deny **这次不跑**。测试也不例外——
    // 一份手搓的偏食事实集会让被测的策略比真实执行时宽松，那种绿是假的。
    buttonType: null,
    accessibleName: '',
    labelText: '',
    isHidden: false,
    isDisabled: false,
    isLikelyOffscreen: false,
    isLikelyHoneyPot: false,
    inPasswordContainer: false,
    inCaptcha: false,
    opensFileDialog: false,
    hasHref: false,
    // 底座取「会导航」： 时它无关紧要，而一旦某条用例把
    //  打开，默认就该落在 fail-closed 那一侧。
    hrefNavigates: true,
    ...overrides,
  };
}

describe('apply click policy', () => {
  it.each([
    ['计划内 combobox trigger', target()],
    [
      '本事务新开的 option',
      target({ kind: 'transaction-option', openedByTransaction: true, role: 'option' }),
    ],
    [
      '计划内 radio/checkbox label',
      target({ kind: 'choice-label', choiceControl: 'radio', tagName: 'label' }),
    ],
    [
      '计划内可视 choice proxy',
      target({ kind: 'choice-proxy', choiceControl: 'checkbox', tagName: 'span' }),
    ],
    [
      '本事务新开的 datepicker cell',
      target({ kind: 'datepicker-cell', openedByTransaction: true, role: 'gridcell' }),
    ],
  ])('%s 是静态 allow 集的一员', (_name, facts) => {
    expect(evaluateClickTarget(facts)).toEqual({ allowed: true });
  });

  it.each([
    ['表单外目标', target({ withinFormRoot: false }), 'OUTSIDE_FORM'],
    ['非计划内控件', target({ planned: false }), 'NOT_PLANNED'],
    ['非本事务打开的选项', target({ kind: 'transaction-option', role: 'option' }), 'FOREIGN_TRANSACTION'],
    [
      '没有 option 语义的 transaction option',
      target({ kind: 'transaction-option', openedByTransaction: true, role: 'button' }),
      'UNSUPPORTED_TARGET',
    ],
    ['Submit 文案', target({ accessibleName: 'Submit application' }), 'SUBMIT_NAME'],
    ['Submit 文案的选项', target({ kind: 'transaction-option', openedByTransaction: true, role: 'option', labelText: 'Select all that apply' }), 'SUBMIT_NAME'],
    ['显式 submit 控件', target({ tagName: 'input', inputType: 'submit' }), 'SUBMIT_CONTROL'],
    ['image submit 控件', target({ tagName: 'input', inputType: 'image' }), 'SUBMIT_CONTROL'],
    ['form 内漏写 type 的 button', target({ tagName: 'button' }), 'IMPLICIT_SUBMIT_BUTTON'],
    ['文件控件', target({ tagName: 'input', inputType: 'file' }), 'FILE_CONTROL'],
    ['会打开文件选择器的代理', target({ opensFileDialog: true }), 'FILE_CONTROL'],
    ['链接', target({ tagName: 'a', hasHref: true }), 'LINK'],
    ['captcha 容器后代', target({ inCaptcha: true }), 'CAPTCHA'],
    ['订阅/同意文案', target({ accessibleName: 'I agree to receive updates' }), 'CONSENT'],
    ['法律声明', target({ accessibleName: 'I certify that this information is true' }), 'LEGAL_DECLARATION'],
    ['蜜罐文案', target({ labelText: 'Please leave this field blank' }), 'HONEYPOT'],
    ['离屏且无标签的 tabindex=-1 蜜罐', target({ isLikelyHoneyPot: true }), 'HONEYPOT'],
    ['密码字段', target({ accessibleName: 'Confirm password' }), 'PASSWORD'],
    ['无标签 password input', target({ tagName: 'input', inputType: 'password' }), 'PASSWORD'],
    ['密码容器内的控件', target({ inPasswordContainer: true }), 'PASSWORD'],
    ['一次性验证码', target({ accessibleName: 'One-time verification code' }), 'OTP_OR_VERIFICATION'],
    ['登录控件', target({ accessibleName: 'Sign in to continue' }), 'LOGIN_OR_PAYMENT'],
    ['支付控件', target({ accessibleName: 'Credit card payment' }), 'LOGIN_OR_PAYMENT'],
    ['隐藏 input', target({ tagName: 'input', inputType: 'hidden' }), 'HIDDEN_CONTROL'],
    ['aria-hidden 控件', target({ isHidden: true }), 'HIDDEN_CONTROL'],
    ['disabled 控件', target({ isDisabled: true }), 'HIDDEN_CONTROL'],
    ['离屏控件', target({ isLikelyOffscreen: true }), 'HIDDEN_CONTROL'],
    ['role=link 控件', target({ role: 'link' }), 'LINK'],
    ['reset 控件', target({ tagName: 'button', buttonType: 'reset' }), 'RESET_CONTROL'],
    ['没有 radio/checkbox 绑定的可视代理', target({ kind: 'choice-proxy' }), 'UNSUPPORTED_TARGET'],
  ] as const)('%s 必须拒绝', (_name, facts, reason) => {
    expect(evaluateClickTarget(facts)).toEqual({ allowed: false, reason });
  });
});

/**
 * Real Greenhouse job boards (2026-09-10): every multi-select question is labelled
 * "… (select all that apply)". A combobox trigger's accessible name is the question wording;
 * only a name that starts with an action word is submit-looking there. Options and buttons
 * keep the whole-text deny.
 */
describe('submit-name deny reads a combobox trigger as a question, not a button', () => {
  it.each([
    'Which of these have you worked with? (select all that apply)',
    'Are you authorized to work in the United States for the next five years?',
  ])('allows the trigger %s', (accessibleName) => {
    expect(evaluateClickTarget(target({ accessibleName }))).toEqual({ allowed: true });
  });
  it.each(['Apply now', 'Next'])('still denies a trigger named %s', (accessibleName) => {
    expect(evaluateClickTarget(target({ accessibleName }))).toEqual({ allowed: false, reason: 'SUBMIT_NAME' });
  });
  // Independent review of #320: a Latin word boundary never follows a CJK character, so the
  // Chinese action words fell out of the trigger deny entirely instead of being narrowed.
  it.each(['提交', '提交申请', '申请', '下一步', '上一步', '保存并继续'])('still denies a trigger named %s', (accessibleName) => {
    expect(evaluateClickTarget(target({ accessibleName }))).toEqual({ allowed: false, reason: 'SUBMIT_NAME' });
  });
});
