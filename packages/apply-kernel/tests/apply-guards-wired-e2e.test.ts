import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { leverAdapter } from '../src/sites/lever/applyForm';
import type { VendorAdapter } from '../src/contracts';

/**
 * 守卫**接线**回归：走完 `adapter.scan → buildApplyPlan` 的完整链路。
 *
 * 为什么单独一个文件、为什么它比纯函数测试重要：
 *
 * `tests/apply-honeypot-beecatcher.test.ts` 的 6 条断言全绿，但它们只调用
 * `isHoneypot()` 这个纯函数。2026-08-01 的对抗式评审实测发现，
 * `dict/guards.ts` 的每一个导出在 `src/` 下**零调用方**——构建产物里
 * `beecatcher` 出现 0 次。防线整体是死代码，而文档已经把"阶段 0 蜜罐防护"
 * 标成 ✅ 并让阶段 6 的 Workday 依赖它。
 *
 * 评审的端到端复现：Workday 原文蜜罐以 confidence 0.75 命中 `portfolioUrl`
 * （label 里的 "Enter website" 撞上适配器的 `/(portfolio|website)/i`），
 * 被真的写入宿主表单，UI 还显示"已填"。整份申请因此被静默判为 bot 丢弃。
 *
 * **纯函数正确 ≠ 它被调用。** 这个文件锁的是后半句。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

/** Workday 登录表单里的真实蜜罐（nvidia.wd5.myworkdayjobs.com）。 */
const BEECATCHER =
  `<label for="bee">Enter website. This input is for robots only, do not enter if you're human.</label>` +
  `<input id="bee" name="beecatcher" data-automation-id="beecatcher" type="text" ` +
  `style="position:absolute;clip:rect(1px,1px,1px,1px)" />`;

const PROFILE = {
  fullName: 'Ada Lovelace',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
  phone: '(555) 555-0123',
  linkedinUrl: 'https://linkedin.com/in/ada',
  portfolioUrl: 'https://ada.example.test',
} as const;

function planFor(adapter: VendorAdapter, vendor: 'greenhouse' | 'lever') {
  const root = adapter.resolveRoot(document);
  expect(root, 'fixture 没被适配器认出来，这条测试就没意义').not.toBeNull();
  return buildApplyPlan({ vendor, root: root!, fields: [...adapter.scan(root!)] }, PROFILE);
}

describe('蜜罐真的被填充链路拦下（不只是纯函数会返回 true）', () => {
  it.each([
    ['greenhouse', greenhouseAdapter, `<form id="application-form">${BEECATCHER}</form>`],
    ['lever', leverAdapter, `<form id="application-form" method="POST">${BEECATCHER}</form>`],
  ] as const)('%s：beecatcher 进 skipped，绝不进 entries', (vendor, adapter, html) => {
    document.body.innerHTML = html;
    const plan = planFor(adapter, vendor);

    const filled = plan.entries.filter((e) => e.element.getAttribute('name') === 'beecatcher');
    expect(
      filled,
      '蜜罐进了 entries —— 用户的真实网址会被写进陷阱，整份申请静默作废',
    ).toHaveLength(0);
    expect(plan.skipped.some((s) => s.reason === 'HONEYPOT')).toBe(true);
  });

  it('正常的作品集字段仍然会被填 —— 证明守卫不是无差别拒绝', () => {
    document.body.innerHTML =
      `<form id="application-form">` +
      `<label for="p">Portfolio</label><input id="p" name="portfolio" type="text" />` +
      `</form>`;
    const plan = planFor(greenhouseAdapter, 'greenhouse');
    expect(
      plan.entries.some((e) => e.key === 'portfolioUrl'),
      '守卫把正常字段也拦了 —— 那它只是把一种失败换成了另一种',
    ).toBe(true);
  });
});

describe('推荐人 / 紧急联系人字段不会被写上申请人本人的资料', () => {
  it('Lever 的无锚点标签规则不再把本人 LinkedIn 填进配偶栏', () => {
    document.body.innerHTML = `
      <form id="application-form" method="POST">
        <label><span>Full name</span><input type="text" name="name" required /></label>
        <label><span>Spouse / partner LinkedIn profile</span>
          <input type="text" name="cards[abc][field0]" /></label>
        <label><span>Reference's full name</span>
          <input type="text" name="cards[abc][field1]" /></label>
        <label><span>Emergency contact full name</span>
          <input type="text" name="cards[abc][field2]" /></label>
      </form>`;
    const plan = planFor(leverAdapter, 'lever');

    // 申请人本人的 Full name 仍然要填。
    expect(plan.entries.filter((e) => e.key === 'fullName')).toHaveLength(1);
    expect(plan.entries[0].label).toContain('Full name');

    for (const label of ['Spouse', "Reference's", 'Emergency']) {
      expect(
        plan.entries.some((e) => e.label.includes(label)),
        `${label} 字段被填上了申请人本人的资料，而且会显示成绿色"已填"`,
      ).toBe(false);
      expect(plan.skipped.some((s) => s.label.includes(label) && s.reason === 'OTHER_PERSON')).toBe(
        true,
      );
    }
  });

  it('Greenhouse 的 location 规则不再命中紧急联系人所在地', () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="loc">Emergency contact location</label>
        <input id="loc" type="text" />
      </form>`;
    const plan = planFor(greenhouseAdapter, 'greenhouse');
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe('OTHER_PERSON');
  });
});
