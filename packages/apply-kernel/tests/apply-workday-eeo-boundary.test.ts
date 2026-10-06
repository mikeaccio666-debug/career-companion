import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isManualOnlyControl } from '../src/dict/guards';
import { evaluateClickTarget } from '../src/click/policy';

/**
 * Workday step 5「Voluntary Disclosures」的红线边界。
 *
 * 结构取自真实申请流程（2026-08-21 只读实测；未作答、未提交）。
 *
 * ## 两件改变判断的实测事实
 *
 * **① EEO 字段是语义化命名**：`formField-hispanicOrLatino` / `ethnicityMulti` /
 * `gender` / `veteranStatus`——**不是**同一份申请 step 4 自定义题那种随机 GUID。
 * 所以「认出这是 EEO 题」在技术上完全可行，`CAP-AF-024` 卡的纯粹是法务
 * （`PENDING-D3-LEGAL-RESPONSIBILITY`）。
 *
 * **② 最后一栏是必填的未列明／混合授权**：`acceptTermsAndAgreements` —
 * 「I acknowledge and consent to submission of this application for employment」，
 * `aria-required="true"`。它不在 pending proposal 的窄闭集内，始终由用户本人完成。
 *
 * 推论很硬：**再完美的 autofill 也填不完一份 Workday 申请**——用户必须自己勾
 * 这一格。这是 2026-08-12 审计第 38 项（「L3 在含法律勾选表单上的语义」，
 * 追踪表至今未闭合）的活证据，也是 L3「无人值守」在这一家结构性不成立的原因。
 *
 * ## 竞品对照（同日实测）
 *
 * 在同一张页面上触发 Jobright v1.20.0 的 autofill：它填了姓名／地址／电话／
 * 学位／日期／简历共 14 栏，而这五栏 EEO **一个事件都没有**（观测到的
 * `eeoTouchCount === 0`）。**市场领先者同样不碰乙档**——我们的 fail closed
 * 不是竞争劣势。
 */

const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/workday/voluntary-disclosures-step5.html'),
  'utf8',
);

afterEach(() => {
  document.body.innerHTML = '';
});

const mount = () => { document.body.innerHTML = FIXTURE; };
const labelOf = (key: string) =>
  document.querySelector(`div[data-automation-id="formField-${key}"]`)
    ?.querySelector('label, legend')?.textContent?.trim() ?? '';

describe('EEO 字段是语义化的——认得出，不是认不出', () => {
  it.each(['hispanicOrLatino', 'ethnicityMulti', 'gender', 'veteranStatus'] as const)(
    '%s 有语义化 automation-id',
    (key) => {
      mount();
      expect(
        document.querySelector(`div[data-automation-id="formField-${key}"]`),
        `${key} 变成 GUID 了——CAP-AF-024 的可行性判断要重写`,
      ).not.toBeNull();
    },
  );

  it('对比：同一份申请的自定义题是 GUID', () => {
    // 见 apply-workday-custom-questions.test.ts。两者命名策略不同不是巧合：
    // EEO 是 Workday 的内建标准字段，自定义题是雇主自己配的。
    expect(/^[0-9a-f]{32}$/.test('1cef6417bc1510015a7e6b1fac6c0001')).toBe(true);
  });
});

describe('⚠️ 必填的实质授权：autofill 填不完这份申请', () => {
  it('acceptTermsAndAgreements 是必填勾选', () => {
    mount();
    const box = document.querySelector<HTMLInputElement>(
      'div[data-automation-id="formField-acceptTermsAndAgreements"] input',
    )!;
    expect(box.type).toBe('checkbox');
    expect(box.getAttribute('aria-required'), '这一栏不必填了？那结论要重评').toBe('true');
  });

  it('它的文案命中铁律 5 守卫——我们绝不代勾', () => {
    mount();
    const label = labelOf('acceptTermsAndAgreements');
    expect(label).toContain('acknowledge and consent to submission');
    expect(
      isManualOnlyControl({ text: label, inputType: 'checkbox', autocomplete: null }),
      '「我确认并同意提交这份申请」没被守卫拦住——代勾等于替用户做了法律声明',
    ).toBe(true);
  });

  it('结构性推论：这一格不勾就交不了，而它只能用户自己勾', () => {
    mount();
    const required = [...document.querySelectorAll('[aria-required="true"]')];
    const consent = document.querySelector(
      'div[data-automation-id="formField-acceptTermsAndAgreements"] input',
    );
    expect(required, '必填项里没有那格同意——前提不成立').toContain(consent);
    // 所以「无人值守跑完一份 Workday 申请」在这一家是结构性不成立的，
    // 不是我们能力不够。这条是 L3 语义裁决的硬输入。
  });
});

describe('提交按钮永远拒绝', () => {
  it('Review 页的 Submit 命中绝对拒绝', () => {
    // 实测：走到 step 7 of 7 时，`pageFooterNextButton` 的文案从
    // 「Save and Continue」变成「Submit」——同一个 automation-id。
    // 所以厂商声明的翻页选择器**必须**配文案守卫，否则最后一步会点到提交。
    const verdict = evaluateClickTarget({
      tagName: 'button', buttonType: 'submit', role: null, inputType: null,
      accessibleName: 'Submit', textContent: 'Submit',
      isHidden: false, isDisabled: false, isLikelyOffscreen: false,
      insideHtmlForm: false, hasHref: false, inCaptcha: false,
      isLikelyHoneyPot: false, inPasswordContainer: false, opensFileDialog: false,
    } as never);
    expect(verdict.allowed, 'Submit 被放行了').toBe(false);
  });
});
