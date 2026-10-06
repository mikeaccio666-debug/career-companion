/**
 * 选项文字用的是申请表上的真实措辞：CC-305 的三项由 OFCCP 规定字句，
 * VEVRAA 与 EEO-1 同理。
 */

import { describe, expect, it } from 'vitest';

import { resolveOptionCandidate } from '../src/click/optionSearch';
import { selfIdentificationComboboxCandidates, selfIdentificationOption } from '../src/dict/selfIdentificationOptions';
import { matchOption } from '../src/write/listboxCombobox';

const GENDER = ['Male', 'Female', 'Non-binary', 'Decline to self identify'];

const DISABILITY = [
  'Yes, I have a disability, or have had one in the past',
  'No, I do not have a disability and have not had one in the past',
  'I do not want to answer',
];

const VETERAN = [
  'I identify as one or more of the classifications of a protected veteran',
  'I am not a protected veteran',
  "I don't wish to answer",
];

const RACE = [
  'Hispanic or Latino',
  'White (Not Hispanic or Latino)',
  'Black or African American (Not Hispanic or Latino)',
  'Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)',
  'Asian (Not Hispanic or Latino)',
  'American Indian or Alaska Native (Not Hispanic or Latino)',
  'Two or More Races (Not Hispanic or Latino)',
  'Decline to self identify',
];

describe('性别', () => {
  it('挑出页面上那一项的原文', () => {
    expect(selfIdentificationOption('MALE', GENDER)).toBe('Male');
    expect(selfIdentificationOption('FEMALE', GENDER)).toBe('Female');
    expect(selfIdentificationOption('NON_BINARY', GENDER)).toBe('Non-binary');
  });
});

describe('残障：CC-305 的三项', () => {
  it('YES / NO 靠开头的 yes/no 分开，而不是靠 disability 这个词', () => {
    expect(selfIdentificationOption('YES', DISABILITY))
      .toBe('Yes, I have a disability, or have had one in the past');
    expect(selfIdentificationOption('NO', DISABILITY))
      .toBe('No, I do not have a disability and have not had one in the past');
  });

  it('不愿回答', () => {
    expect(selfIdentificationOption('DECLINE', DISABILITY)).toBe('I do not want to answer');
  });
});

describe('退伍：VEVRAA 的三项', () => {
  it('两个长句互不串', () => {
    expect(selfIdentificationOption('PROTECTED_VETERAN', VETERAN))
      .toBe('I identify as one or more of the classifications of a protected veteran');
    expect(selfIdentificationOption('NOT_PROTECTED_VETERAN', VETERAN))
      .toBe('I am not a protected veteran');
  });

  it('不愿回答', () => {
    expect(selfIdentificationOption('DECLINE', VETERAN)).toBe("I don't wish to answer");
  });
});

/**
 * 四项的退伍题（2026-09-22 nvidia.wd5 第 4 步 Voluntary Disclosures 原文，全大写）：多了一项「是退伍军人、
 * 但不是受保护的」。档案里只有三档，「不是受保护退伍军人」说不清是「不是退伍军人」还是「退伍了但不受保护」——
 * 两项里挑哪一项都可能是一句关于本人身份的不实陈述，所以交还用户。
 */
const VETERAN_FOUR = [
  'I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERANS LISTED ABOVE',
  'I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN',
  'I AM NOT A VETERAN',
  'I DO NOT WISH TO SELF-IDENTIFY',
];

describe('退伍：四项的那种（多一项「退伍了但不受保护」）', () => {
  it('受保护退伍军人 → 只命中那一项（复数 veterans 也认，带否定的那一项不算）', () => {
    expect(selfIdentificationOption('PROTECTED_VETERAN', VETERAN_FOUR))
      .toBe('I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERANS LISTED ABOVE');
  });

  it('不是受保护退伍军人 → 说不清是哪一项，不答（从前会唯一命中「I IDENTIFY AS A VETERAN…」，替没当过兵的人声称退伍）', () => {
    expect(selfIdentificationOption('NOT_PROTECTED_VETERAN', VETERAN_FOUR)).toBeNull();
  });

  it('不愿回答 → self-identify 的说法', () => {
    expect(selfIdentificationOption('DECLINE', VETERAN_FOUR)).toBe('I DO NOT WISH TO SELF-IDENTIFY');
  });
});

/**
 * 门户给用户的三档是「I am a protected veteran / I am not a protected veteran / I don't wish to answer」——
 * 选了中间那档的用户，只说过自己不是**受保护的**退伍军人。「是不是退伍军人」本身，不替他说是，也不替他说不是；
 * 受保护的那一档反过来，否定句不论写成 not 还是 don't 都不选。
 */
