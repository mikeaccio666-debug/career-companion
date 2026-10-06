import type {
  PilotUa4FinalDisposition,
  PilotUa4TerminalLedger,
  PilotUa4UnobservedRegion,
} from '@edaix/contracts/draft/pilot-ua4-write-authority';
import {
  buildPilotUa4TerminalLedger,
  executePilotUa4Leaf,
  preparePilotUa4WriterBatch,
  type PilotUa4CompiledQuestion,
  type PilotUa4LeafPlan,
  type PilotUa4OwnedUndo,
  type PilotUa4WriterFailureCode,
  type PreparePilotUa4WriterBatchInput,
} from '@edaix/apply-kernel/pilotUa4Writer';

import type { TextFillOnlyObservation } from '@edaix/apply-kernel/textSemanticSettlement';

export type PilotUa4WriterRuntimePolicy = Readonly<{ enabled: boolean }>;

/**
 * Host adapter supplied by the owned apply session. It resolves `payloadRef`
 * locally and must return only a terminal disposition after semantic readback,
 * host validation and positive late recheck, under the declared recovery mode.
 */
export type PilotUa4HostExecutor = Readonly<{
  execute(question: PilotUa4CompiledQuestion): Promise<PilotUa4FinalDisposition>;
  /**
   * Optional batch-final ownership check. It may only preserve a disposition
   * or downgrade it to a closed terminal; it never performs another write.
   */
  finalizeDisposition?(
    questionId: string,
    disposition: PilotUa4FinalDisposition,
  ): PilotUa4FinalDisposition;
}>;

export type PilotUa4LeafResolver = Readonly<{
  /** Resolve only from the current page-local registry; never from wire selectors. */
  resolve(question: PilotUa4CompiledQuestion): PilotUa4LeafPlan | null;
}>;

export type PilotUa4OwnedHostExecutor = PilotUa4HostExecutor & Readonly<{
  takeUndo(questionId: string): PilotUa4OwnedUndo | null;
  /** Transfers every still-owned handle for run-level compensating rollback. */
  /** Value-free lifetime probe used only to retain the exact page registry. */
  hasOwnedUndo(): boolean;
  /** Revoke the current generation without permanently retiring the executor. */
  revokeUndo(): void;
  dispose(): void;
}>;

/**
 * Concrete Extension consumer for the kernel semantic leaves. Fill-first keeps
 * only a read-only observation until batch finalization; legacy Undo handles
 * remain separately keyed by the compiler question.
 */
