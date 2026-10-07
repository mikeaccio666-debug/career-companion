import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import { companionSealCandidates } from '@companion/career-core';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { CompanionDraftPreparation } from '../src/companion-draft-preparation.ts';
import { BackgroundGeneration } from '../src/background-generation.ts';
import { CompanionIdentityDrafts } from '../src/companion-identity-drafts.ts';
import { expectedCompanionIdentityBundleDigest, parseCompanionIdentityBundle, type CompanionIdentityBundle } from '../src/companion-identity-bundle.ts';
import { expectedCompanionIdentityReviewDigest, parseCompanionIdentityReview, type CompanionIdentityReview } from '../src/companion-identity-review.ts';
import { requireModelConsent } from '../src/model-consent.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Fictional loopback HTTP plus a fresh actual PostgreSQL schema. These fixtures
// assert persistence and authority behavior, never vocabulary or launch review.
const base = readConfig(), schema = 'companion_identity_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use only loopback PostgreSQL.');
assert.notEqual(url.port, '5442', 'Use the isolated identity verification server.');
url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString());
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: 'd4'.repeat(32) })!;
const config = { dataCrypto: crypto, requireVerifiedEmail: true,
  modelRoutes: { chat: { provider: 'openai' }, companion_generation: { provider: 'openai' } } };
const store = new OnboardingDrafts(db, config, FICTIONAL_LEGAL);
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const validPreview = { summary: '说话简短，先把下一步理清楚。', samples: ['可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。'] };
let created = false;
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); created = true;
  await db.migrate(); await seedFictionalActiveLegal(db);
  const approver = await actor(true);
  await db.query(`INSERT INTO platform_cost_global_policy(singleton,month_hard_micros,day_hard_micros,approved_by,approved_at,effective_from)
    VALUES(true,100000000,100000000,$1,clock_timestamp(),clock_timestamp())`, [approver.userId]);
  for (const [unit, price] of [['input_token', '1'], ['output_token', '2']]) await db.query(`INSERT INTO platform_model_prices
    (id,provider,model,capability,unit,micros_per_unit,effective_from) VALUES($1,'openai','fictional-companion-model','background',$2,$3,clock_timestamp())`,
  [randomUUID(), unit, price]);
});
after(async () => {
  try { await db.close(); }
  finally { try {
    if (created) { await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
      process.stdout.write(`Identity fixture schema cleanup confirmed: ${schema}\n`); }
  } finally { await admin.close(); } }
});
async function actor(staff = false, name = 'Fictional owner'): Promise<FixedSessionContext> {
  const userId = randomUUID(), hash = tokenHash(randomUUID());
  await db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,$3,'fictional-unused-hash',$4,clock_timestamp())`, [userId, userId + '@example.invalid', name, staff ? 'staff' : 'student']);
  await db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, hash]);
  await seedFictionalConsent(db, userId); return { userId, tokenHash: hash };
}
async function loopback(run: (runtime: PlatformProviderRuntime, bodies: Record<string, any>[]) => Promise<void>) {
  const bodies: Record<string, any>[] = []; let failure: unknown;
  const server = http.createServer(async (request, reply) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
      assert.equal(body.store, false); assert.deepEqual(body.tools ?? [], []);
      const event = { type: 'response.completed', response: { status: 'completed',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(validPreview) }] }],
        usage: { input_tokens: 34, output_tokens: 21 } } };
      reply.writeHead(200, { 'content-type': 'text/event-stream' }); reply.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    } catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const runtime = requireModelConsent(createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1',
    OPENAI_API_KEY: 'fictional-loopback-only', OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model' }, fetch: (target, init) => {
    const remote = new URL(String(target)); assert.equal(remote.origin, 'https://api.openai.com'); assert.equal(remote.pathname, '/v1/responses');
    return fetch(`http://127.0.0.1:${address.port}${remote.pathname}`, init);
  } }));
  try { await run(runtime, bodies); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function ready(runtime: PlatformProviderRuntime, options: { generate?: boolean; name?: string; text?: boolean } = {}) {
  const who = await actor(false, options.name), approver = await actor(true);
  await db.query(`INSERT INTO platform_cost_user_policy(user_id,policy_key,period,soft_behavior,soft_micros,hard_micros,approved_by,approved_at,effective_from)
    VALUES($1,'fictional-identity-preview','week','notify',1,100000000,$2,clock_timestamp(),clock_timestamp())`, [who.userId, approver.userId]);
  let draft = (await store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'fast_track' } })).draft;
  let textId: string | undefined;
  if (options.text) {
    textId = randomUUID();
    draft = (await store.save(who, { expectedRevision: draft.revision, operationId: textId,
      action: { kind: 'text', questionId: 'study', text: 'Fictional coursework note.' } })).draft;
    const claim = await store.claimSafety(who, { detectorRevision: 71 }); assert(claim);
    await store.processSafety(claim, async (_input, admission) => admission(async signal => {
      signal.throwIfAborted(); return { level: 'L0', mode: 'full', resolution: { kind: 'unmatched' } };
    })); draft = (await store.read(who))!;
  }
  while (draft.currentQuestion) draft = (await store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(),
    action: { kind: 'skip', questionId: draft.currentQuestion } })).draft;
  const prepared = await new CompanionDraftPreparation(db, config, FICTIONAL_LEGAL, runtime).prepare(who, { expectedRevision: draft.revision });
  const background = new BackgroundGeneration(db, config, FICTIONAL_LEGAL, runtime);
  if (options.generate !== false) await background.generate(who, { taskId: prepared.taskId });
  return { who, prepared, background, textId };
}
function bundle(revision = 7): Readonly<CompanionIdentityBundle> {
  const content = { schemaVersion: 1, revision, sourceRefs: { names: 'https://example.invalid/fictional-names',
    seals: 'https://example.invalid/fictional-seals', aliases: 'https://example.invalid/fictional-aliases' },
  policy: { familyOrPartner: ['伙伴甲'], teamOrOrg: ['角色甲'], abusive: ['坏词甲'], publicFigures: ['公众甲'],
    allowedSealCharacters: ['墨', '如', '舟', '远', '暖', '灯', '稳', '拾', '启', '朗'], englishSealAliases: [{ name: 'Juno', sealChar: '如' }] } };
  return parseCompanionIdentityBundle({ ...content, contentDigest: expectedCompanionIdentityBundleDigest(content) });
}
async function authority(asset = bundle()) {
  const reviewer = await actor(true), operator = await actor(true), orgId = randomUUID();
  await db.query("INSERT INTO platform_orgs(id,slug,display_name,status) VALUES($1,$2,'Fictional identity fixture','active')", [orgId, 'identity_' + orgId.replaceAll('-', '')]);
  for (const [user, role] of [[reviewer.userId, 'content_reviewer'], [operator.userId, 'ops']]) await db.query(`INSERT INTO platform_org_roles
    (org_id,user_id,role,status,granted_by,granted_at) VALUES($1,$2,$3,'active',$4,clock_timestamp())`, [orgId, user, role, operator.userId]);
  // This tiny pool and review statement are fictional test assets, not a
  // reviewed complete level-one domain or an approval for student use.
  const content = { schemaVersion: 1, bundleRevision: asset.revision, bundleDigest: asset.contentDigest,
    coverage: 'complete_eligible_level_one', reviewerUserId: reviewer.userId, reviewedAt: '2026-10-01T12:34:56.789Z',
    reviewEvidenceRef: 'https://example.invalid/fictional-identity-review', tierOneSourceRef: 'https://example.invalid/fictional-tier-one' };
  const review = parseCompanionIdentityReview({ ...content, reviewDigest: expectedCompanionIdentityReviewDigest(content) });
  await db.query(`INSERT INTO platform_companion_identity_policy(singleton,revision,content_digest,review_digest,reviewed_by,org_id,activated_by,activated_at)
    VALUES(true,$1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,
    content_digest=EXCLUDED.content_digest,review_digest=EXCLUDED.review_digest,reviewed_by=EXCLUDED.reviewed_by,org_id=EXCLUDED.org_id,
    activated_by=EXCLUDED.activated_by,activated_at=EXCLUDED.activated_at`, [asset.revision, asset.contentDigest, review.reviewDigest, reviewer.userId, orgId, operator.userId]);
  return { asset, review, reviewer, operator, orgId };
}
function service(background: BackgroundGeneration, asset: CompanionIdentityBundle | null, review: CompanionIdentityReview | null, database: Database = db) {
  return new CompanionIdentityDrafts(database, config, FICTIONAL_LEGAL, background, asset, review);
}

