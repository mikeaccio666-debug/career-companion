import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OnboardingAction, OnboardingFollowupAction, OnboardingFollowupCommand, ProviderRequestAdmission } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { OnboardingSafetyResponses } from '../src/onboarding-safety-responses.ts';
import { OnboardingSafetyFollowup } from '../src/onboarding-safety-followup.ts';
import { CompanionIntakePreparation } from '../src/companion-intake-preparation.ts';
import { fictionalBundle } from './fixtures/onboarding-followup.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Genuine isolated PostgreSQL transactions, encrypted sources and classifier admission.
// Every actor, text, resource and review reference is synthetic; no paid provider or clinical approval.
const base = readConfig(), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use only isolated loopback PostgreSQL.');
assert.notEqual(url.port, '5442', 'Do not target the local development database.');
const schema = 'onboarding_followup_' + randomUUID().replaceAll('-', '');
url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: 'a8'.repeat(32) })!;
const config = { dataCrypto: crypto, requireVerifiedEmail: true }, bundle = fictionalBundle();
const drafts = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
const responses = new OnboardingSafetyResponses(db, config, FICTIONAL_LEGAL, bundle);
const followup = (database = db) => new OnboardingSafetyFollowup(database, config, FICTIONAL_LEGAL);
let created = false;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true;
  await db.migrate(); await seedFictionalActiveLegal(db);
  const owner = await actor();
  await db.query(`INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4)`, [bundle.revision, bundle.contentDigest, bundle.reviewDigest, owner.userId]);
});
after(async () => {
  try { await db.close(); }
  finally {
    try {
      if (created) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
        console.log('Follow-up fixture schema cleanup confirmed: ' + schema);
      }
    } finally { await admin.close(); }
  }
});
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const pgCode = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const command = (expectedRevision: number, action: OnboardingAction) => ({ expectedRevision, operationId: randomUUID(), action });
const operation = (expectedDraftRevision: number, publicationId: string, action: OnboardingFollowupAction): OnboardingFollowupCommand =>
  ({ expectedDraftRevision, publicationId, operationId: randomUUID(), action });
