import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import type { NameSafetyResourceAction, NameSafetyResourceCommand, PlatformProviderRuntime } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { CompanionNameSafety } from '../src/companion-name-safety.ts';
import { CompanionNameSafetyRunner } from '../src/companion-name-safety-runner.ts';
import { CompanionNameSafetyResponses } from '../src/companion-name-safety-responses.ts';
import { CompanionNameSafetyDelivery } from '../src/companion-name-safety-delivery.ts';
import { SafetyQuestionDelivery } from '../src/safety-question-delivery.ts';
import { OnboardingSafetyRunner } from '../src/onboarding-safety-runner.ts';
import { OnboardingSafetyResponses } from '../src/onboarding-safety-responses.ts';
import { OnboardingSafetyFollowup } from '../src/onboarding-safety-followup.ts';
import { expectedSafetyProfileDigests, parseSafetyDetectorProfile } from '../src/safety-detector-profile.ts';
import { expectedSafetyResponseBundleDigests, parseSafetyResponseBundle, type SafetyResponseBundle } from '../src/safety-response-bundle.ts';
import { SafetyDeliveryReviewRegistry, expectedSafetyDeliveryReviewDigest, parseSafetyDeliveryReview,
  openDelivery, sealDelivery, type SafetyDeliveryReview } from '../src/safety-delivery-review.ts';
import { followupCapture, followupDigest, followupStateCapture, publicationCoordinates, publicationGenesis,
  type NameSafetyFollowupRow, type NameSafetyPublicationRow, type NameSafetyStateRow } from '../src/companion-name-safety-delivery-protocol.ts';
import { occurrenceFromCapture, questionOperationCapture, questionOperationCore, questionOccurrenceCapture, questionScopeCapture,
  type QuestionOccurrenceRow, type QuestionOperationRow, type QuestionScopeRow } from '../src/safety-question-delivery-protocol.ts';
import { deliveryDigest } from '../src/safety-delivery-review.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { fictionalBundle } from './fixtures/onboarding-followup.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';

// Actual isolated PostgreSQL, authenticated student/staff sessions, 043 submit,
// actual classification, 046 capture and real 047 review/activation operations.
// Every person, organization, contact, asset and review is fictional. Exercising
// staff roles and review ports does NOT establish professional qualifications or
// production approval. Render declarations below are synthetic client evidence,
// not proof of a DOM paint, human reading, clinical clearance or tool permission.
type Fixture = Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
type Ready = Awaited<ReturnType<Fixture['ready']>>;
type Authority = Awaited<ReturnType<typeof reviewAuthority>>;
let fixture: Fixture;
let authority: Authority;
const bundle = fictionalBundle();
const profileContent = { schemaVersion: 1, revision: 95,
  instructions: 'Synthetic resource delivery QA only; not clinical review.', algorithm: 'literal_substring_v1',
  lexicon: [
    { id: 'synthetic-low-en', language: 'en', level: 'L1', phrases: ['Fictional low marker'] },
    { id: 'synthetic-high-en', language: 'en', level: 'L2', phrases: ['Fictional high marker'] },
    { id: 'synthetic-low-zh', language: 'zh', level: 'L1', phrases: ['虚构交付低风险标记'] },
    { id: 'synthetic-high-zh', language: 'zh', level: 'L2', phrases: ['虚构交付高风险标记'] },
  ], mergeRule: 'highest_level', fallbackNoHit: 'unavailable',
  review: { reference: 'fictional-delivery-test-not-professional-approval', approvedAt: '2026-10-01T00:00:00.000Z' } };
const profile = parseSafetyDetectorProfile({ ...profileContent, ...expectedSafetyProfileDigests(profileContent) });
const providerEnv = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-loopback-only',
  OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model', OPENAI_SAFETY_CLASSIFY_MODEL: 'fictional-resource-classifier' };
const preview = { summary: '先把事情理清楚，再选一个小行动。',
  samples: ['可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。'] };
const oldCaptureTables = ['platform_companion_name_safety_responses', 'platform_safety_events'] as const;
const authorityTables = ['platform_safety_model_usage', 'platform_cost_reservations', 'platform_cost_ledger',
  'platform_companion_identity_drafts', 'platform_companion_identity_operations', 'platform_companion_identity_selections',
  'platform_companion_name_identity_receipts', 'platform_companion_name_identity_provenance',
  'platform_conversations', 'platform_memories', 'platform_jobs'] as const;
const sidecarTables = ['platform_companion_name_delivery_heads', 'platform_companion_name_delivery_operations',
  'platform_companion_name_safety_publications', 'platform_companion_name_safety_body_projections',
  'platform_companion_name_safety_followup_states', 'platform_companion_name_safety_followups',
  'platform_companion_name_safety_handled', 'platform_safety_question_scopes', 'platform_safety_question_occurrences',
  'platform_safety_question_operations', 'platform_safety_legacy_exposures'] as const;
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503;
const constraint = (error: unknown) => ['23503', '23514'].includes((error as { code?: string }).code ?? '');
const capability = () => randomBytes(32).toString('base64url');

before(async () => {
  fixture = await createCompanionNameSafetyFixture();
  const operator = await fixture.actor(true, 'Fictional detector operator');
  await fixture.db.query(`INSERT INTO platform_safety_detector_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4)`, [profile.revision, profile.digest, profile.reviewDigest, operator.userId]);
});
beforeEach(async () => { authority = await reviewAuthority(); });
after(async () => { if (fixture) await fixture.close(); });

