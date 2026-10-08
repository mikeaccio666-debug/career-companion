import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OnboardingAction, OnboardingDraft, OnboardingScenarioQuestion, ProviderRequestAdmission } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { CompanionIntakePreparation } from '../src/companion-intake-preparation.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';
import { withControlledMissingIntakeSafetySource } from './fixtures/controlled-missing-intake.ts';

// Fictional actors and text in one isolated loopback PostgreSQL schema. The existing
// classifier port invokes genuine admission with synthetic decisions; no HTTP,
// model provider, clinical approval, companion birth or student release is involved.
const base = readConfig(), schema = 'companion_intake_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use only isolated loopback PostgreSQL.');
url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: 'c7'.repeat(32) })!;
const config = { dataCrypto: crypto, requireVerifiedEmail: true };
const store = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
const service = new CompanionIntakePreparation(db, config, FICTIONAL_LEGAL);
let created = false;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true;
  await db.migrate(); await seedFictionalActiveLegal(db);
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
const code = (expected: string, status?: number) => (error: unknown) => error instanceof ApiError
  && error.code === expected && (status === undefined || error.status === status);
const command = (expectedRevision: number, action: OnboardingAction) => ({ expectedRevision, operationId: randomUUID(), action });
const neutral = { warmth: 0, directness: 0, drive: 0, structure: 0, levity: 0, code_mix: 0, length: 'medium' };
const scenarios: readonly OnboardingScenarioQuestion[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'];
async function actor(options: { verified?: boolean; consented?: boolean; kind?: 'student' | 'staff' } = {}): Promise<FixedSessionContext> {
  const userId = randomUUID(), hash = tokenHash(randomUUID());
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional preparation student','fictional-unused-hash',$3,$4)`,
  [userId, userId + '@example.invalid', options.kind ?? 'student', options.verified === false ? null : new Date()]);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, hash]);
  if (options.consented !== false) await seedFictionalConsent(db, userId);
  return { userId, tokenHash: hash };
}
async function save(who: FixedSessionContext, draft: OnboardingDraft, action: OnboardingAction) {
  return (await store.save(who, command(draft.revision, action))).draft;
}
async function finishWithSkips(who: FixedSessionContext, draft: OnboardingDraft) {
  while (draft.currentQuestion) draft = await save(who, draft, { kind: 'skip', questionId: draft.currentQuestion });
  assert.equal(draft.state, 'intake_ready'); return draft;
}
async function fast(who: FixedSessionContext) {
  const first = (await store.save(who, command(0, { kind: 'start', mode: 'fast_track' }))).draft;
  return finishWithSkips(who, first);
}
function classifier(decision: unknown, check?: (input: { text: string; questionId: string }) => void) {
  return async (input: { text: string; questionId: string }, admission: ProviderRequestAdmission) => admission(async signal => {
    signal.throwIfAborted(); check?.(input); return decision;
  });
}
async function claim(who: FixedSessionContext) {
  const value = await store.claimSafety(who, { detectorRevision: 29 });
  assert(value, 'The fixture must claim an actual encrypted operation.'); return value;
}
async function full(who: FixedSessionContext, choices: readonly string[], extra?: string) {
  let draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  while (draft.step === 'O2') {
    assert(draft.currentQuestion); draft = await save(who, draft, { kind: 'skip', questionId: draft.currentQuestion });
  }
  for (const [index, questionId] of scenarios.entries()) draft = await save(who, draft,
    { kind: 'answer', questionId, value: choices[index] } as OnboardingAction);
  assert.equal(draft.currentQuestion, 'extra');
  if (extra === undefined) return save(who, draft, { kind: 'skip', questionId: 'extra' });
  draft = await save(who, draft, { kind: 'text', questionId: 'extra', text: extra });
  const current = await claim(who); assert.equal(current.questionId, 'extra');
  await store.processSafety(current, classifier({ level: 'L0', mode: 'full' }, input => assert.deepEqual(input, { text: extra, questionId: 'extra' })));
  const ready = await store.read(who); assert(ready); return ready;
}
async function history(who: FixedSessionContext, olderLevel: 'L0' | 'L1' | 'L2' = 'L0', olderMode: 'full' | 'keyword_only' = 'full') {
  let draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  const older = command(draft.revision, { kind: 'text', questionId: 'study', text: 'Synthetic superseded preparation note A.' });
  draft = (await store.save(who, older)).draft;
  const newer = command(draft.revision, { kind: 'text', questionId: 'study', text: 'Synthetic current preparation note B.' });
  draft = (await store.save(who, newer)).draft;
  const oldClaim = await claim(who), newClaim = await claim(who);
  assert.equal(oldClaim.operationId, older.operationId); assert.equal(newClaim.operationId, newer.operationId);
  await store.processSafety(newClaim, classifier({ level: 'L0', mode: 'full', resolution: { kind: 'unmatched' } }));
  await store.processSafety(oldClaim, classifier(olderLevel === 'L0'
    ? { level: 'L0', mode: 'full', resolution: { kind: 'unmatched' } }
    : { level: olderLevel, mode: olderMode }));
  const current = await store.read(who); assert(current);
  return { draft: olderLevel === 'L0' ? await finishWithSkips(who, current) : current, older, newer, oldClaim, newClaim };
}
async function ledger(who: FixedSessionContext) {
  const results = await Promise.all([
    db.query('SELECT * FROM platform_onboarding_drafts WHERE user_id=$1 ORDER BY id', [who.userId]),
    db.query('SELECT * FROM platform_onboarding_operations WHERE user_id=$1 ORDER BY applied_revision,operation_id', [who.userId]),
    db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision,id', [who.userId]),
    db.query(`SELECT
      (SELECT count(*)::int FROM platform_conversations WHERE user_id=$1) AS rooms,
      (SELECT count(*)::int FROM platform_memories WHERE user_id=$1) AS memories,
      (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs,
      (SELECT count(*)::int FROM platform_safety_events WHERE user_id=$1) AS safety_events,
      (SELECT count(*)::int FROM platform_onboarding_safety_responses WHERE user_id=$1) AS safety_responses`, [who.userId]),
  ]);
  return { drafts: results[0].rows, operations: results[1].rows, submissions: results[2].rows, effects: results[3].rows[0] };
}
async function waitForPolicyBlock(blocker: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%platform_terms_policy%' AND $1=ANY(pg_blocking_pids(pid))", [blocker]);
    if (result.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail('The actual preparation policy query must be blocked by this fixture.');
}
async function release(lock: PoolClient, pending?: Promise<unknown>) {
  try { await lock.query('ROLLBACK'); }
  finally { lock.release(); await pending?.catch(() => {}); }
}

test('missing or incomplete intake cannot become a personality preparation or initialize records', async () => {
  const who = await actor(), before = await ledger(who);
  await assert.rejects(service.prepare(who, { expectedRevision: 0 }), code('NOT_FOUND', 404));
  assert.deepEqual(await ledger(who), before);
  const first = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  await assert.rejects(service.prepare(who, { expectedRevision: first.revision }), code('ONBOARDING_STATE_CHANGED', 409));
  const stored = await ledger(who); assert.equal(stored.drafts.length, 1); assert.equal(stored.operations.length, 1);
  assert.deepEqual(stored.effects, { rooms: 0, memories: 0, jobs: 0, safety_events: 0, safety_responses: 0 });
});

test('a complete fast intake produces a frozen neutral snapshot across service restarts without creating work', async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who);
  const first = await service.prepare(who, { expectedRevision: draft.revision });
  assert.deepEqual(first, { draftId: draft.id, draftRevision: draft.revision, questionnaireRevision: 1, rulesRevision: 1, dimensions: neutral });
  assert(Object.isFrozen(first)); assert(Object.isFrozen(first.dimensions));
  const fresh = new CompanionIntakePreparation(db, config, FICTIONAL_LEGAL);
  assert.deepEqual(await fresh.prepare(who, { expectedRevision: draft.revision }), first);
  assert.deepEqual(await ledger(who), before);
});