async function session(userId: string): Promise<FixedSessionContext> {
  const hash = tokenHash(randomUUID());
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    SELECT id,$2,auth_version,clock_timestamp()+interval '1 hour' FROM platform_users WHERE id=$1`, [userId, hash]);
  return { userId, tokenHash: hash };
}
async function actor(): Promise<FixedSessionContext> {
  const userId = randomUUID();
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional follow-up student','fictional-unused-hash','student',clock_timestamp())`, [userId, userId + '@example.invalid']);
  await seedFictionalConsent(db, userId); return session(userId);
}
async function text(who: FixedSessionContext, syntheticText?: string) {
  let draft = await drafts.read(who);
  if (!draft) draft = (await drafts.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  assert(draft.currentQuestion);
  const raw = syntheticText ?? 'Synthetic private follow-up text ' + randomUUID();
  const input = command(draft.revision, { kind: 'text', questionId: draft.currentQuestion, text: raw });
  return { input, raw, saved: await drafts.save(who, input) };
}
const classifier = (level: 'L0' | 'L1' | 'L2', mode: 'full' | 'keyword_only' = 'full') =>
  async (_input: { text: string; questionId: string }, admission: ProviderRequestAdmission) => admission(async signal => {
    signal.throwIfAborted();
    return level === 'L0' ? { level, mode: 'full', resolution: { kind: 'unmatched' } } : { level, mode };
  });
async function detected(who: FixedSessionContext, level: 'L0' | 'L1' | 'L2' = 'L2', mode: 'full' | 'keyword_only' = 'full') {
  const pending = await text(who), claim = await drafts.claimSafety(who, { detectorRevision: 17 }); assert(claim);
  await drafts.processSafety(claim, classifier(level, mode));
  return { ...pending, claim };
}
async function ready(who: FixedSessionContext, level: 'L1' | 'L2' = 'L2', mode: 'full' | 'keyword_only' = 'full') {
  const source = await detected(who, level, mode);
  await responses.prepareSubmission(source.claim.submissionId); return source;
}
async function row(table: string, key: string, id: string) {
  assert(['platform_onboarding_operations', 'platform_onboarding_safety_submissions', 'platform_onboarding_safety_responses', 'platform_onboarding_safety_publications', 'platform_onboarding_safety_followups'].includes(table));
  assert(['id', 'submission_id', 'operation_id'].includes(key));
  return (await db.query(`SELECT * FROM ${table} WHERE ${key}=$1`, [id])).rows[0];
}
async function counts(who: FixedSessionContext) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM platform_onboarding_safety_publications WHERE user_id=$1) AS publications,
    (SELECT count(*)::int FROM platform_onboarding_safety_followups WHERE user_id=$1) AS followups,
    (SELECT count(*)::int FROM platform_onboarding_safety_followups WHERE user_id=$1 AND handled) AS handled`, [who.userId])).rows[0];
}
async function published(who: FixedSessionContext) {
  const source = await ready(who), state = await followup().read(who);
  assert(state.draft); assert.equal(state.publications.length, 1);
  return { ...source, draft: state.draft, publication: state.publications[0] };
}
async function present(who: FixedSessionContext, publicationId: string, revision: number) {
  const input = operation(revision, publicationId, { kind: 'present' }), result = await followup().act(who, input);
  assert(result.presentationReceipt); return { input, result, handle: result.presentationReceipt };
}
async function acknowledged(who: FixedSessionContext, publicationId: string, revision: number) {
  const shown = await present(who, publicationId, revision);
  const input = operation(revision, publicationId, { kind: 'acknowledge', presentationReceipt: shown.handle });
  const result = await followup().act(who, input); return { ...shown, ackInput: input, ack: result };
}

test('a genuine ready capture is published once but is neither presented nor acknowledged and cannot unblock intake', async () => {
  const who = await actor(), source = await ready(who);
  assert.deepEqual(await counts(who), { publications: 0, followups: 0, handled: 0 });
  const first = await followup().read(who), second = await followup().read(who);
  assert.deepEqual(first, second); assert(first.draft); assert.equal(first.publications.length, 1);
  const card = first.publications[0];
  assert.equal(card.presented, false); assert.equal(card.acknowledged, false); assert.equal(card.handled, false);
  assert.equal(first.draft.state, 'safety_paused'); assert.equal(first.safety.status, 'blocked');
  assert.equal(card.level, 'L2'); assert.equal(card.response.resourceCard.contacts.length, 3); assert(card.response.question);
  const json = JSON.stringify(first);
  for (const absent of [source.raw, 'reviewRef', 'content_digest', 'review_digest', 'fictional-contact-integrity-reference', 'presentationReceipt']) assert.equal(json.includes(absent), false);
  await assert.rejects(followup().act(who, operation(first.draft.revision, card.publicationId,
    { kind: 'continue_intake', presentationReceipt: 'a'.repeat(43) })), code('ONBOARDING_SAFETY_PRESENTATION_REQUIRED'));
  assert.deepEqual(await counts(who), { publications: 1, followups: 0, handled: 0 });
});

test('actual publication, presentation and acknowledgment remain separate from explicit same-question continuation and a fresh classified text', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const original = await row('platform_onboarding_safety_submissions', 'id', current.claim.submissionId);
  const before = current.draft, shown = await present(who, id, before.revision);
  const persistedPresent = await row('platform_onboarding_safety_followups', 'operation_id', shown.input.operationId);
  assert.equal(persistedPresent.presentation_digest, tokenHash(shown.handle));
  assert.equal(persistedPresent.payload_ciphertext.includes(Buffer.from(shown.handle)), false);
  assert.equal(shown.result.draft.revision, before.revision); assert.equal(shown.result.resumeStatus, 'not_requested');
  await assert.rejects(followup().act(who, operation(before.revision, id,
    { kind: 'continue_intake', presentationReceipt: shown.handle })), code('ONBOARDING_SAFETY_ACKNOWLEDGMENT_REQUIRED'));
  const ack = await followup().act(who, operation(before.revision, id, { kind: 'acknowledge', presentationReceipt: shown.handle }));
  assert.equal(ack.draft.state, 'safety_paused'); assert.equal(ack.draft.revision, before.revision);
  const stillPaused = await followup().read(who); assert.equal(stillPaused.safety.status, 'blocked');
  assert.equal(stillPaused.publications[0].acknowledged, true); assert.equal(stillPaused.publications[0].handled, false);
  assert.equal(stillPaused.publications[0].response.question, undefined);
  assert.deepEqual(stillPaused.publications[0].response.resourceCard, current.publication.response.resourceCard);
  const continued = await followup().act(who, operation(before.revision, id, { kind: 'continue_intake', presentationReceipt: shown.handle }));
  assert.equal(continued.resumeStatus, 'resumed'); assert.equal(continued.draft.revision, before.revision + 1);
  assert.equal(continued.draft.state, 'collecting'); assert.equal(continued.draft.currentQuestion, before.currentQuestion);
  assert.deepEqual(continued.draft.answersPartial, before.answersPartial); assert.equal(continued.draft.safety, undefined);
  assert.deepEqual(await row('platform_onboarding_safety_submissions', 'id', current.claim.submissionId), original);
  assert.equal((await drafts.readSafety(who)).status, 'clear');
  const next = await text(who); assert.equal(next.saved.draft.state, 'safety_pending');
  assert.equal((await drafts.readSafety(who)).pendingCount, 1);
  const fresh = await drafts.claimSafety(who, { detectorRevision: 18 }); assert(fresh);
  assert.notEqual(fresh.submissionId, current.claim.submissionId); assert.equal(fresh.operationId, next.input.operationId);
  await drafts.processSafety(fresh, classifier('L0'));
  const final = await drafts.read(who); assert(final); assert.equal(final.currentQuestion, 'graduation');
  assert.equal(final.answersPartial.study?.kind, 'skipped'); assert.equal((await drafts.readSafety(who)).status, 'clear');
  const history = (await db.query('SELECT id,level,detector_mode FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision', [who.userId])).rows;
  assert.deepEqual(history.map(item => item.level), ['L2', 'L0']); assert.equal(history[1].detector_mode, 'full');
  assert.equal((await followup().read(who)).publications[0].handled, true);
});

test('an older genuine L2 plus superseding persisted full L0 can be handled without leaving the newer answer permanently pending', async () => {
  const who = await actor(), old = await text(who), latest = await text(who);
  const a = await drafts.claimSafety(who, { detectorRevision: 17 }), b = await drafts.claimSafety(who, { detectorRevision: 17 }); assert(a); assert(b);
  assert.equal(a.operationId, old.input.operationId); assert.equal(b.operationId, latest.input.operationId);
  await drafts.processSafety(b, classifier('L0')); await drafts.processSafety(a, classifier('L2'));
  await responses.prepareSubmission(a.submissionId);
  const state = await followup().read(who); assert(state.draft); assert.equal(state.draft.state, 'safety_pending');
  assert.equal(state.draft.pendingText?.id, b.operationId); assert.equal(state.safety.status, 'blocked');
  const card = state.publications[0], ack = await acknowledged(who, card.publicationId, state.draft.revision);
  const result = await followup().act(who, operation(state.draft.revision, card.publicationId,
    { kind: 'continue_intake', presentationReceipt: ack.handle }));
  assert.equal(result.resumeStatus, 'resumed'); assert.equal(result.draft.state, 'collecting');
  assert.equal(result.draft.currentQuestion, 'graduation'); assert.equal(result.draft.revision, state.draft.revision + 1);
  assert.equal((await row('platform_onboarding_safety_submissions', 'id', a.submissionId)).level, 'L2');
  assert.equal((await row('platform_onboarding_safety_submissions', 'id', b.submissionId)).level, 'L0');
  assert.equal((await drafts.readSafety(who)).status, 'clear');
});

test('handling an older risk while a newer genuine source is still pending waits for its actual fresh classification', async () => {
  const who = await actor(); await text(who); const latest = await text(who);
  const a = await drafts.claimSafety(who, { detectorRevision: 17 }); assert(a);
  await drafts.processSafety(a, classifier('L1', 'keyword_only')); await responses.prepareSubmission(a.submissionId);
  const state = await followup().read(who); assert(state.draft);
  const ack = await acknowledged(who, state.publications[0].publicationId, state.draft.revision);
  const result = await followup().act(who, operation(state.draft.revision, state.publications[0].publicationId,
    { kind: 'continue_intake', presentationReceipt: ack.handle }));
  assert.equal(result.resumeStatus, 'waiting_for_safety'); assert.equal(result.draft.revision, state.draft.revision);
  assert.equal(result.draft.state, 'safety_pending'); assert.equal(result.draft.pendingText?.id, latest.input.operationId);
  const next = await drafts.claimSafety(who, { detectorRevision: 18 }); assert(next);
  const completed = await drafts.processSafety(next, classifier('L0')); assert.equal(completed.advanced, true);
  assert.equal((await drafts.read(who))?.currentQuestion, 'graduation'); assert.equal((await drafts.readSafety(who)).status, 'clear');
});

test('a current L2 continuation waiting for an older running source automatically resumes the same unanswered question when that source genuinely completes L0', async () => {
  const who = await actor(); await text(who); await text(who);
  const a = await drafts.claimSafety(who, { detectorRevision: 17 }), b = await drafts.claimSafety(who, { detectorRevision: 17 }); assert(a); assert(b);
  await drafts.processSafety(b, classifier('L2')); await responses.prepareSubmission(b.submissionId);
  const state = await followup().read(who); assert(state.draft); assert.equal(state.draft.state, 'safety_paused');
  const id = state.publications[0].publicationId, ack = await acknowledged(who, id, state.draft.revision);
  const waiting = await followup().act(who, operation(state.draft.revision, id, { kind: 'continue_intake', presentationReceipt: ack.handle }));
  assert.equal(waiting.resumeStatus, 'waiting_for_safety'); assert.equal(waiting.draft.revision, state.draft.revision);
  assert.equal(waiting.draft.state, 'safety_paused'); assert.equal((await counts(who)).handled, 1);
  const completed = await drafts.processSafety(a, classifier('L0')); assert.equal(completed.advanced, true);
  const resumed = await drafts.read(who); assert(resumed); assert.equal(resumed.state, 'collecting');
  assert.equal(resumed.currentQuestion, 'study'); assert.equal(resumed.revision, state.draft.revision + 1);
  assert.equal(resumed.answersPartial.study, undefined); assert.equal(resumed.safety, undefined);
  assert.equal((await row('platform_onboarding_safety_submissions', 'id', b.submissionId)).level, 'L2');
  assert.equal((await row('platform_onboarding_safety_submissions', 'id', a.submissionId)).level, 'L0');
  assert.equal((await drafts.readSafety(who)).status, 'clear');
  const next = await drafts.save(who, command(resumed.revision, { kind: 'skip', questionId: 'study' }));
  assert.equal(next.draft.currentQuestion, 'graduation');
});

test('multiple historical risks require their own real presentations and acknowledgments before the last continuation resumes', async () => {
  const who = await actor(); await text(who); await text(who);
  const a = await drafts.claimSafety(who, { detectorRevision: 17 }), b = await drafts.claimSafety(who, { detectorRevision: 17 }); assert(a); assert(b);
  await drafts.processSafety(a, classifier('L1')); await drafts.processSafety(b, classifier('L2'));
  await responses.prepareSubmission(a.submissionId); await responses.prepareSubmission(b.submissionId);
  const state = await followup().read(who); assert(state.draft); assert.equal(state.publications.length, 2);
  const first = state.publications.find(item => item.submissionId === a.submissionId)!;
  const second = state.publications.find(item => item.submissionId === b.submissionId)!;
  const ack = await acknowledged(who, first.publicationId, state.draft.revision);
  const partial = await followup().act(who, operation(state.draft.revision, first.publicationId,
    { kind: 'continue_intake', presentationReceipt: ack.handle }));
  assert.equal(partial.resumeStatus, 'remaining_safety'); assert.equal(partial.draft.state, 'safety_paused');
  assert.equal(partial.draft.revision, state.draft.revision); assert.equal((await drafts.readSafety(who)).blockedLevel, 'L2');
  await assert.rejects(followup().act(who, operation(state.draft.revision, second.publicationId,
    { kind: 'acknowledge', presentationReceipt: ack.handle })), code('ONBOARDING_SAFETY_PRESENTATION_REQUIRED'));
  const secondAck = await acknowledged(who, second.publicationId, state.draft.revision);
  const final = await followup().act(who, operation(state.draft.revision, second.publicationId,
    { kind: 'continue_intake', presentationReceipt: secondAck.handle }));
  assert.equal(final.resumeStatus, 'resumed'); assert.equal(final.draft.currentQuestion, 'study');
  assert.equal(final.draft.revision, state.draft.revision + 1); assert.equal((await counts(who)).handled, 2);
});

test('need-support records a distinct non-clearance event and keeps the original resource card and L2 pause', async () => {
  const who = await actor(), current = await published(who);
  const result = await followup().act(who, operation(current.draft.revision, current.publication.publicationId, { kind: 'need_support' }));
  assert.equal(result.resumeStatus, 'not_requested'); assert.equal(result.presentationReceipt, undefined);
  assert.equal(result.draft.state, 'safety_paused'); assert.equal(result.draft.revision, current.draft.revision);
  const state = await followup().read(who); assert.equal(state.safety.status, 'blocked');
  assert.deepEqual(state.publications[0].response, current.publication.response);
  assert.equal(state.publications[0].presented, false); assert.equal(state.publications[0].acknowledged, false); assert.equal(state.publications[0].handled, false);
});

test('clarification requires both explicit declarations and a real acknowledgment, preserves original L2 and marks clarification time', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const shown = await present(who, id, current.draft.revision);
  const clarify = operation(current.draft.revision, id, { kind: 'clarify_exaggeration', presentationReceipt: shown.handle, safe: true, exaggeration: true });
  for (const field of ['safe', 'exaggeration'] as const) {
    const action = { ...clarify.action, [field]: false };
    await assert.rejects(followup().act(who, { ...clarify, operationId: randomUUID(), action }), code('INVALID_INPUT'));
  }
  await assert.rejects(followup().act(who, clarify), code('ONBOARDING_SAFETY_ACKNOWLEDGMENT_REQUIRED'));
  await followup().act(who, operation(current.draft.revision, id, { kind: 'acknowledge', presentationReceipt: shown.handle }));
  const result = await followup().act(who, clarify); assert.equal(result.resumeStatus, 'resumed');
  const state = await followup().read(who), saved = await row('platform_onboarding_safety_followups', 'operation_id', clarify.operationId);
  assert(state.publications[0].clarifiedAt); assert.equal(saved.clarified_at.toISOString(), state.publications[0].clarifiedAt);
  assert.equal((await row('platform_onboarding_safety_submissions', 'id', current.claim.submissionId)).level, 'L2');
  assert.deepEqual(state.publications[0].response.resourceCard, current.publication.response.resourceCard);
  assert.equal(state.publications[0].response.text, current.publication.response.text); assert.equal(state.publications[0].handled, true);
});

test('exact current session and owner are enforced even when another real session can read the same resource projection', async () => {
  const who = await actor(), other = await actor(), current = await published(who), second = await session(who.userId);
  const id = current.publication.publicationId, shown = await present(who, id, current.draft.revision);
  assert.equal((await followup().read(other)).publications.length, 0);
  await drafts.save(other, command(0, { kind: 'start', mode: 'standard' }));
  await assert.rejects(followup().act(other, operation(1, id, { kind: 'present' })), code('NOT_FOUND'));
  await assert.rejects(followup().read({ userId: other.userId, tokenHash: who.tokenHash }), code('AUTH_REQUIRED'));
  await assert.rejects(followup().read({ userId: who.userId, tokenHash: tokenHash(randomUUID()) }), code('AUTH_REQUIRED'));
  const reread = await followup().read(second); assert.equal(reread.publications[0].presented, true);
  await assert.rejects(followup().act(second, operation(current.draft.revision, id,
    { kind: 'acknowledge', presentationReceipt: shown.handle })), code('ONBOARDING_SAFETY_PRESENTATION_REQUIRED'));
  await assert.rejects(followup().act(second, shown.input), code('ONBOARDING_OPERATION_CONFLICT'));
  const replacement = await present(second, id, current.draft.revision); assert.notEqual(replacement.handle, shown.handle);
  await followup().act(second, operation(current.draft.revision, id, { kind: 'acknowledge', presentationReceipt: replacement.handle }));
  const continued = await followup().act(second, operation(current.draft.revision, id,
    { kind: 'continue_intake', presentationReceipt: replacement.handle }));
  assert.equal(continued.resumeStatus, 'resumed'); assert.equal((await counts(who)).handled, 1);
});

test('unknown, forged and wrong-publication handles cannot acknowledge, and session expiry or password reset invalidates real handles', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const shown = await present(who, id, current.draft.revision);
  for (const handle of ['b'.repeat(43), shown.handle.slice(0, -1) + (shown.handle.endsWith('a') ? 'b' : 'a')]) {
    await assert.rejects(followup().act(who, operation(current.draft.revision, id,
      { kind: 'acknowledge', presentationReceipt: handle })), code('ONBOARDING_SAFETY_PRESENTATION_REQUIRED'));
  }
  await assert.rejects(followup().act(who, operation(current.draft.revision, randomUUID(),
    { kind: 'acknowledge', presentationReceipt: shown.handle })), code('NOT_FOUND'));
  await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [who.tokenHash]);
  await assert.rejects(followup().act(who, operation(current.draft.revision, id,
    { kind: 'acknowledge', presentationReceipt: shown.handle })), code('AUTH_REQUIRED'));
  await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE token_hash=$1", [who.tokenHash]);
  await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
  await assert.rejects(followup().read(who), code('AUTH_REQUIRED'));
  await assert.rejects(followup().act(who, shown.input), code('AUTH_REQUIRED'));
  assert.deepEqual(await counts(who), { publications: 1, followups: 1, handled: 0 });
});

test('same-operation replay returns current state without storing or regenerating presentation secrets, and changed intent conflicts', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const shown = await present(who, id, current.draft.revision), replay = await followup().act(who, shown.input);
  assert.equal(replay.operation.replayed, true); assert.equal(replay.presentationReceipt, undefined);
  await assert.rejects(followup().act(who, { ...shown.input, action: { kind: 'need_support' } }), code('ONBOARDING_OPERATION_CONFLICT'));
  const ackInput = operation(current.draft.revision, id, { kind: 'acknowledge', presentationReceipt: shown.handle });
  await followup().act(who, ackInput);
  const continueInput = operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: shown.handle });
  const first = await followup().act(who, continueInput), again = await followup().act(who, continueInput);
  assert.equal(first.operation.replayed, false); assert.equal(again.operation.replayed, true); assert.deepEqual(again.draft, first.draft);
  assert.equal((await followup().act(who, shown.input)).draft.revision, first.draft.revision);
  await assert.rejects(followup().act(who, { ...continueInput, expectedDraftRevision: first.draft.revision }), code('ONBOARDING_OPERATION_CONFLICT'));
  assert.deepEqual(await counts(who), { publications: 1, followups: 3, handled: 1 });
  const rowPresent = await row('platform_onboarding_safety_followups', 'operation_id', shown.input.operationId);
  const capture = JSON.parse(crypto.openUtf8(rowPresent.payload_ciphertext, { table: 'platform_onboarding_safety_followups', column: 'payload_ciphertext', rowId: rowPresent.operation_id, ownerId: who.userId, revision: rowPresent.applied_revision }));
  assert.equal(JSON.stringify(capture).includes(shown.handle), false); assert.equal(capture.presentationDigest, tokenHash(shown.handle));
});

test('revision CAS and the shared operation namespace prevent stale continuation and reuse of an existing text operation', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  await assert.rejects(followup().act(who, operation(current.draft.revision - 1, id, { kind: 'present' })), code('ONBOARDING_REVISION_CHANGED'));
  await assert.rejects(followup().act(who, { ...operation(current.draft.revision, id, { kind: 'present' }), operationId: current.input.operationId }), code('ONBOARDING_OPERATION_CONFLICT'));
  const ack = await acknowledged(who, id, current.draft.revision);
  const finished = await followup().act(who, operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: ack.handle }));
  await assert.rejects(followup().act(who, operation(current.draft.revision, id,
    { kind: 'continue_intake', presentationReceipt: ack.handle })), code('ONBOARDING_REVISION_CHANGED'));
  await assert.rejects(followup().act(who, operation(finished.draft.revision, id,
    { kind: 'continue_intake', presentationReceipt: ack.handle })), code('ONBOARDING_STATE_CHANGED'));
  await assert.rejects(drafts.save(who, { ...command(finished.draft.revision, { kind: 'skip', questionId: 'study' }),
    operationId: ack.input.operationId }), code('ONBOARDING_OPERATION_CONFLICT'));
  assert.equal((await counts(who)).handled, 1);
});

test('real concurrent duplicate clicks commit exactly one follow-up and one draft revision', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const ack = await acknowledged(who, id, current.draft.revision);
  const input = operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: ack.handle });
  const results = await Promise.all(Array.from({ length: 5 }, () => followup().act(who, input)));
  assert.equal(results.filter(item => !item.operation.replayed).length, 1);
  assert.deepEqual(results.map(item => item.draft.revision), Array(5).fill(current.draft.revision + 1));
  assert.deepEqual(await counts(who), { publications: 1, followups: 3, handled: 1 });
});

test('concurrent different continuation IDs serialize and the losing stale click cannot create a second handled row', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const ack = await acknowledged(who, id, current.draft.revision);
  const inputs = Array.from({ length: 2 }, () => operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: ack.handle }));
  const results = await Promise.allSettled(inputs.map(input => followup().act(who, input)));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = results.find(item => item.status === 'rejected'); assert(rejected && rejected.status === 'rejected');
  assert(code('ONBOARDING_REVISION_CHANGED')(rejected.reason));
  assert.equal((await drafts.read(who))?.revision, current.draft.revision + 1); assert.equal((await counts(who)).handled, 1);
});

test('resource read, presentation and acknowledgment do not depend on current terms, verified email, provider or ordinary quotas; continuation still does', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [who.userId]);
  await db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [who.userId]);
  const resourceConfig = { ...config, safetyDailyModelCallLimit: 0 };
  const service = new OnboardingSafetyFollowup(db, resourceConfig, null);
  assert.equal((await service.read(who)).publications.length, 1);
  const shown = await service.act(who, operation(current.draft.revision, id, { kind: 'present' })); assert(shown.presentationReceipt);
  const ack = await service.act(who, operation(current.draft.revision, id, { kind: 'acknowledge', presentationReceipt: shown.presentationReceipt }));
  assert.equal(ack.draft.state, 'safety_paused');
  const continueInput = operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: shown.presentationReceipt });
  await assert.rejects(followup().act(who, continueInput), code('EMAIL_VERIFICATION_REQUIRED'));
  await db.query('UPDATE platform_users SET email_verified_at=clock_timestamp() WHERE id=$1', [who.userId]);
  await assert.rejects(followup().act(who, continueInput), code('TERMS_CONFIRMATION_REQUIRED'));
  await seedFictionalConsent(db, who.userId);
  assert.equal((await followup().act(who, continueInput)).resumeStatus, 'resumed');
  const usage = (await db.query(`SELECT (SELECT count(*)::int FROM platform_safety_model_usage) AS safety_calls,
    (SELECT count(*)::int FROM platform_cost_ledger) AS model_costs,
    (SELECT count(*)::int FROM platform_jobs) AS jobs,(SELECT count(*)::int FROM platform_messages) AS messages`)).rows[0];
  assert.deepEqual(usage, { safety_calls: 0, model_costs: 0, jobs: 0, messages: 0 });
});

/** Shift authentic encrypted fixture history as a whole, rather than corrupting unauthenticated metadata. */
async function agePublicationHistory(id: string, ageMs = 18 * 86400_000) {
  const publication = await row('platform_onboarding_safety_publications', 'id', id);
  const response = await row('platform_onboarding_safety_responses', 'id', publication.response_id);
  const shift = (at: Date) => new Date(at.getTime() - ageMs);
  const responsePayload = JSON.parse(crypto.openUtf8(response.payload_ciphertext, { table: 'platform_onboarding_safety_responses', column: 'payload_ciphertext', rowId: response.id, ownerId: response.user_id, revision: 1 }));
  responsePayload.preparedAt = shift(response.prepared_at).toISOString(); responsePayload.retentionUntil = shift(response.retention_until).toISOString();
  const responseCipher = crypto.sealUtf8(JSON.stringify(responsePayload), { table: 'platform_onboarding_safety_responses', column: 'payload_ciphertext', rowId: response.id, ownerId: response.user_id, revision: 1 });
  const publicationPayload = JSON.parse(crypto.openUtf8(publication.payload_ciphertext, { table: 'platform_onboarding_safety_publications', column: 'payload_ciphertext', rowId: publication.id, ownerId: publication.user_id, revision: 1 }));
  publicationPayload.preparedAt = responsePayload.preparedAt; publicationPayload.publishedAt = shift(publication.published_at).toISOString(); publicationPayload.retentionUntil = responsePayload.retentionUntil;
  const publicationCipher = crypto.sealUtf8(JSON.stringify(publicationPayload), { table: 'platform_onboarding_safety_publications', column: 'payload_ciphertext', rowId: publication.id, ownerId: publication.user_id, revision: 1 });
  const operations = (await db.query('SELECT * FROM platform_onboarding_safety_followups WHERE publication_id=$1', [id])).rows;
  await db.transaction(async client => {
    await client.query('UPDATE platform_onboarding_safety_responses SET payload_ciphertext=$2,prepared_at=$3,retention_until=$4 WHERE id=$1', [response.id, responseCipher, responsePayload.preparedAt, responsePayload.retentionUntil]);
    await client.query('UPDATE platform_safety_events SET created_at=$2,retention_until=$3 WHERE response_id=$1', [response.id, responsePayload.preparedAt, responsePayload.retentionUntil]);
    await client.query('UPDATE platform_onboarding_safety_publications SET payload_ciphertext=$2,published_at=$3,retention_until=$4 WHERE id=$1', [id, publicationCipher, publicationPayload.publishedAt, publicationPayload.retentionUntil]);
    for (const saved of operations) {
      const payload = JSON.parse(crypto.openUtf8(saved.payload_ciphertext, { table: 'platform_onboarding_safety_followups', column: 'payload_ciphertext', rowId: saved.operation_id, ownerId: saved.user_id, revision: saved.applied_revision }));
      payload.at = shift(saved.created_at).toISOString(); if (payload.clarifiedAt !== null) payload.clarifiedAt = payload.at;
      const ciphertext = crypto.sealUtf8(JSON.stringify(payload), { table: 'platform_onboarding_safety_followups', column: 'payload_ciphertext', rowId: saved.operation_id, ownerId: saved.user_id, revision: saved.applied_revision });
      await client.query('UPDATE platform_onboarding_safety_followups SET payload_ciphertext=$2,created_at=$3,clarified_at=$4 WHERE user_id=$5 AND operation_id=$1', [saved.operation_id, ciphertext, payload.at, payload.clarifiedAt, saved.user_id]);
    }
  });
}

test('an authentic expired publication is hidden and cannot create a fresh presentation, acknowledgment or support event', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  await agePublicationHistory(id);
  const state = await followup().read(who); assert.equal(state.publications.length, 0);
  assert.deepEqual(state.pendingResponses, [{ responseId: current.publication.responseId, submissionId: current.claim.submissionId, status: 'expired' }]);
  for (const action of [{ kind: 'present' }, { kind: 'need_support' }, { kind: 'acknowledge', presentationReceipt: 'a'.repeat(43) }] as const) {
    await assert.rejects(followup().act(who, operation(current.draft.revision, id, action)), code('ONBOARDING_SAFETY_RESPONSE_EXPIRED'));
  }
  assert.deepEqual(await counts(who), { publications: 1, followups: 0, handled: 0 }); assert.equal(state.safety.status, 'blocked');
});

test('valid historical presentation and acknowledgment permit explicit continuation after retention expiry without recreating a card or fresh handle', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const ack = await acknowledged(who, id, current.draft.revision); await agePublicationHistory(id);
  const before = await counts(who);
  const result = await followup().act(who, operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: ack.handle }));
  assert.equal(result.resumeStatus, 'resumed'); assert.equal(result.presentationReceipt, undefined);
  assert.equal(result.draft.state, 'collecting'); assert.equal(result.draft.currentQuestion, 'study');
  const state = await followup().read(who); assert.equal(state.publications.length, 0); assert.equal(state.safety.status, 'clear');
  assert.equal((await counts(who)).publications, before.publications); assert.equal((await counts(who)).followups, before.followups + 1);
  assert.equal((await row('platform_onboarding_safety_submissions', 'id', current.claim.submissionId)).level, 'L2');
});

test('the same publication suppresses its safety question only after a real recent presentation; history bytes and a new high-risk signal stay distinct', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const before = await row('platform_onboarding_safety_publications', 'id', id);
  assert((await followup().read(who)).publications[0].response.question);
  assert((await followup().read(who)).publications[0].response.question);
  const ack = await acknowledged(who, id, current.draft.revision);
  const afterPresent = await followup().read(who);
  assert.equal(afterPresent.publications[0].response.question, undefined);
  assert.deepEqual(afterPresent.publications[0].response.resourceCard, current.publication.response.resourceCard);
  assert.deepEqual((await row('platform_onboarding_safety_publications', 'id', id)).payload_ciphertext, before.payload_ciphertext);
  await agePublicationHistory(id, 25 * 3600_000);
  assert((await followup().read(who)).publications[0].response.question);
  await followup().act(who, operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: ack.handle }));
  const newRisk = await detected(who); await responses.prepareSubmission(newRisk.claim.submissionId);
  const latest = await followup().read(who), newCard = latest.publications.find(item => item.submissionId === newRisk.claim.submissionId);
  assert(newCard); assert.notEqual(newCard.publicationId, id); assert(newCard.response.question);
});

test('closed request validation rejects caller-supplied safety, hidden fields, accessors and executable action data without evaluating them', async () => {
  const who = await actor(), current = await published(who);
  const input = operation(current.draft.revision, current.publication.publicationId, { kind: 'present' });
  let accessors = 0;
  const getter = { ...input };
  Object.defineProperty(getter, 'action', { enumerable: true, get() { accessors++; throw new Error('Synthetic accessor must never run.'); } });
  const inherited = Object.assign(Object.create({ source: 'caller' }), input);
  const hidden = { ...input }; Object.defineProperty(hidden, 'approval', { value: true });
  for (const invalid of [{ ...input, level: 'L0' }, { ...input, userId: who.userId }, getter, inherited, hidden,
    { ...input, action: { kind: 'present', presentationReceipt: 'a'.repeat(43) } }]) {
    await assert.rejects(followup().act(who, invalid), code('INVALID_INPUT'));
  }
  assert.equal(accessors, 0); assert.deepEqual(await counts(who), { publications: 1, followups: 0, handled: 0 });
});

test('ciphertext damage anywhere in the complete authenticated source, response, publication or follow-up chain cannot release the barrier', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const ack = await acknowledged(who, id, current.draft.revision);
  const continueInput = operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: ack.handle });
  const cases = [
    ['platform_onboarding_operations', 'operation_id', current.input.operationId, 'request_ciphertext'],
    ['platform_onboarding_safety_submissions', 'id', current.claim.submissionId, 'result_ciphertext'],
    ['platform_onboarding_safety_responses', 'id', current.publication.responseId, 'payload_ciphertext'],
    ['platform_onboarding_safety_publications', 'id', id, 'payload_ciphertext'],
    ['platform_onboarding_safety_followups', 'operation_id', ack.input.operationId, 'payload_ciphertext'],
  ] as const;
  for (const [table, key, value, column] of cases) {
    const original = await row(table, key, value), damaged = Buffer.from(original[column]); damaged[30] ^= 1;
    try {
      await db.query(`UPDATE ${table} SET ${column}=$2 WHERE ${key}=$1`, [value, damaged]);
      await assert.rejects(followup().read(who), code('DATA_STORAGE_UNAVAILABLE'));
      await assert.rejects(followup().act(who, continueInput), code('DATA_STORAGE_UNAVAILABLE'));
      assert.equal((await counts(who)).handled, 0);
    } finally { await db.query(`UPDATE ${table} SET ${column}=$2 WHERE ${key}=$1`, [value, original[column]]); }
  }
  assert.equal((await followup().act(who, continueInput)).resumeStatus, 'resumed');
});

test('cross-owner encrypted publication transplantation and authenticated-row metadata mismatch are rejected rather than partially replayed', async () => {
  const who = await actor(), other = await actor(), current = await published(who), foreign = await published(other);
  const original = await row('platform_onboarding_safety_publications', 'id', current.publication.publicationId);
  const foreignRow = await row('platform_onboarding_safety_publications', 'id', foreign.publication.publicationId);
  try {
    await db.query('UPDATE platform_onboarding_safety_publications SET payload_ciphertext=$2 WHERE id=$1', [original.id, foreignRow.payload_ciphertext]);
    await assert.rejects(followup().read(who), code('DATA_STORAGE_UNAVAILABLE'));
  } finally { await db.query('UPDATE platform_onboarding_safety_publications SET payload_ciphertext=$2 WHERE id=$1', [original.id, original.payload_ciphertext]); }
  try {
    await db.query('UPDATE platform_onboarding_safety_publications SET projection_digest=$2 WHERE id=$1', [original.id, '0'.repeat(64)]);
    await assert.rejects(followup().read(who), code('DATA_STORAGE_UNAVAILABLE'));
  } finally { await db.query('UPDATE platform_onboarding_safety_publications SET projection_digest=$2 WHERE id=$1', [original.id, original.projection_digest]); }
  assert.equal((await counts(who)).handled, 0); assert.equal((await followup().read(who)).safety.status, 'blocked');
});

test('a genuine deferred COMMIT rejection rolls back both explicit handling and the corresponding draft revision', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const ack = await acknowledged(who, id, current.draft.revision);
  const input = operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: ack.handle });
  const before = await drafts.read(who), beforeCounts = await counts(who);
  let installed = false;
  try {
    await db.query(`CREATE FUNCTION fictional_reject_followup_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${who.userId}'::uuid AND NEW.handled THEN RAISE EXCEPTION 'Synthetic follow-up commit rejected'; END IF; RETURN NEW; END $$`); installed = true;
    await db.query(`CREATE CONSTRAINT TRIGGER fictional_followup_commit_gate AFTER INSERT ON platform_onboarding_safety_followups
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reject_followup_commit()`);
    await assert.rejects(followup().act(who, input), pgCode('P0001'));
    assert.deepEqual(await drafts.read(who), before); assert.deepEqual(await counts(who), beforeCounts);
    assert.equal(await row('platform_onboarding_safety_followups', 'operation_id', input.operationId), undefined);
    assert.equal((await followup().read(who)).safety.status, 'blocked');
  } finally { if (installed) await db.query('DROP FUNCTION fictional_reject_followup_commit() CASCADE'); }
  assert.equal((await followup().act(who, input)).resumeStatus, 'resumed');
});