async function state(who: FixedSessionContext) {
  const intakeDrafts = await db.query('SELECT * FROM platform_onboarding_drafts WHERE user_id=$1 ORDER BY id', [who.userId]);
  const intakeOperations = await db.query('SELECT * FROM platform_onboarding_operations WHERE user_id=$1 ORDER BY operation_id', [who.userId]);
  const drafts = await db.query('SELECT * FROM platform_companion_identity_drafts WHERE user_id=$1 ORDER BY id', [who.userId]);
  const operations = await db.query('SELECT * FROM platform_companion_identity_operations WHERE user_id=$1 ORDER BY operation_id', [who.userId]);
  const selections = await db.query('SELECT * FROM platform_companion_identity_selections WHERE user_id=$1 ORDER BY id', [who.userId]);
  const selectionOperations = await db.query('SELECT * FROM platform_companion_identity_selection_operations WHERE user_id=$1 ORDER BY operation_id', [who.userId]);
  const effects = (await db.query(`SELECT
    (SELECT count(*)::int FROM platform_conversations WHERE user_id=$1) AS rooms,
    (SELECT count(*)::int FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id WHERE c.user_id=$1) AS messages,
    (SELECT count(*)::int FROM platform_memories WHERE user_id=$1) AS memories,
    (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs,
    (SELECT count(*)::int FROM platform_chat_calls WHERE user_id=$1) AS chat_calls,
    (SELECT count(*)::int FROM platform_runtime_leases WHERE user_id=$1) AS leases,
    (SELECT count(*)::int FROM platform_cost_ledger WHERE user_id=$1) AS costs`, [who.userId])).rows[0];
  const companions = (await db.query('SELECT * FROM platform_companions WHERE user_id=$1', [who.userId])).rows;
  return { intakeDrafts: intakeDrafts.rows, intakeOperations: intakeOperations.rows, drafts: drafts.rows, operations: operations.rows,
    selections: selections.rows, selectionOperations: selectionOperations.rows, effects, companions };
}
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value)); for (const item of Object.values(value)) frozen(item);
}
function command(taskId: string, expectedRevision = 0, name = 'Juno') { return { taskId, expectedRevision, operationId: randomUUID(), name }; }
function selectionCommand(taskId: string, sealChar: string, expectedIdentityRevision = 1, expectedRevision = 0) {
  return { taskId, expectedIdentityRevision, expectedRevision, operationId: randomUUID(), sealChar };
}
async function named(runtime: PlatformProviderRuntime, options: { text?: boolean } = {}) {
  const readyState = await ready(runtime, options), auth = await authority(), names = service(readyState.background, auth.asset, auth.review);
  const identity = await names.save(readyState.who, command(readyState.prepared.taskId));
  return { ...readyState, auth, names, identity: identity.draft };
}
class QueryGateDatabase extends Database {
  constructor(private readonly gate: (client: PoolClient, text: string, values: unknown) => Promise<void>) { super(url.toString()); }
  override withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}): Promise<T> {
    return super.withBoundedTransaction(client => run(new Proxy(client, { get: (target, key) => {
      if (key === 'query') return async (...args: unknown[]) => {
        await this.gate(target, typeof args[0] === 'string' ? args[0] : '', args[1]);
        return Reflect.apply(target.query, target, args);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } })), options);
  }
}
class BeforeCommitDatabase extends Database {
  constructor(private readonly beforeCommit: (client: PoolClient) => Promise<void>) { super(url.toString()); }
  override withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}): Promise<T> {
    return super.withBoundedTransaction(async client => { const result = await run(client); await this.beforeCommit(client); return result; }, options);
  }
}

test('completed actual preview supports one private immutable name draft with no birth or extra model work', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), names = service(background, auth.asset, auth.review);
    assert.equal(await names.read(who, { taskId: prepared.taskId }), null);
    const input = command(prepared.taskId), result = await names.save(who, input), saved = await state(who); frozen(result);
    assert.equal(result.draft.name, 'Juno'); assert.equal(result.draft.nameOrigin, 'user_typed'); assert.equal(result.draft.revision, 1);
    assert.equal(result.draft.companionId, prepared.companionId); assert.equal(result.draft.sealCandidates.length, 3);
    assert.equal(new Set(result.draft.sealCandidates.map(item => item.char)).size, 3); assert.equal(result.draft.sealCandidates[0].char, '如');
    assert.deepEqual(result.operation, { id: input.operationId, appliedRevision: 1, replayed: false });
    assert.deepEqual(await names.read(who, { taskId: prepared.taskId }), result.draft);
    assert.equal(bodies.length, 1); assert.equal(saved.drafts.length, 1); assert.equal(saved.operations.length, 1);
    assert.deepEqual(saved.effects, { rooms: 0, messages: 0, memories: 0, jobs: 0, chat_calls: 0, leases: 0, costs: 1 });
    assert.equal(saved.companions[0].status, 'awaiting_name'); assert.equal(saved.companions[0].draft_rerolls, 0);
    const row = saved.drafts[0], binding = { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext', rowId: row.id, ownerId: who.userId, revision: 1 };
    const text = crypto.openUtf8(row.payload_ciphertext, binding), data = JSON.parse(text);
    assert.equal(data.name, 'Juno'); assert.equal(data.userNameAtSave, 'Fictional owner'); assert.equal(data.source.taskId, prepared.taskId);
    assert.equal(row.payload_ciphertext.includes(Buffer.from('"name":"Juno"')), false);
    assert.equal(saved.operations[0].request_ciphertext.includes(Buffer.from('"name":"Juno"')), false);
    for (const altered of [{ ...binding, ownerId: randomUUID() }, { ...binding, rowId: randomUUID() }, { ...binding, revision: 2 }]) assert.throws(() => crypto.openUtf8(row.payload_ciphertext, altered));
    for (const key of ['selectedSeal', 'sealChar', 'bornAt', 'provider', 'model', 'cost', 'source', 'userNameAtSave']) assert.equal(Object.hasOwn(result.draft, key), false);
  });
});

test('a pending actual generation task cannot substitute for a completed preview', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime, { generate: false }), auth = await authority();
    await assert.rejects(service(background, auth.asset, auth.review).save(who, command(prepared.taskId)), code('COMPANION_PREVIEW_REQUIRED'));
    assert.equal(bodies.length, 0); assert.equal((await state(who)).drafts.length, 0);
  });
});

test('new naming requires configured matching actual staff organization authority at the database time', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime);
    for (const mode of ['missing_bundle', 'missing_review', 'missing_policy', 'mismatch', 'revoked', 'disabled_org', 'student_reviewer', 'future'] as const) {
      const auth = await authority();
      if (mode === 'missing_policy') await db.query('DELETE FROM platform_companion_identity_policy');
      if (mode === 'mismatch') await db.query("UPDATE platform_companion_identity_policy SET content_digest=$1", ['0'.repeat(64)]);
      if (mode === 'revoked') await db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2", [auth.orgId, auth.reviewer.userId]);
      if (mode === 'disabled_org') await db.query("UPDATE platform_orgs SET status='disabled' WHERE id=$1", [auth.orgId]);
      if (mode === 'student_reviewer') await db.query("UPDATE platform_users SET account_kind='student' WHERE id=$1", [auth.reviewer.userId]);
      if (mode === 'future') await db.query("UPDATE platform_companion_identity_policy SET activated_at=clock_timestamp()+interval '1 hour'");
      const before = await state(who);
      await assert.rejects(service(background, mode === 'missing_bundle' ? null : auth.asset, mode === 'missing_review' ? null : auth.review)
        .save(who, command(prepared.taskId)), code('COMPANION_IDENTITY_UNAVAILABLE'));
      assert.deepEqual(await state(who), before);
    }
    assert.equal(bodies.length, 1);
  });
});

