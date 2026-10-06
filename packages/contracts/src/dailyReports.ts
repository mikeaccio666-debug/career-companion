/** Executable Daily Report wire authority; semantics and endpoint policy live in AGENT-API-CONTRACT.md §3.7. */

import type {
  AgentSchemaEnvelope,
  DecimalString,
  IsoDateTime,
  LocalDate,
  OpaqueCursor,
  Uuid,
} from './common.ts';
import type { IanaTimeZone } from './ianaTimeZones.ts';

declare const dailyReportIdBrand: unique symbol;
declare const dailyReportItemIdBrand: unique symbol;
declare const dailyReportCalendarEventIdBrand: unique symbol;

export const DAILY_REPORT_SCHEMA_VERSION = 1 as const;
/** Raw owner-scoped facts fetched per source; queries must request cap + 1 to prove no overflow. */
export const DAILY_REPORT_SOURCE_FACT_QUERY_CAP = 200 as const;
/** Maximum items in any one ordered report section. Overflow fails closed; it is never truncated. */
export const DAILY_REPORT_GROUP_ITEM_CAP = 100 as const;
/** Maximum items across the complete report. Overflow fails closed; it is never truncated. */
export const DAILY_REPORT_TOTAL_ITEM_CAP = 200 as const;
export const DAILY_REPORT_UNREAD_DEFAULT_LIMIT = 20 as const;
export const DAILY_REPORT_UNREAD_MAX_LIMIT = 50 as const;

/**
 * Stable control-only reasons for a fail-closed `ROUTING_REJECTED` run.
 * These values may be persisted and used as bounded metric labels; they must
 * never contain owner, report, source, or other Data-L1 values.
 */
export const DAILY_REPORT_ROUTING_REJECTION_REASONS = [
  'OWNER_MISMATCH',
  'IDENTITY_MISMATCH',
  'FACT_INVALID',
  'MISSING_CONVERSATION',
  'AMBIGUOUS_CONVERSATION',
  'DUPLICATE_FACT',
  'SOURCE_LIMIT_EXCEEDED',
  'PREFERENCE_SUPERSEDED',
  'OWNER_UNAVAILABLE',
  'ROLE_CONVERSATION_UNAVAILABLE',
  'REPORT_WINDOW_EXPIRED',
] as const;
export type DailyReportRoutingRejectionReason =
  (typeof DAILY_REPORT_ROUTING_REJECTION_REASONS)[number];

/** `dr1_` followed by the lowercase SHA-256 identity defined in source §1. */
export type DailyReportId = `dr1_${string}` & {
  readonly [dailyReportIdBrand]: 'DailyReportId';
};
/** `dri1_` followed by the lowercase SHA-256 identity defined in source §1. */
export type DailyReportItemId = `dri1_${string}` & {
  readonly [dailyReportItemIdBrand]: 'DailyReportItemId';
};
/** Bounded opaque Calendar control identity; it is not a Calendar domain model. */
export type DailyReportCalendarEventId = string & {
  readonly [dailyReportCalendarEventIdBrand]: 'DailyReportCalendarEventId';
};

export function parseDailyReportId(value: unknown): DailyReportId | null {
  return typeof value === 'string' && /^dr1_[0-9a-f]{64}$/.test(value)
    ? value as DailyReportId
    : null;
}

export function parseDailyReportItemId(value: unknown): DailyReportItemId | null {
  return typeof value === 'string' && /^dri1_[0-9a-f]{64}$/.test(value)
    ? value as DailyReportItemId
    : null;
}

export function parseDailyReportCalendarEventId(value: unknown): DailyReportCalendarEventId | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
    ? value as DailyReportCalendarEventId
    : null;
}

export const DAILY_REPORT_SECTION_CODES = ['NEEDS_ACTION', 'TODAY', 'YESTERDAY'] as const;
export type DailyReportSectionCode = (typeof DAILY_REPORT_SECTION_CODES)[number];

export const DAILY_REPORT_SECTION_CODE_SEQUENCES = [
  ['NEEDS_ACTION'],
  ['TODAY'],
  ['YESTERDAY'],
  ['NEEDS_ACTION', 'TODAY'],
  ['NEEDS_ACTION', 'YESTERDAY'],
  ['TODAY', 'YESTERDAY'],
  ['NEEDS_ACTION', 'TODAY', 'YESTERDAY'],
] as const;

export const DAILY_REPORT_ITEM_CODES = [
  'MISSION_NEEDS_USER_INPUT',
  'CALENDAR_EVENT_TODAY',
  'APPLICATION_SUBMISSION_CONFIRMED',
  'APPLICATION_RETRY_REQUIRED',
] as const;
export type DailyReportItemCode = (typeof DAILY_REPORT_ITEM_CODES)[number];

