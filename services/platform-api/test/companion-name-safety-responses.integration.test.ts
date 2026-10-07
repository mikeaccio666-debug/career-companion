import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import { parseOnboardingDraft } from '@companion/career-core';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { CompanionNameSafetyRunner } from '../src/companion-name-safety-runner.ts';
import { CompanionNameSafetyResponses } from '../src/companion-name-safety-responses.ts';
import { expectedSafetyProfileDigests, parseSafetyDetectorProfile } from '../src/safety-detector-profile.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { fictionalBundle } from './fixtures/onboarding-followup.ts';

// Isolated real PostgreSQL and real raw-name/claim/classification paths.
// All model HTTP terminates at an owned loopback server. Assets, people,
// contacts and review metadata are fictional, never production approval.
type Fixture = Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
type Ready = Awaited<ReturnType<Fixture['ready']>>;
let fixture: Fixture;
const profileContent = { schemaVersion: 1, revision: 94,
  instructions: 'Synthetic name-resource QA only, never clinical review.',
  algorithm: 'literal_substring_v1', lexicon: [
    { id: 'synthetic-low-en', language: 'en', level: 'L1', phrases: ['Fictional low marker'] },
    { id: 'synthetic-low-zh', language: 'zh', level: 'L1', phrases: ['虚构资源低风险标记'] },
    { id: 'synthetic-high-en', language: 'en', level: 'L2', phrases: ['Fictional high marker'] },
    { id: 'synthetic-high-zh', language: 'zh', level: 'L2', phrases: ['虚构资源高风险标记'] },
  ], mergeRule: 'highest_level', fallbackNoHit: 'unavailable',
  review: { reference: 'fictional-name-resource-test-not-professional-approval', approvedAt: '2026-10-07T00:00:00.000Z' } };
const profile = parseSafetyDetectorProfile({ ...profileContent, ...expectedSafetyProfileDigests(profileContent) });
const providerEnv = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-loopback-only',
  OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model', OPENAI_SAFETY_CLASSIFY_MODEL: 'fictional-resource-classifier' };
const preview = { summary: '先把事情理清楚，再选一个小行动。',
  samples: ['可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。'] };
const bundle = fictionalBundle();
const responseTables = ['platform_companion_name_safety_responses', 'platform_safety_events'] as const;
const immutableTables = ['platform_onboarding_drafts', 'platform_onboarding_operations', 'platform_onboarding_safety_submissions',
  'platform_onboarding_safety_responses', 'platform_onboarding_safety_publications', 'platform_onboarding_safety_followups',
  'platform_companion_answers', 'platform_companion_generation_tasks', 'platform_companion_source_prefixes',
  'platform_companion_generation_calls', 'platform_companion_generation_checkpoints', 'platform_companion_revisions',
  'platform_companion_name_entries', 'platform_companion_name_submissions', 'platform_companion_identity_drafts',
  'platform_companion_identity_operations', 'platform_companion_identity_selections', 'platform_companion_name_identity_receipts',
  'platform_companion_name_identity_provenance', 'platform_safety_model_usage', 'platform_cost_reservations',
  'platform_cost_ledger', 'platform_conversations', 'platform_memories', 'platform_jobs'] as const;
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503;

before(async () => {
  fixture = await createCompanionNameSafetyFixture();
  const operator = await fixture.actor(true);
  await fixture.db.query(`INSERT INTO platform_safety_detector_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4)`, [profile.revision, profile.digest, profile.reviewDigest, operator.userId]);
  await activate();
});
after(async () => { if (fixture) await fixture.close(); });
beforeEach(async () => { await activate(); });

