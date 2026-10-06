import { afterEach, describe, expect, it } from 'vitest';

import workday from '@edaix/apply-rules/workday.json';
import type { ApplyFormDescriptor } from '../src/contracts';
import { buildApplyPlan, type BuildPlanOptions } from '../src/engine';
import type { ApplyProfileCollections, ProfileExperience } from '../src/profileCollections';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { capabilitiesForKinds } from '../src/write/allowlist';
import { chosenOptions } from '../src/write/choiceGroup';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

/**
 * Workday 第 3 步 Application Questions 上的两道资格题（2026-09-24 adobe.wd5 测试台上只读看到的结构；没有答题、没有提交）。
 *
 *  1. 「Are you of legal age to work in the country in which this position will be based?*」——按钮下拉
 *     （button[aria-haspopup=listbox] + 0×0 镜像输入框），包装层 formField-<GUID>，按钮 id primaryQuestionnaire--<GUID>。
 *     问的是年龄，不是工作授权：按 over18 答（明确的，或按学历／工作经历推出来的）。从前 Workday 规则一条标签模式都没有，
 *     包装层又是随机 GUID，这一题一个键都没有，落「没把握」。现在 workday.json 在祖先表**前面**放了一步标签模式，只有十一家
 *     共用的那条 over18 正则（数据）；怎么答由内核 dict/ageQuestion.ts 按整句判。
 *  2. 「Have you ever worked at Adobe in the following capacity:*」——一组复选框（<GUID>-CheckboxGroup）：Employee、Intern、
 *     Temporary Agency or Vendor、Other、「I have not worked for Adobe in the past.」。经历里没有这家（负责人 2026-09-24：跟
 *     Jobright 一样）就只勾最后那一项；经历里有这家不猜是哪种身份，交还用户。
 *
 * 夹具是手写的**结构骨架**：包装层、fkit id、fieldset/legend/richText 的写法照 2026-09-15 nvidia 同一页的实测
 * （apply-workday-wizard-pages.test.ts），题干与选项照 adobe 那一页的原文；GUID、控件 id 是合成的，没有任何账号数据。
 */

const AGE = '00000000000000000000000000a90001';
const CAPACITY = '00000000000000000000000000a90002';
const AUTHORIZED = '00000000000000000000000000a90003';

const AGE_TEXT = 'Are you of legal age to work in the country in which this position will be based?';
const CAPACITY_TEXT = 'Have you ever worked at Adobe in the following capacity:';
const AUTHORIZED_TEXT = 'Are you legally authorized to work in the country where this position is located?';
const CAPACITY_OPTIONS = [
  'Employee',
  'Intern',
  'Temporary Agency or Vendor',
  'Other',
  'I have not worked for Adobe in the past.',
] as const;
const NOT_WORKED = 'I have not worked for Adobe in the past.';

const legend = (text: string) =>
  `<legend><div><div data-automation-id="richText"><p><span>${text}<abbr title="required" class="requiredAsterisk">*</abbr></span></p></div></div></legend>`;

const listboxQuestion = (guid: string, text: string) => `
  <div data-automation-id="formField-${guid}" data-fkit-id="primaryQuestionnaire--${guid}">
    <fieldset>
      ${legend(text)}
      <div><div><div>
        <button aria-haspopup="listbox" type="button" value="" aria-label=" Select One Required" name="${guid}"
          id="primaryQuestionnaire--${guid}">Select One</button>
        <input type="text" value="" />
      </div></div><div></div></div>
    </fieldset>
  </div>`;

const checkboxQuestion = (guid: string, text: string, options: readonly string[]) => `
  <div data-automation-id="formField-${guid}" data-fkit-id="primaryQuestionnaire--${guid}">
    <fieldset data-automation-id="${guid}-CheckboxGroup">
      ${legend(text)}
      ${options.map((option, index) => `
        <div><div><input type="checkbox" id="${guid}-${index}" /></div><label for="${guid}-${index}">${option}</label></div>`).join('')}
    </fieldset>
  </div>`;

const PAGE = `
  <div data-automation-id="applyFlowPage">
    <div data-automation-id="applyFlowPrimaryQuestionsPage">
      <div role="group" aria-labelledby="primaryQuestionnaire-section">
        <div data-fkit-id="primaryQuestionnaire--null">
          ${listboxQuestion(AGE, AGE_TEXT)}
          ${checkboxQuestion(CAPACITY, CAPACITY_TEXT, CAPACITY_OPTIONS)}
          ${listboxQuestion(AUTHORIZED, AUTHORIZED_TEXT)}
        </div>
      </div>
    </div>
  </div>`;

