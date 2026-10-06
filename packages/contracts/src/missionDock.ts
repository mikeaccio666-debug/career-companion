/**
 * 镜像（2026-09-24）：本文件是 argoland `src/career-team/contracts/missionDock.ts` 的拷贝，
 * 只改了相对导入的后缀（本仓用 `.ts`）。权威在 argoland（RULE-EXT-CONTRACT-CONSUMER），
 * 本仓不单方面改形状。
 */
/**
 * Dock Mission wiring (2026-09-24, additive).
 *
 * The ArgoLand.AI extension fills a Start-applying Mission's application page from its
 * own dock. This file is the wire for the three things that makes possible:
 *
 * 1. **Page → Mission binding.** The extension asks which of the owner's Missions the
 *    page it stands on belongs to. The page is matched against the Mission's verified
 *    application target; nothing on the page can nominate a Mission.
 * 2. **Start approval.** Start applying is the user's approval to fill those jobs. Right
 *    before each dock run the extension asks the server to record that approval for the
 *    exact canonical field keys it just scanned; the ordinary execution-intent issue,
 *    claim and receipt then run unchanged. It never authorizes submission.
 * 3. **Mission materials.** The tailored resume and, when the form requires one, the
 *    cover letter reach the extension through this Mission-scoped entry only. Releases
 *    go to the Mission's verified application target and are audited server-side.
 *
 * Everything here is value-free except the two release bodies (the resume PDF and the
 * cover-letter text/PDF), which exist only for the form they are released to.
 */

import {
  parseIsoDateTime,
  parseUuid,
  type AgentSchemaEnvelope,
  type DecimalString,
  type IsoDateTime,
  type Uuid,
} from './common.ts';
import {
  APPLICATION_SUBMISSION_STATES,
  ATS_PROVIDER_CODES,
  CANONICAL_JOB_STATUSES,
  MISSION_STATUSES,
  type AtsProviderCode,
  type CanonicalApplicationBinding,
  type MissionStatus,
} from './missions.ts';
import { APPLICATION_PROFILE_FIELD_KEYS, type ApplicationProfileFieldKey } from './executionIntent.ts';
import { COVER_LETTER_GENERATION_CODES, type CoverLetterGenerationCode } from './coverLetterProduct.ts';

/** A browser page reference: exact HTTPS origin plus canonical pathname, no query. */
export interface MissionPageReferenceV1 {
  readonly canonicalOrigin: string;
  readonly pathname: string;
}

// ── 1. Page → Mission binding ─────────────────────────────────────────────────────

/**
 * Whether Start applying authorizes dock runs for the bound Mission right now.
 *
 * `NOT_START_APPLYING`: the Mission was not created by Start applying; the dock fills it
 * like any other page and asks for no Start approval. `UNAVAILABLE`: it was, but the live
 * Mission policy (consent, membership, kill switch) does not admit a run at this moment.
 */
export const MISSION_PAGE_BINDING_START_STATES = [
  'AVAILABLE',
  'UNAVAILABLE',
  'NOT_START_APPLYING',
] as const;
export type MissionPageBindingStartState = (typeof MISSION_PAGE_BINDING_START_STATES)[number];

export interface ResolveMissionPageBindingRequestV1 extends MissionPageReferenceV1 {
  readonly schemaVersion: 1;
}

export interface MissionPageBindingV1 {
  readonly missionId: Uuid;
  readonly missionRevision: DecimalString;
  readonly status: MissionStatus;
  /** Display only, from the recommendation the user started; null for other Missions. */
  readonly job: { readonly title: string; readonly company: string } | null;
  /** The verified application page the binding matched. */
  readonly target: MissionPageReferenceV1 & { readonly atsProvider: AtsProviderCode };
  readonly application: CanonicalApplicationBinding;
  readonly startApproval: MissionPageBindingStartState;
}

export interface ResolveMissionPageBindingResponseV1 extends AgentSchemaEnvelope {
  readonly binding: MissionPageBindingV1 | null;
}

export function parseMissionPageReferenceV1(value: unknown): MissionPageReferenceV1 | null {
  if (!hasExactRecordKeys(value, ['canonicalOrigin', 'pathname'])) return null;
  const canonicalOrigin = parseCanonicalHttpsOrigin(value.canonicalOrigin);
  const pathname = parseCanonicalPathname(value.pathname, canonicalOrigin);
  return canonicalOrigin === null || pathname === null
    ? null
    : Object.freeze({ canonicalOrigin, pathname });
}

