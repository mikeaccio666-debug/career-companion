import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OnboardingAction, OnboardingDraft, OnboardingScenarioQuestion, ProviderRequestAdmission, ProviderStatus } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { CompanionDraftPreparation } from '../src/companion-draft-preparation.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Every account, legal document, input and provider catalogue is fictional. The
// isolated PostgreSQL schema exercises actual source checks, transactions and
// ciphertext bindings. No model, clinical approval, preview or student route runs.
const base = readConfig(), schema = 'companion_draft_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use only isolated loopback PostgreSQL.');
url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: 'b2'.repeat(32) })!;
const config = { dataCrypto: crypto, requireVerifiedEmail: true, modelRoutes: { chat: { provider: 'openai' } } };
const store = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
let modelCalls = 0, created = false;
function runtime(model = 'fictional-draft-model', enabled = true) {
  return {
    capabilities(): ProviderStatus[] {
      return [{ id: 'openai', name: 'Synthetic catalogue only', enabled, keyConfigured: true,
        capabilities: ['chat'], models: ['fictional-flat-never-selected'], modelsByCapability: { chat: [model] }, envVariables: [] }];
    },
    async *streamChat() { modelCalls++; throw new Error('A preparation must never invoke a provider.'); },
  };
}
const service = new CompanionDraftPreparation(db, config, FICTIONAL_LEGAL, runtime());
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true;
  await db.migrate(); await seedFictionalActiveLegal(db);
});
after(async () => {
  try { assert.equal(modelCalls, 0); }
  finally {
    try { await db.close(); }
    finally {
      try {
        if (created) {
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
        }
      } finally { await admin.close(); }
    }
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
    VALUES($1,$2,'Fictional draft student','fictional-unused-hash',$3,$4)`,
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
async function full(who: FixedSessionContext, extra: string) {
  let draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  while (draft.step === 'O2') { assert(draft.currentQuestion); draft = await save(who, draft, { kind: 'skip', questionId: draft.currentQuestion }); }
  for (const questionId of scenarios) draft = await save(who, draft, { kind: 'answer', questionId, value: 'A' } as OnboardingAction);
  assert.equal(draft.currentQuestion, 'extra'); draft = await save(who, draft, { kind: 'text', questionId: 'extra', text: extra });
  const current = await claim(who); assert.equal(current.questionId, 'extra');
  await store.processSafety(current, classifier({ level: 'L0', mode: 'full' }, input => assert.deepEqual(input, { text: extra, questionId: 'extra' })));
  const ready = await store.read(who); assert(ready); assert.equal(ready.state, 'intake_ready'); return ready;
}
async function history(who: FixedSessionContext, level: 'L0' | 'L1' | 'L2' = 'L0', mode: 'full' | 'keyword_only' = 'full') {
  let draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  const older = command(draft.revision, { kind: 'text', questionId: 'study', text: 'Synthetic older draft note A.' });
  draft = (await store.save(who, older)).draft;
  const newer = command(draft.revision, { kind: 'text', questionId: 'study', text: 'Synthetic current draft note B.' });
  draft = (await store.save(who, newer)).draft;
  const oldClaim = await claim(who), newClaim = await claim(who);
  assert.equal(oldClaim.operationId, older.operationId); assert.equal(newClaim.operationId, newer.operationId);
  await store.processSafety(newClaim, classifier({ level: 'L0', mode: 'full', resolution: { kind: 'unmatched' } }));
  await store.processSafety(oldClaim, classifier(level === 'L0'
    ? { level: 'L0', mode: 'full', resolution: { kind: 'unmatched' } } : { level, mode }));
  const current = await store.read(who); assert(current);
  return { draft: level === 'L0' ? await finishWithSkips(who, current) : current, older, newer, oldClaim, newClaim };
}
async function ledger(who: FixedSessionContext) {
  const results = await Promise.all([
    db.query('SELECT * FROM platform_onboarding_drafts WHERE user_id=$1 ORDER BY id', [who.userId]),
    db.query('SELECT * FROM platform_onboarding_operations WHERE user_id=$1 ORDER BY applied_revision,operation_id', [who.userId]),
    db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision,id', [who.userId]),
    db.query('SELECT * FROM platform_companions WHERE user_id=$1 ORDER BY id', [who.userId]),
    db.query('SELECT * FROM platform_companion_answers WHERE user_id=$1 ORDER BY id', [who.userId]),
    db.query('SELECT * FROM platform_companion_generation_tasks WHERE user_id=$1 ORDER BY id', [who.userId]),
    db.query(`SELECT
      (SELECT count(*)::int FROM platform_conversations WHERE user_id=$1) AS rooms,
      (SELECT count(*)::int FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id WHERE c.user_id=$1) AS messages,
      (SELECT count(*)::int FROM platform_memories WHERE user_id=$1) AS memories,
      (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs,
      (SELECT count(*)::int FROM platform_chat_calls WHERE user_id=$1) AS chat_calls,
      (SELECT count(*)::int FROM platform_usage WHERE user_id=$1) AS usage,
      (SELECT count(*)::int FROM platform_safety_model_usage WHERE user_id=$1) AS safety_usage,
      (SELECT count(*)::int FROM platform_runtime_leases WHERE user_id=$1) AS leases,
      (SELECT count(*)::int FROM platform_cost_reservations WHERE user_id=$1) AS reservations,
      (SELECT count(*)::int FROM platform_cost_ledger WHERE user_id=$1) AS cost_ledger,
      (SELECT count(*)::int FROM platform_cost_user_policy WHERE user_id=$1) AS user_budget`, [who.userId]),
  ]);
  return { drafts: results[0].rows, operations: results[1].rows, submissions: results[2].rows,
    companions: results[3].rows, answers: results[4].rows, tasks: results[5].rows, effects: results[6].rows[0] };
}
const noExecution = { rooms: 0, messages: 0, memories: 0, jobs: 0, chat_calls: 0, usage: 0, safety_usage: 0,
  leases: 0, reservations: 0, cost_ledger: 0, user_budget: 0 };
async function waitForPolicyBlock(blocker: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%platform_terms_policy%' AND $1=ANY(pg_blocking_pids(pid))", [blocker]);
    if (found.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail('The actual preparation must be blocked on the policy fixture.');
}
async function release(lock: PoolClient, pending?: Promise<unknown>) {
  try { await lock.query('ROLLBACK'); }
  finally { lock.release(); await pending?.catch(() => {}); }
}

test('missing or incomplete source creates no drafting entity or pending work', async () => {
  const who = await actor(), empty = await ledger(who);
  await assert.rejects(service.prepare(who, { expectedRevision: 0 }), code('NOT_FOUND', 404));
  assert.deepEqual(await ledger(who), empty);
  const draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft, before = await ledger(who);
  await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }), code('ONBOARDING_STATE_CHANGED', 409));
  assert.deepEqual(await ledger(who), before);
});

test('completed source atomically prepares only a drafting entity, encrypted answers and pending task', async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who);
  const result = await service.prepare(who, { expectedRevision: draft.revision }), after = await ledger(who);
  assert.deepEqual(Object.keys(result).sort(), ['companionId', 'source', 'status', 'taskId']);
  assert.deepEqual(result.source, { draftId: draft.id, draftRevision: draft.revision, questionnaireRevision: 1, rulesRevision: 1 });
  assert.equal(result.status, 'pending'); assert(Object.isFrozen(result)); assert(Object.isFrozen(result.source));
  assert.equal(after.companions.length, 1); assert.equal(after.answers.length, 1); assert.equal(after.tasks.length, 1);
  assert.deepEqual(after.drafts, before.drafts); assert.deepEqual(after.operations, before.operations); assert.deepEqual(after.submissions, before.submissions);
  assert.deepEqual(after.effects, noExecution); assert.equal(modelCalls, 0);
  const companion = after.companions[0], answers = after.answers[0], task = after.tasks[0];
  assert.equal(companion.id, result.companionId); assert.equal(companion.status, 'drafting');
  assert.equal(companion.current_revision, 0); assert.equal(companion.draft_rerolls, 0);
  assert.equal(task.id, result.taskId); assert.equal(task.companion_id, companion.id); assert.equal(task.answers_id, answers.id);
  assert.equal(task.status, 'pending'); assert.equal(task.auth_version, '0'); assert.equal(task.purpose, 'companion_preview');
  const answerSnapshot = JSON.parse(crypto.openUtf8(answers.payload_ciphertext, { table: 'platform_companion_answers',
    column: 'payload_ciphertext', rowId: answers.id, ownerId: who.userId, revision: draft.revision }));
  assert.deepEqual(answerSnapshot, { schemaVersion: 1, id: answers.id, userId: who.userId, sourceDraftId: draft.id,
    sourceRevision: draft.revision, fastTrack: true, answersPartial: draft.answersPartial });
  const seed = JSON.parse(crypto.openUtf8(task.seed_ciphertext, { table: 'platform_companion_generation_tasks',
    column: 'seed_ciphertext', rowId: task.id, ownerId: who.userId, revision: draft.revision }));
  assert.deepEqual(seed.dimensions, neutral); assert.equal(seed.provider, 'openai'); assert.equal(seed.model, 'fictional-draft-model');
  assert.equal(seed.taskId, task.id); assert.equal(seed.answersId, answers.id); assert.equal(seed.companionId, companion.id);
  assert.equal(seed.userId, who.userId); assert.equal(seed.sourceDraftId, draft.id); assert.equal(seed.sourceRevision, draft.revision);
  assert.equal(seed.authVersion, '0'); assert.equal(seed.questionnaireRevision, 1); assert.equal(seed.rulesRevision, 1); assert.equal(seed.generatorVersion, 1);
  assert.equal(seed.purpose, 'companion_preview'); assert.equal(typeof seed.styleCard, 'string');
  for (const key of ['summary', 'samples', 'generatedBy', 'preview', 'name', 'sealChar']) assert.equal(Object.hasOwn(seed, key), false);
  assert.equal((await db.query("SELECT to_regclass('platform_companion_revisions') AS relation")).rows[0].relation, null);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM platform_model_prices')).rows[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM platform_cost_global_policy')).rows[0].count, 0);
});

test('replay across fresh service instances returns the actual immutable saved identifiers without new effects', async () => {
  const who = await actor(), draft = await fast(who), first = await service.prepare(who, { expectedRevision: draft.revision }), before = await ledger(who);
  const fresh = new CompanionDraftPreparation(db, config, FICTIONAL_LEGAL, runtime());
  assert.deepEqual(await fresh.prepare(who, { expectedRevision: draft.revision }), first);
  assert.deepEqual(await service.prepare(who, { expectedRevision: draft.revision }), first);
  assert.deepEqual(await ledger(who), before); assert.deepEqual(before.effects, noExecution);
});

test('concurrent accepted requests serialize on the real owner and create exactly one pending task', async () => {
  const who = await actor(), draft = await fast(who);
  const [a, b] = await Promise.all([service.prepare(who, { expectedRevision: draft.revision }), service.prepare(who, { expectedRevision: draft.revision })]);
  assert.deepEqual(a, b); const stored = await ledger(who);
  assert.equal(stored.companions.length, 1); assert.equal(stored.answers.length, 1); assert.equal(stored.tasks.length, 1);
  assert.deepEqual(stored.effects, noExecution);
});

test('classified O4 influences the private rule seed but raw text stays only in its encrypted source operation', async () => {
  const who = await actor(), raw = '说话直一点，别催我，短一点，多用英文；Synthetic confidential draft note.';
  const draft = await full(who, raw), result = await service.prepare(who, { expectedRevision: draft.revision }), stored = await ledger(who);
  const answers = stored.answers[0], task = stored.tasks[0]; assert.equal(task.id, result.taskId);
  const answerPlain = crypto.openUtf8(answers.payload_ciphertext, { table: 'platform_companion_answers', column: 'payload_ciphertext',
    rowId: answers.id, ownerId: who.userId, revision: draft.revision });
  const seedPlain = crypto.openUtf8(task.seed_ciphertext, { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext',
    rowId: task.id, ownerId: who.userId, revision: draft.revision });
  const answer = JSON.parse(answerPlain), seed = JSON.parse(seedPlain);
  assert.deepEqual(answer.answersPartial.extra, draft.answersPartial.extra);
  assert.equal(seed.dimensions.directness, 1); assert.equal(seed.dimensions.drive, 0); assert.equal(seed.dimensions.length, 'short'); assert.equal(seed.dimensions.code_mix, 1);
  for (const value of [answerPlain, seedPlain, JSON.stringify(result)]) {
    assert.equal(value.includes(raw), false); assert.equal(value.includes('Synthetic confidential draft note'), false);
  }
  assert.deepEqual(stored.effects, noExecution);
});

test('a closed preparation command cannot supply persona, task, source, provider or accessor approvals', async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who); let accessed = 0;
  const getter = Object.defineProperty({}, 'expectedRevision', { enumerable: true, get() { accessed++; return draft.revision; } });
  for (const input of [null, [], {}, { expectedRevision: -1 }, { expectedRevision: -0 }, { expectedRevision: Number.NaN },
    { expectedRevision: 0.5 }, { expectedRevision: 2147483648 }, { expectedRevision: String(draft.revision) },
    { expectedRevision: draft.revision, companionId: randomUUID() }, { expectedRevision: draft.revision, taskId: randomUUID() },
    { expectedRevision: draft.revision, dimensions: neutral }, { expectedRevision: draft.revision, source: { draftId: draft.id } },
    { expectedRevision: draft.revision, provider: 'openai' }, { expectedRevision: draft.revision, status: 'pending' }, getter]) {
    await assert.rejects(service.prepare(who, input), code('INVALID_INPUT', 400));
  }
  assert.equal(accessed, 0); assert.deepEqual(await ledger(who), before);
});

test('stale expected revisions and borrowed sessions cannot create or replay private work', async () => {
  const who = await actor(), other = await actor(), draft = await fast(who), first = await service.prepare(who, { expectedRevision: draft.revision }), before = await ledger(who);
  await assert.rejects(service.prepare(who, { expectedRevision: draft.revision - 1 }), code('ONBOARDING_REVISION_CHANGED', 409));
  await assert.rejects(service.prepare({ userId: who.userId, tokenHash: other.tokenHash }, { expectedRevision: draft.revision }), code('AUTH_REQUIRED', 401));
  await assert.rejects(service.prepare(other, { expectedRevision: draft.revision }), code('NOT_FOUND', 404));
  assert.deepEqual(await ledger(who), before); assert.equal(first.taskId, before.tasks[0].id);
});

for (const [options, expected] of [
  [{ verified: false }, 'EMAIL_VERIFICATION_REQUIRED'], [{ consented: false }, 'TERMS_CONFIRMATION_REQUIRED'], [{ kind: 'staff' }, 'STUDENT_ACCOUNT_REQUIRED'],
] as const) test(`actual account gate prevents any draft preparation: ${expected}`, async () => {
  const who = await actor(options), before = await ledger(who);
  await assert.rejects(service.prepare(who, { expectedRevision: 0 }), code(expected, 403)); assert.deepEqual(await ledger(who), before);
});

for (const deny of ['revoked', 'auth_version', 'expired', 'withdrawn_consent', 'stale_consent'] as const) test(`saved pending work remains private after ${deny}`, async () => {
  const who = await actor(), draft = await fast(who); await service.prepare(who, { expectedRevision: draft.revision });
  if (deny === 'revoked') await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
  if (deny === 'auth_version') await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
  if (deny === 'expired') await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [who.tokenHash]);
  if (deny === 'withdrawn_consent' || deny === 'stale_consent') await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
  if (deny === 'stale_consent') await db.query("INSERT INTO platform_terms_consents(user_id,terms_version,content_digest) VALUES($1,'fictional-old-policy',$2)", [who.userId, 'e'.repeat(64)]);
  const before = await ledger(who), expected = ['withdrawn_consent', 'stale_consent'].includes(deny) ? 'TERMS_CONFIRMATION_REQUIRED' : 'AUTH_REQUIRED';
  await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }), code(expected)); assert.deepEqual(await ledger(who), before);
});

test('a new valid account session cannot silently reuse a task accepted under an older auth version', async () => {
  const who = await actor(), draft = await fast(who); await service.prepare(who, { expectedRevision: draft.revision });
  await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
  const nextHash = tokenHash(randomUUID());
  await db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '1 hour')", [who.userId, nextHash]);
  const before = await ledger(who);
  await assert.rejects(service.prepare({ userId: who.userId, tokenHash: nextHash }, { expectedRevision: draft.revision }), code('COMPANION_DRAFT_SOURCE_CHANGED', 409));
  assert.deepEqual(await ledger(who), before);
});

test('missing crypto and unavailable current legal documents create no work and cannot authorize replay', async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who);
  await assert.rejects(new CompanionDraftPreparation(db, { ...config, dataCrypto: undefined }, FICTIONAL_LEGAL, runtime())
    .prepare(who, { expectedRevision: draft.revision }), code('DATA_STORAGE_UNAVAILABLE', 503));
  await assert.rejects(new CompanionDraftPreparation(db, config, null, runtime())
    .prepare(who, { expectedRevision: draft.revision }), code('LEGAL_DOCUMENTS_UNAVAILABLE', 503));
  assert.deepEqual(await ledger(who), before);
  await service.prepare(who, { expectedRevision: draft.revision }); const saved = await ledger(who);
  try {
    await db.query("UPDATE platform_terms_policy SET content_digest=$1 WHERE singleton=true", ['0'.repeat(64)]);
    await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }), code('LEGAL_DOCUMENTS_UNAVAILABLE', 503));
  } finally { await seedFictionalActiveLegal(db); }
  assert.deepEqual(await ledger(who), saved);
});

test('unconfigured, disabled and throwing model catalogues cannot create a task or return saved work', async () => {
  const who = await actor(), draft = await fast(who), unavailable = [
    new CompanionDraftPreparation(db, { ...config, modelRoutes: {} }, FICTIONAL_LEGAL, runtime()),
    new CompanionDraftPreparation(db, config, FICTIONAL_LEGAL, runtime('fictional-draft-model', false)),
    new CompanionDraftPreparation(db, config, FICTIONAL_LEGAL, { capabilities() { throw new Error('Fictional catalogue outage'); } }),
  ];
  const empty = await ledger(who);
  for (const preparer of unavailable) await assert.rejects(preparer.prepare(who, { expectedRevision: draft.revision }), code('MODEL_ROUTE_UNAVAILABLE', 503));
  assert.deepEqual(await ledger(who), empty);
  await service.prepare(who, { expectedRevision: draft.revision }); const saved = await ledger(who);
  for (const preparer of unavailable) await assert.rejects(preparer.prepare(who, { expectedRevision: draft.revision }), code('MODEL_ROUTE_UNAVAILABLE', 503));
  assert.deepEqual(await ledger(who), saved); assert.equal(modelCalls, 0);
});

test('a changed available server model cannot transform the actual saved pending seed during replay', async () => {
  const who = await actor(), draft = await fast(who); await service.prepare(who, { expectedRevision: draft.revision }); const before = await ledger(who);
  await assert.rejects(new CompanionDraftPreparation(db, config, FICTIONAL_LEGAL, runtime('fictional-other-draft-model'))
    .prepare(who, { expectedRevision: draft.revision }), code('DATA_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(await ledger(who), before);
});

test('pending TEXT blocks preparation before an incomplete-state or stale-revision decision', async () => {
  const who = await actor(); let draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  draft = await save(who, draft, { kind: 'text', questionId: 'study', text: 'Synthetic pending draft note.' }); const before = await ledger(who);
  for (const revision of [draft.revision, draft.revision - 1]) await assert.rejects(service.prepare(who, { expectedRevision: revision }), code('ONBOARDING_SAFETY_REQUIRED', 409));
  assert.deepEqual(await ledger(who), before);
});

test('latest full L0 and an existing task cannot hide a missing superseded TEXT detection', async () => {
  const who = await actor(), current = await history(who); await service.prepare(who, { expectedRevision: current.draft.revision });
  await db.query('DELETE FROM platform_onboarding_safety_submissions WHERE id=$1', [current.oldClaim.submissionId]); const before = await ledger(who);
  assert.equal(before.submissions.length, 1);
  await assert.rejects(service.prepare(who, { expectedRevision: current.draft.revision }), code('ONBOARDING_SAFETY_REQUIRED', 409));
  assert.deepEqual(await ledger(who), before, 'Recovery and any generation writes must roll back together.');
});

for (const [level, mode] of [['L1', 'full'], ['L2', 'keyword_only']] as const) test(`superseded ${level}/${mode} is an independent barrier to drafting`, async () => {
  const who = await actor(), current = await history(who, level, mode), before = await ledger(who);
  assert.equal(before.submissions.find(row => row.id === current.newClaim.submissionId).level, 'L0');
  await assert.rejects(service.prepare(who, { expectedRevision: current.draft.revision }), code('ONBOARDING_SAFETY_REVIEW_REQUIRED', 409));
  assert.deepEqual(await ledger(who), before);
});

for (const damaged of ['older_operation', 'older_result', 'older_projection'] as const) test(`replay still authenticates superseded source: ${damaged}`, async () => {
  const who = await actor(), current = await history(who); await service.prepare(who, { expectedRevision: current.draft.revision });
  if (damaged === 'older_operation') await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, current.older.operationId, Buffer.alloc(29)]);
  if (damaged === 'older_result') await db.query('UPDATE platform_onboarding_safety_submissions SET result_ciphertext=$2 WHERE id=$1', [current.oldClaim.submissionId, Buffer.alloc(29)]);
  if (damaged === 'older_projection') await db.query("UPDATE platform_onboarding_safety_submissions SET level='L1' WHERE id=$1", [current.oldClaim.submissionId]);
  const before = await ledger(who); await assert.rejects(service.prepare(who, { expectedRevision: current.draft.revision }), code('DATA_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(await ledger(who), before);
});

test('intake ciphertext from an earlier revision cannot authorize replay of the completed task', async () => {
  const who = await actor(), first = (await store.save(who, command(0, { kind: 'start', mode: 'fast_track' }))).draft;
  const older = (await ledger(who)).drafts[0].payload_ciphertext, draft = await finishWithSkips(who, first);
  await service.prepare(who, { expectedRevision: draft.revision });
  await db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [who.userId, older]);
  const before = await ledger(who); await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }), code('DATA_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(await ledger(who), before);
});

for (const column of ['answers', 'seed'] as const) test(`another owner cannot supply the saved encrypted ${column} snapshot`, async () => {
  const a = await actor(), b = await actor(), ad = await fast(a), bd = await fast(b);
  await service.prepare(a, { expectedRevision: ad.revision }); await service.prepare(b, { expectedRevision: bd.revision });
  const left = await ledger(a), original = await ledger(b);
  if (column === 'answers') await db.query('UPDATE platform_companion_answers SET payload_ciphertext=$2 WHERE id=$1', [original.answers[0].id, left.answers[0].payload_ciphertext]);
  else await db.query('UPDATE platform_companion_generation_tasks SET seed_ciphertext=$2 WHERE id=$1', [original.tasks[0].id, left.tasks[0].seed_ciphertext]);
  const before = await ledger(b); await assert.rejects(service.prepare(b, { expectedRevision: bd.revision }), code('DATA_STORAGE_UNAVAILABLE', 503));
  assert.deepEqual(await ledger(b), before); assert.deepEqual(await ledger(a), left);
});

test('swapped columns, modified canonical seed and ciphertext bytes cannot become a best-effort preview', async () => {
  const who = await actor(), draft = await fast(who); await service.prepare(who, { expectedRevision: draft.revision }); const original = await ledger(who), task = original.tasks[0];
  const binding = { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext', rowId: task.id, ownerId: who.userId, revision: draft.revision };
  const forged = JSON.parse(crypto.openUtf8(task.seed_ciphertext, binding)); forged.summary = 'Synthetic ungenerated preview.'; forged.generatedBy = 'model';
  for (const ciphertext of [original.answers[0].payload_ciphertext, crypto.sealUtf8(JSON.stringify(forged), binding), Buffer.alloc(29)]) {
    await db.query('UPDATE platform_companion_generation_tasks SET seed_ciphertext=$2 WHERE id=$1', [task.id, ciphertext]); const before = await ledger(who);
    await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }), code('DATA_STORAGE_UNAVAILABLE', 503)); assert.deepEqual(await ledger(who), before);
  }
  await db.query('UPDATE platform_companion_generation_tasks SET seed_ciphertext=$2 WHERE id=$1', [task.id, task.seed_ciphertext]);
  assert.deepEqual(await ledger(who), original);
});

test('valid ciphertext binds the actual snapshot row, owner and source revision', async () => {
  const who = await actor(), draft = await fast(who); await service.prepare(who, { expectedRevision: draft.revision }); const stored = await ledger(who);
  for (const [table, column, row] of [['platform_companion_answers', 'payload_ciphertext', stored.answers[0]], ['platform_companion_generation_tasks', 'seed_ciphertext', stored.tasks[0]]] as const) {
    const binding = { table, column, rowId: row.id, ownerId: who.userId, revision: draft.revision }, ciphertext = row[column];
    assert.doesNotThrow(() => crypto.openUtf8(ciphertext, binding));
    for (const changed of [{ ...binding, rowId: randomUUID() }, { ...binding, ownerId: randomUUID() }, { ...binding, revision: draft.revision + 1 }]) {
      assert.throws(() => crypto.openUtf8(ciphertext, changed));
    }
  }
  assert.deepEqual(await ledger(who), stored);
});

test('database constraints reject duplicate live entities, foreign-owner tasks and invented output states', async () => {
  const who = await actor(), other = await actor(), draft = await fast(who); await service.prepare(who, { expectedRevision: draft.revision }); const before = await ledger(who);
  await assert.rejects(db.query("INSERT INTO platform_companions(id,user_id,status,fingerprint) VALUES($1,$2,'drafting',$3)", [randomUUID(), who.userId, '1'.repeat(64)]), { code: '23505' });
  await assert.rejects(db.query('UPDATE platform_companion_generation_tasks SET user_id=$2 WHERE id=$1', [before.tasks[0].id, other.userId]), { code: '23503' });
  await assert.rejects(db.query("UPDATE platform_companions SET status='awaiting_name' WHERE user_id=$1", [who.userId]), { code: '23514' });
  await assert.rejects(db.query("UPDATE platform_companion_generation_tasks SET status='running' WHERE user_id=$1", [who.userId]), { code: '23514' });
  assert.deepEqual(await ledger(who), before);
});

test('an orphaned live drafting entity cannot cause a second task or bypass persisted-state checks', async () => {
  const who = await actor(), draft = await fast(who);
  await db.query("INSERT INTO platform_companions(id,user_id,status,fingerprint) VALUES($1,$2,'drafting',$3)", [randomUUID(), who.userId, '2'.repeat(64)]);
  const before = await ledger(who); await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }), code('COMPANION_EXISTS', 409));
  assert.deepEqual(await ledger(who), before);
});

test('the fixed session and closed request remain captured during a proven policy lock wait', { timeout: 10_000 }, async () => {
  const who = await actor(), other = await actor(), draft = await fast(who), lock = await db.pool.connect();
  const context = { ...who }, input = { expectedRevision: draft.revision }; let pending: ReturnType<CompanionDraftPreparation['prepare']> | undefined;
  try {
    await lock.query('BEGIN'); const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT singleton FROM platform_terms_policy WHERE singleton=true FOR UPDATE');
    pending = service.prepare(context, input); pending.catch(() => {}); await waitForPolicyBlock(blocker);
    context.userId = other.userId; context.tokenHash = other.tokenHash; input.expectedRevision = 0;
    await lock.query('COMMIT'); const result = await pending;
    assert.equal(result.source.draftId, draft.id); assert.equal(result.source.draftRevision, draft.revision);
    assert.equal((await ledger(who)).tasks[0].id, result.taskId); assert.equal((await ledger(other)).companions.length, 0);
  } finally { await release(lock, pending); }
});

test('actual session expiry during a policy wait prevents durable preparation', { timeout: 10_000 }, async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who), lock = await db.pool.connect();
  let pending: ReturnType<CompanionDraftPreparation['prepare']> | undefined;
  try {
    await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE token_hash=$1", [who.tokenHash]);
    await lock.query('BEGIN'); const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT singleton FROM platform_terms_policy WHERE singleton=true FOR UPDATE');
    pending = service.prepare(who, { expectedRevision: draft.revision }); pending.catch(() => {}); await waitForPolicyBlock(blocker);
    await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.01) FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
    assert.equal((await db.query('SELECT expires_at<=clock_timestamp() AS expired FROM platform_sessions WHERE token_hash=$1', [who.tokenHash])).rows[0].expired, true);
    await lock.query('COMMIT'); await assert.rejects(pending, code('AUTH_REQUIRED', 401)); assert.deepEqual(await ledger(who), before);
  } finally { await release(lock, pending); }
});

test('cancellation before create, during proven policy wait and before replay cannot return prepared work', { timeout: 10_000 }, async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who), already = new AbortController(); already.abort();
  await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }, already.signal), { name: 'AbortError' });
  const lock = await db.pool.connect(), controller = new AbortController(); let pending: ReturnType<CompanionDraftPreparation['prepare']> | undefined;
  try {
    await lock.query('BEGIN'); const blocker = (await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lock.query('SELECT singleton FROM platform_terms_policy WHERE singleton=true FOR UPDATE');
    pending = service.prepare(who, { expectedRevision: draft.revision }, controller.signal); pending.catch(() => {}); await waitForPolicyBlock(blocker);
    controller.abort(); await lock.query('COMMIT'); await assert.rejects(pending, { name: 'AbortError' }); assert.deepEqual(await ledger(who), before);
  } finally { await release(lock, pending); }
  await service.prepare(who, { expectedRevision: draft.revision }); const saved = await ledger(who);
  await assert.rejects(service.prepare(who, { expectedRevision: draft.revision }, already.signal), { name: 'AbortError' }); assert.deepEqual(await ledger(who), saved);
});

test('a real deferred COMMIT rejection rolls back all three durable preparation records', async () => {
  const who = await actor(), draft = await fast(who), before = await ledger(who);
  class CommitFailureDatabase extends Database {
    override withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
      return super.withBoundedTransaction(async client => {
        const value = await run(client); await client.query('INSERT INTO fictional_draft_commit_marker(id) VALUES(1)'); return value;
      }, options);
    }
  }
  const failingDb = new CommitFailureDatabase(url.toString()); let tableCreated = false, functionCreated = false;
  try {
    await db.query('CREATE TABLE fictional_draft_commit_marker(id integer PRIMARY KEY)'); tableCreated = true;
    await db.query(`CREATE FUNCTION fictional_reject_draft_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Fictional draft COMMIT rejected'; END $$`); functionCreated = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_draft_commit_gate AFTER INSERT ON fictional_draft_commit_marker
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_draft_commit()`);
    await assert.rejects(new CompanionDraftPreparation(failingDb, config, FICTIONAL_LEGAL, runtime())
      .prepare(who, { expectedRevision: draft.revision }), /Fictional draft COMMIT rejected/);
    assert.equal((await db.query('SELECT count(*)::int AS markers FROM fictional_draft_commit_marker')).rows[0].markers, 0);
    assert.deepEqual(await ledger(who), before);
  } finally {
    try { await failingDb.close(); }
    finally {
      try { if (functionCreated) await db.query('DROP FUNCTION fictional_reject_draft_commit() CASCADE'); }
      finally { if (tableCreated) await db.query('DROP TABLE fictional_draft_commit_marker'); }
    }
  }
});

test('owner deletion cascades the actual pending task, answer snapshot and drafting entity', async () => {
  const who = await actor(), draft = await fast(who); await service.prepare(who, { expectedRevision: draft.revision });
  assert.equal((await ledger(who)).tasks.length, 1); await db.query('DELETE FROM platform_users WHERE id=$1', [who.userId]);
  const after = await ledger(who);
  assert.equal(after.companions.length, 0); assert.equal(after.answers.length, 0); assert.equal(after.tasks.length, 0);
  assert.equal(after.drafts.length, 0); assert.equal(after.operations.length, 0); assert.equal(after.submissions.length, 0); assert.deepEqual(after.effects, noExecution);
});
