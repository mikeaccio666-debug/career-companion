import { ADMIN_POLICY_VERSION_TAG } from './adminPolicies.ts';
import { parseJobCardView } from './job-card.ts';
/** Recommendation batch DTOs mirrored from AGENT-API-CONTRACT.md §3.4. */

import type {
  AgentSchemaEnvelope,
  DecimalString,
  IsoDateTime,
  LocalDate,
  OpaqueCursor,
  Sha256Digest,
  Uuid,
} from './common.ts';
import type { JobCardView } from './conversations.ts';
import { parseIsoDateTime, parseLocalDate, parseSha256Digest, parseUuid } from './common.ts';
/**
 * 「愿不愿意为这份工作换地方」的词表。
 *
 * 原先它长在 `profileV2.ts` 里，因为档案曾经有一组 `mobility.*` 标量。
 * argoland 2026-09 的契约变更把那一组换成了 `referralSource`，档案里不再有它——
 * 而推荐条件这一侧仍然要用。所以它搬到唯一还在用它的地方，
 * 不再跟着一个已经不存在的档案字段走。
 */
export const PROFILE_V2_RELOCATION_MODES = ['NOT_OPEN', 'OPEN_WITHIN_COUNTRIES', 'OPEN_ANYWHERE'] as const;
export type ProfileRelocationModeV2 = (typeof PROFILE_V2_RELOCATION_MODES)[number];
import type { IsoCountryCode } from './sensitiveWrite.ts';

/**
 * Hard response budgets for §3.4 recommendation projections. String budgets
 * count UTF-16 code units; serialized bytes count the exact JSON UTF-8 form.
 */
export const RECOMMENDATION_RESPONSE_LIMITS = Object.freeze({
  maxSerializedUtf8Bytes: 16_777_216,
  maxStringCodeUnits: 8_000_000,
  maxDisplayCodeUnits: 2_000_000,
} as const);

export const RECOMMENDATION_BATCH_STATUSES = [
  'OPEN',
  'PARTIALLY_DECIDED',
  'COMPLETED',
  'EXPIRED',
] as const;
export type RecommendationBatchStatus = (typeof RECOMMENDATION_BATCH_STATUSES)[number];

export const RECOMMENDATION_ITEM_STATUSES = [
  'PENDING',
  'APPROVED',
  'SKIPPED',
  'UNAVAILABLE',
] as const;
export type RecommendationItemStatus = (typeof RECOMMENDATION_ITEM_STATUSES)[number];

export const RECOMMENDATION_DECISIONS = ['APPLY', 'SKIP'] as const;
export type RecommendationDecision = (typeof RECOMMENDATION_DECISIONS)[number];

export const RECOMMENDATION_DECISION_RESULT_CODES = [
  'APPROVED',
  'SKIPPED',
  'ALREADY_DECIDED',
  'JOB_UNAVAILABLE',
  'CONVERSATION_ARCHIVED',
  'STATE_CONFLICT',
] as const;
export type RecommendationDecisionResultCode =
  (typeof RECOMMENDATION_DECISION_RESULT_CODES)[number];

export const RECOMMENDATION_DECISION_ITEM_ERROR_CODES = [
  'JOB_UNAVAILABLE',
  'CONVERSATION_STATE_CONFLICT',
  'RECOMMENDATION_STATE_CONFLICT',
] as const;
export type RecommendationDecisionItemErrorCode =
  (typeof RECOMMENDATION_DECISION_ITEM_ERROR_CODES)[number];

interface RecommendationItemBase {
  readonly id: Uuid;
  readonly revision: DecimalString;
  readonly job: JobCardView;
}
export type RecommendationItemView = RecommendationItemBase & (
  | { readonly status: 'PENDING'; readonly missionId: null; readonly decidedAt: null }
  | { readonly status: 'APPROVED'; readonly missionId: Uuid; readonly decidedAt: IsoDateTime }
  | { readonly status: 'SKIPPED' | 'UNAVAILABLE'; readonly missionId: null; readonly decidedAt: IsoDateTime }
);

export interface RecommendationBatchCounts {
  readonly total: number;
  readonly pending: number;
  readonly approved: number;
  readonly skipped: number;
  readonly unavailable: number;
}

