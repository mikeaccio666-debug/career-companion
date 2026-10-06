/**
 * AI 起草开放题（P3-13，2026-09-21）。
 *
 * 手势填写路上没有 mission，也没有 T9 那套「每一句都必须是已确认事实的原话」的证据链；
 * 作文题（Why us / Tell us about / Additional information / Describe…）需要的是一段**草稿**：
 * 按用户档案里的简介、经历与技能，对着这一份岗位起草，交给用户改完再写。
 *
 * 边界：
 *  · 只对 TEXTAREA 一类的开放题；数字、布尔、选择题不走 AI。
 *  · 题目文本与岗位卡片由插件上行（用户点了「让 AI 起草」才发）；档案在服务端读，不经插件转一手。
 *  · 服务端**不落库原文**：请求与草稿都不持久化，只留 requestId 与稳定原因码。
 *  · 草稿永远不自动写入：进复核面板那一行，可编辑，用户点「回填」才写；写入同时按答案记忆的规则记住。
 */

export const APPLICATION_QUESTION_DRAFT_SCHEMA_VERSION = 1 as const;

export const APPLICATION_QUESTION_DRAFT_LIMITS = Object.freeze({
  questions: 12,
  questionText: 2_000,
  jobField: 200,
  draftText: 8_000,
  minMaxLength: 50,
});

export type ApplicationQuestionDraftJobV1 = Readonly<{
  company: string | null;
  title: string | null;
  location: string | null;
}>;

export type ApplicationQuestionDraftQuestionV1 = Readonly<{
  questionId: string;
  text: string;
  /** 宿主控件的 maxlength；null = 没声明。草稿不会超过它。 */
  maxLength: number | null;
}>;

export type CreateApplicationQuestionDraftsRequestV1 = Readonly<{
  schemaVersion: typeof APPLICATION_QUESTION_DRAFT_SCHEMA_VERSION;
  requestId: string;
  job: ApplicationQuestionDraftJobV1;
  questions: readonly ApplicationQuestionDraftQuestionV1[];
}>;

export type ApplicationQuestionDraftV1 = Readonly<{
  questionId: string;
  text: string;
}>;

export const APPLICATION_QUESTION_DRAFT_FAILURE_CODES = [
  'QUESTION_DRAFT_REQUEST_INVALID',
  'QUESTION_DRAFT_DISABLED',
  'QUESTION_DRAFT_PROFILE_UNAVAILABLE',
  'QUESTION_DRAFT_PROVIDER_FAILED',
  'QUESTION_DRAFT_OUTPUT_INVALID',
  'QUESTION_DRAFT_CANCELLED',
] as const;
export type ApplicationQuestionDraftFailureCode = (typeof APPLICATION_QUESTION_DRAFT_FAILURE_CODES)[number];

export type CreateApplicationQuestionDraftsResponseV1 =
  | Readonly<{ schemaVersion: 1; ok: true; requestId: string; drafts: readonly ApplicationQuestionDraftV1[] }>
  | Readonly<{ schemaVersion: 1; ok: false; code: ApplicationQuestionDraftFailureCode }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

/**
 * 应答（服务端 → 插件）用的键检查（2026-09-28）：认得的一个都不能少，多出来的不拒——起草是计量的，
 * 后端在应答里多给一样东西（模型名、用量……），旧包从前把整份草稿判坏，额度白扣。多出来的成员不解释、
 * 不转发（结果从认得的字段重建）。请求照旧用 `hasExactKeys`。
 */
function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return keys.every((key) => actual.includes(key)) &&
    actual.every((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > maximum) return null;
  // 控制字符不该出现在题目或公司名里；出现了就是坏输入，不修补。
  if (hasControlCharacter(text)) return null;
  return text;
}

