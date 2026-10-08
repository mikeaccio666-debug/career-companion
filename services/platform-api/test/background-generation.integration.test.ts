import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
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
import { CostGuard } from '../src/cost-guard.ts';
import { requireModelConsent } from '../src/model-consent.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';
import { withControlledMissingIntakeSafetySource } from './fixtures/controlled-missing-intake.ts';

// Actual isolated PostgreSQL and the actual ai-core adapter, with every provider
// request redirected to a fictional loopback SSE server. No external model,
// production approval, clinical review or student HTTP route runs in this file.
const base = readConfig(), schema = 'companion_generation_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
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
  for (const [unit, amount] of [['input_token', '1'], ['output_token', '2']]) {
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
  run: (runtime: PlatformProviderRuntime, bodies: Record<string, any>[]) => Promise<void>,
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
  try { await run(runtime, bodies); if (failure) throw failure; }
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

test('actual strict HTTP completion persists one encrypted revision and settles its exact background reservation', async () => {
  await loopback(async (body, reply) => {
    assert.equal(body.model, 'fictional-companion-model'); assert.equal(body.store, false);
    assert.equal(body.tool_choice, 'none'); assert.deepEqual(body.tools, []); assert.equal(body.text.format.strict, true);
    assert(body.max_output_tokens > 0 && body.max_output_tokens <= 1536);
    respond(reply);
  }, async (runtime, bodies) => {
    const { who, draft, prepared } = await ready(runtime), service = generator(runtime);
    assert.equal(await service.read(who, { taskId: prepared.taskId }), null);
    const before = await stored(who); assert.equal(before.calls.length, 0); assert.equal(before.revisions.length, 0); assert.equal(before.reservations.length, 0);
    const view = await service.generate(who, { taskId: prepared.taskId }); assertPrivatePreview(view, prepared.companionId);
    assert.equal(view.summary, validPreview.summary); assert.deepEqual(view.samples, validPreview.samples);
    assert.equal(bodies.length, 1); const current = await stored(who);
    assert.equal(current.companions[0].status, 'awaiting_name'); assert.equal(current.companions[0].current_revision, 1);
    assert.equal(current.tasks[0].status, 'completed'); assert.equal(current.tasks[0].generation, 1);
    assert.equal(current.tasks[0].lease_token, null); assert.equal(current.tasks[0].runtime_lease_id, null);
    assert.equal(current.calls.length, 1); assert.equal(current.revisions.length, 1); assert.equal(current.reservations.length, 1); assert.equal(current.costs.length, 1);
    const call = current.calls[0], reservation = current.reservations[0], cost = current.costs[0];
    assert.equal(call.status, 'complete'); assert.equal(call.usage_status, 'reported'); assert.equal(call.attempt, 1);
    assert.equal(call.purpose, 'companion_generation'); assert.equal(call.model, 'fictional-companion-model');
    assert(call.admitted_at instanceof Date); assert(call.finished_at instanceof Date);
    assert.equal(call.input_tokens, 34); assert.equal(call.output_tokens, 21); assert.equal(call.validation_status, 'passed_rules');
    assert.equal(call.reservation_id, reservation.id); assert.equal(reservation.source_id, prepared.taskId);
    assert.equal(reservation.source_kind, 'job'); assert.equal(reservation.capability, 'background'); assert.equal(reservation.status, 'committed');
    assert.equal(cost.reservation_id, reservation.id); assert.equal(cost.usage_status, 'reported'); assert.equal(cost.cost_micros, '76'); assert.equal(cost.estimated, false);
    assert.equal(current.leases.length, 0); assert.equal(current.blocks.length, 0); assert.deepEqual(current.effects, noConversation);
    assert.deepEqual(current.answers, before.answers);
    const revision = current.revisions[0], saved = payload(revision, who);
    assert.equal(saved.userId, who.userId); assert.equal(saved.companionId, prepared.companionId); assert.equal(saved.taskId, prepared.taskId);
    assert.equal(saved.answersId, before.answers[0].id); assert.equal(saved.sourceDraftId, draft.id); assert.equal(saved.sourceRevision, draft.revision);
    assert.equal(saved.generation, 1); assert.equal(saved.generatedBy, 'model'); assert.equal(saved.policyRevision, 1);
    assert.equal(saved.assurance, 'deterministic_rules_with_heuristic_fact_detection'); assert.deepEqual(saved.callIds, [call.call_id]);
    assert.equal(saved.summary, validPreview.summary); assert.deepEqual(saved.samples, validPreview.samples);
    assert.equal(revision.payload_ciphertext.includes(Buffer.from(validPreview.summary)), false);
    assert.equal(JSON.stringify(current.blocks).includes(validPreview.summary), false);
    assert.equal(JSON.stringify(bodies[0]).includes(who.userId), false);
    assert.equal(JSON.stringify(bodies[0]).includes(prepared.taskId), false);
    assert.deepEqual(await service.read(who, { taskId: prepared.taskId }), view);
    assert.deepEqual(await generator(runtime).generate(who, { taskId: prepared.taskId }), view);
    assert.equal(bodies.length, 1); assert.deepEqual(await stored(who), current);
  });
});

test('concurrent generators cannot double claim, spend or publish the same pending task', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies) => {
    const { who, prepared } = await ready(runtime), first = generator(runtime), second = generator(runtime);
    const outcomes = await Promise.allSettled([first.generate(who, { taskId: prepared.taskId }), second.generate(who, { taskId: prepared.taskId })]);
    const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled'); assert(fulfilled.length >= 1);
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert(outcome.reason instanceof ApiError);
    assert.equal(bodies.length, 1); const current = await stored(who);
    assert.equal(current.tasks[0].generation, 1); assert.equal(current.calls.length, 1); assert.equal(current.revisions.length, 1);
    assert.equal(current.reservations.length, 1); assert.equal(current.costs.length, 1); assert.equal(current.leases.length, 0);
  });
});