export interface RecommendationBatchView {
  readonly id: Uuid;
  /** Associates the feed batch with its Role conversation; the batch remains authoritative. */
  readonly conversationId: Uuid;
  readonly revision: DecimalString;
  readonly status: RecommendationBatchStatus;
  /** Calendar date in the user's configured timezone, formatted YYYY-MM-DD. */
  readonly localDate: LocalDate;
  readonly generatedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly items: readonly RecommendationItemView[];
  readonly counts: RecommendationBatchCounts;
  readonly updatedAt: IsoDateTime;
  /** `module:version` of the admin policy that produced the batch; null before the policy existed. */
  readonly policyVersion?: string | null;
}

/** §3.4 GET /api/v1/agent/recommendation-batches */
export interface ListRecommendationBatchesQuery {
  /** Optional exact owner-scoped Role conversation filter. */
  readonly conversationId?: Uuid;
  /** Opaque owner/filter-bound pagination cursor. */
  readonly cursor?: OpaqueCursor;
  /** Defaults to 20. */
  readonly limit?: number;
}

export interface ListRecommendationBatchesResponse extends AgentSchemaEnvelope {
  readonly items: readonly RecommendationBatchView[];
  readonly page: {
    readonly nextCursor: OpaqueCursor | null;
    readonly hasMore: boolean;
  };
}

/** §3.4 GET /api/v1/agent/recommendation-batches/:batchId */
export interface GetRecommendationBatchParams {
  readonly batchId: Uuid;
}

export interface GetRecommendationBatchResponse extends AgentSchemaEnvelope {
  readonly batch: RecommendationBatchView;
}

/** §3.4 GET /api/v1/agent/recommendation-batches/:batchId/items/:itemId */
export interface GetRecommendationItemDetailParams {
  readonly batchId: Uuid;
  readonly itemId: Uuid;
}

export interface RecommendationItemDetailView {
  readonly batchId: Uuid;
  readonly conversationId: Uuid;
  readonly itemId: Uuid;
  readonly job: JobCardView;
  readonly canonicalJobId: Uuid;
  readonly canonicalJobRevision: DecimalString;
  readonly listingGenerationKey: string;
  readonly descriptionDigest: Sha256Digest;
  readonly description: string;
}

export interface GetRecommendationItemDetailResponse extends AgentSchemaEnvelope {
  readonly item: RecommendationItemDetailView;
}

/** Shared detail envelope; callers reuse their existing strict JobCard validator. */
export function parseGetRecommendationItemDetailResponse(
  value: unknown,
  validateJobCard: (job: unknown) => boolean,
): GetRecommendationItemDetailResponse | null {
  if (!detailRecord(value, ['schemaVersion', 'item']) || value.schemaVersion !== 1 ||
    !detailRecord(value.item, [
      'batchId', 'conversationId', 'itemId', 'job', 'canonicalJobId',
      'canonicalJobRevision', 'listingGenerationKey', 'descriptionDigest', 'description',
    ])) return null;
  const item = value.item;
  if (!parseUuid(item.batchId) || !parseUuid(item.conversationId) ||
    !parseUuid(item.itemId) || !parseUuid(item.canonicalJobId) ||
    !validateJobCard(item.job) ||
    typeof item.canonicalJobRevision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(item.canonicalJobRevision) ||
    BigInt(item.canonicalJobRevision) > 9_223_372_036_854_775_807n ||
    typeof item.listingGenerationKey !== 'string' ||
    item.listingGenerationKey.trim().length === 0 ||
    [...item.listingGenerationKey].length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(item.listingGenerationKey) ||
    !parseSha256Digest(item.descriptionDigest) ||
    typeof item.description !== 'string' || item.description.trim().length === 0 ||
    [...item.description].length > 30_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item.description)
  ) return null;
  return value as unknown as GetRecommendationItemDetailResponse;
}

function detailRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** §3.4 POST /api/v1/agent/recommendation-batches/refresh */
export interface RefreshRecommendationBatchRequest {
  /** The owned ACTIVE Role conversation whose batch is refreshed. */
  readonly conversationId: Uuid;
}

/** Owner-scoped, per-Role, per-local-day budget of on-demand refreshes. */
export const RECOMMENDATION_REFRESHES_PER_DAY = 2;

