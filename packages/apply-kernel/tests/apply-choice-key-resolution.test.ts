import { afterEach, describe, expect, it } from 'vitest';

import greenhouse from '@edaix/apply-rules/greenhouse.json';
import { buildApplyPlan } from '../src/engine';
import { compileBundledAdapter } from '../src/rules/interpreter';

/**
 * 单选／复选题也要解键——今天扫描器给它们写死 `key: null`。
 *
 * P1-5（2026-09-21）接了「有档案值的选择题按档案写」：规则认到扁平键、档案里有值，
 * 就把码展开成人读写法逐个去撞选项文字。那条能力**在真实页面上从来没有生效过一次**。
 *
 * 原因在 `interpreter.ts` 的 choice 分支：它把字段推进去时 `key` 写死成 `null`，
 * `resolveKey` 只对它后面那一串 text/select/file 调用。于是 engine 里
 * `field.key !== null` 这道前置条件永远不成立，每一个 radio/checkbox 组都落
 * `CHOICE_NO_DATA`——面板说「这个选项需要你来选」。
 *
 * 现有的 `apply-keyed-choice.test.ts` 一直是绿的，因为它**手工构造描述符、直接给了
 * key**，从不经过扫描器。这是本仓同一形状的第六次：蜜罐守卫、推荐人守卫、
 * JOB_DEPENDENT、gate/ 四件、电话元数据守卫，都曾是有测试、没有调用方的死代码。
 *
 * 2026-09-22 用生产包与真实账号跑的 48 页里，「这个选项需要你来选」45 行——其中
 * 代词 12 行、来源题多选 6 行都是档案里**有值**的题（来源题的值是 LinkedIn，
 * 而 ashby 那一页的复选框里就有 LinkedIn 这一项）。
 *
 * ## 用题干解键，不是用成员标签
 *
 * 一组单选的成员标签是「Yes」「No」，题干才是「Are you at least 18 years of age?」。
 * 规则认的是题干。`wording` 已经按「宿主声明的组名 → question scope → 单成员自己的
 * 标签」算好了，解键就该用它。
 *
 * ## 守卫仍在前面
 *
 * engine 的三道守卫（蜜罐 / 推荐人 / 岗位相关）排在 choice 分支**之前**，这是
 * 2026-08-15 就修好的顺序属性，`apply-guards-before-unsupported.redgreen.test.ts`
 * 锁着它。给 choice 接上键不会绕过任何一道——反向探针在下面。
 */

const adapter = () => compileBundledAdapter(greenhouse as never);

const scan = () => {
  const root = adapter().resolveRoot(document)!;
  return [...adapter().scan(root)];
};

const keyOfQuestion = (wording: string): string | null =>
  scan().find((field) => field.label === wording)?.key ?? null;

const mount = (body: string): void => {
  document.body.innerHTML = `<form id="application-form">${body}</form>`;
};

const radioGroup = (legend: string, options: readonly string[], name = 'q') => `
  <fieldset><legend>${legend}</legend>${options.map((text, index) => `
    <label for="${name}${index}">${text}</label>
    <input type="radio" id="${name}${index}" name="${name}" value="${index}">`).join('')}
  </fieldset>`;

const checkboxGroup = (legend: string, options: readonly string[], name = 'c') => `
  <fieldset><legend>${legend}</legend>${options.map((text, index) => `
    <label for="${name}${index}">${text}</label>
    <input type="checkbox" id="${name}${index}" name="${name}" value="${index}">`).join('')}
  </fieldset>`;

afterEach(() => { document.body.innerHTML = ''; });

describe('选择题的题干也要过规则', () => {
  it('单选：规则认得题干，键就该解出来', () => {
    mount(radioGroup('Are you at least 18 years of age?', ['Yes', 'No']));
    expect(
      keyOfQuestion('Are you at least 18 years of age?'),
      '扫描器把 choice 的 key 写死成 null，于是 P1-5 那条能力从来没在真实页面上生效过',
    ).toBe('over18');
  });

  it('复选：多选题一样解键', () => {
    // 2026-09-22 ashby 实测：这一题是复选，选项里就有 LinkedIn，而档案里的值正是它。
    mount(checkboxGroup('How did you hear about this job?', ['LinkedIn', 'Glassdoor', 'Referral']));
    expect(keyOfQuestion('How did you hear about this job?')).toBe('heardAboutSource');
  });

  it('解键之后，档案里有值就真的替用户勾上', () => {
    mount(radioGroup('Are you at least 18 years of age?', ['Yes', 'No']));
    const root = adapter().resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...adapter().scan(root)] } as never,
      { over18: 'true' } as never,
    );
    expect(plan.entries.map((entry) => entry.key)).toContain('over18');
    expect(plan.skipped.find((item) => item.key === 'over18')).toBeUndefined();
  });

  it('反向探针：档案里没有值时照旧留给用户', () => {
    mount(radioGroup('Are you at least 18 years of age?', ['Yes', 'No']));
    const root = adapter().resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...adapter().scan(root)] } as never,
      {} as never,
    );
    expect(plan.entries.map((entry) => entry.key)).not.toContain('over18');
    expect(plan.skipped.some((item) => item.reason === 'CHOICE_NO_DATA')).toBe(true);
  });

  it('反向探针：题干认不出来的题照旧 key=null', () => {
    mount(radioGroup('Which engineering discipline?', ['Backend', 'Frontend']));
    expect(keyOfQuestion('Which engineering discipline?')).toBeNull();
  });

  it('反向探针：用题干解键，不是用成员标签', () => {
    // 成员标签是 Yes / No。若拿成员标签去解键，这两个词什么都不该中——
    // 真正的判据只能是题干。
    mount(radioGroup('Are you at least 18 years of age?', ['Yes', 'No']));
    const fields = scan();
    expect(fields.filter((field) => field.kind === 'choice')).toHaveLength(1);
    expect(fields.find((field) => field.kind === 'choice')!.label)
      .toBe('Are you at least 18 years of age?');
  });

  /**
   * 三道守卫排在 choice 分支之前（2026-08-15 的顺序属性）。给 choice 接上键之后，
   * 这几条必须仍然拦得住——否则蜜罐 checkbox 与推荐人 radio 会被直接写进宿主表单。
   */
  it('反向探针：同意项不因为解出了键就被替用户勾', () => {
    mount(checkboxGroup(
      'Palantir Technologies has my consent to contact me about future roles',
      ['I consent'],
    ));
    const root = adapter().resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...adapter().scan(root)] } as never,
      { over18: 'true', heardAboutSource: 'LinkedIn' } as never,
    );
    expect(plan.entries, '同意项被我们替用户勾了').toHaveLength(0);
  });

  it('反向探针：推荐人那一组仍然拦得住', () => {
    mount(radioGroup('Who referred you?', ['Yes', 'No']));
    const root = adapter().resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...adapter().scan(root)] } as never,
      { over18: 'true' } as never,
    );
    expect(plan.entries).toHaveLength(0);
  });
});
