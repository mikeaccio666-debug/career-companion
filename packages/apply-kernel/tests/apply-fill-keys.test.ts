// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';

import { buildApplyPlan } from '../src/engine';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { flatValueCandidates } from '../src/dict/fillKeyChoices';
import { resolveOptionCandidate } from '../src/click/optionSearch';

/**
 * 填写键扩展（P1-5，2026-09-21）：ats-lab 306 张真实申请页里，规则认得出控件却没有
 * 档案键可对的一档——代词、到岗日期、通知期、简介、期望薪资、是否年满 18、搬迁意愿
 * 与城市、办公模式、Twitter 与其它网站。这组用例钉三件事：
 *
 *  1. 规则把这些标签认到新键上，档案里有值就进计划（文本、日期、textarea、select 各一）。
 *  2. 闭集值（'YEAR'、'true'、'REMOTE,HYBRID'）在 <select> 上按人读写法落到正确的选项。
 *  3. 期望薪资 / 到岗时间 / 搬迁意愿原来一律交还用户（JOB_DEPENDENT）；档案里有值
 *     就按普通字段填，没值仍然交还。
 */
afterEach(() => { document.body.innerHTML = ''; });

const select = (id: string, options: readonly string[], value?: (option: string) => string) =>
  `<select id="${id}"><option value="">Select...</option>${options
    .map((option) => `<option value="${value ? value(option) : option}">${option}</option>`).join('')}</select>`;

