import { parseNormalStagingAcceptedRuntime, type NormalStagingAcceptedRuntime } from './deployment-accepted-runtime.ts';

export const SINGLE_ADMIN_LAUNCH_INVALID = 'DEPLOY_SINGLE_ADMIN_LAUNCH_INVALID' as const;
export const SINGLE_ADMIN_LAUNCH_PATH = '/run/edaix/auth-single-admin/launch.json' as const;
export const SINGLE_ADMIN_RUNTIME_MODE = 'staging-single-admin-runtime' as const;
export type SingleAdminRuntime = Readonly<Omit<NormalStagingAcceptedRuntime, 'mode'> & {
  mode: typeof SINGLE_ADMIN_RUNTIME_MODE;
  currentReleaseId: string;
  currentManifestSha256: string;
  candidateManifestSha256: string;
  authSchemaSha256: string;
  image: string;
}>;
/** DEP start proof only. Auth independently verifies the per-account protected approval. */
export type SingleAdminLaunch = Readonly<{
  schemaVersion: 1;
  purpose: 'staging-single-admin-launch';
  service: 'authSingleAdmin';
  grantId: string;
  grantSha256: string;
  scopeSha256: string;
  parameterVersion: number;
  observedAt: string;
  expiresAt: string;
  runtime: SingleAdminRuntime;
}>;
const fields = ['schemaVersion', 'purpose', 'service', 'grantId', 'grantSha256', 'scopeSha256',
  'parameterVersion', 'observedAt', 'expiresAt', 'runtime'];

/** The protected producer proves provenance and live grant; this parser never manufactures authority. */
export function parseSingleAdminLaunch(value: unknown, now = Date.now()): SingleAdminLaunch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(now)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== fields.length || !fields.every(key => Object.hasOwn(item, key))
    || item.schemaVersion !== 1 || item.purpose !== 'staging-single-admin-launch' || item.service !== 'authSingleAdmin'
    || typeof item.grantId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(item.grantId)
    || !['grantSha256', 'scopeSha256'].every(key => typeof item[key] === 'string' && /^[a-f0-9]{64}$/u.test(item[key]))
    || typeof item.parameterVersion !== 'number' || !Number.isSafeInteger(item.parameterVersion) || item.parameterVersion < 1
    || typeof item.observedAt !== 'string' || typeof item.expiresAt !== 'string') return null;
  const start = Date.parse(item.observedAt), end = Date.parse(item.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > now || now >= end || end - start > 300_000
    || new Date(start).toISOString() !== item.observedAt || new Date(end).toISOString() !== item.expiresAt) return null;
  const runtime = parseSingleAdminRuntime(item.runtime);
  return runtime ? Object.freeze({ ...item, runtime }) as SingleAdminLaunch : null;
}

/** Reuses only pure field validation. The returned discriminant can never pass an ordinary B runtime parser. */
export function parseSingleAdminRuntime(value: unknown): SingleAdminRuntime | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const { currentReleaseId, currentManifestSha256, candidateManifestSha256, authSchemaSha256, image, ...shared } = row;
  if (shared.mode !== SINGLE_ADMIN_RUNTIME_MODE
    || typeof currentReleaseId !== 'string' || !/^[a-f0-9]{40}-default-x64-[a-f0-9]{12}$/u.test(currentReleaseId)
    || ![currentManifestSha256, candidateManifestSha256, authSchemaSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))
    || typeof image !== 'string' || !/^\d{12}\.dkr\.ecr\.[a-z]{2}-[a-z]+-\d\.amazonaws\.com\/[a-z0-9][a-z0-9/_-]*@sha256:[a-f0-9]{64}$/u.test(image)
    || !parseNormalStagingAcceptedRuntime({ ...shared, mode: 'normal-staging-accepted-runtime' })) return null;
  return Object.freeze({ ...row }) as SingleAdminRuntime;
}

/** Auth single-admin consumer only. Never add this branch to the ordinary owner-runtime parser. */
export function deploymentSingleAdminRuntime(environment: Readonly<Record<string, string | undefined>>, now = Date.now()): SingleAdminRuntime | null {
  if (environment.EDAIX_OWNER_ADMISSION_MODE !== SINGLE_ADMIN_RUNTIME_MODE && environment.EDAIX_SINGLE_ADMIN_LAUNCH === undefined) return null;
  const raw = environment.EDAIX_SINGLE_ADMIN_LAUNCH;
  if (environment.EDAIX_OWNER_ADMISSION_MODE !== SINGLE_ADMIN_RUNTIME_MODE || typeof raw !== 'string'
    || new TextEncoder().encode(raw).byteLength > 8192 || environment.NODE_ENV !== 'production'
    || environment.EDAIX_DEPLOYMENT_ENVIRONMENT !== 'staging' || environment.EDAIX_RELEASE_VARIANT !== 'default'
    || environment.EDAIX_NORMAL_STAGING_OWNER_ADMISSION !== undefined || environment.EDAIX_NORMAL_STAGING_ACCEPTED_RUNTIME !== undefined
    || environment.EDAIX_PRIVATE_PREVIEW_ADMISSION !== undefined) throw new Error(SINGLE_ADMIN_LAUNCH_INVALID);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(SINGLE_ADMIN_LAUNCH_INVALID); }
  const proof = parseSingleAdminLaunch(value, now);
  const bindings = [['revision', 'EDAIX_RELEASE_REVISION'], ['releaseId', 'EDAIX_RELEASE_ID'],
    ['publicConfigSha256', 'EDAIX_PUBLIC_CONFIG_SHA256'], ['configurationSha256', 'EDAIX_CONFIGURATION_SHA256'],
    ['hostSha256', 'EDAIX_HOST_SHA256'], ['hostPolicySha256', 'EDAIX_HOST_POLICY_SHA256'],
    ['operationId', 'EDAIX_OPERATION_ID'], ['bootId', 'EDAIX_BOOT_ID'], ['launchId', 'EDAIX_LAUNCH_ID']] as const;
  if (!proof || !bindings.every(([field, key]) => proof.runtime[field] === environment[key])) throw new Error(SINGLE_ADMIN_LAUNCH_INVALID);
  return proof.runtime;
}
