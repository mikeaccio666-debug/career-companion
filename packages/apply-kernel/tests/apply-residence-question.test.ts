import { describe, expect, it } from 'vitest';

import { isCurrentResidenceQuestion, residenceRegion } from '../src/dict/residence';

/**
 * 「你现在人在 X 吗」——语料取自真实申请页。
 *
 * 这一类在 2026-09-18 的 100 页批测里被判成「没把握，没敢填」，可它的答案就在
 * 档案的 `addressCountry` 里，而 Country 那一栏我们本来就照抄进表单了。
 *
 * 但边界很窄，窄的地方全在下面的拒绝用例里。
 */

describe('认得出「你现在人在某处」', () => {
  it.each([
    'Are you currently located in the US?',
    'Do you currently reside in the United States?',
    'Are you based in Canada?',
    'Do you live in the United Kingdom?',
    'Are you currently residing in Germany?',
    'What is your current location?',
  ])('%s', (text) => {
    expect(isCurrentResidenceQuestion(text)).toBe(true);
  });
});

describe('掺了搬迁或意愿的，一律不认', () => {
  // 「愿不愿意搬」是偏好，档案里没有也推不出来。前半句答得上来不等于整道题答得
  // 上来——答一半等于替用户表了态。
  it.each([
    'Are you currently based in or willing to relocate to New York?',
    'Are you located in the Bay Area or open to relocating?',
    'Do you live in Seattle, or are you prepared to move to Seattle?',
    'Are you open to working in-person in one of our offices 2-3 days a week?',
  ])('%s', (text) => {
    expect(isCurrentResidenceQuestion(text)).toBe(false);
  });
});

describe('工作许可与担保不归这里管', () => {
  // 让一道法律问题落到地址判读里，等于把它当成地址题答掉。
  it.each([
    'Are you legally authorized to work in the United States?',
    'Will you now or in the future require sponsorship to work in the US?',
    'Do you currently hold a valid work permit for Canada?',
    'Do you have the right to work in the UK?',
  ])('%s', (text) => {
    expect(isCurrentResidenceQuestion(text)).toBe(false);
  });
});

describe('别的题不认', () => {
  it.each([
    'Why do you want to work here?',
    'How did you hear about us?',
    'Where did you go to school?',
    'Additional Information',
  ])('%s', (text) => {
    expect(isCurrentResidenceQuestion(text)).toBe(false);
  });
});

describe('国家必须点名，而且必须是档案里的那一个', () => {
  it('点名了档案里的国家：认出来', () => {
    expect(residenceRegion('Are you currently located in the US?', 'US')).toBe('US');
    expect(residenceRegion('Do you currently reside in the United States?', 'us')).toBe('US');
  });

  // 不点名就不答，理由与工作授权一字不差：答错不是少填一栏，是向雇主做了一个
  // 不实的事实陈述。
  it.each([
    'Are you currently located in the country where this role is based?',
    'Do you reside in the stated location of this role?',
    'Are you based in the same region as this team?',
  ])('没点名国家：%s', (text) => {
    expect(residenceRegion(text, 'US')).toBeNull();
  });

  // 只答得出「是」。点名别的国家时我们分不清「他确实不在那儿」和「这个国名我们
  // 压根没认出来」——认不出就交还给用户。
  it('点名的是别的国家：交还给用户，不替他说「否」', () => {
    expect(residenceRegion('Are you currently located in Canada?', 'US')).toBeNull();
    expect(residenceRegion('Do you live in Japan?', 'US')).toBeNull();
  });

  it('档案里没有国家：无从判起', () => {
    expect(residenceRegion('Are you currently located in the US?', '')).toBeNull();
    expect(residenceRegion('Are you currently located in the US?', 'USA')).toBeNull();
  });

  // 小写 "us" 在「How did you hear about us」里到处都是；裸码只认原文里的大写。
  it('小写 us 不当国家码', () => {
    expect(residenceRegion('Do you live near us?', 'US')).toBeNull();
  });

  // 2026-09-24：美国的州从前按同码的国家认——住在加拿大的人被答成「是，我住在加州」，住在印度的被答成住在印第安纳。
  // 住在哪与工作授权不同：住在美国不等于住在加州，所以州名在这里也不算美国。
  it('点名的是一个州：不落到同码的国家，也不算那个州所在的国家', () => {
    expect(residenceRegion('Do you currently live in California?', 'CA')).toBeNull();
    expect(residenceRegion('Do you currently live in California?', 'US')).toBeNull();
    expect(residenceRegion('Are you currently located in Indiana?', 'IN')).toBeNull();
    expect(residenceRegion('Are you currently based in DE?', 'DE')).toBeNull();
    expect(residenceRegion('Do you currently reside in Georgia?', 'GE')).toBeNull();
    expect(residenceRegion('Are you currently located in Germany?', 'DE')).toBe('DE');
  });
});
