import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ModelCallEvent } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { createSafetyModelUsage } from '../src/safety-model-usage.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Counts-only protocol tests with real isolated PostgreSQL and fictional events. No provider, HTTP grant or dollar budget is simulated.
const base = readConfig(), schema = 'safety_model_usage_'+randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use only loopback fictional PostgreSQL.');
url.searchParams.set('options', '-c search_path='+schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const store = new OnboardingDrafts(db, { dataCrypto: readDataCrypto({ PLATFORM_DATA_KEY: '99'.repeat(32) }), requireVerifiedEmail: true }, FICTIONAL_LEGAL);
const route = { purpose: 'safety_classify' as const, provider: 'openai', model: 'synthetic-classifier-model' };
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await db.migrate(); await seedFictionalActiveLegal(db); });
after(async () => { try { await db.close(); } finally { try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.close(); } } });
const denied = (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === 'ONBOARDING_SAFETY_UNAVAILABLE';
async function actor(): Promise<FixedSessionContext> {
  const userId = randomUUID(), token = randomUUID();
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional model usage owner','fictional-unused-hash','student',clock_timestamp())`, [userId, userId+'@example.invalid']);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, tokenHash(token)]); await seedFictionalConsent(db, userId);
  return { userId, tokenHash: tokenHash(token) };
}
async function fixture(requestedWho?: FixedSessionContext, limit = 3) {
  const who = requestedWho ?? await actor();
  let draft = await store.read(who);
  if (!draft) draft = (await store.save(who, { operationId: randomUUID(), expectedRevision: 0, action: { kind: 'start', mode: 'standard' } })).draft;
  const raw = 'Synthetic model usage note; no real user data.';
  await store.save(who, { operationId: randomUUID(), expectedRevision: draft.revision, action: { kind: 'text', questionId: draft.currentQuestion, text: raw } });
  const claim = await store.claimSafety(who, { detectorRevision: 7, leaseMs: 60000 }); assert(claim);
  const usage = createSafetyModelUsage(db, claim, route, limit), callId = randomUUID();
  const started: ModelCallEvent = { type: 'started', callId, index: 1, provider: route.provider, model: route.model, purpose: 'safety_classify' };
  return { who, claim, usage, callId, started, raw };
}
async function row(callId: string) { return (await db.query('SELECT * FROM platform_safety_model_usage WHERE call_id=$1', [callId])).rows[0]; }
async function count(who: FixedSessionContext) { return (await db.query('SELECT count(*)::int AS n FROM platform_safety_model_usage WHERE user_id=$1', [who.userId])).rows[0].n; }
const finish = (callId: string, usage: 'reported' | 'missing' | 'invalid' = 'reported', status: 'complete' | 'failed' | 'cancelled' | 'interrupted' = 'complete'): ModelCallEvent => ({ type: 'finished', callId, status,
  usage: usage === 'reported' ? { status: 'reported', inputTokens: 12, outputTokens: 4 } : { status: usage } });
async function admit(f: Awaited<ReturnType<typeof fixture>>) { await db.withBoundedTransaction(client => f.usage.assertAdmitted(client)); }
async function complete(f: Awaited<ReturnType<typeof fixture>>) { await f.usage.onModelCall(f.started); await admit(f); await f.usage.onModelCall(finish(f.callId)); }

test('prepared reservation is durable and counts-only; real admission and completion use the actual row', async () => {
  const f = await fixture(); await f.usage.onModelCall(f.started);
  const prepared = await row(f.callId); assert.equal(prepared.status, 'prepared'); assert.equal(prepared.usage_status, 'pending');
  assert.equal(prepared.user_id, f.who.userId); assert.equal(prepared.submission_id, f.claim.submissionId); assert.equal(prepared.generation, f.claim.generation); assert.equal(prepared.detector_revision, 7);
  assert.equal(prepared.input_tokens, null); assert.equal(prepared.output_tokens, null); assert.equal(prepared.admitted_at, null); assert.equal(JSON.stringify(prepared).includes(f.raw), false);
  for (const field of ['text', 'prompt', 'content', 'api_key', 'lease_token', 'request_ciphertext']) assert.equal(Object.hasOwn(prepared, field), false);
  await admit(f); assert.equal((await row(f.callId)).status, 'admitted');
  await f.usage.onModelCall(finish(f.callId)); const finished = await row(f.callId);
  assert.equal(finished.status, 'complete'); assert.equal(finished.usage_status, 'reported'); assert.equal(finished.input_tokens, 12); assert.equal(finished.output_tokens, 4); assert(finished.admitted_at); assert(finished.finished_at);
  await db.withBoundedTransaction(client => f.usage.assertComplete(client));
  const authority = (await db.query(`SELECT (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs,
    (SELECT count(*)::int FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id WHERE c.user_id=$1) AS messages`, [f.who.userId])).rows[0];
  assert.deepEqual(authority, { jobs: 0, messages: 0 });
});

test('concurrent identical started events prepare once; a generation and reservation can admit only one actual request', async () => {
  const f = await fixture(); await Promise.all([f.usage.onModelCall(f.started), f.usage.onModelCall(f.started)]); assert.equal(await count(f.who), 1);
  await assert.rejects(createSafetyModelUsage(db, f.claim, route, 3).onModelCall({ ...f.started, callId: randomUUID() }), denied);
  await admit(f); await assert.rejects(admit(f), denied); await assert.rejects(f.usage.onModelCall(f.started), denied);
  assert.equal(await count(f.who), 1); assert.equal((await row(f.callId)).status, 'admitted');
});

test('zero/missing limits, wrong owner, generation, lease, detector, route and auth never prepare or admit a call', async () => {
  const f = await fixture(), other = await actor();
  await assert.rejects(createSafetyModelUsage(db, f.claim, route, 0).onModelCall(f.started), denied);
  for (const limit of [undefined, -1, 1.5, 10001, Infinity]) assert.throws(() => createSafetyModelUsage(db, f.claim, route, limit as number), denied);
  for (const claim of [{ ...f.claim, userId: other.userId }, { ...f.claim, generation: f.claim.generation+1 }, { ...f.claim, leaseToken: randomUUID() }, { ...f.claim, detectorRevision: 8 }, { ...f.claim, authVersion: '1' }]) await assert.rejects(createSafetyModelUsage(db, claim, route, 3).onModelCall(f.started), denied);
  for (const changed of [{ ...f.started, model: 'different-model' }, { ...f.started, provider: 'different-provider' }, { ...f.started, index: 2 }, { ...f.started, purpose: 'chat' }, { ...f.started, text: f.raw }]) await assert.rejects(f.usage.onModelCall(changed as ModelCallEvent), denied);
  assert.equal(await count(f.who), 0); assert.equal(await count(other), 0);
  await assert.rejects(admit(f), denied); await f.usage.onModelCall(f.started);
  await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [f.who.userId]);
  await assert.rejects(admit(f), denied); assert.equal((await row(f.callId)).status, 'prepared');
});

