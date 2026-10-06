import { describe, expect, it } from 'vitest';
import { parseExecutionRuntimeAuthorizationV1 } from '../src/executionRuntimeAuthorization';
const authorization = () => ({ schemaVersion: 1, purpose: 'DISCOVERY', runtimeBundleVersion: `rb1_${'a'.repeat(64)}`,
  releaseRevision: '7', policyVersion: 'policy-v1', rulesReleaseVersion: 'release-v1', rulesReleaseDigest: `sha256:${'b'.repeat(64)}`,
  atsProvider: 'GREENHOUSE', pathRuleId: 'application-v1', vendor: 'greenhouse', rulesetVersion: 'rules-v3', rulesetDigest: `sha256:${'c'.repeat(64)}` });
describe('existing runtime authorization shape in shared contracts', () => {
  it('preserves the exact DISCOVERY/EXECUTION shapes and snapshots own data fields', () => {
    const source = authorization();
    expect(parseExecutionRuntimeAuthorizationV1(source)).toEqual(source);
    expect(parseExecutionRuntimeAuthorizationV1({ ...source, purpose: 'EXECUTION' })?.purpose).toBe('EXECUTION');
    const parsed = parseExecutionRuntimeAuthorizationV1(source)!;
    source.rulesetVersion = 'changed';
    expect(parsed.rulesetVersion).toBe('rules-v3');
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it('rejects unknown fields, provider mismatch, getters and invalid versions', () => {
    const source = authorization();
    for (const value of [{ ...source, selector: '#host' }, { ...source, vendor: 'workday' },
      { ...source, releaseRevision: '01' }, { ...source, purpose: 'FILL' },
      Object.defineProperty({ ...source }, 'rulesetDigest', { enumerable: true, get() { throw new Error('must not invoke'); } }),
    ]) expect(parseExecutionRuntimeAuthorizationV1(value)).toBeNull();
  });
});
