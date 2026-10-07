import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { createEvalBudget, type EvalPriceSnapshot, type EvalCaseBinding, type EvalBudgetLedgerEvent } from '../evals/budget.ts';
import { P0_EVAL_CASES } from '../evals/cases.ts';
import { runProviderLoopBaseline } from '../evals/probe.ts';
import { createEvalStudyPlan, studyEntry } from '../evals/study-plan.ts';

const fixturePrice: EvalPriceSnapshot = {
  id: 'fixture-price', provider: 'openai', model: 'fictional-model', tier: 'development',
  sourceUrl: 'https://example.org/fictional-evaluation-price', checkedAt: '2026-10-07T00:00:00Z',
  expiresAt: '2026-10-08T00:00:00Z', reviewedBy: 'human', approvedConfigId: 'fixture-config',
  tariffProfileId: 'fictional-test-tariff', maxContextInputTokens: 1_050_000, maxOutputTokens: 2048,
  inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000,
};
function setup(persist?: (event: Readonly<EvalBudgetLedgerEvent>) => Promise<void>) {
  const item = P0_EVAL_CASES.find(value => value.speaker === 'companion')!;
  const study = createEvalStudyPlan(), entry = studyEntry(study, 'development/' + item.id);
  const binding: EvalCaseBinding = { caseId: entry.caseId, studyDigest: study.digest, scriptId: entry.scriptId,
    scriptDigest: entry.scriptDigest, seedInputDigest: entry.seedInputDigest, stage: entry.stage,
    provider: 'openai', model: 'fictional-model', purpose: 'companion_reply',
    priceSnapshotId: fixturePrice.id, maxOutputTokens: 2048, maxModelCalls: 3 };
  const records: Readonly<EvalBudgetLedgerEvent>[] = [];
  const budget = createEvalBudget({ runId: 'fixture-probe-run', study, capMicroUsd: 19_000_000,
    prices: [fixturePrice], cases: [binding], now: () => new Date('2026-10-07T01:00:00Z'),
    persist: persist ?? (async event => { records.push(event); }) });
  return { item, binding, budget, records };
}
function fixtureRuntime(usage: 'reported' | 'missing' = 'reported'): Pick<PlatformProviderRuntime, 'streamModelStep'> {
  return { async *streamModelStep(input, context) {
    assert.equal(input.model, 'fictional-model');
    assert.equal(context.toolChoice, 'none');
    assert.deepEqual(context.tools, []);
    assert.equal(context.limits.maxOutputTokens, 2048);
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
  assert.equal(result.baselineFirstDeltaMs, 10);
  assert.equal(result.baselineCompletedMs, 20);
  assert.equal(result.qualityScore, null);
  assert.equal(result.qualityStatus, 'not_scored');
  assert.equal(result.inputScope, 'prompt_only');
  assert.equal(result.toolExecution, 'not_exercised');
  assert.equal(result.timingBasis, 'loop_and_budget_accounting');
  assert.equal(result.studyDigest, setupValue.budget.study.digest);
  assert.equal(result.runId, 'fixture-probe-run');
  assert.equal(result.seedInputDigest, setupValue.budget.bindingFor(result.caseId).seedInputDigest);
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

test('every separately supplied binding change is refused before runtime or reservation', async () => {
  const changes: Partial<EvalCaseBinding>[] = [
    { maxOutputTokens: 4096 }, { maxOutputTokens: 1024 }, { maxModelCalls: 4 }, { maxModelCalls: 1 },
    { provider: 'fictional-other-provider' }, { model: 'fictional-other-model' },
    { stage: 'full' }, { purpose: 'room_turn' }, { priceSnapshotId: 'fictional-other-price' },
    { studyDigest: '0'.repeat(64) }, { scriptId: 'companion-02-en' },
    { scriptDigest: '0'.repeat(64) }, { seedInputDigest: '0'.repeat(64) },
  ];
  for (const change of changes) {
    const value = setup(); let invoked = 0;
    const runtime: Pick<PlatformProviderRuntime, 'streamModelStep'> = { async *streamModelStep() {
      invoked++; throw new Error('must not start');
    } };
    await assert.rejects(runProviderLoopBaseline({ ...value, binding: { ...value.binding, ...change }, runtime }), /EVAL_BASELINE_BINDING_MISMATCH/);
    assert.equal(invoked, 0); assert.equal(value.records.length, 0); assert.equal(value.budget.snapshot().startedCalls, 0);
  }
  const value = setup();
  await assert.rejects(runProviderLoopBaseline({ ...value,
    binding: { ...value.binding, caseId: 'development/companion-02-en' }, runtime: fixtureRuntime() }), { code: 'EVAL_BUDGET_CONFIG_INVALID' });
  assert.equal(value.records.length, 0);
});

test('same-ID revised input and an extra binding field cannot enter an evaluation request', async () => {
  for (const part of ['prompt', 'facts', 'history'] as const) {
    const value = setup(), item = structuredClone(value.item); let invoked = 0;
    if (part === 'prompt') (item as { prompt: string }).prompt += ' Fictional revision';
    else if (part === 'facts') (item.state.facts as string[]).push('Fictional added fact');
    else (item.history as { role: 'user'; content: string }[]).push({ role: 'user', content: 'Fictional added turn' });
    const runtime: Pick<PlatformProviderRuntime, 'streamModelStep'> = { async *streamModelStep() { invoked++; throw new Error('must not start'); } };
    await assert.rejects(runProviderLoopBaseline({ ...value, item, runtime }), { code: 'EVAL_STUDY_INVALID' });
    assert.equal(invoked, 0); assert.equal(value.records.length, 0);
  }
  const value = setup();
  const binding = { ...value.binding, unchecked: 'fictional-extra' };
  await assert.rejects(runProviderLoopBaseline({ ...value, binding, runtime: fixtureRuntime() }), /EVAL_BASELINE_BINDING_MISMATCH/);
});

test('baseline timing honestly includes slow durable accounting, not provider-only latency', async () => {
  let clock = 0;
  const value = setup(async event => {
    if (event.type === 'started_reserve') clock += 250;
    if (event.type === 'finished_settled') clock += 400;
    if (event.type === 'case_completed') clock += 100;
  });
  const result = await runProviderLoopBaseline({ ...value, runtime: fixtureRuntime(), nowMs: () => clock });
  assert.equal(result.status, 'completed');
  assert.equal(result.baselineFirstDeltaMs, 250);
  assert.equal(result.baselineCompletedMs, 750);
  assert.equal(result.timingBasis, 'loop_and_budget_accounting');
  assert.equal(Object.hasOwn(result, 'providerFirstDeltaMs'), false);
  assert.equal(Object.hasOwn(result, 'providerCompletedMs'), false);
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
  assert.equal(result.baselineFirstDeltaMs, null);
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
  const wrong = setup(); wrong.binding.purpose = 'room_turn';
  await assert.rejects(runProviderLoopBaseline({ ...wrong, runtime: fixtureRuntime() }), /EVAL_BASELINE_BINDING_MISMATCH/);
  assert.equal(wrong.budget.snapshot().startedCalls, 0);
});