test('all name categories use the actual account name and unknown English aliases remain unavailable', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime, { name: 'Juno' }), auth = await authority(), names = service(background, auth.asset, auth.review);
    for (const [name, category] of [['妈妈', 'family_or_partner'], ['导师', 'team_or_org'], ['jUnO', 'same_as_user'],
      ['坏词甲', 'abusive'], ['公众甲', 'public_figure'], ['一二三四五六七', 'length']]) {
      await assert.rejects(names.save(who, command(prepared.taskId, 0, name)), error => error instanceof ApiError
        && error.status === 422 && error.code === 'NAME_REJECTED' && 'category' in error && error.category === category && !error.message.includes(name));
    }
    await assert.rejects(names.save(who, command(prepared.taskId, 0, 'Unmapped')), code('SEAL_CANDIDATES_UNAVAILABLE'));
    assert.equal((await state(who)).operations.length, 0); assert.equal(bodies.length, 1);
  });
});

test('concurrent identical operations commit once and old replay returns the current draft with its original revision', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), names = service(background, auth.asset, auth.review), input = command(prepared.taskId);
    const results = await Promise.all([names.save(who, input), names.save(who, input), names.save(who, input)]);
    assert.equal(results.filter(item => !item.operation.replayed).length, 1); assert(results.every(item => item.draft.revision === 1));
    let captured = await state(who); assert.equal(captured.drafts.length, 1); assert.equal(captured.operations.length, 1);
    await assert.rejects(names.save(who, command(prepared.taskId, 0, '墨')), code('COMPANION_IDENTITY_REVISION_CHANGED'));
    assert.deepEqual(await state(who), captured);
    const next = await names.save(who, command(prepared.taskId, 1, '舟')); assert.equal(next.draft.revision, 2); assert.equal(next.draft.name, '舟');
    const replay = await names.save(who, input); assert.deepEqual(replay.draft, next.draft);
    assert.deepEqual(replay.operation, { id: input.operationId, appliedRevision: 1, replayed: true });
    captured = await state(who); assert.equal(captured.operations.length, 2); assert.equal(captured.companions[0].draft_rerolls, 0); assert.equal(bodies.length, 1);
  });
});

test('concurrent different names at the same revision have one accepted writer', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), names = service(background, auth.asset, auth.review);
    const results = await Promise.allSettled([names.save(who, command(prepared.taskId, 0, '墨')), names.save(who, command(prepared.taskId, 0, '舟'))]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    const denied = results.find(item => item.status === 'rejected'); assert(denied?.status === 'rejected'); assert(code('COMPANION_IDENTITY_REVISION_CHANGED')(denied.reason));
    assert.equal((await state(who)).operations.length, 1); assert.equal(bodies.length, 1);
  });
});

test('same operation cannot replace the displayed spelling even when vocabulary comparison normalizes it', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), names = service(background, auth.asset, auth.review), input = command(prepared.taskId);
    await names.save(who, input); const captured = await state(who);
    for (const name of ['juno', 'Ｊｕｎｏ']) await assert.rejects(names.save(who, { ...input, name }), code('COMPANION_IDENTITY_OPERATION_CONFLICT'));
    assert.deepEqual(await state(who), captured); assert.equal(bodies.length, 1);
  });
});

test('historical account spelling is preserved while new writes validate the current real account name', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), names = service(background, auth.asset, auth.review), input = command(prepared.taskId);
    const first = await names.save(who, input); await db.query("UPDATE platform_users SET name='Juno' WHERE id=$1", [who.userId]);
    const captured = await state(who);
    assert.deepEqual(await names.read(who, { taskId: prepared.taskId }), first.draft);
    assert.deepEqual((await names.save(who, input)).draft, first.draft);
    await assert.rejects(names.save(who, command(prepared.taskId, 1, 'juno')), error => error instanceof ApiError
      && error.code === 'NAME_REJECTED' && 'category' in error && error.category === 'same_as_user');
    assert.deepEqual(await state(who), captured); assert.equal(bodies.length, 1);
  });
});

test('caller supplied identity, selection and hidden getters cannot enter the closed naming command', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), names = service(background, auth.asset, auth.review), input = command(prepared.taskId);
    const captured = await state(who); let accessed = 0;
    for (const key of ['nameOrigin', 'sealChar', 'sealCandidates', 'dimensions', 'persona', 'voicePreset', 'userId'])
      await assert.rejects(names.save(who, { ...input, [key]: 'Fictional untrusted field' }), code('INVALID_INPUT'));
    const getter = { ...input }; Object.defineProperty(getter, 'name', { enumerable: true, get() { accessed++; return '舟'; } });
    await assert.rejects(names.save(who, getter), code('INVALID_INPUT')); assert.equal(accessed, 0);
    assert.deepEqual(await state(who), captured); assert.equal(bodies.length, 1);
  });
});

test('raw control characters are rejected before trimming while ordinary spaces and NFC spelling remain accepted', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), initial = bundle();
    const content = { ...initial, policy: { ...initial.policy, englishSealAliases: [...initial.policy.englishSealAliases, { name: 'José', sealChar: '如' }] } };
    const asset = parseCompanionIdentityBundle({ ...content, contentDigest: expectedCompanionIdentityBundleDigest(content) });
    const auth = await authority(asset), names = service(background, auth.asset, auth.review), captured = await state(who);
    await assert.rejects(names.save(who, command(prepared.taskId, 0, '\nJuno\t')), error => error instanceof ApiError
      && error.code === 'NAME_REJECTED' && 'category' in error && error.category === 'length');
    assert.deepEqual(await state(who), captured);
    const first = await names.save(who, command(prepared.taskId, 0, ' Juno ')); assert.equal(first.draft.name, 'Juno');
    const next = await names.save(who, command(prepared.taskId, 1, 'Jose\u0301')); assert.equal(next.draft.name, 'José');
    assert.equal(next.draft.revision, 2); assert.equal(bodies.length, 1);
  });
});

test('input and fixed identity are captured before the first asynchronous database wait', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), other = await actor();
    let entered!: () => void, resume!: () => void, held = false;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { resume = resolve; });
    const gated = new QueryGateDatabase(async () => { if (!held) { held = true; entered(); await released; } });
    try {
      const context = { ...who }, input = command(prepared.taskId), original = { ...input };
      const pending = service(background, auth.asset, auth.review, gated).save(context, input); await waiting;
      context.userId = other.userId; context.tokenHash = other.tokenHash; input.name = '舟'; input.operationId = randomUUID(); input.expectedRevision = 20; input.taskId = randomUUID(); resume();
      const saved = await pending; assert.equal(saved.draft.name, 'Juno'); assert.equal(saved.operation.id, original.operationId);
      assert.equal((await state(other)).drafts.length, 0); assert.equal(bodies.length, 1);
    } finally { resume?.(); await gated.close(); }
  });
});

test('fresh session expiry after validated source rolls back naming writes', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(); let held = false;
    const gated = new QueryGateDatabase(async (client, text) => {
      if (held || !text.startsWith('INSERT INTO platform_companion_identity_operations')) return; held = true;
      await client.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [who.tokenHash]);
    });
    try {
      const captured = await state(who);
      await assert.rejects(service(background, auth.asset, auth.review, gated).save(who, command(prepared.taskId)), code('AUTH_REQUIRED'));
      assert.equal(held, true); assert.deepEqual(await state(who), captured); assert.equal(bodies.length, 1);
    } finally { await gated.close(); }
  });
});

test('actual deferred COMMIT rejection rolls back draft, operation and new assets while keeping preview accounting', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(bundle(91)), captured = await state(who);
    const preview = await background.read(who, { taskId: prepared.taskId });
    assert.equal((await db.query('SELECT 1 FROM platform_companion_identity_assets WHERE content_digest=$1 AND review_digest=$2', [auth.asset.contentDigest, auth.review.reviewDigest])).rowCount, 0);
    await db.query(`CREATE FUNCTION identity_fixture_commit_rejection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Fictional deferred identity COMMIT rejection' USING ERRCODE='23514'; END; $$`);
    await db.query(`CREATE CONSTRAINT TRIGGER identity_fixture_commit_rejection AFTER INSERT ON platform_companion_identity_operations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity_fixture_commit_rejection()`);
    let reachedCommit = false;
    const gated = new BeforeCommitDatabase(async client => {
      const staged = (await client.query(`SELECT
        (SELECT count(*)::int FROM platform_companion_identity_drafts WHERE user_id=$1) AS drafts,
        (SELECT count(*)::int FROM platform_companion_identity_operations WHERE user_id=$1) AS operations,
        (SELECT count(*)::int FROM platform_companion_identity_assets WHERE content_digest=$2 AND review_digest=$3) AS assets`,
      [who.userId, auth.asset.contentDigest, auth.review.reviewDigest])).rows[0];
      assert.deepEqual(staged, { drafts: 1, operations: 1, assets: 1 }); reachedCommit = true;
    });
    try {
      await assert.rejects(service(background, auth.asset, auth.review, gated).save(who, command(prepared.taskId)), { code: '23514' });
      assert.equal(reachedCommit, true); assert.deepEqual(await state(who), captured);
      assert.equal((await db.query('SELECT 1 FROM platform_companion_identity_assets WHERE content_digest=$1 AND review_digest=$2', [auth.asset.contentDigest, auth.review.reviewDigest])).rowCount, 0);
      assert.deepEqual(await background.read(who, { taskId: prepared.taskId }), preview); assert.equal(bodies.length, 1);
    } finally {
      await gated.close(); await db.query('DROP TRIGGER identity_fixture_commit_rejection ON platform_companion_identity_operations');
      await db.query('DROP FUNCTION identity_fixture_commit_rejection()');
    }
  });
});

