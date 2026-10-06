/**
 * 语言题按资料里的语言答（2026-10-04，「AI 在资料里找不到依据」里最大的一类）。
 *
 * 10-03 的真实岗位批测里，「AI 没找到依据」的必填行里语言题最多：问会不会某种语言、是不是母语或接近母语、
 * 是不是双语、勾选会说的语言、写出英语以外还会哪几种。资料里本来就有这一块（Profile V2 `languages`：语言 +
 * 四档水平，门户与浮层的资料编辑都能填，简历导入也会带进来），只是内核拿不到，题目只能送给 AI；AI 又在资料里
 * 没有语言时一律答不上。这里让内核按资料直接答，不用 AI、不耗次数、每次答得一样。
 *
 * ## 只答资料说得清的
 *
 *  · 资料里有那种语言、水平够 → 是；水平明确不够 → 否。
 *  · 资料里列了语言、却没有题里问的那一种 → 否（他列的就是他会的语言）。但有两种情况不答「否」：
 *    ① 问的是英语——很多人填语言时不写英语（申请本身就是英文的），没写不等于不会；
 *    ② 他资料里有一条我们认不出是哪种语言（拼写、少见语种）——说不定就是题里问的那一种。
 *  · 资料里一条语言都没有 → 不答（交给 AI 或本人）。
 *  · 「中文」与「普通话／粤语」：题问「Chinese」，普通话、粤语、中文都算；题问「Mandarin」，资料只写了「中文」
 *    分不清是哪一种，不答。
 *
 * 水平用 Profile V2 的四档：NATIVE_OR_BILINGUAL（母语或双语）> PROFESSIONAL（工作语言）> CONVERSATIONAL（会话）>
 * BASIC（基础）。题目要「流利／熟练／工作语言」的，前两档算是、后两档算否；只问「会不会说」的，会话及以上算是、
 * 基础不答；问「母语／接近母语」的，只有第一档算是，工作语言那一档说不清（不答），会话及以下算否；问「是不是
 * X 双语」的，X 与另一种语言都要在工作语言及以上。
 *
 * 语言名是语言知识（与 dict/regions.ts 的国名同一类），不是站点 DOM 知识，所以在内核里。题面与资料里的语言只在
 * 内存里比对，不进日志、诊断（RULE-GLOBAL-DATA-L1）。
 */

import type { LanguageProficiency, ProfileLanguage } from '../profileCollections';
import { normalizeGuardText } from './guards';

export type { ProfileLanguage };

const RANK: Readonly<Record<LanguageProficiency, number>> = {
  NATIVE_OR_BILINGUAL: 4,
  PROFESSIONAL: 3,
  CONVERSATIONAL: 2,
  BASIC: 1,
};

/**
 * 常见语言：编号、英文名（写进文本框用）、各种写法（英文、常见的本族语写法、门户上常见的中文写法）。编号只在这里用。
 * 中文三条分开：`zh` 是笼统的「中文」，`cmn` 普通话、`yue` 粤语各算一种。认不出的写法不会答错：那一条算「认不出」，
 * 只让「否」答不出来。
 */
