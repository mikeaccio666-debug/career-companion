/**
 * Question memory: answers the user explicitly chose to keep (PRODUCT-AUTHORITY §3
 * "Question memory"). Scope keys are derived server-side from the request context, so a
 * caller can never file an answer under another job or application.
 */
import { parseUuid, type DecimalString, type Uuid } from './common.ts';
import {
  APPLICATION_QUESTION_CONTROL_TYPES,
  isBoundedQuestionText,
  parseApplicationQuestionContextV1,
  type ApplicationQuestionContextV1,
  type ApplicationQuestionControl,
} from './applicationQuestionCandidates.ts';

export const APPLICATION_QUESTION_ANSWER_CLASSES = ['PROFILE_STABLE', 'USER_POLICY', 'JOB_SPECIFIC', 'APPLICATION_INSTANCE'] as const;
/** v1 resolves these from the request context; COMPANY, REGION and ROLE follow once a company identity is on the wire. */
export const APPLICATION_QUESTION_MEMORY_SCOPES = ['USER', 'JOB', 'APPLICATION'] as const;
export type ApplicationQuestionAnswerClass = typeof APPLICATION_QUESTION_ANSWER_CLASSES[number];
export type ApplicationQuestionMemoryScope = typeof APPLICATION_QUESTION_MEMORY_SCOPES[number];

export type ApplicationQuestionAnswerValueV1 =
  | Readonly<{ kind: 'TEXT'; text: string }>
  | Readonly<{ kind: 'CHOICES'; optionTexts: readonly string[] }>;

export type ApplicationQuestionIdentityV1 = Readonly<{
  text: string; controlType: ApplicationQuestionControl; optionTexts: readonly string[];
}>;

export type ApplicationQuestionSettingsV1 = Readonly<{
  schemaVersion: 1; enabled: boolean; disclosureVersion: string | null; autoReuse: boolean; revision: DecimalString;
}>;
export type ApplicationQuestionSettingsUpdateV1 = Readonly<{
  schemaVersion: 1; enabled: boolean; disclosureVersion: string; autoReuse: boolean;
}>;

export type ApplicationQuestionMemoryRecordV1 = Readonly<{
  id: Uuid; question: ApplicationQuestionIdentityV1; answer: ApplicationQuestionAnswerValueV1;
  scope: ApplicationQuestionMemoryScope; answerClass: ApplicationQuestionAnswerClass; canonicalJobId: Uuid | null;
  revision: DecimalString; createdAt: string; updatedAt: string;
}>;
export type ApplicationQuestionMemoryListV1 = Readonly<{ schemaVersion: 1; records: readonly ApplicationQuestionMemoryRecordV1[] }>;

export type RememberApplicationQuestionAnswerV1 = Readonly<{
  schemaVersion: 1; context: ApplicationQuestionContextV1; question: ApplicationQuestionIdentityV1;
  answer: ApplicationQuestionAnswerValueV1; scope: ApplicationQuestionMemoryScope; answerClass: ApplicationQuestionAnswerClass;
}>;

/**
 * 题目**身份**的规范化原像：题干去掉必填/选填标记后归一，控件类型，选项文本归一后排序。
 *
 * 记忆落库时的 digest 与扩展侧签发前算的 claim key 摘要都取自这里，两侧才不会各算一套。
 * 这里只做归一，不做散列——`@edaix/contracts` 不带 crypto 依赖，散列由各宿主自己做。
 */
export function applicationQuestionIdentityPreimage(question: ApplicationQuestionIdentityV1): string {
  const clean = (value: string) => value.normalize('NFKC').toLowerCase()
    .replace(/[*＊]|\((?:required|optional)\)|[（(]?(?:必填|选填)[)）]?/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return JSON.stringify([clean(question.text), question.controlType, [...question.optionTexts].map(clean).sort()]);
}

const TEXT_LIMIT = 8_000;

export function parseApplicationQuestionSettingsUpdateV1(value: unknown): ApplicationQuestionSettingsUpdateV1 | null {
  return object(value, ['schemaVersion', 'enabled', 'disclosureVersion', 'autoReuse']) && value.schemaVersion === 1
    && typeof value.enabled === 'boolean' && typeof value.autoReuse === 'boolean' && isBoundedQuestionText(value.disclosureVersion, 64)
    ? value as ApplicationQuestionSettingsUpdateV1 : null;
}

export function parseRememberApplicationQuestionAnswerV1(value: unknown): RememberApplicationQuestionAnswerV1 | null {
  if (!object(value, ['schemaVersion', 'context', 'question', 'answer', 'scope', 'answerClass']) || value.schemaVersion !== 1
    || !parseApplicationQuestionContextV1(value.context) || !identity(value.question)
    || !member(APPLICATION_QUESTION_MEMORY_SCOPES, value.scope) || !member(APPLICATION_QUESTION_ANSWER_CLASSES, value.answerClass)) return null;
  const { question, answer } = value as { question: ApplicationQuestionIdentityV1; answer: unknown };
  const choice = question.controlType === 'SINGLE_CHOICE' || question.controlType === 'MULTI_CHOICE';
  if (!choice) {
    return object(answer, ['kind', 'text']) && answer.kind === 'TEXT' && isBoundedQuestionText(answer.text, TEXT_LIMIT)
      ? value as RememberApplicationQuestionAnswerV1 : null;
  }
  if (!object(answer, ['kind', 'optionTexts']) || answer.kind !== 'CHOICES' || !Array.isArray(answer.optionTexts) || answer.optionTexts.length < 1
    || (question.controlType === 'SINGLE_CHOICE' && answer.optionTexts.length !== 1)
    || new Set(answer.optionTexts).size !== answer.optionTexts.length
    || answer.optionTexts.some((chosen) => !question.optionTexts.includes(chosen as string))) return null;
  return value as RememberApplicationQuestionAnswerV1;
}

function identity(v: unknown): v is ApplicationQuestionIdentityV1 {
  if (!object(v, ['text', 'controlType', 'optionTexts']) || !isBoundedQuestionText(v.text, TEXT_LIMIT)
    || !member(APPLICATION_QUESTION_CONTROL_TYPES, v.controlType) || !Array.isArray(v.optionTexts) || v.optionTexts.length > 40
    || !v.optionTexts.every((o) => isBoundedQuestionText(o, 2_000))) return false;
  const choice = v.controlType === 'SINGLE_CHOICE' || v.controlType === 'MULTI_CHOICE';
  return choice ? v.optionTexts.length > 0 && new Set(v.optionTexts).size === v.optionTexts.length : v.optionTexts.length === 0;
}
function object(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}
function member<T extends readonly string[]>(values: T, v: unknown): v is T[number] { return typeof v === 'string' && values.includes(v); }
export const parseApplicationQuestionMemoryRecordId = parseUuid;

export type ForgetApplicationQuestionAnswerParams = Readonly<{ answerId: string }>;
