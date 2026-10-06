import { afterEach, describe, expect, it } from 'vitest';

import greenhouse from '@edaix/apply-rules/greenhouse.json';
import { buildApplyPlan } from '../src/engine';
import { compileBundledAdapter } from '../src/rules/interpreter';
import type { ApplyProfileCollections } from '../src/profileCollections';

/**
 * 两道题优先选「Other」（产品决定，2026-09-22）。
 *
 * ## 学校不在列表里 → 选 Other
 *
 * 2026-09-22 在 jobs.lever.co/palantir 真实申请页上读到：学校是一个 3302 项的原生下拉，
 * 题干自己写着「Please select "Other (School Not Listed)" if your school is not listed.」，
 * 列表里那一项的真实文字是 `Other - School Not Listed`（破折号，不是题干里写的括号）。
 * 档案里最近那段教育的校名不在这张列表里——所以正确答案就是题目指示的那一项。
 *
 * 校名能对上时照旧填校名：Other 只垫在最后，是退路，不是首选。
 *
 * ## 从哪听说的 → 有 Other 就选 Other
 *
 * 用户是通过 Argoland 来申请的，来源归因到 Argoland 是产品方的决定：这道题只要有
 * `Other` 这一项，就**优先**选它，哪怕档案里的来源（例如 LinkedIn）也在列表里。
 * 没有 Other 时照旧按档案填。
 *
 * 这会覆盖用户自己在档案里填的来源——那是有意的，而且面板在用户提交前把选中的那一项
 * 原样显示出来，他看得见。
 *
 * ## 为什么从真实扫描开始，不手工构造描述符
 *
 * `apply-keyed-choice.test.ts` 手工构造描述符、直接给了 key，于是扫描器给选择题写死
 * `key: null` 这件事一年都没被发现（#60）。这里每一条都从 `compileBundledAdapter`
 * 扫真实 DOM 开始，走完整条路。
 */

const adapter = () => compileBundledAdapter(greenhouse as never);

const planFor = (
  body: string,
  profile: Record<string, string>,
  collections?: ApplyProfileCollections,
) => {
  document.body.innerHTML = `<form id="application-form">${body}</form>`;
  const root = adapter().resolveRoot(document)!;
  return buildApplyPlan(
    { vendor: 'greenhouse', root, fields: [...adapter().scan(root)] } as never,
    profile as never,
    { ...(collections ? { collections } : {}) } as never,
  );
};

const select = (label: string, options: readonly string[], id = 'q') => `
  <label for="${id}">${label}</label>
  <select id="${id}"><option value="">Select...</option>${
    options.map((text, index) => `<option value="v${index}">${text}</option>`).join('')
  }</select>`;

const chosen = (plan: ReturnType<typeof planFor>, key: string): string | null =>
  plan.entries.find((entry) => entry.key === key)?.resolvedOptionText ?? null;

/** 只有 school 有意义；其余字段按类型给空。 */
const educations = (school: string): ApplyProfileCollections => ({
  educations: [{
    school, degreeLevel: 'BACHELOR', fieldOfStudy: null, startDate: null, endDate: null,
    location: null, gpa: null, gpaScale: null, isCurrent: false,
  } as never],
});

const SCHOOL_QUESTION =
  'Which university are you currently attending or did you last attend? ' +
  'Please select "Other (School Not Listed)" if your school is not listed.';

afterEach(() => { document.body.innerHTML = ''; });

