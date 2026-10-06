import { afterEach, describe, expect, it } from 'vitest';

import workday from '@edaix/apply-rules/workday.json';
import type { ApplyFormDescriptor } from '../src/contracts';
import { buildAuditView } from '../src/audit';
import { buildApplyPlan } from '../src/engine';
import { parseApplyProfileCollections } from '../src/profileCollections';
import { describeRowAdds, presentRowCounts, rowPlanSlice } from '../src/rowActions';
import { resolveOptionCandidate } from '../src/click/optionSearch';
import { projectCollectionField } from '../src/collectionProjection';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { hasApprovedResumeFileIdentity } from '../src/write/setFile';
import { mountMyExperience, type MyExperienceShape } from './fixtures/workday/myExperience';

/**
 * Workday 第 2 步「My Experience」（applyFlowMyExpPage）：按档案的每一段经历、每一段教育各占一行，
 * 行内逐格认键。2026-09-24 在 adobe.wd5（没登录、applyManually）同一个岗位上对比：Jobright 加了 3 行
 * 经历、1 行教育，职位／公司／地点／在职／起止年月、学校／学位／专业／GPA、简历全填；我们 0 行、
 * 只有 AI 起草的几个文本框，4 个必填卡住整个向导。
 *
 * 根因：生产早已放行 `manage-rows` 与 `set-file`，但 workday.json 没有 `rowScopes`——行内的格没有键、
 * 也不知道「加一行」按哪里；简历栏的「Resume/CV」标题在第 8 层、默认只往上找 4 层。
 *
 * 规则只用**已有的**规则字段（旧版插件的解析器对不认识的规则字段整份拒收）。夹具是结构骨架，
 * 见 fixtures/workday/myExperience.ts。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

const adapter = () => compileBundledAdapter(workday as never);

function descriptor(shape?: MyExperienceShape): ApplyFormDescriptor {
  mountMyExperience(document, shape);
  const compiled = adapter();
  const root = compiled.resolveRoot(document);
  expect(root, '夹具上找不到 applyFlowMyExpPage 锚点——这条测试就没在测任何东西').not.toBeNull();
  return { vendor: 'workday', root: root!, fields: [...compiled.scan(root!)], rowScopes: compiled.rowScopes ?? [] };
}

/** 按「控件 id 去掉页面生成的序号」取扫描结果里的那一格。 */
function fieldById(form: ApplyFormDescriptor, id: string) {
  return form.fields.find((field) => (field.element.getAttribute('id') ?? '').replace(/-\d+--/, '-N--') === id);
}

const COLLECTIONS = parseApplyProfileCollections({
  experiences: [
    { company: 'Example Robotics', title: 'Machine Learning Engineer', location: 'San Jose, CA', startDate: { year: 2023, month: 3 }, endDate: null, isCurrent: true },
    { company: 'Sample Labs', title: 'Data Scientist', startDate: { year: 2021, month: 6 }, endDate: { year: 2023, month: 2 } },
    { company: 'Demo Corp', title: 'Research Intern', startDate: { year: 2020, month: 5 }, endDate: { year: 2020, month: 8 } },
  ],
  educations: [
    { school: 'Example University', degreeLevel: 'MASTER', fieldOfStudy: 'Computer Science', gpa: '3.9', startDate: { year: 2019, month: 9 }, endDate: { year: 2021, month: 5 } },
  ],
});

describe('Workday My Experience：行作用域与行内的键', () => {
  it.each([
    ['workExperience-N--jobTitle', 'experience.title'],
    ['workExperience-N--companyName', 'experience.company'],
    ['workExperience-N--location', 'experience.location'],
    ['workExperience-N--startDate-dateSectionMonth-input', 'experience.startMonth'],
    ['workExperience-N--startDate-dateSectionYear-input', 'experience.startYear'],
    ['workExperience-N--endDate-dateSectionMonth-input', 'experience.endMonth'],
    ['workExperience-N--endDate-dateSectionYear-input', 'experience.endYear'],
    ['education-N--schoolName', 'education.school'],
    ['education-N--gradeAverage', 'education.gpa'],
    ['education-N--firstYearAttended-dateSectionYear-input', 'education.startYear'],
    ['education-N--lastYearAttended-dateSectionYear-input', 'education.endYear'],
  ])('%s → %s', (id, key) => {
    expect(fieldById(descriptor(), id)?.key, `${id} 没有键`).toBe(key);
  });

  it('Degree 的镜像输入框（无 id、无 name）靠 formField-degree 认成学位，照旧是按钮下拉', () => {
    const form = descriptor();
    const degree = form.fields.find((field) => field.element.closest('[data-automation-id="formField-degree"]') !== null);
    expect(degree?.key).toBe('education.degreeLevel');
    expect(degree?.kind).toBe('combobox');
  });

  it('「I currently work here」认成在职与否', () => {
    const form = descriptor();
    const current = form.fields.find((field) => field.element.closest('[data-automation-id="formField-currentlyWorkHere"]') !== null);
    expect(current?.kind).toBe('choice');
    expect(current?.key).toBe('experience.isCurrent');
  });

  it('反向探针：Role Description 不认键（档案里没有经历描述）', () => {
    expect(fieldById(descriptor(), 'workExperience-N--roleDescription')?.key ?? null).toBeNull();
  });

  it('两个搜索式多选（2026-09-24）：Field of Study 一段教育一个值，Skills 逐项、最多 15 项', () => {
    const form = descriptor();
    expect(fieldById(form, 'education-N--fieldOfStudy')).toMatchObject({
      kind: 'combobox', key: 'education.fieldOfStudy', listbox: { searchPrompt: { maxValues: 1 } },
    });
    expect(form.fields.find((field) => field.element.id === 'skills--skills')).toMatchObject({
      kind: 'combobox', key: 'skills.all', multiple: true, listbox: { searchPrompt: { maxValues: 15 } },
    });
  });

  it('行外的 LinkedIn 照旧是扁平键', () => {
    expect(fieldById(descriptor(), 'socialNetworkAccounts--linkedInAccount')?.key).toBe('linkedinUrl');
  });
});

