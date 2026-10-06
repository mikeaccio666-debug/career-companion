import { describe, expect, it } from 'vitest';
import {
  NORMAL_STAGING_ACCEPTED_RUNTIME_MODE,
  NORMAL_STAGING_ACCEPTED_RUNTIME_INVALID,
  deploymentStagingOwnerRuntime,
  parseNormalStagingAcceptedRuntime,
} from '../src/deployment-accepted-runtime.ts';

const now = Date.parse('2026-09-09T10:00:00.000Z');
const revision = 'a'.repeat(40);
const admission = {
  schemaVersion: 1,
  mode: 'normal-staging-accepted-runtime',
  environment: 'staging',
  revision,
  releaseId: `${revision}-default-x64-${'b'.repeat(12)}`,
  publicConfigSha256: 'c'.repeat(64),
  configurationSha256: 'd'.repeat(64),
  portalOrigin: 'https://staging.example.com',
  apiOrigin: 'https://api.staging.example.com',
  authIssuer: 'https://auth.staging.example.com',
  authAudience: 'edaix-api',
  authUpstreamOrigin: 'https://auth-gateway',
  hostSha256: 'e'.repeat(64), hostPolicySha256: 'f'.repeat(64),
  operationId: '40000000-0000-4000-8000-000000000001', bootId: '50000000-0000-4000-8000-000000000001',
  launchId: '60000000-0000-4000-8000-000000000001',
};
function bindings() {
  return {
    NODE_ENV: 'production',
    EDAIX_DEPLOYMENT_ENVIRONMENT: 'staging',
    EDAIX_RELEASE_VARIANT: 'default',
    EDAIX_RELEASE_REVISION: revision,
    EDAIX_RELEASE_ID: admission.releaseId,
    EDAIX_PUBLIC_CONFIG_SHA256: admission.publicConfigSha256,
    EDAIX_CONFIGURATION_SHA256: admission.configurationSha256,
    EDAIX_HOST_SHA256: admission.hostSha256, EDAIX_HOST_POLICY_SHA256: admission.hostPolicySha256,
    EDAIX_OPERATION_ID: admission.operationId, EDAIX_BOOT_ID: admission.bootId, EDAIX_LAUNCH_ID: admission.launchId,
    EDAIX_OWNER_ADMISSION_MODE: NORMAL_STAGING_ACCEPTED_RUNTIME_MODE,
    EDAIX_NORMAL_STAGING_ACCEPTED_RUNTIME: JSON.stringify(admission),
  };
}

