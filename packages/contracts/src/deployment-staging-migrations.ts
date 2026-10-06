/** Dedicated staging operator input. Never mounted into an application container. */
export type StagingMigrationRow = Readonly<{ id: string; sha256: string }>;
/** The closed action set the host may hand the in-image routine runner. `observe` is the read-only
 * reading of the ledger itself: it applies nothing and, unlike `inspect`, does not require the ledger
 * to hold exactly the recorded baseline, so the host can see rows an operator registered out of band. */
export const STAGING_MIGRATION_ACTIONS = ['apply', 'verify', 'inspect', 'observe'] as const;
export type StagingMigrationAction = (typeof STAGING_MIGRATION_ACTIONS)[number];
export type StagingMigrationManifest = Readonly<{
  schemaVersion: 1; planSha256: string;
  migrations: readonly (StagingMigrationRow & { mode: 'routine-compatible' | 'manual-only'; applicationRollback: 'compatible' | 'forbidden' })[];
}>;
export type StagingMigrationPolicy = Readonly<{
  schemaVersion: 1; environment: 'staging'; enabled: true;
  projectRef: string; host: string; port: 5432; database: 'postgres'; username: string;
  actor: 'postgres'; databaseCaSha256: string; hostSha256: string; configurationSha256: string;
  baseline: readonly StagingMigrationRow[];
}>;
type DatabaseEvidence = Readonly<{ schemaVersion: 1; metadataSha256: string; roleSha256: string; targetSha256: string }>;
/** `observedRows` names rows this operation found already registered in the ledger and admitted as a
 * prefix of its own plan, rather than applied itself. It is absent whenever nothing was admitted, so
 * every record written before the admission path existed stays valid and keeps its digest. */
export type StagingMigrationAttempt = Readonly<{
  schemaVersion: 1; environment: 'staging'; operationId: string; releaseId: string; manifestSha256: string;
  policySha256: string; hostSha256: string; configurationSha256: string; planSha256: string;
  baseline: readonly StagingMigrationRow[]; databases: RoutineDatabaseEvidence; coreSha256: string;
  observedRows?: readonly StagingMigrationRow[];
}>;
/** api and auth always; `auth-worker` only once the email worker is a running service, which is
 * additive: every record written before it keeps its shape and its digest. */
export type RoutineDatabaseEvidence = Readonly<Record<'api' | 'auth', DatabaseEvidence>
  & Partial<Record<'auth-worker', DatabaseEvidence>>>;
export type StagingMigrationEvidence = Readonly<{
  schemaVersion: 1; environment: 'staging'; operationId: string; attemptSha256: string;
  after: readonly StagingMigrationRow[]; databases: RoutineDatabaseEvidence;
  changed: boolean; applicationRollback: 'compatible' | 'forbidden';
  observedRows?: readonly StagingMigrationRow[];
}>;
export function parseStagingMigrationSetting(v: unknown): Readonly<{ schemaVersion: 1; policySha256: string }> | null {
  return record(v) && keys(v, ['schemaVersion', 'policySha256']) && v.schemaVersion === 1 && digest(v.policySha256)
    ? v as { schemaVersion: 1; policySha256: string } : null;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, wanted: readonly string[]) => Object.keys(v).length === wanted.length && wanted.every(k => Object.hasOwn(v, k));
/** Closed the same way `keys` is: every required key present, and nothing outside required ∪ optional. */
const keysWithOptional = (v: Record<string, unknown>, wanted: readonly string[], optional: readonly string[]) =>
  wanted.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => wanted.includes(k) || optional.includes(k));
