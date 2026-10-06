import type {
  AgentSchemaEnvelope,
  DecimalString,
  IsoDateTime,
  Uuid,
} from './common.ts';
import type { IanaTimeZone } from './ianaTimeZones.ts';

export const REFERRAL_REQUEST_STATUSES = [
  'REQUESTED',
  'IN_REVIEW',
  'CONTACTED',
  'COFFEE_CHAT_SCHEDULED',
  'COMPLETED',
  'UNAVAILABLE',
  'CANCELLED',
] as const;
export type ReferralRequestStatus = (typeof REFERRAL_REQUEST_STATUSES)[number];

export const REFERRAL_RESOLUTION_CODES = [
  'MANUAL_PROCESS_COMPLETED',
  'NO_CURRENT_RESOURCE',
  'POSITION_NOT_SUPPORTED',
  'STUDENT_NOT_ELIGIBLE',
  'REQUEST_WITHDRAWN',
  'DUPLICATE_REQUEST',
] as const;
export type ReferralResolutionCode = (typeof REFERRAL_RESOLUTION_CODES)[number];

export interface CreateReferralRequestRequest {
  readonly jobId: string;
}

export interface CreateReferralRequestResponse extends AgentSchemaEnvelope {
  readonly referralRequestId: Uuid;
  readonly created: boolean;
  readonly status: ReferralRequestStatus;
  readonly requestedAt: IsoDateTime;
  readonly notificationSent: true;
}

export interface ReferralRequestParams {
  readonly referralRequestId: Uuid;
}

export interface ReferralRequestView extends AgentSchemaEnvelope {
  readonly referralRequestId: Uuid;
  readonly jobId: string;
  readonly status: ReferralRequestStatus;
  readonly revision: DecimalString;
  readonly requestedAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly notificationSent: boolean;
}

export interface AdminReferralRequestView extends ReferralRequestView {
  readonly ownerUserId: Uuid;
  /** Admin-only Data-L1. Never log, cache, place in URLs, analytics, or audit metadata. */
  readonly studentEmail: string;
  readonly studentResume: ReferralResumeView | null;
  readonly jobDescription: string | null;
  readonly resolutionCode: ReferralResolutionCode | null;
  /** Present only while the separate default-off T14-8 runtime is enabled. */
  readonly referralOutcome?: ReferralOutcomeView;
}

export interface ReferralResumeView {
  readonly resumeVersionId: Uuid;
  readonly fileName: string;
  readonly text: string;
}

export const REFERRAL_OUTCOME_STATUSES = [
  'UNKNOWN',
  'PENDING',
  'MENTOR_DECLINED',
  'REFERRAL_UNAVAILABLE',
  'EXPIRED',
  'CANCELLED',
  'REFERRED',
  'INTERVIEW',
  'FINAL_ROUND',
  'OFFER',
  'HIRED',
  'REJECTED',
] as const;
export type ReferralOutcomeStatus = (typeof REFERRAL_OUTCOME_STATUSES)[number];

export const REFERRAL_OUTCOME_EVIDENCE_SOURCES = [
  'MENTOR_CONFIRMATION',
  'EMPLOYER_CONFIRMATION',
  'STUDENT_CONFIRMATION',
  'ADMIN_OPERATIONAL_RECORD',
] as const;
export type ReferralOutcomeEvidenceSource =
  (typeof REFERRAL_OUTCOME_EVIDENCE_SOURCES)[number];

export const REFERRAL_OUTCOME_PROJECTION_STATES = [
  'NOT_APPLICABLE',
  'APPLIED',
  'UNRESOLVED',
] as const;
export type ReferralOutcomeProjectionState =
  (typeof REFERRAL_OUTCOME_PROJECTION_STATES)[number];

export const REFERRAL_OUTCOME_PROJECTION_REASONS = [
  'NO_APPLICATION_PROJECTION',
  'EXACT_APPLICATION_MATCHED',
  'CANONICAL_JOB_NOT_FOUND',
  'APPLICATION_NOT_FOUND',
  'APPLICATION_IDENTITY_CONFLICT',
] as const;
export type ReferralOutcomeProjectionReason =
  (typeof REFERRAL_OUTCOME_PROJECTION_REASONS)[number];

export interface ReferralOutcomeView {
  readonly status: ReferralOutcomeStatus;
  readonly evidenceSource: ReferralOutcomeEvidenceSource | null;
  readonly revision: DecimalString;
  readonly recordedAt: IsoDateTime | null;
  readonly projectionState: ReferralOutcomeProjectionState;
  readonly projectionReason: ReferralOutcomeProjectionReason;
  readonly applicationId: Uuid | null;
}