function manifest(selected: SafetyResponseBundle, reviewer: FixedSessionContext, orgId: string, evidenceRetentionDays = 40): Readonly<SafetyDeliveryReview> {
  const content = { schemaVersion: 1, bundleRevision: selected.revision, contentDigest: selected.contentDigest,
    bundleReviewDigest: selected.reviewDigest, reviewerUserId: reviewer.userId, orgId,
    reviewedAt: '2026-10-01T12:34:56.789Z',
    reviewEvidenceRef: 'https://example.invalid/fictional-047-review-not-professional-approval',
    coverage: 'body_question_separated', variablePolicy: 'unnamed_empty_user', evidenceRetentionDays,
    legacyPolicy: 'no_auto_reask_possible_exposure' };
  return parseSafetyDeliveryReview({ ...content, reviewDigest: expectedSafetyDeliveryReviewDigest(content) });
}
async function reviewAuthority(selected: SafetyResponseBundle = bundle, evidenceRetentionDays = 40) {
  const reviewer = await fixture.actor(true, 'Fictional safety reviewer'), operator = await fixture.actor(true, 'Fictional safety operator');
  const orgId = randomUUID();
  await fixture.db.query("INSERT INTO platform_orgs(id,slug,display_name,status) VALUES($1,$2,'Fictional delivery QA; not professional approval','active')",
    [orgId, 'delivery_' + orgId.replaceAll('-', '')]);
  for (const [user, role] of [[reviewer.userId, 'safety_reviewer'], [operator.userId, 'ops']])
    await fixture.db.query(`INSERT INTO platform_org_roles(org_id,user_id,role,status,granted_by,granted_at)
      VALUES($1,$2,$3,'active',$4,clock_timestamp())`, [orgId, user, role, operator.userId]);
  const review = manifest(selected, reviewer, orgId, evidenceRetentionDays), registry = new SafetyDeliveryReviewRegistry(fixture.db, fixture.crypto, selected, review);
  const reviewCommand = { operationId: randomUUID() }, recorded = await registry.recordReview(reviewer, reviewCommand);
  const activationCommand = { operationId: randomUUID(), assetId: recorded.assetId };
  await registry.activate(operator, activationCommand);
  return { selected, review, registry, reviewer, operator, orgId, assetId: recorded.assetId, reviewCommand, activationCommand };
}
function original(selected: SafetyResponseBundle | null = authority.selected) {
  return new CompanionNameSafetyResponses(fixture.db, fixture.config, selected);
}
function delivery(selected: SafetyResponseBundle | null = authority.selected, review: SafetyDeliveryReview | null = authority.review,
  legal = FICTIONAL_LEGAL) {
  return new CompanionNameSafetyDelivery(fixture.db, fixture.config, legal, original(selected), selected, review);
}
function disabled() {
  return createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: async () => assert.fail('Fixed delivery cannot call a model.') });
}
async function loopback(run: (runtime: PlatformProviderRuntime, requests: Record<string, any>[]) => Promise<void>, level: 'L0' | 'L1' | 'L2' = 'L0') {
  const requests: Record<string, any>[] = []; let failure: unknown;
  const server = http.createServer(async (request, reply) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks: Buffer[] = []; for await (const part of request) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      assert.equal(body.store, false); assert.equal(body.tool_choice, 'none'); assert.deepEqual(body.tools, []);
      assert.equal(body.text.format.strict, true);
      assert([providerEnv.OPENAI_COMPANION_GENERATION_MODEL, providerEnv.OPENAI_SAFETY_CLASSIFY_MODEL].includes(body.model));
      const value = body.model === providerEnv.OPENAI_COMPANION_GENERATION_MODEL ? preview : { level };
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
  try { await run(runtime, requests); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function classified(f: Ready, runtime: PlatformProviderRuntime, raw = 'Fictional high marker', full = false) {
  const entry = (await fixture.db.query('SELECT revision FROM platform_companion_name_entries WHERE task_id=$1 AND user_id=$2',
    [f.prepared.taskId, f.who.userId])).rows[0];
  const identity = (await fixture.db.query('SELECT revision FROM platform_companion_identity_drafts WHERE task_id=$1 AND user_id=$2',
    [f.prepared.taskId, f.who.userId])).rows[0];
  const submitted = await f.safety.submit(f.who, { taskId: f.prepared.taskId, operationId: randomUUID(), name: raw,
    expectedEntryRevision: entry?.revision ?? 0, expectedIdentityRevision: identity?.revision ?? 0 });
  const runner = new CompanionNameSafetyRunner(f.safety, { modelRoutes: { safety_classify: { provider: 'openai' } }, safetyDailyModelCallLimit: 100 },
    full ? runtime : disabled(), profile);
  await runner.runSubmission(f.who, { taskId: f.prepared.taskId, submissionId: submitted.submissionId });
  return submitted.submissionId;
}
async function captured(runtime: PlatformProviderRuntime, raw = 'Fictional high marker', full = false) {
  const f = await fixture.ready(runtime), submissionId = await classified(f, runtime, raw, full), api = original();
  const application = await f.safety.apply(f.who, { taskId: f.prepared.taskId, submissionId });
  assert.equal(application.status, 'not_eligible');
  const prepared = await api.prepareSubmission(submissionId); assert(prepared);
  assert.equal(prepared.status, 'ready');
  return { f, submissionId, original: api, api: delivery() };
}
async function published(runtime: PlatformProviderRuntime, raw = 'Fictional high marker', full = false) {
  const target = await captured(runtime, raw, full);
  const publicationCommand = { operationId: randomUUID(), submissionId: target.submissionId, expectedEdition: 0 };
  const publication = await target.api.publish(target.f.who, publicationCommand); assert(publication);
  return { ...target, publication, publicationId: publication.publicationId, publicationCommand };
}
type Target = Awaited<ReturnType<typeof published>>;
async function act(target: Target, action: NameSafetyResourceAction, who = target.f.who) {
  const current = await target.api.read(who, { publicationId: target.publicationId });
  const command: NameSafetyResourceCommand = { operationId: randomUUID(), publicationId: target.publicationId,
    expectedPublicationRevision: current.revision, action };
  return { command, result: await target.api.act(who, command) };
}
async function presented(target: Target, who = target.f.who) {
  const projection = await target.api.issueBodyProjection(who, { publicationId: target.publicationId });
  const command: NameSafetyResourceCommand = { operationId: randomUUID(), publicationId: target.publicationId,
    expectedPublicationRevision: projection.revision, action: { kind: 'present_body', bodyProjectionId: projection.bodyProjectionId } };
  const result = await target.api.act(who, command); assert.equal(typeof result.presentationReceipt, 'string');
  return { projection, command, result, receipt: result.presentationReceipt! };
}
async function acknowledged(target: Target, who = target.f.who) {
  const present = await presented(target, who);
  const ack = await act(target, { kind: 'acknowledge', presentationReceipt: present.receipt }, who);
  assert.equal(ack.result.state.acknowledged, true); return { ...present, ack };
}
async function snapshot(userId: string, tables: readonly string[]) {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await fixture.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY to_jsonb(${table})::text`, [userId])).rows])));
}
async function oldBytes(who: FixedSessionContext) { return snapshot(who.userId, oldCaptureTables); }
async function noAuthorityBytes(who: FixedSessionContext) { return snapshot(who.userId, authorityTables); }
async function session(who: FixedSessionContext, revokeOriginal = true) {
  const hash = tokenHash(randomUUID());
  if (revokeOriginal) await fixture.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
  await fixture.db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    SELECT id,$2,auth_version,clock_timestamp()+interval '1 hour' FROM platform_users WHERE id=$1`, [who.userId, hash]);
  return { userId: who.userId, tokenHash: hash };
}
function assertBodyOnly(value: unknown) {
  const text = JSON.stringify(value);
  for (const key of ['question', 'presentationReceipt', 'grantPresentationToken', 'reservationToken', 'leaseToken', 'executionToken'])
    assert(!new RegExp(`"${key}"\\s*:`).test(text), `Body projection leaked ${key}.`);
  assert(!text.includes('Fictional high marker')); assert(!text.includes('Fictional low marker'));
}
const rolledBack = new Error('Owned synthetic mutation rolled back.');
async function rejectsMutation(action: () => Promise<unknown>, mutate: (client: PoolClient) => Promise<unknown>) {
  const originalTransaction = fixture.db.withBoundedTransaction;
  fixture.db.withBoundedTransaction = function<T>(run: (client: PoolClient) => Promise<T>, options = {}) {
    return originalTransaction.call(fixture.db, async client => {
      await mutate(client); await assert.rejects(run(client), unavailable); throw rolledBack;
    }, options) as Promise<T>;
  };
  try { await assert.rejects(action(), error => error === rolledBack); }
  finally { fixture.db.withBoundedTransaction = originalTransaction; }
}
function changedBundle(change: (content: any) => void, base = bundle) {
  const content = JSON.parse(JSON.stringify(base)); delete content.contentDigest; delete content.reviewDigest;
  change(content); return parseSafetyResponseBundle({ ...content, ...expectedSafetyResponseBundleDigests(content) });
}
async function replaceArchivedFixture(client: PoolClient, selected: SafetyResponseBundle, review: SafetyDeliveryReview) {
  // Deliberate contradictory synthetic archive with valid integrity. This is
  // solely a rejection fixture; no fake review/activation is accepted by it.
  const row = (await client.query('SELECT * FROM platform_safety_delivery_assets WHERE id=$1', [authority.assetId])).rows[0];
  const aad = { table: 'platform_safety_delivery_assets', column: 'decision_ciphertext', rowId: row.id, ownerId: row.reviewer_id, revision: 1 };
  const capture = JSON.parse(fixture.crypto.openUtf8(row.decision_ciphertext, aad)); capture.bundle = selected; capture.review = review;
  await client.query(`UPDATE platform_safety_delivery_assets SET bundle_json=$2,review_json=$3,content_digest=$4,
    bundle_review_digest=$5,review_digest=$6,decision_ciphertext=$7 WHERE id=$1`,
  [row.id, JSON.stringify(selected), JSON.stringify(review), selected.contentDigest, selected.reviewDigest, review.reviewDigest,
    fixture.crypto.sealUtf8(JSON.stringify(capture), aad)]);
  await client.query('UPDATE platform_safety_response_policy SET content_digest=$1,review_digest=$2 WHERE singleton=true',
    [selected.contentDigest, selected.reviewDigest]);
}

test('future approvedAt and contact verifiedAt reject actual review, activation and first publication with no archived replacement', async () => {
  await loopback(async runtime => {
    const target = await captured(runtime), before = await snapshot(target.f.who.userId, sidecarTables), old = await oldBytes(target.f.who);
    for (const selected of [changedBundle(c => { c.review.approvedAt = '2099-01-01T00:00:00.000Z'; }),
      changedBundle(c => { c.resources.contacts[0].verifiedAt = '2099-01-01T00:00:00.000Z'; })]) {
      const review = manifest(selected, authority.reviewer, authority.orgId);
      const registry = new SafetyDeliveryReviewRegistry(fixture.db, fixture.crypto, selected, review);
      await assert.rejects(registry.recordReview(authority.reviewer, { operationId: randomUUID() }), code('SAFETY_DELIVERY_UNAVAILABLE'));
      assert.equal((await fixture.db.query('SELECT id FROM platform_safety_delivery_assets WHERE review_digest=$1', [review.reviewDigest])).rowCount, 0);
      await rejectsMutation(() => authority.registry.activate(authority.operator, { operationId: randomUUID(), assetId: authority.assetId }),
        client => replaceArchivedFixture(client, selected, review));
      await rejectsMutation(() => delivery(selected, review).publish(target.f.who,
        { operationId: randomUUID(), submissionId: target.submissionId, expectedEdition: 0 }),
      client => replaceArchivedFixture(client, selected, review));
    }
    assert.deepEqual(await snapshot(target.f.who.userId, sidecarTables), before); assert.deepEqual(await oldBytes(target.f.who), old);
  });
});

test('registry snapshots mutable caller bundle and manifest before construction and across the first actual await', async () => {
  const inputBundle = JSON.parse(JSON.stringify(authority.selected)), inputReview = JSON.parse(JSON.stringify(authority.review));
  const registry = new SafetyDeliveryReviewRegistry(fixture.db, fixture.crypto, inputBundle, inputReview);
  inputBundle.locales.zh.L2.text = 'Synthetic changed after constructor.'; inputReview.reviewEvidenceRef = 'changed after constructor';
  const originalTransaction = fixture.db.withBoundedTransaction;
  fixture.db.withBoundedTransaction = function<T>(run: (client: PoolClient) => Promise<T>, options = {}) {
    return originalTransaction.call(fixture.db, async client => {
      inputBundle.review.approvedAt = '2099-01-01T00:00:00.000Z'; inputReview.reviewerUserId = randomUUID();
      return run(client);
    }, options) as Promise<T>;
  };
  try {
    const result = await registry.recordReview(authority.reviewer, { operationId: randomUUID() }); assert.equal(result.assetId, authority.assetId);
    await registry.activate(authority.operator, { operationId: randomUUID(), assetId: result.assetId });
  } finally { fixture.db.withBoundedTransaction = originalTransaction; }
  const row = (await fixture.db.query('SELECT bundle_json,review_json FROM platform_safety_delivery_assets WHERE id=$1', [authority.assetId])).rows[0];
  assert.equal(row.bundle_json, JSON.stringify(authority.selected)); assert.equal(row.review_json, JSON.stringify(authority.review));
});

test('true publication survives later missing config and revoked staff role; first publication still requires actual active approval', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), old = await oldBytes(target.f.who), second = await captured(runtime);
    await fixture.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1", [authority.orgId]);
    await fixture.db.query('DELETE FROM platform_safety_delivery_policy'); await fixture.db.query('DELETE FROM platform_safety_response_policy');
    const archived = delivery(null, null);
    const restored = await archived.publish(target.f.who, target.publicationCommand); assert(restored); assert.equal(restored.replayed, true);
    const projection = await archived.issueBodyProjection(target.f.who, { publicationId: target.publicationId }); assertBodyOnly(projection);
    await assert.rejects(second.api.publish(second.f.who, { operationId: randomUUID(), submissionId: second.submissionId, expectedEdition: 0 }),
      code('SAFETY_DELIVERY_UNAVAILABLE'));
    assert.deepEqual(await oldBytes(target.f.who), old);
  });
});

test('authentic source and draft anchors block complete sidecar deletion and any plaintext reset or ID replacement', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), question = new SafetyQuestionDelivery(fixture.db, fixture.crypto, target.api);
    await question.reserve(target.f.who, { operationId: randomUUID(), publicationId: target.publicationId,
      expectedQuestionScopeRevision: 0, renderOwnerId: randomUUID() });
    const old = await oldBytes(target.f.who), before = await snapshot(target.f.who.userId, sidecarTables);
    const source = (await fixture.db.query('SELECT first_safety_publication_id FROM platform_companion_name_submissions WHERE id=$1', [target.submissionId])).rows[0];
    assert.equal(source.first_safety_publication_id, target.publicationId);
    const scope = (await fixture.db.query('SELECT draft_id FROM platform_safety_question_scopes WHERE user_id=$1', [target.f.who.userId])).rows[0]; assert(scope);
    for (const attempt of [
      async (client: PoolClient) => {
        await client.query('DELETE FROM platform_companion_name_delivery_heads WHERE submission_id=$1', [target.submissionId]);
        await client.query('DELETE FROM platform_companion_name_safety_publications WHERE submission_id=$1', [target.submissionId]);
      },
      (client: PoolClient) => client.query('UPDATE platform_companion_name_submissions SET first_safety_publication_id=NULL WHERE id=$1', [target.submissionId]),
      (client: PoolClient) => client.query('UPDATE platform_companion_name_submissions SET first_safety_publication_id=$2 WHERE id=$1', [target.submissionId, randomUUID()]),
      (client: PoolClient) => client.query('DELETE FROM platform_safety_question_scopes WHERE user_id=$1', [target.f.who.userId]),
      (client: PoolClient) => client.query('UPDATE platform_onboarding_drafts SET name_question_scope_draft_id=NULL WHERE id=$1', [scope.draft_id]),
      (client: PoolClient) => client.query('UPDATE platform_onboarding_drafts SET name_question_scope_draft_id=$2 WHERE id=$1', [scope.draft_id, randomUUID()]),
    ]) await assert.rejects(fixture.db.transaction(async client => { await attempt(client); }), constraint);
    assert.deepEqual(await snapshot(target.f.who.userId, sidecarTables), before); assert.deepEqual(await oldBytes(target.f.who), old);
    // A visible uncommitted deletion also cannot be used to rebuild edition 1;
    // the real source root still remembers the first actual publication.
    await rejectsMutation(() => target.api.recover(target.f.who, { operationId: randomUUID(), submissionId: target.submissionId, expectedEdition: 0 }),
      async client => {
        await client.query('DELETE FROM platform_companion_name_delivery_heads WHERE submission_id=$1', [target.submissionId]);
        await client.query('DELETE FROM platform_companion_name_safety_publications WHERE submission_id=$1', [target.submissionId]);
      });
    assert.deepEqual(await snapshot(target.f.who.userId, sidecarTables), before); assert.deepEqual(await oldBytes(target.f.who), old);
  });
});

