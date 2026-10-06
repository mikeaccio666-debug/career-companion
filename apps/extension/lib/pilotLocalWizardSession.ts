import { sameDeclaredWizardApplication, type DeclaredWizardStep } from '@edaix/apply-kernel/wizardIdentity';
import { readPilotUa1DeclaredWizard, type PilotUa1LiveObservation } from './pilotUa1DiscoveryRuntime';
import { readMultipageLedgerFacts, type MultipageLedgerFacts } from './pilotMultipageFoundation';

/** Value-free, memory-only history. It contains no Mission identity or execution authority. */
export interface LocalWizardCheckpoint extends MultipageLedgerFacts {
  readonly stepIndex: number;
  readonly stepKey: string;
}

export interface LocalWizardProjection {
  readonly scope: 'LOCAL_SESSION';
  readonly checkpoints: readonly LocalWizardCheckpoint[];
  readonly currentStepIndex: number | null;
  readonly currentStepCheckpointed: boolean;
}

type Failure = Readonly<{ ok: false; code: 'PILOT_CAPABILITY_DISABLED' | 'PILOT_TARGET_DRIFT' | 'PILOT_DISCOVERY_UNAVAILABLE' }>;
type Result<T> = Readonly<{ ok: true; value: T }> | Failure;
const failure = (code: Failure['code']): Failure => Object.freeze({ ok: false, code });

/**
 * Reuses UA-1's single observation and the Mission foundation's canonical
 * terminal-fact reader. This object owns no scanner, writer, navigation action,
 * answer store, remote message, storage or grant. Callers must supply one
 * content-owner token whose identity changes when owner/rules/runtime changes;
 * a token is not minted here and does not authorize a write. Published rule
 * producer wiring remains a separately reviewed prerequisite.
 */