export function parseResolveMissionPageBindingRequestV1(
  value: unknown,
): ResolveMissionPageBindingRequestV1 | null {
  if (!hasExactRecordKeys(value, ['schemaVersion', 'canonicalOrigin', 'pathname'])) return null;
  if (value.schemaVersion !== 1) return null;
  const page = parseMissionPageReferenceV1({
    canonicalOrigin: value.canonicalOrigin,
    pathname: value.pathname,
  });
  return page === null ? null : Object.freeze({ schemaVersion: 1, ...page });
}

export function parseResolveMissionPageBindingResponseV1(
  value: unknown,
): ResolveMissionPageBindingResponseV1 | null {
  if (!hasExactRecordKeys(value, ['schemaVersion', 'binding']) || value.schemaVersion !== 1) {
    return null;
  }
  if (value.binding === null) return Object.freeze({ schemaVersion: 1, binding: null });
  const binding = value.binding;
  if (
    !hasExactRecordKeys(binding, [
      'missionId',
      'missionRevision',
      'status',
      'job',
      'target',
      'application',
      'startApproval',
    ])
  ) {
    return null;
  }
  const missionId = parseUuid(binding.missionId);
  const job = parseJobDisplay(binding.job);
  const target = parseBindingTarget(binding.target);
  const application = parseCanonicalApplicationBinding(binding.application);
  if (
    missionId === null ||
    !isPositiveDecimalString(binding.missionRevision) ||
    !isMember(binding.status, MISSION_STATUSES) ||
    job === undefined ||
    target === null ||
    application === null ||
    !isMember(binding.startApproval, MISSION_PAGE_BINDING_START_STATES)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    binding: Object.freeze({
      missionId,
      missionRevision: binding.missionRevision,
      status: binding.status,
      job,
      target,
      application,
      startApproval: binding.startApproval,
    }),
  });
}

// ── 2. Start approval ─────────────────────────────────────────────────────────────

export const MISSION_START_APPROVAL_SOURCE = 'START_APPLYING' as const;

/**
 * POST /missions/:missionId/start-approvals. Official extension origin only.
 *
 * `fieldKeys` are the canonical profile keys the dock found on `page` just now; the
 * server approves exactly those it may (runtime policy), so the unchanged claim's
 * field-set equality holds. `page` must be the Mission's verified application target.
 */
export interface EnsureMissionStartApprovalRequestV1 {
  readonly schemaVersion: 1;
  readonly clientRequestId: Uuid;
  readonly expectedMissionRevision: DecimalString;
  readonly extensionInstallId: Uuid;
  readonly page: MissionPageReferenceV1;
  readonly fieldKeys: readonly ApplicationProfileFieldKey[];
}

export interface MissionStartApprovalV1 {
  /** The AWAIT_APPROVAL step to name in the execution-intent issue request. */
  readonly stepId: Uuid;
  readonly source: typeof MISSION_START_APPROVAL_SOURCE;
  readonly fieldKeys: readonly ApplicationProfileFieldKey[];
  readonly allowedActions: readonly ['FILL'];
  readonly expiresAt: IsoDateTime;
}

export interface EnsureMissionStartApprovalResponseV1 extends AgentSchemaEnvelope {
  readonly mission: {
    readonly id: Uuid;
    readonly revision: DecimalString;
    readonly status: 'READY_TO_EXECUTE';
  };
  readonly approval: MissionStartApprovalV1;
}

export function parseEnsureMissionStartApprovalRequestV1(
  value: unknown,
): EnsureMissionStartApprovalRequestV1 | null {
  if (
    !hasExactRecordKeys(value, [
      'schemaVersion',
      'clientRequestId',
      'expectedMissionRevision',
      'extensionInstallId',
      'page',
      'fieldKeys',
    ]) ||
    value.schemaVersion !== 1
  ) {
    return null;
  }
  const clientRequestId = parseUuid(value.clientRequestId);
  const extensionInstallId = parseUuid(value.extensionInstallId);
  const page = parseMissionPageReferenceV1(value.page);
  const fieldKeys = parseSortedFieldKeys(value.fieldKeys);
  if (
    clientRequestId === null ||
    extensionInstallId === null ||
    !isPositiveDecimalString(value.expectedMissionRevision) ||
    page === null ||
    fieldKeys === null ||
    fieldKeys.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    clientRequestId,
    expectedMissionRevision: value.expectedMissionRevision,
    extensionInstallId,
    page,
    fieldKeys,
  });
}

