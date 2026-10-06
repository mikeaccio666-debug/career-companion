import { describe, expect, it } from 'vitest';

import { classifyManualOnly } from '../src/dict/guards';
import { evaluateClickTarget, type ClickTargetFacts } from '../src/click/policy';

/**
 * 跨层不变量：**填写侧判 `NEVER` 的，点击侧必须也拦住**。
 *
 * 为什么需要这条（2026-08-18 体检发现）：
 * 「法律声明勾选」在产品上是一个动作，在代码里是**两层**——
 *
 *  - `dict/guards.ts` 的 `classifyManualOnly` 管**填写**（value/selectedIndex）
 *  - `click/policy.ts` 的 `evaluateClickTarget` 管**代点击**
 *
 * 而 checkbox 今天在填写侧一律落 `unsupported`（`dict/controls.ts` 归 choice），
 * 所以真正决定"这个法律声明勾不勾"的是**点击层**。两层各有一套正则、
 * 各有一套原因码（`MANUAL_ONLY` vs `LEGAL_DECLARATION`/`CONSENT`），
 * 谁都不知道对方存在——这是现成的漂移面。
 *
 * `PD-2026-08-18` 放开的是「信息属实」一档。放开那天改的是**点击层**；
 * 本文件保证的是：改点击层时，实质授权（背景调查、仲裁、信用、药检、订阅）
 * 不会跟着一起被放开。任何让下面某条 case 变绿的改动，都必须是有人
 * **显式**改了这个文件——不能悄悄发生。
 */

/**
 * 造一个**本该可以被代点的** checkbox facts：`kind: 'choice-label'`、
 * `planned: true`、在表单内、可见可用。
 *
 * `planned: true` 是这条测试成立的前提——不给的话点击层会先判 `NOT_PLANNED`
 * 拒绝，测试**因为错误的原因变绿**，等于没测。下面对原因码的断言就是防这个。
 */
function checkbox(accessibleName: string): ClickTargetFacts {
  return {
    withinFormRoot: true,
    insideHtmlForm: true,
    kind: 'choice-label',
    planned: true,
    openedByTransaction: false,
    tagName: 'input',
    inputType: 'checkbox',
    accessibleName,
    isHidden: false,
    isDisabled: false,
    isLikelyOffscreen: false,
    hasHref: false,
    buttonType: null,
    labelText: '',
    isLikelyHoneyPot: false,
    inPasswordContainer: false,
    inCaptcha: false,
    opensFileDialog: false,
    hrefNavigates: true,
  };
}

/** 拒绝理由必须是"这是法律/授权类"，不能是"没在计划里"之类的顺带命中。 */
const ON_TOPIC_REASONS = new Set(['LEGAL_DECLARATION', 'CONSENT', 'OTP_OR_VERIFICATION', 'PASSWORD']);

/** 实质授权的闭集——与 `CONSENT_GRANT` 同源，逐条点名不用正则复述。 */
const CONSENT_GRANTS = [
  'I authorize a background check',
  'I agree to binding arbitration',
  'I consent to a credit report',
  'I consent to a drug screen',
  'Subscribe to marketing emails',
  'I certify that I consent to a background check',
  'Veteran Status — I authorize verification with the VA',
] as const;

describe('跨层：实质授权在填写层与点击层都必须挡住', () => {
  it.each(CONSENT_GRANTS)('填写层判 NEVER：%s', (label) => {
    expect(
      classifyManualOnly(label),
      `「${label}」不是 NEVER——opt-in 开关落地后它会被当成可代填的一档`,
    ).toBe('NEVER');
  });

  it.each(CONSENT_GRANTS)('点击层拒绝代点：%s', (label) => {
    const decision = evaluateClickTarget(checkbox(label));
    expect(
      decision.allowed,
      `点击层放行了「${label}」——实质授权被我们代勾了（铁律 5）`,
    ).toBe(false);
    // 挡住了还不够：必须是**因为它是法律/授权类**而挡，不是因为别的顺带条件。
    expect(
      decision.allowed ? null : decision.reason,
      `「${label}」被挡的理由是 ${decision.allowed ? '—' : decision.reason}，` +
        `不在法律/授权闭集里——这条保护是顺带命中的，不算数`,
    ).toSatisfy((reason: unknown) => ON_TOPIC_REASONS.has(String(reason)));
  });

  it('「信息属实」一档今天点击层同样挡着（放开是 PD 落地时的显式动作）', () => {
    // 这条不是不变量，是**现状快照**：PD-2026-08-18 裁定它可在 opt-in 后代勾，
    // 但开关还没建。放开那天这条会红——那是对的，改它的人必须同时读到上面
    // 那条实质授权的不变量。
    const decision = evaluateClickTarget(
      checkbox('I certify that the information provided is accurate'),
    );
    expect(decision.allowed).toBe(false);
  });
});