test('an unfinished reservation or missing/invalid usage blocks later paid calls without treating unknown cost as zero', async () => {
  for (const state of ['prepared', 'admitted', 'missing', 'invalid'] as const) {
    const f = await fixture(); await f.usage.onModelCall(f.started);
    if (state !== 'prepared') await admit(f);
    if (state === 'missing' || state === 'invalid') await f.usage.onModelCall(finish(f.callId, state));
    const next = await fixture(f.who); await assert.rejects(next.usage.onModelCall(next.started), denied);
    assert.equal(await count(f.who), 1); const existing = await row(f.callId);
    assert.equal(existing.input_tokens, null); assert.equal(existing.output_tokens, null);
    if (state === 'missing' || state === 'invalid') await db.withBoundedTransaction(client => f.usage.assertComplete(client));
  }
});

test('the daily call cap is owner scoped and uses the server UTC reservation day, while older unknown usage still blocks', async () => {
  const f = await fixture(undefined, 1); await complete(f);
  const capped = await fixture(f.who, 1); await assert.rejects(capped.usage.onModelCall(capped.started), denied);
  const other = await fixture(undefined, 1); await other.usage.onModelCall(other.started); assert.equal(await count(other.who), 1);
  await db.query("UPDATE platform_safety_model_usage SET created_at=(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 microsecond') AT TIME ZONE 'UTC' WHERE call_id=$1", [f.callId]);
  await capped.usage.onModelCall(capped.started); assert.equal(await count(f.who), 2);
  const unknown = await fixture(); await unknown.usage.onModelCall(unknown.started); await admit(unknown); await unknown.usage.onModelCall(finish(unknown.callId, 'missing'));
  await db.query("UPDATE platform_safety_model_usage SET created_at=clock_timestamp()-interval '2 days' WHERE call_id=$1", [unknown.callId]);
  const later = await fixture(unknown.who); await assert.rejects(later.usage.onModelCall(later.started), denied);
});

