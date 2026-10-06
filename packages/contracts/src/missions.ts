/** Mission wire types mirrored from AGENT-API-CONTRACT.md §4. */

import {
  parseIsoDateTime,
  parseUuid,
  type AgentErrorCode,
  type AgentSchemaEnvelope,
  type DecimalString,
  type IsoDateTime,
  type OpaqueCursor,
  type Sha256Digest,
  type Uuid,
} from './common.ts';
import type { ActionCardView } from './actionCards.ts';

export const AUTOMATION_LEVELS = [
  'L0_PREVIEW_ONLY',
  'L1_FILL_STOP_BEFORE_SUBMIT',
  'L2_CONFIRM_EACH_SUBMISSION',
  'L3_MANAGED_BATCH',
] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

export const EXECUTION_ALLOWED_ACTIONS = ['FILL', 'SUBMIT'] as const;
export type ExecutionAllowedAction = (typeof EXECUTION_ALLOWED_ACTIONS)[number];

export const SOURCE_PLATFORM_CODES = [
  'GREENHOUSE', 'LEVER', 'ASHBY', 'WORKABLE',
  // 2026-09-24 追加（argoland 权威，本仓镜像）：目录里这三家的岗位把 ATS 记作来源平台。
  // 少了它们，本机验签把这三家岗位的每一张执行票都判成畸形。
  'WORKDAY', 'SMARTRECRUITERS', 'BAMBOOHR',
  'INDEED',
] as const;
export type SourcePlatformCode = (typeof SOURCE_PLATFORM_CODES)[number];

export const ATS_PROVIDER_CODES = [
  'GREENHOUSE', 'LEVER', 'ASHBY', 'WORKABLE',
  'WORKDAY', 'ICIMS', 'SMARTRECRUITERS', 'BAMBOOHR',
  // 2026-09-22 追加（argoland 权威，本仓镜像）：规则与适配器早就在仓里且实测能填，
  // 只是从来没进过运行时发布。
  'DOVER', 'JOBVITE', 'RIPPLING',
  /**
   * 2026-09-22 追加（argoland 权威 #584，本仓镜像）：**不绑任何厂商**的那条路。
   *
   * 我们的识别力本来就大半与站点无关：十一份规则的 labelPatterns 去重后只有 38 条，
   * 其中 15 条被 8 家以上共用。这些规则今天被锁在「先认出厂商、再命中锚点」之后，
   * 所以在公司自建域名的申请页上一条都跑不起来。GENERIC 给那条路一个身份。
   *
   * 它照常走 (atsProvider, pathRuleId) 的精确映射、照常受 policy 的厂商位与能力位管，
   * **不是**绕过授权的后门。识别判据不能是路径或站点钩子（自建域上两者都不存在），
   * 只能是「这一张表里有足够多我们认得的字段」——那就是 `genericRoot`。
   */
  'GENERIC',
  'INDEED_APPLY',
] as const;
export type AtsProviderCode = (typeof ATS_PROVIDER_CODES)[number];

/** §4.1 canonical requisition projection; UNKNOWN never falls back to OPEN. */
export const CANONICAL_JOB_STATUSES = ['OPEN', 'CLOSED', 'UNKNOWN'] as const;
export type CanonicalJobStatus = (typeof CANONICAL_JOB_STATUSES)[number];

/** §4.1 permanent Application reapply-safety state. */
export const APPLICATION_SUBMISSION_STATES = [
  'ELIGIBLE',
  'ARMED',
  'TRIGGERING_RISK',
  'TRIGGERED_LOCKED',
  'OUTCOME_UNKNOWN',
] as const;
export type ApplicationSubmissionState = (typeof APPLICATION_SUBMISSION_STATES)[number];

/** §4.7 only these two user/client facts can set the permanent reapply latch. */
export const APPLICATION_SUBMISSION_EVENT_TYPES = [
  'SUBMISSION_TRIGGERED',
  'USER_REPORTED_SUBMISSION',
] as const;
export type ApplicationSubmissionEventType =
  (typeof APPLICATION_SUBMISSION_EVENT_TYPES)[number];

