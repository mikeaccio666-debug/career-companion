import { describe, expect, it } from 'vitest';

import { selfIdentificationCodesFromAnswers } from '../src/dict/selfIdentificationAnswers';
import { selfIdentificationOption } from '../src/dict/selfIdentificationOptions';

/**
 * 门户存的是选项原文，内核认的是闭集码——这里钉的是翻译表，以及「认不得就不猜」。
 * 词表原文取自 argoland `sensitive-profile-card.tsx`（2026-09-21）。
 */
describe('门户 EEO 答案原文 → 内核自我认同码', () => {
  it('性别：Woman / Man / Non-binary，自行描述不译、不想回答译成 DECLINE', () => {
    expect(selfIdentificationCodesFromAnswers({ genderIdentity: ['Woman'] })).toEqual({ eeoGender: 'FEMALE' });
    expect(selfIdentificationCodesFromAnswers({ genderIdentity: ['Man'] })).toEqual({ eeoGender: 'MALE' });
    expect(selfIdentificationCodesFromAnswers({ genderIdentity: ['Non-binary'] })).toEqual({ eeoGender: 'NON_BINARY' });
    expect(selfIdentificationCodesFromAnswers({ genderIdentity: ['不想回答'] })).toEqual({ eeoGender: 'DECLINE' });
    expect(selfIdentificationCodesFromAnswers({ genderIdentity: ['自行描述'] })).toEqual({});
  });

  it('性别认同译不出时退到 EEO 性别（Male / Female / Decline to self-identify）', () => {
    expect(selfIdentificationCodesFromAnswers({ genderIdentity: ['自行描述'], eeoSex: ['Female'] })).toEqual({ eeoGender: 'FEMALE' });
    expect(selfIdentificationCodesFromAnswers({ eeoSex: ['Decline to self-identify'] })).toEqual({ eeoGender: 'DECLINE' });
  });

  it('种族：单选译码；两个可译且不同 → TWO_OR_MORE_RACES；有一个译不出就整项不译', () => {
    expect(selfIdentificationCodesFromAnswers({ raceEthnicity: ['White / European'] })).toEqual({ eeoRace: 'WHITE' });
    expect(selfIdentificationCodesFromAnswers({ raceEthnicity: ['East Asian'] })).toEqual({ eeoRace: 'ASIAN' });
    expect(selfIdentificationCodesFromAnswers({ raceEthnicity: ['South Asian', 'Southeast Asian'] })).toEqual({ eeoRace: 'ASIAN' });
    expect(selfIdentificationCodesFromAnswers({ raceEthnicity: ['Black / African descent', 'White / European'] })).toEqual({ eeoRace: 'TWO_OR_MORE_RACES' });
    expect(selfIdentificationCodesFromAnswers({ raceEthnicity: ['Middle Eastern / North African'] })).toEqual({});
    expect(selfIdentificationCodesFromAnswers({ raceEthnicity: ['White / European', 'Middle Eastern / North African'] })).toEqual({});
    expect(selfIdentificationCodesFromAnswers({ raceEthnicity: ['不想回答'] })).toEqual({ eeoRace: 'DECLINE' });
  });

  it('Hispanic / Latino 答 Yes 优先：内核对那类题只认这一个码', () => {
    expect(selfIdentificationCodesFromAnswers({ hispanicLatino: ['Yes'], raceEthnicity: ['White / European'] }))
      .toEqual({ eeoRace: 'HISPANIC_OR_LATINO', hispanicLatino: 'YES' });
    expect(selfIdentificationCodesFromAnswers({ hispanicLatino: ['No'], raceEthnicity: ['White / European'] }))
      .toEqual({ eeoRace: 'WHITE', hispanicLatino: 'NO' });
  });

  // 2026-09-23：门户把「是否拉美裔」当成单独一问存。从前 No 与「不想回答」在这里被丢掉，
  // 那道必填题于是每次都落成「只能由你本人填写」。它们现在各自带出来。
  it('「是否拉美裔」那一问的原话另外带一份：是／否／不想回答', () => {
    expect(selfIdentificationCodesFromAnswers({ hispanicLatino: ['No'] })).toEqual({ hispanicLatino: 'NO' });
    expect(selfIdentificationCodesFromAnswers({ hispanicLatino: ['Decline to self-identify'] })).toEqual({ hispanicLatino: 'DECLINE' });
    expect(selfIdentificationCodesFromAnswers({ hispanicLatino: ['Yes'] })).toEqual({ eeoRace: 'HISPANIC_OR_LATINO', hispanicLatino: 'YES' });
    expect(selfIdentificationCodesFromAnswers({ hispanicLatino: ['Maybe'] })).toEqual({});
  });

  it('退伍与残障：门户的三句话各自落到内核的码上', () => {
    expect(selfIdentificationCodesFromAnswers({ veteranStatus: ['I am a protected veteran'] })).toEqual({ eeoVeteran: 'PROTECTED_VETERAN' });
    expect(selfIdentificationCodesFromAnswers({ veteranStatus: ['I am not a protected veteran'] })).toEqual({ eeoVeteran: 'NOT_PROTECTED_VETERAN' });
    expect(selfIdentificationCodesFromAnswers({ veteranStatus: ["I don't wish to answer"] })).toEqual({ eeoVeteran: 'DECLINE' });
    expect(selfIdentificationCodesFromAnswers({ disabilityStatus: ['Yes, I have a disability, or have had one in the past'] })).toEqual({ eeoDisability: 'YES' });
    expect(selfIdentificationCodesFromAnswers({ disabilityStatus: ['No, I do not have a disability and have not had one in the past'] })).toEqual({ eeoDisability: 'NO' });
    expect(selfIdentificationCodesFromAnswers({ disabilityStatus: ['I do not want to answer'] })).toEqual({ eeoDisability: 'DECLINE' });
  });

  it('译出来的码内核真的能拿去撞宿主选项——两张表对得上', () => {
    const codes = selfIdentificationCodesFromAnswers({
      genderIdentity: ['Woman'], veteranStatus: ['I am not a protected veteran'],
      disabilityStatus: ['No, I do not have a disability and have not had one in the past'], raceEthnicity: ['White / European'],
    });
    expect(selfIdentificationOption(codes.eeoGender!, ['Male', 'Female', 'Decline to self identify'])).toBe('Female');
    expect(selfIdentificationOption(codes.eeoVeteran!, ['I identify as one or more of the classifications of a protected veteran', 'I am not a protected veteran'])).toBe('I am not a protected veteran');
    expect(selfIdentificationOption(codes.eeoDisability!, ['Yes, I have a disability', 'No, I do not have a disability'])).toBe('No, I do not have a disability');
    expect(selfIdentificationOption(codes.eeoRace!, ['White', 'Asian', 'Two or more races'])).toBe('White');
  });

  it('空答案与陌生字段：什么都不译，也不抛', () => {
    expect(selfIdentificationCodesFromAnswers({})).toEqual({});
    expect(selfIdentificationCodesFromAnswers({ genderIdentity: [], orientationSelfDescribe: ['Gay'] })).toEqual({});
  });
});

