/**
 * 「你现在人在 X，或者愿意搬去 X 吗」——这一类题的判读。
 *
 * 2026-09-22 真实批测里它在 Discord 的每一页上都出现，整轮八页都落
 * `JOB_DEPENDENT`（面板说「取决于这个岗位，由你回答」）：
 *
 *   Are you currently based in or willing to relocate to the Bay Area for this position?
 *
 * 而档案里两半都有：居住地（城市／州／国家）说得出前半句，「愿意搬去哪几座城市」
 * 说得出后半句。`dict/residence.ts` 刻意把掺了搬迁的题挡在门外——那条注释写的是
 * 「愿不愿意搬是偏好，档案里没有，也推不出来」。**那句话在 P1-5 加进
 * `openToRelocation` / `openToRelocationCities` 之后就不再成立了。**这个模块补的
 * 正是它当年缺的那一半。
 *
 * ## 只答得出「是」
 *
 * 与居住地、工作授权同一条成例：
 *  · 他人在那儿 → 是；
 *  · 他说愿意搬、而且点名的地方在他自己列的城市里（或者他没列城市、等于不限）→ 是；
 *  · 其余一律不答。
 *
 * 答不出「否」的理由是我们分不清「他确实不愿意去」和「这个地名我们没认出来」。
 * 「the Bay Area」「Greater Boston」「DMV」这类都市圈写法本来就认不全，而答错
 * 不是少填一栏，是在一份正式申请里向雇主做了不实的陈述。
 */

/** 「愿不愿意搬去 X」「现在在 X 或愿意搬去 X」的问法。 */
const RELOCATION_ASKED = new RegExp(
  '\\b(?:willing|able|open|prepared|happy)\\s+to\\s+relocat\\w*\\b'
  + '|\\brelocat\\w*\\s+to\\b'
  + '|\\bwilling\\s+to\\s+(?:move|relocate)\\b',
  'iu',
);

/**
 * 掺了这些就不是一道纯粹的「去不去得了」。工作许可与担保另有专门判读；
 * 「搬家费用谁出」「什么时候能搬」问的是别的事，档案答不上来。
 */
const NOT_PURE_RELOCATION = new RegExp(
  '\\bauthoriz\\w*\\b|\\bsponsor\\w*\\b|\\bvisa\\b|\\bwork permit\\b'
  + '|\\beligible to work\\b|\\bright to work\\b'
  + '|\\brelocation (?:package|assistance|allowance|budget|expenses?|cost)\\b'
  + '|\\bwhen\\b.*\\brelocat\\w*\\b',
  'iu',
);

/**
 * 都市圈的常见写法 → 它包含的城市。
 *
 * 这是地名知识，与 `dict/regions.ts` 的国名／州名同一类，**不是站点 DOM 知识**，
 * 所以留在内核而不是规则里（RULE-GLOBAL-DOM-RULE-BOUNDARY 管的是选择器）。
 *
 * 表刻意短：只收那些「用户写城市名、雇主写都市圈名」确实指同一处的几条。多收一条
 * 都是替用户多答一道他没答过的题。
 */
const METRO_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'bay area': ['san francisco', 'san jose', 'oakland', 'palo alto', 'mountain view', 'sunnyvale', 'berkeley'],
  'sf bay area': ['san francisco', 'san jose', 'oakland', 'palo alto', 'mountain view', 'sunnyvale', 'berkeley'],
  'san francisco bay area': ['san francisco', 'san jose', 'oakland', 'palo alto', 'mountain view', 'sunnyvale', 'berkeley'],
  'silicon valley': ['san jose', 'palo alto', 'mountain view', 'sunnyvale', 'santa clara'],
  'nyc': ['new york'],
  'new york city': ['new york'],
  'greater new york': ['new york'],
  'greater boston': ['boston', 'cambridge'],
  'greater seattle': ['seattle', 'bellevue', 'redmond'],
  'puget sound': ['seattle', 'bellevue', 'redmond'],
  'greater los angeles': ['los angeles', 'santa monica', 'pasadena'],
  'greater london': ['london'],
};

const normalize = (text: string): string =>
  text.toLowerCase().replace(/[.,]/gu, ' ').replace(/\s+/gu, ' ').trim();

