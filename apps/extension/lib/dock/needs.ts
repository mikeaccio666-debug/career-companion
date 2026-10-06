import { countryNamed } from '@edaix/apply-kernel/regions';

import type { DockRow } from './rows';
import type { DockQuestion } from './types';

/**
 * 「需要你」按他要做的事分组（2026-09-28 负责人：一张单子里从前混着三种事——要他写的、我们没做成的、按规定留给他的）。
 *
 *  · `choose` 选一个：选项对不上、说不准的选择题（NO_OPTION_MATCH、AMBIGUOUS_OPTION……）——摆页面上最接近他资料的真实选项；
 *  · `write` 写一段：没填的开放题——「AI 帮我写」；
 *  · `missing` 资料里没有：当场问一次、写上网页、默认记进答案记忆（总开关管着）；
 *  · `decide` 你来决定：按规定留给他本人的（没开代填的同意、自我认同、涉及他人……）——只「去这一栏」；
 *  · `check` 去网页上看一眼：别的没填上的（网站说格式不对、没确认、没存上的一段……）——只「去这一栏」。
 *
 * 只看稳定原因码与控件的形状（原生控件与 ARIA），不认任何一家的 DOM；选项原文只在本地比一比、摆出来，不外传。
 */
export type NeedKind = 'choose' | 'write' | 'missing' | 'decide' | 'check';

/** 分组在浮层上的先后（「去第一项／下一处」照这个先后走）。 */
export const NEED_KINDS: readonly NeedKind[] = ['choose', 'write', 'missing', 'decide', 'check'];

/** 按规定留给他本人的：只能他自己在网站上处理。 */
const POLICY_REASONS: ReadonlySet<string> = new Set([
  'MANUAL_ONLY', 'OTHER_PERSON', 'CONSENT_OFF', 'CAPABILITY_DISABLED', 'CLICK_DENIED', 'POLICY_DISABLED',
]);
/** 选项的事：页面上的选项与他资料里的说法对不上、说不准、没读全，或按岗位地点推断好了等他点头。 */
const OPTION_REASONS: ReadonlySet<string> = new Set([
  'NO_OPTION_MATCH', 'AMBIGUOUS_OPTION', 'OPTIONS_INCOMPLETE', 'WIDGET_TIMEOUT', 'PREFILLED_NEEDS_CONFIRMATION',
]);
/** 答案不在资料里（或我们认不出这一问）：问他一次就好。 */
const MISSING_REASONS: ReadonlySet<string> = new Set(['NO_VALUE', 'MISSING_PROFILE', 'CHOICE_NO_DATA', 'LOW_CONFIDENCE', 'JOB_DEPENDENT']);
/**
 * 答了之后值得记住、下次自动带出的（他自己的事实）。看岗位的（JOB_DEPENDENT）不记：换一个岗位答案就可能不同；
 * 说得出是哪一国的工作授权也不记（按类别记下来，会被拿去答别的国家）。
 */
const REMEMBER_REASONS: ReadonlySet<string> = new Set(['NO_VALUE', 'MISSING_PROFILE', 'CHOICE_NO_DATA', 'LOW_CONFIDENCE']);

/** 分组要知道的这一行之外的几件事（都由浮层现算，不存）。 */
export interface NeedFacts {
  /** 调用方说这一栏能当场答、是什么样的题；不能就是 null。 */
  readonly question: DockQuestion | null;
  /** 这一栏旁边有「用 AI 写」（AI 开着、这一栏在可以写的那几栏里）。 */
  readonly aiWritable: boolean;
  /** 这一栏是求职信栏、这一轮在写或附不了（照旧由求职信那一套说）。 */
  readonly letter: boolean;
  /** 控件的形状：多行框、单行框、选择题（下拉、单选、组合框）。 */
  readonly control: 'multi' | 'single' | 'choice';
}

export function needKindOf(row: DockRow, facts: NeedFacts): NeedKind {
  if (row.source.unsavedEntry !== undefined || row.source.unaddedEntries !== undefined || facts.letter) return 'check';
  const reason = row.reason ?? '';
  if (POLICY_REASONS.has(reason)) return 'decide';
  const choice = facts.question?.kind === 'choice' || (facts.question === null && facts.control === 'choice');
  if (OPTION_REASONS.has(reason)) return 'choose';
  if (choice) {
    // 选择题：资料里没有的问一次（记住）；看岗位的就是挑一个。
    if (reason === 'JOB_DEPENDENT') return 'choose';
    return MISSING_REASONS.has(reason) ? 'missing' : 'check';
  }
  if (reason === 'USER_ONLY' || facts.aiWritable || facts.question?.kind === 'long') return 'write';
  if (MISSING_REASONS.has(reason)) return facts.control === 'multi' ? 'write' : 'missing';
  return 'check';
}

/** 当场答上之后记不记进答案记忆（只有「资料里没有」的那几类；总开关另由调用方管）。 */
export function rememberable(row: DockRow, kind: NeedKind): boolean {
  return kind === 'missing' && REMEMBER_REASONS.has(row.reason ?? '') && row.source.regionWithoutRecord === undefined;
}

// ── 选项与他资料里的说法有多接近 ─────────────────────────────────────

const STOP_WORDS: ReadonlySet<string> = new Set(['of', 'the', 'and', 'at', 'in', 'a', 'an', 'for', 'de', 'la', 'le', 'du', 'des', 'di']);
const OTHER_OPTION = /^(?:other|others|not listed|none of the above|something else|其他|其它)\b/iu;

