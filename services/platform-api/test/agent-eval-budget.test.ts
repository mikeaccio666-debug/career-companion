import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelCallEvent } from '@companion/platform-contracts';
import { createEvalBudget, estimateMicroUsd, usdPerMillionToMicroUsd, EvalBudgetError, type EvalBudget, type EvalBudgetLedgerEvent, type EvalBudgetOptions, type EvalCaseBinding, type EvalPriceSnapshot } from '../evals/budget.ts';

import { createEvalStudyPlan, studyEntry, type EvalStudyPlan } from '../evals/study-plan.ts';
const study = createEvalStudyPlan();
const CASE_ONE = 'development/companion-01-zh', CASE_TWO = 'development/companion-07-en';
const FULL_ONE = 'development/companion-01-en';

const checkedAt = '2026-10-06T00:00:00.000Z', expiresAt = '2026-10-09T00:00:00.000Z';
const now = () => new Date('2026-10-07T00:00:00.000Z');
const price = (patch: Partial<EvalPriceSnapshot> = {}): EvalPriceSnapshot => ({ id: 'fictional-development-price', provider: 'openai', model: 'fictional-model', tier: 'development',
  sourceUrl: 'https://example.com/fictional-model-pricing', checkedAt, expiresAt, reviewedBy: 'human', approvedConfigId: 'fictional-global-standard-config', tariffProfileId: 'fictional-reviewed-max-tariff',
  maxContextInputTokens: 1_000, maxOutputTokens: 100, inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000, ...patch });
const binding = (caseId: string, patch: Partial<EvalCaseBinding> = {}, plan: EvalStudyPlan = study): EvalCaseBinding => {
  const entry = plan.entries.find(item => item.caseId === caseId) ?? studyEntry(plan, CASE_ONE);
  return { caseId, studyDigest: plan.digest, scriptId: entry.scriptId, scriptDigest: entry.scriptDigest,
    seedInputDigest: entry.seedInputDigest, stage: entry.stage, provider: 'openai', model: 'fictional-model', purpose: entry.purpose,
    priceSnapshotId: 'fictional-development-price', maxOutputTokens: 100, maxModelCalls: 4, ...patch };
};
function setup(patch: Partial<EvalBudgetOptions> = {}) {
  const events: Readonly<EvalBudgetLedgerEvent>[] = [];
  const options: EvalBudgetOptions = { runId: 'fictional-run', study, capMicroUsd: 10_000, prices: [price()], cases: [binding(CASE_ONE), binding(CASE_TWO)], persist: async event => { events.push(event); }, now, ...patch };
  return { budget: createEvalBudget(options), events, options };
}
const started = (callId: string, index = 1, patch: Partial<ModelCallEvent & { type: 'started' }> = {}): ModelCallEvent => ({ type: 'started', callId, index, provider: 'openai', model: 'fictional-model', purpose: 'companion_reply', ...patch });
const finished = (callId: string, inputTokens = 100, outputTokens = 10, status: 'complete' | 'failed' | 'cancelled' | 'interrupted' = 'complete'): ModelCallEvent => ({ type: 'finished', callId, status, usage: { status: 'reported', inputTokens, outputTokens } });
const unknown = (callId: string, status: 'missing' | 'invalid'): ModelCallEvent => ({ type: 'finished', callId, status: 'interrupted', usage: { status } });
async function complete(budget: EvalBudget, caseId: string, callId: string, inputTokens = 100, outputTokens = 10, startPatch: Partial<ModelCallEvent & { type: 'started' }> = {}) {
  const account = budget.accountingFor(caseId); await account(started(callId, 1, { purpose: budget.bindingFor(caseId).purpose, ...startPatch })); await account(finished(callId, inputTokens, outputTokens)); await budget.completeCase(caseId);
}

