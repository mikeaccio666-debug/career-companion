/**
 * 「你有权在 X 国工作吗」「你需要 X 国的担保吗」——这两类题的判读。
 *
 * 它和其它字段有一处根本不同：**答案随岗位所在国家变**。实测 352 个真实申请页，
 * 这两类合计 143 个必填字段，标签逐条点名不同国家：
 *
 *   Are you legally authorized to work in the United States for our Company?
 *   Are you legally entitled to work in Canada?
 *   Will you now or in the future require an employer to sponsor you for a visa to work in Japan?
 *
 * 同一个用户在这三题上可以答得完全不一样。所以这里**只回答点名了国家的题**。
 *
 * 而语料里一半以上没有点名：
 *
 *   ...to work in the country in which this job is based
 *   ...to work in the stated location of this role
 *   ...require immigration sponsorship to work at Cloudflare?
 *
 * 这些一律返回 null 交还给用户。答错一次不是少填一栏，是在正式申请里向雇主
 * 做了一个不实的事实陈述。
 *
 * ## 反查不建全球国名表
 *
 * 只在**用户自己有授权记录的那几个国家**里找（上限 20 条）。这样既不需要一份
 * 会过期的国名表，也天然把搜索面收窄到有意义的范围：用户没有德国的记录，
 * 一道问德国的题本来也答不了。
 *
 * ## 美国的州（2026-09-24）
 *
 * 州名从前与同码的国家混在一起（`regionNames('CA')` 里既有 California 又有 Canada）：「California」按加拿大那条记录答、
 * 「Delaware」按德国、「Indiana」按印度，题面上的裸码 CA、DE、IN 也一样。现在州名、省名按它所在的国家认（工作授权是联邦
 * 的：有权在美国工作就有权在加州工作），与国家同码的两字母州／省码谁都不认，既是州又是国家的名字（Georgia）不答。
 */

import { countryName, subdivisionName, subdivisionsNamed } from './regions.ts';

/**
 * 顺序即语义：担保先判。
 * 「require sponsorship to extend your current **work authorization** status」
 * 同时含两类词，但它问的是担保。
 */
const SPONSORSHIP = /\bsponsor(?:ship|ed|ing)?\b|\bsponsor\b/i;

/**
 * 不带 sponsor 字样的担保题：require / need 雇主（公司、移民）**支持**才能取得或维持工作授权。
 *
 * nvidia.wd5 Workday 第 3 步的原题（2026-09-22）：「Will you require employer support to obtain or
 * maintain authorization to work in the country where this position is located?」——含
 * authorization to work，从前被判成「有权工作」，美国岗上会预填 Yes，等于替用户说「我需要担保」。
 */
const REQUIRES_SUPPORT =
  /\b(?:require|need)s?\b[^?]{0,60}\b(?:support|assistance)\b[^?]{0,80}\b(?:authori[sz](?:ation|ed)|visa|work permit|right to work|immigration)/i;

/**
 * 「不需要担保就有权工作吗」：问的是有权工作，极性与担保题**相反**。
 *
 * 从前含 sponsorship 就判成担保，按「需要担保 = No」答 No——等于替一个有权工作的人说「我没有权利」
 * （语料原题：「…authorised to work in the country you wish to work in without the need for visa
 * sponsorship?」）。答案要两项记录一起决定，见 engine 的 workAuthorizationPrefill。
 */
const WITHOUT_SPONSORSHIP = /\bwithout\b[^?.]{0,40}\b(?:sponsor(?:ship)?|support|assistance)\b/i;

/**
 * 用 or 把「现在是否持签证」与担保捆在一起的题。档案里没有「现在是否持签证」：持 TN、不需要担保的人
 * 按担保那一项答 No，就是不实陈述——他确实 currently on a visa。
 */
const AMBIGUOUS = /\bcurrently\s+on\s+an?\s+visa\b/i;

const AUTHORIZED = new RegExp(
  // 英式拼写 authorised / authorisation 同样是这一类（语料里有 3 题，从前一题都没认出来）。
  '\\bauthori[sz](?:ed|ation) to work\\b|\\bwork authori[sz](?:ed|ation)\\b'
  + '|\\blegally (?:authori[sz]\\w*|entitled|eligible)\\b'
  + '|\\bright to work\\b|\\bwork permit\\b|\\beligible to work\\b|\\bwork rights\\b',
  'i',
);