afterEach(() => { document.body.innerHTML = ''; });

function scan(): ApplyFormDescriptor {
  document.body.innerHTML = PAGE;
  const adapter = compileBundledAdapter(workday as never);
  const root = adapter.resolveRoot(document);
  expect(root, '夹具上找不到 Application Questions 的锚点——这条测试就没在测任何东西').not.toBeNull();
  return { vendor: 'workday', root: root!, fields: [...adapter.scan(root!)] };
}

const fieldIn = (form: ApplyFormDescriptor, guid: string) =>
  form.fields.find((field) => field.element.closest(`[data-automation-id="formField-${guid}"]`) !== null);

const experience = (company: string): ProfileExperience => ({
  company,
  title: 'Engineer',
  employmentType: 'FULL_TIME',
  startDate: { year: 2019, month: 1 },
  endDate: { year: 2021, month: 6 },
  location: null,
  isCurrent: false,
});
const history = (...experiences: ProfileExperience[]): ApplyProfileCollections => ({ experiences });

const plan = (profile: Record<string, string>, options: BuildPlanOptions = {}) => {
  const form = scan();
  return { form, plan: buildApplyPlan(form, profile as never, options) };
};
const entryIn = (built: ReturnType<typeof buildApplyPlan>, form: ApplyFormDescriptor, guid: string) =>
  built.entries.find((entry) => entry.element === fieldIn(form, guid)?.element);
const skipIn = (built: ReturnType<typeof buildApplyPlan>, form: ApplyFormDescriptor, guid: string) =>
  built.skipped.find((item) => item.element === fieldIn(form, guid)?.element);

describe('扫描：两道题的题干与键', () => {
  it('法定工作年龄那一题：按钮下拉，题干来自 legend，键 over18（标签模式那一步给的）', () => {
    const field = fieldIn(scan(), AGE);
    expect(field).toMatchObject({ kind: 'combobox', key: 'over18', label: AGE_TEXT, required: true });
  });

  it('身份那一题：一组五个复选框，题干来自 legend；键照旧没有（按题面在内核里认）', () => {
    const field = fieldIn(scan(), CAPACITY);
    expect(field?.kind).toBe('choice');
    if (field?.kind !== 'choice') return;
    expect(field.label).toBe(`${CAPACITY_TEXT}*`);
    expect(field.key).toBeNull();
    expect(field.required).toBe(true);
    expect(field.choice.control).toBe('checkbox');
    expect(field.choice.options.map((option) => option.label)).toEqual([...CAPACITY_OPTIONS]);
  });

  it('反向探针：工作授权那一题不被年龄的标签模式认走，照旧没有键', () => {
    expect(fieldIn(scan(), AUTHORIZED)?.key).toBeNull();
  });
});

describe('法定工作年龄：按年龄答', () => {
  it('档案明确年满 18 → 组合框的候选落在「Yes」上，不带推断依据', () => {
    const { form, plan: built } = plan({ over18: 'true' });
    const entry = entryIn(built, form, AGE);
    expect(entry).toMatchObject({ kind: 'combobox', key: 'over18' });
    expect(entry?.kind === 'combobox' ? entry.comboboxCandidates : []).toContain('Yes');
    expect(entry?.historyBasis).toBeUndefined();
  });

  it('档案里没有明确值、有一段工作经历 → 推出来的年满 18，带依据', () => {
    const { form, plan: built } = plan({}, { collections: history(experience('Initech')) });
    expect(entryIn(built, form, AGE)).toMatchObject({ key: 'over18', historyBasis: 'ADULT_FROM_HISTORY' });
  });

  it('档案明确未满 18 → 不答，交还用户（JOB_DEPENDENT）', () => {
    const { form, plan: built } = plan({ over18: 'false' }, { collections: history(experience('Initech')) });
    expect(entryIn(built, form, AGE)).toBeUndefined();
    expect(skipIn(built, form, AGE)).toMatchObject({ reason: 'JOB_DEPENDENT', key: 'over18' });
  });

  it('是年龄题不是工作授权题：同一页上授权题按记录答「No」，这一题照年龄答', () => {
    const { form, plan: built } = plan({ over18: 'true' }, {
      capabilities: { 'set-work-authorization': true },
      workAuthorizations: [{ regionCode: 'US', authorizedToWork: 'NO', requiresSponsorship: 'YES' }],
      jobRegionCode: 'US',
    });
    expect(entryIn(built, form, AUTHORIZED)).toMatchObject({ key: 'workAuthorization', value: 'No' });
    const age = entryIn(built, form, AGE);
    expect(age).toMatchObject({ key: 'over18' });
    expect(age?.kind === 'combobox' ? age.comboboxCandidates : []).toContain('Yes');
  });
});

