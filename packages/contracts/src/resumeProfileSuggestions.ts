/** One-shot, owner-only Resume-to-Profile suggestion wire from §5.13.4. */

import { parseSha256Digest, type Sha256Digest } from './common.ts';
import { PROFILE_V2_COLLECTION_LIMITS } from './profileV2.ts';
import { parseResumeProfileStructuredFactsV1, type ResumeProfileStructuredFactsV1 } from './resumeStructuredFacts.ts';

export const RESUME_PROFILE_SUGGESTION_SCHEMA_VERSION = 1 as const;
export const RESUME_PROFILE_SUGGESTION_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export const RESUME_PROFILE_SUGGESTION_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export type ResumeProfileSuggestionMimeType =
  (typeof RESUME_PROFILE_SUGGESTION_MIME_TYPES)[number];

export const RESUME_PROFILE_SUGGESTION_REASONS = [
  'NO_EXTRACTABLE_TEXT',
  'LAYOUT_NOT_READABLE',
  'NO_DETERMINISTIC_FACTS',
  'DOCUMENT_PARSE_FAILED',
] as const;
export type ResumeProfileSuggestionReason =
  (typeof RESUME_PROFILE_SUGGESTION_REASONS)[number];

export const RESUME_PROFILE_SUGGESTION_WARNING_CODES = [
  'RESUME_PDF_LINK_ANNOTATIONS_UNAVAILABLE',
  'RESUME_DOCX_CONVERSION_WARNING',
  'RESUME_TEXT_TRUNCATED',
] as const;
export type ResumeProfileSuggestionWarningCode =
  (typeof RESUME_PROFILE_SUGGESTION_WARNING_CODES)[number];

export const RESUME_PROFILE_SUGGESTION_LINK_KINDS = [
  'email',
  'phone',
  'linkedin',
  'github',
  'vibeid',
  'website',
  'other',
] as const;
export type ResumeProfileSuggestionLinkKind =
  (typeof RESUME_PROFILE_SUGGESTION_LINK_KINDS)[number];

export const RESUME_PROFILE_MODEL_DATA_USE_V1 = 'OPENAI_PROFILE_IMPORT_V1' as const;
export type ResumeProfileModelDataUseV1 = typeof RESUME_PROFILE_MODEL_DATA_USE_V1;

/** Logical multipart request. Bytes travel only in the `file` part and are not persisted. */
export interface ResumeProfileSuggestionUploadRequestV1 {
  readonly consent: true;
  /** Explicit permission for this upload only; absent means deterministic parsing only. */
  readonly modelDataUse?: ResumeProfileModelDataUseV1;
  readonly file: {
    readonly mimeType: ResumeProfileSuggestionMimeType;
    readonly byteLength: number;
  };
}

export interface ResumeSuggestionDateValueV1 {
  readonly raw: string;
  readonly iso: string | null;
}

export interface ResumeSuggestionFieldV1<Value> {
  readonly value: Value;
  readonly confidence: number;
}

export interface ResumeProfileContactSuggestionV1 {
  readonly value: string;
  readonly source: 'RESUME_LINK';
  readonly confidence: number;
  readonly parserVersion: 'resume-profile-suggestions@v1';
}

export type ResumeProfileContactSuggestionsV1 = Readonly<{
  fullName: ResumeProfileContactSuggestionV1 | null;
  preferredName: ResumeProfileContactSuggestionV1 | null;
  email: ResumeProfileContactSuggestionV1 | null;
  phone: ResumeProfileContactSuggestionV1 | null;
  location: ResumeProfileContactSuggestionV1 | null;
  city: ResumeProfileContactSuggestionV1 | null;
}>;

export interface ResumeProfileLinkSuggestionV1 {
  readonly kind: ResumeProfileSuggestionLinkKind;
  readonly href: string;
  readonly label: string;
  readonly source: 'RESUME_LINK';
  readonly confidence: number;
  readonly parserVersion: 'resume-profile-suggestions@v1';
}

export interface ResumeProfileExperienceSuggestionV1 {
  /** Ephemeral suggestion key; never a Profile collection item id. */
  readonly id: string;
  readonly source: 'RESUME_TEXT';
  readonly confidence: number;
  readonly fields: {
    readonly company: ResumeSuggestionFieldV1<string> | null;
    /** Optional for existing V1 producers. Verbatim candidate, never a confirmed achievement. */
    readonly description?: ResumeSuggestionFieldV1<string> | null;
    readonly title: ResumeSuggestionFieldV1<string> | null;
    readonly startDate: ResumeSuggestionFieldV1<ResumeSuggestionDateValueV1> | null;
    readonly endDate: ResumeSuggestionFieldV1<ResumeSuggestionDateValueV1> | null;
    readonly isCurrent: ResumeSuggestionFieldV1<boolean> | null;
  };
}