describe('Workday My Experience：加一行', () => {
  it('数得出每个区此刻有几行（Adobe 预渲染经历、教育各 1 行）', () => {
    expect(presentRowCounts(descriptor())).toEqual({ education: 1, experience: 1 });
    expect(presentRowCounts(descriptor({ experiences: 0, educations: 0 }))).toEqual({ education: 0, experience: 0 });
    expect(presentRowCounts(descriptor({ experiences: 3, educations: 2 }))).toEqual({ education: 2, experience: 3 });
  });

  it('档案 3 段经历、1 段教育：下一步是给经历加第 2 行', () => {
    expect(describeRowAdds(descriptor(), COLLECTIONS).next).toEqual({ collection: 'experience', rowIndex: 1, entryIndex: 1 });
  });

  it('两个区的「加一行」各自在整页恰好命中一颗——证书区那颗同名按钮不算', () => {
    const form = descriptor();
    for (const scope of form.rowScopes ?? []) {
      const matches = form.root.querySelectorAll(scope.actions!.add!);
      expect(matches, scope.collection).toHaveLength(1);
      const section = form.root.querySelectorAll(scope.container)[0]!;
      expect(section.contains(matches[0]!), scope.collection).toBe(true);
    }
  });
});

describe('Workday My Experience：按行取值', () => {
  const plan = () => buildApplyPlan(descriptor(), {}, { collections: COLLECTIONS });
  const value = (id: string) => plan().entries.find((entry) => (entry.element.getAttribute('id') ?? '').replace(/-\d+--/, '-N--') === id)?.value;

  it('第 1 行经历：职位、公司、地点、起始年月', () => {
    expect(value('workExperience-N--jobTitle')).toBe('Machine Learning Engineer');
    expect(value('workExperience-N--companyName')).toBe('Example Robotics');
    expect(value('workExperience-N--location')).toBe('San Jose, CA');
    expect(value('workExperience-N--startDate-dateSectionMonth-input')).toBe('3');
    expect(value('workExperience-N--startDate-dateSectionYear-input')).toBe('2023');
  });

  it('第 1 行教育：学校、GPA、起止年份；学位走下拉，候选里有 Workday 的「Masters」写法', () => {
    expect(value('education-N--schoolName')).toBe('Example University');
    expect(value('education-N--gradeAverage')).toBe('3.9');
    expect(value('education-N--firstYearAttended-dateSectionYear-input')).toBe('2019');
    expect(value('education-N--lastYearAttended-dateSectionYear-input')).toBe('2021');
    const degree = plan().entries.find((entry) => entry.key === 'education.degreeLevel');
    expect(degree?.kind).toBe('combobox');
    expect(degree?.kind === 'combobox' ? degree.comboboxCandidates : []).toContain('Masters');
  });

  it('加出来的第 2 行只拿第 2 段经历', () => {
    const form = descriptor({ experiences: 2, educations: 1 });
    const slice = rowPlanSlice(buildApplyPlan(form, {}, { collections: COLLECTIONS }), form, 1);
    const byKey = new Map(slice.entries.map((entry) => [entry.key, entry.value]));
    expect(byKey.get('experience.company')).toBe('Sample Labs');
    expect(byKey.get('experience.title')).toBe('Data Scientist');
    expect(byKey.get('experience.startMonth')).toBe('6');
    expect(byKey.get('experience.endYear')).toBe('2023');
    expect(slice.entries.every((entry) => entry.key.startsWith('experience.'))).toBe(true);
  });

  it('两个区都有第 2 行时，给了区就只切这个区的（行序在每个区里各数各的）', () => {
    const form = descriptor({ experiences: 2, educations: 2 });
    const plan = buildApplyPlan(form, {}, { collections: parseApplyProfileCollections({
      experiences: [{ company: 'Example Robotics', title: 'Machine Learning Engineer' }, { company: 'Sample Labs', title: 'Data Scientist' }],
      educations: [{ school: 'Example University', degreeLevel: 'MASTER' }, { school: 'Sample College' }],
    }) });
    const keysOf = (slice: ReturnType<typeof rowPlanSlice>) =>
      [...slice.entries.map((entry) => entry.key), ...slice.skipped.map((skip) => String(skip.key))];
    expect(keysOf(rowPlanSlice(plan, form, 1)).some((key) => key.startsWith('education.')), '只按行序切，教育第 2 行也进来').toBe(true);
    expect(keysOf(rowPlanSlice(plan, form, 1, 'experience')).every((key) => key.startsWith('experience.'))).toBe(true);
    expect(keysOf(rowPlanSlice(plan, form, 1, 'education')).every((key) => key.startsWith('education.'))).toBe(true);
    expect(keysOf(rowPlanSlice(plan, form, 1, 'education'))).toContain('education.degreeLevel');
  });
});