test('three actual complete but blocked previews yield a marked deterministic fallback without storing rejected text', async () => {
  const rejected = { ...validPreview, summary: '保证你拿到 offer。Synthetic rejected output.' };
  await loopback((_body, reply) => respond(reply, rejected), async (runtime, bodies) => {
    const { who, prepared } = await ready(runtime), service = generator(runtime);
    const view = await service.generate(who, { taskId: prepared.taskId }); assertPrivatePreview(view, prepared.companionId, 'fallback');
    assert.notEqual(view.summary, rejected.summary); assert.equal(bodies.length, 3);
    const current = await stored(who); assert.equal(current.calls.length, 3); assert.equal(current.costs.length, 3); assert.equal(current.blocks.length, 3);
    assert.deepEqual(current.calls.map(row => row.attempt).sort(), [1, 2, 3]);
    assert(current.calls.every(row => row.status === 'complete' && row.validation_status === 'blocked' && row.admitted_at && row.finished_at));
    assert(current.costs.every(row => row.usage_status === 'reported' && row.cost_micros === '76' && !row.estimated));
    const saved = payload(current.revisions[0], who); assert.equal(saved.generatedBy, 'fallback'); assert.equal(saved.callIds.length, 3);
    assert.deepEqual([...saved.callIds].sort(), current.calls.map(row => row.call_id).sort());
    assert.equal(JSON.stringify(current.blocks).includes(rejected.summary), false);
    assert.equal(JSON.stringify(current.calls).includes(rejected.summary), false);
    assert.equal(JSON.stringify(saved).includes(rejected.summary), false);
    assert.equal(current.leases.length, 0); assert.deepEqual(current.effects, noConversation);
  });
});

test('a blocked first completion can be replaced by a genuinely admitted valid second call', async () => {
  let attempts = 0;
  await loopback((_body, reply) => respond(reply, ++attempts === 1 ? { ...validPreview, summary: 'I am a real person.' } : validPreview), async (runtime, bodies) => {
    const { who, prepared } = await ready(runtime), view = await generator(runtime).generate(who, { taskId: prepared.taskId });
    assertPrivatePreview(view, prepared.companionId); assert.equal(view.summary, validPreview.summary); assert.equal(bodies.length, 2);
    const current = await stored(who); assert.equal(current.calls.length, 2); assert.equal(current.costs.length, 2); assert.equal(current.blocks.length, 1);
    assert.deepEqual(current.calls.map(row => row.validation_status).sort(), ['blocked', 'passed_rules']);
    assert.equal(current.revisions.length, 1); assert.equal(payload(current.revisions[0], who).generatedBy, 'model');
  });
});

test('refusal and upstream errors cannot be counted as completed validation failures or create fallback', async () => {
  for (const mode of ['refusal', 'provider_error'] as const) {
    await loopback((_body, reply) => {
      if (mode === 'refusal') respond(reply, validPreview, { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Fictional refusal.' }] }] });
      else { reply.writeHead(503); reply.end('Fictional private upstream failure.'); }
    }, async (runtime, bodies) => {
      const { who, prepared } = await ready(runtime), service = generator(runtime);
      await assert.rejects(service.generate(who, { taskId: prepared.taskId }), error => error instanceof Error);
      assert.equal(bodies.length, 1); const current = await stored(who);
      assert.equal(current.tasks[0].status, 'failed'); assert.equal(current.revisions.length, 0); assert.equal(current.companions[0].status, 'drafting');
      assert.equal(await service.read(who, { taskId: prepared.taskId }), null);
      assert.equal(current.calls.length, 1); assert.notEqual(current.calls[0].status, 'complete');
      assert.equal(current.calls[0].structured_outcome, null); assert.equal(current.calls[0].validation_status, null);
      assert.equal(current.reservations.length, 1); assert.equal(current.costs.length, 1);
      assert.equal(current.leases.length, 0); assert.deepEqual(current.effects, noConversation);
      const terminal = await stored(who); await assert.rejects(service.generate(who, { taskId: prepared.taskId }), error => error instanceof Error);
      assert.equal(bodies.length, 1); assert.deepEqual(await stored(who), terminal);
    });
  }
});

test('three fully received completed responses with invalid format produce a marked fallback and exact accounting', async () => {
  for (const text of ['{"summary":"Fictional malformed output.', JSON.stringify({ ...validPreview, dimensions: { warmth: 1 } }),
    JSON.stringify({ ...validPreview, samples: [validPreview.samples[0]] }), '']) {
    await loopback((_body, reply) => respond(reply, validPreview, { output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text }] }] }), async (runtime, bodies) => {
      const { who, prepared } = await ready(runtime), service = generator(runtime);
      const view = await service.generate(who, { taskId: prepared.taskId }); assertPrivatePreview(view, prepared.companionId, 'fallback');
      const current = await stored(who); assert.equal(bodies.length, 3); assert.equal(current.calls.length, 3);
      assert(current.calls.every(row => row.status === 'failed' && row.structured_outcome === 'invalid_format'
        && row.validation_status === 'invalid_format' && row.admitted_at instanceof Date && row.finished_at instanceof Date));
      assert.equal(current.costs.length, 3); assert(current.costs.every(row => row.usage_status === 'reported' && row.cost_micros === '76' && !row.estimated));
      assert.equal(current.blocks.length, 3); assert(current.blocks.every(row => JSON.stringify(row.rules) === '["preview.invalid_format"]'));
      assert.equal(current.revisions.length, 1); const saved = payload(current.revisions[0], who);
      assert.equal(saved.generatedBy, 'fallback'); assert.deepEqual([...saved.callIds].sort(), current.calls.map(row => row.call_id).sort());
      for (const value of [JSON.stringify(current.calls), JSON.stringify(current.blocks), JSON.stringify(saved)]) {
        assert.equal(value.includes('Fictional malformed output'), false); assert.equal(value.includes('structuredOutcome'), false);
      }
      assert.equal(current.leases.length, 0); assert.deepEqual(current.effects, noConversation);
      assert.deepEqual(await service.read(who, { taskId: prepared.taskId }), view);
      assert.deepEqual(await generator(runtime).generate(who, { taskId: prepared.taskId }), view);
      assert.equal(bodies.length, 3); assert.deepEqual(await stored(who), current);
    });
  }
});

test('a completed format failure can be followed by a valid model result or combine with rejected content', async () => {
  for (const fallback of [false, true]) {
    let attempt = 0;
    await loopback((_body, reply) => {
      attempt++;
      respond(reply, attempt === 1 ? { ...validPreview, extra: 'Fictional unrequested field.' }
        : fallback ? { ...validPreview, summary: '保证拿到 offer。' } : validPreview);
    }, async (runtime, bodies) => {
      const { who, prepared } = await ready(runtime), service = generator(runtime);
      const view = await service.generate(who, { taskId: prepared.taskId }); assertPrivatePreview(view, prepared.companionId, fallback ? 'fallback' : 'model');
      const current = await stored(who), ordered = [...current.calls].sort((a, b) => a.attempt - b.attempt);
      assert.equal(bodies.length, fallback ? 3 : 2); assert.equal(current.costs.length, bodies.length);
      assert.equal(ordered[0].structured_outcome, 'invalid_format'); assert.equal(ordered[0].validation_status, 'invalid_format');
      assert(ordered.slice(1).every(row => row.status === 'complete' && row.structured_outcome === null
        && row.validation_status === (fallback ? 'blocked' : 'passed_rules')));
      assert.equal(current.revisions.length, 1); assert.equal(payload(current.revisions[0], who).callIds.length, bodies.length);
      assert.equal(current.leases.length, 0); assert.deepEqual(current.effects, noConversation);
    });
  }
});

