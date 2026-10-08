import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { compileFallbackCompanionStyle, createOnboardingDraft, transitionOnboardingDraft, prepareOnboardingDimensions, type CompanionDimensions } from '@companion/career-core';
import type { OnboardingDraft, ProviderStatus } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { OnboardingDrafts } from '../src/onboarding-drafts.ts';
import { CompanionDraftPreparation } from '../src/companion-draft-preparation.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Actual isolated PostgreSQL, encrypted ready intake and real entity rows. The
// query observer only seeds controlled collisions before forwarding the actual
// SELECT; it never substitutes a database result, model output or permission.
const base = readConfig(), baseUrl = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname), 'Use only loopback PostgreSQL.');
const admin = new Database(base.databaseUrl);
after(async () => admin.close());
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: 'e4'.repeat(32) })!;
const config = { dataCrypto: crypto, requireVerifiedEmail: true, modelRoutes: { companion_generation: { provider: 'openai' } } };
const neutral: CompanionDimensions = { warmth: 0, directness: 0, drive: 0, structure: 0, levity: 0, code_mix: 0, length: 'medium' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = (companionId: string, quirkDraw: 0 | 1) => {
  const compiled = compileFallbackCompanionStyle({ companionId, dimensions: neutral, quirkDraw });
  return hash({ dimensions: neutral, quirks: { ...compiled.quirks }, inkToken: compiled.inkToken });
};
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
interface Fixture { db: Database; store: OnboardingDrafts; service: CompanionDraftPreparation; modelCalls: () => number; }
async function beforeDrawMigration(db: Database) {
  const directory = new URL('../migrations/', import.meta.url);
  const names = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name) && Number.parseInt(name, 10) < 36).sort();
  await db.transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('companion-platform-migrations'))");
    await client.query('CREATE TABLE platform_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of names) {
      await client.query(await readFile(new URL(name, directory), 'utf8'));
      await client.query('INSERT INTO platform_migrations(name) VALUES($1)', [name]);
    }
  });
}
async function isolated(run: (fixture: Fixture) => Promise<void>, legacy = false) {
  const schema = 'companion_dedup_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
  url.searchParams.set('options', '-c search_path=' + schema);
  const db = new Database(url.toString()); let created = false, calls = 0;
  const runtime = {
    capabilities(): ProviderStatus[] { return [{ id: 'openai', name: 'Fictional dedup catalogue', enabled: true, keyConfigured: true,
      capabilities: ['chat'], models: [], modelsByPurpose: { companion_generation: ['fictional-dedup-model'] }, envVariables: [] }]; },
    async *streamChat() { calls++; throw new Error('Preparation must not call a model.'); },
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    if (legacy) await beforeDrawMigration(db); else await db.migrate();
    await seedFictionalActiveLegal(db);
    await run({ db, store: new OnboardingDrafts(db, config, FICTIONAL_LEGAL),
      service: new CompanionDraftPreparation(db, config, FICTIONAL_LEGAL, runtime), modelCalls: () => calls });
    assert.equal(calls, 0);
  } finally {
    try { await db.close(); }
    finally { if (created) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
    } }
  }
}
async function actor(f: Fixture): Promise<FixedSessionContext> {
  const userId = randomUUID(), hash = tokenHash(randomUUID());
  await f.db.query(`INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at)
    VALUES($1,$2,'Fictional dedup student','fictional-unused-hash','student',clock_timestamp())`, [userId, userId + '@example.invalid']);
  await f.db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,0,clock_timestamp()+interval '1 hour')`, [userId, hash]);
  await seedFictionalConsent(f.db, userId); return { userId, tokenHash: hash };
}
async function ready(f: Fixture, who: FixedSessionContext): Promise<OnboardingDraft> {
  let draft = (await f.store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'fast_track' } })).draft;
  while (draft.currentQuestion) draft = (await f.store.save(who, { expectedRevision: draft.revision, operationId: randomUUID(),
    action: { kind: 'skip', questionId: draft.currentQuestion } })).draft;
  assert.equal(draft.state, 'intake_ready'); return draft;
}
/** Seed an actual pre-036 fixture in its historical schema. Current services require current migrations;
 * do not weaken their history checks merely to invoke new code against a deliberately old database.
 * These are fictional, explicit skip operations using the compatible revision-1 encrypted format.
 */
async function legacyReady(f: Fixture, who: FixedSessionContext): Promise<OnboardingDraft> {
  return f.db.transaction(async client => {
    const at = (await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
    let draft = createOnboardingDraft({ id: randomUUID(), userId: who.userId, at });
    const operations: { operationId: string; appliedRevision: number; input: string }[] = [];
    const save = (action: { kind: 'start'; mode: 'fast_track' } | { kind: 'skip'; questionId: NonNullable<OnboardingDraft['currentQuestion']> }) => {
      const command = { operationId: randomUUID(), expectedRevision: draft.revision, action };
      draft = transitionOnboardingDraft(draft, command, { at });
      operations.push({ operationId: command.operationId, appliedRevision: draft.revision, input: JSON.stringify(command) });
    };
    save({ kind: 'start', mode: 'fast_track' });
    while (draft.currentQuestion) save({ kind: 'skip', questionId: draft.currentQuestion });
    const ciphertext = crypto.sealUtf8(JSON.stringify(draft), { table: 'platform_onboarding_drafts', column: 'payload_ciphertext',
      rowId: draft.id, ownerId: who.userId, revision: draft.revision });
    await client.query(`INSERT INTO platform_onboarding_drafts(id,user_id,revision,payload_ciphertext,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$5)`, [draft.id, who.userId, draft.revision, ciphertext, at]);
    for (const operation of operations) {
      const request = crypto.sealUtf8(operation.input, { table: 'platform_onboarding_operations', column: 'request_ciphertext',
        rowId: operation.operationId, ownerId: who.userId, revision: operation.appliedRevision });
      await client.query(`INSERT INTO platform_onboarding_operations(user_id,operation_id,draft_id,applied_revision,request_ciphertext)
        VALUES($1,$2,$3,$4,$5)`, [who.userId, operation.operationId, draft.id, operation.appliedRevision, request]);
    }
    assert.equal(draft.state, 'intake_ready'); return draft;
  });
}
async function snapshot(f: Fixture, who: FixedSessionContext) {
  const [companions, answers, tasks] = await Promise.all([
    f.db.query('SELECT * FROM platform_companions WHERE user_id=$1 ORDER BY id', [who.userId]),
    f.db.query('SELECT * FROM platform_companion_answers WHERE user_id=$1 ORDER BY id', [who.userId]),
    f.db.query('SELECT * FROM platform_companion_generation_tasks WHERE user_id=$1 ORDER BY id', [who.userId]),
  ]);
  return { companions: companions.rows, answers: answers.rows, tasks: tasks.rows };
}
function openSeed(row: any, who: FixedSessionContext) {
  return JSON.parse(crypto.openUtf8(row.seed_ciphertext, { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext',
    rowId: row.id, ownerId: who.userId, revision: row.source_revision }));
}
async function noExecution(f: Fixture) {
  for (const table of ['platform_runtime_leases', 'platform_companion_revisions', 'platform_chat_calls', 'platform_cost_reservations',
    'platform_cost_ledger', 'platform_jobs', 'platform_conversations', 'platform_memories']) {
    assert.equal((await f.db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, table);
  }
  assert.equal(f.modelCalls(), 0);
}
function observed(f: Fixture, onLookup?: (client: PoolClient, values: readonly unknown[]) => Promise<void>) {
  let lookups = 0;
  const db = new Proxy(f.db, { get(target, key) {
    if (key === 'withBoundedTransaction') return <T>(run: (client: PoolClient) => Promise<T>, options?: { readOnly?: boolean; timeoutMs?: number }) =>
      target.withBoundedTransaction(client => run(new Proxy(client, { get(connection, property) {
        if (property === 'query') return async (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].includes('FROM platform_companions WHERE fingerprint=$1')) {
            lookups++; await onLookup?.(connection, args[1] as readonly unknown[]);
          }
          return Reflect.apply(connection.query, connection, args);
        };
        const value = Reflect.get(connection, property, connection); return typeof value === 'function' ? value.bind(connection) : value;
      } })), options);
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const runtime = { capabilities(): ProviderStatus[] { return [{ id: 'openai', name: 'Fictional observed catalogue', enabled: true, keyConfigured: true,
    capabilities: ['chat'], models: [], modelsByPurpose: { companion_generation: ['fictional-dedup-model'] }, envVariables: [] }]; } };
  return { service: new CompanionDraftPreparation(db, config, FICTIONAL_LEGAL, runtime), lookups: () => lookups };
}
async function insertCollision(client: { query(text: string, values?: unknown[]): Promise<unknown> }, who: FixedSessionContext, value: string) {
  // A genuine UUID is allocated for this actual fixture entity; the metadata
  // fingerprint is deliberately set to collide. It grants no generation claim.
  const id = randomUUID();
  await client.query("INSERT INTO platform_companions(id,user_id,status,fingerprint) VALUES($1,$2,'drafting',$3)", [id, who.userId, value]);
  return id;
}

test('new noncolliding preparation keeps the legacy zero seed and ordinary non-unique fingerprint index', async () => isolated(async f => {
  const who = await actor(f), draft = await ready(f, who), watched = observed(f);
  const prepared = await watched.service.prepare(who, { expectedRevision: draft.revision }), stored = await snapshot(f, who);
  assert.equal(watched.lookups(), 1); assert.equal(stored.tasks[0].quirk_draw, 0);
  const seed = openSeed(stored.tasks[0], who), compiled = compileFallbackCompanionStyle({ companionId: prepared.companionId, dimensions: neutral });
  assert.equal(Object.hasOwn(seed, 'quirkDraw'), false); assert.deepEqual(seed.quirks, compiled.quirks);
  assert.equal(seed.styleCard, compiled.styleCard); assert.equal(seed.inkToken, compiled.inkToken);
  assert.equal(stored.companions[0].fingerprint, fingerprint(prepared.companionId, 0));
  const index = (await f.db.query(`SELECT i.indisunique FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='platform_companions_fingerprint' AND n.nspname=current_schema()`)).rows;
  assert.deepEqual(index, [{ indisunique: false }]); await noExecution(f);
}));

test('initial collision draws quirks once and replay restores the same actual entity and encrypted seed without another lookup', async () => isolated(async f => {
  const who = await actor(f), other = await actor(f), draft = await ready(f, who); await ready(f, other);
  const watched = observed(f, async (client, values) => {
    assert.equal(values[0], fingerprint(values[1] as string, 0));
    await insertCollision(client, other, values[0] as string);
  });
  const prepared = await watched.service.prepare(who, { expectedRevision: draft.revision }), stored = await snapshot(f, who);
  const task = stored.tasks[0], seed = openSeed(task, who), zero = compileFallbackCompanionStyle({ companionId: prepared.companionId, dimensions: neutral });
  const one = compileFallbackCompanionStyle({ companionId: prepared.companionId, dimensions: neutral, quirkDraw: 1 });
  assert.equal(watched.lookups(), 1); assert.equal(task.quirk_draw, 1); assert.equal(seed.quirkDraw, 1);
  assert.equal(seed.companionId, prepared.companionId); assert.deepEqual(seed.dimensions, neutral);
  assert.deepEqual(seed.quirks, one.quirks); assert.equal(seed.styleCard, one.styleCard); assert.equal(seed.inkToken, zero.inkToken);
  assert.equal(stored.companions[0].fingerprint, fingerprint(prepared.companionId, 1));
  const { sourceReceiptVersion, sourceReceiptDigest, ...baseSeed } = seed;
  assert.equal(Object.keys(baseSeed).at(-1), 'quirkDraw');
  assert.equal(task.source_receipt_version, 1); assert.equal(sourceReceiptVersion, 1);
  assert.match(sourceReceiptDigest, /^[0-9a-f]{64}$/);
  const sourcePrefix = (await f.db.query('SELECT * FROM platform_companion_source_prefixes WHERE task_id=$1', [task.id])).rows;
  assert.equal(sourcePrefix.length, 1); assert.equal(sourcePrefix[0].payload_digest, sourceReceiptDigest);
  assert.deepEqual(await watched.service.prepare(who, { expectedRevision: draft.revision }), prepared);
  assert.equal(watched.lookups(), 1); assert.deepEqual(await snapshot(f, who), stored);
  const fresh = observed(f, async () => assert.fail('Saved draw must not query later collisions.'));
  assert.deepEqual(await fresh.service.prepare(who, { expectedRevision: draft.revision }), prepared);
  assert.equal(fresh.lookups(), 0); assert.deepEqual(await snapshot(f, who), stored); await noExecution(f);
  assert.deepEqual((await f.db.query('SELECT * FROM platform_companion_source_prefixes WHERE task_id=$1', [task.id])).rows, sourcePrefix);
}));

test('even a second collision is accepted after exactly one best-effort draw without a uniqueness promise', async () => isolated(async f => {
  const who = await actor(f), first = await actor(f), second = await actor(f), draft = await ready(f, who);
  await ready(f, first); await ready(f, second);
  const watched = observed(f, async (client, values) => {
    await insertCollision(client, first, values[0] as string);
    await insertCollision(client, second, fingerprint(values[1] as string, 1));
  });
  const prepared = await watched.service.prepare(who, { expectedRevision: draft.revision }), saved = await snapshot(f, who);
  assert.equal(watched.lookups(), 1); assert.equal(saved.tasks[0].quirk_draw, 1);
  assert((await f.db.query('SELECT id FROM platform_companions WHERE fingerprint=$1', [fingerprint(prepared.companionId, 1)])).rows.length >= 2);
  assert.deepEqual(await watched.service.prepare(who, { expectedRevision: draft.revision }), prepared);
  assert.equal(watched.lookups(), 1); await noExecution(f);
}));

test('later collision never changes a saved zero draw and clients cannot request either draw', async () => isolated(async f => {
  const who = await actor(f), draft = await ready(f, who), prepared = await f.service.prepare(who, { expectedRevision: draft.revision });
  const saved = await snapshot(f, who), other = await actor(f); await ready(f, other);
  await insertCollision(f.db, other, saved.companions[0].fingerprint);
  const watched = observed(f, async () => assert.fail('An existing version must not deduplicate again.'));
  assert.deepEqual(await watched.service.prepare(who, { expectedRevision: draft.revision }), prepared);
  assert.equal(watched.lookups(), 0); assert.deepEqual(await snapshot(f, who), saved);
  for (const field of ['quirkDraw', 'quirk_draw']) for (const value of [0, 1]) {
    await assert.rejects(watched.service.prepare(who, { expectedRevision: draft.revision, [field]: value }), code('INVALID_INPUT'));
  }
  assert.deepEqual(await snapshot(f, who), saved); await noExecution(f);
}));

test('draw row and encrypted canonical seed must agree and the database rejects values outside zero/one', async () => isolated(async f => {
  const who = await actor(f), draft = await ready(f, who); await f.service.prepare(who, { expectedRevision: draft.revision });
  const saved = await snapshot(f, who), task = saved.tasks[0], companion = saved.companions[0], seed = openSeed(task, who);
  await assert.rejects(f.db.query('UPDATE platform_companion_generation_tasks SET quirk_draw=2 WHERE id=$1', [task.id]), { code: '23514' });
  await assert.rejects(f.db.query('UPDATE platform_companion_generation_tasks SET quirk_draw=NULL WHERE id=$1', [task.id]), { code: '23502' });
  const changedStyle = compileFallbackCompanionStyle({ companionId: companion.id, dimensions: neutral, quirkDraw: 1 });
  await f.db.query('UPDATE platform_companion_generation_tasks SET quirk_draw=1 WHERE id=$1', [task.id]);
  await f.db.query('UPDATE platform_companions SET fingerprint=$2 WHERE id=$1', [companion.id, fingerprint(companion.id, 1)]);
  let damaged = await snapshot(f, who);
  await assert.rejects(f.service.prepare(who, { expectedRevision: draft.revision }), code('DATA_STORAGE_UNAVAILABLE'));
  assert.deepEqual(await snapshot(f, who), damaged);
  const binding = { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext', rowId: task.id, ownerId: who.userId, revision: draft.revision };
  const inconsistent = { ...seed, quirks: { ...changedStyle.quirks }, styleCard: changedStyle.styleCard, quirkDraw: 0 };
  await f.db.query('UPDATE platform_companion_generation_tasks SET seed_ciphertext=$2 WHERE id=$1', [task.id, crypto.sealUtf8(JSON.stringify(inconsistent), binding)]);
  damaged = await snapshot(f, who);
  await assert.rejects(f.service.prepare(who, { expectedRevision: draft.revision }), code('DATA_STORAGE_UNAVAILABLE'));
  assert.deepEqual(await snapshot(f, who), damaged);
  await f.db.query('UPDATE platform_companion_generation_tasks SET quirk_draw=0,seed_ciphertext=$2 WHERE id=$1', [task.id, crypto.sealUtf8(JSON.stringify({ ...seed, quirkDraw: 0 }), binding)]);
  await f.db.query('UPDATE platform_companions SET fingerprint=$2 WHERE id=$1', [companion.id, companion.fingerprint]);
  damaged = await snapshot(f, who);
  await assert.rejects(f.service.prepare(who, { expectedRevision: draft.revision }), code('DATA_STORAGE_UNAVAILABLE'));
  assert.deepEqual(await snapshot(f, who), damaged); await noExecution(f);
}));

test('draw-one replay still rejects a new session/auth version and changed source without fresh collision checks', async () => isolated(async f => {
  const who = await actor(f), other = await actor(f), draft = await ready(f, who); await ready(f, other);
  const watched = observed(f, (client, values) => insertCollision(client, other, values[0] as string).then(() => {}));
  await watched.service.prepare(who, { expectedRevision: draft.revision }); assert.equal((await snapshot(f, who)).tasks[0].quirk_draw, 1);
  await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
  const hash = tokenHash(randomUUID());
  await f.db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
    VALUES($1,$2,1,clock_timestamp()+interval '1 hour')`, [who.userId, hash]);
  const saved = await snapshot(f, who);
  await assert.rejects(watched.service.prepare({ userId: who.userId, tokenHash: hash }, { expectedRevision: draft.revision }), code('COMPANION_DRAFT_SOURCE_CHANGED'));
  assert.equal(watched.lookups(), 1); assert.deepEqual(await snapshot(f, who), saved);
  await assert.rejects(watched.service.prepare({ userId: who.userId, tokenHash: hash }, { expectedRevision: draft.revision - 1 }), code('ONBOARDING_REVISION_CHANGED'));
  assert.deepEqual(await snapshot(f, who), saved); await noExecution(f);
}));

