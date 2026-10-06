/**
 * EEO 自我认同题的判读：这一题问的是哪一档。
 *
 * 实测 352 个真实申请页上有 147 个这类必填字段，去重只有 20 种写法，分得很干净：
 *
 *   性别  Gender / What is your gender identity? / How do you identify? (gender identity)
 *   族裔  Race and Ethnicity / What is your race and/or ethnicity? / Are you Hispanic/Latino?
 *   退伍  Veteran Status / Military Veteran Status / Protected Veteran Status
 *   残障  Disability Status / Do you have a physical or mental disability…
 *
 * 判读本身不授予任何写入：`SELF_IDENTIFICATION` 在 `classifyManualOnly` 里是乙档，
 * 写入要单独的能力位与逐次阻塞确认。这里只回答「这是哪一档」。
 *
 * ## 跨性别、性取向、LGBTQ+（2026-09-23）
 *
 * 从前性取向不在这里，理由是「档案里没有对应字段，认出来也无值可填」。门户现在存了「是否跨性别」
 * 与性取向（负责人 2026-09-23：用户填了什么就回答什么），于是多了三档：
 *
 *   跨性别  Do you identify as transgender? / Does your gender identity differ from the sex you were
 *           assigned at birth?
 *   性取向  What is your sexual orientation?
 *   LGBTQ+  I consider myself a member of the LGBTQ+ community.（由前两问推出）
 *
 * 顺序：退伍、残障、族裔照旧在前；三档新题排在性别之前——「性别认同与出生时登记的性别不同吗」
 * 带着 gender 一词，问的却是跨性别。三档之间跨性别在前，而它只认问句（identify as transgender、
 * Are you transgender?…），不认单独出现的这个词：「LGBTQ+（lesbian, gay, bisexual, transgender…）」
 * 里的 transgender 只是举例。LGBTQ+ 同样只认「是不是其中一员」的问法，一句「为了 LGBTQ+ 统计」
 * 不会把性取向题抢走。代词仍不在其内（语料里 1 条，门户也没有）。
 *
 * ## 刻意保守的判断
 *
 * 1. **「Are you Hispanic/Latino?」只在档案值确实是 HISPANIC_OR_LATINO 时才答"是"**。
 *    EEO-1 把族裔与种族分成两问，一个人可以既是亚裔又是拉美裔；我们的档案是单值，
 *    表达不了这一点。所以答"否"没有依据——见 `isHispanicOriginQuestion`。
 * 2. **推不出「否」的地方不答「否」**：题里掺了别的身份或群体（「跨性别或非二元」「LGBTQ+ 或
 *    女性」），或者拿性别认同与出生时的性别比——见 `transgenderAnswer` 与 `lgbtqCommunityAnswer`。
 */

import type { SexualOrientationAnswer, TransgenderAnswer } from './selfIdentificationAnswers';

export type SelfIdentificationConcept =
  | 'GENDER' | 'RACE' | 'VETERAN' | 'DISABILITY'
  | 'TRANSGENDER' | 'SEXUAL_ORIENTATION' | 'LGBTQ_COMMUNITY';

