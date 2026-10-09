import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import { compileFallbackCompanionStyle, type CompanionDimensions } from '@companion/career-core';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { CompanionDraftPreparation } from '../src/companion-draft-preparation.ts';
import { BackgroundGeneration } from '../src/background-generation.ts';
import { requireModelConsent } from '../src/model-consent.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Actual isolated PostgreSQL and the actual ai-core adapter, with every provider
// request redirected to a fictional loopback SSE server. No external model,
// production approval, clinical review or student HTTP route runs in this file.
const base = readConfig(), schema = 'companion_recovery_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use only loopback PostgreSQL.');
url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: 'c3'.repeat(32) })!;
const config = { dataCrypto: crypto, requireVerifiedEmail: true,
  modelRoutes: { chat: { provider: 'openai' }, companion_generation: { provider: 'openai' } } };
const providerEnv = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-loopback-only',
  OPENAI_CHAT_MODEL: 'fictional-chat-never-generated', OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model' };
const store = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
let created = false;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true;
  await db.migrate(); await seedFictionalActiveLegal(db);
  const approver = await actor(true);
  await db.query(`INSERT INTO platform_cost_global_policy(singleton,month_hard_micros,day_hard_micros,approved_by,approved_at,effective_from)
    VALUES(true,100000000,100000000,$1,clock_timestamp(),clock_timestamp())`, [approver.userId]);
  for (const [unit, amount] of [['input_token', '1'], ['cached_input_token', '1'], ['cache_write_input_token', '1'], ['output_token', '2']]) {
    await db.query(`INSERT INTO platform_model_prices(id,provider,model,capability,unit,micros_per_unit,effective_from)
      VALUES($1,'openai','fictional-companion-model','background',$2,$3,clock_timestamp())`, [randomUUID(), unit, amount]);
  }
});
after(async () => {
  try { await db.close(); }
  finally {
    try {
      if (created) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
      }
    } finally { await admin.close(); }
  }
});
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
async function actor(staff = false): Promise<FixedSessionContext> {
  const userId = randomUUID(), hash = tokenHash(randomUUID());
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional companion owner','fictional-unused-hash',$3,clock_timestamp())`,
  [userId, userId + '@example.invalid', staff ? 'staff' : 'student']);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, hash]);
  await seedFictionalConsent(db, userId); return { userId, tokenHash: hash };
}
async function policy(who: FixedSessionContext, hard = '100000000') {
  const approver = await actor(true);
  await db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,approved_by,approved_at,effective_from)
    VALUES($1,'fictional-explicit-generation-policy','week','notify',1,$2,$3,clock_timestamp(),clock_timestamp())`,
  [who.userId, hard, approver.userId]);
}
async function pending(who: FixedSessionContext, runtime: PlatformProviderRuntime, preparationDatabase: Database = db) {
  let draft = (await store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'fast_track' } })).draft;
  while (draft.currentQuestion) draft = (await store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(),
    action: { kind: 'skip', questionId: draft.currentQuestion } })).draft;
  assert.equal(draft.state, 'intake_ready');
  const prepared = await new CompanionDraftPreparation(preparationDatabase, config, FICTIONAL_LEGAL, runtime)
    .prepare(who, { expectedRevision: draft.revision });
  return { draft, prepared };
}
const validPreview = { summary: '说话简短，先把下一步理清楚。', samples: [
  '可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。',
] };
function respond(reply: http.ServerResponse, value: unknown = validPreview, overrides: Record<string, unknown> = {}) {
  const event = { type: 'response.completed', response: { status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
    usage: { input_tokens: 34, output_tokens: 21 }, ...overrides } };
  reply.writeHead(200, { 'content-type': 'text/event-stream' });
  reply.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
}
async function loopback(handler: (body: Record<string, any>, reply: http.ServerResponse) => void | Promise<void>,
  run: (runtime: PlatformProviderRuntime, bodies: Record<string, any>[], local: string) => Promise<void>,
  env: NodeJS.ProcessEnv = providerEnv) {
  const bodies: Record<string, any>[] = []; let failure: unknown;
  const server = http.createServer(async (request, reply) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); await handler(body, reply);
    } catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const local = `http://127.0.0.1:${address.port}`;
  const runtime = requireModelConsent(createProviderRuntime({ env, fetch: (target, init) => {
    const remote = new URL(String(target)); assert.equal(remote.origin, 'https://api.openai.com');
    assert.equal(remote.pathname, '/v1/responses'); return fetch(local + remote.pathname, init);
  } }));
  try { await run(runtime, bodies, local); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const generator = (runtime: PlatformProviderRuntime) => new BackgroundGeneration(db, config, FICTIONAL_LEGAL, runtime);
async function stored(who: FixedSessionContext) {
  const names = ['platform_companions', 'platform_companion_answers', 'platform_companion_generation_tasks',
    'platform_companion_generation_calls', 'platform_companion_revisions', 'platform_cost_reservations', 'platform_cost_ledger',
    'platform_runtime_leases'] as const;
  const rows = await Promise.all(names.map(table => db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY 1`, [who.userId])));
  const blocked = await db.query(`SELECT b.* FROM platform_companion_output_blocks b JOIN platform_companion_generation_calls c
    ON c.call_id=b.call_id WHERE c.user_id=$1 ORDER BY b.call_id`, [who.userId]);
  const effects = (await db.query(`SELECT
    (SELECT count(*)::int FROM platform_conversations WHERE user_id=$1) AS rooms,
    (SELECT count(*)::int FROM platform_memories WHERE user_id=$1) AS memories,
    (SELECT count(*)::int FROM platform_chat_calls WHERE user_id=$1) AS chat_calls,
    (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS workbench_jobs,
    (SELECT count(*)::int FROM platform_usage WHERE user_id=$1) AS legacy_usage`, [who.userId])).rows[0];
  return { companions: rows[0].rows, answers: rows[1].rows, tasks: rows[2].rows, calls: rows[3].rows,
    revisions: rows[4].rows, reservations: rows[5].rows, costs: rows[6].rows, leases: rows[7].rows, blocks: blocked.rows, effects };
}
const noConversation = { rooms: 0, memories: 0, chat_calls: 0, workbench_jobs: 0, legacy_usage: 0 };
function payload(row: any, who: FixedSessionContext) {
  return JSON.parse(crypto.openUtf8(row.payload_ciphertext, { table: 'platform_companion_revisions', column: 'payload_ciphertext',
    rowId: row.companion_id, ownerId: who.userId, revision: row.revision }));
}
function assertPrivatePreview(view: any, companionId: string, generatedBy = 'model') {
  assert.equal(view.companionId, companionId); assert.equal(view.revision, 1); assert.equal(view.generatedBy, generatedBy);
  assert.equal(typeof view.summary, 'string'); assert.equal(view.samples.length, 3);
  assert(Object.isFrozen(view)); assert(Object.isFrozen(view.samples)); assert(Object.isFrozen(view.quirks));
  for (const key of ['provider', 'model', 'callIds', 'userId', 'answersId', 'rawText', 'leaseToken']) assert.equal(Object.hasOwn(view, key), false);
}
async function ready(runtime: PlatformProviderRuntime) {
  const who = await actor(); await policy(who); return { who, ...await pending(who, runtime) };
}

async function killAt(phase: string, who: FixedSessionContext, taskId: string, local: string, timeoutMs = 10_000) {
  const child = fork(fileURLToPath(new URL('./fixtures/companion-generation-recovery-child.ts', import.meta.url)), [], {
    execArgv: ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/esm/index.mjs', import.meta.url))],
    env: { ...process.env, COMPANION_RECOVERY_TEST_DATABASE_URL: url.toString(),
      COMPANION_RECOVERY_TEST_MODEL_URL: local, COMPANION_RECOVERY_TEST_CRASH_PHASE: phase },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let paused = false, stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs); timer.unref();
  try {
    const stopped = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('message', (event: any) => {
        if (event.type === 'ready') child.send({ context: who, taskId });
        else if (event.type === 'paused') { assert.equal(event.phase, phase); paused = true; child.kill('SIGKILL'); }
        else reject(new Error('The test process did not reach its real crash boundary.'));
      });
      child.on('exit', (_code, signal) => resolve(signal));
    });
    assert(paused, stderr || 'Expected the actual crash boundary.'); assert.equal(stopped, 'SIGKILL');
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
async function expire(who: FixedSessionContext, taskId: string) {
  return db.withBoundedTransaction(async client => {
    await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [who.userId]);
    const row = (await client.query(`UPDATE platform_companion_generation_tasks SET lease_until=clock_timestamp()-interval '1 second'
      WHERE id=$1 AND user_id=$2 AND status='running' RETURNING *`, [taskId, who.userId])).rows[0];
    assert(row); await client.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [row.runtime_lease_id]);
    return row;
  });
}
const disabled = () => requireModelConsent(createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' },
  fetch: () => { throw new Error('Recovery must not call an external provider.'); } }));

test('actual SIGKILL after checkpoint restores the exact preview with no provider configured and no new call', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies, local) => {
    const { who, prepared } = await ready(runtime);
    await killAt('checkpoint', who, prepared.taskId, local);
    const before = await stored(who), checkpoint = (await db.query('SELECT * FROM platform_companion_generation_checkpoints WHERE task_id=$1', [prepared.taskId])).rows[0];
    assert.equal(before.calls.length, 1); assert.equal(before.calls[0].validation_status, 'passed_rules');
    assert.equal(before.revisions.length, 0); assert.equal(before.tasks[0].status, 'running');
    assert(checkpoint.payload_ciphertext instanceof Buffer); assert(!checkpoint.payload_ciphertext.includes(Buffer.from(validPreview.summary)));
    await expire(who, prepared.taskId);
    const service = new BackgroundGeneration(db, { ...config, modelRoutes: {} }, FICTIONAL_LEGAL, disabled());
    const interrupted = await service.readTaskStatus(who, { taskId: prepared.taskId });
    assert.equal(interrupted.leaseExpired, true); assert.equal(interrupted.recovery, 'validated_preview');
    const result = await service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 });
    assert.equal(result.status, 'completed'); assert.equal(result.generation, 1); assert.equal(result.preview?.summary, validPreview.summary);
    assert.deepEqual(result.preview?.samples, validPreview.samples); assert.equal(bodies.length, 1);
    const after = await stored(who); assert.equal(after.calls.length, 1); assert.equal(after.costs.length, 1);
    assert.equal(after.revisions.length, 1); assert.equal(after.leases.length, 0); assert.deepEqual(after.effects, noConversation);
    assert.deepEqual((await db.query('SELECT payload_ciphertext FROM platform_companion_generation_checkpoints WHERE task_id=$1', [prepared.taskId])).rows[0].payload_ciphertext, checkpoint.payload_ciphertext);
    assert.deepEqual((await service.readTaskStatus(who, { taskId: prepared.taskId })).preview, result.preview);
    await assert.rejects(service.recover(who, { taskId: prepared.taskId, expectedGeneration: 0 }), code('COMPANION_GENERATION_CANCELLED'));
  });
});

test('actual death before any durable call safely reclaims the same generation and fences the old token', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies, local) => {
    const { who, prepared } = await ready(runtime); await killAt('no_calls', who, prepared.taskId, local);
    assert.equal(bodies.length, 0); assert.equal((await stored(who)).calls.length, 0);
    const service = generator(runtime);
    const abandoned = await db.withBoundedTransaction(async client => {
      const row = await (service as any).task(client, who, prepared.taskId);
      const seed = await (service as any).seed(client, who, row);
      return { row, seed, generation: row.generation, leaseToken: row.lease_token, runtimeLeaseId: row.runtime_lease_id };
    });
    await expire(who, prepared.taskId);
    await assert.rejects(db.withBoundedTransaction(client => (service as any).renew(client, who, abandoned)), code('COMPANION_GENERATION_CANCELLED'));
    const pending = await service.readTaskStatus(who, { taskId: prepared.taskId }); assert.equal(pending.recovery, 'no_calls');
    const result = await service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 });
    assert.equal(result.status, 'completed'); assert.equal(result.generation, 1); assert.equal(bodies.length, 1);
    await assert.rejects(db.withBoundedTransaction(client => (service as any).renew(client, who, abandoned)), code('COMPANION_GENERATION_CANCELLED'));
    assert.equal((await stored(who)).calls.length, 1);
    const other = await actor(); await assert.rejects(service.readTaskStatus(other, { taskId: prepared.taskId }), code('NOT_FOUND'));
    await assert.rejects(service.readTaskStatus({ ...who, tokenHash: tokenHash(randomUUID()) }, { taskId: prepared.taskId }), code('AUTH_REQUIRED'));
  });
});

test('actual death after committed dispatch risk remains uncertain, reconciles possible cost, and never replays', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies, local) => {
    const { who, prepared } = await ready(runtime); await killAt('dispatch_risk', who, prepared.taskId, local);
    const before = await stored(who); assert.equal(before.calls.length, 1); assert.equal(before.calls[0].status, 'prepared');
    assert(before.reservations[0].dispatch_intent_at instanceof Date); assert.equal(bodies.length, 0);
    await expire(who, prepared.taskId);
    await db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [who.userId]);
    const service = generator(runtime), result = await service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 });
    assert.equal(result.status, 'uncertain'); assert.equal(result.recovery, 'uncertain'); assert.equal(result.preview, undefined);
    const after = await stored(who); assert.equal(after.calls.length, 1); assert.equal(after.calls[0].admitted_at, null);
    assert.equal(after.costs[0].usage_status, 'dispatch_uncertain'); assert.equal(after.costs[0].estimated, true);
    assert.equal(after.costs[0].cost_micros, before.reservations[0].estimate_micros);
    assert.equal(after.reservations[0].status, 'committed'); assert.equal(after.leases.length, 0);
    await service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 }); assert.equal(bodies.length, 0);
  });
});

test('two recovery runners race for one expired no-call generation and admit only one actual request', async () => {
  await loopback(async (_body, reply) => { await new Promise(resolve => setTimeout(resolve, 80)); respond(reply); },
    async (runtime, bodies, local) => {
      const { who, prepared } = await ready(runtime); await killAt('no_calls', who, prepared.taskId, local);
      await expire(who, prepared.taskId);
      const input = { taskId: prepared.taskId, expectedGeneration: 1 };
      const results = await Promise.all([generator(runtime).recover(who, input), generator(runtime).recover(who, input)]);
      assert(results.some(result => result.status === 'completed')); assert.equal(bodies.length, 1);
      const final = await stored(who); assert.equal(final.calls.length, 1); assert.equal(final.costs.length, 1);
      assert.equal(final.tasks[0].generation, 1); assert.equal(final.revisions.length, 1); assert.equal(final.leases.length, 0);
    });
});

test('actual HTTP launch followed by SIGKILL stays uncertain and later reconciles a still-fresh reservation without replay', async () => {
  await loopback((_body, reply) => {
    reply.writeHead(200, { 'content-type': 'text/event-stream' }); reply.flushHeaders();
  }, async (runtime, bodies, local) => {
    const { who, prepared } = await ready(runtime); await killAt('launched', who, prepared.taskId, local);
    const admitted = await stored(who); assert.equal(bodies.length, 1); assert.equal(admitted.calls[0].status, 'admitted');
    assert(admitted.calls[0].admitted_at instanceof Date); assert.equal(admitted.calls[0].finished_at, null);
    assert.equal(admitted.costs.length, 0); await expire(who, prepared.taskId);
    const service = generator(runtime), first = await service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 });
    assert.equal(first.status, 'uncertain'); const pendingCost = await stored(who);
    assert.equal(pendingCost.reservations[0].status, 'admitted'); assert.equal(pendingCost.costs.length, 0);
    await db.query("UPDATE platform_cost_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [who.userId]);
    const second = await service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 });
    assert.equal(second.status, 'uncertain'); assert.equal(second.preview, undefined);
    const reconciled = await stored(who); assert.equal(reconciled.calls[0].status, 'admitted');
    assert.equal(reconciled.calls[0].finished_at, null); assert.equal(reconciled.costs[0].usage_status, 'expired');
    assert.equal(reconciled.costs[0].estimated, true); assert.equal(reconciled.reservations[0].status, 'committed');
    assert.equal(reconciled.costs[0].cost_micros, admitted.reservations[0].estimate_micros); assert.equal(bodies.length, 1);
  });
});

test('actual completed output lost before validation is uncertain rather than regenerated', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies, local) => {
    const { who, prepared } = await ready(runtime); await killAt('unvalidated_output', who, prepared.taskId, local);
    const before = await stored(who); assert.equal(before.calls[0].status, 'complete'); assert.equal(before.calls[0].validation_status, null);
    assert.equal(before.costs[0].estimated, false); await expire(who, prepared.taskId);
    const result = await generator(runtime).recover(who, { taskId: prepared.taskId, expectedGeneration: 1 });
    assert.equal(result.status, 'uncertain'); assert.equal(bodies.length, 1);
    assert.equal((await db.query('SELECT * FROM platform_companion_generation_checkpoints WHERE task_id=$1', [prepared.taskId])).rowCount, 0);
    assert.equal((await stored(who)).revisions.length, 0);
  });
});

test('real terminal invalid output and exact ledger resume only the remaining attempt in the original generation', async () => {
  let index = 0;
  await loopback((_body, reply) => respond(reply, ++index === 1 ? { summary: 'Fictional incomplete output' } : validPreview),
    async (runtime, bodies, local) => {
      const { who, prepared } = await ready(runtime); await killAt('invalid_output', who, prepared.taskId, local);
      const before = await stored(who); assert.equal(before.calls.length, 1);
      assert.equal(before.calls[0].structured_outcome, 'invalid_format'); assert.equal(before.calls[0].validation_status, 'invalid_format');
      await expire(who, prepared.taskId); const service = generator(runtime);
      assert.equal((await service.readTaskStatus(who, { taskId: prepared.taskId })).recovery, 'invalid_outputs');
      const result = await service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 }); assert.equal(result.status, 'completed');
      const after = await stored(who); assert.equal(bodies.length, 2); assert.equal(after.costs.length, 2);
      assert.deepEqual(after.calls.map(row => row.attempt).sort(), [1, 2]); assert(after.calls.every(row => row.generation === 1));
      assert.equal(after.blocks.length, 1); assert.deepEqual(after.effects, noConversation);
    });
});

test('three actual invalid terminal responses recover a marked fallback without an additional provider call', async () => {
  await loopback((_body, reply) => respond(reply, { summary: 'Fictional incomplete output' }), async (runtime, bodies, local) => {
    const { who, prepared } = await ready(runtime); await killAt('checkpoint', who, prepared.taskId, local);
    assert.equal(bodies.length, 3); await expire(who, prepared.taskId);
    const service = new BackgroundGeneration(db, { ...config, modelRoutes: {} }, FICTIONAL_LEGAL, disabled());
    assert.equal((await service.readTaskStatus(who, { taskId: prepared.taskId })).recovery, 'eligible_fallback');
    const result = await service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 });
    assert.equal(result.status, 'completed'); assert.equal(result.preview?.generatedBy, 'fallback'); assert.equal(bodies.length, 3);
    const after = await stored(who); assert.equal(after.costs.length, 3); assert.equal(after.revisions.length, 1);
  });
});

test('checkpoint, source and receipt tampering fail closed instead of publishing or generating', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies, local) => {
    const { who, prepared } = await ready(runtime); await killAt('checkpoint', who, prepared.taskId, local);
    await expire(who, prepared.taskId); const service = generator(runtime);
    const ledger = (await stored(who)).costs[0];
    await db.query('UPDATE platform_cost_ledger SET cost_micros=cost_micros+1 WHERE reservation_id=$1', [ledger.reservation_id]);
    await assert.rejects(service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 }), code('COMPANION_GENERATION_UNAVAILABLE'));
    await db.query('UPDATE platform_cost_ledger SET cost_micros=$2 WHERE reservation_id=$1', [ledger.reservation_id, ledger.cost_micros]);
    const checkpoint = (await db.query('SELECT * FROM platform_companion_generation_checkpoints WHERE task_id=$1', [prepared.taskId])).rows[0];
    const corrupt = Buffer.from(checkpoint.payload_ciphertext); corrupt[corrupt.length - 1] ^= 1;
    await db.query('UPDATE platform_companion_generation_checkpoints SET payload_ciphertext=$2 WHERE task_id=$1', [prepared.taskId, corrupt]);
    await assert.rejects(service.readTaskStatus(who, { taskId: prepared.taskId }), code('COMPANION_GENERATION_UNAVAILABLE'));
    await db.query('UPDATE platform_companion_generation_checkpoints SET payload_ciphertext=$2,source_revision=source_revision+1 WHERE task_id=$1', [prepared.taskId, checkpoint.payload_ciphertext]);
    await assert.rejects(service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 }), code('COMPANION_GENERATION_UNAVAILABLE'));
    assert.equal(bodies.length, 1); assert.equal((await stored(who)).revisions.length, 0);
  });
});

test('revoked legal consent and a real password reset block checkpoint publication while retaining actual expenditure', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies, local) => {
    for (const mode of ['consent', 'reset'] as const) {
      const { who, prepared } = await ready(runtime); await killAt('checkpoint', who, prepared.taskId, local);
      await expire(who, prepared.taskId); const service = generator(runtime);
      if (mode === 'consent') {
        await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
        await assert.rejects(service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 }), code('TERMS_CONFIRMATION_REQUIRED'));
      } else {
        await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
        await assert.rejects(service.recover(who, { taskId: prepared.taskId, expectedGeneration: 1 }), code('AUTH_REQUIRED'));
        const fresh = { userId: who.userId, tokenHash: tokenHash(randomUUID()) };
        await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
          VALUES($1,$2,1,clock_timestamp()+interval '1 hour')`, [fresh.userId, fresh.tokenHash]);
        await assert.rejects(service.recover(fresh, { taskId: prepared.taskId, expectedGeneration: 1 }), code('COMPANION_DRAFT_SOURCE_CHANGED'));
      }
      const unchanged = await stored(who); assert.equal(unchanged.calls.length, 1); assert.equal(unchanged.costs.length, 1);
      assert.equal(unchanged.costs[0].estimated, false); assert.equal(unchanged.revisions.length, 0);
    }
    assert.equal(bodies.length, 2);
  });
});