/**
 * 点击层的**判定顺序**要能证伪——但不变量要写对。
 *
 * 初版这里断言复合标签 `=== 'CONSENT'`。**那是错的**：绝对拒绝项前置之后
 * （评审指出 CONSENT 排在 SUBMIT/CAPTCHA/HONEYPOT 之前是隐患，核实成立），
 * `Veteran Status — I authorize verification with the VA` 会先命中
 * `OTP_OR_VERIFICATION`——那同样是永不可开的一档，**安全性没有任何损失**，
 * 但断言会红。断言具体等于哪个原因码，锁的是实现细节，不是安全属性。
 *
 * 当前 runtime 的不变量：**`LEGAL_DECLARATION` 是现行表中唯一预留的 eligible 原因码**
 * （`PD-2026-08-18-IRONCLAD-5-SPLIT` 的乙档）。pending L2-P 若获批必须新增专用 durable
 * release taxonomy，不能把 CONSENT 通用原因码翻成 allowed；这条仍对当前重排序危险敏感。
 */
describe('点击层：实质授权不落入当前唯一 eligible 档', () => {
  /** 当前表唯一预留 eligible 的原因码；pending proposal 不得复用此码。 */
  const THE_ONLY_OPENABLE_REASON = 'LEGAL_DECLARATION';

  it.each([
    // LEGAL(certif) + CONSENT(i consent / background check)
    'I certify that I consent to a background check',
    // LEGAL(certif) + CONSENT(agree / terms and conditions)
    'I certify the above and agree to the Terms and Conditions',
    // OTP(verification) + CONSENT(i authorize)
    'Veteran Status — I authorize verification with the VA',
  ])('%s 不落在 LEGAL_DECLARATION 上', (label) => {
    const decision = evaluateClickTarget(checkbox(label));
    expect(decision.allowed, `点击层放行了「${label}」`).toBe(false);
    expect(
      decision.allowed ? null : decision.reason,
      `「${label}」判成了 LEGAL_DECLARATION——乙档开关落地那天，` +
        `这条实质授权会跟着被自动勾选`,
    ).not.toBe(THE_ONLY_OPENABLE_REASON);
  });

  it('反向：纯属实声明确实落在 LEGAL_DECLARATION 上（否则上面那条是空转）', () => {
    // 没有这条，把 LEGAL_DECLARATION 整个删掉，上面三条也全绿。
    const decision = evaluateClickTarget(
      checkbox('I certify that the information provided is accurate'),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? null : decision.reason).toBe(THE_ONLY_OPENABLE_REASON);
  });
});

/**
 * 绝对拒绝必须压过分档判定。
 *
 * 2026-08-18 评审指出：`isConsentName` 原本排在 SUBMIT / CAPTCHA / HONEYPOT /
 * PASSWORD 之前。今天无害——那条链上每个分支都是 deny，变的只是原因码。
 * 但只要有人放宽 CONSENT（例如「让用户选择自动接受 cookie 横幅」），
 * `Accept and Continue` 这类**提交按钮**会先命中 CONSENT_NAME 的 `accept`，
 * 在 SUBMIT_NAME 之前被放行。
 *
 * 代码已重排，但**重排本身当时没有任何测试拦着**（实测：把两条搬回
 * SUBMIT 之前，627 条照样全绿）。本组就是那道拦阻。
 *
 * 当前 runtime 不变量：一个标签同时命中「硬拒绝」和「分档」时，**硬拒绝赢**。
 * pending proposal 的专用路径不得通过改变本优先级实现。
 */
