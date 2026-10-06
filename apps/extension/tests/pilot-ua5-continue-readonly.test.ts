import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePilotUa5BoundProfilePayloadResponse } from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import type { PilotUa5ReadOnlyScanResult } from '../lib/pilotUa5ConnectedProtocol';
import { installPilotUa5ConnectedBackground } from '../connected-dev/backgroundRuntime';
import { installPilotUa5ConnectedContent } from '../connected-dev/contentRuntime';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import { PILOT_UA5_CONTENT_PORT_NAME, PILOT_UA5_PANEL_PORT_NAME, type PilotUa5ConnectedPort } from '../lib/pilotUa5ConnectedProtocol';
import { event, portPair } from './connectedPorts';
import { binding, request as profileRequest, success } from './pilotUa5Fixtures';
import type { PilotWizardScanContext } from '@edaix/contracts/draft/pilot-wizard-context';
import type { VerifiedApplicationTarget } from '@edaix/agent-channel';
import { createPilotWizardSource } from '../lib/pilotWizardSource';

const RUN = 'a'.repeat(32), OFFER = 'b'.repeat(32), QUERY = 'c'.repeat(32), SCAN = 'd'.repeat(32);
const SCANNED = Object.freeze({
  schemaVersion: 1 as const, observedControls: 3, hiddenNotObservedCount: 2,
  unobservedRegions: 1, structureAvailable: true, pageIdentity: 'UNVERIFIED' as const,
});
const projection = Object.freeze({
  schemaVersion: 2 as const, binding, discoveryComplete: true,
  rows: Object.freeze([{ questionId: 'question.email', required: true, state: 'PREFILLED' as const, reason: null }]),
  unobservedRegions: Object.freeze([]),
  summary: Object.freeze({ observableQuestions: 1, requiredQuestions: 1, requiredCompleted: 1, terminalQuestions: 1, unobservedRegions: 0 }),
});
const wizardProjection = Object.freeze({ schemaVersion: 1 as const, scope: 'LOCAL_SESSION' as const,
  sessionDigest: 'a'.repeat(64), currentStep: { stepIndex: 0, identityDigest: 'b'.repeat(64) }, checkpoints: [] });

async function drain() { for (let i = 0; i < 80; i += 1) await Promise.resolve(); }

