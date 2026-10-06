import { describe, expect, it } from 'vitest';

import {
  REQUIRED_FACTS_BY_KIND,
  evaluateClickTarget,
  type ClickTargetFacts,
  type ClickTargetKind,
} from '../../src/click/policy';

/**
 * 事实没给全 ⇒ 不许点（2026-08-23）。
 *
 * ## 病根
 *
 * `ClickTargetFacts` 除 6 个必填项外**全是 optional**，而 deny 规则读的正是
 * 那些 optional 项：
 *
 * ```ts
 * if (facts.isHidden || facts.isDisabled || facts.isLikelyOffscreen …) HIDDEN_CONTROL
 * if (facts.inCaptcha) CAPTCHA
 * if (facts.inPasswordContainer …) PASSWORD
 * ```
 *
 * `undefined` 是 falsy，所以**一个没被填上的事实 = 那条 deny 这次不跑**，
 * 而且完全静默——策略表读起来像是全副武装，实际执行时可能只有一半。
 *
 * 实测：`click/combobox.ts` 的 `triggerFacts` 只给了 10 项，漏掉
 * `isHidden` / `isLikelyOffscreen` / `isLikelyHoneyPot` / `inPasswordContainer` /
 * `inCaptcha` / `opensFileDialog` / `hasHref` / `hrefNavigates` / `buttonType` /
 * `labelText` 十项。也就是说今天一个**隐藏的**下拉触发器是点得动的。
 *
 * ## 修法
 *
 * 把「事实齐全」做成**放行前置**，而不是靠每个事实构造器的作者记住。
 * 缺一项就是 `INCOMPLETE_FACTS`，连 `pointerdown` 都不发。
 *
 * 这条闸必须排在既有 deny **之前**：一条读到 `undefined` 的 deny 等于没跑，
 * 得先证明它读得到东西，再让它跑。
 */

function complete(overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
  return {
    withinFormRoot: true,
    insideHtmlForm: true,
    kind: 'combobox-trigger',
    planned: true,
    openedByTransaction: false,
    tagName: 'input',
    role: undefined,
    inputType: 'text',
    buttonType: null,
    accessibleName: 'Country',
    labelText: 'Country',
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
  };
}

describe('必备事实齐全才可能放行', () => {
  it('齐全的 combobox 触发器照常放行', () => {
    expect(evaluateClickTarget(complete())).toEqual({ allowed: true });
  });

  it('少任何一项必备事实都拒——逐项证明，不是抽查', () => {
    for (const fact of REQUIRED_FACTS_BY_KIND['combobox-trigger']) {
      const facts = { ...complete() };
      delete (facts as unknown as Record<string, unknown>)[fact];
      expect(evaluateClickTarget(facts), `漏掉 ${String(fact)} 却放行了`).toEqual({
        allowed: false,
        reason: 'INCOMPLETE_FACTS',
      });
    }
  });

  /**
   * `choice-member`（2026-09-15 新增）尤其不能例外。
   *
   * 它是**全仓唯一一处不预先 `preventDefault` 的宿主点击**（原生激活，见
   * click/primitives.ts 的 `activateReviewedChoiceGroup`），也就是唯一一处
   * 浏览器默认动作真的会跑的点击。事实缺一项在别的种类上是「少跑一条 deny」，
   * 在这里是「少跑一条 deny，而且默认动作照常执行」。
   */
  it('choice-member 同样受这道闸约束，且必须是 input + type 逐字对上', () => {
    const base = complete({
      kind: 'choice-member',
      tagName: 'input',
      inputType: 'checkbox',
      choiceControl: 'checkbox',
      buttonType: null,
      accessibleName: 'LinkedIn',
      labelText: 'LinkedIn',
    });
    expect(evaluateClickTarget(base)).toEqual({ allowed: true });
    for (const fact of REQUIRED_FACTS_BY_KIND['choice-member']) {
      const facts = { ...base };
      delete (facts as unknown as Record<string, unknown>)[fact];
      expect(evaluateClickTarget(facts), `choice-member 漏掉 ${String(fact)} 却放行了`).toEqual({
        allowed: false,
        reason: 'INCOMPLETE_FACTS',
      });
    }
    // 目标必须就是那个选项控件本身，不是任何一个「绑到它上面」的代理。
    expect(evaluateClickTarget({ ...base, tagName: 'span' })).toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    expect(evaluateClickTarget({ ...base, inputType: 'text' })).toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    expect(evaluateClickTarget({ ...base, inputType: 'radio' }), 'type 与已审阅的控件种类不一致')
      .toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
    const { choiceControl: _dropped, ...withoutControl } = base;
    expect(evaluateClickTarget(withoutControl)).toEqual({ allowed: false, reason: 'UNSUPPORTED_TARGET' });
  });

  it('行动作三种同样受这道闸约束', () => {
    for (const kind of ['row-add', 'row-save', 'row-remove'] as const) {
      const action = kind.slice(4) as 'add' | 'save' | 'remove';
      const base = complete({ kind, tagName: 'button', buttonType: 'button', inputType: undefined, declaredRowAction: action, accessibleName: 'Add row', labelText: 'Add row' });
      expect(evaluateClickTarget(base)).toEqual({ allowed: true });
      for (const fact of REQUIRED_FACTS_BY_KIND[kind]) {
        const facts = { ...base };
        delete (facts as unknown as Record<string, unknown>)[fact];
        expect(evaluateClickTarget(facts), `${kind} 漏掉 ${String(fact)} 却放行了`).toEqual({
          allowed: false,
          reason: 'INCOMPLETE_FACTS',
        });
      }
    }
  });
});