test('only a genuinely admitted completed call permits full-result acceptance; fabricated or unfinished completion stays rejected', async () => {
  const f = await fixture(); await assert.rejects(db.withBoundedTransaction(client => f.usage.assertComplete(client)), denied);
  await f.usage.onModelCall(f.started);
  await assert.rejects(f.usage.onModelCall(finish(f.callId)), denied); assert.equal((await row(f.callId)).status, 'prepared');
  await assert.rejects(db.query("UPDATE platform_safety_model_usage SET status='complete',usage_status='reported',input_tokens=0,output_tokens=0,finished_at=clock_timestamp() WHERE call_id=$1", [f.callId]), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '23514');
  await admit(f); await assert.rejects(db.withBoundedTransaction(client => f.usage.assertComplete(client)), denied);
  await f.usage.onModelCall(finish(f.callId, 'missing')); await db.withBoundedTransaction(client => f.usage.assertComplete(client));
});

test('revoked or expired execution cannot admit again, but its actual late terminal usage is preserved and idempotent', async () => {
  const f = await fixture(); await f.usage.onModelCall(f.started); await admit(f);
  await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [f.who.userId]);
  await db.query("UPDATE platform_onboarding_safety_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.claim.submissionId]);
  await assert.rejects(admit(f), denied);
  const reported = finish(f.callId, 'reported', 'cancelled'); await f.usage.onModelCall(reported); await f.usage.onModelCall(reported);
  assert.equal((await row(f.callId)).input_tokens, 12); assert.equal((await row(f.callId)).status, 'cancelled');
  await assert.rejects(f.usage.onModelCall(finish(f.callId, 'missing', 'cancelled')), denied);
  await assert.rejects(db.withBoundedTransaction(client => f.usage.assertComplete(client)), denied);
  const fresh = createSafetyModelUsage(db, f.claim, route, 0); await assert.rejects(fresh.onModelCall(reported), denied);
});

test('malformed usage cannot overwrite counts, and genuine reported zero remains distinct from missing', async () => {
  const f = await fixture(); await f.usage.onModelCall(f.started); await admit(f);
  for (const inputTokens of [-1, 1.5, Infinity, 2147483648, '12']) await assert.rejects(f.usage.onModelCall({ type: 'finished', callId: f.callId, status: 'complete', usage: { status: 'reported', inputTokens, outputTokens: 1 } } as ModelCallEvent), denied);
  const zero: ModelCallEvent = { type: 'finished', callId: f.callId, status: 'complete', usage: { status: 'reported', inputTokens: 0, outputTokens: 0 } };
  await f.usage.onModelCall(zero); await f.usage.onModelCall(zero); assert.equal((await row(f.callId)).input_tokens, 0); assert.equal((await row(f.callId)).usage_status, 'reported');
  await assert.rejects(f.usage.onModelCall(finish(f.callId)), denied);
});

test('an aborted or stale claim never consumes admission, and a new generation keeps old accounting history', async () => {
  const f = await fixture(); await f.usage.onModelCall(f.started); const controller = new AbortController(); controller.abort();
  await assert.rejects(db.withBoundedTransaction(client => f.usage.assertAdmitted(client, controller.signal)), { name: 'AbortError' }); assert.equal((await row(f.callId)).status, 'prepared');
  await f.usage.onModelCall(finish(f.callId, 'reported', 'failed'));
  await store.failSafety(f.claim, 'unavailable'); const newClaim = await store.claimSafety(f.who, { detectorRevision: 7 }); assert(newClaim); assert.equal(newClaim.generation, f.claim.generation+1);
  await assert.rejects(admit(f), denied); assert.equal((await row(f.callId)).generation, f.claim.generation);
  const next = createSafetyModelUsage(db, newClaim, route, 3), nextCallId = randomUUID();
  await next.onModelCall({ type: 'started', callId: nextCallId, index: 1, provider: route.provider, model: route.model, purpose: 'safety_classify' });
  assert.equal(await count(f.who), 2); assert.equal((await row(nextCallId)).generation, newClaim.generation);
});