function cancellationProbe(controller: AbortController, queryPrefix: string) {
  let hits = 0;
  class ActualQueryCancellationDatabase extends Database {
    override withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
      return super.withBoundedTransaction(client => run(new Proxy(client, { get(target, key) {
        if (key === 'query') return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.query, target, args);
          if (typeof args[0] === 'string' && args[0].startsWith(queryPrefix)) { hits++; controller.abort(); }
          return result;
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } })), options);
    }
  }
  return { database: new ActualQueryCancellationDatabase(url.toString()), hits: () => hits };
}

test('cancellation after the actual publication INSERT returns no projection and rolls the real insertion back', async () => {
  const who = await actor(); await ready(who);
  const controller = new AbortController(), probe = cancellationProbe(controller, 'INSERT INTO platform_onboarding_safety_publications');
  try {
    await assert.rejects(followup(probe.database).read(who, controller.signal), { name: 'AbortError' });
    assert.equal(probe.hits(), 1); assert.deepEqual(await counts(who), { publications: 0, followups: 0, handled: 0 });
  } finally { await probe.database.close(); }
  assert.equal((await followup().read(who)).publications.length, 1);
});

test('cancellation after the actual handled INSERT rolls back both the continuation receipt and the written draft', async () => {
  const who = await actor(), current = await published(who), id = current.publication.publicationId;
  const ack = await acknowledged(who, id, current.draft.revision), before = await drafts.read(who), beforeCounts = await counts(who);
  const input = operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: ack.handle });
  const controller = new AbortController(), probe = cancellationProbe(controller, 'INSERT INTO platform_onboarding_safety_followups');
  try {
    await assert.rejects(followup(probe.database).act(who, input, controller.signal), { name: 'AbortError' });
    assert.equal(probe.hits(), 1); assert.deepEqual(await drafts.read(who), before); assert.deepEqual(await counts(who), beforeCounts);
  } finally { await probe.database.close(); }
  assert.equal((await followup().act(who, input)).resumeStatus, 'resumed');
});

