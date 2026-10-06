import { describe, expect, it } from 'vitest';
import { parsePilotWizardContextSelection, parsePilotWizardContextSelectionResult, parsePilotWizardScanContext } from '../src/draft/pilotWizardContext';
const selection = { kind: 'pilot-ua5/select-wizard-context', schemaVersion: 1,
  correlationId: '12345678-1234-4234-8234-123456789abc', missionId: '22345678-1234-4234-8234-123456789abc',
  expectedOwnerId: '32345678-1234-4234-8234-123456789abc', missionRevision: '7' };
const authorization = { schemaVersion: 1, purpose: 'DISCOVERY', runtimeBundleVersion: `rb1_${'a'.repeat(64)}`, releaseRevision: '7',
  policyVersion: 'policy-v1', rulesReleaseVersion: 'release-v1', rulesReleaseDigest: `sha256:${'b'.repeat(64)}`,
  atsProvider: 'GREENHOUSE', pathRuleId: 'application-v1', vendor: 'greenhouse', rulesetVersion: 'rules-v3', rulesetDigest: `sha256:${'c'.repeat(64)}` };
describe('read-only wizard context', () => {
  it('requires an exact correlated selection result without authority or content', () => {
    const result = { kind: 'pilot-ua5/wizard-context-selected', schemaVersion: 1, correlationId: selection.correlationId, ok: true };
    expect(parsePilotWizardContextSelectionResult(result)).toEqual(result);
    expect(parsePilotWizardContextSelectionResult({ ...result, grant: true })).toBeNull();
    expect(parsePilotWizardContextSelectionResult({ ...result, ok: 'true' })).toBeNull();
  });
  it('accepts an exact Portal Mission reference and rejects unverified mapping or authorization fields', () => {
    expect(parsePilotWizardContextSelection(selection)).toEqual(selection);
    for (const extra of [{ vendor: 'greenhouse' }, { targetUrl: 'https://example.test' }, { allowFill: true }]) {
      expect(parsePilotWizardContextSelection({ ...selection, ...extra })).toBeNull();
    }
    expect(parsePilotWizardContextSelection({ ...selection, missionRevision: '01' })).toBeNull();
  });
  it('accepts only a request-bound local read-only context with the shared runtime identity', () => {
    const input = { schemaVersion: 1, scope: 'LOCAL_SESSION', sessionId: 'd'.repeat(32), requestId: 'e'.repeat(32), expiresAtMs: 12345, authorization };
    expect(parsePilotWizardScanContext(input)).toEqual(input);
    for (const changed of [{ scope: 'MISSION' }, { missionId: selection.missionId }, { expiresAtMs: NaN },
      { authorization: { ...authorization, purpose: 'EXECUTION' } }, { authorization: { ...authorization, selectors: [] } }]) {
      expect(parsePilotWizardScanContext({ ...input, ...changed })).toBeNull();
    }
  });
});