test('actual pre-036 encrypted zero seed survives the new default column unchanged and replays without dedup', async () => isolated(async f => {
  const who = await actor(f), draft = await legacyReady(f, who);
  const prepared = prepareOnboardingDimensions(draft);
  assert.deepEqual(prepared.dimensions, neutral);
  const companionId = randomUUID(), taskId = randomUUID(), answersId = randomUUID();
  const compiled = compileFallbackCompanionStyle({ companionId, dimensions: neutral });
  const answers = { schemaVersion: 1, id: answersId, userId: who.userId, sourceDraftId: draft.id, sourceRevision: draft.revision,
    fastTrack: draft.fastTrack, answersPartial: draft.answersPartial };
  const seed = { schemaVersion: 1, taskId, userId: who.userId, companionId, answersId, sourceDraftId: draft.id, sourceRevision: draft.revision,
    authVersion: '0', questionnaireRevision: 1, rulesRevision: 1, generatorVersion: 1, purpose: 'companion_preview',
    provider: 'openai', model: 'fictional-dedup-model', dimensions: { ...neutral }, quirks: { ...compiled.quirks }, inkToken: compiled.inkToken, styleCard: compiled.styleCard };
  const answerCipher = crypto.sealUtf8(JSON.stringify(answers), { table: 'platform_companion_answers', column: 'payload_ciphertext', rowId: answersId, ownerId: who.userId, revision: draft.revision });
  const seedCipher = crypto.sealUtf8(JSON.stringify(seed), { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext', rowId: taskId, ownerId: who.userId, revision: draft.revision });
  await f.db.transaction(async client => {
    await client.query("INSERT INTO platform_companions(id,user_id,status,fingerprint) VALUES($1,$2,'drafting',$3)", [companionId, who.userId, fingerprint(companionId, 0)]);
    await client.query('INSERT INTO platform_companion_answers(id,user_id,source_draft_id,source_revision,payload_ciphertext) VALUES($1,$2,$3,$4,$5)', [answersId, who.userId, draft.id, draft.revision, answerCipher]);
    await client.query(`INSERT INTO platform_companion_generation_tasks(id,user_id,companion_id,answers_id,source_draft_id,source_revision,auth_version,
      questionnaire_revision,rules_revision,generator_version,purpose,status,seed_ciphertext) VALUES($1,$2,$3,$4,$5,$6,0,1,1,1,'companion_preview','pending',$7)`,
    [taskId, who.userId, companionId, answersId, draft.id, draft.revision, seedCipher]);
  });
  assert.equal((await f.db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='platform_companion_generation_tasks' AND column_name='quirk_draw'`)).rowCount, 0);
  const before = await snapshot(f, who); await f.db.migrate(); const migrated = await snapshot(f, who);
  assert.equal(migrated.tasks[0].quirk_draw, 0);
  assert.deepEqual(migrated.tasks[0].seed_ciphertext, before.tasks[0].seed_ciphertext);
  assert.deepEqual(migrated.answers, before.answers);
  // 051 adds nullable birth columns; every original value must remain exact,
  // and this pre-036 draft must gain no identity, room or birth authority.
  assert.deepEqual(migrated.companions, before.companions.map(row => ({ ...row,
    name: null, name_origin: null, seal_char: null, seal_candidates: null,
    seal_changed_at: null, ink_token: null, relationship_stage: null,
    stage_changed_at: null, overlays: null, birth_receipt_id: null,
    birth_idempotency_key: null, born_at: null, retired_at: null, seal_asset_id: null,
  })));
  assert.equal(Object.hasOwn(openSeed(migrated.tasks[0], who), 'quirkDraw'), false);
  const watched = observed(f, async () => assert.fail('Legacy pending metadata must not be redrawn.'));
  assert.deepEqual(await watched.service.prepare(who, { expectedRevision: draft.revision }), { companionId, taskId, status: 'pending',
    source: { draftId: draft.id, draftRevision: draft.revision, questionnaireRevision: 1, rulesRevision: 1 } });
  assert.equal(watched.lookups(), 0); assert.deepEqual(await snapshot(f, who), migrated); await noExecution(f);
}, true));
