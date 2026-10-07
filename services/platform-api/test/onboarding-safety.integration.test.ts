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
import type { OnboardingAction, ProviderRequestAdmission } from '@companion/platform-contracts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Durable inbox preparation only. All actors/text/classifiers are fictional, with no real provider or HTTP release.
const base = readConfig(), schema = 'onboarding_safety_'+randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use only loopback fictional PostgreSQL.');
url.searchParams.set('options', '-c search_path='+schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: '88'.repeat(32) })!;
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
async function actor(): Promise<FixedSessionContext> {
  const userId = randomUUID(), token = randomUUID();
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional safety owner','fictional-unused-hash','student',clock_timestamp())`, [userId, userId+'@example.invalid']);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, tokenHash(token)]);
  await seedFictionalConsent(db, userId);
  return { userId, tokenHash: tokenHash(token) };
}
async function text(who: FixedSessionContext, raw = 'Synthetic course note; fictional person.') {
  let draft = await store.read(who);
  if (!draft) draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  assert(draft.currentQuestion);
  const input = command(draft.revision, { kind: 'text', questionId: draft.currentQuestion, text: raw });
  const saved = await store.save(who, input);
  return { input, saved, raw };
}
async function claim(who: FixedSessionContext, options: { detectorRevision: number; leaseMs?: number } = { detectorRevision: 7 }) {
  const claimed = await store.claimSafety(who, options);
  assert(claimed, 'An actual encrypted text operation must be claimed.');
  return claimed;
}
async function submission(id: string) { return (await db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE id=$1', [id])).rows[0]; }
async function counts(who: FixedSessionContext) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM platform_onboarding_drafts WHERE user_id=$1) AS drafts,
    (SELECT count(*)::int FROM platform_onboarding_operations WHERE user_id=$1) AS operations,
    (SELECT count(*)::int FROM platform_onboarding_safety_submissions WHERE user_id=$1) AS submissions`, [who.userId])).rows[0];
}
const l0 = { level: 'L0', mode: 'full', resolution: { kind: 'answer', questionId: 'study', value: { degreeField: 'ds_statistics', programChoice: null } } };
const l1 = { level: 'L1', mode: 'full' };
const l2 = { level: 'L2', mode: 'full' };
function classifier(decision: unknown, started?: (input: { text: string; questionId: string }) => void) {
  return async (input: { text: string; questionId: string }, admission: ProviderRequestAdmission): Promise<unknown> =>
    admission(async signal => { signal.throwIfAborted(); started?.(input); return decision; });
}

// A detected result is evidence of the fixture's fenced completion, not evidence of classifier quality or a delivered crisis response.
test('every accepted text survives service restart in an encrypted inbox and identical replay enqueues once', async () => {
  const who = await actor(); assert.equal(await store.claimSafety(who, { detectorRevision: 7 }), null);
  const first = await text(who, 'Synthetic inbox private note alpha.');
  const replay = await store.save(who, first.input); assert.equal(replay.operation.replayed, true);
  assert.deepEqual(await counts(who), { drafts: 1, operations: 2, submissions: 1 });
  const fresh = new OnboardingDrafts(db, config, FICTIONAL_LEGAL), claimed = await fresh.claimSafety(who, { detectorRevision: 7 });
  assert(claimed); assert.equal(JSON.stringify(claimed).includes(first.raw), false);
  let actualInput: { text: string; questionId: string } | undefined;
  const result = await fresh.processSafety(claimed, classifier(l0, input => { actualInput = input; }));
  assert.deepEqual(actualInput, { text: first.raw, questionId: 'study' });
  assert.equal(result.status, 'detected'); assert.equal(result.advanced, true); assert.equal(result.replayed, false);
  const row = await submission(claimed.submissionId);
  assert.equal(row.status, 'detected'); assert.equal(row.level, 'L0'); assert.equal(row.detector_mode, 'full');
  assert(row.result_ciphertext instanceof Buffer); assert.equal(row.result_ciphertext.includes(Buffer.from(first.raw)), false);
  const decoded = JSON.parse(crypto.openUtf8(row.result_ciphertext, {
    table: 'platform_onboarding_safety_submissions', column: 'result_ciphertext', rowId: row.id, ownerId: who.userId, revision: row.generation,
  }));
  assert.equal(decoded.level, 'L0'); assert.equal(decoded.mode, 'full');
  const beforeReplay = await fresh.read(who); let repeated = 0;
  const receipt = await fresh.processSafety(claimed, classifier(l2, () => { repeated++; }));
  assert.equal(receipt.replayed, true); assert.equal(repeated, 0); assert.deepEqual(await fresh.read(who), beforeReplay);
});

test('concurrent claimers acquire one generation and only the exact owner, generation and token can launch', async () => {
  const who = await actor(), other = await actor(); await text(who);
  const results = await Promise.all([store.claimSafety(who, { detectorRevision: 7 }), store.claimSafety(who, { detectorRevision: 7 })]);
  assert.equal(results.filter(Boolean).length, 1); const current = results.find(Boolean)!;
  let launches = 0;
  for (const forged of [
    { ...current, userId: other.userId }, { ...current, generation: current.generation+1 },
    { ...current, leaseToken: randomUUID() }, { ...current, submissionId: randomUUID() },
  ]) await assert.rejects(store.processSafety(forged, classifier(l0, () => { launches++; })), code('ONBOARDING_SAFETY_CLAIM_CHANGED'));
  assert.equal(launches, 0); assert.equal((await submission(current.submissionId)).status, 'running');
  const receipt = await store.processSafety(current, classifier(l0, () => { launches++; }));
  assert.equal(receipt.advanced, true); assert.equal(launches, 1);
  await assert.rejects(store.processSafety({ ...current, leaseToken: randomUUID() }, classifier(l0, () => { launches++; })), code('ONBOARDING_SAFETY_CLAIM_CHANGED'));
  assert.equal(launches, 1);
});

test('newer L0 waits for every older text and an older L2 cannot be erased by the newer classification', async () => {
  const who = await actor(), a = await text(who, 'Synthetic older crisis fixture A.'), b = await text(who, 'Synthetic newer ordinary fixture B.');
  const oldClaim = await claim(who), newClaim = await claim(who);
  assert.equal(oldClaim.operationId, a.input.operationId); assert.equal(newClaim.operationId, b.input.operationId);
  const newer = await store.processSafety(newClaim, classifier(l0)); assert.equal(newer.advanced, false);
  assert.equal((await store.read(who))?.revision, b.saved.draft.revision); assert.equal((await store.read(who))?.state, 'safety_pending');
  await store.processSafety(oldClaim, classifier(l2));
  const paused = await store.read(who); assert.equal(paused?.state, 'safety_pending');
  assert.equal(paused?.answersPartial.study, undefined); assert.equal((await submission(oldClaim.submissionId)).level, 'L2');
  assert.deepEqual(await store.readSafety(who), { status: 'blocked', pendingCount: 0, blockedLevel: 'L2' });
  await assert.rejects(store.save(who, command(paused!.revision, { kind: 'text', questionId: 'study', text: 'Synthetic attempted bypass.' })), code('ONBOARDING_SAFETY_REVIEW_REQUIRED'));
  let repeated = 0; await store.processSafety(newClaim, classifier(l0, () => { repeated++; }));
  assert.equal(repeated, 0); assert.deepEqual(await store.read(who), paused);
});

test('when older and newer text are both L0, the newest text advances exactly once after the older barrier clears', async () => {
  const who = await actor(), a = await text(who, 'Synthetic older ordinary fixture A.'), b = await text(who, 'Synthetic newer ordinary fixture B.');
  const oldClaim = await claim(who), newClaim = await claim(who);
  assert.equal(oldClaim.operationId, a.input.operationId); assert.equal(newClaim.operationId, b.input.operationId);
  const newer = await store.processSafety(newClaim, classifier(l0)); assert.equal(newer.advanced, false);
  const older = await store.processSafety(oldClaim, classifier({ level: 'L0', mode: 'full', resolution: { kind: 'unmatched' } }));
  assert.equal(older.advanced, true);
  const draft = await store.read(who); assert.equal(draft?.revision, b.saved.draft.revision+1); assert.equal(draft?.currentQuestion, 'graduation');
  assert.equal(draft?.answersPartial.study?.kind, 'answered'); assert.equal(draft?.answersPartial.study?.textId, b.input.operationId);
  let repeated = 0;
  for (const current of [oldClaim, newClaim]) assert.equal((await store.processSafety(current, classifier(l2, () => { repeated++; }))).replayed, true);
  assert.equal(repeated, 0); assert.deepEqual(await store.read(who), draft);
});

test('full L1 and keyword-only L2 pause intake; keyword-only L0 and unknown fields never approve text', async () => {
  for (const decision of [l1, { level: 'L2', mode: 'keyword_only' }]) {
    const who = await actor(); await text(who); const current = await claim(who);
    await store.processSafety(current, classifier(decision));
    const draft = await store.read(who); assert.equal(draft?.state, 'safety_paused'); assert.equal(draft?.safety?.level, decision.level);
    assert.equal(draft?.answersPartial.study, undefined);
  }
  for (const decision of [{ level: 'L0', mode: 'keyword_only' }, { ...l0, bypass: true }, { level: 'L9', mode: 'full' }]) {
    const who = await actor(), pending = await text(who), current = await claim(who);
    await assert.rejects(store.processSafety(current, classifier(decision)), code('INVALID_SAFETY_RESULT'));
    const draft = await store.read(who); assert.equal(draft?.state, 'safety_pending'); assert.equal(draft?.revision, pending.saved.draft.revision);
    assert.equal((await submission(current.submissionId)).result_ciphertext, null);
  }
});

test('reset auth version, expired claim or withdrawn/current legal consent blocks the actual classifier launch', async () => {
  for (const deny of ['auth', 'lease', 'consent', 'policy'] as const) {
    const who = await actor(); await text(who); const current = await claim(who); let launches = 0;
    if (deny === 'auth') await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
    if (deny === 'lease') await db.query("UPDATE platform_onboarding_safety_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [current.submissionId]);
    if (deny === 'consent') await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
    if (deny === 'policy') await db.query('UPDATE platform_terms_policy SET content_digest=$1 WHERE singleton=true', ['0'.repeat(64)]);
    try {
      await assert.rejects(store.processSafety(current, classifier(l0, () => { launches++; })), code({ auth: 'AUTH_REQUIRED', lease: 'ONBOARDING_SAFETY_CLAIM_CHANGED', consent: 'TERMS_CONFIRMATION_REQUIRED', policy: 'LEGAL_DOCUMENTS_UNAVAILABLE' }[deny]));
      assert.equal(launches, 0); assert.equal((await submission(current.submissionId)).result_ciphertext, null);
    } finally { if (deny === 'policy') await seedFictionalActiveLegal(db); }
  }
});

test('a callback returning a result without invoking admission cannot persist an approval', async () => {
  const who = await actor(), pending = await text(who), current = await claim(who);
  await assert.rejects(store.processSafety(current, async () => l0), code('INVALID_SAFETY_RESULT'));
  assert.equal((await store.read(who))?.revision, pending.saved.draft.revision); assert.equal((await submission(current.submissionId)).result_ciphertext, null);
});

test('classifier waits outside database locks; lease expiry fences its late result and a new generation recovers', { timeout: 10_000 }, async () => {
  const who = await actor(), pending = await text(who), current = await claim(who);
  let started!: () => void, finish!: (value: unknown) => void;
  const launched = new Promise<void>(resolve => { started = resolve; });
  const processing = store.processSafety(current, async (_input, admission) => admission(() => {
    started(); return new Promise<unknown>(resolve => { finish = resolve; });
  })); processing.catch(() => {});
  try {
    await Promise.race([launched, processing.then(() => { throw new Error('The fixture completed without a classifier launch.'); })]);
    // This UPDATE must complete while the classifier's asynchronous response is still unresolved.
    await db.withBoundedTransaction(async client => {
      await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [who.userId]);
      await client.query("UPDATE platform_onboarding_safety_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [current.submissionId]);
    });
    finish(l0); await assert.rejects(processing, code('ONBOARDING_SAFETY_CLAIM_CHANGED'));
    assert.equal((await store.read(who))?.revision, pending.saved.draft.revision);
    const recovered = await claim(who); assert.equal(recovered.submissionId, current.submissionId); assert.equal(recovered.generation, current.generation+1); assert.notEqual(recovered.leaseToken, current.leaseToken);
    const receipt = await store.processSafety(recovered, classifier(l0)); assert.equal(receipt.advanced, true);
    await assert.rejects(store.processSafety(current, classifier(l0)), code('ONBOARDING_SAFETY_CLAIM_CHANGED'));
  } finally { finish?.(l0); await processing.catch(() => {}); }
});

test('legal consent can be withdrawn during a classifier wait and its late result is not applied', { timeout: 10_000 }, async () => {
  const who = await actor(), pending = await text(who), current = await claim(who);
  let started!: () => void, finish!: (value: unknown) => void;
  const launched = new Promise<void>(resolve => { started = resolve; });
  const processing = store.processSafety(current, async (_input, admission) => admission(() => {
    started(); return new Promise<unknown>(resolve => { finish = resolve; });
  })); processing.catch(() => {});
  try {
    await Promise.race([launched, processing.then(() => { throw new Error('The fixture completed without a classifier launch.'); })]); await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
    finish(l0); await assert.rejects(processing, code('TERMS_CONFIRMATION_REQUIRED'));
    await seedFictionalConsent(db, who.userId);
    assert.equal((await store.read(who))?.revision, pending.saved.draft.revision); assert.equal((await submission(current.submissionId)).result_ciphertext, null);
  } finally { finish?.(l0); await processing.catch(() => {}); }
});

test('an unavailable or timed-out detector records a bounded retryable failure without inventing L0', async () => {
  for (const failure of ['unavailable', 'timeout', 'invalid_result'] as const) {
    const who = await actor(), pending = await text(who), current = await claim(who);
    await store.failSafety(current, failure);
    const row = await submission(current.submissionId);
    assert.equal(row.status, 'pending'); assert.equal(row.failure, failure); assert.equal(row.level, null); assert.equal(row.result_ciphertext, null);
    assert.equal((await store.read(who))?.revision, pending.saved.draft.revision); assert.equal((await store.read(who))?.state, 'safety_pending');
    const retry = await claim(who); assert.equal(retry.generation, current.generation+1);
    await assert.rejects(store.failSafety(current, failure), code('ONBOARDING_SAFETY_CLAIM_CHANGED')); await store.processSafety(retry, classifier(l0));
  }
});

test('damaged encrypted text cannot launch a classifier and transplanted encrypted result cannot replay', async () => {
  const who = await actor(), submitted = await text(who), current = await claim(who); let launches = 0;
  await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, submitted.input.operationId, Buffer.alloc(29)]);
  await assert.rejects(store.processSafety(current, classifier(l0, () => { launches++; })), code('DATA_STORAGE_UNAVAILABLE')); assert.equal(launches, 0);
  const a = await actor(), b = await actor(); await text(a); await text(b); const aClaim = await claim(a), bClaim = await claim(b);
  await store.processSafety(aClaim, classifier(l0)); await store.processSafety(bClaim, classifier(l0));
  const aRow = await submission(aClaim.submissionId), bDraft = await store.read(b);
  await db.query('UPDATE platform_onboarding_safety_submissions SET result_ciphertext=$2 WHERE id=$1', [bClaim.submissionId, aRow.result_ciphertext]);
  await assert.rejects(store.processSafety(bClaim, classifier(l2, () => { launches++; })), code('DATA_STORAGE_UNAVAILABLE'));
  assert.equal(launches, 0); await assert.rejects(store.read(b), code('DATA_STORAGE_UNAVAILABLE'));
  assert.equal((await db.query('SELECT revision FROM platform_onboarding_drafts WHERE user_id=$1', [b.userId])).rows[0].revision, bDraft!.revision);
});

test('foreign keys forbid assigning an existing encrypted operation or draft to a different inbox owner', async () => {
  const a = await actor(), b = await actor(), submitted = await text(a); await text(b);
  const row = (await db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1', [a.userId])).rows[0];
  await assert.rejects(db.query('UPDATE platform_onboarding_safety_submissions SET user_id=$2 WHERE id=$1', [row.id, b.userId]), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '23503');
  assert.equal((await submission(row.id)).user_id, a.userId); assert.equal(row.operation_id, submitted.input.operationId);
});

test('a deferred COMMIT rejection rolls back the text, operation and inbox together', async () => {
  const who = await actor(); await store.save(who, command(0, { kind: 'start', mode: 'standard' })); const previous = await store.read(who);
  let functionCreated = false;
  try {
    await db.query(`CREATE FUNCTION fictional_reject_safety_enqueue_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${who.userId}'::uuid THEN RAISE EXCEPTION 'Fictional deferred inbox rejected'; END IF; RETURN NEW; END $$`);
    functionCreated = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_safety_enqueue_commit_gate AFTER INSERT ON platform_onboarding_safety_submissions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_safety_enqueue_commit()`);
    await assert.rejects(text(who), /Fictional deferred inbox rejected/);
    assert.deepEqual(await counts(who), { drafts: 1, operations: 1, submissions: 0 }); assert.deepEqual(await store.read(who), previous);
  } finally { if (functionCreated) await db.query('DROP FUNCTION fictional_reject_safety_enqueue_commit() CASCADE'); }
});

test('a deferred result COMMIT rejection exposes no completion and requires a new fenced execution generation', async () => {
  const who = await actor(), pending = await text(who), current = await claim(who);
  let functionCreated = false;
  try {
    await db.query(`CREATE FUNCTION fictional_reject_safety_result_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${who.userId}'::uuid AND NEW.status='detected' THEN RAISE EXCEPTION 'Fictional deferred detector rejected'; END IF; RETURN NEW; END $$`);
    functionCreated = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_safety_result_commit_gate AFTER UPDATE ON platform_onboarding_safety_submissions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_safety_result_commit()`);
    await assert.rejects(store.processSafety(current, classifier(l0)), /Fictional deferred detector rejected/);
    const row = await submission(current.submissionId); assert.equal(row.status, 'running'); assert.equal(row.result_ciphertext, null);
    assert.equal((await store.read(who))?.revision, pending.saved.draft.revision); assert.equal((await store.read(who))?.state, 'safety_pending');
  } finally { if (functionCreated) await db.query('DROP FUNCTION fictional_reject_safety_result_commit() CASCADE'); }
  await store.failSafety(current, 'unavailable');
  const retry = await claim(who); assert.equal(retry.submissionId, current.submissionId); assert.equal(retry.generation, current.generation+1);
  await assert.rejects(store.processSafety(current, classifier(l0)), code('ONBOARDING_SAFETY_CLAIM_CHANGED'));
  assert.equal((await store.processSafety(retry, classifier(l0))).advanced, true);
});

test('database-clock expiry during a proven legal-policy lock wait blocks classifier launch', { timeout: 10_000 }, async () => {
  const who = await actor(); await text(who); const current = await claim(who), lock = await db.pool.connect();
  let pending: ReturnType<OnboardingDrafts['processSafety']> | undefined, launches = 0;
  try {
    await db.query("UPDATE platform_onboarding_safety_submissions SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1", [current.submissionId]);
    await lock.query('BEGIN'); const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT singleton FROM platform_terms_policy WHERE singleton=true FOR UPDATE');
    pending = store.processSafety(current, classifier(l0, () => { launches++; })); pending.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%platform_terms_policy%' AND $1=ANY(pg_blocking_pids(pid))", [blocker]);
      if (waiting.rowCount) { blocked = true; break; } await new Promise(resolve => setTimeout(resolve, 3));
    }
    assert(blocked, 'The actual safety admission query must be blocked by this policy lock.');
    await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(lease_until-clock_timestamp())))+0.01) FROM platform_onboarding_safety_submissions WHERE id=$1', [current.submissionId]);
    assert.equal((await db.query('SELECT lease_until<=clock_timestamp() AS expired FROM platform_onboarding_safety_submissions WHERE id=$1', [current.submissionId])).rows[0].expired, true);
    await lock.query('COMMIT'); await assert.rejects(pending, code('ONBOARDING_SAFETY_CLAIM_CHANGED'));
    assert.equal(launches, 0); assert.equal((await submission(current.submissionId)).result_ciphertext, null);
  } finally { try { await lock.query('ROLLBACK'); } finally { lock.release(); await pending?.catch(() => {}); } }
});

test('pre-aborted operations cannot claim, classify or fail a persistent submission', async () => {
  const who = await actor(), pending = await text(who), controller = new AbortController(); controller.abort();
  await assert.rejects(store.claimSafety(who, { detectorRevision: 7 }, controller.signal), { name: 'AbortError' });
  const current = await claim(who); let launches = 0;
  await assert.rejects(store.processSafety(current, classifier(l0, () => { launches++; }), controller.signal), { name: 'AbortError' });
  await assert.rejects(store.failSafety(current, 'unavailable', controller.signal), { name: 'AbortError' });
  const row = await submission(current.submissionId); assert.equal(row.status, 'running'); assert.equal(row.result_ciphertext, null);
  assert.equal(launches, 0); assert.equal((await store.read(who))?.revision, pending.saved.draft.revision);
});

test('recovery from a pre-inbox database restores every encrypted historical text, including superseded ones', async () => {
  const who = await actor(), a = await text(who, 'Synthetic pre-inbox older note A.'), b = await text(who, 'Synthetic pre-inbox newer note B.');
  await db.query('DELETE FROM platform_onboarding_safety_submissions WHERE user_id=$1', [who.userId]);
  assert.deepEqual(await counts(who), { drafts: 1, operations: 3, submissions: 0 });
  const fresh = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
  assert.deepEqual(await fresh.read(who), b.saved.draft);
  const restored = (await db.query('SELECT operation_id FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision', [who.userId])).rows.map(row => row.operation_id);
  assert.deepEqual(restored, [a.input.operationId, b.input.operationId]);
  assert.deepEqual(await fresh.readSafety(who), { status: 'pending', pendingCount: 2, blockedLevel: null });
  const current = await fresh.claimSafety(who, { detectorRevision: 7 }); assert(current); assert.equal(current.operationId, a.input.operationId);
  assert.deepEqual(await counts(who), { drafts: 1, operations: 3, submissions: 2 });
});

test('a damaged historical encrypted operation rolls back all inbox recovery rather than dropping older text', async () => {
  const who = await actor(); await text(who, 'Synthetic valid earlier backfill A.'); const broken = await text(who, 'Synthetic damaged later backfill B.');
  await db.query('DELETE FROM platform_onboarding_safety_submissions WHERE user_id=$1', [who.userId]);
  await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, broken.input.operationId, Buffer.alloc(29)]);
  const fresh = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
  for (const attempt of [() => fresh.read(who), () => fresh.readSafety(who), () => fresh.claimSafety(who, { detectorRevision: 7 })]) {
    await assert.rejects(attempt(), code('DATA_STORAGE_UNAVAILABLE'));
    assert.deepEqual(await counts(who), { drafts: 1, operations: 3, submissions: 0 });
  }
});

test('a pending draft must reference its actual encrypted text operation and matching submitted revision', async () => {
  const who = await actor(), a = await text(who), b = await text(who);
  const binding = { table: 'platform_onboarding_drafts', column: 'payload_ciphertext', rowId: b.saved.draft.id, ownerId: who.userId, revision: b.saved.draft.revision };
  for (const id of [randomUUID(), a.input.operationId]) {
    const malformed = { ...b.saved.draft, pendingText: { ...b.saved.draft.pendingText!, id } };
    await db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [who.userId, crypto.sealUtf8(JSON.stringify(malformed), binding)]);
    await assert.rejects(store.read(who), code('DATA_STORAGE_UNAVAILABLE'));
    await assert.rejects(store.claimSafety(who, { detectorRevision: 7 }), code('DATA_STORAGE_UNAVAILABLE'));
    const rows = (await db.query('SELECT generation,status FROM platform_onboarding_safety_submissions WHERE user_id=$1', [who.userId])).rows;
    assert(rows.every(row => row.generation === 0 && row.status === 'pending'));
  }
});

test('plaintext result projection corruption cannot erase an authenticated L1 barrier or replay it as L0', async () => {
  const who = await actor(); await text(who); const current = await claim(who); await store.processSafety(current, classifier(l1));
  await db.query("UPDATE platform_onboarding_safety_submissions SET level='L0' WHERE id=$1", [current.submissionId]);
  for (const attempt of [() => store.read(who), () => store.readSafety(who), () => store.processSafety(current, classifier(l0))]) await assert.rejects(attempt(), code('DATA_STORAGE_UNAVAILABLE'));
  const row = await submission(current.submissionId); assert.equal(row.level, 'L0'); assert.equal(row.status, 'detected');
});

test('a failed admitted request caught by the classifier cannot be converted into an invented L0 result', async () => {
  const who = await actor(), pending = await text(who), current = await claim(who); let launches = 0;
  await assert.rejects(store.processSafety(current, async (_input, admission) => {
    try { await admission(async () => { launches++; throw new Error('Synthetic unavailable classifier transport.'); }); } catch {}
    return l0;
  }), code('INVALID_SAFETY_RESULT'));
  assert.equal(launches, 1); assert.equal((await store.read(who))?.revision, pending.saved.draft.revision); assert.equal((await submission(current.submissionId)).result_ciphertext, null);
});

test('one generation starts one classifier execution; a concurrent same-claim attempt cannot replace an in-flight L2 with L0', { timeout: 10_000 }, async () => {
  const who = await actor(); await text(who); const current = await claim(who);
  let started!: () => void, finish!: (value: unknown) => void, callbacks = 0, launches = 0;
  const launched = new Promise<void>(resolve => { started = resolve; });
  const processing = store.processSafety(current, async (_input, admission) => {
    callbacks++;
    return admission(() => { launches++; started(); return new Promise<unknown>(resolve => { finish = resolve; }); });
  }); processing.catch(() => {});
  try {
    await Promise.race([launched, processing.then(() => { throw new Error('The first fixture completed without launch.'); })]);
    await assert.rejects(store.processSafety(current, async (_input, admission) => {
      callbacks++; return admission(async () => { launches++; return l0; });
    }), code('ONBOARDING_SAFETY_CLAIM_CHANGED'));
    assert.equal(callbacks, 1); assert.equal(launches, 1);
    finish(l2); const receipt = await processing; assert.equal(receipt.status, 'detected');
    assert.equal((await submission(current.submissionId)).level, 'L2');
    assert.deepEqual(await store.readSafety(who), { status: 'blocked', pendingCount: 0, blockedLevel: 'L2' });
    const draft = await store.read(who); assert.equal(draft?.state, 'safety_paused'); assert.equal(draft?.answersPartial.study, undefined);
  } finally { finish?.(l2); await processing.catch(() => {}); }
});

test('an actual outer admission COMMIT failure aborts a delayed inner request before it can launch', { timeout: 10_000 }, async () => {
  const who = await actor(), submitted = await text(who), current = await claim(who);
  // Both authorization transactions use real PostgreSQL. The subclass only inserts a
  // fictional deferred-trigger marker into the second (outer-launch) transaction.
  class OuterCommitFailureDatabase extends Database {
    transactionCount = 0;
    override withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}): Promise<T> {
      const transactionNumber = ++this.transactionCount;
      return super.withBoundedTransaction(async client => {
        const value = await run(client);
        if (transactionNumber === 2) await client.query('INSERT INTO fictional_safety_outer_commit_marker(id) VALUES(1)');
        return value;
      }, options);
    }
  }
  const failingDb = new OuterCommitFailureDatabase(url.toString()), failingStore = new OnboardingDrafts(failingDb, config, FICTIONAL_LEGAL);
  let tableCreated = false, functionCreated = false, delayedAdmission: ProviderRequestAdmission | undefined, finish: ((value: unknown) => void) | undefined;
  let classifierCallbacks = 0, actualRequests = 0;
  try {
    await db.query('CREATE TABLE fictional_safety_outer_commit_marker(id integer PRIMARY KEY)'); tableCreated = true;
    await db.query(`CREATE FUNCTION fictional_reject_safety_outer_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Fictional outer admission commit rejected'; END $$`); functionCreated = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_safety_outer_commit_gate AFTER INSERT ON fictional_safety_outer_commit_marker
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_safety_outer_commit()`);
    await assert.rejects(failingStore.processSafety(current, async (_input, admission) => {
      classifierCallbacks++; delayedAdmission = admission;
      return new Promise<unknown>(resolve => { finish = resolve; });
    }), /Fictional outer admission commit rejected/);
    assert.equal(failingDb.transactionCount, 2); assert.equal(classifierCallbacks, 1); assert(delayedAdmission);
    assert.equal((await db.query('SELECT count(*)::int AS markers FROM fictional_safety_outer_commit_marker')).rows[0].markers, 0, 'The real deferred COMMIT failure must roll back its marker.');
    // Invoking the captured genuine admission after COMMIT rejection must observe
    // the outer cancellation, even though the persisted account/claim remain valid.
    await assert.rejects(delayedAdmission(async () => { actualRequests++; return l0; }), { name: 'AbortError' });
    assert.equal(actualRequests, 0);
    assert.equal((await submission(current.submissionId)).status, 'running');
    assert.equal((await submission(current.submissionId)).result_ciphertext, null);
    assert.equal((await store.read(who))?.revision, submitted.saved.draft.revision);
    assert.equal((await store.read(who))?.state, 'safety_pending');
  } finally {
    finish?.(l0);
    try { await failingDb.close(); }
    finally {
      try { if (functionCreated) await db.query('DROP FUNCTION fictional_reject_safety_outer_commit() CASCADE'); }
      finally { if (tableCreated) await db.query('DROP TABLE fictional_safety_outer_commit_marker'); }
    }
  }
});

test('the built-in detector deadline aborts a real admitted wait and fences its late response from a new generation', { timeout: 10_000 }, async () => {
  const who = await actor(), submitted = await text(who), current = await claim(who);
  let started!: () => void, drained!: () => void, finish: ((value: unknown) => void) | undefined, fixtureSignal: AbortSignal | undefined;
  let actualRequests = 0;
  const launched = new Promise<void>(resolve => { started = resolve; }), classifierDrained = new Promise<void>(resolve => { drained = resolve; });
  const processing = store.processSafety(current, async (_input, admission) => {
    try {
      return await admission(signal => {
        actualRequests++; fixtureSignal = signal; started();
        return new Promise<unknown>(resolve => { finish = resolve; });
      });
    } finally { drained(); }
  }); processing.catch(() => {});
  try {
    await Promise.race([launched, processing.then(() => { throw new Error('The fixture completed without launch.'); })]);
    await assert.rejects(processing, code('ONBOARDING_SAFETY_UNAVAILABLE'));
    assert.equal(actualRequests, 1); assert(fixtureSignal); assert.equal(fixtureSignal.aborted, true); assert.equal(fixtureSignal.reason?.name, 'TimeoutError');
    const failed = await submission(current.submissionId);
    assert.equal(failed.status, 'pending'); assert.equal(failed.failure, 'timeout'); assert.equal(failed.execution_token, null); assert.equal(failed.lease_token, null); assert.equal(failed.result_ciphertext, null); assert.equal(failed.level, null);
    assert.equal((await store.read(who))?.revision, submitted.saved.draft.revision); assert.equal((await store.read(who))?.state, 'safety_pending');
    const recovered = await claim(who); assert.equal(recovered.generation, current.generation+1);
    finish!(l2); await classifierDrained;
    const afterLate = await submission(current.submissionId);
    assert.equal(afterLate.generation, recovered.generation); assert.equal(afterLate.status, 'running'); assert.equal(afterLate.lease_token, recovered.leaseToken); assert.equal(afterLate.execution_token, null); assert.equal(afterLate.result_ciphertext, null); assert.equal(afterLate.failure, null);
    await assert.rejects(store.processSafety(current, classifier(l2, () => { actualRequests++; })), code('ONBOARDING_SAFETY_CLAIM_CHANGED')); assert.equal(actualRequests, 1);
    assert.equal((await store.processSafety(recovered, classifier(l0))).advanced, true);
    assert.equal((await submission(recovered.submissionId)).level, 'L0');
  } finally { finish?.(l0); await processing.catch(() => {}); if (finish) await classifierDrained; }
});
