/**
 * 按教育／工作经历推出来的两问（2026-10-04，dict/historyAnswers.ts），以及「在这家公司工作过吗」的两处小补：
 *
 *  · 「你现在在读吗」：标着在读（毕业时间还没到）、或已开学还没到结束的那个月 → 是；每一段都结束在这个月之前、
 *    也没有一段标在读 → 否；其余说不清，不答。
 *  · 「你服过兵役吗」：与「正在退役转业的军人吗」同一个依据，有工作经历、一段都不像军队服役 → 否。
 *  · 「employed by any of X entities」：打头的「any of」不算对象；岗位的 JobPosting 写着「X SE」也算同一家。
 *
 * 题面与资料全是合成的。
 */

import { afterEach, describe, expect, it } from 'vitest';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';

import type { ApplyFormDescriptor } from '../src/contracts';
import { currentStudentAnswer, hiringCompanyEmployment, militaryServiceAnswer, normalizeCompany } from '../src/dict/historyAnswers';
import { buildApplyPlan } from '../src/engine';
import { parseApplyProfileCollections, type ApplyProfileCollections } from '../src/profileCollections';
import { compileBundledAdapter } from '../src/rules/interpreter';

afterEach(() => { document.body.innerHTML = ''; });

const TODAY = '2026-10-04';
const education = (fields: Record<string, unknown>): ApplyProfileCollections =>
  parseApplyProfileCollections({ educations: [{ school: 'Example University', ...fields }] });

describe('你现在在读吗', () => {
  const QUESTION = 'Are you currently enrolled in a degree program?';

  it('标着在读、预计毕业还没到 → YES', () => {
    const studying = education({ isCurrent: true, startDate: { year: 2024, month: 9 }, expectedGraduationDate: { year: 2027, month: 5 } });
    expect(currentStudentAnswer(QUESTION, studying, TODAY)).toEqual({ answer: 'YES', basis: 'STUDENT_FROM_EDUCATION' });
  });

  it('没勾在读、但已开学且结束在以后 → YES', () => {
    expect(currentStudentAnswer(QUESTION, education({ startDate: { year: 2025, month: 9 }, endDate: { year: 2027, month: 6 } }), TODAY))
      .toMatchObject({ answer: 'YES' });
  });

  it('每一段都早已结束 → NO', () => {
    const graduated = parseApplyProfileCollections({
      educations: [
        { school: 'Example University', startDate: { year: 2016, month: 9 }, endDate: { year: 2020, month: 6 } },
        { school: 'Example College', startDate: { year: 2020, month: 9 }, endDate: { year: 2022, month: 5 } },
      ],
    });
    expect(currentStudentAnswer(QUESTION, graduated, TODAY)).toEqual({ answer: 'NO', basis: 'STUDENT_FROM_EDUCATION' });
  });

  it.each([
    ['有一段既没标在读也没有结束时间', { startDate: { year: 2020, month: 9 } }],
    ['标着在读却早过了毕业时间（资料没更新）', { isCurrent: true, endDate: { year: 2023, month: 5 } }],
    ['这个月刚好结束', { startDate: { year: 2022, month: 9 }, endDate: { year: 2026, month: 10 } }],
    ['只写了今年结束（说不清是哪个月）', { startDate: { year: 2022, month: 9 }, endDate: { year: 2026, month: null } }],
  ])('%s → 不答', (_why, fields) => {
    expect(currentStudentAnswer(QUESTION, education(fields), TODAY)).toBeNull();
  });

  it('没有教育经历、或不知道今天 → 不答', () => {
    expect(currentStudentAnswer(QUESTION, {}, TODAY)).toBeNull();
    expect(currentStudentAnswer(QUESTION, education({ isCurrent: true }), undefined)).toBeNull();
  });

  it.each([
    'Are you attending school this term?',
    'Are you currently a student?',
    'Are you a current student?',
    'Are you currently enrolled in college or university?',
    'Are you enrolled in a university program this semester?',
  ])('「%s」→ 认', (text) => {
    expect(currentStudentAnswer(text, education({ isCurrent: true }), TODAY)).toMatchObject({ answer: 'YES' });
  });

  it.each([
    'Are you a full-time student?',
    'Are you currently attending high school?',
    'Are you planning to enroll in a degree program?',
    'Will you be a student next semester?',
    'Are you an international student on an F-1 visa?',
    'Are you graduating this year?',
    'Are you not currently enrolled in school?',
  ])('「%s」→ 不认', (text) => {
    expect(currentStudentAnswer(text, education({ isCurrent: true }), TODAY)).toBeNull();
  });
});

