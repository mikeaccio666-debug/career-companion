import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import type { OnboardingAction, OnboardingDraft, OnboardingFollowupAction, OnboardingScenarioQuestion, PlatformProviderRuntime } from '@companion/platform-contracts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { CompanionDraftPreparation } from '../src/companion-draft-preparation.ts';
import { CompanionEntry } from '../src/companion-entry.ts';
import { BackgroundGeneration } from '../src/background-generation.ts';
import { readConfig } from '../src/config.ts';
import { requireModelConsent } from '../src/model-consent.ts';
import { OnboardingSafetyResponses } from '../src/onboarding-safety-responses.ts';
import { OnboardingSafetyFollowup } from '../src/onboarding-safety-followup.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { fictionalBundle } from './fixtures/onboarding-followup.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';

// The existing fixture supplies actual isolated loopback PostgreSQL migrations,
// current sessions/legal consent and explicit fictional cost policies. Generation
// traverses the real ai-core adapter and a loopback SSE server. No external model,
// Redis worker, public HTTP service, source repair or future lifecycle API runs.
let fixture: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
before(async () => { fixture = await createCompanionNameSafetyFixture(); });
after(async () => { if (fixture) await fixture.close(); });
const scenarios: readonly OnboardingScenarioQuestion[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'];
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const invalidProof = (error: unknown) => error instanceof ApiError && error.status === 503
  && ['DATA_STORAGE_UNAVAILABLE', 'COMPANION_GENERATION_UNAVAILABLE'].includes(error.code);
const preview = { summary: '先把事情理清楚，再选一个小行动。', samples: [
  '可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。',
] };
const providerEnv = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-loopback-only',
  OPENAI_CHAT_MODEL: 'fictional-chat-unused', OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model' };
function respond(reply: http.ServerResponse, value: unknown = preview) {
  const event = { type: 'response.completed', response: { status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
    usage: { input_tokens: 34, output_tokens: 21 } } };
  reply.writeHead(200, { 'content-type': 'text/event-stream' });
  reply.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
}
async function loopback(run: (runtime: PlatformProviderRuntime, bodies: Record<string, any>[]) => Promise<void>, invalid: boolean | 'timeout' = false) {
  const bodies: Record<string, any>[] = []; let failure: unknown;
  const server = http.createServer(async (request, reply) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
      assert.equal(body.model, 'fictional-companion-model'); assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true); assert.deepEqual(body.tools, []);
      if (invalid !== 'timeout') respond(reply, invalid ? { ...preview, samples: [preview.samples[0]] } : preview);
    } catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const local = `http://127.0.0.1:${address.port}`;
  const runtime = requireModelConsent(createProviderRuntime({ env: providerEnv, fetch: (target, init) => {
    const remote = new URL(String(target)); assert.equal(remote.origin, 'https://api.openai.com');
    assert.equal(remote.pathname, '/v1/responses'); return fetch(local + remote.pathname, init);
  } }));
  try { await run(runtime, bodies); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const generation = (runtime: PlatformProviderRuntime) => new BackgroundGeneration(fixture.db, fixture.config, FICTIONAL_LEGAL, runtime);
async function save(who: FixedSessionContext, draft: OnboardingDraft, action: OnboardingAction) {
  return (await fixture.store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(), action })).draft;
}
async function basic(who: FixedSessionContext, draft: OnboardingDraft) {
  while (draft.step === 'O2') { assert(draft.currentQuestion); draft = await save(who, draft, { kind: 'skip', questionId: draft.currentQuestion }); }
  return draft;
}
async function classifyText(who: FixedSessionContext, draft: OnboardingDraft, questionId: NonNullable<OnboardingDraft['currentQuestion']>,
  text: string, resolution?: { kind: 'unmatched' } | { kind: 'answer'; questionId: any; value: any }) {
  draft = await save(who, draft, { kind: 'text', questionId, text });
  const claim = await fixture.store.claimSafety(who, { detectorRevision: 29 }); assert(claim);
  assert.equal(claim.questionId, questionId); const operationId = claim.operationId;
  await fixture.store.processSafety(claim, async (input, admission) => admission(async signal => {
    signal.throwIfAborted(); assert.deepEqual(input, { questionId, text });
    return { level: 'L0', mode: 'full', ...(resolution ? { resolution } : {}) };
  }));
  const current = await fixture.store.read(who); assert(current);
  return { draft: current, operationId, submissionId: claim.submissionId };
}
async function ready(runtime: PlatformProviderRuntime, kind: 'fast' | 'remaining' | 'text' = 'fast', generate = true) {
  const who = await fixture.actor(), approver = await fixture.actor(true);
  await fixture.db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,approved_by,approved_at,effective_from)
    VALUES($1,'fictional-historical-preview','week','notify',1,100000000,$2,clock_timestamp(),clock_timestamp())`, [who.userId, approver.userId]);
  let draft = (await fixture.store.save(who, { expectedRevision: 0, operationId: randomUUID(),
    action: { kind: 'start', mode: kind === 'fast' ? 'fast_track' : 'standard' } })).draft;
  const textSources: { operationId: string; submissionId: string }[] = [];
  if (kind === 'text') {
    // Actual old and replacement operations complete independently; only the
    // replacement resolution is in the capture. No old raw-text timeline is invented.
    draft = await save(who, draft, { kind: 'text', questionId: 'study', text: 'Synthetic superseded study context.' });
    const old = await fixture.store.claimSafety(who, { detectorRevision: 29 }); assert(old);
    draft = await save(who, draft, { kind: 'text', questionId: 'study', text: 'Synthetic current study context; 别催我.' });
    const newer = await fixture.store.claimSafety(who, { detectorRevision: 29 }); assert(newer);
    assert.notEqual(old.operationId, newer.operationId);
    await fixture.store.processSafety(newer, async (_input, admission) => admission(async () => ({ level: 'L0', mode: 'full',
      resolution: { kind: 'answer', questionId: 'study', value: { degreeField: 'ds_statistics', programChoice: null } } })));
    await fixture.store.processSafety(old, async (_input, admission) => admission(async () => ({ level: 'L0', mode: 'full', resolution: { kind: 'unmatched' } })));
    draft = (await fixture.store.read(who))!; textSources.push({ operationId: newer.operationId, submissionId: newer.submissionId });
    const unmatched = await classifyText(who, draft, 'graduation', 'Synthetic unmatched graduation context.', { kind: 'unmatched' });
    draft = unmatched.draft; textSources.push(unmatched);
  }
  draft = await basic(who, draft);
  if (kind === 'remaining') {
    draft = await save(who, draft, { kind: 'answer', questionId: 'Q1', value: 'C' });
    draft = await save(who, draft, { kind: 'skip_remaining' });
  } else if (kind === 'text') {
    for (const [index, questionId] of scenarios.entries()) draft = await save(who, draft,
      { kind: 'answer', questionId, value: ['B', 'C', 'A', 'A', 'C', 'B', 'B'][index] } as OnboardingAction);
    const extra = await classifyText(who, draft, 'extra', '说话直一点，别催我，短一点，多用英文；Synthetic unrelated private context.');
    draft = extra.draft; textSources.push(extra);
  }
  while (draft.currentQuestion) draft = await save(who, draft, { kind: 'skip', questionId: draft.currentQuestion });
  assert.equal(draft.state, 'intake_ready');
  const prepared = await new CompanionDraftPreparation(fixture.db, fixture.config, FICTIONAL_LEGAL, runtime)
    .prepare(who, { expectedRevision: draft.revision }), service = generation(runtime);
  if (generate) await service.generate(who, { taskId: prepared.taskId });
  return { who, draft, prepared, service, textSources };
}
function historical(service: BackgroundGeneration, who: FixedSessionContext, taskId: string, signal?: AbortSignal) {
  return fixture.db.withBoundedTransaction(client => service.readHistoricalCompletedInTransaction(client, who, { taskId }, signal));
}
const tables = ['platform_onboarding_drafts', 'platform_onboarding_operations', 'platform_onboarding_safety_submissions',
  'platform_onboarding_safety_responses', 'platform_onboarding_safety_publications', 'platform_onboarding_safety_followups',
  'platform_safety_events', 'platform_companion_answers', 'platform_companions',
  'platform_companion_source_prefixes',
  'platform_companion_generation_tasks', 'platform_companion_generation_calls', 'platform_companion_generation_checkpoints',
  'platform_companion_generation_requests', 'platform_companion_generation_outbox',
  'platform_companion_revisions', 'platform_cost_reservations', 'platform_cost_ledger', 'platform_runtime_leases',
  'platform_conversations', 'platform_memories', 'platform_chat_calls', 'platform_jobs'] as const;
async function snapshot(who: FixedSessionContext) {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await fixture.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY 1`, [who.userId])).rows])));
}
async function revision(taskId: string) {
  return (await fixture.db.query('SELECT * FROM platform_companion_revisions WHERE task_id=$1', [taskId])).rows[0];
}
function revisionPayload(row: any, who: FixedSessionContext) {
  return JSON.parse(fixture.crypto.openUtf8(row.payload_ciphertext, { table: 'platform_companion_revisions', column: 'payload_ciphertext',
    rowId: row.companion_id, ownerId: who.userId, revision: 1 }));
}
const rollback = new Error('Fictional historical proof mutation rollback.');
async function rejectedMutation(service: BackgroundGeneration, who: FixedSessionContext, taskId: string,
  mutate: (client: PoolClient) => Promise<unknown>) {
  await assert.rejects(fixture.db.withBoundedTransaction(async client => {
    await mutate(client);
    await assert.rejects(service.readHistoricalCompletedInTransaction(client, who, { taskId }), invalidProof);
    throw rollback;
  }), error => error === rollback);
}

