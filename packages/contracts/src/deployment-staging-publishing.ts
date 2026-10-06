import { STAGING_CUTOVER_PHASES, STAGING_CUTOVER_REASONS, type StagingCutoverReference } from './deployment-cutover.ts';

/** Closed operational staging authority. No user, feature or production permission is carried here. */
export type StagingPublishingScope = Readonly<{
  hostSha256: string; configurationId: string; configurationSha256: string; publicConfigSha256: string;
  hostToolsSha256: string; documentVersion: string; documentSha256: string;
  initialPrevious: StagingCutoverReference;
  initialConfigurationTransitionSha256?: string;
  /** Ordinary B → B configuration change. Mutually exclusive with the initial transition. */
  configurationChangeSha256?: string;
}>;
export type StagingPublishingGrant = Readonly<{
  schemaVersion: 1; environment: 'staging'; grantId: string; parameterArn: string;
  scope: StagingPublishingScope; approvalRef: string;
}>;
export type StagingPublishingState = Readonly<{
  schemaVersion: 1; environment: 'staging'; grantId: string; scopeSha256: string; status: 'ACTIVE' | 'REVOKED';
}>;
export type StagingPublishingObservation = Readonly<{
  schemaVersion: 1; grantId: string; parameterArn: string; scopeSha256: string;
  version: number; valueSha256: string; revoked: boolean;
}>;
export type NormalStagingUpdatePlan = Readonly<{
  schemaVersion: 1; mode: 'normal-staging-update'; environment: 'staging'; operationId: string;
  action: 'update' | 'restart'; previous: StagingCutoverReference; candidate: StagingCutoverReference;
  grantId: string; grantSha256: string; scopeSha256: string; parameterVersion: number; hostSha256: string;
  approvedAt: string; expiresAt: string; rollback: 'before-candidate-start-only';
}>;
export const STAGING_PUBLISHING_REASONS = [...STAGING_CUTOVER_REASONS,
  'DEPLOY_STAGING_GRANT_INVALID', 'DEPLOY_STAGING_GRANT_UNAVAILABLE', 'DEPLOY_STAGING_GRANT_REVOKED',
  'DEPLOY_STAGING_GRANT_ROLLBACK', 'DEPLOY_STAGING_SCOPE_MISMATCH', 'DEPLOY_STAGING_PUBLICATION_PAUSED',
  'DEPLOY_STAGING_UPDATE_INVALID', 'DEPLOY_STAGING_UPDATE_FAILED', 'DEPLOY_STAGING_STOP_REQUESTED',
  'DEPLOY_STAGING_SOURCE_ORDER_INVALID', 'DEPLOY_STAGING_EXPECTED_CURRENT_REQUIRED',
  'DEPLOY_STAGING_START_WINDOW_EXPIRED', 'DEPLOY_STAGING_LAUNCH_INVALID',
  'DEPLOY_STAGING_CONFIGURATION_TRANSITION_INVALID', 'DEPLOY_STAGING_CONFIGURATION_CHANGE_INVALID',
  'DEPLOY_STAGING_API_COMPATIBILITY_UNCONFIRMED',
  'DEPLOY_STAGING_MIGRATION_FAILED', 'DEPLOY_STAGING_MIGRATION_INVALID', 'DEPLOY_STAGING_MIGRATION_RECOVERY_REQUIRED',
  // The candidate could not stand its provider graph up. Listed here so the
  // operation record carries the cause: a reason outside this set is flattened
  // to DEPLOY_STAGING_UPDATE_FAILED, which is what made this class of failure
  // unreadable from the record and cost hours of guessing.
  'DEPLOY_CANDIDATE_GRAPH_INVALID'] as const;