test('provider self-report, malformed envelopes and post-terminal events cannot supply completed-format proof', async () => {
  for (const mode of ['self_report', 'missing_output', 'incomplete', 'post_terminal', 'transport_cut'] as const) {
    await loopback((_body, reply) => {
      const response = { status: mode === 'incomplete' ? 'incomplete' : 'completed',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{' }] }],
        usage: { input_tokens: 34, output_tokens: 21 }, structuredOutcome: 'invalid_format' };
      if (mode === 'self_report') respond(reply, validPreview, { ...response, error: { code: 'PROVIDER_STRUCTURED_VALIDATION_FAILED' } });
      else if (mode === 'missing_output') respond(reply, validPreview, { ...response, output: undefined });
      else if (mode === 'incomplete') respond(reply, validPreview, response);
      else {
        reply.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.write(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
        if (mode === 'post_terminal') reply.end('data: {"type":"response.output_text.delta","delta":"Fictional late text"}\n\ndata: [DONE]\n\n');
        else setTimeout(() => reply.destroy(), 15);
      }
    }, async (runtime, bodies) => {
      const { who, prepared } = await ready(runtime), service = generator(runtime);
      await assert.rejects(service.generate(who, { taskId: prepared.taskId }), error => error instanceof ApiError);
      const current = await stored(who); assert.equal(bodies.length, 1); assert.equal(current.calls.length, 1);
      assert.equal(current.calls[0].structured_outcome, null); assert.equal(current.calls[0].validation_status, null);
      assert.equal(current.revisions.length, 0); assert.equal(current.blocks.length, 0); assert.equal(current.tasks[0].status, 'failed');
      assert.equal(current.costs.length, 1); assert.equal(current.leases.length, 0); assert.deepEqual(current.effects, noConversation);
      assert.equal(await service.read(who, { taskId: prepared.taskId }), null);
    });
  }
});

test('disabled paid switch and absent dedicated generation model create no preview or fallback', async () => {
  await loopback((_body, _reply) => assert.fail('No actual provider request may start.'), async (runtime, bodies) => {
    const { who, prepared } = await ready(runtime), before = await stored(who);
    for (const env of [{ ...providerEnv, PLATFORM_ALLOW_PROVIDER_CALLS: '0' },
      { ...providerEnv, OPENAI_COMPANION_GENERATION_MODEL: undefined }]) {
      const unavailable = createProviderRuntime({ env, fetch: () => { assert.fail('No provider request is configured.'); } });
      const service = generator(unavailable);
      await assert.rejects(service.generate(who, { taskId: prepared.taskId }), error => error instanceof Error);
      assert.equal(await service.read(who, { taskId: prepared.taskId }), null);
      assert.deepEqual(await stored(who), before);
    }
    assert.equal(bodies.length, 0);
  });
});

test('budget rejection and unavailable prices never create a model or deterministic preview', async () => {
  await loopback((_body, _reply) => assert.fail('No admitted HTTP is authorized.'), async (runtime, bodies) => {
    for (const mode of ['missing_policy', 'hard_limit', 'missing_price', 'soft_limit'] as const) {
      const who = await actor(); if (mode !== 'missing_policy') await policy(who, mode === 'hard_limit' ? '1' : '100000000');
      if (mode === 'soft_limit') {
        // A fictional earlier accounting source is settled through the actual
        // guard. Changing a fresh user's policy alone cannot hit a soft cap.
        const guard = new CostGuard(db);
        const prior = await guard.reserve({ userId: who.userId, sourceKind: 'job', sourceId: randomUUID(), capability: 'background',
          purpose: 'fictional-prior-budget-settlement', provider: 'openai', model: 'fictional-companion-model',
          maxInputTokens: 1, maxOutputTokens: 1, ttlSeconds: 60 });
        assert.equal(prior.decision, 'ok');
        await db.withBoundedTransaction(client => guard.admitInTransaction(client, prior.reservation.binding));
        await guard.commit(prior.reservation.binding, { status: 'reported', inputTokens: 1, outputTokens: 1 });
        await db.query("UPDATE platform_cost_user_policy SET soft_behavior='degrade' WHERE user_id=$1", [who.userId]);
      }
      const { prepared } = await pending(who, runtime), service = generator(runtime);
      const before = await stored(who);
      const originalPrefix = (await db.query('SELECT * FROM platform_companion_source_prefixes WHERE user_id=$1', [who.userId])).rows;
      let price: any;
      if (mode === 'missing_price') {
        price = (await db.query("SELECT * FROM platform_model_prices WHERE unit='output_token'")).rows[0];
        await db.query('UPDATE platform_model_prices SET effective_to=clock_timestamp() WHERE id=$1', [price.id]);
      }
      try {
        await assert.rejects(service.generate(who, { taskId: prepared.taskId }), code('COMPANION_GENERATION_BUDGET_UNAVAILABLE'));
        const current = await stored(who); assert.equal(current.revisions.length, 0);
        assert.deepEqual(current.costs, before.costs); assert.deepEqual(current.reservations, before.reservations);
        if (mode !== 'soft_limit') { assert.equal(current.costs.length, 0); assert.equal(current.reservations.length, 0); }
        assert.equal(current.calls.length, 0); assert.equal(current.leases.length, 0);
        assert.equal(current.tasks[0].status, 'failed'); assert.equal(current.tasks[0].error_code, 'COMPANION_GENERATION_BUDGET_UNAVAILABLE');
        assert.deepEqual(current.tasks[0].seed_ciphertext, before.tasks[0].seed_ciphertext); assert.deepEqual(current.answers, before.answers);
        assert.deepEqual((await db.query('SELECT * FROM platform_companion_source_prefixes WHERE user_id=$1', [who.userId])).rows, originalPrefix);
        assert.equal(await service.read(who, { taskId: prepared.taskId }), null); assert.deepEqual(current.effects, noConversation);
      } finally { if (price) await db.query('UPDATE platform_model_prices SET effective_to=$2 WHERE id=$1', [price.id, price.effective_to]); }
    }
    assert.equal(bodies.length, 0);
  });
});

test('server route cannot silently replace the provider or model authenticated in the accepted seed', async () => {
  await loopback((_body, _reply) => assert.fail('The seed and dispatch route differ.'), async (runtime, bodies) => {
    const { who, prepared } = await ready(runtime), before = await stored(who);
    const changed = { ...runtime, capabilities: () => runtime.capabilities().map(provider => provider.id === 'openai'
      ? { ...provider, modelsByPurpose: { ...provider.modelsByPurpose, companion_generation: ['different-fictional-model'] } } : provider) };
    await assert.rejects(generator(changed).generate(who, { taskId: prepared.taskId }), error => error instanceof Error);
    assert.equal(bodies.length, 0); const current = await stored(who);
    assert.equal(current.revisions.length, 0); assert.equal(current.calls.length, 0); assert.equal(current.reservations.length, 0);
    assert.deepEqual(current.answers, before.answers); assert.equal(current.companions[0].status, 'drafting');
  });
});

test('closed generation/read commands and fixed actual account sessions cannot borrow another pending task', async () => {
  await loopback((_body, _reply) => assert.fail('Rejected commands must not call the provider.'), async (runtime, bodies) => {
    const { who, prepared } = await ready(runtime), other = await actor(), service = generator(runtime), before = await stored(who); let accessed = 0;
    const getter = Object.defineProperty({}, 'taskId', { enumerable: true, get() { accessed++; return prepared.taskId; } });
    for (const value of [null, [], {}, { taskId: 'invented' }, { taskId: prepared.taskId, provider: 'openai' },
      { taskId: prepared.taskId, summary: validPreview.summary }, { taskId: prepared.taskId, userId: other.userId }, getter]) {
      await assert.rejects(service.generate(who, value), error => error instanceof Error);
      await assert.rejects(service.read(who, value), error => error instanceof Error);
    }
    assert.equal(accessed, 0);
    for (const context of [other, { userId: who.userId, tokenHash: other.tokenHash }]) {
      await assert.rejects(service.generate(context, { taskId: prepared.taskId }), error => error instanceof ApiError);
      await assert.rejects(service.read(context, { taskId: prepared.taskId }), error => error instanceof ApiError);
    }
    assert.equal(bodies.length, 0); assert.deepEqual(await stored(who), before);
  });
});

test('real session, account and consent revocation prevent accepting pending generation', async () => {
  await loopback((_body, _reply) => assert.fail('The revoked context must not admit HTTP.'), async (runtime, bodies) => {
    for (const mode of ['revoked_session', 'auth_version', 'expired_session', 'consent', 'unverified', 'staff'] as const) {
      const { who, prepared } = await ready(runtime);
      if (mode === 'revoked_session') await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
      if (mode === 'auth_version') await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
      if (mode === 'expired_session') await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [who.tokenHash]);
      if (mode === 'consent') await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
      if (mode === 'unverified') await db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [who.userId]);
      if (mode === 'staff') await db.query("UPDATE platform_users SET account_kind='staff' WHERE id=$1", [who.userId]);
      const before = await stored(who), service = generator(runtime);
      await assert.rejects(service.generate(who, { taskId: prepared.taskId }), error => error instanceof ApiError);
      await assert.rejects(service.read(who, { taskId: prepared.taskId }), error => error instanceof ApiError);
      assert.deepEqual(await stored(who), before);
    }
    assert.equal(bodies.length, 0);
  });
});

