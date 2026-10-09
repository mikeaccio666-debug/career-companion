import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import type { EvalBudget, EvalBudgetSnapshot } from './budget.ts';
import { runProviderLoopBaseline, type ProviderBaselineResult } from './probe.ts';
import { assertEvalStudyPlan, assertStudyInput } from './study-plan.ts';

const claimed = new WeakSet<EvalBudget>();
export class EvalPilotError extends Error {
  readonly code = 'EVAL_PILOT_INVALID';
  constructor() { super('The fresh, complete pilot configuration could not be confirmed.'); }
}
export interface EvalPilotReport {
  scope: 'isolated_provider_loop_pilot'; runId: string; studyDigest: string;
  status: 'completed' | 'stopped';
  stopReason: 'cancelled' | 'probe_failed' | 'result_persistence_failed' | null;
  plannedCases: number; persistedCases: number; completedCases: number;
  lastCaseId: string | null;
  budget: EvalBudgetSnapshot;
  productGate: 'not_evaluated'; qualityStatus: 'not_scored';
}

/**
 * Runs only the frozen development pilot. No credentials, transport creation,
 * live CLI, forecast approval, formal samples or automatic expansion here.
 * Both ledger and result persistence are supplied by the caller. The latter
 * must durably save before resolving; only content-free probe summaries pass it.
 * A run cannot be resumed/retried using this in-process budget instance.
 */
export async function runProviderPilot(options: {
  budget: EvalBudget; runtime: Pick<PlatformProviderRuntime, 'streamModelStep'>;
  persistResult: (result: Readonly<ProviderBaselineResult>) => Promise<void>;
  signal?: AbortSignal; nowMs?: () => number;
}): Promise<EvalPilotReport> {
  const { budget, runtime, persistResult, signal, nowMs } = options;
  assertEvalStudyPlan(budget.study);
  const before = budget.snapshot();
  if (typeof persistResult !== 'function' || claimed.has(budget) || before.status !== 'active' ||
      before.startedCalls || before.completedCaseIds.length || before.committedMicroUsd) throw new EvalPilotError();
  // Validate every pilot binding before the first request, not halfway through.
  const samples = budget.study.pilotCaseIds.map(caseId => {
    const binding = budget.bindingFor(caseId);
    const script = budget.study.scripts.find(item => item.id === binding.scriptId);
    if (!script || binding.stage !== 'pilot') throw new EvalPilotError();
    return { binding, item: assertStudyInput(budget.study, caseId, script) };
  });
  if (samples.length !== 12) throw new EvalPilotError();
  claimed.add(budget);
  let persistedCases = 0, completedCases = 0, lastCaseId: string | null = null;
  let stopReason: EvalPilotReport['stopReason'] = null;
  for (const sample of samples) {
    if (signal?.aborted || budget.signal.aborted) {
      stopReason = 'cancelled'; budget.abort(); break;
    }
    lastCaseId = sample.binding.caseId;
    let result: ProviderBaselineResult;
    try { result = await runProviderLoopBaseline({ ...sample, budget, runtime, signal, nowMs }); }
    catch { stopReason = 'probe_failed'; budget.abort(); break; }
    // A persistence callback cannot rewrite the status used by this runner.
    for (const metric of Object.values(result.productMetrics)) Object.freeze(metric);
    Object.freeze(result.productMetrics); Object.freeze(result);
    try { await persistResult(result); }
    catch { stopReason = 'result_persistence_failed'; budget.abort(); break; }
    persistedCases++;
    if (result.status === 'completed') completedCases++;
    if (result.status !== 'completed') {
      stopReason = signal?.aborted ? 'cancelled' : 'probe_failed'; budget.abort(); break;
    }
    if (signal?.aborted || budget.signal.aborted) {
      stopReason = 'cancelled'; budget.abort(); break;
    }
  }
  return Object.freeze({ scope: 'isolated_provider_loop_pilot', runId: budget.runId,
    studyDigest: budget.study.digest, status: stopReason ? 'stopped' : 'completed', stopReason,
    plannedCases: samples.length, persistedCases, completedCases, lastCaseId,
    budget: budget.snapshot(), productGate: 'not_evaluated', qualityStatus: 'not_scored' });
}
