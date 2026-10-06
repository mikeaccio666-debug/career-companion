import { parsePilotLocalWizardProjection, type PilotLocalWizardProjection } from '@edaix/contracts/draft/pilot-local-wizard';
import { parsePilotWizardScanContext } from '@edaix/contracts/draft/pilot-wizard-context';
import { resolveStoredWizardRuntimeAuthority } from './executionRuntimeAuthority';
import { createPilotWizardRuntime, isPilotWizardRuntimeCurrent, type PilotWizardRuntime } from './pilotWizardRuntime';
import { createPilotLocalWizardSession } from './pilotLocalWizardSession';
import { readPilotUa1DeclaredWizard, readPilotUa1WizardRuntime, type PilotUa1LiveObservation } from './pilotUa1DiscoveryRuntime';
import { readPilotUa5TerminalLedger, type PilotUa5RunResult } from './pilotUa5Orchestrator';
import { pilotUa5SemanticDigest as digest } from './pilotUa5SemanticDigest';
import type { PilotUa1DiscoveryRequest } from './pilotUa1DiscoveryProtocol';
import { readPilotUa4TerminalLedger, type PilotUa4WriterRuntimeResult } from './pilotUa4WriterRuntime';
import type { PilotUa4TerminalLedger } from '@edaix/contracts/draft/pilot-ua4-write-authority';

/** One content-document owner of verified, memory-only wizard history. It owns no scanner or writer. */
export function createPilotWizardController(input: Readonly<{
  document: Document;
  view: Window;
  location: Location;
  now: () => number;
  readStoredRuntimeBundle(): Promise<unknown>;
  extensionVersion(): string;
  /** Replaced for auth/runtime storage changes; never contains the auth data. */
  readAuthorityEpoch(): object;
}>) {
  let generation = 0, scopeKey: string | null = null, scopeToken: object | null = null, scopeEpoch: object | null = null;
  let activeRuntime: PilotWizardRuntime | null = null;
  let history: ReturnType<typeof createPilotLocalWizardSession> | null = null;
  let sessionDigest: string | null = null;
  const stepDigests = new Map<number, string>();
  let pendingTerminal: Readonly<{ live: PilotUa1LiveObservation; ledger: PilotUa4TerminalLedger; commit: () => boolean }> | null = null;
  const reset = (): void => {
    generation += 1; activeRuntime = null; scopeKey = null; scopeToken = null; scopeEpoch = null; sessionDigest = null;
    history?.dispose(); history = null; stepDigests.clear(); pendingTerminal = null;
  };
  const scopeCurrent = (): boolean => {
    try {
      return scopeToken !== null && scopeEpoch === input.readAuthorityEpoch() && activeRuntime !== null && isPilotWizardRuntimeCurrent(activeRuntime);
    } catch { return false; }
  };

  return Object.freeze({
    async prepare(candidate: unknown, discovery: PilotUa1DiscoveryRequest, signal: AbortSignal): Promise<PilotWizardRuntime | null> {
      const attempt = ++generation;
      activeRuntime = null;
      pendingTerminal = null;
      const reject = (): null => { if (attempt === generation) reset(); return null; };
      try {
        const context = parsePilotWizardScanContext(candidate), time = input.now(), epoch = input.readAuthorityEpoch();
        if (!context || context.requestId !== discovery.requestId || signal.aborted || !Number.isSafeInteger(time) ||
            time < discovery.issuedAtMs || time >= discovery.expiresAtMs || time >= context.expiresAtMs) return reject();
        const authority = await resolveStoredWizardRuntimeAuthority({ stored: await input.readStoredRuntimeBundle(),
          authorization: context.authorization, nowMs: time, extensionVersion: input.extensionVersion() });
        if (!authority.ok || attempt !== generation || signal.aborted || epoch !== input.readAuthorityEpoch()) return reject();
        const runtime = createPilotWizardRuntime({ authority: authority.value, document: input.document, location: input.location,
          now: input.now, isAuthorityCurrent: () => attempt === generation && !signal.aborted && input.readAuthorityEpoch() === epoch && input.now() < context.expiresAtMs });
        if (!runtime) return reject();
        const key = JSON.stringify([context.sessionId, runtime.rulesetDigest, runtime.runtimeBundleVersion]);
        if (scopeKey !== key || scopeEpoch !== epoch || history === null) {
          history?.dispose(); stepDigests.clear();
          scopeKey = key; scopeEpoch = epoch; scopeToken = Object.freeze({});
          sessionDigest = digest('S7_LOCAL_SESSION_V1', context.sessionId);
          const token = scopeToken;
          history = createPilotLocalWizardSession({ enabled: true, view: input.view, scopeToken: token,
            readCurrentScopeToken: () => scopeCurrent() ? scopeToken : null });
        }
        activeRuntime = runtime;
        return runtime;
      } catch { return reject(); }
    },

    observe(live: PilotUa1LiveObservation): boolean {
      if (!scopeCurrent() || !history || !activeRuntime || !sessionDigest || readPilotUa1WizardRuntime(live) !== activeRuntime) return false;
      const step = readPilotUa1DeclaredWizard(live);
      if (!step || !history.observe(live).ok) return false;
      stepDigests.set(step.stepIndex, digest('S7_LOCAL_WIZARD_STEP_V1', JSON.stringify([
        sessionDigest, activeRuntime.rulesetDigest, step.wizardKey, step.stepKey,
      ])));
      return true;
    },

    captureTerminal(live: PilotUa1LiveObservation, result: PilotUa4WriterRuntimeResult): boolean {
      if (!scopeCurrent() || !history || !activeRuntime || readPilotUa1WizardRuntime(live) !== activeRuntime) return false;
      const ledger = readPilotUa4TerminalLedger(result);
      if (!ledger) return false;
      const capture = history.captureTerminal(live, ledger);
      if (!capture.ok) return false;
      pendingTerminal = Object.freeze({ live, ledger, commit: () => capture.value.commit().ok });
      return true;
    },

    record(live: PilotUa1LiveObservation, result: PilotUa5RunResult): boolean {
      const pending = pendingTerminal;
      pendingTerminal = null;
      if (!scopeCurrent() || !pending || pending.live !== live) return false;
      const ledger = readPilotUa5TerminalLedger(result);
      return ledger === pending.ledger && pending.commit();
    },

    snapshot(): PilotLocalWizardProjection | null {
      if (!scopeCurrent() || !history || !sessionDigest) { reset(); return null; }
      const snapshot = history.snapshot();
      if (!snapshot.ok) return null;
      const index = snapshot.value.currentStepIndex;
      const parsed = parsePilotLocalWizardProjection({ schemaVersion: 1, scope: 'LOCAL_SESSION', sessionDigest,
        currentStep: index === null ? null : { stepIndex: index, identityDigest: stepDigests.get(index) },
        checkpoints: snapshot.value.checkpoints.map((checkpoint) => ({ stepIndex: checkpoint.stepIndex,
          identityDigest: stepDigests.get(checkpoint.stepIndex), discoveryComplete: checkpoint.currentGenerationDiscoveryComplete,
          requiredDispositions: checkpoint.requiredDispositions, unobservedRegions: checkpoint.unobservedRegions })) });
      return parsed.ok ? parsed.value : null;
    },
    reset,
  });
}
