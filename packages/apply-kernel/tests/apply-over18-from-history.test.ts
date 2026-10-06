/**
 * 「是否年满 18 岁」：档案里没有明确的是／否时，按学历／工作经历推（2026-09-24，负责人：「跟 Jobright 一样」）。
 *
 * 档案里有 `over18`（Profile V2 `eligibility.over18`）就照它答，与从前逐字相同——明确的「否」照样是「否」。
 * 没有它时，只要档案里有至少一段教育或一段工作经历就答「是」，条目带上 `historyBasis`，浮层据此写明
 * 「按你的学历／工作经历推断」；一段都没有就照旧不答（单选 CHOICE_NO_DATA、下拉 NO_VALUE）。
 *
 * 选项匹配不变：Yes/No 仍由 fillKeyChoices 展开，页面上恰好一项对得上才写。只在选项控件上推——
 * 文本框上没有「恰好一项」可言。
 */

import { afterEach, describe, expect, it } from 'vitest';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';

import { buildAuditView } from '../src/audit';
import type { ApplyFormDescriptor, ScanRootOptions } from '../src/contracts';
import { buildApplyPlan, type BuildPlanOptions } from '../src/engine';
import type { ApplyProfileCollections } from '../src/profileCollections';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { ashbyAdapter } from '../src/sites/ashby/applyForm';

afterEach(() => { document.body.innerHTML = ''; });

const QUESTION = 'Are you at least 18 years of age?';

const EDUCATION = {
  school: 'Example University', degreeLevel: 'BACHELOR', fieldOfStudy: 'Design',
  startDate: { year: 2016, month: 9 }, endDate: { year: 2020, month: 5 },
  location: null, gpa: null, gpaScale: null, isCurrent: false,
} as const;
const EXPERIENCE = {
  company: 'Initech', title: 'Engineer', employmentType: 'FULL_TIME',
  startDate: { year: 2021, month: 1 }, endDate: null, location: null, isCurrent: true,
} as const;

const WITH_EDUCATION: ApplyProfileCollections = { educations: [EDUCATION] };
const WITH_EXPERIENCE: ApplyProfileCollections = { experiences: [EXPERIENCE] };