test('own sealed head, operation, projection or publication corruption and tail deletion cannot synthesize a new journal', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), present = await presented(target);
    const before = await snapshot(target.f.who.userId, sidecarTables), old = await oldBytes(target.f.who);
    for (const mutation of [
      (client: PoolClient) => client.query("UPDATE platform_companion_name_safety_followup_states SET payload_ciphertext=decode(repeat('01',40),'hex') WHERE publication_id=$1", [target.publicationId]),
      (client: PoolClient) => client.query("UPDATE platform_companion_name_safety_followups SET payload_ciphertext=decode(repeat('02',40),'hex') WHERE operation_id=$1 AND user_id=$2", [present.command.operationId, target.f.who.userId]),
      (client: PoolClient) => client.query("UPDATE platform_companion_name_safety_body_projections SET payload_ciphertext=decode(repeat('03',40),'hex') WHERE id=$1", [present.projection.bodyProjectionId]),
      (client: PoolClient) => client.query("UPDATE platform_companion_name_safety_publications SET payload_ciphertext=decode(repeat('04',40),'hex') WHERE id=$1", [target.publicationId]),
      async (client: PoolClient) => {
        await client.query('DELETE FROM platform_companion_name_safety_followups WHERE user_id=$1 AND operation_id=$2', [target.f.who.userId, present.command.operationId]);
        await client.query(`UPDATE platform_companion_name_safety_followup_states SET revision=0,latest_operation_id=NULL,journal_digest=$2 WHERE publication_id=$1`,
          [target.publicationId, publicationGenesis((await client.query<NameSafetyPublicationRow>('SELECT * FROM platform_companion_name_safety_publications WHERE id=$1', [target.publicationId])).rows[0])]);
      },
    ]) await rejectsMutation(() => target.api.read(target.f.who, { publicationId: target.publicationId }), mutation);
    assert.deepEqual(await snapshot(target.f.who.userId, sidecarTables), before); assert.deepEqual(await oldBytes(target.f.who), old);
    const ack = await act(target, { kind: 'acknowledge', presentationReceipt: present.receipt }); assert.equal(ack.result.state.acknowledged, true);
  });
});

test('later pending name and a damaged independent card do not prevent authentic old-target resource access', async () => {
  await loopback(async runtime => {
    const target = await published(runtime);
    const otherId = await classified(target.f, runtime, 'Fictional low marker'); await original().prepareSubmission(otherId);
    const other = await target.api.publish(target.f.who, { operationId: randomUUID(), submissionId: otherId, expectedEdition: 0 }); assert(other);
    await fixture.db.query("UPDATE platform_companion_name_safety_publications SET payload_ciphertext=decode(repeat('05',40),'hex') WHERE id=$1", [other.publicationId]);
    const entry = (await fixture.db.query('SELECT revision FROM platform_companion_name_entries WHERE task_id=$1', [target.f.prepared.taskId])).rows[0];
    await target.f.safety.submit(target.f.who, { taskId: target.f.prepared.taskId, operationId: randomUUID(), name: 'Synthetic still pending',
      expectedEntryRevision: entry.revision, expectedIdentityRevision: 0 });
    const old = await oldBytes(target.f.who), unchanged = await noAuthorityBytes(target.f.who);
    const ack = await acknowledged(target); assert.equal(ack.result.state.level, 'L2');
    assert.equal((await act(target, { kind: 'continue_naming', presentationReceipt: ack.receipt })).result.state.handled, true);
    assert.deepEqual(await oldBytes(target.f.who), old); assert.deepEqual(await noAuthorityBytes(target.f.who), unchanged);
    await assert.rejects(target.api.read(target.f.who, { publicationId: other.publicationId }), code('DATA_STORAGE_UNAVAILABLE'));
  });
});

async function historicalTarget(runtime: PlatformProviderRuntime, setup?: (target: Target) => Promise<void>, retentionDays = 1, evidenceRetentionDays = 40) {
  authority = await reviewAuthority(changedBundle(c => { c.revision = 96; c.retentionDays = retentionDays; }), evidenceRetentionDays);
  const capturedTarget = await captured(runtime);
  // Controlled synthetic historical fixture. The name/classifier/usage paths
  // above are real. Only this fictional old capsule and its bound event are
  // coherently dated three days earlier, before establishing the byte baseline.
  // The DB clock is unchanged; later 047 operations may not rewrite this baseline.
  const row = (await fixture.db.query('SELECT * FROM platform_companion_name_safety_responses WHERE submission_id=$1', [capturedTarget.submissionId])).rows[0];
  const at = new Date(row.prepared_at.getTime() - 3 * 86400000), until = new Date(at.getTime() + authority.selected.retentionDays * 86400000);
  const aad = { table: 'platform_companion_name_safety_responses', column: 'payload_ciphertext', rowId: row.id, ownerId: row.user_id, revision: 1 };
  const oldCapture = JSON.parse(fixture.crypto.openUtf8(row.payload_ciphertext, aad));
  oldCapture.preparedAt = at.toISOString(); oldCapture.retentionUntil = until.toISOString();
  await fixture.db.transaction(async client => {
    await client.query('UPDATE platform_companion_name_safety_responses SET prepared_at=$2,retention_until=$3,payload_ciphertext=$4 WHERE id=$1',
      [row.id, at, until, fixture.crypto.sealUtf8(JSON.stringify(oldCapture), aad)]);
    await client.query('UPDATE platform_safety_events SET created_at=$2,retention_until=$3 WHERE name_response_id=$1', [row.id, at, until]);
  });
  const old = await oldBytes(capturedTarget.f.who), publicationCommand = { operationId: randomUUID(), submissionId: capturedTarget.submissionId, expectedEdition: 0 };
  const publication = await capturedTarget.api.publish(capturedTarget.f.who, publicationCommand); assert(publication);
  const target: Target = { ...capturedTarget, publication, publicationId: publication.publicationId, publicationCommand };
  if (setup) await setup(target);
  await ageDeliveryFixture(target, 2 * 86400000);
  assert.deepEqual(await oldBytes(target.f.who), old);
  const state = await target.api.read(target.f.who, { publicationId: target.publicationId }); assert.equal(state.status, retentionDays <= 2 ? 'expired' : 'ready');
  return { target, old };
}
async function ageDeliveryFixture(target: Target, milliseconds: number) {
  // Consistent fictional historical 047 records, made strictly later than the
  // already fixed old 046 capsule. Existing authentic grade/usage, handles,
  // handling and asked declarations are never fabricated. Journal operations
  // were obtained from the actual ports, then their dates and seals move together.
  const earlier = (value: Date | null) => value ? new Date(value.getTime() - milliseconds) : null;
  await fixture.db.transaction(async client => {
    const p = (await client.query<NameSafetyPublicationRow>('SELECT * FROM platform_companion_name_safety_publications WHERE id=$1', [target.publicationId])).rows[0];
    const asset = (await client.query('SELECT * FROM platform_safety_delivery_assets WHERE id=$1', [p.asset_id])).rows[0];
    const assetAad = { table: 'platform_safety_delivery_assets', column: 'decision_ciphertext', rowId: asset.id, ownerId: asset.reviewer_id, revision: 1 };
    const assetPayload = JSON.parse(fixture.crypto.openUtf8(asset.decision_ciphertext, assetAad));
    asset.recorded_at = earlier(asset.recorded_at); assetPayload.recordedAt = asset.recorded_at.toISOString();
    await client.query('UPDATE platform_safety_delivery_assets SET recorded_at=$2,decision_ciphertext=$3 WHERE id=$1',
      [asset.id, asset.recorded_at, fixture.crypto.sealUtf8(JSON.stringify(assetPayload), assetAad)]);
    const ops = (await client.query('SELECT * FROM platform_safety_delivery_review_operations WHERE asset_id=$1', [asset.id])).rows;
    for (const operation of ops) {
      const aad = { table: 'platform_safety_delivery_review_operations', column: 'capture_ciphertext', rowId: operation.operation_id, ownerId: operation.user_id, revision: 1 };
      const capture = JSON.parse(fixture.crypto.openUtf8(operation.capture_ciphertext, aad));
      operation.created_at = earlier(operation.created_at); capture.at = operation.created_at.toISOString();
      await client.query('UPDATE platform_safety_delivery_review_operations SET created_at=$3,capture_ciphertext=$4 WHERE user_id=$1 AND operation_id=$2',
        [operation.user_id, operation.operation_id, operation.created_at, fixture.crypto.sealUtf8(JSON.stringify(capture), aad)]);
    }
    await client.query("UPDATE platform_safety_delivery_policy SET activated_at=activated_at-($1::bigint*interval '1 millisecond') WHERE asset_id=$2", [milliseconds, asset.id]);
    await client.query("UPDATE platform_safety_response_policy SET activated_at=activated_at-($1::bigint*interval '1 millisecond') WHERE activated_by=$2", [milliseconds, authority.operator.userId]);
    const payload = openDelivery(fixture.crypto, 'platform_companion_name_safety_publications', p.id, p.user_id, 1, p.payload_ciphertext) as Record<string, any>;
    p.prepared_at = earlier(p.prepared_at)!; p.published_at = earlier(p.published_at)!;
    p.retention_until = earlier(p.retention_until)!; p.evidence_retention_until = earlier(p.evidence_retention_until)!;
    payload.activation.at = new Date(Date.parse(payload.activation.at) - milliseconds).toISOString();
    const newPayload = { schemaVersion: 1, ...publicationCoordinates(p), activation: payload.activation, locale: payload.locale, response: payload.response };
    await client.query(`UPDATE platform_companion_name_safety_publications SET prepared_at=$2,published_at=$2,retention_until=$3,
      evidence_retention_until=$4,payload_ciphertext=$5 WHERE id=$1`,
      [p.id, p.prepared_at, p.retention_until, p.evidence_retention_until, sealDelivery(fixture.crypto, 'platform_companion_name_safety_publications', p.id, p.user_id, 1, newPayload)]);
    const requests = (await client.query('SELECT * FROM platform_companion_name_delivery_operations WHERE publication_id=$1', [p.id])).rows;
    for (const request of requests) {
      const capture = openDelivery(fixture.crypto, 'platform_companion_name_delivery_operations', request.operation_id, request.user_id, 1, request.payload_ciphertext) as Record<string, any>;
      request.created_at = earlier(request.created_at); capture.at = request.created_at.toISOString();
      await client.query('UPDATE platform_companion_name_delivery_operations SET created_at=$3,payload_ciphertext=$4 WHERE user_id=$1 AND operation_id=$2',
        [request.user_id, request.operation_id, request.created_at, sealDelivery(fixture.crypto, 'platform_companion_name_delivery_operations', request.operation_id, request.user_id, 1, capture)]);
    }
    const projections = (await client.query('SELECT * FROM platform_companion_name_safety_body_projections WHERE publication_id=$1', [p.id])).rows;
    for (const projection of projections) {
      const capture = openDelivery(fixture.crypto, 'platform_companion_name_safety_body_projections', projection.id, projection.user_id, 1, projection.payload_ciphertext) as Record<string, any>;
      projection.issued_at = earlier(projection.issued_at); capture.issuedAt = projection.issued_at.toISOString();
      await client.query('UPDATE platform_companion_name_safety_body_projections SET issued_at=$2,payload_ciphertext=$3 WHERE id=$1',
        [projection.id, projection.issued_at, sealDelivery(fixture.crypto, 'platform_companion_name_safety_body_projections', projection.id, projection.user_id, 1, capture)]);
    }
    const followups = (await client.query<NameSafetyFollowupRow>('SELECT * FROM platform_companion_name_safety_followups WHERE publication_id=$1 ORDER BY applied_revision', [p.id])).rows;
    let digest = publicationGenesis(p);
    for (const op of followups) {
      const capture = openDelivery(fixture.crypto, 'platform_companion_name_safety_followups', op.operation_id, op.user_id, op.applied_revision, op.payload_ciphertext) as Record<string, unknown>;
      op.created_at = earlier(op.created_at)!; op.clarified_at = earlier(op.clarified_at); op.previous_digest = digest;
      op.journal_digest = followupDigest(op, capture.request, capture.authority); digest = op.journal_digest;
      await client.query(`UPDATE platform_companion_name_safety_followups SET created_at=$3,clarified_at=$4,previous_digest=$5,
        journal_digest=$6,payload_ciphertext=$7 WHERE user_id=$1 AND operation_id=$2`,
      [op.user_id, op.operation_id, op.created_at, op.clarified_at, op.previous_digest, op.journal_digest,
        sealDelivery(fixture.crypto, 'platform_companion_name_safety_followups', op.operation_id, op.user_id, op.applied_revision, followupCapture(op, capture.request, capture.authority))]);
    }
    const state = (await client.query<NameSafetyStateRow>('SELECT * FROM platform_companion_name_safety_followup_states WHERE publication_id=$1', [p.id])).rows[0];
    state.journal_digest = digest;
    await client.query('UPDATE platform_companion_name_safety_followup_states SET journal_digest=$2,payload_ciphertext=$3 WHERE publication_id=$1',
      [p.id, digest, sealDelivery(fixture.crypto, 'platform_companion_name_safety_followup_states', p.id, p.user_id, state.revision, followupStateCapture(state, p))]);
    const questionScope = (await client.query<QuestionScopeRow>('SELECT * FROM platform_safety_question_scopes WHERE user_id=$1 AND draft_id=$2', [p.user_id, p.logical_draft_id])).rows[0];
    if (questionScope) {
      const scopePayload = openDelivery(fixture.crypto, 'platform_safety_question_scopes', questionScope.draft_id, questionScope.user_id, questionScope.revision, questionScope.payload_ciphertext) as { legacyDigest: string };
      const qops = (await client.query<QuestionOperationRow>('SELECT * FROM platform_safety_question_operations WHERE user_id=$1 AND draft_id=$2 ORDER BY applied_revision', [p.user_id, p.logical_draft_id])).rows;
      let qdigest = deliveryDigest(JSON.stringify({ userId: p.user_id, draftId: p.logical_draft_id, legacyDigest: scopePayload.legacyDigest }));
      const latest = new Map<string, QuestionOccurrenceRow>();
      for (const op of qops) {
        const capture = openDelivery(fixture.crypto, 'platform_safety_question_operations', op.operation_id, op.user_id, op.applied_revision, op.payload_ciphertext) as Record<string, any>;
        const after = occurrenceFromCapture(capture.after);
        after.reserved_until = earlier(after.reserved_until)!; after.display_until = earlier(after.display_until);
        after.evidence_until = earlier(after.evidence_until); after.claimed_at = earlier(after.claimed_at); after.receipt_received_at = earlier(after.receipt_received_at);
        op.created_at = earlier(op.created_at)!; op.previous_digest = qdigest;
        op.journal_digest = deliveryDigest(JSON.stringify(questionOperationCore(op, capture.request, after, capture.secret, capture.question))); qdigest = op.journal_digest;
        await client.query(`UPDATE platform_safety_question_operations SET created_at=$3,previous_digest=$4,journal_digest=$5,payload_ciphertext=$6
          WHERE user_id=$1 AND operation_id=$2`,
        [op.user_id, op.operation_id, op.created_at, op.previous_digest, op.journal_digest,
          sealDelivery(fixture.crypto, 'platform_safety_question_operations', op.operation_id, op.user_id, op.applied_revision,
            questionOperationCapture(op, capture.request, after, capture.secret, capture.question))]);
        latest.set(after.id, after);
      }
      for (const occurrence of latest.values()) await client.query(`UPDATE platform_safety_question_occurrences SET reserved_until=$2,display_until=$3,
        evidence_until=$4,claimed_at=$5,receipt_received_at=$6 WHERE id=$1`,
      [occurrence.id, occurrence.reserved_until, occurrence.display_until, occurrence.evidence_until, occurrence.claimed_at, occurrence.receipt_received_at]);
      questionScope.journal_digest = qdigest;
      await client.query('UPDATE platform_safety_question_scopes SET journal_digest=$3,payload_ciphertext=$4 WHERE user_id=$1 AND draft_id=$2',
        [questionScope.user_id, questionScope.draft_id, qdigest, sealDelivery(fixture.crypto, 'platform_safety_question_scopes', questionScope.draft_id,
          questionScope.user_id, questionScope.revision, questionScopeCapture(questionScope, scopePayload.legacyDigest))]);
    }
  });
}

