/**
 * 「你能每周到办公室 N 天吗」「这个岗位要求全职在现场办公，你愿意并且能做到吗」「你接受远程吗」——按资料里
 * 「可接受的办公方式」答（2026-10-04，「AI 在资料里找不到依据」里的一类）。
 *
 * 资料里有这一问（Profile V2 `preferences.workModes`，门户上是必填的「可接受的办公方式」，可多选：远程、混合、
 * 现场），扁平键 `preferredWorkModes`（'REMOTE,HYBRID'）。这一类是非题从前全送 AI：同一种问法有时答、有时不答，
 * 资料里写着的意思它又常常不敢用。这里按资料直接答。
 *
 * ## 答「否」只看办公方式
 *
 * 题目要的办公方式不在他可接受的那几种里 → 否：只接受远程的人被问「每周三天到办公室」，答案就是否，与那间办公室在
 * 哪儿无关。混合（每周几天）在他接受现场办公时也算接受——能天天去，自然能每周去几天。
 *
 * ## 答「是」还要地点对得上
 *
 * 到办公室上班还要去得了那间办公室：他住在题目（或岗位地点）点到的那座城市／州，或者他说过愿意搬、没限定城市，
 * 或者他列的搬迁城市里有那一座。地点对不上就不答——我们分不清「他去不了」和「这个地名我们没认出来」
 * （与 dict/relocation.ts 同一条成例）。远程只看办公方式。
 *
 * ## 不归这里管的
 *
 * 掺了搬迁、出差、工作许可与签证、薪资、残障与便利措施、兼职与实习、轮班与工作时段、时区、到岗时间、
 * 居住地（「你住在 X 吗」由 dict/residence.ts 判）、客户现场的，都不答；问句本身是否定句的不答。
 * 题面与资料只在内存里比对，不进日志、诊断（RULE-GLOBAL-DATA-L1）。
 */

import { normalizeGuardText } from './guards';
import { placeNamedIn } from './relocation';

export type WorkMode = 'REMOTE' | 'HYBRID' | 'ONSITE';
export type WorkArrangementBasis = 'WORK_MODES_IN_PROFILE';

export interface WorkArrangementFacts {
  /** 扁平键 `preferredWorkModes`：逗号连接的码（'REMOTE,HYBRID'）。 */
  readonly workModes?: string | undefined;
  /** 他住的城市。 */
  readonly city?: string | undefined;
  /** 他住的州／省全名（码由调用方换成全名；两字母码在英文句子里撞得太多，不拿来比）。 */
  readonly region?: string | undefined;
  /** `'true'` 才算他说过愿意搬。 */
  readonly openToRelocation?: string | undefined;
  /** 逗号分隔的城市；空 = 愿意搬、不限地点。 */
  readonly openToRelocationCities?: string | undefined;
}

/** 在问他能不能、愿不愿意（不是陈述、也不是在问别的事）。 */
const ASKS =
  /\b(?:are|would|will)\s+you\s+(?:be\s+)?(?:currently\s+)?(?:able|willing|comfortable|open|available|prepared|happy|ok|okay)\b|\bcan\s+you\s+(?:work|commit|come|be|commute|attend|meet|report)\b|\b(?:does|would|will)\s+(?:this|that|it)\s+(?:work|be\s+(?:ok|okay|acceptable|possible))\s+for\s+you\b|\bis\s+(?:this|that)\s+(?:ok|okay|acceptable|possible|something\s+you)\b|\bwilling\s+and\s+able\b|\bable\s+and\s+willing\b/u;

