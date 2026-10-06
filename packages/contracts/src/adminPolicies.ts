/**
 * Admin policy documents mirrored from AGENT-API-CONTRACT.md §5.29.
 *
 * One append-only store (`job_agent.admin_policies`) carries every operator
 * tunable as a versioned document per module: draft → active → retired, one
 * active version per module, the active version stamped on what it produced.
 * A module declares its document schema here; an unreadable, absent or
 * unknown document always resolves to the module's strictest preset.
 */
import {
  AGENT_HTTP_SCHEMA_VERSION,
  parseIsoDateTime,
  type AgentSchemaEnvelope,
  type IsoDateTime,
} from './common.ts';

export const ADMIN_POLICY_MODULE_IDS = ['recommendation'] as const;
export type AdminPolicyModuleId = (typeof ADMIN_POLICY_MODULE_IDS)[number];

export const ADMIN_POLICY_STATES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export type AdminPolicyState = (typeof ADMIN_POLICY_STATES)[number];

/** Bounded version listing per module, newest first. */
export const ADMIN_POLICY_MAX_VERSIONS_LISTED = 50;
export const ADMIN_POLICY_MAX_VERSION = 999_999_999;
export const ADMIN_POLICY_MAX_DOCUMENT_BYTES = 16_384;

/** `module:version`, the tag a produced artifact (a recommendation batch) records. */
export const ADMIN_POLICY_VERSION_TAG = /^[a-z][a-z0-9-]{1,63}:[1-9][0-9]{0,8}$/u;

export function adminPolicyVersionTag(moduleId: AdminPolicyModuleId, version: number): string {
  if (!isModuleId(moduleId) || !isVersion(version)) throw new Error('ADMIN_POLICY_VERSION_INVALID');
  return `${moduleId}:${version}`;
}

// ---------------------------------------------------------------------------
// recommendation · document v1
// ---------------------------------------------------------------------------

export const RECOMMENDATION_POLICY_SCHEMA_VERSION = 1;
export const RECOMMENDATION_POLICY_LOCATION_MODES = ['ACCEPTED_LIST_ONLY', 'TIERS'] as const;
export type RecommendationPolicyLocationMode = (typeof RECOMMENDATION_POLICY_LOCATION_MODES)[number];
export const RECOMMENDATION_POLICY_UNRESOLVED_HANDLINGS = ['EXCLUDE', 'FLAG'] as const;
export type RecommendationPolicyUnresolvedHandling = (typeof RECOMMENDATION_POLICY_UNRESOLVED_HANDLINGS)[number];
export const RECOMMENDATION_POLICY_CRITERIA = [
  'WORK_AUTHORIZATION',
  'LOCATION',
  'GRADUATION',
  'LEVEL',
  'EXPERIENCE',
  'EDUCATION',
  'MUST_HAVE',
] as const;
export type RecommendationPolicyCriterion = (typeof RECOMMENDATION_POLICY_CRITERIA)[number];

/** Inclusive bounds every published document must respect. */
export const RECOMMENDATION_POLICY_LIMITS = Object.freeze({
  batchSize: Object.freeze({ min: 1, max: 50 }),
  maxFlaggedShare: Object.freeze({ min: 0, max: 1 }),
  exposureCooldownDays: Object.freeze({ min: 0, max: 90 }),
  postingWindowDays: Object.freeze({ min: 1, max: 90 }),
} as const);

export interface RecommendationPolicyDocumentV1 {
  readonly schemaVersion: typeof RECOMMENDATION_POLICY_SCHEMA_VERSION;
  /** ACCEPTED_LIST_ONLY ignores country, relocation and remote facts. */
  readonly locationMode: RecommendationPolicyLocationMode;
  /** How an unresolved hard criterion is admitted; a NOT_SATISFIED or PENDING criterion is never admitted. */
  readonly unresolvedHandling: Readonly<Record<RecommendationPolicyCriterion, RecommendationPolicyUnresolvedHandling>>;
  /** Largest share of a batch that flagged (needs-confirmation) jobs may take, 0..1. */
  readonly maxFlaggedShare: number;
  readonly batchSize: number;
  readonly exposureCooldownDays: number;
  readonly postingWindowDays: number;
}

