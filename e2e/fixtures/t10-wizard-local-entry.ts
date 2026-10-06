/** Real connected source/content/Panel code with synthetic I/O. NON_ACCEPTANCE / NOT_RELEASED. */
import { createPilotUa5ConnectedLiveRun } from '../../apps/extension/connected-dev/liveRun';
import { installPilotUa5ConnectedBackground } from '../../apps/extension/connected-dev/backgroundRuntime';
import { installPilotUa5ConnectedContent } from '../../apps/extension/connected-dev/contentRuntime';
import { createPilotUa5PanelRuntimeClient } from '../../apps/extension/connected-dev/panelRuntimeClient';
import { createProductPanelUa5Adapter } from '../../apps/extension/product-panel/ua5Adapter';
import { mountProductPanel } from '../../apps/extension/product-panel/panel';
import { createPilotUa1DiscoveryRequest } from '../../apps/extension/lib/pilotUa1DiscoveryProtocol';
import { createPilotWizardSource } from '../../apps/extension/lib/pilotWizardSource';
import { createMissionApplicationTargetClient } from '../../apps/extension/lib/missionApplicationTargetClient';
import { createBackgroundExecutionRuntimeAuthority } from '../../apps/extension/lib/executionRuntimeAuthority';
import { createExecutionRuntimeBundleClient } from '../../apps/extension/lib/executionRuntimeBundleClient';
import { readPilotUa5ResultWizard, type PilotUa5ConnectedPort } from '../../apps/extension/lib/pilotUa5ConnectedProtocol';
import { parsePilotUa5BoundProfilePayloadResponse } from '../../packages/contracts/src/draft/pilotUa5ProfilePayloads';
import type { PilotLocalWizardProjection } from '../../packages/contracts/src/draft/pilotLocalWizard';
import { pilotUa5SemanticDigest as digest } from '../../apps/extension/lib/pilotUa5SemanticDigest';
import { syntheticWizardRuntime } from './t10-wizard-runtime';
import { syntheticWizardProfileResponse } from './t10-wizard-profile';

function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return { addListener: (listener: (value: T) => void) => { listeners.add(listener); },
    removeListener: (listener: (value: T) => void) => { listeners.delete(listener); },
    emit: (value: T) => { for (const listener of [...listeners]) listener(value); } };
}

/** Queued, structured-cloned private ports, including delivery-before-disconnect order. */
function pair(name: string, sender: PilotUa5ConnectedPort['sender']): readonly [PilotUa5ConnectedPort, PilotUa5ConnectedPort] {
  const messages = [event<unknown>(), event<unknown>()], disconnects = [event<void>(), event<void>()];
  let closed = false;
  const make = (side: number): PilotUa5ConnectedPort => ({ name, ...(side ? { sender } : {}),
    onMessage: messages[side]!, onDisconnect: disconnects[side]!,
    postMessage(message) {
      if (closed) throw new Error('TEST_PORT_CLOSED');
      const wire = structuredClone(message);
      queueMicrotask(() => messages[1 - side]!.emit(wire));
    },
    disconnect() {
      if (closed) return;
      closed = true;
      queueMicrotask(() => { disconnects[0]!.emit(); disconnects[1]!.emit(); });
    },
  });
  return [make(0), make(1)];
}

