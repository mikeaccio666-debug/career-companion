/** T9 CAP-AF-037 owner-scoped Profile-to-JD resume generation contract. */

import {
  parseIsoDateTime,
  parseSha256Digest,
  parseUuid,
  type AgentHttpSchemaVersion,
  type DecimalString,
  type IsoDateTime,
  type Sha256Digest,
  type Uuid,
} from './common.ts';

export const JOB_RESUME_GENERATION_MAX_JOB_SELECTOR_CHARS = 512 as const;
export const JOB_RESUME_GENERATION_MAX_SECTIONS = 12 as const;
export const JOB_RESUME_GENERATION_MAX_BULLETS_PER_SECTION = 5 as const;
export const JOB_RESUME_GENERATION_MAX_SKILLS = 40 as const;
export const JOB_RESUME_GENERATION_MAX_LANGUAGES = 20 as const;

export const JOB_RESUME_GENERATION_CACHE_POLICY = Object.freeze({
  responseHeaders: Object.freeze({
    'Cache-Control': 'private, no-store, no-transform',
    Pragma: 'no-cache',
    Expires: '0',
  }),
  etag: 'forbidden',
} as const);

export interface CreateJobResumeGenerationRequestV1 {
  readonly clientRequestId: Uuid;
  readonly trackId: Uuid;
  /** Opaque server-owned catalog selector. It is never a caller-provided JD body. */
  readonly jobId: string;
  readonly expectedProfileRevision: DecimalString;
  readonly expectedProfileDeletionEpoch: DecimalString;
  readonly expectedLibraryRevision: DecimalString;
  /** Optional layout source only; never a content-authority parent. */
  readonly layoutTemplateResumeVersionId: Uuid | null;
}

export interface GeneratedResumeExperienceV1 {
  readonly heading: string;
  readonly organization: string;
  readonly location: string | null;
  readonly dateRange: string | null;
  readonly bullets: readonly string[];
}

export interface GeneratedResumeProjectV1 {
  readonly heading: string;
  readonly organization: string | null;
  readonly role: string | null;
  readonly dateRange: string | null;
  readonly bullets: readonly string[];
}

export interface GeneratedResumeEducationV1 {
  readonly school: string;
  readonly credential: string | null;
  readonly location: string | null;
  readonly dateRange: string | null;
  readonly details: readonly string[];
}

export interface GeneratedResumeDocumentV1 {
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly location: string | null;
  readonly links: readonly string[];
  readonly summary: string | null;
  readonly experiences: readonly GeneratedResumeExperienceV1[];
  readonly projects: readonly GeneratedResumeProjectV1[];
  readonly educations: readonly GeneratedResumeEducationV1[];
  readonly skills: readonly string[];
  readonly languages: readonly string[];
}

export interface JobResumeGenerationResponseV1 {
  readonly schemaVersion: AgentHttpSchemaVersion;
  readonly clientRequestId: Uuid;
  readonly resumeVersion: Readonly<{
    resumeVersionId: Uuid;
    trackId: Uuid;
    versionNumber: number;
    label: string;
    fileName: string;
    lifecycleStatus: 'READY';
    origin: 'REWRITE';
    contentRevision: DecimalString;
    createdAt: IsoDateTime;
  }>;
  readonly job: Readonly<{
    canonicalJobId: Uuid;
    canonicalJobRevision: DecimalString;
    descriptionDigest: Sha256Digest;
    title: string;
    company: string;
  }>;
  readonly profile: Readonly<{
    revision: DecimalString;
    deletionEpoch: DecimalString;
  }>;
  readonly libraryRevision: DecimalString;
  readonly layoutTemplateResumeVersionId: Uuid | null;
  readonly document: GeneratedResumeDocumentV1;
  readonly grounding: Readonly<{
    status: 'VERIFIED';
    selectedEvidenceBlockCount: number;
    omittedLowerRelevanceBlockCount: number;
    unsupportedClaimCount: 0;
    softPageTarget: 1;
    estimatedPages: 1 | 2;
    keyEvidenceOmitted: boolean;
    qualityDisposition?: 'ADVISORY';
    advisories?: readonly ('COVERAGE_REFINEMENT_SUGGESTED' | 'RESUME_QUALITY_REFINEMENT_REQUIRED')[];
  }>;
  readonly renderedPdf: Readonly<{
    artifactId: Uuid;
    mimeType: 'application/pdf';
    size: number;
  }>;
}