/** 问的就是「你是不是跨性别」：问句、陈述句，或者整个题面只有这一个词。 */
const TRANSGENDER_QUESTION =
  /\bidentif(?:y|ies|ying) (?:yourself |myself )?as (?:a )?transgender\b|\b(?:are you|i am|i'm) (?:a )?transgender\b|(?:^\W*|\byour |\bhave (?:a |any )?)transgender (?:status|identity|experience|history)\b|\b(?:consider|describe) (?:yourself|myself) (?:to be |as )?(?:a )?transgender\b|^\W*transgender(?:\W+optional)?\W*$|跨性别/iu;

/**
 * 拿性别认同与出生时登记的性别比。第 1 组是两者之间的字（找否定词），第 2 组是比较的说法：
 * differ 一族问「不一样吗」，same / match 一族问「一样吗」，带否定的「doesn't match」按「不一样」。
 */
const BIRTH_SEX_COMPARISON =
  /\bgender(?: identity)?\b([^.?]{0,60}?)\b(differ(?:s|ent)?|(?:the )?same|match(?:es)?|aligns?|corresponds?)\b[^.?]{0,60}?\bassigned\b[^.?]{0,20}\bbirth\b/iu;

/**
 * 问的是「你算不算 LGBTQ+ 群体的一员」。只提到一个 LGBTQ 词不算：「为了 LGBTQ+ 统计，请选性取向」
 * 是性取向题，「Are you interested in our LGBTQ+ community events?」问的根本不是身份。
 */
const LGBTQ_QUESTION =
  /\b(?:member|part) of the (?:lgbt|lesbian\b)|\bidentif(?:y|ies|ying) (?:yourself |myself )?(?:as|with) (?:a member of )?(?:the )?lgbt|\bare you (?:a )?lgbt|\b(?:consider|describe) (?:yourself|myself) (?:to be |as )?(?:a member of the |part of the )?lgbt|^\W*lgbt\w*\+?(?: (?:status|identity))?(?:\W+optional)?\W*$|(?:属于|是否是|是)\s*lgbt/iu;

/**
 * 题面在问身份之外的事（2026-09-23）：「If you identify as LGBTQ+, would you like to join our ERG?」
 * 「Gender（If you identify as transgender, select your current gender）」。答「是」的两档（跨性别、
 * LGBTQ+）碰上这种题就不认，让它落到后面的档或交还用户——替他答「是」等于替他报名、同意被联系。
 */
const NOT_ABOUT_IDENTITY =
  /\bif (?:you|i) (?:identify|are|am|consider)\b|\bwould you like\b|\binterested in\b|\bjoin\b|\bcontact(?:ed)?\b|\bconnect(?:ed)? (?:with|to)\b|\breceive\b|\bparticipat|\bresource groups?\b|\berg\b|\bnewsletters?\b|\bmentor|\bevents?\b|如果|是否愿意|加入/iu;

/**
 * 邀请加入员工社群、被联系、报名活动的题（2026-09-24）：「Would you like to join our Disability ERG?」
 * 「If you identify as Hispanic, would you like to be contacted by our Latinx network?」。问到哪一档身份都不认：
 * 答「是」等于替他报名、同意被联系，答「否」也替他回绝了。认的是员工社群的叫法，或「邀请的动作」与「社群、
 * 活动一类的对象」同时出现；只写着「需要便利安排请联系我们」的正常身份题不受影响。
 */
const RESOURCE_GROUP = /\b[eb]rgs?\b|\b(?:employee|business) resource groups?\b|\baffinity groups?\b|\bemployee networks?\b/iu;
const INVITE_ACTION =
  /\bwould you like\b|\binterested in\b|\bjoin(?:ing)?\b|\bbe contacted\b|\bconnect(?:ed|ing)? (?:with|to)\b|\bhear (?:from|about)\b|\breceive (?:information|updates|emails?|communications?)\b|\bsign(?:ing)? up\b|\bopt(?:ing)? in\b|是否愿意|加入/iu;
const INVITE_TARGET =
  /\bcommunit(?:y|ies)\b|\bnetworks?\b|\bgroups?\b|\bprograms?\b|\bclubs?\b|\bchapters?\b|\bevents?\b|\bnewsletters?\b|\bmentor|\brecruit|社群|社区|群体|活动/iu;
const INVITATION = new RegExp(
  `${RESOURCE_GROUP.source}|^(?=[\\s\\S]*(?:${INVITE_ACTION.source}))(?=[\\s\\S]*(?:${INVITE_TARGET.source}))`,
  'iu',
);
/** 答「是」的两档（跨性别、LGBTQ+）连条件从句一类也不认。 */
const NOT_ABOUT_OWN_IDENTITY = new RegExp(`${NOT_ABOUT_IDENTITY.source}|${INVITATION.source}`, 'iu');

/** 顺序即优先级：退伍与残障的写法最定型，先判尽，避免被更宽的族裔词捞走。`unless` 命中时这一档不认，往后找。 */
const CONCEPTS: readonly Readonly<{ concept: SelfIdentificationConcept; pattern: RegExp; unless?: RegExp }>[] =
  Object.freeze([
    { concept: 'VETERAN', pattern: /\bveteran\b|\bmilitary service\b|\bVEVRAA\b|退伍/iu, unless: INVITATION },
    {
      concept: 'DISABILITY',
      pattern: /\bdisabilit(?:y|ies)\b|\bdisabled\b|\bCC-?305\b|残[疾障]/iu,
      unless: INVITATION,
    },
    {
      concept: 'RACE',
      pattern: /\brace\b|\bethnicit(?:y|ies)\b|\bethnic\b|\bhispanic\b|\blatin[ox]\b|种族|族裔/iu,
      unless: INVITATION,
    },
    {
      concept: 'TRANSGENDER',
      pattern: new RegExp(`${TRANSGENDER_QUESTION.source}|${BIRTH_SEX_COMPARISON.source}`, 'iu'),
      unless: NOT_ABOUT_OWN_IDENTITY,
    },
    { concept: 'LGBTQ_COMMUNITY', pattern: LGBTQ_QUESTION, unless: NOT_ABOUT_OWN_IDENTITY },
    { concept: 'SEXUAL_ORIENTATION', pattern: /\bsexual orientation\b|性取向/iu, unless: INVITATION },
    { concept: 'GENDER', pattern: /\bgender\b|性别/iu, unless: INVITATION },
  ]);

export function selfIdentificationConcept(text: string): SelfIdentificationConcept | null {
  for (const candidate of CONCEPTS) {
    if (candidate.pattern.test(text) && !(candidate.unless?.test(text) ?? false)) return candidate.concept;
  }
  return null;
}

/**
 * 「Are you Hispanic/Latino?」这种把族裔单拎出来问的是/否题。
 *
 * EEO-1 把族裔与种族分成两问：一个人可以既是亚裔又是拉美裔。我们的档案只有一个
 * 单值字段，所以当它是 HISPANIC_OR_LATINO 时答"是"有依据；是别的值时**并不能推出
 * "否"**——那只说明用户在单值字段里选了另一项，不说明他不是拉美裔。
 *
 * 宁可让用户自己答一次，也不替他否认一个我们并不知道的事实。
 */
export function isHispanicOriginQuestion(text: string): boolean {
  return /\bhispanic\b|\blatin[ox]\b/iu.test(text);
}

/**
 * 多选的族裔题（「Please check all that apply」）。
 *
 * 档案是单值，勾一项就等于替用户声明"只有这一项"。写入端据此只勾档案里那一项，
 * 并在确认时把这一点说清楚，而不是假装我们知道全集。
 */
export function isMultiSelectPrompt(text: string): boolean {
  return /\b(?:check|select)\s+all\s+that\s+apply\b|\b多选\b|可多选/iu.test(text);
}

type YesNoDecline = 'YES' | 'NO' | 'DECLINE';

/** 跨性别题里还掺着别的身份（「跨性别或非二元」「transgender and/or gender non-conforming」）。 */
const OTHER_IDENTITIES =
  /\bnon[-\s]?binary\b|\bgender[-\s]?(?:non[-\s]?conforming|diverse|queer|fluid|expansive|variant)\b|\bgenderqueer\b|\btwo[-\s]?spirit\b|\bintersex\b|\blgbt|\bqueer\b|\bgay\b|\blesbian\b|\bbisexual\b|非二元/iu;

/** LGBTQ+ 题里还掺着别的群体（「LGBTQ+、女性或其他代表性不足的群体」）。 */
const OTHER_GROUPS =
  /\bwom[ae]n\b|\bfemale\b|\bunder-?represented\b|\bminorit(?:y|ies)\b|\b(?:people|person) of colou?r\b|\bb?ipoc\b|\bneurodivergent\b|\bveteran|\bdisab|\brace\b|\bracial\b|\bethnic/iu;

/**
 * 用户在门户里对「是否跨性别」的回答，在这一道跨性别题上该答什么；答不了就 null。
 *
 *  · 直问（Do you identify as transgender?）：照他的话答，是／否／不想回答。
 *  · 题里还掺着别的身份（「跨性别或非二元」）：只有「是」推得出来——他不是跨性别，不等于他也不是
 *    非二元；「不想回答」也不替他答，另一半身份他也许在别处说过。
 *  · 拿性别认同与出生时的性别比（Does your gender identity differ from…? / Is it the same as…?）：
 *    「是跨性别」推得出「不一样」；「不是跨性别」推不出「一样」——非二元的人多半不认「跨性别」
 *    这个词，他的性别认同却同样不是出生时登记的那一个。所以只答「是」那一向与「不想回答」。
 */
export function transgenderAnswer(text: string, stated: TransgenderAnswer | undefined): YesNoDecline | null {
  if (stated === undefined) return null;
  if (TRANSGENDER_QUESTION.test(text)) {
    if (!OTHER_IDENTITIES.test(text)) return stated;
    return stated === 'YES' ? 'YES' : null;
  }
  const comparison = BIRTH_SEX_COMPARISON.exec(text);
  if (comparison === null) return null;
  if (stated === 'DECLINE') return 'DECLINE';
  if (stated !== 'YES') return null;
  const differs = /^differ/iu.test(comparison[2]!) || /\bnot\b|n['’]t\b/iu.test(comparison[1]!);
  return differs ? 'YES' : 'NO';
}

/**
 * 「你算不算 LGBTQ+ 群体的一员」由门户里的两问推出（负责人 2026-09-23 定的规则）：
 *
 *  · 是：性取向是异性恋以外的任何一项，或者他说过自己是跨性别；
 *  · 否：只在性取向是异性恋、又说过不是跨性别时——而且不是已知的非二元（非二元多半也算在这个
 *    群体里；这一条比负责人的规则再严一点，只会少答，不会多答）；
 *  · 不想回答：只在两问都答了不想回答时；
 *  · 其余（缺一问、自行描述、一问不想回答另一问是否）一律不答。
 *
 * 题里掺了别的群体（「LGBTQ+ 或女性」）时只有「是」推得出来：否认 LGBTQ+ 不等于否认整道题。
 */
export function lgbtqCommunityAnswer(
  text: string,
  facts: Readonly<{ transgender?: TransgenderAnswer; orientation?: SexualOrientationAnswer; gender?: string }>,
): YesNoDecline | null {
  const { transgender, orientation } = facts;
  const nonHeterosexual = orientation !== undefined && orientation !== 'HETEROSEXUAL' && orientation !== 'DECLINE';
  if (nonHeterosexual || transgender === 'YES') return 'YES';
  if (OTHER_GROUPS.test(text)) return null;
  if (orientation === 'HETEROSEXUAL' && transgender === 'NO' && facts.gender !== 'NON_BINARY') return 'NO';
  if (orientation === 'DECLINE' && transgender === 'DECLINE') return 'DECLINE';
  return null;
}
