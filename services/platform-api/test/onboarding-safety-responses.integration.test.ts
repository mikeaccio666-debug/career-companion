import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OnboardingAction, ProviderRequestAdmission } from '@companion/platform-contracts';
import { Database, DatabaseOperationTimeout } from '../src/database.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { OnboardingSafetyResponses } from '../src/onboarding-safety-responses.ts';
import { expectedSafetyResponseBundleDigests, parseSafetyResponseBundle, type SafetyResponseBundle } from '../src/safety-response-bundle.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// All actors, free text, decisions, reviewer references and resources are fictional, non-clinical fixtures.
// Classification invokes genuine admission; there is no paid provider, HTTP publication, Redis or student release.
const base = readConfig(), schema = 'onboarding_safety_responses_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use only isolated loopback PostgreSQL.');
url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: '88'.repeat(32) })!;
const config = { dataCrypto: crypto, requireVerifiedEmail: true };
const store = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
const pair = (zh: string, en = zh) => ({ zh, en });
function bundleContent(revision = 7) {
  const locale = (language: 'zh' | 'en') => ({
    L1: { text: language === 'zh' ? '虚构 L1 用户[{{userName}}] 主理人[{{companionName}}]。' : 'Fictional L1 user[{{userName}}] companion[{{companionName}}].' },
    L2: { text: language === 'zh' ? '虚构 L2 用户[{{userName}}] 主理人[{{companionName}}]。' : 'Fictional L2 user[{{userName}}] companion[{{companionName}}].',
      safetyQuestion: language === 'zh' ? '虚构测试问题：{{userName}}，此合成测试准备好了吗？' : 'Fictional fixture question: {{userName}}, is this synthetic test ready?' },
    resourceCard: { title: language === 'zh' ? '虚构资源' : 'Fictional resources', footer: language === 'zh' ? '虚构测试不会替你联系任何人。' : 'This fictional fixture does not contact anyone.',
      schoolUnknown: language === 'zh' ? '虚构学校未知指引。' : 'Fictional unknown-school instruction.', outsideUsLabel: language === 'zh' ? '虚构境外提示' : 'Fictional outside-country label' },
  });
  return { schemaVersion: 1, revision, retentionDays: 17, review: { reference: 'fictional-bundle-integrity-not-professional-approval', approvedAt: '2026-01-01T00:00:00.000Z' },
    locales: { zh: locale('zh'), en: locale('en') }, resources: { outsideUs: pair('虚构境外说明，无具体联系方式。', 'Fictional outside explanation without a contact destination.'),
      contacts: ['lifeline_988', 'emergency_911', 'crisis_text_line'].map((id, index) => ({ id, verifiedAt: '2026-01-01T00:00:00.000Z',
        reviewRef: 'fictional-contact-integrity-reference-' + index, name: pair('虚构资源 ' + index, 'Fictional resource ' + index),
        description: pair('虚构资源说明。', 'Fictional resource explanation.'), actions: [
          { kind: 'call', number: '+1555010010' + index, label: pair('虚构拨号', 'Synthetic call') },
          { kind: 'web', url: 'https://resources.example.com/fictional-' + index, label: pair('虚构链接', 'Synthetic website') },
        ] })) } };
}
function fictionalBundle(revision = 7): SafetyResponseBundle { const content = bundleContent(revision); return parseSafetyResponseBundle({ ...content, ...expectedSafetyResponseBundleDigests(content) }); }
const bundle = fictionalBundle();
const responses = (value: SafetyResponseBundle | null = bundle, database = db, legal = FICTIONAL_LEGAL) => new OnboardingSafetyResponses(database, config, legal, value);
let created = false, policyOwner: string;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await db.migrate(); await seedFictionalActiveLegal(db);
  policyOwner = (await actor('Fictional policy activation fixture')).userId; await activate();
});
after(async () => {
  try { await db.close(); }
  finally {
    try {
      if (created) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0, 'The actual owned schema must be absent after DROP.');
      }
    } finally { await admin.close(); }
  }
});
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const pgCode = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const command = (expectedRevision: number, action: OnboardingAction) => ({ expectedRevision, operationId: randomUUID(), action });
async function actor(name = 'Fictional response student'): Promise<FixedSessionContext> {
  const userId = randomUUID(), hash = tokenHash(randomUUID());
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,$3,'fictional-unused-hash','student',clock_timestamp())`, [userId, userId + '@example.invalid', name]);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, hash]);
  await seedFictionalConsent(db, userId); return { userId, tokenHash: hash };
}
async function activate(value = bundle) {
  await db.query(`INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,
    content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by`,
  [value.revision, value.contentDigest, value.reviewDigest, policyOwner]);
}
async function text(who: FixedSessionContext, raw = 'Synthetic private onboarding text ' + randomUUID()) {
  let draft = await store.read(who);
  if (!draft) draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  assert(draft.currentQuestion);
  const input = command(draft.revision, { kind: 'text', questionId: draft.currentQuestion, text: raw }), saved = await store.save(who, input);
  return { input, saved, raw };
}
const fixtureClassifier = (level: 'L0' | 'L1' | 'L2', mode: 'full' | 'keyword_only' = 'full') =>
  async (_input: { text: string; questionId: string }, admission: ProviderRequestAdmission) => admission(async signal => {
    signal.throwIfAborted(); return level === 'L0' ? { level, mode: 'full', resolution: { kind: 'unmatched' } } : { level, mode };
  });
async function detect(who: FixedSessionContext, level: 'L0' | 'L1' | 'L2' = 'L2', mode: 'full' | 'keyword_only' = 'full') {
  const submitted = await text(who), claim = await store.claimSafety(who, { detectorRevision: 17 }); assert(claim);
  const result = await store.processSafety(claim, fixtureClassifier(level, mode)); return { ...submitted, claim, result };
}
async function source(id: string) { return (await db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE id=$1', [id])).rows[0]; }
async function response(id: string) { return (await db.query('SELECT * FROM platform_onboarding_safety_responses WHERE submission_id=$1', [id])).rows[0]; }
async function counts(who: FixedSessionContext) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM platform_onboarding_safety_responses WHERE user_id=$1) AS responses,
    (SELECT count(*)::int FROM platform_safety_events WHERE user_id=$1) AS events`, [who.userId])).rows[0];
}
function capture(row: Awaited<ReturnType<typeof response>>) {
  return JSON.parse(crypto.openUtf8(row.payload_ciphertext, { table: 'platform_onboarding_safety_responses', column: 'payload_ciphertext', rowId: row.id, ownerId: row.user_id, revision: 1 }));
}