test('expired edition cannot issue a fresh body or acknowledgment; genuine recovery appends an edition without changing old046 bytes', async () => {
  await loopback(async runtime => {
    let receipt = '';
    const { target, old } = await historicalTarget(runtime, async t => { receipt = (await presented(t)).receipt; });
    await assert.rejects(target.api.issueBodyProjection(target.f.who, { publicationId: target.publicationId }), code('SAFETY_DELIVERY_RESPONSE_EXPIRED'));
    await assert.rejects(act(target, { kind: 'acknowledge', presentationReceipt: receipt }), code('SAFETY_DELIVERY_RESPONSE_EXPIRED'));
    const beforeOldEdition = (await fixture.db.query('SELECT * FROM platform_companion_name_safety_publications WHERE id=$1', [target.publicationId])).rows[0];
    const recovered = await target.api.recover(target.f.who, { operationId: randomUUID(), submissionId: target.submissionId, expectedEdition: 1 }); assert(recovered);
    assert.equal(recovered.edition, 2); assert.notEqual(recovered.publicationId, target.publicationId);
    const latest = { ...target, publication: recovered, publicationId: recovered.publicationId };
    assertBodyOnly(await latest.api.issueBodyProjection(latest.f.who, { publicationId: latest.publicationId }));
    const ack = await acknowledged(latest); assert.equal((await act(latest, { kind: 'continue_naming', presentationReceipt: ack.receipt })).result.state.handled, true);
    assert.deepEqual((await fixture.db.query('SELECT * FROM platform_companion_name_safety_publications WHERE id=$1', [target.publicationId])).rows[0], beforeOldEdition);
    assert.deepEqual(await oldBytes(target.f.who), old);
  });
});

test('expired real same-session presentation plus acknowledgment remains an explicit handling path; late body evidence grants no handle', async () => {
  await loopback(async runtime => {
    let receipt = '', projectionId = '';
    const { target, old } = await historicalTarget(runtime, async t => {
      receipt = (await acknowledged(t)).receipt;
      projectionId = (await t.api.issueBodyProjection(t.f.who, { publicationId: t.publicationId })).bodyProjectionId;
    });
    const evidence = await act(target, { kind: 'present_body', bodyProjectionId: projectionId });
    assert.equal(Object.hasOwn(evidence.result, 'presentationReceipt'), false);
    const row = (await fixture.db.query('SELECT kind FROM platform_companion_name_safety_followups WHERE user_id=$1 AND operation_id=$2',
      [target.f.who.userId, evidence.command.operationId])).rows[0]; assert.equal(row.kind, 'present_body_evidence');
    const handled = await act(target, { kind: 'continue_naming', presentationReceipt: receipt }); assert.equal(handled.result.state.handled, true);
    assert.equal(handled.result.state.status, 'expired'); assert.deepEqual(await oldBytes(target.f.who), old);
  });
});

test('new login obtains its own body chain despite missing current terms, email and budget; handling retains current authorization gates', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), oldChain = await acknowledged(target), fresh = await session(target.f.who);
    await fixture.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [fresh.userId]);
    await fixture.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [fresh.userId]);
    await fixture.db.query('DELETE FROM platform_cost_user_policy WHERE user_id=$1', [fresh.userId]);
    const before = await noAuthorityBytes(fresh), old = await oldBytes(fresh);
    await assert.rejects(target.api.read(target.f.who, { publicationId: target.publicationId }), code('AUTH_REQUIRED'));
    const newChain = await acknowledged(target, fresh); assert.notEqual(newChain.receipt, oldChain.receipt);
    await assert.rejects(act(target, { kind: 'continue_naming', presentationReceipt: newChain.receipt }, fresh),
      error => error instanceof ApiError && ['EMAIL_VERIFICATION_REQUIRED', 'TERMS_CONFIRMATION_REQUIRED'].includes(error.code));
    assert.deepEqual(await oldBytes(fresh), old); assert.deepEqual(await noAuthorityBytes(fresh), before);
    assert.equal((await fixture.db.query('SELECT * FROM platform_companion_name_safety_handled WHERE user_id=$1', [fresh.userId])).rowCount, 0);
  });
});

function questions(target: Target, timing?: { reservationMs: number; displayMs: number }) {
  return new SafetyQuestionDelivery(fixture.db, fixture.crypto, target.api, timing);
}
async function reservedQuestion(target: Target, api = questions(target), who = target.f.who, renderOwnerId = randomUUID()) {
  const state = await api.read(who, { publicationId: target.publicationId });
  const command = { operationId: randomUUID(), publicationId: target.publicationId,
    expectedQuestionScopeRevision: state.scopeRevision, renderOwnerId };
  const result = await api.reserve(who, command); assert.equal(typeof result.reservationToken, 'string');
  return { api, who, renderOwnerId, command, result };
}
async function claimedQuestion(target: Target, api = questions(target), who = target.f.who, renderOwnerId = randomUUID()) {
  const reservation = await reservedQuestion(target, api, who, renderOwnerId);
  const command = { operationId: randomUUID(), occurrenceId: reservation.result.occurrenceId,
    reservationId: reservation.result.reservationId, reservationToken: reservation.result.reservationToken!,
    generation: reservation.result.generation, renderOwnerId };
  const result = await api.claim(who, command);
  assert.equal(result.status, 'display_granted'); assert.equal(typeof result.question, 'string'); assert.equal(typeof result.grantPresentationToken, 'string');
  return { ...reservation, claimCommand: command, claim: result };
}
function questionPresentCommand(grant: Awaited<ReturnType<typeof claimedQuestion>>) {
  return { operationId: randomUUID(), occurrenceId: grant.claim.occurrenceId, grantId: grant.claim.grantId,
    grantPresentationToken: grant.claim.grantPresentationToken!, renderOwnerId: grant.renderOwnerId };
}
async function waitPast(value: string) { await delay(Math.max(0, Date.parse(value) - Date.now()) + 75); }

