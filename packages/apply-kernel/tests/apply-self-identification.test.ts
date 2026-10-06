/**
 * 标签逐字取自 352 个真实申请页上的 147 个 EEO 必填字段（去重 20 种）。
 */

import { describe, expect, it } from 'vitest';

import {
  isHispanicOriginQuestion,
  isMultiSelectPrompt,
  lgbtqCommunityAnswer,
  selfIdentificationConcept,
  transgenderAnswer,
} from '../src/dict/selfIdentification';

describe('这一题问的是四档里的哪一档', () => {
  const CASES: readonly (readonly [string, string])[] = [
    ['Gender', 'GENDER'],
    ['Voluntary Self-Identification of Gender', 'GENDER'],
    ['How do you identify? (gender identity)', 'GENDER'],
    ['What is your gender or gender identity?', 'GENDER'],
    ['What is your gender identity?', 'GENDER'],
    ['Race and Ethnicity', 'RACE'],
    ['How do you identify? (race/ethnicity)', 'RACE'],
    ['What is your race and/or ethnicity? Please check all that apply.', 'RACE'],
    ['What is your race or ethnicity?', 'RACE'],
    ['Are you Hispanic/Latino?', 'RACE'],
    ['Voluntary Self-Identification of Race/Ethnicity', 'RACE'],
    ['Veteran Status', 'VETERAN'],
    ['Military Veteran Status', 'VETERAN'],
    ['Protected Veteran Status', 'VETERAN'],
    ['If you are based in the US, what is your veteran status?', 'VETERAN'],
    ['Disability Status', 'DISABILITY'],
    ['What is your disability status?', 'DISABILITY'],
    ['Do you have a physical or mental disability, impairment, or condition?', 'DISABILITY'],
  ];
  for (const [caption, concept] of CASES) {
    it(`「${caption.slice(0, 44)}」→ ${concept}`, () =>
      expect(selfIdentificationConcept(caption)).toBe(concept));
  }
});

describe('不在认得的几档里的不认', () => {
  it('代词：门户里没有对应的一问', () => {
    expect(selfIdentificationConcept(
      'To ensure we address you correctly, we invite you to enter your pronouns.',
    )).toBeNull();
  });

  it('普通字段不受影响', () => {
    expect(selfIdentificationConcept('Current Job Title')).toBeNull();
    expect(selfIdentificationConcept('How did you hear about us?')).toBeNull();
  });
});

/**
 * 2026-09-23：门户存了「是否跨性别」与性取向（负责人：用户填了什么就回答什么），多了三档。
 * 它们排在性别之前（「性别认同与出生时登记的性别不同吗」带着 gender 一词），退伍、残障、族裔照旧在前。
 */
describe('跨性别、性取向、LGBTQ+ 三档', () => {
  const CASES: readonly (readonly [string, string])[] = [
    ['Do you identify as transgender?', 'TRANSGENDER'],
    ['Are you transgender?', 'TRANSGENDER'],
    ['Transgender (optional)', 'TRANSGENDER'],
    ['Do you identify as transgender? (Transgender refers to a person whose gender identity differs from the sex they were assigned at birth)', 'TRANSGENDER'],
    ['gender identity differs from sex assigned at birth', 'TRANSGENDER'],
    ['Does your gender identity differ from the sex you were assigned at birth?', 'TRANSGENDER'],
    ['Is your gender identity the same as the sex you were assigned at birth?', 'TRANSGENDER'],
    ['你是否认同自己是跨性别者？', 'TRANSGENDER'],
    ['What is your sexual orientation?', 'SEXUAL_ORIENTATION'],
    ['Voluntary Self-Identification of Sexual Orientation', 'SEXUAL_ORIENTATION'],
    ['Sexual orientation (this helps us report on LGBTQ+ inclusion)', 'SEXUAL_ORIENTATION'],
    ['您的性取向', 'SEXUAL_ORIENTATION'],
    ['I consider myself a member of the LGBTQ+ community. (optional)', 'LGBTQ_COMMUNITY'],
    ['Do you identify as a member of the LGBTQIA+ community?', 'LGBTQ_COMMUNITY'],
    ['Do you identify as LGBTQ+?', 'LGBTQ_COMMUNITY'],
    ['Do you identify as LGBTQ+ (lesbian, gay, bisexual, transgender, queer)?', 'LGBTQ_COMMUNITY'],
    ['Do you consider yourself a member of the Lesbian, Gay, Bisexual and/or Transgender community?', 'LGBTQ_COMMUNITY'],
  ];
  for (const [caption, concept] of CASES) {
    it(`「${caption.slice(0, 44)}」→ ${concept}`, () =>
      expect(selfIdentificationConcept(caption)).toBe(concept));
  }

  it('退伍与残障仍然优先：掺在一起的题照旧归它们', () => {
    expect(selfIdentificationConcept('Are you a veteran or a member of the LGBTQ+ community?')).toBe('VETERAN');
    expect(selfIdentificationConcept('Do you identify as transgender or as a person with a disability?')).toBe('DISABILITY');
  });

  it('原来那四档的写法一个都没被抢走', () => {
    expect(selfIdentificationConcept('What is your gender identity?')).toBe('GENDER');
    expect(selfIdentificationConcept('How do you identify? (gender identity)')).toBe('GENDER');
    expect(selfIdentificationConcept('Are you Hispanic/Latino?')).toBe('RACE');
  });

  it('问的是身份之外的事（报名、被联系、活动）或只是条件从句：不认成答「是」的两档', () => {
    for (const caption of [
      'If you identify as LGBTQ+, would you like to join our Pride employee resource group?',
      'As a member of the LGBTQ+ community, would you like to be contacted by our Pride network?',
      'Are you interested in our LGBTQ+ community events?',
      'Would you like to receive information about support for transgender employees?',
    ]) {
      expect(selfIdentificationConcept(caption), caption).toBeNull();
    }
    // 性别题里带一句「若你是跨性别，请选现在的性别」：仍是性别题，与从前逐字相同。
    expect(selfIdentificationConcept('Gender (If you identify as transgender, please select your current gender identity)')).toBe('GENDER');
  });

  it('只问出生时登记的性别、不拿性别认同与它比的，不是跨性别题', () => {
    expect(selfIdentificationConcept('What sex were you assigned at birth?')).toBeNull();
    expect(selfIdentificationConcept('What was your sex assigned at birth? (This may differ from your gender identity)'))
      .not.toBe('TRANSGENDER');
  });
});