describe('你服过兵役吗', () => {
  const CIVILIAN = parseApplyProfileCollections({
    experiences: [{ company: 'Acme Robotics', title: 'Software Engineer' }],
    educations: [{ school: 'Example University' }],
  });

  it.each([
    'Have you served in the military?',
    'Have you ever served in the U.S. Armed Forces?',
    'Have you ever served in the United States military?',
    'Did you serve in the military?',
    'Do you have prior military service?',
  ])('「%s」→ NO（工作经历里没有军职）', (text) => {
    expect(militaryServiceAnswer(text, CIVILIAN)).toEqual({ answer: 'NO', basis: 'NO_MILITARY_SERVICE_IN_HISTORY' });
  });

  it('有一段像军职、或一段工作经历都没有 → 不答', () => {
    const veteran = parseApplyProfileCollections({ experiences: [{ company: 'U.S. Navy', title: 'Petty Officer' }] });
    expect(militaryServiceAnswer('Have you served in the military?', veteran)).toBeNull();
    expect(militaryServiceAnswer('Have you served in the military?', parseApplyProfileCollections({ educations: [{ school: 'Example University' }] }))).toBeNull();
  });

  it.each([
    'Are you a protected veteran?',
    'Has your spouse served in the military?',
    'If you have served in the military, which branch?',
    'Have you served in the military? Please list your branch and dates.',
    'What was your military discharge type?',
    // 与军方合作过（比如国防承包商）不是服役：经历里没有军职也推不出「否」。
    'Have you worked with the military as a contractor?',
  ])('「%s」→ 不认', (text) => {
    expect(militaryServiceAnswer(text, CIVILIAN)).toBeNull();
  });
});

describe('在这家公司工作过吗：两处小补', () => {
  const history = parseApplyProfileCollections({
    experiences: [{ company: 'Initech', title: 'Engineer', startDate: { year: 2019, month: 1 }, endDate: { year: 2021, month: 6 } }],
  });

  it('「employed by any of Acme entities」：打头的 any of 不算对象 → 问现在、经历里没有 → NO', () => {
    expect(hiringCompanyEmployment('Are you employed by any of Acme entities?', 'Acme', history)).toEqual({ answer: 'NO', basis: 'EMPLOYER_NOT_IN_HISTORY' });
    expect(hiringCompanyEmployment('Have you worked for any of the Acme subsidiaries?', 'Acme', history)).toMatchObject({ answer: 'NO' });
  });

  it('岗位写着「Acme SE」「Acme N.V.」，题面与经历写「Acme」→ 同一家', () => {
    expect(normalizeCompany('Acme SE')).toBe(normalizeCompany('Acme'));
    expect(normalizeCompany('Acme N.V.')).toBe(normalizeCompany('Acme'));
    expect(hiringCompanyEmployment('Have you ever worked for Acme?', 'Acme SE', history)).toMatchObject({ answer: 'NO' });
  });
});

function greenhouse(controls: string): ApplyFormDescriptor {
  document.body.innerHTML = `<form id="application-form">
    <label for="first_name">First Name</label><input id="first_name" type="text" />
    ${controls}
  </form>`;
  const adapter = compileBundledAdapter(greenhouseRules);
  const root = adapter.resolveRoot(document)!;
  return { vendor: 'greenhouse', root, fields: [...adapter.scan(root)] };
}

describe('接进计划', () => {
  const STUDENT = 'Are you attending school this term?';
  const SERVED = 'Have you served in the military?';
  const COLLECTIONS = parseApplyProfileCollections({
    experiences: [{ company: 'Acme Robotics', title: 'Software Engineer', startDate: { year: 2022, month: 6 }, endDate: { year: 2022, month: 8 } }],
    educations: [{ school: 'Example University', isCurrent: true, startDate: { year: 2023, month: 9 }, expectedGraduationDate: { year: 2027, month: 5 } }],
  });
  const radios = (name: string, label: string) => `<fieldset><legend>${label}</legend>
    <label><input name="${name}" type="radio" value="y" /> Yes</label><label><input name="${name}" type="radio" value="n" /> No</label></fieldset>`;

  it('单选：在读选 Yes（currentStudent）、服过兵役选 No（militaryService），依据带上', () => {
    const result = buildApplyPlan(greenhouse(radios('s', STUDENT) + radios('m', SERVED)), {} as never, { collections: COLLECTIONS, today: TODAY });
    expect(result.entries.find((entry) => entry.label === STUDENT)).toMatchObject({ key: 'currentStudent', value: 'Yes', historyBasis: 'STUDENT_FROM_EDUCATION' });
    expect(result.entries.find((entry) => entry.label === SERVED)).toMatchObject({ key: 'militaryService', value: 'No', historyBasis: 'NO_MILITARY_SERVICE_IN_HISTORY' });
  });

  it('下拉：服过兵役选 No', () => {
    const select = `<label for="mil">${SERVED}</label><select id="mil"><option value="">Select...</option><option>Yes</option><option>No</option></select>`;
    const result = buildApplyPlan(greenhouse(select), {} as never, { collections: COLLECTIONS, today: TODAY });
    expect(result.entries.find((entry) => entry.label === SERVED)).toMatchObject({ kind: 'select', key: 'militaryService', resolvedOptionText: 'No' });
  });
});
