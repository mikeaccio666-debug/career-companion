import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import { parseOnboardingDraft } from '@companion/career-core';
import type { OnboardingAction, OnboardingDraft, OnboardingFollowupAction, PlatformProviderRuntime } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { BackgroundGeneration } from '../src/background-generation.ts';
import { CompanionDraftPreparation } from '../src/companion-draft-preparation.ts';
import { CompanionIdentityDrafts } from '../src/companion-identity-drafts.ts';
import { CompanionNameSafety } from '../src/companion-name-safety.ts';
import { CompanionNameSafetyRunner } from '../src/companion-name-safety-runner.ts';
import { OnboardingSafetyResponses } from '../src/onboarding-safety-responses.ts';
import { OnboardingSafetyFollowup } from '../src/onboarding-safety-followup.ts';
import { expectedSafetyProfileDigests, parseSafetyDetectorProfile } from '../src/safety-detector-profile.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { fictionalBundle } from './fixtures/onboarding-followup.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';

// Actual isolated PostgreSQL, real sessions, legal consent, generation/cost
// receipts and strict ai-core SSE completion. All model traffic is redirected
// to an owned loopback server; all policies and content are fictional QA data.
type Fixture = Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
let fixture: Fixture;
type Ready = Awaited<ReturnType<Fixture['ready']>>;
const profileContent = { schemaVersion: 1, revision: 93,
  instructions: 'Fictional historical naming QA. Classify synthetic examples only.',
  algorithm: 'literal_substring_v1', lexicon: [
    { id: 'en-low', language: 'en', level: 'L1', phrases: ['Synthetic low marker'] },
    { id: 'zh-low', language: 'zh', level: 'L1', phrases: ['虚构低风险标记'] },
    { id: 'en-high', language: 'en', level: 'L2', phrases: ['Synthetic high marker'] },
    { id: 'zh-high', language: 'zh', level: 'L2', phrases: ['虚构高风险标记'] },
  ], mergeRule: 'highest_level', fallbackNoHit: 'unavailable',
  review: { reference: 'fictional-historical-name-review-not-clinical-approval', approvedAt: '2026-10-07T00:00:00.000Z' } };
const profile = parseSafetyDetectorProfile({ ...profileContent, ...expectedSafetyProfileDigests(profileContent) });
const providerEnv = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-loopback-only',
  OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model', OPENAI_SAFETY_CLASSIFY_MODEL: 'fictional-name-safety' };
const preview = { summary: '说话简短，先把下一步理清楚。',
  samples: ['可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。'] };
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const damagedHistory = (error: unknown) => error instanceof ApiError && error.status === 503
  && ['DATA_STORAGE_UNAVAILABLE', 'COMPANION_GENERATION_UNAVAILABLE', 'COMPANION_NAME_SAFETY_UNAVAILABLE', 'COMPANION_IDENTITY_UNAVAILABLE'].includes(error.code);
before(async () => {
  fixture = await createCompanionNameSafetyFixture();
  const operator = await fixture.actor(true);
  await fixture.db.query(`INSERT INTO platform_safety_detector_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4)`, [profile.revision, profile.digest, profile.reviewDigest, operator.userId]);
});
after(async () => { if (fixture) await fixture.close(); });