async function activate(next = bundle) {
  const operator = await fixture.actor(true);
  await fixture.db.query(`INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,
    content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by`,
  [next.revision, next.contentDigest, next.reviewDigest, operator.userId]);
}
function responses(selected: typeof bundle | null = bundle) {
  return new CompanionNameSafetyResponses(fixture.db, fixture.config, selected);
}
async function loopback(run: (runtime: PlatformProviderRuntime, bodies: Record<string, any>[]) => Promise<void>, level: 'L0' | 'L1' | 'L2' = 'L0') {
  const bodies: Record<string, any>[] = []; let failure: unknown;
  const server = http.createServer(async (request, reply) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks: Buffer[] = []; for await (const part of request) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
      assert.equal(body.store, false); assert.equal(body.tool_choice, 'none'); assert.deepEqual(body.tools, []);
      assert.equal(body.text.format.strict, true);
      const value = body.model === providerEnv.OPENAI_COMPANION_GENERATION_MODEL ? preview : { level };
      assert([providerEnv.OPENAI_COMPANION_GENERATION_MODEL, providerEnv.OPENAI_SAFETY_CLASSIFY_MODEL].includes(body.model));
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
        usage: { input_tokens: 34, output_tokens: 21 } } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const runtime = createProviderRuntime({ env: providerEnv, fetch: (target, init) => {
    const remote = new URL(String(target)); assert.equal(remote.origin, 'https://api.openai.com'); assert.equal(remote.pathname, '/v1/responses');
    return fetch(`http://127.0.0.1:${address.port}${remote.pathname}`, init);
  } });
  try { await run(runtime, bodies); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function disabled() {
  return createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: async () => assert.fail('Fixed resources cannot call a model.') });
}
async function classified(f: Ready, runtime: PlatformProviderRuntime, raw = 'Fictional high marker', model = false) {
  const accepted = await f.safety.submit(f.who, { taskId: f.prepared.taskId, operationId: randomUUID(), name: raw,
    expectedEntryRevision: 0, expectedIdentityRevision: 0 });
  const runner = new CompanionNameSafetyRunner(f.safety, { modelRoutes: { safety_classify: { provider: 'openai' } }, safetyDailyModelCallLimit: 100 },
    model ? runtime : disabled(), profile);
  await runner.runSubmission(f.who, { taskId: f.prepared.taskId, submissionId: accepted.submissionId });
  return accepted.submissionId;
}
async function snapshot(who: FixedSessionContext, includeResponses = true) {
  const tables = includeResponses ? [...immutableTables, ...responseTables] : immutableTables;
  return Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await fixture.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY to_jsonb(${table})::text`, [who.userId])).rows])));
}
async function newSession(who: FixedSessionContext) {
  const hash = tokenHash(randomUUID());
  await fixture.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
  await fixture.db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    SELECT id,$2,auth_version,clock_timestamp()+interval '1 hour' FROM platform_users WHERE id=$1`, [who.userId, hash]);
  return { userId: who.userId, tokenHash: hash };
}
async function responseRow(id: string) {
  return (await fixture.db.query('SELECT * FROM platform_companion_name_safety_responses WHERE submission_id=$1', [id])).rows[0];
}
async function standardReady(runtime: PlatformProviderRuntime, language?: 'en') {
  const who = await fixture.actor();
  let draft = (await fixture.store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'standard' } })).draft;
  while (draft.step === 'O2') {
    assert(draft.currentQuestion);
    draft = (await fixture.store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(),
      action: draft.currentQuestion === 'emotion_language' && language ? { kind: 'answer', questionId: 'emotion_language', value: language }
        : { kind: 'skip', questionId: draft.currentQuestion } })).draft;
  }
  draft = (await fixture.store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(), action: { kind: 'skip_remaining' } })).draft;
  draft = (await fixture.store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(), action: { kind: 'skip', questionId: 'extra' } })).draft;
  assert.equal(draft.state, 'intake_ready'); return fixture.ready(runtime, { who });
}
function assertBodyOnly(value: unknown, text: string) {
  const encoded = JSON.stringify(value); assert(encoded.includes(text));
  for (const key of ['question', 'reviewRef', 'claim', 'leaseToken', 'executionToken', 'previewCapture', 'answers'])
    assert(!new RegExp(`"${key}"\\s*:`).test(encoded), `A body observation must not expose ${key}.`);
}
const rollback = new Error('Synthetic target resource mutation rolled back.');
async function rejectsMutation(action: () => Promise<unknown>, mutate: (client: PoolClient) => Promise<unknown>) {
  const original = fixture.db.withBoundedTransaction;
  fixture.db.withBoundedTransaction = function<T>(run: (client: PoolClient) => Promise<T>, options = {}) {
    return original.call(fixture.db, async client => {
      await mutate(client); await assert.rejects(run(client), unavailable); throw rollback;
    }, options) as Promise<T>;
  };
  try { await assert.rejects(action(), error => error === rollback); }
  finally { fixture.db.withBoundedTransaction = original; }
}

