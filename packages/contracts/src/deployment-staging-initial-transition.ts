import { parseNormalStagingReference } from './deployment-staging-publishing.ts';
import type { StagingCutoverReference } from './deployment-cutover.ts';

/** Protected operator evidence for one initial normal-v1 → B configuration transition.
 * Its digest must be inside the freshly verified publishing grant. It grants no DB or business permission. */
export type StagingInitialConfigurationTransition = Readonly<{
  mode: 'normal-staging-initial-configuration-transition';
  grantId: string; hostSha256: string; previous: StagingCutoverReference; candidate: StagingCutoverReference;
  previousProxySha256: string; candidateProxySha256: string;
  previousSchemaSha256: string; candidateSchemaSha256: string;
  approvalRef: string;
} & ({ schemaVersion: 1; ordinaryApiCompatibilitySha256: string }
  | { schemaVersion: 2; routineMigrationPolicySha256: string })>;

export type StagingDatabasePreflightEvidence = Readonly<{
  schemaVersion: 1; metadataSha256: string; roleSha256: string; targetSha256: string;
}>;

/** Concrete observations, recomputed by the host from the exact two artifact inventories and unchanged env. */
export type StagingOrdinaryApiCompatibility = Readonly<{
  schemaVersion: 1; mode: 'normal-staging-ordinary-api-compatibility'; environment: 'staging';
  profile: '15a-to-415-disabled-new-stores-v1';
  previousRevision: string; candidateRevision: string;
  previousManifestSha256: string; candidateManifestSha256: string;
  previousSchemaSha256: string; candidateSchemaSha256: string;
  configurationSha256: string; apiEnvironmentSha256: string;
  checks: Readonly<{
    clients: readonly Readonly<{ name: 'job-agent' | 'api-main'; previousClientSha256: string;
      candidateClientSha256: string; existingModelCount: number; existingScalarShapeSha256: string; addedModels: readonly string[] }>[];
    sourceClosureSha256: string; hgSourceEnabled: false; materialProvider: 'unavailable';
    databaseProbePlan: Readonly<{ requiredModels: readonly string[]; calendarRequired: boolean }>;
  }>;
  databasePreflights: Readonly<Record<'previous' | 'candidate', Readonly<{
    api: StagingDatabasePreflightEvidence; auth: StagingDatabasePreflightEvidence;
  }>>>;
  ordinaryApiDatabaseChecks: Readonly<Record<'previous' | 'candidate', Readonly<{
    checkedModelCount: number; checkedModelsSha256: string; ownerAdmissionFunctionsSha256: string; calendarConstraintSha256: string | null; compoundUniqueRead: boolean;
  }>>>;
  verifiedAt: string; approvalRef: string;
}>;

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
  && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const matches = (v: unknown, pattern: RegExp): v is string => typeof v === 'string' && pattern.test(v);
