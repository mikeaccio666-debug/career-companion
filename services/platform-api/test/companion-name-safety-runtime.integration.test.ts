import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import { companionSealCandidates } from '@companion/career-core';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { CompanionNameSafetyRunner } from '../src/companion-name-safety-runner.ts';
import { CompanionNameSafety } from '../src/companion-name-safety.ts';
import { CompanionIdentityDrafts } from '../src/companion-identity-drafts.ts';
import { expectedCompanionIdentityBundleDigest, parseCompanionIdentityBundle } from '../src/companion-identity-bundle.ts';
import { OnboardingSafetyRunner } from '../src/onboarding-safety-runner.ts';
import { expectedSafetyProfileDigests, parseSafetyDetectorProfile } from '../src/safety-detector-profile.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal } from './fixtures/student-entry.ts';

// Actual completed preview, real PostgreSQL name inbox and strict ai-core HTTP
// protocol. Every HTTP request is redirected to an owned ephemeral loopback
// server. Policies, examples and reported token counts are explicitly fictional.
let fixture: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
const profileContent = { schemaVersion: 1, revision: 83,
  instructions: 'Fictional naming QA policy only. Classify synthetic examples.',
  algorithm: 'literal_substring_v1', lexicon: [
    { id: 'en-low', language: 'en', level: 'L1', phrases: ['Synthetic low marker'] },
    { id: 'zh-low', language: 'zh', level: 'L1', phrases: ['虚构低风险标记'] },
    { id: 'en-high', language: 'en', level: 'L2', phrases: ['Synthetic high marker'] },
    { id: 'zh-high', language: 'zh', level: 'L2', phrases: ['虚构高风险标记'] },
  ], mergeRule: 'highest_level', fallbackNoHit: 'unavailable',
  review: { reference: 'fictional-name-review-not-clinical-approval', approvedAt: '2026-10-07T00:00:00.000Z' } };
const profile = parseSafetyDetectorProfile({ ...profileContent, ...expectedSafetyProfileDigests(profileContent) });
const routeConfig = { modelRoutes: { safety_classify: { provider: 'openai' } }, safetyDailyModelCallLimit: 10 };
const providerEnv = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-loopback-only',
  OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model', OPENAI_SAFETY_CLASSIFY_MODEL: 'fictional-name-safety' };
const unavailable = (error: unknown) => error instanceof ApiError && error.code === 'COMPANION_NAME_SAFETY_UNAVAILABLE';
const validPreview = { summary: '说话简短，先把下一步理清楚。',
  samples: ['可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。'] };