/**
 * Reproduces the behaviour before any policy existed. postingWindowDays is an upper bound: a run admits
 * under the smaller of it and the source's own freshness window, so publishing this preset does not
 * widen a source that is fresher than 30 days.
 */
export const STRICTEST_RECOMMENDATION_POLICY_DOCUMENT: RecommendationPolicyDocumentV1 = Object.freeze({
  schemaVersion: RECOMMENDATION_POLICY_SCHEMA_VERSION,
  locationMode: 'ACCEPTED_LIST_ONLY',
  unresolvedHandling: Object.freeze(
    Object.fromEntries(RECOMMENDATION_POLICY_CRITERIA.map((criterion) => [criterion, 'EXCLUDE'] as const)),
  ) as Readonly<Record<RecommendationPolicyCriterion, RecommendationPolicyUnresolvedHandling>>,
  maxFlaggedShare: 0,
  batchSize: 50,
  exposureCooldownDays: 7,
  postingWindowDays: 30,
});

export function parseRecommendationPolicyDocument(value: unknown): RecommendationPolicyDocumentV1 | null {
  if (!exact(value, ['schemaVersion', 'locationMode', 'unresolvedHandling', 'maxFlaggedShare', 'batchSize',
    'exposureCooldownDays', 'postingWindowDays'])) return null;
  if (value.schemaVersion !== RECOMMENDATION_POLICY_SCHEMA_VERSION ||
    !RECOMMENDATION_POLICY_LOCATION_MODES.includes(value.locationMode as never) ||
    !exact(value.unresolvedHandling, [...RECOMMENDATION_POLICY_CRITERIA]) ||
    !Object.values(value.unresolvedHandling).every((handling) =>
      RECOMMENDATION_POLICY_UNRESOLVED_HANDLINGS.includes(handling as never)) ||
    !bounded(value.maxFlaggedShare, RECOMMENDATION_POLICY_LIMITS.maxFlaggedShare, false) ||
    !bounded(value.batchSize, RECOMMENDATION_POLICY_LIMITS.batchSize, true) ||
    !bounded(value.exposureCooldownDays, RECOMMENDATION_POLICY_LIMITS.exposureCooldownDays, true) ||
    !bounded(value.postingWindowDays, RECOMMENDATION_POLICY_LIMITS.postingWindowDays, true)) return null;
  return value as unknown as RecommendationPolicyDocumentV1;
}

/** Module dispatch: the document shape a module accepts, or null. */
export function parseAdminPolicyDocument(moduleId: unknown, value: unknown): unknown | null {
  switch (moduleId) {
    case 'recommendation': return parseRecommendationPolicyDocument(value);
    default: return null;
  }
}

export function strictestAdminPolicyDocument(moduleId: AdminPolicyModuleId): unknown {
  switch (moduleId) {
    case 'recommendation': return STRICTEST_RECOMMENDATION_POLICY_DOCUMENT;
  }
}

// ---------------------------------------------------------------------------
// wire · §5.29
// ---------------------------------------------------------------------------

export interface AdminPolicyView {
  readonly moduleId: AdminPolicyModuleId;
  readonly version: number;
  readonly state: AdminPolicyState;
  readonly schemaVersion: number;
  readonly document: unknown;
  readonly createdAt: IsoDateTime;
  readonly publishedAt: IsoDateTime | null;
  readonly retiredAt: IsoDateTime | null;
}

/** §5.29 GET /api/v1/agent/admin/policies/:moduleId */
export interface AdminPolicyModuleParams { readonly moduleId: AdminPolicyModuleId }
export interface ListAdminPoliciesResponse extends AgentSchemaEnvelope {
  readonly moduleId: AdminPolicyModuleId;
  readonly active: AdminPolicyView | null;
  /** Newest first, bounded by ADMIN_POLICY_MAX_VERSIONS_LISTED. */
  readonly versions: readonly AdminPolicyView[];
}