export function parseEnsureMissionStartApprovalResponseV1(
  value: unknown,
): EnsureMissionStartApprovalResponseV1 | null {
  if (
    !hasExactRecordKeys(value, ['schemaVersion', 'mission', 'approval']) ||
    value.schemaVersion !== 1 ||
    !hasExactRecordKeys(value.mission, ['id', 'revision', 'status']) ||
    !hasExactRecordKeys(value.approval, [
      'stepId',
      'source',
      'fieldKeys',
      'allowedActions',
      'expiresAt',
    ])
  ) {
    return null;
  }
  const mission = value.mission;
  const approval = value.approval;
  const missionId = parseUuid(mission.id);
  const stepId = parseUuid(approval.stepId);
  const fieldKeys = parseSortedFieldKeys(approval.fieldKeys);
  const expiresAt = parseIsoDateTime(approval.expiresAt);
  if (
    missionId === null ||
    !isPositiveDecimalString(mission.revision) ||
    mission.status !== 'READY_TO_EXECUTE' ||
    stepId === null ||
    approval.source !== MISSION_START_APPROVAL_SOURCE ||
    fieldKeys === null ||
    fieldKeys.length === 0 ||
    !Array.isArray(approval.allowedActions) ||
    approval.allowedActions.length !== 1 ||
    approval.allowedActions[0] !== 'FILL' ||
    expiresAt === null
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    mission: Object.freeze({ id: missionId, revision: mission.revision, status: 'READY_TO_EXECUTE' }),
    approval: Object.freeze({
      stepId,
      source: MISSION_START_APPROVAL_SOURCE,
      fieldKeys,
      allowedActions: Object.freeze(['FILL'] as const),
      expiresAt,
    }),
  });
}

// ── 3. Mission materials ──────────────────────────────────────────────────────────

export const MISSION_RESUME_MATERIAL_UNAVAILABLE_CODES = [
  'RESUME_PROCESSING',
  'VERSION_NOT_READY',
  'RESUME_VERSION_STALE',
] as const;
export type MissionResumeMaterialUnavailableCode =
  (typeof MISSION_RESUME_MATERIAL_UNAVAILABLE_CODES)[number];

/** The tailored resume the Mission's application bundle binds. No bytes here. */
export type MissionResumeMaterialV1 =
  | Readonly<{
      state: 'READY';
      resumeVersionId: Uuid;
      artifactId: Uuid;
      contentRevision: DecimalString;
      libraryRevision: DecimalString;
      fileName: string;
      size: number;
    }>
  | Readonly<{ state: 'UNAVAILABLE'; code: MissionResumeMaterialUnavailableCode }>;

/** The newest saved cover letter for the Mission's job. No text here. */
export type MissionCoverLetterMaterialV1 =
  | Readonly<{ state: 'NONE' }>
  | Readonly<{ state: 'READY'; artifactId: Uuid; generatedAt: IsoDateTime }>;

/** GET /missions/:missionId/materials */
export interface MissionMaterialsV1 extends AgentSchemaEnvelope {
  readonly missionId: Uuid;
  readonly resume: MissionResumeMaterialV1;
  readonly coverLetter: MissionCoverLetterMaterialV1;
}

/** POST /missions/:missionId/materials/resume → the PDF bytes, fenced by the manifest. */
export interface ReleaseMissionResumeRequestV1 {
  readonly schemaVersion: 1;
  readonly artifactId: Uuid;
  readonly expectedContentRevision: DecimalString;
  readonly expectedLibraryRevision: DecimalString;
}

/** Identity travels in headers; the body is the file itself. */
export const MISSION_MATERIAL_HEADERS = Object.freeze({
  releaseId: 'X-Material-Release-Id',
  resumeVersionId: 'X-Resume-Version-Id',
  artifactId: 'X-Material-Artifact-Id',
  sha256: 'X-Material-Sha256',
});

