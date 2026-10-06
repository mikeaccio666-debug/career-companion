/** Owner-only ephemeral generation; never an artifact or ATS release. */
import { parseIsoDateTime, parseUuid } from './common.ts';

export const COVER_LETTER_GENERATION_CODES = [
  'COVER_LETTER_UNAVAILABLE', 'COVER_LETTER_INPUT_INVALID', 'COVER_LETTER_OWNER_UNAVAILABLE',
  'COVER_LETTER_JOB_UNAVAILABLE', 'COVER_LETTER_JOB_STALE', 'COVER_LETTER_JOB_TEXT_UNAVAILABLE',
  'COVER_LETTER_JOB_TEXT_INVALID', 'COVER_LETTER_NOT_REQUIRED', 'COVER_LETTER_USER_CHOICE_REQUIRED',
  'COVER_LETTER_GENERATION_DECLINED', 'COVER_LETTER_PROFILE_UNAVAILABLE', 'COVER_LETTER_PROFILE_INVALID',
  'COVER_LETTER_PROFILE_STALE', 'COVER_LETTER_EVIDENCE_UNAVAILABLE', 'COVER_LETTER_INPUT_TOO_LARGE',
  'COVER_LETTER_UNSAFE_SOURCE', 'COVER_LETTER_PROVIDER_FAILED', 'COVER_LETTER_OUTPUT_INVALID',
  'COVER_LETTER_ENTITY_MISMATCH', 'COVER_LETTER_UNSUPPORTED_CLAIM', 'COVER_LETTER_TIMEOUT',
  'COVER_LETTER_CANCELLED', 'COVER_LETTER_BUSY',
] as const;
export type CoverLetterGenerationCode = typeof COVER_LETTER_GENERATION_CODES[number];
export type CoverLetterRequirement = 'REQUIRED' | 'NOT_REQUIRED' | 'UNKNOWN';
export type CoverLetterProductFailureV1 = Readonly<{ schemaVersion: 1; ok: false; code: CoverLetterGenerationCode }>;
export type CoverLetterRequirementRequestV1 = Readonly<{ jobId: string }>;
export type CoverLetterRequirementContextV1 = Readonly<{
  schemaVersion: 1; jobId: string; canonicalJobId: string; canonicalJobRevision: string;
  requirement: CoverLetterRequirement; requirementRevision: string;
}>;
export type CoverLetterRequirementResultV1 = CoverLetterProductFailureV1
  | Readonly<{ schemaVersion: 1; ok: true; context: CoverLetterRequirementContextV1 }>;
export type CoverLetterProductRequestV1 = Readonly<{
  clientRequestId: string; jobId: string; canonicalJobId: string; canonicalJobRevision: string;
  requirementRevision: string; unknownRequirementChoice: 'GENERATE' | 'SKIP' | null;
}>;
export type CoverLetterProductCandidateV1 = Readonly<{
  schemaVersion: 1; clientRequestId: string; jobId: string; canonicalJobId: string;
  canonicalJobRevision: string; requirementRevision: string; body: string;
  mimeType: 'text/plain'; generatedAt: string; persisted: false; artifactId: null; deliveryAuthorized: false;
}>;
export type CoverLetterProductResultV1 = CoverLetterProductFailureV1
  | Readonly<{ schemaVersion: 1; ok: true; candidate: CoverLetterProductCandidateV1 }>;

export function parseCoverLetterRequirementRequestV1(value: unknown): CoverLetterRequirementRequestV1 | null {
  return record(value, ['jobId']) && selector(value.jobId) ? value as CoverLetterRequirementRequestV1 : null;
}
export function parseCoverLetterProductRequestV1(value: unknown): CoverLetterProductRequestV1 | null {
  return record(value, ['clientRequestId', 'jobId', 'canonicalJobId', 'canonicalJobRevision',
    'requirementRevision', 'unknownRequirementChoice']) && parseUuid(value.clientRequestId) && selector(value.jobId)
    && parseUuid(value.canonicalJobId) && revision(value.canonicalJobRevision) && revision(value.requirementRevision)
    && (value.unknownRequirementChoice === null || value.unknownRequirementChoice === 'GENERATE' || value.unknownRequirementChoice === 'SKIP')
    ? value as CoverLetterProductRequestV1 : null;
}
export function parseCoverLetterRequirementResultV1(value: unknown): CoverLetterRequirementResultV1 | null {
  if (failure(value)) return value;
  if (!record(value, ['schemaVersion', 'ok', 'context']) || value.schemaVersion !== 1 || value.ok !== true) return null;
  const c = value.context;
  return record(c, ['schemaVersion', 'jobId', 'canonicalJobId', 'canonicalJobRevision', 'requirement', 'requirementRevision'])
    && c.schemaVersion === 1 && selector(c.jobId) && parseUuid(c.canonicalJobId) && revision(c.canonicalJobRevision)
    && revision(c.requirementRevision) && ['REQUIRED', 'NOT_REQUIRED', 'UNKNOWN'].includes(c.requirement as string)
    ? value as CoverLetterRequirementResultV1 : null;
}
export function parseCoverLetterProductResultV1(value: unknown): CoverLetterProductResultV1 | null {
  if (failure(value)) return value;
  if (!record(value, ['schemaVersion', 'ok', 'candidate']) || value.schemaVersion !== 1 || value.ok !== true) return null;
  const c = value.candidate;
  return record(c, ['schemaVersion', 'clientRequestId', 'jobId', 'canonicalJobId', 'canonicalJobRevision',
    'requirementRevision', 'body', 'mimeType', 'generatedAt', 'persisted', 'artifactId', 'deliveryAuthorized'])
    && c.schemaVersion === 1 && parseUuid(c.clientRequestId) && selector(c.jobId) && parseUuid(c.canonicalJobId)
    && revision(c.canonicalJobRevision) && revision(c.requirementRevision) && typeof c.body === 'string'
    && c.body.trim().length > 0 && new TextEncoder().encode(c.body).length <= 12_000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(c.body)
    && c.mimeType === 'text/plain' && parseIsoDateTime(c.generatedAt) !== null
    && c.persisted === false && c.artifactId === null && c.deliveryAuthorized === false
    ? value as CoverLetterProductResultV1 : null;
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function selector(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/u.test(value);
}
function revision(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/u.test(value)
    && BigInt(value) <= 9_223_372_036_854_775_807n;
}
function failure(value: unknown): value is CoverLetterProductFailureV1 {
  return record(value, ['schemaVersion', 'ok', 'code']) && value.schemaVersion === 1 && value.ok === false
    && COVER_LETTER_GENERATION_CODES.includes(value.code as CoverLetterGenerationCode);
}