test('publication and follow-up ownership foreign keys and actual owner deletion cannot leave reusable detached clearance', async () => {
  const who = await actor(), other = await actor(), current = await published(who), id = current.publication.publicationId;
  const ack = await acknowledged(who, id, current.draft.revision);
  await assert.rejects(db.query('UPDATE platform_onboarding_safety_publications SET user_id=$2 WHERE id=$1', [id, other.userId]), pgCode('23503'));
  await followup().act(who, operation(current.draft.revision, id, { kind: 'continue_intake', presentationReceipt: ack.handle }));
  await db.query('DELETE FROM platform_users WHERE id=$1', [who.userId]);
  assert.deepEqual(await counts(who), { publications: 0, followups: 0, handled: 0 });
  await assert.rejects(followup().read(who), code('AUTH_REQUIRED'));
  await assert.rejects(followup().act(who, ack.ackInput), code('AUTH_REQUIRED'));
  assert.equal(await row('platform_onboarding_safety_submissions', 'id', current.claim.submissionId), undefined);
});

test('caller input and identity mutation during an observed real account lock wait cannot change captured presentation intent', { timeout: 10_000 }, async () => {
  const who = await actor(), other = await actor(), current = await published(who);
  const input = operation(current.draft.revision, current.publication.publicationId, { kind: 'present' });
  const originalId = input.operationId, context = { ...who }, probeUrl = new URL(url);
  const applicationName = 'followup_mutation_' + randomUUID().replaceAll('-', '');
  probeUrl.searchParams.set('application_name', applicationName);
  const probeDb = new Database(probeUrl.toString(), { max: 1 }), lock = await db.pool.connect();
  let pending: ReturnType<OnboardingSafetyFollowup['act']> | undefined, released = false;
  try {
    await lock.query('BEGIN'); await lock.query('SELECT id FROM platform_users WHERE id=$1 FOR UPDATE', [who.userId]);
    pending = followup(probeDb).act(context, input); pending.catch(() => {});
    input.operationId = randomUUID(); input.publicationId = randomUUID(); input.expectedDraftRevision += 99; input.action.kind = 'need_support';
    context.userId = other.userId; context.tokenHash = other.tokenHash;
    let observed = false;
    for (let index = 0; index < 30 && !observed; index++) {
      observed = Boolean((await admin.query(`SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`, [applicationName])).rowCount);
      if (!observed) await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observed, true, 'The real server query must actually wait on the owned account lock.');
    await lock.query('ROLLBACK'); released = true;
    const result = await pending; assert(result.presentationReceipt);
    assert.equal(result.operation.id, originalId); assert.equal(result.publicationId, current.publication.publicationId);
    const saved = await row('platform_onboarding_safety_followups', 'operation_id', originalId);
    assert.equal(saved.action_kind, 'present'); assert.equal(saved.user_id, who.userId);
    assert.equal(saved.expected_revision, current.draft.revision); assert.equal(saved.session_hash, who.tokenHash);
    assert.equal((await counts(other)).followups, 0);
  } finally {
    if (!released) await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); await probeDb.close();
  }
});