function harness(queued = false, wizard = false, sourceOptions?: Readonly<{
  source: Pick<ReturnType<typeof createPilotWizardSource>, 'resolve' | 'validate'>;
  now: () => number;
}>) {
  const backgroundConnections = event<(port: PilotUa5ConnectedPort) => void>();
  const contentConnections = event<(port: PilotUa5ConnectedPort) => void>();
  const state = { owner: 'owner-1' as string | null, tabId: 42, pageEpoch: 1, time: 1_000, digest: 'f'.repeat(64), live: true };
  const discovery = (id: string) => createPilotUa1DiscoveryRequest({
    pageUrl: `${binding.origin}${binding.pathname}`, requestId: id,
    issuedAtMs: state.time, targetUrlDigest: state.digest,
  })!;
  const readPageFacts = vi.fn(async () => Object.freeze({
    tabId: state.tabId, origin: binding.origin, pathname: binding.pathname,
    pageEpoch: state.pageEpoch, targetUrlDigest: state.digest,
  }));
  let oldSignal: AbortSignal | null = null;
  const run = vi.fn(async (_discovery, _progress, ports) => {
    oldSignal = ports.signal;
    await ports.resolveProfilePayloads(profileRequest);
    return { ok: true as const, projection };
  });
  const retireResult = vi.fn();
  const rescan = vi.fn(async (_discovery, signal: AbortSignal): Promise<PilotUa5ReadOnlyScanResult> => {
    expect(oldSignal?.aborted).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(retireResult).toHaveBeenCalledOnce();
    return { ok: true as const, scan: SCANNED, ...(wizard ? { wizard: wizardProjection } : {}) };
  });
  installPilotUa5ConnectedContent({
    enabled: true, extensionId: 'test-extension', expectedBackgroundUrl: 'chrome-extension://test-extension/background.js',
    runtime: { onConnect: contentConnections }, runCurrentPage: run,
    rescanCurrentPage: rescan, retireCurrentResult: retireResult,
    ...(wizard ? { getWizardProjection: () => wizardProjection } : {}),
  });
  const profile = vi.fn(async () => {
    const parsed = parsePilotUa5BoundProfilePayloadResponse({ ok: true, schemaVersion: 2, payload: success(), originalBindingSeal: 'e30.e30.AA' });
    if (!parsed.ok) throw new Error('TEST_PROFILE_INVALID');
    return parsed.value;
  });
  const revoke = vi.fn();
  const writes = vi.fn(async () => ({ allowed: true as const, writeNotAfterMs: 31_000 }));
  const consumeWriteGesture = vi.fn(async () => true);
  const continueDiscovery = vi.fn(async (_tabId: number, id: string) => discovery(id));
  const wizardSource = { resolve: vi.fn(async (_tabId: number, requestId: string): Promise<PilotWizardScanContext> => ({
    schemaVersion: 1, scope: 'LOCAL_SESSION', sessionId: '4'.repeat(32), requestId, expiresAtMs: 31_000,
    authorization: { schemaVersion: 1, purpose: 'DISCOVERY', runtimeBundleVersion: `rb1_${'a'.repeat(64)}`, releaseRevision: '7',
      policyVersion: 'policy-v1', rulesReleaseVersion: 'release-v1', rulesReleaseDigest: `sha256:${'b'.repeat(64)}`,
      atsProvider: 'GREENHOUSE', pathRuleId: 'application-v1', vendor: 'greenhouse', rulesetVersion: 'rules-v3', rulesetDigest: `sha256:${'c'.repeat(64)}` },
  })), validate: vi.fn(async () => true) };
  installPilotUa5ConnectedBackground({
    enabled: true, extensionId: 'test-extension', expectedSidepanelUrl: 'chrome-extension://test-extension/sidepanel.html',
    now: sourceOptions?.now ?? (() => state.time), runtime: { onConnect: backgroundConnections },
    tabs: { connect(_tabId, options) {
      const [background, content] = portPair(options.name, { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' }, queued);
      contentConnections.emit(content);
      return background;
    } },
    probeApiHealth: async () => true, hasAuthToken: async () => state.owner !== null,
    selectActiveTab: async () => state.tabId, isLiveWriteAuthorized: async () => state.live,
    hasSiteAccess: async () => true, isPageRegistered: async () => true,
    hasUserAction: async () => true, consumeUserAction: consumeWriteGesture,
    createDiscoveryRequest: async (_tabId, id) => discovery(id), revalidateRun: writes,
    finishRunAuthorization: () => true, revokeRunAuthorization: revoke,
    consumeUndoAuthorization: async () => false, resolveProfilePayloads: profile,
    readPageFacts, getCurrentUserId: async () => state.owner,
    createReadOnlyDiscoveryRequest: continueDiscovery, createContinueIntentId: () => OFFER,
    ...(wizard ? { wizardSource: sourceOptions?.source ?? wizardSource } : {}),
  });
  async function wire(message: unknown, senderUrl = 'chrome-extension://test-extension/sidepanel.html') {
    const [client, server] = portPair(PILOT_UA5_PANEL_PORT_NAME, { id: 'test-extension', url: senderUrl }, queued);
    const messages: unknown[] = [];
    client.onMessage.addListener((value) => messages.push(value));
    backgroundConnections.emit(server);
    client.postMessage(message);
    await drain();
    return { messages, client };
  }
  async function startAndOffer() {
    const started = await wire({ kind: 'pilot-ua5/start-current-page', version: 2, requestId: RUN });
    expect(started.messages).toContainEqual(expect.objectContaining({ kind: wizard ? 'pilot-ua5/wizard-result' : 'pilot-ua5/result', result: { ok: true, projection } }));
    const offered = await wire({ kind: 'pilot-ua5/get-continue-offer', version: 2, requestId: QUERY, runRequestId: RUN });
    expect(offered.messages).toEqual([expect.objectContaining({ kind: 'pilot-ua5/continue-offer', offer: { intentId: OFFER, expiresAtMs: 31_000 } })]);
  }
  const continueMessage = () => ({ kind: 'pilot-ua5/continue-read-only', version: 2, requestId: SCAN, runRequestId: RUN, intentId: OFFER });
  return { state, wire, startAndOffer, continueMessage, profile, revoke, writes, consumeWriteGesture, continueDiscovery, rescan, run, readPageFacts, contentConnections, wizardSource };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Continue through the existing v2 chain', () => {
  it.each([false, true])('keeps the current background/Continue context isolated from an old owner reply (reset=%s)', async (reset) => {
    const owner = '32345678-1234-4234-8234-123456789abc';
    const getCurrentUserId = vi.fn(async (): Promise<string | null> => owner);
    const target = { missionRevision: '7', canonicalOrigin: binding.origin, pathname: binding.pathname,
      atsProvider: 'GREENHOUSE' as const, pathRuleId: 'application-v1', verifierVersion: 'test-v1',
      verifiedAt: new Date(500).toISOString(), freshUntil: new Date(100_000).toISOString(), policyVersion: 'target-v1', revision: '4' };
    const source = createPilotWizardSource({ allowedPortalOrigins: ['https://portal.example.test'], getCurrentUserId,
      readConnectionReadiness: async () => 'READY', resolveTarget: async () => target as unknown as VerifiedApplicationTarget,
      runtimeAuthority: { authorizeDiscovery: async () => ({ ok: true, value: {
        schemaVersion: 1, purpose: 'DISCOVERY', runtimeBundleVersion: `rb1_${'a'.repeat(64)}`, releaseRevision: '7',
        policyVersion: 'policy-v1', rulesReleaseVersion: 'release-v1', rulesReleaseDigest: `sha256:${'b'.repeat(64)}`,
        atsProvider: 'GREENHOUSE', pathRuleId: 'application-v1', vendor: 'greenhouse', rulesetVersion: 'rules-v3', rulesetDigest: `sha256:${'c'.repeat(64)}`,
      } }), revalidate: async () => true },
      readPageFacts: async () => ({ tabId: 42, origin: binding.origin, pathname: binding.pathname, pageEpoch: 1, targetUrlDigest: 'f'.repeat(64) }),
      now: () => 1_000, newSessionId: () => 'e'.repeat(32),
    });
    expect(await source.select({ kind: 'pilot-ua5/select-wizard-context', schemaVersion: 1,
      correlationId: '12345678-1234-4234-8234-123456789abc', missionId: '22345678-1234-4234-8234-123456789abc',
      expectedOwnerId: owner, missionRevision: '7' }, 'https://portal.example.test')).toBe(true);
    let finishOldOwner!: (value: string | null) => void;
    getCurrentUserId.mockImplementationOnce(() => new Promise((resolve) => { finishOldOwner = resolve; }));
    const oldResolve = source.resolve(7, '7'.repeat(32));
    const issued: PilotWizardScanContext[] = [];
    const observedSource = { resolve: async (tabId: number, requestId: string) => {
      const context = await source.resolve(tabId, requestId);
      if (context) issued.push(context);
      return context;
    }, validate: source.validate };
    const h = harness(false, true, { source: observedSource, now: () => 1_000 });
    h.state.owner = owner;
    const started = await h.wire({ kind: 'pilot-ua5/start-current-page', version: 2, requestId: RUN });
    await drain(); await drain();
    expect(started.messages).toContainEqual(expect.objectContaining({ kind: 'pilot-ua5/wizard-result', result: { ok: true, projection } }));
    const offered = await h.wire({ kind: 'pilot-ua5/get-continue-offer', version: 2, requestId: QUERY, runRequestId: RUN });
    expect(offered.messages).toEqual([expect.objectContaining({ kind: 'pilot-ua5/continue-offer', offer: { intentId: OFFER, expiresAtMs: 31_000 } })]);
    expect(issued).toHaveLength(1);
    const current = issued[0]!;
    expect(h.run.mock.calls[0]![2].wizardContext).toEqual(current);
    expect(await source.validate(current)).toBe(true);
    const profileCalls = h.profile.mock.calls.length, writeCalls = h.writes.mock.calls.length;
    if (reset) source.reset();
    finishOldOwner(null);
    expect(await oldResolve).toBeNull();
    expect(await source.validate(current)).toBe(!reset);
    const continued = await h.wire(h.continueMessage());
    await drain(); await drain();
    expect(continued.messages).toEqual([{
      kind: reset ? 'pilot-ua5/rescan-result' : 'pilot-ua5/wizard-rescan-result',
      version: 2, requestId: SCAN, runRequestId: RUN,
      result: { ok: true, scan: SCANNED, ...(reset ? {} : { wizard: wizardProjection }) },
    }]);
    if (reset) expect(JSON.stringify(continued.messages)).not.toContain('sessionDigest');
    expect(h.rescan).toHaveBeenCalledOnce();
    expect(h.profile).toHaveBeenCalledTimes(profileCalls);
    expect(h.writes).toHaveBeenCalledTimes(writeCalls);
    expect(h.consumeWriteGesture).toHaveBeenCalledOnce();
  });

  it.each([30_999, 31_000, 31_001])('publishes canonical results after the real source final owner read at %i', async (settledAt) => {
    const owner = '32345678-1234-4234-8234-123456789abc';
    let time = 1_000, reads = 0;
    const target = { missionRevision: '7', canonicalOrigin: binding.origin, pathname: binding.pathname,
      atsProvider: 'GREENHOUSE' as const, pathRuleId: 'application-v1', verifierVersion: 'test-v1',
      verifiedAt: new Date(500).toISOString(), freshUntil: new Date(100_000).toISOString(), policyVersion: 'target-v1', revision: '4' };
    const source = createPilotWizardSource({ allowedPortalOrigins: ['https://portal.example.test'],
      getCurrentUserId: async () => { reads++; await Promise.resolve(); if (reads === 6) time = settledAt; return owner; },
      readConnectionReadiness: async () => 'READY', resolveTarget: async () => target as unknown as VerifiedApplicationTarget,
      runtimeAuthority: { authorizeDiscovery: async () => ({ ok: true, value: {
        schemaVersion: 1, purpose: 'DISCOVERY', runtimeBundleVersion: `rb1_${'a'.repeat(64)}`, releaseRevision: '7',
        policyVersion: 'policy-v1', rulesReleaseVersion: 'release-v1', rulesReleaseDigest: `sha256:${'b'.repeat(64)}`,
        atsProvider: 'GREENHOUSE', pathRuleId: 'application-v1', vendor: 'greenhouse', rulesetVersion: 'rules-v3', rulesetDigest: `sha256:${'c'.repeat(64)}`,
      } }), revalidate: async () => true },
      readPageFacts: async () => ({ tabId: 42, origin: binding.origin, pathname: binding.pathname, pageEpoch: 1, targetUrlDigest: 'f'.repeat(64) }),
      now: () => time, newSessionId: () => 'e'.repeat(32),
    });
    expect(await source.select({ kind: 'pilot-ua5/select-wizard-context', schemaVersion: 1,
      correlationId: '12345678-1234-4234-8234-123456789abc', missionId: '22345678-1234-4234-8234-123456789abc',
      expectedOwnerId: owner, missionRevision: '7' }, 'https://portal.example.test')).toBe(true);
    const h = harness(false, true, { source, now: () => time });
    h.state.owner = owner;
    const started = await h.wire({ kind: 'pilot-ua5/start-current-page', version: 2, requestId: RUN });
    await drain(); await drain();
    expect(reads).toBe(6);
    expect(time).toBe(settledAt);
    expect(started.messages).toContainEqual(expect.objectContaining({
      kind: settledAt < 31_000 ? 'pilot-ua5/wizard-result' : 'pilot-ua5/result', result: { ok: true, projection },
    }));
    if (settledAt >= 31_000) expect(JSON.stringify(started.messages)).not.toContain('sessionDigest');
  });
  it.each([false, true])('validates the readonly source before publishing wizard history (queued=%s)', async (queued) => {
    const h = harness(queued, true);
    await h.startAndOffer();
    expect(h.run.mock.calls[0]![2].wizardContext).toMatchObject({ scope: 'LOCAL_SESSION', requestId: RUN });
    const profileCalls = h.profile.mock.calls.length, writeCalls = h.writes.mock.calls.length;
    const continued = await h.wire(h.continueMessage());
    expect(continued.messages).toEqual([{ kind: 'pilot-ua5/wizard-rescan-result', version: 2, requestId: SCAN, runRequestId: RUN,
      result: { ok: true, scan: SCANNED, wizard: wizardProjection } }]);
    expect(h.wizardSource.validate).toHaveBeenCalledTimes(2);
    expect(h.profile).toHaveBeenCalledTimes(profileCalls);
    expect(h.writes).toHaveBeenCalledTimes(writeCalls);
    expect(h.consumeWriteGesture).toHaveBeenCalledOnce();
  });
  it('removes unverified wizard metadata while preserving the canonical current-page result', async () => {
    const h = harness(false, true);
    h.wizardSource.validate.mockResolvedValue(false);
    const started = await h.wire({ kind: 'pilot-ua5/start-current-page', version: 2, requestId: RUN });
    expect(started.messages).toContainEqual({ kind: 'pilot-ua5/result', version: 2, requestId: RUN, result: { ok: true, projection } });
    expect(JSON.stringify(started.messages)).not.toContain('sessionDigest');
  });
  it.each([false, true])('consumes once, retires the old run and only rescans (queued=%s)', async (queued) => {
    const h = harness(queued);
    await h.startAndOffer();
    const profileCalls = h.profile.mock.calls.length, writeCalls = h.writes.mock.calls.length;
    h.state.live = false; // Read-only Continue cannot grant a writer or renew its lease.
    const continued = await h.wire(h.continueMessage());
    expect(continued.messages).toEqual([{
      kind: 'pilot-ua5/rescan-result', version: 2, requestId: SCAN, runRequestId: RUN,
      result: { ok: true, scan: SCANNED },
    }]);
    expect(h.revoke).toHaveBeenCalledWith(RUN);
    expect(h.rescan).toHaveBeenCalledOnce();
    expect(h.profile).toHaveBeenCalledTimes(profileCalls);
    expect(h.writes).toHaveBeenCalledTimes(writeCalls);
    expect(h.consumeWriteGesture).toHaveBeenCalledOnce();
    await h.wire(h.continueMessage());
    expect(h.rescan).toHaveBeenCalledOnce();
  });

  it.each(['owner', 'tab', 'document', 'url', 'expiry'] as const)('rejects changed %s before rescan', async (change) => {
    const h = harness();
    await h.startAndOffer();
    if (change === 'owner') h.state.owner = 'owner-2';
    if (change === 'tab') h.state.tabId += 1;
    if (change === 'document') h.state.pageEpoch += 1;
    if (change === 'url') h.state.digest = 'e'.repeat(64);
    if (change === 'expiry') h.state.time = 31_000;
    const result = await h.wire(h.continueMessage());
    expect(result.messages).toEqual([expect.objectContaining({ result: { ok: false, code: 'PILOT_NOT_USER_TRIGGERED' } })]);
    expect(h.rescan).not.toHaveBeenCalled();
    expect(h.continueDiscovery).not.toHaveBeenCalled();
    expect(h.revoke).toHaveBeenCalledWith(RUN);
  });

  it('does not consume the valid offer for a forged nonce or foreign sender', async () => {
    const h = harness();
    await h.startAndOffer();
    await h.wire({ ...h.continueMessage(), intentId: 'e'.repeat(32) });
    await h.wire(h.continueMessage(), 'https://untrusted.invalid');
    expect(h.rescan).not.toHaveBeenCalled();
    const valid = await h.wire(h.continueMessage());
    expect(valid.messages).toContainEqual(expect.objectContaining({ result: { ok: true, scan: SCANNED } }));
  });

  it('does not accept a content rescan without the exact old run', async () => {
    const h = harness();
    await h.startAndOffer();
    const [background, content] = portPair(PILOT_UA5_CONTENT_PORT_NAME, { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' });
    h.contentConnections.emit(content);
    background.postMessage({
      kind: 'pilot-ua5/rescan-current-page', version: 2, requestId: SCAN, runRequestId: 'e'.repeat(32),
      discovery: createPilotUa1DiscoveryRequest({ pageUrl: `${binding.origin}${binding.pathname}`, requestId: SCAN, issuedAtMs: 1_000, targetUrlDigest: 'f'.repeat(64) }),
    });
    await drain();
    expect(h.rescan).not.toHaveBeenCalled();
  });

  it.each(['owner', 'document', 'expiry', 'disconnect', 'duplicate'] as const)('fences late rescan publication after %s', async (change) => {
    const h = harness(true);
    await h.startAndOffer();
    let resolveScan!: (value: PilotUa5ReadOnlyScanResult) => void;
    let signal!: AbortSignal;
    h.rescan.mockImplementationOnce(async (_discovery, currentSignal) => {
      signal = currentSignal;
      return new Promise((resolve) => { resolveScan = resolve; });
    });
    const pending = await h.wire(h.continueMessage());
    expect(h.rescan).toHaveBeenCalledOnce();
    expect(pending.messages).toEqual([]);
    if (change === 'owner') h.state.owner = 'owner-2';
    if (change === 'document') h.state.pageEpoch++;
    if (change === 'expiry') { h.state.time = 31_000; await vi.advanceTimersByTimeAsync(30_000); }
    if (change === 'disconnect') { pending.client.disconnect(); await drain(); }
    if (change === 'duplicate') await h.wire(h.continueMessage());
    if (change === 'expiry' || change === 'disconnect') expect(signal.aborted).toBe(true);
    resolveScan({ ok: true, scan: SCANNED }); await drain();
    expect(h.rescan).toHaveBeenCalledOnce();
    if (change === 'duplicate') expect(pending.messages).toContainEqual(expect.objectContaining({ result: { ok: true, scan: SCANNED } }));
    else expect(pending.messages).not.toContainEqual(expect.objectContaining({ result: { ok: true, scan: SCANNED } }));
  });

  it('retires a consumed intent when the same port sends a second request while validation waits', async () => {
    const h = harness();
    await h.startAndOffer();
    let finishFacts!: (value: Awaited<ReturnType<typeof h.readPageFacts>>) => void;
    h.readPageFacts.mockImplementationOnce(() => new Promise((resolve) => { finishFacts = resolve; }));
    const pending = await h.wire(h.continueMessage());
    pending.client.postMessage(h.continueMessage());
    await drain();
    expect(h.revoke).toHaveBeenCalledWith(RUN);
    finishFacts({ tabId: 42, origin: binding.origin, pathname: binding.pathname, pageEpoch: 1, targetUrlDigest: 'f'.repeat(64) });
    await drain();
    expect(h.rescan).not.toHaveBeenCalled();
    await h.wire(h.continueMessage());
    expect(h.rescan).not.toHaveBeenCalled();
  });
});