const LANGUAGES: readonly (readonly [id: string, display: string, names: readonly string[]])[] = [
  ['en', 'English', ['english', 'anglais', 'inglés', 'ingles', 'englisch', '英语', '英文', '英語']],
  ['zh', 'Chinese', ['chinese', '中文', '汉语', '漢語', '华语', '華語']],
  ['cmn', 'Mandarin', ['mandarin', 'putonghua', '普通话', '普通話', '国语', '國語']],
  ['yue', 'Cantonese', ['cantonese', '粤语', '粵語', '广东话', '廣東話']],
  ['es', 'Spanish', ['spanish', 'español', 'espanol', '西班牙语', '西班牙語']],
  ['fr', 'French', ['french', 'français', 'francais', '法语', '法語']],
  ['de', 'German', ['german', 'deutsch', '德语', '德語']],
  ['it', 'Italian', ['italian', 'italiano', '意大利语', '義大利語']],
  ['pt', 'Portuguese', ['portuguese', 'português', 'portugues', '葡萄牙语', '葡萄牙語']],
  ['ja', 'Japanese', ['japanese', '日本語', '日语', '日文']],
  ['ko', 'Korean', ['korean', '한국어', '韩语', '韓語', '韩文']],
  ['ru', 'Russian', ['russian', '俄语', '俄語']],
  ['ar', 'Arabic', ['arabic', '阿拉伯语']],
  ['hi', 'Hindi', ['hindi', '印地语']],
  ['bn', 'Bengali', ['bengali', 'bangla']],
  ['ur', 'Urdu', ['urdu']],
  ['pa', 'Punjabi', ['punjabi', 'panjabi']],
  ['ta', 'Tamil', ['tamil']],
  ['te', 'Telugu', ['telugu']],
  ['mr', 'Marathi', ['marathi']],
  ['gu', 'Gujarati', ['gujarati']],
  ['vi', 'Vietnamese', ['vietnamese', '越南语']],
  ['th', 'Thai', ['thai', '泰语']],
  ['id', 'Indonesian', ['indonesian', 'bahasa indonesia', '印尼语']],
  ['ms', 'Malay', ['malay', 'bahasa melayu']],
  ['tl', 'Tagalog', ['tagalog', 'filipino']],
  ['nl', 'Dutch', ['dutch', 'nederlands', '荷兰语']],
  ['sv', 'Swedish', ['swedish']],
  ['no', 'Norwegian', ['norwegian']],
  ['da', 'Danish', ['danish']],
  ['fi', 'Finnish', ['finnish']],
  ['pl', 'Polish', ['polish', '波兰语']],
  ['cs', 'Czech', ['czech']],
  ['el', 'Greek', ['greek', '希腊语']],
  ['tr', 'Turkish', ['turkish', '土耳其语']],
  ['he', 'Hebrew', ['hebrew', '希伯来语']],
  ['fa', 'Persian', ['persian', 'farsi']],
  ['uk', 'Ukrainian', ['ukrainian', '乌克兰语']],
  ['ro', 'Romanian', ['romanian']],
  ['hu', 'Hungarian', ['hungarian']],
  ['sw', 'Swahili', ['swahili']],
  ['asl', 'American Sign Language', ['american sign language']],
];

const DISPLAY: ReadonlyMap<string, string> = /* @__PURE__ */ new Map(LANGUAGES.map(([id, display]) => [id, display]));
/** 中文的三条：问「Chinese」时三条都算；问普通话或粤语时，只写了「中文」的说不清。 */
const CHINESE_FAMILY: ReadonlySet<string> = /* @__PURE__ */ new Set(['zh', 'cmn', 'yue']);