test('all seven actual scenario answers reach the ordered mapping without copying private O4 context', async () => {
  const who = await actor(), raw = '说话直一点，别灌鸡汤；短一点也不错；Synthetic private story with no inferred preference.';
  const draft = await full(who, ['C', 'C', 'D', 'B', 'C', 'B', 'C'], raw), before = await ledger(who);
  const prepared = await service.prepare(who, { expectedRevision: draft.revision });
  assert.deepEqual(prepared.dimensions, { warmth: -1, directness: 1, drive: -1, structure: 1, levity: -1, code_mix: 0, length: 'medium' });
  assert.deepEqual(Object.keys(prepared).sort(), ['dimensions', 'draftId', 'draftRevision', 'questionnaireRevision', 'rulesRevision']);
  assert.equal(JSON.stringify(prepared).includes(raw), false); assert.equal(JSON.stringify(prepared).includes('Synthetic private story'), false);
  assert.deepEqual(await ledger(who), before);
});

test('only classified O4 text changes communication dimensions; matching words in a basic-fact answer are not preferences', async () => {
  const who = await actor(); let draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  const raw = '别催我，别灌鸡汤，少开玩笑，多用中文；Synthetic fictional study note.';
  draft = await save(who, draft, { kind: 'text', questionId: 'study', text: raw });
  const current = await claim(who);
  await store.processSafety(current, classifier({ level: 'L0', mode: 'full', resolution: { kind: 'answer', questionId: 'study', value: { degreeField: 'ds_statistics', programChoice: null } } }));
  draft = (await store.read(who))!;
  while (draft.step === 'O2') { assert(draft.currentQuestion); draft = await save(who, draft, { kind: 'skip', questionId: draft.currentQuestion }); }
  const choices = ['D', 'A', 'B', 'D', 'A', 'A', 'A'];
  for (const [index, questionId] of scenarios.entries()) draft = await save(who, draft,
    { kind: 'answer', questionId, value: choices[index] } as OnboardingAction);
  draft = await save(who, draft, { kind: 'skip', questionId: 'extra' });
  const before = await ledger(who), prepared = await service.prepare(who, { expectedRevision: draft.revision });
  assert.deepEqual(prepared.dimensions, { warmth: 1, directness: -1, drive: 1, structure: 0, levity: 1, code_mix: 1, length: 'short' });
  assert.equal(JSON.stringify(prepared).includes(raw), false); assert.deepEqual(await ledger(who), before);
});

