import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import type { CompanionBirthRequest, PlatformProviderRuntime } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import type { FixedSessionContext } from '../src/auth.ts';
import { CompanionIdentityDrafts } from '../src/companion-identity-drafts.ts';
import { CompanionNameSafetyRunner } from '../src/companion-name-safety-runner.ts';
import { expectedSafetyProfileDigests, parseSafetyDetectorProfile } from '../src/safety-detector-profile.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';

// Real isolated PostgreSQL and actual source/application/selection services.
// All inputs and review statements are fictional QA fixtures; they establish
// neither clinical/vocabulary review nor approval to launch the product.
// Both actual preview and full-L0 classifier I/O go to this owned loopback SSE
// server. No arbitrary SQL provenance or caller-supplied model result is used.
type Fixture = Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
type Ready = Awaited<ReturnType<Fixture['ready']>>;
let fixture: Fixture;
const profileContent = { schemaVersion: 1, revision: 94,
  instructions: 'Fictional birth identity QA. Classify synthetic examples only.',
  algorithm: 'literal_substring_v1', lexicon: [
    { id: 'en-low', language: 'en', level: 'L1', phrases: ['Synthetic low marker'] },
    { id: 'zh-low', language: 'zh', level: 'L1', phrases: ['虚构低风险标记'] },
    { id: 'en-high', language: 'en', level: 'L2', phrases: ['Synthetic high marker'] },
    { id: 'zh-high', language: 'zh', level: 'L2', phrases: ['虚构高风险标记'] },
  ], mergeRule: 'highest_level', fallbackNoHit: 'unavailable',
  review: { reference: 'fictional-birth-identity-review-not-clinical-approval', approvedAt: '2026-10-07T00:00:00.000Z' } };
const profile = parseSafetyDetectorProfile({ ...profileContent, ...expectedSafetyProfileDigests(profileContent) });
const providerEnv = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-loopback-only',
  OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model', OPENAI_SAFETY_CLASSIFY_MODEL: 'fictional-name-safety' };
const preview = { summary: '说话简短，先把下一步理清楚。',
  samples: ['可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。'] };
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
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
async function applyName(f: Ready, runtime: PlatformProviderRuntime, name = 'Juno', expectedEntryRevision = 0, expectedIdentityRevision = 0) {
  const submitted = await f.safety.submit(f.who, { taskId: f.prepared.taskId, operationId: randomUUID(),
    name, expectedEntryRevision, expectedIdentityRevision });
  const target = { taskId: f.prepared.taskId, submissionId: submitted.submissionId };
  const runner = new CompanionNameSafetyRunner(f.safety, { modelRoutes: { safety_classify: { provider: 'openai' } }, safetyDailyModelCallLimit: 10 }, runtime, profile);
  await runner.runSubmission(f.who, target);
  const applied = await f.safety.apply(f.who, target);
  assert.equal(applied.status, 'applied'); assert.equal(applied.appliedIdentityRevision, expectedIdentityRevision + 1);
  const identity = await f.names.read(f.who, { taskId: f.prepared.taskId }); assert(identity);
  return { submissionId: submitted.submissionId, identity };
}
async function named(runtime: PlatformProviderRuntime) {
  const f = await fixture.ready(runtime), saved = await applyName(f, runtime);
  return { ...f, ...saved };
}
async function selected(runtime: PlatformProviderRuntime) {
  const f = await named(runtime), sealChar = f.identity.sealCandidates[0].char;
  const selection = await f.names.saveSelection(f.who, { taskId: f.prepared.taskId, expectedIdentityRevision: f.identity.revision,
    expectedRevision: 0, operationId: randomUUID(), sealChar });
  return { ...f, selection, request: Object.freeze({ name: f.identity.name, sealChar }) };
}
function capture(f: Ready, request: Readonly<CompanionBirthRequest>, who: FixedSessionContext = f.who, taskId = f.prepared.taskId) {
  return fixture.db.withBoundedTransaction(client => f.names.captureBirthSelectionInTransaction(client, who, { taskId, request }));
}
const tables = ['platform_onboarding_drafts', 'platform_onboarding_operations', 'platform_companions', 'platform_companion_answers',
  'platform_companion_generation_tasks', 'platform_companion_generation_calls', 'platform_companion_revisions', 'platform_companion_name_entries',
  'platform_companion_name_submissions', 'platform_companion_identity_drafts', 'platform_companion_identity_operations',
  'platform_companion_identity_selections', 'platform_companion_identity_selection_operations', 'platform_companion_name_identity_receipts',
  'platform_companion_name_identity_provenance', 'platform_safety_model_usage', 'platform_cost_reservations', 'platform_cost_ledger',
  'platform_runtime_leases', 'platform_companion_birth_receipts', 'platform_companion_birth_assets', 'platform_conversations', 'platform_memories', 'platform_jobs'] as const;