type Ready = Awaited<ReturnType<typeof fixture.ready>>;
before(async () => { fixture = await createCompanionNameSafetyFixture(); await activate((await fixture.actor(true)).userId); });
after(async () => { if (fixture) await fixture.close(); });
async function activate(userId: string) {
  await fixture.db.query(`INSERT INTO platform_safety_detector_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
    VALUES(true,$1,$2,$3,clock_timestamp(),$4) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,
    content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by`,
  [profile.revision, profile.digest, profile.reviewDigest, userId]);
}
function respond(reply: http.ServerResponse, decision: unknown, overrides: Record<string, unknown> = {}) {
  const event = { type: 'response.completed', response: { status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(decision) }] }],
    usage: { input_tokens: 34, output_tokens: 21 }, ...overrides } };
  reply.writeHead(200, { 'content-type': 'text/event-stream' }); reply.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
}
async function loopback(handler: (body: Record<string, any>, reply: http.ServerResponse) => Promise<void> | void,
  run: (previewRuntime: PlatformProviderRuntime, safetyRuntime: PlatformProviderRuntime, bodies: Record<string, any>[]) => Promise<void>,
  env: NodeJS.ProcessEnv = providerEnv) {
  const bodies: Record<string, any>[] = []; let failure: unknown;
  const server = http.createServer(async (request, reply) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.store, false); assert.equal(body.tool_choice, 'none'); assert.deepEqual(body.tools, []);
      if (body.model === providerEnv.OPENAI_COMPANION_GENERATION_MODEL) respond(reply, validPreview);
      else { assert.equal(body.model, providerEnv.OPENAI_SAFETY_CLASSIFY_MODEL); bodies.push(body); await handler(body, reply); }
    } catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const make = (runtimeEnv: NodeJS.ProcessEnv) => createProviderRuntime({ env: runtimeEnv, fetch: (target, init) => {
    const remote = new URL(String(target)); assert.equal(remote.origin, 'https://api.openai.com'); assert.equal(remote.pathname, '/v1/responses');
    return fetch(`http://127.0.0.1:${address.port}${remote.pathname}`, init);
  } });
  try { await run(make(providerEnv), make(env), bodies); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function runner(f: Ready, runtime: PlatformProviderRuntime, limit = 10, detector: typeof profile | null = profile) {
  return new CompanionNameSafetyRunner(f.safety, { ...routeConfig, safetyDailyModelCallLimit: limit }, runtime, detector);
}
async function submit(f: Ready, name = 'Juno', expectedEntryRevision = 0, expectedIdentityRevision = 0) {
  return f.safety.submit(f.who, { taskId: f.prepared.taskId, expectedEntryRevision, expectedIdentityRevision, operationId: randomUUID(), name });
}
async function source(f: Ready) {
  return (await fixture.db.query('SELECT * FROM platform_companion_name_submissions WHERE user_id=$1 ORDER BY submitted_revision DESC', [f.who.userId])).rows[0];
}
async function usage(f: Ready) {
  return (await fixture.db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1 ORDER BY created_at,call_id', [f.who.userId])).rows;
}
async function frozenIntake(f: Ready) {
  const drafts = await fixture.db.query('SELECT * FROM platform_onboarding_drafts WHERE user_id=$1 ORDER BY id', [f.who.userId]);
  const operations = await fixture.db.query('SELECT * FROM platform_onboarding_operations WHERE user_id=$1 ORDER BY operation_id', [f.who.userId]);
  return { drafts: drafts.rows, operations: operations.rows };
}
async function identityEffects(f: Ready) {
  return (await fixture.db.query(`SELECT
    (SELECT count(*)::int FROM platform_companion_identity_drafts WHERE user_id=$1) AS identity,
    (SELECT count(*)::int FROM platform_companion_identity_operations WHERE user_id=$1) AS operations,
    (SELECT count(*)::int FROM platform_companion_name_identity_receipts WHERE user_id=$1) AS receipts,
    (SELECT count(*)::int FROM platform_companion_name_identity_provenance WHERE user_id=$1) AS provenance`, [f.who.userId])).rows[0];
}
function assertClassificationRetained(before: Record<string, any>, after: Record<string, any>) {
  for (const field of ['id', 'operation_id', 'entry_id', 'task_id', 'companion_id', 'submitted_revision', 'expected_identity_revision',
    'submitted_auth_version', 'application_operation_id', 'request_ciphertext', 'status', 'generation', 'auth_version', 'lease_token',
    'lease_until', 'execution_token', 'detector_revision', 'claim_ciphertext', 'result_ciphertext', 'level', 'detector_mode', 'failure'])
    assert.deepEqual(after[field], before[field], `Applying a name must preserve its committed classification field: ${field}`);
}
async function noEffects(f: Ready) {
  const found = (await fixture.db.query(`SELECT
    (SELECT count(*)::int FROM platform_companion_identity_drafts WHERE user_id=$1) AS identity,
    (SELECT count(*)::int FROM platform_companion_identity_selections WHERE user_id=$1) AS selections,
    (SELECT count(*)::int FROM platform_conversations WHERE user_id=$1) AS rooms,
    (SELECT count(*)::int FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id WHERE c.user_id=$1) AS messages,
    (SELECT count(*)::int FROM platform_memories WHERE user_id=$1) AS memories,
    (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs`, [f.who.userId])).rows[0];
  assert.deepEqual(found, { identity: 0, selections: 0, rooms: 0, messages: 0, memories: 0, jobs: 0 });
  assert.deepEqual(await identityEffects(f), { identity: 0, operations: 0, receipts: 0, provenance: 0 });
}
async function assertPending(f: Ready) {
  const row = await source(f); assert.equal(row.status, 'pending'); assert.equal(row.level, null);
  assert.equal(row.result_ciphertext, null); assert.equal(row.application_status, 'pending'); await noEffects(f);
}

test('a real strict completed call saves full L0 for its exact encrypted name source without mutating intake or creating identity', async () => {
  await loopback((body, reply) => {
    assert.equal(body.max_output_tokens, 40); assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema, { type: 'object', properties: { level: { type: 'string', enum: ['L0', 'L1', 'L2'] } }, required: ['level'], additionalProperties: false });
    respond(reply, { level: 'L0' });
  }, async (preview, runtime, bodies) => {
    const f = await fixture.ready(preview), intake = await frozenIntake(f); await submit(f);
    await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId });
    const row = await source(f); assert.equal(row.status, 'detected'); assert.equal(row.level, 'L0'); assert.equal(row.detector_mode, 'full');
    assert(row.request_ciphertext instanceof Buffer); assert(row.result_ciphertext instanceof Buffer);
    assert.equal(row.request_ciphertext.includes(Buffer.from('Juno')), false); assert.equal(row.result_ciphertext.includes(Buffer.from('"level":"L0"')), false);
    const calls = await usage(f); assert.equal(calls.length, 1); const call = calls[0];
    assert.equal(call.source_kind, 'companion_name'); assert.equal(call.submission_id, row.id); assert.equal(call.operation_id, row.operation_id);
    assert.equal(call.entry_id, row.entry_id); assert.equal(call.task_id, f.prepared.taskId); assert.equal(call.companion_id, f.prepared.companionId);
    assert.equal(call.submitted_revision, row.submitted_revision); assert.equal(call.expected_identity_revision, 0); assert.equal(call.preview_revision, 1);
    assert.equal(call.draft_id, null); assert.equal(call.question_id, null); assert.equal(call.generation, row.generation);
    assert.equal(call.name_execution_token, row.execution_token);
    assert.equal(call.status, 'complete'); assert.equal(call.usage_status, 'reported'); assert.equal(call.input_tokens, 34); assert.equal(call.output_tokens, 21);
    assert(call.admitted_at); assert(call.finished_at); assert.equal(JSON.stringify(call).includes('Juno'), false);
    for (const field of ['text', 'prompt', 'content', 'api_key', 'lease_token', 'request_ciphertext', 'execution_token']) assert.equal(Object.hasOwn(call, field), false);
    assert.equal(JSON.stringify(bodies[0]).includes(f.who.userId), false); assert.equal(JSON.stringify(bodies[0]).includes(row.id), false);
    assert.deepEqual(await frozenIntake(f), intake); await noEffects(f);
    assert.equal(await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId }), null); assert.equal(bodies.length, 1);
  });
});

test('a missing reviewed profile never claims saved naming text or sends HTTP', async () => {
  await loopback(() => assert.fail('No classifier request is authorized.'), async (preview, runtime, bodies) => {
    const f = await fixture.ready(preview); await submit(f);
    await assert.rejects(runner(f, runtime, 10, null).runNext(f.who, { taskId: f.prepared.taskId }), unavailable);
    assert.equal((await source(f)).generation, 0); assert.equal(bodies.length, 0); await assertPending(f);
  });
});