test('authority revoked while genuine HTTP is pending fences preview but preserves the actual expenditure', async () => {
  for (const mode of ['auth_version', 'consent', 'session'] as const) {
    let who!: FixedSessionContext;
    await loopback(async (_body, reply) => {
      // If the request/stream is awaited with account/consent locks held, this
      // actual SQL cannot finish and the success path cannot complete.
      if (mode === 'auth_version') await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
      if (mode === 'consent') await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
      if (mode === 'session') await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
      respond(reply);
    }, async (runtime, bodies) => {
      const fixture = await ready(runtime); who = fixture.who; const service = generator(runtime);
      await assert.rejects(service.generate(who, { taskId: fixture.prepared.taskId }), error => error instanceof Error);
      assert.equal(bodies.length, 1); const current = await stored(who);
      assert.equal(current.revisions.length, 0); assert.equal(current.companions[0].status, 'drafting');
      assert.equal(current.calls.length, 1); assert.equal(current.costs.length, 1);
      assert.equal(current.calls[0].status, 'complete'); assert.equal(current.calls[0].usage_status, 'reported');
      assert.equal(current.costs[0].cost_micros, '76'); assert.equal(current.costs[0].estimated, false); assert.equal(current.leases.length, 0);
    });
  }
});

test('actual fifteen-second admitted HTTP timeout is eligible for an explicitly marked fallback', { timeout: 25_000 }, async () => {
  let closed = false;
  await loopback((_body, reply) => { reply.on('close', () => { closed = true; }); }, async (runtime, bodies) => {
    const { who, prepared } = await ready(runtime), started = performance.now();
    const view = await generator(runtime).generate(who, { taskId: prepared.taskId });
    assertPrivatePreview(view, prepared.companionId, 'fallback'); assert(performance.now() - started >= 14_900);
    assert.equal(bodies.length, 1); const current = await stored(who);
    assert.equal(current.tasks[0].status, 'completed'); assert.equal(current.calls.length, 1); assert(current.calls[0].admitted_at);
    assert.notEqual(current.calls[0].status, 'complete'); assert.equal(current.calls[0].validation_status, 'timed_out');
    assert.equal(current.costs.length, 1); assert.equal(current.costs[0].estimated, true);
    assert(BigInt(current.costs[0].cost_micros) > 0n); assert.equal(current.revisions[0].generated_by, 'fallback');
    assert.equal(current.leases.length, 0);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, true);
  });
});