test('real L2 keyword completion enqueues a pending reference; one fixed capture and body read grant no display or execution authority', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime), api = responses();
    const pending = await responseRow(id); assert(pending); assert.equal(pending.status, 'pending');
    assert.equal(pending.level, 'L2'); assert.equal(pending.detector_mode, 'keyword_only');
    assert.equal(pending.payload_ciphertext, null);
    assert.equal((await fixture.db.query('SELECT * FROM platform_safety_events WHERE user_id=$1', [f.who.userId])).rowCount, 0);
    const original = await snapshot(f.who, false);
    const prepared = await api.prepareSubmission(id); assert(prepared); assert.equal(prepared.status, 'ready');
    const ready = await responseRow(id); assert(Buffer.isBuffer(ready.payload_ciphertext));
    const view = await api.readBody(f.who, { submissionId: id }); assert(view); assert.equal(view.status, 'ready');
    assertBodyOnly(view, '虚构 L2');
    assert.deepEqual(await snapshot(f.who, false), original);
    const events = (await fixture.db.query('SELECT * FROM platform_safety_events WHERE user_id=$1', [f.who.userId])).rows;
    assert.equal(events.length, 1); assert.equal(events[0].source_kind, 'companion_name'); assert.equal(events[0].event_kind, 'response_prepared');
    assert.equal(events[0].name_submission_id, id); assert.equal(events[0].submission_id, null); assert.equal(events[0].response_id, null);
    assert.equal((await fixture.db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1', [f.who.userId])).rowCount, 0);
    const beforeReplay = await snapshot(f.who);
    const replay = await api.prepareSubmission(id); assert(replay); assert.equal(replay.replayed, true);
    assert.deepEqual(await api.readBody(f.who, { submissionId: id }), view);
    assert.deepEqual(await snapshot(f.who), beforeReplay); assert.equal(bodies.length, 1);
  });
});

test('genuine full L0 and unavailable raw names produce no fixed resource, classification or identity backfill', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), l0 = await classified(f, runtime, 'Juno', true), api = responses();
    const before = await snapshot(f.who);
    assert.equal(await api.recoverSubmission(l0), null); assert.equal(await api.prepareSubmission(l0), null);
    assert.equal(await api.readBody(f.who, { submissionId: l0 }), null);
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 2);
    const pending = await f.safety.submit(f.who, { taskId: f.prepared.taskId, operationId: randomUUID(), name: '舟',
      expectedEntryRevision: 1, expectedIdentityRevision: 0 });
    const snapshotPending = await snapshot(f.who);
    await assert.rejects(api.recoverSubmission(pending.submissionId), unavailable);
    await assert.rejects(api.prepareSubmission(pending.submissionId), unavailable);
    assert.deepEqual(await snapshot(f.who), snapshotPending);
    assert.equal((await fixture.db.query('SELECT * FROM platform_companion_name_safety_responses WHERE user_id=$1', [f.who.userId])).rowCount, 0);
  });
});

test('a real L1 keyword fallback captures only the reviewed L1 body and contact without a safety model request', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime, 'Fictional low marker'), api = responses();
    await api.prepareSubmission(id);
    const view = await api.readBody(f.who, { submissionId: id }); assert(view); assert.equal(view.status, 'ready');
    assert.equal(view.level, 'L1'); assert.equal(view.mode, 'keyword_only'); assertBodyOnly(view, '虚构 L1');
    assert(view.status === 'ready'); assert.equal(view.body.resourceCard.contacts.length, 1);
    assert.equal((await fixture.db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1', [f.who.userId])).rowCount, 0);
    assert.equal(bodies.length, 1);
  });
});

test('missing or inactive reviewed assets leave the actual pending reference unchanged and ready captures survive later configuration loss', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime), before = await snapshot(f.who);
    await assert.rejects(responses(null).prepareSubmission(id), code('COMPANION_NAME_SAFETY_RESPONSE_UNAVAILABLE'));
    const pending = await responses(null).readBody(f.who, { submissionId: id }); assert(pending); assert.equal(pending.status, 'pending');
    assert.deepEqual(await snapshot(f.who), before);
    await fixture.db.query('DELETE FROM platform_safety_response_policy');
    await assert.rejects(responses().prepareSubmission(id), code('COMPANION_NAME_SAFETY_RESPONSE_UNAVAILABLE'));
    assert.deepEqual(await snapshot(f.who), before);
    await activate(); await responses().prepareSubmission(id);
    const ready = await responses().readBody(f.who, { submissionId: id }), captured = await snapshot(f.who);
    await fixture.db.query('DELETE FROM platform_safety_response_policy');
    const replay = await responses(null).prepareSubmission(id); assert(replay); assert.equal(replay.replayed, true);
    assert.deepEqual(await responses(null).readBody(f.who, { submissionId: id }), ready);
    assert.deepEqual(await snapshot(f.who), captured); assert.equal(bodies.length, 1);
    await activate();
  });
});

