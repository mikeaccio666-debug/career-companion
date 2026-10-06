/** Stable wire primitives mirrored from AGENT-API-CONTRACT.md §§1 and 6. */

export const AGENT_HTTP_SCHEMA_VERSION = 1 as const;
export const AGENT_API_BASE_PATH = '/api/v1/agent' as const;

export type AgentHttpSchemaVersion = typeof AGENT_HTTP_SCHEMA_VERSION;
declare const wireBrand: unique symbol;
/** Canonical lowercase RFC 4122 UUID version 4. */
export type Uuid = string & { readonly [wireBrand]: 'Uuid' };
export type IsoDateTime = string & { readonly [wireBrand]: 'IsoDateTime' };
export type LocalDate = string & { readonly [wireBrand]: 'LocalDate' };
export type OpaqueCursor = string & { readonly [wireBrand]: 'OpaqueCursor' };
export type DecimalString = `${bigint}`;
export type Sha256Digest = `sha256:${string}` & { readonly [wireBrand]: 'Sha256Digest' };

/** Hostile-boundary constructors. They return null instead of branding invalid wire values. */
export function parseUuid(value: unknown): Uuid | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value as Uuid
    : null;
}
export function parseSha256Digest(value: unknown): Sha256Digest | null {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) ? value as Sha256Digest : null;
}
export function parseIsoDateTime(value: unknown): IsoDateTime | null {
  if (typeof value !== 'string') return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/,
  );
  if (!match) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  const instant = new Date(timestamp);
  const [, year, month, day, hour, minute, second] = match;
  if (
    instant.getUTCFullYear() !== Number(year) ||
    instant.getUTCMonth() + 1 !== Number(month) ||
    instant.getUTCDate() !== Number(day) ||
    instant.getUTCHours() !== Number(hour) ||
    instant.getUTCMinutes() !== Number(minute) ||
    instant.getUTCSeconds() !== Number(second)
  ) return null;
  return value as IsoDateTime;
}
export function parseLocalDate(value: unknown): LocalDate | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]! ? value as LocalDate : null;
}

export interface AgentSchemaEnvelope {
  readonly schemaVersion: AgentHttpSchemaVersion;
}

export const RECOMMENDED_ACTIONS = [
  'NONE',
  'REFRESH_SESSION',
  'SIGN_IN',
  'VERIFY_EMAIL',
  'UPGRADE',
  'WAIT_AND_RETRY',
  'WAIT_FOR_RESOURCE',
  'RETRY_MESSAGE',
  'REFRESH_RESOURCE',
  'RESTART_EXECUTION',
  'OPEN_EXTENSION',
  'UPLOAD_RESUME',
  'REVIEW_PROFILE',
  'REVIEW_MISSION',
  'REVIEW_SENSITIVE_WRITE',
  'UPGRADE_EXTENSION',
  'CONTACT_SUPPORT',
] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

/** Safe control metadata only; no open-ended record is accepted at this boundary. */
export interface AgentErrorDetails {
  readonly currentRevision?: DecimalString;
  readonly conversationId?: Uuid;
  readonly resourceId?: Uuid;
  readonly fieldKeys?: readonly string[];
  readonly retryAfterSeconds?: number;
  readonly resetAt?: IsoDateTime;
}

const error = <
  const S extends number,
  const R extends boolean,
  const U extends boolean,
  const A extends RecommendedAction,
>(statusCode: S, retryable: R, requiresUserAction: U, recommendedAction: A) => ({
  statusCode,
  retryable,
  requiresUserAction,
  recommendedAction,
} as const);