test('foreign intake, answer and seed ciphertext cannot authorize a pending generation', async () => {
  await loopback(() => assert.fail('Damaged source must not admit HTTP.'), async (runtime, bodies) => {
    const left = await ready(runtime), right = await ready(runtime), original = await stored(right.who), foreign = await stored(left.who);
    const leftDraft = (await db.query('SELECT payload_ciphertext FROM platform_onboarding_drafts WHERE user_id=$1', [left.who.userId])).rows[0];
    const rightDraft = (await db.query('SELECT payload_ciphertext FROM platform_onboarding_drafts WHERE user_id=$1', [right.who.userId])).rows[0];
    const targets = [
      ['platform_onboarding_drafts', 'payload_ciphertext', 'user_id', right.who.userId, leftDraft.payload_ciphertext, rightDraft.payload_ciphertext],
      ['platform_companion_answers', 'payload_ciphertext', 'id', original.answers[0].id, foreign.answers[0].payload_ciphertext, original.answers[0].payload_ciphertext],
      ['platform_companion_generation_tasks', 'seed_ciphertext', 'id', right.prepared.taskId, foreign.tasks[0].seed_ciphertext, original.tasks[0].seed_ciphertext],
    ] as const;
    for (const [table, column, idColumn, id, transplanted, saved] of targets) {
      await db.query(`UPDATE ${table} SET ${column}=$2 WHERE ${idColumn}=$1`, [id, transplanted]);
      const damaged = await stored(right.who);
      try {
        await assert.rejects(generator(runtime).read(right.who, { taskId: right.prepared.taskId }), error => error instanceof ApiError);
        await assert.rejects(generator(runtime).generate(right.who, { taskId: right.prepared.taskId }), error => error instanceof ApiError);
        assert.deepEqual(await stored(right.who), damaged);
      } finally { await db.query(`UPDATE ${table} SET ${column}=$2 WHERE ${idColumn}=$1`, [id, saved]); }
    }
    assert.equal(bodies.length, 0); assert.equal((await stored(right.who)).revisions.length, 0);
  });
});

test('completed replay authenticates revision owner, canonical source and actual terminal cost receipt', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies) => {
    const left = await ready(runtime), right = await ready(runtime), service = generator(runtime);
    await service.generate(left.who, { taskId: left.prepared.taskId });
    const view = await service.generate(right.who, { taskId: right.prepared.taskId });
    const original = await stored(right.who), foreign = await stored(left.who), revision = original.revisions[0], plain = payload(revision, right.who);
    const binding = { table: 'platform_companion_revisions', column: 'payload_ciphertext', rowId: right.prepared.companionId, ownerId: right.who.userId, revision: 1 };
    const counterfeit = { ...plain, sourceRevision: plain.sourceRevision + 1 };
    for (const ciphertext of [foreign.revisions[0].payload_ciphertext, Buffer.alloc(29), crypto.sealUtf8(JSON.stringify(counterfeit), binding)]) {
      await db.query('UPDATE platform_companion_revisions SET payload_ciphertext=$2 WHERE companion_id=$1', [right.prepared.companionId, ciphertext]);
      const damaged = await stored(right.who);
      try {
        await assert.rejects(service.read(right.who, { taskId: right.prepared.taskId }), error => error instanceof ApiError);
        await assert.rejects(service.generate(right.who, { taskId: right.prepared.taskId }), error => error instanceof ApiError);
        assert.deepEqual(await stored(right.who), damaged); assert.equal(bodies.length, 2);
      } finally { await db.query('UPDATE platform_companion_revisions SET payload_ciphertext=$2 WHERE companion_id=$1', [right.prepared.companionId, revision.payload_ciphertext]); }
    }
    await db.query("UPDATE platform_companion_generation_calls SET validation_status='blocked' WHERE call_id=$1", [original.calls[0].call_id]);
    try { await assert.rejects(service.read(right.who, { taskId: right.prepared.taskId }), code('COMPANION_GENERATION_UNAVAILABLE')); }
    finally { await db.query("UPDATE platform_companion_generation_calls SET validation_status='passed_rules' WHERE call_id=$1", [original.calls[0].call_id]); }
    assert.deepEqual(await service.read(right.who, { taskId: right.prepared.taskId }), view);
    await db.query('DELETE FROM platform_cost_ledger WHERE reservation_id=$1', [original.reservations[0].id]);
    const missing = await stored(right.who);
    await assert.rejects(service.read(right.who, { taskId: right.prepared.taskId }), code('COMPANION_GENERATION_UNAVAILABLE'));
    await assert.rejects(service.generate(right.who, { taskId: right.prepared.taskId }), code('COMPANION_GENERATION_UNAVAILABLE'));
    assert.deepEqual(await stored(right.who), missing); assert.equal(bodies.length, 2);
  });
});

test('completed preview remains private after actual consent or account session revocation', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies) => {
    for (const mode of ['consent', 'session'] as const) {
      const { who, prepared } = await ready(runtime), service = generator(runtime);
      await service.generate(who, { taskId: prepared.taskId });
      if (mode === 'consent') await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
      else await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
      const captured = await stored(who);
      await assert.rejects(service.read(who, { taskId: prepared.taskId }), error => error instanceof ApiError);
      await assert.rejects(service.generate(who, { taskId: prepared.taskId }), error => error instanceof ApiError);
      assert.deepEqual(await stored(who), captured);
    }
    assert.equal(bodies.length, 2);
  });
});

test('actual task and runtime lease expiry fence late HTTP completion while preserving expenditure', async () => {
  for (const mode of ['task', 'runtime'] as const) {
    let who!: FixedSessionContext;
    await loopback(async (_body, reply) => {
      if (mode === 'task') await db.query("UPDATE platform_companion_generation_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND status='running'", [who.userId]);
      else await db.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='background'", [who.userId]);
      respond(reply);
    }, async (runtime, bodies) => {
      const fixture = await ready(runtime); who = fixture.who;
      await assert.rejects(generator(runtime).generate(who, { taskId: fixture.prepared.taskId }), code('COMPANION_GENERATION_CANCELLED'));
      const captured = await stored(who);
      assert.equal(bodies.length, 1); assert.equal(captured.calls[0].status, 'complete'); assert.equal(captured.costs[0].cost_micros, '76');
      assert.equal(captured.revisions.length, 0); assert.equal(captured.companions[0].status, 'drafting');
      assert.equal(captured.tasks[0].status, 'failed'); assert.equal(captured.leases.length, 0);
    });
  }
});