export interface RecommendationRefreshView {
  readonly conversationId: Uuid;
  /** Local generation date in the account's primary timezone; the budget day. */
  readonly localDate: LocalDate;
  /** Real UTC instant the refresh was queued; unchanged when an unfinished refresh is returned again. */
  readonly requestedAt: IsoDateTime;
  /** Refreshes still available on `localDate` once this one has finished; while it is in flight a new request returns it again. */
  readonly remainingToday: number;
}

export interface RefreshRecommendationBatchResponse extends AgentSchemaEnvelope {
  readonly refresh: RecommendationRefreshView;
}

/** §3.4 POST /api/v1/agent/recommendation-batches/:batchId/items/:itemId/confirmations */
export const RECOMMENDATION_CONFIRMATION_CRITERIA = ['LOCATION'] as const;
export type RecommendationConfirmationCriterion = (typeof RECOMMENDATION_CONFIRMATION_CRITERIA)[number];
export const RECOMMENDATION_CONFIRMATION_MAX_COUNTRIES = 50;

export interface ConfirmRecommendationItemParams { readonly batchId: Uuid; readonly itemId: Uuid }

/** A LOCATION confirmation writes the owner's mobility facts with USER provenance; at least one field. */
export interface ConfirmRecommendationItemRequest {
  readonly criterion: RecommendationConfirmationCriterion;
  readonly relocationMode?: ProfileRelocationModeV2;
  readonly relocationCountryCodes?: readonly IsoCountryCode[];
  readonly remoteOk?: boolean;
}

export interface ConfirmRecommendationItemResponse extends AgentSchemaEnvelope {
  readonly criterion: RecommendationConfirmationCriterion;
  /** Profile V2 revision after the write. */
  readonly profileRevision: DecimalString;
}

export function parseConfirmRecommendationItemRequest(value: unknown): ConfirmRecommendationItemRequest | null {
  if (!detailRecordSubset(value, ['criterion'], ['relocationMode', 'relocationCountryCodes', 'remoteOk']) ||
    !RECOMMENDATION_CONFIRMATION_CRITERIA.includes(value.criterion as never)) return null;
  const fields = ['relocationMode', 'relocationCountryCodes', 'remoteOk'].filter((key) => Object.hasOwn(value, key));
  if (fields.length === 0) return null;
  if (Object.hasOwn(value, 'relocationMode') && !PROFILE_V2_RELOCATION_MODES.includes(value.relocationMode as never)) return null;
  if (Object.hasOwn(value, 'remoteOk') && typeof value.remoteOk !== 'boolean') return null;
  if (Object.hasOwn(value, 'relocationCountryCodes')) {
    const codes = value.relocationCountryCodes;
    if (!Array.isArray(codes) || codes.length > RECOMMENDATION_CONFIRMATION_MAX_COUNTRIES ||
      !codes.every((code) => typeof code === 'string' && /^[A-Z]{2}$/u.test(code)) ||
      new Set(codes).size !== codes.length) return null;
  }
  return value as unknown as ConfirmRecommendationItemRequest;
}

export function parseConfirmRecommendationItemResponse(value: unknown): ConfirmRecommendationItemResponse | null {
  return detailRecord(value, ['schemaVersion', 'criterion', 'profileRevision']) && value.schemaVersion === 1 &&
    RECOMMENDATION_CONFIRMATION_CRITERIA.includes(value.criterion as never) &&
    typeof value.profileRevision === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(value.profileRevision)
    ? value as unknown as ConfirmRecommendationItemResponse : null;
}