test('handled keyword-only O4 risk permits later intake preparation but never supplies personality preferences or turns its old result into full L0', async () => {
  const who = await actor();
  let draft = (await drafts.save(who, command(0, { kind: 'start', mode: 'standard' }))).draft;
  while (draft.step === 'O2') { assert(draft.currentQuestion); draft = (await drafts.save(who, command(draft.revision, { kind: 'skip', questionId: draft.currentQuestion }))).draft; }
  draft = (await drafts.save(who, command(draft.revision, { kind: 'skip_remaining' }))).draft;
  assert.equal(draft.currentQuestion, 'extra');
  const pending = await text(who, '说话直一点，短一点。Synthetic non-clinical high-risk fixture.');
  const claim = await drafts.claimSafety(who, { detectorRevision: 17 }); assert(claim);
  await drafts.processSafety(claim, classifier('L2', 'keyword_only')); await responses.prepareSubmission(claim.submissionId);
  const state = await followup().read(who); assert(state.draft);
  const ack = await acknowledged(who, state.publications[0].publicationId, state.draft.revision);
  const continued = await followup().act(who, operation(state.draft.revision, state.publications[0].publicationId,
    { kind: 'continue_intake', presentationReceipt: ack.handle }));
  assert.equal(continued.draft.currentQuestion, 'extra');
  const finished = await drafts.save(who, command(continued.draft.revision, { kind: 'skip', questionId: 'extra' }));
  const prepared = await new CompanionIntakePreparation(db, config, FICTIONAL_LEGAL).prepare(who, { expectedRevision: finished.draft.revision });
  assert.deepEqual(prepared.dimensions, { warmth: 0, directness: 0, drive: 0, structure: 0, levity: 0, code_mix: 0, length: 'medium' });
  const original = await row('platform_onboarding_safety_submissions', 'id', claim.submissionId);
  assert.equal(original.level, 'L2'); assert.equal(original.detector_mode, 'keyword_only');
  assert.equal(JSON.stringify(prepared).includes(pending.raw), false); assert.equal(finished.draft.answersPartial.extra?.kind, 'skipped');
  const stored = await row('platform_onboarding_safety_followups', 'operation_id', ack.input.operationId), bytes = Buffer.from(stored.payload_ciphertext); bytes[30] ^= 1;
  try {
    await db.query('UPDATE platform_onboarding_safety_followups SET payload_ciphertext=$2 WHERE operation_id=$1', [stored.operation_id, bytes]);
    await assert.rejects(new CompanionIntakePreparation(db, config, FICTIONAL_LEGAL).prepare(who,
      { expectedRevision: finished.draft.revision }), code('DATA_STORAGE_UNAVAILABLE'));
  } finally { await db.query('UPDATE platform_onboarding_safety_followups SET payload_ciphertext=$2 WHERE operation_id=$1', [stored.operation_id, stored.payload_ciphertext]); }
});