test('O4 explicit preferences apply after scenario caps, using the actual encrypted classified operation', async () => {
  const who = await actor(), draft = await full(who, ['B', 'C', 'A', 'A', 'C', 'B', 'B'], '说话直一点，别催我，短一点，多用英文');
  const prepared = await service.prepare(who, { expectedRevision: draft.revision });
  assert.deepEqual(prepared.dimensions, { warmth: 1, directness: 1, drive: 0, structure: 0, levity: 0, code_mix: 1, length: 'short' });
});

test('stale revisions and another owner session cannot read a current private preparation', async () => {
  const who = await actor(), other = await actor(), draft = await fast(who), before = await ledger(who);
  await assert.rejects(service.prepare(who, { expectedRevision: draft.revision - 1 }), code('ONBOARDING_REVISION_CHANGED', 409));
  await assert.rejects(service.prepare({ userId: who.userId, tokenHash: other.tokenHash }, { expectedRevision: draft.revision }), code('AUTH_REQUIRED', 401));
  await assert.rejects(service.prepare(other, { expectedRevision: draft.revision }), code('NOT_FOUND', 404));
  assert.deepEqual(await ledger(who), before);
});

test('the preparation command is closed and rejects spoofed persona, source approvals and accessor values', async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who); let accessed = 0;
  const getter = Object.defineProperty({}, 'expectedRevision', { enumerable: true, get() { accessed++; return draft.revision; } });
  for (const value of [null, [], {}, { expectedRevision: '7' }, { expectedRevision: -1 }, { expectedRevision: -0 },
    { expectedRevision: 0.5 }, { expectedRevision: Number.NaN }, { expectedRevision: 2147483648 },
    { expectedRevision: draft.revision, dimensions: neutral }, { expectedRevision: draft.revision, safety: { level: 'L0' } },
    { expectedRevision: draft.revision, classifiedText: 'Synthetic injected raw text.' },
    { expectedRevision: draft.revision, provider: 'fixture' }, { expectedRevision: draft.revision, companionId: randomUUID() }, getter]) {
    await assert.rejects(service.prepare(who, value), code('INVALID_INPUT', 400));
  }
  assert.equal(accessed, 0); assert.deepEqual(await ledger(who), before);
});

