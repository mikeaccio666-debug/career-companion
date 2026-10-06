/**
 * 「年满 18 且有权在 X 工作吗」（2026-09-24，负责人：顺手修掉的老毛病）。
 *
 * 从前这道合起来的题只凭 over18 一半就答了（规则的 18 岁正则认了它，档案里有 over18 就直接写），没有 over18
 * 时又只凭工作授权一半答。现在两半都得有依据：年满 18（明确的，或按学历／工作经历推出来的）∧ 那国的授权记录
 * 是「是」才答是；年龄明确「否」、或授权记录明确「否」才答否；其余照旧交还（JOB_DEPENDENT）。
 * 「年满 18 且愿意搬迁」这类同样不许只凭其中一半作答。
 *
 * 题面全是合成的。
 */

import { afterEach, describe, expect, it } from 'vitest';
import greenhouse from '@edaix/apply-rules/greenhouse.json';

import type { ApplyFormDescriptor } from '../src/contracts';
import { buildApplyPlan, type BuildPlanOptions } from '../src/engine';
import type { ApplyProfileCollections } from '../src/profileCollections';
import { compileBundledAdapter } from '../src/rules/interpreter';

afterEach(() => { document.body.innerHTML = ''; });

const WITH_EDUCATION: ApplyProfileCollections = {
  educations: [{
    school: 'Example University', degreeLevel: 'BACHELOR', fieldOfStudy: 'Design',
    startDate: { year: 2016, month: 9 }, endDate: { year: 2020, month: 5 },
    location: null, gpa: null, gpaScale: null, isCurrent: false,
  }],
};

