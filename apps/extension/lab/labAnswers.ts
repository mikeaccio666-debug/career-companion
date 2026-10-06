/**
 * ATS lab mock answers (VIBE_DIST=ats-lab only).
 *
 * The profile plan only writes the eleven canonical keys, collections, the
 * resume and the cover letter. Everything else a real form asks (country,
 * "how did you hear about us", work authorization, relocation, salary, free
 * text questions, self-identification) needs an answer source. Production
 * gets those from the backend question service or the user's review panel;
 * the lab synthesizes them here and feeds them through the same
 * `buildFillPlan` path the product uses for remembered answers.
 *
 * Boundaries kept on purpose:
 *  - consent grants, certifications, e-signatures, marketing opt-ins and
 *    "contact my employer" questions are never mocked (the kernel would also
 *    refuse the NEVER class on its own);
 *  - self-identification questions are answered with the "decline" option
 *    only, and only while the lab option `selfIdentification` is on.
 */

import type { ApplyFormDescriptor, ApplyPlan } from '@edaix/apply-kernel/contracts';
import { describeQuestion, type QuestionDescription } from '@edaix/apply-kernel/questions';
import type { QuestionAnswer } from '@edaix/apply-kernel/engine';
import { LAB_PROFILE } from './labProfile';

export interface LabAnswerOptions {
  /** Answer EEO / self-identification questions with a decline option (default true). */
  readonly selfIdentification?: boolean;
  /**
   * The option list handed to `labAnswerFor` came from opening a widget and may be
   * incomplete (virtualised list, one level of a tiered menu). A complete enumeration
   * — a radio/checkbox group or a native select — sets this false.
   */
  readonly optionsMayBePartial?: boolean;
  /**
   * Option texts harvested from combobox widgets before the plan was built
   * (the kernel asks comboboxes as free text, so without this a mock answer
   * has to guess the exact wording of an option).
   */
  readonly harvestedOptions?: ReadonlyMap<Element, readonly string[]>;
}

export interface LabMockAnswerReport {
  readonly questionId: string;
  readonly order: number;
  readonly label: string;
  readonly controlType: QuestionDescription['controlType'];
  readonly skipReason: string;
  readonly value: string;
  readonly category: string;
  readonly optionCount: number;
  readonly harvested: boolean;
}

const ANSWERABLE_SKIP_REASONS: ReadonlySet<string> = new Set([
  'LOW_CONFIDENCE',
  'JOB_DEPENDENT',
  'CHOICE_NO_DATA',
  'NO_VALUE',
  'MANUAL_ONLY',
  // 乙档预填：生产里由用户在授权弹框上点一次确认放行，lab 替他点。
  // 放行的值不走下面的猜测，见 `PREFILL_REASON` 处。
  'PREFILLED_NEEDS_CONFIRMATION',
]);

/** 已经挑好答案、只差用户放行的那一档。 */
const PREFILL_REASON = 'PREFILLED_NEEDS_CONFIRMATION';

const CONSENT = /\b(agree|consent|certify|acknowledge|accept the|signature|sign (?:here|below)|subscribe|newsletter|marketing|contact (?:my|your) (?:current )?employer|background check|drug (?:test|screen)|arbitration|credit check|terms (?:and|&) conditions|privacy policy)\b/iu;
const SELF_ID = /\b(gender|race|ethnicit|hispanic|latino|veteran|disabilit|lgbtq|sexual orientation|pronouns?\b|transgender|self[- ]identif|non-binary)/iu;

type Options = QuestionDescription['options'];

const normalizeOptionText = (text: string): string => text.replace(/\s+/gu, ' ').trim().toLowerCase();

function pickOption(options: Options, preferences: readonly RegExp[]): string | null {
  for (const pattern of preferences) {
    const hit = options.find((option) => pattern.test(option.text));
    if (hit) return hit.text;
  }
  return null;
}