test('a completed model history requires the actual original checkpoint and preserves the original envelope without side effects', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, service } = await ready(runtime), before = await snapshot(who);
    const current = await fixture.db.withBoundedTransaction(client => service.readInTransaction(client, who, { taskId: prepared.taskId })); assert(current);
    const result = await historical(service, who, prepared.taskId); assert(result);
    assert.deepEqual(result, { kind: 'historical_completed_preview', envelope: current });
    assert(Object.isFrozen(result)); assert(Object.isFrozen(result.envelope)); assert(Object.isFrozen(result.envelope.source));
    assert(Object.isFrozen(result.envelope.dimensions)); assert(Object.isFrozen(result.envelope.preview));
    assert.equal(bodies.length, 1); assert.deepEqual(await snapshot(who), before);
    await rejectedMutation(service, who, prepared.taskId, client => client.query('DELETE FROM platform_companion_generation_checkpoints WHERE task_id=$1', [prepared.taskId]));
    assert.deepEqual(await snapshot(who), before); assert.equal(bodies.length, 1);
  });
});

test('historical observation is independent of current draft and companion projections while the current writer gate stays closed', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, service } = await ready(runtime), original = await historical(service, who, prepared.taskId); assert(original);
    // Controlled fixture mutations exercise independence; they do not implement
    // or claim a birth, reroll, new version, legalized write or lifecycle API.
    await fixture.db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [who.userId, Buffer.alloc(29)]);
    await fixture.db.query("UPDATE platform_companions SET status='drafting',current_revision=0 WHERE id=$1", [prepared.companionId]);
    const before = await snapshot(who);
    const cold = requireModelConsent(createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: async () => {
      assert.fail('A historical observer must never contact a provider.');
    } }));
    const observer = new BackgroundGeneration(fixture.db, { ...fixture.config, modelRoutes: {} }, FICTIONAL_LEGAL, cold);
    assert.deepEqual(await historical(observer, who, prepared.taskId), original);
    await assert.rejects(fixture.db.withBoundedTransaction(client => service.readInTransaction(client, who, { taskId: prepared.taskId })), invalidProof);
    assert.deepEqual(await snapshot(who), before); assert.equal(bodies.length, 1);
  });
});