test('cancellation after final acceptance but before actual COMMIT does not pretend the accepted write was undone', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), controller = new AbortController(), input = command(prepared.taskId);
    let reachedCommit = false;
    const gated = new BeforeCommitDatabase(async client => {
      assert.equal((await client.query('SELECT 1 FROM platform_companion_identity_operations WHERE user_id=$1 AND operation_id=$2', [who.userId, input.operationId])).rowCount, 1);
      reachedCommit = true; controller.abort(new DOMException('Fictional cancellation after acceptance', 'AbortError'));
    });
    try {
      const saved = await service(background, auth.asset, auth.review, gated).save(who, input, controller.signal);
      assert.equal(reachedCommit, true); assert.equal(controller.signal.aborted, true); assert.equal(saved.operation.replayed, false);
      const current = await state(who); assert.equal(current.drafts.length, 1); assert.equal(current.drafts[0].revision, 1); assert.equal(current.operations.length, 1);
      const names = service(background, auth.asset, auth.review);
      assert.deepEqual(await names.read(who, { taskId: prepared.taskId }), saved.draft);
      const replay = await names.save(who, input); assert.deepEqual(replay.draft, saved.draft); assert.equal(replay.operation.replayed, true);
      assert.deepEqual(await state(who), current); assert.equal(bodies.length, 1);
    } finally { await gated.close(); }
  });
});

test('new legal policy or revoked session blocks private reads, replay and fresh naming', async () => {
  await loopback(async (runtime, bodies) => {
    for (const mode of ['legal', 'session'] as const) {
      const { who, prepared, background } = await ready(runtime), auth = await authority(), names = service(background, auth.asset, auth.review), input = command(prepared.taskId);
      await names.save(who, input);
      if (mode === 'legal') await db.query("UPDATE platform_terms_policy SET content_digest=$1", ['0'.repeat(64)]);
      else await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
      const captured = await state(who);
      try {
        for (const action of [() => names.read(who, { taskId: prepared.taskId }), () => names.save(who, input), () => names.save(who, command(prepared.taskId, 1, '舟'))])
          await assert.rejects(action(), code(mode === 'legal' ? 'LEGAL_DOCUMENTS_UNAVAILABLE' : 'AUTH_REQUIRED'));
        assert.deepEqual(await state(who), captured);
      } finally { if (mode === 'legal') await seedFictionalActiveLegal(db); }
    }
    assert.equal(bodies.length, 2);
  });
});

test('historical asset snapshots restore after external reconfiguration or activation deletion without granting a new write', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), names = service(background, auth.asset, auth.review), input = command(prepared.taskId);
    const first = await names.save(who, input); await authority(bundle(8));
    const unavailable = service(background, null, null);
    assert.deepEqual(await unavailable.read(who, { taskId: prepared.taskId }), first.draft);
    assert.equal((await unavailable.save(who, input)).operation.replayed, true);
    await db.query('DELETE FROM platform_companion_identity_policy');
    const captured = await state(who);
    assert.deepEqual(await unavailable.read(who, { taskId: prepared.taskId }), first.draft);
    assert.deepEqual((await names.save(who, input)).draft, first.draft);
    await assert.rejects(unavailable.save(who, command(prepared.taskId, 1, '舟')), code('COMPANION_IDENTITY_UNAVAILABLE'));
    assert.deepEqual(await state(who), captured); assert.equal(bodies.length, 1);
  });
});

test('server file loading captures immutable assets and missing or invalid current files retain historical recovery', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fictional-identity-assets-'));
    const bundlePath = path.join(directory, 'bundle.json'), reviewPath = path.join(directory, 'review.json'), input = command(prepared.taskId);
    try {
      await fs.writeFile(bundlePath, JSON.stringify(auth.asset)); await fs.writeFile(reviewPath, JSON.stringify(auth.review));
      const configured = { ...config, companionIdentityBundlePath: bundlePath, companionIdentityReviewPath: reviewPath };
      const names = await CompanionIdentityDrafts.fromConfiguration(db, configured, FICTIONAL_LEGAL, background);
      await fs.writeFile(bundlePath, '{"fictional":"changed-after-capture"}');
      const first = await names.save(who, input); // The earlier copied server asset is stable.
      for (const mode of ['invalid', 'missing', 'unconfigured'] as const) {
        if (mode === 'missing') { await fs.rm(bundlePath); await fs.rm(reviewPath); }
        const reader = await CompanionIdentityDrafts.fromConfiguration(db, mode === 'unconfigured' ? config : configured, FICTIONAL_LEGAL, background);
        const captured = await state(who);
        assert.deepEqual(await reader.read(who, { taskId: prepared.taskId }), first.draft);
        assert.equal((await reader.save(who, input)).operation.replayed, true);
        await assert.rejects(reader.save(who, command(prepared.taskId, 1, '舟')), code('COMPANION_IDENTITY_UNAVAILABLE'));
        assert.deepEqual(await state(who), captured);
      }
      assert.equal(bodies.length, 1);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});

test('saved vocabulary cannot be deleted through its foreign key or silently repaired after tampering', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background } = await ready(runtime), auth = await authority(), names = service(background, auth.asset, auth.review), input = command(prepared.taskId);
    const first = await names.save(who, input);
    await assert.rejects(db.query('DELETE FROM platform_companion_identity_assets WHERE content_digest=$1 AND review_digest=$2', [auth.asset.contentDigest, auth.review.reviewDigest]), { code: '23503' });
    assert.deepEqual(await names.read(who, { taskId: prepared.taskId }), first.draft);
    const row = (await db.query('SELECT bundle_json,review_json FROM platform_companion_identity_assets WHERE content_digest=$1 AND review_digest=$2', [auth.asset.contentDigest, auth.review.reviewDigest])).rows[0];
    for (const column of ['bundle_json', 'review_json'] as const) {
      await db.query(`UPDATE platform_companion_identity_assets SET ${column}=$3 WHERE content_digest=$1 AND review_digest=$2`, [auth.asset.contentDigest, auth.review.reviewDigest, '{"fictional":"tampered"}']);
      try {
        const captured = await state(who);
        for (const action of [() => names.read(who, { taskId: prepared.taskId }), () => names.save(who, input), () => names.save(who, command(prepared.taskId, 1, '舟'))])
          await assert.rejects(action(), code('COMPANION_IDENTITY_UNAVAILABLE'));
        assert.deepEqual(await state(who), captured); assert.equal(bodies.length, 1);
      } finally { await db.query(`UPDATE platform_companion_identity_assets SET ${column}=$3 WHERE content_digest=$1 AND review_digest=$2`, [auth.asset.contentDigest, auth.review.reviewDigest, row[column]]); }
    }
  });
});

