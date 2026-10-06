/**
 * 把档案里存的 EEO 枚举值对到**页面上真实存在的那个选项**。
 *
 * 不生成文字，只从页面给出的选项里挑：下游 `chosenOptions` 用的是精确文本匹配，
 * 而 EEO 选项的措辞是法定的（CC-305 的三项由 OFCCP 规定字句），我们既不该改写它，
 * 也不该猜一个页面上没有的说法。
 *
 * ## 必须恰好命中一个
 *
 * 零个或多个都返回 null。多个命中意味着我们分不清用户该选哪一项，而这一类题
 * 选错是在一份正式申请里对雇主做了一个关于本人身份的错误陈述。
 *
 * ## DECLINE 是一个答案，不是空值
 *
 * 「不愿回答」在美国申请表上是法律要求雇主提供的选项。用户在档案里选了它，
 * 就该照样勾上；而档案里**没有值**时不能替他勾任何一项，包括不能替他勾这一项。
 * 那个判断在调用方，这里只负责"给定一个值，页面上哪一项对应它"。
 */

const DECLINE = /\bdecline\b|\bprefer not\b|\bdo(?:n'?t| not) (?:wish|want)\b|\bnot to (?:answer|disclose|self.?identify)\b|\bchoose not\b|不愿|不想回答|拒绝回答/iu;

/** 每个值的匹配式。顺序无关——命中必须唯一，所以互斥性由式子本身保证。 */
const MATCHERS: Readonly<Record<string, RegExp>> = Object.freeze({
  // 性别
  MALE: /^\s*(?:male|man)\b/iu,
  FEMALE: /^\s*(?:female|woman)\b/iu,
  NON_BINARY: /\bnon[-\s]?binary\b|\bgenderqueer\b|\bnon[-\s]?conforming\b/iu,

  // 族裔（EEO-1 七类，措辞照搬）
  HISPANIC_OR_LATINO: /\bhispanic\b|\blatin[ox]\b/iu,
  WHITE: /^\s*white\b/iu,
  BLACK_OR_AFRICAN_AMERICAN: /\bblack\b|\bafrican american\b/iu,
  NATIVE_HAWAIIAN_OR_OTHER_PACIFIC_ISLANDER: /\bnative hawaiian\b|\bpacific islander\b/iu,
  ASIAN: /^\s*asian\b/iu,
  AMERICAN_INDIAN_OR_ALASKA_NATIVE: /\bamerican indian\b|\balaska native\b/iu,
  TWO_OR_MORE_RACES: /\btwo or more races\b|\bmultiracial\b|\bmulti[-\s]?racial\b/iu,

  // 退伍（VEVRAA 自我认同表的三项；有的表多一项「退伍了但不受保护」，见下面的 EXCLUDES）。
  // 复数 veterans 也认：OFCCP 表上是「…classifications of protected veterans listed above」。
  // 「不是受保护」的每一支都必须说到 protected：用户只否认过受保护的身份，「No, I am not a veteran」
  // 答的是另一个问题。
  PROTECTED_VETERAN: /\bidentify as (?:one or more|a)\b.*\bprotected veterans?\b|\byes\b.*\bprotected veterans?\b|\bi am a protected veteran\b/iu,
  NOT_PROTECTED_VETERAN: /\bi am not\b.*\bprotected veterans?\b|\bnot a protected veterans?\b|^\s*no\b.*\bprotected veterans?\b/iu,

  // 残障（CC-305 恰好三项）；「是否拉美裔」「是否跨性别」「是否 LGBTQ+」同样是这两项
  YES: /^\s*yes\b/iu,
  NO: /^\s*no\b/iu,

  // 性取向（2026-09-23，门户那六项）。合并的选项（「Gay or Lesbian」「Heterosexual or straight」）
  // 只要恰好一项说到他那一档就算。
  ASEXUAL: /\basexual\b/iu,
  GAY: /\bgay\b/iu,
  LESBIAN: /\blesbian\b/iu,
  HETEROSEXUAL: /\bheterosexual\b|\bstraight\b/iu,
  QUEER: /\bqueer\b/iu,
  // 门户的「Bisexual / Pansexual」是一档，宿主可能分成两项：说到其一的都算命中，分列时命中两项，
  // 按「恰好一个」的纪律不选；只剩一项时它还得说到 bisexual（见 ALSO_REQUIRED）。
  BISEXUAL_PANSEXUAL: /\bbi-?sexual\b|\bpan-?sexual\b/iu,
});

/**
 * 恰好命中的那一项还得满足的条件。宿主只列了「Pansexual」而没有「Bisexual」时，门户那一档说不清
 * 他是哪一个——负责人认的是单列的「Bisexual」或两者合并的一项。
 */
const ALSO_REQUIRED: Readonly<Record<string, RegExp>> = Object.freeze({
  BISEXUAL_PANSEXUAL: /\bbi-?sexual\b/iu,
});

/**
 * 命中了也不算的那些选项。
 *
 * 四项的退伍题（2026-09-22 nvidia.wd5 第 4 步原文）多一项「I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED
 * VETERAN」。门户给用户的三档里，「I am not a protected veteran」说不清是「不是退伍军人」还是「退伍了但不受保护」：
 *  · 它不许命中任何**承认自己是退伍军人**的选项——从前在这种表上它唯一命中那一项，等于替一个没当过兵
 *    的人声称退伍；于是在四项表上它一项都不命中，交还用户；
 *  · 它也不许命中**否认自己是退伍军人**的选项（「…not a veteran or a protected veteran」）——退伍了但不受保护
 *    的人也在这一档里；
 *  · 「受保护退伍军人」不许命中**带否定**的选项——同一句里既有 identify as a 又有 protected veteran；
 *    否定写成 don't / don’t 也一样。
 */
const EXCLUDES: Readonly<Record<string, RegExp>> = Object.freeze({
  PROTECTED_VETERAN: /(?:\bnot\b|n['’]t\b)[^.]*\bprotected veterans?\b/iu,
  NOT_PROTECTED_VETERAN: /\bidentify as a veteran\b|\bi am a veteran\b|\bjust not\b|\bnot a veterans?\b/iu,
});

/**
 * EEO-1 的书写惯例：七项里有六项带「(Not Hispanic or Latino)」后缀，用来把族裔与
 * 种族分开。不剥掉它，匹配拉美裔那一项时七项全中、整题作废。
 *
 * 只剥**否定式**括号，别的括号照留——「Male (cisgender)」那种是真的在区分两项，
 * 剥掉反而会把两项看成同一项。
 */
function matchable(label: string): string {
  return label.normalize('NFKC').replace(/\((?:not|non)\b[^)]*\)/giu, ' ').trim();
}

/**
 * @param storedValue 档案里的枚举值（`DECLINE` 也是一个值）
 * @param optionLabels 页面上这一题的全部选项文字，原样
 * @returns 恰好命中的那一项的原文；零个或多个命中时 null
 */
export function selfIdentificationOption(
  storedValue: string,
  optionLabels: readonly string[],
): string | null {
  const pattern = storedValue === 'DECLINE' ? DECLINE : MATCHERS[storedValue];
  if (pattern === undefined) return null;
  // DECLINE 的式子很宽，先把它从候选里排掉再匹配别的值：
  // 「I don't wish to answer」里含 answer，也含别的值可能命中的词。
  const candidates = storedValue === 'DECLINE'
    ? optionLabels
    : optionLabels.filter((label) => !DECLINE.test(label));
  const exclude = EXCLUDES[storedValue];
  const hits = candidates.filter((label) => {
    const text = matchable(label);
    return pattern.test(text) && !(exclude?.test(text) ?? false);
  });
  if (hits.length !== 1) return null;
  return ALSO_REQUIRED[storedValue]?.test(matchable(hits[0]!)) === false ? null : hits[0]!;
}

/**
 * 组合框（react-select 一类）的菜单要点开才有选项，计划期拿不到文字来跑上面的匹配式，
 * 只能给写入期一串**闭集候选**：同一个值在法定表格（EEO-1 / VEVRAA / CC-305）与常见 ATS
 * 上的几种原文写法，按最常见的在前。写入期 `resolveOptionCandidate` 逐个去撞真实菜单，
 * 每级都要求恰好一项，歧义即停——与单选钮那条「恰好命中一个」是同一条纪律，只是晚到写入期判。
 *
 * 只列**同一件事**的不同写法，不列近义：'Female' 与 'Woman' 是同一档，'Non-binary' 不是。
 */
const COMBOBOX_CANDIDATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  MALE: ['Male', 'Man'],
  FEMALE: ['Female', 'Woman'],
  NON_BINARY: ['Non-binary', 'Nonbinary', 'Non-Binary', 'Genderqueer'],
  HISPANIC_OR_LATINO: ['Hispanic or Latino', 'Hispanic/Latino', 'Hispanic or Latinx', 'Hispanic or Latina'],
  WHITE: ['White (Not Hispanic or Latino)', 'White'],
  BLACK_OR_AFRICAN_AMERICAN: ['Black or African American (Not Hispanic or Latino)', 'Black or African American'],
  NATIVE_HAWAIIAN_OR_OTHER_PACIFIC_ISLANDER: [
    'Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)',
    'Native Hawaiian or Other Pacific Islander',
  ],
  ASIAN: ['Asian (Not Hispanic or Latino)', 'Asian'],
  AMERICAN_INDIAN_OR_ALASKA_NATIVE: [
    'American Indian or Alaska Native (Not Hispanic or Latino)',
    'American Indian or Alaska Native',
    'American Indian or Alaskan Native',
  ],
  TWO_OR_MORE_RACES: ['Two or More Races (Not Hispanic or Latino)', 'Two or More Races', 'Two or more races'],
  PROTECTED_VETERAN: [
    'I identify as one or more of the classifications of a protected veteran',
    'I am a protected veteran',
    'Identify as one or more of the classifications of protected veteran',
    // OFCCP 表原文（2026-09-22 nvidia.wd5 第 4 步，全大写）：从前三条都撞不上它。
    'I identify as one or more of the classifications of protected veterans listed above',
    'I identify as one or more of the classifications of protected veteran listed above',
  ],
  // 不带「I am not a veteran」：档案这一档说的是「不是受保护退伍军人」，退伍了但不受保护的人也在这一档里，
  // 替他选「我不是退伍军人」就是一句不实陈述。那种表上这一题交还用户。
  NOT_PROTECTED_VETERAN: ['I am not a protected veteran'],
  YES: ['Yes'],
  NO: ['No'],
  // 性取向（2026-09-23）。每个候选只有一个词：写入期 `matchOption` 在候选阶梯之后还有一道「机构名」
  // 兜底——菜单项的词序列是候选的严格前缀就算中（为「University of Washington, Bothell」→ 名单里的
  // 「University of Washington」而设）。多词候选因此会被更短的菜单项接走：「Gay or Lesbian」接到
  // 单列的「Gay」，「Bisexual and/or pansexual」接到与「Pansexual」分列的「Bisexual」。单词候选
  // 没有严格前缀；合并的菜单项（「Heterosexual or straight」「Gay, lesbian」）由阶梯的词边界前缀接住。
  //
  // 双性恋／泛性恋因此在组合框上一个候选都不给：它唯一诚实的写法是两者合并的一项，而那是多词的；
  // 裸的「Bisexual」在分列的菜单上又会唯一撞中。计划期看不到菜单，交还用户（单选与原生下拉照答）。
  ASEXUAL: ['Asexual'],
  GAY: ['Gay'],
  LESBIAN: ['Lesbian'],
  HETEROSEXUAL: ['Heterosexual', 'Straight'],
  QUEER: ['Queer'],
  DECLINE: [
    'Decline To Self Identify',
    'Decline to self-identify',
    "I don't wish to answer",
    'I do not want to answer',
    'I do not wish to answer',
    'Prefer not to say',
    'Prefer not to answer',
    'Decline to answer',
    'Decline to state',
    // 2026-09-22 nvidia.wd5 第 4 步原文是「I DO NOT WISH TO SELF-IDENTIFY」，从前一条都撞不上。
    'I do not wish to self-identify',
    "I don't wish to self-identify",
    'I choose not to self-identify',
    // 人口统计题（跨性别、性取向、LGBTQ+）上常见的两句。
    'I prefer not to answer',
    'I prefer not to say',
    // 2026-09-24 ats.rippling.com/moov 的自我认同下拉（种族、退伍、性别、是否拉美裔）都用这一句。
    'Choose not to disclose',
  ],
});

/** 组合框上这个值的闭集候选（见上）；没登记的值给空表——不是我们该猜的。 */
export function selfIdentificationComboboxCandidates(storedValue: string): readonly string[] {
  return COMBOBOX_CANDIDATES[storedValue] ?? [];
}