describe('退伍：只替用户说他说过的那一句', () => {
  it('不是受保护退伍军人 →「No, I am not a veteran」不选（那是在答「是不是退伍军人」）', () => {
    expect(selfIdentificationOption('NOT_PROTECTED_VETERAN', ['Yes, I am a veteran', 'No, I am not a veteran', "I don't wish to answer"]))
      .toBeNull();
  });

  it('不是受保护退伍军人 → 同一句里连带否认退伍的也不选', () => {
    expect(selfIdentificationOption('NOT_PROTECTED_VETERAN', ['I am a protected veteran', 'I am not a veteran or a protected veteran', "I don't wish to answer"]))
      .toBeNull();
  });

  it.each(["I don't identify as a protected veteran", 'I don’t identify as a protected veteran'])(
    '受保护退伍军人 → 否定写成 don\'t 也不选：%s',
    (negative) => {
      expect(selfIdentificationOption('PROTECTED_VETERAN', [negative, 'Prefer not to answer'])).toBeNull();
    },
  );

  it('受保护退伍军人 → 否定的那项排除掉，肯定的那项唯一命中', () => {
    expect(selfIdentificationOption('PROTECTED_VETERAN', ['I am a protected veteran', "I don't identify as a protected veteran", 'Prefer not to answer']))
      .toBe('I am a protected veteran');
  });
});

describe('组合框候选（菜单要点开才有选项，写入期逐个去撞）', () => {
  const lower = (value: string) => value.toLowerCase();

  it('受保护退伍军人：带上 OFCCP 表上「…protected veterans listed above」的写法', () => {
    expect(selfIdentificationComboboxCandidates('PROTECTED_VETERAN').map(lower))
      .toContain(lower(VETERAN_FOUR[0]!));
  });

  it('不是受保护退伍军人：不带「I am not a veteran」——那句从来不能保证是真话', () => {
    expect(selfIdentificationComboboxCandidates('NOT_PROTECTED_VETERAN').map(lower)).not.toContain('i am not a veteran');
    expect(selfIdentificationComboboxCandidates('NOT_PROTECTED_VETERAN')).toContain('I am not a protected veteran');
  });

  it('不愿回答：带上 self-identify 的说法', () => {
    expect(selfIdentificationComboboxCandidates('DECLINE').map(lower)).toContain('i do not wish to self-identify');
  });

  // nvidia.wd5 上这一题是 Workday 的按钮下拉，走的正是这条路：写入期拿整串候选按顺序去撞，
  // 靠前的候选撞出歧义会让整轮停手，所以要连顺序一起钉住。
  it('写入期拿整串候选去撞那四项：受保护、不愿回答各中一项，不是受保护的一项都不中', () => {
    const resolve = (value: string) => resolveOptionCandidate(selfIdentificationComboboxCandidates(value), VETERAN_FOUR);
    expect(resolve('PROTECTED_VETERAN')).toMatchObject({ kind: 'MATCH', optionIndex: 0 });
    expect(resolve('NOT_PROTECTED_VETERAN')).toEqual({ kind: 'NO_OPTION_MATCH' });
    expect(resolve('DECLINE')).toMatchObject({ kind: 'MATCH', optionIndex: 3 });
  });
});

describe('族裔：EEO-1 七类', () => {
  // 七项里六项都带「(Not Hispanic or Latino)」后缀——匹配拉美裔那一项时必须
  // 不被这个后缀带偏，否则七项全中、整题作废。
  it('拉美裔不被其余六项的后缀带偏', () => {
    expect(selfIdentificationOption('HISPANIC_OR_LATINO', RACE)).toBe('Hispanic or Latino');
  });

  it('其余六类各自命中', () => {
    const CASES: readonly (readonly [string, string])[] = [
      ['WHITE', 'White (Not Hispanic or Latino)'],
      ['BLACK_OR_AFRICAN_AMERICAN', 'Black or African American (Not Hispanic or Latino)'],
      ['NATIVE_HAWAIIAN_OR_OTHER_PACIFIC_ISLANDER', 'Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)'],
      ['ASIAN', 'Asian (Not Hispanic or Latino)'],
      ['AMERICAN_INDIAN_OR_ALASKA_NATIVE', 'American Indian or Alaska Native (Not Hispanic or Latino)'],
      ['TWO_OR_MORE_RACES', 'Two or More Races (Not Hispanic or Latino)'],
    ];
    for (const [stored, label] of CASES) {
      expect(selfIdentificationOption(stored, RACE)).toBe(label);
    }
  });
});

describe('命中不唯一时一律不选', () => {
  it('页面上没有对应选项', () => {
    expect(selfIdentificationOption('NON_BINARY', ['Male', 'Female'])).toBeNull();
  });

  it('两项都像', () => {
    expect(selfIdentificationOption('MALE', ['Male', 'Male (cisgender)'])).toBeNull();
  });

  it('不认识的值', () => {
    expect(selfIdentificationOption('SOMETHING_ELSE', GENDER)).toBeNull();
  });
});

/**
 * 性取向（2026-09-23）。选项取 Greenhouse 人口统计题的常见写法与各家的合并写法。
 * 门户的「Bisexual / Pansexual」是一档：宿主只有一项说到它（「Bisexual」或两者合并）才选，
 * 分成「Bisexual」「Pansexual」两项时不替他挑。
 */
