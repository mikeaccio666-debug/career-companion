/**
 * 不带限定的「工作年限」按带日期的工作经历算（2026-10-04，dict/experienceYears.ts）。
 *
 * 要守住的：
 *  · 只答总年限；限定了领域、技能、行业、职能的（relevant、in sales、with Python、industry……）不答；
 *  · 重叠的时间只算一次；志愿者不算；在职的算到这个月；
 *  · 只有年份的日期按最短、最长两种读法各算一遍，落在同一个答案上才答；
 *  · 有一段缺开始日期、或既没结束日期也没标在职、或一段经历都没有，不答；不知道今天是哪天也不答；
 *  · 选项题：两种读法落在同一项、而且恰好一项才选（交界、空档都不答）。
 *
 * 题面与资料全是合成的。
 */

import { afterEach, describe, expect, it } from 'vitest';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';

import type { ApplyFormDescriptor } from '../src/contracts';
import { experienceMonths, experienceOption, totalExperienceQuestion, wholeYears } from '../src/dict/experienceYears';
import { buildApplyPlan } from '../src/engine';
import type { ProfileExperience } from '../src/profileCollections';
import { compileBundledAdapter } from '../src/rules/interpreter';

afterEach(() => { document.body.innerHTML = ''; });

const job = (
  start: [number, number | null] | null,
  end: [number, number | null] | null,
  extra: Partial<ProfileExperience> = {},
): ProfileExperience => ({
  company: 'Acme',
  title: 'Engineer',
  employmentType: 'FULL_TIME',
  startDate: start === null ? null : { year: start[0], month: start[1] },
  endDate: end === null ? null : { year: end[0], month: end[1] },
  location: null,
  isCurrent: false,
  ...extra,
});
const TODAY = '2026-10-04';

describe('认题', () => {
  it.each([
    ['Years of Experience', false],
    ['Years of work experience*', false],
    ['How many years of professional experience do you have?', false],
    ['How many years of experience do you have?', false],
    ['Total years of experience', false],
    ['Number of years of experience', false],
    ['Years of full-time work experience', true],
    ['Total work experience (in years)', false],
    ['How many years have you worked?', false],
  ])('「%s」→ 总年限（只算全职：%s）', (text, fullTimeOnly) => {
    expect(totalExperienceQuestion(text)).toEqual({ fullTimeOnly });
  });

  it.each([
    'How many years of relevant experience do you have?',
    'Years of experience in sales',
    'Years of Python experience',
    'How many years of industry experience do you have?',
    'How many years of management experience do you have?',
    'Years of experience as a team lead',
    'Do you have at least 3 years of experience?',
    'Describe your experience',
  ])('「%s」→ 不认', (text) => {
    expect(totalExperienceQuestion(text)).toBeNull();
  });
});

describe('算月数', () => {
  it('两段不重叠：相加（结束那个月算在里面）', () => {
    const months = experienceMonths([job([2019, 1], [2020, 12]), job([2021, 1], [2021, 6])], TODAY, false);
    expect(months).toEqual({ min: 30, max: 30 });
    expect(wholeYears(months!)).toBe(2);
  });

  it('重叠的只算一次；在职的算到这个月', () => {
    const months = experienceMonths([
      job([2020, 1], [2022, 12]),
      job([2022, 1], null, { isCurrent: true }),
    ], TODAY, false);
    // 2020-01 → 2026-10（含）：82 个月。
    expect(months).toEqual({ min: 82, max: 82 });
    expect(wholeYears(months!)).toBe(6);
  });

  it('志愿者不算；实习算；问全职只算全职', () => {
    const history = [
      job([2018, 1], [2018, 12], { employmentType: 'VOLUNTEER' }),
      job([2019, 6], [2019, 8], { employmentType: 'INTERNSHIP' }),
      job([2020, 1], [2021, 12]),
    ];
    expect(experienceMonths(history, TODAY, false)).toEqual({ min: 27, max: 27 });
    expect(experienceMonths(history, TODAY, true)).toEqual({ min: 24, max: 24 });
  });

  it('问全职、有一段没标雇佣类型 → 说不清', () => {
    expect(experienceMonths([job([2020, 1], [2021, 12], { employmentType: null })], TODAY, true)).toBeNull();
  });

  it('只有年份：两种读法落在同一个整年上才答', () => {
    // 2019 → 2023：最短 2019-12…2023-01（38 个月，3 年），最长 2019-01…2023-12（60 个月，5 年）→ 不答。
    expect(wholeYears(experienceMonths([job([2019, null], [2023, null])], TODAY, false)!)).toBeNull();
    // 2016 → 2026-10（在职）：最短 2016-12…2026-10（119 个月，9 年），最长 130 个月（10 年）→ 不答。
    expect(wholeYears(experienceMonths([job([2016, null], null, { isCurrent: true })], TODAY, false)!)).toBeNull();
    // 起止都有月份就答得准。
    expect(wholeYears(experienceMonths([job([2016, 3], null, { isCurrent: true })], TODAY, false)!)).toBe(10);
  });

  it('说不清的几种 → null', () => {
    expect(experienceMonths([job(null, [2021, 1])], TODAY, false)).toBeNull();
    expect(experienceMonths([job([2020, 1], null)], TODAY, false)).toBeNull(); // 没结束日期也没标在职
    expect(experienceMonths([], TODAY, false)).toBeNull();
    expect(experienceMonths(undefined, TODAY, false)).toBeNull();
    expect(experienceMonths([job([2020, 1], [2021, 1])], undefined, false)).toBeNull();
    expect(experienceMonths([job([2022, 1], [2021, 1])], TODAY, false)).toBeNull(); // 结束早于开始
  });
});