test('damaged, transplanted and validly encrypted noncanonical identity payloads cannot be restored', async () => {
  await loopback(async (runtime, bodies) => {
    const own = await ready(runtime), foreign = await ready(runtime), auth = await authority();
    const names = service(own.background, auth.asset, auth.review), otherNames = service(foreign.background, auth.asset, auth.review);
    const input = command(own.prepared.taskId); await names.save(own.who, input); await otherNames.save(foreign.who, command(foreign.prepared.taskId));
    const row = (await state(own.who)).drafts[0], other = (await state(foreign.who)).drafts[0];
    const binding = { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext', rowId: row.id, ownerId: own.who.userId, revision: 1 };
    const forged = JSON.parse(crypto.openUtf8(row.payload_ciphertext, binding)); forged.sealCandidates[0].char = '舟';
    for (const ciphertext of [Buffer.alloc(29), other.payload_ciphertext, crypto.sealUtf8(JSON.stringify(forged), binding)]) {
      await db.query('UPDATE platform_companion_identity_drafts SET payload_ciphertext=$2 WHERE id=$1', [row.id, ciphertext]);
      const captured = await state(own.who);
      for (const action of [() => names.read(own.who, { taskId: own.prepared.taskId }), () => names.save(own.who, input), () => names.save(own.who, command(own.prepared.taskId, 1, '舟'))])
        await assert.rejects(action(), code('COMPANION_IDENTITY_UNAVAILABLE'));
      assert.deepEqual(await state(own.who), captured);
    }
    assert.equal(bodies.length, 2);
  });
});

test('actual provider completion, cost ledger and full encrypted intake history remain required for every naming operation', async () => {
  await loopback(async (runtime, bodies) => {
    for (const mode of ['completion', 'cost', 'history'] as const) {
      const { who, prepared, background, textId } = await ready(runtime, { text: mode === 'history' }), auth = await authority(), names = service(background, auth.asset, auth.review), input = command(prepared.taskId);
      await names.save(who, input);
      if (mode === 'completion') await db.query("UPDATE platform_companion_generation_calls SET status='failed' WHERE user_id=$1", [who.userId]);
      else if (mode === 'cost') await db.query('DELETE FROM platform_cost_ledger WHERE user_id=$1', [who.userId]);
      else await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, textId, Buffer.alloc(29)]);
      const captured = await state(who);
      for (const action of [() => names.read(who, { taskId: prepared.taskId }), () => names.save(who, input), () => names.save(who, command(prepared.taskId, 1, '舟'))])
        await assert.rejects(action(), error => error instanceof ApiError && error.status >= 400);
      assert.deepEqual(await state(who), captured);
    }
    assert.equal(bodies.length, 3);
  });
});

test('seal selection is explicit private preparation with an independent encrypted revision and no birth effects', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, names, identity } = await named(runtime), before = await state(who);
    const empty = { companionId: prepared.companionId, taskId: prepared.taskId, previewRevision: 1,
      identityRevision: 1, revision: 0, selectedSeal: null };
    assert.deepEqual(await names.readSelection(who, { taskId: prepared.taskId }), empty);
    assert.equal(before.selections.length, 0); assert.equal(before.selectionOperations.length, 0);
    const input = selectionCommand(prepared.taskId, identity.sealCandidates[1].char), saved = await names.saveSelection(who, input); frozen(saved);
    assert.deepEqual(saved.selection, { ...empty, revision: 1, selectedSeal: input.sealChar });
    assert.deepEqual(saved.operation, { id: input.operationId, appliedRevision: 1, replayed: false });
    assert.deepEqual(await names.readSelection(who, { taskId: prepared.taskId }), saved.selection);
    const captured = await state(who), row = captured.selections[0], receipt = captured.selectionOperations[0];
    assert.equal(captured.selections.length, 1); assert.equal(captured.selectionOperations.length, 1);
    assert.deepEqual(captured.drafts, before.drafts); assert.deepEqual(captured.operations, before.operations);
    assert.deepEqual(captured.intakeDrafts, before.intakeDrafts); assert.deepEqual(captured.intakeOperations, before.intakeOperations);
    assert.deepEqual(captured.effects, before.effects); assert.deepEqual(captured.companions, before.companions); assert.equal(bodies.length, 1);
    const binding = { table: 'platform_companion_identity_selections', column: 'payload_ciphertext', rowId: row.id, ownerId: who.userId, revision: 1 };
    const payload = JSON.parse(crypto.openUtf8(row.payload_ciphertext, binding));
    assert.equal(payload.identityRevision, 1); assert.equal(payload.source.taskId, prepared.taskId);
    assert.equal(payload.identitySnapshot.name, identity.name); assert.deepEqual(payload.identitySnapshot.sealCandidates, identity.sealCandidates);
    const request = JSON.parse(crypto.openUtf8(receipt.request_ciphertext, { table: 'platform_companion_identity_selection_operations',
      column: 'request_ciphertext', rowId: input.operationId, ownerId: who.userId, revision: 1 }));
    assert.deepEqual(request.request, input); assert.deepEqual(request.identitySnapshot, payload.identitySnapshot);
    assert.deepEqual(request.source, payload.source);
    for (const sealed of [row.payload_ciphertext, receipt.request_ciphertext]) assert.equal(sealed.includes(Buffer.from('"sealChar"')), false);
    for (const altered of [{ ...binding, ownerId: randomUUID() }, { ...binding, rowId: randomUUID() }, { ...binding, revision: 2 },
      { ...binding, table: 'platform_companion_identity_drafts' }]) assert.throws(() => crypto.openUtf8(row.payload_ciphertext, altered));
    for (const key of ['name', 'sealCandidates', 'source', 'identitySnapshot', 'bundleRevision', 'bornAt', 'provider', 'model'])
      assert.equal(Object.hasOwn(saved.selection, key), false);
  });
});

test('seal CAS serializes identical and competing writers and exact old replay returns current selection', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, names, identity } = await named(runtime), input = selectionCommand(prepared.taskId, identity.sealCandidates[0].char);
    const results = await Promise.all([names.saveSelection(who, input), names.saveSelection(who, input), names.saveSelection(who, input)]);
    assert.equal(results.filter(item => !item.operation.replayed).length, 1);
    assert(results.every(item => item.selection.revision === 1));
    const contenders = await Promise.allSettled(identity.sealCandidates.slice(1).map(candidate => names.saveSelection(who,
      selectionCommand(prepared.taskId, candidate.char, 1, 1))));
    assert.equal(contenders.filter(item => item.status === 'fulfilled').length, 1);
    const denied = contenders.find(item => item.status === 'rejected'); assert(denied?.status === 'rejected');
    assert(code('COMPANION_SEAL_SELECTION_REVISION_CHANGED')(denied.reason));
    const current = await names.readSelection(who, { taskId: prepared.taskId }); assert(current); assert.equal(current.revision, 2);
    const captured = await state(who), replay = await names.saveSelection(who, input);
    assert.deepEqual(replay.selection, current); assert.deepEqual(replay.operation, { id: input.operationId, appliedRevision: 1, replayed: true });
    await assert.rejects(names.saveSelection(who, { ...input, sealChar: identity.sealCandidates[1].char }), code('COMPANION_SEAL_SELECTION_OPERATION_CONFLICT'));
    await assert.rejects(names.saveSelection(who, selectionCommand(prepared.taskId, input.sealChar, 1, 0)), code('COMPANION_SEAL_SELECTION_REVISION_CHANGED'));
    await assert.rejects(names.saveSelection(who, selectionCommand(prepared.taskId, input.sealChar, 2, 2)), code('COMPANION_IDENTITY_REVISION_CHANGED'));
    assert.deepEqual(await state(who), captured); assert.equal(captured.selectionOperations.length, 2);
    assert.equal(captured.drafts[0].revision, 1); assert.equal(bodies.length, 1);
  });
});

test('name changes invalidate the saved seal without resetting its CAS revision or reviving it when the name returns', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, names, identity } = await named(runtime), input = selectionCommand(prepared.taskId, identity.sealCandidates[0].char);
    await names.saveSelection(who, input);
    await names.save(who, command(prepared.taskId, 1, '舟'));
    let current = await names.readSelection(who, { taskId: prepared.taskId }); assert(current);
    assert.equal(current.identityRevision, 2); assert.equal(current.revision, 1); assert.equal(current.selectedSeal, null);
    assert.deepEqual((await names.saveSelection(who, input)).selection, current);
    const restored = await names.save(who, command(prepared.taskId, 2, 'Juno'));
    assert.deepEqual(restored.draft.sealCandidates, identity.sealCandidates);
    current = await names.readSelection(who, { taskId: prepared.taskId }); assert(current);
    assert.equal(current.identityRevision, 3); assert.equal(current.revision, 1); assert.equal(current.selectedSeal, null);
    const captured = await state(who);
    await assert.rejects(names.saveSelection(who, selectionCommand(prepared.taskId, input.sealChar, 1, 1)), code('COMPANION_IDENTITY_REVISION_CHANGED'));
    await assert.rejects(names.saveSelection(who, selectionCommand(prepared.taskId, input.sealChar, 3, 0)), code('COMPANION_SEAL_SELECTION_REVISION_CHANGED'));
    assert.deepEqual(await state(who), captured);
    const next = await names.saveSelection(who, selectionCommand(prepared.taskId, input.sealChar, 3, 1));
    assert.equal(next.selection.revision, 2); assert.equal(next.selection.identityRevision, 3); assert.equal(next.selection.selectedSeal, input.sealChar);
    const replay = await names.saveSelection(who, input); assert.deepEqual(replay.selection, next.selection); assert.equal(replay.operation.appliedRevision, 1);
    assert.equal((await state(who)).companions[0].draft_rerolls, 0); assert.equal(bodies.length, 1);
  });
});