test('actual detection atomically enqueues reference-only work and fixed preparation preserves the L2 barrier', async () => {
  const who = await actor(), submitted = await text(who), claim = await store.claimSafety(who, { detectorRevision: 17 }); assert(claim);
  assert.deepEqual(await counts(who), { responses: 0, events: 0 });
  await store.processSafety(claim, fixtureClassifier('L2'));
  const queued = await response(claim.submissionId), detected = await source(claim.submissionId);
  assert.equal(detected.status, 'detected'); assert.equal(queued.status, 'pending'); assert.equal(queued.payload_ciphertext, null);
  for (const [key, value] of Object.entries({ user_id: who.userId, submission_id: claim.submissionId, operation_id: submitted.input.operationId,
    draft_id: claim.draftId, question_id: claim.questionId, submitted_revision: claim.submittedAtRevision, source_generation: claim.generation, detector_revision: claim.detectorRevision })) assert.equal(queued[key], value);
  assert.equal(JSON.stringify(queued).includes(submitted.raw), false); assert.equal(detected.result_ciphertext.includes(Buffer.from(submitted.raw)), false);
  assert.deepEqual(await counts(who), { responses: 1, events: 0 });
  await responses().prepareSubmission(claim.submissionId);
  assert.deepEqual(await store.readSafety(who), { status: 'blocked', pendingCount: 0, blockedLevel: 'L2' });
  const draft = await store.read(who); assert(draft);
  await assert.rejects(store.save(who, command(draft.revision, { kind: 'skip', questionId: 'study' })), code('ONBOARDING_SAFETY_REVIEW_REQUIRED'));
});

test('restart recovery restores every historical L1/L2 queue reference and never manufactures L0 work', async () => {
  const who = await actor(), a = await text(who), b = await text(who), c = await text(who);
  const claims = [];
  for (let index = 0; index < 3; index++) { const claim = await store.claimSafety(who, { detectorRevision: 17 }); assert(claim); claims.push(claim); }
  assert.deepEqual(claims.map(claim => claim.operationId), [a.input.operationId, b.input.operationId, c.input.operationId]);
  await store.processSafety(claims[2], fixtureClassifier('L0'));
  await store.processSafety(claims[0], fixtureClassifier('L2'));
  await store.processSafety(claims[1], fixtureClassifier('L1', 'keyword_only'));
  assert.deepEqual(await counts(who), { responses: 2, events: 0 });
  await db.query('DELETE FROM platform_onboarding_safety_responses WHERE user_id=$1', [who.userId]);
  const fresh = responses(), first = await fresh.prepareNext(); assert(first); assert.equal(first.submissionId, claims[0].submissionId);
  assert.deepEqual(await counts(who), { responses: 2, events: 1 });
  assert.equal((await response(claims[1].submissionId)).status, 'pending'); assert.equal(await response(claims[2].submissionId), undefined);
  const second = await fresh.prepareNext(); assert(second); assert.equal(second.submissionId, claims[1].submissionId);
  assert.deepEqual(await counts(who), { responses: 2, events: 2 }); assert.equal(await fresh.prepareNext(), null);
});

test('L0 has no safety response queue or event and cannot become a fixed crisis response', async () => {
  const who = await actor(), current = await detect(who, 'L0');
  assert.deepEqual(await counts(who), { responses: 0, events: 0 }); assert.deepEqual(await responses().read(who), []);
  await assert.rejects(responses().prepareSubmission(current.claim.submissionId), code('ONBOARDING_SAFETY_RESPONSE_UNAVAILABLE'));
  assert.deepEqual(await counts(who), { responses: 0, events: 0 });
});