describe('选项题', () => {
  const RANGES = ['Less than 1 year', '1-3 years', '3-5 years', '5+ years'];
  it.each([
    [0, 'Less than 1 year'],
    [30, '1-3 years'],
    [42, '3-5 years'],
    [61, '5+ years'],
    [36, null], // 整 3 年：「1-3」「3-5」都包含
  ])('%i 个月 → %s', (months, option) => {
    expect(experienceOption(RANGES, { min: months, max: months })).toBe(option);
  });

  it('空档（「1-3」「4-6」之间的 3 年半）不答；最短与最长读法落在不同的项不答', () => {
    expect(experienceOption(['1-3 years', '4-6 years'], { min: 42, max: 42 })).toBeNull();
    expect(experienceOption(RANGES, { min: 30, max: 42 })).toBeNull();
  });

  it('「None」只给恰好 0；「2 years」是满 2 年不到 3 年', () => {
    expect(experienceOption(['None', '1 year', '2 years', '3 years or more'], { min: 0, max: 0 })).toBe('None');
    expect(experienceOption(['None', '1 year', '2 years', '3 years or more'], { min: 30, max: 30 })).toBe('2 years');
    expect(experienceOption(['None', '1 year', '2 years', '3 years or more'], { min: 5, max: 5 })).toBeNull();
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
  const COLLECTIONS = { experiences: [job([2020, 1], [2022, 12]), job([2023, 2], null, { isCurrent: true })] };
  const LABEL = 'Years of Experience';

  it('文本框写整年数，键 experienceYears，依据带上', () => {
    const result = buildApplyPlan(greenhouse(`<label for="yoe">${LABEL}</label><input id="yoe" type="text" />`), {} as never, { collections: COLLECTIONS, today: TODAY });
    // 2020-01…2022-12（36）+ 2023-02…2026-10（45）= 81 个月 → 6 年。
    expect(result.entries.find((entry) => entry.label === LABEL)).toMatchObject({
      kind: 'text', key: 'experienceYears', value: '6', confidence: 1, historyBasis: 'EXPERIENCE_YEARS_FROM_HISTORY',
    });
  });

  it('数字框也写整年数', () => {
    const result = buildApplyPlan(greenhouse(`<label for="yoe">${LABEL}</label><input id="yoe" type="number" />`), {} as never, { collections: COLLECTIONS, today: TODAY });
    expect(result.entries.find((entry) => entry.label === LABEL)).toMatchObject({ key: 'experienceYears', value: '6' });
  });

  it('下拉选落进的那一档', () => {
    const select = `<label for="yoe">${LABEL}</label><select id="yoe"><option value="">Select</option><option>0-2 years</option><option>3-5 years</option><option>6-10 years</option><option>10+ years</option></select>`;
    const result = buildApplyPlan(greenhouse(select), {} as never, { collections: COLLECTIONS, today: TODAY });
    expect(result.entries.find((entry) => entry.label === LABEL)).toMatchObject({ kind: 'select', key: 'experienceYears', resolvedOptionText: '6-10 years' });
  });

  it('不知道今天是哪天（调用方没给 today）→ 不答，照原路', () => {
    const result = buildApplyPlan(greenhouse(`<label for="yoe">${LABEL}</label><input id="yoe" type="text" />`), {} as never, { collections: COLLECTIONS });
    expect(result.entries.find((entry) => entry.label === LABEL)).toBeUndefined();
  });

  it('集合没交来 → 不答', () => {
    const result = buildApplyPlan(greenhouse(`<label for="yoe">${LABEL}</label><input id="yoe" type="text" />`), {} as never, { today: TODAY });
    expect(result.entries.find((entry) => entry.label === LABEL)).toBeUndefined();
  });
});