test('an actual full-L0 application and its historical measured-usage proof remain identical across PostgreSQL time zones', async () => {
  await loopback((_body, reply) => respond(reply, { level: 'L0' }), async (preview, runtime) => {
    const f = await fixture.ready(preview); await submit(f); await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId });
    const id = (await source(f)).id, request = { taskId: f.prepared.taskId, submissionId: id };
    await f.safety.apply(f.who, request);
    const before = { entry: await f.safety.read(f.who, { taskId: f.prepared.taskId }), identity: await f.names.read(f.who, { taskId: f.prepared.taskId }),
      replay: await f.safety.apply(f.who, request), row: await source(f), calls: await usage(f) };
    assert.equal(before.row.application_status, 'applied'); assert.equal(before.identity?.name, 'Juno');
    const original = fixture.db.withBoundedTransaction;
    try {
      for (const zone of ['Pacific/Honolulu', 'UTC']) {
        fixture.db.withBoundedTransaction = function<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}) {
          return original.call(fixture.db, async client => { await client.query(`SET LOCAL TIME ZONE '${zone}'`); return run(client); }, options) as Promise<T>;
        };
        assert.deepEqual(await f.safety.read(f.who, { taskId: f.prepared.taskId }), before.entry);
        assert.deepEqual(await f.names.read(f.who, { taskId: f.prepared.taskId }), before.identity);
        assert.deepEqual(await f.safety.apply(f.who, request), before.replay);
        assert.deepEqual(await source(f), before.row); assert.deepEqual(await usage(f), before.calls);
      }
    } finally { fixture.db.withBoundedTransaction = original; }
  });
});

test('mirrored valid historical application and provenance snapshots cannot substitute for the independent actual saved-identity receipt', async () => {
  await loopback((_body, reply) => respond(reply, { level: 'L0' }), async (preview, runtime, bodies) => {
    let f = await fixture.ready(preview); await submit(f); await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId });
    const first = await source(f), oldRequest = { taskId: f.prepared.taskId, submissionId: first.id };
    assert.equal((await f.safety.apply(f.who, oldRequest)).appliedIdentityRevision, 1);
    const original = await source(f), appBinding = { table: 'platform_companion_name_submissions', column: 'application_ciphertext',
      rowId: original.id, ownerId: f.who.userId, revision: original.generation };
    const text = fixture.crypto.openUtf8(original.application_ciphertext, appBinding), originalApplication = JSON.parse(text);
    const { contentDigest: _digest, ...content } = f.authority.asset;
    const alternateContent = { ...content, revision: 8, policy: { ...content.policy, englishSealAliases: [{ name: 'Juno', sealChar: '墨' }] } };
    const alternateAsset = parseCompanionIdentityBundle({ ...alternateContent, contentDigest: expectedCompanionIdentityBundleDigest(alternateContent) });
    const alternate = await fixture.identityAuthority(alternateAsset);
    const identities = new CompanionIdentityDrafts(fixture.db, fixture.config, FICTIONAL_LEGAL, f.background, alternate.asset, alternate.review);
    f = { ...f, names: identities, safety: new CompanionNameSafety(fixture.db, fixture.config, FICTIONAL_LEGAL, f.background, identities), authority: alternate };
    await submit(f, '墨', 1, 1); await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId });
    assert.equal((await f.safety.apply(f.who, { taskId: f.prepared.taskId, submissionId: (await source(f)).id })).appliedIdentityRevision, 2);
    const before = await f.safety.read(f.who, { taskId: f.prepared.taskId }), oldReplay = await f.safety.apply(f.who, oldRequest);
    assert.equal((await f.names.read(f.who, { taskId: f.prepared.taskId }))?.name, '墨');
    const provenance = (await fixture.db.query('SELECT * FROM platform_companion_name_identity_provenance WHERE submission_id=$1', [first.id])).rows[0];
    const actualReceipt = (await fixture.db.query('SELECT * FROM platform_companion_name_identity_receipts WHERE submission_id=$1', [first.id])).rows[0];
    const provenanceBinding = { table: 'platform_companion_name_identity_provenance', column: 'payload_ciphertext', rowId: provenance.draft_id,
      ownerId: f.who.userId, revision: provenance.identity_revision };
    assert.equal(fixture.crypto.openUtf8(provenance.payload_ciphertext, provenanceBinding), text);
    const verified = await fixture.db.withBoundedTransaction(client => f.background.readInTransaction(client, f.who, { taskId: f.prepared.taskId })); assert(verified);
    for (const variant of ['same_name_alternate_reviewed_assets', 'different_name'] as const) {
      const forged = structuredClone(originalApplication), capture = forged.identityCapture;
      capture.bundleRevision = alternate.asset.revision; capture.contentDigest = alternate.asset.contentDigest; capture.reviewDigest = alternate.review.reviewDigest;
      if (variant === 'different_name') capture.name = '舟';
      capture.sealCandidates = companionSealCandidates({ companionId: f.prepared.companionId, name: capture.name, dimensions: verified.dimensions, policy: alternate.asset.policy });
      assert.notDeepEqual(capture.sealCandidates, originalApplication.identityCapture.sealCandidates);
      if (variant === 'same_name_alternate_reviewed_assets') {
        // This alternate snapshot is structurally valid, uses actually captured
        // reviewed assets, and still matches the original request's exact name.
        // Those checks alone cannot prove it was the snapshot actually saved.
        const accepted = await fixture.db.withBoundedTransaction(client => f.names.validateCapturedInTransaction(client, f.who,
          { taskId: f.prepared.taskId, operationId: first.application_operation_id, payload: JSON.stringify(capture) }));
        assert.equal(accepted.name, 'Juno'); assert.equal(accepted.revision, 1); assert.equal(accepted.sealCandidates[0].char, '墨');
      }
      const forgedText = JSON.stringify(forged);
      try {
        await fixture.db.transaction(async client => {
          await client.query('UPDATE platform_companion_name_submissions SET application_ciphertext=$2 WHERE id=$1', [first.id, fixture.crypto.sealUtf8(forgedText, appBinding)]);
          await client.query('UPDATE platform_companion_name_identity_provenance SET payload_ciphertext=$2 WHERE submission_id=$1', [first.id, fixture.crypto.sealUtf8(forgedText, provenanceBinding)]);
        });
        await assert.rejects(f.safety.read(f.who, { taskId: f.prepared.taskId }), unavailable);
        await assert.rejects(f.safety.apply(f.who, oldRequest), unavailable);
        assert.equal((await f.names.read(f.who, { taskId: f.prepared.taskId }))?.name, '墨');
        assert.deepEqual((await fixture.db.query('SELECT * FROM platform_companion_name_identity_receipts WHERE submission_id=$1', [first.id])).rows[0], actualReceipt);
      } finally {
        await fixture.db.transaction(async client => {
          await client.query('UPDATE platform_companion_name_submissions SET application_ciphertext=$2 WHERE id=$1', [first.id, original.application_ciphertext]);
          await client.query('UPDATE platform_companion_name_identity_provenance SET payload_ciphertext=$2 WHERE submission_id=$1', [first.id, provenance.payload_ciphertext]);
        });
      }
      assert.deepEqual(await f.safety.read(f.who, { taskId: f.prepared.taskId }), before); assert.deepEqual(await f.safety.apply(f.who, oldRequest), oldReplay);
    }
    try {
      await fixture.db.query('UPDATE platform_companion_name_identity_receipts SET payload_ciphertext=set_byte(payload_ciphertext,30,get_byte(payload_ciphertext,30)#1) WHERE submission_id=$1', [first.id]);
      await assert.rejects(f.safety.read(f.who, { taskId: f.prepared.taskId }), unavailable);
      await assert.rejects(f.safety.apply(f.who, oldRequest), unavailable);
    } finally {
      await fixture.db.query('UPDATE platform_companion_name_identity_receipts SET payload_ciphertext=$2 WHERE submission_id=$1', [first.id, actualReceipt.payload_ciphertext]);
    }
    assert.deepEqual(await f.safety.read(f.who, { taskId: f.prepared.taskId }), before); assert.deepEqual(await f.safety.apply(f.who, oldRequest), oldReplay);
    await submit(f, '舟', 2, 2); await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId });
    assert.equal((await f.safety.apply(f.who, { taskId: f.prepared.taskId, submissionId: (await source(f)).id })).appliedIdentityRevision, 3);
    assert.equal((await f.names.read(f.who, { taskId: f.prepared.taskId }))?.name, '舟');
    assert.deepEqual(await f.safety.apply(f.who, oldRequest), oldReplay); assert.equal(bodies.length, 3); assert.equal((await usage(f)).length, 3);
  });
});

