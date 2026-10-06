import { describe, expect, it } from 'vitest';

import { REQUIRED_FACTS_BY_KIND, evaluateClickTarget, type ClickTargetFacts } from '../src/click/policy';

/**
 * 账号墙上的那几颗（2026-09-28）走自己的一张表：放行的正是通用判定一律拒的东西（「Sign in」「Create Account」、
 * `type=submit`、「I agree」），所以每一条绝对拒绝在这张表里重新写了一遍。这里逐条证明它们一条都没省。
 */

type Role = NonNullable<ClickTargetFacts['declaredAccountControl']>;

function facts(role: Role, overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
  const shape: Partial<ClickTargetFacts> =
    role === 'terms'
      ? { tagName: 'INPUT', inputType: 'checkbox', buttonType: null, accessibleName: 'I agree', labelText: '', insideHtmlForm: true }
      : role === 'submit'
        ? { tagName: 'DIV', role: 'button', inputType: undefined, buttonType: null, accessibleName: 'Create Account', labelText: '', insideHtmlForm: true }
        : { tagName: 'BUTTON', inputType: undefined, buttonType: '', accessibleName: 'Sign in with email', labelText: 'Sign in with email', insideHtmlForm: false };
  return {
    withinFormRoot: true,
    kind: 'account-control',
    planned: true,
    openedByTransaction: false,
    declaredAccountControl: role,
    isHidden: false,
    isDisabled: false,
    isLikelyOffscreen: false,
    isLikelyHoneyPot: false,
    inPasswordContainer: false,
    inCaptcha: false,
    opensFileDialog: false,
    hasHref: false,
    hrefNavigates: false,
    ...shape,
    ...overrides,
  } as ClickTargetFacts;
}

describe('放行的只有这几种形状', () => {
  it.each(['submit', 'useEmail', 'toSignIn', 'toCreateAccount', 'terms'] as const)('%s', (role) => {
    expect(evaluateClickTarget(facts(role))).toEqual({ allowed: true });
  });

  it('提交可以是 type=submit（iCIMS 的 Next）', () => {
    expect(evaluateClickTarget(facts('submit', { tagName: 'INPUT', role: undefined, inputType: 'submit', accessibleName: 'Next' })))
      .toEqual({ allowed: true });
  });

  it('同样的「登录」「提交」换成通用种类，照旧一律拒——账号墙那张表不借给别人', () => {
    const signIn = facts('submit', { accessibleName: 'Sign In', labelText: 'Sign In' });
    const next = facts('submit', { tagName: 'INPUT', role: undefined, inputType: 'submit', accessibleName: 'Next' });
    for (const kind of ['combobox-trigger', 'choice-proxy', 'transaction-option', 'other'] as const) {
      expect(evaluateClickTarget({ ...signIn, kind }).allowed, `${kind} 放行了 Sign In`).toBe(false);
      expect(evaluateClickTarget({ ...next, kind }).allowed, `${kind} 放行了 type=submit`).toBe(false);
    }
  });
});

describe('必备事实缺一项就拒', () => {
  it('逐项删除', () => {
    for (const fact of REQUIRED_FACTS_BY_KIND['account-control']) {
      const incomplete = { ...facts('submit') };
      delete (incomplete as unknown as Record<string, unknown>)[fact];
      expect(evaluateClickTarget(incomplete), `漏掉 ${String(fact)} 却放行了`).toEqual({ allowed: false, reason: 'INCOMPLETE_FACTS' });
    }
    expect(REQUIRED_FACTS_BY_KIND['account-control']).toContain('declaredAccountControl');
  });

  it('不在账号墙里：先按 OUTSIDE_FORM 报', () => {
    expect(evaluateClickTarget(facts('submit', { withinFormRoot: false }))).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
  });
});

