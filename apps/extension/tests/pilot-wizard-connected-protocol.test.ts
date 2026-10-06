import { expect, it } from 'vitest';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import { createPilotUa5ContentRunRequest, parsePilotUa5ContentRunRequest, createPilotUa5ContentRescanRequest,
  parsePilotUa5ContentRescanRequest, parsePilotUa5RescanResultMessage, pilotUa5RescanResultMessage,
  parsePilotUa5PanelEvent, pilotUa5ResultMessage } from '../lib/pilotUa5ConnectedProtocol';
const id = '1'.repeat(32), run = '2'.repeat(32);
const discovery = createPilotUa1DiscoveryRequest({ pageUrl: 'https://ats.example.test/application', issuedAtMs: 10_000,
  requestId: id, targetUrlDigest: 'a'.repeat(64) })!;
const context = { schemaVersion: 1, scope: 'LOCAL_SESSION', sessionId: '3'.repeat(32), requestId: id, expiresAtMs: 30_000,
  authorization: { schemaVersion: 1, purpose: 'DISCOVERY', runtimeBundleVersion: `rb1_${'a'.repeat(64)}`, releaseRevision: '7',
    policyVersion: 'policy-v1', rulesReleaseVersion: 'release-v1', rulesReleaseDigest: `sha256:${'b'.repeat(64)}`,
    atsProvider: 'GREENHOUSE', pathRuleId: 'application-v1', vendor: 'greenhouse', rulesetVersion: 'rules-v3', rulesetDigest: `sha256:${'c'.repeat(64)}` } } as const;
const scan = { schemaVersion: 1, observedControls: 1, hiddenNotObservedCount: 0, unobservedRegions: 0,
  structureAvailable: true, pageIdentity: 'UNVERIFIED' } as const;
const wizard = { schemaVersion: 1, scope: 'LOCAL_SESSION', sessionDigest: 'a'.repeat(64),
  currentStep: { identityDigest: 'b'.repeat(64), stepIndex: 0 }, checkpoints: [] } as const;
it('uses distinct wizard request kinds while preserving the original run and rescan shapes', () => {
  const original = createPilotUa5ContentRunRequest(id, discovery)!;
  expect(Object.keys(original)).toEqual(['kind', 'version', 'requestId', 'discovery']);
  const current = createPilotUa5ContentRunRequest(id, discovery, context)!;
  expect(current.kind).toBe('pilot-ua5/run-wizard-exact-page');
  expect(parsePilotUa5ContentRunRequest(current)).toEqual(current);
  expect(parsePilotUa5ContentRunRequest({ ...current, kind: original.kind })).toBeNull();
  expect(createPilotUa5ContentRunRequest(id, discovery, { ...context, requestId: run })).toBeNull();
  const rescan = createPilotUa5ContentRescanRequest(id, run, discovery, context)!;
  expect(rescan.kind).toBe('pilot-ua5/rescan-wizard-current-page');
  expect(parsePilotUa5ContentRescanRequest(rescan)).toEqual(rescan);
});
it('carries only the strict local projection in distinct result kinds and rejects unknown fields', () => {
  const result = { ok: true, scan, wizard } as const;
  const message = pilotUa5RescanResultMessage(id, run, result)!;
  expect(message.kind).toBe('pilot-ua5/wizard-rescan-result');
  expect(parsePilotUa5RescanResultMessage(message)).toEqual(message);
  expect(parsePilotUa5RescanResultMessage({ ...message, kind: 'pilot-ua5/rescan-result' })).toBeNull();
  expect(parsePilotUa5RescanResultMessage({ ...message, result: { ...result, wizard: { ...wizard, selector: '#host' } } })).toBeNull();
  // A failure remains a failure and cannot carry a purported wizard result.
  expect(pilotUa5ResultMessage(id, { ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }, wizard)).toBeNull();
  expect(parsePilotUa5PanelEvent({ kind: 'pilot-ua5/wizard-result', version: 2, requestId: id,
    result: { ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }, wizard })).toBeNull();
});
