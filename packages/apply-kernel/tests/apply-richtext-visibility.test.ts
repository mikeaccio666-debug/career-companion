import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan, summarizePlan } from '../src/engine';
import { buildAuditView } from '../src/audit';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import type { ApplyProfileDraft } from '../src/profileDraft';

/**
 * 富文本 / contenteditable / 自定义控件必须**进入视野**（CAP-AF-004 的扫描那一半）。
 *
 * 今天 `scanRoot.ts:11` 的扫描面写死 `'input, select, textarea'`——
 * contenteditable 富文本编辑器、自定义 web component 根本不在里面。后果不是
 * 「填不上」，是**我们在分母上撒谎**：
 *
 *   一张表有 3 个 input（都填上了）+ 一个必填的富文本「Why do you want to join
 *   us?」，我们报「必填 3/3 已就绪」。用户看着一个满绿的面板去点提交，宿主
 *   弹红字说必填项未填——而那一栏我们从头到尾没提过它存在。
 *
 * 这属于「把没成功报成成功」那一族，正是这台引擎要消灭的形态；而且它比
 * WRITE_REVERTED 更隐蔽：那一类至少还在列表里有一行。
 *
 * ## 这一轮只做「看得见」，不做「写得进去」
 *
 * 写入原语（写入点、事件序列、原值快照与还原）是另一件事，而且富文本最有价值的
 * 那一栏——求职信正文——不是 Profile 档案键（11 键上限）；`coverLetterText`
 * 由 T9 的 CAP-AF-025 提供独立材料。正式 source caller 接线前，正确终点是：扫到它、如实报
 * UNSUPPORTED_CONTROL、进必填分母、在面板上占一行并可 [定位]。
 *
 * 「我们填不了这一栏，但它在这儿，你得自己填」——这句话今天一个字都没说出口。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const PROFILE: ApplyProfileDraft = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
};

function plan(html: string) {
  document.body.innerHTML = `<form id="application-form">${html}</form>`;
  const root = greenhouseAdapter.resolveRoot(document);
  expect(root, '适配器没认出表单').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
    PROFILE,
  );
}

const FILLED_THREE = `
  <label for="first_name">First Name</label><input id="first_name" type="text" required />
  <label for="last_name">Last Name</label><input id="last_name" type="text" required />
  <label for="email">Email</label><input id="email" type="email" required />`;

describe('富文本编辑器必须进入视野', () => {
  it('必填的 contenteditable 要进必填分母——否则我们会谎报 3/3 已就绪', () => {
    const built = plan(
      `${FILLED_THREE}
       <label id="why-label">Why do you want to join us?</label>
       <div contenteditable="true" role="textbox" aria-labelledby="why-label" aria-required="true"></div>`,
    );
    const summary = summarizePlan(built);
    expect(
      summary.requiredTotal,
      '必填的富文本没进分母——面板会显示「必填 3/3 已就绪」而那一栏空着，用户点提交才被宿主打回',
    ).toBe(4);
    expect(summary.requiredHandled, '我们把填不了的那一栏算成了已就绪').toBe(3);
  });

  it('它在审计面板上要占一行，并且能 [定位]', () => {
    const built = plan(
      `${FILLED_THREE}
       <label id="why-label">Why do you want to join us?</label>
       <div contenteditable="true" role="textbox" aria-labelledby="why-label" aria-required="true"></div>`,
    );
    const view = buildAuditView(
      built,
      built.entries.map((entry) => ({ key: entry.key, label: entry.label, ok: true as const })),
    );
    const row = view.rows.find((item) => item.label.includes('Why do you want to join us'));
    expect(row, '富文本那一栏在面板上根本不存在——用户不知道还有一栏等着他').not.toBeUndefined();
    expect(row!.status, '「我们填不了」应当如实说成等你填，不是失败').toBe('NEEDS_MANUAL');
    expect(row!.element, '没有元素引用就 [定位] 不了').not.toBeUndefined();
  });

  it('原因码如实报 UNSUPPORTED_CONTROL——不是 LOW_CONFIDENCE', () => {
    // 两者对用户的含义相反：前者是「这类控件我们还不支持」，后者是
    // 「我们没认出这一栏是什么」。混起来用户和下一个接手的人都会被误导。
    const built = plan(
      `<label id="cl">Cover letter</label>
       <div contenteditable="true" role="textbox" aria-labelledby="cl"></div>`,
    );
    const skip = built.skipped.find((item) => item.label.includes('Cover letter'));
    expect(skip?.reason).toBe('UNSUPPORTED_CONTROL');
  });

  it('只认真正可编辑的：false / inherit / hidden 与普通 div 不进视野', () => {
    // 两个都刻意标上 aria-required：漏进来就会把分母顶到 5，这条才咬得住。
    const built = plan(
      `${FILLED_THREE}
       <div contenteditable="false" aria-required="true" aria-label="Read-only notice"></div>
       <div contenteditable="inherit" aria-required="true" aria-label="Inherited editor"></div>
       <div contenteditable="true" hidden aria-required="true" aria-label="Hidden editor"></div>
       <div inert><div contenteditable="true" aria-required="true" aria-label="Inert editor"></div></div>
       <div aria-required="true" aria-label="Just a paragraph"></div>`,
    );
    expect(
      summarizePlan(built).requiredTotal,
      '把 contenteditable="false" 或普通 div 扫进来了——整页的文字块都会变成"字段"，分母立刻虚高',
    ).toBe(3);
    expect(built.skipped.some((item) => item.label.includes('Read-only'))).toBe(false);
    expect(built.skipped.some((item) => item.label.includes('Inherited'))).toBe(false);
    expect(built.skipped.some((item) => item.label.includes('Hidden'))).toBe(false);
    expect(built.skipped.some((item) => item.label.includes('Inert'))).toBe(false);
    expect(built.skipped.some((item) => item.label.includes('paragraph'))).toBe(false);
  });

  it('反向探针：没有富文本时行为逐字不变', () => {
    const built = plan(FILLED_THREE);
    const summary = summarizePlan(built);
    expect(summary.requiredTotal).toBe(3);
    expect(built.entries).toHaveLength(3);
    expect(built.skipped).toHaveLength(0);
  });

  it('反向探针：蜜罐藏在 contenteditable 里同样不进分母', () => {
    const built = plan(
      `${FILLED_THREE}
       <div contenteditable="true" role="textbox" aria-label="Leave this field blank"
            data-qa="honeypot" aria-required="true"></div>`,
    );
    expect(
      summarizePlan(built).requiredTotal,
      '蜜罐进了必填分母——用户会以为还差一项，永远填不完',
    ).toBe(3);
  });
});