test('a genuine admitted provider timeout and settled receipt recover its eligible fallback without replay', async () => {
  await loopback((_body, _reply) => {}, async (runtime, bodies, local) => {
    const { who, prepared } = await ready(runtime);
    // The owned child needs the real 15s request deadline to elapse before its
    // fallback publication transaction. It cannot label an arbitrary error timeout.
    await killAt('checkpoint', who, prepared.taskId, local, 25_000);
    const before = await stored(who); assert.equal(before.calls.length, 1);
    assert.equal(before.calls[0].validation_status, 'timed_out'); assert(before.calls[0].admitted_at instanceof Date);
    assert(before.calls[0].finished_at instanceof Date); assert.equal(before.costs.length, 1);
    await expire(who, prepared.taskId);
    const result = await new BackgroundGeneration(db, { ...config, modelRoutes: {} }, FICTIONAL_LEGAL, disabled())
      .recover(who, { taskId: prepared.taskId, expectedGeneration: 1 });
    assert.equal(result.status, 'completed'); assert.equal(result.preview?.generatedBy, 'fallback'); assert.equal(bodies.length, 1);
  });
});

test('the actual heartbeat renews both live scoped leases across multiple real attempts', async () => {
  let who: FixedSessionContext, beforeLease: any, renewedLease: any, index = 0;
  await loopback(async (_body, reply) => {
    if (++index === 1) {
      beforeLease = (await db.query(`SELECT t.lease_until,l.expires_at,t.lease_token FROM platform_companion_generation_tasks t
        JOIN platform_runtime_leases l ON l.id=t.runtime_lease_id WHERE t.user_id=$1`, [who.userId])).rows[0];
      await new Promise(resolve => setTimeout(resolve, 12_000)); respond(reply, { summary: 'Fictional incomplete output' });
    } else {
      await new Promise(resolve => setTimeout(resolve, 4_200));
      renewedLease = (await db.query(`SELECT t.lease_until,l.expires_at,t.lease_token FROM platform_companion_generation_tasks t
        JOIN platform_runtime_leases l ON l.id=t.runtime_lease_id WHERE t.user_id=$1`, [who.userId])).rows[0];
      respond(reply);
    }
  }, async (runtime, bodies) => {
    const prepared = await ready(runtime); who = prepared.who;
    await generator(runtime).generate(who, { taskId: prepared.prepared.taskId });
    assert.equal(bodies.length, 2); assert.equal(renewedLease.lease_token, beforeLease.lease_token);
    assert(renewedLease.lease_until.getTime() > beforeLease.lease_until.getTime() + 10_000);
    assert(renewedLease.expires_at.getTime() > beforeLease.expires_at.getTime() + 10_000);
    assert.equal((await stored(who)).leases.length, 0);
  });
});
