import { describe, expect, it } from 'vitest';

import { evaluateClickTarget, type ClickTargetFacts } from '../../src/click/policy';

/**
 * 行动作按钮的代点击（CAP-AF-003 ④ · 红证）。
 *
 * ## 为什么这一次点击性质不同
 *
 * 决策 16（负责人 2026-07-31）在铁律 2「不代点宿主控件」上开的口子是
 * **搜索式下拉、选项、日期、简历上传**——它们的共同点是「打开一个菜单
 * 或选中一个值」，点完页面上没有任何东西被提交。
 *
 * 增删行不是这样。Workable 的 `data-ui=save-section` **把一段经历提交给宿主**：
 * 点下去之后那一段进入宿主的数据结构，后续只能靠删行撤销。这是性质不同的
 * 一次点击，所以它不搭 `set-combobox` 的便车，而是走自己的
 * `ClickTargetKind` 与自己的能力位——能力可以单独关掉，关掉之后
 * 下拉照常工作。
 *
 * ## 放行的唯一条件是「厂商规则声明过」
 *
 * 一个按钮能不能点，不由它的文本或长相决定——那是猜。它必须**匹配
 * apply-rules 里声明的行动作选择器**，且落在对应的行作用域内；这个证明
 * 由调用方在 DOM 侧完成，作为 `declaredRowAction` 事实交进来。
 * 没有这个事实的候选一律 `UNSUPPORTED_TARGET`。
 *
 * ## 绝对拒绝仍然全部在前
 *
 * 一个叫 `Save and continue` 的按钮同时是行动作和翻页动作——它必须死在
 * `SUBMIT_NAME` 上，而不是因为「厂商声明过」被放行。本文件下半部分锁的
 * 就是这条：厂商规则**不能**成为绕过提交拒绝的通道。
 */