const clean = (text: string): string =>
  normalizeGuardText(text).replace(/[()（）[\]【】,，;；/|·•:："'“”‘’]/gu, ' ').replace(/\s+/gu, ' ').trim();

const HAN = /\p{Script=Han}/u;

/** 名字在文本里是不是单独出现（拉丁文按词边界，汉字等直接按子串）。 */
function mentions(text: string, name: string): boolean {
  if (HAN.test(name) || !/[a-z]/u.test(name)) return text.includes(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u').test(text);
}

/**
 * 文本里点到的语言（编号，按在文本里出现的先后，去重）。「Chinese (Mandarin)」「Mandarin Chinese」这种同时点到
 * 中文与普通话的，只算更具体的普通话（粤语同理）。
 */
export function languagesNamed(text: string): string[] {
  const haystack = clean(text);
  const hits: { id: string; at: number }[] = [];
  for (const [id, , names] of LANGUAGES) {
    let at = -1;
    for (const name of names) {
      if (!mentions(haystack, name)) continue;
      const position = haystack.indexOf(name);
      if (at < 0 || position < at) at = position;
    }
    if (at >= 0) hits.push({ id, at });
  }
  const ids = hits.sort((left, right) => left.at - right.at).map((hit) => hit.id);
  return ids.includes('zh') && (ids.includes('cmn') || ids.includes('yue')) ? ids.filter((id) => id !== 'zh') : ids;
}

/** 资料里那一条是哪种语言；认不出（拼写、少见语种）是 null。 */
function languageIdOf(entry: ProfileLanguage): string | null {
  const named = languagesNamed(entry.language);
  return named.length === 1 ? named[0]! : null;
}

interface KnownLanguages {
  /** 认得出的那几条：编号 → 水平（同一种写了两条按高的算）。 */
  readonly levels: ReadonlyMap<string, number>;
  /** 有没有认不出的那一条（它说不定就是题里问的那一种）。 */
  readonly unrecognized: boolean;
}

function known(languages: readonly ProfileLanguage[]): KnownLanguages {
  const levels = new Map<string, number>();
  let unrecognized = false;
  for (const entry of languages) {
    const id = languageIdOf(entry);
    if (id === null) {
      unrecognized = true;
      continue;
    }
    levels.set(id, Math.max(levels.get(id) ?? 0, RANK[entry.proficiency]));
  }
  return { levels, unrecognized };
}

/**
 * 他在这种语言上的水平：0 = 资料里没有；null = 说不清（问普通话、资料只写了中文）。
 * 问「Chinese」时取中文三条里最高的那一条。
 */
function levelOf(language: string, facts: KnownLanguages): number | null {
  if (language === 'zh') {
    const levels = [...CHINESE_FAMILY].map((id) => facts.levels.get(id) ?? 0);
    return Math.max(...levels);
  }
  const own = facts.levels.get(language);
  if (own !== undefined) return own;
  if (CHINESE_FAMILY.has(language) && facts.levels.has('zh')) return null;
  return 0;
}

/** 题目要的水平：`NATIVE` 母语／接近母语，`FLUENT` 流利／熟练／工作语言，`SPEAK` 会不会说。 */
type Demand = 'NATIVE' | 'FLUENT' | 'SPEAK';

const NATIVE_WORDS = /\bnative\b|\bnear[-\s]?native\b|\bmother\s+tongue\b|\bfirst\s+language\b|母语|母語|第一语言/u;
const BILINGUAL_WORDS = /\bbilingual\b|双语|雙語/u;
const FLUENT_WORDS =
  /\bfluen(?:t|tly|cy)\b|\bproficien(?:t|tly|cy)\b|\bprofessional\b|\bbusiness[-\s]level\b|\bworking\s+(?:knowledge|proficiency)\b|\bwritten\s+and\s+(?:spoken|verbal|oral)\b|\b(?:spoken|verbal|oral)\s+and\s+written\b|\bread,?\s+write,?\s+and\s+speak\b|\bspeak,?\s+read,?\s+and\s+write\b|\bstrong\s+command\b|\bexcellent\b|流利|熟练|熟練|精通/u;
const SPEAK_WORDS = /\bspeak\b|\bspeaks\b|\bspoken\b|\bspeaker\b|\bcommunicate\b|\bconverse\b|\bknowledge\s+of\b|\bknow\b|会说|會說|说|說/u;

/** 问的不是他自己会不会这门语言，或者问的是别的事（翻译、教、证书、考试分数、年限）。 */
const REFUSED =
  /\btranslat\w*|\binterpret\w*|\bteach\w*|\btutor\w*|\bcertif\w*|\btest\w*|\bexam\w*|\bscore\w*|\btoefl\b|\bielts\b|\bduolingo\b|\bhsk\b|\bjlpt\b|\bdele\b|\bdelf\b|\bdalf\b|\byears?\b|\bmonths?\b|\bfamily\b|\bspouse\b|\bchild(?:ren)?\b|\bparents?\b|\bcustomers?\b|\bclients?\b|\bpatients?\b|\b(?:any|some|every)(?:one|body)\b|\bwho\b|\bprogramming\b|\bcoding\b|\bquery\b|\bsql\b|\bscript\w*|\bsign\b(?!\s+language)/u;
const NEGATION = /\bnot\b|n['’]t\b|\bnever\b|\bunable\b|\bno\s+longer\b|\bother\s+than\b|\bexcept\b|\bbesides\b|\bapart\s+from\b/u;
/** 是在问他（你会……吗、你是……吗），不是在陈述或要求（「Spanish required」那种说明不算题）。 */
const ASKS = /\b(?:do|can|are|would|have|will)\s+you\b|\byour\b|\bis\s+\w+(?:\s+\w+)?\s+your\b|你|您|\?$|？$/u;

export type LanguageAnswerBasis = 'LANGUAGES_IN_PROFILE';

/** 一道是非题：是／否，依据是资料里的语言。 */
export interface LanguageYesNo {
  readonly answer: 'YES' | 'NO';
  readonly basis: LanguageAnswerBasis;
}

/**
 * 「你会说 X 吗」「你 X 流利吗」「你是 X 母语或接近母语吗」「你是 X 双语吗」——按资料里的语言答是或否；
 * 不是这一类题、或资料说不清，就 null。
 *
 * 点到好几种语言时：用 or 连着的（会法语或德语吗）有一种够就是、全都没有才是否；用 and 连着的（英语和西语都流利吗）
 * 都够才是、有一种不够就是否。分不清是 and 还是 or 的不答。
 */
export function languageYesNo(text: string, languages: readonly ProfileLanguage[] | undefined): LanguageYesNo | null {
  if (languages === undefined || languages.length === 0) return null;
  const question = normalizeGuardText(text).replace(/\((?:required|optional)\)/gu, ' ').trim();
  if (question === '' || REFUSED.test(question) || NEGATION.test(question) || !ASKS.test(question)) return null;
  const named = languagesNamed(question);
  if (named.length === 0) return null;
  const bilingual = BILINGUAL_WORDS.test(question);
  const demand: Demand | null = NATIVE_WORDS.test(question)
    ? 'NATIVE'
    : bilingual || FLUENT_WORDS.test(question)
      ? 'FLUENT'
      : SPEAK_WORDS.test(question)
        ? 'SPEAK'
        : null;
  if (demand === null) return null;
  // 好几种语言：要说得清是 and 还是 or。
  const joiner = named.length === 1 ? 'one' : /\bor\b|或|还是|還是/u.test(question) && !/\band\b|和|及/u.test(question)
    ? 'any'
    : /\band\b|和|及/u.test(question) && !/\bor\b|或/u.test(question)
      ? 'all'
      : null;
  if (joiner === null) return null;
  const facts = known(languages);
  const verdicts = named.map((language) => verdictFor(language, demand, facts));
  const yes: LanguageYesNo = { answer: 'YES', basis: 'LANGUAGES_IN_PROFILE' };
  const no: LanguageYesNo = { answer: 'NO', basis: 'LANGUAGES_IN_PROFILE' };
  // 「Are you Spanish bilingual?」只点了一种：这一种要在工作语言及以上，还要另有一种（不是同一种，中文三条算一种）也是。
  // 「Are you bilingual in English and Spanish?」点了两种，就是两种都要好（下面 and 那一支）。
  if (bilingual && named.length === 1) {
    const verdict = verdicts[0]!;
    if (verdict !== 'YES') return verdict === null ? null : no;
    const family = (id: string): string => (CHINESE_FAMILY.has(id) ? 'zh' : id);
    const asked = family(named[0]!);
    return [...facts.levels.entries()].some(([id, level]) => family(id) !== asked && level >= RANK.PROFESSIONAL) ? yes : null;
  }
  if (joiner === 'any') {
    if (verdicts.includes('YES')) return yes;
    return verdicts.every((verdict) => verdict === 'NO') ? no : null;
  }
  // 只点了一种、或 and 连着的几种：有一种不够就是否；都够才是。
  if (verdicts.includes('NO')) return no;
  return verdicts.every((verdict) => verdict === 'YES') ? yes : null;
}

/** 一种语言、一个要求：是／否／说不清。 */
function verdictFor(language: string, demand: Demand, facts: KnownLanguages): 'YES' | 'NO' | null {
  const level = levelOf(language, facts);
  if (level === null) return null;
  if (level === 0) {
    // 资料里没有这一种：英语不答「否」（常常不写），有认不出的那一条也不答「否」。
    if (language === 'en' || facts.unrecognized) return null;
    return 'NO';
  }
  switch (demand) {
    case 'NATIVE':
      return level >= RANK.NATIVE_OR_BILINGUAL ? 'YES' : level <= RANK.CONVERSATIONAL ? 'NO' : null;
    case 'FLUENT':
      return level >= RANK.PROFESSIONAL ? 'YES' : 'NO';
    case 'SPEAK':
      return level >= RANK.CONVERSATIONAL ? 'YES' : null;
  }
}

/** 问的是一串语言（「会哪几种语言」「语言技能，勾选所有适用的」「英语以外还会哪些语言」）。 */
const LIST_ASKED =
  /\b(?:which|what)\s+(?:other\s+)?languages?\b|\blanguages?\s*\(s\)|\blanguage\s+skills?\b|\blanguages?\s+(?:spoken|you\s+speak|do\s+you\s+speak|you\s+are\s+fluent)\b|\bother\s+languages?\b|\blanguages?\b.*\b(?:check|select|choose|tick)\s+all\b|哪些语言|哪几种语言|会说的语言|语言能力/u;
const EXCLUDES_ENGLISH = /\bother\s+than\s+english\b|\bbesides\s+english\b|\bexcept\s+english\b|\bapart\s+from\s+english\b|\bin\s+addition\s+to\s+english\b|\bother\s+languages?\b|英语以外|除了英语|除英语外/u;
const LIST_REFUSED =
  /\btranslat\w*|\binterpret\w*|\bteach\w*|\bcertif\w*|\btest\w*|\bscore\w*|\bprogramming\b|\bcoding\b|\bframeworks?\b|\btools?\b|\bfamily\b|\bspouse\b|\bcustomers?\b|\bclients?\b/u;

/** 一道「列出语言」的题要的是哪几种：水平门槛（流利还是会说就行）、要不要去掉英语。不是这一类就 null。 */
function listDemand(text: string): Readonly<{ min: number; excludeEnglish: boolean }> | null {
  const question = normalizeGuardText(text);
  if (!LIST_ASKED.test(question) || LIST_REFUSED.test(question)) return null;
  const native = NATIVE_WORDS.test(question);
  const fluent = FLUENT_WORDS.test(question);
  return { min: native ? RANK.NATIVE_OR_BILINGUAL : fluent ? RANK.PROFESSIONAL : RANK.CONVERSATIONAL, excludeEnglish: EXCLUDES_ENGLISH.test(question) };
}

/**
 * 勾选题（复选框组、多选下拉）：勾上资料里够水平的那几种语言对应的选项（选项原文，按页面顺序）。一项都勾不上、
 * 不是这一类题、资料里没有语言，都是 null（不替他勾「None」）。中文三条的对应与是非题同一套：选项写「Mandarin」、
 * 资料只写了「中文」，那一项不勾。
 */
export function languageOptionsToCheck(
  text: string,
  options: readonly string[],
  languages: readonly ProfileLanguage[] | undefined,
): readonly string[] | null {
  if (languages === undefined || languages.length === 0) return null;
  const demand = listDemand(text);
  if (demand === null) return null;
  const facts = known(languages);
  const chosen: string[] = [];
  for (const option of options) {
    const named = languagesNamed(option);
    if (named.length !== 1) continue;
    const language = named[0]!;
    if (demand.excludeEnglish && language === 'en') continue;
    const level = levelOf(language, facts);
    if (level !== null && level >= demand.min) chosen.push(option);
  }
  return chosen.length > 0 ? chosen : null;
}

/**
 * 文本题（「英语以外你还流利地说哪些语言」「你会说哪些语言」）：资料里够水平的那几种，英文名逗号隔开，按资料的顺序。
 * 资料里认不出的那一条照他自己写的原样带上（那是他自己的话）。一种都没有就 null（不替他写「None」）。
 */
export function languageListText(text: string, languages: readonly ProfileLanguage[] | undefined): string | null {
  if (languages === undefined || languages.length === 0) return null;
  const demand = listDemand(text);
  if (demand === null) return null;
  const names: string[] = [];
  for (const entry of languages) {
    if (RANK[entry.proficiency] < demand.min) continue;
    const id = languageIdOf(entry);
    if (demand.excludeEnglish && id === 'en') continue;
    const name = id === null ? entry.language.trim() : DISPLAY.get(id) ?? entry.language.trim();
    if (name !== '' && !names.includes(name)) names.push(name);
  }
  return names.length > 0 ? names.join(', ') : null;
}