test('concurrent preparation commits one immutable capture and event; a new bundle does not redraw the saved body', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime), api = responses();
    const prepared = await Promise.all([api.prepareSubmission(id), api.prepareSubmission(id)]);
    assert(prepared[0] && prepared[1]); assert.equal(prepared[0].responseId, prepared[1].responseId);
    assert.deepEqual(prepared.map(result => result!.replayed).sort(), [false, true]);
    const saved = await api.readBody(f.who, { submissionId: id }), before = await snapshot(f.who);
    const next = fictionalBundle(8); await activate(next);
    assert.deepEqual(await responses(next).readBody(f.who, { submissionId: id }), saved);
    const replay = await responses(next).prepareSubmission(id); assert(replay); assert.equal(replay.replayed, true);
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 1);
    await activate();
  });
});

test('fresh real session restores the body despite new terms, unverified email and exhausted budgets; revoked and foreign viewers cannot read it', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime), api = responses(); await api.prepareSubmission(id);
    const body = await api.readBody(f.who, { submissionId: id }), current = await newSession(f.who), other = await fixture.actor(), staff = await fixture.actor(true);
    await fixture.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [f.who.userId]);
    await fixture.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [f.who.userId]);
    await fixture.db.query('UPDATE platform_cost_user_policy SET hard_micros=1,soft_micros=1 WHERE user_id=$1', [f.who.userId]);
    const before = await snapshot(f.who);
    await assert.rejects(api.readBody(f.who, { submissionId: id }), code('AUTH_REQUIRED'));
    await assert.rejects(api.readBody(other, { submissionId: id }), code('NOT_FOUND'));
    await assert.rejects(api.readBody(staff, { submissionId: id }), code('STUDENT_ACCOUNT_REQUIRED'));
    assert.deepEqual(await api.readBody(current, { submissionId: id }), body);
    assert.deepEqual(await snapshot(f.who), before);
    await assert.rejects(f.safety.submit(current, { taskId: f.prepared.taskId, operationId: randomUUID(), name: '舟',
      expectedEntryRevision: 1, expectedIdentityRevision: 0 }), code('EMAIL_VERIFICATION_REQUIRED'));
    await fixture.db.query('UPDATE platform_users SET email_verified_at=clock_timestamp() WHERE id=$1', [f.who.userId]);
    await assert.rejects(f.safety.submit(current, { taskId: f.prepared.taskId, operationId: randomUUID(), name: '舟',
      expectedEntryRevision: 1, expectedIdentityRevision: 0 }), code('TERMS_CONFIRMATION_REQUIRED'));
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 1);
  });
});

test('corrupt own source, capture or prepared event fails closed instead of repairing the body', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime), api = responses(); await api.prepareSubmission(id);
    const ready = await responseRow(id), before = await snapshot(f.who);
    for (const column of ['request_ciphertext', 'claim_ciphertext', 'result_ciphertext']) {
      const source = (await fixture.db.query(`SELECT ${column} FROM platform_companion_name_submissions WHERE id=$1`, [id])).rows[0];
      const damaged = Buffer.from(source[column]); damaged[0] ^= 1;
      await rejectsMutation(() => api.readBody(f.who, { submissionId: id }), client =>
        client.query(`UPDATE platform_companion_name_submissions SET ${column}=$2 WHERE id=$1`, [id, damaged]));
    }
    const damaged = Buffer.from(ready.payload_ciphertext); damaged[0] ^= 1;
    for (const action of [() => api.readBody(f.who, { submissionId: id }), () => api.prepareSubmission(id)]) {
      await rejectsMutation(action, client => client.query('UPDATE platform_companion_name_safety_responses SET payload_ciphertext=$2 WHERE id=$1', [ready.id, damaged]));
      await rejectsMutation(action, client => client.query('DELETE FROM platform_safety_events WHERE name_response_id=$1', [ready.id]));
      await rejectsMutation(action, client => client.query("UPDATE platform_safety_events SET retention_until=retention_until+interval '1 second' WHERE name_response_id=$1", [ready.id]));
    }
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 1);
  });
});