export function createPilotUa4LeafHostExecutor(
  resolver: PilotUa4LeafResolver,
): PilotUa4OwnedHostExecutor {
  const owned = new Map<string, PilotUa4OwnedUndo>();
  const observations = new Map<string, TextFillOnlyObservation>();
  let epoch = 0;
  let disposed = false;

  const revokeOwned = () => {
    epoch += 1;
    for (const observation of observations.values()) observation.dispose();
    observations.clear();
    for (const undo of owned.values()) {
      try { undo.dispose(); } catch { /* every handle is independently revoked */ }
    }
    owned.clear();
  };

  const finalizeOwned = (
    questionId: string,
    disposition: PilotUa4FinalDisposition,
  ): PilotUa4FinalDisposition => {
    if (disposition.state !== 'FILLED') return disposition;
    if (disposition.undo === 'FROZEN') {
      const observation = observations.get(questionId);
      observations.delete(questionId);
      try {
        const code = observation === undefined ? 'IDENTITY_CHANGED' : observation.finalize();
        if (code === null) return disposition;
        return Object.freeze({ state: 'POLICY_BLOCKED',
          reason: code === 'IDENTITY_CHANGED' || code === 'DETACHED' ? 'EXACT_TARGET_DRIFT' :
            code === 'HOST_REJECTED' ? 'HOST_REJECTED' : 'LATE_REVERTED',
          writeEffect: 'MAY_HAVE_CHANGED' });
      } finally { observation?.dispose(); }
    }
    const undo = owned.get(questionId);
    if (undo === undefined) {
      return Object.freeze({ state: 'POLICY_BLOCKED', reason: 'UNDO_UNAVAILABLE' });
    }
    // Text settlement exposes enough opaque ownership predicates for a final
    // non-mutating proof. Other existing kernel handles retain their own
    // terminal contracts and are not structurally guessed here.
    try {
      if (
        'isAtWrittenState' in undo && typeof undo.isAtWrittenState === 'function' &&
        'targetState' in undo && typeof undo.targetState === 'function' &&
        'wasUserEdited' in undo && typeof undo.wasUserEdited === 'function' &&
        'userEditGeneration' in undo && typeof undo.userEditGeneration === 'function' &&
        'writeUserEditGeneration' in undo
      ) {
        const current = undo.targetState() === 'CURRENT' &&
          undo.wasUserEdited() === false &&
          undo.userEditGeneration() === undo.writeUserEditGeneration &&
          undo.isAtWrittenState() === true;
        if (!current) {
          owned.delete(questionId);
          try { undo.dispose(); } catch { /* already revoked */ }
          return Object.freeze({ state: 'POLICY_BLOCKED', reason: 'UNDO_UNAVAILABLE' });
        }
      }
      return disposition;
    } catch {
      owned.delete(questionId);
      try { undo.dispose(); } catch { /* already revoked */ }
      return Object.freeze({ state: 'POLICY_BLOCKED', reason: 'UNDO_UNAVAILABLE' });
    }
  };

  return Object.freeze({
    async execute(question: PilotUa4CompiledQuestion): Promise<PilotUa4FinalDisposition> {
      if (disposed) {
        return Object.freeze({ state: 'POLICY_BLOCKED', reason: 'WRITER_EXECUTION_FAILED' });
      }
      const executionEpoch = epoch;
      const plan = resolver.resolve(question);
      if (plan === null) {
        return Object.freeze({ state: 'POLICY_BLOCKED', reason: 'TARGET_NOT_ELIGIBLE' });
      }
      const result = await executePilotUa4Leaf(question, plan);
      if (disposed || executionEpoch !== epoch) {
        result.observation?.dispose();
        try { result.undo?.dispose(); } catch { /* stale ownership is terminal */ }
        return result.disposition;
      }
      observations.get(question.questionId)?.dispose();
      observations.delete(question.questionId);
      if (result.observation) observations.set(question.questionId, result.observation);
      const previous = owned.get(question.questionId);
      if (previous !== undefined && previous !== result.undo) {
        try { previous.dispose(); } catch { /* replacement still takes ownership */ }
      }
      if (result.undo === null) owned.delete(question.questionId);
      else owned.set(question.questionId, result.undo);
      return result.disposition;
    },
    takeUndo(questionId: string): PilotUa4OwnedUndo | null {
      if (disposed) return null;
      const undo = owned.get(questionId) ?? null;
      if (undo !== null) owned.delete(questionId);
      return undo;
    },
    finalizeDisposition: finalizeOwned,
    hasOwnedUndo(): boolean {
      return !disposed && owned.size > 0;
    },
    revokeUndo(): void {
      if (disposed) return;
      revokeOwned();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      revokeOwned();
    },
  });
}

export type PilotUa4WriterRuntimeInput = Readonly<{
  authority: unknown;
  currentBinding: unknown;
  currentControlIdentityDigests: unknown;
  nowMs: unknown;
  semanticEpochs: PreparePilotUa4WriterBatchInput['semanticEpochs'];
  ua2Classifications: PreparePilotUa4WriterBatchInput['ua2Classifications'];
  semanticDigest: PreparePilotUa4WriterBatchInput['semanticDigest'];
  payloadRefs: PreparePilotUa4WriterBatchInput['payloadRefs'];
  discoveryComplete: boolean;
  /** Already terminal non-writer rows: AI/user/manual/discovery facts. */
  preResolvedDispositions: readonly Readonly<{
    questionId: string;
    disposition: PilotUa4FinalDisposition;
  }>[];
  /**
   * Parts of the page the scan reached but could not observe into, each with
   * the identity the producer gave it and a neutral reason. They are not
   * questions: the runtime never adds them to the denominator, mints no
   * terminal for them and asks no host to touch them. They ride the ledger's
   * own `unobservedRegions` section, and the ledger parser enforces the rest:
   * a region alongside `discoveryComplete: true` fails closed, and a region id
   * that collides with a question id fails closed.
   */
  unobservedRegions?: readonly PilotUa4UnobservedRegion[];
}>;

export type PilotUa4WriterRuntimeResult =
  | Readonly<{ ok: true; value: PilotUa4TerminalLedger }>
  | Readonly<{
      ok: false;
      code: 'PILOT_CAPABILITY_DISABLED' | PilotUa4WriterFailureCode;
    }>;