test('missing bundle, crypto, activation or mismatched active digests leaves genuine work pending without a fake event', async () => {
  const who = await actor(), current = await detect(who), id = current.claim.submissionId;
  await assert.rejects(responses(null).prepareSubmission(id), code('ONBOARDING_SAFETY_RESPONSE_UNAVAILABLE'));
  const unencrypted = new OnboardingSafetyResponses(db, { requireVerifiedEmail: true }, FICTIONAL_LEGAL, bundle);
  await assert.rejects(unencrypted.prepareSubmission(id), code('DATA_STORAGE_UNAVAILABLE'));
  try {
    await db.query('DELETE FROM platform_safety_response_policy');
    await assert.rejects(responses().prepareSubmission(id), code('ONBOARDING_SAFETY_RESPONSE_UNAVAILABLE'));
    await activate();
    for (const [column, value] of [['revision', bundle.revision + 1], ['content_digest', '0'.repeat(64)], ['review_digest', '1'.repeat(64)]] as const) {
      await db.query(`UPDATE platform_safety_response_policy SET ${column}=$1 WHERE singleton=true`, [value]);
      await assert.rejects(responses().prepareSubmission(id), code('ONBOARDING_SAFETY_RESPONSE_UNAVAILABLE')); await activate();
    }
  } finally { await activate(); }
  assert.deepEqual(await counts(who), { responses: 1, events: 0 }); assert.equal((await response(id)).status, 'pending');
  assert.deepEqual(await responses(null).read(who), [{ responseId: (await response(id)).id, submissionId: id, level: 'L2', status: 'pending' }]);
});

test('ready ciphertext authenticates exact source and bundle capture; restart, asset updates and missing configuration replay it unchanged', async () => {
  const who = await actor(), current = await detect(who), service = responses(), receipt = await service.prepareSubmission(current.claim.submissionId);
  assert.equal(receipt.replayed, false); const original = await response(current.claim.submissionId), saved = capture(original);
  assert(original.payload_ciphertext instanceof Buffer); assert.equal(original.payload_ciphertext.includes(Buffer.from(current.raw)), false);
  assert.equal(JSON.stringify(saved).includes(current.raw), false); assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.id, original.id); assert.equal(saved.source_generation, current.claim.generation);
  assert.equal(saved.content_digest, bundle.contentDigest); assert.equal(saved.review_digest, bundle.reviewDigest);
  assert.equal(saved.response.resourceCard.contacts[0].reviewRef, bundle.resources.contacts[0].reviewRef);
  assert.equal(original.retention_until.getTime() - original.prepared_at.getTime() >= 17 * 86400_000, true);
  const changed = fictionalBundle(bundle.revision + 1);
  try {
    await activate(changed);
    for (const restarted of [responses(changed), responses(null)]) {
      assert.equal((await restarted.prepareSubmission(current.claim.submissionId)).replayed, true);
      assert.equal((await restarted.read(who))[0].response?.text, saved.response.text);
    }
    await db.query('DELETE FROM platform_safety_response_policy');
    assert.equal((await responses(null).prepareSubmission(current.claim.submissionId)).replayed, true);
  } finally { await activate(); }
  const unchanged = await response(current.claim.submissionId);
  assert.deepEqual(unchanged.payload_ciphertext, original.payload_ciphertext); assert.equal(unchanged.prepared_at.toISOString(), original.prepared_at.toISOString());
  assert.equal(unchanged.retention_until.toISOString(), original.retention_until.toISOString()); assert.deepEqual(await counts(who), { responses: 1, events: 1 });
});

test('unsafe optional account names are omitted from personalization without changing the actual account name', async () => {
  for (const name of ['<3', '{{companionName}}', 'Fictional\nName', '\u202eFictional', '   ']) {
    const who = await actor(name), current = await detect(who); await responses().prepareSubmission(current.claim.submissionId);
    const read = await responses().read(who); assert.equal(read[0].status, 'ready'); assert(read[0].response);
    assert.equal(read[0].response.text, '虚构 L2 用户[] 主理人[你的主理人]。');
    assert.equal((await db.query('SELECT name FROM platform_users WHERE id=$1', [who.userId])).rows[0].name, name);
    assert.deepEqual(await counts(who), { responses: 1, events: 1 });
  }
  const name = '😀'.repeat(100), who = await actor(name), current = await detect(who); await responses().prepareSubmission(current.claim.submissionId);
  assert.equal((await responses().read(who))[0].response?.text.includes(name), true);
  assert.equal((await db.query('SELECT name FROM platform_users WHERE id=$1', [who.userId])).rows[0].name, name);
});