test('historical reads use a real current fresh session without treating original generation auth as a current execution grant', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, service } = await ready(runtime), original = await historical(service, who, prepared.taskId);
    const hash = tokenHash(randomUUID());
    await fixture.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
    await fixture.db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
      VALUES($1,$2,1,clock_timestamp()+interval '1 hour')`, [who.userId, hash]);
    const fresh = { userId: who.userId, tokenHash: hash }, before = await snapshot(who);
    await assert.rejects(historical(service, who, prepared.taskId), code('AUTH_REQUIRED'));
    assert.deepEqual(await historical(service, fresh, prepared.taskId), original);
    assert.equal((await fixture.db.query('SELECT auth_version FROM platform_companion_generation_tasks WHERE id=$1', [prepared.taskId])).rows[0].auth_version, '0');
    await assert.rejects(new CompanionDraftPreparation(fixture.db, fixture.config, FICTIONAL_LEGAL, runtime)
      .prepare(fresh, { expectedRevision: prepared.source.draftRevision }), code('COMPANION_DRAFT_SOURCE_CHANGED'));
    assert.deepEqual(await snapshot(who), before); assert.equal(bodies.length, 1);
  });
});

test('capture validates genuine fast_track and skip_remaining operations against original command receipts', async () => {
  await loopback(async (runtime, bodies) => {
    for (const kind of ['fast', 'remaining'] as const) {
      const { who, prepared, service } = await ready(runtime, kind), before = await snapshot(who);
      const result = await historical(service, who, prepared.taskId); assert(result);
      assert.equal(result.envelope.dimensions.directness, kind === 'fast' ? 0 : 1);
      const operation = (await fixture.db.query('SELECT * FROM platform_onboarding_operations WHERE user_id=$1 ORDER BY applied_revision', [who.userId])).rows
        .find(row => JSON.parse(fixture.crypto.openUtf8(row.request_ciphertext, { table: 'platform_onboarding_operations', column: 'request_ciphertext',
          rowId: row.operation_id, ownerId: who.userId, revision: row.applied_revision })).action.kind === (kind === 'fast' ? 'start' : 'skip_remaining'));
      assert(operation);
      await rejectedMutation(service, who, prepared.taskId, client => client.query('DELETE FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2', [who.userId, operation.operation_id]));
      assert.deepEqual(await snapshot(who), before);
    }
    assert.equal(bodies.length, 2);
  });
});

test('genuine replacement text, unmatched text and extra preferences require the exact original full L0 results', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, service, textSources } = await ready(runtime, 'text'), before = await snapshot(who);
    const result = await historical(service, who, prepared.taskId); assert(result);
    assert.deepEqual(result.envelope.dimensions, { warmth: 1, directness: 1, drive: 0, structure: 0, levity: 0, code_mix: 1, length: 'short' });
    assert.equal(textSources.length, 3);
    for (const source of textSources) {
      await rejectedMutation(service, who, prepared.taskId, client => client.query('UPDATE platform_onboarding_safety_submissions SET result_ciphertext=$2 WHERE id=$1', [source.submissionId, Buffer.alloc(29)]));
      await rejectedMutation(service, who, prepared.taskId, client => client.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, source.operationId, Buffer.alloc(29)]));
    }
    assert.deepEqual(await snapshot(who), before); assert.equal(bodies.length, 1);
    assert.equal(JSON.stringify(result).includes('Synthetic'), false); assert.equal(JSON.stringify(result).includes('别催我'), false);
  });
});

test('unknown, foreign and coherently re-encrypted alternate captured answers fail closed without rewriting history', async () => {
  await loopback(async (runtime, bodies) => {
    const own = await ready(runtime), foreign = await ready(runtime), before = await snapshot(own.who);
    const row = before.platform_companion_answers[0], foreignRow = (await snapshot(foreign.who)).platform_companion_answers[0];
    const binding = { table: 'platform_companion_answers', column: 'payload_ciphertext', rowId: row.id,
      ownerId: own.who.userId, revision: row.source_revision };
    const saved = JSON.parse(fixture.crypto.openUtf8(row.payload_ciphertext, binding));
    const altered = structuredClone(saved); altered.answersPartial.study = { kind: 'answered', source: 'user_entered', appliedRevision: 2,
      value: { degreeField: 'cs', programChoice: null } };
    for (const ciphertext of [Buffer.alloc(29), foreignRow.payload_ciphertext,
      fixture.crypto.sealUtf8(JSON.stringify({ ...saved, executionApproved: true }), binding),
      fixture.crypto.sealUtf8(JSON.stringify(altered), binding)]) {
      await rejectedMutation(own.service, own.who, own.prepared.taskId, client => client.query('UPDATE platform_companion_answers SET payload_ciphertext=$2 WHERE id=$1', [row.id, ciphertext]));
    }
    await assert.rejects(historical(own.service, foreign.who, own.prepared.taskId), code('NOT_FOUND'));
    await assert.rejects(historical(own.service, { userId: own.who.userId, tokenHash: foreign.who.tokenHash }, own.prepared.taskId), code('AUTH_REQUIRED'));
    assert.deepEqual(await snapshot(own.who), before); assert.equal(bodies.length, 2);
  });
});

test('a genuine fallback history requires canonical deterministic prose and all actual failed-call cost receipts', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, service } = await ready(runtime), before = await snapshot(who), result = await historical(service, who, prepared.taskId); assert(result);
    assert.equal(result.envelope.preview.generatedBy, 'fallback'); assert.equal(bodies.length, 3);
    assert.equal(before.platform_companion_generation_checkpoints.length, 0);
    const row = await revision(prepared.taskId), saved = revisionPayload(row, who);
    const changed = { ...saved, summary: preview.summary, samples: [...preview.samples] };
    assert.notDeepEqual({ summary: saved.summary, samples: saved.samples }, preview);
    const sealed = fixture.crypto.sealUtf8(JSON.stringify(changed), { table: 'platform_companion_revisions', column: 'payload_ciphertext',
      rowId: prepared.companionId, ownerId: who.userId, revision: 1 });
    await rejectedMutation(service, who, prepared.taskId, client => client.query('UPDATE platform_companion_revisions SET payload_ciphertext=$2 WHERE task_id=$1', [prepared.taskId, sealed]));
    for (const call of before.platform_companion_generation_calls) {
      await rejectedMutation(service, who, prepared.taskId, client => client.query('DELETE FROM platform_cost_ledger WHERE reservation_id=$1', [call.reservation_id]));
    }
    assert.deepEqual(await snapshot(who), before); assert.equal(bodies.length, 3);
  }, true);
});

test('an actual fifteen-second HTTP timeout retains the original fallback and settled uncertainty during historical observation', { timeout: 25_000 }, async () => {
  await loopback(async (runtime, bodies) => {
    const started = performance.now(), { who, prepared, service } = await ready(runtime);
    assert(performance.now() - started >= 14_900);
    const before = await snapshot(who), original = await historical(service, who, prepared.taskId); assert(original);
    assert.equal(original.envelope.preview.generatedBy, 'fallback'); assert.equal(bodies.length, 1);
    assert.equal(before.platform_companion_generation_calls.length, 1);
    const call = before.platform_companion_generation_calls[0];
    assert(call.admitted_at); assert.equal(call.validation_status, 'timed_out'); assert.notEqual(call.status, 'complete');
    assert.equal(before.platform_companion_generation_checkpoints.length, 0);
    assert.equal(before.platform_cost_ledger.length, 1); assert.equal(before.platform_cost_ledger[0].estimated, true);
    assert(BigInt(before.platform_cost_ledger[0].cost_micros) > 0n);
    const cold = requireModelConsent(createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: async () => {
      assert.fail('Observing an actual timeout fallback cannot retry the provider.');
    } }));
    assert.deepEqual(await historical(generation(cold), who, prepared.taskId), original);
    await rejectedMutation(service, who, prepared.taskId, client => client.query('DELETE FROM platform_cost_ledger WHERE reservation_id=$1', [call.reservation_id]));
    assert.deepEqual(await snapshot(who), before); assert.equal(bodies.length, 1);
  }, 'timeout');
});

test('multiple original L1 and L2 handling chains remain complete while a later damaged response is outside the captured prefix', async () => {
  await loopback(async (runtime, bodies) => {
    const bundle = fictionalBundle(), operator = await fixture.actor(true), who = await fixture.actor();
    await fixture.db.query(`INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
      VALUES(true,$1,$2,$3,clock_timestamp(),$4) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,
      content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by`,
    [bundle.revision, bundle.contentDigest, bundle.reviewDigest, operator.userId]);
    await fixture.db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,approved_by,approved_at,effective_from)
      VALUES($1,'fictional-multiple-history','week','notify',1,100000000,$2,clock_timestamp(),clock_timestamp())`, [who.userId, operator.userId]);
    const responses = new OnboardingSafetyResponses(fixture.db, fixture.config, FICTIONAL_LEGAL, bundle);
    const followup = new OnboardingSafetyFollowup(fixture.db, fixture.config, FICTIONAL_LEGAL);
    let draft = (await fixture.store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'standard' } })).draft;
    const originalTextIds: string[] = [];
    for (const level of ['L1', 'L2', 'L1'] as const) {
      draft = await save(who, draft, { kind: 'text', questionId: 'study', text: 'Synthetic distinct original risk ' + level });
      const claim = await fixture.store.claimSafety(who, { detectorRevision: 29 }); assert(claim);
      originalTextIds.push(claim.operationId);
      await fixture.store.processSafety(claim, async (_input, admission) => admission(async () => ({ level, mode: 'keyword_only' })));
      await responses.prepareSubmission(claim.submissionId);
      const view = await followup.read(who); assert(view.draft);
      const publication = view.publications.find(item => item.submissionId === claim.submissionId); assert(publication);
      const command = (action: OnboardingFollowupAction) => ({ expectedDraftRevision: view.draft!.revision,
        publicationId: publication.publicationId, operationId: randomUUID(), action });
      const shown = await followup.act(who, command({ kind: 'present' })); assert(shown.presentationReceipt);
      await followup.act(who, command({ kind: 'acknowledge', presentationReceipt: shown.presentationReceipt }));
      const continued = await followup.act(who, command(level === 'L1'
        ? { kind: 'continue_intake', presentationReceipt: shown.presentationReceipt }
        : { kind: 'clarify_exaggeration', presentationReceipt: shown.presentationReceipt, safe: true, exaggeration: true }));
      assert.equal(continued.resumeStatus, 'resumed'); draft = continued.draft;
    }
    draft = await basic(who, draft); draft = await save(who, draft, { kind: 'skip_remaining' });
    draft = await save(who, draft, { kind: 'skip', questionId: 'extra' }); assert.equal(draft.state, 'intake_ready');
    const prepared = await new CompanionDraftPreparation(fixture.db, fixture.config, FICTIONAL_LEGAL, runtime)
      .prepare(who, { expectedRevision: draft.revision }), service = generation(runtime);
    await service.generate(who, { taskId: prepared.taskId });
    const original = await historical(service, who, prepared.taskId); assert(original);
    const before = await snapshot(who); assert.equal(before.platform_onboarding_safety_publications.length, 3);
    const grades = (await fixture.db.query('SELECT level FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision,id',
      [who.userId])).rows.map((row: { level: string }) => row.level);
    assert.deepEqual(grades, ['L1', 'L2', 'L1']);
    for (const id of originalTextIds) await rejectedMutation(service, who, prepared.taskId,
      client => client.query('DELETE FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2', [who.userId, id]));
    assert.deepEqual(await snapshot(who), before);
    // Controlled projection reopening is only a fixture for future history;
    // every new text/result/response still goes through the actual service path.
    const row = (await fixture.db.query('SELECT * FROM platform_onboarding_drafts WHERE user_id=$1', [who.userId])).rows[0];
    const binding = { table: 'platform_onboarding_drafts', column: 'payload_ciphertext', rowId: row.id,
      ownerId: who.userId, revision: row.revision };
    const later = JSON.parse(fixture.crypto.openUtf8(row.payload_ciphertext, binding));
    delete later.answersPartial.extra; later.state = 'collecting'; later.step = 'O4'; later.currentQuestion = 'extra';
    await fixture.db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1',
      [who.userId, fixture.crypto.sealUtf8(JSON.stringify(later), binding)]);
    const current = await fixture.store.read(who); assert(current);
    await save(who, current, { kind: 'text', questionId: 'extra', text: 'Synthetic later risk outside original source.' });
    const claim = await fixture.store.claimSafety(who, { detectorRevision: 29 }); assert(claim);
    await fixture.store.processSafety(claim, async (_input, admission) => admission(async () => ({ level: 'L2', mode: 'keyword_only' })));
    const saved = await responses.prepareSubmission(claim.submissionId);
    await fixture.db.query('UPDATE platform_onboarding_safety_responses SET payload_ciphertext=$2 WHERE id=$1', [saved.responseId, Buffer.alloc(29)]);
    const changed = await snapshot(who);
    assert.deepEqual(await historical(service, who, prepared.taskId), original);
    await assert.rejects(fixture.db.withBoundedTransaction(client => service.readInTransaction(client, who, { taskId: prepared.taskId })), invalidProof);
    assert.deepEqual(await snapshot(who), changed); assert.equal(bodies.length, 1);
  });
});