export type WorkAuthorizationQuestionKind =
  | 'AUTHORIZED_TO_WORK'
  | 'REQUIRES_SPONSORSHIP'
  /** 不需要担保就有权工作吗：有权工作且不需要担保才是 Yes。 */
  | 'AUTHORIZED_WITHOUT_SPONSORSHIP';

export function workAuthorizationQuestionKind(text: string): WorkAuthorizationQuestionKind | null {
  if (AMBIGUOUS.test(text)) return null;
  // 「without … sponsorship」必须排在担保之前：它含 sponsorship，问的却是有权工作。
  if (AUTHORIZED.test(text) && WITHOUT_SPONSORSHIP.test(text)) return 'AUTHORIZED_WITHOUT_SPONSORSHIP';
  if (SPONSORSHIP.test(text) || REQUIRES_SUPPORT.test(text)) return 'REQUIRES_SPONSORSHIP';
  if (AUTHORIZED.test(text)) return 'AUTHORIZED_TO_WORK';
  return null;
}

/**
 * 题目问的是「你现在住的那个国家」，而不是岗位所在国。
 *
 * 按岗位地点推断（P1-7）只对「where this position is located」「for which you applied」那一类成立；
 * 「the country you're currently living in」「your country of residence」「your current location」
 * 问的是用户自己住哪——拿岗位国家去答，住在加拿大、申请美国岗的人会被答成「在美国有权工作」。
 * 这类一律不推，交还用户。
 */
const RESIDENCE = new RegExp(
  "\\byou(?:['’]re|\\s+are)?\\s+(?:currently\\s+)?(?:living|located|residing)\\b"
  + '|\\byou\\s+(?:currently\\s+)?(?:live|reside)\\b'
  + '|\\b(?:your|the)\\s+(?:current\\s+)?(?:country|place|location)\\s+of\\s+residence\\b'
  + '|\\byour\\s+(?:current\\s+)?location\\b',
  'i',
);

export function refersToResidence(text: string): boolean {
  return RESIDENCE.test(text);
}

/**
 * 题目点名的那个国家，必须**恰好一个**。
 *
 * 一道题同时点到用户两条记录的国家（「authorized to work in the US or Canada」）
 * 时返回 null：两条记录可以给出相反的答案，而没有任何依据说该用哪一条。
 *
 * 美国的州、加拿大的省（按全名）算它们的国家，除非 `subdivisionsCount` 是 false：工作授权算——许可是联邦的；
 * 「你现在住在哪」不算（residence.ts）——住在美国不等于住在加州。两种都不会把州落到同码的国家上（2026-09-24）。
 */
export function namedWorkRegion(
  text: string,
  regions: readonly string[],
  subdivisionsCount = true,
): string | null {
  const places = subdivisionsNamed(text);
  // 既是州又是国家的名字（Georgia）：说不清是哪一个，谁的记录都不认。
  if (places.ambiguous) return null;
  const matched = new Set<string>();
  for (const region of regions) {
    const code = region.trim().toUpperCase();
    if ((subdivisionsCount && places.countries.has(code)) || mentionsCountry(text, places.rest, code)) matched.add(code);
  }
  return matched.size === 1 ? [...matched][0]! : null;
}

/** `rest`：挖掉州／省全名之后的小写题面（「New Mexico」里的 Mexico 不是国名）。 */
function mentionsCountry(text: string, rest: string, code: string): boolean {
  if (!/^[A-Z]{2}$/u.test(code)) return false;
  const name = countryName(code)?.toLowerCase();
  if (name !== undefined && name.length >= 4 && wordAt(rest, name)) return true;
  // 与美国州／加拿大省同码的国家（CA 加拿大、DE 德国、IN 印度、GA 加蓬……三十来个）不认裸码：题面上的 CA、DE、IN
  // 说不清是州还是国家（2026-09-24）。
  if (subdivisionName(code) !== null) return false;
  // 裸码只认**原文里的大写形式**：小写 "us" 在
  // 「How did you hear about us」里到处都是，而国家写法是 "the US"。
  // 带点的 U.S / U.K 一并认。
  return wordAt(text, code) || wordAt(text, code.split('').join('.'))
    || wordAt(text, `${code.split('').join('.')}.`);
}

/** 整词匹配；不用 \b，因为 `U.S` 的点会让 \b 落在错的地方。 */
function wordAt(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : haystack[at - 1]!;
    const after = haystack[at + needle.length] ?? '';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    from = at + 1;
  }
}