test('selection accepts only a closed captured command and a current stored candidate from the actual owner', async () => {
  await loopback(async (runtime, bodies) => {
    const pending = await ready(runtime, { generate: false }), pendingAuth = await authority(), pendingNames = service(pending.background, pendingAuth.asset, pendingAuth.review);
    await assert.rejects(pendingNames.saveSelection(pending.who, selectionCommand(pending.prepared.taskId, '墨')), code('COMPANION_PREVIEW_REQUIRED'));
    const unnamed = await ready(runtime), unnamedAuth = await authority(), unnamedNames = service(unnamed.background, unnamedAuth.asset, unnamedAuth.review);
    assert.equal(await unnamedNames.readSelection(unnamed.who, { taskId: unnamed.prepared.taskId }), null);
    await assert.rejects(unnamedNames.saveSelection(unnamed.who, selectionCommand(unnamed.prepared.taskId, '墨')), code('COMPANION_IDENTITY_REQUIRED'));
    const { who, prepared, names, identity } = await named(runtime), input = selectionCommand(prepared.taskId, identity.sealCandidates[0].char), captured = await state(who);
    const other = await actor(); let accessed = 0;
    for (const key of ['name', 'selectedSeal', 'sealCandidates', 'dimensions', 'source', 'bundle', 'review', 'userId', 'inkToken', 'bornAt'])
      await assert.rejects(names.saveSelection(who, { ...input, [key]: 'Fictional caller claim' }), code('INVALID_INPUT'));
    for (const field of ['expectedRevision', 'expectedIdentityRevision'] as const)
      for (const value of [-0, -1, 1.5, Number.MAX_SAFE_INTEGER, '1'])
        await assert.rejects(names.saveSelection(who, { ...input, [field]: value }), code('INVALID_INPUT'));
    const getter = { ...input }; Object.defineProperty(getter, 'sealChar', { enumerable: true, get() { accessed++; return input.sealChar; } });
    await assert.rejects(names.saveSelection(who, getter), code('INVALID_INPUT')); assert.equal(accessed, 0);
    const hidden = { ...input }; Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
    for (const extra of [hidden, { ...input, [Symbol('hidden')]: true }]) await assert.rejects(names.saveSelection(who, extra), code('INVALID_INPUT'));
    const noncandidate = ['墨', '如', '舟', '远', '暖'].find(char => !identity.sealCandidates.some(candidate => candidate.char === char)); assert(noncandidate);
    for (const sealChar of [noncandidate, '导', 'AB', '墨舟', ' 墨', '\n墨', '\ud800'])
      await assert.rejects(names.saveSelection(who, { ...input, sealChar }), code('SEAL_REJECTED'));
    for (const action of [() => names.readSelection(other, { taskId: prepared.taskId }), () => names.saveSelection(other, input)])
      await assert.rejects(action(), error => error instanceof ApiError && error.status >= 400);
    assert.deepEqual(await state(who), captured); assert.equal((await state(other)).selections.length, 0); assert.equal(bodies.length, 2);
  });
});

test('new selection requires current matching asset authority while history survives missing configuration and revoked activation', async () => {
  await loopback(async (runtime, bodies) => {
    for (const mode of ['missing_bundle', 'missing_review', 'missing_policy', 'revoked', 'disabled_org', 'student_reviewer', 'future', 'different_capture'] as const) {
      const { who, prepared, background, auth, names, identity } = await named(runtime), input = selectionCommand(prepared.taskId, identity.sealCandidates[0].char);
      const first = await names.saveSelection(who, input);
      let writer = names;
      if (mode === 'missing_bundle') writer = service(background, null, auth.review);
      if (mode === 'missing_review') writer = service(background, auth.asset, null);
      if (mode === 'missing_policy') await db.query('DELETE FROM platform_companion_identity_policy');
      if (mode === 'revoked') await db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2", [auth.orgId, auth.reviewer.userId]);
      if (mode === 'disabled_org') await db.query("UPDATE platform_orgs SET status='disabled' WHERE id=$1", [auth.orgId]);
      if (mode === 'student_reviewer') await db.query("UPDATE platform_users SET account_kind='student' WHERE id=$1", [auth.reviewer.userId]);
      if (mode === 'future') await db.query("UPDATE platform_companion_identity_policy SET activated_at=clock_timestamp()+interval '1 hour'");
      if (mode === 'different_capture') { const latest = await authority(bundle(81)); writer = service(background, latest.asset, latest.review); }
      const captured = await state(who);
      assert.deepEqual(await writer.readSelection(who, { taskId: prepared.taskId }), first.selection);
      assert.deepEqual((await writer.saveSelection(who, input)).selection, first.selection);
      await assert.rejects(writer.saveSelection(who, selectionCommand(prepared.taskId, identity.sealCandidates[1].char, 1, 1)), code('COMPANION_IDENTITY_UNAVAILABLE'));
      assert.deepEqual(await state(who), captured);
    }
    assert.equal(bodies.length, 8);
  });
});

test('new selection checks the current real account name while history retains its original name snapshot', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, names, identity } = await named(runtime), input = selectionCommand(prepared.taskId, identity.sealCandidates[0].char);
    const first = await names.saveSelection(who, input);
    await db.query("UPDATE platform_users SET name='juno' WHERE id=$1", [who.userId]);
    const captured = await state(who);
    assert.deepEqual(await names.readSelection(who, { taskId: prepared.taskId }), first.selection);
    assert.deepEqual((await names.saveSelection(who, input)).selection, first.selection);
    await assert.rejects(names.saveSelection(who, selectionCommand(prepared.taskId, identity.sealCandidates[1].char, 1, 1)), error => error instanceof ApiError
      && error.code === 'NAME_REJECTED' && 'category' in error && error.category === 'same_as_user');
    assert.deepEqual(await state(who), captured); assert.equal(bodies.length, 1);
  });
});

