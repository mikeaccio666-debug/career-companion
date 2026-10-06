/** T9 candidate-only, request-lifetime batch. It is never a write or Submit release. */
import { parseUuid } from './common.ts';

export const APPLICATION_QUESTION_CONTROL_TYPES = ['TEXT', 'TEXTAREA', 'SINGLE_CHOICE', 'MULTI_CHOICE'] as const;
export const APPLICATION_QUESTION_SOURCE_TYPES = ['PROFILE', 'RESUME', 'CONFIRMED_ANSWER'] as const;
export const APPLICATION_QUESTION_DISPOSITIONS = ['REVIEW_REQUIRED', 'USER_CONFIRMATION_REQUIRED', 'DURABLE_RELEASE_REQUIRED', 'NEEDS_USER_INPUT', 'USER_ONLY'] as const;
export const APPLICATION_QUESTION_CODES = [
  'EVIDENCE_BOUND', 'EVIDENCE_MISSING', 'EVIDENCE_CONFLICT', 'USER_CONFIRMED_VALUE', 'RELEASE_REQUIRED',
  'CREDENTIAL', 'HUMAN_PRESENCE', 'FINAL_SUBMIT', 'BUNDLED_CONSENT', 'UNKNOWN_HIGH_RISK',
  'QUESTION_INPUT_INVALID', 'QUESTION_DISABLED', 'QUESTION_OWNER_UNAVAILABLE', 'QUESTION_CONTEXT_STALE',
  'QUESTION_EVIDENCE_INVALID', 'QUESTION_EVIDENCE_STALE', 'QUESTION_PROVIDER_FAILED',
  'QUESTION_OUTPUT_INVALID', 'QUESTION_TIMEOUT', 'QUESTION_CANCELLED', 'QUESTION_BUSY',
] as const;
export type ApplicationQuestionCode = typeof APPLICATION_QUESTION_CODES[number];
export type ApplicationQuestionControl = typeof APPLICATION_QUESTION_CONTROL_TYPES[number];
export type ApplicationQuestionSource = typeof APPLICATION_QUESTION_SOURCE_TYPES[number];
export type ApplicationQuestionContextV1 = Readonly<{
  extensionInstallId: string; missionId: string; missionRevision: string; canonicalJobId: string;
  applicationBundleVersion: string; applicationTargetRevision: string; pageId: string; pageGeneration: string;
}>;
export type ApplicationQuestionV1 = Readonly<{
  questionId: string; text: string; controlType: ApplicationQuestionControl; required: boolean;
  options: readonly Readonly<{ optionId: string; text: string }>[];
}>;
export type ApplicationQuestionBatchV1 = Readonly<{
  schemaVersion: 1; requestId: string; context: ApplicationQuestionContextV1; questions: readonly ApplicationQuestionV1[];
}>;
export type ApplicationQuestionProvenanceV1 = Readonly<{
  evidenceId: string; source: ApplicationQuestionSource; sourceId: string; sourceRevision: string;
}>;
export type ApplicationQuestionCandidateV1 = Readonly<{
  questionId: string; disposition: typeof APPLICATION_QUESTION_DISPOSITIONS[number]; reasonCode: ApplicationQuestionCode;
  answer: Readonly<{ kind: 'TEXT'; text: string }> | Readonly<{ kind: 'CHOICES'; optionIds: readonly string[] }> | null;
  /** Qualitative evidence strength, not a calibrated model probability. */
  confidence: 'NONE' | 'LOW' | 'HIGH'; provenance: readonly ApplicationQuestionProvenanceV1[];
}>;
export type ApplicationQuestionResultV1 = Readonly<{ schemaVersion: 1; ok: false; code: ApplicationQuestionCode }>
  | Readonly<{ schemaVersion: 1; ok: true; requestId: string; context: ApplicationQuestionContextV1;
    candidates: readonly ApplicationQuestionCandidateV1[]; persisted: false; deliveryAuthorized: false }>;

/** What one candidates request may carry. A producer keeps a page within these before asking. */
export const APPLICATION_QUESTION_BATCH_LIMITS = Object.freeze({ questions: 50, optionsPerQuestion: 40, textBytes: 64_000 });

export function parseApplicationQuestionBatchV1(value: unknown): ApplicationQuestionBatchV1 | null {
  if (!object(value, ['schemaVersion', 'requestId', 'context', 'questions']) || value.schemaVersion !== 1
    || !parseUuid(value.requestId) || !context(value.context) || !Array.isArray(value.questions)
    || value.questions.length < 1 || value.questions.length > APPLICATION_QUESTION_BATCH_LIMITS.questions) return null;
  const ids = new Set<string>(); let bytes = 0;
  for (const q of value.questions) {
    if (!object(q, ['questionId', 'text', 'controlType', 'required', 'options']) || !token(q.questionId)
      || ids.has(q.questionId) || !text(q.text, 8_000) || !member(APPLICATION_QUESTION_CONTROL_TYPES, q.controlType)
      || typeof q.required !== 'boolean' || !Array.isArray(q.options) || q.options.length > APPLICATION_QUESTION_BATCH_LIMITS.optionsPerQuestion) return null;
    if (q.controlType === 'TEXT' || q.controlType === 'TEXTAREA') { if (q.options.length !== 0) return null; }
    else if (q.options.length === 0) return null;
    ids.add(q.questionId); bytes += utf8(q.text);
    const options = new Set<string>();
    for (const o of q.options) {
      if (!object(o, ['optionId', 'text']) || !token(o.optionId) || options.has(o.optionId) || !text(o.text, 2_000)) return null;
      options.add(o.optionId); bytes += utf8(o.text);
    }
    if (bytes > APPLICATION_QUESTION_BATCH_LIMITS.textBytes) return null;
  }
  return value as ApplicationQuestionBatchV1;
}