function greenhouse(controls: string): ApplyFormDescriptor {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    ${controls}
  </form>`;
  const adapter = compileBundledAdapter(greenhouseRules);
  const root = adapter.resolveRoot(document)!;
  return { vendor: 'greenhouse', root, fields: [...adapter.scan(root)] };
}

const radios = (label: string, options: readonly string[] = ['Yes', 'No']) => greenhouse(`
  <fieldset><legend>${label}</legend>
    ${options.map((text, index) => `<label><input name="age" type="radio" value="${index}" /> ${text}</label>`).join('')}
  </fieldset>`);

const select = (label: string, options: readonly string[] = ['Yes', 'No']) => greenhouse(`
  <label for="age">${label}</label>
  <select id="age"><option value="">Select...</option>${options.map((text) => `<option>${text}</option>`).join('')}</select>`);

const plan = (
  form: ApplyFormDescriptor,
  profile: Record<string, string> = { firstName: 'Taylor' },
  options: BuildPlanOptions = {},
) => buildApplyPlan(form, profile as never, options);

const entryFor = (result: ReturnType<typeof plan>, label: string) => result.entries.find((entry) => entry.label === label);
const skipFor = (result: ReturnType<typeof plan>, label: string) => result.skipped.find((item) => item.label === label);

describe('档案里有明确的值：照它答，与从前逐字相同', () => {
  it('over18 = true → Yes，不是推出来的（不带 historyBasis）', () => {
    const result = plan(radios(QUESTION), { firstName: 'Taylor', over18: 'true' }, { collections: WITH_EDUCATION });
    const entry = entryFor(result, QUESTION);
    expect(entry).toMatchObject({ kind: 'choice', key: 'over18', value: 'Yes' });
    expect(entry?.historyBasis).toBeUndefined();
  });

  it('over18 = false → 照样是 No，哪怕档案里有教育与工作经历', () => {
    const result = plan(select(QUESTION), { firstName: 'Taylor', over18: 'false' }, {
      collections: { educations: [EDUCATION], experiences: [EXPERIENCE] },
    });
    const entry = entryFor(result, QUESTION);
    expect(entry).toMatchObject({ kind: 'select', key: 'over18', resolvedOptionText: 'No' });
    expect(entry?.historyBasis).toBeUndefined();
  });
});

describe('档案里没有：有教育或工作经历就答「是」', () => {
  it('单选：有一段教育 → Yes，条目带上依据', () => {
    const result = plan(radios(QUESTION), undefined, { collections: WITH_EDUCATION });
    expect(entryFor(result, QUESTION)).toMatchObject({
      kind: 'choice', key: 'over18', value: 'Yes', historyBasis: 'ADULT_FROM_HISTORY',
    });
    expect(skipFor(result, QUESTION)).toBeUndefined();
  });

  it('原生下拉：有一段工作经历 → 选 Yes', () => {
    const result = plan(select(QUESTION), undefined, { collections: WITH_EXPERIENCE });
    expect(entryFor(result, QUESTION)).toMatchObject({
      kind: 'select', key: 'over18', resolvedOptionText: 'Yes', historyBasis: 'ADULT_FROM_HISTORY',
    });
  });

  it('审计行把依据带给浮层', () => {
    const result = plan(radios(QUESTION), undefined, { collections: WITH_EDUCATION });
    const row = buildAuditView(result, []).rows.find((item) => item.label === QUESTION);
    expect(row).toMatchObject({ key: 'over18', historyBasis: 'ADULT_FROM_HISTORY' });
  });
});

describe('推不出来：照旧不答', () => {
  it('教育与经历一段都没有 → 单选 CHOICE_NO_DATA、下拉 NO_VALUE', () => {
    for (const collections of [undefined, {}, { skills: ['Go'] }] as const) {
      const options: BuildPlanOptions = collections === undefined ? {} : { collections };
      expect(entryFor(plan(radios(QUESTION), undefined, options), QUESTION)).toBeUndefined();
      expect(skipFor(plan(radios(QUESTION), undefined, options), QUESTION)).toMatchObject({ reason: 'CHOICE_NO_DATA', key: 'over18' });
      expect(skipFor(plan(select(QUESTION), undefined, options), QUESTION)).toMatchObject({ reason: 'NO_VALUE', key: 'over18' });
    }
  });

  it('页面上没有恰好一项对得上的选项 → 不猜', () => {
    expect(entryFor(plan(radios(QUESTION, ['Yes', 'Yes', 'No']), undefined, { collections: WITH_EDUCATION }), QUESTION)).toBeUndefined();
    expect(entryFor(plan(radios(QUESTION, ['Absolutely', 'Nope']), undefined, { collections: WITH_EDUCATION }), QUESTION)).toBeUndefined();
  });

  it('用户关掉了这一类（suppressedKeys）→ 不推回来', () => {
    const result = plan(select(QUESTION), undefined, { collections: WITH_EDUCATION, suppressedKeys: new Set(['over18']) });
    expect(entryFor(result, QUESTION)).toBeUndefined();
    expect(skipFor(result, QUESTION)).toMatchObject({ reason: 'SENSITIVE_OPT_OUT' });
  });

  it('档案写着还在读高中 → 不推（那是「未必成年」的证据）', () => {
    const highSchool = { ...EDUCATION, school: 'Example High School', degreeLevel: 'HIGH_SCHOOL', endDate: null, isCurrent: true } as const;
    const result = plan(radios(QUESTION), undefined, { collections: { educations: [highSchool], experiences: [EXPERIENCE] } });
    expect(entryFor(result, QUESTION)).toBeUndefined();
    expect(skipFor(result, QUESTION)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });

  it('反着问的（「under the age of 18」）→ 与明确值共用一个判读：推出来的年满 18 答「No」，不是「Yes」', () => {
    const inverted = 'Are you under the age of 18?';
    const result = plan(radios(inverted), undefined, { collections: WITH_EDUCATION });
    expect(entryFor(result, inverted)).toMatchObject({ key: 'over18', value: 'No', historyBasis: 'ADULT_FROM_HISTORY' });
  });

  it('掺了工作授权的一句（18 岁且有权工作）、又没有授权记录 → 推出来的值不替它作答，照旧交还', () => {
    const combined = 'Are you at least 18 years of age and legally authorized to work in the United States?';
    const result = plan(radios(combined), undefined, { collections: WITH_EDUCATION });
    expect(entryFor(result, combined)).toBeUndefined();
    expect(skipFor(result, combined)).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('自由文本框不推：没有「恰好一项」可对', () => {
    const result = plan(greenhouse(`<label for="age">${QUESTION}</label><input id="age" type="text" />`), undefined, { collections: WITH_EDUCATION });
    expect(entryFor(result, QUESTION)).toBeUndefined();
    expect(skipFor(result, QUESTION)).toMatchObject({ reason: 'NO_VALUE', key: 'over18' });
  });
});

describe('Ashby 的是非按钮（aria-pressed）', () => {
  const REQUIRED_CLASS = 'hashed-required';
  const SCAN_OPTIONS: ScanRootOptions = {
    readGeneratedContent: (element, pseudo) =>
      pseudo === '::after' && element.classList.contains(REQUIRED_CLASS) ? '"*"' : 'none',
  };

  function scanAshby(pressed: 'yes' | 'no' | null = null): ApplyFormDescriptor {
    document.body.innerHTML = `
      <div class="ashby-application-form-container">
        <div class="ashby-application-form-field-entry" data-field-path="question_1003">
          <label class="${REQUIRED_CLASS} ashby-application-form-question-title" for="question_1003">${QUESTION}</label>
          <div class="ashby-application-form-input-yesno">
            <button class="ashby-application-form-input-yesno-option" aria-pressed="${pressed === 'yes'}">Yes</button>
            <button class="ashby-application-form-input-yesno-option" aria-pressed="${pressed === 'no'}">No</button>
            <input type="checkbox" tabindex="-1" name="question_1003">
          </div>
        </div>
      </div>`;
    const root = ashbyAdapter.resolveRoot(document, SCAN_OPTIONS)!;
    return { vendor: 'ashby', root, fields: [...ashbyAdapter.scan(root, SCAN_OPTIONS)] };
  }

  it('没有明确的值、有工作经历 → 按 Yes 那一颗', () => {
    const result = plan(scanAshby(), {}, { collections: WITH_EXPERIENCE });
    expect(entryFor(result, QUESTION)).toMatchObject({
      kind: 'choice', key: 'over18', value: 'Yes', historyBasis: 'ADULT_FROM_HISTORY',
    });
  });

  it('已经按下了一颗 → fill-first 不覆盖（NOT_EMPTY）', () => {
    const result = plan(scanAshby('no'), {}, { collections: WITH_EXPERIENCE });
    expect(entryFor(result, QUESTION)).toBeUndefined();
    expect(skipFor(result, QUESTION)).toMatchObject({ reason: 'NOT_EMPTY' });
  });

  it('一段经历都没有 → 照旧 CHOICE_NO_DATA', () => {
    expect(skipFor(plan(scanAshby(), {}, { collections: {} }), QUESTION)).toMatchObject({ reason: 'CHOICE_NO_DATA' });
  });
});