export type NormalStagingUpdateOperation = Readonly<{
  schemaVersion: 4; mode: 'normal-staging-update'; operationId: string; plan: NormalStagingUpdatePlan;
  startedAt: string; updatedAt: string; phase: typeof STAGING_CUTOVER_PHASES[number];
  status: 'in_progress' | 'succeeded' | 'rejected' | 'rolled_back' | 'recovery_required'; candidateStartAttempted: boolean;
  attempt: Readonly<{ operationId: string; startedAt: string; expiresAt: string }>;
  migration?: Readonly<{ status: 'attempted' } | { status: 'verified'; changed: boolean; applicationRollback: 'compatible' | 'forbidden' }>;
  reason?: typeof STAGING_PUBLISHING_REASONS[number]; recoveryReason?: typeof STAGING_PUBLISHING_REASONS[number];
}>;
export type StagingCurrentView = Readonly<{
  schemaVersion: 1; environment: 'staging'; mode: 'legacy' | 'normal-staging-update';
  current: StagingCutoverReference | null;
}>;
export type StagingStopRequest = Readonly<{
  schemaVersion: 1; mode: 'stop-staging'; operationId: string; requestedAt: string; hostSha256: string;
}>;
export type StagingStopReceipt = Readonly<{
  schemaVersion: 5; mode: 'stop-staging'; environment: 'staging'; operationId: string; hostSha256: string;
  requestedAt: string; completedAt: string; status: 'succeeded' | 'recovery_required';
  coveredOperationIds: readonly string[]; writersStopped: boolean; reason?: 'DEPLOY_CUTOVER_WRITERS_ACTIVE' | 'DEPLOY_STAGING_STOP_REQUESTED';
}>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
  && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const matches = (v: unknown, pattern: RegExp): v is string => typeof v === 'string' && pattern.test(v);