function mount(): void {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="first_name">First Name</label><input id="first_name" type="text" />
      <label for="pronouns">Pronouns</label><input id="pronouns" type="text" />
      <label for="start">Date Available</label><input id="start" type="date" />
      <label for="notice">Notice period (days)</label><input id="notice" type="number" />
      <label for="summary">Summary</label><textarea id="summary"></textarea>
      <label for="headline">Headline</label><input id="headline" type="text" />
      <label for="pay">Desired Pay</label><input id="pay" type="text" />
      <label for="currency">Currency</label>${select('currency', ['USD', 'EUR', 'GBP'])}
      <label for="period">Pay period</label>${select('period', ['Annual', 'Monthly', 'Hourly'], (o) => o.toLowerCase())}
      <label for="over18">Are you at least 18 years of age?</label>${select('over18', ['Yes', 'No'])}
      <label for="relocate">Are you willing to relocate?</label>${select('relocate', ['Yes', 'No'])}
      <label for="cities">Which cities would you relocate to?</label><input id="cities" type="text" />
      <label for="mode">Work arrangement</label>${select('mode', ['Remote', 'Hybrid', 'On-site'])}
      <label for="twitter">Twitter URL</label><input id="twitter" type="url" />
      <label for="other">Other website</label><input id="other" type="url" />
    </form>`;
}

const PROFILE = {
  firstName: 'Taylor',
  preferredPronouns: 'she/her',
  earliestStartDate: '2026-10-15',
  noticePeriodDays: '30',
  profileSummary: 'Backend engineer, six years on payments.',
  currentJobTitle: 'Staff Engineer',
  expectedSalaryAmount: '120000',
  expectedSalaryCurrency: 'USD',
  expectedSalaryPeriod: 'YEAR',
  over18: 'true',
  openToRelocation: 'false',
  openToRelocationCities: 'Seattle, Austin',
  preferredWorkModes: 'HYBRID,REMOTE',
  profileTwitterUrl: 'https://x.com/taylor',
  otherWebsiteUrl: 'https://taylor.example',
};

function plan(profile: Record<string, string> = PROFILE) {
  const adapter = compileBundledAdapter(greenhouseRules);
  const root = adapter.resolveRoot(document)!;
  return buildApplyPlan({ vendor: 'greenhouse', root, fields: [...adapter.scan(root)] }, profile, {});
}

describe('新键：规则认得出、档案有值就进计划', () => {
  it('文本、日期、数字、textarea、url 各按其键写档案里的值', () => {
    mount();
    const entries = new Map(plan().entries.map((entry) => [entry.key, entry.value]));
    expect(entries.get('preferredPronouns')).toBe('she/her');
    expect(entries.get('earliestStartDate')).toBe('2026-10-15');
    expect(entries.get('noticePeriodDays')).toBe('30');
    expect(entries.get('profileSummary')).toBe('Backend engineer, six years on payments.');
    expect(entries.get('currentJobTitle')).toBe('Staff Engineer');
    expect(entries.get('expectedSalaryAmount')).toBe('120000');
    expect(entries.get('openToRelocationCities')).toBe('Seattle, Austin');
    expect(entries.get('profileTwitterUrl')).toBe('https://x.com/taylor');
    expect(entries.get('otherWebsiteUrl')).toBe('https://taylor.example');
  });

  it('闭集值在 <select> 上落到人读的那一项：年薪 → Annual，true → Yes，混合 → Hybrid', () => {
    mount();
    const byKey = new Map(plan().entries.map((entry) => [entry.key, entry]));
    expect(byKey.get('expectedSalaryPeriod')?.resolvedOptionText).toBe('Annual');
    expect(byKey.get('expectedSalaryCurrency')?.resolvedOptionText).toBe('USD');
    expect(byKey.get('over18')?.resolvedOptionText).toBe('Yes');
    expect(byKey.get('openToRelocation')?.resolvedOptionText).toBe('No');
    // 档案里的顺序说了算：HYBRID 排在前面，单选下拉落它。
    expect(byKey.get('preferredWorkModes')?.resolvedOptionText).toBe('Hybrid');
  });

  it('没有值的新键如实 NO_VALUE；薪资/到岗/搬迁没值时仍交还用户（JOB_DEPENDENT）', () => {
    mount();
    const result = plan({ firstName: 'Taylor' });
    const reasons = new Map(result.skipped.map((skip) => [skip.label, skip.reason]));
    expect(reasons.get('Pronouns')).toBe('NO_VALUE');
    expect(reasons.get('Twitter URL')).toBe('NO_VALUE');
    // "Date Available" 从来不在 JOB_DEPENDENT 的判据里（那里只认 when can you start /
    // available to start 一类问法），所以它和别的新键一样如实 NO_VALUE。
    expect(reasons.get('Date Available')).toBe('NO_VALUE');
    for (const label of ['Notice period (days)', 'Desired Pay', 'Are you willing to relocate?']) {
      expect(reasons.get(label), label).toBe('JOB_DEPENDENT');
    }
    expect(result.entries.map((entry) => entry.key)).toEqual(['firstName']);
  });
});

describe('代词：完整写法排在短码前面（2026-09-23 Rippling 实测 AMBIGUOUS_OPTION）', () => {
  // Rippling 的代词下拉：同一页既有「He/him/his」又有「He/him/his, they/them/theirs」。
  // 门户存的是「He/Him」，按词边界前缀两条都中，而候选阶梯把歧义当终局。
  const rippling = ['She/her/hers', 'He/him/his', 'They/them/theirs', 'She/her/hers, they/them/theirs', 'He/him/his, they/them/theirs', 'Just use my name'];

  it('He/Him 在 Rippling 的选项里唯一落到 He/him/his', () => {
    const candidates = flatValueCandidates('preferredPronouns', 'He/Him', 'options');
    expect(resolveOptionCandidate(candidates, rippling)).toMatchObject({ kind: 'MATCH', optionIndex: 1 });
  });

  it('She/Her、They/Them 同理', () => {
    expect(resolveOptionCandidate(flatValueCandidates('preferredPronouns', 'She/Her', 'options'), rippling)).toMatchObject({ kind: 'MATCH', optionIndex: 0 });
    expect(resolveOptionCandidate(flatValueCandidates('preferredPronouns', 'They/Them', 'options'), rippling)).toMatchObject({ kind: 'MATCH', optionIndex: 2 });
  });

  it('只写 He/Him 的下拉照样一次就中；存值的大小写与空格不影响', () => {
    const short = ['She/Her', 'He/Him', 'They/Them', 'Prefer not to say'];
    expect(resolveOptionCandidate(flatValueCandidates('preferredPronouns', 'he / him', 'options'), short)).toMatchObject({ kind: 'MATCH', optionIndex: 1 });
    expect(resolveOptionCandidate(flatValueCandidates('preferredPronouns', 'Prefer not to say', 'options'), ['He/him/his', 'I prefer not to answer', 'Prefer not to say'])).toMatchObject({ kind: 'MATCH', optionIndex: 2 });
  });

  it('文本框照写用户自己的写法；没登记的存值原样一个候选', () => {
    expect(flatValueCandidates('preferredPronouns', 'She/Her', 'text')).toEqual(['She/Her']);
    expect(flatValueCandidates('preferredPronouns', 'Ze/Zir', 'options')).toEqual(['Ze/Zir']);
  });
});

describe('闭集值的候选展开', () => {
  it('下拉：码在前、人读写法在后；文本框：人读写法在前', () => {
    expect(flatValueCandidates('expectedSalaryPeriod', 'YEAR', 'options').slice(0, 2)).toEqual(['YEAR', 'Annual']);
    expect(flatValueCandidates('expectedSalaryPeriod', 'YEAR', 'text')[0]).toBe('Annual');
    expect(flatValueCandidates('over18', 'false', 'text')).toEqual(['No', 'false']);
  });

  it('集合值逐项展开、保持档案顺序；没登记的键原样一个候选', () => {
    expect(flatValueCandidates('preferredWorkModes', 'ONSITE,REMOTE', 'options').slice(0, 3)).toEqual(['ONSITE', 'On-site', 'Onsite']);
    expect(flatValueCandidates('preferredWorkModes', 'REMOTE', 'text')[0]).toBe('Remote');
    expect(flatValueCandidates('firstName', 'Taylor', 'options')).toEqual(['Taylor']);
  });
});
