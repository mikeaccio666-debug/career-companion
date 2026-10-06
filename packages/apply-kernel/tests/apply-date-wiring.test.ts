import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { parseApplyProfileCollections } from '../src/profileCollections';
import { compileRuleAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';

/**
 * 日期写入的**接线**（CAP-AF-002 ↔ 填充主链）。
 *
 * ⚠️ 本文件存在的理由：`dateFormat.ts` 落地时**一个生产调用方都没有**，
 * 只有它自己的单测。这个仓已经被同一形状咬过三次——蜜罐守卫、推荐人守卫、
 * `JOB_DEPENDENT` 都曾是枚举、文案、i18n 三处登记齐全而引擎里一次都没调用过的
 * 死代码，其中蜜罐那次的实测后果是 Workday 的 beecatcher 以 0.75 置信度命中
 * `portfolioUrl` 被真写入、UI 还显示「已填」。
 *
 * 所以这里锁的不是"日期格式化对不对"（那是 apply-date-format.test.ts 的事），
 * 是**它真的被填充主链调用了**：把 engine 里那一行接线删掉，本文件必须变红。
 *
 * ## 三种真实形状（都来自实测，见 41-能力地图 CAP-AF-002 与 50-证据库 §F.6-e）
 *
 *  · Workable：`start_date` / `end_date` 是**纯文本框**，两个都没有 id，只能靠 name 认；
 *  · Greenhouse：`input[type=number]` 的「年」（`end-year--0`，label『End date year*』）；
 *  · Workday / Taleo：月和年两个独立 `<select>`（走 `*.startYear` / `*.startMonth` 两路）。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const COLLECTIONS = parseApplyProfileCollections({
  experiences: [
    { company: 'Acme', title: 'SWE', startDate: { year: 2021, month: 6 }, endDate: { year: 2022, month: 12 } },
  ],
});

function rules(map: Record<string, string>) {
  return {
    schemaVersion: 2,
    finalSubmitControl: null,
    vendor: 'workable',
    anchors: ['#main'],
    applyPath: { source: '.*' },
    excludeWithin: [],
    denyLabels: [],
    denyNameSubstrings: [],
    widgetNames: [],
    rowScopes: [
      { kind: 'contains', container: 'div[data-ui="experience"]', row: 'ul > li', collection: 'experience' },
    ],
    keySteps: [{ type: 'attrMap', attr: 'name', confidence: 1, map }],
  };
}

function planFor(inner: string, map: Record<string, string>) {
  document.body.innerHTML = `<div id="main"><div data-ui="experience"><ul><li>${inner}</li></ul></div></div>`;
  const parsed = parseVendorRuleset(rules(map));
  if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.code}`);
  const adapter = compileRuleAdapter(parsed.value);
  const root = adapter.resolveRoot(document)!;
  return buildApplyPlan(
    { vendor: 'workable', root, fields: [...adapter.scan(root)] },
    {},
    { collections: COLLECTIONS },
  );
}

function valueOf(plan: ReturnType<typeof planFor>, name: string): string | undefined {
  return plan.entries.find((entry) => entry.element.getAttribute('name') === name)?.value;
}

describe('整段日期按目标控件的真实形态格式化', () => {
  it('Workable 的纯文本框拿 ISO 形态——全世界唯一没有歧义的写法', () => {
    const plan = planFor(
      `<label>Start<input name="start_date" type="text" /></label>
       <label>End<input name="end_date" type="text" /></label>`,
      { start_date: 'experience.startDate', end_date: 'experience.endDate' },
    );
    expect(valueOf(plan, 'start_date')).toBe('2021-06');
    expect(valueOf(plan, 'end_date')).toBe('2022-12');
  });

  it('type=month 拿 YYYY-MM，type=date 补 01 日', () => {
    const plan = planFor(
      `<label>Start<input name="start_date" type="month" /></label>
       <label>End<input name="end_date" type="date" /></label>`,
      { start_date: 'experience.startDate', end_date: 'experience.endDate' },
    );
    expect(valueOf(plan, 'start_date')).toBe('2021-06');
    expect(valueOf(plan, 'end_date')).toBe('2022-12-01');
  });

  it('type=number 只拿年份——Greenhouse 的 end-year 那一栏', () => {
    const plan = planFor(
      `<label>Start year<input name="start_date" type="number" /></label>`,
      { start_date: 'experience.startDate' },
    );
    expect(valueOf(plan, 'start_date')).toBe('2021');
  });

  it('只有年份时 type=date/month 一律不填，不补假月份', () => {
    document.body.innerHTML = `<div id="main"><div data-ui="experience"><ul><li>
      <label>Start<input name="start_date" type="date" /></label></li></ul></div></div>`;
    const parsed = parseVendorRuleset(rules({ start_date: 'experience.startDate' }));
    if (!parsed.ok) throw new Error('unreachable');
    const adapter = compileRuleAdapter(parsed.value);
    const root = adapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'workable', root, fields: [...adapter.scan(root)] },
      {},
      { collections: parseApplyProfileCollections({ experiences: [{ company: 'X', startDate: { year: 2021 } }] }) },
    );
    // 补一个假月份会让用户在自己的申请表上看到一个他没填过的日期。
    expect(valueOf(plan, 'start_date')).toBeUndefined();
    expect(plan.skipped.find((s) => s.element?.getAttribute('name') === 'start_date')?.reason).toBe('NO_VALUE');
  });

  it('在职：结束日期那一栏没有值', () => {
    document.body.innerHTML = `<div id="main"><div data-ui="experience"><ul><li>
      <label>End<input name="end_date" type="text" /></label></li></ul></div></div>`;
    const parsed = parseVendorRuleset(rules({ end_date: 'experience.endDate' }));
    if (!parsed.ok) throw new Error('unreachable');
    const adapter = compileRuleAdapter(parsed.value);
    const root = adapter.resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'workable', root, fields: [...adapter.scan(root)] },
      {},
      { collections: parseApplyProfileCollections({ experiences: [{ company: 'X', isCurrent: true, startDate: { year: 2023, month: 1 } }] }) },
    );
    expect(valueOf(plan, 'end_date')).toBeUndefined();
  });
});

describe('年/月分开两栏的厂商仍走原来的两路', () => {
  it('Workday/Taleo 形态：startYear 与 startMonth 各自成栏', () => {
    const plan = planFor(
      `<label>Year<input name="sy" type="text" /></label>
       <label>Month<input name="sm" type="text" /></label>`,
      { sy: 'experience.startYear', sm: 'experience.startMonth' },
    );
    expect(valueOf(plan, 'sy')).toBe('2021');
    // 月份是有序候选，纯文本框拿首项（数字形态）。
    expect(valueOf(plan, 'sm')).toBe('6');
  });
});
