import { samePilotUa5ProfileCheck, type PilotUa5ProfileCheck } from '@edaix/contracts/draft/pilot-ua5-profile-currentness';
import type { PilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import type { PilotUa1PageBinding } from '@edaix/contracts/draft';
import type { PilotWizardScanContext } from '@edaix/contracts/draft/pilot-wizard-context';
import type { PilotLocalWizardProjection } from '@edaix/contracts/draft/pilot-local-wizard';
import type { PilotUa5ProgressEvent, PilotUa5RunResult } from '../lib/pilotUa5Orchestrator';
import {
  pilotUa5ProfilePayloadFailure,
  type PilotUa5ProfilePayloadRequest,
  type PilotUa5ProfilePayloadResponse,
} from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import {
  PILOT_UA5_CONTENT_PORT_NAME,
  createPilotUa5WriteCheckRequest,
  pilotUa5ProfileCheckRequestMessage,
  parsePilotUa5ProfileCheckResult,
  isExactExtensionSender,
  parsePilotUa5ContentRunRequest,
  parsePilotUa5ContentRescanRequest,
  parsePilotUa5ReadOnlyScanResult,
  pilotUa5RescanResultMessage,
  parsePilotUa5ProfilePayloadResultMessage,
  parsePilotUa5CurrentResultRequest,
  parsePilotUa5UndoRequest,
  parsePilotUa5WriteCheckResult,
  pilotUa5ConnectedFailure,
  pilotUa5ProgressMessage,
  pilotUa5ProfilePayloadRequestMessage,
  pilotUa5ResultMessage,
  pilotUa5UndoResultMessage,
  type PilotUa5ConnectedPort,
  type PilotUa5LeafWriteAuthorization,
  type PilotUa5ReadOnlyScanResult,
} from '../lib/pilotUa5ConnectedProtocol';

type ConnectEvent = Readonly<{
  addListener(listener: (port: PilotUa5ConnectedPort) => void): void;
}>;

export type PilotUa5ConnectedRunCurrentPage = (
  discovery: PilotUa1DiscoveryRequest,
  onProgress: (event: PilotUa5ProgressEvent) => void,
  ports: Readonly<{
    signal: AbortSignal;
    wizardContext?: PilotWizardScanContext;
    resolveProfilePayloads(
      request: PilotUa5ProfilePayloadRequest,
    ): Promise<PilotUa5ProfilePayloadResponse>;
    authorizeLeafWrite?(binding: PilotUa1PageBinding, questionId: string): Promise<PilotUa5LeafWriteAuthorization>;
    isProfileCurrent?(expected: Pick<PilotUa5ProfileCheck, 'profileBinding' | 'questionId' | 'answerDigest'>): Promise<boolean>;
  }>,
) => Promise<PilotUa5RunResult>;

export type PilotUa5ConnectedUndoCurrentPage = (
  runRequestId: string,
  questionId: string,
) => Promise<'RESTORED' | 'UNAVAILABLE'>;

export function installPilotUa5ConnectedContent(input: Readonly<{
  enabled: boolean;
  extensionId: string;
  expectedBackgroundUrl: string;
  runtime: Readonly<{ onConnect: ConnectEvent }>;
  runCurrentPage: PilotUa5ConnectedRunCurrentPage;
  undoCurrentPage?: PilotUa5ConnectedUndoCurrentPage;
  getCurrentResult?: () => ReturnType<typeof pilotUa5ResultMessage>;
  rescanCurrentPage?: (discovery: PilotUa1DiscoveryRequest, signal: AbortSignal, wizardContext?: PilotWizardScanContext) => Promise<PilotUa5ReadOnlyScanResult>;
  getWizardProjection?: (result: PilotUa5RunResult) => PilotLocalWizardProjection | undefined;
  retireCurrentResult?: () => void;
  lifecycle?: Pick<EventTarget, 'addEventListener'>;
}>): boolean {
  if (!input.enabled) return false;
  type Activity = Readonly<{
    requestId: string; discovery: PilotUa1DiscoveryRequest; controller: AbortController; done: Promise<void>;
  }>;
  let activity: Activity | null = null;
  let lastRun: Activity | null = null;
  input.lifecycle?.addEventListener('pagehide', () => {
    lastRun = null;
    activity?.controller.abort();
  });

  input.runtime.onConnect.addListener((port) => {
    if (port.name !== PILOT_UA5_CONTENT_PORT_NAME) return;
    if (!isExactExtensionSender(port.sender, input.extensionId, input.expectedBackgroundUrl)) {
      try { port.disconnect(); } catch { /* already closed */ }
      return;
    }
    let started = false;
    let terminal = false;
    let activeRequestId: string | null = null;
    const controller = new AbortController();
    let profileConsumed = false;
    let settleProfile: ((response: PilotUa5ProfilePayloadResponse) => void) | null = null;
    let nextWriteOrdinal = 1;
    let forwardRevoked = false;
    let pendingWriteCheck: Readonly<{
      ordinal: number;
      questionId: string;
      binding: PilotUa1PageBinding;
      finish(authorization: PilotUa5LeafWriteAuthorization): void;
    }> | null = null;
    let pageGrant: Readonly<{ ordinal: number; questionId: string; binding: PilotUa1PageBinding }> | null = null;
    let pendingProfileCheck: Readonly<{ check: PilotUa5ProfileCheck; finish(allowed: boolean): void }> | null = null;
    controller.signal.addEventListener('abort', () => { pageGrant = null; }, { once: true });

    const awaitReply = <T>(
      envelope: unknown,
      unavailable: T,
      setPending: (finish: ((response: T) => void) | null) => void,
    ): Promise<T> => new Promise((resolve) => {
      let settled = false;
      const finish = (response: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        setPending(null);
        resolve(response);
      };
      const onAbort = () => { finish(unavailable); controller.abort(); };
      const timer = setTimeout(onAbort, 6_000);
      setPending(finish);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) { onAbort(); return; }
      try { port.postMessage(envelope); } catch { onAbort(); }
    });

    const close = () => {
      try { port.disconnect(); } catch { /* already closed */ }
    };
    const failAndClose = () => {
      controller.abort();
      close();
    };
    port.onDisconnect.addListener(() => {
      if (!terminal) controller.abort();
    });
    port.onMessage.addListener((message) => {
      const rescanRequest = parsePilotUa5ContentRescanRequest(message);
      if (rescanRequest !== null && !started) {
        started = true;
        const previous = lastRun;
        if (!previous || previous.requestId !== rescanRequest.runRequestId ||
            (activity !== null && activity !== previous) || !input.rescanCurrentPage || !input.retireCurrentResult ||
            previous.discovery.targetOrigin !== rescanRequest.discovery.targetOrigin ||
            previous.discovery.targetPathname !== rescanRequest.discovery.targetPathname ||
            previous.discovery.targetUrlDigest !== rescanRequest.discovery.targetUrlDigest) {
          failAndClose(); return;
        }
        let settleScan!: () => void;
        const scanActivity: Activity = Object.freeze({
          requestId: rescanRequest.requestId, discovery: rescanRequest.discovery, controller,
          done: new Promise<void>((resolve) => { settleScan = resolve; }),
        });
        // Hold the slot while the old run finishes. Its finally cannot release
        // a replacement scan, and a late old result cannot regain publication.
        lastRun = null;
        activity = scanActivity;
        previous.controller.abort();
        void (async () => {
          let result: PilotUa5ReadOnlyScanResult = { ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' };
          try {
            await previous.done;
            input.retireCurrentResult!();
            if (!controller.signal.aborted && activity === scanActivity) {
              result = parsePilotUa5ReadOnlyScanResult(await input.rescanCurrentPage!(rescanRequest.discovery, controller.signal,
                rescanRequest.wizardContext)) ?? result;
              if (result.ok && result.wizard && !rescanRequest.wizardContext) result = { ok: true, scan: result.scan };
            }
          } catch { result = { ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }; }
          if (controller.signal.aborted || activity !== scanActivity) result = { ok: false, code: 'PILOT_TARGET_DRIFT' };
          const envelope = pilotUa5RescanResultMessage(rescanRequest.requestId, rescanRequest.runRequestId, result);
          terminal = true;
          if (envelope !== null && !controller.signal.aborted) {
            try { port.postMessage(envelope); } catch { controller.abort(); }
          }
        })().finally(() => {
          if (activity === scanActivity) activity = null;
          settleScan();
          close();
        });
        return;
      }
      const recovery = parsePilotUa5CurrentResultRequest(message);
      if (recovery !== null && !started) {
        started = true;
        terminal = true;
        let result: ReturnType<typeof pilotUa5ResultMessage> = null;
        try { result = input.getCurrentResult?.() ?? null; } catch { result = null; }
        try {
          port.postMessage(result ?? pilotUa5ResultMessage(
            recovery.requestId, pilotUa5ConnectedFailure('PILOT_UA5_WRITER_UNAVAILABLE'),
          ));
        } catch { /* No delivery authority; the retained session still owns recovery. */ }
        close();
        return;
      }
      const undoRequest = parsePilotUa5UndoRequest(message);
      if (undoRequest !== null && !started) {
        started = true;
        terminal = true;
        try {
          port.postMessage(pilotUa5UndoResultMessage(
            undoRequest.requestId, undoRequest.runRequestId, undoRequest.questionId, 'UNAVAILABLE',
          ));
        } catch { controller.abort(); }
        close();
        return;
      }

      const profileResult = parsePilotUa5ProfilePayloadResultMessage(message);
      if (profileResult !== null && started) {
        if (
          profileResult.requestId !== activeRequestId ||
          settleProfile === null
        ) {
          failAndClose();
          return;
        }
        settleProfile(profileResult.response);
        settleProfile = null;
        return;
      }

      const writeCheckResult = parsePilotUa5WriteCheckResult(message);
      if (writeCheckResult !== null && started) {
        const pending = pendingWriteCheck;
        if (
          pending === null ||
          writeCheckResult.requestId !== activeRequestId ||
          writeCheckResult.ordinal !== pending.ordinal ||
          writeCheckResult.questionId !== pending.questionId || terminal || controller.signal.aborted
        ) {
          failAndClose();
          return;
        }
        if (!writeCheckResult.allowed || writeCheckResult.writeNotAfterMs === null) {
          forwardRevoked = true;
          pending.finish(false);
          return;
        }
        pageGrant = Object.freeze({ ordinal: pending.ordinal, questionId: pending.questionId, binding: pending.binding });
        // The live session owns the monotonic clock and checks this absolute
        // deadline again at the native setter. Delivery cannot extend it.
        pending.finish(Object.freeze({ allowed: true, writeNotAfterMs: writeCheckResult.writeNotAfterMs }));
        return;
      }

      const profileCheckResult = parsePilotUa5ProfileCheckResult(message);
      if (profileCheckResult !== null && started) {
        const pending = pendingProfileCheck;
        if (!pending || terminal || controller.signal.aborted || profileCheckResult.requestId !== activeRequestId ||
            profileCheckResult.ordinal !== pending.check.ordinal ||
            (profileCheckResult.result.ok && !samePilotUa5ProfileCheck(profileCheckResult.result.check, pending.check))) {
          failAndClose(); return;
        }
        // Consume the only pending comparison before resolving into the setter.
        nextWriteOrdinal += 1;
        if (!profileCheckResult.result.ok) forwardRevoked = true;
        pending.finish(profileCheckResult.result.ok);
        return;
      }

      const request = parsePilotUa5ContentRunRequest(message);
      if (
        request === null ||
        request.requestId !== request.discovery.requestId ||
        started ||
        activity !== null
      ) {
        failAndClose();
        return;
      }
      started = true;
      activeRequestId = request.requestId;
      let settleRun!: () => void;
      const runActivity: Activity = Object.freeze({
        requestId: request.requestId, discovery: request.discovery, controller,
        done: new Promise<void>((resolve) => { settleRun = resolve; }),
      });
      activity = runActivity;
      lastRun = runActivity;
      void (async () => {
        let candidate: PilotUa5RunResult;
        try {
          candidate = await input.runCurrentPage(
            request.discovery,
            (event) => {
              if (terminal || controller.signal.aborted) return;
              const envelope = pilotUa5ProgressMessage(request.requestId, event);
              if (envelope === null) return;
              try { port.postMessage(envelope); } catch { controller.abort(); }
            },
            Object.freeze({
              signal: controller.signal,
              ...(request.wizardContext ? { wizardContext: request.wizardContext } : {}),
              resolveProfilePayloads: async (profileRequest) => {
                if (profileConsumed || controller.signal.aborted) {
                  return pilotUa5ProfilePayloadFailure('PILOT_UA5_PROFILE_UNAVAILABLE');
                }
                profileConsumed = true;
                const envelope = pilotUa5ProfilePayloadRequestMessage(
                  request.requestId,
                  profileRequest,
                );
                if (envelope === null) {
                  return pilotUa5ProfilePayloadFailure('PILOT_UA5_INPUT_INVALID');
                }
                return awaitReply<PilotUa5ProfilePayloadResponse>(
                  envelope, pilotUa5ProfilePayloadFailure('PILOT_UA5_PROFILE_UNAVAILABLE'),
                  (finish) => { settleProfile = finish; },
                );
              },
              authorizeLeafWrite: async (binding, questionId) => {
                if (forwardRevoked) return false;
                if (terminal || controller.signal.aborted || pendingWriteCheck !== null || pageGrant !== null || pendingProfileCheck !== null) {
                  failAndClose(); return false;
                }
                const ordinal = nextWriteOrdinal;
                const envelope = createPilotUa5WriteCheckRequest(request.requestId, ordinal, binding, questionId);
                if (envelope === null) { failAndClose(); return false; }
                return awaitReply<PilotUa5LeafWriteAuthorization>(envelope, false, (finish) => {
                  pendingWriteCheck = finish === null ? null : Object.freeze({ ordinal, questionId, binding: envelope.binding, finish });
                });
              },
              isProfileCurrent: async (expected) => {
                if (forwardRevoked) return false;
                const grant = pageGrant;
                if (terminal || controller.signal.aborted || !grant || pendingWriteCheck !== null || pendingProfileCheck !== null ||
                    grant.ordinal !== nextWriteOrdinal || grant.questionId !== expected.questionId) {
                  failAndClose(); return false;
                }
                pageGrant = null;
                const envelope = pilotUa5ProfileCheckRequestMessage({ ...expected, runRequestId: request.requestId,
                  ordinal: grant.ordinal, binding: grant.binding });
                if (!envelope) { failAndClose(); return false; }
                return awaitReply<boolean>(envelope, false, (finish) => {
                  pendingProfileCheck = finish === null ? null : Object.freeze({ check: envelope.check, finish });
                });
              },
            }),
          );
        } catch {
          candidate = pilotUa5ConnectedFailure('PILOT_UA5_WRITER_UNAVAILABLE');
        }
        let wizard: PilotLocalWizardProjection | undefined;
        try { wizard = request.wizardContext ? input.getWizardProjection?.(candidate) : undefined; } catch { wizard = undefined; }
        const envelope = pilotUa5ResultMessage(request.requestId, candidate, wizard) ??
          pilotUa5ResultMessage(request.requestId, pilotUa5ConnectedFailure('PILOT_UA5_WRITER_UNAVAILABLE'));
        // Settlement is canonical before delivery. Losing this port only stops
        // further forward writes; it never rolls back already settled leaves.
        terminal = true;
        if (envelope !== null && !controller.signal.aborted) {
          try { port.postMessage(envelope); } catch { /* Read-only recovery remains available. */ }
        }
      })().finally(() => {
        if (activity === runActivity) activity = null;
        settleRun();
        close();
      });
    });
  });
  return true;
}