test('nonconforming server ports cannot substitute deltas for actual admission and terminal settlement', async () => {
  const available = requireModelConsent(createProviderRuntime({ env: providerEnv, fetch: () => { assert.fail('This counterexample has no HTTP adapter.'); } }));
  for (const mode of ['no_start', 'no_admission', 'unadmitted_format', 'no_finish', 'invented_budget_error'] as const) {
    const who = await actor(); await policy(who); const { prepared } = await pending(who, available);
    const runtime: PlatformProviderRuntime = { ...available, async *streamChat(input, context) {
      if (mode === 'invented_budget_error') throw new ApiError(503, 'COMPANION_GENERATION_BUDGET_UNAVAILABLE', 'An invented provider budget error is not a CostGuard decision.');
      const callId = randomUUID();
      if (mode !== 'no_start') await context!.onModelCall!({ type: 'started', callId, index: 1, provider: input.provider,
        model: input.model!, purpose: 'companion_generation' });
      if (mode === 'no_finish') await context!.requestAdmission!(async signal => { signal.throwIfAborted(); return undefined; }, context!.signal);
      if (mode === 'no_admission') {
        // Swallow the guard's genuine refusal, then maliciously return text.
        await assert.rejects(Promise.resolve(context!.onModelCall!({ type: 'finished', callId, status: 'complete', usage: { status: 'reported', inputTokens: 34, outputTokens: 21 } })), error => error instanceof ApiError);
      }
      if (mode === 'unadmitted_format') {
        await assert.rejects(Promise.resolve(context!.onModelCall!({ type: 'finished', callId, status: 'failed',
          structuredOutcome: 'invalid_format', usage: { status: 'reported', inputTokens: 0, outputTokens: 0 } })), error => error instanceof ApiError);
      }
      yield { type: 'delta', text: JSON.stringify(validPreview) };
    } };
    await assert.rejects(generator(runtime).generate(who, { taskId: prepared.taskId }), code('COMPANION_GENERATION_UNAVAILABLE'));
    const current = await stored(who);
    assert.equal(current.revisions.length, 0); assert.equal(current.costs.length, 0); assert.equal(current.tasks[0].status, 'failed');
    assert.equal(current.companions[0].status, 'drafting'); assert.equal(current.leases.length, 0);
    assert.equal(current.calls.length, mode === 'no_start' || mode === 'invented_budget_error' ? 0 : 1);
    if (mode === 'invented_budget_error') {
      assert.equal(current.tasks[0].error_code, 'COMPANION_GENERATION_UNAVAILABLE'); assert.equal(current.reservations.length, 0);
    }
    if (current.calls.length) {
      assert.notEqual(current.calls[0].status, 'complete'); assert.equal(current.calls[0].finished_at, null);
      assert.equal(current.calls[0].admitted_at !== null, mode === 'no_finish');
      assert(current.reservations[0].dispatch_intent_at instanceof Date);
    }
    assert.equal(await generator(runtime).read(who, { taskId: prepared.taskId }), null);
  }
});

test('lost completed-format evidence cannot be inferred from a legacy failed row when reading a saved fallback', async () => {
  await loopback((_body, reply) => respond(reply, { ...validPreview, extra: true }), async (runtime, bodies) => {
    const { who, prepared } = await ready(runtime), service = generator(runtime);
    const view = await service.generate(who, { taskId: prepared.taskId }); assertPrivatePreview(view, prepared.companionId, 'fallback');
    const current = await stored(who); assert.equal(bodies.length, 3);
    await db.query('UPDATE platform_companion_generation_calls SET structured_outcome=NULL WHERE call_id=$1', [current.calls[0].call_id]);
    const damaged = await stored(who);
    await assert.rejects(service.read(who, { taskId: prepared.taskId }), code('COMPANION_GENERATION_UNAVAILABLE'));
    await assert.rejects(service.generate(who, { taskId: prepared.taskId }), code('COMPANION_GENERATION_UNAVAILABLE'));
    assert.equal(bodies.length, 3); assert.deepEqual(await stored(who), damaged);
  });
});

test('superseded encrypted TEXT and missing safety receipt remain barriers before and after generation', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies) => {
    for (const afterGeneration of [false, true]) {
      const who = await actor(); await policy(who);
      let draft = (await store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'standard' } })).draft;
      const olderId = randomUUID();
      draft = (await store.save(who, { expectedRevision: draft.revision, operationId: olderId,
        action: { kind: 'text', questionId: 'study', text: 'Fictional older coursework note.' } })).draft;
      draft = (await store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(),
        action: { kind: 'text', questionId: 'study', text: 'Fictional current coursework note.' } })).draft;
      const old = await store.claimSafety(who, { detectorRevision: 29 }), current = await store.claimSafety(who, { detectorRevision: 29 });
      assert(old && current); assert.equal(old.operationId, olderId);
      for (const claimed of [current, old]) await store.processSafety(claimed, async (_input, admission) => admission(async signal => {
        signal.throwIfAborted(); return { level: 'L0', mode: 'full', resolution: { kind: 'unmatched' } };
      }));
      draft = (await store.read(who))!;
      while (draft.currentQuestion) draft = (await store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(),
        action: { kind: 'skip', questionId: draft.currentQuestion } })).draft;
      assert.equal(draft.state, 'intake_ready');
      const prepared = await new CompanionDraftPreparation(db, config, FICTIONAL_LEGAL, runtime).prepare(who, { expectedRevision: draft.revision });
      const service = generator(runtime);
      if (afterGeneration) await service.generate(who, { taskId: prepared.taskId });
      const older = (await db.query('SELECT request_ciphertext FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2', [who.userId, olderId])).rows[0];
      await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, olderId, Buffer.alloc(29)]);
      const damaged = await stored(who);
      try {
        await assert.rejects(service.read(who, { taskId: prepared.taskId }), error => error instanceof ApiError);
        await assert.rejects(service.generate(who, { taskId: prepared.taskId }), error => error instanceof ApiError);
        assert.deepEqual(await stored(who), damaged);
      } finally { await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, olderId, older.request_ciphertext]); }
      await withControlledMissingIntakeSafetySource(db, { ownedSchema: schema, userId: who.userId, submissionId: old.submissionId }, async () => {
        const missing = await stored(who);
        await assert.rejects(service.read(who, { taskId: prepared.taskId }), error => error instanceof ApiError);
        await assert.rejects(service.generate(who, { taskId: prepared.taskId }), error => error instanceof ApiError);
        assert.deepEqual(await stored(who), missing);
        // Any proposed backfill rolls back together with the denied operation.
        assert.equal((await db.query('SELECT id FROM platform_onboarding_safety_submissions WHERE operation_id=$1', [olderId])).rowCount, 0);
      });
    }
    assert.equal(bodies.length, 1);
  });
});

test('caller cancellation after actual HTTP launch cannot create either model preview or fallback', async () => {
  const cancelled = new AbortController();
  await loopback((_body, reply) => { cancelled.abort(new DOMException('Fictional user cancellation.', 'AbortError')); respond(reply); }, async (runtime, bodies) => {
    const { who, prepared } = await ready(runtime);
    await assert.rejects(generator(runtime).generate(who, { taskId: prepared.taskId }, cancelled.signal), error => error instanceof Error);
    const current = await stored(who); assert.equal(bodies.length, 1);
    assert.equal(current.revisions.length, 0); assert.equal(current.companions[0].status, 'drafting');
    assert.equal(current.tasks[0].status, 'failed'); assert.equal(current.leases.length, 0);
    assert.equal(current.costs.length, 1); assert(BigInt(current.costs[0].cost_micros) > 0n);
    assert(current.calls[0].admitted_at instanceof Date); assert(current.calls[0].finished_at instanceof Date);
    assert.equal(current.calls[0].validation_status, null); assert.equal(await generator(runtime).read(who, { taskId: prepared.taskId }), null);
  });
});

