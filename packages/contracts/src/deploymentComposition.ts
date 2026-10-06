/** Private deployment metadata. Public DeploymentVersion remains schema v1. */
export const COMPOSITION_SERVICE_ENTRIES = Object.freeze({
  api: 'units/api/dist/apps/api/src/main.js',
  auth: 'units/auth/dist/main.js',
  authWorker: 'units/auth/dist/email-worker.js',
  chat: 'units/chat/apps/chat/server.js',
  marketing: 'units/marketing/apps/marketing/server.js',
} as const);
export type CompositionService = keyof typeof COMPOSITION_SERVICE_ENTRIES;
export type DeploymentArtifactReference = Readonly<{
  format: 1 | 2;
  image: string;
  sourceRevision: string;
  releaseId: string;
  ciRunId: string;
  buildRunId: string;
  manifestSha256: string;
  entry: string;
  platform: 'linux';
  architecture: 'x64';
  nodeVersion: string;
  lockfileSha256: string;
  publicConfigSha256: string;
  schemaSha256: string;
}>;
export type CompositionServices = Readonly<{
  api: DeploymentArtifactReference;
  chat: DeploymentArtifactReference;
  marketing: DeploymentArtifactReference;
  auth?: DeploymentArtifactReference;
  authWorker?: DeploymentArtifactReference;
}>;
export type DeploymentComposition = Readonly<{
  schemaVersion: 2;
  kind: 'marketing-composition';
  compositionId: string;
  assembly: Readonly<{ sourceRevision: string; ciRunId: string; buildRunId: string; buildRunAttempt: number }>;
  compatibilitySha256: string;
  services: CompositionServices;
}>;
export type CompositionAdmission = Readonly<{
  schemaVersion: 2;
  environment: 'staging' | 'production';
  expectedPrevious: string;
  policySha256: string;
  configurationSha256: string;
  acceptedSchemaSha256: readonly string[];
  acceptanceReference: string;
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value)
  && Number.isSafeInteger(Number(value));
const release = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{40}-[a-z][a-z0-9-]{0,31}-x64-[a-f0-9]{12}$/u.test(value);
const image = (value: unknown): value is string => typeof value === 'string'
  && /^\d{12}\.dkr\.ecr\.[a-z]{2}-[a-z]+-\d\.amazonaws\.com\/[a-z0-9][a-z0-9/_-]*@sha256:[a-f0-9]{64}$/u.test(value);