test('selection authenticates ciphertext, actual bound receipt and historical candidates even after invalidation', async () => {
  await loopback(async (runtime, bodies) => {
    const own = await ready(runtime), foreign = await ready(runtime), auth = await authority();
    const names = service(own.background, auth.asset, auth.review), others = service(foreign.background, auth.asset, auth.review);
    const identity = (await names.save(own.who, command(own.prepared.taskId))).draft;
    const otherIdentity = (await others.save(foreign.who, command(foreign.prepared.taskId))).draft;
    const input = selectionCommand(own.prepared.taskId, identity.sealCandidates[0].char);
    await names.saveSelection(own.who, input); await others.saveSelection(foreign.who, selectionCommand(foreign.prepared.taskId, otherIdentity.sealCandidates[0].char));
    const saved = await state(own.who), row = saved.selections[0], receipt = saved.selectionOperations[0], other = (await state(foreign.who)).selections[0];
    const binding = { table: 'platform_companion_identity_selections', column: 'payload_ciphertext', rowId: row.id, ownerId: own.who.userId, revision: 1 };
    const payload = JSON.parse(crypto.openUtf8(row.payload_ciphertext, binding));
    const differentCandidate = { ...payload, sealChar: identity.sealCandidates[1].char };
    const wrongSource = { ...payload, source: { ...payload.source, sourceRevision: payload.source.sourceRevision + 1 } };
    const wrongSnapshot = { ...payload, identitySnapshot: { ...payload.identitySnapshot, revision: 2 } };
    for (const ciphertext of [Buffer.alloc(29), other.payload_ciphertext, crypto.sealUtf8(JSON.stringify(differentCandidate), binding),
      crypto.sealUtf8(JSON.stringify(wrongSource), binding), crypto.sealUtf8(JSON.stringify(wrongSnapshot), binding)]) {
      await db.query('UPDATE platform_companion_identity_selections SET payload_ciphertext=$2 WHERE id=$1', [row.id, ciphertext]);
      const captured = await state(own.who);
      for (const action of [() => names.readSelection(own.who, { taskId: own.prepared.taskId }), () => names.saveSelection(own.who, input),
        () => names.saveSelection(own.who, selectionCommand(own.prepared.taskId, identity.sealCandidates[1].char, 1, 1))])
        await assert.rejects(action(), code('COMPANION_IDENTITY_UNAVAILABLE'));
      assert.deepEqual(await state(own.who), captured);
    }
    await db.query('UPDATE platform_companion_identity_selections SET payload_ciphertext=$2 WHERE id=$1', [row.id, row.payload_ciphertext]);
    await names.save(own.who, command(own.prepared.taskId, 1, '舟'));
    await db.query('UPDATE platform_companion_identity_selection_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2',
      [own.who.userId, input.operationId, Buffer.alloc(29)]);
    const captured = await state(own.who);
    for (const action of [() => names.readSelection(own.who, { taskId: own.prepared.taskId }), () => names.saveSelection(own.who, input),
      () => names.saveSelection(own.who, selectionCommand(own.prepared.taskId, '舟', 2, 1))]) await assert.rejects(action(), code('COMPANION_IDENTITY_UNAVAILABLE'));
    assert.deepEqual(await state(own.who), captured);
    await db.query('UPDATE platform_companion_identity_selection_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2',
      [own.who.userId, input.operationId, receipt.request_ciphertext]);
    await db.query('UPDATE platform_companion_identity_selections SET identity_revision=3 WHERE id=$1', [row.id]);
    await assert.rejects(names.readSelection(own.who, { taskId: own.prepared.taskId }), code('COMPANION_IDENTITY_UNAVAILABLE'));
    assert.equal(bodies.length, 2);
  });
});

test('invalidated selection recovers its original asset capture rather than the renamed identity assets', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background, auth, names, identity } = await named(runtime), input = selectionCommand(prepared.taskId, identity.sealCandidates[0].char);
    await names.saveSelection(who, input);
    const nextAuth = await authority(bundle(82)), nextNames = service(background, nextAuth.asset, nextAuth.review);
    await nextNames.save(who, command(prepared.taskId, 1, '舟'));
    const expected = await nextNames.readSelection(who, { taskId: prepared.taskId }); assert(expected); assert.equal(expected.selectedSeal, null);
    const asset = (await db.query('SELECT * FROM platform_companion_identity_assets WHERE content_digest=$1 AND review_digest=$2', [auth.asset.contentDigest, auth.review.reviewDigest])).rows[0];
    await assert.rejects(db.query('DELETE FROM platform_companion_identity_assets WHERE content_digest=$1 AND review_digest=$2', [auth.asset.contentDigest, auth.review.reviewDigest]), { code: '23503' });
    for (const column of ['bundle_json', 'review_json'] as const) {
      await db.query(`UPDATE platform_companion_identity_assets SET ${column}=$3 WHERE content_digest=$1 AND review_digest=$2`, [auth.asset.contentDigest, auth.review.reviewDigest, '{"fictional":"corrupted-history"}']);
      try {
        const captured = await state(who);
        for (const action of [() => nextNames.readSelection(who, { taskId: prepared.taskId }), () => nextNames.saveSelection(who, input),
          () => nextNames.saveSelection(who, selectionCommand(prepared.taskId, '舟', 2, 1))]) await assert.rejects(action(), code('COMPANION_IDENTITY_UNAVAILABLE'));
        assert.deepEqual(await state(who), captured);
      } finally { await db.query(`UPDATE platform_companion_identity_assets SET ${column}=$3 WHERE content_digest=$1 AND review_digest=$2`, [auth.asset.contentDigest, auth.review.reviewDigest, asset[column]]); }
    }
    assert.deepEqual((await service(background, null, null).saveSelection(who, input)).selection, expected);
    assert.equal(bodies.length, 1);
  });
});

test('canonical alternate name snapshots cannot replace the current identity or disagree with the actual selection receipt', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background, auth, names, identity } = await named(runtime);
    const verified = await db.withBoundedTransaction(client => background.readInTransaction(client, who, { taskId: prepared.taskId })); assert(verified);
    const alternative = auth.asset.policy.allowedSealCharacters.map(name => ({ name, candidates: companionSealCandidates({
      companionId: prepared.companionId, name, dimensions: verified.dimensions, policy: auth.asset.policy }) }))
      .find(item => item.candidates.some(candidate => identity.sealCandidates.some(original => candidate.char === original.char))
        && item.candidates.some(candidate => !identity.sealCandidates.some(original => candidate.char === original.char)));
    assert(alternative);
    const shared = alternative.candidates.find(candidate => identity.sealCandidates.some(original => candidate.char === original.char))!.char;
    const outside = alternative.candidates.find(candidate => !identity.sealCandidates.some(original => candidate.char === original.char))!.char;
    const input = selectionCommand(prepared.taskId, shared); await names.saveSelection(who, input);
    const captured = await state(who), row = captured.selections[0], receipt = captured.selectionOperations[0];
    const rowBinding = { table: 'platform_companion_identity_selections', column: 'payload_ciphertext', rowId: row.id, ownerId: who.userId, revision: 1 };
    const opBinding = { table: 'platform_companion_identity_selection_operations', column: 'request_ciphertext', rowId: input.operationId, ownerId: who.userId, revision: 1 };
    const payload = JSON.parse(crypto.openUtf8(row.payload_ciphertext, rowBinding)), operation = JSON.parse(crypto.openUtf8(receipt.request_ciphertext, opBinding));
    const alternateSnapshot = { ...payload.identitySnapshot, name: alternative.name, sealCandidates: alternative.candidates };
    await db.query('UPDATE platform_companion_identity_selections SET payload_ciphertext=$2 WHERE id=$1', [row.id,
      crypto.sealUtf8(JSON.stringify({ ...payload, identitySnapshot: alternateSnapshot, sealChar: outside }), rowBinding)]);
    await db.query('UPDATE platform_companion_identity_selection_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, input.operationId,
      crypto.sealUtf8(JSON.stringify({ ...operation, identitySnapshot: alternateSnapshot, request: { ...operation.request, sealChar: outside } }), opBinding)]);
    let damaged = await state(who);
    for (const action of [() => names.readSelection(who, { taskId: prepared.taskId }), () => names.saveSelection(who, { ...input, sealChar: outside }),
      () => names.saveSelection(who, selectionCommand(prepared.taskId, identity.sealCandidates[0].char, 1, 1))])
      await assert.rejects(action(), code('COMPANION_IDENTITY_UNAVAILABLE'));
    assert.deepEqual(await state(who), damaged);
    await db.query('UPDATE platform_companion_identity_selections SET payload_ciphertext=$2 WHERE id=$1', [row.id, row.payload_ciphertext]);
    await db.query('UPDATE platform_companion_identity_selection_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, input.operationId, receipt.request_ciphertext]);
    await names.save(who, command(prepared.taskId, 1, '墨'));
    await db.query('UPDATE platform_companion_identity_selection_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, input.operationId,
      crypto.sealUtf8(JSON.stringify({ ...operation, identitySnapshot: alternateSnapshot }), opBinding)]);
    damaged = await state(who);
    for (const action of [() => names.readSelection(who, { taskId: prepared.taskId }), () => names.saveSelection(who, input)])
      await assert.rejects(action(), code('COMPANION_IDENTITY_UNAVAILABLE'));
    assert.deepEqual(await state(who), damaged); assert.equal(bodies.length, 1);
  });
});

