import { parseNormalStagingReference } from './deployment-staging-publishing.ts';
import type { StagingCutoverReference } from './deployment-cutover.ts';

/** Protected operator evidence for one ordinary B → B configuration change.
 *
 * The initial transition record covers exactly one normal-v1 → B move and its
 * validator requires the pre-change policy to still carry `normalStaging`. Once
 * that move has happened no further configuration input can be changed, because
 * ordinary updates require an unchanged `configurationSha256`. This record is the
 * steady-state counterpart: both sides are already B, and the operator states in
 * advance exactly which inputs may differ.
 *
 * Its digest must be inside the freshly verified publishing grant. It authorizes
 * no database, business or release permission, and it never widens what the host
 * verifies: every field outside `changes` must still be byte-identical.
 *
 * `public-config` is the one kind that moves part of release identity. The host
 * refuses to install a release whose `publicConfigSha256` is not the one the
 * selected configuration pins, so a corrected public build configuration can
 * only be adopted by re-pinning it here, in writing, with both digests named. It
 * moves the pin, never the release: the record still forbids the release, image
 * and every other frozen policy field from moving with it, so declaring it can
 * admit a differently-built release of the same revision and nothing else.
 *
 * `database-metadata` is the second such kind, for the same reason in a different
 * place. The host re-derives each database's metadata digest from the live
 * database at every deploy, and that digest covers the connecting role's table
 * grants -- so granting a role access to one more table moves it. The digest is
 * pinned in policy and policy is immutable, so before this kind existed an
 * ordinary grant permanently rejected every subsequent deploy, with no path back:
 * the dedicated metadata-rebind tool requires the pre-transition `normalStaging`
 * shape and refuses a runtime host. A digest is not reversible either, so the
 * database cannot be put back to match the pin except by guessing.
 *
 * It moves only `databases[service].metadataSha256`. `roleSha256` and
 * `targetSha256` -- which role connects, and to what -- stay frozen, so this
 * cannot become a way to repoint a runtime or widen its reach; that is the whole
 * property the frozen `databases` field existed to hold, and it still holds.
 *
 * `addedDatabases` is the one way a database may appear that was not there
 * before, and it exists because a service may. A `services` change that turns on
 * the email worker brings a process that connects to the database, and the host
 * refuses to deploy `auth-worker` without a `databases['auth-worker']` entry --
 * so without this the service could be declared and never admitted. It pins the
 * new entry whole, in writing: the role, the target and the observed metadata the
 * operator measured with the host's own reader. It can only ever name services
 * this record adds, so it still cannot repoint or re-role a database that already
 * exists; that remains frozen on every path.
 */
export type StagingConfigurationChange = Readonly<{
  schemaVersion: 1;
  mode: 'normal-staging-configuration-change';
  grantId: string;
  hostSha256: string;
  previous: StagingCutoverReference;
  candidate: StagingCutoverReference;
  /** The closed set of policy inputs this one change is allowed to alter. */
  changes: readonly StagingConfigurationChangeKind[];
  /** Service env files whose bytes may differ, with both digests pinned. */
  environment: readonly Readonly<{ service: string; previousSha256: string; candidateSha256: string }>[];
  previousComposeSha256: string;
  candidateComposeSha256: string;
  previousProxySha256: string;
  candidateProxySha256: string;
  /** Release identity: both sides pinned so the move is reviewable on its face. */
  previousPublicConfigSha256: string;
  candidatePublicConfigSha256: string;
  previousServices: readonly string[];
  candidateServices: readonly string[];
  previousAcceptedSchemaSha256: readonly string[];
  candidateAcceptedSchemaSha256: readonly string[];
  /** Observed database metadata, per service, both sides pinned. */
  previousDatabaseMetadata: DatabaseMetadataPins;
  candidateDatabaseMetadata: DatabaseMetadataPins;
  /** Complete policy entries for the databases this change's added services bring.
   * Absent on every change that adds no database-backed service. */
  addedDatabases?: Readonly<Record<string, AddedDatabase>>;
  approvalRef: string;
}>;

/** One added database, exactly as policy carries it: measured, not assumed. */
export type AddedDatabase = Readonly<{ metadataSha256: string; roleSha256: string; targetSha256: string }>;