test('a genuine full-L0 semantic rejection is durable without clearing classification, writing identity or requesting the model again', async () => {
  for (const [raw, category] of [['伙伴甲', 'family_or_partner'], ['一二三四五六七', 'length'], ['Juno', 'same_as_user']] as const) {
    await loopback((_body, reply) => respond(reply, { level: 'L0' }), async (preview, runtime, bodies) => {
      const f = await fixture.ready(preview), intake = await frozenIntake(f); await submit(f, raw);
      const execute = runner(f, runtime); await execute.runNext(f.who, { taskId: f.prepared.taskId });
      const classified = await source(f), calls = await usage(f), request = { taskId: f.prepared.taskId, submissionId: classified.id };
      assert.equal(classified.status, 'detected'); assert.equal(classified.level, 'L0'); assert.equal(classified.detector_mode, 'full');
      assert.equal(calls.length, 1); assert.equal(calls[0].status, 'complete'); assert.equal(calls[0].usage_status, 'reported');
      if (category === 'same_as_user') await fixture.db.query('UPDATE platform_users SET name=$2 WHERE id=$1', [f.who.userId, raw]);
      const applied = await f.safety.apply(f.who, request);
      assert.deepEqual(applied, { submissionId: classified.id, status: 'name_rejected', rejectedCategory: category, appliedIdentityRevision: null, replayed: false });
      const rejected = await source(f); assertClassificationRetained(classified, rejected);
      assert.equal(rejected.application_status, 'name_rejected'); assert.equal(rejected.rejected_category, category);
      assert(rejected.application_ciphertext instanceof Buffer); assert.equal(rejected.applied_identity_revision, null);
      const reloaded = await f.safety.read(f.who, { taskId: f.prepared.taskId });
      assert.equal(reloaded?.submissions[0].application, 'name_rejected'); assert.equal(reloaded?.submissions[0].rejectedCategory, category);
      assert.deepEqual(await f.safety.apply(f.who, request), { ...applied, replayed: true });
      assert.deepEqual(await source(f), rejected); assert.deepEqual(await usage(f), calls); await noEffects(f);
      assert.deepEqual(await frozenIntake(f), intake); assert.equal(await execute.runNext(f.who, { taskId: f.prepared.taskId }), null); assert.equal(bodies.length, 1);
    });
  }
});

test('a real stale identity CAS records superseded intent and its replay cannot overwrite a subsequent safely classified name', async () => {
  await loopback((_body, reply) => respond(reply, { level: 'L0' }), async (preview, runtime, bodies) => {
    const f = await fixture.ready(preview), intake = await frozenIntake(f); await submit(f); const execute = runner(f, runtime);
    await execute.runNext(f.who, { taskId: f.prepared.taskId });
    await f.safety.apply(f.who, { taskId: f.prepared.taskId, submissionId: (await source(f)).id });
    const originalIdentity = await f.names.read(f.who, { taskId: f.prepared.taskId }), effects = await identityEffects(f);
    assert.equal(originalIdentity?.revision, 1); assert.equal(originalIdentity?.name, 'Juno');
    assert.deepEqual(effects, { identity: 1, operations: 1, receipts: 1, provenance: 1 });
    await submit(f, '舟', 1, 0); await execute.runNext(f.who, { taskId: f.prepared.taskId });
    const stale = await source(f), calls = await usage(f), staleRequest = { taskId: f.prepared.taskId, submissionId: stale.id };
    assert.equal(stale.level, 'L0'); assert.equal(stale.detector_mode, 'full'); assert.equal(stale.expected_identity_revision, 0);
    const superseded = await f.safety.apply(f.who, staleRequest);
    assert.deepEqual(superseded, { submissionId: stale.id, status: 'superseded', rejectedCategory: null, appliedIdentityRevision: null, replayed: false });
    const saved = await source(f); assertClassificationRetained(stale, saved); assert.equal(saved.application_status, 'superseded');
    assert.deepEqual(await identityEffects(f), effects); assert.deepEqual(await f.names.read(f.who, { taskId: f.prepared.taskId }), originalIdentity);
    assert.deepEqual(await f.safety.apply(f.who, staleRequest), { ...superseded, replayed: true });
    assert.deepEqual(await source(f), saved); assert.deepEqual(await usage(f), calls); assert.equal(await execute.runNext(f.who, { taskId: f.prepared.taskId }), null); assert.equal(bodies.length, 2);
    await submit(f, '墨', 2, 1); await execute.runNext(f.who, { taskId: f.prepared.taskId });
    assert.equal((await f.safety.apply(f.who, { taskId: f.prepared.taskId, submissionId: (await source(f)).id })).appliedIdentityRevision, 2);
    const current = await f.names.read(f.who, { taskId: f.prepared.taskId }); assert.equal(current?.name, '墨'); assert.equal(current?.revision, 2);
    assert.deepEqual(await f.safety.apply(f.who, staleRequest), { ...superseded, replayed: true });
    assert.deepEqual(await f.names.read(f.who, { taskId: f.prepared.taskId }), current);
    assert.deepEqual(await identityEffects(f), { identity: 1, operations: 2, receipts: 2, provenance: 2 });
    assert.deepEqual(await frozenIntake(f), intake); assert.equal(bodies.length, 3); assert.equal((await usage(f)).length, 3);
  });
});