test('question read and reservation create no asked declaration; concurrent actual controllers receive one exclusive committed grant', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), api = questions(target), initial = await snapshot(target.f.who.userId, sidecarTables);
    const firstRead = await api.read(target.f.who, { publicationId: target.publicationId });
    assert.equal(firstRead.scopeRevision, 0); assert.equal(firstRead.receiptReceivedAt, null); assert.equal(firstRead.sourcePhase, null);
    assert.deepEqual(await snapshot(target.f.who.userId, sidecarTables), initial);
    const secondDevice = await session(target.f.who, false), devices = [target.f.who, secondDevice], controllers = [randomUUID(), randomUUID()];
    const requests = devices.map((_, i) => ({ operationId: randomUUID(), publicationId: target.publicationId,
      expectedQuestionScopeRevision: 0, renderOwnerId: controllers[i] }));
    const races = await Promise.allSettled(devices.map((who, i) => api.reserve(who, requests[i])));
    assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
    const winner = races.findIndex(r => r.status === 'fulfilled'), won = races[winner]; assert(won.status === 'fulfilled');
    const lost = races[1 - winner]; assert(lost.status === 'rejected'); assert(code('SAFETY_QUESTION_SCOPE_REVISION_CHANGED')(lost.reason));
    assert.equal(Object.hasOwn(won.value, 'question'), false); assert.equal((await api.read(devices[winner], { publicationId: target.publicationId })).receiptReceivedAt, null);
    const replay = await api.reserve(devices[winner], requests[winner]); assert.equal(Object.hasOwn(replay, 'reservationToken'), false);
    const claimCommand = { operationId: randomUUID(), occurrenceId: won.value.occurrenceId, reservationId: won.value.reservationId,
      reservationToken: won.value.reservationToken!, generation: won.value.generation, renderOwnerId: controllers[winner] };
    const grant = await api.claim(devices[winner], claimCommand); assert.equal(grant.status, 'display_granted'); assert(grant.question);
    const exact = await api.claim(devices[winner], claimCommand); assert.equal(exact.grantId, grant.grantId);
    assert.equal(exact.question, grant.question); assert.equal(exact.grantPresentationToken, grant.grantPresentationToken);
    assert.equal(exact.operation.replayed, true);
    await assert.rejects(api.claim(devices[1 - winner], { ...claimCommand, operationId: randomUUID(), renderOwnerId: controllers[1 - winner] }), code('SAFETY_QUESTION_RESERVED'));
    const state = await api.read(target.f.who, { publicationId: target.publicationId }); assert.equal(state.receiptReceivedAt, null);
    assert.equal(state.deliveryUncertain, true); assert.equal(state.sourcePhase, 'claimed');
    assert.equal((await target.api.read(target.f.who, { publicationId: target.publicationId })).revision, 0);
  });
});

test('unclaimed reservation expires under actual DB time and changes generation; stale owner capability cannot claim the successor', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), api = questions(target, { reservationMs: 1000, displayMs: 15000 });
    const old = await reservedQuestion(target, api); await waitPast(old.result.reservedUntil);
    const fresh = await reservedQuestion(target, api, target.f.who, randomUUID());
    assert.equal(fresh.result.occurrenceId, old.result.occurrenceId); assert.equal(fresh.result.generation, old.result.generation + 1);
    assert.notEqual(fresh.result.reservationId, old.result.reservationId);
    await assert.rejects(api.claim(target.f.who, { operationId: randomUUID(), occurrenceId: old.result.occurrenceId,
      reservationId: old.result.reservationId, reservationToken: old.result.reservationToken!, generation: old.result.generation,
      renderOwnerId: old.renderOwnerId }), code('SAFETY_QUESTION_RESERVED'));
    const grant = await api.claim(target.f.who, { operationId: randomUUID(), occurrenceId: fresh.result.occurrenceId,
      reservationId: fresh.result.reservationId, reservationToken: fresh.result.reservationToken!, generation: fresh.result.generation,
      renderOwnerId: fresh.renderOwnerId }); assert.equal(grant.status, 'display_granted');
    assert.equal((await api.read(target.f.who, { publicationId: target.publicationId })).receiptReceivedAt, null);
  });
});

test('lost committed grant becomes uncertain after the actual display window; late authentic evidence changes no body CAS or handled fact', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), api = questions(target, { reservationMs: 15000, displayMs: 1000 }), grant = await claimedQuestion(target, api);
    const old = await oldBytes(target.f.who), unchanged = await noAuthorityBytes(target.f.who);
    const body = await acknowledged(target); const handled = await act(target, { kind: 'continue_naming', presentationReceipt: body.receipt });
    await waitPast(grant.claim.displayUntil!);
    const retry = await api.claim(target.f.who, grant.claimCommand); assert.equal(retry.status, 'delivery_uncertain');
    assert.equal(Object.hasOwn(retry, 'question'), false); assert.equal(Object.hasOwn(retry, 'grantPresentationToken'), false);
    await assert.rejects(reservedQuestion(target, api), code('SAFETY_QUESTION_DELIVERY_UNCERTAIN'));
    const stateBefore = await target.api.read(target.f.who, { publicationId: target.publicationId });
    const beforeReceipt = Date.now(), command = questionPresentCommand(grant), receipt = await api.present(target.f.who, command);
    assert(Date.parse(receipt.receiptReceivedAt) >= beforeReceipt - 1);
    assert.equal((await api.read(target.f.who, { publicationId: target.publicationId })).sourcePhase, 'declared');
    assert.deepEqual(await target.api.read(target.f.who, { publicationId: target.publicationId }), stateBefore);
    assert.equal(stateBefore.revision, handled.result.state.revision);
    const receiptReplay = await api.present(target.f.who, command); assert.equal(receiptReplay.receiptReceivedAt, receipt.receiptReceivedAt);
    assert.equal(receiptReplay.operation.replayed, true);
    const declaredReplay = await api.claim(target.f.who, grant.claimCommand);
    assert.equal(Object.hasOwn(declaredReplay, 'question'), false); assert.equal(Object.hasOwn(declaredReplay, 'grantPresentationToken'), false);
    assert.deepEqual(await oldBytes(target.f.who), old); assert.deepEqual(await noAuthorityBytes(target.f.who), unchanged);
  });
});

test('question evidence arriving after fictional body expiry uses its original grant and remains independent of later recovery and body revision', async () => {
  await loopback(async runtime => {
    let grant: Awaited<ReturnType<typeof claimedQuestion>> | undefined;
    const { target, old } = await historicalTarget(runtime, async t => { grant = await claimedQuestion(t); }); assert(grant);
    const api = questions(target), stateBefore = await target.api.read(target.f.who, { publicationId: target.publicationId });
    assert.equal(stateBefore.status, 'expired'); assert.equal(stateBefore.revision, 0);
    const receipt = await api.present(target.f.who, questionPresentCommand(grant)); assert(receipt.receiptReceivedAt);
    const after = await target.api.read(target.f.who, { publicationId: target.publicationId }); assert.deepEqual(after, stateBefore);
    assert.equal(after.acknowledged, false); assert.equal(after.handled, false);
    const recovered = await target.api.recover(target.f.who, { operationId: randomUUID(), submissionId: target.submissionId, expectedEdition: 1 }); assert(recovered);
    assert.equal(recovered.edition, 2);
    assert.equal((await api.read(target.f.who, { publicationId: recovered.publicationId })).receiptReceivedAt, receipt.receiptReceivedAt);
    await assert.rejects(api.reserve(target.f.who, { operationId: randomUUID(), publicationId: recovered.publicationId,
      expectedQuestionScopeRevision: receipt.scopeRevision, renderOwnerId: randomUUID() }), code('SAFETY_QUESTION_ALREADY_ASKED'));
    assert.deepEqual(await oldBytes(target.f.who), old);
  });
});

test('revoked original question session and fresh-login transplanted grants cannot declare asked evidence or reissue a claimed question', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), grant = await claimedQuestion(target), command = questionPresentCommand(grant), fresh = await session(target.f.who);
    await assert.rejects(grant.api.present(target.f.who, command), code('AUTH_REQUIRED'));
    await assert.rejects(grant.api.present(fresh, command), code('SAFETY_QUESTION_DELIVERY_UNCERTAIN'));
    await assert.rejects(grant.api.claim(fresh, grant.claimCommand), code('SAFETY_QUESTION_OPERATION_CONFLICT'));
    await assert.rejects(reservedQuestion(target, grant.api, fresh), code('SAFETY_QUESTION_DELIVERY_UNCERTAIN'));
    const body = await acknowledged(target, fresh); assert.equal(body.ack.result.state.acknowledged, true);
    const state = await grant.api.read(fresh, { publicationId: target.publicationId }); assert.equal(state.receiptReceivedAt, null);
  });
});

test('question quota spans actual new sessions and editions while a genuine new L2 source gets its one first-signal exception', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), first = await claimedQuestion(target), receipt = await first.api.present(target.f.who, questionPresentCommand(first));
    await assert.rejects(reservedQuestion(target), code('SAFETY_QUESTION_ALREADY_ASKED'));
    const fresh = await session(target.f.who, false);
    await assert.rejects(reservedQuestion(target, first.api, fresh), code('SAFETY_QUESTION_ALREADY_ASKED'));
    const newId = await classified(target.f, runtime, 'Fictional high marker additional real source'); await original().prepareSubmission(newId);
    const publicationCommand = { operationId: randomUUID(), submissionId: newId, expectedEdition: 0 };
    const publication = await target.api.publish(target.f.who, publicationCommand); assert(publication);
    const next: Target = { ...target, submissionId: newId, publication, publicationId: publication.publicationId, publicationCommand };
    const second = await claimedQuestion(next), secondReceipt = await second.api.present(next.f.who, questionPresentCommand(second));
    assert(secondReceipt.scopeRevision > receipt.scopeRevision);
    await assert.rejects(reservedQuestion(next), code('SAFETY_QUESTION_ALREADY_ASKED'));
    assert.equal((await fixture.db.query('SELECT * FROM platform_safety_question_occurrences WHERE user_id=$1 AND phase=\'declared\'', [target.f.who.userId])).rowCount, 2);
    assert.equal((await fixture.db.query('SELECT * FROM platform_companion_name_safety_handled WHERE user_id=$1', [target.f.who.userId])).rowCount, 0);
  });
});

test('first routine claim rechecks whole-scope asked and uncertainty after a real new L2 source intervenes', async () => {
  for (const declareIntervening of [true, false]) await loopback(async runtime => {
    const { target } = await historicalTarget(runtime, async t => {
      const initial = await claimedQuestion(t); await initial.api.present(t.f.who, questionPresentCommand(initial));
    }, 17);
    const api = questions(target), routine = await reservedQuestion(target, api);
    const newId = await classified(target.f, runtime, 'Fictional high marker intervening classified source'); await original().prepareSubmission(newId);
    const publicationCommand = { operationId: randomUUID(), submissionId: newId, expectedEdition: 0 };
    const publication = await target.api.publish(target.f.who, publicationCommand); assert(publication);
    const next: Target = { ...target, submissionId: newId, publication, publicationId: publication.publicationId, publicationCommand };
    const newGrant = await claimedQuestion(next);
    if (declareIntervening) await api.present(target.f.who, questionPresentCommand(newGrant));
    await assert.rejects(api.claim(target.f.who, { operationId: randomUUID(), occurrenceId: routine.result.occurrenceId,
      reservationId: routine.result.reservationId, reservationToken: routine.result.reservationToken!, generation: routine.result.generation,
      renderOwnerId: routine.renderOwnerId }), code(declareIntervening ? 'SAFETY_QUESTION_ALREADY_ASKED' : 'SAFETY_QUESTION_DELIVERY_UNCERTAIN'));
    const occurrence = (await fixture.db.query('SELECT * FROM platform_safety_question_occurrences WHERE id=$1', [routine.result.occurrenceId])).rows[0];
    assert.equal(occurrence.phase, 'reserved'); assert.equal(occurrence.grant_id, null); assert.equal(occurrence.receipt_received_at, null);
    const body = await acknowledged(target); assert.equal(body.ack.result.state.acknowledged, true);
  });
});

