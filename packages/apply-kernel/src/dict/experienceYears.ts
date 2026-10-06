/**
 * 「工作年限」「你有几年工作经验」——按资料里带日期的工作经历算（2026-10-04，「AI 在资料里找不到依据」里的一类）。
 *
 * 只答**不带限定**的总年限：「Years of work experience」「How many years of professional experience do you have?」
 * 「Total years of experience」。限定了领域、技能、行业、职能的（「relevant」「in sales」「with Python」「as a manager」
 * 「leadership」……）要判断哪几段算数，不归这里（照旧交给 AI 或本人）。
 *
 * ## 怎么算
 *
 * 每一段经历一个区间：开始 → 结束（在职的到今天）。几段重叠的时间只算一次（同时做两份工不算两年）。志愿者不算
 * 工作经历；实习算（那是他列在工作经历里的工作）。问「full-time」的只算标了全职的那几段，而且每一段都要标了雇佣
 * 类型才答——有一段没标，就说不清它算不算。
 *
 * 只有年份、没有月份的日期按最短与最长两种读法各算一遍：两种读法落在同一个答案上才答（文本框写整年数，选项题
 * 落在同一个区间），否则不答——不替他编一个月份。任何一段缺开始日期、或既没有结束日期也没标在职，就不答。
 *
 * 题面与资料只在内存里算，不进日志、诊断（RULE-GLOBAL-DATA-L1）。
 */

import type { ProfileExperience } from '../profileCollections';
import { normalizeGuardText } from './guards';

export type ExperienceYearsBasis = 'EXPERIENCE_YEARS_FROM_HISTORY';

/**
 * 不带限定的总年限问法。题面整句只许是这几种说法，多一个限定词就不认（见文件头）。
 */
const TOTAL_YEARS = new RegExp(
  '^(?:(?:how\\s+many|number\\s+of|total(?:\\s+number\\s+of)?)\\s+)?'
  + '(?:years?|yrs?)\\s+(?:of\\s+)?(?:total\\s+)?(?:(full[-\\s]?time|professional|work|working|industry|employment)\\s+)?'
  + '(?:work\\s+)?experience'
  + '(?:\\s+(?:do|have)\\s+you\\s+(?:have|had|got))?(?:\\s+in\\s+total)?(?:\\s+overall)?$'
  + '|^(?:total|overall)\\s+(?:(full[-\\s]?time|professional|work)\\s+)?(?:work\\s+)?experience\\s+\\(?(?:in\\s+)?years\\)?$'
  + '|^(?:how\\s+many\\s+years\\s+have\\s+you\\s+(?:been\\s+)?work(?:ed|ing)(?:\\s+(full[-\\s]?time|professionally))?)$',
  'u',
);

/** 「行业」经验通常指某个行业（招聘方的那个）：只在题面说「industry experience」而没点名哪个行业时也不认。 */
const QUALIFIED = /\bindustry\b/u;

type Month = number; // 公历月序号：year * 12 + (month - 1)

/** 一段经历的区间（月序号，含头不含尾）的最短与最长读法；说不清就 null。 */
function spanOf(experience: ProfileExperience, today: Month): Readonly<{ shortest: [Month, Month]; longest: [Month, Month] }> | null {
  const start = experience.startDate;
  if (start === null) return null;
  const end = experience.endDate;
  if (end === null && !experience.isCurrent) return null;
  const startEarliest = start.year * 12 + ((start.month ?? 1) - 1);
  const startLatest = start.year * 12 + ((start.month ?? 12) - 1);
  // 结束那个月算在里面（2020 年 1 月到 2020 年 3 月是 3 个月）。在职的到这个月。
  const endEarliest = end === null ? today + 1 : end.year * 12 + ((end.month ?? 1) - 1) + 1;
  const endLatest = end === null ? today + 1 : end.year * 12 + ((end.month ?? 12) - 1) + 1;
  // 结束早于开始：脏数据，说不清。
  if (endLatest <= startEarliest) return null;
  return {
    shortest: [startLatest, Math.max(startLatest, endEarliest)],
    longest: [startEarliest, endLatest],
  };
}

/** 几段区间合起来一共多少个月（重叠只算一次）。 */
function unionMonths(spans: readonly (readonly [Month, Month])[]): number {
  const sorted = [...spans].filter(([from, to]) => to > from).sort((left, right) => left[0] - right[0]);
  let total = 0;
  let cursorStart = -1;
  let cursorEnd = -1;
  for (const [from, to] of sorted) {
    if (from > cursorEnd) {
      if (cursorEnd > cursorStart) total += cursorEnd - cursorStart;
      cursorStart = from;
      cursorEnd = to;
    } else if (to > cursorEnd) {
      cursorEnd = to;
    }
  }
  if (cursorEnd > cursorStart) total += cursorEnd - cursorStart;
  return total;
}

/** 当天（`YYYY-MM-DD`）的月序号；不合法就 null。 */
function monthOf(today: string | undefined): Month | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/u.exec(today ?? '');
  if (match === null) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? Number(match[1]) * 12 + (month - 1) : null;
}

/** 总工作月数的最短与最长读法：`{ min, max }`（月）。 */
export interface ExperienceMonths {
  readonly min: number;
  readonly max: number;
}

/**
 * 这道题是不是在问不带限定的总年限；是就给出要不要只算全职。不是就 null。
 */
