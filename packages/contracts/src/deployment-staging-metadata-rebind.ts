import { parseNormalStagingReference } from './deployment-staging-publishing.ts';
import type { StagingCutoverReference } from './deployment-cutover.ts';

/** One operator-reviewed normal-v1 configuration rebind. This carries no DB grant or launch authority. */
export const STAGING_METADATA_REBIND_REASONS = ['DEPLOY_METADATA_REBIND_INVALID', 'DEPLOY_METADATA_REBIND_FAILED',
  'DEPLOY_METADATA_REBIND_EVIDENCE_MISMATCH', 'DEPLOY_METADATA_REBIND_PAIR_MISMATCH',
  'DEPLOY_METADATA_REBIND_RECOVERY_REQUIRED', 'DEPLOY_METADATA_REBIND_WINDOW_EXPIRED',
  'DEPLOY_METADATA_REBIND_GRANT_UNCONFIRMED'] as const;
export type StagingMetadataRebindReason = typeof STAGING_METADATA_REBIND_REASONS[number];
export const STAGING_METADATA_READ_COLUMNS = Object.freeze({
  queue_outbox_events: Object.freeze(['id', 'event_key', 'queue_name', 'type', 'payload', 'status',
    'attempts', 'error', 'available_at', 'processed_at', 'created_at', 'updated_at']),
  user_profiles: Object.freeze(['id', 'user_id', 'full_name', 'headline', 'bio', 'location', 'target_roles',
    'skills', 'education', 'experience', 'website_url', 'linkedin_url', 'github_url', 'preferences', 'created_at', 'updated_at']),
});
export type NormalDatabaseColumn = Readonly<{ table_name: string; column_name: string; ordinal_position: number;
  data_type: string; udt_name: string; is_nullable: 'YES' | 'NO'; column_default: string | null }>;
export type NormalDatabaseMetadata = Readonly<{ database: string; role: string; elevated: false;
  columns: readonly NormalDatabaseColumn[];
  constraints: readonly Readonly<{ table_name: string; name: string; definition: string }>[] | null;
  privileges: readonly Readonly<{ table_name: string; privilege_type: string }>[] }>;
export type StagingMetadataGrantReceipt = Readonly<{ schemaVersion: 1; status: 'COMMITTED'; direction: 'APPLY';
  beforeSha256: string; afterSha256: string; changedColumnCount: number }>;
export type StagingMetadataObservation = Readonly<{ api: NormalDatabaseMetadata; auth: NormalDatabaseMetadata }>;
/** Before/owner data are sealed observations; expectedAfter/expectedGrantReceipt are forecasts, not execution evidence. */
export type StagingMetadataRebindEvidence = Readonly<{ schemaVersion: 1; mode: 'staging-column-read-metadata-projection';
  before: StagingMetadataObservation;
  expectedAfter: StagingMetadataObservation;
  ownerColumns: readonly NormalDatabaseColumn[]; expectedGrantReceipt: StagingMetadataGrantReceipt }>;
export type StagingMetadataRebindPlan = Readonly<{ schemaVersion: 1; mode: 'staging-metadata-rebind'; environment: 'staging';
  operationId: string; previous: StagingCutoverReference; candidate: StagingCutoverReference;
  hostSha256: string; evidenceSha256: string; grantReceiptSha256: string;
  approvalRef: string; approvedAt: string; expiresAt: string; runtimeAction: 'none'; recovery: 'complete-rebind-only' }>;
export const STAGING_METADATA_REBIND_PHASES = ['preflight', 'awaiting_database_change', 'verifying_database',
  'configuration_switching', 'configuration_selected', 'committed', 'rejected', 'recovery_required'] as const;