test('an older active pending source and its later genuine L1 or L2 classification both block application of a newer full-L0 name', async () => {
  for (const level of ['L1', 'L2'] as const) {
    await loopback((_body, reply) => respond(reply, { level: 'L0' }), async (preview, runtime, bodies) => {
      const f = await fixture.ready(preview), intake = await frozenIntake(f); await submit(f, level === 'L1' ? 'Synthetic low marker' : 'Synthetic high marker');
      const old = await source(f), claim = await f.safety.claim(f.who, { taskId: f.prepared.taskId, detectorRevision: profile.revision, leaseMs: 60000 }); assert(claim);
      await submit(f, 'Juno', 1); const execute = runner(f, runtime); await execute.runNext(f.who, { taskId: f.prepared.taskId });
      const latest = await source(f), latestRequest = { taskId: f.prepared.taskId, submissionId: latest.id };
      assert.equal(latest.level, 'L0'); assert.equal(latest.detector_mode, 'full'); assert.equal(latest.generation, 1);
      const pending = await f.safety.read(f.who, { taskId: f.prepared.taskId }); assert.equal(pending?.status, 'pending'); assert.equal(pending?.pendingCount, 1);
      assert.equal(pending?.submissions[0].status, 'running'); assert.equal(pending?.submissions[0].level, null);
      const blocked = (error: unknown) => error instanceof ApiError && error.code === 'COMPANION_NAME_SAFETY_REVIEW_REQUIRED';
      await assert.rejects(f.safety.apply(f.who, latestRequest), blocked); assert.deepEqual(await source(f), latest); await noEffects(f);
      await f.safety.fail(claim, 'unavailable'); await execute.runNext(f.who, { taskId: f.prepared.taskId });
      const risk = (await fixture.db.query('SELECT * FROM platform_companion_name_submissions WHERE id=$1', [old.id])).rows[0];
      assert.equal(risk.status, 'detected'); assert.equal(risk.level, level); assert.equal(risk.generation, 2);
      assert.equal(risk.detector_mode, level === 'L1' ? 'full' : 'keyword_only'); assert(risk.result_ciphertext instanceof Buffer);
      const ineligible = await f.safety.apply(f.who, { taskId: f.prepared.taskId, submissionId: old.id }); assert.equal(ineligible.status, 'not_eligible');
      assertClassificationRetained(risk, (await fixture.db.query('SELECT * FROM platform_companion_name_submissions WHERE id=$1', [old.id])).rows[0]);
      await assert.rejects(f.safety.apply(f.who, latestRequest), blocked); assert.deepEqual(await source(f), latest);
      const reloaded = await f.safety.read(f.who, { taskId: f.prepared.taskId }); assert.equal(reloaded?.status, 'blocked'); assert.equal(reloaded?.blockedCount, 1);
      assert.equal(reloaded?.submissions[0].level, level); assert.equal(reloaded?.submissions[1].level, 'L0'); assert.equal(reloaded?.submissions[1].application, 'pending');
      await noEffects(f); assert.deepEqual(await frozenIntake(f), intake); assert.equal(await execute.runNext(f.who, { taskId: f.prepared.taskId }), null);
      assert.equal(bodies.length, level === 'L1' ? 2 : 1); assert.equal((await usage(f)).length, bodies.length);
    });
  }
});