test('whole populated migration SQL repeats twice without rewriting old capsules, sealed body/question journals or source/draft anchors', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), body = await acknowledged(target), question = await claimedQuestion(target);
    await act(target, { kind: 'clarify_exaggeration', presentationReceipt: body.receipt, safe: true, exaggeration: true });
    await question.api.present(target.f.who, questionPresentCommand(question));
    const tables = [...oldCaptureTables, ...authorityTables, ...sidecarTables, 'platform_companion_name_submissions', 'platform_onboarding_drafts'];
    const before = await snapshot(target.f.who.userId, tables), migrationJournal = (await fixture.db.query('SELECT * FROM platform_migrations ORDER BY name')).rows;
    const assets = (await fixture.db.query('SELECT * FROM platform_safety_delivery_assets ORDER BY id')).rows;
    const staffOps = (await fixture.db.query('SELECT * FROM platform_safety_delivery_review_operations ORDER BY user_id,operation_id')).rows;
    const sql = await readFile(new URL('../migrations/047_companion_name_safety_delivery.sql', import.meta.url), 'utf8');
    for (let repeat = 0; repeat < 2; repeat++) {
      await fixture.db.transaction(async client => { await client.query(sql); });
      assert.deepEqual(await snapshot(target.f.who.userId, tables), before);
      assert.deepEqual((await fixture.db.query('SELECT * FROM platform_safety_delivery_assets ORDER BY id')).rows, assets);
      assert.deepEqual((await fixture.db.query('SELECT * FROM platform_safety_delivery_review_operations ORDER BY user_id,operation_id')).rows, staffOps);
      assert.deepEqual((await fixture.db.query('SELECT * FROM platform_migrations ORDER BY name')).rows, migrationJournal);
    }
    assert.equal((await target.api.read(target.f.who, { publicationId: target.publicationId })).handled, true);
    assert.equal((await question.api.read(target.f.who, { publicationId: target.publicationId })).sourcePhase, 'declared');
  });
});

test('genuine handled old risk enables only the narrow existing entry L0 apply; caller flags and body observation cannot replace handling', async () => {
  await loopback(async (runtime, requests) => {
    const target = await published(runtime), old = await oldBytes(target.f.who);
    const l0 = await classified(target.f, runtime, 'Juno', true);
    const application = { taskId: target.f.prepared.taskId, submissionId: l0 };
    const narrow = new CompanionNameSafety(fixture.db, fixture.config, FICTIONAL_LEGAL, target.f.background, target.f.names, target.api);
    await assert.rejects(narrow.apply(target.f.who, { ...application, handled: true }), code('INVALID_INPUT'));
    await assert.rejects(narrow.apply(target.f.who, application), code('COMPANION_NAME_SAFETY_REVIEW_REQUIRED'));
    const ack = await acknowledged(target);
    await assert.rejects(narrow.apply(target.f.who, application), code('COMPANION_NAME_SAFETY_REVIEW_REQUIRED'));
    await act(target, { kind: 'continue_naming', presentationReceipt: ack.receipt });
    await assert.rejects(target.f.safety.apply(target.f.who, application), code('COMPANION_NAME_SAFETY_REVIEW_REQUIRED'));
    const applied = await narrow.apply(target.f.who, application); assert.equal(applied.status, 'applied'); assert.equal(applied.appliedIdentityRevision, 1);
    const replay = await narrow.apply(target.f.who, application); assert.equal(replay.status, 'applied'); assert.equal(replay.replayed, true);
    const oldRisk = (await fixture.db.query('SELECT level,detector_mode,application_status FROM platform_companion_name_submissions WHERE id=$1', [target.submissionId])).rows[0];
    assert.deepEqual(oldRisk, { level: 'L2', detector_mode: 'keyword_only', application_status: 'not_eligible' });
    assert.deepEqual(await oldBytes(target.f.who), old); assert.equal(requests.length, 2);
    assert.equal((await fixture.db.query('SELECT * FROM platform_conversations WHERE user_id=$1', [target.f.who.userId])).rowCount, 0);
    assert.equal((await fixture.db.query('SELECT * FROM platform_jobs WHERE user_id=$1', [target.f.who.userId])).rowCount, 0);
  });
});

test('real account deletion cleans anchored publication and question data instead of resetting surviving history', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), body = await acknowledged(target), question = await claimedQuestion(target);
    await act(target, { kind: 'continue_naming', presentationReceipt: body.receipt });
    await question.api.present(target.f.who, questionPresentCommand(question));
    await fixture.db.query('DELETE FROM platform_users WHERE id=$1', [target.f.who.userId]);
    for (const table of [...oldCaptureTables, ...sidecarTables, 'platform_companion_name_submissions', 'platform_onboarding_drafts'])
      assert.equal((await fixture.db.query(`SELECT * FROM ${table} WHERE user_id=$1`, [target.f.who.userId])).rowCount, 0, table);
    await assert.rejects(target.api.read(target.f.who, { publicationId: target.publicationId }), code('AUTH_REQUIRED'));
    assert.equal((await fixture.db.query('SELECT * FROM platform_safety_delivery_assets WHERE id=$1', [authority.assetId])).rowCount, 1);
  });
});

test('actual legacy publication is possible exposure rather than backfilled asked evidence; a genuine new L2 first signal remains eligible', async () => {
  await loopback(async (runtime, requests) => {
    const who = await fixture.actor();
    const started = (await fixture.store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'fast_track' } })).draft;
    assert(started.currentQuestion);
    await fixture.store.save(who, { expectedRevision: started.revision, operationId: randomUUID(),
      action: { kind: 'text', questionId: started.currentQuestion, text: 'Fictional high marker in real legacy intake' } });
    await new OnboardingSafetyRunner(fixture.store, { modelRoutes: { safety_classify: { provider: 'openai' } }, safetyDailyModelCallLimit: 100 },
      disabled(), profile).runNext(who);
    const originalSubmission = (await fixture.db.query('SELECT id FROM platform_onboarding_safety_submissions WHERE user_id=$1', [who.userId])).rows[0]; assert(originalSubmission);
    const oldResponses = new OnboardingSafetyResponses(fixture.db, fixture.config, FICTIONAL_LEGAL, authority.selected);
    await oldResponses.prepareSubmission(originalSubmission.id);
    const legacy = new OnboardingSafetyFollowup(fixture.db, fixture.config, FICTIONAL_LEGAL), state = await legacy.read(who);
    assert(state.draft); assert.equal(state.publications.length, 1); const oldPublication = state.publications[0];
    const present = await legacy.act(who, { operationId: randomUUID(), publicationId: oldPublication.publicationId,
      expectedDraftRevision: state.draft.revision, action: { kind: 'present' } }); assert(present.presentationReceipt);
    await legacy.act(who, { operationId: randomUUID(), publicationId: oldPublication.publicationId,
      expectedDraftRevision: state.draft.revision, action: { kind: 'acknowledge', presentationReceipt: present.presentationReceipt } });
    await legacy.act(who, { operationId: randomUUID(), publicationId: oldPublication.publicationId,
      expectedDraftRevision: state.draft.revision, action: { kind: 'continue_intake', presentationReceipt: present.presentationReceipt } });
    const f = await fixture.ready(runtime, { who }), submissionId = await classified(f, runtime);
    await original().prepareSubmission(submissionId);
    const api = delivery(), publicationCommand = { operationId: randomUUID(), submissionId, expectedEdition: 0 };
    const publication = await api.publish(who, publicationCommand); assert(publication);
    const target: Target = { f, submissionId, original: original(), api, publication, publicationId: publication.publicationId, publicationCommand };
    const oldTables = ['platform_onboarding_safety_submissions', 'platform_onboarding_safety_responses', 'platform_onboarding_safety_publications', 'platform_onboarding_safety_followups'];
    const before = await snapshot(who.userId, oldTables), question = questions(target);
    const initial = await question.read(who, { publicationId: target.publicationId });
    assert.equal(initial.possibleLegacyExposure, true); assert.equal(initial.receiptReceivedAt, null); assert.equal(initial.sourcePhase, null);
    assert.equal((await fixture.db.query('SELECT * FROM platform_safety_legacy_exposures WHERE user_id=$1', [who.userId])).rowCount, 0);
    for (const mutation of [
      (client: PoolClient) => client.query("UPDATE platform_onboarding_safety_publications SET payload_ciphertext=decode(repeat('08',40),'hex') WHERE id=$1", [oldPublication.publicationId]),
      (client: PoolClient) => client.query("UPDATE platform_onboarding_safety_responses SET level='L1' WHERE submission_id=$1", [originalSubmission.id]),
    ]) await rejectsMutation(() => question.read(who, { publicationId: target.publicationId }), mutation);
    assertBodyOnly(await target.api.issueBodyProjection(who, { publicationId: target.publicationId }));
    const grant = await claimedQuestion(target, question);
    assert.equal((await question.read(who, { publicationId: target.publicationId })).receiptReceivedAt, null);
    const exposure = (await fixture.db.query('SELECT * FROM platform_safety_legacy_exposures WHERE user_id=$1', [who.userId])).rows[0];
    assert.equal(exposure.publication_id, oldPublication.publicationId);
    const receipt = await question.present(who, questionPresentCommand(grant)); assert(receipt.receiptReceivedAt);
    await assert.rejects(reservedQuestion(target, question), code('SAFETY_QUESTION_DELIVERY_UNCERTAIN'));
    assert.deepEqual(await snapshot(who.userId, oldTables), before); assert.equal(requests.length, 1);
  });
});

test('actual full L0 and still-pending name source cannot create resource editions or any authority from caller-supplied risk fields', async () => {
  await loopback(async runtime => {
    const f = await fixture.ready(runtime), submissionId = await classified(f, runtime, 'Juno', true), api = delivery();
    const before = await snapshot(f.who.userId, [...oldCaptureTables, ...authorityTables, ...sidecarTables]);
    assert.equal(await api.publish(f.who, { operationId: randomUUID(), submissionId, expectedEdition: 0 }), null);
    assert.equal(await api.recover(f.who, { operationId: randomUUID(), submissionId, expectedEdition: 0 }), null);
    await assert.rejects(api.publish(f.who, { operationId: randomUUID(), submissionId, expectedEdition: 0, level: 'L2' }), code('INVALID_INPUT'));
    assert.deepEqual(await snapshot(f.who.userId, [...oldCaptureTables, ...authorityTables, ...sidecarTables]), before);
    const entry = (await fixture.db.query('SELECT revision FROM platform_companion_name_entries WHERE task_id=$1', [f.prepared.taskId])).rows[0];
    const pending = await f.safety.submit(f.who, { taskId: f.prepared.taskId, operationId: randomUUID(), name: 'Synthetic pending raw source',
      expectedEntryRevision: entry.revision, expectedIdentityRevision: 0 });
    const pendingBefore = await snapshot(f.who.userId, [...oldCaptureTables, ...authorityTables, ...sidecarTables]);
    await assert.rejects(api.publish(f.who, { operationId: randomUUID(), submissionId: pending.submissionId, expectedEdition: 0 }), unavailable);
    assert.deepEqual(await snapshot(f.who.userId, [...oldCaptureTables, ...authorityTables, ...sidecarTables]), pendingBefore);
  });
});

