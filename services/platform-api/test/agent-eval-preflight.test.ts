import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evalCommand } from '../evals/main.ts';
import { buildEvalPreflight } from '../evals/preflight.ts';

test('dry-run is deterministic, contains no student text and claims no measured result', () => {
  const plan = buildEvalPreflight();
  assert.deepEqual(buildEvalPreflight(), plan);
  assert.equal(plan.mode, 'dry_run');
  assert.equal(plan.providerCalls, 0);
  assert.equal(plan.priceStatus, 'research_only_not_approved');
  assert.equal(plan.approvedBudgetMicroUsd, null);
  assert.equal(plan.spentMicroUsd, null);
  assert.equal(plan.forecastMicroUsd, null);
  assert.equal(plan.pr3EntryGate.status, 'blocked');
  assert(plan.pr3EntryGate.reasons.includes('real_model_study_not_run'));
  assert.match(plan.caseSetDigest, /^[a-f0-9]{64}$/);
  assert.match(plan.priceCandidateDigest, /^[a-f0-9]{64}$/);
  for (const item of plan.cases) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'language', 'pairId', 'speaker', 'turnKind']);
  }
  for (const metric of Object.values(plan.productMetrics)) {
    assert.equal(metric.value, null);
    assert.equal(metric.status, 'blocked');
    assert(metric.reason.length > 0);
  }
});

test('environment cannot activate a live command and arguments are never echoed', () => {
  const previous = process.env.PLATFORM_ALLOW_PROVIDER_CALLS;
  process.env.PLATFORM_ALLOW_PROVIDER_CALLS = '1';
  try {
    assert.equal(evalCommand([]).exitCode, 0);
    assert.equal(evalCommand(['--dry-run']).exitCode, 0);
    for (const args of [['--live'], ['--budget', '20'], ['--dry-run', '--live'], ['fictional-sensitive-argument']]) {
      assert.deepEqual(evalCommand(args), { exitCode: 2, result: { status: 'rejected', code: 'EVAL_DRY_RUN_ONLY' } });
    }
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_ALLOW_PROVIDER_CALLS;
    else process.env.PLATFORM_ALLOW_PROVIDER_CALLS = previous;
  }
});

test('actual CLI entry prints planning JSON even with provider flags set, without leaking keys', () => {
  const cli = fileURLToPath(new URL('../evals/main.ts', import.meta.url));
  const text = execFileSync(process.execPath, ['--import', 'tsx', cli, '--dry-run'], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-eval-secret-never-use' },
  });
  const plan = JSON.parse(text);
  assert.equal(plan.providerCalls, 0);
  assert.equal(plan.liveCommandAvailable, false);
  assert(!text.includes('fictional-eval-secret-never-use'));
  assert(!text.includes('OPENAI_API_KEY'));
  assert(!text.includes('PLATFORM_ALLOW_PROVIDER_CALLS'));
});