test('a model revision cannot be relabeled fallback or separated from its authenticated checkpoint and price settlement', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, service } = await ready(runtime), before = await snapshot(who);
    const checkpoint = before.platform_companion_generation_checkpoints[0], row = await revision(prepared.taskId), saved = revisionPayload(row, who);
    const binding = { table: 'platform_companion_revisions', column: 'payload_ciphertext', rowId: prepared.companionId, ownerId: who.userId, revision: 1 };
    await rejectedMutation(service, who, prepared.taskId, client => client.query("UPDATE platform_companion_revisions SET generated_by='fallback',payload_ciphertext=$2 WHERE task_id=$1",
      [prepared.taskId, fixture.crypto.sealUtf8(JSON.stringify({ ...saved, generatedBy: 'fallback' }), binding)]));
    await rejectedMutation(service, who, prepared.taskId, client => client.query('UPDATE platform_companion_generation_checkpoints SET payload_digest=$2 WHERE task_id=$1', [prepared.taskId, '0'.repeat(64)]));
    await rejectedMutation(service, who, prepared.taskId, client => client.query('UPDATE platform_companion_generation_checkpoints SET payload_ciphertext=$2 WHERE task_id=$1', [prepared.taskId, Buffer.alloc(29)]));
    await rejectedMutation(service, who, prepared.taskId, client => client.query('UPDATE platform_cost_ledger SET cost_micros=cost_micros+1 WHERE reservation_id=$1', [before.platform_companion_generation_calls[0].reservation_id]));
    assert(checkpoint); assert.deepEqual(await snapshot(who), before); assert.equal(bodies.length, 1);
  });
});