test('actual deferred PostgreSQL COMMIT failure cannot return a ghost preview and does not undo model accounting', async () => {
  let gateCreated = false;
  try {
    await db.query(`CREATE FUNCTION fictional_reject_preview_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Fictional preview COMMIT rejected'; END $$`); gateCreated = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_preview_commit_gate AFTER INSERT ON platform_companion_revisions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_preview_commit()`);
    await loopback((_body, reply) => respond(reply), async (runtime, bodies) => {
      const { who, prepared } = await ready(runtime), service = generator(runtime);
      await assert.rejects(service.generate(who, { taskId: prepared.taskId }), code('COMPANION_GENERATION_UNAVAILABLE'));
      assert.equal(bodies.length, 1); const current = await stored(who);
      assert.equal(current.revisions.length, 0); assert.equal(current.companions[0].status, 'drafting');
      assert.equal(current.companions[0].current_revision, 0); assert.equal(current.tasks[0].status, 'failed');
      assert.equal(current.tasks[0].lease_token, null); assert.equal(current.leases.length, 0);
      assert.equal(current.calls.length, 1); assert.equal(current.calls[0].status, 'complete');
      assert.equal(current.calls[0].validation_status, 'passed_rules'); assert.equal(current.costs.length, 1);
      assert.equal(current.costs[0].cost_micros, '76'); assert.equal(current.costs[0].estimated, false);
      assert.equal(current.reservations[0].status, 'committed');
      assert.equal(await service.read(who, { taskId: prepared.taskId }), null);
      assert.deepEqual(current.effects, noConversation);
    });
  } finally { if (gateCreated) await db.query('DROP FUNCTION fictional_reject_preview_commit() CASCADE'); }
});

// These hooks only pause at an observed SQL boundary and arrange genuine
// timestamp expiry in the same isolated database. They never replace a query,
// grant, model event, receipt or row count with an invented result.
class QueryGateDatabase extends Database {
  constructor(private readonly gate: (client: PoolClient, text: string, values: unknown) => Promise<void>,
    private readonly observed: (text: string, rowCount: number | null) => void) { super(url.toString()); }
  override withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
    return super.withBoundedTransaction(client => run(new Proxy(client, { get: (target, key) => {
      if (key === 'query') return async (...args: unknown[]) => {
        const text = typeof args[0] === 'string' ? args[0] : '';
        await this.gate(target, text, args[1]);
        const result = await Reflect.apply(target.query, target, args);
        this.observed(text, result.rowCount); return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } })), options);
  }
}

test('a genuinely prepared collision draw is preserved by generation, fallback and completed replay', async () => {
  for (const fallback of [false, true]) {
    await loopback((_body, reply) => respond(reply, fallback ? { ...validPreview, extra: true } : validPreview), async (runtime, bodies) => {
      const who = await actor(), other = await actor(); await policy(who); let lookups = 0;
      const gated = new QueryGateDatabase(async (client, text, input) => {
        if (!text.includes('FROM platform_companions WHERE fingerprint=$1')) return;
        const values = input as string[]; lookups++;
        await client.query("INSERT INTO platform_companions(id,user_id,status,fingerprint) VALUES($1,$2,'drafting',$3)", [randomUUID(), other.userId, values[0]]);
      }, () => {});
      try {
        const { draft, prepared } = await pending(who, runtime, gated), before = await stored(who);
        assert.equal(lookups, 1); assert.equal(before.tasks[0].quirk_draw, 1);
        const dimensions: CompanionDimensions = { warmth: 0, directness: 0, drive: 0, structure: 0, levity: 0, code_mix: 0, length: 'medium' };
        const zero = compileFallbackCompanionStyle({ companionId: prepared.companionId, dimensions });
        const one = compileFallbackCompanionStyle({ companionId: prepared.companionId, dimensions, quirkDraw: 1 });
        const preparer = new CompanionDraftPreparation(gated, config, FICTIONAL_LEGAL, runtime);
        assert.deepEqual(await preparer.prepare(who, { expectedRevision: draft.revision }), prepared); assert.equal(lookups, 1);
        const service = new BackgroundGeneration(gated, config, FICTIONAL_LEGAL, runtime);
        const view = await service.generate(who, { taskId: prepared.taskId }); assertPrivatePreview(view, prepared.companionId, fallback ? 'fallback' : 'model');
        assert.deepEqual(view.quirks, one.quirks); assert.equal(view.styleCard, one.styleCard); assert.equal(view.inkToken, zero.inkToken);
        if (fallback) { assert.equal(view.summary, zero.summary); assert.deepEqual(view.samples, zero.samples); }
        const current = await stored(who); assert.equal(current.tasks[0].quirk_draw, 1);
        assert.equal(bodies.length, fallback ? 3 : 1); assert.equal(current.costs.length, bodies.length);
        assert.deepEqual(await service.read(who, { taskId: prepared.taskId }), view);
        await assert.rejects(preparer.prepare(who, { expectedRevision: draft.revision }), code('COMPANION_EXISTS'));
        assert.equal(lookups, 1); assert.deepEqual(await service.generate(who, { taskId: prepared.taskId }), view);
        assert.deepEqual(await stored(who), current);
      } finally { await gated.close(); }
    });
  }
});

test('a retry rechecks actual prior validation, completion proof and cost binding at dispatch admission', async () => {
  for (const mode of ['validation', 'completion_proof', 'cost_receipt'] as const) {
    await loopback((_body, reply) => respond(reply, { ...validPreview, extra: true }), async (runtime, bodies) => {
      const { who, prepared } = await ready(runtime); let changed = false;
      const gated = new QueryGateDatabase(async (client, text) => {
        if (changed || !text.includes('c.attempt<$4')) return;
        const second = (await client.query('SELECT call_id FROM platform_companion_generation_calls WHERE task_id=$1 AND attempt=2', [prepared.taskId])).rows[0];
        if (!second) return;
        const prior = (await client.query('SELECT * FROM platform_companion_generation_calls WHERE task_id=$1 AND attempt=1', [prepared.taskId])).rows[0];
        assert.equal(prior.structured_outcome, 'invalid_format'); assert.equal(prior.validation_status, 'invalid_format');
        if (mode === 'validation') await client.query('UPDATE platform_companion_generation_calls SET validation_status=NULL WHERE call_id=$1', [prior.call_id]);
        else if (mode === 'completion_proof') await client.query('UPDATE platform_companion_generation_calls SET structured_outcome=NULL WHERE call_id=$1', [prior.call_id]);
        else assert.equal((await client.query('DELETE FROM platform_cost_ledger WHERE reservation_id=$1', [prior.reservation_id])).rowCount, 1);
        changed = true;
      }, () => {});
      try {
        await assert.rejects(new BackgroundGeneration(gated, config, FICTIONAL_LEGAL, runtime).generate(who, { taskId: prepared.taskId }), code('COMPANION_GENERATION_UNAVAILABLE'));
        assert.equal(changed, true); assert.equal(bodies.length, 1);
        const current = await stored(who), ordered = [...current.calls].sort((a, b) => a.attempt - b.attempt);
        assert.equal(ordered.length, 2); assert.equal(ordered[1].admitted_at, null); assert.equal(ordered[1].structured_outcome, null);
        assert.equal(current.costs.length, 1); assert.equal(current.revisions.length, 0); assert.equal(current.leases.length, 0);
        assert.equal(current.tasks[0].status, 'failed'); assert.deepEqual(current.effects, noConversation);
        // The gate's actual SQL mutation rolled back with denied admission.
        assert.equal(ordered[0].structured_outcome, 'invalid_format'); assert.equal(ordered[0].validation_status, 'invalid_format');
      } finally { await gated.close(); }
    });
  }
});

test('final dispatch grant rejects prices or global policy that expire after earlier admission checks', async () => {
  await loopback(() => assert.fail('An expired final money grant must not launch HTTP.'), async (runtime, bodies) => {
    for (const mode of ['price', 'global_policy'] as const) {
      const { who, prepared } = await ready(runtime); let held = false, expired = false, grantRows: number | null | undefined;
      const isGrant = (text: string) => text.startsWith("UPDATE platform_companion_generation_calls c SET status='admitted'");
      const gated = new QueryGateDatabase(async (client, text) => {
        if (!isGrant(text) || held) return; held = true;
        const prior = (await client.query(`SELECT c.status AS call_status,c.admitted_at,r.status AS cost_status,r.dispatch_intent_at
          FROM platform_companion_generation_calls c JOIN platform_cost_reservations r ON r.id=c.reservation_id WHERE c.task_id=$1`, [prepared.taskId])).rows[0];
        assert.equal(prior.call_status, 'prepared'); assert.equal(prior.admitted_at, null);
        assert.equal(prior.cost_status, 'admitted'); assert(prior.dispatch_intent_at instanceof Date);
        if (mode === 'price') await client.query("UPDATE platform_model_prices SET effective_to=clock_timestamp()+interval '50 milliseconds' WHERE provider='openai' AND model='fictional-companion-model' AND unit='output_token'");
        else await client.query("UPDATE platform_cost_global_policy SET effective_to=clock_timestamp()+interval '50 milliseconds' WHERE singleton=true");
        await client.query('SELECT pg_sleep(0.08)');
        const actual = mode === 'price'
          ? await client.query("SELECT effective_to<=clock_timestamp() AS expired FROM platform_model_prices WHERE provider='openai' AND model='fictional-companion-model' AND unit='output_token'")
          : await client.query('SELECT effective_to<=clock_timestamp() AS expired FROM platform_cost_global_policy WHERE singleton=true');
        expired = actual.rows[0].expired; assert.equal(expired, true);
      }, (text, rowCount) => { if (isGrant(text)) grantRows = rowCount; });
      try {
        await assert.rejects(new BackgroundGeneration(gated, config, FICTIONAL_LEGAL, runtime).generate(who, { taskId: prepared.taskId }), code('COMPANION_GENERATION_UNAVAILABLE'));
        assert.equal(held, true); assert.equal(expired, true); assert.equal(grantRows, 0);
        const current = await stored(who); assert.equal(current.calls.length, 1); assert.equal(current.calls[0].admitted_at, null);
        assert.equal(current.costs.length, 0); assert.equal(current.revisions.length, 0); assert.equal(current.leases.length, 0);
        assert.equal(current.tasks[0].status, 'failed'); assert.equal(current.companions[0].status, 'drafting');
      } finally { await gated.close(); }
    }
    assert.equal(bodies.length, 0);
  });
});

test('runtime expiry immediately before final completion CAS rolls back preview while keeping real call settlement', async () => {
  await loopback((_body, reply) => respond(reply), async (runtime, bodies) => {
    const { who, prepared } = await ready(runtime); let held = false, expired = false, completionRows: number | null | undefined;
    const isCompletion = (text: string) => text.startsWith("UPDATE platform_companion_generation_tasks SET status='completed'");
    const gated = new QueryGateDatabase(async (client, text) => {
      if (!isCompletion(text) || held) return; held = true;
      const before = (await client.query(`SELECT t.runtime_lease_id,l.expires_at>clock_timestamp() AS live,
        (SELECT count(*)::int FROM platform_companion_revisions WHERE task_id=t.id) AS captured
        FROM platform_companion_generation_tasks t JOIN platform_runtime_leases l ON l.id=t.runtime_lease_id WHERE t.id=$1`, [prepared.taskId])).rows[0];
      assert.equal(before.live, true); assert.equal(before.captured, 1);
      await client.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()+interval '50 milliseconds' WHERE id=$1", [before.runtime_lease_id]);
      await client.query('SELECT pg_sleep(0.08)');
      expired = (await client.query('SELECT expires_at<=clock_timestamp() AS expired FROM platform_runtime_leases WHERE id=$1', [before.runtime_lease_id])).rows[0].expired;
      assert.equal(expired, true);
    }, (text, rowCount) => { if (isCompletion(text)) completionRows = rowCount; });
    try {
      await assert.rejects(new BackgroundGeneration(gated, config, FICTIONAL_LEGAL, runtime).generate(who, { taskId: prepared.taskId }), code('COMPANION_GENERATION_CANCELLED'));
      assert.equal(held, true); assert.equal(expired, true); assert.equal(completionRows, 0); assert.equal(bodies.length, 1);
      const current = await stored(who); assert.equal(current.revisions.length, 0); assert.equal(current.companions[0].status, 'drafting');
      assert.equal(current.companions[0].current_revision, 0); assert.equal(current.tasks[0].status, 'failed'); assert.equal(current.leases.length, 0);
      assert.equal(current.calls[0].status, 'complete'); assert.equal(current.calls[0].validation_status, 'passed_rules');
      assert.equal(current.costs[0].cost_micros, '76'); assert.equal(current.reservations[0].status, 'committed');
      assert.equal(await generator(runtime).read(who, { taskId: prepared.taskId }), null);
    } finally { await gated.close(); }
  });
});