const YES = [/^yes\b/iu];
const NO = [/^no\b/iu, /\bnot\b/iu];
const DECLINE = [/decline|prefer not|don'?t wish|do not wish|not to (?:say|answer|disclose)|choose not|rather not/iu, /^no\b/iu];

interface AnswerRule {
  readonly pattern: RegExp;
  readonly category: string;
  readonly withOptions: readonly RegExp[];
  readonly freeText: string;
}

const RULES: readonly AnswerRule[] = [
  { pattern: /pronounce|pronunciation/iu, category: 'name-pronunciation', withOptions: [], freeText: 'TAY-lor ig-ZAM-pul' },
  // Phone **metadata** must never receive the number itself. Workday asks for a
  // "Phone Device Type" (a picker) and a "Phone Extension" next to "Phone Number";
  // 2026-09-15 live, the generic /phone|mobile/ rule below put the whole number
  // into the extension box — a control the kernel's own PHONE_GUARD exists to
  // protect, reached through the answer lane instead of the profile lane. These
  // two rules sit ahead of it so the specific reading always wins.
  { pattern: /phone (?:device )?type|device type/iu, category: 'phone-device-type', withOptions: [/^mobile$/iu, /cell/iu, /^home$/iu], freeText: 'Mobile' },
  { pattern: /extension|\bext\b|area code|country (?:phone |calling |dial(?:ing)? )?code/iu, category: 'phone-meta', withOptions: [/united states/iu, /\(\+1\)/u], freeText: '' },
  // 他人信息：只有 set-other-person 打开时这一栏才会走到答案层（见 engine 的守卫）。
  { pattern: /references?\b|referee|emergency contact/iu, category: 'references', withOptions: [], freeText: 'Jordan Sample, Example Corp, jordan.sample@example.com, +1 415 555 0177' },
  // 「你是否有在**该国**工作的合法资格」里带着 country 这个词，「是否持有本州执照」
  // 带着 state——它们问的是资格不是国别/州别。具体读法必须排在通用的地理规则之前，
  // 否则这两道题会按地名去答（2026-09-15 实测 Lever / BambooHR 上各有一道）。
  // 2026-09-15 实测（nvidia.wd5 第 3 步 Application Questions）：这两条必须排在
  // 下面那条裸 `country` 之前。雇主的两道移民题分别是「Are you legally authorized to
  // work in the **country** where this position is located?」与「Will you require
  // employer support to obtain or maintain authorization to work in that **country**?
  // e.g. (work permit)」——两句都含 country，于是先命中地址那条、答出「United States」，
  // 而采到的选项只有 Yes / No，两道题双双落 CHOICE_NO_DATA，整页过不去。裸 country 是
  // 一个**字段名**规则（地址里的 Country 栏），不该吞掉只是提到某个国家的问句。
  // sponsorship 这条同时补上「require employer support …authorization to work」的说法：
  // 只认 sponsor/visa 的话，第二题会落到 work-authorization 上答成「Yes」——对一个不需要
  // 任何担保的 mock 申请人来说那是个**错**答案，而不只是一个没答上的格子。
  { pattern: /sponsor|\bvisa\b|require (?:employer|company|immigration)\s+support|employer support to (?:obtain|maintain)/iu, category: 'sponsorship', withOptions: NO, freeText: 'No' },
  { pattern: /authori[sz]ed|eligible to work|legally|work permit|right to work|work in the/iu, category: 'work-authorization', withOptions: YES, freeText: 'Yes' },
  { pattern: /\bcountry\b/iu, category: 'country', withOptions: [/^united states(?: of america)?$/iu, /united states/iu, /^usa?$/iu], freeText: 'United States' },
  { pattern: /\b(?:state|province)\b/iu, category: 'state', withOptions: [/^california$/iu, /^ca$/iu], freeText: 'California' },
  { pattern: /\bcity\b|\blocation\b/iu, category: 'city', withOptions: [/san francisco/iu], freeText: 'San Francisco' },
  { pattern: /\bzip\b|postal/iu, category: 'postal', withOptions: [], freeText: '94105' },
  { pattern: /street|address line|\baddress\b/iu, category: 'address', withOptions: [], freeText: '123 Example Street' },
  { pattern: /how did you (?:hear|find|learn)|referral source|\bsource\b|where did you/iu, category: 'source', withOptions: [/linkedin/iu, /job board/iu, /other/iu], freeText: 'LinkedIn' },
  { pattern: /relocat|located in|based in|willing to|commut|remote|on[- ]?site|hybrid|in[- ]office|in person/iu, category: 'location-preference', withOptions: YES, freeText: 'Yes' },
  { pattern: /salary|compensation|pay (?:expectation|rate|range)|desired (?:pay|rate)|rate expectation/iu, category: 'compensation', withOptions: [], freeText: '150000' },
  { pattern: /date available|available date|availability date|start date|available to start|earliest (?:start|date)/iu, category: 'availability-date', withOptions: [], freeText: '10/01/2026' },
  { pattern: /availability|notice period|when can you start/iu, category: 'availability', withOptions: [], freeText: '2 weeks' },
  { pattern: /years? of (?:\w+ )?experience|how many years/iu, category: 'experience-years', withOptions: [/\b(?:8|5|6|7|9|10)\b/u, /\+/u], freeText: '8' },
  { pattern: /linkedin/iu, category: 'link', withOptions: [], freeText: LAB_PROFILE.linkedinUrl ?? '' },
  { pattern: /github/iu, category: 'link', withOptions: [], freeText: LAB_PROFILE.githubUrl ?? '' },
  { pattern: /portfolio|website|personal site|\burl\b/iu, category: 'link', withOptions: [], freeText: LAB_PROFILE.portfolioUrl ?? '' },
  { pattern: /phone|mobile/iu, category: 'phone', withOptions: [], freeText: LAB_PROFILE.phone ?? '' },
  { pattern: /e-?mail/iu, category: 'email', withOptions: [], freeText: LAB_PROFILE.email ?? '' },
  { pattern: /full name|your name|^name$/iu, category: 'name', withOptions: [], freeText: LAB_PROFILE.fullName ?? '' },
  { pattern: /first name|given name/iu, category: 'name', withOptions: [], freeText: LAB_PROFILE.firstName ?? '' },
  { pattern: /last name|family name|surname/iu, category: 'name', withOptions: [], freeText: LAB_PROFILE.lastName ?? '' },
  { pattern: /\b(?:18|eighteen)\b|legal age|of age/iu, category: 'age', withOptions: YES, freeText: 'Yes' },
  { pattern: /currently (?:employed|work)|previously (?:worked|employed)|former employee|worked (?:at|for)|applied (?:to|for|before)/iu, category: 'employment-history', withOptions: NO, freeText: 'No' },
  { pattern: /language|fluent|proficien/iu, category: 'language', withOptions: [/english/iu, /native|fluent/iu], freeText: 'English' },
  // A school picker is a closed catalogue of institutions; when the mock applicant's
  // university is not in it the host's own "not listed" row is the honest answer, and
  // some postings say so in the question text.
  { pattern: /which (?:university|school|college)|currently attending|last attend/iu, category: 'school', withOptions: [/university of california.*berkeley|uc berkeley/iu, /other \(?school not listed\)?|not listed|^other$/iu], freeText: 'Other (School not listed)' },
  { pattern: /highest (?:level of )?education|degree|school|university|college/iu, category: 'education', withOptions: [/bachelor/iu], freeText: "Bachelor's Degree" },
  { pattern: /current (?:company|employer)|employer/iu, category: 'employer', withOptions: [], freeText: 'Example Corp' },
  { pattern: /title|position|role/iu, category: 'title', withOptions: [], freeText: 'Senior Software Engineer' },
];

const GENERIC_PARAGRAPH =
  'Mock answer from the EdAIX ATS lab. This text is synthetic, exists only to exercise the field, and is never submitted.';

export function labAnswerFor(question: QuestionDescription, options: LabAnswerOptions): { value: string; category: string } | null {
  const text = question.text;
  const opts = question.options;
  const hasOptions = opts.length > 0;
  if (CONSENT.test(text)) return null;
  if (SELF_ID.test(text)) {
    if (options.selfIdentification === false) return null;
    const pronouns = /\bpronouns?\b/iu.test(text);
    const value = hasOptions
      ? pickOption(opts, pronouns ? [...DECLINE, /just use my name|use my name/iu, /they\/them/iu] : DECLINE)
      : pronouns ? 'They/them' : 'Decline to self-identify';
    return value ? { value, category: 'self-identification' } : null;
  }
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    if (hasOptions) {
      // 两种"有选项"要分开，因为它们的选项集可信度不同：
      //
      // · **完整枚举**（单选/复选组、原生 select）——describeQuestion 数的是这道题
      //   全部成员，取其中一项一定是页面上真有的答案。
      // · **采集来的**（combobox 打开菜单读到的）可能只是一部分：虚拟列表只渲染可见行，
      //   分层菜单只走了一层。2026-09-15 实测 Workday 的「How Did You Hear About Us?」
      //   只采到 Associations 那一层，拿首项顶上去就把这道题答成了「Atidim」。
      //
      // 所以：首选项命中就用它；否则若规则的 freeText 本来就在选项里就用那一项；
      // 都不成立时，完整枚举取首项（页面上真有的答案），采集来的退回 freeText
      // 交给写入侧的匹配阶梯——匹配不上就如实失败，而不是替用户瞎答。
      const preferred = pickOption(opts, rule.withOptions);
      const freeTextOption = rule.freeText
        ? opts.find((option) => normalizeOptionText(option.text) === normalizeOptionText(rule.freeText)
            || normalizeOptionText(option.text).startsWith(normalizeOptionText(rule.freeText)))
        : undefined;
      const fallback = options.optionsMayBePartial === true
        // 采集来的列表：有 freeText 就交给写入侧的阶梯去判；规则本来就没有
        // freeText 的（比如国家码那条，它只想从选项里挑），没有别的东西可用。
        ? (rule.freeText || opts[0]?.text || null)
        : (opts[0]?.text ?? rule.freeText ?? null);
      const picked = preferred ?? freeTextOption?.text ?? fallback;
      return picked ? { value: picked, category: rule.category } : null;
    }
    return rule.freeText ? { value: rule.freeText, category: rule.category } : null;
  }
  if (hasOptions) {
    // 孤立的单个复选框不是"一道题"，是宿主的 UI 开关：Workday 的
    // "I have a preferred name" 勾上会让表单长出一整段新字段，把本轮扫描的
    // 元素全部重渲染成 DETACHED（2026-09-15 实测）。有明确是非选项的题照常答，
    // 单框默认不动并如实记一行。
    if (question.controlType === 'MULTI_CHOICE' && opts.length === 1) return null;
    return { value: pickOption(opts, [...YES, ...NO]) ?? opts[0]!.text, category: 'generic-choice' };
  }
  if (question.controlType === 'TEXTAREA') return { value: GENERIC_PARAGRAPH, category: 'generic-textarea' };
  return { value: 'Mock lab answer', category: 'generic-text' };
}

