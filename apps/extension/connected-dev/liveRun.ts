/**
 * One connected-dev current-page run, entirely owned by the content realm.
 *
 * UA-1's live Element registry and Profile payload values never leave this
 * function. The only outward result is UA-5's value-free progress/projection.
 */

import {
  parsePilotUa5CompositionRequest,
  parsePilotUa5ReadOnlyScan,
  type PilotUa5CompositionResponse,
} from '@edaix/contracts/draft/pilot-ua5-certification';
import { parsePilotUa5ProfilePayloadResponse } from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import {
  createPilotUa1ContentRuntime,
  type PilotUa1LiveObservation,
  type PilotUa1Observation,
} from '../lib/pilotUa1DiscoveryRuntime';
import {
  createPilotUa5LiveContentSession,
  type PilotUa5LiveContentSessionInput,
} from '../lib/pilotUa5LiveContentSession';
import {
  runPilotUa5CurrentPage,
  type PilotUa5RunResult,
} from '../lib/pilotUa5Orchestrator';
import { pilotUa5ResultMessage, type PilotUa5ReadOnlyScanResult } from '../lib/pilotUa5ConnectedProtocol';
import type { PilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import { pilotUa5SemanticDigest } from '../lib/pilotUa5SemanticDigest';
import { isPilotUa5ControlledLocalObservation } from '../lib/pilotUa5ControlledLocalAdmission';
import type { PilotUa5ConnectedRunCurrentPage } from './contentRuntime';
import { createPilotWizardController } from '../lib/pilotWizardController';
import { isPilotWizardRuntimeCurrent, type PilotWizardRuntime } from '../lib/pilotWizardRuntime';
import type { PilotWizardScanContext } from '@edaix/contracts/draft/pilot-wizard-context';
import type { PilotLocalWizardProjection } from '@edaix/contracts/draft/pilot-local-wizard';

export type CreatePilotUa5ConnectedLiveRunInput = Readonly<{
  enabled: boolean;
  /** Narrows the approved local acceptance artifact; grants no write authority. */
  controlledLocalTextOnly?: boolean;
  extensionId: string;
  expectedBackgroundUrl: string;
  document?: Document;
  view?: Window;
  location?: Location;
  now?: () => number;
  /** Absolute build cutoff copied into the isolated content execution fence. */
  writeNotAfterMs?: number;
  /** Test seam only; production keeps UA-1's content-script shadow-root authority. */
  openShadowRoot?: (element: Element) => ShadowRoot | null;
  forwardWriteMode?: PilotUa5LiveContentSessionInput['forwardWriteMode'];
  wizard?: Pick<Parameters<typeof createPilotWizardController>[0], 'readStoredRuntimeBundle' | 'extensionVersion' | 'readAuthorityEpoch'>;
  session?: Omit<
    PilotUa5LiveContentSessionInput,
    'enabled' | 'document' | 'view' | 'location' | 'now' | 'writeNotAfterMs' |
    'forwardWriteMode' | 'authorizeLeafWrite' | 'isProfileCurrent' | 'onTerminalLedger'
  >;
}>;

const compositionFailure = (): PilotUa5CompositionResponse => Object.freeze({
  ok: false,
  schemaVersion: 1,
  code: 'PILOT_UA5_AUTHORITY_UNAVAILABLE',
});

export function createPilotUa5ConnectedLiveRun(
  input: CreatePilotUa5ConnectedLiveRunInput,
) {
  const wizard = input.wizard ? createPilotWizardController({ ...input.wizard,
    document: input.document ?? document, view: input.view ?? window, location: input.location ?? location, now: input.now ?? Date.now }) : null;
  const wizardResults = new WeakMap<PilotUa5RunResult, Readonly<{ projection: PilotLocalWizardProjection; runtime: PilotWizardRuntime }>>();
  let retained: Readonly<{
    requestId: string;
    result: PilotUa5RunResult;
    expiresAtMs: number;
    isCurrent: () => boolean;
    dispose: () => void;
  }> | null = null;
  let retireTimer: ReturnType<typeof setTimeout> | null = null;
  const retire = () => {
    if (retireTimer !== null) clearTimeout(retireTimer);
    retireTimer = null;
    retained?.dispose();
    retained = null;
  };
  const run: PilotUa5ConnectedRunCurrentPage = async (
    discovery,
    onProgress,
    ports,
  ): Promise<PilotUa5RunResult> => {
    retire();
    const doc = input.document ?? document;
    const view = input.view ?? window;
    const loc = input.location ?? location;
    const now = input.now ?? Date.now;
    const session = createPilotUa5LiveContentSession({
      ...(input.session ?? {}),
      enabled: input.enabled,
      document: doc,
      view,
      location: loc,
      now,
      writeNotAfterMs: input.writeNotAfterMs,
      forwardWriteMode: input.forwardWriteMode ?? 'FILL_ONLY',
      authorizeLeafWrite: ({ binding, questionId }) =>
        ports.authorizeLeafWrite?.(binding, questionId) ?? Promise.resolve(false),
      isProfileCurrent: (expected) => ports.isProfileCurrent?.(expected) ?? Promise.resolve(false),
      onTerminalLedger: (live, result) => wizard?.captureTerminal(live, result) ?? false,
    });
    const abortSession = () => session.abort();
    ports.signal.addEventListener('abort', abortSession, { once: true });
    try {
      if (!input.enabled || ports.signal.aborted) {
        return Object.freeze({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
      }
      let captured: PilotUa1LiveObservation | null = null;
      let wizardLive: PilotUa1LiveObservation | null = null;
      const wizardRuntime = wizard ? await wizard.prepare(ports.wizardContext, discovery, ports.signal) : null;
      const observeExactPage = createPilotUa1ContentRuntime({
        enabled: true,
        extensionId: input.extensionId,
        expectedBackgroundUrl: input.expectedBackgroundUrl,
        document: doc,
        view,
        location: loc,
        now,
        openShadowRoot: input.openShadowRoot,
        ...(wizardRuntime ? { wizardRuntime } : {}),
        observeLive: (live) => {
          captured = live;
        },
      });
      const result = await runPilotUa5CurrentPage(
        Object.freeze({ enabled: true }),
        Object.freeze({
          observe: async () => {
            if (ports.signal.aborted) return null;
            const result = await observeExactPage(discovery, Object.freeze({
              id: input.extensionId,
              url: input.expectedBackgroundUrl,
            }));
            const live = captured as PilotUa1LiveObservation | null;
            captured = null;
            if (!result.ok || live === null || ports.signal.aborted ||
              (input.controlledLocalTextOnly === true &&
                !isPilotUa5ControlledLocalObservation(live.observation.packet))) {
              live?.registry.dispose();
              return null;
            }
            if (!session.observe(live)) return null;
            if (wizard?.observe(live)) wizardLive = live;
            return live.observation;
          },
          compose: async (candidate: unknown) => {
            if (ports.signal.aborted) return compositionFailure();
            const parsedRequest = parsePilotUa5CompositionRequest(candidate);
            if (!parsedRequest.ok) return compositionFailure();
            let candidateResponse: unknown;
            try {
              candidateResponse = await ports.resolveProfilePayloads(parsedRequest.value);
            } catch {
              return compositionFailure();
            }
            if (ports.signal.aborted) return compositionFailure();
            const parsedResponse = parsePilotUa5ProfilePayloadResponse(candidateResponse);
            if (!parsedResponse.ok || !parsedResponse.value.ok) return compositionFailure();
            if (!session.bindPayloads(parsedResponse.value.payloads, parsedResponse.value.profileBinding)) return compositionFailure();
            return parsedResponse.value.composition;
          },
          writer: session.writer,
          resolvePayloadRef: session.resolvePayloadRef,
          semanticDigest: pilotUa5SemanticDigest,
          now,
          onProgress,
        }),
        true,
      );
      if (result.ok && wizardRuntime && wizardLive && wizard) {
        if (session.didCaptureTerminal()) wizard.record(wizardLive, result);
        const projection = wizard.snapshot();
        if (projection !== null) wizardResults.set(result, Object.freeze({ projection, runtime: wizardRuntime }));
      }
      if (result.ok && result.projection.rows.some(
        (row) => row.state === 'FILLED' || row.writeEffect === 'MAY_HAVE_CHANGED',
      )) {
        // Delivery recovery retains only the canonical value-free result and a
        // read-only page-generation fence. No payload, target map or Undo lives here.
        const expiresAtMs = discovery.issuedAtMs + 60_000;
        const root = doc.documentElement;
        const href = loc.href;
        let lastTime = discovery.issuedAtMs;
        let invalidated = false;
        const invalidate = () => { invalidated = true; };
        const observer = new MutationObserver(invalidate);
        observer.observe(root, { childList: true, subtree: true });
        for (const name of ['pagehide', 'popstate', 'hashchange']) view.addEventListener(name, invalidate, true);
        const dispose = () => {
          invalidated = true;
          observer.disconnect();
          for (const name of ['pagehide', 'popstate', 'hashchange']) view.removeEventListener(name, invalidate, true);
        };
        const isCurrent = () => {
          try {
            const time = now();
            if (!Number.isSafeInteger(time) || time < lastTime || time >= expiresAtMs ||
                loc.href !== href || doc.documentElement !== root || observer.takeRecords().length > 0) invalidate();
            lastTime = time;
            return !invalidated;
          } catch { invalidate(); return false; }
        };
        retained = Object.freeze({ requestId: discovery.requestId, result, expiresAtMs, isCurrent, dispose });
        const retainedRun = retained;
        retireTimer = setTimeout(() => {
          if (retained === retainedRun) retire();
        }, Math.max(0, expiresAtMs - (session.currentTime() ?? expiresAtMs)));
      }
      return result;
    } finally {
      ports.signal.removeEventListener('abort', abortSession);
      session.dispose();
    }
  };

  return Object.assign(run, Object.freeze({
    async rescanCurrentPage(discovery: PilotUa1DiscoveryRequest, signal: AbortSignal, wizardContext?: PilotWizardScanContext): Promise<PilotUa5ReadOnlyScanResult> {
      if (!input.enabled || signal.aborted) return { ok: false, code: 'PILOT_CAPABILITY_DISABLED' };
      const doc = input.document ?? document, view = input.view ?? window, loc = input.location ?? location;
      const now = input.now ?? Date.now;
      const root = doc.documentElement, href = loc.href;
      let observation: PilotUa1Observation | null = null;
      let capturedLive: PilotUa1LiveObservation | null = null;
      let invalidated = false;
      const invalidate = () => { invalidated = true; };
      let result: PilotUa5ReadOnlyScanResult = { ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' };
      try {
        for (const name of ['pagehide', 'popstate', 'hashchange']) view.addEventListener(name, invalidate, true);
        const wizardRuntime = wizard ? await wizard.prepare(wizardContext, discovery, signal) : null;
        // UA-1 remains the sole collector. A verified wizard uses its one live
        // registry; this branch creates no Profile/session/compiler/writer.
        const observe = createPilotUa1ContentRuntime({
          enabled: true, extensionId: input.extensionId, expectedBackgroundUrl: input.expectedBackgroundUrl,
          document: doc, view, location: loc, now, openShadowRoot: input.openShadowRoot,
          observe: (fresh) => { observation = fresh; },
          ...(wizardRuntime ? { wizardRuntime, observeLive: (live: PilotUa1LiveObservation) => {
            capturedLive = live; wizard?.observe(live);
          } } : {}),
        });
        const observed = await observe(discovery, { id: input.extensionId, url: input.expectedBackgroundUrl });
        const fresh = observation as PilotUa1Observation | null;
        if (!observed.ok) result = observed;
        else if (fresh !== null && observed.detectedControlCount === fresh.packet.controls.length) {
          const parsed = parsePilotUa5ReadOnlyScan({
            schemaVersion: 1,
            observedControls: observed.detectedControlCount,
            hiddenNotObservedCount: fresh.packet.observation.hiddenNotObservedCount,
            unobservedRegions: fresh.packet.observation.opaqueBoundaries.length,
            structureAvailable: fresh.structure !== null,
            pageIdentity: 'UNVERIFIED',
          });
          const projection = wizardRuntime ? wizard?.snapshot() : null;
          if (parsed.ok) result = { ok: true, scan: parsed.value, ...(projection ? { wizard: projection } : {}) };
        }
      } catch { result = { ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }; }
      finally {
        observation = null;
        (capturedLive as PilotUa1LiveObservation | null)?.registry.dispose();
        for (const name of ['pagehide', 'popstate', 'hashchange']) {
          try { view.removeEventListener(name, invalidate, true); } catch { invalidated = true; }
        }
      }
      try {
        const time = now();
        if (signal.aborted || invalidated || doc.documentElement !== root || loc.href !== href ||
            !Number.isSafeInteger(time) || time < discovery.issuedAtMs || time >= discovery.expiresAtMs) {
          return { ok: false, code: 'PILOT_TARGET_DRIFT' };
        }
      } catch { return { ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' }; }
      return result;
    },
    getWizardProjection(result: PilotUa5RunResult): PilotLocalWizardProjection | undefined {
      const stored = wizardResults.get(result);
      return stored && isPilotWizardRuntimeCurrent(stored.runtime) ? stored.projection : undefined;
    },
    resetWizard: () => wizard?.reset(),
    getCurrentResult() {
      const current = retained;
      if (current === null) return null;
      if (!current.isCurrent()) {
        retire();
        return null;
      }
      return pilotUa5ResultMessage(current.requestId, current.result);
    },
    async undoCurrentPage(
      _runRequestId: string,
      _questionId: string,
    ): Promise<'RESTORED' | 'UNAVAILABLE'> {
      return 'UNAVAILABLE';
    },
    dispose: retire,
  }));
}