const digest = (v: unknown) => matches(v, /^[a-f0-9]{64}$/u);
const revision = (v: unknown) => matches(v, /^[a-f0-9]{40}$/u);
const uuid = (v: unknown) => matches(v, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const approval = (v: unknown) => matches(v, /^https:\/\/github\.com\/edaix-official\/edaix-job-agents\/(pull|issues)\/[1-9][0-9]*(#[-a-zA-Z0-9]+)?$/u);
const time = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

export function parseStagingInitialConfigurationTransition(v: unknown): StagingInitialConfigurationTransition | null {
  if (!record(v)) return null;
  const evidenceKey = v.schemaVersion === 2 ? 'routineMigrationPolicySha256' : 'ordinaryApiCompatibilitySha256';
  if (!keys(v, ['schemaVersion', 'mode', 'grantId', 'hostSha256', 'previous', 'candidate',
    'previousProxySha256', 'candidateProxySha256', 'previousSchemaSha256', 'candidateSchemaSha256',
    evidenceKey, 'approvalRef']) || ![1, 2].includes(v.schemaVersion as number)
    || v.mode !== 'normal-staging-initial-configuration-transition' || !uuid(v.grantId) || !approval(v.approvalRef)
    || !['hostSha256', 'previousProxySha256', 'candidateProxySha256', 'previousSchemaSha256', 'candidateSchemaSha256',
      evidenceKey].every(key => digest(v[key]))) return null;
  const previous = parseNormalStagingReference(v.previous), candidate = parseNormalStagingReference(v.candidate);
  if (!previous || !candidate || previous.configurationId === candidate.configurationId
    || previous.configurationSha256 !== candidate.configurationSha256) return null;
  return v as unknown as StagingInitialConfigurationTransition;
}

export function parseStagingOrdinaryApiCompatibility(v: unknown): StagingOrdinaryApiCompatibility | null {
  if (!record(v) || !keys(v, ['schemaVersion', 'mode', 'environment', 'profile', 'previousRevision', 'candidateRevision',
    'previousManifestSha256', 'candidateManifestSha256', 'previousSchemaSha256', 'candidateSchemaSha256',
    'configurationSha256', 'apiEnvironmentSha256', 'checks', 'databasePreflights', 'ordinaryApiDatabaseChecks', 'verifiedAt', 'approvalRef'])
    || v.schemaVersion !== 1 || v.mode !== 'normal-staging-ordinary-api-compatibility' || v.environment !== 'staging'
    || v.profile !== '15a-to-415-disabled-new-stores-v1' || !time(v.verifiedAt) || !approval(v.approvalRef)
    || !revision(v.previousRevision) || !revision(v.candidateRevision)
    || !['previousManifestSha256', 'candidateManifestSha256', 'previousSchemaSha256', 'candidateSchemaSha256',
      'configurationSha256', 'apiEnvironmentSha256'].every(key => digest(v[key]))
    || !record(v.checks) || !keys(v.checks, ['clients', 'sourceClosureSha256', 'hgSourceEnabled', 'materialProvider', 'databaseProbePlan'])
    || !digest(v.checks.sourceClosureSha256) || v.checks.hgSourceEnabled !== false || v.checks.materialProvider !== 'unavailable'
    || !Array.isArray(v.checks.clients) || v.checks.clients.length !== 2
    || !record(v.databasePreflights) || !keys(v.databasePreflights, ['previous', 'candidate'])
    || !record(v.ordinaryApiDatabaseChecks) || !keys(v.ordinaryApiDatabaseChecks, ['previous', 'candidate'])) return null;
  const probePlan = v.checks.databaseProbePlan;
  if (!record(probePlan) || !keys(probePlan, ['requiredModels', 'calendarRequired']) || typeof probePlan.calendarRequired !== 'boolean'
    || !Array.isArray(probePlan.requiredModels) || probePlan.requiredModels.length < 3 || probePlan.requiredModels.length > 84
    || !probePlan.requiredModels.every(name => matches(name, /^[A-Z][A-Za-z0-9]{1,80}$/u))
    || new Set(probePlan.requiredModels).size !== probePlan.requiredModels.length) return null;
  for (const [i, client] of v.checks.clients.entries()) {
    if (!record(client) || !keys(client, ['name', 'previousClientSha256', 'candidateClientSha256', 'existingModelCount',
      'existingScalarShapeSha256', 'addedModels']) || client.name !== ['job-agent', 'api-main'][i]
      || !Number.isSafeInteger(client.existingModelCount) || (client.existingModelCount as number) <= 0
      || !['previousClientSha256', 'candidateClientSha256', 'existingScalarShapeSha256'].every(key => digest(client[key]))
      || !Array.isArray(client.addedModels) || client.addedModels.length !== 7
      || !client.addedModels.every(name => matches(name, /^[A-Z][A-Za-z0-9]{1,80}$/u))
      || new Set(client.addedModels).size !== client.addedModels.length) return null;
  }
  for (const [name, result] of Object.entries(v.ordinaryApiDatabaseChecks)) {
    if (!record(result) || !keys(result, ['checkedModelCount', 'checkedModelsSha256', 'ownerAdmissionFunctionsSha256', 'calendarConstraintSha256', 'compoundUniqueRead'])
      || result.checkedModelCount !== probePlan.requiredModels.length || !digest(result.checkedModelsSha256) || !digest(result.ownerAdmissionFunctionsSha256)
      || (probePlan.calendarRequired ? !digest(result.calendarConstraintSha256) : result.calendarConstraintSha256 !== null)
      || result.compoundUniqueRead !== (probePlan.calendarRequired && name === 'candidate')) return null;
  }
  for (const direction of Object.values(v.databasePreflights)) {
    if (!record(direction) || !keys(direction, ['api', 'auth'])) return null;
    for (const evidence of Object.values(direction)) {
      if (!record(evidence) || !keys(evidence, ['schemaVersion', 'metadataSha256', 'roleSha256', 'targetSha256'])
        || evidence.schemaVersion !== 1 || !['metadataSha256', 'roleSha256', 'targetSha256'].every(key => digest(evidence[key]))) return null;
    }
  }
  return v as unknown as StagingOrdinaryApiCompatibility;
}