/** Mock answers for every field the profile plan left unfilled for a reviewable reason. */
export function labMockAnswers(
  descriptor: ApplyFormDescriptor,
  profilePlan: ApplyPlan,
  options: LabAnswerOptions = {},
): { answers: QuestionAnswer[]; report: LabMockAnswerReport[] } {
  const answers: QuestionAnswer[] = [];
  const report: LabMockAnswerReport[] = [];
  for (const skip of profilePlan.skipped) {
    if (!ANSWERABLE_SKIP_REASONS.has(skip.reason)) continue;
    const field = descriptor.fields[skip.order];
    if (!field || field.element !== skip.element) continue;
    if (field.kind === 'unsupported' || field.kind === 'file' || field.kind === 'richtext') continue;
    const questionId = `q${skip.order}`;
    const described = describeQuestion(field, questionId);
    if (described === null) continue;
    const harvested = field.kind === 'combobox' && described.options.length === 0
      ? options.harvestedOptions?.get(field.element)
      : undefined;
    const question: QuestionDescription = harvested && harvested.length > 0
      ? { ...described, controlType: 'SINGLE_CHOICE', options: harvested.map((text, index) => ({ optionId: `h${index}`, text })) }
      : described;
    // A canonical profile key that the profile plan could not use with confidence still has a
    // profile value; prefer it over a guessed answer.
    const profileValue = typeof field.key === 'string' && field.key in LAB_PROFILE
      ? (LAB_PROFILE as Record<string, string | undefined>)[field.key]
      : undefined;
    // 乙档预填放行的是 engine 在**这一页的选项里**挑出来的那一项原文，
    // 不是档案里的枚举，也不是 mock 的猜测——要量的正是那一步挑得对不对。
    // `selfIdentification: false` 仍然关掉整条：那个开关的语义是「这轮不碰
    // 自我认同类题目」，预填过的也一样不碰。
    const prefill = skip.reason === PREFILL_REASON ? skip.prefill : undefined;
    if (skip.reason === PREFILL_REASON && (prefill === undefined || options.selfIdentification === false)) continue;
    const answer = prefill !== undefined
      ? { value: prefill, category: 'tier-b-prefill' }
      : profileValue && skip.reason !== 'CHOICE_NO_DATA'
      ? { value: profileValue, category: 'profile-low-confidence' }
      : labAnswerFor(question, {
          ...options,
          // Only a harvested list can be partial; describeQuestion enumerates a
          // choice group or a native select in full.
          optionsMayBePartial: harvested !== undefined && harvested.length > 0,
        });
    if (answer === null) continue;
    answers.push({ questionId, element: field.element, value: answer.value });
    report.push({
      questionId,
      order: skip.order,
      label: question.text.slice(0, 120),
      controlType: question.controlType,
      skipReason: skip.reason,
      value: answer.value.slice(0, 120),
      category: answer.category,
      optionCount: question.options.length,
      harvested: harvested !== undefined && harvested.length > 0,
    });
  }
  return { answers, report };
}
