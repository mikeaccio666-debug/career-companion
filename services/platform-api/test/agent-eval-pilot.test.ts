import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { createEvalBudget, type EvalCaseBinding, type EvalPriceSnapshot } from '../evals/budget.ts';
import { createEvalStudyPlan } from '../evals/study-plan.ts';
import { runProviderPilot } from '../evals/pilot.ts';
import type { ProviderBaselineResult } from '../evals/probe.ts';

function fixture(options: { missingBinding?: boolean; failAt?: number; missingUsage?: boolean } = {}) {
  const study = createEvalStudyPlan();
  const price: EvalPriceSnapshot = {
    id: 'fictional-price', provider: 'openai', model: 'fictional-model', tier: 'development',
    sourceUrl: 'https://example.org/fictional-price', checkedAt: '2026-10-07T00:00:00Z', expiresAt: '2026-10-09T00:00:00Z',
    reviewedBy: 'human', approvedConfigId: 'fixture-config', tariffProfileId: 'fictional-tariff',
    maxContextInputTokens: 1000, maxOutputTokens: 100,
    inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000,
  };
  const bindings: EvalCaseBinding[] = study.entries.filter(entry => entry.stage === 'pilot').map(entry => ({
    ...entry, studyDigest: study.digest, provider: price.provider, model: price.model,
    priceSnapshotId: price.id, maxOutputTokens: 100, maxModelCalls: 3,
  })).map(({ speaker: _speaker, ...entry }) => entry);
  if (options.missingBinding) bindings.pop();
  const events: string[] = [], results: Readonly<ProviderBaselineResult>[] = [];
  const budget = createEvalBudget({ runId: 'fixture-pilot', study, prices: [price], cases: bindings,
    capMicroUsd: 100_000, now: () => new Date('2026-10-08T00:00:00Z'),
    persist: async event => { events.push(event.type); } });
  let calls = 0;
  const runtime: Pick<PlatformProviderRuntime, 'streamModelStep'> = {
    async *streamModelStep(input, context) {
      const index = ++calls, callId = `fictional-call-${index}`;
      events.push(`request-${index}`);
      if (index > 1) assert(events.includes(`result-${index - 1}`));
      await context.onModelCall?.({ type: 'started', callId, index: context.callIndex,
        provider: input.provider, model: input.model!, purpose: context.purpose });
      yield { type: 'delta', text: 'Fictional private response.' };
      const status = options.failAt === index ? 'failed' : 'complete';
      await context.onModelCall?.({ type: 'finished', callId, status,
        usage: options.missingUsage ? { status: 'missing' } : { status: 'reported', inputTokens: 10, outputTokens: 10 } });
      if (status === 'failed') throw new Error('fictional-secret-provider-error');
      return { text: 'Fictional private response.', calls: [] };
    },
  };
  const persistResult = async (result: Readonly<ProviderBaselineResult>) => {
    results.push(result); events.push(`result-${results.length}`);
  };
  return { budget, runtime, persistResult, events, results, calls: () => calls };
}

test('fixed 12-script pilot persists each result before proceeding and never expands or approves the forecast', async () => {
  const value = fixture();
  const report = await runProviderPilot(value);
  assert.equal(report.status, 'completed'); assert.equal(report.stopReason, null);
  assert.equal(report.completedCases, 12); assert.equal(report.persistedCases, 12);
  assert.equal(value.calls(), 12); assert.equal(report.budget.actualSpentMicroUsd, 360);
  assert.deepEqual(value.results.map(result => result.caseId), [...value.budget.study.pilotCaseIds]);
  assert.equal(value.events.includes('forecast_approved'), false);
  assert.equal(report.productGate, 'not_evaluated'); assert.equal(report.qualityStatus, 'not_scored');
  assert(!JSON.stringify([report, value.results]).includes('Fictional private response'));
  assert(Object.isFrozen(value.results[0])); assert(Object.isFrozen(value.results[0].productMetrics));
  assert(Object.isFrozen(report));
});

test('a missing final binding is rejected before any request or budget write', async () => {
  const value = fixture({ missingBinding: true });
  await assert.rejects(runProviderPilot(value));
  assert.equal(value.calls(), 0); assert.deepEqual(value.events, []);
});

test('a failed probe is persisted and stops the batch even when all usage was reported', async () => {
  const value = fixture({ failAt: 2 });
  const report = await runProviderPilot(value);
  assert.equal(report.status, 'stopped'); assert.equal(report.stopReason, 'probe_failed');
  assert.equal(value.calls(), 2); assert.equal(report.persistedCases, 2); assert.equal(report.completedCases, 1);
  assert.equal(report.budget.actualSpentMicroUsd, 60);
  assert.equal(report.budget.pendingReservedMicroUsd, 0);
  assert(value.budget.signal.aborted);
  assert(!JSON.stringify([report, value.results]).includes('fictional-secret'));
});

test('missing usage retains its reservation and stops after one script', async () => {
  const value = fixture({ missingUsage: true });
  const report = await runProviderPilot(value);
  assert.equal(value.calls(), 1); assert.equal(report.completedCases, 0);
  assert.equal(report.budget.reason, 'usage_missing');
  assert.equal(report.budget.pendingReservedMicroUsd, 1200);
  assert.equal(report.budget.actualSpentMicroUsd, 0);
});

test('result persistence failure stops without refunding settled usage or publishing private exception details', async () => {
  const value = fixture();
  const report = await runProviderPilot({ ...value, persistResult: async () => { throw new Error('fictional-secret-disk-error'); } });
  assert.equal(report.stopReason, 'result_persistence_failed'); assert.equal(value.calls(), 1);
  assert.equal(report.persistedCases, 0); assert.equal(report.completedCases, 0);
  assert.equal(report.budget.actualSpentMicroUsd, 30);
  assert.equal(report.budget.completedCaseIds.length, 1);
  assert(!JSON.stringify(report).includes('fictional-secret'));
  await assert.rejects(runProviderPilot(value), { code: 'EVAL_PILOT_INVALID' });
  assert.equal(value.calls(), 1);
});

test('cancellation before start or during result persistence cannot start the next request', async () => {
  for (const beforeStart of [true, false]) {
    const value = fixture(), controller = new AbortController();
    if (beforeStart) controller.abort();
    const report = await runProviderPilot({ ...value, signal: controller.signal,
      persistResult: async result => { await value.persistResult(result); controller.abort(); } });
    assert.equal(report.stopReason, 'cancelled'); assert.equal(value.calls(), beforeStart ? 0 : 1);
  }
});

test('concurrent or repeat invocation cannot reuse the same budget', async () => {
  const value = fixture();
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { reached = resolve; });
  const first = runProviderPilot({ ...value, persistResult: async result => {
    reached(); await gate; await value.persistResult(result);
  } });
  await observed;
  await assert.rejects(runProviderPilot(value), { code: 'EVAL_PILOT_INVALID' });
  release(); assert.equal((await first).status, 'completed');
  await assert.rejects(runProviderPilot(value), { code: 'EVAL_PILOT_INVALID' });
  assert.equal(value.calls(), 12);
});