test('question sealed-head corruption and deleted suffix with a plaintext rewind fail closed and do not modify body state', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), grant = await claimedQuestion(target), before = await snapshot(target.f.who.userId, sidecarTables);
    const bodyBefore = await target.api.read(target.f.who, { publicationId: target.publicationId });
    for (const mutation of [
      (client: PoolClient) => client.query("UPDATE platform_safety_question_scopes SET payload_ciphertext=decode(repeat('06',40),'hex') WHERE user_id=$1", [target.f.who.userId]),
      (client: PoolClient) => client.query("UPDATE platform_safety_question_operations SET payload_ciphertext=decode(repeat('07',40),'hex') WHERE user_id=$1 AND operation_id=$2", [target.f.who.userId, grant.claimCommand.operationId]),
      async (client: PoolClient) => {
        await client.query('DELETE FROM platform_safety_question_operations WHERE user_id=$1 AND operation_id=$2', [target.f.who.userId, grant.claimCommand.operationId]);
        const oldHead = (await client.query('SELECT operation_id,journal_digest,applied_revision FROM platform_safety_question_operations WHERE user_id=$1 ORDER BY applied_revision DESC LIMIT 1', [target.f.who.userId])).rows[0];
        await client.query('UPDATE platform_safety_question_scopes SET revision=$2,latest_operation_id=$3,journal_digest=$4 WHERE user_id=$1',
          [target.f.who.userId, oldHead.applied_revision, oldHead.operation_id, oldHead.journal_digest]);
      },
    ]) await rejectsMutation(() => grant.api.read(target.f.who, { publicationId: target.publicationId }), mutation);
    assert.deepEqual(await snapshot(target.f.who.userId, sidecarTables), before);
    assert.deepEqual(await target.api.read(target.f.who, { publicationId: target.publicationId }), bodyBefore);
    const receipt = await grant.api.present(target.f.who, questionPresentCommand(grant)); assert(receipt.receiptReceivedAt);
  });
});

test('original claimed question cannot receive new presentation evidence after its explicitly reviewed evidence retention', async () => {
  await loopback(async runtime => {
    let grant: Awaited<ReturnType<typeof claimedQuestion>> | undefined;
    const { target, old } = await historicalTarget(runtime, async t => { grant = await claimedQuestion(t); }, 1, 1); assert(grant);
    const before = await snapshot(target.f.who.userId, sidecarTables);
    await assert.rejects(grant.api.present(target.f.who, questionPresentCommand(grant)), code('SAFETY_QUESTION_NOT_AVAILABLE'));
    assert.deepEqual(await snapshot(target.f.who.userId, sidecarTables), before); assert.deepEqual(await oldBytes(target.f.who), old);
    const state = await grant.api.read(target.f.who, { publicationId: target.publicationId });
    assert.equal(state.receiptReceivedAt, null); assert.equal(state.deliveryUncertain, true);
    assert.equal((await target.api.read(target.f.who, { publicationId: target.publicationId })).handled, false);
  });
});

test('an already committed exact live question claim keeps its original grant after a genuine newer L2 source is declared', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), first = await claimedQuestion(target);
    const newId = await classified(target.f, runtime, 'Fictional high marker newer independent classification'); await original().prepareSubmission(newId);
    const publicationCommand = { operationId: randomUUID(), submissionId: newId, expectedEdition: 0 };
    const publication = await target.api.publish(target.f.who, publicationCommand); assert(publication);
    const next: Target = { ...target, submissionId: newId, publication, publicationId: publication.publicationId, publicationCommand };
    const second = await claimedQuestion(next); await second.api.present(target.f.who, questionPresentCommand(second));
    const before = await snapshot(target.f.who.userId, sidecarTables), retry = await first.api.claim(target.f.who, first.claimCommand);
    assert.equal(retry.status, 'display_granted'); assert.equal(retry.operation.replayed, true);
    assert.equal(retry.grantId, first.claim.grantId); assert.equal(retry.question, first.claim.question);
    assert.equal(retry.grantPresentationToken, first.claim.grantPresentationToken); assert.equal(retry.displayUntil, first.claim.displayUntil);
    assert.deepEqual(await snapshot(target.f.who.userId, sidecarTables), before);
    await assert.rejects(first.api.present(target.f.who, { ...questionPresentCommand(first), grantPresentationToken: capability() }),
      code('SAFETY_QUESTION_DELIVERY_UNCERTAIN'));
    assert.equal((await first.api.read(target.f.who, { publicationId: target.publicationId })).sourcePhase, 'claimed');
  });
});

test('fictional actual staff review and activation are immutable operations; labels and student accounts grant no approval', async () => {
  const a = authority;
  assert.deepEqual(await a.registry.recordReview(a.reviewer, a.reviewCommand), { assetId: a.assetId, replayed: true });
  assert.deepEqual(await a.registry.activate(a.operator, a.activationCommand), { assetId: a.assetId, replayed: true });
  const stored = (await fixture.db.query('SELECT * FROM platform_safety_delivery_assets WHERE id=$1', [a.assetId])).rows[0];
  assert(Buffer.isBuffer(stored.decision_ciphertext)); assert.equal(stored.reviewer_id, a.reviewer.userId);
  assert.equal((await fixture.db.query('SELECT * FROM platform_safety_delivery_review_operations WHERE asset_id=$1', [a.assetId])).rowCount, 2);
  const student = await fixture.actor(), studentReview = manifest(a.selected, student, a.orgId);
  const invalidRegistry = new SafetyDeliveryReviewRegistry(fixture.db, fixture.crypto, a.selected, studentReview);
  await assert.rejects(invalidRegistry.recordReview(student, { operationId: randomUUID() }), code('STAFF_ACCESS_REQUIRED'));
  await assert.rejects(a.registry.activate(student, { operationId: randomUUID(), assetId: a.assetId }), code('STAFF_ACCESS_REQUIRED'));
  const unassignedStaff = await fixture.actor(true, 'Fictional staff without safety reviewer role');
  const unassignedReview = manifest(a.selected, unassignedStaff, a.orgId);
  await assert.rejects(new SafetyDeliveryReviewRegistry(fixture.db, fixture.crypto, a.selected, unassignedReview)
    .recordReview(unassignedStaff, { operationId: randomUUID() }), code('STAFF_ACCESS_REQUIRED'));
  assert.equal((await fixture.db.query('SELECT * FROM platform_safety_delivery_assets WHERE review_digest=$1', [studentReview.reviewDigest])).rowCount, 0);
  assert.equal((await fixture.db.query('SELECT * FROM platform_safety_question_occurrences WHERE user_id=$1', [student.userId])).rowCount, 0);
});

test('real keyword L2 body declaration, acknowledgment and explicit continue create only authentic handled source evidence', async () => {
  await loopback(async (runtime, requests) => {
    const target = await published(runtime), old = await oldBytes(target.f.who), unchanged = await noAuthorityBytes(target.f.who);
    const initial = await target.api.read(target.f.who, { publicationId: target.publicationId });
    assert.equal(initial.mode, 'keyword_only'); assert.equal(initial.level, 'L2'); assert.equal(initial.presented, false);
    const present = await presented(target); assertBodyOnly(present.projection); assert.equal(present.result.state.handled, false);
    await assert.rejects(act(target, { kind: 'continue_naming', presentationReceipt: present.receipt }), code('SAFETY_DELIVERY_ACKNOWLEDGMENT_REQUIRED'));
    const ack = await act(target, { kind: 'acknowledge', presentationReceipt: present.receipt });
    const handled = await act(target, { kind: 'continue_naming', presentationReceipt: present.receipt });
    assert.equal(handled.result.state.handled, true); assert.equal(handled.result.state.clarifiedAt, null);
    const receipt = (await fixture.db.query('SELECT * FROM platform_companion_name_safety_handled WHERE submission_id=$1', [target.submissionId])).rows[0];
    assert.equal(receipt.operation_id, handled.command.operationId); assert.equal(receipt.publication_id, target.publicationId);
    const operation = (await fixture.db.query('SELECT * FROM platform_companion_name_safety_followups WHERE operation_id=$1 AND user_id=$2',
      [receipt.operation_id, target.f.who.userId])).rows[0];
    assert.equal(operation.presentation_operation_id, present.command.operationId); assert.equal(operation.acknowledgment_operation_id, ack.command.operationId);
    assert.equal(operation.presentation_kind, 'present_body'); assert.equal(operation.acknowledgment_kind, 'acknowledge');
    assert.equal((await fixture.db.query('SELECT * FROM platform_safety_question_operations WHERE user_id=$1', [target.f.who.userId])).rowCount, 0);
    assert.deepEqual(await oldBytes(target.f.who), old); assert.deepEqual(await noAuthorityBytes(target.f.who), unchanged);
    const source = (await fixture.db.query('SELECT * FROM platform_companion_name_submissions WHERE id=$1', [target.submissionId])).rows[0];
    assert.equal(source.level, 'L2'); assert.equal(source.detector_mode, 'keyword_only'); assert.equal(source.application_status, 'not_eligible');
    assert.equal(requests.length, 1);
  });
});

test('actual full L1 classifier usage survives explicit two-flag clarification without grade, identity or execution backfill', async () => {
  await loopback(async (runtime, requests) => {
    const target = await published(runtime, 'Synthetic name classified by the owned model', true);
    const old = await oldBytes(target.f.who), unchanged = await noAuthorityBytes(target.f.who), ack = await acknowledged(target);
    assert.equal(ack.result.state.mode, 'full'); assert.equal(ack.result.state.level, 'L1');
    for (const invalid of [
      { kind: 'clarify_exaggeration', presentationReceipt: ack.receipt, safe: false, exaggeration: true },
      { kind: 'clarify_exaggeration', presentationReceipt: ack.receipt, safe: true, exaggeration: false },
      { kind: 'clarify_exaggeration', presentationReceipt: ack.receipt, safe: true, exaggeration: true, handled: true },
    ]) await assert.rejects(target.api.act(target.f.who, { operationId: randomUUID(), publicationId: target.publicationId,
      expectedPublicationRevision: ack.ack.result.state.revision, action: invalid }), code('INVALID_INPUT'));
    const result = await act(target, { kind: 'clarify_exaggeration', presentationReceipt: ack.receipt, safe: true, exaggeration: true });
    assert.equal(result.result.state.handled, true); assert(result.result.state.clarifiedAt);
    assert.deepEqual(await oldBytes(target.f.who), old); assert.deepEqual(await noAuthorityBytes(target.f.who), unchanged);
    const source = (await fixture.db.query('SELECT level,detector_mode,application_status FROM platform_companion_name_submissions WHERE id=$1', [target.submissionId])).rows[0];
    assert.deepEqual(source, { level: 'L1', detector_mode: 'full', application_status: 'not_eligible' });
    assert.equal(requests.length, 2);
  }, 'L1');
});

