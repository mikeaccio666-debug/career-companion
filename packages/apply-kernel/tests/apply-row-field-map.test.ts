import { afterEach, describe, expect, it } from 'vitest';

import { buildApplyPlan } from '../src/engine';
import { parseApplyProfileCollections } from '../src/profileCollections';
import { greenhouseAdapter } from '../src/sites/greenhouse/applyForm';
import { workableAdapter } from '../src/sites/workable/applyForm';

/**
 * 行作用域自带的字段映射（`rowScopes[].fieldMap`）。
 *
 * 缺口：Workable 的行内控件**只有 name 没有 id**，而经历段与教育段
 * **共用同一批 name**——两段里都有 `start_date` 与 `end_date`
 * （2026-08-22 实测，50-证据库 §F.6-e）。一张按 `name` 查的全局表表达不了
 * 「这个 `start_date` 是哪一段的」，只能二选一，另一段必然错：
 * 用户的入学年月会被写进工作经历的起始日期栏。
 *
 * 本文件用**随包内置的真实 workable.json**，不是夹具——这条链的价值恰恰在于
 * 那份规则数据写对了。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const COLLECTIONS = parseApplyProfileCollections({
  experiences: [
    { company: 'Acme', title: 'SWE', startDate: { year: 2021, month: 6 }, endDate: { year: 2022, month: 12 } },
  ],
  educations: [
    {
      school: 'MIT',
      fieldOfStudy: 'Computer Science',
      degreeLevel: 'BACHELOR',
      startDate: { year: 2017, month: 9 },
      endDate: { year: 2021, month: 5 },
    },
  ],
});

/** 按 F.6-e 实测结构：区容器 > ul > li，行内只有 name。 */
function mount(): void {
  const experienceRow = `
    <li>
      <label>Title<input name="title" type="text" /></label>
      <label>Company<input name="company" type="text" /></label>
      <label>Industry<input name="industry" type="text" /></label>
      <label>Summary<textarea name="summary"></textarea></label>
      <label>Start date<input name="start_date" type="text" /></label>
      <label>End date<input name="end_date" type="text" /></label>
    </li>`;
  const educationRow = `
    <li>
      <label>School<input name="school" type="text" /></label>
      <label>Field of study<input name="field_of_study" type="text" /></label>
      <label>Degree<input name="degree" type="text" /></label>
      <label>Start date<input name="start_date" type="text" /></label>
      <label>End date<input name="end_date" type="text" /></label>
    </li>`;
  document.body.innerHTML = `
    <form data-ui="application-form">
      <div data-ui="experience"><ul>${experienceRow}</ul>
        <button type="button" data-ui="add-section">+ Add</button></div>
      <div data-ui="education"><ul>${educationRow}</ul>
        <button type="button" data-ui="add-section">+ Add</button></div>
    </form>`;
}

function plan() {
  mount();
  const root = workableAdapter.resolveRoot(document);
  expect(root, 'Workable 适配器没认出表单').not.toBeNull();
  return buildApplyPlan(
    { vendor: 'workable', root: root!, fields: [...workableAdapter.scan(root!)] },
    {},
    { collections: COLLECTIONS },
  );
}

/**
 * 某一段容器里、某个 name 的那一条。
 *
 * 找的是 `skipped` 不是 `entries`：Workable 的行声明了 `writeMode: 'typed'`
 * （只接受逐字符输入，见 apply-typed-write-honesty.test.ts），所以这些控件
 * 今天一律如实报 `WIDGET`。但**键仍然解析出来了**——这里锁的正是那件事：
 * 「认出来了、写不进去」与「没认出来」是两回事，审计面板要说得出区别。
 */
function inSection(p: ReturnType<typeof plan>, section: string, name: string) {
  const match = (el: Element | undefined | null) =>
    el?.getAttribute('name') === name && el.closest(`div[data-ui="${section}"]`) !== null;
  // 两边都找：Workable 的行声明了 `writeMode: 'typed'`，普通文本格走逐字符通路
  // 进 entries，而**掩码格**（start_date / end_date）仍如实报填不了、进 skipped。
  // 键在两边都保留——「认出来了」与「填得了」是两件事。
  return (
    p.entries.find((e) => match(e.element)) ?? p.skipped.find((item) => match(item.element))
  );
}