test('the fixed locale uses the actual persisted O2 English selection without inventing school or language support', async () => {
  const who = await actor(); let draft = (await store.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  for (const questionId of ['study', 'graduation', 'roles', 'search_stage'] as const) draft = (await store.save(who, command(draft.revision, { kind: 'skip', questionId }))).draft;
  draft = (await store.save(who, command(draft.revision, { kind: 'answer', questionId: 'emotion_language', value: 'en' }))).draft;
  assert.equal(draft.answersPartial.emotion_language?.kind, 'answered');
  const current = await detect(who); await responses().prepareSubmission(current.claim.submissionId);
  const row = await response(current.claim.submissionId); assert.equal(row.locale, 'en');
  const result = (await responses().read(who))[0]; assert(result.response);
  assert.equal(result.response.text, 'Fictional L2 user[Fictional response student] companion[Your companion].');
  assert.equal(result.response.resourceCard.schoolUnknown, bundle.locales.en.resourceCard.schoolUnknown);
  assert.equal(Object.hasOwn(result.response.resourceCard, 'schoolContact'), false);
  assert.equal(Object.hasOwn(result.response.resourceCard.contacts[0], 'languageSupport'), false);
});

test('fixed preparation works with zero model allowance, expired detector lease, revoked legal consent and no network or Redis', async () => {
  const who = await actor(), current = await detect(who, 'L2', 'keyword_only');
  await db.query("UPDATE platform_onboarding_safety_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [current.claim.submissionId]);
  await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
  const fixedConfig = { ...config, safetyDailyModelCallLimit: 0, provider: undefined, redisUrl: undefined };
  const service = new OnboardingSafetyResponses(db, fixedConfig, null, bundle);
  let requests = 0; const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() => { requests++; throw new Error('No synthetic provider or contact network request expected.'); }) as typeof fetch;
    assert.equal((await service.prepareSubmission(current.claim.submissionId)).status, 'ready');
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(requests, 0); assert.equal((await response(current.claim.submissionId)).detector_mode, 'keyword_only');
  const actual = (await db.query(`SELECT (SELECT count(*)::int FROM platform_safety_model_usage) AS model_calls,
    (SELECT count(*)::int FROM platform_messages) AS messages,(SELECT count(*)::int FROM platform_jobs) AS jobs`)).rows[0];
  assert.deepEqual(actual, { model_calls: 0, messages: 0, jobs: 0 });
  await assert.rejects(responses().read(who), code('TERMS_CONFIRMATION_REQUIRED'));
});

test('private reads require the exact unexpired session, active consent and student account even when preparation succeeds', async () => {
  const who = await actor(), other = await actor(), current = await detect(who), service = responses();
  await service.prepareSubmission(current.claim.submissionId); assert.deepEqual(await service.read(other), []);
  await assert.rejects(service.read({ userId: other.userId, tokenHash: who.tokenHash }), code('AUTH_REQUIRED'));
  await assert.rejects(service.read({ userId: who.userId, tokenHash: tokenHash(randomUUID()) }), code('AUTH_REQUIRED'));
  await db.query("UPDATE platform_users SET account_kind='staff' WHERE id=$1", [other.userId]);
  await assert.rejects(service.read(other), code('STUDENT_ACCOUNT_REQUIRED'));
  await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [who.tokenHash]);
  await assert.rejects(service.read(who), code('AUTH_REQUIRED'));
  await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE token_hash=$1", [who.tokenHash]);
  await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
  await assert.rejects(service.read(who), code('TERMS_CONFIRMATION_REQUIRED')); await seedFictionalConsent(db, who.userId);
  await db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [who.userId]);
  await assert.rejects(service.read(who), code('EMAIL_VERIFICATION_REQUIRED'));
  assert.equal((await service.prepareSubmission(current.claim.submissionId)).replayed, true);
  await db.query('UPDATE platform_users SET email_verified_at=clock_timestamp(),auth_version=auth_version+1 WHERE id=$1', [who.userId]);
  await assert.rejects(service.read(who), code('AUTH_REQUIRED')); assert.equal((await service.prepareSubmission(current.claim.submissionId)).replayed, true);
});

test('active legal-document changes block reads but cannot gate the internal fixed-response preparation', async () => {
  const who = await actor(), current = await detect(who);
  try {
    await db.query('UPDATE platform_terms_policy SET content_digest=$1 WHERE singleton=true', ['0'.repeat(64)]);
    assert.equal((await responses().prepareSubmission(current.claim.submissionId)).status, 'ready');
    await assert.rejects(responses().read(who), code('LEGAL_DOCUMENTS_UNAVAILABLE'));
  } finally { await seedFictionalActiveLegal(db); }
});

test('concurrent preparers serialize one captured response and exactly one reference-only event', async () => {
  const who = await actor(), current = await detect(who, 'L1');
  const receipts = await Promise.all(Array.from({ length: 5 }, () => responses().prepareSubmission(current.claim.submissionId)));
  assert.equal(new Set(receipts.map(receipt => receipt.responseId)).size, 1); assert.equal(receipts.filter(receipt => !receipt.replayed).length, 1);
  assert.deepEqual(await counts(who), { responses: 1, events: 1 });
  const event = (await db.query('SELECT * FROM platform_safety_events WHERE user_id=$1', [who.userId])).rows[0];
  assert.equal(event.event_kind, 'response_prepared'); assert.equal(event.submission_id, current.claim.submissionId);
  assert.equal(JSON.stringify(event).includes(current.raw), false); assert.equal(event.level, 'L1');
  assert.equal((await responses().read(who))[0].response?.resourceCard.contacts.length, 1);
});