const reference = (value: unknown): value is string => typeof value === 'string'
  && /^https:\/\/github\.com\/edaix-official\/edaix-job-agents\/(issues|pull)\/[1-9][0-9]*(#[-a-zA-Z0-9]+)?$/u.test(value);
const ARTIFACT_KEYS = ['format', 'image', 'sourceRevision', 'releaseId', 'ciRunId', 'buildRunId',
  'manifestSha256', 'entry', 'platform', 'architecture', 'nodeVersion', 'lockfileSha256', 'publicConfigSha256', 'schemaSha256'] as const;

export function parseDeploymentArtifactReference(value: unknown, service: CompositionService): DeploymentArtifactReference | null {
  if (!record(value) || !keys(value, ARTIFACT_KEYS)
    || !Object.hasOwn(COMPOSITION_SERVICE_ENTRIES, service)
    || (value.format !== 1 && !(service === 'marketing' && value.format === 2))
    || !image(value.image) || !sha(value.sourceRevision) || !release(value.releaseId)
    || !value.releaseId.startsWith(`${value.sourceRevision}-`)
    || !id(value.ciRunId) || !id(value.buildRunId) || !digest(value.manifestSha256)
    || value.entry !== COMPOSITION_SERVICE_ENTRIES[service] || value.platform !== 'linux' || value.architecture !== 'x64'
    || typeof value.nodeVersion !== 'string' || !/^24\.\d+\.\d+$/u.test(value.nodeVersion)
    || !digest(value.lockfileSha256) || !digest(value.publicConfigSha256) || !digest(value.schemaSha256)) return null;
  return Object.fromEntries(ARTIFACT_KEYS.map(key => [key, value[key]])) as DeploymentArtifactReference;
}

export function parseDeploymentComposition(value: unknown): DeploymentComposition | null {
  if (!record(value) || !keys(value, ['schemaVersion', 'kind', 'compositionId', 'assembly', 'compatibilitySha256', 'services'])
    || value.schemaVersion !== 2 || value.kind !== 'marketing-composition' || !release(value.compositionId)
    || !digest(value.compatibilitySha256) || !record(value.assembly)
    || !keys(value.assembly, ['sourceRevision', 'ciRunId', 'buildRunId', 'buildRunAttempt'])
    || !sha(value.assembly.sourceRevision) || !id(value.assembly.ciRunId) || !id(value.assembly.buildRunId)
    || !Number.isSafeInteger(value.assembly.buildRunAttempt) || Number(value.assembly.buildRunAttempt) < 1
    || !value.compositionId.startsWith(`${value.assembly.sourceRevision}-marketing-x64-`)
    || !record(value.services) || !['api', 'chat', 'marketing'].every(key => Object.hasOwn(value.services as object, key))
    || Object.keys(value.services).some(key => !Object.hasOwn(COMPOSITION_SERVICE_ENTRIES, key))) return null;
  const services: Partial<Record<CompositionService, DeploymentArtifactReference>> = {};
  for (const service of Object.keys(COMPOSITION_SERVICE_ENTRIES) as CompositionService[]) {
    if (!Object.hasOwn(value.services, service)) continue;
    const parsed = parseDeploymentArtifactReference(value.services[service], service);
    if (!parsed) return null;
    services[service] = parsed;
  }
  if (services.authWorker && !services.auth) return null;
  const base = services.api!;
  for (const [service, artifact] of Object.entries(services)) {
    if (artifact.image.split('@')[0] !== base.image.split('@')[0]) return null;
    // First capability keeps every non-Marketing service on its original full-product artifact.
    if (service !== 'marketing' && ARTIFACT_KEYS.some(key => key !== 'entry' && artifact[key] !== base[key])) return null;
  }
  return { schemaVersion: 2, kind: 'marketing-composition', compositionId: value.compositionId,
    assembly: { sourceRevision: value.assembly.sourceRevision, ciRunId: value.assembly.ciRunId,
      buildRunId: value.assembly.buildRunId, buildRunAttempt: Number(value.assembly.buildRunAttempt) },
    compatibilitySha256: value.compatibilitySha256, services: services as CompositionServices };
}

export function parseCompositionAdmission(value: unknown): CompositionAdmission | null {
  if (!record(value) || !keys(value, ['schemaVersion', 'environment', 'expectedPrevious', 'policySha256',
    'configurationSha256', 'acceptedSchemaSha256', 'acceptanceReference'])
    || value.schemaVersion !== 2 || !['staging', 'production'].includes(String(value.environment))
    || !release(value.expectedPrevious) || !digest(value.policySha256) || !digest(value.configurationSha256)
    || !Array.isArray(value.acceptedSchemaSha256) || value.acceptedSchemaSha256.length < 1
    || value.acceptedSchemaSha256.length > 16 || !value.acceptedSchemaSha256.every(digest)
    || new Set(value.acceptedSchemaSha256).size !== value.acceptedSchemaSha256.length
    || !reference(value.acceptanceReference)) return null;
  return { schemaVersion: 2, environment: value.environment as 'staging' | 'production',
    expectedPrevious: value.expectedPrevious, policySha256: value.policySha256,
    configurationSha256: value.configurationSha256, acceptedSchemaSha256: [...value.acceptedSchemaSha256],
    acceptanceReference: value.acceptanceReference };
}

export type DeploymentInventoryEntry = Readonly<{ path: string; kind: 'file'; mode: 420 | 493; bytes: number; sha256: string }>
  | Readonly<{ path: string; kind: 'symlink'; target: string }>;
export type MarketingReleaseManifest = Readonly<{
  schemaVersion: 2; kind: 'marketing-unit'; sourceRevision: string; releaseId: string;
  lockfileSha256: string; platform: 'linux'; architecture: 'x64'; nodeVersion: string;
  variant: string; publicConfigSha256: string; schemaSha256: string; compatibilitySha256: string;
  entry: typeof COMPOSITION_SERVICE_ENTRIES.marketing; files: readonly DeploymentInventoryEntry[];
}>;
const relativePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 2048 && !value.includes('\\') && !/[\x00-\x1f\x7f]/u.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

export function parseMarketingReleaseManifest(value: unknown): MarketingReleaseManifest | null {
  if (!record(value) || !keys(value, ['schemaVersion', 'kind', 'sourceRevision', 'releaseId', 'lockfileSha256',
    'platform', 'architecture', 'nodeVersion', 'variant', 'publicConfigSha256', 'schemaSha256',
    'compatibilitySha256', 'entry', 'files']) || value.schemaVersion !== 2 || value.kind !== 'marketing-unit'
    || !sha(value.sourceRevision) || !release(value.releaseId) || !value.releaseId.startsWith(`${value.sourceRevision}-`)
    || !digest(value.lockfileSha256) || value.platform !== 'linux' || value.architecture !== 'x64'
    || typeof value.nodeVersion !== 'string' || !/^24\.\d+\.\d+$/u.test(value.nodeVersion)
    || typeof value.variant !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(value.variant)
    || !digest(value.publicConfigSha256) || !digest(value.schemaSha256) || !digest(value.compatibilitySha256)
    || value.entry !== COMPOSITION_SERVICE_ENTRIES.marketing || !Array.isArray(value.files)
    || value.files.length === 0 || value.files.length > 200_000) return null;
  const paths = new Set<string>(); const files: DeploymentInventoryEntry[] = [];
  let bytes = 0;
  for (const file of value.files) {
    if (!record(file) || !relativePath(file.path) || paths.has(file.path)
      || !(file.path.startsWith('bin/') || file.path.startsWith('units/marketing/'))) return null;
    paths.add(file.path);
    if (file.kind === 'file' && keys(file, ['path', 'kind', 'mode', 'bytes', 'sha256'])
      && [420, 493].includes(Number(file.mode)) && typeof file.mode === 'number'
      && typeof file.bytes === 'number' && Number.isSafeInteger(file.bytes) && file.bytes >= 0
      && file.bytes <= 256 * 1024 ** 2 && digest(file.sha256)) {
      bytes += file.bytes;
      if (bytes > 4 * 1024 ** 3) return null;
      files.push({ path: file.path, kind: 'file', mode: file.mode as 420 | 493, bytes: file.bytes, sha256: file.sha256 });
    } else if (file.kind === 'symlink' && keys(file, ['path', 'kind', 'target'])
      && typeof file.target === 'string' && file.target.length > 0 && file.target.length <= 2048
      && !file.target.startsWith('/') && !file.target.includes('\\') && !/[\x00-\x1f\x7f]/u.test(file.target)) {
      files.push({ path: file.path, kind: 'symlink', target: file.target });
    } else return null;
  }
  if (!['bin/node', 'bin/launch.mjs', COMPOSITION_SERVICE_ENTRIES.marketing].every(path =>
    files.some(file => file.path === path && file.kind === 'file'))) return null;
  return { schemaVersion: 2, kind: 'marketing-unit', sourceRevision: value.sourceRevision, releaseId: value.releaseId,
    lockfileSha256: value.lockfileSha256, platform: 'linux', architecture: 'x64', nodeVersion: value.nodeVersion,
    variant: value.variant, publicConfigSha256: value.publicConfigSha256, schemaSha256: value.schemaSha256,
    compatibilitySha256: value.compatibilitySha256, entry: COMPOSITION_SERVICE_ENTRIES.marketing, files };
}

export type MarketingReleaseRequest = Readonly<{
  schemaVersion: 2;
  kind: 'marketing-copy' | 'marketing-validate';
  marketing?: DeploymentArtifactReference;
  base: DeploymentArtifactReference;
  services: readonly CompositionService[];
  sourceEvidence: Readonly<{ runId: string; artifact: 'published-release' | 'staging-deployment' }>;
  admissions: Readonly<{ staging: CompositionAdmission; production: CompositionAdmission }>;
}>;
export function parseMarketingReleaseRequest(value: unknown): MarketingReleaseRequest | null {
  if (!record(value) || !keys(value, ['schemaVersion', 'kind', 'base', 'services', 'sourceEvidence', 'admissions',
    ...(value.kind === 'marketing-validate' ? ['marketing'] : [])])
    || value.schemaVersion !== 2 || !['marketing-copy', 'marketing-validate'].includes(String(value.kind)) || !Array.isArray(value.services)
    || value.services.length !== new Set(value.services).size
    || !['api', 'chat', 'marketing'].every(service => (value.services as unknown[]).includes(service))
    || value.services.some(service => typeof service !== 'string' || !Object.hasOwn(COMPOSITION_SERVICE_ENTRIES, service))
    || (value.services.includes('authWorker') && !value.services.includes('auth'))
    || !record(value.sourceEvidence) || !keys(value.sourceEvidence, ['runId', 'artifact'])
    || !id(value.sourceEvidence.runId) || !['published-release', 'staging-deployment'].includes(String(value.sourceEvidence.artifact))
    || !record(value.admissions) || !keys(value.admissions, ['staging', 'production'])) return null;
  const base = parseDeploymentArtifactReference(value.base, 'api');
  const marketing = value.kind === 'marketing-validate' ? parseDeploymentArtifactReference(value.marketing, 'marketing') : null;
  const staging = parseCompositionAdmission(value.admissions.staging);
  const production = parseCompositionAdmission(value.admissions.production);
  if (!base || !staging || staging.environment !== 'staging' || !production || production.environment !== 'production'
    || (value.kind === 'marketing-validate' && (marketing?.format !== 2 || value.sourceEvidence.artifact !== 'staging-deployment'))) return null;
  return { schemaVersion: 2, kind: value.kind as MarketingReleaseRequest['kind'], base, ...(marketing ? { marketing } : {}),
    services: (Object.keys(COMPOSITION_SERVICE_ENTRIES) as CompositionService[]).filter(service => (value.services as unknown[]).includes(service)),
    sourceEvidence: { runId: value.sourceEvidence.runId, artifact: value.sourceEvidence.artifact as 'published-release' | 'staging-deployment' },
    admissions: { staging, production } };
}

export type RetainedRuntimeIdentity = Readonly<{ containerId: string; imageId: string; startedAt: string; running: true }>;
export type MarketingOperation = Readonly<{
  schemaVersion: 2; operationId: string; mode: 'marketing'; candidate: string; previous: string | null; expectedPrevious: string;
  startedAt: string; status: 'in_progress' | 'succeeded' | 'rejected' | 'rolled_back' | 'recovery_required';
  phase: 'preflight' | 'admitted' | 'marketing_drained' | 'replacement_started' | 'checking' | 'committed' | 'rolling_back' | 'rejected' | 'rolled_back' | 'recovery_required';
  admission?: CompositionAdmission;
  retained?: Readonly<Record<string, RetainedRuntimeIdentity>>;
  /** Boot of the effective recoveredRetained ?? retained baseline. */
  retainedBootId?: string;
  reason?: string; recoveryReason?: string; recoveredAt?: string; recoveredAfterBoot?: boolean;
  recoveredRetained?: Readonly<Record<string, RetainedRuntimeIdentity>>;
}>;
/** Stable reason carried by an operation receipt (reason / recoveryReason). release-transaction.mjs, the producer, imports this same pattern. */
export const DEPLOYMENT_OPERATION_REASON_PATTERN = /^DEPLOY_[A-Z0-9_]{1,80}$/u;
export function parseMarketingOperation(value: unknown): MarketingOperation | null {
  const required = ['schemaVersion', 'operationId', 'mode', 'candidate', 'previous', 'expectedPrevious', 'startedAt', 'status', 'phase'];
  const optional = ['admission', 'retained', 'retainedBootId', 'reason', 'recoveryReason', 'recoveredAt', 'recoveredAfterBoot', 'recoveredRetained'];
  const identifier = (item: unknown) => typeof item === 'string' && /^[a-z0-9][a-z0-9-]{0,159}$/u.test(item);
  const timestamp = (item: unknown) => typeof item === 'string' && item.length <= 64 && Number.isFinite(Date.parse(item));
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
    || value.schemaVersion !== 2 || value.mode !== 'marketing'
    || typeof value.operationId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.operationId)
    || !identifier(value.candidate) || !(value.previous === null || identifier(value.previous)) || !identifier(value.expectedPrevious)
    || !timestamp(value.startedAt)
    || !['in_progress', 'succeeded', 'rejected', 'rolled_back', 'recovery_required'].includes(String(value.status))
    || !['preflight', 'admitted', 'marketing_drained', 'replacement_started', 'checking', 'committed', 'rolling_back', 'rejected', 'rolled_back', 'recovery_required'].includes(String(value.phase))
    || ['reason', 'recoveryReason'].some(key => Object.hasOwn(value, key) && (typeof value[key] !== 'string' || !DEPLOYMENT_OPERATION_REASON_PATTERN.test(value[key] as string)))
    || (Object.hasOwn(value, 'recoveredAt') && !timestamp(value.recoveredAt))
    || (Object.hasOwn(value, 'recoveredAfterBoot') && typeof value.recoveredAfterBoot !== 'boolean')) return null;
  if (Object.hasOwn(value, 'retained') !== Object.hasOwn(value, 'retainedBootId')
    || (Object.hasOwn(value, 'recoveredRetained') && !Object.hasOwn(value, 'retained'))
    || (Object.hasOwn(value, 'retainedBootId') && (typeof value.retainedBootId !== 'string'
      || !(value.retainedBootId === 'local' || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.retainedBootId))))) return null;
  if (Object.hasOwn(value, 'admission') && !parseCompositionAdmission(value.admission)) return null;
  for (const snapshot of ['retained', 'recoveredRetained']) {
    if (!Object.hasOwn(value, snapshot)) continue;
    if (!record(value[snapshot])) return null;
    for (const [service, identity] of Object.entries(value[snapshot])) {
      if (!['api', 'auth', 'auth-worker', 'chat', 'gateway'].includes(service) || !record(identity)
        || !keys(identity, ['containerId', 'imageId', 'startedAt', 'running'])
        || typeof identity.containerId !== 'string' || !/^[a-f0-9]{64}$/u.test(identity.containerId)
        || typeof identity.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(identity.imageId)
        || !timestamp(identity.startedAt) || identity.running !== true) return null;
    }
  }
  return { ...value } as MarketingOperation;
}

