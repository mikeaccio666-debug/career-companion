/** Staging-only transition evidence. This never grants runtime/business authority. */
export type StagingCutoverReference = Readonly<{
  releaseId: string; revision: string; image: string; ciRunId: string; configurationId: string;
  policySha256: string; manifestSha256: string; configurationSha256: string;
}>;
export type StagingCutoverPlan = Readonly<{
  schemaVersion: 1; mode: 'staging-cutover'; environment: 'staging'; operationId: string;
  previous: StagingCutoverReference; candidate: StagingCutoverReference;
  hostSha256: string; databaseTargetSha256: string; compatibilitySha256: string; normalAdmissionSha256: string;
  approvalRef: string; approvedAt: string; expiresAt: string; rollback: 'before-candidate-start-only';
}>;
export const STAGING_CUTOVER_PHASES = ['preflight', 'admitted', 'draining', 'stopping', 'stopped',
  'configuration_switching', 'configuration_selected', 'release_switching', 'release_selected',
  'candidate_starting', 'checking', 'resuming', 'committed', 'rolling_back', 'rolled_back', 'rejected', 'recovery_required'] as const;
export const STAGING_CUTOVER_REASONS = ['DEPLOY_CUTOVER_INVALID', 'DEPLOY_CUTOVER_FAILED',
  'DEPLOY_CUTOVER_PREVIOUS_MISMATCH', 'DEPLOY_CUTOVER_WRITERS_ACTIVE', 'DEPLOY_CUTOVER_PAIR_MISMATCH',
  'DEPLOY_CUTOVER_ROLLBACK_FORBIDDEN', 'DEPLOY_CUTOVER_EVIDENCE_MISMATCH', 'DEPLOY_CUTOVER_INTERRUPTED',
  'DEPLOY_CUTOVER_ADMISSION_INVALID', 'DEPLOY_CUTOVER_RECOVERY_REQUIRED'] as const;