test('a real deferred PostgreSQL application COMMIT failure preserves classified L0 and permits only application retry', async () => {
  await loopback((_body, reply) => respond(reply, { level: 'L0' }), async (preview, runtime, bodies) => {
    const f = await fixture.ready(preview), intake = await frozenIntake(f); await submit(f); const execute = runner(f, runtime);
    await execute.runNext(f.who, { taskId: f.prepared.taskId });
    const classified = await source(f), calls = await usage(f), request = { taskId: f.prepared.taskId, submissionId: classified.id };
    assert.equal(classified.status, 'detected'); assert.equal(classified.level, 'L0'); assert.equal(classified.detector_mode, 'full');
    let functionCreated = false;
    try {
      await fixture.db.query(`CREATE FUNCTION fictional_name_apply_commit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.user_id='${f.who.userId}'::uuid THEN
          IF (SELECT count(*) FROM platform_companion_identity_drafts WHERE user_id=NEW.user_id)<>1
            OR (SELECT count(*) FROM platform_companion_identity_operations WHERE user_id=NEW.user_id)<>1
            OR (SELECT count(*) FROM platform_companion_name_identity_receipts WHERE user_id=NEW.user_id)<>1
            OR (SELECT count(*) FROM platform_companion_name_identity_provenance WHERE user_id=NEW.user_id)<>1
            OR NOT EXISTS(SELECT 1 FROM platform_companion_name_submissions WHERE id=NEW.submission_id AND application_status='applied')
          THEN RAISE EXCEPTION 'Fictional deferred fixture did not stage the complete application'; END IF;
          RAISE EXCEPTION 'Fictional deferred application commit failure' USING ERRCODE='23514';
        END IF; RETURN NEW; END $$`); functionCreated = true;
      await fixture.db.query(`CREATE CONSTRAINT TRIGGER fictional_name_apply_commit_fail AFTER INSERT ON platform_companion_name_identity_provenance
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_name_apply_commit_fail()`);
      await assert.rejects(f.safety.apply(f.who, request), error => !!error && typeof error === 'object' && 'code' in error && error.code === '23514'
        && 'message' in error && error.message === 'Fictional deferred application commit failure');
      assert.deepEqual(await source(f), classified); assert.deepEqual(await usage(f), calls); await noEffects(f);
      assert.equal((await f.safety.read(f.who, { taskId: f.prepared.taskId }))?.submissions[0].application, 'pending');
      assert.equal(await execute.runNext(f.who, { taskId: f.prepared.taskId }), null); assert.equal(bodies.length, 1);
    } finally { if (functionCreated) await fixture.db.query('DROP FUNCTION fictional_name_apply_commit_fail() CASCADE'); }
    const applied = await f.safety.apply(f.who, request); assert.equal(applied.status, 'applied'); assert.equal(applied.appliedIdentityRevision, 1);
    assertClassificationRetained(classified, await source(f)); assert.deepEqual(await usage(f), calls);
    assert.deepEqual(await identityEffects(f), { identity: 1, operations: 1, receipts: 1, provenance: 1 });
    assert.equal((await f.names.read(f.who, { taskId: f.prepared.taskId }))?.name, 'Juno');
    assert.deepEqual(await f.safety.apply(f.who, request), { ...applied, replayed: true });
    assert.deepEqual(await frozenIntake(f), intake); assert.equal(await execute.runNext(f.who, { taskId: f.prepared.taskId }), null); assert.equal(bodies.length, 1);
  });
});

test('disabled calls, absent provider credentials and zero quota leave unmatched input pending rather than inventing a grade', async () => {
  for (const [env, limit] of [[{ ...providerEnv, PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, 10],
    [{ ...providerEnv, OPENAI_API_KEY: '' }, 10], [providerEnv, 0]] as const) {
    await loopback(() => assert.fail('No HTTP may be admitted.'), async (preview, runtime, bodies) => {
      const f = await fixture.ready(preview); await submit(f); const intake = await frozenIntake(f);
      await assert.rejects(runner(f, runtime, limit).runNext(f.who, { taskId: f.prepared.taskId }), unavailable);
      await assertPending(f); assert.equal(bodies.length, 0); assert.equal((await usage(f)).length, 0); assert.deepEqual(await frozenIntake(f), intake);
    }, env);
  }
});

test('a reviewed high-risk keyword grades even a semantically invalid multiline name without a provider or any model quota', async () => {
  for (const env of [providerEnv, { ...providerEnv, PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, { ...providerEnv, OPENAI_API_KEY: '' }]) {
    await loopback(() => assert.fail('L2 never starts a model.'), async (preview, runtime, bodies) => {
      const f = await fixture.ready(preview); await submit(f, '虚构高风险标记\nSynthetic high marker: much too long to be a name.');
      await runner(f, runtime, 0).runNext(f.who, { taskId: f.prepared.taskId });
      const row = await source(f); assert.equal(row.status, 'detected'); assert.equal(row.level, 'L2'); assert.equal(row.detector_mode, 'keyword_only');
      assert.equal(row.application_status, 'pending'); assert.equal(row.rejected_category, null);
      assert.equal(bodies.length, 0); assert.equal((await usage(f)).length, 0); await noEffects(f);
    }, env);
  }
});

test('a model cannot downgrade a reviewed L1 keyword, and failed classification preserves the actual keyword signal', async () => {
  for (const failure of [false, true]) {
    await loopback((_body, reply) => { if (failure) reply.writeHead(500).end(); else respond(reply, { level: 'L0' }); }, async (preview, runtime, bodies) => {
      const f = await fixture.ready(preview); await submit(f, 'Synthetic low marker');
      await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId });
      const row = await source(f); assert.equal(row.level, 'L1'); assert.equal(row.detector_mode, failure ? 'keyword_only' : 'full');
      assert.equal(bodies.length, 1); await noEffects(f);
    });
  }
});

test('HTTP failure, refusal, incomplete output and malformed closed results leave no-hit text durably pending', async () => {
  const failures = [
    (reply: http.ServerResponse) => reply.writeHead(500).end(),
    (reply: http.ServerResponse) => respond(reply, { level: 'L0' }, { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Fictional refusal.' }] }] }),
    (reply: http.ServerResponse) => respond(reply, { level: 'L0' }, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    (reply: http.ServerResponse) => respond(reply, { level: 'L0', hidden: true }),
    (reply: http.ServerResponse) => respond(reply, { level: 'L9' }),
  ];
  for (const fail of failures) await loopback((_body, reply) => { fail(reply); }, async (preview, runtime, bodies) => {
    const f = await fixture.ready(preview); await submit(f); const intake = await frozenIntake(f);
    await assert.rejects(runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId }), unavailable);
    await assertPending(f); assert.equal(bodies.length, 1); assert.deepEqual(await frozenIntake(f), intake);
    assert.equal((await usage(f)).length, 1);
  });
});

test('real HTTP timeout preserves a matched L1 but never certifies an unknown no-hit result', async () => {
  for (const raw of ['Synthetic low marker', 'Juno']) {
    let closed = false;
    await loopback((_body, reply) => { reply.on('close', () => { closed = true; }); }, async (preview, runtime, bodies) => {
      const f = await fixture.ready(preview); await submit(f, raw);
      if (raw === 'Juno') { await assert.rejects(runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId }), unavailable); await assertPending(f); }
      else { await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId }); assert.equal((await source(f)).level, 'L1'); assert.equal((await source(f)).detector_mode, 'keyword_only'); }
      assert.equal(bodies.length, 1); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, true);
      const call = (await usage(f))[0]; assert(call.admitted_at); assert.notEqual(call.status, 'prepared'); assert.notEqual(call.usage_status, 'reported');
    });
  }
});

