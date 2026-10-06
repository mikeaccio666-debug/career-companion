import { describe, expect, it } from 'vitest';

import type { RowScopeRule } from '../src/contracts';
import { parseApplyProfileCollections } from '../src/profileCollections';
import { MAX_ROW_ADDS, planAddedRowRemoval, planRows } from '../src/rowPlan';

/**
 * 增删行编排（CAP-AF-003 ①②⑤）。
 *
 * 缺口原文：「增删行零代码……工作经历和教育——简历里信息量最大、用户手填最痛
 * 的部分——在 Workable 上一条都进不去。」
 *
 * 本文件锁的是**排步骤**这一半：档案有几段、页面有几行、这一家怎么加行，
 * 排成一份确定的有序计划。行身份那一半在 apply-row-identity.test.ts。
 */

const THREE_JOBS = parseApplyProfileCollections({
  experiences: [
    { company: 'Acme', title: 'SWE' },
    { company: 'Globex', title: 'Senior SWE' },
    { company: 'Initech', title: 'Staff SWE' },
  ],
  educations: [{ school: 'MIT', degreeLevel: 'BACHELOR' }],
});

/** Workable 形态：能加行，且每行填完必须点保存。 */
const WORKABLE_EXPERIENCE: RowScopeRule = {
  kind: 'contains',
  container: 'div[data-ui="experience"]',
  row: 'ul > li',
  collection: 'experience',
  actions: {
    add: 'button[data-ui="add-section"]',
    save: 'button[data-ui="save-section"]',
    remove: 'button[data-ui="remove-section"]',
  },
};

/** Greenhouse 形态：能加行，没有分段保存这一步。 */
const GREENHOUSE_EDUCATION: RowScopeRule = {
  kind: 'contains',
  container: 'div.education--container',
  row: 'div.education--form',
  collection: 'education',
  actions: { add: 'button.add-another-button' },
};

describe('按档案段数决定加几行', () => {
  it('页面 1 行、档案 3 段：加两行，逐行推进', () => {
    const plan = planRows({
      collections: THREE_JOBS,
      scopes: [WORKABLE_EXPERIENCE],
      present: { experience: 1 },
    });
    expect(plan.steps.map((step) => `${step.kind}:${step.rowIndex}`)).toEqual([
      // 第 1 行页面上已经有了，直接填、直接存。
      'fillRow:0',
      'saveRow:0',
      // 后两行各自「加 → 填 → 存」。
      'addRow:1',
      'fillRow:1',
      'saveRow:1',
      'addRow:2',
      'fillRow:2',
      'saveRow:2',
    ]);
  });

  it('顺序是逐行推进，不是先加满再一起填', () => {
    // Workable 上「连点三次加行再一起填」会把三段都填进最后一行——未保存的行
    // 共用同一组 name，只靠行容器区分。而且逐行推进有个额外好处：中途任何一步
    // 失败，前面已保存的段都是完整的。
    const plan = planRows({
      collections: THREE_JOBS,
      scopes: [WORKABLE_EXPERIENCE],
      present: { experience: 0 },
    });
    const kinds = plan.steps.map((step) => step.kind);
    expect(kinds).toEqual([
      'addRow', 'fillRow', 'saveRow',
      'addRow', 'fillRow', 'saveRow',
      'addRow', 'fillRow', 'saveRow',
    ]);
  });

  it('没有分段保存的厂商就不排保存步骤', () => {
    const plan = planRows({
      collections: THREE_JOBS,
      scopes: [GREENHOUSE_EDUCATION],
      present: { education: 1 },
    });
    expect(plan.steps.map((step) => step.kind)).toEqual(['fillRow']);
    expect(plan.steps.every((step) => step.kind !== 'saveRow')).toBe(true);
  });

  it('页面行数够用时一次都不点加行', () => {
    const plan = planRows({
      collections: THREE_JOBS,
      scopes: [WORKABLE_EXPERIENCE],
      present: { experience: 3 },
    });
    expect(plan.steps.filter((step) => step.kind === 'addRow')).toEqual([]);
  });
});