export type StagingCutoverReason = typeof STAGING_CUTOVER_REASONS[number];
export type StagingCutoverOperation = Readonly<{
  schemaVersion: 3; mode: 'staging-cutover'; operationId: string; plan: StagingCutoverPlan;
  startedAt: string; updatedAt: string; phase: typeof STAGING_CUTOVER_PHASES[number];
  status: 'in_progress' | 'succeeded' | 'rejected' | 'rolled_back' | 'recovery_required';
  candidateStartAttempted: boolean; reason?: StagingCutoverReason; recoveryReason?: StagingCutoverReason;
}>;
export type StagingConfigurationSelection = Readonly<{
  schemaVersion: 1; environment: 'staging'; operationId: string; configurationId: string;
}>;
export type StagingCutoverCompatibility = Readonly<{
  schemaVersion: 1; operationId: string; hostSha256: string; databaseTargetSha256: string;
  previousReleaseId: string; candidateReleaseId: string; keysCompatibility: 'preserved';
  externalWriters: 'none'; previousWriterCompatibility: 'valid-until-candidate-start'; recoveryEvidenceSha256: string;
}>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const digest = (value: unknown): value is string => matches(value, /^[a-f0-9]{64}$/u);
const uuid = (value: unknown): value is string => matches(value, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
export function parseStagingConfigurationSelection(value: unknown): StagingConfigurationSelection | null {
  return record(value) && keys(value, ['schemaVersion', 'environment', 'operationId', 'configurationId'])
    && value.schemaVersion === 1 && value.environment === 'staging' && uuid(value.operationId)
    && (value.configurationId === 'legacy' || digest(value.configurationId)) ? value as unknown as StagingConfigurationSelection : null;
}
export function parseStagingCutoverCompatibility(value: unknown, plan: StagingCutoverPlan): StagingCutoverCompatibility | null {
  return record(value) && keys(value, ['schemaVersion', 'operationId', 'hostSha256', 'databaseTargetSha256',
    'previousReleaseId', 'candidateReleaseId', 'keysCompatibility', 'externalWriters', 'previousWriterCompatibility', 'recoveryEvidenceSha256'])
    && value.schemaVersion === 1 && value.operationId === plan.operationId && value.hostSha256 === plan.hostSha256
    && value.databaseTargetSha256 === plan.databaseTargetSha256 && value.previousReleaseId === plan.previous.releaseId
    && value.candidateReleaseId === plan.candidate.releaseId && value.keysCompatibility === 'preserved'
    && value.externalWriters === 'none' && value.previousWriterCompatibility === 'valid-until-candidate-start'
    && digest(value.recoveryEvidenceSha256) ? value as unknown as StagingCutoverCompatibility : null;
}
function reference(value: unknown, previous: boolean): value is StagingCutoverReference {
  if (!record(value) || !keys(value, ['releaseId', 'revision', 'image', 'ciRunId', 'configurationId',
    'policySha256', 'manifestSha256', 'configurationSha256']) || !matches(value.revision, /^[a-f0-9]{40}$/u)) return false;
  const variant = previous ? 'staging-private-preview' : 'default';
  return matches(value.releaseId, new RegExp(`^${value.revision}-${variant}-x64-[a-f0-9]{12}$`, 'u'))
    && matches(value.image, /^\d{12}\.dkr\.ecr\.[a-z]{2}-[a-z]+-\d\.amazonaws\.com\/[a-z0-9][a-z0-9/_-]*@sha256:[a-f0-9]{64}$/u)
    && matches(value.ciRunId, /^[1-9][0-9]{0,19}$/u)
    && (previous ? value.configurationId === 'legacy' : digest(value.configurationId) && value.configurationId === value.policySha256)
    && digest(value.policySha256) && digest(value.manifestSha256) && digest(value.configurationSha256);
}
export function parseStagingCutoverPlan(value: unknown, now: number = Date.now()): StagingCutoverPlan | null {
  if (!record(value) || !keys(value, ['schemaVersion', 'mode', 'environment', 'operationId', 'previous', 'candidate',
    'hostSha256', 'databaseTargetSha256', 'compatibilitySha256', 'normalAdmissionSha256',
    'approvalRef', 'approvedAt', 'expiresAt', 'rollback']) || value.schemaVersion !== 1
    || value.mode !== 'staging-cutover' || value.environment !== 'staging' || !uuid(value.operationId)
    || !reference(value.previous, true) || !reference(value.candidate, false)
    || !['hostSha256', 'databaseTargetSha256', 'compatibilitySha256', 'normalAdmissionSha256'].every(key => digest(value[key]))
    || !matches(value.approvalRef, /^https:\/\/github\.com\/edaix-official\/edaix-job-agents\/(pull|issues)\/[1-9][0-9]*(#[-a-zA-Z0-9]+)?$/u)
    || !timestamp(value.approvedAt) || !timestamp(value.expiresAt) || !Number.isFinite(now)
    || value.rollback !== 'before-candidate-start-only') return null;
  const approved = Date.parse(value.approvedAt); const expiry = Date.parse(value.expiresAt);
  if (approved > now || expiry <= now || expiry <= approved || expiry - approved > 60 * 60 * 1000) return null;
  return value as unknown as StagingCutoverPlan;
}
export function parseStagingCutoverOperation(value: unknown): StagingCutoverOperation | null {
  if (!record(value) || !keys(value, ['schemaVersion', 'mode', 'operationId', 'plan', 'startedAt', 'updatedAt', 'phase',
    'status', 'candidateStartAttempted'], ['reason', 'recoveryReason']) || value.schemaVersion !== 3
    || value.mode !== 'staging-cutover' || !record(value.plan) || !timestamp(value.plan.approvedAt)
    || !parseStagingCutoverPlan(value.plan, Date.parse(value.plan.approvedAt)) || value.operationId !== value.plan.operationId
    || !timestamp(value.startedAt) || !timestamp(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.startedAt)
    || !(STAGING_CUTOVER_PHASES as readonly unknown[]).includes(value.phase) || typeof value.candidateStartAttempted !== 'boolean'
    || !['in_progress', 'succeeded', 'rejected', 'rolled_back', 'recovery_required'].includes(value.status as string)
    || ['reason', 'recoveryReason'].some(key => Object.hasOwn(value, key)
      && !(STAGING_CUTOVER_REASONS as readonly unknown[]).includes(value[key]))) return null;
  const terminal: Record<string, string> = { committed: 'succeeded', rejected: 'rejected',
    rolled_back: 'rolled_back', recovery_required: 'recovery_required' };
  if ((terminal[value.phase as string] ?? 'in_progress') !== value.status) return null;
  const afterStart = ['candidate_starting', 'checking', 'resuming', 'committed'].includes(value.phase as string);
  if (afterStart && !value.candidateStartAttempted) return null;
  if (!afterStart && value.phase !== 'recovery_required' && value.candidateStartAttempted) return null;
  return value as unknown as StagingCutoverOperation;
}