export const AGENT_ERROR_DEFINITIONS = {
  VALIDATION_FAILED: error(400, false, false, 'NONE'),
  PROFILE_INTAKE_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  PROFILE_INTAKE_LIMIT_REACHED: error(409, false, true, 'REFRESH_RESOURCE'),
  PROFILE_INTAKE_AUDIO_INVALID: error(400, false, true, 'NONE'),
  LOGIN_REQUIRED: error(401, true, false, 'REFRESH_SESSION'),
  ACCESS_DENIED: error(403, false, false, 'NONE'),
  ACCOUNT_UNAVAILABLE: error(403, false, true, 'CONTACT_SUPPORT'),
  PAYWALL_REQUIRED: error(402, false, true, 'UPGRADE'),
  USAGE_EXHAUSTED: error(429, true, false, 'WAIT_AND_RETRY'),
  RATE_LIMITED: error(429, true, false, 'WAIT_AND_RETRY'),
  PREPARATION_RETRY_EXHAUSTED: error(409, false, true, 'REFRESH_RESOURCE'),
  PREPARATION_RECOVERY_CONFLICT: error(409, true, true, 'REFRESH_RESOURCE'),
  PREPARATION_CHECKPOINT_EXPIRED: error(409, false, true, 'REFRESH_RESOURCE'),
  PREPARATION_MATERIAL_UNAVAILABLE: error(409, false, true, 'REFRESH_RESOURCE'),
  INTERNAL_ERROR: error(500, true, true, 'CONTACT_SUPPORT'),
  CALENDAR_SYNC_CONFLICT: error(409, true, true, 'REFRESH_RESOURCE'),
  AGENT_UNAVAILABLE: error(503, true, false, 'WAIT_AND_RETRY'),
  MENTOR_COFFEE_CHAT_DISABLED: error(503, false, true, 'CONTACT_SUPPORT'),
  REFERRAL_GUARANTEE_DISABLED: error(503, false, true, 'CONTACT_SUPPORT'),
  REFERRAL_OUTCOME_DISABLED: error(503, false, true, 'CONTACT_SUPPORT'),
  REFERRAL_OUTCOME_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  REFERRAL_GUARANTEE_REMEDY_UNAVAILABLE: error(409, false, true, 'REFRESH_RESOURCE'),
  REFERRAL_COMMERCE_DISABLED: error(503, false, true, 'CONTACT_SUPPORT'),
  REFERRAL_PAYMENT_REQUIRED: error(402, false, true, 'UPGRADE'),
  REFERRAL_REFUND_NOT_AVAILABLE: error(409, false, true, 'REFRESH_RESOURCE'),
  REFERRAL_REFUND_RECONCILIATION_REQUIRED: error(409, true, true, 'CONTACT_SUPPORT'),
  REFERRAL_MENTOR_NOT_AVAILABLE: error(409, false, true, 'REFRESH_RESOURCE'),
  REFERRAL_COFFEE_CHAT_SLOT_NOT_FOUND: error(404, false, false, 'NONE'),
  AUTH_EMAIL_ALREADY_REGISTERED: error(409, false, true, 'SIGN_IN'),
  AUTH_INVALID_CREDENTIALS: error(401, false, true, 'SIGN_IN'),
  AUTH_CSRF_INVALID: error(403, false, false, 'REFRESH_SESSION'),
  AUTH_REFRESH_INVALID: error(401, false, true, 'SIGN_IN'),
  AUTH_HANDOFF_INVALID: error(401, false, true, 'OPEN_EXTENSION'),
  AUTH_INVITATION_REQUIRED: error(403, false, true, 'NONE'),
  AUTH_INVITATION_INVALID: error(401, false, true, 'NONE'),
  AUTH_REGISTRATION_SESSION_INVALID: error(401, false, true, 'NONE'),
  AUTH_VERIFICATION_INVALID: error(400, false, false, 'NONE'),
  WAITLIST_CHALLENGE_REQUIRED: error(403, true, true, 'NONE'),
  CONVERSATION_NOT_FOUND: error(404, false, false, 'NONE'),
  RESOURCE_NOT_FOUND: error(404, false, false, 'NONE'),
  CONVERSATION_IDEMPOTENCY_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  CONVERSATION_ROLE_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  CONVERSATION_STATE_CONFLICT: error(409, true, true, 'REFRESH_RESOURCE'),
  MESSAGE_NOT_FOUND: error(404, false, false, 'NONE'),
  MESSAGE_IDEMPOTENCY_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  DAILY_REPORT_PREFERENCE_CONFLICT: error(409, true, true, 'REFRESH_RESOURCE'),
  DAILY_REPORT_NOT_FOUND: error(404, false, false, 'NONE'),
  GENERATION_ALREADY_RUNNING: error(409, true, true, 'REFRESH_RESOURCE'),
  TURN_CANCELLED: error(409, true, true, 'RETRY_MESSAGE'),
  ACTION_NOT_FOUND: error(404, false, true, 'REFRESH_RESOURCE'),
  ACTION_STATE_CONFLICT: error(409, true, true, 'REFRESH_RESOURCE'),
  ACTION_EXPIRED: error(410, false, true, 'REFRESH_RESOURCE'),
  ACTION_IDEMPOTENCY_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  TOOL_VALIDATION_FAILED: error(422, false, false, 'NONE'),
  TOOL_NOT_ALLOWED: error(403, false, false, 'NONE'),
  TOOL_TIMEOUT: error(504, true, false, 'WAIT_AND_RETRY'),
  TOOL_EXECUTION_FAILED: error(502, false, true, 'CONTACT_SUPPORT'),
  RECOMMENDATION_BATCH_NOT_FOUND: error(404, false, false, 'NONE'),
  RECOMMENDATION_STATE_CONFLICT: error(409, true, true, 'REFRESH_RESOURCE'),
  RECOMMENDATION_IDEMPOTENCY_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  // §3.4 on-demand refresh: the owner's daily refresh budget is spent, or the
  // owner/Role is not ready for a first batch yet.
  RECOMMENDATION_REFRESH_RATE_LIMITED: error(429, true, false, 'WAIT_AND_RETRY'),
  RECOMMENDATION_REFRESH_NOT_READY: error(409, false, true, 'REVIEW_PROFILE'),
  MISSION_NOT_FOUND: error(404, false, false, 'NONE'),
  MISSION_STEP_NOT_FOUND: error(404, false, false, 'NONE'),
  MISSION_IDEMPOTENCY_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  MISSION_STATE_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  // §4.18 intake refusals. Not retryable and not the user's fault to fix by
  // waiting: the URL either names a board we support or it does not.
  JOB_INTAKE_PROVIDER_UNSUPPORTED: error(400, false, true, 'NONE'),
  JOB_INTAKE_PROVIDER_NOT_ENABLED: error(400, false, true, 'NONE'),
  JOB_INTAKE_URL_UNPARSEABLE: error(400, false, true, 'NONE'),
  // T6-14 verified admission: a posting the provider no longer serves cannot be
  // added; a provider that cannot be reached can be retried later.
  JOB_INTAKE_POSTING_UNAVAILABLE: error(404, false, true, 'NONE'),
  JOB_INTAKE_PROVIDER_UNAVAILABLE: error(503, true, false, 'WAIT_AND_RETRY'),
  JOB_UNAVAILABLE: error(404, false, true, 'REFRESH_RESOURCE'),
  JOB_EXPIRED: error(410, false, true, 'REFRESH_RESOURCE'),
  // The posting's description changed after a résumé was tailored to it: continuing needs a fresh one.
  JOB_DESCRIPTION_CHANGED: error(409, false, true, 'REFRESH_RESOURCE'),
  JOB_IDENTITY_AMBIGUOUS: error(409, false, true, 'REFRESH_RESOURCE'),
  APPLICATION_ALREADY_SUBMITTED: error(409, false, true, 'REFRESH_RESOURCE'),
  APPLICATION_SUBMISSION_OUTCOME_UNKNOWN: error(409, false, true, 'REVIEW_MISSION'),
  APPROVAL_NOT_READY: error(409, true, true, 'REVIEW_MISSION'),
  EXECUTION_APPROVAL_REQUIRED: error(409, false, true, 'REVIEW_MISSION'),
  EXECUTION_INTENT_NOT_ALLOWED: error(403, false, true, 'REVIEW_MISSION'),
  EXECUTION_INTENT_INVALID: error(401, false, true, 'RESTART_EXECUTION'),
  EXECUTION_INTENT_EXPIRED: error(410, true, true, 'RESTART_EXECUTION'),
  EXECUTION_INTENT_SUPERSEDED: error(409, true, true, 'RESTART_EXECUTION'),
  EXECUTION_INTENT_CONSUMED: error(409, false, true, 'RESTART_EXECUTION'),
  EXECUTION_TARGET_MISMATCH: error(412, false, true, 'REFRESH_RESOURCE'),
  EXECUTION_FIELD_SET_MISMATCH: error(412, false, true, 'REFRESH_RESOURCE'),
  EXECUTION_PLAN_MISMATCH: error(412, true, true, 'REFRESH_RESOURCE'),
  EXECUTION_POLICY_CHANGED: error(412, true, true, 'REFRESH_RESOURCE'),
  EXTENSION_INSTALL_MISMATCH: error(403, false, true, 'OPEN_EXTENSION'),
  EXECUTION_LEASE_EXPIRED: error(410, true, true, 'RESTART_EXECUTION'),
  EXECUTION_CLIENT_UPGRADE_REQUIRED: error(426, false, true, 'UPGRADE_EXTENSION'),
  SENSITIVE_WRITE_CONFIRMATION_NOT_FOUND: error(404, false, true, 'REFRESH_RESOURCE'),
  SENSITIVE_WRITE_RELEASE_NOT_FOUND: error(404, false, true, 'REFRESH_RESOURCE'),
  SENSITIVE_WRITE_RELEASE_STATE_CONFLICT: error(409, true, true, 'REFRESH_RESOURCE'),
  SENSITIVE_WRITE_RELEASE_IDEMPOTENCY_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  SENSITIVE_WRITE_RELEASE_STALE: error(412, true, true, 'REVIEW_SENSITIVE_WRITE'),
  SENSITIVE_WRITE_RELEASE_EXPIRED: error(410, true, true, 'REVIEW_SENSITIVE_WRITE'),
  SENSITIVE_EXECUTION_MATERIAL_UNAVAILABLE: error(409, true, true, 'REVIEW_SENSITIVE_WRITE'),
  SENSITIVE_EXECUTION_MATERIAL_SCOPE_MISMATCH: error(412, false, true, 'REFRESH_RESOURCE'),
  RECEIPT_IDEMPOTENCY_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  RECEIPT_INTENT_NOT_CLAIMED: error(409, false, true, 'RESTART_EXECUTION'),
  RECEIPT_SCOPE_MISMATCH: error(412, false, true, 'REFRESH_RESOURCE'),
  RECEIPT_VERIFICATION_FAILED: error(422, false, true, 'REVIEW_MISSION'),
  PROVIDER_CONFIRMATION_DISABLED: error(503, true, false, 'WAIT_AND_RETRY'),
  PROVIDER_ATTESTATION_INVALID: error(401, false, false, 'NONE'),
  PROVIDER_ATTESTATION_STALE: error(410, false, false, 'NONE'),
  PROVIDER_CONFIRMATION_NOT_FOUND: error(404, false, false, 'NONE'),
  PROVIDER_CONFIRMATION_SCOPE_MISMATCH: error(412, false, false, 'NONE'),
  PROVIDER_CONFIRMATION_CONFLICT: error(409, false, true, 'CONTACT_SUPPORT'),
  REFERRAL_REQUEST_NOT_FOUND: error(404, false, false, 'NONE'),
  REFERRAL_STATE_CONFLICT: error(409, true, true, 'REFRESH_RESOURCE'),
  REFERRAL_TRANSITION_INVALID: error(409, false, true, 'REFRESH_RESOURCE'),
  NO_FINAL_RESUME: error(409, true, true, 'UPLOAD_RESUME'),
  RESUME_PROCESSING: error(409, true, false, 'WAIT_FOR_RESOURCE'),
  VERSION_NOT_READY: error(409, true, false, 'WAIT_FOR_RESOURCE'),
  RESUME_VERSION_STALE: error(409, true, true, 'REFRESH_RESOURCE'),
  // 附件释出的收件域名在运营拒绝清单里。
  //
  // 与 ACCESS_DENIED 分开：那一条说的是「你这个账号角色不能碰这个资源」，而这里
  // 账号完全有权，是**这个收件人**不许收。混成一条会让用户去查自己的权限，
  // 而真正该改的是清单。
  ATTACHMENT_TARGET_NOT_ALLOWED: error(403, false, true, 'CONTACT_SUPPORT'),
  // 这一页拿不到这封求职信（2026-09-27，按页面附求职信）：不是这个人的、还没就绪、写给的是
  // 别的岗位或别的页面，或者资料删除后已不可读。几种情况答同一个码，不向调用方透露是哪一种。
  COVER_LETTER_NOT_FOUND: error(404, false, true, 'REFRESH_RESOURCE'),
  LIBRARY_REVISION_MISMATCH: error(409, true, true, 'REFRESH_RESOURCE'),
  RESUME_TRACK_NOT_FOUND: error(404, false, true, 'REFRESH_RESOURCE'),
  RESUME_TRACK_LIMIT_REACHED: error(409, false, true, 'REFRESH_RESOURCE'),
  RESUME_TRACK_ARCHIVED: error(409, false, true, 'REFRESH_RESOURCE'),
  RESUME_TRACK_NOT_ARCHIVED: error(409, false, true, 'REFRESH_RESOURCE'),
  RESUME_DEFAULT_REPLACEMENT_REQUIRED: error(409, false, true, 'REFRESH_RESOURCE'),
  RESUME_VERSION_NOT_FOUND: error(404, false, true, 'REFRESH_RESOURCE'),
  RESUME_GENERATION_IDEMPOTENCY_CONFLICT: error(409, false, true, 'REFRESH_RESOURCE'),
  PROFILE_EVIDENCE_REQUIRED: error(409, false, true, 'REVIEW_PROFILE'),
  PROFILE_REVISION_MISMATCH: error(412, true, true, 'REVIEW_PROFILE'),
  PROFILE_DELETION_EPOCH_MISMATCH: error(412, false, true, 'REVIEW_PROFILE'),
  PROFILE_IMPORT_RECONFIRMATION_REQUIRED: error(412, false, true, 'REVIEW_PROFILE'),
  // Pure-AI resume import (2026-10-01, argoland profileImport.ts).
  PROFILE_IMPORT_NOT_FOUND: error(404, false, false, 'NONE'),
  PROFILE_IMPORT_STATE_CONFLICT: error(409, true, true, 'REFRESH_RESOURCE'),
  // Not the student's own uploaded PDF within the size limit; the portal falls back to the review flow.
  PROFILE_IMPORT_UNSUPPORTED_RESUME: error(422, false, true, 'NONE'),
  // The Profile no longer holds what the question was asked about.
  PROFILE_IMPORT_ISSUE_STALE: error(409, false, true, 'REFRESH_RESOURCE'),
  /* Account preferences carry their own revision, so a stale save there must not
     tell the client to refresh the profile's. */
  PROFILE_PREFERENCES_REVISION_MISMATCH: error(412, true, true, 'REVIEW_PROFILE'),
  TELEMETRY_DISABLED: error(503, false, false, 'NONE'),
  TELEMETRY_PROVIDER_UNAVAILABLE: error(503, true, false, 'WAIT_AND_RETRY'),
} as const;