function detailRecordSubset(value: unknown, required: readonly string[], optional: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

/** §3.4 POST /api/v1/agent/recommendation-batches/:batchId/decisions */
export interface DecideRecommendationBatchParams {
  readonly batchId: Uuid;
}

export interface RecommendationItemDecisionRequest {
  readonly itemId: Uuid;
  readonly itemRevision: DecimalString;
  readonly decision: RecommendationDecision;
}

export interface DecideRecommendationBatchRequest {
  readonly clientRequestId: Uuid;
  readonly expectedRevision: DecimalString;
  readonly decisions: readonly RecommendationItemDecisionRequest[];
}

export type RecommendationItemDecisionResult =
  | {
      readonly itemId: Uuid;
      readonly resultCode: 'APPROVED';
      readonly missionId: Uuid;
      readonly errorCode: null;
    }
  | {
      readonly itemId: Uuid;
      readonly resultCode: 'SKIPPED';
      readonly missionId: null;
      readonly errorCode: null;
    }
  | {
      readonly itemId: Uuid;
      readonly resultCode: 'ALREADY_DECIDED';
      readonly missionId: Uuid | null;
      readonly errorCode: null;
    }
  | {
      readonly itemId: Uuid;
      readonly resultCode: 'JOB_UNAVAILABLE';
      readonly missionId: null;
      readonly errorCode: 'JOB_UNAVAILABLE';
    }
  | {
      readonly itemId: Uuid;
      readonly resultCode: 'CONVERSATION_ARCHIVED';
      readonly missionId: null;
      readonly errorCode: 'CONVERSATION_STATE_CONFLICT';
    }
  | {
      readonly itemId: Uuid;
      readonly resultCode: 'STATE_CONFLICT';
      readonly missionId: null;
      readonly errorCode: 'RECOMMENDATION_STATE_CONFLICT';
    };

export interface DecideRecommendationBatchResponse extends AgentSchemaEnvelope {
  readonly batch: RecommendationBatchView;
  readonly results: readonly RecommendationItemDecisionResult[];
}

/** Shared bounded decoder for the exact batch used by a material preparation command. */
export function parseGetRecommendationBatchResponse(value: unknown): GetRecommendationBatchResponse | null {
  const exact = (v: unknown, fields: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === fields.length && fields.every(k=>Object.hasOwn(v,k));
  const revision = (v: unknown) => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n;
  if (!exact(value,['schemaVersion','batch']) || value.schemaVersion !== 1) return null;
  const b=value.batch;
  if (!exact(b,['id','conversationId','revision','status','localDate','generatedAt','expiresAt','items','counts','updatedAt',...(b && typeof b==='object' && Object.hasOwn(b,'policyVersion')?['policyVersion']:[])]) ||
    !parseUuid(b.id) || !parseUuid(b.conversationId) || !revision(b.revision) || !RECOMMENDATION_BATCH_STATUSES.includes(b.status as never) ||
    !parseLocalDate(b.localDate) || !parseIsoDateTime(b.generatedAt) || !parseIsoDateTime(b.expiresAt) ||
    Date.parse(String(b.expiresAt)) <= Date.parse(String(b.generatedAt)) || !parseIsoDateTime(b.updatedAt) ||
    !Array.isArray(b.items) || b.items.length > 500) return null;
  if(Object.hasOwn(b,'policyVersion') && b.policyVersion!==null && (typeof b.policyVersion!=='string'||!ADMIN_POLICY_VERSION_TAG.test(b.policyVersion)))return null;
  const counts={total:b.items.length,pending:0,approved:0,skipped:0,unavailable:0};
  const ids=new Set();
  for (const i of b.items) {
    if (!exact(i,['id','revision','status','job','missionId','decidedAt']) || !parseUuid(i.id) || ids.has(i.id) || !revision(i.revision) ||
      !parseJobCardView(i.job) || !RECOMMENDATION_ITEM_STATUSES.includes(i.status as never)) return null;
    ids.add(i.id);
    if(i.status==='PENDING'){if(i.missionId!==null || i.decidedAt!==null)return null;counts.pending++;}
    else {if(!parseIsoDateTime(i.decidedAt))return null;
      if(i.status==='APPROVED'){if(!parseUuid(i.missionId))return null;counts.approved++;}
      else {if(i.missionId!==null)return null;if(i.status==='SKIPPED')counts.skipped++;else counts.unavailable++;}}
  }
  if(!exact(b.counts,Object.keys(counts)) || Object.entries(counts).some(([k,v])=>(b.counts as Record<string,unknown>)[k]!==v))return null;
  if(b.status==='OPEN' && (!counts.total || counts.pending!==counts.total) || b.status==='PARTIALLY_DECIDED' && (!counts.pending || counts.pending===counts.total) ||
    b.status==='COMPLETED' && counts.pending!==0)return null;
  return value as unknown as GetRecommendationBatchResponse;
}