test('a deferred prepared-reservation COMMIT rejection returns no admission and leaves no partial usage row', async () => {
  const f = await fixture(); let functionCreated = false;
  try {
    await db.query(`CREATE FUNCTION fictional_reject_safety_usage_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${f.who.userId}'::uuid THEN RAISE EXCEPTION 'Fictional usage commit rejected'; END IF; RETURN NEW; END $$`); functionCreated = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_safety_usage_commit_gate AFTER INSERT ON platform_safety_model_usage
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_safety_usage_commit()`);
    await assert.rejects(f.usage.onModelCall(f.started), denied); assert.equal(await count(f.who), 0); await assert.rejects(admit(f), denied);
  } finally { if (functionCreated) await db.query('DROP FUNCTION fictional_reject_safety_usage_commit() CASCADE'); }
});

test('the composite foreign key forbids attributing an actual submission call to another user', async () => {
  const f = await fixture(), other = await actor(); await f.usage.onModelCall(f.started);
  await assert.rejects(db.query('UPDATE platform_safety_model_usage SET user_id=$2 WHERE call_id=$1', [f.callId, other.userId]), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '23503');
  assert.equal((await row(f.callId)).user_id, f.who.userId);
});

test('a proven account lock serializes two different reservations before either can consume the same user budget', { timeout: 10_000 }, async () => {
  const first = await fixture(undefined, 1), second = await fixture(first.who, 1), holder = await db.pool.connect();
  const gate = Number.parseInt(randomUUID().slice(0, 7), 16);
  let functionCreated = false, locked = false, a: Promise<void> | undefined, b: Promise<void> | undefined;
  try {
    const blocker = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder.query('SELECT pg_advisory_lock(81829,$1)', [gate]); locked = true;
    await db.query(`CREATE FUNCTION fictional_wait_safety_usage_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.call_id='${first.callId}'::uuid THEN PERFORM pg_advisory_xact_lock(81829,${gate}); END IF; RETURN NEW; END $$`); functionCreated = true;
    await db.query(`CREATE TRIGGER fictional_safety_usage_insert_gate BEFORE INSERT ON platform_safety_model_usage
      FOR EACH ROW EXECUTE FUNCTION fictional_wait_safety_usage_insert()`);
    a = first.usage.onModelCall(first.started); a.catch(() => {});
    let firstBackend: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%INSERT INTO platform_safety_model_usage%' AND $1=ANY(pg_blocking_pids(pid))", [blocker]);
      if (waiting.rowCount) { firstBackend = waiting.rows[0].pid; break; } await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert(firstBackend, 'The first real INSERT must be blocked by the controlled advisory gate.');
    b = second.usage.onModelCall(second.started); b.catch(() => {});
    let accountBlocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%platform_users%' AND $1=ANY(pg_blocking_pids(pid))", [firstBackend]);
      if (waiting.rowCount) { accountBlocked = true; break; } await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert(accountBlocked, 'The second reservation must wait on the first actual account lock.');
    await holder.query('SELECT pg_advisory_unlock(81829,$1)', [gate]); locked = false;
    await a; await assert.rejects(b, denied);
    assert.equal(await count(first.who), 1); assert.equal((await row(first.callId)).status, 'prepared'); assert.equal(await row(second.callId), undefined);
  } finally {
    try { if (locked) await holder.query('SELECT pg_advisory_unlock(81829,$1)', [gate]); }
    finally {
      holder.release(); await Promise.allSettled([...(a ? [a] : []), ...(b ? [b] : [])]);
      if (functionCreated) await db.query('DROP FUNCTION fictional_wait_safety_usage_insert() CASCADE');
    }
  }
});