describe('每一条绝对拒绝都还在', () => {
  it.each([
    ['隐藏', { isHidden: true }, 'HIDDEN_CONTROL'],
    ['禁用（iCIMS 的 Next 勾上条款之前）', { isDisabled: true }, 'HIDDEN_CONTROL'],
    ['离屏', { isLikelyOffscreen: true }, 'HIDDEN_CONTROL'],
    ['在验证码里', { inCaptcha: true }, 'CAPTCHA'],
    ['蜜罐', { isLikelyHoneyPot: true }, 'HONEYPOT'],
    ['密码部件里的东西', { inPasswordContainer: true }, 'PASSWORD'],
    ['会导航的链接', { tagName: 'A', hasHref: true, hrefNavigates: true }, 'LINK'],
    ['role=link', { role: 'link' }, 'LINK'],
    ['文件框', { opensFileDialog: true }, 'FILE_CONTROL'],
    ['一次性验证码', { accessibleName: 'Send verification code' }, 'OTP_OR_VERIFICATION'],
    ['付款', { accessibleName: 'Continue to payment' }, 'LOGIN_OR_PAYMENT'],
    ['像是交申请', { accessibleName: 'Submit application' }, 'SUBMIT_NAME'],
    ['Apply now', { accessibleName: 'Apply now' }, 'SUBMIT_NAME'],
    ['不在计划里', { planned: false }, 'NOT_PLANNED'],
  ] as const)('%s → %s', (_why, overrides, reason) => {
    expect(evaluateClickTarget(facts('submit', overrides as Partial<ClickTargetFacts>))).toEqual({ allowed: false, reason });
  });

  it('重置按钮', () => {
    expect(evaluateClickTarget(facts('submit', { tagName: 'BUTTON', role: undefined, buttonType: 'reset' })))
      .toEqual({ allowed: false, reason: 'RESET_CONTROL' });
  });

  it('密码框本身永远不点', () => {
    expect(evaluateClickTarget(facts('submit', { tagName: 'INPUT', role: undefined, inputType: 'password' })).allowed).toBe(false);
  });
});

describe('角色与形状要对上', () => {
  it('条款必须是勾选框', () => {
    expect(evaluateClickTarget(facts('terms', { tagName: 'BUTTON', inputType: undefined, buttonType: 'button' })))
      .toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
  });

  it.each([
    'I agree to receive marketing emails',
    'Subscribe me to job alerts',
    'I agree to join the talent community',
    'I consent to receive text messages (SMS)',
    'I authorize a background check',
    'I agree to binding arbitration and waive my right to a jury trial',
  ])('条款的字里掺了注册之外的授权：「%s」→ CONSENT', (text) => {
    expect(evaluateClickTarget(facts('terms', { accessibleName: text }))).toEqual({ allowed: false, reason: 'CONSENT' });
  });

  it('「I accept」（iCIMS 的隐私政策）照放行', () => {
    expect(evaluateClickTarget(facts('terms', { accessibleName: 'I accept' }))).toEqual({ allowed: true });
  });

  it('切换视图的那几颗不许是表单里的提交按钮', () => {
    expect(evaluateClickTarget(facts('toSignIn', { buttonType: 'submit' }))).toEqual({ allowed: false, reason: 'SUBMIT_CONTROL' });
    expect(evaluateClickTarget(facts('useEmail', { insideHtmlForm: true, buttonType: '' })))
      .toEqual({ allowed: false, reason: 'IMPLICIT_SUBMIT_BUTTON' });
  });

  it('除了条款，别的角色的名字不许像同意或法律声明', () => {
    expect(evaluateClickTarget(facts('submit', { accessibleName: 'I agree and continue' }))).toEqual({ allowed: false, reason: 'CONSENT' });
    expect(evaluateClickTarget(facts('toCreateAccount', { accessibleName: 'I certify', labelText: 'I certify' })))
      .toEqual({ allowed: false, reason: 'LEGAL_DECLARATION' });
  });

  it('文本框不是按钮', () => {
    expect(evaluateClickTarget(facts('submit', { tagName: 'INPUT', role: undefined, inputType: 'text' })))
      .toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
  });
});