test('historical requests are closed and unfinished work stays an observation without any model or source repair', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, service } = await ready(runtime, 'fast', false), before = await snapshot(who);
    assert.equal(await historical(service, who, prepared.taskId), null);
    let accesses = 0;
    const getter = Object.defineProperty({}, 'taskId', { enumerable: true, get() { accesses++; return prepared.taskId; } });
    for (const value of [null, [], {}, { taskId: prepared.taskId, completed: true }, { taskId: prepared.taskId, envelope: {} },
      { taskId: prepared.taskId, userId: who.userId }, { taskId: prepared.taskId.toUpperCase() }, getter]) {
      await assert.rejects(fixture.db.withBoundedTransaction(client => service.readHistoricalCompletedInTransaction(client, who, value)), code('INVALID_INPUT'));
    }
    const controller = new AbortController(); controller.abort(new Error('Fictional cancelled observer.'));
    await assert.rejects(historical(service, who, prepared.taskId, controller.signal), error => error === controller.signal.reason);
    assert.equal(accesses, 0); assert.deepEqual(await snapshot(who), before); assert.equal(bodies.length, 0);
  });
});

test('historical observation still authorizes current verified student identity and current legal consent', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, service } = await ready(runtime), before = await snapshot(who);
    for (const [query, expected] of [
      ['DELETE FROM platform_sessions WHERE user_id=$1', 'AUTH_REQUIRED'],
      ['UPDATE platform_sessions SET expires_at=clock_timestamp()-interval \'1 second\' WHERE user_id=$1', 'AUTH_REQUIRED'],
      ['UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', 'EMAIL_VERIFICATION_REQUIRED'],
      ["UPDATE platform_users SET account_kind='staff' WHERE id=$1", 'STUDENT_ACCOUNT_REQUIRED'],
      ['DELETE FROM platform_terms_consents WHERE user_id=$1', 'TERMS_CONFIRMATION_REQUIRED'],
    ] as const) {
      await assert.rejects(fixture.db.withBoundedTransaction(async client => {
        await client.query(query, [who.userId]);
        await assert.rejects(service.readHistoricalCompletedInTransaction(client, who, { taskId: prepared.taskId }), code(expected));
        throw rollback;
      }), error => error === rollback);
    }
    await assert.rejects(fixture.db.withBoundedTransaction(client => new BackgroundGeneration(fixture.db,
      { ...fixture.config, dataCrypto: undefined }, FICTIONAL_LEGAL, runtime).readHistoricalCompletedInTransaction(client, who, { taskId: prepared.taskId })), code('DATA_STORAGE_UNAVAILABLE'));
    await assert.rejects(fixture.db.withBoundedTransaction(client => new BackgroundGeneration(fixture.db,
      fixture.config, null, runtime).readHistoricalCompletedInTransaction(client, who, { taskId: prepared.taskId })), code('LEGAL_DOCUMENTS_UNAVAILABLE'));
    assert.deepEqual(await snapshot(who), before); assert.equal(bodies.length, 1);
  });
});