const normalize = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/['’`]/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const wordsOf = (value: string): string[] => normalize(value).split(' ').filter((word) => word !== '' && !STOP_WORDS.has(word));

/** 两个词像不像：一样是 1；一个是另一个的开头（至少三个字母）是 0.8。 */
function wordMatch(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.8;
  return 0;
}

/**
 * 两串词互相覆盖了多少（每个词在对面最像的那一个）。缩写两边都算：他写「UC」、选项写「University of California」，
 * 「UC」算对上了，「University」「California」也算被对上了。
 */
function coverage(from: readonly string[], to: readonly string[]): { forward: number[]; backward: number[] } {
  const forward = from.map((word) => Math.max(0, ...to.map((other) => wordMatch(word, other))));
  const backward = to.map((word) => Math.max(0, ...from.map((other) => wordMatch(word, other))));
  const expand = (short: readonly string[], long: readonly string[], shortScores: number[], longScores: number[]): void => {
    const initials = long.map((word) => word[0] ?? '').join('');
    short.forEach((word, index) => {
      // 缩写：两到四个字母，恰好是对面连着几个词的首字母。
      if (shortScores[index]! >= 1 || !/^[a-z]{2,4}$/u.test(word)) return;
      const at = initials.indexOf(word);
      if (at < 0) return;
      shortScores[index] = 1;
      for (let covered = at; covered < at + word.length; covered += 1) longScores[covered] = 1;
    });
  };
  expand(from, to, forward, backward);
  expand(to, from, backward, forward);
  return { forward, backward };
}

/** 两段字的字符二元组相似度（处理中文、拼写差一点）。 */
function bigramDice(a: string, b: string): number {
  const grams = (value: string): string[] => {
    const compact = value.replace(/\s+/gu, '');
    const out: string[] = [];
    for (let index = 0; index < compact.length - 1; index += 1) out.push(compact.slice(index, index + 2));
    return out;
  };
  const left = grams(a);
  const right = grams(b);
  if (left.length === 0 || right.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const gram of right) pool.set(gram, (pool.get(gram) ?? 0) + 1);
  let shared = 0;
  for (const gram of left) {
    const count = pool.get(gram) ?? 0;
    if (count > 0) { shared += 1; pool.set(gram, count - 1); }
  }
  return (2 * shared) / (left.length + right.length);
}

/** 一个选项与他资料里那句话有多接近（0–1）。 */
export function optionCloseness(hint: string, option: string): number {
  const a = normalize(hint);
  const b = normalize(option);
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  // 国名（2026-09-28）：两边都认得出是哪一国，就只看是不是同一国——USA、U.S.、United States of America 是同一个，
  // UK 是 United Kingdom 不是 Ukraine。别名表在内核的 dict/regions.ts（`countryNamed`），与推岗位国家的那一张挨着。
  const hintCountry = countryNamed(hint);
  const optionCountry = hintCountry === null ? null : countryNamed(option);
  if (hintCountry !== null && optionCountry !== null) return hintCountry === optionCountry ? 1 : 0;
  const from = wordsOf(hint);
  const to = wordsOf(option);
  let words = 0;
  if (from.length > 0 && to.length > 0) {
    const { forward, backward } = coverage(from, to);
    const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
    // 他的说法被覆盖了多少为主（漏了他说的一个词就差得远），选项里多出来的词为辅。
    words = 0.8 * (sum(forward) / from.length) + 0.2 * (sum(backward) / to.length);
  }
  const contains = a.includes(b) || b.includes(a) ? 0.5 + 0.4 * (Math.min(a.length, b.length) / Math.max(a.length, b.length)) : 0;
  return Math.max(words, contains, 0.9 * bigramDice(a, b));
}

/**
 * 摆出来的选项至少要这么像（他说的每个词大多对得上）；一个都不够像时不猜——只摆「Other」一类（有的话），其余让他去
 * 网页上看全部。宁可少摆，不可摆一个像是对的错选项。
 */
const CLOSE_ENOUGH = 0.55;

/**
 * 「选一个」「资料里没有」那一行上摆哪几个选项（页面上的原文）：
 *  · 选项不多（不超过四个）：全摆，按页面的先后（是／否这种题就该两个都在）；
 *  · 多：按与他资料里那句话的接近程度挑最像的几个（最多三个）；都不够像就摆「Other」一类（有的话）；
 *    他资料里没有那句话就一个都不挑（让他去网页上看全部，或在浮层里的下拉里选）。
 * 计划期替他挑好的那一项（`suggested`）永远在最前。
 */
export function optionChips(question: DockQuestion, hint: string | null, max = 3): string[] {
  const options = question.options.filter((option) => option.trim() !== '');
  const suggested = question.suggested !== null && options.includes(question.suggested) ? question.suggested : null;
  const lead = (picked: readonly string[]): string[] =>
    suggested === null ? [...picked] : [suggested, ...picked.filter((option) => option !== suggested)].slice(0, Math.max(max, picked.length));
  if (options.length <= max + 1) return lead(options);
  const wanted = (hint ?? '').trim();
  if (wanted === '') return suggested === null ? [] : [suggested];
  const scored = options
    .map((option, index) => ({ option, index, score: optionCloseness(wanted, option) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const ranked = scored.filter((item) => item.score >= CLOSE_ENOUGH).slice(0, max).map((item) => item.option);
  if (ranked.length === 0) {
    const other = options.find((option) => OTHER_OPTION.test(option.trim()));
    return lead(other === undefined ? [] : [other]);
  }
  return lead(ranked).slice(0, max);
}
