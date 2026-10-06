/**
 * 用档案里的学历与工作经历推出来的两类答案（2026-09-24，负责人：「跟 Jobright 一样」）。
 *
 * 1. 「是否年满 18 岁」：档案里有明确的是／否（Profile V2 `eligibility.over18`）就照它答，与从前逐字相同；
 *    没有时，有至少一段教育或一段工作经历就当作年满 18。档案写着还在读高中不推（那恰好是「未必成年」的证据）。
 *    题目问的是哪一边（反着问的「Are you under 18?」答反面）由 dict/ageQuestion.ts 判，与明确值共用。
 * 2. 「你在这家公司工作过吗」「你是这家公司的在职或前员工吗」：经历里有一段的雇主按比对口径就是本次申请的
 *    公司 → 是；没有 → 否。问「你现在是否受雇于 X」的，只有一段在职的经历对得上才答是。
 *
 * 3. 「Are you a transitioning service member?」（2026-09-24，负责人：跟 Jobright 一样；Shield AI 的 Lever 表单）：有工作
 *    经历、且没有一段看起来是军队服役 → 否。有一段像（陆海空军、海军陆战队、海岸警卫队、太空军、国民警卫队、武装部队、
 *    国防部……，也看教育里的军校与 ROTC）、或工作经历一段都没有，就不答。题面由规则认（键 transitioningServiceMember），
 *    这里再核一遍是那一句本身。
 *
 * 几类都只在选项控件上写，页面上恰好一项对得上才写（调用方按既有的选项匹配判）；条目带上依据
 * （`HistoryAnswerBasis`），浮层据此照实写明答案是怎么来的。公司名与档案里的值只在内存里比对，
 * 不进日志、不进诊断（RULE-GLOBAL-DATA-L1）。
 */

import type { HistoryAnswerBasis } from '../contracts';
import type { ApplyProfileCollections } from '../profileCollections';
import { normalizeGuardText } from './guards';

// ── 年满 18 ──────────────────────────────────────────────────────────

/** 档案能不能推出「年满 18」：至少一段教育或工作经历，而且没有一段写着还在读高中。 */
export function adultFromHistory(collections: ApplyProfileCollections | undefined): boolean {
  const educations = collections?.educations ?? [];
  if (educations.some((item) => item.degreeLevel === 'HIGH_SCHOOL' && item.isCurrent)) return false;
  return educations.length > 0 || (collections?.experiences?.length ?? 0) > 0;
}

// ── 在这家公司工作过吗 ───────────────────────────────────────────────

/** `EVER`：工作过（含现在在职）；`CURRENT`：现在在职。 */
export type EmploymentTense = 'EVER' | 'CURRENT';

/** 打头的法人实体代码：「ADUS-Adobe Inc.」的「ADUS-」。 */
const ENTITY_CODE_PREFIX = /^\s*[A-Z0-9]{2,8}-(?=\p{Lu})/u;

/**
 * 公司名的比对口径：NFKC、去掉打头的法人实体代码、小写、去标点、去公司后缀（Inc / LLC / Ltd / Corp / Co …）、压空白。
 * 「Acme, Inc.」与「ACME」算同一家；「Acme Labs」与「Acme」不算——宁可不填。
 *
 * 法人实体代码（2026-09-24 adobe.wd5）：Workday 的 JobPosting 里 hiringOrganization 写成「ADUS-Adobe Inc.」，题面只说
 * 「Adobe」。只认「两位以上大写字母或数字＋连字符＋大写字母开头的名字」：T-Mobile、E-Trade 一位打头，照旧是本名。
 * 真把名字的一截当成了代码，结果也只是对不上、不答，不会答错。
 */
