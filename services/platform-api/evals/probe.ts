import { createHash } from 'node:crypto';
import { ProviderAdapter, runAgentLoop } from '@companion/ai-core';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import type { ScriptCase } from './cases.ts';
import type { EvalBudget, EvalCaseBinding } from './budget.ts';
import { PRODUCT_METRIC_BLOCKERS } from './preflight.ts';

import { baselineInput } from './baseline-input.ts';
import { assertStudyInput } from './study-plan.ts';
export { baselinePrompt } from './baseline-input.ts';

export interface ProviderBaselineResult {
  scope: 'isolated_provider_loop_baseline'; caseId: string; runId: string;
  studyDigest: string; scriptId: string; scriptDigest: string;
  stage: EvalCaseBinding['stage']; provider: string; model: string; purpose: EvalCaseBinding['purpose']; priceSnapshotId: string;
  inputScope: 'prompt_only'; toolExecution: 'not_exercised';
  timingBasis: 'loop_and_budget_accounting';
  status: 'completed' | 'failed'; errorCode?: string;
  seedInputDigest: string; outputDigest: string; outputChars: number;
  baselineFirstDeltaMs: number | null; baselineCompletedMs: number;
  productMetrics: Record<string, { value: null; status: 'blocked'; reason: string }>;
  qualityScore: null; qualityStatus: 'not_scored';
}

/**
 * Caller supplies a reviewed runtime and its own budget. The CLI does not call
 * this function. No account, room, lease, card, validator or grant is simulated.
 * Text is discarded after hashing; this is protocol timing, not quality grading.
 */
export async function runProviderLoopBaseline(options: {
  item: ScriptCase; binding: EvalCaseBinding; budget: EvalBudget;
  runtime: Pick<PlatformProviderRuntime, 'streamModelStep'>;
  signal?: AbortSignal; nowMs?: () => number;
}): Promise<ProviderBaselineResult> {
  const budget = options.budget, binding = budget.bindingFor(options.binding.caseId);
  const keys = Object.keys(binding) as (keyof EvalCaseBinding)[];
  if (Object.keys(options.binding).length !== keys.length || keys.some(key => options.binding[key] !== binding[key])) {
    throw new Error('EVAL_BASELINE_BINDING_MISMATCH');
  }
  const item = assertStudyInput(budget.study, binding.caseId, options.item);
  const now = options.nowMs ?? (() => performance.now()), started = now();
  const signal = options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal;
  const { persona, messages } = baselineInput(item);
  const seedInputDigest = binding.seedInputDigest;
  const output = createHash('sha256'); let outputChars = 0, firstDelta: number | null = null;
  let status: 'completed' | 'failed' = 'completed', errorCode: string | undefined;
  let finalCallComplete = false;
  const account = budget.accountingFor(binding.caseId);
  try {
    for await (const event of runAgentLoop(new ProviderAdapter(options.runtime), {
      provider: binding.provider, model: binding.model, mode: 'agent', persona, messages,
    }, {
      turnId: binding.caseId, purpose: binding.purpose, signal,
      limits: { maxRounds: 1, maxToolCalls: 0, maxOutputTokens: binding.maxOutputTokens, timeoutMs: 60_000 },
      callTimeoutMs: 45_000, firstTokenTimeoutMs: 30_000, finalTimeoutMs: 5000,
      reasoningEffort: 'low', toolDefinitions: [], resolveTools: () => [],
      executeTool: async () => { throw new Error('EVAL_NO_EXECUTOR'); },
      drainInterjections: () => [], onModelCall: async event => {
        await account(event);
        if (event.type === 'started') finalCallComplete = false;
        else finalCallComplete = event.status === 'complete';
      },
    })) {
      if (event.type === 'delta' && event.text.length) {
        firstDelta ??= now() - started; outputChars += event.text.length; output.update(event.text);
      }
    }
    if (!finalCallComplete || !outputChars) throw new Error('EVAL_NO_COMPLETED_OUTPUT');
    await budget.completeCase(binding.caseId);
  } catch (error) {
    status = 'failed';
    // Neither thrown provider bodies nor arbitrary messages reach the metric record.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const codes = ['USAGE_RECORD_UNCONFIRMED', 'PROVIDER_UNREACHABLE', 'PROVIDER_STREAM_INTERRUPTED',
      'PROVIDER_OUTPUT_LIMIT', 'AGENT_DEADLINE', 'JOB_CANCELLED', 'STREAM_CANCELLED'];
    errorCode = typeof code === 'string' && codes.includes(code) ? code : signal.aborted ? 'EVAL_CANCELLED' : 'EVAL_BASELINE_FAILED';
  }
  return { scope: 'isolated_provider_loop_baseline', caseId: binding.caseId, runId: budget.runId,
    studyDigest: binding.studyDigest, scriptId: binding.scriptId, scriptDigest: binding.scriptDigest,
    stage: binding.stage, provider: binding.provider, model: binding.model, purpose: binding.purpose, priceSnapshotId: binding.priceSnapshotId,
    inputScope: 'prompt_only', toolExecution: 'not_exercised', timingBasis: 'loop_and_budget_accounting', status,
    ...(errorCode ? { errorCode } : {}), seedInputDigest,
    outputDigest: output.digest('hex'), outputChars, baselineFirstDeltaMs: firstDelta,
    baselineCompletedMs: now() - started,
    productMetrics: Object.fromEntries(Object.entries(PRODUCT_METRIC_BLOCKERS).map(([key, reason]) => [key,
      { value: null, status: 'blocked', reason }])), qualityScore: null, qualityStatus: 'not_scored' };
}