test('prices and token multiplication use exact integer microUSD with a conservative ceiling', () => {
  assert.equal(usdPerMillionToMicroUsd('0.25'), 250_000);
  assert.equal(usdPerMillionToMicroUsd('5'), 5_000_000);
  assert.equal(usdPerMillionToMicroUsd('0.000001'), 1);
  assert.equal(estimateMicroUsd({ inputMicroUsdPerMillion: 250_000, outputMicroUsdPerMillion: 750_000 }, 1, 1), 1);
  assert.equal(estimateMicroUsd({ inputMicroUsdPerMillion: 250_000, outputMicroUsdPerMillion: 750_000 }, 1_050_000, 1_024), 263_268);
  for (const value of ['0.0000001', '1e-3', '-1', 'NaN', 'Infinity', ' 1', '01']) assert.throws(() => usdPerMillionToMicroUsd(value));
  assert.throws(() => estimateMicroUsd(price(), -1, 0));
  assert.throws(() => estimateMicroUsd(price(), Number.MAX_SAFE_INTEGER, 0));
});
test('decimal prices reject trailing line terminators with a typed error before BigInt conversion', () => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) for (const decimal of ['1', '0.25']) {
    assert.throws(() => usdPerMillionToMicroUsd(decimal + suffix), error => error instanceof EvalBudgetError && error.code === 'EVAL_BUDGET_CONFIG_INVALID');
  }
});
test('identifiers reject every trailing line terminator in configuration and runtime call metadata', async () => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => setup({ runId: 'fictional-run' + suffix }), error => error instanceof EvalBudgetError);
    assert.throws(() => setup({ cases: [binding(CASE_ONE + suffix)] }), error => error instanceof EvalBudgetError);
    for (const field of ['id', 'provider', 'model', 'approvedConfigId', 'tariffProfileId'] as const) {
      assert.throws(() => setup({ prices: [price({ [field]: price()[field] + suffix })] }), error => error instanceof EvalBudgetError);
    }
    const { budget, events } = setup();
    await assert.rejects(budget.accountingFor(CASE_ONE)(started('call-one' + suffix)), error => error instanceof EvalBudgetError && error.code === 'USAGE_RECORD_UNCONFIRMED');
    assert.equal(events.length, 0); assert.equal(budget.signal.aborted, true);
  }
});
test('unknown, stale or unreviewed prices and caps of USD20 or more fail closed before accounting', () => {
  for (const patch of [
    { expiresAt: '2026-10-07T00:00:00.000Z' }, { checkedAt: '2026-10-08T00:00:00.000Z' }, { maxContextInputTokens: 0 },
    { inputMicroUsdPerMillion: NaN }, { outputMicroUsdPerMillion: 0 }, { tariffProfileId: '' }, { approvedConfigId: '' },
    { reviewedBy: 'model' as 'human' }, { sourceUrl: 'https://example.com/?secret=fixture' },
  ]) assert.throws(() => setup({ prices: [price(patch)] }), { code: 'EVAL_PRICE_UNCONFIRMED' });
  assert.throws(() => setup({ capMicroUsd: 20_000_000 }), { code: 'EVAL_BUDGET_CONFIG_INVALID' });
  assert.throws(() => setup({ capMicroUsd: 0 }));
  assert.throws(() => setup({ cases: [binding(CASE_ONE, { maxOutputTokens: 101 })] }));
  assert.throws(() => setup({ cases: [binding(CASE_ONE, { model: 'another-model' })] }));
});
test('HTTP may begin only after full-context reservation is durably persisted, then known usage settles once', async () => {
  let unblock!: () => void, entered!: () => void, httpCalls = 0;
  const enteredPersist = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const records: Readonly<EvalBudgetLedgerEvent>[] = [];
  const { budget } = setup({ persist: async event => { records.push(event); if (event.type === 'started_reserve') { entered(); await gate; } } });
  const account = budget.accountingFor(CASE_ONE);
  const invoking = account(started('call-one')).then(() => { httpCalls++; });
  await enteredPersist;
  assert.equal(httpCalls, 0); assert.equal(budget.snapshot().pendingReservedMicroUsd, 1_200);
  unblock(); await invoking;
  assert.equal(httpCalls, 1);
  await account(finished('call-one'));
  assert.equal(budget.snapshot().pendingReservedMicroUsd, 0); assert.equal(budget.snapshot().actualSpentMicroUsd, 120);
  await account(finished('call-one'));
  assert.equal(records.filter(event => event.type === 'finished_settled').length, 1);
  assert.equal(budget.snapshot().actualSpentMicroUsd, 120);
  assert.ok(records.every(Object.isFrozen));
});
test('actual zero usage is known, while known failed requests still consume their reported cost', async () => {
  const { budget } = setup(), account = budget.accountingFor(CASE_ONE);
  await account(started('call-one')); await account(finished('call-one', 0, 0));
  await account(started('call-two', 2)); await account(finished('call-two', 100, 10, 'failed'));
  assert.equal(budget.snapshot().reportedCalls, 2); assert.equal(budget.snapshot().actualSpentMicroUsd, 120);
  assert.equal(budget.snapshot().pendingReservedMicroUsd, 0);
});
test('known settlements release only confirmed unused reservation so later low-cost calls can run', async () => {
  const { budget } = setup({ capMicroUsd: 1_400, cases: [binding(CASE_ONE, { maxModelCalls: 10 })] }), account = budget.accountingFor(CASE_ONE);
  for (let index = 1; index <= 10; index++) { await account(started(`call-${index}`, index)); await account(finished(`call-${index}`, 10, 0)); }
  assert.equal(budget.snapshot().actualSpentMicroUsd, 100);
  assert.equal(budget.snapshot().status, 'active');
});
test('a later reservation stays queued until the prior confirmed settlement is durable', async () => {
  let release!: () => void, entered!: () => void, secondHttp = 0;
  const enteredSettlement = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const { budget } = setup({ capMicroUsd: 1_400, persist: async event => { if (event.type === 'finished_settled' && event.callId === 'call-one') { entered(); await gate; } } });
  const first = budget.accountingFor(CASE_ONE), second = budget.accountingFor(CASE_TWO);
  await first(started('call-one'));
  const settling = first(finished('call-one')); await enteredSettlement;
  const invoking = second(started('call-two')).then(() => { secondHttp++; });
  assert.equal(secondHttp, 0); assert.equal(budget.snapshot().actualSpentMicroUsd, 0); assert.equal(budget.snapshot().pendingReservedMicroUsd, 1_200);
  release(); await settling; await invoking;
  assert.equal(secondHttp, 1); assert.equal(budget.snapshot().actualSpentMicroUsd, 120); assert.equal(budget.snapshot().pendingReservedMicroUsd, 1_200);
  await second(finished('call-two')); assert.equal(budget.snapshot().committedMicroUsd, 240);
});
test('missing/invalid provider usage keeps the entire reservation and stops every later case without retry', async () => {
  for (const status of ['missing', 'invalid'] as const) {
    const { budget, events } = setup(), account = budget.accountingFor(CASE_ONE);
    await account(started('call-one'));
    await assert.rejects(account(unknown('call-one', status)), { code: 'USAGE_RECORD_UNCONFIRMED' });
    assert.equal(budget.signal.aborted, true); assert.equal(budget.snapshot().pendingReservedMicroUsd, 1_200);
    assert.equal(budget.snapshot().actualSpentMicroUsd, 0); assert.equal(budget.snapshot().uncertainCalls, 1);
    await assert.rejects(budget.accountingFor(CASE_TWO)(started('call-two')), { code: 'USAGE_RECORD_UNCONFIRMED' });
    assert.equal(events.filter(event => event.type === 'started_reserve').length, 1);
    const receipt = events.find(event => event.type === 'finished_uncertain');
    assert.equal(receipt?.type === 'finished_uncertain' && receipt.actualMicroUsd, null);
  }
});
test('bad reported token integers or values above bound are uncertain rather than a clipped or zero bill', async () => {
  for (const [input, output] of [[NaN, 1], [1, -1], [1.5, 1], [1_001, 1], [1, 101]]) {
    const { budget } = setup(), account = budget.accountingFor(CASE_ONE); await account(started('call-one'));
    await assert.rejects(account(finished('call-one', input, output)), { code: 'USAGE_RECORD_UNCONFIRMED' });
    assert.equal(budget.snapshot().pendingReservedMicroUsd, 1_200); assert.equal(budget.snapshot().reportedCalls, 0);
    assert.equal(budget.snapshot().actualSpentMicroUsd, 0);
  }
});
test('reservation or settlement persistence failure aborts the batch and retains uncertainty', async () => {
  for (const failsOn of ['started_reserve', 'finished_settled'] as const) {
    let httpCalls = 0;
    const { budget } = setup({ persist: async event => { if (event.type === failsOn) throw new Error('fictional disk failure'); } }), account = budget.accountingFor(CASE_ONE);
    if (failsOn === 'started_reserve') await assert.rejects(account(started('call-one')).then(() => { httpCalls++; }), { code: 'USAGE_RECORD_UNCONFIRMED' });
    else { await account(started('call-one')); httpCalls++; await assert.rejects(account(finished('call-one')), { code: 'USAGE_RECORD_UNCONFIRMED' }); }
    assert.equal(httpCalls, failsOn === 'started_reserve' ? 0 : 1);
    assert.equal(budget.snapshot().pendingReservedMicroUsd, 1_200); assert.equal(budget.snapshot().actualSpentMicroUsd, 0);
    assert.equal(budget.signal.aborted, true);
    await assert.rejects(budget.accountingFor(CASE_TWO)(started('call-two')));
  }
});
test('clock failure while constructing reserve or settlement metadata preserves uncertainty and locks the batch', async () => {
  for (const failedRead of [3, 5]) for (const failure of ['invalid', 'throw'] as const) {
    let clockReads = 0, httpCalls = 0;
    const { budget, events } = setup({ now: () => {
      clockReads++;
      if (clockReads === failedRead) {
        if (failure === 'throw') throw new Error('fictional clock failure');
        return new Date(NaN);
      }
      return now();
    } });
    const account = budget.accountingFor(CASE_ONE);
    if (failedRead === 3) await assert.rejects(account(started('call-one')).then(() => { httpCalls++; }), error => error instanceof EvalBudgetError && error.code === 'USAGE_RECORD_UNCONFIRMED');
    else { await account(started('call-one')); httpCalls++; await assert.rejects(account(finished('call-one')), error => error instanceof EvalBudgetError && error.code === 'USAGE_RECORD_UNCONFIRMED'); }
    assert.equal(httpCalls, failedRead === 3 ? 0 : 1);
    assert.equal(budget.snapshot().pendingReservedMicroUsd, 1_200); assert.equal(budget.snapshot().actualSpentMicroUsd, 0);
    assert.equal(budget.snapshot().uncertainCalls, 1); assert.equal(budget.signal.aborted, true);
    const writes = events.length;
    await assert.rejects(budget.accountingFor(CASE_TWO)(started('call-two')), { code: 'USAGE_RECORD_UNCONFIRMED' });
    assert.equal(events.length, writes); // A recovered clock still cannot unlock the batch.
  }
});
test('start binding, monotonic indices, duplicate calls, cross-case finishes and single inflight execution are enforced', async () => {
  for (const patch of [{ provider: 'another-provider' }, { model: 'another-model' }, { purpose: 'room_turn' }, { index: 2 }] as Partial<ModelCallEvent & { type: 'started' }>[]) {
    const { budget, events } = setup();
    await assert.rejects(budget.accountingFor(CASE_ONE)(started('call-one', 1, patch)), { code: 'USAGE_RECORD_UNCONFIRMED' });
    assert.equal(events.length, 0);
  }
  const duplicate = setup().budget, duplicateAccount = duplicate.accountingFor(CASE_ONE);
  await duplicateAccount(started('call-one')); await duplicateAccount(finished('call-one'));
  await assert.rejects(duplicateAccount(started('call-one', 2)), { reason: 'duplicate_call' });
  const inflight = setup().budget; await inflight.accountingFor(CASE_ONE)(started('call-one'));
  await assert.rejects(inflight.accountingFor(CASE_TWO)(started('call-two')), { reason: 'inflight_call' });
  assert.equal(inflight.snapshot().pendingReservedMicroUsd, 1_200);
  const crossed = setup().budget; await crossed.accountingFor(CASE_ONE)(started('call-one'));
  await assert.rejects(crossed.accountingFor(CASE_TWO)(finished('call-one')), { reason: 'binding_invalid' });
});
test('exact reservation cap, max calls, stale prices and frozen owner configuration prevent another HTTP', async () => {
  const { budget, options } = setup({ capMicroUsd: 1_200 });
  options.capMicroUsd = 19_000_000;
  const account = budget.accountingFor(CASE_ONE); await account(started('call-one')); await account(finished('call-one'));
  await assert.rejects(account(started('call-two', 2)), { reason: 'budget_limit' });
  assert.equal(budget.snapshot().capMicroUsd, 1_200); assert.equal(budget.snapshot().startedCalls, 1);
  const limited = setup({ cases: [binding(CASE_ONE, { maxModelCalls: 1 })] }).budget;
  await limited.accountingFor(CASE_ONE)(started('call-one')); await limited.accountingFor(CASE_ONE)(finished('call-one'));
  await assert.rejects(limited.accountingFor(CASE_ONE)(started('call-two', 2)), { reason: 'binding_invalid' });
  let clock = now(); const stale = setup({ now: () => clock }).budget;
  clock = new Date(expiresAt);
  await assert.rejects(stale.accountingFor(CASE_ONE)(started('call-one')), { reason: 'price_unconfirmed' });
});
test('cancellation during durable reservation prevents HTTP and keeps the reservation, while signal is immediately propagated', async () => {
  const controller = new AbortController(); let enter!: () => void, release!: () => void, httpCalls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const { budget } = setup({ signal: controller.signal, persist: async event => { if (event.type === 'started_reserve') { enter(); await gate; } } });
  const invoking = budget.accountingFor(CASE_ONE)(started('call-one')).then(() => { httpCalls++; });
  await entered; controller.abort(); assert.equal(budget.signal.aborted, true); release();
  await assert.rejects(invoking, { code: 'USAGE_RECORD_UNCONFIRMED' });
  assert.equal(httpCalls, 0); assert.equal(budget.snapshot().pendingReservedMicroUsd, 1_200); assert.equal(budget.snapshot().status, 'cancelled');
});
test('a price expiring during durable reservation does not permit HTTP under an expired tariff review', async () => {
  let clock = now(), enter!: () => void, release!: () => void, httpCalls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const { budget } = setup({ now: () => clock, persist: async event => { if (event.type === 'started_reserve') { enter(); await gate; } } });
  const invoking = budget.accountingFor(CASE_ONE)(started('call-one')).then(() => { httpCalls++; });
  await entered; clock = new Date(expiresAt); release();
  await assert.rejects(invoking, { reason: 'price_unconfirmed' });
  assert.equal(httpCalls, 0); assert.equal(budget.signal.aborted, true); assert.equal(budget.snapshot().pendingReservedMicroUsd, 1_200);
});

