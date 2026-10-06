import { describe, expect, it } from 'vitest';
import {
  NORMAL_STAGING_OWNER_ADMISSION_MODE,
  NORMAL_STAGING_OWNER_ADMISSION_INVALID,
  deploymentNormalStagingOwnerAdmission,
  parseNormalStagingOwnerAdmission,
} from '../src/deployment-staging.ts';

const now = Date.parse('2026-09-09T10:00:00.000Z');
const revision = 'a'.repeat(40);
const admission = {
  schemaVersion: 1,
  mode: 'normal-staging-owner-admission',
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
  approvedAt: '2026-09-09T09:00:00.000Z',
  expiresAt: '2026-09-09T11:00:00.000Z',
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
    EDAIX_OWNER_ADMISSION_MODE: NORMAL_STAGING_OWNER_ADMISSION_MODE,
    EDAIX_NORMAL_STAGING_OWNER_ADMISSION: JSON.stringify(admission),
  };
}

describe('normal staging owner admission', () => {
  it('admits only exact current staging bindings and keeps unconfigured launches off', () => {
    expect(parseNormalStagingOwnerAdmission(admission, now)).toEqual(admission);
    expect(deploymentNormalStagingOwnerAdmission(bindings(), now)).toEqual(admission);
    expect(deploymentNormalStagingOwnerAdmission({}, now)).toBeNull();
    expect(deploymentNormalStagingOwnerAdmission({ EDAIX_DEPLOYMENT_ENVIRONMENT: 'staging' }, now)).toBeNull();
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
    { authAudience: '' }, { authAudience: 'audience\n' },
  ])('rejects malformed shape or authority %j', patch => {
    expect(parseNormalStagingOwnerAdmission({ ...admission, ...patch }, now)).toBeNull();
  });

  it.each([
    { NODE_ENV: 'development' }, { EDAIX_DEPLOYMENT_ENVIRONMENT: 'production' },
    { EDAIX_RELEASE_VARIANT: undefined }, { EDAIX_RELEASE_VARIANT: 'staging-private-preview' },
    { EDAIX_RELEASE_ID: `${revision}-default-x64-${'e'.repeat(12)}` },
    { EDAIX_RELEASE_REVISION: 'e'.repeat(40) }, { EDAIX_PUBLIC_CONFIG_SHA256: 'e'.repeat(64) },
    { EDAIX_CONFIGURATION_SHA256: 'e'.repeat(64) }, { EDAIX_OWNER_ADMISSION_MODE: undefined },
    { EDAIX_OWNER_ADMISSION_MODE: 'other' }, { EDAIX_NORMAL_STAGING_OWNER_ADMISSION: undefined },
    { EDAIX_NORMAL_STAGING_OWNER_ADMISSION: '{' }, { EDAIX_NORMAL_STAGING_OWNER_ADMISSION: ' '.repeat(8193) },
    { EDAIX_PRIVATE_PREVIEW_ADMISSION: '{}' },
  ])('fails closed for partial or mismatched runtime bindings %j', patch => {
    expect(() => deploymentNormalStagingOwnerAdmission({ ...bindings(), ...patch }, now))
      .toThrow(NORMAL_STAGING_OWNER_ADMISSION_INVALID);
  });

  it('rechecks expiry and rejects an invalid clock without retaining an earlier success', () => {
    expect(deploymentNormalStagingOwnerAdmission(bindings(), now)).toEqual(admission);
    for (const time of [Date.parse(admission.expiresAt), NaN, Infinity]) {
      expect(parseNormalStagingOwnerAdmission(admission, time)).toBeNull();
      expect(() => deploymentNormalStagingOwnerAdmission(bindings(), time))
        .toThrow(NORMAL_STAGING_OWNER_ADMISSION_INVALID);
    }
  });
});