test('genuine handled L1 and L2 history keeps its risk grade and requires original resource publication, presentation, acknowledgment and explicit continuation', async () => {
  await loopback(async (runtime, bodies) => {
    const bundle = fictionalBundle(), operator = await fixture.actor(true);
    // Existing synthetic asset activation is only fixture integrity; it is not
    // professional review, production approval or a substituted handled marker.
    await fixture.db.query(`INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by)
      VALUES(true,$1,$2,$3,clock_timestamp(),$4) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,
      content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,activated_at=EXCLUDED.activated_at,activated_by=EXCLUDED.activated_by`,
    [bundle.revision, bundle.contentDigest, bundle.reviewDigest, operator.userId]);
    const responses = new OnboardingSafetyResponses(fixture.db, fixture.config, FICTIONAL_LEGAL, bundle);
    const followup = new OnboardingSafetyFollowup(fixture.db, fixture.config, FICTIONAL_LEGAL);
    for (const level of ['L1', 'L2'] as const) {
      const who = await fixture.actor(), mode = level === 'L1' ? 'keyword_only' : 'full';
      await fixture.db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,approved_by,approved_at,effective_from)
        VALUES($1,'fictional-historical-handled','week','notify',1,100000000,$2,clock_timestamp(),clock_timestamp())`, [who.userId, operator.userId]);
      let draft = (await fixture.store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'standard' } })).draft;
      draft = await save(who, draft, { kind: 'text', questionId: 'study', text: 'Synthetic handled-risk study context.' });
      const claim = await fixture.store.claimSafety(who, { detectorRevision: 29 }); assert(claim);
      await fixture.store.processSafety(claim, async (_input, admission) => admission(async signal => {
        signal.throwIfAborted(); return { level, mode };
      }));
      assert.equal((await responses.prepareSubmission(claim.submissionId)).status, 'ready');
      const published = await followup.read(who); assert(published.draft); assert.equal(published.publications.length, 1);
      const publication = published.publications[0]; assert(publication);
      assert.equal(publication.level, level); assert.equal(publication.handled, false);
      const command = (action: OnboardingFollowupAction) => ({ expectedDraftRevision: published.draft!.revision,
        publicationId: publication.publicationId, operationId: randomUUID(), action });
      const presentCommand = command({ kind: 'present' }), shown = await followup.act(who, presentCommand); assert(shown.presentationReceipt);
      const ackCommand = command({ kind: 'acknowledge', presentationReceipt: shown.presentationReceipt });
      await followup.act(who, ackCommand);
      const requested = command(level === 'L1' ? { kind: 'continue_intake', presentationReceipt: shown.presentationReceipt }
        : { kind: 'clarify_exaggeration', presentationReceipt: shown.presentationReceipt, safe: true, exaggeration: true });
      const continued = await followup.act(who, requested); assert.equal(continued.resumeStatus, 'resumed');
      draft = continued.draft; assert.equal(draft.currentQuestion, 'study'); assert.equal(draft.state, 'collecting');
      // New structured answers are ordinary actual operations. The older risk
      // neither becomes L0 nor contributes text to personality preferences.
      draft = await basic(who, draft); draft = await save(who, draft, { kind: 'skip_remaining' });
      draft = await save(who, draft, { kind: 'skip', questionId: 'extra' }); assert.equal(draft.state, 'intake_ready');
      const prepared = await new CompanionDraftPreparation(fixture.db, fixture.config, FICTIONAL_LEGAL, runtime)
        .prepare(who, { expectedRevision: draft.revision }), service = generation(runtime);
      await service.generate(who, { taskId: prepared.taskId });
      const before = await snapshot(who), result = await historical(service, who, prepared.taskId); assert(result);
      assert.deepEqual(result.envelope.dimensions, { warmth: 0, directness: 0, drive: 0, structure: 0, levity: 0, code_mix: 0, length: 'medium' });
      assert.equal(before.platform_onboarding_safety_submissions[0].level, level);
      assert.equal(before.platform_onboarding_safety_submissions[0].detector_mode, mode);
      const handling = before.platform_onboarding_safety_followups.find((row: { operation_id: string }) => row.operation_id === requested.operationId); assert(handling);
      assert.equal(handling.handled, true); assert.equal(handling.presentation_operation_id, presentCommand.operationId);
      assert.equal(handling.acknowledgment_operation_id, ackCommand.operationId);
      assert.equal(handling.action_kind, level === 'L1' ? 'continue_intake' : 'clarify_exaggeration');
      assert.equal(handling.clarified_at instanceof Date, level === 'L2');
      assert.equal(before.platform_safety_events[0].level, level);
      assert.deepEqual(await snapshot(who), before);
      await rejectedMutation(service, who, prepared.taskId, client => client.query('UPDATE platform_onboarding_safety_publications SET payload_ciphertext=$2 WHERE id=$1',
        [publication.publicationId, Buffer.alloc(29)]));
      await rejectedMutation(service, who, prepared.taskId, client => client.query('DELETE FROM platform_onboarding_safety_publications WHERE id=$1', [publication.publicationId]));
      for (const operationId of [presentCommand.operationId, ackCommand.operationId, requested.operationId]) {
        await rejectedMutation(service, who, prepared.taskId, client => client.query('DELETE FROM platform_onboarding_safety_followups WHERE user_id=$1 AND operation_id=$2', [who.userId, operationId]));
      }
      await rejectedMutation(service, who, prepared.taskId, client => client.query('UPDATE platform_onboarding_safety_followups SET payload_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2',
        [who.userId, requested.operationId, Buffer.alloc(29)]));
      assert.deepEqual(await snapshot(who), before);
      assert.equal(JSON.stringify(result).includes('Synthetic handled-risk'), false);
    }
    assert.equal(bodies.length, 2);
  });
});

test('a genuine accepted entry request and outbox stay authenticated historical facts after a fresh login without renewing original execution', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, draft, prepared } = await ready(runtime, 'fast', false);
    const entry = new CompanionEntry(fixture.db, { ...readConfig(), ...fixture.config }, FICTIONAL_LEGAL, runtime);
    const command = { operationId: randomUUID(), expectedRevision: draft.revision }, accepted = await entry.accept(who, command);
    assert.equal(accepted.operation.id, command.operationId); assert.equal(accepted.operation.replayed, false);
    assert.equal(accepted.entry.kind, 'generation');
    assert.equal((await snapshot(who)).platform_companion_generation_requests.length, 1);
    assert.equal((await snapshot(who)).platform_companion_generation_outbox.length, 1);
    const notification = { requestId: command.operationId, taskId: prepared.taskId };
    await entry.executeNotification(notification); assert.equal(bodies.length, 1);
    const before = await snapshot(who), original = await historical(entry.generation, who, prepared.taskId); assert(original);
    const request = before.platform_companion_generation_requests[0];
    const binding = { table: 'platform_companion_generation_requests', column: 'payload_ciphertext', rowId: request.id,
      ownerId: who.userId, revision: draft.revision };
    const text = fixture.crypto.openUtf8(request.payload_ciphertext, binding), saved = JSON.parse(text);
    assert.equal(saved.tokenHash, who.tokenHash); assert.equal(saved.authVersion, '0');
    assert.equal(saved.command.operationId, command.operationId); assert.equal(saved.taskId, prepared.taskId);
    assert.equal(request.payload_digest, createHash('sha256').update(text).digest('hex'));
    assert.equal(request.payload_ciphertext.includes(Buffer.from(who.tokenHash)), false);
    await rejectedMutation(entry.generation, who, prepared.taskId, client => client.query('UPDATE platform_companion_generation_requests SET payload_ciphertext=$2 WHERE id=$1',
      [request.id, Buffer.alloc(29)]));
    await rejectedMutation(entry.generation, who, prepared.taskId, client => client.query('UPDATE platform_companion_generation_requests SET payload_digest=$2 WHERE id=$1',
      [request.id, '0'.repeat(64)]));
    await rejectedMutation(entry.generation, who, prepared.taskId, client => client.query('UPDATE platform_companion_generation_requests SET source_revision=source_revision+1 WHERE id=$1', [request.id]));
    const alternate = JSON.stringify({ ...saved, sourceDraftId: randomUUID() });
    await rejectedMutation(entry.generation, who, prepared.taskId, client => client.query('UPDATE platform_companion_generation_requests SET payload_ciphertext=$2,payload_digest=$3 WHERE id=$1',
      [request.id, fixture.crypto.sealUtf8(alternate, binding), createHash('sha256').update(alternate).digest('hex')]));
    await rejectedMutation(entry.generation, who, prepared.taskId, client => client.query('DELETE FROM platform_companion_generation_outbox WHERE request_id=$1', [request.id]));
    assert.deepEqual(await snapshot(who), before); assert.equal(bodies.length, 1);
    const hash = tokenHash(randomUUID());
    await fixture.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
    await fixture.db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
      VALUES($1,$2,1,clock_timestamp()+interval '1 hour')`, [who.userId, hash]);
    const fresh = { userId: who.userId, tokenHash: hash }, afterLogin = await snapshot(who);
    await assert.rejects(historical(entry.generation, who, prepared.taskId), code('AUTH_REQUIRED'));
    assert.deepEqual(await historical(entry.generation, fresh, prepared.taskId), original);
    await assert.rejects(entry.executeNotification(notification), code('AUTH_REQUIRED'));
    await assert.rejects(entry.accept(fresh, command), code('COMPANION_DRAFT_SOURCE_CHANGED'));
    assert.deepEqual(await snapshot(who), afterLogin); assert.equal(bodies.length, 1);
    assert.deepEqual(afterLogin.platform_companion_generation_requests, before.platform_companion_generation_requests);
    assert.deepEqual(afterLogin.platform_companion_generation_outbox, before.platform_companion_generation_outbox);
  });
});