/**
 * 2026-09-23（负责人：用户填了什么就回答什么）：门户 EEO 那一节还存了「是否跨性别」与性取向，
 * 从前在这里一个字都不译。词表原文取自 argoland `sensitive-profile-card.tsx`：
 * 跨性别 Yes / No / 自行描述 / 不想回答；性取向八项。
 */
describe('「是否跨性别」与性取向', () => {
  it.each([
    ['Yes', 'YES'],
    ['No', 'NO'],
    ['不想回答', 'DECLINE'],
    ['Decline to self-identify', 'DECLINE'],
    ["I don't wish to answer", 'DECLINE'],
  ] as const)('跨性别「%s」→ %s', (answer, code) => {
    expect(selfIdentificationCodesFromAnswers({ transgenderStatus: [answer] })).toEqual({ transgenderStatus: code });
  });

  it.each([
    ['Asexual', 'ASEXUAL'],
    ['Bisexual / Pansexual', 'BISEXUAL_PANSEXUAL'],
    ['Bisexual and/or pansexual', 'BISEXUAL_PANSEXUAL'],
    ['Gay', 'GAY'],
    ['Heterosexual / Straight', 'HETEROSEXUAL'],
    ['Lesbian', 'LESBIAN'],
    ['Queer', 'QUEER'],
    ['不想回答', 'DECLINE'],
    ['Prefer not to say', 'DECLINE'],
  ] as const)('性取向「%s」→ %s', (answer, code) => {
    expect(selfIdentificationCodesFromAnswers({ sexualOrientation: [answer] })).toEqual({ sexualOrientation: code });
  });

  it('自行描述不译：门户的「自行描述」、跟着存进来的原文、英文的 self-describe 都没有码', () => {
    expect(selfIdentificationCodesFromAnswers({ transgenderStatus: ['自行描述'] })).toEqual({});
    expect(selfIdentificationCodesFromAnswers({ sexualOrientation: ['自行描述'] })).toEqual({});
    expect(selfIdentificationCodesFromAnswers({ sexualOrientation: ['I prefer to self-describe'] })).toEqual({});
    expect(selfIdentificationCodesFromAnswers({ sexualOrientation: ['自行描述', 'Gay-leaning demisexual'] })).toEqual({});
  });

  it('认不得的话不译：只认门户的整句，不做包含匹配', () => {
    for (const answer of ['Gay-leaning demisexual', 'Bisexual', 'Pansexual', 'Mostly straight', 'Maybe']) {
      expect(selfIdentificationCodesFromAnswers({ sexualOrientation: [answer] }), answer).toEqual({});
    }
    expect(selfIdentificationCodesFromAnswers({ transgenderStatus: ['Not sure'] })).toEqual({});
  });

  it('一问存了不止一句：每一句都译成同一个码才算，两个不同的码不替他挑', () => {
    expect(selfIdentificationCodesFromAnswers({ sexualOrientation: ['Gay', 'Gay'] })).toEqual({ sexualOrientation: 'GAY' });
    expect(selfIdentificationCodesFromAnswers({ sexualOrientation: ['Gay', 'Queer'] })).toEqual({});
    expect(selfIdentificationCodesFromAnswers({ transgenderStatus: ['Yes', 'No'] })).toEqual({});
  });

  it('其余几问照旧：多带这两句不影响性别、种族、「是否拉美裔」', () => {
    expect(selfIdentificationCodesFromAnswers({
      genderIdentity: ['Woman'], hispanicLatino: ['No'], raceEthnicity: ['East Asian'],
      transgenderStatus: ['No'], sexualOrientation: ['Lesbian'],
    })).toEqual({ eeoGender: 'FEMALE', eeoRace: 'ASIAN', hispanicLatino: 'NO', transgenderStatus: 'NO', sexualOrientation: 'LESBIAN' });
  });
});