test('a genuine full L1 model receipt remains required for resource recovery, and changed usage cannot become keyword-only proof', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime, 'Juno', true), api = responses(); await api.prepareSubmission(id);
    const view = await api.readBody(f.who, { submissionId: id }); assert(view); assert.equal(view.mode, 'full'); assert.equal(view.level, 'L1');
    const before = await snapshot(f.who);
    for (const mutate of [
      (client: PoolClient) => client.query("UPDATE platform_safety_model_usage SET model='fictional-wrong-model' WHERE submission_id=$1", [id]),
      (client: PoolClient) => client.query('DELETE FROM platform_safety_model_usage WHERE submission_id=$1', [id]),
    ]) {
      await rejectsMutation(() => api.readBody(f.who, { submissionId: id }), mutate);
      await rejectsMutation(() => api.prepareSubmission(id), mutate);
    }
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 2);
  }, 'L1');
});

test('later real pending names and unrelated corrupted captures cannot block an old card or grant current naming permission', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime), api = responses(); await api.prepareSubmission(id);
    const body = await api.readBody(f.who, { submissionId: id });
    const later = await f.safety.submit(f.who, { taskId: f.prepared.taskId, operationId: randomUUID(), name: '舟',
      expectedEntryRevision: 1, expectedIdentityRevision: 0 });
    const original = (await fixture.db.query('SELECT request_ciphertext FROM platform_companion_name_submissions WHERE id=$1', [later.submissionId])).rows[0];
    const damaged = Buffer.from(original.request_ciphertext); damaged[0] ^= 1;
    await fixture.db.query('UPDATE platform_companion_name_submissions SET request_ciphertext=$2 WHERE id=$1', [later.submissionId, damaged]);
    const before = await snapshot(f.who);
    assert.deepEqual(await api.readBody(f.who, { submissionId: id }), body);
    const replay = await api.prepareSubmission(id); assert(replay); assert.equal(replay.replayed, true);
    await assert.rejects(f.safety.read(f.who, { taskId: f.prepared.taskId }), unavailable);
    await assert.rejects(f.safety.apply(f.who, { taskId: f.prepared.taskId, submissionId: later.submissionId }), unavailable);
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 1);
  });
});

test('account deletion cascades the exact name reference, capture and event; recovery cannot resurrect an owner', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime), api = responses(); await api.prepareSubmission(id);
    await fixture.db.query('DELETE FROM platform_users WHERE id=$1', [f.who.userId]);
    for (const table of [...responseTables, 'platform_companion_name_submissions'])
      assert.equal((await fixture.db.query(`SELECT * FROM ${table} WHERE user_id=$1`, [f.who.userId])).rowCount, 0);
    await assert.rejects(api.recoverSubmission(id), code('NOT_FOUND'));
    await assert.rejects(api.prepareSubmission(id), code('NOT_FOUND'));
    await assert.rejects(api.readBody(f.who, { submissionId: id }), code('AUTH_REQUIRED'));
    assert.equal(bodies.length, 1);
  });
});

test('real captured English preference is optional personalization; unreadable answers use explicit Chinese default without authorizing execution', async () => {
  await loopback(async (runtime, bodies) => {
    const en = await standardReady(runtime, 'en'), enId = await classified(en, runtime, 'Fictional low marker'), api = responses();
    await api.prepareSubmission(enId);
    const english = await api.readBody(en.who, { submissionId: enId }); assertBodyOnly(english, 'Fictional L1');
    const englishRow = await responseRow(enId); assert.equal(englishRow.locale, 'en'); assert.equal(englishRow.locale_origin, 'captured_answers');
    const fallback = await standardReady(runtime, 'en'), id = await classified(fallback, runtime, 'Fictional low marker');
    const answers = (await fixture.db.query('SELECT id,payload_ciphertext FROM platform_companion_answers WHERE user_id=$1', [fallback.who.userId])).rows[0];
    const damaged = Buffer.from(answers.payload_ciphertext); damaged[0] ^= 1;
    await fixture.db.query('UPDATE platform_companion_answers SET payload_ciphertext=$2 WHERE id=$1', [answers.id, damaged]);
    const immutable = await snapshot(fallback.who, false); await api.prepareSubmission(id);
    const chinese = await api.readBody(fallback.who, { submissionId: id }); assertBodyOnly(chinese, '虚构 L1');
    const row = await responseRow(id); assert.equal(row.locale, 'zh'); assert.equal(row.locale_origin, 'default_zh');
    assert.deepEqual(await snapshot(fallback.who, false), immutable);
    await assert.rejects(fallback.safety.submit(fallback.who, { taskId: fallback.prepared.taskId, operationId: randomUUID(), name: '舟',
      expectedEntryRevision: 1, expectedIdentityRevision: 0 }), unavailable);
    assert.deepEqual(await snapshot(fallback.who, false), immutable); assert.equal(bodies.length, 2);
  });
});