/** Hard cap for one released material file. */
export const MISSION_MATERIAL_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Why the dock asks for a cover letter. `FORM_REQUIRED`: the form marks its letter field
 * required, so the run the user started generates one. `USER_REQUEST`: an optional letter
 * field and the user pressed the dock's button. Both are charged once per job.
 */
export const MISSION_COVER_LETTER_TRIGGERS = ['FORM_REQUIRED', 'USER_REQUEST'] as const;
export type MissionCoverLetterTrigger = (typeof MISSION_COVER_LETTER_TRIGGERS)[number];

/** POST /missions/:missionId/materials/cover-letter. Official extension origin only. */
export interface RequestMissionCoverLetterRequestV1 {
  readonly schemaVersion: 1;
  readonly clientRequestId: Uuid;
  readonly trigger: MissionCoverLetterTrigger;
}

/**
 * Domain failures answer 200 with the closed cover-letter code set, exactly like the
 * cover-letter product. `generated: false` means an existing letter was returned and
 * nothing was charged.
 */
export type RequestMissionCoverLetterResultV1 =
  | Readonly<{
      schemaVersion: 1;
      ok: true;
      coverLetter: Readonly<{ state: 'READY'; artifactId: Uuid; generatedAt: IsoDateTime }>;
      generated: boolean;
    }>
  | Readonly<{ schemaVersion: 1; ok: false; code: CoverLetterGenerationCode }>;

/** POST /missions/:missionId/materials/cover-letter/text and …/pdf. */
export interface ReleaseMissionCoverLetterRequestV1 {
  readonly schemaVersion: 1;
  readonly artifactId: Uuid;
}

/** …/text: the letter for a textarea or plain-text editor. */
export interface ReleaseMissionCoverLetterTextV1 {
  readonly schemaVersion: 1;
  readonly artifactId: Uuid;
  readonly text: string;
}

/** Same bound as the cover-letter product's body. */
export const MISSION_COVER_LETTER_MAX_TEXT_BYTES = 12_000;

export function parseMissionMaterialsV1(value: unknown): MissionMaterialsV1 | null {
  if (
    !hasExactRecordKeys(value, ['schemaVersion', 'missionId', 'resume', 'coverLetter']) ||
    value.schemaVersion !== 1
  ) {
    return null;
  }
  const missionId = parseUuid(value.missionId);
  const resume = parseResumeMaterial(value.resume);
  const coverLetter = parseCoverLetterMaterial(value.coverLetter);
  if (missionId === null || resume === null || coverLetter === null) return null;
  return Object.freeze({ schemaVersion: 1, missionId, resume, coverLetter });
}

export function parseReleaseMissionResumeRequestV1(
  value: unknown,
): ReleaseMissionResumeRequestV1 | null {
  if (
    !hasExactRecordKeys(value, [
      'schemaVersion',
      'artifactId',
      'expectedContentRevision',
      'expectedLibraryRevision',
    ]) ||
    value.schemaVersion !== 1
  ) {
    return null;
  }
  const artifactId = parseUuid(value.artifactId);
  if (
    artifactId === null ||
    !isNonNegativeDecimalString(value.expectedContentRevision) ||
    !isNonNegativeDecimalString(value.expectedLibraryRevision)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    artifactId,
    expectedContentRevision: value.expectedContentRevision,
    expectedLibraryRevision: value.expectedLibraryRevision,
  });
}

export function parseRequestMissionCoverLetterRequestV1(
  value: unknown,
): RequestMissionCoverLetterRequestV1 | null {
  if (
    !hasExactRecordKeys(value, ['schemaVersion', 'clientRequestId', 'trigger']) ||
    value.schemaVersion !== 1
  ) {
    return null;
  }
  const clientRequestId = parseUuid(value.clientRequestId);
  if (clientRequestId === null || !isMember(value.trigger, MISSION_COVER_LETTER_TRIGGERS)) {
    return null;
  }
  return Object.freeze({ schemaVersion: 1, clientRequestId, trigger: value.trigger });
}