function suite(formalPilot = false, capMicroUsd = 19_000) {
  const plan = createEvalStudyPlan({ formalPilotIds: formalPilot ? ['companion-01-zh', 'companion-07-en'] : [] });
  const development = plan.developmentCaseIds.map(caseId => binding(caseId, {}, plan));
  const formal = plan.formalCaseIds.map(caseId => binding(caseId, {
    model: 'fictional-formal-model', priceSnapshotId: 'fictional-formal-price', maxModelCalls: 1 }, plan));
  const result = setup({ study: plan, capMicroUsd, prices: [price(), price({ id: 'fictional-formal-price', model: 'fictional-formal-model', tier: 'formal', inputMicroUsdPerMillion: 10_000_000, outputMicroUsdPerMillion: 20_000_000 })], cases: [...development, ...formal] });
  return { ...result, request: { fullCaseIds: [...plan.developmentCaseIds], formalCaseIds: [...plan.formalCaseIds] } };
}
async function developmentPilot(budget: EvalBudget) {
  for (const [index, caseId] of budget.study.pilotCaseIds.entries()) await complete(budget, caseId, `development-call-${index}`, 10, 1);
}

test('full/formal stages stay blocked until all 12 pilot cases have completed known usage and a current forecast is approved', async () => {
  const { budget, request } = suite(false, 1_000_000);
  assert.equal(budget.forecast(request).status, 'blocked');
  await developmentPilot(budget);
  const forecast = budget.forecast(request);
  assert.equal(forecast.developmentPilotCases, 12); assert.equal(forecast.developmentTotalMicroUsd, 1_440);
  assert.equal(forecast.formalBasis, 'full_context'); assert.equal(forecast.formalTotalMicroUsd, 240_000);
  assert.equal(forecast.status, 'ready');
  await budget.approveForecast(forecast);
  await complete(budget, FULL_ONE, 'development-call-12', 10, 1);
  assert.equal(budget.snapshot().completedCaseIds.length, 13);
  const blocked = suite().budget;
  await assert.rejects(blocked.accountingFor(FULL_ONE)(started('development-call-12')), { reason: 'stage_blocked' });
});
test('formal forecast uses its own model pilot, never cheap pilot cost, and otherwise blocks costly whole-context formal sampling', async () => {
  const conservative = suite(); await developmentPilot(conservative.budget);
  const forecast = conservative.budget.forecast(conservative.request);
  assert.equal(forecast.formalTotalMicroUsd, 240_000); assert.equal(forecast.status, 'blocked'); assert.ok(forecast.reasons.includes('over_budget'));
  await assert.rejects(conservative.budget.approveForecast(forecast), { code: 'EVAL_STAGE_BLOCKED' });
  const measured = suite(true); await developmentPilot(measured.budget);
  await complete(measured.budget, 'formal/companion-01-zh', 'formal-call-0', 10, 1, { model: 'fictional-formal-model' });
  await complete(measured.budget, 'formal/companion-07-en', 'formal-call-1', 20, 2, { model: 'fictional-formal-model' });
  const own = measured.budget.forecast(measured.request);
  assert.equal(own.formalBasis, 'own_pilot'); assert.equal(own.formalTotalMicroUsd, 3_600);
  assert.equal(own.developmentTotalMicroUsd, 1_440); assert.equal(own.totalEstimatedMicroUsd, 5_040); assert.equal(own.status, 'ready');
  await measured.budget.approveForecast(own);
  await complete(measured.budget, 'formal/companion-05-zh', 'formal-call-2', 10, 1, { model: 'fictional-formal-model' });
});
test('forecast approvals reject forged or stale values, incomplete pilots and invalid suite membership', async () => {
  const { budget, request } = suite(false, 1_000_000);
  const early = budget.forecast(request); await assert.rejects(budget.approveForecast(early), { code: 'EVAL_STAGE_BLOCKED' });
  await developmentPilot(budget);
  const ready = budget.forecast(request); await assert.rejects(budget.approveForecast({ ...ready }), { code: 'EVAL_STAGE_BLOCKED' });
  assert.equal(budget.forecast({ ...request, fullCaseIds: request.fullCaseIds.slice(1) }).status, 'blocked');
  await budget.approveForecast(ready);
  await assert.rejects(budget.approveForecast(ready), { code: 'EVAL_STAGE_BLOCKED' });
  const account = budget.accountingFor(CASE_ONE);
  await assert.rejects(account(started('cannot-replay-completed-case', 2)), { reason: 'binding_invalid' });
  await assert.rejects(budget.approveForecast(ready));
});
test('ledger payloads keep private runtime text and unchecked extra fields out of logging', async () => {
  const { budget, events } = setup(), account = budget.accountingFor(CASE_ONE);
  const sentinel = 'PRIVATE-FICTIONAL-TEXT-KEY-REASONING';
  await account({ ...started('call-one'), content: sentinel, apiKey: sentinel } as unknown as ModelCallEvent);
  await account({ ...finished('call-one'), rawResponse: sentinel } as unknown as ModelCallEvent);
  await budget.completeCase(CASE_ONE);
  assert.equal(JSON.stringify(events).includes(sentinel), false);
  assert.equal(JSON.stringify(budget.snapshot()).includes(sentinel), false);
});