/** Consumer verifies the same request/order/options, not a new model-defined wire. */
export function parseApplicationQuestionResultV1(value: unknown, request: ApplicationQuestionBatchV1): ApplicationQuestionResultV1 | null {
  if (!parseApplicationQuestionBatchV1(request)) return null;
  if (object(value, ['schemaVersion', 'ok', 'code']) && value.schemaVersion === 1 && value.ok === false
    && member(APPLICATION_QUESTION_CODES, value.code) && value.code.startsWith('QUESTION_')) return value as ApplicationQuestionResultV1;
  if (!object(value, ['schemaVersion', 'ok', 'requestId', 'context', 'candidates', 'persisted', 'deliveryAuthorized'])
    || value.schemaVersion !== 1 || value.ok !== true || value.requestId !== request.requestId
    || !context(value.context) || !sameQuestionContext(value.context, request.context)
    || value.persisted !== false || value.deliveryAuthorized !== false || !Array.isArray(value.candidates)
    || value.candidates.length !== request.questions.length) return null;
  let bytes = 0;
  for (let i = 0; i < request.questions.length; i++) {
    const q = request.questions[i]!; const c = value.candidates[i];
    if (!object(c, ['questionId', 'disposition', 'reasonCode', 'answer', 'confidence', 'provenance'])
      || c.questionId !== q.questionId || !member(APPLICATION_QUESTION_DISPOSITIONS, c.disposition)
      || !member(APPLICATION_QUESTION_CODES, c.reasonCode) || !['NONE', 'LOW', 'HIGH'].includes(c.confidence as string)
      || !Array.isArray(c.provenance) || c.provenance.length > 32) return null;
    if (c.disposition === 'NEEDS_USER_INPUT' || c.disposition === 'USER_ONLY') {
      if (c.answer !== null || c.confidence !== 'NONE' || c.provenance.length !== 0) return null;
      if (c.disposition === 'NEEDS_USER_INPUT' ? !['EVIDENCE_MISSING', 'EVIDENCE_CONFLICT'].includes(c.reasonCode)
        : !['CREDENTIAL', 'HUMAN_PRESENCE', 'FINAL_SUBMIT', 'BUNDLED_CONSENT', 'UNKNOWN_HIGH_RISK'].includes(c.reasonCode)) return null;
      continue;
    }
    const expectedReason = c.disposition === 'REVIEW_REQUIRED' ? 'EVIDENCE_BOUND'
      : c.disposition === 'DURABLE_RELEASE_REQUIRED' ? 'RELEASE_REQUIRED' : 'USER_CONFIRMED_VALUE';
    if (c.reasonCode !== expectedReason || c.confidence === 'NONE' || c.provenance.length === 0) return null;
    if (q.controlType === 'TEXT' || q.controlType === 'TEXTAREA') {
      if (!object(c.answer, ['kind', 'text']) || c.answer.kind !== 'TEXT' || !text(c.answer.text, 8_000)) return null;
      bytes += utf8(c.answer.text);
    } else {
      if (!object(c.answer, ['kind', 'optionIds']) || c.answer.kind !== 'CHOICES' || !Array.isArray(c.answer.optionIds)
        || c.answer.optionIds.length < 1 || (q.controlType === 'SINGLE_CHOICE' && c.answer.optionIds.length !== 1)
        || new Set(c.answer.optionIds).size !== c.answer.optionIds.length
        || c.answer.optionIds.some(id => !q.options.some(o => o.optionId === id))) return null;
    }
    const seen = new Set<string>();
    for (const p of c.provenance) {
      if (!object(p, ['evidenceId', 'source', 'sourceId', 'sourceRevision']) || !token(p.evidenceId)
        || seen.has(p.evidenceId) || !member(APPLICATION_QUESTION_SOURCE_TYPES, p.source)
        || !parseUuid(p.sourceId) || !revision(p.sourceRevision)) return null;
      seen.add(p.evidenceId);
    }
    if (bytes > 64_000) return null;
  }
  return value as ApplicationQuestionResultV1;
}
export function parseApplicationQuestionContextV1(value: unknown): ApplicationQuestionContextV1 | null { return context(value) ? value : null; }
/** Bounded, control-character-free wire text; shared with question memory. */
export const isBoundedQuestionText: (value: unknown, limit: number) => value is string = text;
export function sameQuestionContext(a: ApplicationQuestionContextV1, b: ApplicationQuestionContextV1): boolean {
  return Object.keys(b).every(k => a[k as keyof typeof a] === b[k as keyof typeof b]);
}
function context(v: unknown): v is ApplicationQuestionContextV1 {
  return object(v, ['extensionInstallId', 'missionId', 'missionRevision', 'canonicalJobId', 'applicationBundleVersion', 'applicationTargetRevision', 'pageId', 'pageGeneration'])
    && parseUuid(v.extensionInstallId) !== null && parseUuid(v.missionId) !== null && parseUuid(v.canonicalJobId) !== null
    && token(v.pageId) && ['missionRevision', 'applicationBundleVersion', 'applicationTargetRevision', 'pageGeneration'].every(k => revision(v[k]));
}
function object(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
function member<T extends readonly string[]>(values: T, v: unknown): v is T[number] { return typeof v === 'string' && values.includes(v); }
function token(v: unknown): v is string { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(v) && !['constructor', '__proto__', 'prototype'].includes(v); }
function revision(v: unknown): v is string { return typeof v === 'string' && /^[1-9][0-9]{0,18}$/u.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n; }
function utf8(v: string): number { return new TextEncoder().encode(v).length; }
function text(v: unknown, limit: number): v is string { return typeof v === 'string' && v.trim().length > 0 && utf8(v) <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v); }