describe('同名字段按所在段解析成不同角色', () => {
  it('两段的 start_date 解析成各自那一段的角色——这正是全局表做不到的', () => {
    const p = plan();
    expect(inSection(p, 'experience', 'start_date')?.key).toBe('experience.startDate');
    expect(inSection(p, 'education', 'start_date')?.key).toBe('education.startDate');
  });

  it('普通文本格走逐字符通路，掩码格如实报填不了', () => {
    const p = plan();
    const title = p.entries.find((e) => e.element.getAttribute('name') === 'title');
    expect(title?.writeMode, 'title 没带上 typed —— 它会退回整串写入').toBe('typed');
    // 掩码格：投影层给的首选是 2021-06，敲进 MM/YYYY 会写出错误日期，
    // 而回读判决恰好会判成功（§F.6-w）。所以它不进计划。
    expect(p.entries.find((e) => e.element.getAttribute('name') === 'start_date')).toBeUndefined();
  });

  it('角色也确实是各自那一段的', () => {
    const p = plan();
    expect(inSection(p, 'experience', 'end_date')?.key).toBe('experience.endDate');
    expect(inSection(p, 'education', 'end_date')?.key).toBe('education.endDate');
  });

  it('非日期的行内字段一并认出来', () => {
    const p = plan();
    expect(inSection(p, 'experience', 'title')?.key).toBe('experience.title');
    expect(inSection(p, 'experience', 'company')?.key).toBe('experience.company');
    expect(inSection(p, 'education', 'school')?.key).toBe('education.school');
    expect(inSection(p, 'education', 'field_of_study')?.key).toBe('education.fieldOfStudy');
  });

  it('学位也认得出来', () => {
    expect(inSection(plan(), 'education', 'degree')?.key).toBe('education.degreeLevel');
  });
});

describe('刻意不映射的三个，一个都不许被猜出来', () => {
  it('industry / summary：档案里没有这两个概念，键必须是 null', () => {
    const p = plan();
    // 猜测正是这台引擎要消灭的失败形态——把公司名写进行业栏比空着糟得多。
    expect(inSection(p, 'experience', 'industry')?.key).toBeNull();
    expect(inSection(p, 'experience', 'summary')?.key).toBeNull();
  });
});

/**
 * Greenhouse 与 Workable 的行内定位形状**正好是镜像**（2026-08-23 实测）。
 *
 *  · Workable：只有 `name`（`title` / `company` / `start_date`），没有 id；
 *  · Greenhouse：只有 `id`（`school--0` / `degree--0` / `discipline--0`），没有 name。
 *
 * 所以 `fieldMap` 的查表键不能写死成 `name`。`cellIdPattern` 把行号从 id 上剥掉，
 * 剩下的 `school` 才是跨行稳定的那一段。
 *
 * 这一段用**随包内置的真实 greenhouse.json**。
 */
describe('Greenhouse：行内单元靠 id 剥行号认出来', () => {
  function greenhousePlan(rowCount: number) {
    const row = (index: number) => `
      <div class="education--form">
        <label for="school--${index}">School</label><input id="school--${index}" type="text" />
        <label for="degree--${index}">Degree</label><input id="degree--${index}" type="text" />
        <label for="discipline--${index}">Discipline</label><input id="discipline--${index}" type="text" />
      </div>`;
    document.body.innerHTML = `
      <form id="application-form">
        <label for="first_name">First Name</label><input id="first_name" type="text" />
        <div class="education--container">
          ${Array.from({ length: rowCount }, (_unused, index) => row(index)).join('')}
          <button type="button" class="add-another-button">Add another</button>
        </div>
      </form>`;
    const root = greenhouseAdapter.resolveRoot(document);
    expect(root, 'Greenhouse 适配器没认出表单').not.toBeNull();
    return buildApplyPlan(
      { vendor: 'greenhouse', root: root!, fields: [...greenhouseAdapter.scan(root!)] },
      { firstName: 'Mike' },
      { collections: COLLECTIONS },
    );
  }

  function byId(p: ReturnType<typeof greenhousePlan>, id: string) {
    return p.entries.find((entry) => entry.element.getAttribute('id') === id);
  }

  it('三栏各自认出来，行号被剥掉不参与查表', () => {
    const p = greenhousePlan(1);
    expect(byId(p, 'school--0')?.key).toBe('education.school');
    expect(byId(p, 'degree--0')?.key).toBe('education.degreeLevel');
    expect(byId(p, 'discipline--0')?.key).toBe('education.fieldOfStudy');
  });

  it('第 2 行拿第 2 段——行号只用来对齐档案，不参与认字段', () => {
    const p = greenhousePlan(2);
    expect(byId(p, 'school--0')?.value).toBe('MIT');
    // 档案里只有一段教育，第 2 行如实落空而不是重填第 1 段。
    expect(byId(p, 'school--1')).toBeUndefined();
    expect(
      p.skipped.find((s) => s.element?.getAttribute('id') === 'school--1')?.reason,
    ).toBe('NO_VALUE');
  });

  it('行外字段照旧走扁平键', () => {
    expect(byId(greenhousePlan(1), 'first_name')?.value).toBe('Mike');
  });
});