test('a valid admitted completed classification survives missing token counts, whose saved uncertainty blocks the next naming call', async () => {
  for (const tokenUsage of [null, { input_tokens: -1, output_tokens: 21 }]) {
    await loopback((_body, reply) => respond(reply, { level: 'L0' }, { usage: tokenUsage }), async (preview, runtime, bodies) => {
      const f = await fixture.ready(preview); await submit(f); await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId });
      const call = (await usage(f))[0]; assert.equal(call.status, 'complete'); assert.equal(call.usage_status, tokenUsage === null ? 'missing' : 'invalid');
      assert.equal(call.input_tokens, null); assert.equal(call.output_tokens, null); assert.equal((await source(f)).level, 'L0');
      await submit(f, '墨', 1); await assert.rejects(runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId }), unavailable);
      await assertPending(f); assert.equal(bodies.length, 1); assert.equal((await usage(f)).length, 1);
    });
  }
});

test('detector policy rotation after real admission fences old-profile acceptance while retaining measured usage', async () => {
  await loopback(async (_body, reply) => { await fixture.db.query('UPDATE platform_safety_detector_policy SET review_digest=$1 WHERE singleton=true', ['a'.repeat(64)]); respond(reply, { level: 'L0' }); },
  async (preview, runtime, bodies) => {
    const f = await fixture.ready(preview); await submit(f);
    try { await assert.rejects(runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId }), unavailable); await assertPending(f);
      const call = (await usage(f))[0]; assert.equal(call.status, 'complete'); assert.equal(call.usage_status, 'reported'); assert.equal(bodies.length, 1); }
    finally { await activate(f.who.userId); }
  });
});

test('session revocation, auth reset, legal rotation, lease expiry, execution-token rotation and source corruption fence acceptance without erasing an actual late completion', async () => {
  for (const fence of ['session', 'auth', 'legal', 'lease', 'execution', 'source'] as const) {
    let f!: Ready;
    await loopback(async (_body, reply) => {
      if (fence === 'session') await fixture.db.query('DELETE FROM platform_sessions WHERE user_id=$1 AND token_hash=$2', [f.who.userId, f.who.tokenHash]);
      if (fence === 'auth') await fixture.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [f.who.userId]);
      if (fence === 'legal') await fixture.db.query('UPDATE platform_terms_policy SET review_digest=$1 WHERE singleton=true', ['b'.repeat(64)]);
      if (fence === 'lease') await fixture.db.query("UPDATE platform_companion_name_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=$1", [f.who.userId]);
      if (fence === 'execution') await fixture.db.query('UPDATE platform_companion_name_submissions SET execution_token=$2 WHERE user_id=$1', [f.who.userId, randomUUID()]);
      if (fence === 'source') await fixture.db.query('UPDATE platform_companion_name_submissions SET request_ciphertext=set_byte(request_ciphertext,30,get_byte(request_ciphertext,30)#1) WHERE user_id=$1', [f.who.userId]);
      respond(reply, { level: 'L0' });
    }, async (preview, runtime, bodies) => {
      f = await fixture.ready(preview); await submit(f); const intake = await frozenIntake(f);
      try {
        await assert.rejects(runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId }), error => error instanceof ApiError);
        const row = await source(f); assert.equal(row.level, null); assert.equal(row.result_ciphertext, null); assert.equal(row.application_status, 'pending');
        const call = (await usage(f))[0]; assert.equal(call.status, 'complete'); assert.equal(call.usage_status, 'reported');
        assert.equal(call.input_tokens, 34); assert.equal(call.output_tokens, 21); assert(call.admitted_at); assert.equal(bodies.length, 1);
        assert.deepEqual(await frozenIntake(f), intake); await noEffects(f);
      } finally { if (fence === 'legal') await seedFictionalActiveLegal(fixture.db); }
    });
  }
});

test('two different pending name sources wait on the actual account lock before sharing one daily reservation', { timeout: 10_000 }, async () => {
  await loopback((_body, reply) => respond(reply, { level: 'L0' }), async (preview, runtime, bodies) => {
    const f = await fixture.ready(preview); await submit(f, 'Juno'); await submit(f, '墨', 1);
    const holder = await fixture.db.pool.connect(), gate = Number.parseInt(randomUUID().slice(0, 7), 16);
    let created = false, locked = false, first: Promise<unknown> | undefined, second: Promise<unknown> | undefined, firstError: unknown;
    try {
      const blocker = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await holder.query('SELECT pg_advisory_lock(91837,$1)', [gate]); locked = true;
      await fixture.db.query(`CREATE FUNCTION fictional_name_usage_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.user_id='${f.who.userId}'::uuid THEN PERFORM pg_advisory_xact_lock(91837,${gate}); END IF; RETURN NEW; END $$`); created = true;
      await fixture.db.query(`CREATE TRIGGER fictional_name_usage_insert_gate BEFORE INSERT ON platform_safety_model_usage
        FOR EACH ROW EXECUTE FUNCTION fictional_name_usage_insert_gate()`);
      const execute = runner(f, runtime, 1);
      first = execute.runNext(f.who, { taskId: f.prepared.taskId }); first.catch(error => { firstError = error; });
      let firstBackend: number | undefined;
      const firstWaitDeadline = Date.now() + 750;
      while (Date.now() < firstWaitDeadline && !firstError) {
        const found = await fixture.db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%INSERT INTO platform_safety_model_usage%' AND $1=ANY(pg_blocking_pids(pid))", [blocker]);
        if (found.rowCount) { firstBackend = found.rows[0].pid; break; } await new Promise(resolve => setTimeout(resolve, 2));
      }
      if (!firstBackend && firstError) throw firstError;
      assert(firstBackend, 'Observe the first real reservation INSERT held behind the controlled advisory gate.');
      second = execute.runNext(f.who, { taskId: f.prepared.taskId }); second.catch(() => {});
      let accountBlocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const found = await fixture.db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%platform_users%' AND $1=ANY(pg_blocking_pids(pid))", [firstBackend]);
        if (found.rowCount) { accountBlocked = true; break; } await new Promise(resolve => setTimeout(resolve, 2));
      }
      assert(accountBlocked, 'Observe the second source waiting on the first actual account row lock.');
      await holder.query('SELECT pg_advisory_unlock(91837,$1)', [gate]); locked = false;
      await first; await assert.rejects(second, unavailable);
      assert.equal((await usage(f)).length, 1); assert.equal(bodies.length, 1);
      const rows = (await fixture.db.query('SELECT level,status FROM platform_companion_name_submissions WHERE user_id=$1 ORDER BY submitted_revision', [f.who.userId])).rows;
      assert.deepEqual(rows, [{ level: 'L0', status: 'detected' }, { level: null, status: 'pending' }]);
    } finally {
      try { if (locked) await holder.query('SELECT pg_advisory_unlock(91837,$1)', [gate]); }
      finally { holder.release(); await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]); if (created) await fixture.db.query('DROP FUNCTION fictional_name_usage_insert_gate() CASCADE'); }
    }
  });
});