export interface ResumeProfileEducationSuggestionV1 {
  /** Ephemeral suggestion key; never a Profile collection item id. */
  readonly id: string;
  readonly source: 'RESUME_TEXT';
  readonly confidence: number;
  readonly fields: {
    readonly school: ResumeSuggestionFieldV1<string> | null;
    readonly degree: ResumeSuggestionFieldV1<string> | null;
    readonly startDate: ResumeSuggestionFieldV1<ResumeSuggestionDateValueV1> | null;
    readonly endDate: ResumeSuggestionFieldV1<ResumeSuggestionDateValueV1> | null;
  };
}

/** Optional deterministic project candidates; absent in earlier V1 responses. */
export interface ResumeProfileProjectSuggestionV1 {
  readonly id: string;
  readonly source: 'RESUME_TEXT';
  readonly confidence: number;
  readonly fields: {
    readonly title: ResumeSuggestionFieldV1<string> | null;
    readonly organization: ResumeSuggestionFieldV1<string> | null;
    readonly startDate: ResumeSuggestionFieldV1<ResumeSuggestionDateValueV1> | null;
    readonly endDate: ResumeSuggestionFieldV1<ResumeSuggestionDateValueV1> | null;
    readonly isCurrent: ResumeSuggestionFieldV1<boolean> | null;
    readonly description: ResumeSuggestionFieldV1<string> | null;
  };
}

export interface ResumeProfileSkillSuggestionV1 {
  readonly value: string;
  readonly confidence: number;
}

/** Additive text candidates; existing RESUME_LINK contact semantics stay unchanged. */
export type ResumeProfileTextFieldV1 = 'heading' | 'fullName' | 'firstName' | 'middleName' | 'lastName'
  | 'preferredName' | 'city' | 'region' | 'location' | 'summary';
export interface ResumeProfileTextSuggestionV1 {
  readonly value: string;
  readonly source: 'RESUME_TEXT';
  readonly confidence: number;
}
export type ResumeProfileTextSuggestionsV1 = Readonly<Partial<Record<ResumeProfileTextFieldV1, ResumeProfileTextSuggestionV1>>>;

/** Value-free, request-local observations, never telemetry or raw document content. */
export interface ResumeProfileExtractionDiagnosticsV1 {
  readonly experiences: { readonly sectionFound: boolean; readonly datedLines: number };
  readonly educations: { readonly sectionFound: boolean; readonly datedLines: number };
}

export interface ResumeProfileSuggestionSetV1 {
  readonly schemaVersion: 1;
  readonly status: 'PARSED' | 'NOT_EXTRACTABLE';
  /** Digest of the suggestion payload, not of the uploaded source bytes or full Resume text. */
  readonly suggestionSetDigest: Sha256Digest | null;
  readonly extractor: {
    readonly name: 'resume-profile-suggestions';
    readonly version: 'v1';
  };
  readonly reason: {
    readonly code: ResumeProfileSuggestionReason;
    readonly retryable: boolean;
  } | null;
  readonly warnings: readonly ResumeProfileSuggestionWarningCode[];
  readonly diagnostics?: ResumeProfileExtractionDiagnosticsV1;
  readonly truncated: {
    readonly experiences: boolean;
    readonly educations: boolean;
    readonly skills: boolean;
    readonly links: boolean;
    readonly projects?: boolean;
  };
  readonly suggestions: {
    readonly contacts: ResumeProfileContactSuggestionsV1;
    readonly links: readonly ResumeProfileLinkSuggestionV1[];
    readonly experiences: readonly ResumeProfileExperienceSuggestionV1[];
    readonly educations: readonly ResumeProfileEducationSuggestionV1[];
    readonly skills: readonly ResumeProfileSkillSuggestionV1[];
    readonly projects?: readonly ResumeProfileProjectSuggestionV1[];
    /** Optional for backward compatibility. heading is not an inferred identity field. */
    readonly text?: ResumeProfileTextSuggestionsV1;
    /** Optional verified raw facts; normalized categories and dates remain subject to user review. */
    readonly structured?: ResumeProfileStructuredFactsV1;
  };
}