let groups = 0;
function greenhouseForm(controls: string): ApplyFormDescriptor {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    ${controls}
  </form>`;
  const adapter = compileBundledAdapter(greenhouse);
  const root = adapter.resolveRoot(document)!;
  return { vendor: 'greenhouse', root, fields: [...adapter.scan(root)] };
}
const radios = (label: string): string => {
  groups += 1;
  return `<fieldset><legend>${label}</legend>
    <label><input name="g${groups}" type="radio" value="1" /> Yes</label>
    <label><input name="g${groups}" type="radio" value="0" /> No</label>
  </fieldset>`;
};
const select = (label: string): string => {
  groups += 1;
  return `<label for="s${groups}">${label}</label>
    <select id="s${groups}"><option value="">Select...</option><option>Yes</option><option>No</option></select>`;
};

const plan = (controls: string, profile: Record<string, string>, options: BuildPlanOptions = {}) =>
  buildApplyPlan(greenhouseForm(controls), { firstName: 'Taylor', ...profile } as never, options);
const entryFor = (result: ReturnType<typeof plan>, label: string) => result.entries.find((entry) => entry.label === label);
const skipFor = (result: ReturnType<typeof plan>, label: string) => result.skipped.find((item) => item.label === label);

const COMBINED = 'Are you at least 18 years of age and legally authorized to work in the United States?';
const US = (authorizedToWork: 'YES' | 'NO') => [{ regionCode: 'US', authorizedToWork, requiresSponsorship: 'NO' }] as const;
const released = (extra: BuildPlanOptions = {}): BuildPlanOptions => ({ capabilities: { 'set-work-authorization': true }, ...extra });

describe('「年满 18 且有权在 X 工作吗」：两半都得成立', () => {
  it('只有 over18、没有授权记录 → 不答（JOB_DEPENDENT），不再只凭年龄答「是」', () => {
    const result = plan(radios(COMBINED), { over18: 'true' }, released());
    expect(entryFor(result, COMBINED)).toBeUndefined();
    expect(skipFor(result, COMBINED)).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('年满 18 ∧ 美国授权记录是「是」→ Yes，键是 workAuthorization', () => {
    const result = plan(radios(COMBINED), { over18: 'true' }, released({ workAuthorizations: US('YES') }));
    expect(entryFor(result, COMBINED)).toMatchObject({ key: 'workAuthorization', value: 'Yes' });
  });

  it('年满 18 但美国授权记录是「否」→ No', () => {
    const result = plan(radios(COMBINED), { over18: 'true' }, released({ workAuthorizations: US('NO') }));
    expect(entryFor(result, COMBINED)).toMatchObject({ key: 'workAuthorization', value: 'No' });
  });

  it('明确未满 18 → No（有没有授权记录都一样），键是 over18', () => {
    expect(entryFor(plan(radios(COMBINED), { over18: 'false' }, released()), COMBINED)).toMatchObject({ key: 'over18', value: 'No' });
    expect(entryFor(plan(radios(COMBINED), { over18: 'false' }, released({ workAuthorizations: US('YES') })), COMBINED))
      .toMatchObject({ key: 'over18', value: 'No' });
  });

  it('没有 over18、也推不出来 → 不再只凭授权记录答「是」', () => {
    const result = plan(radios(COMBINED), {}, released({ workAuthorizations: US('YES') }));
    expect(entryFor(result, COMBINED)).toBeUndefined();
    expect(skipFor(result, COMBINED)).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('按学历推出年满 18 ∧ 授权「是」→ Yes，带上依据', () => {
    const result = plan(radios(COMBINED), {}, released({ workAuthorizations: US('YES'), collections: WITH_EDUCATION }));
    expect(entryFor(result, COMBINED)).toMatchObject({ key: 'workAuthorization', value: 'Yes', historyBasis: 'ADULT_FROM_HISTORY' });
  });

  it('题目没点名国家、按岗位地点推断 → 照样两半都得成立，并带上推断的国家', () => {
    const label = 'Are you at least 18 years old and legally authorized to work in the country where this role is located?';
    const result = plan(radios(label), { over18: 'true' }, released({ workAuthorizations: US('YES'), jobRegionCode: 'US' }));
    expect(entryFor(result, label)).toMatchObject({ key: 'workAuthorization', value: 'Yes', inferredRegionCode: 'US' });
  });

  it('工作授权的能力位关着 → 不答「是」', () => {
    const result = plan(radios(COMBINED), { over18: 'true' }, { workAuthorizations: US('YES') });
    expect(entryFor(result, COMBINED)).toBeUndefined();
    expect(skipFor(result, COMBINED)).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('三件事问在一句里、或年龄配的是搬迁 → 不答', () => {
    const three = 'Are you at least 18 years of age, legally authorized to work in the United States, and willing to relocate?';
    expect(skipFor(plan(radios(three), { over18: 'true' }, released({ workAuthorizations: US('YES') })), three))
      .toMatchObject({ reason: 'JOB_DEPENDENT' });
    const relocate = 'Are you at least 18 years of age and willing to relocate?';
    expect(skipFor(plan(radios(relocate), { over18: 'true', openToRelocation: 'true' }), relocate))
      .toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('「at least 18 hours a week」不是年龄：不按「年满 18 且有权工作」答', () => {
    const label = 'Are you available at least 18 hours per week and authorized to work in the United States?';
    const result = plan(radios(label), { over18: 'true' }, released({ workAuthorizations: US('YES') }));
    expect(entryFor(result, label)).toBeUndefined();
    expect(skipFor(result, label)).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('没认出键的这道题（Workday 这类没有 over18 规则的厂商）同样两半都得成立', () => {
    const form = (): ApplyFormDescriptor => {
      const descriptor = greenhouseForm(radios(COMBINED));
      return { ...descriptor, fields: descriptor.fields.map((field) => (field.label === COMBINED ? { ...field, key: null, confidence: 0 } : field)) };
    };
    const onlyAuthorization = buildApplyPlan(form(), {} as never, released({ workAuthorizations: US('YES') }));
    expect(onlyAuthorization.skipped.find((item) => item.label === COMBINED)).toMatchObject({ reason: 'JOB_DEPENDENT' });
    const both = buildApplyPlan(form(), { over18: 'true' } as never, released({ workAuthorizations: US('YES') }));
    expect(both.entries.find((entry) => entry.label === COMBINED)).toMatchObject({ key: 'workAuthorization', value: 'Yes' });
  });

  it('只问工作授权、年龄写在问号后面的说明里 → 照旧按授权记录答', () => {
    const label = 'Are you legally authorized to work in the United States? (Applicants must be 18 or older.)';
    const result = plan(radios(label), { over18: 'true' }, released({ workAuthorizations: US('YES') }));
    expect(entryFor(result, label)).toMatchObject({ key: 'workAuthorization', value: 'Yes' });
  });

  it('只问年龄、授权写在问号后面的说明里 → 照旧按年龄答', () => {
    const label = 'Are you at least 18 years of age? (You must also be authorized to work in the United States.)';
    const result = plan(radios(label), { over18: 'true' }, released({ workAuthorizations: US('NO') }));
    expect(entryFor(result, label)).toMatchObject({ key: 'over18', value: 'Yes' });
  });

  it('同一节里单独的年龄题与这道合起来的题都答，不按重复字段仲裁掉', () => {
    const alone = 'Are you at least 18 years of age?';
    const result = plan(select(alone) + select(COMBINED), { over18: 'false' }, released());
    expect(entryFor(result, alone)).toMatchObject({ key: 'over18', resolvedOptionText: 'No' });
    expect(entryFor(result, COMBINED)).toMatchObject({ key: 'over18', resolvedOptionText: 'No' });
  });
});

/**
 * 2026-09-24 负责人决定（Mike：「就答是的」）：说得出是哪一国、他有别国的记录唯独没有这一国的，工作授权那一半按默认
 * 答「是」（与 Jobright 一致），条目带上那一国。年龄那一半照旧得有依据：没有 over18、也推不出来，就交还用户。
 */
describe('「年满 18 且有权在 X 工作吗」：X 他没有记录、但有别国的记录', () => {
  const ROLE = 'Are you at least 18 years old and legally authorized to work in the country where this role is located?';

  it('年满 18 ∧ 岗位在爱沙尼亚、他只有美国记录 → Yes，带上爱沙尼亚', () => {
    const result = plan(radios(ROLE), { over18: 'true' }, released({ workAuthorizations: US('YES'), jobRegionCode: 'EE' }));
    expect(entryFor(result, ROLE)).toMatchObject({
      key: 'workAuthorization', value: 'Yes', defaultedRegionCode: 'EE', inferredRegionCode: 'EE',
    });
  });

  it('题目自己点名了波兰 → 同样按默认答，带上波兰', () => {
    const label = 'Are you at least 18 years of age and legally authorized to work in Poland?';
    const result = plan(radios(label), { over18: 'true' }, released({ workAuthorizations: US('YES') }));
    expect(entryFor(result, label)).toMatchObject({ key: 'workAuthorization', value: 'Yes', defaultedRegionCode: 'PL' });
  });

  it('按学历推出年满 18 ∧ 默认答 → Yes，两个依据都带上', () => {
    const result = plan(radios(ROLE), {}, released({ workAuthorizations: US('YES'), jobRegionCode: 'EE', collections: WITH_EDUCATION }));
    expect(entryFor(result, ROLE)).toMatchObject({
      key: 'workAuthorization', value: 'Yes', historyBasis: 'ADULT_FROM_HISTORY', defaultedRegionCode: 'EE',
    });
  });

  it('没有 over18、也推不出来 → 照旧交还，不只凭默认的那一半答', () => {
    const result = plan(radios(ROLE), {}, released({ workAuthorizations: US('YES'), jobRegionCode: 'EE' }));
    expect(entryFor(result, ROLE)).toBeUndefined();
    expect(skipFor(result, ROLE)).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('一条记录都没有 → 照旧交还', () => {
    const result = plan(radios(ROLE), { over18: 'true' }, released({ workAuthorizations: [], jobRegionCode: 'EE' }));
    expect(entryFor(result, ROLE)).toBeUndefined();
    expect(skipFor(result, ROLE)).toMatchObject({ reason: 'JOB_DEPENDENT' });
  });

  it('那一国有明确的「否」→ No，不按默认', () => {
    const records = [...US('YES'), { regionCode: 'EE', authorizedToWork: 'NO', requiresSponsorship: 'YES' }] as const;
    const entry = entryFor(plan(radios(ROLE), { over18: 'true' }, released({ workAuthorizations: records, jobRegionCode: 'EE' })), ROLE);
    expect(entry).toMatchObject({ key: 'workAuthorization', value: 'No' });
    expect(entry?.defaultedRegionCode).toBeUndefined();
  });
});
