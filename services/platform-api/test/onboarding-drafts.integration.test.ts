import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Database } from '../src/database.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import type { OnboardingAction, OnboardingSaveResult } from '@companion/platform-contracts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Explicit fictional actors in a random loopback schema; no HTTP release or classifier is simulated.
const base = readConfig(), schema = 'onboarding_'+randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use only loopback fictional PostgreSQL.');
url.searchParams.set('options', '-c search_path='+schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: '77'.repeat(32) })!;
const config = { dataCrypto: crypto, requireVerifiedEmail: true };
const store = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
let created = false;
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); created = true; await db.migrate(); await seedFictionalActiveLegal(db); });
after(async () => {
  try { await db.close(); }
  finally { try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.close(); } }
});
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const command = (expectedRevision: number, action: OnboardingAction, operationId = randomUUID()) => ({ expectedRevision, operationId, action });
const start = (mode: 'standard' | 'fast_track' = 'standard') => command(0, { kind: 'start', mode });
async function actor(options: { consented?: boolean; verified?: boolean; kind?: 'student' | 'staff' } = {}): Promise<FixedSessionContext> {
  const userId = randomUUID(), token = randomUUID();
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional intake owner','fictional-unused-hash',$3,$4)`,
  [userId, userId+'@example.invalid', options.kind ?? 'student', options.verified === false ? null : new Date()]);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, tokenHash(token)]);
  if (options.consented !== false) await seedFictionalConsent(db, userId);
  return { userId, tokenHash: tokenHash(token) };
}
async function counts(who: FixedSessionContext) {
  const result = await db.query(`SELECT
    (SELECT count(*)::int FROM platform_onboarding_drafts WHERE user_id=$1) AS drafts,
    (SELECT count(*)::int FROM platform_onboarding_operations WHERE user_id=$1) AS operations`, [who.userId]);
  return result.rows[0];
}
async function releaseTransaction(lock: PoolClient, pending?: Promise<unknown>) {
  try { await lock.query('ROLLBACK'); }
  finally { lock.release(); await pending?.catch(() => {}); }
}

test('a read never initializes progress; each accepted question survives a fresh service instance', async () => {
  const who = await actor(); assert.equal(await store.read(who), null); assert.deepEqual(await counts(who), { drafts: 0, operations: 0 });
  const first = await store.save(who, start()); assert.equal(first.draft.currentQuestion, 'study'); assert.equal(first.draft.revision, 1);
  const saved = await store.save(who, command(1, { kind: 'answer', questionId: 'study', value: { degreeField: 'ds_statistics', programChoice: null } }));
  assert.deepEqual(saved.draft.answersPartial.study, { kind: 'answered', value: { degreeField: 'ds_statistics', programChoice: null }, source: 'user_entered', appliedRevision: 2 });
  assert.deepEqual(await new OnboardingDrafts(db, config, FICTIONAL_LEGAL).read(who), saved.draft);
  const skipped = await store.save(who, command(2, { kind: 'skip', questionId: 'graduation' }));
  assert.equal(skipped.draft.currentQuestion, 'roles'); assert.equal(skipped.draft.answersPartial.graduation?.kind, 'skipped');
  assert.deepEqual(await counts(who), { drafts: 1, operations: 3 });
});

test('intake admission requires actual student, fixed session, email, active documents, consent and storage', async () => {
  const unconsented = await actor({ consented: false }), unverified = await actor({ verified: false }), staff = await actor({ kind: 'staff' }), owner = await actor(), other = await actor();
  for (const [service, who, expected] of [
    [store, unconsented, 'TERMS_CONFIRMATION_REQUIRED'], [store, unverified, 'EMAIL_VERIFICATION_REQUIRED'],
    [store, staff, 'STUDENT_ACCOUNT_REQUIRED'], [store, { userId: owner.userId, tokenHash: other.tokenHash }, 'AUTH_REQUIRED'],
    [new OnboardingDrafts(db, config, null), owner, 'LEGAL_DOCUMENTS_UNAVAILABLE'],
    [new OnboardingDrafts(db, { requireVerifiedEmail: true }, FICTIONAL_LEGAL), owner, 'DATA_STORAGE_UNAVAILABLE'],
  ] as const) {
    await assert.rejects(service.read(who), code(expected)); await assert.rejects(service.save(who, start()), code(expected));
    assert.deepEqual(await counts(who), { drafts: 0, operations: 0 });
  }
});