export const DAILY_REPORT_SOURCE_TYPES = [
  'MISSION_STEP',
  'CALENDAR_EVENT',
  'APPLICATION_RECEIPT',
] as const;
export type DailyReportSourceType = (typeof DAILY_REPORT_SOURCE_TYPES)[number];

export const DAILY_REPORT_PRIMARY_ACTION_CODES = ['OPEN_APPLICATIONS', 'OPEN_CALENDAR'] as const;
export type DailyReportPrimaryActionCode = (typeof DAILY_REPORT_PRIMARY_ACTION_CODES)[number];

export interface DailyReportMissionNeedsUserInputItem {
  readonly itemId: DailyReportItemId;
  readonly code: 'MISSION_NEEDS_USER_INPUT';
  readonly source: {
    readonly type: 'MISSION_STEP';
    readonly missionId: Uuid;
    readonly missionStepId: Uuid;
    readonly missionRevision: DecimalString;
  };
  readonly primaryAction: { readonly code: 'OPEN_APPLICATIONS' };
}

export interface DailyReportCalendarEventTodayItem {
  readonly itemId: DailyReportItemId;
  readonly code: 'CALENDAR_EVENT_TODAY';
  readonly source: {
    readonly type: 'CALENDAR_EVENT';
    readonly eventId: DailyReportCalendarEventId;
    readonly startsAt: IsoDateTime;
    readonly endsAt: IsoDateTime;
  };
  readonly primaryAction: { readonly code: 'OPEN_CALENDAR' };
}

export interface DailyReportApplicationSubmissionConfirmedItem {
  readonly itemId: DailyReportItemId;
  readonly code: 'APPLICATION_SUBMISSION_CONFIRMED';
  readonly source: {
    readonly type: 'APPLICATION_RECEIPT';
    /** Permanent owner + canonical-job Application identity. */
    readonly applicationId: Uuid;
    /** Evidence selected for this report item. */
    readonly receiptId: Uuid;
    /** Origin Mission retained for trace/navigation; it is not item identity. */
    readonly missionId: Uuid;
    readonly verifiedAt: IsoDateTime;
  };
  readonly primaryAction: { readonly code: 'OPEN_APPLICATIONS' };
}

export interface DailyReportApplicationRetryRequiredItem {
  readonly itemId: DailyReportItemId;
  readonly code: 'APPLICATION_RETRY_REQUIRED';
  readonly source: {
    readonly type: 'APPLICATION_RECEIPT';
    /** Permanent owner + canonical-job Application identity. */
    readonly applicationId: Uuid;
    /** Evidence selected for this report item. */
    readonly receiptId: Uuid;
    /** Origin Mission retained for trace/navigation; it is not item identity. */
    readonly missionId: Uuid;
    /** Server-owned time when this retry receipt was accepted/recorded; not a provider failure time. */
    readonly receivedAt: IsoDateTime;
  };
  readonly primaryAction: { readonly code: 'OPEN_APPLICATIONS' };
}

export type DailyReportItem =
  | DailyReportMissionNeedsUserInputItem
  | DailyReportCalendarEventTodayItem
  | DailyReportApplicationSubmissionConfirmedItem
  | DailyReportApplicationRetryRequiredItem;

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export interface DailyReportNeedsActionSection {
  readonly code: 'NEEDS_ACTION';
  readonly items: NonEmptyReadonlyArray<DailyReportMissionNeedsUserInputItem>;
}

export interface DailyReportTodaySection {
  readonly code: 'TODAY';
  readonly items: NonEmptyReadonlyArray<DailyReportCalendarEventTodayItem>;
}

export interface DailyReportYesterdaySection {
  readonly code: 'YESTERDAY';
  readonly items: NonEmptyReadonlyArray<
    DailyReportApplicationSubmissionConfirmedItem | DailyReportApplicationRetryRequiredItem
  >;
}

/** The seven nonempty ordered subsets of NEEDS_ACTION → TODAY → YESTERDAY. */
export type DailyReportSectionSequence =
  | readonly [DailyReportNeedsActionSection]
  | readonly [DailyReportTodaySection]
  | readonly [DailyReportYesterdaySection]
  | readonly [DailyReportNeedsActionSection, DailyReportTodaySection]
  | readonly [DailyReportNeedsActionSection, DailyReportYesterdaySection]
  | readonly [DailyReportTodaySection, DailyReportYesterdaySection]
  | readonly [DailyReportNeedsActionSection, DailyReportTodaySection, DailyReportYesterdaySection];