for (const [options, expected] of [
  [{ verified: false }, 'EMAIL_VERIFICATION_REQUIRED'], [{ consented: false }, 'TERMS_CONFIRMATION_REQUIRED'],
  [{ kind: 'staff' }, 'STUDENT_ACCOUNT_REQUIRED'],
] as const) test(`preparation authorizes the actual account before source access: ${expected}`, async () => {
  const who = await actor(options), before = await ledger(who);
  await assert.rejects(service.prepare(who, { expectedRevision: 0 }), code(expected, 403));
  assert.deepEqual(await ledger(who), before);
});

test('missing crypto or unavailable active legal documents cannot prepare even completed intake', async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who);
  await assert.rejects(new CompanionIntakePreparation(db, { requireVerifiedEmail: true }, FICTIONAL_LEGAL)
    .prepare(who, { expectedRevision: draft.revision }), code('DATA_STORAGE_UNAVAILABLE', 503));
  await assert.rejects(new CompanionIntakePreparation(db, config, null)
    .prepare(who, { expectedRevision: draft.revision }), code('LEGAL_DOCUMENTS_UNAVAILABLE', 503));
  try {
    await db.query("UPDATE platform_terms_policy SET content_digest=$1 WHERE singleton=true", ['0'.repeat(64)]);
    await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }), code('LEGAL_DOCUMENTS_UNAVAILABLE', 503));
  } finally { await seedFictionalActiveLegal(db); }
  assert.deepEqual(await ledger(who), before);
});

for (const deny of ['revoked', 'auth_version', 'expired', 'withdrawn_consent', 'stale_consent'] as const) test(`completed intake is not authorization after ${deny}`, async () => {
  const who = await actor(), draft = await fast(who);
  if (deny === 'revoked') await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
  if (deny === 'auth_version') await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
  if (deny === 'expired') await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [who.tokenHash]);
  if (deny === 'withdrawn_consent' || deny === 'stale_consent') await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
  if (deny === 'stale_consent') await db.query("INSERT INTO platform_terms_consents(user_id,terms_version,content_digest) VALUES($1,'fictional-old-policy',$2)", [who.userId, 'e'.repeat(64)]);
  const before = await ledger(who), expected = ['withdrawn_consent', 'stale_consent'].includes(deny) ? 'TERMS_CONFIRMATION_REQUIRED' : 'AUTH_REQUIRED';
  await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }), code(expected));
  assert.deepEqual(await ledger(who), before);
});

test('pending TEXT requires safety completion before reporting either an incomplete state or stale version', async () => {
  const who = await actor(); let draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  draft = await save(who, draft, { kind: 'text', questionId: 'study', text: 'Synthetic still-pending preparation note.' });
  const before = await ledger(who);
  await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }), code('ONBOARDING_SAFETY_REQUIRED', 409));
  await assert.rejects(service.prepare(who, { expectedRevision: draft.revision - 1 }), code('ONBOARDING_SAFETY_REQUIRED', 409));
  assert.deepEqual(await ledger(who), before);
});

