/**
 * 「你能出差吗」「这个岗位要 25% 的时间出差，你可以吗」——按资料里「出差最多能接受多少」答（2026-10-04，
 * argoland #738 的 Profile V2 `preferences.travelPercentMax`：工作时间的百分比上限，0／25／50／75／100）。
 *
 * 出差是他的意愿，从简历和经历里推不出来；从前这一类题只能送 AI，而 AI 在资料里找不到依据，只能不答。资料里答过
 * 一次上限，这里就照它答：
 *
 *  · 题目说了比例（「up to 25%」「10-20% travel」）：取它说的最大那一个，不超过他的上限答「是」，超过答「否」；
 *  · 题目说「偶尔、有时、按需」：当作不超过 25%；说「经常、大量、大部分时间」：当作至少 50%，他的上限到 75% 才答
 *    「是」，上限只有 25% 或不出差答「否」，上限正好 50% 说不清；
 *  · 题目只问「愿不愿意出差」：他接受出差（上限大于 0）就答「是」，不出差答「否」。
 *
 * 掺了这些的不归这里：报销与津贴、签证护照与工作许可、搬迁与通勤、出国（护照与签证另有一套）、开车与自备车辆、
 * 「你去过哪里／出过差吗」（问的是经历，不是意愿）、否定问句。按天数说的（「每月 3 天」）换算不准，当作没说比例。
 * 题面与资料只在内存里比对，不进日志、诊断（RULE-GLOBAL-DATA-L1）。
 */

import type { TravelPercent } from '../profileV2Travel';
import { normalizeGuardText } from './guards';

export type TravelBasis = 'TRAVEL_IN_PROFILE';

const TRAVEL = /\btravel(?:s|ing|ling|ed|led)?\b|出差/u;
/** 在问他能不能、愿不愿意（或只是「Willing to travel?」这种短标签）。 */
const ASKS =
  /\b(?:are|would|will)\s+you\s+(?:be\s+)?(?:able|willing|comfortable|open|available|prepared|happy|ok|okay)\b|\bcan\s+you\s+(?:travel|commit|accommodate|meet)\b|\b(?:does|would|will)\s+(?:this|that|it)\s+(?:work|be\s+(?:ok|okay|acceptable|possible))\s+for\s+you\b|\bis\s+(?:this|that)\s+(?:ok|okay|acceptable|possible|something\s+you)\b|\bwilling\s+and\s+able\b|\bable\s+and\s+willing\b|^(?:(?:are\s+you\s+)?(?:willing|able|open)\s+to\s+travel|travel\s+(?:willingness|requirements?)|willingness\s+to\s+travel)\b|愿意出差|能出差|可以出差/u;
const REFUSED =
  /\breimburs\w*|\bexpenses?\b|\ballowance\b|\bper\s+diem\b|\bvisa\b|\bpassports?\b|\bauthori[sz]\w*|\bsponsor\w*|\brelocat\w*|\bcommut\w*|\binternational(?:ly)?\b|\babroad\b|\boverseas\b|\bdriv(?:e|ing|er)\b|\bvehicle\b|\bcar\b|\blicen[cs]e\b|\bhave\s+you\s+(?:ever\s+)?travel|\bhow\s+(?:much|often)\s+have\s+you\b|\bvaccin\w*|\bcovid\b/u;
const NEGATION = /\bnot\b|n['’]t\b|\bnever\b|\bunable\b|\bwithout\b/u;
const OCCASIONAL = /\boccasional(?:ly)?\b|\bsome\b|\bperiodic(?:ally)?\b|\bminimal\b|\blight\b|\blimited\b|\binfrequent(?:ly)?\b|\bas\s+needed\b|\bfrom\s+time\s+to\s+time\b|\bsometimes\b|偶尔/u;
const FREQUENT = /\bfrequent(?:ly)?\b|\bextensive(?:ly)?\b|\bsignificant\b|\bheavy\b|\bregular(?:ly)?\b|\bconstant(?:ly)?\b|\bmost\s+of\s+the\s+time\b|\bmajority\b|经常|大量/u;
/** 按天、按周说的（「每月 3 天」「一周两次」）：换算成比例不准，当作没说比例——但也不当作「偶尔」。 */
const BY_DAYS = /\b\d+\s*(?:days?|nights?|weeks?|times?)\s*(?:a|per|each|every|\/)\s*(?:week|month|quarter|year)\b/u;

/** 问句（第一个带「能不能、愿不愿意」的句子）与它之前的说明。问句后面的（「If not, please explain.」）不看。 */
function questionOf(text: string): Readonly<{ context: string; ask: string }> | null {
  const normalized = normalizeGuardText(text).replace(/\((?:required|optional)\)/gu, ' ').replace(/\s+/gu, ' ').trim();
  const sentences = normalized.split(/(?<=[?.!？。])\s*/u).filter((sentence) => sentence.trim() !== '');
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index]!.trim();
    if (ASKS.test(sentence)) return { context: sentences.slice(0, index + 1).join(' '), ask: sentence };
  }
  return null;
}

/** 题目要的出差比例（0–100）；`ANY` 是只问愿不愿意出差，`FREQUENT` 是说「经常」没说多少。说不清就 null。 */
function demandOf(context: string): number | 'ANY' | 'FREQUENT' | null {
  const percents = [...context.matchAll(/(\d{1,3})\s*%/gu)].map((match) => Number(match[1])).filter((value) => value >= 0 && value <= 100);
  if (percents.length > 0) return Math.max(...percents);
  if (BY_DAYS.test(context)) return null;
  if (FREQUENT.test(context)) return 'FREQUENT';
  if (OCCASIONAL.test(context)) return 25;
  return 'ANY';
}

/**
 * 按资料里的出差上限答这道题；不是这一类、资料里没答、或答不准就 null。
 */
export function travelAnswer(
  text: string,
  limit: TravelPercent | undefined,
): Readonly<{ answer: 'YES' | 'NO'; basis: TravelBasis }> | null {
  if (limit === undefined) return null;
  const question = questionOf(text);
  if (question === null) return null;
  const { context, ask } = question;
  if (!TRAVEL.test(context) || REFUSED.test(context) || NEGATION.test(ask)) return null;
  const demand = demandOf(context);
  if (demand === null) return null;
  const yes = { answer: 'YES', basis: 'TRAVEL_IN_PROFILE' } as const;
  const no = { answer: 'NO', basis: 'TRAVEL_IN_PROFILE' } as const;
  if (demand === 'ANY') return limit > 0 ? yes : no;
  if (demand === 'FREQUENT') return limit >= 75 ? yes : limit <= 25 ? no : null;
  return demand <= limit ? yes : no;
}