export async function createHarness() {
  const initialTime = Date.now(), source = await syntheticWizardRuntime(initialTime);
  const owner = '32345678-1234-4234-8234-123456789abc', missionId = '22345678-1234-4234-8234-123456789abc';
  let currentOwner: string | null = owner, epoch: object = {}, pageEpoch = 1, sequence = 0;
  let profileCalls = 0, hostCalls = 0, runtimeCalls = 0, targetCalls = 0;
  let displayed: PilotLocalWizardProjection | null = null;
  let lastCode = 'NOT_RUN';
  let contentCode = 'NOT_RUN';
  const extensionId = 'synthetic-wizard-browser-fixture';
  const backgroundUrl = `chrome-extension://${extensionId}/background.js`, panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  const facts = async () => ({ tabId: 7, origin: location.origin, pathname: location.pathname,
    targetUrlDigest: digest(location.href), pageEpoch });
  const runtimeClient = createExecutionRuntimeBundleClient({ apiBase: 'http://127.0.0.1:4177', extensionVersion: () => '0.0.0',
    store: { read: async () => source.stored, write: async () => undefined },
    fetchFn: async () => { runtimeCalls += 1; return new Response(source.stored.rawBody, {
      status: 200, headers: { 'content-type': 'application/json', etag: source.stored.etag },
    }); },
  });
  const targetClient = createMissionApplicationTargetClient({ apiBase: 'http://127.0.0.1:4177', getAccessToken: async () => 'synthetic-token',
    fetchFn: async () => { targetCalls += 1; return new Response(JSON.stringify({ schemaVersion: 1, target: {
      missionRevision: '7', canonicalOrigin: location.origin, pathname: location.pathname,
      atsProvider: 'GREENHOUSE', pathRuleId: 'greenhouse-application-v1', verifierVersion: 'test-v1',
      verifiedAt: new Date(initialTime - 1_000).toISOString(), freshUntil: new Date(initialTime + 60_000).toISOString(),
      policyVersion: 'target-v1', revision: '4',
    } }), { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  const wizardSource = createPilotWizardSource({ allowedPortalOrigins: ['https://portal.example.test'],
    getCurrentUserId: async () => currentOwner, readConnectionReadiness: async () => 'READY',
    resolveTarget: targetClient.resolve, runtimeAuthority: createBackgroundExecutionRuntimeAuthority({ client: runtimeClient }), readPageFacts: facts,
  });
  const selected = await wizardSource.select({ kind: 'pilot-ua5/select-wizard-context', schemaVersion: 1,
    correlationId: '12345678-1234-4234-8234-123456789abc', expectedOwnerId: owner, missionId, missionRevision: '7' }, 'https://portal.example.test');
  if (!selected) throw new Error('TEST_SOURCE_UNAVAILABLE');
  const run = createPilotUa5ConnectedLiveRun({ enabled: true, extensionId, expectedBackgroundUrl: backgroundUrl,
    document, view: window, location, openShadowRoot: (element) => element.shadowRoot,
    wizard: { readStoredRuntimeBundle: async () => source.stored, extensionVersion: () => '0.0.0', readAuthorityEpoch: () => epoch },
  });
  const contentConnections = event<PilotUa5ConnectedPort>(), backgroundConnections = event<PilotUa5ConnectedPort>();
  installPilotUa5ConnectedContent({ enabled: true, extensionId, expectedBackgroundUrl: backgroundUrl,
    runtime: { onConnect: contentConnections },
    runCurrentPage: async (discovery, progress, ports) => {
      const result = await run(discovery, progress, { ...ports,
        authorizeLeafWrite: async () => { hostCalls += 1; return false; } });
      contentCode = result.ok ? 'OK' : result.code;
      return result;
    },
    getCurrentResult: run.getCurrentResult,
    getWizardProjection: run.getWizardProjection, rescanCurrentPage: run.rescanCurrentPage, retireCurrentResult: run.dispose, lifecycle: window,
  });
  const reset = () => { epoch = {}; pageEpoch += 1; run.resetWizard(); wizardSource.reset(); displayed = null; };
  window.addEventListener('pagehide', reset);
  const discovery = (_tab: number, requestId: string) => Promise.resolve(createPilotUa1DiscoveryRequest({
    pageUrl: location.href, issuedAtMs: Date.now(), requestId, targetUrlDigest: digest(location.href),
  }));
  installPilotUa5ConnectedBackground({ enabled: true, extensionId, expectedSidepanelUrl: panelUrl,
    runtime: { onConnect: backgroundConnections },
    tabs: { connect(_tab, options) { const [background, content] = pair(options.name, { id: extensionId, url: backgroundUrl });
      contentConnections.emit(content); return background; } },
    probeApiHealth: async () => true, hasAuthToken: async () => currentOwner === owner,
    selectActiveTab: async () => 7, isLiveWriteAuthorized: () => true, hasSiteAccess: () => true, isPageRegistered: () => true,
    hasUserAction: () => true, consumeUserAction: () => true,
    // Synthetic prefilled page: permit pipeline setup but reject every leaf.
    revalidateRun: () => ({ allowed: true, writeNotAfterMs: initialTime + 60_000 }),
    finishRunAuthorization: () => true, revokeRunAuthorization: () => undefined, consumeUndoAuthorization: () => false,
    createDiscoveryRequest: discovery, createReadOnlyDiscoveryRequest: discovery,
    resolveProfilePayloads: async (request) => {
      profileCalls += 1;
      const payload = syntheticWizardProfileResponse(request.request, Date.now());
      const parsed = parsePilotUa5BoundProfilePayloadResponse({ ok: true, schemaVersion: 2, payload, originalBindingSeal: 'e30.e30.AA' });
      if (!parsed.ok) throw new Error('TEST_PROFILE_UNAVAILABLE');
      return parsed.value;
    },
    getCurrentUserId: async () => currentOwner, readPageFacts: facts, wizardSource,
  });
  const client = createPilotUa5PanelRuntimeClient({ requestId: () => (++sequence).toString(16).padStart(32, '0'),
    runtime: { connect(options) { const [client, server] = pair(options.name, { id: extensionId, url: panelUrl });
      backgroundConnections.emit(server); return client; } },
  });
  let panel: ReturnType<typeof mountProductPanel> | null = null;
  return Object.freeze({
    async observeAndRecord() {
      const result = await client.runCurrentPage(() => {});
      const projection = readPilotUa5ResultWizard(result);
      lastCode = result.ok ? (projection ? 'CHECKPOINT_AVAILABLE' : 'CHECKPOINT_UNAVAILABLE') : result.code;
      displayed = projection ?? (displayed ? { ...displayed, currentStep: null } : null);
      const checkpoint = projection?.checkpoints.at(-1);
      return result.ok && checkpoint ? { ok: true, checkpointedStep: checkpoint.stepIndex } : { ok: false };
    },
    async observeOnly() {
      const beforeProfile = profileCalls;
      const offer = await client.getContinueOffer();
      if (!offer) { displayed = displayed ? { ...displayed, currentStep: null } : null; return { ok: false }; }
      const result = await client.continueReadOnly(offer.intentId);
      displayed = result.ok && result.wizard ? result.wizard : (displayed ? { ...displayed, currentStep: null } : null);
      return { ok: result.ok && !!displayed?.currentStep, profileUnchanged: beforeProfile === profileCalls };
    },
    async mountPanel() {
      const root = document.createElement('aside'); root.id = 'wizard-panel'; document.body.append(root);
      const adapter = createProductPanelUa5Adapter({ runCurrentPage: client.runCurrentPage, getContinueOffer: client.getContinueOffer,
        continueReadOnly: client.continueReadOnly, probeReadiness: client.probeReadiness });
      panel = mountProductPanel(root, adapter, { presentation: 'CONNECTED', reducedMotion: true });
      return adapter.requestStartAutofill({ kind: 'START_AUTOFILL' });
    },
    revokeOwner() { currentOwner = null; epoch = {}; run.resetWizard(); wizardSource.reset(); },
    summary() {
      return { ok: true, scope: 'LOCAL_SESSION', hostCalls, profileCalls, runtimeCalls, targetCalls, lastCode, contentCode,
        steps: displayed?.checkpoints.map((point) => point.stepIndex) ?? [],
        requiredStates: displayed?.checkpoints.map((point) => point.requiredDispositions.map((row) => row.disposition.state)) ?? [],
        unobservedRegions: displayed?.checkpoints.map((point) => point.unobservedRegions.length) ?? [],
        discoveryComplete: displayed?.checkpoints.map((point) => point.discoveryComplete) ?? [],
        currentStepIndex: displayed?.currentStep?.stepIndex ?? null,
        currentStepCheckpointed: !!displayed?.currentStep && displayed.checkpoints.some((point) => point.stepIndex === displayed!.currentStep!.stepIndex),
      };
    },
    dispose() { panel?.destroy(); reset(); run.dispose(); window.removeEventListener('pagehide', reset); },
  });
}
