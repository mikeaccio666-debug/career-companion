import { describe, expect, it } from 'vitest';
import { deploymentListenHost, deploymentVersionFromEnvironment, parseDeploymentVersion } from '../src/deployment.ts';

describe('deployment version', () => {
  it('binds the process release to its source revision and never echoes arbitrary environment values', () => {
    const revision = 'a'.repeat(40);
    const releaseId = `${revision}-staging-x64-${'b'.repeat(12)}`;
    expect(deploymentVersionFromEnvironment({ EDAIX_RELEASE_REVISION: revision, EDAIX_RELEASE_ID: releaseId }))
      .toEqual({ schemaVersion: 1, revision, releaseId });
    expect(deploymentVersionFromEnvironment({})).toBeNull();
    expect(parseDeploymentVersion({ schemaVersion: 1, revision: 'c'.repeat(40), releaseId })).toBeNull();
    expect(parseDeploymentVersion({ schemaVersion: 1, revision, releaseId, token: 'synthetic' })).toBeNull();
    expect(deploymentListenHost({})).toBe('127.0.0.1');
    expect(() => deploymentListenHost({ EDAIX_LISTEN_HOST: '0.0.0.0' })).toThrow('DEPLOYMENT_LISTEN_HOST_INVALID');
    expect(deploymentListenHost({ EDAIX_LISTEN_HOST: '0.0.0.0', EDAIX_RELEASE_REVISION: revision, EDAIX_RELEASE_ID: releaseId })).toBe('0.0.0.0');
  });
});