test('controlled pre-046 legacy risk recovers only a genuine resource reference despite absent 045 proof and later pending intake', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await standardReady(runtime), id = await classified(f, runtime), api = responses();
    const task = (await fixture.db.query('SELECT * FROM platform_companion_generation_tasks WHERE id=$1', [f.prepared.taskId])).rows[0];
    const binding = { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext', rowId: task.id,
      ownerId: f.who.userId, revision: task.source_revision };
    const seed = JSON.parse(fixture.crypto.openUtf8(task.seed_ciphertext, binding));
    assert.equal(seed.sourceReceiptVersion, 1); const { sourceReceiptVersion: _v, sourceReceiptDigest: _d, ...legacySeed } = seed;
    // Controlled old-format fixture only. Preserve its actual name request,
    // claim, result and generation/cost proof; never simulate a real migration.
    await fixture.db.transaction(async client => {
      await client.query('UPDATE platform_companion_generation_tasks SET source_receipt_version=NULL,seed_ciphertext=$2 WHERE id=$1',
        [task.id, fixture.crypto.sealUtf8(JSON.stringify(legacySeed), binding)]);
      assert.equal((await client.query('DELETE FROM platform_companion_source_prefixes WHERE task_id=$1', [task.id])).rowCount, 1);
      assert.equal((await client.query('DELETE FROM platform_companion_name_safety_responses WHERE submission_id=$1 AND status=\'pending\'', [id])).rowCount, 1);
    });
    const current = await fixture.store.read(f.who); assert(current); assert.equal(current.fastTrack, false);
    const answersPartial = { ...current.answersPartial }; delete answersPartial.extra;
    const reopened = parseOnboardingDraft({ ...current, answersPartial, state: 'collecting', step: 'O4', currentQuestion: 'extra' });
    await fixture.db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [f.who.userId,
      fixture.crypto.sealUtf8(JSON.stringify(reopened), { table: 'platform_onboarding_drafts', column: 'payload_ciphertext',
        rowId: reopened.id, ownerId: f.who.userId, revision: reopened.revision })]);
    const pending = (await fixture.store.save(f.who, { expectedRevision: reopened.revision, operationId: randomUUID(),
      action: { kind: 'text', questionId: 'extra', text: 'Fictional later independent intake input.' } })).draft;
    assert.equal(pending.state, 'safety_pending');
    const before = await snapshot(f.who, false), journal = (await fixture.db.query('SELECT * FROM platform_migrations ORDER BY name')).rows;
    const restored = await api.recoverSubmission(id); assert(restored); assert.equal(restored.replayed, false);
    assert.equal((await responseRow(id)).status, 'pending');
    assert.equal((await fixture.db.query('SELECT * FROM platform_safety_events WHERE user_id=$1', [f.who.userId])).rowCount, 0);
    await api.prepareSubmission(id); const view = await api.readBody(f.who, { submissionId: id }); assertBodyOnly(view, '虚构 L2');
    await assert.rejects(f.safety.read(f.who, { taskId: task.id }), code('ONBOARDING_SAFETY_REQUIRED'));
    await assert.rejects(f.safety.submit(f.who, { taskId: task.id, operationId: randomUUID(), name: '舟',
      expectedEntryRevision: 1, expectedIdentityRevision: 0 }), code('ONBOARDING_SAFETY_REQUIRED'));
    assert.deepEqual(await snapshot(f.who, false), before);
    assert.equal((await fixture.db.query('SELECT * FROM platform_companion_source_prefixes WHERE task_id=$1', [task.id])).rowCount, 0);
    assert.deepEqual((await fixture.db.query('SELECT * FROM platform_migrations ORDER BY name')).rows, journal);
    assert.equal(bodies.length, 1);
  });
});

