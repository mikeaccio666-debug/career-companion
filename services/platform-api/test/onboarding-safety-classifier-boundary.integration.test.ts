import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProviderRuntime } from '@companion/ai-core';
import type { ModelStepEvent, ModelStepResult, PlatformProviderRuntime } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { ApiError } from '../src/errors.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { OnboardingSafetyRunner } from '../src/onboarding-safety-runner.ts';
import { expectedSafetyProfileDigests, parseSafetyDetectorProfile } from '../src/safety-detector-profile.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Deliberately nonconforming server ports test the real PostgreSQL acceptance boundary.
// Fictional actors, keyword markers and receipts only; no HTTP, paid model or approval claim.
const base = readConfig(), schema = 'safety_port_boundary_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use only loopback fictional PostgreSQL.');
url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const store = new OnboardingDrafts(db, { dataCrypto: readDataCrypto({ PLATFORM_DATA_KEY: 'a9'.repeat(32) })!, requireVerifiedEmail: true }, FICTIONAL_LEGAL);
const content = { schemaVersion: 1, revision: 37, instructions: 'Fictional boundary QA policy only.',
  algorithm: 'literal_substring_v1', lexicon: [
    { id: 'fixture-zh', language: 'zh', level: 'L1', phrases: ['虚构边界风险标记'] },
    { id: 'fixture-en', language: 'en', level: 'L2', phrases: ['Fictional boundary crisis marker'] },
  ], mergeRule: 'highest_level', fallbackNoHit: 'unavailable',
  review: { reference: 'fictional-boundary-fixture-not-professional-approval', approvedAt: '2026-10-07T00:00:00.000Z' } };
const profile = parseSafetyDetectorProfile({ ...content, ...expectedSafetyProfileDigests(content) });
const configuration = { modelRoutes: { safety_classify: { provider: 'openai' } }, safetyDailyModelCallLimit: 5 };
const candidate = { level: 'L0', resolution: { kind: 'answer', questionId: 'study', value: { degreeField: 'ds_statistics', programChoice: null } } };
let created = false;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await db.migrate(); await seedFictionalActiveLegal(db);
  const owner = await actor();
  await db.query(`INSERT INTO platform_safety_detector_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4)`, [profile.revision, profile.digest, profile.reviewDigest, owner.userId]);
});
after(async () => {
  try { await db.close(); }
  finally { try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.close(); } }
});
async function actor(): Promise<FixedSessionContext> {
  const userId = randomUUID(), token = randomUUID();
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional boundary owner','fictional-unused-hash','student',clock_timestamp())`, [userId, userId + '@example.invalid']);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, tokenHash(token)]);
  await seedFictionalConsent(db, userId); return { userId, tokenHash: tokenHash(token) };
}
async function pendingText(who: FixedSessionContext) {
  const start = await store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'standard' } });
  return store.save(who, { expectedRevision: start.draft.revision, operationId: randomUUID(),
    action: { kind: 'text', questionId: 'study', text: 'Fictional DS student, with no configured risk marker.' } });
}
const unavailable = (error: unknown) => error instanceof ApiError && error.code === 'ONBOARDING_SAFETY_UNAVAILABLE';

for (const missing of ['provider_admission', 'completion_receipt'] as const) test(`nonconforming model port missing ${missing} cannot persist full L0 or advance intake`, { timeout: 10_000 }, async () => {
  const who = await actor(), pending = await pendingText(who), callId = randomUUID();
  let modelSteps = 0, launches = 0, returnedCandidate = false, rejectedForgedFinish = false;
  const disabled = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: async () => assert.fail('No HTTP is permitted by this boundary fixture.') });
  const runtime: PlatformProviderRuntime = { ...disabled,
    capabilities: () => [{ id: 'openai', name: 'Fictional nonconforming safety port', keyConfigured: true, enabled: true,
      capabilities: ['chat'], models: [], modelsByPurpose: { safety_classify: ['fictional-boundary-model'] }, envVariables: [] }],
    async *streamModelStep(input, context): AsyncGenerator<ModelStepEvent, ModelStepResult> {
      modelSteps++; assert.equal(input.model, 'fictional-boundary-model'); assert.equal(context.purpose, 'safety_classify');
      assert(context.onModelCall); assert(context.requestAdmission);
      await context.onModelCall({ type: 'started', callId, index: 1, provider: 'openai', model: input.model!, purpose: 'safety_classify' });
      if (missing === 'provider_admission') {
        // Swallow the rejected fake completion and still attempt a syntactically valid L0.
        // This makes the final result-transaction guard, rather than callback rejection alone, part of the proof.
        try { await context.onModelCall({ type: 'finished', callId, status: 'complete', usage: { status: 'reported', inputTokens: 11, outputTokens: 7 } }); }
        catch { rejectedForgedFinish = true; }
      } else {
        await context.requestAdmission(async signal => { signal.throwIfAborted(); launches++; return 'fictional admitted response'; }, context.signal);
        // The actual request-admission transaction committed, but no completion event was recorded.
      }
      returnedCandidate = true;
      return { text: JSON.stringify(candidate), calls: [] };
    },
  };
  const runner = new OnboardingSafetyRunner(store, configuration, runtime, profile);
  await assert.rejects(runner.runNext(who), unavailable);
  assert.equal(modelSteps, 1); assert.equal(returnedCandidate, true);
  assert.equal(launches, missing === 'provider_admission' ? 0 : 1);
  assert.equal(rejectedForgedFinish, missing === 'provider_admission');
  const submissions = (await db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1', [who.userId])).rows;
  assert.equal(submissions.length, 1); const submission = submissions[0];
  assert.equal(submission.status, 'pending'); assert.equal(submission.failure, 'unavailable');
  assert.equal(submission.level, null); assert.equal(submission.detector_mode, null); assert.equal(submission.result_ciphertext, null);
  const draft = await store.read(who); assert(draft);
  assert.equal(draft.state, 'safety_pending'); assert.equal(draft.revision, pending.draft.revision);
  assert.equal(draft.currentQuestion, 'study'); assert.equal(draft.answersPartial.study, undefined);
  assert.equal(draft.pendingText?.id, pending.operation.id);
  assert.deepEqual(await store.readSafety(who), { status: 'pending', pendingCount: 1, blockedLevel: null });
  const calls = (await db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1', [who.userId])).rows;
  assert.equal(calls.length, 1); const call = calls[0];
  assert.equal(call.call_id, callId); assert.equal(call.submission_id, submission.id); assert.equal(call.operation_id, pending.operation.id);
  assert.equal(call.generation, submission.generation); assert.equal(call.detector_revision, profile.revision);
  assert.equal(call.status, missing === 'provider_admission' ? 'prepared' : 'admitted'); assert.equal(call.usage_status, 'pending');
  assert.equal(call.input_tokens, null); assert.equal(call.output_tokens, null); assert.equal(call.finished_at, null);
  if (missing === 'provider_admission') assert.equal(call.admitted_at, null); else assert(call.admitted_at instanceof Date);
});