async function snapshot(who: FixedSessionContext, client: Pick<Fixture['db'], 'query'> = fixture.db) {
  const saved: Record<string, unknown> = {};
  for (const table of tables) saved[table] = (await client.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY to_jsonb(${table})::text`, [who.userId])).rows;
  saved.messages = (await client.query('SELECT m.* FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id WHERE c.user_id=$1 ORDER BY m.id', [who.userId])).rows;
  return saved;
}
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value)); for (const item of Object.values(value)) frozen(item);
}
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const rollback = new Error('Fictional birth identity mutation rollback.');
/** Perturb sources in the SAME real transaction, require actual capture to
 * reject without modifying those sources, then roll back and prove the original
 * database snapshot is preserved. No repair, fake approval or bypass is used. */
async function rejectedMutation(f: Awaited<ReturnType<typeof selected>>, mutate: (client: PoolClient) => Promise<unknown>, expected = code('COMPANION_IDENTITY_UNAVAILABLE')) {
  const original = await snapshot(f.who);
  await assert.rejects(fixture.db.withBoundedTransaction(async client => {
    await mutate(client); const before = await snapshot(f.who, client);
    await assert.rejects(f.names.captureBirthSelectionInTransaction(client, f.who, { taskId: f.prepared.taskId, request: f.request }), expected);
    assert.deepEqual(await snapshot(f.who, client), before); throw rollback;
  }), error => error === rollback);
  assert.deepEqual(await snapshot(f.who), original);
}

test('birth capture binds real classified name, current explicit selection, current review and canonical authenticated plaintext without side effects', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await selected(runtime), before = await snapshot(f.who), result = await capture(f, f.request); frozen(result);
    const identity = (await fixture.db.query('SELECT * FROM platform_companion_identity_drafts WHERE user_id=$1', [f.who.userId])).rows[0];
    const selection = (await fixture.db.query('SELECT * FROM platform_companion_identity_selections WHERE user_id=$1', [f.who.userId])).rows[0];
    const operation = (await fixture.db.query('SELECT * FROM platform_companion_identity_selection_operations WHERE user_id=$1', [f.who.userId])).rows[0];
    const provenance = (await fixture.db.query('SELECT * FROM platform_companion_name_identity_provenance WHERE user_id=$1', [f.who.userId])).rows[0];
    assert.deepEqual(result, { identityDraftId: identity.id, companionId: f.prepared.companionId, taskId: f.prepared.taskId,
      identityRevision: 1, name: 'Juno', nameOrigin: 'user_typed', sealChar: f.request.sealChar,
      sealCandidates: f.identity.sealCandidates, inkToken: f.identity.inkToken,
      selectionId: selection.id, selectionOperationId: operation.operation_id, selectionRevision: 1,
      nameApplicationOperationId: provenance.operation_id, nameSubmissionId: f.submissionId, nameGeneration: provenance.generation,
      bundleRevision: f.authority.asset.revision, contentDigest: f.authority.asset.contentDigest, reviewDigest: f.authority.review.reviewDigest,
      identityPayloadDigest: digest(fixture.crypto.openUtf8(identity.payload_ciphertext, { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext', rowId: identity.id, ownerId: f.who.userId, revision: 1 })),
      selectionPayloadDigest: digest(fixture.crypto.openUtf8(selection.payload_ciphertext, { table: 'platform_companion_identity_selections', column: 'payload_ciphertext', rowId: selection.id, ownerId: f.who.userId, revision: 1 })),
      selectionOperationPayloadDigest: digest(fixture.crypto.openUtf8(operation.request_ciphertext, { table: 'platform_companion_identity_selection_operations', column: 'request_ciphertext', rowId: operation.operation_id, ownerId: f.who.userId, revision: 1 })) });
    assert.deepEqual(await capture(f, f.request), result); assert.deepEqual(await snapshot(f.who), before);
    assert.equal(bodies.length, 2); assert.deepEqual(before.platform_companion_birth_receipts, []);
    for (const table of ['platform_companion_birth_assets', 'platform_conversations', 'messages', 'platform_memories', 'platform_jobs']) assert.deepEqual(before[table], []);
    for (const key of ['bornAt', 'active', 'canBirth', 'chatReady', 'authVersion', 'provider', 'model', 'voice']) assert.equal(Object.hasOwn(result, key), false);
  });
});

test('a syntactically valid direct identity write cannot substitute for the actual full-L0 name application and receipt', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime), identity = (await f.names.save(f.who, { taskId: f.prepared.taskId, expectedRevision: 0, operationId: randomUUID(), name: 'Juno' })).draft;
    const sealChar = identity.sealCandidates[0].char;
    await f.names.saveSelection(f.who, { taskId: f.prepared.taskId, expectedIdentityRevision: 1, expectedRevision: 0, operationId: randomUUID(), sealChar });
    const before = await snapshot(f.who);
    await assert.rejects(capture(f, { name: 'Juno', sealChar }), code('COMPANION_IDENTITY_UNAVAILABLE'));
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 1);
  });
});

test('birth capture requires a saved name and explicit current seal and never silently selects an available candidate', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await fixture.ready(runtime);
    await assert.rejects(capture(f, { name: 'Juno', sealChar: '如' }), code('COMPANION_IDENTITY_REQUIRED'));
    const { identity } = await applyName(f, runtime), before = await snapshot(f.who);
    for (const candidate of identity.sealCandidates) await assert.rejects(capture(f, { name: identity.name, sealChar: candidate.char }), code('COMPANION_SEAL_SELECTION_REQUIRED'));
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 2);
  });
});

test('a genuinely changed name invalidates the old selection and a genuinely changed selection cannot replay the old seal request', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await selected(runtime), original = await capture(f, f.request);
    const replacement = await applyName(f, runtime, '舟', 1, 1), request = { name: replacement.identity.name, sealChar: replacement.identity.sealCandidates[0].char };
    await assert.rejects(capture(f, f.request), code('COMPANION_IDENTITY_REVISION_CHANGED'));
    await assert.rejects(capture(f, request), code('COMPANION_SEAL_SELECTION_REQUIRED'));
    const selectedAgain = await f.names.saveSelection(f.who, { taskId: f.prepared.taskId, expectedIdentityRevision: 2, expectedRevision: 1, operationId: randomUUID(), sealChar: request.sealChar });
    const current = await capture(f, request);
    assert.equal(current.identityDraftId, original.identityDraftId); assert.equal(current.identityRevision, 2); assert.equal(current.selectionRevision, 2);
    assert.equal(current.nameSubmissionId, replacement.submissionId); assert.equal(current.selectionOperationId, selectedAgain.operation.id);
    assert.notEqual(current.identityPayloadDigest, original.identityPayloadDigest); assert.notEqual(current.selectionPayloadDigest, original.selectionPayloadDigest);
    const nextSeal = replacement.identity.sealCandidates.find(candidate => candidate.char !== request.sealChar)!;
    await f.names.saveSelection(f.who, { taskId: f.prepared.taskId, expectedIdentityRevision: 2, expectedRevision: 2, operationId: randomUUID(), sealChar: nextSeal.char });
    const before = await snapshot(f.who);
    await assert.rejects(capture(f, request), code('SEAL_REJECTED'));
    const next = await capture(f, { name: request.name, sealChar: nextSeal.char });
    assert.equal(next.identityRevision, 2); assert.equal(next.selectionRevision, 3); assert.equal(next.identityPayloadDigest, current.identityPayloadDigest);
    assert.notEqual(next.selectionOperationPayloadDigest, current.selectionOperationPayloadDigest);
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 3);
  });
});

test('historically reviewed identity and seal cannot bypass missing, mismatched, revoked or future current review authority', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await selected(runtime); await capture(f, f.request);
    const mutations: Array<(client: PoolClient) => Promise<unknown>> = [
      client => client.query('DELETE FROM platform_companion_identity_policy'),
      client => client.query('UPDATE platform_companion_identity_policy SET review_digest=$1', ['0'.repeat(64)]),
      client => client.query("UPDATE platform_companion_identity_policy SET activated_at=clock_timestamp()+interval '1 day'"),
      client => client.query("UPDATE platform_orgs SET status='disabled' WHERE id=$1", [f.authority.orgId]),
      client => client.query("UPDATE platform_users SET account_kind='student' WHERE id=$1", [f.authority.reviewer.userId]),
      client => client.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2 AND role='content_reviewer'", [f.authority.orgId, f.authority.reviewer.userId]),
      client => client.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2 AND role='ops'", [f.authority.orgId, f.authority.operator.userId]),
    ];
    for (const mutate of mutations) await rejectedMutation(f, mutate);
    const disabled = new CompanionIdentityDrafts(fixture.db, fixture.config, FICTIONAL_LEGAL, f.background, null, null), before = await snapshot(f.who);
    await assert.rejects(fixture.db.withBoundedTransaction(client => disabled.captureBirthSelectionInTransaction(client, f.who, { taskId: f.prepared.taskId, request: f.request })), code('COMPANION_IDENTITY_UNAVAILABLE'));
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 2);
  });
});

test('capture revalidates the current account name instead of only the historical name at save', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await selected(runtime); await capture(f, f.request);
    await rejectedMutation(f, client => client.query('UPDATE platform_users SET name=$2 WHERE id=$1', [f.who.userId, f.identity.name]), code('NAME_REJECTED'));
    assert.equal(bodies.length, 2);
  });
});

test('corrupted authenticated identity, selection, selection operation or actual name provenance fails without repairing evidence', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await selected(runtime); await capture(f, f.request);
    const sources = [
      ['platform_companion_identity_drafts', 'payload_ciphertext'],
      ['platform_companion_identity_selections', 'payload_ciphertext'],
      ['platform_companion_identity_selection_operations', 'request_ciphertext'],
      ['platform_companion_identity_operations', 'request_ciphertext'],
      ['platform_companion_name_identity_receipts', 'payload_ciphertext'],
      ['platform_companion_name_identity_provenance', 'payload_ciphertext'],
    ] as const;
    for (const [table, column] of sources) await rejectedMutation(f, async client => {
      const rows = (await client.query(`SELECT ${column} AS ciphertext FROM ${table} WHERE user_id=$1`, [f.who.userId])).rows;
      assert.equal(rows.length, 1); const corrupt = Buffer.from(rows[0].ciphertext); corrupt[corrupt.length - 1] ^= 1;
      return client.query(`UPDATE ${table} SET ${column}=$2 WHERE user_id=$1`, [f.who.userId, corrupt]);
    });
    assert.equal(bodies.length, 2);
  });
});

test('foreign task, foreign session and same-name foreign ciphertext cannot be used as the current owner identity', async () => {
  await loopback(async (runtime, bodies) => {
    const other = await selected(runtime), foreign = (await fixture.db.query('SELECT * FROM platform_companion_identity_drafts WHERE user_id=$1', [other.who.userId])).rows[0];
    // ready() activates the next fictional policy. The owner below is created
    // last so only its genuine current review is in force during these probes.
    const f = await selected(runtime), before = await snapshot(f.who), foreignBefore = await snapshot(other.who);
    await assert.rejects(capture(f, f.request, f.who, other.prepared.taskId), code('NOT_FOUND'));
    await assert.rejects(capture(f, f.request, other.who), code('NOT_FOUND'));
    await assert.rejects(capture(f, f.request, { userId: f.who.userId, tokenHash: other.who.tokenHash }), code('AUTH_REQUIRED'));
    await rejectedMutation(f, client => client.query('UPDATE platform_companion_identity_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [f.who.userId, foreign.payload_ciphertext]));
    assert.deepEqual(await snapshot(f.who), before); assert.deepEqual(await snapshot(other.who), foreignBefore); assert.equal(bodies.length, 4);
  });
});

test('capture observes actual current session, student, verification and consent gates without launching another model', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await selected(runtime); await capture(f, f.request);
    const modes: Array<readonly [(client: PoolClient) => Promise<unknown>, string]> = [
      [client => client.query('DELETE FROM platform_sessions WHERE token_hash=$1', [f.who.tokenHash]), 'AUTH_REQUIRED'],
      [client => client.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [f.who.tokenHash]), 'AUTH_REQUIRED'],
      [client => client.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [f.who.userId]), 'AUTH_REQUIRED'],
      [client => client.query("UPDATE platform_users SET account_kind='staff' WHERE id=$1", [f.who.userId]), 'STUDENT_ACCOUNT_REQUIRED'],
      [client => client.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [f.who.userId]), 'EMAIL_VERIFICATION_REQUIRED'],
      [client => client.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [f.who.userId]), 'TERMS_CONFIRMATION_REQUIRED'],
    ];
    for (const [mutate, expected] of modes) await rejectedMutation(f, mutate, code(expected));
    assert.equal(bodies.length, 2);
  });
});

test('plaintext fingerprints remain stable when the same authenticated source is resealed with a fresh IV', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await selected(runtime), original = await capture(f, f.request), before = await snapshot(f.who);
    await assert.rejects(fixture.db.withBoundedTransaction(async client => {
      const row = (await client.query('SELECT * FROM platform_companion_identity_selections WHERE user_id=$1', [f.who.userId])).rows[0];
      const binding = { table: 'platform_companion_identity_selections', column: 'payload_ciphertext', rowId: row.id, ownerId: f.who.userId, revision: row.revision };
      const text = fixture.crypto.openUtf8(row.payload_ciphertext, binding), ciphertext = fixture.crypto.sealUtf8(text, binding);
      assert.notDeepEqual(ciphertext, row.payload_ciphertext);
      await client.query('UPDATE platform_companion_identity_selections SET payload_ciphertext=$2 WHERE user_id=$1', [f.who.userId, ciphertext]);
      assert.deepEqual(await f.names.captureBirthSelectionInTransaction(client, f.who, { taskId: f.prepared.taskId, request: f.request }), original);
      throw rollback;
    }), error => error === rollback);
    assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 2);
  });
});

test('closed birth capture inputs reject caller authority and accessors before source observation', async () => {
  await loopback(async (runtime, bodies) => {
    const f = await selected(runtime), before = await snapshot(f.who), input = { taskId: f.prepared.taskId, request: f.request }; let accessed = 0;
    const getter = { ...input }; Object.defineProperty(getter, 'request', { enumerable: true, get() { accessed++; return f.request; } });
    for (const value of [getter, { ...input, source: {} }, { ...input, [Symbol('review')]: true }, { ...input, taskId: input.taskId + '\n' },
      { ...input, request: { ...f.request, userId: f.who.userId } }, { ...input, request: { ...f.request, sealChar: '墨如' } }]) {
      await assert.rejects(fixture.db.withBoundedTransaction(client => f.names.captureBirthSelectionInTransaction(client, f.who, value)), code('INVALID_INPUT'));
    }
    assert.equal(accessed, 0); assert.deepEqual(await snapshot(f.who), before); assert.equal(bodies.length, 2);
  });
});