export function parseCreateJobResumeGenerationRequestV1(
  value: unknown,
): CreateJobResumeGenerationRequestV1 | null {
  if (!exactRecord(value, [
    'clientRequestId',
    'trackId',
    'jobId',
    'expectedProfileRevision',
    'expectedProfileDeletionEpoch',
    'expectedLibraryRevision',
    'layoutTemplateResumeVersionId',
  ])) return null;
  if (
    parseUuid(value.clientRequestId) === null ||
    parseUuid(value.trackId) === null ||
    !boundedSingleLine(value.jobId, JOB_RESUME_GENERATION_MAX_JOB_SELECTOR_CHARS) ||
    !decimal(value.expectedProfileRevision) ||
    !decimal(value.expectedProfileDeletionEpoch) ||
    !decimal(value.expectedLibraryRevision) ||
    !(value.layoutTemplateResumeVersionId === null ||
      parseUuid(value.layoutTemplateResumeVersionId) !== null)
  ) return null;
  return value as unknown as CreateJobResumeGenerationRequestV1;
}

export function parseJobResumeGenerationResponseV1(
  value: unknown,
): JobResumeGenerationResponseV1 | null {
  if (!exactRecord(value, [
    'schemaVersion',
    'clientRequestId',
    'resumeVersion',
    'job',
    'profile',
    'libraryRevision',
    'layoutTemplateResumeVersionId',
    'document',
    'grounding',
    'renderedPdf',
  ])) return null;
  if (
    value.schemaVersion !== 1 ||
    parseUuid(value.clientRequestId) === null ||
    !resumeVersion(value.resumeVersion) ||
    !job(value.job) ||
    !profile(value.profile) ||
    !decimal(value.libraryRevision) ||
    !(value.layoutTemplateResumeVersionId === null ||
      parseUuid(value.layoutTemplateResumeVersionId) !== null) ||
    !document(value.document) ||
    !grounding(value.grounding) ||
    !renderedPdf(value.renderedPdf)
  ) return null;
  return value as unknown as JobResumeGenerationResponseV1;
}

function resumeVersion(value: unknown): boolean {
  return exactRecord(value, [
    'resumeVersionId',
    'trackId',
    'versionNumber',
    'label',
    'fileName',
    'lifecycleStatus',
    'origin',
    'contentRevision',
    'createdAt',
  ]) &&
    parseUuid(value.resumeVersionId) !== null &&
    parseUuid(value.trackId) !== null &&
    integer(value.versionNumber, 1, 2_147_483_647) &&
    boundedSingleLine(value.label, 160) &&
    boundedSingleLine(value.fileName, 255) &&
    value.lifecycleStatus === 'READY' &&
    value.origin === 'REWRITE' &&
    decimal(value.contentRevision) &&
    parseIsoDateTime(value.createdAt) !== null;
}

function job(value: unknown): boolean {
  return exactRecord(value, [
    'canonicalJobId',
    'canonicalJobRevision',
    'descriptionDigest',
    'title',
    'company',
  ]) &&
    parseUuid(value.canonicalJobId) !== null &&
    decimal(value.canonicalJobRevision) &&
    parseSha256Digest(value.descriptionDigest) !== null &&
    boundedSingleLine(value.title, 256) &&
    boundedSingleLine(value.company, 256);
}

function profile(value: unknown): boolean {
  return exactRecord(value, ['revision', 'deletionEpoch']) &&
    decimal(value.revision) &&
    decimal(value.deletionEpoch);
}

export function parseGeneratedResumeDocumentV1(value: unknown): GeneratedResumeDocumentV1 | null {
  return document(value) ? value as GeneratedResumeDocumentV1 : null;
}

function document(value: unknown): boolean {
  return exactRecord(value, [
    'fullName',
    'email',
    'phone',
    'location',
    'links',
    'summary',
    'experiences',
    'projects',
    'educations',
    'skills',
    'languages',
  ]) &&
    boundedSingleLine(value.fullName, 256) &&
    nullableSingleLine(value.email, 254) &&
    nullableSingleLine(value.phone, 64) &&
    nullableSingleLine(value.location, 256) &&
    stringArray(value.links, 20, 2_048) &&
    nullableText(value.summary, 2_000) &&
    Array.isArray(value.experiences) &&
    value.experiences.length <= JOB_RESUME_GENERATION_MAX_SECTIONS &&
    value.experiences.every(experience) &&
    Array.isArray(value.projects) &&
    value.projects.length <= JOB_RESUME_GENERATION_MAX_SECTIONS &&
    value.projects.every(project) &&
    Array.isArray(value.educations) &&
    value.educations.length <= JOB_RESUME_GENERATION_MAX_SECTIONS &&
    value.educations.every(education) &&
    stringArray(value.skills, JOB_RESUME_GENERATION_MAX_SKILLS, 80) &&
    stringArray(value.languages, JOB_RESUME_GENERATION_MAX_LANGUAGES, 120);
}