export function totalExperienceQuestion(text: string): Readonly<{ fullTimeOnly: boolean }> | null {
  const question = normalizeGuardText(text)
    .replace(/\((?:required|optional)\)/gu, ' ')
    .replace(/[?？.:：]+\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const match = TOTAL_YEARS.exec(question);
  if (match === null) return null;
  const qualifier = match[1] ?? match[2] ?? match[3] ?? '';
  if (QUALIFIED.test(qualifier)) return null;
  return { fullTimeOnly: /full[-\s]?time/u.test(qualifier) };
}

/**
 * 资料里的工作经历一共多少个月（最短与最长读法）；说不清就 null。
 */
export function experienceMonths(
  experiences: readonly ProfileExperience[] | undefined,
  today: string | undefined,
  fullTimeOnly: boolean,
): ExperienceMonths | null {
  const now = monthOf(today);
  if (now === null || experiences === undefined) return null;
  const counted: ProfileExperience[] = [];
  for (const experience of experiences) {
    if (experience.employmentType === 'VOLUNTEER') continue;
    if (fullTimeOnly) {
      if (experience.employmentType === null) return null;
      if (experience.employmentType !== 'FULL_TIME') continue;
    }
    counted.push(experience);
  }
  // 一段工作经历都没有：我们不知道他的履历，说「0 年」是替他编。
  if (experiences.length === 0) return null;
  const shortest: [Month, Month][] = [];
  const longest: [Month, Month][] = [];
  for (const experience of counted) {
    const span = spanOf(experience, now);
    if (span === null) return null;
    shortest.push(span.shortest);
    longest.push(span.longest);
  }
  return { min: unionMonths(shortest), max: unionMonths(longest) };
}

/** 文本框写的整年数（向下取整）；两种读法落在不同的整年上就 null。 */
export function wholeYears(months: ExperienceMonths): number | null {
  const low = Math.floor(months.min / 12);
  const high = Math.floor(months.max / 12);
  return low === high ? low : null;
}

/**
 * 一个选项说的年限：一个判断「这么多年算不算这一项」的函数（年数是实数，2 年 6 个月是 2.5）。认不出就 null。
 *
 *  · 「None」「No experience」「0」：恰好 0；
 *  · 「Less than 2 years」「Under 2」「<2」：小于 2；
 *  · 「1-3 years」「1 to 3 years」：1 到 3（含两端）；
 *  · 「More than 5 years」「Over 5」「>5」：大于 5；
 *  · 「5+ years」「5 years or more」：不少于 5；
 *  · 「2 years」：满 2 年、不到 3 年。
 */
function optionTest(option: string): ((years: number) => boolean) | null {
  const text = option.normalize('NFKC').toLowerCase().replace(/[–—~]/gu, '-').replace(/\s+/gu, ' ').trim();
  const number = '(\\d+(?:\\.\\d+)?)';
  const unit = '\\s*(?:years?|yrs?)?';
  let match: RegExpExecArray | null;
  if (/^(?:none|no(?:\s+(?:prior|professional|work))?\s+experience|0(?:\s*(?:years?|yrs?))?)$/u.test(text)) return (years) => years === 0;
  if ((match = new RegExp(`^(?:less\\s+than|under|fewer\\s+than|<)\\s*${number}${unit}$`, 'u').exec(text)) !== null) {
    const bound = Number(match[1]);
    return (years) => years < bound;
  }
  if ((match = new RegExp(`^${number}${unit}\\s*(?:-|to)\\s*${number}${unit}$`, 'u').exec(text)) !== null) {
    const low = Number(match[1]);
    const high = Number(match[2]);
    return low <= high ? (years) => years >= low && years <= high : null;
  }
  if ((match = new RegExp(`^(?:more\\s+than|over|greater\\s+than|>)\\s*${number}${unit}$`, 'u').exec(text)) !== null) {
    const bound = Number(match[1]);
    return (years) => years > bound;
  }
  if ((match = new RegExp(`^${number}\\s*\\+${unit}$|^${number}${unit}\\s+(?:or|and)\\s+(?:more|above|over|greater)$`, 'u').exec(text)) !== null) {
    const bound = Number(match[1] ?? match[2]);
    return (years) => years >= bound;
  }
  if ((match = new RegExp(`^${number}\\s*(?:years?|yrs?)$`, 'u').exec(text)) !== null) {
    const value = Number(match[1]);
    return (years) => years >= value && years < value + 1;
  }
  return null;
}

/**
 * 选项题：年限落在哪一项。最短与最长两种读法都落在同一项、而且各自恰好落在一项才算；落在两项的交界上（整 3 年，
 * 「1-3」与「3-5」都包含）、或落在两项之间的空档里（3 年半，「1-3」「4-6」都不含），都不答。认不出的选项
 * （「Prefer not to say」）不参与。
 */
export function experienceOption(options: readonly string[], months: ExperienceMonths): string | null {
  const tests = options.map((option) => [option, optionTest(option)] as const);
  const pick = (years: number): string[] =>
    tests.filter(([, test]) => test !== null && test(years)).map(([option]) => option);
  const low = pick(months.min / 12);
  const high = pick(months.max / 12);
  if (low.length !== 1 || high.length !== 1 || low[0] !== high[0]) return null;
  return low[0]!;
}