test('a real deferred queue COMMIT rejection rolls source completion and outbox insertion back together', async () => {
  const who = await actor(), pending = await text(who), claim = await store.claimSafety(who, { detectorRevision: 17 }); assert(claim);
  let installed = false;
  try {
    await db.query(`CREATE FUNCTION fictional_reject_response_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${who.userId}'::uuid THEN RAISE EXCEPTION 'Fictional response enqueue commit rejected'; END IF; RETURN NEW; END $$`); installed = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_response_enqueue_gate AFTER INSERT ON platform_onboarding_safety_responses
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_response_enqueue()`);
    await assert.rejects(store.processSafety(claim, fixtureClassifier('L2')), pgCode('P0001'));
    const row = await source(claim.submissionId); assert.equal(row.status, 'running'); assert.equal(row.result_ciphertext, null); assert.equal(row.level, null);
    assert.deepEqual(await counts(who), { responses: 0, events: 0 });
    assert.equal((await store.read(who))?.revision, pending.saved.draft.revision); assert.equal((await store.read(who))?.state, 'safety_pending');
  } finally { if (installed) await db.query('DROP FUNCTION fictional_reject_response_enqueue() CASCADE'); }
  await store.failSafety(claim, 'unavailable'); const retry = await store.claimSafety(who, { detectorRevision: 17 }); assert(retry);
  assert.equal(retry.generation, claim.generation + 1); await store.processSafety(retry, fixtureClassifier('L2'));
  assert.equal((await response(retry.submissionId)).source_generation, retry.generation);
});

test('damaged operation, result, source metadata or queue binding fails closed without preparing a partial response', async () => {
  for (const damage of ['operation', 'result', 'source_metadata', 'queue'] as const) {
    const who = await actor(), current = await detect(who), id = current.claim.submissionId;
    const operation = (await db.query('SELECT request_ciphertext FROM platform_onboarding_operations WHERE operation_id=$1', [current.claim.operationId])).rows[0];
    const original = await source(id), queued = await response(id);
    try {
      if (damage === 'operation') { const bytes = Buffer.from(operation.request_ciphertext); bytes[30] ^= 1; await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$2 WHERE operation_id=$1', [current.claim.operationId, bytes]); }
      if (damage === 'result') { const bytes = Buffer.from(original.result_ciphertext); bytes[30] ^= 1; await db.query('UPDATE platform_onboarding_safety_submissions SET result_ciphertext=$2 WHERE id=$1', [id, bytes]); }
      if (damage === 'source_metadata') await db.query("UPDATE platform_onboarding_safety_submissions SET level='L1' WHERE id=$1", [id]);
      if (damage === 'queue') await db.query('UPDATE platform_onboarding_safety_responses SET source_generation=source_generation+1 WHERE id=$1', [queued.id]);
      await assert.rejects(responses().prepareSubmission(id), code('DATA_STORAGE_UNAVAILABLE'));
      assert.deepEqual(await counts(who), { responses: 1, events: 0 }); assert.equal((await response(id)).status, 'pending');
      assert.equal((await response(id)).payload_ciphertext, null);
    } finally {
      if (damage === 'operation') await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$2 WHERE operation_id=$1', [current.claim.operationId, operation.request_ciphertext]);
      if (damage === 'result') await db.query('UPDATE platform_onboarding_safety_submissions SET result_ciphertext=$2 WHERE id=$1', [id, original.result_ciphertext]);
      if (damage === 'source_metadata') await db.query('UPDATE platform_onboarding_safety_submissions SET level=$2 WHERE id=$1', [id, original.level]);
      if (damage === 'queue') await db.query('UPDATE platform_onboarding_safety_responses SET source_generation=$2 WHERE id=$1', [queued.id, queued.source_generation]);
    }
  }
});

test('historical recovery is all-or-nothing when a later old encrypted result is corrupt', async () => {
  const who = await actor(); await text(who); await text(who);
  const a = await store.claimSafety(who, { detectorRevision: 17 }), b = await store.claimSafety(who, { detectorRevision: 17 }); assert(a); assert(b);
  await store.processSafety(a, fixtureClassifier('L1')); await store.processSafety(b, fixtureClassifier('L2'));
  await db.query('DELETE FROM platform_onboarding_safety_responses WHERE user_id=$1', [who.userId]);
  const old = await source(b.submissionId), bytes = Buffer.from(old.result_ciphertext); bytes[30] ^= 1;
  try {
    await db.query('UPDATE platform_onboarding_safety_submissions SET result_ciphertext=$2 WHERE id=$1', [b.submissionId, bytes]);
    await assert.rejects(responses().prepareSubmission(a.submissionId), code('DATA_STORAGE_UNAVAILABLE'));
    assert.deepEqual(await counts(who), { responses: 0, events: 0 });
  } finally { await db.query('UPDATE platform_onboarding_safety_submissions SET result_ciphertext=$2 WHERE id=$1', [b.submissionId, old.result_ciphertext]); }
  await responses().prepareSubmission(a.submissionId); assert.deepEqual(await counts(who), { responses: 2, events: 1 });
});

test('ready ciphertext corruption, cross-owner transplantation and captured metadata mismatch cannot be replayed or read', async () => {
  const who = await actor(), other = await actor(), a = await detect(who), b = await detect(other);
  await responses().prepareSubmission(a.claim.submissionId); await responses().prepareSubmission(b.claim.submissionId);
  const original = await response(a.claim.submissionId), foreign = await response(b.claim.submissionId), damaged = Buffer.from(original.payload_ciphertext); damaged[30] ^= 1;
  try {
    for (const ciphertext of [damaged, foreign.payload_ciphertext]) {
      await db.query('UPDATE platform_onboarding_safety_responses SET payload_ciphertext=$2 WHERE id=$1', [original.id, ciphertext]);
      await assert.rejects(responses(null).prepareSubmission(a.claim.submissionId), code('DATA_STORAGE_UNAVAILABLE'));
      await assert.rejects(responses(null).read(who), code('DATA_STORAGE_UNAVAILABLE'));
      assert.deepEqual(await counts(who), { responses: 1, events: 1 });
    }
    await db.query('UPDATE platform_onboarding_safety_responses SET payload_ciphertext=$2,bundle_revision=bundle_revision+1 WHERE id=$1', [original.id, original.payload_ciphertext]);
    await assert.rejects(responses().read(who), code('DATA_STORAGE_UNAVAILABLE'));
  } finally { await db.query('UPDATE platform_onboarding_safety_responses SET payload_ciphertext=$2,bundle_revision=$3 WHERE id=$1', [original.id, original.payload_ciphertext, original.bundle_revision]); }
  assert.equal((await responses().read(who))[0].status, 'ready');
});

test('a damaged older ready capture cannot be silently skipped to prepare a newer pending response', async () => {
  const who = await actor(); await text(who); await text(who);
  const a = await store.claimSafety(who, { detectorRevision: 17 }), b = await store.claimSafety(who, { detectorRevision: 17 }); assert(a); assert(b);
  await store.processSafety(a, fixtureClassifier('L1')); await store.processSafety(b, fixtureClassifier('L2'));
  await responses().prepareSubmission(a.submissionId); const original = await response(a.submissionId), bytes = Buffer.from(original.payload_ciphertext); bytes[30] ^= 1;
  try {
    await db.query('UPDATE platform_onboarding_safety_responses SET payload_ciphertext=$2 WHERE id=$1', [original.id, bytes]);
    await assert.rejects(responses().prepareSubmission(b.submissionId), code('DATA_STORAGE_UNAVAILABLE'));
    assert.deepEqual(await counts(who), { responses: 2, events: 1 }); assert.equal((await response(b.submissionId)).status, 'pending');
    assert.equal((await response(b.submissionId)).payload_ciphertext, null);
  } finally { await db.query('UPDATE platform_onboarding_safety_responses SET payload_ciphertext=$2 WHERE id=$1', [original.id, original.payload_ciphertext]); }
  assert.equal((await responses().prepareSubmission(b.submissionId)).status, 'ready');
});

test('actual event level or retention corruption rejects both private read and ready replay without rewriting evidence', async () => {
  const who = await actor(), current = await detect(who); await responses().prepareSubmission(current.claim.submissionId);
  const original = await response(current.claim.submissionId), event = (await db.query('SELECT * FROM platform_safety_events WHERE response_id=$1', [original.id])).rows[0];
  for (const [column, value] of [['level', 'L1'], ['retention_until', new Date(event.retention_until.getTime() + 86400_000)]] as const) {
    try {
      await db.query(`UPDATE platform_safety_events SET ${column}=$2 WHERE id=$1`, [event.id, value]);
      const damaged = (await db.query('SELECT * FROM platform_safety_events WHERE id=$1', [event.id])).rows[0];
      await assert.rejects(responses(null).read(who), code('DATA_STORAGE_UNAVAILABLE'));
      await assert.rejects(responses(null).prepareSubmission(current.claim.submissionId), code('DATA_STORAGE_UNAVAILABLE'));
      assert.deepEqual(await response(current.claim.submissionId), original);
      assert.deepEqual((await db.query('SELECT * FROM platform_safety_events WHERE id=$1', [event.id])).rows[0], damaged);
      assert.deepEqual(await counts(who), { responses: 1, events: 1 });
    } finally { await db.query('UPDATE platform_safety_events SET level=$2,retention_until=$3 WHERE id=$1', [event.id, event.level, event.retention_until]); }
  }
  assert.equal((await responses(null).read(who))[0].status, 'ready');
});

test('cancellation after real ready UPDATE rolls ready ciphertext and its event back in the same transaction', async () => {
  const who = await actor(), current = await detect(who), controller = new AbortController(); let actualReadyUpdates = 0;
  class CancelAfterReadyDatabase extends Database {
    override withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
      return super.withBoundedTransaction(client => run(new Proxy(client, { get(target, key) {
        if (key === 'query') return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.query, target, args);
          if (typeof args[0] === 'string' && args[0].startsWith("UPDATE platform_onboarding_safety_responses SET status='ready'")) { actualReadyUpdates++; controller.abort(); }
          return result;
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } })), options);
    }
  }
  const cancelDb = new CancelAfterReadyDatabase(url.toString());
  try {
    await assert.rejects(responses(bundle, cancelDb).prepareSubmission(current.claim.submissionId, controller.signal), { name: 'AbortError' });
    assert.equal(actualReadyUpdates, 1); assert.equal((await response(current.claim.submissionId)).status, 'pending');
    assert.equal((await response(current.claim.submissionId)).payload_ciphertext, null); assert.deepEqual(await counts(who), { responses: 1, events: 0 });
  } finally { await cancelDb.close(); }
  assert.equal((await responses().prepareSubmission(current.claim.submissionId)).replayed, false);
});

test('ready replay rejects cancellation after the real event SELECT without changing the captured ciphertext or event', async () => {
  const who = await actor(), current = await detect(who); await responses().prepareSubmission(current.claim.submissionId);
  const original = await response(current.claim.submissionId), events = (await db.query('SELECT * FROM platform_safety_events WHERE user_id=$1', [who.userId])).rows;
  const controller = new AbortController(); let actualEventReads = 0;
  class CancelAfterEventReadDatabase extends Database {
    override withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
      return super.withBoundedTransaction(client => run(new Proxy(client, { get(target, key) {
        if (key === 'query') return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.query, target, args);
          if (typeof args[0] === 'string' && args[0].startsWith('SELECT * FROM platform_safety_events WHERE response_id=')) { actualEventReads++; controller.abort(); }
          return result;
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } })), options);
    }
  }
  const cancelDb = new CancelAfterEventReadDatabase(url.toString());
  try {
    await assert.rejects(responses(null, cancelDb).prepareSubmission(current.claim.submissionId, controller.signal), { name: 'AbortError' });
    assert.equal(actualEventReads, 1); assert.deepEqual(await response(current.claim.submissionId), original);
    assert.deepEqual((await db.query('SELECT * FROM platform_safety_events WHERE user_id=$1', [who.userId])).rows, events);
  } finally { await cancelDb.close(); }
});

test('prepareNext rejects a real ACCESS EXCLUSIVE lock within an explicit fixture deadline', { timeout: 10_000 }, async () => {
  const who = await actor(); await detect(who); const before = await counts(who), lock = await db.pool.connect();
  let boundedReads = 0, pending: ReturnType<OnboardingSafetyResponses['prepareNext']> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  class ShortFixtureDatabase extends Database {
    override withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
      assert.equal(options.readOnly, true); boundedReads++; return super.withBoundedTransaction(run, { ...options, timeoutMs: 200 });
    }
  }
  const boundedDb = new ShortFixtureDatabase(url.toString(), { max: 1 });
  try {
    await lock.query('BEGIN'); await lock.query('LOCK TABLE platform_onboarding_safety_submissions IN ACCESS EXCLUSIVE MODE');
    pending = responses(bundle, boundedDb).prepareNext(); pending.catch(() => {});
    // This separate escape guard releases no authority and makes an unbounded implementation fail instead of hanging QA.
    const unbounded = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Fictional bounded fixture did not finish.')), 1500); });
    await assert.rejects(Promise.race([pending, unbounded]), (error: unknown) => error instanceof DatabaseOperationTimeout || pgCode('55P03')(error) || pgCode('57014')(error));
    assert.equal(boundedReads, 1);
  } finally {
    clearTimeout(timer); await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); await boundedDb.close();
  }
  assert.deepEqual(await counts(who), before);
});

test('a real deferred event COMMIT rejection returns no ready receipt and preserves pending work for recovery', async () => {
  const who = await actor(), current = await detect(who); let installed = false;
  try {
    await db.query(`CREATE FUNCTION fictional_reject_response_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${who.userId}'::uuid THEN RAISE EXCEPTION 'Fictional response event commit rejected'; END IF; RETURN NEW; END $$`); installed = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_response_event_gate AFTER INSERT ON platform_safety_events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_response_event()`);
    await assert.rejects(responses().prepareSubmission(current.claim.submissionId), pgCode('P0001'));
    assert.deepEqual(await counts(who), { responses: 1, events: 0 }); const row = await response(current.claim.submissionId);
    assert.equal(row.status, 'pending'); assert.equal(row.payload_ciphertext, null); assert.equal(row.prepared_at, null); assert.equal(row.retention_until, null);
  } finally { if (installed) await db.query('DROP FUNCTION fictional_reject_response_event() CASCADE'); }
  assert.equal((await responses().prepareSubmission(current.claim.submissionId)).replayed, false);
  assert.deepEqual(await counts(who), { responses: 1, events: 1 });
});