test('lost body handle is absent on exact replay; a fresh actual projection safely provides a new presentation chain', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), first = await presented(target);
    await act(target, { kind: 'need_support' });
    const replay = await target.api.act(target.f.who, first.command);
    assert.equal(replay.operation.replayed, true); assert.equal(replay.operation.appliedRevision, first.result.operation.appliedRevision);
    assert.equal(Object.hasOwn(replay, 'presentationReceipt'), false); assert.equal(replay.state.revision, 2);
    await assert.rejects(target.api.act(target.f.who, { ...first.command, action: { kind: 'need_support' } }), code('SAFETY_DELIVERY_OPERATION_CONFLICT'));
    const second = await acknowledged(target); assert.notEqual(second.receipt, first.receipt);
    const beforeReplay = await snapshot(target.f.who.userId, sidecarTables);
    const ackReplay = await target.api.act(target.f.who, second.ack.command);
    assert.equal(ackReplay.operation.replayed, true); assert.equal(Object.hasOwn(ackReplay, 'presentationReceipt'), false);
    assert.deepEqual(await snapshot(target.f.who.userId, sidecarTables), beforeReplay);
    const handled = await act(target, { kind: 'continue_naming', presentationReceipt: second.receipt });
    const handledReplay = await target.api.act(target.f.who, handled.command); assert.equal(handledReplay.operation.replayed, true);
    await assert.rejects(act(target, { kind: 'continue_naming', presentationReceipt: second.receipt }), code('SAFETY_DELIVERY_STATE_CHANGED'));
  });
});

test('forged projection, foreign owner and transplanted session handles cannot acknowledge or handle a resource', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), before = await snapshot(target.f.who.userId, sidecarTables);
    await assert.rejects(act(target, { kind: 'present_body', bodyProjectionId: randomUUID() }), code('SAFETY_DELIVERY_PRESENTATION_REQUIRED'));
    await assert.rejects(act(target, { kind: 'acknowledge', presentationReceipt: capability() }), code('SAFETY_DELIVERY_PRESENTATION_REQUIRED'));
    assert.deepEqual(await snapshot(target.f.who.userId, sidecarTables), before);
    const foreign = await fixture.actor(), staff = await fixture.actor(true);
    await assert.rejects(target.api.read(foreign, { publicationId: target.publicationId }), code('NOT_FOUND'));
    await assert.rejects(target.api.read(staff, { publicationId: target.publicationId }), code('STUDENT_ACCOUNT_REQUIRED'));
    const acknowledgedFirst = await acknowledged(target), otherSession = await session(target.f.who, false);
    await assert.rejects(act(target, { kind: 'acknowledge', presentationReceipt: acknowledgedFirst.receipt }, otherSession), code('SAFETY_DELIVERY_PRESENTATION_REQUIRED'));
    await assert.rejects(act(target, { kind: 'continue_naming', presentationReceipt: acknowledgedFirst.receipt }, otherSession), code('SAFETY_DELIVERY_PRESENTATION_REQUIRED'));
    await assert.rejects(target.api.act(otherSession, acknowledgedFirst.command), code('SAFETY_DELIVERY_OPERATION_CONFLICT'));
    const ownNew = await acknowledged(target, otherSession);
    assert.equal((await act(target, { kind: 'continue_naming', presentationReceipt: ownNew.receipt }, otherSession)).result.state.handled, true);
  });
});

test('same-owner concurrent first publication and followup CAS serialize without granting invalid student review authority', async () => {
  await loopback(async runtime => {
    const target = await captured(runtime), request = { operationId: randomUUID(), submissionId: target.submissionId, expectedEdition: 0 };
    const invalid = new SafetyDeliveryReviewRegistry(fixture.db, fixture.crypto, authority.selected,
      manifest(authority.selected, target.f.who, authority.orgId));
    const results = await Promise.allSettled([target.api.publish(target.f.who, request), target.api.publish(target.f.who, request),
      invalid.recordReview(target.f.who, { operationId: randomUUID() }),
      authority.registry.activate(target.f.who, { operationId: randomUUID(), assetId: authority.assetId })]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'fulfilled');
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') assert.fail('Actual publication calls did not complete.');
    assert(results[0].value && results[1].value); assert.equal(results[0].value.publicationId, results[1].value.publicationId);
    assert.deepEqual([results[0].value.replayed, results[1].value.replayed].sort(), [false, true]);
    for (const result of results.slice(2)) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert(code('STAFF_ACCESS_REQUIRED')(result.reason)); }
    const publicationId = results[0].value.publicationId;
    const projections = await Promise.all([target.api.issueBodyProjection(target.f.who, { publicationId }), target.api.issueBodyProjection(target.f.who, { publicationId })]);
    const races = await Promise.allSettled(projections.map(p => target.api.act(target.f.who, { operationId: randomUUID(), publicationId,
      expectedPublicationRevision: p.revision, action: { kind: 'present_body', bodyProjectionId: p.bodyProjectionId } })));
    assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
    const failure = races.find(r => r.status === 'rejected'); assert(failure && failure.status === 'rejected');
    assert(code('SAFETY_DELIVERY_PUBLICATION_REVISION_CHANGED')(failure.reason));
    assert.equal((await fixture.db.query('SELECT * FROM platform_companion_name_safety_publications WHERE submission_id=$1', [target.submissionId])).rowCount, 1);
    assert.equal((await fixture.db.query('SELECT * FROM platform_companion_name_safety_handled WHERE submission_id=$1', [target.submissionId])).rowCount, 0);
  });
});

test('PostgreSQL rejects NULL required leaves and typed parents from a wrong kind, actual publication, session or body chain', async () => {
  await loopback(async runtime => {
    const target = await published(runtime), first = await acknowledged(target);
    const clarified = await act(target, { kind: 'clarify_exaggeration', presentationReceipt: first.receipt, safe: true, exaggeration: true });
    const secondSession = await session(target.f.who, false), otherSessionChain = await acknowledged(target, secondSession);
    const sameSessionOtherBody = await acknowledged(target);
    const otherId = await classified(target.f, runtime, 'Fictional low marker real typed-parent target');
    assert.equal((await target.f.safety.apply(target.f.who, { taskId: target.f.prepared.taskId, submissionId: otherId })).status, 'not_eligible');
    await original().prepareSubmission(otherId);
    const publicationCommand = { operationId: randomUUID(), submissionId: otherId, expectedEdition: 0 };
    const publication = await target.api.publish(target.f.who, publicationCommand); assert(publication);
    const other: Target = { ...target, submissionId: otherId, publication, publicationId: publication.publicationId, publicationCommand };
    const otherPublicationChain = await acknowledged(other);
    const continued = await act(other, { kind: 'continue_naming', presentationReceipt: otherPublicationChain.receipt });
    const before = await snapshot(target.f.who.userId, [...oldCaptureTables, ...sidecarTables]);
    const requiredNulls: readonly [string, string, string][] = [
      ['acknowledgment presentation kind', first.ack.command.operationId, 'presentation_kind'],
      ['acknowledgment presentation parent', first.ack.command.operationId, 'presentation_operation_id'],
      ['acknowledgment body digest', first.ack.command.operationId, 'body_digest'],
      ['presentation digest', first.command.operationId, 'presentation_digest'],
      ['presentation body projection', first.command.operationId, 'body_projection_id'],
      ['clarification presentation kind', clarified.command.operationId, 'presentation_kind'],
      ['clarification acknowledgment kind', clarified.command.operationId, 'acknowledgment_kind'],
      ['clarification acknowledgment parent', clarified.command.operationId, 'acknowledgment_operation_id'],
      ['clarification timestamp', clarified.command.operationId, 'clarified_at'],
      ['continuation presentation kind', continued.command.operationId, 'presentation_kind'],
      ['continuation acknowledgment kind', continued.command.operationId, 'acknowledgment_kind'],
    ];
    const parentChanges: readonly [string, string, string, string][] = [
      ['ack points to real acknowledgment kind', first.ack.command.operationId, 'presentation_operation_id', first.ack.command.operationId],
      ['handled presentation points to real acknowledgment kind', clarified.command.operationId, 'presentation_operation_id', first.ack.command.operationId],
      ['handled acknowledgment points to real presentation kind', clarified.command.operationId, 'acknowledgment_operation_id', first.command.operationId],
      ['handled acknowledgment points to real clarify kind', clarified.command.operationId, 'acknowledgment_operation_id', clarified.command.operationId],
      ['ack points to real other publication presentation', first.ack.command.operationId, 'presentation_operation_id', otherPublicationChain.command.operationId],
      ['handled acknowledgment points to real other publication', clarified.command.operationId, 'acknowledgment_operation_id', otherPublicationChain.ack.command.operationId],
      ['handled presentation points to real other session', clarified.command.operationId, 'presentation_operation_id', otherSessionChain.command.operationId],
      ['handled acknowledgment points to real other session', clarified.command.operationId, 'acknowledgment_operation_id', otherSessionChain.ack.command.operationId],
      ['ack points to real same session other body chain', first.ack.command.operationId, 'presentation_operation_id', sameSessionOtherBody.command.operationId],
      ['handled acknowledgment points to real same session other body chain', clarified.command.operationId, 'acknowledgment_operation_id', sameSessionOtherBody.ack.command.operationId],
      ['ack projection belongs to real other publication', first.ack.command.operationId, 'body_projection_id', otherPublicationChain.projection.bodyProjectionId],
      ['handled projection belongs to real other session', clarified.command.operationId, 'body_projection_id', otherSessionChain.projection.bodyProjectionId],
    ];
    for (const [label, operationId, column] of requiredNulls) {
      const unexpectedAcceptance = new Error('Required CHECK unexpectedly accepted: ' + label);
      await assert.rejects(fixture.db.transaction(async client => {
        const changed = await client.query(`UPDATE platform_companion_name_safety_followups SET ${column}=NULL
          WHERE user_id=$1 AND operation_id=$2 RETURNING operation_id`, [target.f.who.userId, operationId]);
        assert.equal(changed.rowCount, 1);
        // Immediate CHECK normally rejects UPDATE. This also flushes all
        // deferrable FKs before the sentinel, so rejection cannot be faked by
        // throwing before their validation. An unexpected success rolls back.
        await client.query('SET CONSTRAINTS ALL IMMEDIATE'); throw unexpectedAcceptance;
      }), error => (error as { code?: string }).code === '23514', label);
      assert.deepEqual(await snapshot(target.f.who.userId, [...oldCaptureTables, ...sidecarTables]), before, label);
    }
    for (const [label, operationId, column, parentId] of parentChanges) {
      const unexpectedAcceptance = new Error('Typed parent FK unexpectedly accepted: ' + label);
      await assert.rejects(fixture.db.transaction(async client => {
        const changed = await client.query(`UPDATE platform_companion_name_safety_followups SET ${column}=$3
          WHERE user_id=$1 AND operation_id=$2 RETURNING operation_id`, [target.f.who.userId, operationId, parentId]);
        assert.equal(changed.rowCount, 1);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE'); throw unexpectedAcceptance;
      }), error => (error as { code?: string }).code === '23503', label);
      assert.deepEqual(await snapshot(target.f.who.userId, [...oldCaptureTables, ...sidecarTables]), before, label);
    }
    assert.equal((await target.api.read(target.f.who, { publicationId: target.publicationId })).handled, true);
    assert.equal((await other.api.read(other.f.who, { publicationId: other.publicationId })).handled, true);
  });
});