test('two devices with the same revision cannot silently overwrite each other', async () => {
  const who = await actor(); await store.save(who, start());
  const results = await Promise.allSettled([
    store.save(who, command(1, { kind: 'answer', questionId: 'study', value: { degreeField: 'cs', programChoice: '12_month' } })),
    store.save(who, command(1, { kind: 'skip', questionId: 'study' })),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected'); assert(rejected?.status === 'rejected'); assert(code('ONBOARDING_REVISION_CHANGED')(rejected.reason));
  assert.equal((await store.read(who))?.revision, 2); assert.deepEqual(await counts(who), { drafts: 1, operations: 2 });
});

test('concurrent identical first requests save once, and later replay returns the current revision', async () => {
  const who = await actor(), input = start(), results = await Promise.all([store.save(who, input), store.save(who, input)]);
  assert.equal(new Set(results.map(result => result.draft.id)).size, 1); assert.deepEqual(results.map(result => result.operation.replayed).sort(), [false, true]);
  const latest = await store.save(who, command(1, { kind: 'skip', questionId: 'study' }));
  const replay = await store.save(who, input); assert.deepEqual(replay.draft, latest.draft); assert.equal(replay.operation.appliedRevision, 1); assert.equal(replay.operation.replayed, true);
  await assert.rejects(store.save(who, { ...input, action: { kind: 'start', mode: 'fast_track' } }), code('ONBOARDING_OPERATION_CONFLICT'));
  assert.deepEqual(await counts(who), { drafts: 1, operations: 2 });
});

test('commands cannot skip ahead, invent completion, or answer the free-text question as an ordinary value', async () => {
  const who = await actor();
  await assert.rejects(store.save(who, command(0, { kind: 'skip', questionId: 'study' })), code('ONBOARDING_STATE_CHANGED'));
  await assert.rejects(store.save(who, { ...start(), step: 'O5', completed: true }), code('INVALID_INPUT'));
  await store.save(who, start());
  await assert.rejects(store.save(who, command(1, { kind: 'skip', questionId: 'Q7' })), code('ONBOARDING_STATE_CHANGED'));
  await assert.rejects(store.save(who, { ...command(1, { kind: 'skip', questionId: 'study' }), action: { kind: 'answer', questionId: 'extra', value: { textId: randomUUID() } } }), code('INVALID_INPUT'));
  assert.equal((await store.read(who))?.revision, 1); assert.deepEqual(await counts(who), { drafts: 1, operations: 1 });
});

test('typed answers are encrypted pending submissions, never unchecked progress or raw public draft text', async () => {
  const who = await actor(); await store.save(who, start());
  const raw = 'Synthetic note only: Please speak gently; fictional campus.', input = command(1, { kind: 'text', questionId: 'study', text: raw });
  const saved = await store.save(who, input); assert.equal(saved.draft.state, 'safety_pending'); assert.equal(saved.draft.currentQuestion, 'study');
  assert.equal(saved.draft.pendingText?.id, input.operationId); assert.equal(saved.draft.answersPartial.study, undefined); assert.equal(JSON.stringify(saved).includes(raw), false);
  const row = (await db.query('SELECT * FROM platform_onboarding_drafts WHERE user_id=$1', [who.userId])).rows[0];
  const operation = (await db.query('SELECT * FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2', [who.userId, input.operationId])).rows[0];
  assert.equal(row.payload_ciphertext.includes(Buffer.from(raw)), false); assert.equal(operation.request_ciphertext.includes(Buffer.from(raw)), false);
  assert.equal(JSON.parse(crypto.openUtf8(operation.request_ciphertext, { table: 'platform_onboarding_operations', column: 'request_ciphertext', rowId: input.operationId, ownerId: who.userId, revision: 2 })).action.text, raw);
  await assert.rejects(store.save(who, command(2, { kind: 'skip', questionId: 'study' })), code('ONBOARDING_STATE_CHANGED'));
  await assert.rejects(store.save(who, { ...command(2, { kind: 'skip', questionId: 'study' }), safety: { level: 'L0' } }), code('INVALID_INPUT'));
  assert.equal((await store.read(who))?.state, 'safety_pending'); assert.deepEqual(await counts(who), { drafts: 1, operations: 2 });
});

test('fast intake resolves explicit questions without issuing companion, memory, room or letter records', async () => {
  const who = await actor(); let saved = await store.save(who, start('fast_track'));
  while (saved.draft.currentQuestion) saved = await store.save(who, command(saved.draft.revision, { kind: 'skip', questionId: saved.draft.currentQuestion }));
  assert.equal(saved.draft.state, 'intake_ready'); assert.equal(saved.draft.step, 'O5'); assert.equal(saved.draft.revision, 7);
  assert.equal(saved.draft.answersPartial.extra?.kind, 'skipped');
  const rows = await db.query(`SELECT
    (SELECT count(*)::int FROM platform_conversations WHERE user_id=$1) AS rooms,
    (SELECT count(*)::int FROM platform_memories WHERE user_id=$1) AS memories,
    (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs`, [who.userId]);
  assert.deepEqual(rows.rows[0], { rooms: 0, memories: 0, jobs: 0 });
  await assert.rejects(store.save(who, command(7, { kind: 'skip', questionId: 'extra' })), code('ONBOARDING_STATE_CHANGED'));
});

test('revocation and withdrawn consent also block duplicate-operation reads', async () => {
  const who = await actor(), input = start(); await store.save(who, input);
  await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
  await assert.rejects(store.save(who, input), code('TERMS_CONFIRMATION_REQUIRED')); await seedFictionalConsent(db, who.userId);
  await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
  await assert.rejects(store.read(who), code('AUTH_REQUIRED')); await assert.rejects(store.save(who, input), code('AUTH_REQUIRED'));
  assert.deepEqual(await counts(who), { drafts: 1, operations: 1 });
});

test('row, owner and revision authenticated ciphertext cannot be transplanted or silently reset', async () => {
  const a = await actor(), b = await actor(); const first = await store.save(a, start()); await store.save(b, start());
  const old = (await db.query('SELECT payload_ciphertext FROM platform_onboarding_drafts WHERE user_id=$1', [a.userId])).rows[0].payload_ciphertext;
  await db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [b.userId, old]);
  await assert.rejects(store.read(b), code('DATA_STORAGE_UNAVAILABLE'));
  // Writes now authenticate the enrolled original history before changing it.
  await assert.rejects(store.save(b, command(1, { kind: 'skip', questionId: 'study' })), code('COMPANION_PREBIRTH_INVENTORY_UNAVAILABLE'));
  await store.save(a, command(1, { kind: 'skip', questionId: 'study' }));
  await db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [a.userId, old]);
  await assert.rejects(store.read(a), code('DATA_STORAGE_UNAVAILABLE')); assert.equal(first.draft.revision, 1);
  assert.deepEqual(await counts(a), { drafts: 1, operations: 2 }); assert.deepEqual(await counts(b), { drafts: 1, operations: 1 });
});