export function normalizeCompany(value: string): string {
  return value
    .normalize('NFKC')
    .replace(ENTITY_CODE_PREFIX, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    // 带点的缩写（「N.V.」「L.L.C.」）去掉标点后是一串单个字母，先并回一个词，后缀表才认得。
    .replace(/\b(?:[a-z]\s+){1,3}[a-z]\b/gu, (letters) => letters.replace(/\s+/gu, ''))
    // SE / NV / BV（2026-10-04）：欧洲公司的法人形式（「Zalando SE」「SAP SE」），岗位的 JobPosting 常带着它，题面与经历不带。
    .replace(/\b(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|ag|se|nv|bv|pte|pty)\b/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 不归这里管、或这样问答不准的：申请过／面试过；问的是别人（亲友、推荐、「认识谁」）；「与 X 合作过」、
 * 合作伙伴、客户、供应商、竞争对手；否定句；限定了时间段（「过去 12 个月」答「是」要看日期）。
 */
const REFUSED =
  /\bappl(?:y|ied|ications?)\b|\binterview|\brelatives?\b|\bfamily\b|\bfriends?\b|\bspouse|\brelated\b|\b(?:any|some)(?:one|body)\b|\bknow\b|\brefer|\bwork(?:ed|ing|s)?\s+with\b|\bpartners?\b|\b(?:client|customer|vendor|supplier|competitor)s?\b|\bnot\b|\bnever\b|n['’]t\b|\b\d+\s*(?:months?|years?|yrs?|weeks?|days?)\b|\b(?:past|previous|recent|last)\s+(?:\w+\s+)?(?:months?|years?|weeks?)\b|\bwithin\b|\bsince\b|\bduring\b|\blast\b/u;

/** 只问承包商／顾问／实习身份的（没提 employee / employed）：经历里认不出那种身份，不答。 */
const CONTRACT_ONLY = /\bcontract(?:ors?|ed|ing)?\b|\bconsult(?:ants?|ing)?\b|\bfreelanc|\bintern(?:ed|s|ships?)?\b|\btemp(?:orary)?\b/u;
const EMPLOYEE_WORD = /\bemploy(?:ees?|ed|ment)\b/u;

const ADV = '(?:(?:ever|previously|formerly|already|once|currently|presently|now|also|recently)\\s+)*';
const YOU = `\\b(?:have|had|were|are|did|do)\\s+you\\s+${ADV}(?:been\\s+)?${ADV}`;
const ROLE = '(?:current|former|previous|past|ex)(?:\\s*(?:or|/)\\s*(?:current|former|previous|past))?[\\s-]+';
/** have you (ever) (been) worked/employed for|at|by|with X；worked here。 */
const WORKED_FOR = new RegExp(`(?:${YOU}|^${ADV})(?:employed|work(?:ed|ing)?)\\s+(?:(?:by|for|at|with)\\s+(.+)|(here)\\b)`, 'u');
/** (are you a) current or former employee of X。 */
const EMPLOYEE_OF = new RegExp(`(?:${YOU}(?:an?\\s+)?|^)(?:${ROLE})?employee\\s+(?:of|at|with|for)\\s+(.+)`, 'u');
/**
 * (are you a) current or former X employee；former employee。没点名公司时必须带 current / former 一类的词
 * （说的就是这家）：光秃秃的「Are you an employee?」分不清问的是不是这家。
 */
const COMPANY_EMPLOYEE = new RegExp(`(?:${YOU}(?:an?\\s+)?(${ROLE})?|^(${ROLE}))(?:(.+?)\\s+)?employee$`, 'u');

const PAST = /\b(?:ever|previously|formerly|former|previous|past|before|prior|once|ex|have|had|were|did)\b/u;
const PRESENT = /\b(?:currently|current|presently|now|are|do)\b/u;

/** 说的就是这一家：us / here / this company / our organization / the employer … */
const SELF = /^(?:us|here|(?:this|our|the) (?:company|organi[sz]ation|employer|firm|business))$/u;
/**
 * 公司名后面允许跟的话：时间状语、以什么身份、子公司／关联公司、「你正在申请的」。公司后缀（Inc、Corp…）
 * 不必列：从长到短试到「Acme Inc」那一截时，比对口径已经把后缀去掉了。
 */
const FILLER: ReadonlySet<string> = new Set(
  ('before previously formerly ever here in the past at any point time as a an employee employees staff member full part '
    + 'or and either including of its their our one all subsidiary subsidiaries affiliate affiliates affiliated companies '
    + 'company division divisions brand brands entity entities capacity role position contractor consultant intern internships '
    + 'you re are applying to for').split(' '),
);

/**
 * 题面点名的对象是不是本次申请的这一家：公司名（或 us / this company）打头，后面只剩允许跟的话。
 * 打头的「any of (the / its)」「one of」（2026-10-04：「employed by any of Acme entities」）不算对象本身。
 */
function namesHiringCompany(object: string, company: string): boolean {
  const words = object.replace(/^(?:any|one|either)\s+of\s+(?:the\s+|its\s+)?/u, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let end = words.length; end > 0; end -= 1) {
    if (end < words.length && !FILLER.has(words[end]!)) return false;
    const head = words.slice(0, end).join(' ');
    if (SELF.test(head) || normalizeCompany(head) === company) return true;
  }
  return false;
}

/**
 * 这道题是不是在问「你在本次申请的这家公司工作过吗／现在在吗」；是就给出问的是哪一种，否则 null。
 *
 * 只认几种常见问法（动词式 have you worked for X、名词式 current or former employee of X / former X employee），
 * 对象必须是这一家（点名它、或说 us / this company / here、或名词式干脆没点名）。岗位公司不知道就一律不认。
 */
export function hiringCompanyEmploymentTense(text: string, jobCompany: string): EmploymentTense | null {
  const company = normalizeCompany(jobCompany);
  if (company === '') return null;
  const full = normalizeGuardText(text).replace(/\((?:required|optional)\)/gu, ' ');
  if (REFUSED.test(full) || (CONTRACT_ONLY.test(full) && !EMPLOYEE_WORD.test(full))) return null;
  // 「…at Adobe in the following capacity:」（2026-09-24 adobe.wd5，选项是一组身份）：「the following」只在后面是身份时算废话——
  // 「…or any of the following companies?」后面列的是别的公司，经历里没有这一家推不出「否」。
  const question = (full.split('?')[0] ?? '').replace(/\bthe following capacit\w*/u, 'capacity').replace(/[\s.!;,]+$/u, '');
  const verb = WORKED_FOR.exec(question) ?? EMPLOYEE_OF.exec(question);
  if (verb !== null) {
    // 动词式必须点名对象（「Have you ever been employed?」问的是有没有工作过，不是这家）。
    if (!namesHiringCompany(verb[1] ?? verb[2] ?? '', company)) return null;
  } else {
    const noun = COMPANY_EMPLOYEE.exec(question);
    if (noun === null) return null;
    const named = noun[3];
    if (named === undefined ? noun[1] === undefined && noun[2] === undefined : !namesHiringCompany(named, company)) return null;
  }
  return PAST.test(question) ? 'EVER' : PRESENT.test(question) ? 'CURRENT' : null;
}

/** 明说没在这里工作过的一句；worked with（合作过）不算——`(.+)` 接到的「with X」过不了公司名那一关。 */
const NOT_EMPLOYED =
  /^(?:no )?(?:i )?(?:have n(?:ot|ever)|haven t|never)(?: (?:ever|previously))? (?:worked(?: for| at)?|been employed(?: by| at| with)?)(?: (.+))?$/u;
const NONE_OF_THEM = /^none(?: of (?:the above|these))?$/u;

/**
 * 答「否」而页面上没有「No」那一项时，「没在这家工作过」的那一项（2026-09-24 adobe.wd5：「Have you ever worked at Adobe in the
 * following capacity:」是一组复选框——Employee、Intern、Temporary Agency or Vendor、Other、「I have not worked for Adobe in the
 * past.」）。闭集阶梯，按序试，某一级恰好一项就是它、两项以上就停（分不清勾哪一项）、一项都没有试下一级：
 *  1. 明说没在这里工作过：have not／have never／haven't／never + worked (for|at)／been employed (by|at|with)；点名的对象
 *     必须是这一家（与题面同一个比对口径），或 here／us／this company，或干脆不点名；
 *  2. 「None of the above」「None of these」「None」。
 * 「No, I have not」这类以 No 打头的由调用方的是／否判读先接住。只该在「经历里根本没有这家」时用：那段经历已经结束时
 * （问「现在」答「否」）「没在这家工作过」不成立。
 */
export function notEmployedOption(options: readonly string[], jobCompany: string): string | null {
  const company = normalizeCompany(jobCompany);
  for (const rung of [
    (text: string) => {
      const hit = NOT_EMPLOYED.exec(text);
      return hit !== null && (hit[1] === undefined || namesHiringCompany(hit[1], company));
    },
    (text: string) => NONE_OF_THEM.test(text),
  ]) {
    const hits = options.filter((option) => rung(option.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()));
    if (hits.length > 0) return hits.length === 1 ? hits[0]! : null;
  }
  return null;
}

const within = (inner: string, outer: string): boolean => inner !== '' && ` ${outer} `.includes(` ${inner} `);

/**
 * 按工作经历答这道题；不是这一类、或答不准就 null。
 *
 * 答不准的几种：经历集合没交来、教育与经历一段都没有（我们不知道他的履历，说「否」是替他编）；
 * 岗位公司不知道；某段经历的雇主只是部分对得上（「Acme Labs」对「Acme」，分不清是不是同一家）；
 * 问「现在」而那段经历既没标在职、也没有结束日期。
 */
export function hiringCompanyEmployment(
  text: string,
  jobCompany: string | undefined,
  collections: ApplyProfileCollections | undefined,
): Readonly<{ answer: 'YES' | 'NO'; basis: HistoryAnswerBasis }> | null {
  if (jobCompany === undefined || collections === undefined) return null;
  const experiences = collections.experiences ?? [];
  if (experiences.length === 0 && (collections.educations?.length ?? 0) === 0) return null;
  const tense = hiringCompanyEmploymentTense(text, jobCompany);
  if (tense === null) return null;
  const company = normalizeCompany(jobCompany);
  let unsure = false;
  let ended = false;
  for (const experience of experiences) {
    const name = normalizeCompany(experience.company);
    // 问「现在」只看在职的那几段：标了在职的算，有结束日期的不算，两样都没有的说不清。
    const counts = tense === 'EVER' || experience.isCurrent ? true : experience.endDate === null ? null : false;
    if (name === company) {
      if (counts === true) return { answer: 'YES', basis: 'EMPLOYER_IN_HISTORY' };
      if (counts === null) unsure = true;
      else ended = true;
    } else if (counts !== false && (within(name, company) || within(company, name))) {
      unsure = true;
    }
  }
  if (unsure) return null;
  return { answer: 'NO', basis: ended ? 'EMPLOYER_ENDED' : 'EMPLOYER_NOT_IN_HISTORY' };
}

// ── 是正在退役转业的军人吗 ──────────────────────────────────────────

/**
 * 题面就是「你（现在）是正在退役转业的军人吗」那一句：规则已经按整句认过（键 transitioningServiceMember），这里再核
 * 一遍，免得规则日后放宽时把别的问法一起答了。带条件（if / whether）、否定、掺了退伍军人（那是 EEO 自我认同）、
 * 问的是家属（配偶、子女、家属）、或者「If yes」接着问项目的，一律不认。
 */
const TRANSITIONING_QUESTION =
  /^(?:(?:are|is)\s+you\s+(?:(?:currently|presently|now)\s+)?(?:an?\s+)?)?transitioning\s+(?:(?:u\s?s|united\s+states)\s+)?(?:military\s+)?service\s*-?\s*members?\s*\??$/u;
const TRANSITIONING_REFUSED =
  /\b(?:if|whether|not|never|veterans?|spouse|spouses|dependents?|family|child|children|partner|relative)\b|n['’]t\b/u;

/**
 * 看起来像军队服役的雇主、职位或学校（宽口径：宁可多认、让这一题交还本人，也不替一个服过役的人答「否」）。
 * 「Old Navy」「Salvation Army」也会被认成军职——那只会让这一题不答，不会答错。
 */
const MILITARY_SERVICE =
  /\b(?:army|navy|naval|air\s+force|marine\s+corps|marines|coast\s+guard|space\s+force|national\s+guard|armed\s+forces|military|usmc|usaf|uscg|ussf|usn|rotc|dod|department\s+of\s+defen[cs]e|department\s+of\s+the\s+(?:army|navy|air\s+force)|soldiers?|sergeant|lieutenant|corporal|colonel|petty\s+officer|warrant\s+officer|commissioned\s+officer|non-?commissioned\s+officer|nco|infantry(?:man)?|airman|sailor|seaman|enlisted|service\s*members?|reservist)\b/u;

const looksMilitary = (value: string | null | undefined): boolean =>
  typeof value === 'string' && MILITARY_SERVICE.test(normalizeGuardText(value).replace(/\./gu, ''));

/**
 * 按工作经历答「你是正在退役转业的军人吗」；不是这一句、或答不准就 null。
 *
 * 答不准的几种：集合没交来、工作经历一段都没有（只凭学历说「否」是替他编）、有一段经历（雇主或职位）或教育（学校或
 * 专业）看起来像军队服役。
 */
export function transitioningServiceMemberAnswer(
  text: string,
  collections: ApplyProfileCollections | undefined,
): Readonly<{ answer: 'NO'; basis: HistoryAnswerBasis }> | null {
  const question = normalizeGuardText(text).replace(/\((?:required|optional)\)/gu, ' ').replace(/[\s.!;,]+$/u, '').trim();
  if (!TRANSITIONING_QUESTION.test(question) || TRANSITIONING_REFUSED.test(question)) return null;
  return noMilitaryInHistory(collections) ? { answer: 'NO', basis: 'NO_MILITARY_SERVICE_IN_HISTORY' } : null;
}

/** 工作经历与教育里都没有一段像军队服役（宽口径，见 `MILITARY_SERVICE`）；工作经历一段都没有就说不清。 */
function noMilitaryInHistory(collections: ApplyProfileCollections | undefined): boolean {
  const experiences = collections?.experiences ?? [];
  if (experiences.length === 0) return false;
  if (experiences.some((experience) => looksMilitary(experience.company) || looksMilitary(experience.title))) return false;
  return !(collections?.educations ?? []).some((education) => looksMilitary(education.school) || looksMilitary(education.fieldOfStudy));
}

// ── 服过兵役吗 ──────────────────────────────────────────────────────

/**
 * 「你（曾经）在军队服过役吗」（2026-10-04）：与「正在退役转业的军人吗」同一个依据——有工作经历、一段都不像军队服役
 * 就答 No。只认问他本人有没有服过役的那几种说法；掺了退伍军人（那是 EEO 自我认同）、家属、条件、否定，或问的是
 * 兵种、日期、退役类型的，不答。
 */
const SERVED_QUESTION = new RegExp(
  '^(?:(?:have|did)\\s+you\\s+(?:ever\\s+)?(?:previously\\s+)?(?:served|serve|been)\\s+in\\s+'
  + '|do\\s+you\\s+have\\s+(?:any\\s+)?(?:prior\\s+|previous\\s+|past\\s+)?)'
  + '(?:the\\s+)?(?:(?:u\\s?s|united\\s+states|us)\\s+)?'
  + '(?:military|armed\\s+forces|army|navy|air\\s+force|marine\\s+corps|marines|coast\\s+guard|space\\s+force|national\\s+guard)'
  + '(?:\\s+(?:or\\s+(?:the\\s+)?)?(?:reserves?|national\\s+guard))?'
  + '(?:\\s+service)?(?:\\s+experience)?$',
  'u',
);
const SERVED_REFUSED =
  /\b(?:if|whether|not|never|veterans?|spouse|spouses|dependents?|family|child|children|partner|relative|branch|dates?|discharge\w*|rank|dd-?\s?214|honorabl\w*)\b|n['’]t\b/u;

/** 按工作经历答「你服过兵役吗」；不是这一句、或答不准就 null。 */
export function militaryServiceAnswer(
  text: string,
  collections: ApplyProfileCollections | undefined,
): Readonly<{ answer: 'NO'; basis: HistoryAnswerBasis }> | null {
  const question = normalizeGuardText(text).replace(/\((?:required|optional)\)/gu, ' ').replace(/\./gu, '').replace(/[\s!;,?]+$/u, '').replace(/\s+/gu, ' ').trim();
  if (!SERVED_QUESTION.test(question) || SERVED_REFUSED.test(question)) return null;
  return noMilitaryInHistory(collections) ? { answer: 'NO', basis: 'NO_MILITARY_SERVICE_IN_HISTORY' } : null;
}

// ── 现在在读吗 ──────────────────────────────────────────────────────

/**
 * 「你这学期在上学吗」「你现在在读吗」「你目前在读学位课程吗」（2026-10-04）。只认问他现在是不是在读的说法：
 * 问全日制还是非全日制、问高中、问打算何时入学或毕业的，不归这里。
 */
const STUDENT_QUESTION = new RegExp(
  '^(?:are|is)\\s+you\\s+(?:currently\\s+|presently\\s+|now\\s+)?'
  + '(?:'
  + '(?:attending|enrolled\\s+(?:in|at)|registered\\s+(?:in|at)|studying\\s+(?:in|at))\\s+(?:a\\s+|an\\s+)?'
  + '(?:school|college|university|classes|courses|(?:degree|academic|educational|university|college|undergraduate|graduate)\\s+(?:program(?:me)?|studies|course))'
  + '(?:\\s+or\\s+(?:a\\s+|an\\s+)?(?:school|college|university))?'
  + '|(?:a\\s+|an\\s+)?(?:current\\s+|currently\\s+)?(?:enrolled\\s+)?(?:college\\s+|university\\s+)?student'
  + ')'
  + '(?:\\s+(?:this|the\\s+current|for\\s+the\\s+current)\\s+(?:semester|term|quarter|school\\s+year|academic\\s+year))?$',
  'u',
);
const STUDENT_REFUSED = /\b(?:full[-\s]?time|part[-\s]?time|high\s+school|secondary|if|whether|not|never|plan|planning|intend|will|next|upcoming|future|graduat\w*|international|f-?1|visa)\b|n['’]t\b/u;

/** `YYYY-MM-DD` → 月序号；不合法就 null。 */
function monthIndex(today: string | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/u.exec(today ?? '');
  if (match === null) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? Number(match[1]) * 12 + (month - 1) : null;
}

/**
 * 按教育经历答「你现在在读吗」；不是这一句、或答不准就 null。`today` 是用户本地的当天（`YYYY-MM-DD`）。
 *
 *  · 有一段教育标着在读、而且（有毕业时间的话）毕业时间还没到 → 是；
 *  · 有一段已经开学、还没到结束（或预计毕业）的那个月 → 是（标在读的那一格漏勾了）；
 *  · 每一段都有结束（或预计毕业）时间、都早于这个月、也没有一段标在读 → 否；
 *  · 其余（没有教育经历、有一段既没标在读也没有结束时间、标着在读却早过了毕业时间、这个月刚好毕业）→ 不答。
 */
export function currentStudentAnswer(
  text: string,
  collections: ApplyProfileCollections | undefined,
  today: string | undefined,
): Readonly<{ answer: 'YES' | 'NO'; basis: HistoryAnswerBasis }> | null {
  const question = normalizeGuardText(text).replace(/\((?:required|optional)\)/gu, ' ').replace(/[\s.!;,?]+$/u, '').replace(/\s+/gu, ' ').trim();
  if (!STUDENT_QUESTION.test(question) || STUDENT_REFUSED.test(question)) return null;
  const now = monthIndex(today);
  const educations = collections?.educations ?? [];
  if (now === null || educations.length === 0) return null;
  const at = (date: { year: number; month: number | null } | null | undefined, missing: number): number | null =>
    date === null || date === undefined ? null : date.year * 12 + ((date.month ?? missing) - 1);
  let undetermined = false;
  for (const education of educations) {
    // 结束那一刻的最早与最晚读法（只有年份时，1 月到 12 月都可能）。
    const endLatest = at(education.endDate ?? education.expectedGraduationDate, 12);
    const endEarliest = at(education.endDate ?? education.expectedGraduationDate, 1);
    const startEarliest = at(education.startDate, 1);
    if (education.isCurrent) {
      if (endEarliest === null || endEarliest > now) return { answer: 'YES', basis: 'STUDENT_FROM_EDUCATION' };
      undetermined = true;
      continue;
    }
    if (endLatest === null) {
      undetermined = true;
      continue;
    }
    if (endEarliest !== null && endEarliest > now && startEarliest !== null && startEarliest <= now) {
      return { answer: 'YES', basis: 'STUDENT_FROM_EDUCATION' };
    }
    if (endLatest >= now) undetermined = true;
  }
  return undetermined ? null : { answer: 'NO', basis: 'STUDENT_FROM_EDUCATION' };
}