const digest = (v: unknown): v is string => matches(v, /^[a-f0-9]{64}$/u);
const uuid = (v: unknown): v is string => matches(v, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const time = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const version = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const arn = (v: unknown): v is string => matches(v, /^arn:aws:ssm:[a-z]{2}-[a-z]+-\d:\d{12}:parameter\/[A-Za-z0-9_./-]{1,512}$/u)
  && !(v as string).includes('//') && !(v as string).split('/').some(x => x === '.' || x === '..');
export function parseNormalStagingReference(v: unknown): StagingCutoverReference | null {
  return record(v) && keys(v, ['releaseId', 'revision', 'image', 'ciRunId', 'configurationId', 'policySha256', 'manifestSha256', 'configurationSha256'])
    && matches(v.revision, /^[a-f0-9]{40}$/u) && matches(v.releaseId, new RegExp(`^${v.revision}-default-x64-[a-f0-9]{12}$`, 'u'))
    && matches(v.image, /^\d{12}\.dkr\.ecr\.[a-z]{2}-[a-z]+-\d\.amazonaws\.com\/[a-z0-9][a-z0-9/_-]*@sha256:[a-f0-9]{64}$/u)
    && matches(v.ciRunId, /^[1-9][0-9]{0,19}$/u)
    && ['configurationId', 'policySha256', 'manifestSha256', 'configurationSha256'].every(k => digest(v[k]))
    && v.configurationId === v.policySha256 ? v as unknown as StagingCutoverReference : null;
}
export function parseStagingPublishingGrant(v: unknown): StagingPublishingGrant | null {
  if (!record(v) || !keys(v, ['schemaVersion', 'environment', 'grantId', 'parameterArn', 'scope', 'approvalRef'])
    || v.schemaVersion !== 1 || v.environment !== 'staging' || !uuid(v.grantId) || !arn(v.parameterArn)
    || !matches(v.approvalRef, /^https:\/\/github\.com\/edaix-official\/edaix-job-agents\/(pull|issues)\/[1-9][0-9]*(#[-a-zA-Z0-9]+)?$/u)
    || !record(v.scope) || !keys(v.scope, ['hostSha256', 'configurationId', 'configurationSha256', 'publicConfigSha256',
      'hostToolsSha256', 'documentVersion', 'documentSha256', 'initialPrevious'],
    ['initialConfigurationTransitionSha256', 'configurationChangeSha256'])) return null;
  const s = v.scope;
  if (!['hostSha256', 'configurationId', 'configurationSha256', 'publicConfigSha256', 'hostToolsSha256', 'documentSha256'].every(k => digest(s[k]))
    || !matches(s.documentVersion, /^[1-9][0-9]{0,19}$/u) || !parseNormalStagingReference(s.initialPrevious)
    || Object.hasOwn(s, 'initialConfigurationTransitionSha256') && !digest(s.initialConfigurationTransitionSha256)
    || Object.hasOwn(s, 'configurationChangeSha256') && !digest(s.configurationChangeSha256)
    // One grant authorizes one kind of configuration move, never both at once.
    || Object.hasOwn(s, 'initialConfigurationTransitionSha256') && Object.hasOwn(s, 'configurationChangeSha256')) return null;
  return v as unknown as StagingPublishingGrant;
}
export function parseStagingPublishingState(v: unknown): StagingPublishingState | null {
  return record(v) && keys(v, ['schemaVersion', 'environment', 'grantId', 'scopeSha256', 'status'])
    && v.schemaVersion === 1 && v.environment === 'staging' && uuid(v.grantId) && digest(v.scopeSha256)
    && ['ACTIVE', 'REVOKED'].includes(v.status as string) ? v as unknown as StagingPublishingState : null;
}
export function parseStagingPublishingObservation(v: unknown): StagingPublishingObservation | null {
  return record(v) && keys(v, ['schemaVersion', 'grantId', 'parameterArn', 'scopeSha256', 'version', 'valueSha256', 'revoked'])
    && v.schemaVersion === 1 && uuid(v.grantId) && arn(v.parameterArn) && digest(v.scopeSha256)
    && version(v.version) && digest(v.valueSha256) && typeof v.revoked === 'boolean' ? v as unknown as StagingPublishingObservation : null;
}
export function parseNormalStagingUpdatePlan(v: unknown, now = Date.now()): NormalStagingUpdatePlan | null {
  if (!record(v) || !keys(v, ['schemaVersion', 'mode', 'environment', 'operationId', 'action', 'previous', 'candidate',
    'grantId', 'grantSha256', 'scopeSha256', 'parameterVersion', 'hostSha256', 'approvedAt', 'expiresAt', 'rollback'])
    || v.schemaVersion !== 1 || v.mode !== 'normal-staging-update' || v.environment !== 'staging' || !uuid(v.operationId)
    || !['update', 'restart'].includes(v.action as string) || !parseNormalStagingReference(v.previous) || !parseNormalStagingReference(v.candidate)
    || !uuid(v.grantId) || !['grantSha256', 'scopeSha256', 'hostSha256'].every(k => digest(v[k])) || !version(v.parameterVersion)
    || !time(v.approvedAt) || !time(v.expiresAt) || !Number.isFinite(now) || v.rollback !== 'before-candidate-start-only') return null;
  const start = Date.parse(v.approvedAt), end = Date.parse(v.expiresAt);
  if (start > now || end <= now || end <= start || end - start > 3_600_000) return null;
  const p = v.previous as unknown as StagingCutoverReference, c = v.candidate as unknown as StagingCutoverReference;
  if (v.action === 'restart' && JSON.stringify(p) !== JSON.stringify(c)) return null;
  if (v.action === 'update' && p.releaseId === c.releaseId && p.configurationId === c.configurationId) return null;
  return v as unknown as NormalStagingUpdatePlan;
}
export function parseNormalStagingUpdateOperation(v: unknown): NormalStagingUpdateOperation | null {
  if (!record(v) || !keys(v, ['schemaVersion', 'mode', 'operationId', 'plan', 'startedAt', 'updatedAt', 'phase', 'status',
    'candidateStartAttempted', 'attempt'], ['reason', 'recoveryReason', 'migration']) || v.schemaVersion !== 4 || v.mode !== 'normal-staging-update'
    || !record(v.plan) || !time(v.plan.approvedAt) || !parseNormalStagingUpdatePlan(v.plan, Date.parse(v.plan.approvedAt))
    || v.operationId !== v.plan.operationId || !time(v.startedAt) || !time(v.updatedAt) || Date.parse(v.updatedAt) < Date.parse(v.startedAt)
    || !(STAGING_CUTOVER_PHASES as readonly unknown[]).includes(v.phase) || typeof v.candidateStartAttempted !== 'boolean'
    || ['reason', 'recoveryReason'].some(k => Object.hasOwn(v, k) && !(STAGING_PUBLISHING_REASONS as readonly unknown[]).includes(v[k]))
    || !record(v.attempt) || !keys(v.attempt, ['operationId', 'startedAt', 'expiresAt']) || !uuid(v.attempt.operationId)
    || !time(v.attempt.startedAt) || !time(v.attempt.expiresAt) || Date.parse(v.attempt.startedAt) < Date.parse(v.startedAt)
    || Date.parse(v.attempt.expiresAt) <= Date.parse(v.attempt.startedAt)
    || Date.parse(v.attempt.expiresAt) - Date.parse(v.attempt.startedAt) > 3_600_000) return null;
  const terminal: Record<string, string> = { committed: 'succeeded', rejected: 'rejected', rolled_back: 'rolled_back', recovery_required: 'recovery_required' };
  if ((terminal[v.phase as string] ?? 'in_progress') !== v.status) return null;
  const afterStart = ['candidate_starting', 'checking', 'resuming', 'committed'].includes(v.phase as string);
  if (afterStart && !v.candidateStartAttempted || !afterStart && v.phase !== 'recovery_required' && v.candidateStartAttempted) return null;
  if (Object.hasOwn(v, 'migration')) {
    const m = v.migration;
    if (!record(m) || (m.status === 'attempted' ? !keys(m, ['status']) : m.status !== 'verified'
      || !keys(m, ['status', 'changed', 'applicationRollback']) || typeof m.changed !== 'boolean'
      || !['compatible', 'forbidden'].includes(m.applicationRollback as string))) return null;
    if (['preflight', 'rejected', 'admitted', 'draining', 'stopping'].includes(v.phase as string)
      || m.status === 'attempted' && !['stopped', 'recovery_required'].includes(v.phase as string)) return null;
  }
  return v as unknown as NormalStagingUpdateOperation;
}
export function parseStagingCurrentView(v: unknown): StagingCurrentView | null {
  return record(v) && keys(v, ['schemaVersion', 'environment', 'mode', 'current']) && v.schemaVersion === 1 && v.environment === 'staging'
    && (v.mode === 'legacy' ? v.current === null : v.mode === 'normal-staging-update' && parseNormalStagingReference(v.current))
    ? v as unknown as StagingCurrentView : null;
}
export function parseStagingStopRequest(v: unknown): StagingStopRequest | null {
  return record(v) && keys(v, ['schemaVersion', 'mode', 'operationId', 'requestedAt', 'hostSha256']) && v.schemaVersion === 1
    && v.mode === 'stop-staging' && uuid(v.operationId) && time(v.requestedAt) && digest(v.hostSha256) ? v as unknown as StagingStopRequest : null;
}
export function parseStagingStopReceipt(v: unknown): StagingStopReceipt | null {
  return record(v) && keys(v, ['schemaVersion', 'mode', 'environment', 'operationId', 'hostSha256', 'requestedAt', 'completedAt', 'status', 'writersStopped', 'coveredOperationIds'], ['reason'])
    && v.schemaVersion === 5 && v.mode === 'stop-staging' && v.environment === 'staging' && uuid(v.operationId) && digest(v.hostSha256)
    && time(v.requestedAt) && time(v.completedAt) && Date.parse(v.completedAt) >= Date.parse(v.requestedAt)
    && Array.isArray(v.coveredOperationIds) && v.coveredOperationIds.length > 0 && v.coveredOperationIds.length <= 128
    && v.coveredOperationIds.every(uuid) && new Set(v.coveredOperationIds).size === v.coveredOperationIds.length
    && v.coveredOperationIds.includes(v.operationId)
    && ['succeeded', 'recovery_required'].includes(v.status as string) && typeof v.writersStopped === 'boolean'
    && (v.status === 'succeeded' ? v.writersStopped && v.reason === undefined : !v.writersStopped
      && ['DEPLOY_CUTOVER_WRITERS_ACTIVE', 'DEPLOY_STAGING_STOP_REQUESTED'].includes(v.reason as string))
    ? v as unknown as StagingStopReceipt : null;
}