export function createPilotLocalWizardSession(input: Readonly<{
  enabled: boolean;
  view: Window;
  scopeToken: object;
  readCurrentScopeToken: () => object | null;
}>) {
  let disposed = input.enabled !== true || typeof input.scopeToken !== 'object' || input.scopeToken === null;
  let chainValid = true;
  let revision = 0;
  let current: PilotUa1LiveObservation | null = null;
  let lastStep: DeclaredWizardStep | null = null;
  let checkpoints: readonly LocalWizardCheckpoint[] = Object.freeze([]);
  let recordedLive: PilotUa1LiveObservation | null = null;
  const retire = (): void => { chainValid = false; current = null; revision += 1; };
  const navigationEvents = ['pagehide', 'beforeunload', 'popstate', 'hashchange'] as const;
  const registered: Array<(typeof navigationEvents)[number]> = [];
  const dispose = (): Result<null> => {
    disposed = true; retire(); lastStep = null; recordedLive = null; checkpoints = Object.freeze([]);
    let cleaned = true;
    for (const type of registered.splice(0)) {
      try { input.view.removeEventListener(type, retire, true); }
      catch { cleaned = false; }
    }
    return cleaned ? Object.freeze({ ok: true, value: null }) : failure('PILOT_DISCOVERY_UNAVAILABLE');
  };
  if (!disposed) {
    try {
      for (const type of navigationEvents) {
        input.view.addEventListener(type, retire, true);
        registered.push(type);
      }
    } catch { dispose(); }
  }
  const scopeCurrent = (): boolean => {
    if (disposed) return false;
    try {
      const token = input.readCurrentScopeToken();
      if (!disposed && token === input.scopeToken) return true;
    } catch { disposed = true; }
    dispose();
    return false;
  };
  const rejectChain = (): Failure => { retire(); return failure('PILOT_TARGET_DRIFT'); };

  const captureTerminal = (live: PilotUa1LiveObservation, terminalLedger: unknown): Result<Readonly<{ commit: () => Result<LocalWizardCheckpoint> }>> => {
    if (!scopeCurrent()) return failure('PILOT_CAPABILITY_DISABLED');
    if (!chainValid || current !== live || lastStep === null) return failure('PILOT_TARGET_DRIFT');
    const before = revision, step = readPilotUa1DeclaredWizard(live);
    if (step === null) return failure('PILOT_TARGET_DRIFT');
    const facts = readMultipageLedgerFacts(terminalLedger);
    if (!facts.ok) return facts;
    const binding = live.observation.packet.binding;
    if (facts.value.binding.domGeneration !== binding.domGeneration ||
        facts.value.binding.origin !== binding.origin || facts.value.binding.pathname !== binding.pathname) {
      return failure('PILOT_TARGET_DRIFT');
    }
    if (!scopeCurrent()) return failure('PILOT_CAPABILITY_DISABLED');
    const finalStep = readPilotUa1DeclaredWizard(live);
    if (!scopeCurrent()) return failure('PILOT_CAPABILITY_DISABLED');
    if (!chainValid || current !== live || revision !== before || finalStep === null) {
      return failure('PILOT_TARGET_DRIFT');
    }
    const checkpoint = Object.freeze({ ...facts.value, stepIndex: step.stepIndex, stepKey: step.stepKey });
    return Object.freeze({ ok: true, value: Object.freeze({ commit: (): Result<LocalWizardCheckpoint> => {
      if (!scopeCurrent()) return failure('PILOT_CAPABILITY_DISABLED');
      if (!chainValid || current !== live) return failure('PILOT_TARGET_DRIFT');
      if (recordedLive === live) {
        const existing = checkpoints.at(-1)!;
        return JSON.stringify(existing) === JSON.stringify(checkpoint)
          ? Object.freeze({ ok: true, value: existing }) : failure('PILOT_TARGET_DRIFT');
      }
      if (revision !== before) return failure('PILOT_TARGET_DRIFT');
      checkpoints = Object.freeze([
        ...(checkpoints.at(-1)?.stepIndex === step.stepIndex ? checkpoints.slice(0, -1) : checkpoints), checkpoint,
      ]);
      recordedLive = live; revision += 1;
      return Object.freeze({ ok: true, value: checkpoint });
    } }) });
  };

  return Object.freeze({
    observe(live: PilotUa1LiveObservation): Result<null> {
      if (!scopeCurrent()) return failure('PILOT_CAPABILITY_DISABLED');
      if (!chainValid) return failure('PILOT_TARGET_DRIFT');
      const before = revision;
      const step = readPilotUa1DeclaredWizard(live);
      if (step === null || !scopeCurrent() || !chainValid || revision !== before) return rejectChain();
      if (lastStep === null) {
        if (step.stepIndex !== 0) return rejectChain();
      } else {
        if (!sameDeclaredWizardApplication(lastStep, step)) return rejectChain();
        const same = step.stepIndex === lastStep.stepIndex && step.stepKey === lastStep.stepKey;
        const next = step.stepIndex === lastStep.stepIndex + 1 && step.stepKey !== lastStep.stepKey;
        if (!same && !next) return rejectChain();
        // A missing terminal is unknown; advancing cannot manufacture one.
        if (next && checkpoints.at(-1)?.stepIndex !== lastStep.stepIndex) return rejectChain();
      }
      current = live; lastStep = step; revision += 1;
      return Object.freeze({ ok: true, value: null });
    },

    /** Capture only facts while UA-1 is current; commit adds no current-page claim after cleanup. */
    captureTerminal,
    recordTerminal(live: PilotUa1LiveObservation, terminalLedger: unknown): Result<LocalWizardCheckpoint> {
      const prepared = captureTerminal(live, terminalLedger);
      return prepared.ok ? prepared.value.commit() : prepared;
    },

    snapshot(): Result<LocalWizardProjection> {
      if (!scopeCurrent()) return failure('PILOT_CAPABILITY_DISABLED');
      const before = revision;
      const step = chainValid && current !== null ? readPilotUa1DeclaredWizard(current) : null;
      if (!scopeCurrent()) return failure('PILOT_CAPABILITY_DISABLED');
      if (revision !== before) return failure('PILOT_TARGET_DRIFT');
      return Object.freeze({ ok: true, value: Object.freeze({
        scope: 'LOCAL_SESSION', checkpoints,
        currentStepIndex: step?.stepIndex ?? null,
        currentStepCheckpointed: step !== null && current !== null && current === recordedLive,
      }) });
    },

    dispose,
  });
}