export interface UpdateAdminReferralOutcomeRequest {
  readonly expectedRevision: DecimalString;
  readonly status: ReferralOutcomeStatus;
  readonly evidenceSource: ReferralOutcomeEvidenceSource;
}

export interface UpdateAdminReferralOutcomeResponse extends AgentSchemaEnvelope {
  readonly outcome: ReferralOutcomeView;
}

export interface ListAdminReferralRequestsQuery {
  readonly cursor?: Uuid;
  readonly limit?: number;
}

export interface ListAdminReferralRequestsResponse extends AgentSchemaEnvelope {
  readonly items: readonly AdminReferralRequestView[];
  readonly nextCursor: Uuid | null;
}

export interface UpdateAdminReferralRequestRequest {
  readonly expectedRevision: DecimalString;
  readonly status: ReferralRequestStatus;
  readonly resolutionCode?: ReferralResolutionCode;
}

/** T14 Mentor workflow stays separately named while T13 owns the Ops lifecycle status. */
export const REFERRAL_MENTOR_WORKFLOW_STATUSES = [
  'REQUESTED',
  'MENTOR_CONTACTING',
  'MENTOR_CONFIRMED',
  'COFFEE_CHAT_SCHEDULING',
  'COFFEE_CHAT_COMPLETED',
  'REFERRAL_IN_PROGRESS',
  'COMPLETED',
  'DECLINED',
  'CANCELLED',
  'NEEDS_INFORMATION',
] as const;
export type ReferralMentorWorkflowStatus =
  (typeof REFERRAL_MENTOR_WORKFLOW_STATUSES)[number];

export const REFERRAL_MENTOR_DECISIONS = [
  'APPROVE',
  'REQUEST_CHANGE',
  'DECLINE',
] as const;
export type ReferralMentorDecision = (typeof REFERRAL_MENTOR_DECISIONS)[number];

export const REFERRAL_COFFEE_CHAT_SLOT_STATUSES = [
  'OFFERED',
  'SELECTED',
  'CANCELLED',
] as const;
export type ReferralCoffeeChatSlotStatus =
  (typeof REFERRAL_COFFEE_CHAT_SLOT_STATUSES)[number];

export const REFERRAL_MEETING_PROVIDERS = ['GOOGLE_MEET', 'ZOOM'] as const;
export type ReferralMeetingProvider = (typeof REFERRAL_MEETING_PROVIDERS)[number];

export const REFERRAL_GUARANTEE_STATES = [
  'ON_TRACK',
  'COFFEE_CHAT_ARRANGED',
  'REFERRAL_COMPLETED',
  'REMEDY_AVAILABLE',
  'REFUND_REQUESTED',
] as const;
export type ReferralGuaranteeState = (typeof REFERRAL_GUARANTEE_STATES)[number];

export const REFERRAL_GUARANTEE_REMEDIES = ['REFUND', 'REMATCH'] as const;
export type ReferralGuaranteeRemedy = (typeof REFERRAL_GUARANTEE_REMEDIES)[number];

export const REFERRAL_GUARANTEE_REMEDY_REASONS = [
  'THREE_DAY_SLA_MISSED',
  'MENTOR_DECLINED',
] as const;
export type ReferralGuaranteeRemedyReason =
  (typeof REFERRAL_GUARANTEE_REMEDY_REASONS)[number];

/**
 * T14-10 guarantees a referral for the request's exact company and job.
 * Coffee Chat satisfies the 72-hour service SLA, but only an explicit
 * Mentor/Admin completion satisfies the referral guarantee itself.
 */
export interface ReferralGuaranteeView {
  readonly state: ReferralGuaranteeState;
  readonly deadlineAt: IsoDateTime;
  readonly attempt: number;
  readonly revision: DecimalString;
  readonly remedyReason: ReferralGuaranteeRemedyReason | null;
  readonly lastRemedy: ReferralGuaranteeRemedy | null;
}

export interface AdminReferralMentorBindingItem {
  readonly referralRequestId: Uuid;
  readonly mentorUserId: Uuid | null;
  readonly mentorDecision: ReferralMentorDecision | null;
  readonly selectedCoffeeChatSlotId: Uuid | null;
  readonly revision: DecimalString;
  /** Present only while the separate default-off T14-10 runtime is enabled. */
  readonly guarantee?: ReferralGuaranteeView;
}

export interface ReferralRequestPathParams {
  readonly referralRequestId: Uuid;
}

export interface ListAdminReferralMentorBindingsResponse extends AgentSchemaEnvelope {
  readonly items: readonly AdminReferralMentorBindingItem[];
}

export interface UpdateAdminReferralMentorBindingRequest {
  readonly expectedRevision: DecimalString;
  readonly mentorUserId: Uuid | null;
  readonly reasonCode: 'MENTOR_ASSIGNED' | 'MENTOR_REASSIGNED' | 'MENTOR_UNASSIGNED';
}