describe('在 Adobe 工作过吗：身份那一组复选框', () => {
  it('经历里没有 Adobe → 只勾「I have not worked for Adobe in the past.」，依据「没有这家公司」', () => {
    const { form, plan: built } = plan({}, { jobCompany: 'Adobe', collections: history(experience('Initech')) });
    const entry = entryIn(built, form, CAPACITY);
    expect(entry).toMatchObject({
      kind: 'choice', key: 'previouslyEmployedHere', value: NOT_WORKED, historyBasis: 'EMPLOYER_NOT_IN_HISTORY',
    });
    if (entry?.kind === 'choice') expect(chosenOptions(entry.choice, [entry.value])).toEqual([NOT_WORKED]);
  });

  it('岗位公司写的是「Adobe Inc.」→ 同一家', () => {
    const { form, plan: built } = plan({}, { jobCompany: 'Adobe Inc.', collections: history(experience('Initech')) });
    expect(entryIn(built, form, CAPACITY)).toMatchObject({ key: 'previouslyEmployedHere', value: NOT_WORKED });
  });

  it('经历里有 Adobe → 不猜是哪种身份，交还用户', () => {
    const { form, plan: built } = plan({}, { jobCompany: 'Adobe', collections: history(experience('Adobe')) });
    expect(entryIn(built, form, CAPACITY)).toBeUndefined();
    expect(skipIn(built, form, CAPACITY)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });

  it('岗位公司不知道、或不是题面点名的那一家 → 不答', () => {
    for (const options of [
      { collections: history(experience('Initech')) },
      { jobCompany: 'Figma', collections: history(experience('Initech')) },
    ] as const) {
      const { form, plan: built } = plan({}, options);
      expect(entryIn(built, form, CAPACITY)).toBeUndefined();
    }
  });

  it('已经勾了一项 → fill-first 不覆盖（NOT_EMPTY）', () => {
    const form = scan();
    (document.getElementById(`${CAPACITY}-1`) as HTMLInputElement).checked = true;
    const built = buildApplyPlan(form, {} as never, { jobCompany: 'Adobe', collections: history(experience('Initech')) });
    expect(entryIn(built, form, CAPACITY)).toBeUndefined();
    expect(skipIn(built, form, CAPACITY)).toMatchObject({ reason: 'NOT_EMPTY', key: 'previouslyEmployedHere' });
  });

  it('写入：只勾上那一项，其余四项不动', async () => {
    const { form, plan: built } = plan({}, { jobCompany: 'Adobe', collections: history(experience('Initech')) });
    const only = { ...built, entries: built.entries.filter((entry) => entry.key === 'previouslyEmployedHere') };
    expect(only.entries).toHaveLength(1);
    const bundled = testApplyPolicy();
    const summary = await runApplyPlan({
      plan: only,
      auth: testAuthority(only.fingerprint, 'fill', [...capabilitiesForKinds(only.entries.map((entry) => entry.kind))]),
      journal: createUndoJournal(),
      root: form.root,
      // 内置策略把 workday 关着（生产只认后端下发的运行时包）；与别的 Workday 用例一样，测试里单独打开。
      policy: { ...bundled, vendors: { ...bundled.vendors, workday: true } },
      // 宿主对这一组的判决：与 apply-choice-native-activation 同一个替身（插件里读的是真控件的约束校验与 aria-invalid）。
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 5,
    });
    expect(summary.results.map((result) => [result.key, result.ok])).toEqual([['previouslyEmployedHere', true]]);
    const checked = CAPACITY_OPTIONS.filter((_, index) => (document.getElementById(`${CAPACITY}-${index}`) as HTMLInputElement).checked);
    expect(checked).toEqual([NOT_WORKED]);
  });
});