/** `haystack` 里是不是整词出现了 `needle`。 */
function mentionsWord(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`, 'u').test(haystack);
}

/**
 * 题目点到的地方是不是**用户这座城市**。
 *
 * 两个方向：题目直接写了城市名；或者题目写的是都市圈名（「the Bay Area」）而这座
 * 城市在那个圈里。方向不能反——用户写「San Francisco」，题目写「Bay Area」，
 * 拿城市名去匹配题面永远匹配不上。
 */
function questionNames(haystack: string, place: string): boolean {
  const wanted = normalize(place);
  if (wanted === '') return false;
  if (mentionsWord(haystack, wanted)) return true;
  return Object.entries(METRO_ALIASES).some(
    ([metro, members]) => members.includes(wanted) && mentionsWord(haystack, metro),
  );
}

/**
 * 这段文字点到的地方是不是 `place`（他的城市、州全名，或他列的搬迁城市）：直接写了这个地名，或写的是包含它的
 * 都市圈。与搬迁题同一套判据；到办公室上班那一类题（dict/workArrangement.ts）也用它核对地点。
 */
export function placeNamedIn(text: string, place: string): boolean {
  return questionNames(normalize(text), place);
}

/** 这是不是一道搬迁题；不是就返回 null。 */
export function isRelocationQuestion(text: string): boolean {
  if (NOT_PURE_RELOCATION.test(text)) return false;
  return RELOCATION_ASKED.test(text);
}

/**
 * 题目没写搬去哪儿，说的就是这个岗位（2026-09-24，jobs.lever.co/shieldai：「Are you local to or willing to
 * relocate?」）：「relocate」后面直接收尾，或者只跟着「for this role / to this position」一类。写了具体地方的
 * （「relocate to Austin」「near our Foster City office」）不算，那一道照题面答。
 */
const DESTINATION_IS_THE_JOB =
  /\brelocat\w*\s*(?:[?.!:]?\s*(?:[*✱]\s*)?$|(?:for|to)\s+(?:this|the)\s+(?:role|position|job|opportunity)\b[^?]{0,20}\??\s*(?:[*✱]\s*)?$)/iu;

export interface RelocationFacts {
  /** 档案里的城市，可空。 */
  readonly city?: string | undefined;
  /** 档案里的州／省全名或码，可空。 */
  readonly region?: string | undefined;
  /** `'true'` 才算他说过愿意搬。 */
  readonly openToRelocation?: string | undefined;
  /** 逗号分隔的城市清单；空串等于「愿意搬、没限定」。 */
  readonly openToRelocationCities?: string | undefined;
}

/**
 * 按档案能不能对这道题答「是」。
 *
 * 判据只有两条，都要求题目点到的那个地方**在文本里出现**：
 *  · 他现在就住在那儿（城市或州对上）；
 *  · 他说愿意搬，且清单里有那座城市，或者清单是空的（愿意搬、不限地点）。
 */
export function answersYesToRelocation(
  text: string,
  facts: RelocationFacts,
  /**
   * 岗位地点（调用方从页面的 JobPosting 读出，2026-09-24）。只在题目没写搬去哪儿（`DESTINATION_IS_THE_JOB`）
   * 时代替题面，拿来对他住的地方与他列的搬迁城市；不给就与从前一样，只看题面。
   */
  jobLocation?: string,
): boolean {
  if (!isRelocationQuestion(text)) return false;
  const place = jobLocation?.trim() ?? '';
  const haystack = normalize(place !== '' && DESTINATION_IS_THE_JOB.test(text.trim()) ? place : text);
  const mentions = (place: string): boolean => questionNames(haystack, place);

  const city = (facts.city ?? '').trim();
  const region = (facts.region ?? '').trim();
  if (city !== '' && mentions(city)) return true;
  // 州／省只在写成全名时才算（两字母码在英文句子里撞得太多：「in」「or」「me」）。
  if (region.length > 2 && mentions(region)) return true;

  if ((facts.openToRelocation ?? '').trim().toLowerCase() !== 'true') return false;
  const cities = (facts.openToRelocationCities ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  // 说了愿意搬、又没限定地点：那句话本身就是答案。
  if (cities.length === 0) return true;
  return cities.some((entry) => mentions(entry));
}