describe('绝对拒绝压过分档（提交/蜜罐/验证码/密码不许被 CONSENT 抢走）', () => {
  const TIER_REASONS = new Set(['CONSENT', 'LEGAL_DECLARATION']);

  it.each([
    // CONSENT_NAME 的 accept + SUBMIT_NAME 的 continue
    ['Accept and Continue', 'SUBMIT_NAME'],
    // CONSENT_NAME 的 agree + SUBMIT_NAME 的 submit
    ['I agree — Submit application', 'SUBMIT_NAME'],
    // CONSENT_NAME 的 terms + SUBMIT_NAME 的 next
    ['Accept terms and go to next step', 'SUBMIT_NAME'],
  ])('%s → %s（不是分档原因码）', (label, expected) => {
    const decision = evaluateClickTarget(checkbox(label));
    expect(decision.allowed).toBe(false);
    const reason = decision.allowed ? '' : decision.reason;
    expect(
      TIER_REASONS.has(reason),
      `「${label}」被判成 ${reason}——分档判定抢在了绝对拒绝之前。` +
        `将来任何对 CONSENT 的放宽都会顺带够到这个提交按钮`,
    ).toBe(false);
    expect(reason).toBe(expected);
  });

  it('蜜罐带同意词：判 HONEYPOT，不被 CONSENT 抢走', () => {
    const decision = evaluateClickTarget({
      ...checkbox('I agree'),
      isLikelyHoneyPot: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? '' : decision.reason).toBe('HONEYPOT');
  });

  it('验证码区内带同意词：判 CAPTCHA，不被 CONSENT 抢走', () => {
    const decision = evaluateClickTarget({
      ...checkbox('I accept'),
      inCaptcha: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? '' : decision.reason).toBe('CAPTCHA');
  });
});

/**
 * 用**真正可点的形态**再测一遍甲档。
 *
 * 上面几组的 facts 都是 `tagName: 'input'`——那个形状即便过了拒绝链，
 * 也会在 `kind` 分支上落 `UNSUPPORTED_TARGET`（`click/policy.ts:153-156`：
 * `choice-label` 只在 `choiceControl && tagName === 'label'` 时才 allowed）。
 * 也就是说那些用例**没有证明**「一个本来完全可点的目标会因为是实质授权而被拒」。
 *
 * 2026-08-18 影响审计纠正了一处我写错的因果：`choice-label` **早就在放行
 * 闭集里**，甲档标签今天挡得住靠的是两件别的事——`:148` 的
 * `if (!facts.planned) return NOT_PLANNED`，以及**全仓零生产者**产出
 * choice-label facts（`click/combobox.ts` 只产 combobox-trigger 与
 * transaction-option）。
 *
 * ⚠️ 所以真正的危险动作不是「放开 choice-label」（它已经开着），
 * 而是**新建那个把 checkbox 标成 planned 并产出 choice-label facts 的生产者**
 * ——那正是乙档代勾要做的第一件事。本组就是给那一天准备的：
 * 生产者接上之后，下面这些标签必须仍然被拒。
 */
describe('真正可点的形态下，甲档仍然被拒（给生产者落地那天准备）', () => {
  /** 一个**完全够格**的代点目标：label 元素 + 关联控件 + 已在计划里。 */
  function clickableLabel(accessibleName: string): ClickTargetFacts {
    return {
      withinFormRoot: true,
      insideHtmlForm: true,
      kind: 'choice-label',
      planned: true,
      openedByTransaction: false,
      tagName: 'label',
      choiceControl: 'checkbox',
      accessibleName,
      isHidden: false,
      isDisabled: false,
      isLikelyOffscreen: false,
      hasHref: false,
    buttonType: null,
    labelText: '',
    isLikelyHoneyPot: false,
    inPasswordContainer: false,
    inCaptcha: false,
    opensFileDialog: false,
    hrefNavigates: true,
    };
  }

  it('先证明这个形态确实是可点的（否则下面全是空转）', () => {
    // 没有这条，把整个拒绝链删光，下面的用例也会因为 UNSUPPORTED_TARGET 而"通过"。
    expect(
      evaluateClickTarget(clickableLabel('Which team interests you?')).allowed,
      '这个形态本身不可点——下面所有用例都是空转，不构成任何保护',
    ).toBe(true);
  });

  it.each([
    'I authorize a background check',
    'I agree to binding arbitration',
    'I consent to a credit report',
    'I consent to a drug screen',
    'Subscribe to marketing emails',
    'I waive my right to a jury trial',
    'I certify that I consent to a background check',
  ])('%s：完全够格也照样拒', (label) => {
    const decision = evaluateClickTarget(clickableLabel(label));
    expect(
      decision.allowed,
      `「${label}」在真正可点的形态下被放行了——生产者接上那天它会被自动勾选`,
    ).toBe(false);
    expect(
      decision.allowed ? '' : decision.reason,
      `「${label}」判成了 LEGAL_DECLARATION——那是唯一有朝一日会被放开的一档`,
    ).not.toBe('LEGAL_DECLARATION');
  });
});

/**
 * 本轮新增的授权措辞——**双层 + 精确原因码**。
 *
 * Yiwen 二轮【高】（2026-08-18）实测：把这一整组新增规则从 `CONSENT_GRANT`
 * 里删掉，643 条测试**照样全绿**。也就是说修复对了，但没有任何东西
 * 拦着它被误删或改坏——`docs/64` §1 点名的形态，本项目今天第五次。
 *
 * 每条同时断言三件事（缺一条都能被绕过）：
 *  1. `classifyManualOnly(label) === 'NEVER'` —— 填写层
 *  2. 真正可点的 `choice-label` 形态下 `allowed === false` —— 点击层
 *  3. 原因**不落在 `LEGAL_DECLARATION`** —— 那是唯一有朝一日会被放开的一档
 */
describe('新增授权措辞：填写层与点击层双锁', () => {
  /** 一个完全够格的代点目标——不是靠上游拒绝条件制造的假绿。 */
  function clickable(accessibleName: string): ClickTargetFacts {
    return {
      withinFormRoot: true,
      insideHtmlForm: true,
      kind: 'choice-label',
      planned: true,
      openedByTransaction: false,
      tagName: 'label',
      choiceControl: 'checkbox',
      accessibleName,
      isHidden: false,
      isDisabled: false,
      isLikelyOffscreen: false,
      hasHref: false,
    buttonType: null,
    labelText: '',
    isLikelyHoneyPot: false,
    inPasswordContainer: false,
    inCaptcha: false,
    opensFileDialog: false,
    hrefNavigates: true,
    };
  }

  it.each([
    ['permission（给出许可）', 'I give Acme Corp permission to contact my current employer'],
    ['permission（grant 变体）', 'I grant permission to contact the references listed above'],
    ['release（免除责任）', 'I hereby release my previous employer from any liability'],
    ['contact employer', 'I authorize you to contact my former supervisor for verification'],
    ['contact reference', 'You may contact my references before an offer is extended'],
    ['electronic signature', 'My electronic signature below constitutes my legal signature'],
    ['中文·授权联系', '本人授权贵司联系我的前任雇主核实以上信息'],
    ['中文·免除责任', '本人同意免除原雇主因提供上述信息而产生的责任'],
  ])('%s：两层都挡，且不落在 LEGAL_DECLARATION', (_name, label) => {
    expect(
      classifyManualOnly(label),
      `填写层放行了「${label}」——这是把一项新权利交出去，属甲档`,
    ).toBe('NEVER');

    const decision = evaluateClickTarget(clickable(label));
    expect(decision.allowed, `点击层放行了「${label}」`).toBe(false);
    expect(
      decision.allowed ? '' : decision.reason,
      `「${label}」判成了 LEGAL_DECLARATION——乙档开关落地那天它会被自动勾选`,
    ).not.toBe('LEGAL_DECLARATION');
  });

  /**
   * 正向对照：防止把正则扩成恒真。
   *
   * 没有这一组，把 `CONSENT_GRANT` 改成 `/./` 上面八条也全绿，
   * 而整个乙档会当场失效（所有属实声明都被判成甲档）。
   */
  it.each([
    ['普通联系信息字段', 'Emergency contact phone number'],
    ['普通签名说明', 'Please sign the offer letter after you receive it'],
    ['纯属实声明', 'I certify that the information provided in this application is accurate'],
  ])('正向对照 · %s：不该被判成实质授权', (_name, label) => {
    expect(
      classifyManualOnly(label),
      `「${label}」被判成 NEVER——正则扩得太宽，乙档会整体失效`,
    ).not.toBe('NEVER');
  });
});