/**
 * 2026-09-24：邀请加入员工社群、被联系、报名活动的题，问到的是哪一档身份都不替用户答——答「是」等于替他
 * 报名、同意被联系，答「否」也替他回绝了。从前只有跨性别与 LGBTQ+ 两档这样判，残障、族裔、退伍会被认成
 * 身份题、照档案答上。
 */
describe('邀请加入社群、被联系的题：哪一档都不认', () => {
  it('残障、族裔、退伍、性别、性取向的员工社群邀请', () => {
    for (const caption of [
      'Would you like to join our Disability Employee Resource Group?',
      'If you identify as Hispanic or Latino, would you like to be contacted by our Latinx network?',
      'Are you interested in connecting with our Veterans community?',
      'Would you like to hear from our Women in Engineering group about gender equity events?',
      'Our Disability ERG hosts monthly events. Are you a person with a disability who wants to join?',
      'Would you like to sign up for our Pride community newsletter? (sexual orientation not required)',
    ]) {
      expect(selfIdentificationConcept(caption), caption).toBeNull();
    }
  });

  it('正常的身份题照旧认，哪怕题面里写着「有需要请联系我们」', () => {
    expect(selfIdentificationConcept('Disability Status (If you need an accommodation, please contact our recruiting team)')).toBe('DISABILITY');
    expect(selfIdentificationConcept('If you are Hispanic or Latino, please also select your race')).toBe('RACE');
    expect(selfIdentificationConcept('Are you a protected veteran? Protected veterans may have additional rights under USERRA.')).toBe('VETERAN');
    expect(selfIdentificationConcept('Which of the following racial or ethnic groups do you identify with?')).toBe('RACE');
    expect(selfIdentificationConcept('What is your sexual orientation?')).toBe('SEXUAL_ORIENTATION');
  });
});

describe('两处刻意保守的判断', () => {
  it('把族裔单拎出来问的是否题认得出来', () => {
    expect(isHispanicOriginQuestion('Are you Hispanic/Latino?')).toBe(true);
    // 认出来是为了**不**据此答"否"：EEO-1 把族裔与种族分成两问，单值档案表达不了
    // 「既是亚裔又是拉美裔」，所以选了别的值并不能推出不是拉美裔。
    expect(isHispanicOriginQuestion('What is your race or ethnicity?')).toBe(false);
  });

  it('多选题认得出来', () => {
    expect(isMultiSelectPrompt(
      'What is your race and/or ethnicity? Please check all that apply.',
    )).toBe(true);
    expect(isMultiSelectPrompt('What is your race or ethnicity?')).toBe(false);
  });
});

