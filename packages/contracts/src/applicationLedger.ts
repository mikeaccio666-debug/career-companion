/**
 * T11 Application Ledger and provider-confirmation wire contracts.
 *
 * The client receipt remains the immutable source fact. A complete trusted
 * confirmation projects an effective SUBMISSION_CONFIRMED outcome without
 * rewriting that source outcome.
 */

import type {
  AgentErrorCode,
  AgentSchemaEnvelope,
  DecimalString,
  IsoDateTime,
  Sha256Digest,
  Uuid,
} from './common.ts';
import type {
  ApplicationReceiptOutcomeCode,
  ReceiptVerificationLevel,
} from './executionIntent.ts';
import type { IanaTimeZone } from './ianaTimeZones.ts';

export const APPLICATION_LEDGER_STATUSES = [
  'VERIFIED',
  'SUBMITTED_UNVERIFIED',
  'OUTCOME_UNKNOWN',
  'PARTIAL',
  'FAILED',
  'BLOCKED',
] as const;
export type ApplicationLedgerStatus = (typeof APPLICATION_LEDGER_STATUSES)[number];

export const APPLICATION_LEDGER_DATE_STATES = [
  'KNOWN',
  'UNKNOWN_MISSING_SUBMITTED_AT',
  'UNKNOWN_MISSING_TIME_ZONE',
  'UNKNOWN_CONFLICT',
  'UNKNOWN_EVIDENCE',
] as const;
export type ApplicationLedgerDateState =
  (typeof APPLICATION_LEDGER_DATE_STATES)[number];

export const APPLICATION_LEDGER_MILESTONES = [
  'INTERVIEW',
  'FINAL_ROUND',
  'OFFER',
] as const;
export type ApplicationLedgerMilestone =
  (typeof APPLICATION_LEDGER_MILESTONES)[number];

export const APPLICATION_LEDGER_OUTCOMES = [
  'ACCEPTED',
  'DECLINED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type ApplicationLedgerOutcome =
  (typeof APPLICATION_LEDGER_OUTCOMES)[number];

export type EffectiveApplicationReceiptOutcomeCode =
  | ApplicationReceiptOutcomeCode
  | 'SUBMISSION_CONFIRMED';

export interface ApplicationLedgerReceiptView {
  readonly receiptId: Uuid;
  readonly sourceOutcome: ApplicationReceiptOutcomeCode;
  readonly effectiveOutcome: EffectiveApplicationReceiptOutcomeCode;
  readonly verificationLevel: ReceiptVerificationLevel;
  /** Provider-authoritative time; null unless the confirmation envelope is valid. */
  readonly submittedAt: IsoDateTime | null;
  readonly verifiedAt: IsoDateTime | null;
}

/** Current display material checked at read time; never historical receipt evidence. */
export interface ApplicationLedgerJobSummary {
  readonly canonicalJobId: Uuid;
  readonly canonicalJobRevision: DecimalString;
  readonly listingId: Uuid;
  readonly listingGenerationKey: string;
  readonly descriptionDigest: Sha256Digest;
  readonly title: string;
  readonly company: string;
  readonly checkedAt: IsoDateTime;
  readonly freshUntil: IsoDateTime;
}

/** Recorded referral milestones, never inferred interview dates or provider evidence. */
export interface ApplicationLedgerActivity {
  readonly source: 'REFERRAL';
  /** At most one first recording per milestone, in canonical milestone order. */
  readonly milestones: readonly Readonly<{
    milestone: ApplicationLedgerMilestone;
    recordedAt: IsoDateTime;
  }>[];
}

export interface ApplicationLedgerItem {
  /** Only included for includeActivity=true; null means unavailable or ambiguous. */
  readonly activity?: ApplicationLedgerActivity | null;
  /** Only included for includeJobSummary=true; null means unavailable. */
  readonly jobSummary?: ApplicationLedgerJobSummary | null;
  readonly applicationId: Uuid;
  readonly canonicalJobId: Uuid;
  readonly applicationBundleVersion: DecimalString;
  readonly status: ApplicationLedgerStatus;
  readonly dateState: ApplicationLedgerDateState;
  readonly firstProviderConfirmedSubmittedAt: IsoDateTime | null;
  readonly receipts: readonly ApplicationLedgerReceiptView[];
  /** Empty until an independent authoritative milestone source exists. */
  readonly milestones: readonly ApplicationLedgerMilestone[];
  /** Null until an independent authoritative employer/user outcome exists. */
  readonly outcome: ApplicationLedgerOutcome | null;
}

export interface ListApplicationLedgerQuery {
  readonly includeActivity?: true;
  readonly includeJobSummary?: true;
  readonly cursor?: Uuid;
  readonly limit?: number;
}

export interface ListApplicationLedgerResponse extends AgentSchemaEnvelope {
  readonly primaryTimeZone: IanaTimeZone | null;
  readonly items: readonly ApplicationLedgerItem[];
  readonly nextCursor: Uuid | null;
}

export interface UpdatePrimaryTimeZoneRequest {
  readonly primaryTimeZone: IanaTimeZone;
}

export interface UpdatePrimaryTimeZoneResponse extends AgentSchemaEnvelope {
  readonly primaryTimeZone: IanaTimeZone;
}

export const PROVIDER_ATTESTATION_SCHEMA_VERSION = 1 as const;
export const PROVIDER_CONFIRMATION_SIGNATURE_HEADER =
  'X-EdAIX-Provider-Signature' as const;
export const PROVIDER_CONFIRMATION_KEY_ID_HEADER =
  'X-EdAIX-Provider-Key-Id' as const;
export const PROVIDER_CONFIRMATION_TIMESTAMP_HEADER =
  'X-EdAIX-Provider-Timestamp' as const;
export const PROVIDER_CONFIRMATION_ENDPOINT = Object.freeze({
  method: 'POST',
  path: '/api/internal/v1/provider-confirmations',
  auth: 'hmac-sha256-v1',
  successStatuses: [200, 201] as const,
});
export const PROVIDER_CONFIRMATION_ERROR_CODES = [
  'VALIDATION_FAILED',
  'PROVIDER_CONFIRMATION_DISABLED',
  'PROVIDER_ATTESTATION_INVALID',
  'PROVIDER_ATTESTATION_STALE',
  'PROVIDER_CONFIRMATION_NOT_FOUND',
  'PROVIDER_CONFIRMATION_SCOPE_MISMATCH',
  'PROVIDER_CONFIRMATION_CONFLICT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const satisfies readonly AgentErrorCode[];

/**
 * Raw provider submission id is transient input only. The API validates the
 * signed request, HMACs this value immediately, and never logs or persists it.
 */
export interface ProviderSubmissionAttestationRequest {
  readonly schemaVersion: typeof PROVIDER_ATTESTATION_SCHEMA_VERSION;
  readonly attestationId: Uuid;
  readonly receiptId: Uuid;
  readonly providerSubmissionId: string;
  readonly submittedAt: IsoDateTime;
}

export interface ProviderSubmissionAttestationResponse extends AgentSchemaEnvelope {
  readonly receiptId: Uuid;
  readonly sourceOutcome: 'SUBMISSION_TRIGGERED';
  readonly effectiveOutcome: 'SUBMISSION_CONFIRMED';
  readonly verificationLevel: 'PROVIDER_CONFIRMED';
  readonly submittedAt: IsoDateTime;
  readonly verifiedAt: IsoDateTime;
  readonly evidenceDigest: Sha256Digest;
  readonly replayed: boolean;
}