export interface DailyReportMessagePart {
  readonly partId: Uuid;
  readonly type: 'daily_report';
  readonly reportSchemaVersion: 1;
  readonly reportId: DailyReportId;
  readonly localDate: LocalDate;
  readonly primaryTimezone: IanaTimeZone;
  readonly sections: DailyReportSectionSequence;
}

export type DailyReportPreferenceView =
  | {
    readonly revision: DecimalString;
    readonly enabled: false;
    readonly primaryTimezone: IanaTimeZone | null;
  }
  | {
    readonly revision: DecimalString;
    readonly enabled: true;
    readonly primaryTimezone: IanaTimeZone;
  };

export const DAILY_REPORT_PREFERENCE_RECONCILIATION_STATES = [
  'TIMEZONE_SNAPSHOT_DRIFT',
] as const;

/**
 * Read-only recovery view for an enabled schedule whose derived timezone
 * snapshot no longer matches the Profile authority. Only a disabling PATCH is
 * valid from this state; the current revision remains available for CAS.
 */
export interface DailyReportPreferenceTimeZoneSnapshotDriftView {
  readonly revision: DecimalString;
  readonly enabled: true;
  readonly primaryTimezone: IanaTimeZone | null;
  readonly reconciliationState: 'TIMEZONE_SNAPSHOT_DRIFT';
}

export type DailyReportPreferenceReadView =
  | DailyReportPreferenceView
  | DailyReportPreferenceTimeZoneSnapshotDriftView;

export interface GetDailyReportPreferenceResponse extends AgentSchemaEnvelope {
  readonly preference: DailyReportPreferenceReadView;
}

export type UpdateDailyReportPreferenceRequest =
  | {
    readonly expectedRevision: DecimalString;
    readonly enabled: false;
    readonly primaryTimezone: IanaTimeZone | null;
  }
  | {
    readonly expectedRevision: DecimalString;
    readonly enabled: true;
    readonly primaryTimezone: IanaTimeZone;
  };

export interface UpdateDailyReportPreferenceResponse extends AgentSchemaEnvelope {
  readonly preference: DailyReportPreferenceView;
}

/**
 * Independent per-report Email delivery preference. Absence in the persisted
 * UserProfile preferences object is projected as `enabled: true` to preserve
 * the pre-T12-2 delivery semantics; the global notificationEmail kill switch
 * is deliberately not part of this wire.
 */
export interface DailyReportEmailPreferenceView {
  readonly enabled: boolean;
}

export interface GetDailyReportEmailPreferenceResponse extends AgentSchemaEnvelope {
  readonly preference: DailyReportEmailPreferenceView;
}

export interface UpdateDailyReportEmailPreferenceRequest {
  readonly enabled: boolean;
}

export interface UpdateDailyReportEmailPreferenceResponse extends AgentSchemaEnvelope {
  readonly preference: DailyReportEmailPreferenceView;
}

interface DailyReportDeliveryBase {
  readonly reportId: DailyReportId;
  readonly conversationId: Uuid;
  readonly messageId: Uuid;
  readonly localDate: LocalDate;
  readonly createdAt: IsoDateTime;
}

export type DailyReportUnreadDeliveryView = DailyReportDeliveryBase & {
  readonly status: 'UNREAD';
  readonly readAt: null;
};

export type DailyReportReadDeliveryView = DailyReportDeliveryBase & {
  readonly status: 'READ';
  readonly readAt: IsoDateTime;
};

export type DailyReportDeliveryView = DailyReportUnreadDeliveryView | DailyReportReadDeliveryView;
export const DAILY_REPORT_DELIVERY_STATUSES = ['UNREAD', 'READ'] as const;
export type DailyReportDeliveryStatus = (typeof DAILY_REPORT_DELIVERY_STATUSES)[number];

export interface ListUnreadDailyReportsQuery {
  readonly cursor?: OpaqueCursor;
  readonly limit?: number;
}

export interface ListUnreadDailyReportsResponse extends AgentSchemaEnvelope {
  readonly items: readonly DailyReportUnreadDeliveryView[];
  readonly page: {
    readonly nextCursor: OpaqueCursor | null;
    readonly hasMore: boolean;
  };
}

export interface RecordDailyReportReadParams {
  readonly reportId: DailyReportId;
}

export interface RecordDailyReportReadRequest {
  readonly conversationId: Uuid;
  readonly messageId: Uuid;
}

export interface RecordDailyReportReadResponse extends AgentSchemaEnvelope {
  readonly delivery: DailyReportReadDeliveryView;
}