export type PilotUa4WriterRuntime = Readonly<{
  execute(input: PilotUa4WriterRuntimeInput): Promise<PilotUa4WriterRuntimeResult>;
}>;

const terminalResults = new WeakMap<PilotUa4WriterRuntimeResult, PilotUa4TerminalLedger>();
/** Content-only producer identity; copied results cannot mint a terminal capture. */
export function readPilotUa4TerminalLedger(result: PilotUa4WriterRuntimeResult): PilotUa4TerminalLedger | null {
  return terminalResults.get(result) ?? null;
}

/** Composition-only port. This module reads no DOM and owns no selectors. */
export function createPilotUa4WriterRuntime(
  policy: PilotUa4WriterRuntimePolicy,
  hostExecutor: PilotUa4HostExecutor,
): PilotUa4WriterRuntime {
  return Object.freeze({
    async execute(input: PilotUa4WriterRuntimeInput): Promise<PilotUa4WriterRuntimeResult> {
      if (!policy.enabled) {
        return Object.freeze({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
      }
      const prepared = preparePilotUa4WriterBatch({
        authority: input.authority,
        currentBinding: input.currentBinding,
        currentControlIdentityDigests: input.currentControlIdentityDigests,
        nowMs: input.nowMs,
        semanticEpochs: input.semanticEpochs,
        ua2Classifications: input.ua2Classifications,
        semanticDigest: input.semanticDigest,
        payloadRefs: input.payloadRefs,
      });
      if (!prepared.ok) return prepared;
      const dispositions: Array<Readonly<{
        questionId: string;
        disposition: PilotUa4FinalDisposition;
      }>> = [...prepared.value.dispositions, ...input.preResolvedDispositions];
      for (const question of prepared.value.questions) {
        let disposition: PilotUa4FinalDisposition;
        try {
          const candidate = await hostExecutor.execute(question);
          disposition = isValidDisposition(candidate, input.currentBinding)
            ? candidate
            : executionFailure();
        } catch {
          disposition = executionFailure();
        }
        dispositions.push(Object.freeze({ questionId: question.questionId, disposition }));
      }
      const finalized = dispositions.map((entry) => {
        if (
          entry.disposition.state !== 'FILLED' ||
          hostExecutor.finalizeDisposition === undefined
        ) return entry;
        const mayHaveChanged = entry.disposition.undo === 'FROZEN';
        let disposition: PilotUa4FinalDisposition;
        try {
          const candidate = hostExecutor.finalizeDisposition(
            entry.questionId,
            entry.disposition,
          );
          // A finalizer is a downgrade-only proof. Reject any malformed or
          // state-upgrading candidate instead of trusting caller structure.
          disposition = isValidDisposition(candidate, input.currentBinding)
            ? candidate
            : executionFailure(mayHaveChanged);
        } catch {
          disposition = executionFailure(mayHaveChanged);
        }
        return Object.freeze({ questionId: entry.questionId, disposition });
      });
      const result = buildPilotUa4TerminalLedger({
        binding: input.currentBinding,
        discoveryComplete: input.discoveryComplete,
        questions: prepared.value.denominatorQuestions,
        dispositions: finalized,
        unobservedRegions: input.unobservedRegions ?? [],
      });
      if (result.ok) terminalResults.set(result, result.value);
      return Object.freeze(result);
    },
  });
}

function executionFailure(mayHaveChanged = false): PilotUa4FinalDisposition {
  return Object.freeze({
    state: 'POLICY_BLOCKED',
    reason: 'WRITER_EXECUTION_FAILED',
    ...(mayHaveChanged ? { writeEffect: 'MAY_HAVE_CHANGED' as const } : {}),
  });
}

function isValidDisposition(value: unknown, binding: unknown): value is PilotUa4FinalDisposition {
  if (typeof value !== 'object' || value === null) return false;
  let state: unknown;
  try {
    state = Reflect.get(value, 'state');
  } catch {
    return false;
  }
  const discoveryComplete = state !== 'DISCOVERY_INCOMPLETE';
  return buildPilotUa4TerminalLedger({
    binding,
    discoveryComplete,
    questions: [{ questionId: 'validation.question', required: true }],
    dispositions: [{
      questionId: 'validation.question',
      disposition: value as PilotUa4FinalDisposition,
    }],
  }).ok;
}