function experience(value: unknown): boolean {
  return exactRecord(value, [
    'heading', 'organization', 'location', 'dateRange', 'bullets',
  ]) &&
    boundedSingleLine(value.heading, 160) &&
    boundedSingleLine(value.organization, 160) &&
    nullableSingleLine(value.location, 256) &&
    nullableSingleLine(value.dateRange, 64) &&
    stringArray(value.bullets, JOB_RESUME_GENERATION_MAX_BULLETS_PER_SECTION, 1_000);
}

function project(value: unknown): boolean {
  return exactRecord(value, [
    'heading', 'organization', 'role', 'dateRange', 'bullets',
  ]) &&
    boundedSingleLine(value.heading, 160) &&
    nullableSingleLine(value.organization, 160) &&
    nullableSingleLine(value.role, 160) &&
    nullableSingleLine(value.dateRange, 64) &&
    stringArray(value.bullets, JOB_RESUME_GENERATION_MAX_BULLETS_PER_SECTION, 1_000);
}

function education(value: unknown): boolean {
  return exactRecord(value, [
    'school', 'credential', 'location', 'dateRange', 'details',
  ]) &&
    boundedSingleLine(value.school, 160) &&
    nullableSingleLine(value.credential, 256) &&
    nullableSingleLine(value.location, 256) &&
    nullableSingleLine(value.dateRange, 64) &&
    stringArray(value.details, JOB_RESUME_GENERATION_MAX_BULLETS_PER_SECTION, 1_000);
}

function grounding(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const withAdvisories = 'advisories' in value;
  return exactRecord(value, [
    'status',
    'selectedEvidenceBlockCount',
    'omittedLowerRelevanceBlockCount',
    'unsupportedClaimCount',
    'softPageTarget',
    'estimatedPages',
    'keyEvidenceOmitted',
    ...(withAdvisories ? ['qualityDisposition', 'advisories'] : []),
  ]) &&
    value.status === 'VERIFIED' &&
    integer(value.selectedEvidenceBlockCount, 1, 64) &&
    integer(value.omittedLowerRelevanceBlockCount, 0, 64) &&
    value.unsupportedClaimCount === 0 &&
    value.softPageTarget === 1 &&
    (value.estimatedPages === 1 || value.estimatedPages === 2) &&
    typeof value.keyEvidenceOmitted === 'boolean' && (!withAdvisories ||
      (value.qualityDisposition === 'ADVISORY' && Array.isArray(value.advisories) && value.advisories.length > 0 && value.advisories.length <= 2 &&
        new Set(value.advisories).size === value.advisories.length && value.advisories.every(code =>
          ['COVERAGE_REFINEMENT_SUGGESTED', 'RESUME_QUALITY_REFINEMENT_REQUIRED'].includes(code))));
}

function renderedPdf(value: unknown): boolean {
  return exactRecord(value, ['artifactId', 'mimeType', 'size']) &&
    parseUuid(value.artifactId) !== null &&
    value.mimeType === 'application/pdf' &&
    integer(value.size, 1, 20 * 1024 * 1024);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function decimal(value: unknown): value is DecimalString {
  return typeof value === 'string' &&
    value.length <= 19 &&
    /^(0|[1-9]\d*)$/.test(value) &&
    BigInt(value) <= 9_223_372_036_854_775_807n;
}

function boundedSingleLine(value: unknown, maximum: number): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    [...value].length <= maximum &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
}

function nullableSingleLine(value: unknown, maximum: number): boolean {
  return value === null || boundedSingleLine(value, maximum);
}

function nullableText(value: unknown, maximum: number): boolean {
  return value === null || (typeof value === 'string' && value.trim().length > 0 &&
    [...value].length <= maximum && ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code <= 31 && ![9, 10, 13].includes(code));
    }));
}

function stringArray(value: unknown, maximumItems: number, maximumChars: number): boolean {
  return Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => boundedSingleLine(item, maximumChars)) &&
    new Set(value).size === value.length;
}

function integer(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= minimum && value <= maximum;
}