/** §5.29 POST /api/v1/agent/admin/policies/:moduleId */
export interface CreateAdminPolicyDraftRequest { readonly document: unknown }

/** §5.29 POST /api/v1/agent/admin/policies/:moduleId/versions/:version/publish */
export interface AdminPolicyVersionParams { readonly moduleId: AdminPolicyModuleId; readonly version: number }
export interface AdminPolicyResponse extends AgentSchemaEnvelope { readonly policy: AdminPolicyView }

export function parseAdminPolicyView(value: unknown): AdminPolicyView | null {
  if (!exact(value, ['moduleId', 'version', 'state', 'schemaVersion', 'document', 'createdAt', 'publishedAt', 'retiredAt'])) return null;
  if (!isModuleId(value.moduleId) || !isVersion(value.version) ||
    !ADMIN_POLICY_STATES.includes(value.state as never) ||
    !Number.isInteger(value.schemaVersion) || Number(value.schemaVersion) < 1 ||
    parseAdminPolicyDocument(value.moduleId, value.document) === null ||
    !parseIsoDateTime(value.createdAt) ||
    (value.publishedAt !== null && !parseIsoDateTime(value.publishedAt)) ||
    (value.retiredAt !== null && !parseIsoDateTime(value.retiredAt))) return null;
  const state = value.state as AdminPolicyState;
  if (state === 'DRAFT' && (value.publishedAt !== null || value.retiredAt !== null)) return null;
  if (state === 'ACTIVE' && (value.publishedAt === null || value.retiredAt !== null)) return null;
  if (state === 'RETIRED' && (value.publishedAt === null || value.retiredAt === null)) return null;
  return value as unknown as AdminPolicyView;
}

export function parseListAdminPoliciesResponse(value: unknown): ListAdminPoliciesResponse | null {
  if (!exact(value, ['schemaVersion', 'moduleId', 'active', 'versions']) || value.schemaVersion !== AGENT_HTTP_SCHEMA_VERSION ||
    !isModuleId(value.moduleId) || !Array.isArray(value.versions) || value.versions.length > ADMIN_POLICY_MAX_VERSIONS_LISTED ||
    (value.active !== null && parseAdminPolicyView(value.active) === null) ||
    !value.versions.every((row) => parseAdminPolicyView(row) !== null && (row as AdminPolicyView).moduleId === value.moduleId) ||
    new Set(value.versions.map((row) => (row as AdminPolicyView).version)).size !== value.versions.length) return null;
  const active = value.active as AdminPolicyView | null;
  if (active !== null && (active.state !== 'ACTIVE' || active.moduleId !== value.moduleId)) return null;
  if ((value.versions as AdminPolicyView[]).filter((row) => row.state === 'ACTIVE').length > 1) return null;
  return value as unknown as ListAdminPoliciesResponse;
}

export function parseAdminPolicyResponse(value: unknown): AdminPolicyResponse | null {
  return exact(value, ['schemaVersion', 'policy']) && value.schemaVersion === AGENT_HTTP_SCHEMA_VERSION &&
    parseAdminPolicyView(value.policy) !== null ? value as unknown as AdminPolicyResponse : null;
}

export function parseCreateAdminPolicyDraftRequest(value: unknown): CreateAdminPolicyDraftRequest | null {
  return exact(value, ['document']) && value.document !== null && typeof value.document === 'object' && !Array.isArray(value.document)
    ? value as unknown as CreateAdminPolicyDraftRequest : null;
}

function isModuleId(value: unknown): value is AdminPolicyModuleId {
  return ADMIN_POLICY_MODULE_IDS.includes(value as never);
}
function isVersion(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= ADMIN_POLICY_MAX_VERSION;
}
function bounded(value: unknown, limit: Readonly<{ min: number; max: number }>, integer: boolean): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (!integer || Number.isInteger(value)) &&
    value >= limit.min && value <= limit.max;
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key));
}