export function parseRequestMissionCoverLetterResultV1(
  value: unknown,
): RequestMissionCoverLetterResultV1 | null {
  if (hasExactRecordKeys(value, ['schemaVersion', 'ok', 'code'])) {
    return value.schemaVersion === 1 &&
      value.ok === false &&
      isMember(value.code, COVER_LETTER_GENERATION_CODES)
      ? Object.freeze({ schemaVersion: 1, ok: false, code: value.code })
      : null;
  }
  if (
    !hasExactRecordKeys(value, ['schemaVersion', 'ok', 'coverLetter', 'generated']) ||
    value.schemaVersion !== 1 ||
    value.ok !== true ||
    typeof value.generated !== 'boolean'
  ) {
    return null;
  }
  const coverLetter = parseCoverLetterMaterial(value.coverLetter);
  if (coverLetter === null || coverLetter.state !== 'READY') return null;
  return Object.freeze({ schemaVersion: 1, ok: true, coverLetter, generated: value.generated });
}

export function parseReleaseMissionCoverLetterRequestV1(
  value: unknown,
): ReleaseMissionCoverLetterRequestV1 | null {
  if (!hasExactRecordKeys(value, ['schemaVersion', 'artifactId']) || value.schemaVersion !== 1) {
    return null;
  }
  const artifactId = parseUuid(value.artifactId);
  return artifactId === null ? null : Object.freeze({ schemaVersion: 1, artifactId });
}

export function parseReleaseMissionCoverLetterTextV1(
  value: unknown,
): ReleaseMissionCoverLetterTextV1 | null {
  if (
    !hasExactRecordKeys(value, ['schemaVersion', 'artifactId', 'text']) ||
    value.schemaVersion !== 1
  ) {
    return null;
  }
  const artifactId = parseUuid(value.artifactId);
  if (
    artifactId === null ||
    typeof value.text !== 'string' ||
    value.text.trim().length === 0 ||
    new TextEncoder().encode(value.text).length > MISSION_COVER_LETTER_MAX_TEXT_BYTES ||
    // eslint-disable-next-line no-control-regex -- the release fence rejects these exact control characters
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value.text)
  ) {
    return null;
  }
  return Object.freeze({ schemaVersion: 1, artifactId, text: value.text });
}

// ── shared, value-free decoders ───────────────────────────────────────────────────

function parseJobDisplay(
  value: unknown,
): { readonly title: string; readonly company: string } | null | undefined {
  if (value === null) return null;
  if (
    !hasExactRecordKeys(value, ['title', 'company']) ||
    !isDisplayText(value.title, 256) ||
    !isDisplayText(value.company, 256)
  ) {
    return undefined;
  }
  return Object.freeze({ title: value.title, company: value.company });
}

function parseBindingTarget(
  value: unknown,
): (MissionPageReferenceV1 & { readonly atsProvider: AtsProviderCode }) | null {
  if (!hasExactRecordKeys(value, ['canonicalOrigin', 'pathname', 'atsProvider'])) return null;
  const page = parseMissionPageReferenceV1({
    canonicalOrigin: value.canonicalOrigin,
    pathname: value.pathname,
  });
  if (page === null || !isMember(value.atsProvider, ATS_PROVIDER_CODES)) return null;
  return Object.freeze({ ...page, atsProvider: value.atsProvider });
}

function parseCanonicalApplicationBinding(value: unknown): CanonicalApplicationBinding | null {
  if (
    !hasExactRecordKeys(value, [
      'canonicalJobId',
      'canonicalJobStatus',
      'lastVerifiedAt',
      'applicationId',
      'applicationBundleVersion',
      'applicationRevision',
      'submissionState',
    ])
  ) {
    return null;
  }
  const canonicalJobId = parseUuid(value.canonicalJobId);
  const applicationId = parseUuid(value.applicationId);
  const lastVerifiedAt = value.lastVerifiedAt === null ? null : parseIsoDateTime(value.lastVerifiedAt);
  if (
    canonicalJobId === null ||
    applicationId === null ||
    !isMember(value.canonicalJobStatus, CANONICAL_JOB_STATUSES) ||
    (value.lastVerifiedAt !== null && lastVerifiedAt === null) ||
    !isPositiveDecimalString(value.applicationBundleVersion) ||
    !isPositiveDecimalString(value.applicationRevision) ||
    !isMember(value.submissionState, APPLICATION_SUBMISSION_STATES)
  ) {
    return null;
  }
  return Object.freeze({
    canonicalJobId,
    canonicalJobStatus: value.canonicalJobStatus,
    lastVerifiedAt,
    applicationId,
    applicationBundleVersion: value.applicationBundleVersion,
    applicationRevision: value.applicationRevision,
    submissionState: value.submissionState,
  });
}