function facts(overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts {
  return {
    withinFormRoot: true,
    insideHtmlForm: true,
    kind: 'row-save',
    planned: true,
    openedByTransaction: false,
    tagName: 'button',
    buttonType: 'button',
    declaredRowAction: 'save',
    accessibleName: 'Save',
    // 事实必须给全（REQUIRED_FACTS_BY_KIND）：缺席的事实是 undefined，
    // 等于对应的 deny 这次不跑，那种绿是假的。
    labelText: '',
    isHidden: false,
    isDisabled: false,
    isLikelyOffscreen: false,
    isLikelyHoneyPot: false,
    inPasswordContainer: false,
    inCaptcha: false,
    opensFileDialog: false,
    hasHref: false,
    hrefNavigates: true,
    ...overrides,
  };
}

describe('行动作代点击 · 放行面', () => {
  it('厂商声明过的 save-section 按钮可以点', () => {
    expect(evaluateClickTarget(facts())).toEqual({ allowed: true });
  });

  it('加一行与删行同样按各自的种类放行', () => {
    expect(
      evaluateClickTarget(facts({ kind: 'row-add', declaredRowAction: 'add', accessibleName: 'Add another' })),
    ).toEqual({ allowed: true });
    expect(
      evaluateClickTarget(facts({ kind: 'row-remove', declaredRowAction: 'remove', accessibleName: 'Remove' })),
    ).toEqual({ allowed: true });
  });
});

describe('行动作代点击 · 拒绝面', () => {
  it('没有厂商声明就不能点——按钮长得像不算证据', () => {
    // 原因码是 `INCOMPLETE_FACTS` 而不是 `UNSUPPORTED_TARGET`：对行动作来说
    // `declaredRowAction` 是**必备事实**（REQUIRED_FACTS_BY_KIND），
    // 调用方没给就是没证明，而不是"证明了但不合格"。「不是行动作」这件事
    // 应该表达成压根不调用 clickHostTarget，而不是调用时把证明留空。
    expect(evaluateClickTarget(facts({ declaredRowAction: undefined }))).toEqual({
      allowed: false,
      reason: 'INCOMPLETE_FACTS',
    });
  });

  it('种类与声明的动作对不上就不能点', () => {
    // 把删行按钮当成保存按钮点下去，用户会丢掉刚填的一整段。
    expect(evaluateClickTarget(facts({ kind: 'row-save', declaredRowAction: 'remove' }))).toEqual({
      allowed: false,
      reason: 'UNSUPPORTED_TARGET',
    });
  });

  it('不在行计划里就不能点', () => {
    expect(evaluateClickTarget(facts({ planned: false }))).toEqual({
      allowed: false,
      reason: 'NOT_PLANNED',
    });
  });

  it('厂商规则不能成为绕过提交拒绝的通道', () => {
    // 这是本文件最要紧的一条：`Save and continue` 在很多宿主上既保存本段
    // 又翻到下一页。厂商声明过也不行——绝对拒绝排在种类放行之前。
    for (const [name, reason] of [
      ['Save and continue', 'SUBMIT_NAME'],
      ['Submit application', 'SUBMIT_NAME'],
      ['Next', 'SUBMIT_NAME'],
      ['保存并继续', 'SUBMIT_NAME'],
    ] as const) {
      expect(evaluateClickTarget(facts({ accessibleName: name })), name).toEqual({
        allowed: false,
        reason,
      });
    }
  });

  it('type=submit 的行动作按钮不能点——省略 type 的按钮同理', () => {
    expect(evaluateClickTarget(facts({ buttonType: 'submit' }))).toEqual({
      allowed: false,
      reason: 'SUBMIT_CONTROL',
    });
    expect(evaluateClickTarget(facts({ buttonType: '' }))).toEqual({
      allowed: false,
      reason: 'IMPLICIT_SUBMIT_BUTTON',
    });
  });

  it('隐藏 / 禁用 / 表单外的行动作按钮不能点', () => {
    expect(evaluateClickTarget(facts({ isHidden: true }))).toEqual({
      allowed: false,
      reason: 'HIDDEN_CONTROL',
    });
    expect(evaluateClickTarget(facts({ isDisabled: true }))).toEqual({
      allowed: false,
      reason: 'HIDDEN_CONTROL',
    });
    expect(evaluateClickTarget(facts({ withinFormRoot: false }))).toEqual({
      allowed: false,
      reason: 'OUTSIDE_FORM',
    });
  });
});

/**
 * `<a role="button" href="javascript:void(0)">` 形态的行动作（2026-08-22 iCIMS 实测）。
 *
 * iCIMS 的加行按钮长这样：
 *   `<a id="PersonProfileFields.AddressesButton_-1" role="button" href="javascript:void(0)">`
 *
 * 现行 LINK 规则是「`<a>` 且有 href ⇒ 拒」，所以 iCIMS 的加行**一次都点不了**，
 * 而且失败是静默的：原因码 `LINK` 看起来像是被正确挡住的。
 *
 * LINK 这条 deny 防的是**导航**——点走一个链接会离开表单、丢掉用户已填的内容。
 * `javascript:void(0)` 按定义不导航。所以修法不是放宽 LINK，是让它只对**真会导航的
 * href** 生效，并且 fail closed：`hrefNavigates` 缺省（`undefined`）仍按导航处理，
 * 调用方不表态就维持旧行为。
 */
describe('行动作代点击 · <a role=button> 形态（iCIMS）', () => {
  const anchor = (overrides: Partial<ClickTargetFacts> = {}): ClickTargetFacts =>
    facts({
      kind: 'row-add',
      declaredRowAction: 'add',
      accessibleName: 'Add More (Addresses)',
      tagName: 'a',
      buttonType: null,
      hasHref: true,
      ...overrides,
    });

  it('明确证明不导航的锚点可以点', () => {
    expect(evaluateClickTarget(anchor({ hrefNavigates: false }))).toEqual({ allowed: true });
  });

  it('调用方不表态时仍然按导航处理——fail closed，旧行为一字不变', () => {
    expect(evaluateClickTarget(anchor())).toEqual({ allowed: false, reason: 'LINK' });
  });

  it('会导航的锚点照旧拒绝，厂商声明过也不行', () => {
    // 这条是本节的要害：把 hrefNavigates 交给规则数据或页面自述，就等于把
    // 「会不会离开表单」的判断交给了被判断的一方。
    expect(evaluateClickTarget(anchor({ hrefNavigates: true }))).toEqual({
      allowed: false,
      reason: 'LINK',
    });
  });

  it('role=link 一律拒绝，不管 href 导不导航', () => {
    expect(evaluateClickTarget(anchor({ hrefNavigates: false, role: 'link' }))).toEqual({
      allowed: false,
      reason: 'LINK',
    });
  });

  it('不导航也救不了绝对拒绝：提交名、验证码、密码照旧', () => {
    for (const [overrides, reason] of [
      [{ accessibleName: 'Submit application' }, 'SUBMIT_NAME'],
      [{ inCaptcha: true }, 'CAPTCHA'],
      [{ inPasswordContainer: true }, 'PASSWORD'],
      [{ accessibleName: 'I agree to the terms' }, 'CONSENT'],
    ] as const) {
      expect(evaluateClickTarget(anchor({ hrefNavigates: false, ...overrides }))).toEqual({
        allowed: false,
        reason,
      });
    }
  });
});

/**
 * `manage-rows` 不许从手势路径铸出来（2026-08-23）。
 *
 * `capabilitiesForGenericMint` 被**两条铸造路径共用**，而它的保留集
 * 此前只含 `set-attestation`——于是 `mintAuthority`（浮层里的一次真实点击）
 * 也能铸出 `manage-rows`。
 *
 * 为什么这不行：`row-save` 会把一整段经历**提交进宿主的数据结构**，撤销只能
 * 靠删行；而实测（50-证据库 §F.6-o）第一行根本没有删行按钮，也就是**删不掉**。
 * 这种不可逆动作的信任根不能是「有人在浮层里点过一下」，只能是
 * 「用户在 chat 批准了这个岗位、这些字段、这个档位，后端复核签发 lease」——
 * 也就是 `mintIntentAuthority` 那条路（grant.ts 头注对两条信任根的对比）。
 *
 * 与 `set-attestation` 同一档，理由不同：那一条是铁律 5，这一条是不可逆。
 */
describe('manage-rows 的信任根', () => {
  it('手势路径即使明确请求也铸不出 manage-rows', async () => {
    const { mintAuthority } = await import('../../src/grant');
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    shadow.append(button);

    // happy-dom 里 isTrusted 不可写，用一个可信事件的替身：直接构造并打标。
    const event = new MouseEvent('click', { bubbles: true, composed: true });
    Object.defineProperty(event, 'isTrusted', { value: true });
    button.dispatchEvent(event);

    const minted = mintAuthority({
      event,
      shadowRoot: shadow,
      purpose: 'fill',
      fingerprint: 'fp',
      capabilities: new Set(['set-text', 'manage-rows'] as const),
    });
    expect(minted.ok, minted.ok ? '' : minted.code).toBe(true);
    if (!minted.ok) return;

    const { checkActiveCapability, consumeAuthority } = await import('../../src/grant');
    expect(consumeAuthority(minted.value).ok).toBe(true);
    expect(checkActiveCapability(minted.value, 'set-text')).toEqual({ ok: true, value: undefined });
    expect(checkActiveCapability(minted.value, 'manage-rows')).toEqual({
      ok: false,
      code: 'CAPABILITY_DISABLED',
    });
    host.remove();
  });

  it('lease 路径同样铸不出——保留集是共用的，放开要另建专用铸造路径', async () => {
    // 与 `set-attestation` 的处理一致：未来放行必须另建绑定 durable
    // sensitive-release authority 的专用路径，翻转一行或调用方传 Set 都不够。
    const { mintIntentAuthority, consumeAuthority, checkActiveCapability } = await import(
      '../../src/grant'
    );
    const minted = mintIntentAuthority({
      lease: { executionLease: 'lease_1', expiresAtMs: Date.now() + 300_000 },
      purpose: 'fill',
      fingerprint: 'fp',
      capabilities: new Set(['set-text', 'manage-rows'] as const),
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(consumeAuthority(minted.value).ok).toBe(true);
    expect(checkActiveCapability(minted.value, 'manage-rows')).toEqual({
      ok: false,
      code: 'CAPABILITY_DISABLED',
    });
  });
});