/** Shared runtime decoder for both existing V1 and its optional text/diagnostic additions. */
export function parseResumeProfileSuggestionSetV1(value: unknown): ResumeProfileSuggestionSetV1 | null {
  if (!object(value) || value.schemaVersion !== 1 || (value.status !== 'PARSED' && value.status !== 'NOT_EXTRACTABLE')
    || !object(value.extractor) || value.extractor.name !== 'resume-profile-suggestions' || value.extractor.version !== 'v1'
    || !Array.isArray(value.warnings) || value.warnings.length > RESUME_PROFILE_SUGGESTION_WARNING_CODES.length
    || !value.warnings.every((item) => RESUME_PROFILE_SUGGESTION_WARNING_CODES.includes(item))) return null;
  if (value.status === 'PARSED' ? !parseSha256Digest(value.suggestionSetDigest) || value.reason !== null
    : value.suggestionSetDigest !== null || !object(value.reason)
      || !RESUME_PROFILE_SUGGESTION_REASONS.includes(value.reason.code as ResumeProfileSuggestionReason)
      || typeof value.reason.retryable !== 'boolean') return null;
  const truncated = value.truncated;
  if (!object(truncated) || !['experiences', 'educations', 'skills', 'links']
    .every((key) => typeof truncated[key] === 'boolean')) return null;
  if (truncated.projects !== undefined && typeof truncated.projects !== 'boolean') return null;
  const suggestions = value.suggestions;
  if (!object(suggestions) || !object(suggestions.contacts)) return null;
  const contacts = suggestions.contacts;
  if (!['fullName', 'preferredName', 'email', 'phone', 'location', 'city'].every((key) => {
    const item = contacts[key];
    return item === null || (stringField(item, 512) && item.source === 'RESUME_LINK'
      && item.parserVersion === 'resume-profile-suggestions@v1');
  })) return null;
  if (!boundedArray(suggestions.links, PROFILE_V2_COLLECTION_LIMITS.links, (item) => object(item)
    && RESUME_PROFILE_SUGGESTION_LINK_KINDS.includes(item.kind as ResumeProfileSuggestionLinkKind)
    && text(item.href, 2048) && typeof item.label === 'string' && item.label.length <= 512
    && item.source === 'RESUME_LINK' && item.parserVersion === 'resume-profile-suggestions@v1'
    && confidence(item.confidence) && safeLink(item.href))) return null;
  if (!boundedArray(suggestions.skills, PROFILE_V2_COLLECTION_LIMITS.skills, (item) => stringField(item, 40))) return null;
  const entries = (items: unknown, cap: number, fields: Record<string, (value: unknown) => boolean>) =>
    boundedArray(items, cap, (item) => {
      if (!object(item) || !text(item.id, 80) || item.source !== 'RESUME_TEXT' || !confidence(item.confidence) || !object(item.fields)) return false;
      const candidateFields = item.fields;
      return Object.entries(fields).every(([key, check]) => {
        const field = candidateFields[key];
        return field === null || (object(field) && confidence(field.confidence) && check(field.value));
      });
    });
  if (!entries(suggestions.experiences, PROFILE_V2_COLLECTION_LIMITS.experiences, {
    company: (item) => text(item, 160), title: (item) => text(item, 160),
    startDate: dateValue, endDate: dateValue, isCurrent: (item) => typeof item === 'boolean',
  }) || !entries(suggestions.educations, PROFILE_V2_COLLECTION_LIMITS.educations, {
    school: (item) => text(item, 160), degree: (item) => text(item, 120), startDate: dateValue, endDate: dateValue,
  })) return null;
  if ((suggestions.experiences as { fields: Record<string, unknown> }[]).some((entry) => {
    const description = entry.fields.description;
    return description !== undefined && description !== null && !stringField(description, 2000);
  })) return null;
  if (suggestions.projects !== undefined && (!entries(suggestions.projects, PROFILE_V2_COLLECTION_LIMITS.projects, {
    title: (item) => text(item, 160), organization: (item) => text(item, 160),
    startDate: dateValue, endDate: dateValue, isCurrent: (item) => typeof item === 'boolean',
    description: (item) => text(item, 2000),
  }) || new Set((suggestions.projects as { id: string }[]).map(item => item.id)).size !== (suggestions.projects as unknown[]).length)) return null;
  if (suggestions.text !== undefined) {
    const allowed = ['heading', 'fullName', 'firstName', 'middleName', 'lastName', 'preferredName', 'city', 'region', 'location', 'summary'];
    if (!object(suggestions.text) || !Object.entries(suggestions.text).every(([key, item]) => allowed.includes(key)
      && stringField(item, key === 'summary' ? 4000 : 256) && item.source === 'RESUME_TEXT')) return null;
  }
  if (suggestions.structured !== undefined && !parseResumeProfileStructuredFactsV1(suggestions.structured)) return null;
  if (value.diagnostics !== undefined) {
    const diagnostics = value.diagnostics;
    if (!object(diagnostics) || Object.keys(diagnostics).length !== 2 || !['experiences', 'educations'].every((key) => {
      const item = diagnostics[key];
      return object(item) && Object.keys(item).length === 2 && typeof item.sectionFound === 'boolean'
        && Number.isInteger(item.datedLines) && Number(item.datedLines) >= 0 && Number(item.datedLines) <= 100_000;
    })) return null;
  }
  return value as unknown as ResumeProfileSuggestionSetV1;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function confidence(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function stringField(value: unknown, max: number): value is Record<string, unknown> { return object(value) && text(value.value, max) && confidence(value.confidence); }
function boundedArray(value: unknown, max: number, check: (item: unknown) => boolean): boolean { return Array.isArray(value) && value.length <= max && value.every(check); }
function dateValue(value: unknown): boolean {
  return object(value) && text(value.raw, 96) && (value.iso === null
    || typeof value.iso === 'string' && /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/u.test(value.iso));
}
function safeLink(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
