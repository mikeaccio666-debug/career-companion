import { parsePilotUa5ProfileCurrentnessResponse, samePilotUa5ProfileCheck, PILOT_UA5_PROFILE_CURRENTNESS_UNAVAILABLE, type PilotUa5ProfileCurrentnessRequest, type PilotUa5ProfileCurrentnessResponse } from '@edaix/contracts/draft/pilot-ua5-profile-currentness';
import type { PilotUa1PageBinding } from '@edaix/contracts/draft';
import type { PilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import type { PilotUa5ExactPageFacts } from './exactPageLease';
import type { createPilotWizardSource } from '../lib/pilotWizardSource';
import {
  pilotUa5ProfilePayloadFailure,
  parsePilotUa5BoundProfilePayloadResponse,
  type PilotUa5BoundProfilePayloadRequest,
  type PilotUa5BoundProfilePayloadResponse,
  type PilotUa5ProfilePayloadResponse,
} from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import {
  PILOT_UA5_CONTENT_PORT_NAME,
  PILOT_UA5_PANEL_PORT_NAME,
  createPilotUa5ContentRunRequest,
  createPilotUa5ContentRescanRequest,
  parsePilotUa5ContinueOfferRequest,
  parsePilotUa5ContinueRequest,
  parsePilotUa5RescanResultMessage,
  pilotUa5ContinueOfferMessage,
  pilotUa5RescanResultMessage,
  isExactExtensionSender,
  parsePilotUa5PanelEvent,
  parsePilotUa5PanelRequest,
  parsePilotUa5CurrentResultRequest,
  parsePilotUa5ProfilePayloadRequestMessage,
  parsePilotUa5ReadinessRequest,
  parsePilotUa5UndoRequest,
  parsePilotUa5WriteCheckRequest,
  parsePilotUa5ProfileCheckRequest,
  pilotUa5ProfileCheckResultMessage,
  pilotUa5ConnectedFailure,
  pilotUa5ProfilePayloadResultMessage,
  pilotUa5ReadinessMessage,
  pilotUa5ResultMessage,
  pilotUa5UndoResultMessage,
  pilotUa5WriteCheckResultMessage,
  type PilotUa5ConnectedPort,
  type PilotUa5ReadinessStatus,
  type PilotUa5ReadOnlyScanResult,
} from '../lib/pilotUa5ConnectedProtocol';

type ConnectEvent = Readonly<{
  addListener(listener: (port: PilotUa5ConnectedPort) => void): void;
}>;

type Readiness = Readonly<{
  status: Exclude<PilotUa5ReadinessStatus, 'CHECKING'>;
  tabId: number | null;
}>;

export type PilotUa5RunAuthorizationProof = Readonly<{
  allowed: true;
  writeNotAfterMs: number;
}>;

export function installPilotUa5ConnectedBackground(input: Readonly<{
  enabled: boolean;
  extensionId: string;
  expectedSidepanelUrl: string;
  runtime: Readonly<{ onConnect: ConnectEvent }>;
  tabs: Readonly<{
    connect(
      tabId: number,
      options: { name: string; frameId: number },
    ): PilotUa5ConnectedPort;
  }>;
  probeApiHealth(): Promise<boolean>;
  hasAuthToken(): Promise<boolean>;
  /** Resolves only the active exact target; forward/build authority is checked separately. */
  selectActiveTab(): Promise<number | null>;
  isLiveWriteAuthorized(): boolean | Promise<boolean>;
  hasSiteAccess(tabId: number): boolean | Promise<boolean>;
  isPageRegistered(tabId: number): boolean | Promise<boolean>;
  hasUserAction(tabId: number): boolean | Promise<boolean>;
  consumeUserAction(tabId: number, requestId: string): boolean | Promise<boolean>;
  revalidateRun(
    tabId: number,
    requestId: string,
    discovery: PilotUa1DiscoveryRequest,
    binding?: PilotUa1PageBinding,
  ): false | PilotUa5RunAuthorizationProof |
    Promise<false | PilotUa5RunAuthorizationProof>;
  finishRunAuthorization(requestId: string, keepUndo: boolean): boolean;
  revokeRunAuthorization(requestId: string): void;
  hasRecoveryAuthorization?(tabId: number, runRequestId: string): boolean | Promise<boolean>;
  consumeUndoAuthorization(tabId: number, runRequestId: string): boolean | Promise<boolean>;
  createDiscoveryRequest(
    tabId: number,
    requestId: string,
  ): Promise<PilotUa1DiscoveryRequest | null>;
  resolveProfilePayloads?(request: PilotUa5BoundProfilePayloadRequest, writeNotAfterMs: number): Promise<PilotUa5BoundProfilePayloadResponse>;
  checkProfileCurrentness?(request: PilotUa5ProfileCurrentnessRequest, writeNotAfterMs: number): Promise<PilotUa5ProfileCurrentnessResponse>;
  /** Existing owner and exact-page readers; they confer no forward authority. */
  getCurrentUserId?(): Promise<string | null>;
  readPageFacts?(tabId: number): Promise<PilotUa5ExactPageFacts | null>;
  createReadOnlyDiscoveryRequest?(tabId: number, requestId: string): Promise<PilotUa1DiscoveryRequest | null>;
  /** Test seam; the real worker uses crypto.getRandomValues. */
  createContinueIntentId?: () => string;
  now?: () => number;
  wizardSource?: Pick<ReturnType<typeof createPilotWizardSource>, 'resolve' | 'validate'>;
}>): boolean {
  if (!input.enabled) return false;
  const now = input.now ?? Date.now;

  type ContinueContext = {
    runRequestId: string; intentId: string; ownerId: string; page: PilotUa5ExactPageFacts;
    expiresAtMs: number; lastTime: number; consumed: boolean;
    retireOldRun(): boolean; cancelScan?: () => void; timer?: ReturnType<typeof setTimeout>;
  };
  // One expiring, value-free UI intent per tab. This is not a lease or ledger.
  const continuations = new Map<number, ContinueContext>();
  const forget = (context: ContinueContext) => {
    if (context.timer !== undefined) clearTimeout(context.timer);
    if (continuations.get(context.page.tabId) === context) continuations.delete(context.page.tabId);
  };
  const retireContinuation = (context: ContinueContext) => {
    forget(context);
    context.cancelScan?.();
    context.retireOldRun();
  };
  const readTime = (context: ContinueContext): boolean => {
    let time: number;
    try { time = now(); } catch { return false; }
    if (!Number.isSafeInteger(time) || time < context.lastTime || time >= context.expiresAtMs) return false;
    context.lastTime = time;
    return true;
  };
  const samePage = (left: PilotUa5ExactPageFacts, right: PilotUa5ExactPageFacts): boolean =>
    left.tabId === right.tabId && left.pageEpoch === right.pageEpoch && left.origin === right.origin &&
    left.pathname === right.pathname && left.targetUrlDigest === right.targetUrlDigest;
  const discoveryMatchesPage = (discovery: PilotUa1DiscoveryRequest, page: PilotUa5ExactPageFacts): boolean =>
    discovery.targetOrigin === page.origin && discovery.targetPathname === page.pathname && discovery.targetUrlDigest === page.targetUrlDigest;
  const readScope = async (tabId: number) => {
    try {
      if (!input.getCurrentUserId || !input.readPageFacts || !input.createReadOnlyDiscoveryRequest) return null;
      const ownerId = await input.getCurrentUserId();
      const page = await input.readPageFacts(tabId);
      if (!ownerId || !page || page.tabId !== tabId || !Number.isSafeInteger(page.pageEpoch) || page.pageEpoch < 0 ||
          await input.getCurrentUserId() !== ownerId) return null;
      return Object.freeze({ ownerId, page: Object.freeze({ ...page }) });
    } catch { return null; }
  };
  const currentContinuation = async (context: ContinueContext): Promise<boolean> => {
    if (continuations.get(context.page.tabId) !== context || !readTime(context)) return false;
    const target = await diagnoseTarget(false, false);
    if (target.tabId !== context.page.tabId || target.status !== 'READY' || !await booleanProof(input.hasAuthToken)) return false;
    const scope = await readScope(context.page.tabId);
    return scope !== null && scope.ownerId === context.ownerId && samePage(scope.page, context.page) &&
      continuations.get(context.page.tabId) === context && readTime(context);
  };

  const booleanProof = async (proof: () => boolean | Promise<boolean>): Promise<boolean> => {
    try { return await proof() === true; } catch { return false; }
  };
  const authorizationProof = async (
    proof: () => false | PilotUa5RunAuthorizationProof |
      Promise<false | PilotUa5RunAuthorizationProof>,
  ): Promise<PilotUa5RunAuthorizationProof | null> => {
    try {
      const value = await proof();
      return value !== false && value.allowed === true &&
        Number.isSafeInteger(value.writeNotAfterMs) && value.writeNotAfterMs > 0
        ? Object.freeze({ allowed: true, writeNotAfterMs: value.writeNotAfterMs })
        : null;
    } catch {
      return null;
    }
  };

  const diagnoseTarget = async (
    requireUserAction: boolean,
    requireLiveWriteAuthorization = true,
  ): Promise<Readiness> => {
    if (
      requireLiveWriteAuthorization &&
      !await booleanProof(input.isLiveWriteAuthorized)
    ) {
      return Object.freeze({ status: 'LIVE_WRITE_NOT_AUTHORIZED', tabId: null });
    }
    let tabId: number | null = null;
    try { tabId = await input.selectActiveTab(); } catch { /* fail closed */ }
    if (tabId === null || !Number.isSafeInteger(tabId) || tabId < 0) {
      return Object.freeze({ status: 'LIVE_WRITE_NOT_AUTHORIZED', tabId: null });
    }
    if (!await booleanProof(() => input.hasSiteAccess(tabId!))) {
      return Object.freeze({ status: 'SITE_ACCESS_REQUIRED', tabId: null });
    }
    if (!await booleanProof(() => input.isPageRegistered(tabId!))) {
      return Object.freeze({ status: 'PAGE_NOT_REGISTERED', tabId: null });
    }
    if (requireUserAction && !await booleanProof(() => input.hasUserAction(tabId!))) {
      return Object.freeze({ status: 'USER_ACTION_REQUIRED', tabId: null });
    }
    return Object.freeze({ status: 'READY', tabId });
  };

  const diagnoseRuntime = async (): Promise<Readiness> => {
    if (!await booleanProof(input.probeApiHealth)) {
      return Object.freeze({ status: 'API_UNREACHABLE', tabId: null });
    }
    if (!await booleanProof(input.hasAuthToken)) {
      return Object.freeze({ status: 'AUTH_REQUIRED', tabId: null });
    }
    return Object.freeze({ status: 'READY', tabId: null });
  };

  const diagnoseReadiness = async (requireUserAction = true): Promise<Readiness> => {
    const target = await diagnoseTarget(requireUserAction);
    if (target.status !== 'READY' || target.tabId === null) return target;
    const runtime = await diagnoseRuntime();
    return runtime.status === 'READY' ? target : runtime;
  };

  input.runtime.onConnect.addListener((panelPort) => {
    if (panelPort.name !== PILOT_UA5_PANEL_PORT_NAME) return;
    if (!isExactExtensionSender(
      panelPort.sender,
      input.extensionId,
      input.expectedSidepanelUrl,
    )) {
      try { panelPort.disconnect(); } catch { /* already closed */ }
      return;
    }
    let started = false;
    let contentPort: PilotUa5ConnectedPort | null = null;
    let terminal = false;
    let activeRunId: string | null = null;
    let runAuthorizationStarted = false;
    let authorizedLeafWrites = 0;
    let original: Readonly<{
      seal: string; payload: Pick<Extract<PilotUa5ProfilePayloadResponse, { ok: true }>, 'profileBinding' | 'composition'>;
      expiresAtMs: number;
    }> | null = null;
    let panelAttached = true;
    const deliver = (message: unknown) => {
      if (!panelAttached) return;
      try { panelPort.postMessage(message); } catch { panelAttached = false; }
    };
    const finishAuthorization = (keepUndo: boolean): boolean => {
      if (activeRunId === null || !runAuthorizationStarted) return false;
      runAuthorizationStarted = false;
      let settled = false;
      try { settled = input.finishRunAuthorization(activeRunId, keepUndo && authorizedLeafWrites > 0) === true; }
      catch { settled = false; }
      if (!settled) input.revokeRunAuthorization(activeRunId);
      return settled;
    };
    const closeContent = () => {
      original = null;
      const current = contentPort;
      contentPort = null;
      try { current?.disconnect(); } catch { /* Already disconnected. */ }
    };
    const connectContent = (tabId: number): PilotUa5ConnectedPort | null => {
      try {
        contentPort = input.tabs.connect(tabId, { name: PILOT_UA5_CONTENT_PORT_NAME, frameId: 0 });
      } catch { contentPort = null; }
      return contentPort;
    };
    const failRun = (
      requestId: string,
      code: Parameters<typeof pilotUa5ConnectedFailure>[0] = 'PILOT_CAPABILITY_DISABLED',
    ) => {
      if (terminal) return;
      terminal = true;
      // A lost content result is not evidence of zero writes. Retire forward
      // authority while preserving its original bounded recovery admission.
      finishAuthorization(true);
      deliver(pilotUa5ResultMessage(requestId, pilotUa5ConnectedFailure(code)));
      closeContent();
    };
    const failUndo = (request: NonNullable<ReturnType<typeof parsePilotUa5UndoRequest>>) => {
      if (terminal) return;
      terminal = true;
      const message = pilotUa5UndoResultMessage(
        request.requestId,
        request.runRequestId,
        request.questionId,
        'UNAVAILABLE',
      );
      if (message !== null) deliver(message);
      closeContent();
    };

    let cancelReadOnly: (() => void) | null = null;
    panelPort.onDisconnect.addListener(() => { panelAttached = false; cancelReadOnly?.(); });
    panelPort.onMessage.addListener((message) => {
      const readinessRequest = parsePilotUa5ReadinessRequest(message);
      const request = parsePilotUa5PanelRequest(message);
      const offerRequest = parsePilotUa5ContinueOfferRequest(message);
      const continueRequest = parsePilotUa5ContinueRequest(message);
      const undoRequest = parsePilotUa5UndoRequest(message);
      const recoveryRequest = parsePilotUa5CurrentResultRequest(message);
      if (started) {
        if (cancelReadOnly !== null) {
          cancelReadOnly();
          return;
        }
        if (activeRunId !== null) {
          failRun(activeRunId, 'PILOT_UA5_WRITER_UNAVAILABLE');
        } else {
          terminal = true;
          closeContent();
          try { panelPort.disconnect(); } catch { /* already closed */ }
        }
        return;
      }
      if (readinessRequest === null && request === null && undoRequest === null && recoveryRequest === null && offerRequest === null && continueRequest === null) {
        terminal = true;
        closeContent();
        try { panelPort.disconnect(); } catch { /* already closed */ }
        return;
      }
      started = true;

      if (offerRequest !== null) {
        void (async () => {
          const context = [...continuations.values()].find((item) => item.runRequestId === offerRequest.runRequestId);
          const allowed = context !== undefined && !context.consumed && await currentContinuation(context);
          if (terminal) return;
          terminal = true;
          deliver(pilotUa5ContinueOfferMessage(offerRequest.requestId, offerRequest.runRequestId,
            allowed && context && !context.consumed ? { intentId: context.intentId, expiresAtMs: context.expiresAtMs } : null));
        })();
        return;
      }

      if (continueRequest !== null) {
        const context = [...continuations.values()].find((item) => item.runRequestId === continueRequest.runRequestId && item.intentId === continueRequest.intentId);
        let ownsContinuation = false;
        const finishScan = (result: PilotUa5ReadOnlyScanResult) => {
          if (terminal) return;
          terminal = true;
          cancelReadOnly = null;
          if (ownsContinuation && context) {
            forget(context);
            context.retireOldRun();
          }
          deliver(pilotUa5RescanResultMessage(continueRequest.requestId, continueRequest.runRequestId, result));
          closeContent();
        };
        if (!context || context.consumed) {
          finishScan({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });
          return;
        }
        // Consume before the first await. No reply, retry or new lease can
        // recreate this intent; only a separately settled run can offer another.
        context.consumed = true;
        ownsContinuation = true;
        cancelReadOnly = () => finishScan({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
        context.cancelScan = cancelReadOnly;
        void (async () => {
          if (!await currentContinuation(context)) {
            finishScan({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' }); return;
          }
          if (terminal || !context.retireOldRun()) {
            finishScan({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }); return;
          }
          let wizardContext = null;
          try { wizardContext = await input.wizardSource?.resolve(context.page.tabId, continueRequest.requestId) ?? null; }
          catch { wizardContext = null; }
          if (terminal) return;
          let discovery: PilotUa1DiscoveryRequest | null = null;
          try { discovery = await input.createReadOnlyDiscoveryRequest!(context.page.tabId, continueRequest.requestId); }
          catch { discovery = null; }
          if (terminal) return;
          if (!discovery || !discoveryMatchesPage(discovery, context.page) || !await currentContinuation(context)) {
            finishScan({ ok: false, code: 'PILOT_TARGET_DRIFT' }); return;
          }
          if (terminal) return;
          const envelope = createPilotUa5ContentRescanRequest(continueRequest.requestId, context.runRequestId, discovery, wizardContext ?? undefined);
          const content = envelope === null ? null : connectContent(context.page.tabId);
          if (!content) { finishScan({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }); return; }
          let resultReceived = false;
          content.onDisconnect.addListener(() => { if (!terminal && !resultReceived) finishScan({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }); });
          content.onMessage.addListener((candidate) => {
            if (terminal) return;
            const result = parsePilotUa5RescanResultMessage(candidate);
            if (resultReceived || !result || result.requestId !== continueRequest.requestId || result.runRequestId !== context.runRequestId) {
              finishScan({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }); return;
            }
            resultReceived = true;
            void (async () => {
              let scanned = result.result;
              if (scanned.ok && scanned.wizard) {
                const verified = wizardContext !== null && await booleanProof(() => input.wizardSource?.validate(wizardContext!) ?? false);
                if (!verified) scanned = { ok: true, scan: scanned.scan };
              }
              const current = await currentContinuation(context);
              if (!terminal) finishScan(current ? scanned : { ok: false, code: 'PILOT_TARGET_DRIFT' });
            })();
          });
          try { content.postMessage(envelope); } catch { finishScan({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }); }
        })();
        return;
      }

      if (readinessRequest !== null) {
        void diagnoseReadiness().then(({ status }) => {
          if (terminal) return;
          const response = pilotUa5ReadinessMessage(readinessRequest.requestId, status);
          terminal = true;
          if (response !== null) {
            deliver(response);
          }
        });
        return;
      }

      if (undoRequest !== null) { failUndo(undoRequest); return; }
      const recovery = recoveryRequest;
      if (recovery !== null) {
        const failRecovery = () => failRun(recovery.requestId);
        void (async () => {
          // Recovery has no forward-write build gate, but still requires the
          // exact active page, permission, registration and signed-in owner.
          const target = await diagnoseTarget(false, false);
          if (terminal) return;
          if (target.tabId === null || target.status !== 'READY' ||
              !await booleanProof(input.hasAuthToken)) {
            failRecovery();
            return;
          }
          if (terminal) return;
          const connected = connectContent(target.tabId);
          if (connected === null) { failRecovery(); return; }
          connected.onDisconnect.addListener(() => { if (!terminal) failRecovery(); });
          connected.onMessage.addListener((candidate) => {
            if (terminal) return;
            const event = parsePilotUa5PanelEvent(candidate);
            if (event?.kind !== 'pilot-ua5/result') { failRecovery(); return; }
            terminal = true;
            void (async () => {
              const current = await diagnoseTarget(false, false);
              const allowed = current.tabId === target.tabId && current.status === 'READY' &&
                await booleanProof(() => input.hasRecoveryAuthorization?.(target.tabId!, event.requestId) ?? false);
              deliver(allowed ? event : pilotUa5ResultMessage(
                recovery.requestId, pilotUa5ConnectedFailure('PILOT_UA5_WRITER_UNAVAILABLE'),
              ));
              closeContent();
            })();
          });
          try { connected.postMessage(recovery); } catch { failRecovery(); }
        })();
        return;
      }

      if (request === null) return;
      activeRunId = request.requestId;
      void (async () => {
        const target = await diagnoseReadiness();
        if (terminal) return;
        if (target.status !== 'READY' || target.tabId === null) {
          failRun(request.requestId, target.status === 'API_UNREACHABLE' || target.status === 'AUTH_REQUIRED'
            ? 'PILOT_CAPABILITY_DISABLED' : 'PILOT_NOT_USER_TRIGGERED');
          return;
        }
        const tabId = target.tabId;
        let wizardContext = null;
        try { wizardContext = await input.wizardSource?.resolve(tabId, request.requestId) ?? null; }
        catch { wizardContext = null; }
        if (terminal) return;
        const previousContinuation = continuations.get(tabId);
        if (previousContinuation) retireContinuation(previousContinuation);
        const actionConsumed = await booleanProof(() =>
          input.consumeUserAction(tabId, request.requestId));
        if (!actionConsumed) {
          if (!terminal) failRun(request.requestId, 'PILOT_NOT_USER_TRIGGERED');
          return;
        }
        runAuthorizationStarted = true;
        if (terminal) {
          finishAuthorization(true);
          return;
        }
        let discovery: PilotUa1DiscoveryRequest | null;
        try {
          discovery = await input.createDiscoveryRequest(tabId, request.requestId);
        } catch {
          discovery = null;
        }
        if (terminal) return;
        if (discovery === null) {
          failRun(request.requestId);
          return;
        }
        const continuationScope = await readScope(tabId);
        if (terminal) return;
        const discoveryValid = await authorizationProof(() => input.revalidateRun(
          tabId,
          request.requestId,
          discovery!,
        ));
        if (terminal) return;
        if (discoveryValid === null) {
          failRun(request.requestId);
          return;
        }
        const exactDiscovery = discovery;
        const contentRequest = createPilotUa5ContentRunRequest(
          request.requestId,
          exactDiscovery,
          wizardContext ?? undefined,
        );
        if (contentRequest === null) {
          failRun(request.requestId);
          return;
        }
        const connected = connectContent(tabId);
        if (connected === null) { failRun(request.requestId); return; }
        let profilePhase: 'UNREQUESTED' | 'PENDING' | 'READY' = 'UNREQUESTED';
        let writeCheckPending = false;
        let pendingProfileCheck = false;
        let pageGrant: Readonly<{ ordinal: number; questionId: string; binding: PilotUa1PageBinding; writeNotAfterMs: number }> | null = null;
        let nextWriteOrdinal = 1;
        let runRevoked = false;

        const revalidateProof = async (
          binding?: PilotUa1PageBinding,
        ): Promise<PilotUa5RunAuthorizationProof | null> => {
          if (runRevoked || terminal) return null;
          const current = await diagnoseReadiness(false);
          if (terminal || runRevoked || current.status !== 'READY' || current.tabId !== tabId) return null;
          const proof = await authorizationProof(() => input.revalidateRun(tabId, request.requestId, exactDiscovery, binding));
          return terminal || runRevoked ? null : proof;
        };
        connected.onDisconnect.addListener(() => {
          if (!terminal) failRun(request.requestId);
        });
        connected.onMessage.addListener((candidate) => {
          if (terminal) return;
          const profileRequest = parsePilotUa5ProfilePayloadRequestMessage(candidate);
          if (profileRequest !== null) {
            if (
              profilePhase !== 'UNREQUESTED' ||
              profileRequest.requestId !== request.requestId ||
              profileRequest.request.discovery.binding.origin !== exactDiscovery.targetOrigin ||
              profileRequest.request.discovery.binding.pathname !== exactDiscovery.targetPathname
            ) {
              failRun(request.requestId);
              return;
            }
            profilePhase = 'PENDING';
            void (async () => {
              const binding = profileRequest.request.discovery.binding;
              const initialProof = await revalidateProof(binding);
              if (initialProof === null) { failRun(request.requestId); return; }
              let response: PilotUa5ProfilePayloadResponse = pilotUa5ProfilePayloadFailure('PILOT_UA5_PROFILE_UNAVAILABLE');
              try {
                const bound = input.resolveProfilePayloads === undefined ? null : parsePilotUa5BoundProfilePayloadResponse(
                  await input.resolveProfilePayloads({ schemaVersion: 2, runRequestId: request.requestId, request: profileRequest.request },
                    Math.min(initialProof.writeNotAfterMs, exactDiscovery.issuedAtMs + 60_000)));
                if (bound?.ok) {
                  if (bound.value.ok) {
                    response = bound.value.payload;
                    original = Object.freeze({ seal: bound.value.originalBindingSeal,
                      payload: Object.freeze({ composition: response.composition, profileBinding: response.profileBinding }),
                      expiresAtMs: Math.min(response.composition.authority.expiresAtMs, response.composition.candidateRule.expiresAtMs, initialProof.writeNotAfterMs, exactDiscovery.issuedAtMs + 60_000),
                    });
                  } else response = pilotUa5ProfilePayloadFailure(bound.value.code);
                }
              } catch { response = pilotUa5ProfilePayloadFailure('PILOT_UA5_PROFILE_UNAVAILABLE'); }
              if (terminal) { original = null; return; }
              if (await revalidateProof(binding) === null) {
                failRun(request.requestId);
                return;
              }
              const envelope = pilotUa5ProfilePayloadResultMessage(
                request.requestId,
                response,
              ) ?? pilotUa5ProfilePayloadResultMessage(
                request.requestId,
                pilotUa5ProfilePayloadFailure('PILOT_UA5_PROFILE_UNAVAILABLE'),
              );
              // Clear the in-flight fence before a synchronous test/runtime
              // port can resume content and request its first leaf check.
              profilePhase = 'READY';
              if (!terminal && envelope !== null) {
                try { connected.postMessage(envelope); } catch { failRun(request.requestId); }
              }
            })();
            return;
          }

          const writeCheck = parsePilotUa5WriteCheckRequest(candidate);
          if (writeCheck !== null) {
            if (
              profilePhase !== 'READY' ||
              writeCheckPending || pendingProfileCheck || pageGrant !== null || original === null || runRevoked ||
              writeCheck.requestId !== request.requestId ||
              writeCheck.ordinal !== nextWriteOrdinal
            ) {
              failRun(request.requestId);
              return;
            }
            const source = original;
            const authorization = source?.payload.composition.authority.questionAuthorizations.find((item) => item.questionId === writeCheck.questionId);
            if (!source || !authorization || !samePilotUa5ProfileCheck({
              runRequestId: request.requestId, ordinal: writeCheck.ordinal, binding: writeCheck.binding,
              profileBinding: source.payload.profileBinding, questionId: authorization.questionId, answerDigest: authorization.answerDigest,
            }, { runRequestId: request.requestId, ordinal: writeCheck.ordinal, binding: source.payload.composition.authority.binding,
              profileBinding: source.payload.profileBinding, questionId: authorization.questionId, answerDigest: authorization.answerDigest })) {
              failRun(request.requestId); return;
            }
            writeCheckPending = true;
            void revalidateProof(writeCheck.binding).then((proof) => {
              if (terminal) return;
              const time = now();
              const allowed = proof !== null && source === original && Number.isSafeInteger(time) && time >= exactDiscovery.issuedAtMs && time < source.expiresAtMs;
              if (!allowed) runRevoked = true;
              if (allowed) pageGrant = Object.freeze({ ordinal: writeCheck.ordinal, questionId: writeCheck.questionId,
                binding: writeCheck.binding, writeNotAfterMs: Math.min(proof!.writeNotAfterMs, source.expiresAtMs) });
              const response = pilotUa5WriteCheckResultMessage(
                request.requestId,
                writeCheck.ordinal,
                allowed,
                allowed ? pageGrant!.writeNotAfterMs : null,
                writeCheck.questionId,
              );
              writeCheckPending = false;
              if (!terminal && response !== null) {
                try { connected.postMessage(response); } catch { failRun(request.requestId); }
              }
            });
            return;
          }

          const profileCheck = parsePilotUa5ProfileCheckRequest(candidate);
          if (profileCheck !== null) {
            const grant = pageGrant, source = original;
            const authorization = source?.payload.composition.authority.questionAuthorizations.find((item) => item.questionId === profileCheck.check.questionId);
            if (!source || !grant || !authorization || runRevoked || pendingProfileCheck || writeCheckPending ||
                profileCheck.requestId !== request.requestId || grant.ordinal !== nextWriteOrdinal ||
                !samePilotUa5ProfileCheck(profileCheck.check, { runRequestId: request.requestId, ordinal: grant.ordinal, binding: grant.binding,
                  profileBinding: source.payload.profileBinding, questionId: grant.questionId, answerDigest: authorization.answerDigest })) {
              failRun(request.requestId); return;
            }
            pageGrant = null;
            pendingProfileCheck = true;
            void (async () => {
              let result: PilotUa5ProfileCurrentnessResponse = PILOT_UA5_PROFILE_CURRENTNESS_UNAVAILABLE;
              const before = await revalidateProof(grant.binding);
              if (before !== null && input.checkProfileCurrentness !== undefined) {
                try {
                  const parsed = parsePilotUa5ProfileCurrentnessResponse(await input.checkProfileCurrentness({
                    schemaVersion: 1, check: profileCheck.check, originalBindingSeal: source.seal,
                  }, Math.min(grant.writeNotAfterMs, before.writeNotAfterMs, source.expiresAtMs)));
                  if (parsed.ok && (!parsed.value.ok || samePilotUa5ProfileCheck(parsed.value.check, profileCheck.check))) result = parsed.value;
                } catch { result = PILOT_UA5_PROFILE_CURRENTNESS_UNAVAILABLE; }
              }
              const after = await revalidateProof(grant.binding);
              if (terminal) return;
              const time = now();
              if (!after || source !== original || !Number.isSafeInteger(time) || time < exactDiscovery.issuedAtMs ||
                  time >= Math.min(source.expiresAtMs, grant.writeNotAfterMs, after.writeNotAfterMs)) result = PILOT_UA5_PROFILE_CURRENTNESS_UNAVAILABLE;
              if (!result.ok) runRevoked = true;
              // Commit both phases before a synchronous port can request the next leaf.
              pendingProfileCheck = false;
              nextWriteOrdinal += 1;
              if (result.ok) authorizedLeafWrites += 1;
              const response = pilotUa5ProfileCheckResultMessage(request.requestId, grant.ordinal, result);
              if (response !== null) {
                try { connected.postMessage(response); } catch { failRun(request.requestId); }
              } else failRun(request.requestId);
            })();
            return;
          }

          const event = parsePilotUa5PanelEvent(candidate);
          if (
            event === null ||
            event.requestId !== request.requestId ||
            writeCheckPending || pendingProfileCheck || pageGrant !== null ||
            (event.kind !== 'pilot-ua5/progress' &&
              profilePhase !== 'READY')
          ) {
            failRun(request.requestId);
            return;
          }
          if (event.kind !== 'pilot-ua5/progress') {
            const affectedCount = event.result.ok
              ? event.result.projection.rows.filter((row) => row.state === 'FILLED' || row.writeEffect === 'MAY_HAVE_CHANGED').length
              : 0;
            if (affectedCount > authorizedLeafWrites ||
                (!finishAuthorization(affectedCount > 0) && affectedCount > 0)) {
              failRun(request.requestId, 'PILOT_UA5_WRITER_UNAVAILABLE');
              return;
            }
            terminal = true;
            const publish = (wizardVerified: boolean) => {
              if (event.result.ok && (event.kind !== 'pilot-ua5/wizard-result' || wizardVerified) && continuationScope && discoveryMatchesPage(exactDiscovery, continuationScope.page)) {
                let intentId: string | null = null;
                let time = NaN;
                try {
                  intentId = input.createContinueIntentId?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
                  time = now();
                } catch { intentId = null; }
                const expiresAtMs = Math.min(discoveryValid.writeNotAfterMs, exactDiscovery.issuedAtMs + 60_000);
                if (intentId !== null && /^[a-f0-9]{32}$/u.test(intentId) && Number.isSafeInteger(time) && time >= exactDiscovery.issuedAtMs && time < expiresAtMs) {
                  let retirementResult: boolean | null = null;
                  const context: ContinueContext = {
                    ...continuationScope, intentId, runRequestId: request.requestId, expiresAtMs, lastTime: time, consumed: false,
                    retireOldRun: () => {
                      if (retirementResult !== null) return retirementResult;
                      retirementResult = false;
                      runRevoked = true;
                      terminal = true;
                      original = null;
                      let retired = true;
                      try { input.revokeRunAuthorization(request.requestId); } catch { retired = false; }
                      closeContent();
                      retirementResult = retired;
                      return retirementResult;
                    },
                  };
                  continuations.set(tabId, context);
                  context.timer = setTimeout(() => retireContinuation(context), expiresAtMs - time);
                }
              }
              deliver(event.kind === 'pilot-ua5/wizard-result' && !wizardVerified ? pilotUa5ResultMessage(request.requestId, event.result) : event);
              closeContent();
            };
            if (event.kind === 'pilot-ua5/wizard-result') {
              void booleanProof(() => wizardContext ? input.wizardSource?.validate(wizardContext) ?? false : false).then(publish);
            } else publish(false);
            return;
          }
          deliver(event);
        });
        try {
          connected.postMessage(contentRequest);
        } catch {
          failRun(request.requestId);
        }
      })();
    });
  });
  return true;
}