export function parseCompositionSourceEvidence(value: unknown): MarketingReleaseRequest['sourceEvidence'] | null {
  if (!record(value) || !keys(value, ['runId', 'artifact']) || !id(value.runId)
    || !['published-release', 'staging-deployment'].includes(String(value.artifact))) return null;
  return { runId: value.runId, artifact: value.artifact as 'published-release' | 'staging-deployment' };
}

export type CompositionReleaseReceipt = Readonly<{
  schemaVersion: 2; kind: 'marketing-composition'; image: string;
  sourceRevision: string; releaseId: string; ciRunId: string; buildRunId: string;
  composition: DeploymentComposition;
  admissions: MarketingReleaseRequest['admissions'];
  sourceEvidence: MarketingReleaseRequest['sourceEvidence'];
}>;
/** Transport identity describes assembly; individual sources remain on each artifact. */
export function parseCompositionReleaseReceipt(value: unknown): CompositionReleaseReceipt | null {
  const required = ['schemaVersion', 'kind', 'image', 'sourceRevision', 'releaseId', 'ciRunId', 'buildRunId', 'composition', 'admissions', 'sourceEvidence'];
  const optional = ['environment', 'commandId', 'operation', 'acceptanceUrl', 'approval'];
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
    || value.schemaVersion !== 2 || value.kind !== 'marketing-composition' || !image(value.image)
    || !record(value.admissions) || !keys(value.admissions, ['staging', 'production'])) return null;
  if ((Object.hasOwn(value, 'environment') && !['staging', 'production'].includes(String(value.environment)))
    || (Object.hasOwn(value, 'commandId') && (typeof value.commandId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.commandId)))
    || (Object.hasOwn(value, 'operation') && !parseMarketingOperation(value.operation))
    || (Object.hasOwn(value, 'acceptanceUrl') && !reference(value.acceptanceUrl))) return null;
  if (Object.hasOwn(value, 'approval')) {
    const approval = value.approval;
    if (!record(approval) || !keys(approval, ['mode', 'actorId', 'runId', 'runAttempt', 'workflowRevision'])
      || approval.mode !== 'github-free-owner' || !id(approval.actorId) || !id(approval.runId)
      || approval.runAttempt !== 1 || !sha(approval.workflowRevision)) return null;
  }
  const composition = parseDeploymentComposition(value.composition);
  const sourceEvidence = parseCompositionSourceEvidence(value.sourceEvidence);
  const staging = parseCompositionAdmission(value.admissions.staging);
  const production = parseCompositionAdmission(value.admissions.production);
  if (!composition || !sourceEvidence || !staging || staging.environment !== 'staging'
    || !production || production.environment !== 'production' || value.releaseId !== composition.compositionId
    || value.sourceRevision !== composition.assembly.sourceRevision || value.ciRunId !== composition.assembly.ciRunId
    || value.buildRunId !== composition.assembly.buildRunId || value.image.split('@')[0] !== composition.services.api.image.split('@')[0]) return null;
  return { schemaVersion: 2, kind: 'marketing-composition', image: value.image,
    sourceRevision: composition.assembly.sourceRevision, releaseId: composition.compositionId,
    ciRunId: composition.assembly.ciRunId, buildRunId: composition.assembly.buildRunId,
    composition, sourceEvidence, admissions: { staging, production } };
}