export interface UpdateAdminReferralMentorBindingResponse extends AgentSchemaEnvelope {
  readonly binding: AdminReferralMentorBindingItem;
}

export interface ReferralCoffeeChatSlotItem {
  readonly slotId: Uuid;
  readonly startAt: IsoDateTime;
  readonly endAt: IsoDateTime;
  readonly timeZone: IanaTimeZone;
  readonly status: ReferralCoffeeChatSlotStatus;
  readonly meetingProvider: ReferralMeetingProvider | null;
  /** Owner/Mentor only after selection. Never log, audit, or place in queue payloads. */
  readonly meetingUrl: string | null;
}

export interface MentorReferralRequestItem {
  readonly referralRequestId: Uuid;
  readonly studentReferenceId: Uuid;
  readonly jobId: string;
  readonly jobTitle: string | null;
  readonly company: string | null;
  /** Exact assigned-request Data-L1. Never log, cache, place in URLs, analytics, or audit metadata. */
  readonly studentEmail: string;
  readonly studentPhone: string | null;
  readonly studentResume: ReferralResumeView | null;
  readonly status: ReferralMentorWorkflowStatus;
  readonly mentorDecision: ReferralMentorDecision | null;
  readonly revision: DecimalString;
  readonly slots: readonly ReferralCoffeeChatSlotItem[];
}

export interface ListMentorReferralRequestsResponse extends AgentSchemaEnvelope {
  readonly items: readonly MentorReferralRequestItem[];
}

export interface DecideMentorReferralRequestRequest {
  readonly expectedRevision: DecimalString;
  readonly decision: ReferralMentorDecision;
}

export interface DecideMentorReferralRequestResponse extends AgentSchemaEnvelope {
  readonly request: MentorReferralRequestItem;
}

export interface CompleteMentorReferralRequestRequest {
  readonly expectedRevision: DecimalString;
}

export interface CompleteMentorReferralRequestResponse extends AgentSchemaEnvelope {
  readonly request: MentorReferralRequestItem;
}

export interface ReferralCoffeeChatSlotProposal {
  readonly startAt: IsoDateTime;
  readonly endAt: IsoDateTime;
  readonly timeZone: IanaTimeZone;
}

export interface ReplaceMentorCoffeeChatSlotsRequest {
  readonly expectedRevision: DecimalString;
  readonly slots: readonly ReferralCoffeeChatSlotProposal[];
}

export interface ReplaceMentorCoffeeChatSlotsResponse extends AgentSchemaEnvelope {
  readonly request: MentorReferralRequestItem;
}

export interface SetMentorCoffeeChatMeetingUrlRequest {
  readonly expectedRevision: DecimalString;
  readonly meetingUrl: string;
}

export interface SetMentorCoffeeChatMeetingUrlResponse extends AgentSchemaEnvelope {
  readonly request: MentorReferralRequestItem;
}

export interface StudentReferralCoffeeChatItem {
  readonly referralRequestId: Uuid;
  readonly jobId: string;
  readonly jobTitle: string | null;
  readonly company: string | null;
  readonly status: ReferralMentorWorkflowStatus;
  readonly revision: DecimalString;
  readonly slots: readonly ReferralCoffeeChatSlotItem[];
  /** Present only while the separate default-off T14-10 runtime is enabled. */
  readonly guarantee?: ReferralGuaranteeView;
  /** Present only while the separate default-off T14-8 runtime is enabled. */
  readonly referralOutcome?: ReferralOutcomeView;
}

export interface ListStudentReferralCoffeeChatsResponse extends AgentSchemaEnvelope {
  readonly items: readonly StudentReferralCoffeeChatItem[];
}

/** Supplying limit opts into complete bounded pages; an unpaginated read keeps its legacy shape. */
export interface ListStudentReferralCoffeeChatsQuery {
  readonly limit?: number;
  readonly cursor?: Uuid;
}

export interface ListStudentReferralCoffeeChatsPageResponse extends ListStudentReferralCoffeeChatsResponse {
  readonly nextCursor: Uuid | null;
}

export interface SelectStudentCoffeeChatSlotRequest {
  readonly expectedRevision: DecimalString;
  readonly slotId: Uuid;
}

export interface SelectStudentCoffeeChatSlotResponse extends AgentSchemaEnvelope {
  readonly request: StudentReferralCoffeeChatItem;
}

export interface SelectReferralGuaranteeRemedyRequest {
  readonly expectedRevision: DecimalString;
  readonly remedy: ReferralGuaranteeRemedy;
}

export interface SelectReferralGuaranteeRemedyResponse extends AgentSchemaEnvelope {
  readonly request: StudentReferralCoffeeChatItem;
}