test('a complete draft and latest full L0 cannot hide a superseded historical TEXT with a missing detection', async () => {
  const who = await actor(), current = await history(who);
  await withControlledMissingIntakeSafetySource(db, { ownedSchema: schema, userId: who.userId, submissionId: current.oldClaim.submissionId }, async () => {
    const before = await ledger(who); assert.equal(before.submissions.length, 1);
    for (const preparer of [service, new CompanionIntakePreparation(db, config, FICTIONAL_LEGAL)]) {
      await assert.rejects(preparer.prepare(who, { expectedRevision: current.draft.revision }), code('ONBOARDING_SAFETY_REQUIRED', 409));
      // Recovery inserts are inside the failed preparation transaction, never silently committed.
      assert.deepEqual(await ledger(who), before);
    }
  });
});

for (const [level, mode] of [['L1', 'full'], ['L2', 'keyword_only']] as const) test(`the latest full L0 cannot erase a genuine superseded ${level}/${mode} barrier`, async () => {
  const who = await actor(), current = await history(who, level, mode), before = await ledger(who);
  assert.equal(before.submissions.find(row => row.id === current.newClaim.submissionId).level, 'L0');
  assert.equal(before.submissions.find(row => row.id === current.oldClaim.submissionId).level, level);
  await assert.rejects(service.prepare(who, { expectedRevision: current.draft.revision }), code('ONBOARDING_SAFETY_REVIEW_REQUIRED', 409));
  assert.deepEqual(await ledger(who), before);
});

for (const damaged of ['older_operation', 'older_result', 'older_result_projection'] as const) test(`preparation authenticates every superseded source, including ${damaged}`, async () => {
  const who = await actor(), current = await history(who);
  if (damaged === 'older_operation') await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, current.older.operationId, Buffer.alloc(29)]);
  if (damaged === 'older_result') await db.query('UPDATE platform_onboarding_safety_submissions SET result_ciphertext=$2 WHERE id=$1', [current.oldClaim.submissionId, Buffer.alloc(29)]);
  if (damaged === 'older_result_projection') await db.query("UPDATE platform_onboarding_safety_submissions SET level='L1' WHERE id=$1", [current.oldClaim.submissionId]);
  const before = await ledger(who);
  await assert.rejects(service.prepare(who, { expectedRevision: current.draft.revision }), code('DATA_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(await ledger(who), before);
});

test('transplanted O4 request or detection ciphertext cannot supply another owner preferences', async () => {
  const a = await actor(), b = await actor(), aDraft = await full(a, ['A', 'A', 'A', 'A', 'A', 'A', 'A'], '多用中文'), bDraft = await full(b, ['B', 'B', 'B', 'B', 'B', 'B', 'B'], '多用英文');
  const aLedger = await ledger(a), original = await ledger(b);
  const aExtra = aDraft.answersPartial.extra, bExtra = bDraft.answersPartial.extra;
  assert(aExtra?.kind === 'answered'); assert(bExtra?.kind === 'answered');
  const aOperation = aLedger.operations.find(row => row.operation_id === aExtra.value.textId);
  const bOperation = original.operations.find(row => row.operation_id === bExtra.value.textId);
  assert(aOperation); assert(bOperation);
  await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [b.userId, bOperation.operation_id, aOperation.request_ciphertext]);
  await assert.rejects(service.prepare(b, { expectedRevision: bDraft.revision }), code('DATA_STORAGE_UNAVAILABLE', 503));
  await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [b.userId, bOperation.operation_id, bOperation.request_ciphertext]);
  await db.query('UPDATE platform_onboarding_safety_submissions SET result_ciphertext=$2 WHERE id=$1', [original.submissions[0].id, aLedger.submissions[0].result_ciphertext]);
  await assert.rejects(service.prepare(b, { expectedRevision: bDraft.revision }), code('DATA_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(await ledger(a), aLedger);
  assert.equal((await ledger(b)).drafts[0].revision, bDraft.revision);
});

