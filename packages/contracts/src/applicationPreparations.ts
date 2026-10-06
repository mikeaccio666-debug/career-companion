/** T8/T9 Start-authorized background preparation. This wire grants no fill or submit authority. */
import { parseIsoDateTime, parseUuid, type DecimalString, type IsoDateTime, type Uuid } from './common.ts';
import type { DecideRecommendationBatchRequest } from './recommendations.ts';

export type ApplicationMaterialPlan =
  | { readonly mode: 'USE_EXISTING'; readonly trackId: Uuid; readonly resumeVersionId: Uuid; readonly expectedLibraryRevision: DecimalString }
  | { readonly mode: 'GENERATE_FOR_JOB'; readonly trackId: Uuid; readonly expectedLibraryRevision: DecimalString };
/** Omission preserves the existing generate-new API; Assistant always supplies an explicit plan. */
export interface StartApplicationPreparationsRequest extends DecideRecommendationBatchRequest {
  readonly materialPlan?: ApplicationMaterialPlan;
}
export function parseApplicationMaterialPlan(value: unknown): ApplicationMaterialPlan | null {
  if (!record(value) || !parseUuid(value.trackId) || !revision(value.expectedLibraryRevision)) return null;
  if (value.mode === 'USE_EXISTING' && keys(value, ['mode','trackId','resumeVersionId','expectedLibraryRevision']) && parseUuid(value.resumeVersionId)) return value as unknown as ApplicationMaterialPlan;
  if (value.mode === 'GENERATE_FOR_JOB' && keys(value, ['mode','trackId','expectedLibraryRevision'])) return value as unknown as ApplicationMaterialPlan;
  return null;
}
export function parseStartApplicationPreparationsRequest(value: unknown): StartApplicationPreparationsRequest | null {
  if (!record(value) || !keys(value, ['clientRequestId','expectedRevision','decisions', ...(Object.hasOwn(value,'materialPlan') ? ['materialPlan'] : [])]) ||
    !parseUuid(value.clientRequestId) || !positiveRevision(value.expectedRevision) ||
    (Object.hasOwn(value,'materialPlan') && !parseApplicationMaterialPlan(value.materialPlan)) ||
    !Array.isArray(value.decisions) || value.decisions.length < 1 || value.decisions.length > 50 ||
    !value.decisions.every(d => record(d) && keys(d,['itemId','itemRevision','decision']) && parseUuid(d.itemId) && positiveRevision(d.itemRevision) && ['APPLY','SKIP'].includes(String(d.decision))) ||
    new Set(value.decisions.map(d=>d.itemId)).size !== value.decisions.length) return null;
  return value as unknown as StartApplicationPreparationsRequest;
}
function revision(value: unknown): value is DecimalString {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}
export interface ApplicationPreparationsParams { readonly batchId: Uuid; }
export interface RetryApplicationPreparationParams extends ApplicationPreparationsParams { readonly preparationId: Uuid; }
export const APPLICATION_PREPARATION_STATUSES = [
  'QUEUED', 'GENERATING_RESUME', 'BINDING_MISSION', 'READY', 'FAILED',
] as const;
export type ApplicationPreparationStatus = typeof APPLICATION_PREPARATION_STATUSES[number];
export const APPLICATION_PREPARATION_FAILURE_CODES = [
  'JOB_UNAVAILABLE', 'SOURCE_CHANGED', 'RESUME_TRACK_UNAVAILABLE', 'GENERATION_FAILED',
  'MISSION_UNAVAILABLE', 'OWNER_UNAVAILABLE', 'LEASE_EXPIRED', 'PREPARATION_UNAVAILABLE',
] as const;
export type ApplicationPreparationFailureCode = typeof APPLICATION_PREPARATION_FAILURE_CODES[number];

export interface ApplicationPreparationView {
  readonly preparationId: Uuid;
  readonly itemId: Uuid;
  readonly revision: DecimalString;
  readonly status: ApplicationPreparationStatus;
  readonly failureCode: ApplicationPreparationFailureCode | null;
  /** Server-owned eligibility for a fresh explicit Retry; the write revalidates current authority. */
  readonly retryable: boolean;
  /** A saved CV can survive a later failure; it never implies Mission or execution approval. */
  readonly resumeVersionId: Uuid | null;
  readonly missionId: Uuid | null;
  readonly updatedAt: IsoDateTime;
}
export interface ApplicationPreparationsResponse {
  readonly schemaVersion: 1;
  readonly batchId: Uuid;
  readonly conversationId: Uuid;
  readonly items: readonly ApplicationPreparationView[];
}
export interface RetryApplicationPreparationRequest {
  readonly clientRequestId: Uuid;
  readonly expectedRevision: DecimalString;
}

export function parseApplicationPreparationsResponse(value: unknown): ApplicationPreparationsResponse | null {
  if (!record(value) || !keys(value, ['schemaVersion', 'batchId', 'conversationId', 'items']) ||
    value.schemaVersion !== 1 || !parseUuid(value.batchId) || !parseUuid(value.conversationId) ||
    !Array.isArray(value.items) || value.items.length > 500 || !value.items.every(isItem)) return null;
  const items = value.items as ApplicationPreparationView[];
  if (new Set(items.map((item) => item.preparationId)).size !== items.length ||
    new Set(items.map((item) => item.itemId)).size !== items.length) return null;
  return value as unknown as ApplicationPreparationsResponse;
}

export function parseRetryApplicationPreparationRequest(value: unknown): RetryApplicationPreparationRequest | null {
  if (!record(value) || !keys(value, ['clientRequestId', 'expectedRevision']) ||
    !parseUuid(value.clientRequestId) || !positiveRevision(value.expectedRevision)) return null;
  return value as unknown as RetryApplicationPreparationRequest;
}

function isItem(value: unknown): value is ApplicationPreparationView {
  if (!record(value) || !keys(value, ['preparationId', 'itemId', 'revision', 'status', 'failureCode', 'retryable',
    'resumeVersionId', 'missionId', 'updatedAt']) || !parseUuid(value.preparationId) ||
    !parseUuid(value.itemId) || !positiveRevision(value.revision) ||
    !APPLICATION_PREPARATION_STATUSES.some((status) => status === value.status) || typeof value.retryable !== 'boolean' ||
    !parseIsoDateTime(value.updatedAt) ||
    !(value.resumeVersionId === null || parseUuid(value.resumeVersionId)) ||
    !(value.missionId === null || parseUuid(value.missionId))) return false;
  if (value.status === 'FAILED') {
    if (!APPLICATION_PREPARATION_FAILURE_CODES.some((code) => code === value.failureCode)) return false;
  } else if (value.failureCode !== null || value.retryable) return false;
  if (value.status === 'READY') return value.resumeVersionId !== null && value.missionId !== null;
  if (value.status === 'BINDING_MISSION' && value.resumeVersionId === null) return false;
  return value.missionId === null;
}
function positiveRevision(value: unknown): value is DecimalString {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