export type StagingMetadataRebindOperation = Readonly<{ schemaVersion: 5; mode: 'staging-metadata-rebind'; operationId: string;
  plan: StagingMetadataRebindPlan; startedAt: string; updatedAt: string; phase: typeof STAGING_METADATA_REBIND_PHASES[number];
  status: 'in_progress' | 'succeeded' | 'rejected' | 'recovery_required'; candidateStartAttempted: false;
  reason?: StagingMetadataRebindReason }>;

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
  && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const matches = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
const digest = (v: unknown): v is string => matches(v, /^[a-f0-9]{64}$/u);
const time = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const column = (v: unknown): v is NormalDatabaseColumn => record(v)
  && keys(v, ['table_name', 'column_name', 'ordinal_position', 'data_type', 'udt_name', 'is_nullable', 'column_default'])
  && ['table_name', 'column_name', 'data_type', 'udt_name'].every(k => text(v[k]))
  && Number.isSafeInteger(v.ordinal_position) && Number(v.ordinal_position) > 0 && Number(v.ordinal_position) <= 1600
  && ['YES', 'NO'].includes(v.is_nullable as string) && (v.column_default === null || text(v.column_default, 65536));
export function parseNormalDatabaseMetadata(v: unknown): NormalDatabaseMetadata | null {
  if (!record(v) || !keys(v, ['database', 'role', 'elevated', 'columns', 'constraints', 'privileges'])
    || !text(v.database) || !text(v.role) || v.elevated !== false
    || !Array.isArray(v.columns) || v.columns.length === 0 || v.columns.length > 20000 || !v.columns.every(column)
    || new Set(v.columns.map(c => `${c.table_name}\0${c.column_name}`)).size !== v.columns.length
    || new Set(v.columns.map(c => `${c.table_name}\0${c.ordinal_position}`)).size !== v.columns.length
    || !(v.constraints === null || Array.isArray(v.constraints) && v.constraints.length <= 20000 && v.constraints.every(c =>
      record(c) && keys(c, ['table_name', 'name', 'definition']) && text(c.table_name) && text(c.name) && text(c.definition, 65536)))
    || !Array.isArray(v.privileges) || v.privileges.length === 0 || v.privileges.length > 20000 || !v.privileges.every(p =>
      record(p) && keys(p, ['table_name', 'privilege_type']) && text(p.table_name)
      && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'].includes(p.privilege_type as string))) return null;
  return v as unknown as NormalDatabaseMetadata;
}
export function parseStagingMetadataGrantReceipt(v: unknown): StagingMetadataGrantReceipt | null {
  return record(v) && keys(v, ['schemaVersion', 'status', 'direction', 'beforeSha256', 'afterSha256', 'changedColumnCount'])
    && v.schemaVersion === 1 && v.status === 'COMMITTED' && v.direction === 'APPLY'
    && digest(v.beforeSha256) && digest(v.afterSha256) && v.beforeSha256 !== v.afterSha256
    && Number.isSafeInteger(v.changedColumnCount) && Number(v.changedColumnCount) >= 1 && Number(v.changedColumnCount) <= 28
    ? v as unknown as StagingMetadataGrantReceipt : null;
}
export function parseStagingMetadataOwnerColumns(v: unknown): readonly NormalDatabaseColumn[] | null {
  if (!Array.isArray(v) || v.length !== 28 || !v.every(column)) return null;
  const expected = Object.entries(STAGING_METADATA_READ_COLUMNS).flatMap(([table, columns]) => columns.map(name => `${table}\0${name}`));
  const actual = new Set(v.map(c => `${c.table_name}\0${c.column_name}`));
  return actual.size === expected.length && expected.every(k => actual.has(k))
    && new Set(v.map(c => `${c.table_name}\0${c.ordinal_position}`)).size === v.length ? v : null;
}
export function parseStagingMetadataObservation(v: unknown): StagingMetadataObservation | null {
  return record(v) && keys(v, ['api', 'auth']) && parseNormalDatabaseMetadata(v.api) && parseNormalDatabaseMetadata(v.auth)
    ? v as unknown as StagingMetadataObservation : null;
}
export function parseStagingMetadataRebindEvidence(v: unknown): StagingMetadataRebindEvidence | null {
  if (!record(v) || !keys(v, ['schemaVersion', 'mode', 'before', 'expectedAfter', 'ownerColumns', 'expectedGrantReceipt'])
    || v.schemaVersion !== 1 || v.mode !== 'staging-column-read-metadata-projection' || !parseStagingMetadataGrantReceipt(v.expectedGrantReceipt)
    || !parseStagingMetadataOwnerColumns(v.ownerColumns)) return null;
  for (const k of ['before', 'expectedAfter']) {
    const side = v[k];
    if (!parseStagingMetadataObservation(side)) return null;
  }
  return v as unknown as StagingMetadataRebindEvidence;
}
export function parseStagingMetadataRebindPlan(v: unknown, now = Date.now()): StagingMetadataRebindPlan | null {
  if (!record(v) || !keys(v, ['schemaVersion', 'mode', 'environment', 'operationId', 'previous', 'candidate',
    'hostSha256', 'evidenceSha256', 'grantReceiptSha256', 'approvalRef', 'approvedAt', 'expiresAt', 'runtimeAction', 'recovery'])
    || v.schemaVersion !== 1 || v.mode !== 'staging-metadata-rebind' || v.environment !== 'staging'
    || !matches(v.operationId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
    || !['hostSha256', 'evidenceSha256', 'grantReceiptSha256'].every(k => digest(v[k]))
    || !matches(v.approvalRef, /^https:\/\/github\.com\/edaix-official\/edaix-job-agents\/(pull|issues)\/[1-9][0-9]*(#[-a-zA-Z0-9]+)?$/u)
    || !time(v.approvedAt) || !time(v.expiresAt) || !Number.isFinite(now)
    || v.runtimeAction !== 'none' || v.recovery !== 'complete-rebind-only') return null;
  const a = parseNormalStagingReference(v.previous), b = parseNormalStagingReference(v.candidate);
  if (!a || !b || a.configurationId === b.configurationId || !['releaseId', 'revision', 'image', 'ciRunId', 'manifestSha256', 'configurationSha256']
    .every(k => a[k as keyof StagingCutoverReference] === b[k as keyof StagingCutoverReference])) return null;
  const approved = Date.parse(v.approvedAt), expiry = Date.parse(v.expiresAt);
  if (approved > now || expiry <= now || expiry <= approved || expiry - approved > 3_600_000) return null;
  return v as unknown as StagingMetadataRebindPlan;
}
export function parseStagingMetadataRebindOperation(v: unknown): StagingMetadataRebindOperation | null {
  if (!record(v) || !keys(v, ['schemaVersion', 'mode', 'operationId', 'plan', 'startedAt', 'updatedAt', 'phase', 'status', 'candidateStartAttempted'], ['reason'])
    || v.schemaVersion !== 5 || v.mode !== 'staging-metadata-rebind' || !record(v.plan) || !time(v.plan.approvedAt)
    || !parseStagingMetadataRebindPlan(v.plan, Date.parse(v.plan.approvedAt)) || v.operationId !== v.plan.operationId
    || !time(v.startedAt) || !time(v.updatedAt) || Date.parse(v.updatedAt) < Date.parse(v.startedAt) || v.candidateStartAttempted !== false
    || !(STAGING_METADATA_REBIND_PHASES as readonly unknown[]).includes(v.phase)
    || Object.hasOwn(v, 'reason') && !(STAGING_METADATA_REBIND_REASONS as readonly unknown[]).includes(v.reason)) return null;
  const terminal: Record<string, string> = { committed: 'succeeded', rejected: 'rejected', recovery_required: 'recovery_required' };
  return (terminal[v.phase as string] ?? 'in_progress') === v.status ? v as unknown as StagingMetadataRebindOperation : null;
}