describe('这道闸的位置与范围', () => {
  it('排在 withinFormRoot 之后——表单外的目标先按 OUTSIDE_FORM 报', () => {
    // 「不在我们认的表单里」比「事实没给全」更根本，也更好懂。
    const facts = complete({ withinFormRoot: false });
    delete (facts as unknown as Record<string, unknown>).isHidden;
    expect(evaluateClickTarget(facts)).toEqual({ allowed: false, reason: 'OUTSIDE_FORM' });
  });

  it('排在既有 deny 之前——一条读到 undefined 的 deny 等于没跑', () => {
    // 若齐全性闸排在后面，这个漏了 isHidden 的目标会先通过 HIDDEN_CONTROL
    // （因为读到 undefined），再被别的规则处理——那正是要消灭的形态。
    const facts = complete({ isHidden: true });
    delete (facts as unknown as Record<string, unknown>).inCaptcha;
    expect(evaluateClickTarget(facts)).toEqual({ allowed: false, reason: 'INCOMPLETE_FACTS' });
  });

  it('每一种可代点击的 kind 都在表里登记——新增一种就必须显式表态', () => {
    // 这份清单要与 `ClickTargetKind` 逐一对齐。补了两项（2026-09-15）：
    // `reviewed-option` 早先随 fill-only 选项点击落地却漏登记在这条断言里，
    // `choice-member` 是原生激活新增的种类。漏登记的后果不是编译错误而是
    // 静默——所以这条断言的价值全在「清单是完整的」。
    // 2026-09-23 显式加 `proxy-option`（ARIA 代理题：Ashby 的 aria-pressed 按钮、Workable 的
    // role=radio 代理）。它除 DENY_FACTS 外还必备三项形状事实（状态属性、表单归属、承载），
    // 逐项删除的红证在 tests/apply-aria-proxy-choice.test.ts。
    // 2026-09-28 显式加 `account-control`（账号墙上规则声明的那几颗：用邮箱登录、切到登录／注册、注册条款、提交）。
    // 它除 DENY_FACTS 外还必备 `declaredAccountControl`（规则声明的角色），逐项删除的红证在
    // tests/apply-account-control-policy.test.ts。
    const kinds: readonly ClickTargetKind[] = [
      'combobox-trigger', 'transaction-option', 'reviewed-option',
      'choice-label', 'choice-proxy', 'choice-member', 'proxy-option',
      'datepicker-cell', 'row-add', 'row-save', 'row-remove', 'account-control', 'other',
    ];
    for (const kind of kinds) {
      expect(REQUIRED_FACTS_BY_KIND[kind], `${kind} 没登记必备事实`).toBeDefined();
    }
    expect(
      Object.keys(REQUIRED_FACTS_BY_KIND).sort(),
      '有 kind 登记了必备事实却没进这条断言的清单',
    ).toEqual([...kinds].sort());
  });

  it('隐藏与验证码这两项对每一种可点击目标都是必备', () => {
    // 「看不见的东西不许点」与「验证码里的东西不许点」没有任何一种目标可以豁免。
    for (const kind of ['combobox-trigger', 'transaction-option', 'reviewed-option', 'choice-label',
                        'choice-proxy', 'choice-member', 'proxy-option', 'datepicker-cell', 'row-add', 'row-save', 'row-remove',
                        'account-control'] as const) {
      expect(REQUIRED_FACTS_BY_KIND[kind], kind).toContain('isHidden');
      expect(REQUIRED_FACTS_BY_KIND[kind], kind).toContain('inCaptcha');
    }
  });
});