/** §4.3 non-replay VALIDATE_JOB first-match results; success follows these six cases. */
export const VALIDATE_JOB_FIRST_MATCH_RESULT_CODES = [
  'JOB_IDENTITY_AMBIGUOUS',
  'JOB_UNAVAILABLE',
  'APPLICATION_SUBMISSION_OUTCOME_UNKNOWN',
  'APPLICATION_ALREADY_SUBMITTED',
  'JOB_EXPIRED',
  'JOB_UNAVAILABLE',
] as const satisfies readonly AgentErrorCode[];

export const MISSION_STATUSES = [
  'QUEUED',
  'PREPARING',
  'WAITING_FOR_APPROVAL',
  'READY_TO_EXECUTE',
  'EXECUTING',
  'WAITING_FOR_USER',
  'CANCELLATION_REQUESTED',
  'CANCELLED',
  'SUCCEEDED',
  'PARTIALLY_SUCCEEDED',
  'FAILED',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const MISSION_TERMINAL_STATUSES = [
  'CANCELLED', 'SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'FAILED',
] as const satisfies readonly MissionStatus[];
export type MissionTerminalStatus = (typeof MISSION_TERMINAL_STATUSES)[number];

export const MISSION_STATUS_TRANSITIONS = {
  QUEUED: ['PREPARING', 'CANCELLATION_REQUESTED', 'FAILED'],
  PREPARING: ['WAITING_FOR_APPROVAL', 'CANCELLATION_REQUESTED', 'FAILED'],
  WAITING_FOR_APPROVAL: ['READY_TO_EXECUTE', 'CANCELLATION_REQUESTED', 'FAILED'],
  READY_TO_EXECUTE: ['EXECUTING', 'CANCELLATION_REQUESTED', 'FAILED'],
  EXECUTING: ['WAITING_FOR_USER', 'CANCELLATION_REQUESTED', 'SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'FAILED'],
  WAITING_FOR_USER: ['READY_TO_EXECUTE', 'EXECUTING', 'CANCELLATION_REQUESTED', 'FAILED'],
  CANCELLATION_REQUESTED: ['CANCELLED', 'PARTIALLY_SUCCEEDED', 'FAILED'],
  CANCELLED: [],
  SUCCEEDED: [],
  PARTIALLY_SUCCEEDED: [],
  FAILED: [],
} as const satisfies Record<MissionStatus, readonly MissionStatus[]>;

export const MISSION_STEP_TYPES = [
  'VALIDATE_JOB',
  'PREPARE_MATERIALS',
  'DISCOVER_FORM',
  'AWAIT_APPROVAL',
  'EXECUTE_FILL',
  'AWAIT_USER_SUBMIT',
  'VERIFY_RECEIPT',
] as const;
export type MissionStepType = (typeof MISSION_STEP_TYPES)[number];

export const MISSION_STEP_STATUSES = [
  'PENDING', 'RUNNING', 'WAITING_FOR_USER', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED',
] as const;
export type MissionStepStatus = (typeof MISSION_STEP_STATUSES)[number];

export const MISSION_PROGRESS_CODES = [
  'MISSION_QUEUED',
  'JOB_VALIDATED',
  'MATERIALS_READY',
  'FORM_DISCOVERED',
  'FIELD_PLAN_READY',
  'APPROVAL_RECORDED',
  'EXECUTION_STARTED',
  'FIELDS_FILLED',
  'USER_ACTION_REQUIRED',
  'RECEIPT_RECORDED',
  'CANCELLATION_PENDING',
  'MISSION_COMPLETED',
  'MISSION_PARTIAL',
  'MISSION_FAILED',
] as const;
export type MissionProgressCode = (typeof MISSION_PROGRESS_CODES)[number];

export const MISSION_STEP_ERROR_CODES = [
  'JOB_UNAVAILABLE',
  'JOB_EXPIRED',
  'JOB_IDENTITY_AMBIGUOUS',
  'APPLICATION_ALREADY_SUBMITTED',
  'APPLICATION_SUBMISSION_OUTCOME_UNKNOWN',
  'NO_FINAL_RESUME',
  'RESUME_PROCESSING',
  'VERSION_NOT_READY',
  'RESUME_VERSION_STALE',
  'PROFILE_REVISION_MISMATCH',
  'PROFILE_DELETION_EPOCH_MISMATCH',
  'EXECUTION_APPROVAL_REQUIRED',
  'EXECUTION_TARGET_MISMATCH',
  'EXECUTION_FIELD_SET_MISMATCH',
  'EXECUTION_POLICY_CHANGED',
  'EXTENSION_INSTALL_MISMATCH',
  'EXECUTION_LEASE_EXPIRED',
  'RECEIPT_VERIFICATION_FAILED',
  'TOOL_TIMEOUT',
  'TOOL_EXECUTION_FAILED',
  'AGENT_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const satisfies readonly AgentErrorCode[];
export type MissionStepErrorCode = (typeof MISSION_STEP_ERROR_CODES)[number];

export interface TrustedJobIdentity {
  /** Source-bound listing id; this field is never a canonicalJobId alias. */
  readonly jobId: string;
  readonly sourcePlatform: SourcePlatformCode;
  readonly atsProvider: AtsProviderCode;
  readonly canonicalOrigin: string;
  readonly pathRuleId: string;
  readonly postingFingerprint: Sha256Digest;
}

/** §4.2 value-free, server-owned binding shared by every Mission view. */
export interface CanonicalApplicationBinding {
  readonly canonicalJobId: Uuid;
  readonly canonicalJobStatus: CanonicalJobStatus;
  readonly lastVerifiedAt: IsoDateTime | null;
  readonly applicationId: Uuid;
  readonly applicationBundleVersion: DecimalString;
  readonly applicationRevision: DecimalString;
  readonly submissionState: ApplicationSubmissionState;
}

export interface MissionProgress {
  readonly progressCode: MissionProgressCode;
  readonly completed: number;
  readonly total: number;
  readonly currentStepId: Uuid | null;
}

export interface MissionSummary {
  readonly id: Uuid;
  readonly conversationId: Uuid;
  readonly revision: DecimalString;
  readonly status: MissionStatus;
  readonly job: TrustedJobIdentity;
  /** Null is reserved for read-only pre-T11 rows created before canonical binding existed. */
  readonly application: CanonicalApplicationBinding | null;
  readonly automationLevel: AutomationLevel;
  readonly progress: MissionProgress;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface MissionStepView {
  readonly id: Uuid;
  /** Bounded step order; unlike message sequence this is a JSON integer. */
  readonly sequence: number;
  readonly attempt: number;
  readonly type: MissionStepType;
  readonly status: MissionStepStatus;
  readonly progressCode: MissionProgressCode;
  readonly errorCode: MissionStepErrorCode | null;
  readonly startedAt: IsoDateTime | null;
  readonly finishedAt: IsoDateTime | null;
}

export interface MissionApprovalPlan {
  readonly stepId: Uuid;
  readonly stepAttempt: number;
  readonly approvalMessageId: Uuid;
  readonly actionId: Uuid;
  /** T11 Missions use source-contract §1.2 planDigest v2; wire remains an opaque digest. */
  readonly planDigest: Sha256Digest;
  readonly fieldSchemaVersion: number;
  readonly fieldKeys: readonly string[];
  readonly automationLevel: AutomationLevel;
  readonly allowedActions: readonly ExecutionAllowedAction[];
  readonly policyVersion: string;
  readonly expiresAt: IsoDateTime;
}

export type AssistantMissionApprovalRef = Omit<
  RecordMissionApprovalRequest,
  | "clientRequestId"
  | "decision"
  | "jobId"
  | "fieldKeys"
  | "automationLevel"
  | "allowedActions"
>;
export interface AssistantMissionRunContext {
  readonly resumeVersionId: string;
  readonly fieldKeys: readonly string[];
  readonly planDigest: string;
  readonly expiresAt: string;
  readonly approval: AssistantMissionApprovalRef | null;
  readonly start: MissionRunStartRefView | null;
}

export interface MissionDetailView extends MissionSummary {
  /** Owner-only exact material and pending/approved run reference; absent on older servers. */
  readonly assistantRun?: AssistantMissionRunContext | null;
  readonly steps: readonly MissionStepView[];
  readonly approvalPlan: MissionApprovalPlan | null;
}

export interface ListMissionsQuery {
  readonly conversationId?: Uuid;
  readonly status?: MissionStatus;
  readonly cursor?: OpaqueCursor;
  readonly limit?: number;
}
export interface ListMissionsResponse extends AgentSchemaEnvelope {
  readonly items: readonly MissionSummary[];
  readonly page: { readonly nextCursor: OpaqueCursor | null; readonly hasMore: boolean };
}

export interface GetMissionParams { readonly missionId: Uuid }
export interface GetMissionResponse extends AgentSchemaEnvelope { readonly mission: MissionDetailView }

/**
 * The three references a run needs, read off one Mission detail.
 *
 * `missionStepId` here is the **approval** step -- the one the user approved --
 * which is what `IssueExecutionIntentRequest` names. It is deliberately not the
 * execution step the issuer creates; those are different rows and comparing them
 * for equality rejects every legitimate issuance (§5.4).
 *
 * A Mission with no approval plan yields null: nothing may start a run on a
 * Mission the user has not approved, so the absence is the answer, not an error.
 *
 * This is a projection, not a decoder for `MissionDetailView`. It validates the
 * fields it consumes and ignores the rest, because the detail body legitimately
 * carries far more than a run start needs and this caller is its owner.
 */
export interface MissionRunStartRefView {
  readonly missionId: Uuid;
  readonly missionStepId: Uuid;
  readonly missionRevision: DecimalString;
}


/** §4.2 owner-only, value-free projection of one fresh verified application URL. */
export interface MissionApplicationTargetView {
  /** Owner Mission CAS fence; distinct from the application-target revision below. */
  readonly missionRevision: DecimalString;
  readonly canonicalOrigin: string;
  readonly pathname: string;
  readonly atsProvider: AtsProviderCode;
  readonly pathRuleId: string;
  readonly verifierVersion: string;
  readonly verifiedAt: IsoDateTime;
  readonly freshUntil: IsoDateTime;
  /** URL-verification freshness policy only; never an execution/apply policy authority. */
  readonly policyVersion: string;
  readonly revision: DecimalString;
}

export interface GetMissionApplicationTargetParams { readonly missionId: Uuid }
export interface GetMissionApplicationTargetResponse extends AgentSchemaEnvelope {
  readonly target: MissionApplicationTargetView;
}

/**
 * Strict shared decoder for the Mission application-target read boundary.
 * It deliberately has no vendor, selector, value, label, HTML, token or
 * open-ended metadata field.
 */
export function parseGetMissionApplicationTargetResponse(
  value: unknown,
): GetMissionApplicationTargetResponse | null {
  if (
    !hasExactRecordKeys(value, ['schemaVersion', 'target']) ||
    value.schemaVersion !== 1 ||
    !hasExactRecordKeys(value.target, [
      'missionRevision',
      'canonicalOrigin',
      'pathname',
      'atsProvider',
      'pathRuleId',
      'verifierVersion',
      'verifiedAt',
      'freshUntil',
      'policyVersion',
      'revision',
    ])
  ) return null;

  const target = value.target;
  const canonicalOrigin = parseCanonicalHttpsOrigin(target.canonicalOrigin);
  const pathname = parseCanonicalApplicationPathname(target.pathname, canonicalOrigin);
  const verifiedAt = parseIsoDateTime(target.verifiedAt);
  const freshUntil = parseIsoDateTime(target.freshUntil);
  if (
    !isPositiveDecimalString(target.missionRevision) ||
    canonicalOrigin === null ||
    pathname === null ||
    !isMember(target.atsProvider, ATS_PROVIDER_CODES) ||
    !isBoundedSafeToken(target.pathRuleId, 256) ||
    !isBoundedSafeToken(target.verifierVersion, 64) ||
    !verifiedAt ||
    !freshUntil ||
    Date.parse(verifiedAt) >= Date.parse(freshUntil) ||
    !isBoundedSafeToken(target.policyVersion, 128) ||
    !isPositiveDecimalString(target.revision)
  ) return null;

  return Object.freeze({
    schemaVersion: 1,
    target: Object.freeze({
      missionRevision: target.missionRevision,
      canonicalOrigin,
      pathname,
      atsProvider: target.atsProvider,
      pathRuleId: target.pathRuleId,
      verifierVersion: target.verifierVersion,
      verifiedAt,
      freshUntil,
      policyVersion: target.policyVersion,
      revision: target.revision,
    }),
  });
}

export interface CreateMissionRequest {
  readonly clientRequestId: Uuid;
  readonly conversationId: Uuid;
  readonly jobId: string;
  readonly requestedAutomationLevel: AutomationLevel;
  readonly resumeVersionId?: Uuid;
  readonly fieldKeys?: never;
  readonly target?: never;
  readonly allowedActions?: never;
  readonly profile?: never;
  readonly policyVersion?: never;
}
export interface CreateMissionResponse extends AgentSchemaEnvelope {
  /** Every T11 create/replay is canonically bound; only legacy reads may expose null. */
  readonly mission: MissionSummary & { readonly application: CanonicalApplicationBinding };
}

export const MISSION_APPROVAL_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type MissionApprovalDecision = (typeof MISSION_APPROVAL_DECISIONS)[number];
export interface RecordMissionApprovalParams { readonly missionId: Uuid }
export interface RecordMissionApprovalRequest {
  readonly clientRequestId: Uuid;
  readonly missionRevision: DecimalString;
  readonly missionStepId: Uuid;
  readonly stepAttempt: number;
  readonly approvalMessageId: Uuid;
  readonly actionId: Uuid;
  readonly actionRevision: DecimalString;
  readonly actionPayloadDigest: Sha256Digest;
  readonly planDigest: Sha256Digest;
  readonly decision: MissionApprovalDecision;
  readonly jobId?: never;
  readonly fieldKeys?: never;
  readonly automationLevel?: never;
  readonly allowedActions?: never;
}

export interface RecordMissionApprovalResponse extends AgentSchemaEnvelope {
  readonly mission: MissionDetailView;
  readonly actionCard: ActionCardView;
}

export const CANCELLATION_EFFECTS = [
  'IMMEDIATE',
  'PENDING_SAFE_POINT',
  'EXTERNAL_EFFECT_MAY_HAVE_OCCURRED',
  'ALREADY_TERMINAL',
] as const;
export type CancellationEffect = (typeof CANCELLATION_EFFECTS)[number];
export interface CancelMissionParams { readonly missionId: Uuid }
export interface CancelMissionRequest { readonly expectedRevision?: DecimalString }
export interface CancelMissionResponse extends AgentSchemaEnvelope {
  readonly mission: {
    readonly id: Uuid;
    readonly revision: DecimalString;
    readonly status: MissionStatus;
    readonly cancellationEffect: CancellationEffect;
  };
}

/** §4.6 POST /api/v1/agent/missions/:missionId/submission-boundaries */
export interface EnterSubmissionBoundaryParams { readonly missionId: Uuid }
export interface EnterSubmissionBoundaryRequest {
  readonly clientRequestId: Uuid;
  readonly expectedMissionRevision: DecimalString;
  readonly missionStepId: Uuid;
  readonly stepAttempt: number;
  readonly applicationId: Uuid;
  readonly expectedApplicationRevision: DecimalString;
  readonly applicationBundleVersion: DecimalString;
  readonly extensionInstallId: Uuid;

  /** CAP-AF-064 evidence is deliberately outside this contract. */
  readonly confirmationUrl?: never;
  readonly atsConfirmationId?: never;
  readonly confirmationEmail?: never;
  readonly screenshot?: never;
  readonly providerEvidence?: never;
  readonly metadata?: never;
}

export interface SubmissionBoundaryView {
  readonly id: Uuid;
  readonly missionId: Uuid;
  readonly missionRevision: DecimalString;
  readonly missionStepId: Uuid;
  readonly stepAttempt: number;
  readonly applicationId: Uuid;
  readonly applicationBundleVersion: DecimalString;
  readonly attemptRevision: DecimalString;
  readonly acceptedAt: IsoDateTime;
}

export interface EnterSubmissionBoundaryResponse extends AgentSchemaEnvelope {
  readonly boundary: SubmissionBoundaryView;
  readonly application: CanonicalApplicationBinding;
}

/** §4.7 POST /api/v1/agent/missions/:missionId/submission-events */
export interface RecordSubmissionEventParams { readonly missionId: Uuid }

interface RecordSubmissionEventCommon {
  readonly clientRequestId: Uuid;
  readonly applicationId: Uuid;
  readonly expectedApplicationRevision: DecimalString;
  readonly applicationBundleVersion: DecimalString;

  /** No arm may smuggle CAP-AF-064 evidence or open metadata. */
  readonly confirmationUrl?: never;
  readonly atsConfirmationId?: never;
  readonly confirmationEmail?: never;
  readonly screenshot?: never;
  readonly providerEvidence?: never;
  readonly metadata?: never;
}

export type RecordSubmissionEventRequest =
  | (RecordSubmissionEventCommon & {
      readonly eventType: 'SUBMISSION_TRIGGERED';
      readonly boundaryId: Uuid;
      readonly attemptRevision: DecimalString;
      readonly extensionInstallId: Uuid;
    })
  | (RecordSubmissionEventCommon & {
      readonly eventType: 'USER_REPORTED_SUBMISSION';
      readonly boundaryId?: never;
      readonly attemptRevision?: never;
      readonly extensionInstallId?: never;
    });

export interface ApplicationSubmissionEventView {
  readonly id: Uuid;
  readonly eventType: ApplicationSubmissionEventType;
  readonly applicationId: Uuid;
  readonly applicationBundleVersion: DecimalString;
  readonly applicationRevision: DecimalString;
  readonly recordedAt: IsoDateTime;
}

export interface RecordSubmissionEventResponse extends AgentSchemaEnvelope {
  readonly event: ApplicationSubmissionEventView;
  readonly application: CanonicalApplicationBinding;
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
  if (typeof value !== 'string') return null;
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

function parseCanonicalApplicationPathname(
  value: unknown,
  canonicalOrigin: string | null,
): string | null {
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
    /%(?![0-9A-F]{2})/.test(value) ||
    /%(?:2E|2F|5C|25|00)/i.test(value)
  ) return null;

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

function isBoundedSafeToken(value: unknown, maximum: number): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !hasAsciiControl(value);
}

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function isPositiveDecimalString(value: unknown): value is DecimalString {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function isMember<const T extends string>(
  value: unknown,
  members: readonly T[],
): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value);
}

/**
 * A mission's policy identity is two facts, not one: the runtime policy the
 * mission was approved under, and the user's quota policy version at that
 * moment. They are carried in a single column as `<runtime>.q<quota>` because
 * the mission compares the pair when deciding whether an approval is still
 * current.
 *
 * The published execution-runtime bundle only knows the runtime half. Comparing
 * a composed value against it as equal strings can never match once any quota
 * assignment exists, so consumers of the runtime half must go through
 * {@link missionRuntimePolicyVersion} rather than compare the raw column.
 */
const MISSION_QUOTA_POLICY_SUFFIX = /^(.*)\.q(\d+)$/u;

export function composeMissionPolicyVersion(
  runtimePolicyVersion: string,
  quotaPolicyVersion: number,
): string | null {
  if (runtimePolicyVersion.length === 0) return null;
  if (!Number.isSafeInteger(quotaPolicyVersion) || quotaPolicyVersion <= 0) return null;
  // A runtime version that already ends in a quota suffix would make the
  // composed value ambiguous to parse back, so it is refused rather than
  // silently producing a version that decomposes into something else.
  if (MISSION_QUOTA_POLICY_SUFFIX.test(runtimePolicyVersion)) return null;
  return `${runtimePolicyVersion}.q${quotaPolicyVersion}`;
}

/**
 * The runtime half of a mission policy version. A value with no quota suffix is
 * returned unchanged, so callers holding a plain runtime version stay correct.
 */
export function missionRuntimePolicyVersion(missionPolicyVersion: string): string {
  const match = MISSION_QUOTA_POLICY_SUFFIX.exec(missionPolicyVersion);
  return match === null ? missionPolicyVersion : (match[1] as string);
}