describe('加不了就说加不了，不猜一个选择器出来', () => {
  it('厂商没声明 add：只填页面上已有的行，其余如实报 NO_ADD_SELECTOR', () => {
    const plan = planRows({
      collections: THREE_JOBS,
      scopes: [{ kind: 'contains', container: 'div.x', row: 'li', collection: 'experience' }],
      present: { experience: 1 },
    });
    expect(plan.steps.map((step) => step.kind)).toEqual(['fillRow']);
    expect(plan.unreachable).toContainEqual({
      collection: 'experience',
      count: 2,
      reason: 'NO_ADD_SELECTOR',
    });
  });

  it('整个集合没有行作用域：一步都不排，如实报告', () => {
    const plan = planRows({ collections: THREE_JOBS, scopes: [], present: {} });
    expect(plan.steps).toEqual([]);
    expect(plan.unreachable).toContainEqual({
      collection: 'experience',
      count: 3,
      reason: 'NO_ADD_SELECTOR',
    });
    expect(plan.unreachable).toContainEqual({
      collection: 'education',
      count: 1,
      reason: 'NO_ADD_SELECTOR',
    });
  });

  it('超过静态上限的部分报 ROW_LIMIT，不是无限点下去', () => {
    // 上限防的是「点了没反应 → 继续点」把宿主按钮打爆。
    const many = parseApplyProfileCollections({
      experiences: Array.from({ length: MAX_ROW_ADDS + 3 }, (_unused, index) => ({
        company: `Co${index}`,
        title: 'SWE',
      })),
    });
    const plan = planRows({
      collections: many,
      scopes: [WORKABLE_EXPERIENCE],
      present: { experience: 0 },
    });
    expect(plan.steps.filter((step) => step.kind === 'addRow')).toHaveLength(MAX_ROW_ADDS);
    expect(plan.unreachable).toContainEqual({
      collection: 'experience',
      count: 3,
      reason: 'ROW_LIMIT',
    });
  });
});

describe('绝不自动删宿主原有的行', () => {
  it('页面比档案多出来的行只报告，不排任何删除步骤', () => {
    // 那一行里可能有用户自己刚敲进去的字。
    const plan = planRows({
      collections: THREE_JOBS,
      scopes: [WORKABLE_EXPERIENCE],
      present: { experience: 5 },
    });
    expect(plan.extraRows).toContainEqual({ collection: 'experience', count: 2 });
    expect(plan.steps.filter((step) => step.kind === 'removeRow')).toEqual([]);
  });

  it('撤销时倒序删——从中间删会把后面每一行的序号全部前移', () => {
    expect(
      planAddedRowRemoval('experience', WORKABLE_EXPERIENCE, [1, 2, 3]).map((step) => step.rowIndex),
    ).toEqual([3, 2, 1]);
  });

  it('厂商没声明 remove 就删不了，返回空计划而不是硬来', () => {
    expect(planAddedRowRemoval('education', GREENHOUSE_EDUCATION, [1])).toEqual([]);
  });

  it('非法行序被剔除，不会排出一步点在不存在的行上', () => {
    expect(planAddedRowRemoval('experience', WORKABLE_EXPERIENCE, [-1, 1.5, Number.NaN, 2])).toEqual([
      { kind: 'removeRow', collection: 'experience', rowIndex: 2, selector: 'button[data-ui="remove-section"]' },
    ]);
  });
});

describe('计划是确定的', () => {
  it('同一份档案在同一页面上每次排出同一份计划', () => {
    const args = {
      collections: THREE_JOBS,
      scopes: [WORKABLE_EXPERIENCE, GREENHOUSE_EDUCATION],
      present: { experience: 1, education: 1 },
    };
    expect(planRows(args)).toEqual(planRows(args));
  });

  it('教育在前、经历在后——计划要能展示给用户审阅', () => {
    const plan = planRows({
      collections: THREE_JOBS,
      scopes: [WORKABLE_EXPERIENCE, GREENHOUSE_EDUCATION],
      present: { experience: 1, education: 1 },
    });
    const collections = plan.steps.map((step) => step.collection);
    expect(collections[0]).toBe('education');
    expect(collections.at(-1)).toBe('experience');
  });

  it('页面行数缺失 / 非法一律按 0 行处理', () => {
    for (const bad of [undefined, -3, 1.5, Number.NaN]) {
      const plan = planRows({
        collections: THREE_JOBS,
        scopes: [WORKABLE_EXPERIENCE],
        present: { experience: bad as number },
      });
      expect(plan.steps.filter((step) => step.kind === 'addRow')).toHaveLength(3);
    }
  });

  it('不参与编排的行作用域（iCIMS 电话/地址）不影响计划', () => {
    // 它们要行身份，但档案里没有对应集合——行身份与增删行编排是两件事。
    const icimsPhone: RowScopeRule = {
      kind: 'idPrefix',
      container: 'form#profileForm',
      idPattern: /^(-?\d+)_PersonProfileFields\.Phone/,
    };
    expect(
      planRows({ collections: THREE_JOBS, scopes: [icimsPhone, WORKABLE_EXPERIENCE], present: { experience: 1 } }),
    ).toEqual(
      planRows({ collections: THREE_JOBS, scopes: [WORKABLE_EXPERIENCE], present: { experience: 1 } }),
    );
  });
});
