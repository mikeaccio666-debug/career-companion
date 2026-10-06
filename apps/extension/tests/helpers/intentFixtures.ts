/** 合同 §5.3 载荷的测试夹具（合法基线 + 定点覆写）。 */

export const FIXTURE_NOW = 1_800_000_000;
export const FIXTURE_ISSUER = 'https://api.test.invalid';
export const FIXTURE_INSTALL = 'install-uuid-1';
export const FIXTURE_HEADER = { alg: 'ES256', kid: 'k_test_1', typ: 'edaix-execution-intent+jwt' };

export const sha = (ch: string) => `sha256:${ch.repeat(64)}`;

export function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ver: 1,
    iss: FIXTURE_ISSUER,
    aud: 'edaix-job-agent-extension',
    sub: 'user-1',
    jti: 'jti-1',
    iat: FIXTURE_NOW - 10,
    nbf: FIXTURE_NOW - 10,
    exp: FIXTURE_NOW + 100,
    missionId: 'm_1',
    missionRevision: '8',
    missionStepId: 'ms_1',
    stepAttempt: 1,
    intentVersion: 1,
    extensionInstallId: FIXTURE_INSTALL,
    target: {
      jobId: 'job-1',
      sourcePlatform: 'GREENHOUSE',
      atsProvider: 'GREENHOUSE',
      canonicalOrigin: 'https://job-boards.greenhouse.io',
      pathRuleId: 'greenhouse-application-v1',
      postingFingerprint: sha('a'),
    },
    fieldKeys: ['email', 'firstName', 'lastName'],
    fieldSchemaVersion: 1,
    automationLevel: 'L1_FILL_STOP_BEFORE_SUBMIT',
    allowedActions: ['FILL'],
    planDigest: sha('b'),
    approvalMessageId: 'approval-1',
    profile: { revision: '1', deletionEpoch: '1', snapshotDigest: sha('c') },
    resume: { versionId: 'rv-1', contentHash: sha('d'), contentRevision: '1', libraryRevision: '1' },
    policyVersion: 'apply-policy-1',
    killSwitchVersion: '1',
    consentVersion: 'job-automation-v1',
    ...overrides,
  };
}
