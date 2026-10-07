import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { createEvalBudget, type EvalPriceSnapshot, type EvalCaseBinding, type EvalBudgetLedgerEvent } from '../evals/budget.ts';
import { P0_EVAL_CASES } from '../evals/cases.ts';
import { runProviderLoopBaseline } from '../evals/probe.ts';

const fixturePrice: EvalPriceSnapshot = {
  id: 'fixture-price', provider: 'openai', model: 'fictional-model', tier: 'development',
  sourceUrl: 'https://example.org/fictional-evaluation-price', checkedAt: '2026-10-07T00:00:00Z',
  expiresAt: '2026-10-08T00:00:00Z', reviewedBy: 'human', approvedConfigId: 'fixture-config',
  tariffProfileId: 'fictional-test-tariff', maxContextInputTokens: 1_050_000, maxOutputTokens: 2048,
  inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000,
};
function setup(persist?: (event: Readonly<EvalBudgetLedgerEvent>) => Promise<void>) {
  const item = P0_EVAL_CASES.find(value => value.speaker === 'companion')!;
  const binding: EvalCaseBinding = { caseId: 'fixture-development/' + item.id, stage: 'pilot',
    provider: 'openai', model: 'fictional-model', purpose: 'companion_reply',
    priceSnapshotId: fixturePrice.id, maxOutputTokens: 2048, maxModelCalls: 3 };
  const records: Readonly<EvalBudgetLedgerEvent>[] = [];
  const budget = createEvalBudget({ runId: 'fixture-probe-run', capMicroUsd: 19_000_000,
    prices: [fixturePrice], cases: [binding], now: () => new Date('2026-10-07T01:00:00Z'),
    persist: persist ?? (async event => { records.push(event); }) });
  return { item, binding, budget, records };
}
function fixtureRuntime(usage: 'reported' | 'missing' = 'reported'): Pick<PlatformProviderRuntime, 'streamModelStep'> {
  return { async *streamModelStep(input, context) {
    assert.equal(input.model, 'fictional-model');
    assert.equal(context.toolChoice, 'none');
    assert.deepEqual(context.tools, []);
    await context.onModelCall?.({ type: 'started', callId: 'fixture-probe-call', index: context.callIndex,
      provider: input.provider, model: input.model!, purpose: context.purpose });
    yield { type: 'delta', text: 'Fictional private response that must not reach logs.' };
    await context.onModelCall?.({ type: 'finished', callId: 'fixture-probe-call', status: 'complete',
      usage: usage === 'reported' ? { status: 'reported', inputTokens: 100, outputTokens: 20 } : { status: 'missing' } });
    return { text: 'Fictional private response that must not reach logs.', calls: [] };
  } };
}

test('shared loop probe records raw timing and known usage without pretending to score product metrics', async () => {
  const setupValue = setup(); let clock = 0;
  const result = await runProviderLoopBaseline({ ...setupValue, runtime: fixtureRuntime(), nowMs: () => clock += 10 });
  assert.equal(result.status, 'completed');
  assert.equal(result.scope, 'isolated_provider_loop_baseline');
  assert.equal(result.providerFirstDeltaMs, 10);
  assert.equal(result.providerCompletedMs, 20);
  assert.equal(result.qualityScore, null);
  assert.equal(result.qualityStatus, 'not_scored');
  assert(result.outputChars > 0);
  assert.match(result.outputDigest, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(result).includes('Fictional private response'));
  assert(!JSON.stringify(setupValue.records).includes('Fictional private response'));
  assert(setupValue.records.some(value => value.type === 'case_completed'));
  const snapshot = setupValue.budget.snapshot();
  assert.equal(snapshot.actualSpentMicroUsd, 140);
  assert.equal(snapshot.pendingReservedMicroUsd, 0);
  for (const metric of Object.values(result.productMetrics)) {
    assert.equal(metric.value, null); assert.equal(metric.status, 'blocked');
  }
});

test('missing usage preserves reservation and prevents completion or another script', async () => {
  const setupValue = setup();
  const result = await runProviderLoopBaseline({ ...setupValue, runtime: fixtureRuntime('missing') });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'USAGE_RECORD_UNCONFIRMED');
  assert.equal(setupValue.budget.signal.aborted, true);
  assert.equal(setupValue.budget.snapshot().completedCaseIds.length, 0);
  assert(setupValue.budget.snapshot().pendingReservedMicroUsd > 0);
  assert(!setupValue.records.some(value => value.type === 'case_completed'));
});

test('reservation persistence failure aborts before the injected runtime emits a response', async () => {
  const setupValue = setup(async () => { throw new Error('fictional-sensitive-backend-error'); });
  const result = await runProviderLoopBaseline({ ...setupValue, runtime: fixtureRuntime() });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'USAGE_RECORD_UNCONFIRMED');
  assert.equal(result.outputChars, 0);
  assert.equal(result.providerFirstDeltaMs, null);
  assert(!JSON.stringify(result).includes('fictional-sensitive-backend-error'));
  assert(setupValue.budget.snapshot().pendingReservedMicroUsd > 0);
});

test('untrusted exception codes/messages cannot appear in metric records', async () => {
  const setupValue = setup();
  const runtime: Pick<PlatformProviderRuntime, 'streamModelStep'> = { async *streamModelStep() {
    throw Object.assign(new Error('fictional-secret-provider-body'), { code: 'fictional-secret-arbitrary-code' });
  } };
  const result = await runProviderLoopBaseline({ ...setupValue, runtime });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'EVAL_BASELINE_FAILED');
  assert(!JSON.stringify(result).includes('fictional-secret'));
});

test('a bound script cannot be swapped or revised while the isolated request is running', async () => {
  const setupValue = setup();
  const mutableItem = structuredClone(setupValue.item);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { started = resolve; });
  let capturedPrompt = '';
  const runtime: Pick<PlatformProviderRuntime, 'streamModelStep'> = { async *streamModelStep(input, context) {
    await context.onModelCall?.({ type: 'started', callId: 'fixture-freeze-call', index: context.callIndex,
      provider: input.provider, model: input.model!, purpose: context.purpose });
    started(); await gate;
    capturedPrompt = input.messages.filter(message => message.role === 'user').at(-1)!.content;
    yield { type: 'delta', text: 'Fictional response.' };
    await context.onModelCall?.({ type: 'finished', callId: 'fixture-freeze-call', status: 'complete',
      usage: { status: 'reported', inputTokens: 10, outputTokens: 10 } });
    return { text: 'Fictional response.', calls: [] };
  } };
  const pending = runProviderLoopBaseline({ ...setupValue, item: mutableItem, runtime });
  await observed;
  const original = mutableItem.prompt;
  (mutableItem as { prompt: string }).prompt = 'Fictional revised input must not replace the frozen script.';
  setupValue.binding.model = 'fictional-other-model';
  release();
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(capturedPrompt, original);
  const wrong = setup(); wrong.binding.caseId = 'fixture-development/wrong-script';
  await assert.rejects(runProviderLoopBaseline({ ...wrong, runtime: fixtureRuntime() }), /EVAL_BASELINE_BINDING_MISMATCH/);
  assert.equal(wrong.budget.snapshot().startedCalls, 0);
});