describe('性取向', () => {
  const ORIENTATION = [
    'Asexual', 'Bisexual and/or pansexual', 'Gay', 'Heterosexual', 'Lesbian', 'Queer',
    'I prefer to self-describe', "I don't wish to answer",
  ];

  it.each([
    ['ASEXUAL', 'Asexual'],
    ['BISEXUAL_PANSEXUAL', 'Bisexual and/or pansexual'],
    ['GAY', 'Gay'],
    ['HETEROSEXUAL', 'Heterosexual'],
    ['LESBIAN', 'Lesbian'],
    ['QUEER', 'Queer'],
    ['DECLINE', "I don't wish to answer"],
  ] as const)('%s → 「%s」', (code, option) => {
    expect(selfIdentificationOption(code, ORIENTATION)).toBe(option);
  });

  it('合并的选项：恰好一项说到他那一档就选它', () => {
    const merged = ['Straight/Heterosexual', 'Gay or Lesbian', 'Bisexual', 'Prefer to self-describe', 'Prefer not to say'];
    expect(selfIdentificationOption('HETEROSEXUAL', merged)).toBe('Straight/Heterosexual');
    expect(selfIdentificationOption('GAY', merged)).toBe('Gay or Lesbian');
    expect(selfIdentificationOption('LESBIAN', merged)).toBe('Gay or Lesbian');
  });

  it('双性恋／泛性恋：单列的「Bisexual」或合并的一项才选；分成两项、或只有「Pansexual」不选', () => {
    expect(selfIdentificationOption('BISEXUAL_PANSEXUAL', ['Gay', 'Bisexual', 'Heterosexual'])).toBe('Bisexual');
    expect(selfIdentificationOption('BISEXUAL_PANSEXUAL', ['Gay', 'Bisexual/Pansexual', 'Heterosexual'])).toBe('Bisexual/Pansexual');
    expect(selfIdentificationOption('BISEXUAL_PANSEXUAL', ['Gay', 'Bisexual', 'Pansexual', 'Heterosexual'])).toBeNull();
    expect(selfIdentificationOption('BISEXUAL_PANSEXUAL', ['Gay', 'Pansexual', 'Heterosexual'])).toBeNull();
  });

  it('页面上没有他那一档：不选，也不退到「自行描述」或「其他」', () => {
    expect(selfIdentificationOption('QUEER', ['Gay', 'Heterosexual', 'Other', 'I prefer to self-describe'])).toBeNull();
    expect(selfIdentificationOption('ASEXUAL', ['Gay', 'Lesbian', 'Heterosexual'])).toBeNull();
  });

  describe('组合框：写入期拿候选去撞真实菜单（整条 matchOption，含它的兜底）', () => {
    const menu = (texts: readonly string[]) => texts.map((text) => {
      const option = document.createElement('div');
      option.textContent = text;
      return option;
    });
    const pick = (code: string, texts: readonly string[]) => {
      const match = matchOption(selfIdentificationComboboxCandidates(code), menu(texts));
      return match.kind === 'MATCH' ? match.option.textContent : match.kind;
    };

    it('常见菜单上各中一项；合并的菜单项由词边界前缀接住', () => {
      expect(pick('GAY', ORIENTATION)).toBe('Gay');
      expect(pick('ASEXUAL', ORIENTATION)).toBe('Asexual');
      expect(pick('HETEROSEXUAL', ['Heterosexual or straight', 'Gay', 'Lesbian'])).toBe('Heterosexual or straight');
      expect(pick('HETEROSEXUAL', ['Straight/Heterosexual', 'Gay', 'Lesbian'])).toBe('Straight/Heterosexual');
      expect(pick('DECLINE', ['Yes', 'No', 'I prefer not to answer'])).toBe('I prefer not to answer');
    });

    it('多词候选会被更短的菜单项接走——所以性取向的候选一律是单个词', () => {
      // 这就是那道机构名兜底：若候选写成两者合并的样子，分列的菜单上会替他选了「Bisexual」。
      expect(matchOption(['Bisexual and/or pansexual'], menu(['Asexual', 'Bisexual', 'Pansexual', 'Gay'])))
        .toMatchObject({ kind: 'MATCH' });
      for (const code of ['ASEXUAL', 'GAY', 'LESBIAN', 'HETEROSEXUAL', 'QUEER']) {
        for (const candidate of selfIdentificationComboboxCandidates(code)) {
          expect(candidate, code).toMatch(/^\p{L}+$/u);
        }
      }
    });

    it('双性恋／泛性恋在组合框上一个候选都不给：分列的菜单上不能替他挑', () => {
      expect(selfIdentificationComboboxCandidates('BISEXUAL_PANSEXUAL')).toEqual([]);
    });

    it('女同性恋：只有「Gay or lesbian」的菜单不选（从不退到单列的「Gay」）', () => {
      expect(pick('LESBIAN', ['Straight', 'Gay or lesbian', 'Bisexual'])).toBe('NO_OPTION_MATCH');
      expect(pick('LESBIAN', ['Straight', 'Gay', 'Bisexual'])).toBe('NO_OPTION_MATCH');
      expect(pick('LESBIAN', ['Straight', 'Gay', 'Lesbian'])).toBe('Lesbian');
    });
  });
});