test('authenticated but invalid state and damaged operation ciphertext return bounded storage errors', async () => {
  const who = await actor(), input = start(), saved = await store.save(who, input);
  const binding = { table: 'platform_onboarding_drafts', column: 'payload_ciphertext', rowId: saved.draft.id, ownerId: who.userId, revision: 1 };
  const invalid = crypto.sealUtf8(JSON.stringify({ ...saved.draft, schemaVersion: 99 }), binding);
  await db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [who.userId, invalid]);
  await assert.rejects(store.read(who), code('DATA_STORAGE_UNAVAILABLE'));
  await db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [who.userId, crypto.sealUtf8(JSON.stringify(saved.draft), binding)]);
  await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, input.operationId, Buffer.alloc(29)]);
  await assert.rejects(store.save(who, input), code('COMPANION_PREBIRTH_INVENTORY_UNAVAILABLE'));
  // Reads now verify the complete operation history before claiming that all text was accounted for.
  await assert.rejects(store.read(who), code('DATA_STORAGE_UNAVAILABLE'));
  assert.equal((await db.query('SELECT revision FROM platform_onboarding_drafts WHERE user_id=$1', [who.userId])).rows[0].revision, saved.draft.revision);
});

test('a fixed command and account survive caller mutation during a proven account lock wait', async () => {
  const who = await actor(), other = await actor(), input = start(), original = structuredClone(input), lock = await db.pool.connect();
  let pending: Promise<OnboardingSaveResult> | undefined;
  try {
    await lock.query('BEGIN'); const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [who.userId]);
    pending = store.save(who, input); pending.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%platform_users%' AND $1=ANY(pg_blocking_pids(pid))", [blocker]);
      if (result.rowCount) { blocked = true; break; } await new Promise(resolve => setTimeout(resolve, 3));
    }
    assert(blocked, 'The actual account query must be blocked by this test.');
    (who as { userId: string }).userId = other.userId; (who as { tokenHash: string }).tokenHash = other.tokenHash;
    input.expectedRevision = 9; input.action = { kind: 'start', mode: 'fast_track' };
    await lock.query('COMMIT'); const saved = await pending;
    assert.equal(saved.draft.fastTrack, false); assert.notEqual(saved.draft.userId, other.userId); assert.equal(saved.operation.id, original.operationId);
    assert.equal(await store.read(other), null);
  } finally { await releaseTransaction(lock, pending); }
});

