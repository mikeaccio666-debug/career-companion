import { parseDeploymentVersion } from './deployment.ts';
import {
  deploymentNormalStagingOwnerAdmission,
  NORMAL_STAGING_OWNER_ADMISSION_BINDING_FIELDS,
  type NormalStagingOwnerAdmission,
} from './deployment-staging.ts';

/** Protected launch identity for ordinary staging. Never an Auth or feature release grant. */
export const NORMAL_STAGING_ACCEPTED_RUNTIME_MODE = 'normal-staging-accepted-runtime' as const;
export const NORMAL_STAGING_ACCEPTED_RUNTIME_INVALID = 'DEPLOY_NORMAL_STAGING_ACCEPTED_RUNTIME_INVALID' as const;
export const NORMAL_STAGING_ACCEPTED_RUNTIME_MAX_BYTES = 8192;
const ACCEPTED_BINDINGS = Object.freeze([
  'EDAIX_NORMAL_STAGING_ACCEPTED_RUNTIME', 'EDAIX_HOST_SHA256', 'EDAIX_HOST_POLICY_SHA256',
  'EDAIX_OPERATION_ID', 'EDAIX_BOOT_ID', 'EDAIX_LAUNCH_ID',
] as const);
/** Capture once at process construction; ambient mutations cannot replace the launch authority. */
export const STAGING_OWNER_RUNTIME_BINDING_FIELDS = Object.freeze([
  ...NORMAL_STAGING_OWNER_ADMISSION_BINDING_FIELDS, ...ACCEPTED_BINDINGS, 'EDAIX_SINGLE_ADMIN_LAUNCH',
] as const);

export type NormalStagingAcceptedRuntime = Readonly<{
  schemaVersion: 1;
  mode: typeof NORMAL_STAGING_ACCEPTED_RUNTIME_MODE;
  environment: 'staging';
  revision: string;
  releaseId: string;
  publicConfigSha256: string;
  configurationSha256: string;
  portalOrigin: string;
  apiOrigin: string;
  authIssuer: string;
  authAudience: string;
  authUpstreamOrigin: string;
  hostSha256: string;
  hostPolicySha256: string;
  operationId: string;
  bootId: string;
  launchId: string;
}>;
const FIELDS = Object.freeze([
  'schemaVersion', 'mode', 'environment', 'revision', 'releaseId', 'publicConfigSha256',
  'configurationSha256', 'portalOrigin', 'apiOrigin', 'authIssuer', 'authAudience',
  'authUpstreamOrigin', 'hostSha256', 'hostPolicySha256', 'operationId', 'bootId', 'launchId',
]);
const MATCHED_BINDINGS = Object.freeze([
  ['revision', 'EDAIX_RELEASE_REVISION'], ['releaseId', 'EDAIX_RELEASE_ID'],
  ['publicConfigSha256', 'EDAIX_PUBLIC_CONFIG_SHA256'], ['configurationSha256', 'EDAIX_CONFIGURATION_SHA256'],
  ['hostSha256', 'EDAIX_HOST_SHA256'], ['hostPolicySha256', 'EDAIX_HOST_POLICY_SHA256'],
  ['operationId', 'EDAIX_OPERATION_ID'], ['bootId', 'EDAIX_BOOT_ID'], ['launchId', 'EDAIX_LAUNCH_ID'],
] as const);

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

/** Shape validation only. DEP verifies protected provenance, fresh grants and start/health ordering. */
export function parseNormalStagingAcceptedRuntime(value: unknown): NormalStagingAcceptedRuntime | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(item, key))
    || item.schemaVersion !== 1 || item.mode !== NORMAL_STAGING_ACCEPTED_RUNTIME_MODE
    || item.environment !== 'staging'
    || !parseDeploymentVersion({ schemaVersion: 1, revision: item.revision, releaseId: item.releaseId })
    || typeof item.releaseId !== 'string' || !item.releaseId.startsWith(`${item.revision}-default-`)
    || !['publicConfigSha256', 'configurationSha256', 'hostSha256', 'hostPolicySha256'].every(key =>
      typeof item[key] === 'string' && /^[a-f0-9]{64}$/u.test(item[key]))
    || !['operationId', 'bootId', 'launchId'].every(key => typeof item[key] === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(item[key]))
    || !canonicalHttpsOrigin(item.portalOrigin, true) || !canonicalHttpsOrigin(item.apiOrigin, true)
    || !canonicalHttpsOrigin(item.authIssuer, true) || !canonicalHttpsOrigin(item.authUpstreamOrigin, false)
    || typeof item.authAudience !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.authAudience)) return null;
  return Object.freeze({ ...item }) as NormalStagingAcceptedRuntime;
}

/**
 * Select one operational mode. Legacy admission retains its original time limit; accepted runtime
 * has no deployment clock. Each new process still requires a fresh DEP grant and launch identity.
 * Neither branch replaces access-token, durable session, owner, role or entitlement validation.
 */
export function deploymentStagingOwnerRuntime(
  environment: Readonly<Record<string, string | undefined>>, now = Date.now(),
): NormalStagingOwnerAdmission | NormalStagingAcceptedRuntime | null {
  if (environment.EDAIX_SINGLE_ADMIN_LAUNCH !== undefined) throw invalidRuntime();
  if (environment.EDAIX_OWNER_ADMISSION_MODE !== NORMAL_STAGING_ACCEPTED_RUNTIME_MODE
    && !ACCEPTED_BINDINGS.some(key => environment[key] !== undefined)) {
    return deploymentNormalStagingOwnerAdmission(environment, now);
  }
  const raw = environment.EDAIX_NORMAL_STAGING_ACCEPTED_RUNTIME;
  if (environment.EDAIX_OWNER_ADMISSION_MODE !== NORMAL_STAGING_ACCEPTED_RUNTIME_MODE
    || typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > NORMAL_STAGING_ACCEPTED_RUNTIME_MAX_BYTES
    || environment.EDAIX_NORMAL_STAGING_OWNER_ADMISSION !== undefined
    || environment.EDAIX_PRIVATE_PREVIEW_ADMISSION !== undefined) throw invalidRuntime();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalidRuntime(); }
  const runtime = parseNormalStagingAcceptedRuntime(value);
  if (!runtime || environment.NODE_ENV !== 'production'
    || environment.EDAIX_DEPLOYMENT_ENVIRONMENT !== 'staging'
    || environment.EDAIX_RELEASE_VARIANT !== 'default'
    || !MATCHED_BINDINGS.every(([field, key]) => runtime[field] === environment[key])) throw invalidRuntime();
  return runtime;
}

function invalidRuntime(): Error {
  return new Error(NORMAL_STAGING_ACCEPTED_RUNTIME_INVALID);
}
