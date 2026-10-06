import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { parseApplyProfileCollections } from '../src/profileCollections';
import { compileRuleAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';

/**
 * 结构化档案 → 页面上正确的那一行（CAP-AF-019 + 020 + 003 的接缝）。
 *
 * 前面三块各自都测过：档案的形状、投影层的取值、行身份的稳定。本文件测的是
 * **它们连起来真的能把第 2 段经历填进第 2 行**——三块各自对而接缝错，
 * 表现就是「两行填了一样的内容」，这正是本轮要根治的失效形态。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const COLLECTIONS = parseApplyProfileCollections({
  experiences: [
    { company: 'Acme', title: 'SWE', startDate: { year: 2021, month: 6 } },
    { company: 'Globex', title: 'Senior SWE', startDate: { year: 2023, month: 1 } },
  ],
});

/** 按 Workable 实测结构：区容器 > ul > li，行内字段只有 name。 */
function experienceRow(): string {
  return `
    <li>
      <label>Title<input name="title" type="text" /></label>
      <label>Company<input name="company" type="text" /></label>
      <label>Start month<select name="start_month">
        <option value=""></option><option>January</option><option>June</option>
      </select></label>
    </li>`;
}

function mount(rowCount: number): void {
  document.body.innerHTML = `
    <div id="main">
      <label>First name<input name="firstname" type="text" /></label>
      <div data-ui="experience"><ul>${experienceRow().repeat(rowCount)}</ul></div>
    </div>`;
}

/** 只声明本测试要用的最小规则：行作用域 + 行内角色映射。 */
const RULES = {
  schemaVersion: 2,
  finalSubmitControl: null,
  vendor: 'workable',
  anchors: ['#main'],
  excludeWithin: [],
  denyLabels: [],
  denyNameSubstrings: [],
  widgetNames: [],
  applyPath: { source: '.*' },
  rowScopes: [
    {
      kind: 'contains',
      container: 'div[data-ui="experience"]',
      row: 'ul > li',
      collection: 'experience',
      actions: { add: 'button[data-ui="add-section"]' },
    },
  ],
  keySteps: [
    {
      type: 'attrMap',
      attr: 'name',
      confidence: 1,
      map: {
        firstname: 'firstName',
        title: 'experience.title',
        company: 'experience.company',
        start_month: 'experience.startMonth',
      },
    },
  ],
};

function planFor(rowCount: number) {
  mount(rowCount);
  const parsed = parseVendorRuleset(RULES);
  expect(parsed, 'fixture ruleset rejected').toMatchObject({ ok: true });
  if (!parsed.ok) throw new Error('unreachable');
  const adapter = compileRuleAdapter(parsed.value);
  const root = adapter.resolveRoot(document);
  expect(root, 'scan root not proven').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'workable', root: root!, fields: [...adapter.scan(root!)] },
    { firstName: 'Mike' },
    { collections: COLLECTIONS },
  );
}

function valueOf(plan: ReturnType<typeof planFor>, name: string): string | undefined {
  return plan.entries.find((entry) => entry.element.getAttribute('name') === name)?.value;
}

describe('行内角色按行取值', () => {
  it('两行各拿各的那一段——这就是接缝对了的样子', () => {
    const plan = planFor(2);
    const companies = plan.entries
      .filter((entry) => entry.key === 'experience.company')
      .map((entry) => entry.value);
    expect(companies).toEqual(['Acme', 'Globex']);
    const titles = plan.entries
      .filter((entry) => entry.key === 'experience.title')
      .map((entry) => entry.value);
    expect(titles).toEqual(['SWE', 'Senior SWE']);
  });

  it('行外字段照旧走 11 个扁平键，不受影响', () => {
    expect(valueOf(planFor(2), 'firstname')).toBe('Mike');
  });

  it('页面行数比档案少：只填得下的那一段，多的不硬塞', () => {
    const plan = planFor(1);
    expect(plan.entries.filter((entry) => entry.key === 'experience.company').map((e) => e.value)).toEqual([
      'Acme',
    ]);
  });

  it('页面行数比档案多：多出来的行报 NO_VALUE，不是拿第 1 段重填一遍', () => {
    // 「两行填了一样的内容」是这套接缝最典型的失效形态。
    const plan = planFor(3);
    expect(plan.entries.filter((entry) => entry.key === 'experience.company')).toHaveLength(2);
    expect(
      plan.skipped.filter((s) => s.key === 'experience.company' && s.reason === 'NO_VALUE'),
    ).toHaveLength(1);
  });

  it('没给结构化档案就一条行内字段都不填，也不报错', () => {
    mount(2);
    const parsed = parseVendorRuleset(RULES);
    if (!parsed.ok) throw new Error('unreachable');
    const adapter = compileRuleAdapter(parsed.value);
    const root = adapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'workable', root, fields: [...adapter.scan(root)] },
      { firstName: 'Mike' },
    );
    expect(plan.entries.filter((entry) => String(entry.key).startsWith('experience.'))).toEqual([]);
    expect(valueOf(plan, 'firstname')).toBe('Mike');
  });
});

describe('select 的阶梯匹配', () => {
  it('月份候选逐个试：宿主写 June 就落 June，不因为首选是 6 而放弃', () => {
    // 投影层给的候选是 ['6','June','06','Jun']；首选 '6' 在这张 select 上
    // 匹配不到，把它当成结论就等于「有值却填不上」。
    const plan = planFor(2);
    const months = plan.entries
      .filter((entry) => entry.key === 'experience.startMonth')
      .map((entry) => entry.value);
    expect(months).toEqual(['June', 'January']);
  });
});