describe('normal staging accepted runtime', () => {
  it('admits only exact current staging bindings and keeps unconfigured launches off', () => {
    expect(parseNormalStagingAcceptedRuntime(admission)).toEqual(admission);
    expect(deploymentStagingOwnerRuntime(bindings(), now)).toEqual(admission);
    expect(deploymentStagingOwnerRuntime({}, now)).toBeNull();
    expect(deploymentStagingOwnerRuntime({ EDAIX_DEPLOYMENT_ENVIRONMENT: 'staging' }, now)).toBeNull();
  });

  it.each([
    { extra: true }, { schemaVersion: 2 }, { environment: 'production' }, { mode: 'staging-private-preview' },
    { revision: 'b'.repeat(40) }, { releaseId: `${revision}-staging-x64-${'b'.repeat(12)}` },
    { configurationSha256: 'd'.repeat(63) }, { publicConfigSha256: 'C'.repeat(64) },
    { approvedAt: '2026-09-09T10:01:00.000Z' }, { expiresAt: '2026-09-09T10:00:00.000Z' },
    { expiresAt: '2026-09-17T10:00:00.000Z' }, { approvedAt: '2026-02-30T10:00:00.000Z' },
    { portalOrigin: 'https://localhost:18443' }, { portalOrigin: 'https://127.0.0.1' },
    { portalOrigin: 'https://[::1]' }, { portalOrigin: 'https://portal.internal' },
    { portalOrigin: 'https://user@staging.example.com' }, { portalOrigin: 'https://staging.example.com/' },
    { apiOrigin: 'http://api.staging.example.com' }, { apiOrigin: 'https://api.staging.example.com?a=b' },
    { authIssuer: 'https://localhost' }, { authUpstreamOrigin: 'http://auth-gateway' },
    { hostSha256: 'e'.repeat(63) }, { hostPolicySha256: 'F'.repeat(64) },
    { operationId: '40000000-0000-1000-8000-000000000001' }, { bootId: 'not-a-uuid' },
    { launchId: '60000000-0000-4000-7000-000000000001' }, { acceptedAt: '2026-09-09T10:00:00.000Z' },
    { healthAccepted: true }, { authAudience: '' }, { authAudience: 'audience\n' },
  ])('rejects malformed shape or authority %j', patch => {
    expect(parseNormalStagingAcceptedRuntime({ ...admission, ...patch })).toBeNull();
  });

  it.each([
    { NODE_ENV: 'development' }, { EDAIX_DEPLOYMENT_ENVIRONMENT: 'production' },
    { EDAIX_RELEASE_VARIANT: undefined }, { EDAIX_RELEASE_VARIANT: 'staging-private-preview' },
    { EDAIX_RELEASE_ID: `${revision}-default-x64-${'e'.repeat(12)}` },
    { EDAIX_RELEASE_REVISION: 'e'.repeat(40) }, { EDAIX_PUBLIC_CONFIG_SHA256: 'e'.repeat(64) },
    { EDAIX_CONFIGURATION_SHA256: 'e'.repeat(64) }, { EDAIX_OWNER_ADMISSION_MODE: undefined },
    { EDAIX_OWNER_ADMISSION_MODE: 'other' }, { EDAIX_NORMAL_STAGING_ACCEPTED_RUNTIME: undefined },
    { EDAIX_NORMAL_STAGING_ACCEPTED_RUNTIME: '{' }, { EDAIX_NORMAL_STAGING_ACCEPTED_RUNTIME: ' '.repeat(8193) },
    { EDAIX_PRIVATE_PREVIEW_ADMISSION: '{}' },
  ])('fails closed for partial or mismatched runtime bindings %j', patch => {
    expect(() => deploymentStagingOwnerRuntime({ ...bindings(), ...patch }, now))
      .toThrow(NORMAL_STAGING_ACCEPTED_RUNTIME_INVALID);
  });

  it('does not apply deployment-clock expiry to a bound process', () => {
    for (const time of [0, now, now + 366 * 86400000, NaN, Infinity]) {
      expect(deploymentStagingOwnerRuntime(bindings(), time)).toEqual(admission);
    }
    const parsed = parseNormalStagingAcceptedRuntime(admission);
    expect(parsed).not.toBe(admission);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('rejects every missing wire field and every missing or replaced launch binding', () => {
    for (const key of Object.keys(admission)) {
      const partial = { ...admission } as Record<string, unknown>;
      delete partial[key];
      expect(parseNormalStagingAcceptedRuntime(partial), key).toBeNull();
    }
    for (const key of Object.keys(bindings())) {
      for (const replacement of [undefined, 'other']) {
        expect(() => deploymentStagingOwnerRuntime({ ...bindings(), [key]: replacement }), key)
          .toThrow(NORMAL_STAGING_ACCEPTED_RUNTIME_INVALID);
      }
    }
  });

  it.each([null, [], true, 'data', 1])('rejects a non-record %j', value => {
    expect(parseNormalStagingAcceptedRuntime(value)).toBeNull();
  });

  it('rejects partial new authority mixed into unconfigured or legacy mode', () => {
    for (const key of ['EDAIX_NORMAL_STAGING_ACCEPTED_RUNTIME', 'EDAIX_HOST_SHA256', 'EDAIX_HOST_POLICY_SHA256',
      'EDAIX_OPERATION_ID', 'EDAIX_BOOT_ID', 'EDAIX_LAUNCH_ID']) {
      expect(() => deploymentStagingOwnerRuntime({ [key]: 'present' })).toThrow(NORMAL_STAGING_ACCEPTED_RUNTIME_INVALID);
      expect(() => deploymentStagingOwnerRuntime({ [key]: 'present',
        EDAIX_OWNER_ADMISSION_MODE: 'normal-staging-owner-admission' })).toThrow(NORMAL_STAGING_ACCEPTED_RUNTIME_INVALID);
    }
    expect(() => deploymentStagingOwnerRuntime({ ...bindings(), EDAIX_NORMAL_STAGING_OWNER_ADMISSION: '{}' }))
      .toThrow(NORMAL_STAGING_ACCEPTED_RUNTIME_INVALID);
  });

  it('delegates legacy admission without relaxing expiry or changing its reason', () => {
    const { hostSha256, hostPolicySha256, operationId, bootId, launchId, ...common } = admission;
    expect([hostSha256, hostPolicySha256, operationId, bootId, launchId]).toHaveLength(5);
    const legacy = { ...common, mode: 'normal-staging-owner-admission',
      approvedAt: '2026-09-09T09:00:00.000Z', expiresAt: '2026-09-09T11:00:00.000Z' };
    const environment = { NODE_ENV: 'production', EDAIX_DEPLOYMENT_ENVIRONMENT: 'staging',
      EDAIX_RELEASE_VARIANT: 'default', EDAIX_RELEASE_REVISION: revision, EDAIX_RELEASE_ID: legacy.releaseId,
      EDAIX_PUBLIC_CONFIG_SHA256: legacy.publicConfigSha256, EDAIX_CONFIGURATION_SHA256: legacy.configurationSha256,
      EDAIX_OWNER_ADMISSION_MODE: legacy.mode, EDAIX_NORMAL_STAGING_OWNER_ADMISSION: JSON.stringify(legacy) };
    expect(deploymentStagingOwnerRuntime(environment, now)).toEqual(legacy);
    for (const time of [Date.parse(legacy.expiresAt), NaN, Infinity]) {
      expect(() => deploymentStagingOwnerRuntime(environment, time)).toThrow('DEPLOY_NORMAL_STAGING_OWNER_ADMISSION_INVALID');
    }
    expect(() => deploymentStagingOwnerRuntime({ EDAIX_OWNER_ADMISSION_MODE: 'unknown' }, now))
      .toThrow('DEPLOY_NORMAL_STAGING_OWNER_ADMISSION_INVALID');
  });
});