/** 掺了这些就不是一道单纯的「去不去得了办公室」。 */
const REFUSED = new RegExp(
  [
    '\\brelocat\\w*', '\\bmov(?:e|ing)\\s+to\\b', '\\btravel\\w*',
    '\\bauthori[sz]\\w*', '\\bsponsor\\w*', '\\bvisa\\b', '\\bwork\\s+permit\\b', '\\beligib\\w*',
    '\\bsalary\\b', '\\bcompensation\\b', '\\bpay\\b', '\\bwages?\\b',
    '\\baccommodat\\w*', '\\bdisabilit\\w*', '\\bmedical\\b', '\\bhealth\\b',
    '\\bpart[-\\s]?time\\b', '\\bintern(?:ship)?s?\\b', '\\bcontract(?:or)?s?\\b', '\\btemporary\\b', '\\bseasonal\\b',
    '\\bweekends?\\b', '\\bnights?\\b', '\\bovernight\\b', '\\bshifts?\\b', '\\bovertime\\b', '\\bon[-\\s]call\\b',
    '\\bhours\\b', '\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b', '\\btime\\s*zones?\\b', '\\b(?:et|est|pt|pst|ct|cst|mt|mst|gmt|utc|cet)\\b',
    '\\bstart(?:ing)?\\b', '\\bbegin(?:ning)?\\b', '\\bimmediately\\b',
    '\\b(?:currently\\s+)?(?:based|located|residing|reside|live|living|local)\\b',
    '\\bclients?\\b', '\\bcustomers?\\b', '\\bvaccinat\\w*',
  ].join('|'),
  'u',
);
const NEGATION = /\bnot\b|n['’]t\b|\bnever\b|\bunable\b|\bwithout\b/u;

const NUMBERS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
/** 「三天／周」「3 days a week」「5 days in the office」「two days on-site」。 */
const DAYS =
  /\b(\d|one|two|three|four|five)\s*(?:\+\s*)?(?:full\s+)?days?\s*(?:(?:per|a|each|every|\/)\s*week\b|weekly\b|in\s+(?:the\s+|our\s+)?office\b|on[-\s]?site\b|onsite\b|in[-\s]person\b)/u;
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;
const HYBRID = /\bhybrid\b/u;
/** 到办公室、在现场：on-site、in-office、in person、「from / at / in our … office / HQ」。 */
const ATTENDANCE =
  /\bon[-\s]?site\b|\bonsite\b|\bin[-\s]office\b|\bin\s+the\s+office\b|\bin[-\s]person\b|\b(?:from|at|in|into|to)\s+(?:our|the)\s+(?:[\p{L}\p{N}.,'&-]+\s+){0,5}(?:office|offices|hq|headquarters|studio|campus)\b/u;
/** 天天去：全职在现场、完全在办公室、100%。 */
const EVERY_DAY = /\bfull[-\s]?time\b|\bfully\b|\b100\s*%|\bevery\s+day\b|\bdaily\b/u;
const REMOTE = /\bremote(?:ly)?\b|\bwork(?:ing)?\s+from\s+home\b|\bwfh\b/u;
const NOT_REMOTE = /\bnot\s+(?:a\s+)?(?:fully\s+)?remote\b|\bnon[-\s]?remote\b/u;
/** 远程题点了地方（「美国境内远程」「从多伦多远程」）：那就还要看他在哪儿，不归这里。 */
const REMOTE_PLACE = /\b(?:within|from|in)\s+(?:the\s+)?(?:[\p{L}]+\s+){0,2}(?:country|countries|state|states|region|us|usa|u\s?s|uk|eu|europe|canada)\b|\bcountry\b/u;
/** 办公室有名字（「our Foster City HQ」「the London office」）：不能拿岗位地点代替题面。 */
const NAMED_OFFICE = /\b(?:our|the)\s+(?!(?:main|current|local|nearest|closest|primary|company)\s)(?:[\p{L}\p{N}.,'&-]+\s+){1,5}(?:office|offices|hq|headquarters|studio|campus)\b/u;

/** 题目要哪一种办公方式；`OFFICE` 是到办公室、但说不清是每天还是每周几天。 */
type Demand = WorkMode | 'OFFICE';

/**
 * 题目的问句（第一个带「能不能、愿不愿意」的句子）与它之前的说明。问句后面的（「If not, please explain.」）不看。
 */
function questionOf(text: string): Readonly<{ context: string; ask: string }> | null {
  const normalized = normalizeGuardText(text).replace(/\((?:required|optional)\)/gu, ' ').replace(/\s+/gu, ' ').trim();
  const sentences = normalized.split(/(?<=[?.!])\s+/u);
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index]!;
    if (ASKS.test(sentence)) return { context: sentences.slice(0, index + 1).join(' '), ask: sentence };
  }
  return null;
}

function demandOf(context: string): Demand | null {
  const days = DAYS.exec(context);
  const weekdays = WEEKDAYS.filter((day) => new RegExp(`\\b${day}s?\\b`, 'u').test(context)).length;
  const attendance = ATTENDANCE.test(context) || HYBRID.test(context) || days !== null;
  const remote = REMOTE.test(context) && !NOT_REMOTE.test(context);
  const count = days !== null ? (NUMBERS[days[1]!] ?? Number(days[1])) : attendance && weekdays >= 2 ? weekdays : null;
  if (count !== null) return count >= 5 ? 'ONSITE' : count >= 1 ? 'HYBRID' : null;
  if (HYBRID.test(context)) return 'HYBRID';
  if (ATTENDANCE.test(context)) {
    // 远程与到办公室都说了、又没说每周几天：分不清问的是哪一边。
    if (remote) return null;
    return EVERY_DAY.test(context) ? 'ONSITE' : 'OFFICE';
  }
  return remote ? 'REMOTE' : null;
}

function modesOf(value: string | undefined): ReadonlySet<WorkMode> {
  const modes = new Set<WorkMode>();
  for (const code of (value ?? '').split(',')) {
    const trimmed = code.trim().toUpperCase();
    if (trimmed === 'REMOTE' || trimmed === 'HYBRID' || trimmed === 'ONSITE') modes.add(trimmed);
  }
  return modes;
}

/** 他接受题目要的那种办公方式吗：是／否／说不清（只接受混合的人被问「到办公室」，说不清是不是每天）。 */
function accepts(demand: Demand, modes: ReadonlySet<WorkMode>): boolean | null {
  switch (demand) {
    case 'REMOTE':
      return modes.has('REMOTE');
    case 'ONSITE':
      return modes.has('ONSITE');
    case 'HYBRID':
      return modes.has('HYBRID') || modes.has('ONSITE');
    case 'OFFICE':
      return modes.has('ONSITE') ? true : modes.has('HYBRID') ? null : false;
  }
}

/** 他去得了那间办公室吗：住在那儿，或愿意搬去那儿。说不清就是 false（不答）。 */
function reachable(context: string, facts: WorkArrangementFacts, jobLocation: string | undefined): boolean {
  const places = [context];
  // 办公室没有名字（「our office」「the office」）：说的就是这个岗位的地点。
  if ((jobLocation?.trim() ?? '') !== '' && !NAMED_OFFICE.test(context)) places.push(jobLocation!);
  const named = (place: string): boolean => place.trim() !== '' && places.some((text) => placeNamedIn(text, place));
  const city = facts.city?.trim() ?? '';
  const region = facts.region?.trim() ?? '';
  if (named(city)) return true;
  if (region.length > 2 && named(region)) return true;
  if ((facts.openToRelocation ?? '').trim().toLowerCase() !== 'true') return false;
  const cities = (facts.openToRelocationCities ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  return cities.length === 0 || cities.some(named);
}

/**
 * 按资料里可接受的办公方式答这道题；不是这一类、或答不准就 null。
 *
 * `jobLocation` 是页面 JobPosting 里的岗位地点原文（调用方读出）：题目只说「our office」时拿它当那间办公室的地点。
 */
export function workArrangementAnswer(
  text: string,
  facts: WorkArrangementFacts,
  jobLocation?: string,
): Readonly<{ answer: 'YES' | 'NO'; basis: WorkArrangementBasis }> | null {
  const modes = modesOf(facts.workModes);
  if (modes.size === 0) return null;
  const question = questionOf(text);
  if (question === null) return null;
  const { context, ask } = question;
  if (REFUSED.test(context) || NEGATION.test(ask)) return null;
  const demand = demandOf(context);
  if (demand === null) return null;
  if (demand === 'REMOTE' && REMOTE_PLACE.test(context)) return null;
  const accepted = accepts(demand, modes);
  if (accepted === null) return null;
  if (!accepted) return { answer: 'NO', basis: 'WORK_MODES_IN_PROFILE' };
  if (demand !== 'REMOTE' && !reachable(context, facts, jobLocation)) return null;
  return { answer: 'YES', basis: 'WORK_MODES_IN_PROFILE' };
}