test('complete migration 046 repeats twice without changing original rows, captured ciphertext, event source branches or journal', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime), api = responses(); await api.prepareSubmission(id);
    const before = await snapshot(f.who), journal = (await fixture.db.query('SELECT * FROM platform_migrations ORDER BY name')).rows;
    const sql = await readFile(new URL('../migrations/046_companion_name_safety_responses.sql', import.meta.url), 'utf8');
    for (let repeat = 0; repeat < 2; repeat++) {
      await fixture.db.transaction(client => client.query(sql));
      assert.deepEqual(await snapshot(f.who), before);
      assert.deepEqual((await fixture.db.query('SELECT * FROM platform_migrations ORDER BY name')).rows, journal);
    }
    const ready = await responseRow(id), source = (await fixture.db.query('SELECT * FROM platform_companion_name_submissions WHERE id=$1', [id])).rows[0];
    for (const attempt of [
      (client: PoolClient) => client.query('UPDATE platform_companion_name_safety_responses SET source_generation=source_generation+1 WHERE id=$1', [ready.id]),
      (client: PoolClient) => client.query("UPDATE platform_companion_name_safety_responses SET level='L1' WHERE id=$1", [ready.id]),
      (client: PoolClient) => client.query('UPDATE platform_safety_events SET submission_id=$2 WHERE name_response_id=$1', [ready.id, source.id]),
      (client: PoolClient) => client.query('UPDATE platform_safety_events SET name_source_generation=NULL WHERE name_response_id=$1', [ready.id]),
      (client: PoolClient) => client.query('UPDATE platform_safety_events SET user_id=$2 WHERE name_response_id=$1', [ready.id, randomUUID()]),
    ]) await assert.rejects(fixture.db.transaction(attempt), error => ['23503', '23514'].includes((error as { code?: string }).code ?? ''));
    assert.deepEqual(await snapshot(f.who), before);
    const view = await api.readBody(f.who, { submissionId: id }); assertBodyOnly(view, '虚构 L2'); assert.equal(bodies.length, 1);
  });
});

test('a coherently aged fictional capture reports expired without returning its body or silently preparing a replacement', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), id = await classified(f, runtime), api = responses();
    await api.prepareSubmission(id);
    const sourceBefore = await snapshot(f.who, false), ready = await responseRow(id);
    // Controlled retention fixture: age only this owned synthetic capture and
    // its bound event together. The actual database clock is never changed.
    const times: { at: Date; until: Date } = (await fixture.db.query(`SELECT t.until-($1::int*interval '1 day') AS at,t.until
      FROM (SELECT date_trunc('milliseconds',clock_timestamp())-interval '1 second' AS until) t`, [bundle.retentionDays])).rows[0];
    const aad = { table: 'platform_companion_name_safety_responses', column: 'payload_ciphertext',
      rowId: ready.id, ownerId: f.who.userId, revision: 1 };
    const payload = JSON.parse(fixture.crypto.openUtf8(ready.payload_ciphertext, aad));
    payload.preparedAt = times.at.toISOString(); payload.retentionUntil = times.until.toISOString();
    const ciphertext = fixture.crypto.sealUtf8(JSON.stringify(payload), aad);
    await fixture.db.transaction(async client => {
      assert.equal((await client.query(`UPDATE platform_companion_name_safety_responses
        SET prepared_at=$2,retention_until=$3,payload_ciphertext=$4 WHERE id=$1`,
      [ready.id, times.at, times.until, ciphertext])).rowCount, 1);
      assert.equal((await client.query(`UPDATE platform_safety_events SET created_at=$2,retention_until=$3
        WHERE name_response_id=$1`, [ready.id, times.at, times.until])).rowCount, 1);
    });
    const before = await snapshot(f.who), view = await api.readBody(f.who, { submissionId: id });
    assert(view); assert.equal(view.status, 'expired');
    assert.equal(Object.hasOwn(view, 'body'), false); assert.equal(Object.hasOwn(view, 'question'), false);
    const replay = await responses(null).prepareSubmission(id); assert(replay); assert.equal(replay.replayed, true);
    assert.deepEqual(await responses(null).readBody(f.who, { submissionId: id }), view);
    assert.deepEqual(await snapshot(f.who), before); assert.deepEqual(await snapshot(f.who, false), sourceBefore);
    assert.equal(bodies.length, 1);
  });
});