const optionalRows = (v: Record<string, unknown>, key: string) => !Object.hasOwn(v, key) || parseStagingMigrationRows(v[key]) !== null;
const matches = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
const digest = (v: unknown): v is string => matches(v, /^[a-f0-9]{64}$/u);
export function parseStagingMigrationRows(v: unknown): readonly StagingMigrationRow[] | null {
  return Array.isArray(v) && v.length > 0 && v.length <= 1024 && v.every(x => record(x) && keys(x, ['id', 'sha256'])
    && matches(x.id, /^\d{4}_[a-z0-9_]+$/u) && digest(x.sha256))
    && new Set(v.map(x => x.id.slice(0, 4))).size === v.length
    && v.every((x, i) => i === 0 || v[i - 1].id < x.id) ? v : null;
}
export function parseStagingMigrationManifest(v: unknown): StagingMigrationManifest | null {
  if (!record(v) || !keys(v, ['schemaVersion', 'planSha256', 'migrations']) || v.schemaVersion !== 1 || !digest(v.planSha256)
    || !Array.isArray(v.migrations) || !parseStagingMigrationRows(v.migrations.map(x => record(x) ? { id: x.id, sha256: x.sha256 } : null))
    || !v.migrations.every(x => keys(x, ['id', 'sha256', 'mode', 'applicationRollback'])
      && ['routine-compatible', 'manual-only'].includes(x.mode) && ['compatible', 'forbidden'].includes(x.applicationRollback)
      && (!['0013', '0016'].includes(x.id.slice(0, 4)) || x.mode === 'manual-only'))) return null;
  return v as unknown as StagingMigrationManifest;
}
export function parseStagingMigrationPolicy(v: unknown): StagingMigrationPolicy | null {
  if (!record(v) || !keys(v, ['schemaVersion', 'environment', 'enabled', 'projectRef', 'host', 'port', 'database',
    'username', 'actor', 'databaseCaSha256', 'hostSha256', 'configurationSha256', 'baseline'])
    || v.schemaVersion !== 1 || v.environment !== 'staging' || v.enabled !== true
    || !matches(v.projectRef, /^[a-z]{20}$/u) || v.projectRef === 'jxnznoyzqdtoqynpjtao'
    || !matches(v.host, /^(?:db\.[a-z]{20}\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$/u)
    || v.port !== 5432 || v.database !== 'postgres' || v.actor !== 'postgres'
    || !['databaseCaSha256', 'hostSha256', 'configurationSha256'].every(k => digest(v[k]))
    || !parseStagingMigrationRows(v.baseline)) return null;
  if (v.host === `db.${v.projectRef}.supabase.co` ? v.username !== 'postgres'
    : !v.host.endsWith('.pooler.supabase.com') || v.username !== `postgres.${v.projectRef}`) return null;
  return v as unknown as StagingMigrationPolicy;
}
const databases = (v: unknown) => record(v) && keysWithOptional(v, ['api', 'auth'], ['auth-worker']) && Object.values(v).every(d => record(d)
  && keys(d, ['schemaVersion', 'metadataSha256', 'roleSha256', 'targetSha256']) && d.schemaVersion === 1
  && ['metadataSha256', 'roleSha256', 'targetSha256'].every(k => digest(d[k])));
export function parseStagingMigrationAttempt(v: unknown): StagingMigrationAttempt | null {
  return record(v) && keysWithOptional(v, ['schemaVersion', 'environment', 'operationId', 'releaseId', 'manifestSha256', 'policySha256',
    'hostSha256', 'configurationSha256', 'planSha256', 'baseline', 'databases', 'coreSha256'], ['observedRows'])
    && v.schemaVersion === 1 && v.environment === 'staging'
    && matches(v.operationId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
    && matches(v.releaseId, /^[a-f0-9]{40}-default-x64-[a-f0-9]{12}$/u)
    && ['manifestSha256', 'policySha256', 'hostSha256', 'configurationSha256', 'planSha256', 'coreSha256'].every(k => digest(v[k]))
    && parseStagingMigrationRows(v.baseline) && databases(v.databases)
    && optionalRows(v, 'observedRows') ? v as unknown as StagingMigrationAttempt : null;
}
export function parseStagingMigrationEvidence(v: unknown): StagingMigrationEvidence | null {
  return record(v) && keysWithOptional(v, ['schemaVersion', 'environment', 'operationId', 'attemptSha256', 'after', 'databases',
    'changed', 'applicationRollback'], ['observedRows'])
    && v.schemaVersion === 1 && v.environment === 'staging'
    && matches(v.operationId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
    && digest(v.attemptSha256) && parseStagingMigrationRows(v.after) && databases(v.databases)
    && typeof v.changed === 'boolean' && ['compatible', 'forbidden'].includes(v.applicationRollback as string)
    && optionalRows(v, 'observedRows')
    ? v as unknown as StagingMigrationEvidence : null;
}