/** 换行与制表符是作文题里正常的排版；其余 C0 控制字符与 DEL 不是。 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

function nullableBoundedText(value: unknown, maximum: number): string | null | undefined {
  if (value === null) return null;
  const text = boundedText(value, maximum);
  return text === null ? undefined : text;
}

/** 敌意边界解析：形状、上限、字符集任一不符就整份拒——不修补、不截断。 */
export function parseCreateApplicationQuestionDraftsRequestV1(
  value: unknown,
): CreateApplicationQuestionDraftsRequestV1 | null {
  if (!isPlainObject(value)) return null;
  if (!hasExactKeys(value, ['schemaVersion', 'requestId', 'job', 'questions'])) return null;
  if (value.schemaVersion !== APPLICATION_QUESTION_DRAFT_SCHEMA_VERSION) return null;
  if (typeof value.requestId !== 'string' || !UUID.test(value.requestId)) return null;
  if (!isPlainObject(value.job) || !hasExactKeys(value.job, ['company', 'title', 'location'])) return null;
  const company = nullableBoundedText(value.job.company, APPLICATION_QUESTION_DRAFT_LIMITS.jobField);
  const title = nullableBoundedText(value.job.title, APPLICATION_QUESTION_DRAFT_LIMITS.jobField);
  const location = nullableBoundedText(value.job.location, APPLICATION_QUESTION_DRAFT_LIMITS.jobField);
  if (company === undefined || title === undefined || location === undefined) return null;
  if (!Array.isArray(value.questions) || value.questions.length === 0 || value.questions.length > APPLICATION_QUESTION_DRAFT_LIMITS.questions) return null;
  const questions: ApplicationQuestionDraftQuestionV1[] = [];
  const seen = new Set<string>();
  for (const raw of value.questions) {
    if (!isPlainObject(raw) || !hasExactKeys(raw, ['questionId', 'text', 'maxLength'])) return null;
    if (typeof raw.questionId !== 'string' || !QUESTION_ID.test(raw.questionId) || seen.has(raw.questionId)) return null;
    const text = boundedText(raw.text, APPLICATION_QUESTION_DRAFT_LIMITS.questionText);
    if (text === null) return null;
    let maxLength: number | null = null;
    if (raw.maxLength !== null) {
      if (typeof raw.maxLength !== 'number' || !Number.isInteger(raw.maxLength) ||
        raw.maxLength < APPLICATION_QUESTION_DRAFT_LIMITS.minMaxLength || raw.maxLength > APPLICATION_QUESTION_DRAFT_LIMITS.draftText) return null;
      maxLength = raw.maxLength;
    }
    seen.add(raw.questionId);
    questions.push(Object.freeze({ questionId: raw.questionId, text, maxLength }));
  }
  return Object.freeze({
    schemaVersion: APPLICATION_QUESTION_DRAFT_SCHEMA_VERSION,
    requestId: value.requestId,
    job: Object.freeze({ company, title, location }),
    questions: Object.freeze(questions),
  });
}

/** 插件侧解码应答；草稿超长、题目 id 对不上请求的整份拒收。 */
export function parseCreateApplicationQuestionDraftsResponseV1(
  value: unknown,
  request: Pick<CreateApplicationQuestionDraftsRequestV1, 'requestId' | 'questions'>,
): CreateApplicationQuestionDraftsResponseV1 | null {
  if (!isPlainObject(value) || value.schemaVersion !== APPLICATION_QUESTION_DRAFT_SCHEMA_VERSION) return null;
  if (value.ok === false) {
    if (!hasRequiredKeys(value, ['schemaVersion', 'ok', 'code'])) return null;
    return typeof value.code === 'string' && (APPLICATION_QUESTION_DRAFT_FAILURE_CODES as readonly string[]).includes(value.code)
      ? Object.freeze({ schemaVersion: 1 as const, ok: false as const, code: value.code as ApplicationQuestionDraftFailureCode })
      : null;
  }
  if (value.ok !== true || !hasRequiredKeys(value, ['schemaVersion', 'ok', 'requestId', 'drafts'])) return null;
  if (value.requestId !== request.requestId || !Array.isArray(value.drafts)) return null;
  const limits = new Map(request.questions.map((question) => [question.questionId, question.maxLength ?? APPLICATION_QUESTION_DRAFT_LIMITS.draftText]));
  const drafts: ApplicationQuestionDraftV1[] = [];
  const seen = new Set<string>();
  for (const raw of value.drafts) {
    if (!isPlainObject(raw) || !hasRequiredKeys(raw, ['questionId', 'text'])) return null;
    if (typeof raw.questionId !== 'string' || !limits.has(raw.questionId) || seen.has(raw.questionId)) return null;
    const text = boundedText(raw.text, limits.get(raw.questionId)!);
    if (text === null) return null;
    seen.add(raw.questionId);
    drafts.push(Object.freeze({ questionId: raw.questionId, text }));
  }
  return Object.freeze({ schemaVersion: 1 as const, ok: true as const, requestId: value.requestId as string, drafts: Object.freeze(drafts) });
}