export type AgentErrorCode = keyof typeof AGENT_ERROR_DEFINITIONS;
export type AgentErrorDefinition<C extends AgentErrorCode> = (typeof AGENT_ERROR_DEFINITIONS)[C];

export interface AgentErrorEnvelopeFor<C extends AgentErrorCode> extends AgentSchemaEnvelope {
  readonly statusCode: AgentErrorDefinition<C>['statusCode'];
  readonly code: C;
  /** Display copy only; clients branch on code, never on this text. */
  readonly message: string;
  readonly retryable: AgentErrorDefinition<C>['retryable'];
  readonly requiresUserAction: AgentErrorDefinition<C>['requiresUserAction'];
  readonly recommendedAction: AgentErrorDefinition<C>['recommendedAction'];
  readonly requestId: string;
  readonly details?: AgentErrorDetails;
}

export type AgentErrorEnvelope = {
  [C in AgentErrorCode]: AgentErrorEnvelopeFor<C>;
}[AgentErrorCode];

export const COMMON_PRIVATE_ERROR_CODES = [
  'VALIDATION_FAILED',
  'LOGIN_REQUIRED',
  'ACCOUNT_UNAVAILABLE',
  'RATE_LIMITED',
  'AGENT_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const satisfies readonly AgentErrorCode[];

/** Stable bearer-v2 admission outcomes; messages and subject/session values are never exposed. */
export const BEARER_SUBJECT_OWNER_ADMISSION_ERROR_CODES = [
  'LOGIN_REQUIRED',
  'ACCOUNT_UNAVAILABLE',
  'AGENT_UNAVAILABLE',
] as const satisfies readonly AgentErrorCode[];
