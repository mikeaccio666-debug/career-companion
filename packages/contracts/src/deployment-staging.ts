import { parseDeploymentVersion } from './deployment.ts';

/** Operational staging admission only; never a feature, payment or production release. */
export const NORMAL_STAGING_OWNER_ADMISSION_MODE = 'normal-staging-owner-admission' as const;
export const NORMAL_STAGING_OWNER_ADMISSION_INVALID = 'DEPLOY_NORMAL_STAGING_OWNER_ADMISSION_INVALID' as const;
export const NORMAL_STAGING_OWNER_ADMISSION_MAX_BYTES = 8192;
/** Exact process bindings retained by the API for request-time expiry validation. */
export const NORMAL_STAGING_OWNER_ADMISSION_BINDING_FIELDS = Object.freeze([
  'NODE_ENV', 'EDAIX_DEPLOYMENT_ENVIRONMENT', 'EDAIX_RELEASE_VARIANT', 'EDAIX_RELEASE_REVISION',
  'EDAIX_RELEASE_ID', 'EDAIX_PUBLIC_CONFIG_SHA256', 'EDAIX_CONFIGURATION_SHA256',
  'EDAIX_OWNER_ADMISSION_MODE', 'EDAIX_NORMAL_STAGING_OWNER_ADMISSION', 'EDAIX_PRIVATE_PREVIEW_ADMISSION',
] as const);

export type NormalStagingOwnerAdmission = Readonly<{
  schemaVersion: 1;
  mode: typeof NORMAL_STAGING_OWNER_ADMISSION_MODE;
  environment: 'staging';
  revision: string;
  releaseId: string;
  publicConfigSha256: string;
  /** Hash of the ordered protected raw service-env hashes, excluding injected admission bindings. */
  configurationSha256: string;
  portalOrigin: string;
  apiOrigin: string;
  authIssuer: string;
  authAudience: string;
  authUpstreamOrigin: string;
  approvedAt: string;
  expiresAt: string;
}>;

const FIELDS = Object.freeze([
  'schemaVersion', 'mode', 'environment', 'revision', 'releaseId', 'publicConfigSha256',
  'configurationSha256', 'portalOrigin', 'apiOrigin', 'authIssuer', 'authAudience',
  'authUpstreamOrigin', 'approvedAt', 'expiresAt',
]);
const MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

function canonicalHttpsOrigin(value: unknown, publicHost: boolean): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) return false;
  if (!publicHost) return true;
  const host = url.hostname;
  return host.length <= 253 && host.includes('.')
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host)
    && !/^[0-9.]+$/u.test(host)
    && !/(?:^|\.)(?:localhost|local|internal)$/u.test(host)
    && host.split('.').every(label => label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label));
}

function canonicalTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

/** Pure shape/currentness validation. Host policy and protected-file provenance are checked by DEP. */
export function parseNormalStagingOwnerAdmission(
  value: unknown, now = Date.now(),
): NormalStagingOwnerAdmission | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isFinite(now)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(item, key))
    || item.schemaVersion !== 1 || item.mode !== NORMAL_STAGING_OWNER_ADMISSION_MODE
    || item.environment !== 'staging'
    || !parseDeploymentVersion({ schemaVersion: 1, revision: item.revision, releaseId: item.releaseId })
    || typeof item.releaseId !== 'string' || !item.releaseId.startsWith(`${item.revision}-default-`)
    || !['publicConfigSha256', 'configurationSha256'].every(key => typeof item[key] === 'string'
      && /^[a-f0-9]{64}$/u.test(item[key]))
    || !canonicalHttpsOrigin(item.portalOrigin, true) || !canonicalHttpsOrigin(item.apiOrigin, true)
    || !canonicalHttpsOrigin(item.authIssuer, true) || !canonicalHttpsOrigin(item.authUpstreamOrigin, false)
    || typeof item.authAudience !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.authAudience)) return null;
  const start = canonicalTime(item.approvedAt);
  const end = canonicalTime(item.expiresAt);
  if (start === null || end === null || start > now || end <= now || end <= start
    || end - start > MAX_VALIDITY_MS) return null;
  return Object.freeze({ ...item }) as NormalStagingOwnerAdmission;
}

/**
 * These bindings must be overwritten by the protected launcher after host/manifest/config verification.
 * A parsed JSON object alone is not evidence of that provenance. Callers must not cache past expiry.
 */
export function deploymentNormalStagingOwnerAdmission(
  environment: Readonly<Record<string, string | undefined>>, now = Date.now(),
): NormalStagingOwnerAdmission | null {
  const mode = environment.EDAIX_OWNER_ADMISSION_MODE;
  const raw = environment.EDAIX_NORMAL_STAGING_OWNER_ADMISSION;
  if (mode === undefined && raw === undefined) return null;
  if (mode !== NORMAL_STAGING_OWNER_ADMISSION_MODE || typeof raw !== 'string'
    || new TextEncoder().encode(raw).byteLength > NORMAL_STAGING_OWNER_ADMISSION_MAX_BYTES) throw invalidAdmission();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalidAdmission(); }
  const admission = parseNormalStagingOwnerAdmission(value, now);
  if (!admission || environment.NODE_ENV !== 'production'
    || environment.EDAIX_DEPLOYMENT_ENVIRONMENT !== 'staging'
    || environment.EDAIX_RELEASE_VARIANT !== 'default'
    || environment.EDAIX_PRIVATE_PREVIEW_ADMISSION !== undefined
    || admission.revision !== environment.EDAIX_RELEASE_REVISION
    || admission.releaseId !== environment.EDAIX_RELEASE_ID
    || admission.publicConfigSha256 !== environment.EDAIX_PUBLIC_CONFIG_SHA256
    || admission.configurationSha256 !== environment.EDAIX_CONFIGURATION_SHA256) throw invalidAdmission();
  return admission;
}

function invalidAdmission(): Error {
  return new Error(NORMAL_STAGING_OWNER_ADMISSION_INVALID);
}