function parseResumeMaterial(value: unknown): MissionResumeMaterialV1 | null {
  if (hasExactRecordKeys(value, ['state', 'code'])) {
    return value.state === 'UNAVAILABLE' &&
      isMember(value.code, MISSION_RESUME_MATERIAL_UNAVAILABLE_CODES)
      ? Object.freeze({ state: 'UNAVAILABLE', code: value.code })
      : null;
  }
  if (
    !hasExactRecordKeys(value, [
      'state',
      'resumeVersionId',
      'artifactId',
      'contentRevision',
      'libraryRevision',
      'fileName',
      'size',
    ]) ||
    value.state !== 'READY'
  ) {
    return null;
  }
  const resumeVersionId = parseUuid(value.resumeVersionId);
  const artifactId = parseUuid(value.artifactId);
  if (
    resumeVersionId === null ||
    artifactId === null ||
    !isNonNegativeDecimalString(value.contentRevision) ||
    !isNonNegativeDecimalString(value.libraryRevision) ||
    !isSafeFileName(value.fileName) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MISSION_MATERIAL_MAX_BYTES
  ) {
    return null;
  }
  return Object.freeze({
    state: 'READY',
    resumeVersionId,
    artifactId,
    contentRevision: value.contentRevision,
    libraryRevision: value.libraryRevision,
    fileName: value.fileName,
    size: value.size,
  });
}

function parseCoverLetterMaterial(value: unknown): MissionCoverLetterMaterialV1 | null {
  if (hasExactRecordKeys(value, ['state'])) {
    return value.state === 'NONE' ? Object.freeze({ state: 'NONE' }) : null;
  }
  if (!hasExactRecordKeys(value, ['state', 'artifactId', 'generatedAt']) || value.state !== 'READY') {
    return null;
  }
  const artifactId = parseUuid(value.artifactId);
  const generatedAt = parseIsoDateTime(value.generatedAt);
  return artifactId === null || generatedAt === null
    ? null
    : Object.freeze({ state: 'READY', artifactId, generatedAt });
}

function parseSortedFieldKeys(value: unknown): readonly ApplicationProfileFieldKey[] | null {
  if (!Array.isArray(value) || value.length > APPLICATION_PROFILE_FIELD_KEYS.length) return null;
  let previous: string | undefined;
  for (const key of value) {
    if (
      typeof key !== 'string' ||
      !(APPLICATION_PROFILE_FIELD_KEYS as readonly string[]).includes(key) ||
      (previous !== undefined && previous >= key)
    ) {
      return null;
    }
    previous = key;
  }
  return Object.freeze([...value] as ApplicationProfileFieldKey[]);
}

function hasExactRecordKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseCanonicalHttpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.origin === value
      ? value
      : null;
  } catch {
    return null;
  }
}

function parseCanonicalPathname(value: unknown, canonicalOrigin: string | null): string | null {
  if (
    canonicalOrigin === null ||
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    hasAsciiControl(value) ||
    /%(?![0-9A-F]{2})/i.test(value) ||
    /%(?:2E|2F|5C|25|00)/i.test(value)
  ) {
    return null;
  }
  try {
    const parsed = new URL(value, canonicalOrigin);
    return parsed.origin === canonicalOrigin &&
      parsed.pathname === value &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.username === '' &&
      parsed.password === ''
      ? value
      : null;
  } catch {
    return null;
  }
}

function isDisplayText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    // eslint-disable-next-line no-control-regex -- display text never carries control characters
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isSafeFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    // eslint-disable-next-line no-control-regex -- a file name never carries separators or controls
    !/[/\\\u0000-\u001f\u007f]/u.test(value)
  );
}

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function isPositiveDecimalString(value: unknown): value is DecimalString {
  return typeof value === 'string' && value.length <= 20 && /^[1-9][0-9]*$/.test(value);
}

function isNonNegativeDecimalString(value: unknown): value is DecimalString {
  return typeof value === 'string' && value.length <= 20 && /^(0|[1-9][0-9]*)$/.test(value);
}

function isMember<const T extends string>(value: unknown, members: readonly T[]): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value);
}