/**
 * 2026-09-28 测试台（adobe.wd5，连填到第 2 页）：档案 6 段教育里 3 段没有学位层级。Workday 的 Degree 是必填，
 * 星号是题干里一个 aria-hidden 的 `<abbr>`，按钮下拉扫到的镜像输入框自己没有 required——从前这一格
 * required=false：那 3 格缺学位不进「需要你」，浮层说「这一页填好了」，连填按下一步，Workday 整页报
 * 「The field Degree is required and must have a value」。
 */
describe('Workday My Experience：这一段没有学位', () => {
  const MISSING_DEGREE = parseApplyProfileCollections({
    educations: [
      { school: 'Example University', degreeLevel: 'BACHELOR', startDate: { year: 2015, month: 9 }, endDate: { year: 2019, month: 5 } },
      { school: 'Sample College', startDate: { year: 2019, month: 9 }, endDate: { year: 2021, month: 5 } },
    ],
  });

  it('学位格是必填；缺学位的那一段照实跳过（资料里没有），审计把它算进待你处理的必填', () => {
    const form = descriptor({ experiences: 0, educations: 2 });
    const plan = buildApplyPlan(form, {}, { collections: MISSING_DEGREE });
    const degrees = form.fields.filter((field) => field.element.closest('[data-automation-id="formField-degree"]') !== null);
    expect(degrees.map((field) => field.required)).toEqual([true, true]);
    expect(plan.entries.filter((entry) => entry.key === 'education.degreeLevel')).toHaveLength(1);
    const missing = plan.skipped.filter((skip) => skip.key === 'education.degreeLevel');
    expect(missing).toEqual([expect.objectContaining({ reason: 'NO_VALUE', required: true })]);
    const view = buildAuditView(plan, plan.entries.map((entry) => ({ key: entry.key, label: entry.label, ok: true })));
    expect(view.rows.filter((item) => item.label === 'Degree').map((item) => [item.status, item.required]))
      .toEqual([['FILLED', true], ['MISSING_PROFILE', true]]);
  });
});

describe('Workday 学位下拉：档案的学位层级对到哪一项', () => {
  // 2026-09-24 经批准打开 adobe.wd5 的 Degree 下拉只读（Escape 关上，没选）。
  const ADOBE_DEGREES = ['Select One', 'GED', 'High School', 'Associates', 'Bachelors', 'Masters', 'Doctorate', 'JD'];
  const pick = (degreeLevel: string) => {
    const collections = parseApplyProfileCollections({ educations: [{ school: 'Example University', degreeLevel }] });
    const outcome = resolveOptionCandidate(projectCollectionField(collections, 'education.degreeLevel', 0), ADOBE_DEGREES);
    return outcome.kind === 'MATCH' ? ADOBE_DEGREES[outcome.optionIndex] : outcome.kind;
  };

  it.each([
    ['HIGH_SCHOOL', 'High School'],
    ['ASSOCIATE', 'Associates'],
    ['BACHELOR', 'Bachelors'],
    ['MASTER', 'Masters'],
    ['MBA', 'Masters'],
    ['PHD', 'Doctorate'],
    ['JD', 'JD'],
  ])('%s → %s', (level, option) => {
    expect(pick(level)).toBe(option);
  });

  it('名单里没有对得上的（MD、Other）就不选，交还用户', () => {
    expect(pick('MD')).toBe('NO_OPTION_MATCH');
    expect(pick('OTHER')).toBe('NO_OPTION_MATCH');
  });
});

describe('Workday 简历栏', () => {
  it('「Resume/CV」在第 8 层：规则把上下文深度抬到 8，这一栏认得出是简历', () => {
    const form = descriptor();
    const file = form.fields.find((field) => field.kind === 'file');
    expect(file, '文件控件没被扫到').toBeDefined();
    expect(hasApprovedResumeFileIdentity(file!.element as HTMLInputElement, form.root)).toBe(true);
  });
});