test('SQL enforces non-null retention for ready responses and source ownership uses actual foreign keys', async () => {
  const who = await actor(), other = await actor(), current = await detect(who); await responses().prepareSubmission(current.claim.submissionId);
  const row = await response(current.claim.submissionId);
  await assert.rejects(db.query('UPDATE platform_onboarding_safety_responses SET retention_until=NULL WHERE id=$1', [row.id]), pgCode('23514'));
  await assert.rejects(db.query('UPDATE platform_onboarding_safety_responses SET user_id=$2 WHERE id=$1', [row.id, other.userId]), pgCode('23503'));
  assert.equal((await response(current.claim.submissionId)).retention_until.toISOString(), row.retention_until.toISOString());
  assert.equal((await response(current.claim.submissionId)).user_id, who.userId);
});

test('deleting the actual owner cascades private capture and event references and cannot resurrect a response', async () => {
  const who = await actor(), current = await detect(who); await responses().prepareSubmission(current.claim.submissionId);
  assert.deepEqual(await counts(who), { responses: 1, events: 1 });
  await db.query('DELETE FROM platform_users WHERE id=$1', [who.userId]);
  assert.deepEqual(await counts(who), { responses: 0, events: 0 }); assert.equal(await source(current.claim.submissionId), undefined);
  await assert.rejects(responses().prepareSubmission(current.claim.submissionId), code('NOT_FOUND'));
  await assert.rejects(responses().read(who), code('AUTH_REQUIRED'));
  assert.equal((await db.query('SELECT id FROM platform_users WHERE id=$1', [policyOwner])).rowCount, 1);
  assert.equal((await db.query('SELECT activated_by FROM platform_safety_response_policy WHERE singleton=true')).rows[0].activated_by, policyOwner);
});