test('the command and fixed session are snapshots while the real policy query waits', { timeout: 10_000 }, async () => {
  const who = await actor(), other = await actor(), draft = await fast(who), before = await ledger(who), lock = await db.pool.connect();
  const context = { ...who }, input = { expectedRevision: draft.revision };
  let pending: ReturnType<CompanionIntakePreparation['prepare']> | undefined;
  try {
    await lock.query('BEGIN'); const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT singleton FROM platform_terms_policy WHERE singleton=true FOR UPDATE');
    pending = service.prepare(context, input); pending.catch(() => {}); await waitForPolicyBlock(blocker);
    context.userId = other.userId; context.tokenHash = other.tokenHash; input.expectedRevision = 0;
    await lock.query('COMMIT'); const prepared = await pending;
    assert.equal(prepared.draftId, draft.id); assert.equal(prepared.draftRevision, draft.revision);
    assert.deepEqual(prepared.dimensions, neutral); assert.deepEqual(await ledger(who), before);
  } finally { await release(lock, pending); }
});

test('session expiry during a proven policy wait prevents returning a preparation', { timeout: 10_000 }, async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who), lock = await db.pool.connect();
  let pending: ReturnType<CompanionIntakePreparation['prepare']> | undefined;
  try {
    await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE token_hash=$1", [who.tokenHash]);
    await lock.query('BEGIN'); const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT singleton FROM platform_terms_policy WHERE singleton=true FOR UPDATE');
    pending = service.prepare(who, { expectedRevision: draft.revision }); pending.catch(() => {}); await waitForPolicyBlock(blocker);
    await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.01) FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
    assert.equal((await db.query('SELECT expires_at<=clock_timestamp() AS expired FROM platform_sessions WHERE token_hash=$1', [who.tokenHash])).rows[0].expired, true);
    await lock.query('COMMIT'); await assert.rejects(pending, code('AUTH_REQUIRED', 401));
    assert.deepEqual(await ledger(who), before);
  } finally { await release(lock, pending); }
});

test('cancellation before admission or during a proven lock wait never produces work', { timeout: 10_000 }, async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who), already = new AbortController(); already.abort();
  await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }, already.signal), { name: 'AbortError' });
  const lock = await db.pool.connect(), controller = new AbortController();
  let pending: ReturnType<CompanionIntakePreparation['prepare']> | undefined;
  try {
    await lock.query('BEGIN'); const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT singleton FROM platform_terms_policy WHERE singleton=true FOR UPDATE');
    pending = service.prepare(who, { expectedRevision: draft.revision }, controller.signal); pending.catch(() => {});
    await waitForPolicyBlock(blocker); controller.abort(); await lock.query('COMMIT');
    await assert.rejects(pending, { name: 'AbortError' }); assert.deepEqual(await ledger(who), before);
  } finally { await release(lock, pending); }
});

test('a real deferred COMMIT rejection cannot return an already calculated personality snapshot', async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who);
  class CommitFailureDatabase extends Database {
    override withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
      return super.withBoundedTransaction(async client => {
        const value = await run(client); await client.query('INSERT INTO fictional_preparation_commit_marker(id) VALUES(1)'); return value;
      }, options);
    }
  }
  const failingDb = new CommitFailureDatabase(url.toString()); let tableCreated = false, functionCreated = false;
  try {
    await db.query('CREATE TABLE fictional_preparation_commit_marker(id integer PRIMARY KEY)'); tableCreated = true;
    await db.query(`CREATE FUNCTION fictional_reject_preparation_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Fictional preparation COMMIT rejected'; END $$`); functionCreated = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_preparation_commit_gate AFTER INSERT ON fictional_preparation_commit_marker
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_preparation_commit()`);
    await assert.rejects(new CompanionIntakePreparation(failingDb, config, FICTIONAL_LEGAL)
      .prepare(who, { expectedRevision: draft.revision }), /Fictional preparation COMMIT rejected/);
    assert.equal((await db.query('SELECT count(*)::int AS markers FROM fictional_preparation_commit_marker')).rows[0].markers, 0);
    assert.deepEqual(await ledger(who), before);
  } finally {
    try { await failingDb.close(); }
    finally {
      try { if (functionCreated) await db.query('DROP FUNCTION fictional_reject_preparation_commit() CASCADE'); }
      finally { if (tableCreated) await db.query('DROP TABLE fictional_preparation_commit_marker'); }
    }
  }
});