test('budget authority is immutable and binds source, purpose and stage before any reserve', () => {
  const value = setup(), authoritative = value.budget.bindingFor(CASE_ONE);
  assert(Object.isFrozen(authoritative));
  assert.throws(() => { (authoritative as EvalCaseBinding).maxOutputTokens = 4096; }, TypeError);
  value.options.cases[0]!.maxOutputTokens = 4096;
  assert.equal(value.budget.bindingFor(CASE_ONE).maxOutputTokens, 100);
  assert.equal(authoritative.studyDigest, value.budget.study.digest);
  for (const patch of [{ caseId: 'unrelated-case' }, { stage: 'full' }, { purpose: 'expert_consult' },
    { studyDigest: '0'.repeat(64) }, { scriptId: 'companion-02-en' },
    { scriptDigest: '0'.repeat(64) }, { seedInputDigest: '0'.repeat(64) }] as Partial<EvalCaseBinding>[]) {
    assert.throws(() => setup({ cases: [binding(CASE_ONE, patch)] }), { code: 'EVAL_BUDGET_CONFIG_INVALID' });
  }
  assert.throws(() => setup({ study: structuredClone(study) }), { code: 'EVAL_BUDGET_CONFIG_INVALID' });
});

test('same-sized substitutes do not authorize a study forecast', async () => {
  const { budget, request } = suite(false, 1_000_000); await developmentPilot(budget);
  const substituted = { fullCaseIds: [...request.fullCaseIds], formalCaseIds: [...request.formalCaseIds] };
  substituted.formalCaseIds[0] = 'formal/companion-02-en';
  const forecast = budget.forecast(substituted);
  assert.equal(forecast.status, 'blocked'); assert(forecast.reasons.includes('invalid_suite'));
  await assert.rejects(budget.approveForecast(forecast), { code: 'EVAL_STAGE_BLOCKED' });
  assert(!budget.snapshot().completedCaseIds.includes(FULL_ONE));
  assert.equal(budget.forecast(request).status, 'ready');
});