test('session expiry during a proven policy lock wait prevents writing a draft', async () => {
  const who = await actor(), lock = await db.pool.connect();
  let pending: Promise<OnboardingSaveResult> | undefined;
  try {
    await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE token_hash=$1", [who.tokenHash]);
    await lock.query('BEGIN'); const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT singleton FROM platform_terms_policy WHERE singleton=true FOR UPDATE');
    pending = store.save(who, start()); pending.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%platform_terms_policy%' AND $1=ANY(pg_blocking_pids(pid))", [blocker]);
      if (result.rowCount) { blocked = true; break; } await new Promise(resolve => setTimeout(resolve, 3));
    }
    assert(blocked, 'The actual policy query must be blocked by this test.');
    await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.01) FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
    assert.equal((await db.query('SELECT expires_at<=clock_timestamp() AS expired FROM platform_sessions WHERE token_hash=$1', [who.tokenHash])).rows[0].expired, true);
    await lock.query('COMMIT'); await assert.rejects(pending, code('AUTH_REQUIRED')); assert.deepEqual(await counts(who), { drafts: 0, operations: 0 });
  } finally { await releaseTransaction(lock, pending); }
});

test('a deferred COMMIT failure never returns success and rolls back both draft and operation', async () => {
  const who = await actor();
  let functionCreated = false;
  try {
    await db.query(`CREATE FUNCTION fictional_reject_intake_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${who.userId}'::uuid THEN RAISE EXCEPTION 'Fictional deferred commit rejected'; END IF; RETURN NEW; END $$`);
    functionCreated = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_intake_commit_gate AFTER INSERT ON platform_onboarding_operations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_intake_commit()`);
    await assert.rejects(store.save(who, start()), /Fictional deferred commit rejected/);
    assert.deepEqual(await counts(who), { drafts: 0, operations: 0 }); assert.equal(await store.read(who), null);
  } finally { if (functionCreated) await db.query('DROP FUNCTION fictional_reject_intake_commit() CASCADE'); }
});

test('expiry and cancellation after acceptance do not undo COMMIT; a new valid session can recover the same operation', async () => {
  const who = await actor(), input = start(), controller = new AbortController(), lock = await db.pool.connect();
  const gate = Number.parseInt(randomUUID().slice(0, 7), 16);
  let functionCreated = false, locked = false, pending: Promise<OnboardingSaveResult> | undefined;
  try {
    const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT pg_advisory_lock(81826,$1)', [gate]); locked = true;
    await db.query(`CREATE FUNCTION fictional_wait_intake_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${who.userId}'::uuid THEN PERFORM pg_advisory_xact_lock(81826,${gate}); END IF; RETURN NEW; END $$`);
    functionCreated = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_intake_acceptance_gate AFTER INSERT ON platform_onboarding_operations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_wait_intake_commit()`);
    await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE token_hash=$1", [who.tokenHash]);
    pending = store.save(who, input, controller.signal); pending.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query='COMMIT' AND $1=ANY(pg_blocking_pids(pid))", [blocker]);
      if (result.rowCount) { blocked = true; break; } await new Promise(resolve => setTimeout(resolve, 3));
    }
    assert(blocked, 'COMMIT must have reached the actual deferred trigger after acceptance.');
    assert.equal((await counts(who)).operations, 0, 'The operation is not visible before COMMIT.');
    controller.abort();
    await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.01) FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
    assert.equal((await db.query('SELECT expires_at<=clock_timestamp() AS expired FROM platform_sessions WHERE token_hash=$1', [who.tokenHash])).rows[0].expired, true);
    await lock.query('SELECT pg_advisory_unlock(81826,$1)', [gate]);
    const confirmed = await pending; assert.equal(confirmed.operation.replayed, false); assert.deepEqual(await counts(who), { drafts: 1, operations: 1 });
    await assert.rejects(store.read(who), code('AUTH_REQUIRED'));
    const replacement = { userId: who.userId, tokenHash: tokenHash(randomUUID()) };
    await db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')", [replacement.userId, replacement.tokenHash]);
    const recovered = await store.save(replacement, input); assert.deepEqual(recovered.draft, confirmed.draft); assert.equal(recovered.operation.replayed, true);
  } finally {
    try { if (locked) await lock.query('SELECT pg_advisory_unlock(81826,$1)', [gate]); }
    finally {
      lock.release(); await pending?.catch(() => {});
      if (functionCreated) await db.query('DROP FUNCTION fictional_wait_intake_commit() CASCADE');
    }
  }
});

test('already cancelled saves write nothing; an operation owner cannot reference another owner draft', async () => {
  const who = await actor(), other = await actor(), controller = new AbortController(); controller.abort();
  await assert.rejects(store.save(who, start(), controller.signal)); assert.deepEqual(await counts(who), { drafts: 0, operations: 0 });
  const saved = await store.save(other, start());
  await assert.rejects(db.query(`INSERT INTO platform_onboarding_operations(user_id,operation_id,draft_id,applied_revision,request_ciphertext)
    VALUES($1,$2,$3,1,$4)`, [who.userId, randomUUID(), saved.draft.id, Buffer.alloc(29)]), error => (error as { code?: string }).code === '23503');
});