async function loopback(run: (runtime: PlatformProviderRuntime, bodies: Record<string, any>[]) => Promise<void>) {
  const bodies: Record<string, any>[] = []; let failure: unknown;
  const server = http.createServer(async (request, reply) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
      assert.equal(body.store, false); assert.equal(body.tool_choice, 'none'); assert.deepEqual(body.tools, []);
      assert.equal(body.text.format.strict, true);
      assert([providerEnv.OPENAI_COMPANION_GENERATION_MODEL, providerEnv.OPENAI_SAFETY_CLASSIFY_MODEL].includes(body.model));
      const value = body.model === providerEnv.OPENAI_COMPANION_GENERATION_MODEL ? preview : { level: 'L0' };
      const event = { type: 'response.completed', response: { status: 'completed',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
        usage: { input_tokens: 34, output_tokens: 21 } } };
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    } catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const runtime = createProviderRuntime({ env: providerEnv, fetch: (target, init) => {
    const remote = new URL(String(target)); assert.equal(remote.origin, 'https://api.openai.com');
    assert.equal(remote.pathname, '/v1/responses'); return fetch(`http://127.0.0.1:${address.port}${remote.pathname}`, init);
  } });
  try { await run(runtime, bodies); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function runner(f: Ready, runtime: PlatformProviderRuntime, detector: typeof profile | null = profile) {
  return new CompanionNameSafetyRunner(f.safety, { modelRoutes: { safety_classify: { provider: 'openai' } }, safetyDailyModelCallLimit: 10 }, runtime, detector);
}
function command(f: Ready, name = '  Juno  ', expectedEntryRevision = 0, expectedIdentityRevision = 0) {
  return { taskId: f.prepared.taskId, operationId: randomUUID(), name, expectedEntryRevision, expectedIdentityRevision };
}
const target = (f: Ready, submissionId: string) => ({ taskId: f.prepared.taskId, submissionId });
async function row(submissionId: string) {
  return (await fixture.db.query('SELECT * FROM platform_companion_name_submissions WHERE id=$1', [submissionId])).rows[0];
}
async function save(who: FixedSessionContext, draft: OnboardingDraft, action: OnboardingAction) {
  return (await fixture.store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(), action })).draft;
}
async function completeStandard(who: FixedSessionContext, draft: OnboardingDraft) {
  while (draft.step === 'O2') { assert(draft.currentQuestion); draft = await save(who, draft, { kind: 'skip', questionId: draft.currentQuestion }); }
  draft = await save(who, draft, { kind: 'skip_remaining' });
  draft = await save(who, draft, { kind: 'skip', questionId: 'extra' }); assert.equal(draft.state, 'intake_ready'); return draft;
}
async function userBudget(who: FixedSessionContext) {
  const approver = await fixture.actor(true);
  await fixture.db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,approved_by,approved_at,effective_from)
    VALUES($1,'fictional-historical-name','week','notify',1,100000000,$2,clock_timestamp(),clock_timestamp())`, [who.userId, approver.userId]);
}
async function generated(runtime: PlatformProviderRuntime, who: FixedSessionContext, draft: OnboardingDraft): Promise<Ready> {
  const prepared = await new CompanionDraftPreparation(fixture.db, fixture.config, FICTIONAL_LEGAL, runtime).prepare(who, { expectedRevision: draft.revision });
  const background = new BackgroundGeneration(fixture.db, fixture.config, FICTIONAL_LEGAL, runtime);
  await background.generate(who, { taskId: prepared.taskId });
  const authority = await fixture.identityAuthority();
  const names = new CompanionIdentityDrafts(fixture.db, fixture.config, FICTIONAL_LEGAL, background, authority.asset, authority.review);
  return { who, prepared, background, authority, names, safety: new CompanionNameSafety(fixture.db, fixture.config, FICTIONAL_LEGAL, background, names) };
}
async function standard(runtime: PlatformProviderRuntime) {
  const who = await fixture.actor(); await userBudget(who);
  const draft = (await fixture.store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'standard' } })).draft;
  return generated(runtime, who, await completeStandard(who, draft));
}
async function applied(f: Ready, runtime: PlatformProviderRuntime) {
  const request = command(f), accepted = await f.safety.submit(f.who, request);
  await runner(f, runtime).runSubmission(f.who, target(f, accepted.submissionId));
  const result = await f.safety.apply(f.who, target(f, accepted.submissionId));
  assert.equal(result.status, 'applied'); assert.equal(result.appliedIdentityRevision, 1);
  const identity = await f.names.read(f.who, { taskId: f.prepared.taskId }); assert(identity); assert.equal(identity.name, 'Juno');
  return { request, submissionId: accepted.submissionId, identity };
}
const tables = ['platform_onboarding_drafts', 'platform_onboarding_operations', 'platform_onboarding_safety_submissions',
  'platform_onboarding_safety_responses', 'platform_onboarding_safety_publications', 'platform_onboarding_safety_followups',
  'platform_safety_events', 'platform_companions', 'platform_companion_answers', 'platform_companion_source_prefixes',
  'platform_companion_generation_tasks', 'platform_companion_generation_calls',
  'platform_companion_generation_checkpoints', 'platform_companion_revisions', 'platform_companion_name_entries',
  'platform_companion_name_submissions', 'platform_companion_identity_drafts', 'platform_companion_identity_operations',
  'platform_companion_identity_selections', 'platform_companion_identity_selection_operations',
  'platform_companion_name_identity_receipts', 'platform_companion_name_identity_provenance', 'platform_safety_model_usage',
  'platform_cost_reservations', 'platform_cost_ledger', 'platform_runtime_leases', 'platform_conversations', 'platform_memories', 'platform_jobs'] as const;
async function snapshot(f: Pick<Ready, 'who'>) {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await fixture.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY to_jsonb(${table})::text`, [f.who.userId])).rows])));
}
async function fresh(who: FixedSessionContext): Promise<FixedSessionContext> {
  const hash = tokenHash(randomUUID());
  await fixture.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
  await fixture.db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    SELECT id,$2,auth_version,clock_timestamp()+interval '1 hour' FROM platform_users WHERE id=$1`, [who.userId, hash]);
  return { userId: who.userId, tokenHash: hash };
}
/** Controlled current-projection fixture only: no product re-open/reroll API is
 * claimed. All subsequent TEXT and safety rows are then real service writes;
 * the original captured answers, operations, seed and preview stay untouched. */
async function laterText(f: Ready, level: 'pending' | 'L1' | 'L2') {
  const current = await fixture.store.read(f.who); assert(current); assert.equal(current.fastTrack, false);
  const answersPartial = { ...current.answersPartial }; delete answersPartial.extra;
  const reopened = parseOnboardingDraft({ ...current, answersPartial, state: 'collecting', step: 'O4', currentQuestion: 'extra' });
  await fixture.db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [f.who.userId,
    fixture.crypto.sealUtf8(JSON.stringify(reopened), { table: 'platform_onboarding_drafts', column: 'payload_ciphertext', rowId: reopened.id, ownerId: f.who.userId, revision: reopened.revision })]);
  const pending = await save(f.who, reopened, { kind: 'text', questionId: 'extra', text: 'Synthetic later intake source; independent from the original name.' });
  assert.equal(pending.state, 'safety_pending');
  if (level !== 'pending') {
    const claim = await fixture.store.claimSafety(f.who, { detectorRevision: 29 }); assert(claim);
    await fixture.store.processSafety(claim, async (_input, admission) => admission(async signal => { signal.throwIfAborted(); return { level, mode: 'full' }; }));
    assert.equal((await fixture.store.read(f.who))?.state, 'safety_paused');
  }
  return fixture.store.readSafety(f.who);
}
function cold(f: Ready, mode: 'disabled' | 'unconfigured') {
  const runtime = createProviderRuntime({ env: mode === 'disabled' ? { ...providerEnv, PLATFORM_ALLOW_PROVIDER_CALLS: '0' } : { PLATFORM_ALLOW_PROVIDER_CALLS: '1' },
    fetch: async () => { assert.fail('A saved history observation cannot launch provider I/O.'); } });
  const config = { ...fixture.config, modelRoutes: mode === 'disabled' ? fixture.config.modelRoutes : {} };
  const background = new BackgroundGeneration(fixture.db, config, FICTIONAL_LEGAL, runtime);
  const names = new CompanionIdentityDrafts(fixture.db, config, FICTIONAL_LEGAL, background, null, null);
  return { ...f, background, names, safety: new CompanionNameSafety(fixture.db, config, FICTIONAL_LEGAL, background, names), runtime };
}
const rolledBack = new Error('Fictional historical naming mutation rollback.');
/** Mutate inside the exact production read/claim bounded transaction, assert
 * that its real callback rejects, then roll back. No separate connection can
 * hide the mutation or wait on this transaction's own locks. */
async function rejectedMutation(action: () => Promise<unknown>, mutate: (client: PoolClient) => Promise<unknown>,
  expected: (error: unknown) => boolean = damagedHistory) {
  const original = fixture.db.withBoundedTransaction;
  fixture.db.withBoundedTransaction = function<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
    return original.call(fixture.db, async client => {
      await mutate(client); await assert.rejects(run(client), expected); throw rolledBack;
    }, options) as Promise<T>;
  };
  try { await assert.rejects(action(), error => error === rolledBack); }
  finally { fixture.db.withBoundedTransaction = original; }
}
async function blockedCurrentWrites(f: Ready, saved: Awaited<ReturnType<typeof applied>>, pendingId: string, expected: string) {
  const input = { taskId: f.prepared.taskId }, before = await snapshot(f);
  for (const action of [
    () => f.safety.submit(f.who, command(f, '舟', 2, 1)),
    () => f.safety.submit(f.who, saved.request),
    () => f.safety.apply(f.who, target(f, pendingId)),
    () => f.safety.apply(f.who, target(f, saved.submissionId)),
    () => f.names.read(f.who, input),
    () => fixture.db.withBoundedTransaction(client => f.names.readInTransaction(client, f.who, input)),
    () => f.names.save(f.who, { ...input, expectedRevision: 1, operationId: randomUUID(), name: '舟' }),
    () => f.names.readSelection(f.who, input),
    () => f.names.saveSelection(f.who, { ...input, expectedIdentityRevision: 1, expectedRevision: 0,
      operationId: randomUUID(), sealChar: saved.identity.sealCandidates[0].char }),
  ]) await assert.rejects(action(), code(expected));
  assert.deepEqual(await snapshot(f), before);
}

test('fresh real authVersion restores old applied and pending names; only a fresh claim can execute an expired saved source', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), saved = await applied(f, runtime);
    const pendingRequest = command(f, '  舟  ', 1, 1), accepted = await f.safety.submit(f.who, pendingRequest);
    const oldClaim = await f.safety.claimSubmission(f.who, { ...target(f, accepted.submissionId), detectorRevision: profile.revision }); assert(oldClaim);
    const originalView = await f.safety.read(f.who, { taskId: f.prepared.taskId }), originalApplied = await row(saved.submissionId), pending = await row(accepted.submissionId);
    const previous = await snapshot(f), newSession = await fresh(f.who);
    await fixture.db.query("UPDATE platform_companion_name_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [accepted.submissionId]);
    await assert.rejects(f.safety.read(f.who, { taskId: f.prepared.taskId }), code('AUTH_REQUIRED'));
    assert.deepEqual(await f.safety.read(newSession, { taskId: f.prepared.taskId }), originalView);
    const next = await f.safety.claimSubmission(newSession, { ...target(f, accepted.submissionId), detectorRevision: profile.revision }); assert(next);
    assert.equal(next.generation, 2); assert.equal(next.authVersion, '1'); assert.notEqual(next.leaseToken, oldClaim.leaseToken);
    let classified = false;
    await assert.rejects(f.safety.process(oldClaim, async () => { classified = true; return {}; }, undefined, async () => {}), code('COMPANION_NAME_SAFETY_CLAIM_CHANGED'));
    await assert.rejects(f.safety.fail(oldClaim, 'unavailable'), code('COMPANION_NAME_SAFETY_CLAIM_CHANGED')); assert.equal(classified, false);
    await f.safety.fail(next, 'unavailable');
    await runner(f, runtime).runSubmission(newSession, target(f, accepted.submissionId));
    const result = await row(accepted.submissionId); assert.equal(result.level, 'L0'); assert.equal(result.detector_mode, 'full'); assert.equal(result.auth_version, '1');
    assert.deepEqual(result.request_ciphertext, pending.request_ciphertext); assert.equal(result.submitted_auth_version, '0');
    assert.deepEqual(await row(saved.submissionId), originalApplied);
    const now = await snapshot(f); assert.deepEqual(now.platform_companion_name_identity_receipts, previous.platform_companion_name_identity_receipts);
    assert.deepEqual(now.platform_companion_identity_drafts, previous.platform_companion_identity_drafts);
    assert.deepEqual(now.platform_companion_answers, previous.platform_companion_answers);
    assert.deepEqual(now.platform_companion_revisions, previous.platform_companion_revisions);
    const requestText = fixture.crypto.openUtf8(result.request_ciphertext, { table: 'platform_companion_name_submissions', column: 'request_ciphertext',
      rowId: result.id, ownerId: f.who.userId, revision: result.submitted_revision });
    assert.deepEqual(JSON.parse(requestText).request, pendingRequest); assert.equal(bodies.length, 3);
  });
});

test('later genuine pending intake text keeps old name history visible and independently classifiable without opening any current writer', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await standard(runtime), saved = await applied(f, runtime);
    const accepted = await f.safety.submit(f.who, command(f, '舟', 1, 1)), pending = await row(accepted.submissionId), oldApplied = await row(saved.submissionId);
    const view = await f.safety.read(f.who, { taskId: f.prepared.taskId });
    const safety = await laterText(f, 'pending'); assert.equal(safety.status, 'pending');
    assert.deepEqual(await f.safety.read(f.who, { taskId: f.prepared.taskId }), view);
    for (const mode of ['disabled', 'unconfigured'] as const) {
      const observer = cold(f, mode), before = await snapshot(f);
      assert.deepEqual(await observer.safety.read(f.who, { taskId: f.prepared.taskId }), view);
      assert.equal(await runner(observer, observer.runtime, null).runSubmission(f.who, target(f, saved.submissionId)), null);
      assert.deepEqual(await snapshot(f), before);
    }
    await runner(f, runtime).runSubmission(f.who, target(f, accepted.submissionId));
    const classified = await row(accepted.submissionId); assert.equal(classified.level, 'L0'); assert.equal(classified.detector_mode, 'full');
    assert.deepEqual(classified.request_ciphertext, pending.request_ciphertext); assert.deepEqual(await row(saved.submissionId), oldApplied);
    await blockedCurrentWrites(f, saved, accepted.submissionId, 'ONBOARDING_SAFETY_REQUIRED');
    assert.deepEqual(await fixture.store.readSafety(f.who), safety); assert.equal(bodies.length, 3);
  });
});

test('later genuine L1 and L2 intake risk cannot erase old classifications or turn historical observation into naming or seal permission', async () => {
  await loopback(async (runtime, bodies) => {
    for (const level of ['L1', 'L2'] as const) {
      const f = await standard(runtime), saved = await applied(f, runtime), accepted = await f.safety.submit(f.who, command(f, '舟', 1, 1));
      const view = await f.safety.read(f.who, { taskId: f.prepared.taskId }), oldApplied = await row(saved.submissionId);
      const risk = await laterText(f, level); assert.equal(risk.status, 'blocked'); assert.equal(risk.blockedLevel, level);
      assert.deepEqual(await f.safety.read(f.who, { taskId: f.prepared.taskId }), view);
      await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId });
      assert.equal((await row(accepted.submissionId)).level, 'L0');
      await blockedCurrentWrites(f, saved, accepted.submissionId, 'ONBOARDING_SAFETY_REVIEW_REQUIRED');
      assert.deepEqual(await fixture.store.readSafety(f.who), risk); assert.deepEqual(await row(saved.submissionId), oldApplied);
      const entry = await f.safety.read(f.who, { taskId: f.prepared.taskId }); assert(entry);
      assert.equal(entry.submissions[0].application, 'applied'); assert.equal(entry.submissions[1].application, 'pending');
      assert(entry.submissions.every(item => item.level === 'L0')); // The separate intake risk above remains its real L1/L2.
    }
    assert.equal(bodies.length, 6);
  });
});

test('unconfigured or stopped providers and absent current identity assets restore already applied full-L0 evidence without a new call or charge', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), saved = await applied(f, runtime), view = await f.safety.read(f.who, { taskId: f.prepared.taskId });
    const before = await snapshot(f);
    for (const mode of ['disabled', 'unconfigured'] as const) {
      const observer = cold(f, mode);
      assert.deepEqual(await observer.safety.read(f.who, { taskId: f.prepared.taskId }), view);
      assert.equal(await runner(observer, observer.runtime).runSubmission(f.who, target(f, saved.submissionId)), null);
      assert.equal(await runner(observer, observer.runtime, null).runSubmission(f.who, target(f, saved.submissionId)), null);
      assert.deepEqual(await snapshot(f), before);
    }
    assert.equal(before.platform_safety_model_usage.length, 1); assert.equal(before.platform_safety_model_usage[0].status, 'complete');
    assert.equal(before.platform_safety_model_usage[0].source_kind, 'companion_name'); assert.equal(bodies.length, 2);
  });
});

test('saved history and claims still require a current unexpired verified student session and current legal consent', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime); await applied(f, runtime);
    const accepted = await f.safety.submit(f.who, command(f, '舟', 1, 1)), before = await snapshot(f);
    for (const [sql, expected] of [
      ['DELETE FROM platform_sessions WHERE user_id=$1', 'AUTH_REQUIRED'],
      ["UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", 'AUTH_REQUIRED'],
      ['UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', 'AUTH_REQUIRED'],
      ['UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', 'EMAIL_VERIFICATION_REQUIRED'],
      ["UPDATE platform_users SET account_kind='staff' WHERE id=$1", 'STUDENT_ACCOUNT_REQUIRED'],
      ['DELETE FROM platform_terms_consents WHERE user_id=$1', 'TERMS_CONFIRMATION_REQUIRED'],
    ] as const) {
      for (const action of [() => f.safety.read(f.who, { taskId: f.prepared.taskId }),
        () => f.safety.claimSubmission(f.who, { ...target(f, accepted.submissionId), detectorRevision: profile.revision })])
        await rejectedMutation(action, client => client.query(sql, [f.who.userId]), code(expected));
      assert.deepEqual(await snapshot(f), before);
    }
    for (const action of [() => f.safety.read(f.who, { taskId: f.prepared.taskId }),
      () => f.safety.claimSubmission(f.who, { ...target(f, accepted.submissionId), detectorRevision: profile.revision })])
      await rejectedMutation(action, client => client.query("UPDATE platform_terms_policy SET content_digest=repeat('f',64) WHERE singleton=true"), code('LEGAL_DOCUMENTS_UNAVAILABLE'));
    assert.deepEqual(await snapshot(f), before);
    assert.equal(bodies.length, 2);
  });
});

test('canonical alternate original answers or seed, a missing checkpoint and a changed independent identity receipt reject history without repair', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await standard(runtime), saved = await applied(f, runtime), accepted = await f.safety.submit(f.who, command(f, '舟', 1, 1)), before = await snapshot(f);
    const answers = before.platform_companion_answers[0], task = before.platform_companion_generation_tasks[0];
    const answerBinding = { table: 'platform_companion_answers', column: 'payload_ciphertext', rowId: answers.id, ownerId: f.who.userId, revision: answers.source_revision };
    const answerCapture = JSON.parse(fixture.crypto.openUtf8(answers.payload_ciphertext, answerBinding));
    answerCapture.answersPartial.study = { kind: 'answered', source: 'user_entered', appliedRevision: 2, value: { degreeField: 'cs', programChoice: null } };
    const seedBinding = { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext', rowId: task.id, ownerId: f.who.userId, revision: task.source_revision };
    const seed = JSON.parse(fixture.crypto.openUtf8(task.seed_ciphertext, seedBinding)); seed.dimensions.directness = 1;
    const receipt = before.platform_companion_name_identity_receipts[0], receiptBinding = { table: 'platform_companion_name_identity_receipts',
      column: 'payload_ciphertext', rowId: receipt.operation_id, ownerId: f.who.userId, revision: receipt.identity_revision };
    const captured = JSON.parse(fixture.crypto.openUtf8(receipt.payload_ciphertext, receiptBinding)); captured.identityCapture.name = '舟';
    const mutations = [
      (client: PoolClient) => client.query('UPDATE platform_companion_answers SET payload_ciphertext=$2 WHERE id=$1', [answers.id, fixture.crypto.sealUtf8(JSON.stringify(answerCapture), answerBinding)]),
      (client: PoolClient) => client.query('UPDATE platform_companion_generation_tasks SET seed_ciphertext=$2 WHERE id=$1', [task.id, fixture.crypto.sealUtf8(JSON.stringify(seed), seedBinding)]),
      (client: PoolClient) => client.query('DELETE FROM platform_companion_generation_checkpoints WHERE task_id=$1', [task.id]),
      (client: PoolClient) => client.query('UPDATE platform_companion_name_identity_receipts SET payload_ciphertext=$2 WHERE operation_id=$1', [receipt.operation_id, fixture.crypto.sealUtf8(JSON.stringify(captured), receiptBinding)]),
    ];
    for (const mutate of mutations) {
      for (const action of [() => f.safety.read(f.who, { taskId: f.prepared.taskId }),
        () => f.safety.claimSubmission(f.who, { ...target(f, accepted.submissionId), detectorRevision: profile.revision })]) await rejectedMutation(action, mutate);
      assert.deepEqual(await snapshot(f), before);
    }
    assert.equal((await row(saved.submissionId)).application_status, 'applied'); assert.equal(bodies.length, 2);
  });
});

async function handled(runtime: PlatformProviderRuntime, level: 'L1' | 'L2') {
  const who = await fixture.actor(); await userBudget(who);
  const bundle = fictionalBundle(), operator = await fixture.actor(true);
  await fixture.db.query(`INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,
    content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by`,
  [bundle.revision, bundle.contentDigest, bundle.reviewDigest, operator.userId]);
  let draft = (await fixture.store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'standard' } })).draft;
  draft = await save(who, draft, { kind: 'text', questionId: 'study', text: 'Synthetic original handled-risk context.' });
  const claim = await fixture.store.claimSafety(who, { detectorRevision: 29 }); assert(claim);
  await fixture.store.processSafety(claim, async (_input, admission) => admission(async () => ({ level, mode: 'full' })));
  const responses = new OnboardingSafetyResponses(fixture.db, fixture.config, FICTIONAL_LEGAL, bundle);
  assert.equal((await responses.prepareSubmission(claim.submissionId)).status, 'ready');
  const followup = new OnboardingSafetyFollowup(fixture.db, fixture.config, FICTIONAL_LEGAL), published = await followup.read(who); assert(published.draft);
  const publication = published.publications[0]; assert(publication); assert.equal(publication.level, level);
  const followupCommand = (action: OnboardingFollowupAction) => ({ expectedDraftRevision: published.draft!.revision,
    publicationId: publication.publicationId, operationId: randomUUID(), action });
  const present = followupCommand({ kind: 'present' }), shown = await followup.act(who, present); assert(shown.presentationReceipt);
  const ack = followupCommand({ kind: 'acknowledge', presentationReceipt: shown.presentationReceipt }); await followup.act(who, ack);
  const continuation = followupCommand(level === 'L1' ? { kind: 'continue_intake', presentationReceipt: shown.presentationReceipt }
    : { kind: 'clarify_exaggeration', presentationReceipt: shown.presentationReceipt, safe: true, exaggeration: true });
  const continued = await followup.act(who, continuation); assert.equal(continued.resumeStatus, 'resumed');
  const f = await generated(runtime, who, await completeStandard(who, continued.draft));
  return { f, claim, publicationId: publication.publicationId, operationIds: [present.operationId, ack.operationId, continuation.operationId] };
}

test('original handled L1 and L2 resource and same-session continuation chains stay required after later pending intake and a fresh login', async () => {
  await loopback(async (runtime, bodies) => {
    for (const level of ['L1', 'L2'] as const) {
      const original = await handled(runtime, level), f = original.f; await applied(f, runtime);
      const accepted = await f.safety.submit(f.who, command(f, '舟', 1, 1)); await laterText(f, 'pending');
      const oldView = await f.safety.read(f.who, { taskId: f.prepared.taskId }), who = await fresh(f.who), before = await snapshot(f);
      assert.deepEqual(await f.safety.read(who, { taskId: f.prepared.taskId }), oldView);
      const mutations = [
        (client: PoolClient) => client.query('UPDATE platform_onboarding_safety_publications SET payload_ciphertext=$2 WHERE id=$1', [original.publicationId, Buffer.alloc(29)]),
        (client: PoolClient) => client.query('UPDATE platform_onboarding_safety_submissions SET result_ciphertext=$2 WHERE id=$1', [original.claim.submissionId, Buffer.alloc(29)]),
        ...original.operationIds.map(operationId => (client: PoolClient) => client.query('DELETE FROM platform_onboarding_safety_followups WHERE user_id=$1 AND operation_id=$2', [who.userId, operationId])),
      ];
      for (const mutate of mutations) {
        await rejectedMutation(() => f.safety.read(who, { taskId: f.prepared.taskId }), mutate);
        await rejectedMutation(() => f.safety.claimSubmission(who, { ...target(f, accepted.submissionId), detectorRevision: profile.revision }), mutate);
        assert.deepEqual(await snapshot(f), before);
      }
      const risk = before.platform_onboarding_safety_submissions.find((item: { id: string }) => item.id === original.claim.submissionId); assert(risk);
      assert.equal(risk.level, level); assert.equal(risk.detector_mode, 'full');
    }
    assert.equal(bodies.length, 4);
  });
});

test('deleting a genuine superseded original TEXT operation and its cascaded submission cannot shrink the historical source prefix', async () => {
  await loopback(async (runtime, bodies) => {
    const who = await fixture.actor(); await userBudget(who);
    let draft = (await fixture.store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'standard' } })).draft;
    draft = await save(who, draft, { kind: 'text', questionId: 'study', text: 'Synthetic older unreferenced study input.' });
    const older = await fixture.store.claimSafety(who, { detectorRevision: 29 }); assert(older);
    draft = await save(who, draft, { kind: 'text', questionId: 'study', text: 'Synthetic replacement study input.' });
    const newer = await fixture.store.claimSafety(who, { detectorRevision: 29 }); assert(newer); assert.notEqual(newer.operationId, older.operationId);
    await fixture.store.processSafety(newer, async (_input, admission) => admission(async () => ({ level: 'L0', mode: 'full',
      resolution: { kind: 'answer', questionId: 'study', value: { degreeField: 'ds_statistics', programChoice: null } } })));
    await fixture.store.processSafety(older, async (_input, admission) => admission(async () => ({ level: 'L0', mode: 'full', resolution: { kind: 'unmatched' } })));
    draft = (await fixture.store.read(who))!;
    assert.equal(draft.answersPartial.study?.kind, 'answered'); assert.equal(draft.answersPartial.study?.textId, newer.operationId);
    const f = await generated(runtime, who, await completeStandard(who, draft)); await applied(f, runtime);
    const accepted = await f.safety.submit(who, command(f, '舟', 1, 1)), before = await snapshot(f);
    const erase = async (client: PoolClient) => {
      assert.equal((await client.query('DELETE FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2', [who.userId, older.operationId])).rowCount, 1);
      assert.equal((await client.query('SELECT id FROM platform_onboarding_safety_submissions WHERE id=$1', [older.submissionId])).rowCount, 0);
    };
    await rejectedMutation(() => f.safety.read(who, { taskId: f.prepared.taskId }), erase);
    await rejectedMutation(() => f.safety.claimSubmission(who, { ...target(f, accepted.submissionId), detectorRevision: profile.revision }), erase);
    assert.deepEqual(await snapshot(f), before); assert.equal(bodies.length, 2);
  });
});

test('a controlled legacy task receives only current evidence, never a backfilled manifest or historical authority after its current intake changes', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await standard(runtime), saved = await applied(f, runtime), accepted = await f.safety.submit(f.who, command(f, '舟', 1, 1));
    const task = (await fixture.db.query('SELECT * FROM platform_companion_generation_tasks WHERE id=$1', [f.prepared.taskId])).rows[0];
    assert.equal(task.source_receipt_version, 1);
    const binding = { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext', rowId: task.id,
      ownerId: f.who.userId, revision: task.source_revision };
    const seed = JSON.parse(fixture.crypto.openUtf8(task.seed_ciphertext, binding));
    assert.equal(seed.sourceReceiptVersion, 1); assert.match(seed.sourceReceiptDigest, /^[0-9a-f]{64}$/);
    const { sourceReceiptVersion: _version, sourceReceiptDigest: _digest, ...legacySeed } = seed;
    // Explicit old-format fixture simulation only. This neither proves a real
    // migration of production data nor invents a receipt for an older task.
    await fixture.db.transaction(async client => {
      await client.query('UPDATE platform_companion_generation_tasks SET source_receipt_version=NULL,seed_ciphertext=$2 WHERE id=$1',
        [task.id, fixture.crypto.sealUtf8(JSON.stringify(legacySeed), binding)]);
      assert.equal((await client.query('DELETE FROM platform_companion_source_prefixes WHERE task_id=$1', [task.id])).rowCount, 1);
    });
    const before = await snapshot(f), taskInput = { taskId: task.id }, proof = await fixture.db.withBoundedTransaction(client =>
      f.background.readSavedCompletedInTransaction(client, f.who, taskInput)); assert(proof);
    assert.equal(proof.kind, 'current_completed_preview');
    const entry = await f.safety.read(f.who, taskInput); assert(entry); assert.equal(entry.submissions[0].application, 'applied');
    assert.equal(entry.submissions[1].status, 'pending');
    await assert.rejects(fixture.db.withBoundedTransaction(client => f.background.readHistoricalCompletedInTransaction(client, f.who, taskInput)), damagedHistory);
    assert.deepEqual(await snapshot(f), before); assert.equal(before.platform_companion_source_prefixes.length, 0);
    assert.equal((await row(saved.submissionId)).application_status, 'applied');
    await laterText(f, 'pending'); const advanced = await snapshot(f);
    await assert.rejects(fixture.db.withBoundedTransaction(client => f.background.readSavedCompletedInTransaction(client, f.who, taskInput)), code('ONBOARDING_SAFETY_REQUIRED'));
    await assert.rejects(f.safety.read(f.who, taskInput), code('ONBOARDING_SAFETY_REQUIRED'));
    await assert.rejects(f.safety.claimSubmission(f.who, { ...target(f, accepted.submissionId), detectorRevision: profile.revision }), code('ONBOARDING_SAFETY_REQUIRED'));
    assert.deepEqual(await snapshot(f), advanced); assert.equal(advanced.platform_companion_source_prefixes.length, 0); assert.equal(bodies.length, 2);
  });
});

test('directly repeating migration 045 preserves real version-one and controlled legacy records without backfilling authorization', async () => {
  await loopback(async (runtime, bodies) => {
    const modern = await standard(runtime), modernName = await applied(modern, runtime);
    const legacy = await standard(runtime), legacyName = await applied(legacy, runtime);
    const task = (await fixture.db.query('SELECT * FROM platform_companion_generation_tasks WHERE id=$1', [legacy.prepared.taskId])).rows[0];
    const binding = { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext', rowId: task.id,
      ownerId: legacy.who.userId, revision: task.source_revision };
    const seed = JSON.parse(fixture.crypto.openUtf8(task.seed_ciphertext, binding));
    assert.equal(seed.sourceReceiptVersion, 1); assert.match(seed.sourceReceiptDigest, /^[0-9a-f]{64}$/);
    const { sourceReceiptVersion: _version, sourceReceiptDigest: _digest, ...legacySeed } = seed;
    // Explicit old-format fixture simulation only, before the preservation
    // snapshot. The migration itself must never manufacture this authority.
    await fixture.db.transaction(async client => {
      assert.equal((await client.query('UPDATE platform_companion_generation_tasks SET source_receipt_version=NULL,seed_ciphertext=$2 WHERE id=$1',
        [task.id, fixture.crypto.sealUtf8(JSON.stringify(legacySeed), binding)])).rowCount, 1);
      assert.equal((await client.query('DELETE FROM platform_companion_source_prefixes WHERE task_id=$1', [task.id])).rowCount, 1);
    });
    const beforeModern = await snapshot(modern), beforeLegacy = await snapshot(legacy);
    const journal = (await fixture.db.query('SELECT * FROM platform_migrations ORDER BY name')).rows;
    assert.equal(journal.filter(record => record.name === '045_companion_source_prefix.sql').length, 1);
    assert.equal(beforeModern.platform_companion_source_prefixes.length, 1);
    assert.equal(beforeLegacy.platform_companion_source_prefixes.length, 0);
    assert.equal(beforeLegacy.platform_companion_generation_tasks[0].source_receipt_version, null);
    const sql = await readFile(new URL('../migrations/045_companion_source_prefix.sql', import.meta.url), 'utf8');
    // Execute the complete SQL twice, bypassing the migrator's skip journal.
    // A journal-only second migrate() cannot establish DDL repeatability.
    for (let attempt = 0; attempt < 2; attempt++) {
      await fixture.db.transaction(client => client.query(sql));
      assert.deepEqual(await snapshot(modern), beforeModern);
      assert.deepEqual(await snapshot(legacy), beforeLegacy);
      assert.deepEqual((await fixture.db.query('SELECT * FROM platform_migrations ORDER BY name')).rows, journal);
    }
    await fixture.db.migrate();
    assert.deepEqual((await fixture.db.query('SELECT * FROM platform_migrations ORDER BY name')).rows, journal);
    for (const [f, kind, saved] of [[modern, 'historical_completed_preview', modernName], [legacy, 'current_completed_preview', legacyName]] as const) {
      const input = { taskId: f.prepared.taskId };
      const proof = await fixture.db.withBoundedTransaction(client => f.background.readSavedCompletedInTransaction(client, f.who, input));
      assert(proof); assert.equal(proof.kind, kind);
      const entry = await f.safety.read(f.who, input); assert(entry); assert.equal(entry.submissions[0].application, 'applied');
      assert.equal((await row(saved.submissionId)).application_status, 'applied');
    }
    await assert.rejects(fixture.db.withBoundedTransaction(client => legacy.background.readHistoricalCompletedInTransaction(client, legacy.who,
      { taskId: legacy.prepared.taskId })), damagedHistory);
    assert.deepEqual(await snapshot(modern), beforeModern); assert.deepEqual(await snapshot(legacy), beforeLegacy);
    assert.equal(bodies.length, 4);
  });
});

test('a missing version-one manifest or clearing only its row flag cannot downgrade saved new-format naming evidence to legacy', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await standard(runtime); await applied(f, runtime);
    const accepted = await f.safety.submit(f.who, command(f, '舟', 1, 1)), before = await snapshot(f), task = before.platform_companion_generation_tasks[0];
    assert.equal(task.source_receipt_version, 1); assert.equal(before.platform_companion_source_prefixes.length, 1);
    const seed = JSON.parse(fixture.crypto.openUtf8(task.seed_ciphertext, { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext',
      rowId: task.id, ownerId: f.who.userId, revision: task.source_revision }));
    assert.equal(seed.sourceReceiptVersion, 1); assert.match(seed.sourceReceiptDigest, /^[0-9a-f]{64}$/);
    for (const mutate of [
      (client: PoolClient) => client.query('DELETE FROM platform_companion_source_prefixes WHERE task_id=$1', [task.id]),
      (client: PoolClient) => client.query('UPDATE platform_companion_generation_tasks SET source_receipt_version=NULL WHERE id=$1', [task.id]),
    ]) {
      for (const action of [
        () => fixture.db.withBoundedTransaction(client => f.background.readSavedCompletedInTransaction(client, f.who, { taskId: task.id })),
        () => f.safety.read(f.who, { taskId: task.id }),
        () => f.safety.claimSubmission(f.who, { ...target(f, accepted.submissionId), detectorRevision: profile.revision }),
      ]) await rejectedMutation(action, mutate);
      assert.deepEqual(await snapshot(f), before);
    }
    assert.equal(bodies.length, 2);
  });
});