test('private projection strips reviewer references and user text; ready questions remain proposals without delivery or 24-hour evidence', async () => {
  const who = await actor(), current = await detect(who); await responses().prepareSubmission(current.claim.submissionId);
  const original = await response(current.claim.submissionId), first = await responses().read(who), second = await responses().read(who);
  assert.deepEqual(first, second); assert(first[0].response); assert.equal(typeof first[0].response.question, 'string');
  const publicJson = JSON.stringify(first); assert.equal(publicJson.includes(current.raw), false); assert.equal(publicJson.includes('reviewRef'), false);
  assert.equal(publicJson.includes('fictional-contact-integrity-reference'), false); assert.equal(publicJson.includes('content_digest'), false);
  assert.equal(first[0].response.resourceCard.contacts[0].verifiedAt, bundle.resources.contacts[0].verifiedAt);
  const event = (await db.query('SELECT * FROM platform_safety_events WHERE response_id=$1', [original.id])).rows[0];
  assert.equal(event.event_kind, 'response_prepared'); assert.equal(Object.hasOwn(event, 'asked_at'), false); assert.equal(Object.hasOwn(event, 'delivered_at'), false);
  const columns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1
    AND table_name IN ('platform_onboarding_safety_responses','platform_safety_events')`, [schema])).rows.map(row => row.column_name);
  for (const absent of ['raw_text', 'message_text', 'delivered_at', 'seen_at', 'asked_at']) assert.equal(columns.includes(absent), false);
  assert.deepEqual(await counts(who), { responses: 1, events: 1 }); assert.deepEqual((await response(current.claim.submissionId)).payload_ciphertext, original.payload_ciphertext);
});

test('database time suppresses an authentic expired historical capture without claiming it was delivered', async () => {
  const who = await actor(), current = await detect(who); await responses().prepareSubmission(current.claim.submissionId);
  const row = await response(current.claim.submissionId), payload = capture(row);
  const times = (await db.query("SELECT clock_timestamp()-interval '18 days' AS prepared,clock_timestamp()-interval '1 day' AS until")).rows[0];
  payload.preparedAt = times.prepared.toISOString(); payload.retentionUntil = times.until.toISOString();
  const historicalCipher = crypto.sealUtf8(JSON.stringify(payload), { table: 'platform_onboarding_safety_responses', column: 'payload_ciphertext', rowId: row.id, ownerId: who.userId, revision: 1 });
  await db.transaction(async client => {
    await client.query('UPDATE platform_onboarding_safety_responses SET payload_ciphertext=$2,prepared_at=$3,retention_until=$4 WHERE id=$1', [row.id, historicalCipher, times.prepared, times.until]);
    await client.query('UPDATE platform_safety_events SET created_at=$2,retention_until=$3 WHERE response_id=$1', [row.id, times.prepared, times.until]);
  });
  const result = await responses(null).read(who); assert.equal(result[0].status, 'expired'); assert.equal(Object.hasOwn(result[0], 'response'), false);
  assert.equal((await responses(null).prepareSubmission(current.claim.submissionId)).replayed, true);
  assert.deepEqual(await counts(who), { responses: 1, events: 1 });
});