describe('跨性别题按用户在门户里的回答该答什么', () => {
  const DIRECT = 'Do you identify as transgender?';

  it('直问：照他的话答，是／否／不想回答', () => {
    expect(transgenderAnswer(DIRECT, 'YES')).toBe('YES');
    expect(transgenderAnswer(DIRECT, 'NO')).toBe('NO');
    expect(transgenderAnswer(DIRECT, 'DECLINE')).toBe('DECLINE');
    expect(transgenderAnswer(DIRECT, undefined)).toBeNull();
  });

  it('题里掺了别的身份：只有「是」推得出来', () => {
    const mixed = 'Do you identify as transgender and/or non-binary?';
    expect(transgenderAnswer(mixed, 'YES')).toBe('YES');
    expect(transgenderAnswer(mixed, 'NO')).toBeNull();
    expect(transgenderAnswer(mixed, 'DECLINE')).toBeNull();
  });

  it('拿性别认同与出生时的性别比：「是跨性别」推得出答案（按问法正反），「不是」推不出，不想回答照答', () => {
    const differs = 'Does your gender identity differ from the sex you were assigned at birth?';
    const same = 'Is your gender identity the same as the sex you were assigned at birth?';
    const negated = "My gender identity doesn't match the sex I was assigned at birth";
    expect(transgenderAnswer(differs, 'YES')).toBe('YES');
    expect(transgenderAnswer(same, 'YES')).toBe('NO');
    expect(transgenderAnswer(negated, 'YES')).toBe('YES');
    expect(transgenderAnswer(differs, 'NO')).toBeNull();
    expect(transgenderAnswer(same, 'NO')).toBeNull();
    expect(transgenderAnswer(differs, 'DECLINE')).toBe('DECLINE');
  });
});

describe('「是否 LGBTQ+」由门户里的两问推出（2026-09-23 夜报给负责人的推法）', () => {
  const Q = 'I consider myself a member of the LGBTQ+ community.';

  it.each(['ASEXUAL', 'BISEXUAL_PANSEXUAL', 'GAY', 'LESBIAN', 'QUEER'] as const)('性取向 %s → 是（跨性别怎么答都一样）', (orientation) => {
    expect(lgbtqCommunityAnswer(Q, { orientation })).toBe('YES');
    expect(lgbtqCommunityAnswer(Q, { orientation, transgender: 'NO' })).toBe('YES');
    expect(lgbtqCommunityAnswer(Q, { orientation, transgender: 'DECLINE' })).toBe('YES');
  });

  it('说过自己是跨性别 → 是，哪怕性取向是异性恋或不想回答', () => {
    expect(lgbtqCommunityAnswer(Q, { transgender: 'YES', orientation: 'HETEROSEXUAL' })).toBe('YES');
    expect(lgbtqCommunityAnswer(Q, { transgender: 'YES', orientation: 'DECLINE' })).toBe('YES');
    expect(lgbtqCommunityAnswer(Q, { transgender: 'YES' })).toBe('YES');
  });

  it('否：只在异性恋、又不是跨性别时', () => {
    expect(lgbtqCommunityAnswer(Q, { orientation: 'HETEROSEXUAL', transgender: 'NO' })).toBe('NO');
    expect(lgbtqCommunityAnswer(Q, { orientation: 'HETEROSEXUAL', transgender: 'NO', gender: 'FEMALE' })).toBe('NO');
  });

  it('不想回答：只在两问都不想回答时', () => {
    expect(lgbtqCommunityAnswer(Q, { orientation: 'DECLINE', transgender: 'DECLINE' })).toBe('DECLINE');
  });

  it('其余一律不答：缺一问、一问不想回答另一问是否、已知是非二元', () => {
    expect(lgbtqCommunityAnswer(Q, {})).toBeNull();
    expect(lgbtqCommunityAnswer(Q, { orientation: 'HETEROSEXUAL' })).toBeNull();
    expect(lgbtqCommunityAnswer(Q, { transgender: 'NO' })).toBeNull();
    expect(lgbtqCommunityAnswer(Q, { transgender: 'DECLINE' })).toBeNull();
    expect(lgbtqCommunityAnswer(Q, { orientation: 'DECLINE' })).toBeNull();
    expect(lgbtqCommunityAnswer(Q, { orientation: 'HETEROSEXUAL', transgender: 'DECLINE' })).toBeNull();
    expect(lgbtqCommunityAnswer(Q, { orientation: 'DECLINE', transgender: 'NO' })).toBeNull();
    expect(lgbtqCommunityAnswer(Q, { orientation: 'HETEROSEXUAL', transgender: 'NO', gender: 'NON_BINARY' })).toBeNull();
  });

  it('题里掺了别的群体（「LGBTQ+ 或女性」）：只有「是」推得出来', () => {
    const mixed = 'Do you identify as LGBTQ+, a woman, or a member of another underrepresented group?';
    expect(selfIdentificationConcept(mixed)).toBe('LGBTQ_COMMUNITY');
    expect(lgbtqCommunityAnswer(mixed, { orientation: 'GAY' })).toBe('YES');
    expect(lgbtqCommunityAnswer(mixed, { orientation: 'HETEROSEXUAL', transgender: 'NO' })).toBeNull();
    expect(lgbtqCommunityAnswer(mixed, { orientation: 'DECLINE', transgender: 'DECLINE' })).toBeNull();
  });
});