describe('学校不在列表里 → 选 Other', () => {
  it('校名对不上、列表里有 Other → 选那一项（palantir 的真实写法是破折号）', () => {
    const plan = planFor(
      select(SCHOOL_QUESTION, ['Harvard University', 'Stanford University', 'Other - School Not Listed']),
      {},
      educations('Some University Not On This List'),
    );
    expect(
      chosen(plan, 'education.school'),
      '题目自己写着「不在列表里就选 Other」，我们却让用户自己去选',
    ).toBe('Other - School Not Listed');
  });

  it('校名对得上 → 照旧填校名，Other 只是退路', () => {
    const plan = planFor(
      select(SCHOOL_QUESTION, ['Harvard University', 'Stanford University', 'Other - School Not Listed']),
      {},
      educations('Stanford University'),
    );
    expect(chosen(plan, 'education.school')).toBe('Stanford University');
  });

  it('反向探针：列表里没有 Other → 照旧对不上，不猜', () => {
    const plan = planFor(
      select(SCHOOL_QUESTION, ['Harvard University', 'Stanford University']),
      {},
      educations('Some University Not On This List'),
    );
    expect(chosen(plan, 'education.school')).toBeNull();
    expect(plan.skipped.find((item) => item.key === 'education.school')?.reason).toBe('NO_OPTION_MATCH');
  });

  it('「not listed」写法也算 Other', () => {
    const plan = planFor(
      select(SCHOOL_QUESTION, ['Harvard University', 'My school is not listed']),
      {},
      educations('Some University Not On This List'),
    );
    expect(chosen(plan, 'education.school')).toBe('My school is not listed');
  });
});

describe('从哪听说的 → 有 Other 就选 Other', () => {
  it('列表里有 Other，也有档案里的 LinkedIn → 仍然选 Other（产品决定）', () => {
    const plan = planFor(
      select('How did you hear about this job?', ['LinkedIn', 'Glassdoor', 'Referral', 'Other']),
      { heardAboutSource: 'LinkedIn' },
    );
    expect(chosen(plan, 'heardAboutSource')).toBe('Other');
  });

  it('列表里没有 Other → 照旧按档案填', () => {
    const plan = planFor(
      select('How did you hear about this job?', ['LinkedIn', 'Glassdoor', 'Referral']),
      { heardAboutSource: 'LinkedIn' },
    );
    expect(chosen(plan, 'heardAboutSource')).toBe('LinkedIn');
  });

  it('反向探针：「None of the above」不是 Other——来源题只认明写 Other 的那一项', () => {
    const plan = planFor(
      select('How did you hear about this job?', ['LinkedIn', 'None of the above']),
      { heardAboutSource: 'LinkedIn' },
    );
    expect(chosen(plan, 'heardAboutSource')).toBe('LinkedIn');
  });

  it('复选题（ashby 那种）同样优先 Other', () => {
    document.body.innerHTML = `<form id="application-form">
      <fieldset><legend>How did you hear about this job?</legend>
        <label for="c0">LinkedIn</label><input type="checkbox" id="c0" name="src" value="0">
        <label for="c1">Glassdoor</label><input type="checkbox" id="c1" name="src" value="1">
        <label for="c2">Other</label><input type="checkbox" id="c2" name="src" value="2">
      </fieldset></form>`;
    const root = adapter().resolveRoot(document)!;
    const plan = buildApplyPlan(
      { vendor: 'greenhouse', root, fields: [...adapter().scan(root)] } as never,
      { heardAboutSource: 'LinkedIn' } as never,
    );
    const entry = plan.entries.find((item) => item.key === 'heardAboutSource');
    expect(entry, '复选题的来源题没进计划').toBeDefined();
    expect(entry!.value).toBe('Other');
  });
});

describe('别的题不受影响', () => {
  it('反向探针：国家下拉里有 Other，但国家对得上 → 照旧选国家', () => {
    const plan = planFor(
      select('Country', ['United States', 'Canada', 'Other']),
      { addressCountry: 'US' },
    );
    expect(chosen(plan, 'addressCountry')).toBe('United States');
  });

  it('反向探针：国家对不上时也不退到 Other——只有学校题有这条退路', () => {
    const plan = planFor(
      select('Country', ['United States', 'Canada', 'Other']),
      { addressCountry: 'FR' },
    );
    expect(chosen(plan, 'addressCountry')).toBeNull();
  });
});