test('durably settled failed, cancelled or interrupted final calls cannot complete a pilot', async () => {
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    const { budget, events } = setup(), account = budget.accountingFor(CASE_ONE);
    await account(started('final-noncomplete')); await account(finished('final-noncomplete', 100, 10, status));
    await assert.rejects(budget.completeCase(CASE_ONE), { reason: 'binding_invalid' });
    assert.equal(budget.snapshot().actualSpentMicroUsd, 120);
    assert.equal(budget.snapshot().completedCaseIds.length, 0);
    assert(!events.some(event => event.type === 'case_completed'));
  }
});

test('a failed earlier retry is charged and a durably complete final retry can complete', async () => {
  const { budget, events } = setup(), account = budget.accountingFor(CASE_ONE);
  await account(started('failed-retry')); await account(finished('failed-retry', 100, 10, 'failed'));
  await account(started('successful-retry', 2)); await account(finished('successful-retry', 100, 10));
  await budget.completeCase(CASE_ONE);
  assert.equal(budget.snapshot().actualSpentMicroUsd, 240);
  assert.deepEqual(budget.snapshot().completedCaseIds, [CASE_ONE]);
  const completion = events.find(event => event.type === 'case_completed');
  assert.equal(completion?.type === 'case_completed' && completion.calls, 2);
  for (const event of events) if ('studyDigest' in event) assert.equal(event.studyDigest, study.digest);
});