/** `metadataSha256` per database-backed service. Role and target are never here:
 * those are the identity and reach of the connection, and this record may not
 * move them. */
export type DatabaseMetadataPins = Readonly<Record<string, string>>;

export const STAGING_CONFIGURATION_CHANGE_KINDS = ['environment', 'compose', 'proxy', 'services', 'accepted-schema', 'public-config', 'database-metadata'] as const;
export type StagingConfigurationChangeKind = typeof STAGING_CONFIGURATION_CHANGE_KINDS[number];

const SERVICES = ['api', 'auth', 'auth-worker', 'chat', 'marketing'] as const;

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
  && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(v, key))
  && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const matches = (v: unknown, pattern: RegExp): v is string => typeof v === 'string' && pattern.test(v);
const digest = (v: unknown) => matches(v, /^[a-f0-9]{64}$/u);
const uuid = (v: unknown) => matches(v, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const approval = (v: unknown) => matches(v, /^https:\/\/github\.com\/edaix-official\/edaix-job-agents\/(pull|issues)\/[1-9][0-9]*(#[-a-zA-Z0-9]+)?$/u);
const digestList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(digest)
  && new Set(v as string[]).size === v.length;
const serviceList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0
  && v.every(name => (SERVICES as readonly string[]).includes(name as string))
  && new Set(v as string[]).size === v.length;

const FIELDS = ['schemaVersion', 'mode', 'grantId', 'hostSha256', 'previous', 'candidate', 'changes', 'environment',
  'previousComposeSha256', 'candidateComposeSha256', 'previousProxySha256', 'candidateProxySha256',
  'previousPublicConfigSha256', 'candidatePublicConfigSha256',
  'previousServices', 'candidateServices', 'previousAcceptedSchemaSha256', 'candidateAcceptedSchemaSha256',
  'previousDatabaseMetadata', 'candidateDatabaseMetadata', 'approvalRef'];

/** Additive, and absent from every record written before added databases existed, so those
 * records keep both their meaning and their digest. */
const OPTIONAL_FIELDS = ['addedDatabases'];

/** Database-backed services, in the shape policy pins them. */
const DATABASE_SERVICES = ['api', 'auth', 'auth-worker'] as const;

const metadataPins = (v: unknown): v is Record<string, string> => record(v)
  && Object.keys(v).length > 0
  && Object.keys(v).every(key => (DATABASE_SERVICES as readonly string[]).includes(key))
  && Object.values(v).every(digest);

/** Written by the original protected operator. A record that declares no change,
 * or declares a change it does not actually carry, is rejected here rather than
 * on the host, so an empty or mismatched approval can never reach a runtime. */
export function parseStagingConfigurationChange(value: unknown): StagingConfigurationChange | null {
  if (!record(value) || !keys(value, FIELDS, OPTIONAL_FIELDS)) return null;
  if (value.schemaVersion !== 1 || value.mode !== 'normal-staging-configuration-change') return null;
  if (!uuid(value.grantId) || !digest(value.hostSha256) || !approval(value.approvalRef)) return null;
  if (!['previousComposeSha256', 'candidateComposeSha256', 'previousProxySha256', 'candidateProxySha256',
    'previousPublicConfigSha256', 'candidatePublicConfigSha256'].every(key => digest(value[key]))) return null;

  const previous = parseNormalStagingReference(value.previous);
  const candidate = parseNormalStagingReference(value.candidate);
  if (!previous || !candidate || previous.configurationId === candidate.configurationId) return null;

  // A configuration change is exactly that: the release stays, the configuration
  // moves -- with one exception the `public-config` kind cannot do without.
  //
  // `publicConfigSha256` is a digest of the build that produced a release, so
  // the only artifact that carries a given value is the release built with it.
  // Holding the release still while re-pinning the policy therefore asks the
  // deploy to admit a candidate configuration against the *previous* build's
  // manifest, and `verifyRelease` compares exactly those two: the re-pin could
  // only ever pass when the running release already carried the target digest,
  // which is the one case that needs no re-pin at all.
  //
  // So a declared `public-config` may carry its release with it. Nothing is
  // loosened beyond that: the pairing is still operator-written and digest
  // pinned, the release still has to verify against the configuration that
  // names it, and every other kind keeps the release immovable.
  const adoptsRelease = Array.isArray(value.changes)
    && (value.changes as unknown[]).includes('public-config');
  if (!adoptsRelease
    && (previous.releaseId !== candidate.releaseId || previous.image !== candidate.image)) return null;

  if (!Array.isArray(value.changes) || value.changes.length === 0
    || new Set(value.changes as string[]).size !== value.changes.length
    || !value.changes.every(kind => (STAGING_CONFIGURATION_CHANGE_KINDS as readonly string[]).includes(kind as string))) return null;
  const changes = new Set(value.changes as StagingConfigurationChangeKind[]);

  if (!Array.isArray(value.environment)) return null;
  const seen = new Set<string>();
  for (const entry of value.environment) {
    if (!record(entry) || !keys(entry, ['service', 'previousSha256', 'candidateSha256'])) return null;
    if (!(SERVICES as readonly string[]).includes(entry.service as string) || seen.has(entry.service as string)) return null;
    if (!digest(entry.previousSha256) || !digest(entry.candidateSha256)) return null;
    // Listing a file whose bytes do not move would let a reviewer believe it was reviewed.
    if (entry.previousSha256 === entry.candidateSha256) return null;
    seen.add(entry.service as string);
  }
  // Entries pin the services whose bytes move, so any entry means `environment`
  // is moving. The converse does not hold: adding or removing a service changes
  // configurationSha256 with no pair of digests to pin, and that case is
  // admissible only when the service set is declared as moving too.
  if (value.environment.length > 0 && !changes.has('environment')) return null;
  if (changes.has('environment') && value.environment.length === 0 && !changes.has('services')) return null;

  if (!serviceList(value.previousServices) || !serviceList(value.candidateServices)) return null;
  if (!digestList(value.previousAcceptedSchemaSha256) || !digestList(value.candidateAcceptedSchemaSha256)) return null;

  // Both sides must name the same services, so a metadata re-pin cannot quietly
  // add or drop a database-backed service along the way.
  if (!metadataPins(value.previousDatabaseMetadata) || !metadataPins(value.candidateDatabaseMetadata)) return null;
  const metadataServices = Object.keys(value.previousDatabaseMetadata).sort();
  if (JSON.stringify(metadataServices) !== JSON.stringify(Object.keys(value.candidateDatabaseMetadata).sort())) return null;

  // A database may only be added by the record that adds the service which brings it, and it
  // must be pinned whole. Databases that already exist are never named here: moving their role
  // or target stays impossible, and moving their metadata stays the `database-metadata` kind's
  // business alone.
  if (Object.hasOwn(value, 'addedDatabases')) {
    const added = value.addedDatabases;
    if (!record(added) || Object.keys(added).length === 0) return null;
    const grew = (value.candidateServices as string[]).filter(service => !(value.previousServices as string[]).includes(service));
    for (const [service, entry] of Object.entries(added)) {
      if (!(DATABASE_SERVICES as readonly string[]).includes(service) || !grew.includes(service)) return null;
      if (Object.hasOwn(value.previousDatabaseMetadata as Record<string, unknown>, service)) return null;
      if (!record(entry) || !keys(entry, ['metadataSha256', 'roleSha256', 'targetSha256'])
        || !Object.values(entry).every(digest)) return null;
    }
  }

  // Each declared kind must actually differ, and each undeclared kind must not.
  const moved = {
    compose: value.previousComposeSha256 !== value.candidateComposeSha256,
    proxy: value.previousProxySha256 !== value.candidateProxySha256,
    services: JSON.stringify(value.previousServices) !== JSON.stringify(value.candidateServices),
    'accepted-schema': JSON.stringify(value.previousAcceptedSchemaSha256) !== JSON.stringify(value.candidateAcceptedSchemaSha256),
    'public-config': value.previousPublicConfigSha256 !== value.candidatePublicConfigSha256,
    'database-metadata': metadataServices.some(service =>
      (value.previousDatabaseMetadata as Record<string, string>)[service]
        !== (value.candidateDatabaseMetadata as Record<string, string>)[service]),
  } as const;
  for (const [kind, differs] of Object.entries(moved)) {
    if (changes.has(kind as StagingConfigurationChangeKind) !== differs) return null;
  }
  return Object.freeze({ ...value, previous, candidate }) as unknown as StagingConfigurationChange;
}