test('legal, session, real account and complete generation provenance remain required for selection reads and writes', async () => {
  await loopback(async (runtime, bodies) => {
    for (const mode of ['legal', 'session', 'staff', 'unverified', 'completion', 'cost', 'history'] as const) {
      const { who, prepared, names, identity, textId } = await named(runtime, { text: mode === 'history' }), input = selectionCommand(prepared.taskId, identity.sealCandidates[0].char);
      await names.saveSelection(who, input);
      if (mode === 'legal') await db.query("UPDATE platform_terms_policy SET content_digest=$1", ['0'.repeat(64)]);
      if (mode === 'session') await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
      if (mode === 'staff') await db.query("UPDATE platform_users SET account_kind='staff' WHERE id=$1", [who.userId]);
      if (mode === 'unverified') await db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [who.userId]);
      if (mode === 'completion') await db.query("UPDATE platform_companion_generation_calls SET status='failed' WHERE user_id=$1", [who.userId]);
      if (mode === 'cost') await db.query('DELETE FROM platform_cost_ledger WHERE user_id=$1', [who.userId]);
      if (mode === 'history') await db.query('UPDATE platform_onboarding_operations SET request_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2', [who.userId, textId, Buffer.alloc(29)]);
      const captured = await state(who);
      try {
        for (const action of [() => names.readSelection(who, { taskId: prepared.taskId }), () => names.saveSelection(who, input),
          () => names.saveSelection(who, selectionCommand(prepared.taskId, identity.sealCandidates[1].char, 1, 1))])
          await assert.rejects(action(), error => error instanceof ApiError && error.status >= 400);
        assert.deepEqual(await state(who), captured);
      } finally { if (mode === 'legal') await seedFictionalActiveLegal(db); }
    }
    assert.equal(bodies.length, 7);
  });
});

test('seal command and owner are captured before database waits and late session expiry rolls the selection back', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background, auth, identity } = await named(runtime), other = await actor();
    let entered!: () => void, resume!: () => void, held = false;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { resume = resolve; });
    const gated = new QueryGateDatabase(async () => { if (!held) { held = true; entered(); await released; } });
    const input = selectionCommand(prepared.taskId, identity.sealCandidates[0].char), original = { ...input };
    try {
      const context = { ...who }, pending = service(background, auth.asset, auth.review, gated).saveSelection(context, input); await waiting;
      context.userId = other.userId; context.tokenHash = other.tokenHash; input.sealChar = identity.sealCandidates[1].char;
      input.operationId = randomUUID(); input.expectedRevision = 40; input.expectedIdentityRevision = 30; input.taskId = randomUUID(); resume();
      const saved = await pending; assert.equal(saved.selection.selectedSeal, original.sealChar); assert.equal(saved.operation.id, original.operationId);
      assert.equal((await state(other)).selections.length, 0);
    } finally { resume?.(); await gated.close(); }
    let expired = false;
    const expiry = new QueryGateDatabase(async (client, text) => {
      if (expired || !text.startsWith('INSERT INTO platform_companion_identity_selection_operations')) return; expired = true;
      await client.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [who.tokenHash]);
    });
    try {
      const captured = await state(who);
      await assert.rejects(service(background, auth.asset, auth.review, expiry).saveSelection(who,
        selectionCommand(prepared.taskId, identity.sealCandidates[1].char, 1, 1)), code('AUTH_REQUIRED'));
      assert.equal(expired, true); assert.deepEqual(await state(who), captured); assert.equal(bodies.length, 1);
    } finally { await expiry.close(); }
  });
});

test('actual deferred COMMIT rejection rolls back seal row and receipt while post-acceptance cancellation preserves the commit', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, background, auth, names, identity } = await named(runtime), captured = await state(who), input = selectionCommand(prepared.taskId, identity.sealCandidates[0].char);
    await db.query(`CREATE FUNCTION selection_fixture_commit_rejection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Fictional deferred selection COMMIT rejection' USING ERRCODE='23514'; END; $$`);
    await db.query(`CREATE CONSTRAINT TRIGGER selection_fixture_commit_rejection AFTER INSERT ON platform_companion_identity_selection_operations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION selection_fixture_commit_rejection()`);
    let reachedCommit = false;
    const gated = new BeforeCommitDatabase(async client => {
      const staged = (await client.query(`SELECT
        (SELECT count(*)::int FROM platform_companion_identity_selections WHERE user_id=$1) AS selections,
        (SELECT count(*)::int FROM platform_companion_identity_selection_operations WHERE user_id=$1) AS operations`, [who.userId])).rows[0];
      assert.deepEqual(staged, { selections: 1, operations: 1 }); reachedCommit = true;
    });
    try {
      await assert.rejects(service(background, auth.asset, auth.review, gated).saveSelection(who, input), { code: '23514' });
      assert.equal(reachedCommit, true); assert.deepEqual(await state(who), captured);
    } finally {
      await gated.close(); await db.query('DROP TRIGGER selection_fixture_commit_rejection ON platform_companion_identity_selection_operations');
      await db.query('DROP FUNCTION selection_fixture_commit_rejection()');
    }
    const controller = new AbortController(), acceptance = new BeforeCommitDatabase(async client => {
      assert.equal((await client.query('SELECT 1 FROM platform_companion_identity_selection_operations WHERE user_id=$1 AND operation_id=$2', [who.userId, input.operationId])).rowCount, 1);
      controller.abort(new DOMException('Fictional cancellation after acceptance', 'AbortError'));
    });
    try {
      const saved = await service(background, auth.asset, auth.review, acceptance).saveSelection(who, input, controller.signal);
      assert.equal(saved.operation.replayed, false); assert.equal(controller.signal.aborted, true);
      const committed = await state(who); assert.equal(committed.selections.length, 1); assert.equal(committed.selectionOperations.length, 1);
      assert.deepEqual(await names.readSelection(who, { taskId: prepared.taskId }), saved.selection);
      assert.deepEqual((await names.saveSelection(who, input)).selection, saved.selection); assert.deepEqual(await state(who), committed); assert.equal(bodies.length, 1);
    } finally { await acceptance.close(); }
  });
});

test('actual two-connection session revocation waits preserve the confirmed transaction order', async () => {
  await loopback(async (runtime, bodies) => {
    async function waitForLock(pid: number) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const row = (await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
        if (row?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('Expected the actual other PostgreSQL connection to wait for its row lock.');
    }
    for (const order of ['selection_first', 'revocation_first'] as const) {
      const { who, prepared, background, auth, identity } = await named(runtime), input = selectionCommand(prepared.taskId, identity.sealCandidates[0].char);
      const captured = await state(who), revoker = await db.pool.connect();
      let gated: QueryGateDatabase | undefined, resume: (() => void) | undefined, pending: Promise<unknown> | undefined, deletion: Promise<unknown> | undefined;
      try {
        await revoker.query('BEGIN'); const revokerPid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        if (order === 'selection_first') {
          let entered!: () => void, held = false;
          const waiting = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { resume = resolve; });
          gated = new QueryGateDatabase(async (_client, text) => {
            if (held || !text.startsWith('INSERT INTO platform_companion_identity_selection_operations')) return;
            held = true; entered(); await released;
          });
          pending = service(background, auth.asset, auth.review, gated).saveSelection(who, input); await waiting;
          deletion = revoker.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
          await waitForLock(revokerPid); resume!();
          const saved = await pending; assert(saved && typeof saved === 'object' && 'operation' in saved);
          await deletion; await revoker.query('COMMIT');
          const current = await state(who); assert.equal(current.selections.length, 1); assert.equal(current.selectionOperations.length, 1);
          assert.deepEqual(current.intakeDrafts, captured.intakeDrafts); assert.deepEqual(current.intakeOperations, captured.intakeOperations);
          assert.deepEqual(current.drafts, captured.drafts); assert.deepEqual(current.effects, captured.effects); assert.deepEqual(current.companions, captured.companions);
        } else {
          await revoker.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
          let entered!: (pid: number) => void, held = false;
          const waiting = new Promise<number>(resolve => { entered = resolve; });
          gated = new QueryGateDatabase(async (client, text) => {
            if (held || !text.startsWith('SELECT token_hash FROM platform_sessions')) return;
            held = true; entered((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          });
          pending = service(background, auth.asset, auth.review, gated).saveSelection(who, input);
          const denied = assert.rejects(pending, code('AUTH_REQUIRED'));
          await waitForLock(await waiting); await revoker.query('COMMIT'); await denied;
          assert.deepEqual(await state(who), captured);
        }
        await assert.rejects(service(background, auth.asset, auth.review).readSelection(who, { taskId: prepared.taskId }), code('AUTH_REQUIRED'));
      } finally {
        resume?.(); await revoker.query('ROLLBACK'); revoker.release();
        await Promise.allSettled([pending, deletion]); await gated?.close();
      }
    }
    assert.equal(bodies.length, 2);
  });
});