test('concurrent real runners admit only one classifier HTTP request for one name generation', async () => {
  await loopback((_body, reply) => respond(reply, { level: 'L0' }), async (preview, runtime, bodies) => {
    const f = await fixture.ready(preview); await submit(f); const execute = runner(f, runtime);
    const receipts = await Promise.all([execute.runNext(f.who, { taskId: f.prepared.taskId }), execute.runNext(f.who, { taskId: f.prepared.taskId })]);
    assert.equal(receipts.filter(Boolean).length, 1); assert.equal(bodies.length, 1); assert.equal((await source(f)).generation, 1); assert.equal((await usage(f)).length, 1);
  });
});

test('a real prior onboarding call consumes the same account daily cap and older unknown usage still blocks naming', async () => {
  for (const mode of ['capped', 'older_unknown', 'capped_l2'] as const) {
    const tokenUsage = mode === 'older_unknown' ? null : { input_tokens: 34, output_tokens: 21 };
    await loopback((body, reply) => {
      // Onboarding and naming each use their own strict output schema.
      assert.equal(body.max_output_tokens, 100); respond(reply, { level: 'L0', resolution: { kind: 'unmatched' } }, { usage: tokenUsage });
    }, async (preview, runtime, bodies) => {
      const who = await fixture.actor(), start = await fixture.store.save(who, { operationId: randomUUID(), expectedRevision: 0, action: { kind: 'start', mode: 'fast_track' } });
      await fixture.store.save(who, { operationId: randomUUID(), expectedRevision: start.draft.revision, action: { kind: 'text', questionId: 'study', text: 'Fictional shared-budget coursework.' } });
      const intakeRunner = new OnboardingSafetyRunner(fixture.store, { ...routeConfig, safetyDailyModelCallLimit: 1 }, runtime, profile);
      await intakeRunner.runNext(who);
      const f = await fixture.ready(preview, { who }); assert.equal((await usage(f))[0].source_kind, 'onboarding');
      if (mode === 'older_unknown') await fixture.db.query("UPDATE platform_safety_model_usage SET created_at=clock_timestamp()-interval '2 days' WHERE user_id=$1", [who.userId]);
      await submit(f, mode === 'capped_l2' ? 'Synthetic high marker' : 'Juno');
      if (mode === 'capped_l2') {
        await runner(f, runtime, 1).runNext(who, { taskId: f.prepared.taskId });
        assert.equal((await source(f)).level, 'L2'); assert.equal((await source(f)).detector_mode, 'keyword_only'); await noEffects(f);
      } else {
        await assert.rejects(runner(f, runtime, mode === 'older_unknown' ? 10 : 1).runNext(who, { taskId: f.prepared.taskId }), unavailable); await assertPending(f);
      }
      assert.equal(bodies.length, 1); assert.equal((await usage(f)).length, 1);
    });
  }
});

test('actual usage rows enforce a closed source shape and concrete naming foreign keys', async () => {
  await loopback((_body, reply) => respond(reply, { level: 'L0' }), async (preview, runtime) => {
    const f = await fixture.ready(preview); await submit(f); await runner(f, runtime).runNext(f.who, { taskId: f.prepared.taskId });
    const call = (await usage(f))[0], before = structuredClone(call), other = await fixture.actor();
    const violation = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
    for (const field of ['entry_id', 'task_id', 'companion_id', 'submission_id', 'operation_id'])
      await assert.rejects(fixture.db.query(`UPDATE platform_safety_model_usage SET ${field}=$2 WHERE call_id=$1`, [call.call_id, randomUUID()]), violation('23503'));
    await assert.rejects(fixture.db.query('UPDATE platform_safety_model_usage SET user_id=$2 WHERE call_id=$1', [call.call_id, other.userId]), violation('23503'));
    await assert.rejects(fixture.db.query('UPDATE platform_safety_model_usage SET expected_identity_revision=1 WHERE call_id=$1', [call.call_id]), violation('23503'));
    for (const sql of ["source_kind='onboarding'", 'entry_id=NULL', 'name_execution_token=NULL', 'draft_id=\'' + randomUUID() + '\'', 'question_id=\'study\'', 'preview_revision=2'])
      await assert.rejects(fixture.db.query(`UPDATE platform_safety_model_usage SET ${sql} WHERE call_id=$1`, [call.call_id]), violation('23514'));
    assert.deepEqual((await usage(f))[0], before);
  });
});
