import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { CompanionBirthService } from '../src/companion-birth-service.ts';
import { CompanionBirthOriginStore } from '../src/companion-birth-origin-store.ts';
import { openCompanionBirthOrigin } from '../src/companion-birth-origin-codec.ts';
import { openCompanionBirthAssets } from '../src/companion-birth-assets.ts';
import { inspectCompanionSealPNG } from '../src/companion-seal-rendering.ts';
import { BackgroundGeneration } from '../src/background-generation.ts';
import { CompanionIdentityDrafts } from '../src/companion-identity-drafts.ts';
import { CompanionNameSafety } from '../src/companion-name-safety.ts';
import { CompanionPrebirthSafety } from '../src/companion-prebirth-safety.ts';
import { createPrebirthFixture, withPrebirthLoopback, type PrebirthFixture } from './fixtures/companion-prebirth.ts';
import { readyBirth, createFixtureBirthService, fictionalBirthGlyphs, type ReadyBirth,
  FICTIONAL_BIRTH_GLYPH_PATH as glyphPath, FICTIONAL_BIRTH_GLYPH_DIGEST as glyphDigest } from './fixtures/companion-birth.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal } from './fixtures/student-entry.ts';

// Fictional source/review actors exercise the actual prebirth gates and SQL
// COMMIT. This server-owned triangle is a test outline, not a real character,
// licensed font build, eligible vocabulary or professional review. Rendering is
// nevertheless the actual bounded native resvg child, with actual encrypted
// bytes and actual PostgreSQL origin storage. All model I/O stays loopback.
let fixture: PrebirthFixture;
before(async () => { fixture = await createPrebirthFixture(); });
after(async () => { if (fixture) await fixture.close(); });
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const predecessorTables = ['platform_onboarding_drafts', 'platform_onboarding_operations', 'platform_onboarding_safety_submissions',
  'platform_companion_answers', 'platform_companion_generation_tasks', 'platform_companion_generation_calls', 'platform_companion_revisions',
  'platform_companion_name_entries', 'platform_companion_name_submissions', 'platform_companion_identity_drafts', 'platform_companion_identity_operations',
  'platform_companion_identity_selections', 'platform_companion_identity_selection_operations', 'platform_companion_name_identity_receipts',
  'platform_companion_name_identity_provenance', 'platform_companion_prebirth_heads', 'platform_companion_prebirth_inventory',
  'platform_safety_model_usage', 'platform_cost_reservations', 'platform_cost_ledger', 'platform_runtime_leases', 'platform_chat_calls',
  'platform_memories', 'platform_jobs'] as const;
async function predecessors(who: FixedSessionContext) {
  const result: Record<string, unknown> = {};
  for (const table of predecessorTables) result[table] = (await fixture.db.query(
    `SELECT * FROM ${table} WHERE user_id=$1 ORDER BY row_to_json(${table})::text`, [who.userId])).rows;
  return result;
}
async function birthRows(who: FixedSessionContext) {
  const rows: Record<string, any[]> = {};
  for (const table of ['platform_companions', 'platform_companion_birth_receipts', 'platform_companion_birth_assets', 'platform_conversations']) {
    rows[table] = (await fixture.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY id`, [who.userId])).rows;
  }
  rows.messages = (await fixture.db.query('SELECT m.* FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id WHERE c.user_id=$1 ORDER BY m.id', [who.userId])).rows;
  return rows;
}
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert(Object.isFrozen(value)); for (const item of Object.values(value)) frozen(item);
}

test('actual birth atomically commits one encrypted asset pair, immutable origin, main and system event at one database millisecond with no C1 or model work', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const poolBorrows: number[] = [];
    const { ready, body, identity, submitted, service: birth } = await readyBirth(fixture, runtime, { observeGlyph: () => {
      poolBorrows.push(fixture.db.pool.totalCount - fixture.db.pool.idleCount);
    } });
    const predecessor = await predecessors(ready.who), count = requests.length;
    assert.deepEqual(await birth.read(ready.who), { kind: 'not_born' });
    const key = randomUUID(), result = await birth.birth(ready.who, body, key); frozen(result);
    assert.equal(result.kind, 'birth_result'); assert.equal(result.replayed, false); assert.equal(result.receipt.idempotencyKey, key);
    assert.equal(result.receipt.identity.companionId, ready.prepared.companionId); assert.equal(result.receipt.identity.name, body.name);
    assert.deepEqual(poolBorrows, [0, 1]); // actual render has released T1; T2 holds its own real client
    const saved = await birthRows(ready.who);
    for (const rows of Object.values(saved)) assert.equal(rows.length, 1);
    const companion = saved.platform_companions[0], receipt = saved.platform_companion_birth_receipts[0], asset = saved.platform_companion_birth_assets[0];
    const main = saved.platform_conversations[0], event = saved.messages[0], at = result.receipt.bornAt;
    for (const time of [companion.born_at, companion.stage_changed_at, companion.updated_at, receipt.born_at, asset.created_at, main.created_at, main.updated_at, event.created_at]) assert.equal(time.toISOString(), at);
    assert.equal(companion.status, 'active'); assert.equal(companion.current_revision, 1); assert.equal(companion.relationship_stage, 'acquainting');
    assert.equal(companion.overlays, null); assert.equal(companion.seal_changed_at, null); assert.equal(companion.retired_at, null);
    assert.equal(companion.birth_receipt_id, receipt.id); assert.equal(companion.seal_asset_id, asset.id); assert.equal(companion.birth_idempotency_key, key);
    assert.equal(main.id, result.receipt.main.id); assert.equal(main.kind, 'main'); assert.equal(main.mode, 'companion'); assert.equal(main.persona, null);
    assert.equal(event.id, result.receipt.event.id); assert.equal(event.conversation_id, main.id); assert.equal(event.role, 'system');
    assert.equal(event.kind, 'event'); assert.equal(event.content, ''); assert.equal(event.speaker_kind, 'system'); assert.equal(event.channel, 'system');
    assert.deepEqual(event.payload, { event: 'companion_born', birthReceiptId: receipt.id, companionId: companion.id });
    assert.deepEqual(event.speaker_snapshot, { displayName: '系统', roleLabel: '系统', sealChar: null, ink_token: null, personaRevision: null });
    for (const field of ['provider', 'model', 'lease_until', 'speaker_key', 'speaker_ref']) assert.equal(event[field], null);
    assert.deepEqual(event.attachments, []);
    const origin = openCompanionBirthOrigin(fixture.crypto, ready.who.userId, receipt.id, receipt.request_ciphertext, receipt.snapshot_ciphertext, receipt.request_digest);
    assert.deepEqual(origin.receipt, result.receipt); assert.equal(origin.capture.identity.nameSubmissionId, submitted.submissionId);
    assert.equal(origin.capture.identity.identityRevision, identity.revision); assert.equal(origin.capture.acceptedAuthVersion, '0');
    assert.equal(origin.capture.inventory.tipId, receipt.inventory_tip_id); assert.equal(origin.capture.identity.reviewDigest, ready.authority.review.reviewDigest);
    const actual = openCompanionBirthAssets(fixture.crypto, asset, origin.asset);
    assert.equal(actual.svgSha256, sha(actual.svg)); assert.equal(actual.pngSha256, sha(actual.png)); assert.equal(actual.glyphAssetDigest, glyphDigest);
    assert.equal(actual.pathSha256, sha(glyphPath)); assert.equal(actual.svgByteLength, asset.svg_size_bytes); assert.equal(actual.pngByteLength, asset.png_size_bytes);
    assert.deepEqual(inspectCompanionSealPNG(actual.png), { width: 128, height: 128, byteLength: actual.png.length, sha256: sha(actual.png) });
    assert.equal(asset.svg_ciphertext.includes(Buffer.from('<svg')), false); assert.equal(asset.png_base64_ciphertext.includes(Buffer.from(actual.png.toString('base64'))), false);
    assert.notDeepEqual(asset.svg_ciphertext, actual.svg); assert.notDeepEqual(asset.png_base64_ciphertext, actual.png);
    assert.deepEqual(await birth.readReceipt(ready.who, key), { kind: 'found', receipt: result.receipt });
    const current = await birth.read(ready.who); assert.equal(current.kind, 'active');
    if (current.kind === 'active') { assert.equal(current.companion.main.id, main.id); assert.equal(current.companion.identity.sealAssetId, asset.id); }
    assert.deepEqual(await predecessors(ready.who), predecessor); assert.equal(requests.length, count);
    assert.equal(fixture.db.pool.waitingCount, 0); assert.equal(fixture.db.pool.totalCount, fixture.db.pool.idleCount);
  });
});

test('lost acknowledgement replays the immutable own origin after genuine new login, withdrawal and unavailable current provider, glyph and review', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const f = await readyBirth(fixture, runtime), born = await f.service.birth(f.ready.who, f.body, f.key), original = await birthRows(f.ready.who), count = requests.length;
    const fresh = { userId: f.ready.who.userId, tokenHash: tokenHash(randomUUID()) };
    await fixture.db.transaction(async client => {
      await client.query('UPDATE platform_users SET auth_version=auth_version+1,email_verified_at=NULL WHERE id=$1', [fresh.userId]);
      await client.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
        SELECT id,$2,auth_version,clock_timestamp()+interval '1 hour' FROM platform_users WHERE id=$1`, [fresh.userId, fresh.tokenHash]);
      await client.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [fresh.userId]);
      await client.query('UPDATE platform_terms_policy SET content_digest=$1', ['0'.repeat(64)]);
      await client.query('DELETE FROM platform_companion_identity_policy');
    });
    try {
      const disabled = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: async () => {
        assert.fail('Own birth observation/replay must not use a model provider.');
      } });
      const config = { ...fixture.config, modelRoutes: {} };
      const background = new BackgroundGeneration(fixture.db, config, null, disabled);
      const identities = new CompanionIdentityDrafts(fixture.db, config, null, background, null, null);
      const names = new CompanionNameSafety(fixture.db, config, null, background, identities);
      const prebirth = new CompanionPrebirthSafety(fixture.db, config, null, background, names, identities);
      const cold = new CompanionBirthService(fixture.db, config, null, prebirth, names, background, identities,
        new CompanionBirthOriginStore(fixture.crypto), null);
      await assert.rejects(cold.birth(f.ready.who, f.body, f.key), code('AUTH_REQUIRED'));
      const replay = await cold.birth(fresh, f.body, f.key);
      assert.deepEqual(replay, { ...born, replayed: true });
      assert.deepEqual(await cold.readReceipt(fresh, f.key), { kind: 'found', receipt: born.receipt });
      const active = await cold.read(fresh); assert.equal(active.kind, 'active');
      if (active.kind === 'active') assert.equal(active.companion.main.id, born.receipt.main.id);
      const row = original.platform_companion_birth_receipts[0];
      const sealed = openCompanionBirthOrigin(fixture.crypto, fresh.userId, row.id, row.request_ciphertext, row.snapshot_ciphertext, row.request_digest);
      assert.equal(sealed.capture.acceptedAuthVersion, '0');
      assert.equal((await fixture.db.query('SELECT auth_version FROM platform_users WHERE id=$1', [fresh.userId])).rows[0].auth_version, '1');
      assert.deepEqual(await birthRows(fresh), original); assert.equal(requests.length, count);
    } finally { await seedFictionalActiveLegal(fixture.db); }
  });
});

test('same-key different-body conflicts and a new key for an actually active companion cannot create another origin', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const f = await readyBirth(fixture, runtime), born = await f.service.birth(f.ready.who, f.body, f.key), before = await birthRows(f.ready.who);
    const sources = await predecessors(f.ready.who), count = requests.length;
    await assert.rejects(f.service.birth(f.ready.who, { ...f.body, name: 'Other' }, f.key), code('COMPANION_BIRTH_OPERATION_CONFLICT'));
    await assert.rejects(f.service.birth(f.ready.who, f.body, randomUUID()), code('COMPANION_EXISTS'));
    assert.deepEqual(await f.service.birth(f.ready.who, { ...f.body, name: '  ' + f.body.name + '  ' }, f.key), { ...born, replayed: true });
    assert.deepEqual(await birthRows(f.ready.who), before); assert.deepEqual(await predecessors(f.ready.who), sources); assert.equal(requests.length, count);
  });
});

test('concurrent genuine same-key calls commit one birth and replay the same complete result', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const f = await readyBirth(fixture, runtime), before = await predecessors(f.ready.who), count = requests.length;
    const attempts = await Promise.allSettled([f.service.birth(f.ready.who, f.body, f.key), f.service.birth(f.ready.who, f.body, f.key)]);
    const results = [];
    for (const result of attempts) {
      if (result.status === 'fulfilled') results.push(result.value);
      else {
        // An actual PostgreSQL lock/deadlock timeout has rolled back its bounded
        // transaction. Reobserve the same key after both attempts are terminal.
        assert(['55P03', '40P01'].includes(result.reason?.code));
        results.push(await f.service.birth(f.ready.who, f.body, f.key));
      }
    }
    assert.equal(results.filter(item => !item.replayed).length, 1); assert.equal(results.filter(item => item.replayed).length, 1);
    assert.deepEqual(results[0].receipt, results[1].receipt);
    for (const rows of Object.values(await birthRows(f.ready.who))) assert.equal(rows.length, 1);
    assert.deepEqual(await predecessors(f.ready.who), before); assert.equal(requests.length, count);
    assert.equal(fixture.db.pool.waitingCount, 0); assert.equal(fixture.db.pool.totalCount, fixture.db.pool.idleCount);
  });
});

test('the same operation key belongs independently to each authenticated owner and never leaks a foreign origin', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const own = await readyBirth(fixture, runtime), key = randomUUID(), born = await own.service.birth(own.ready.who, own.body, key);
    const other = await readyBirth(fixture, runtime), count = requests.length;
    assert.deepEqual(await other.service.readReceipt(other.ready.who, key), { kind: 'not_found' });
    assert.deepEqual(await other.service.read(other.ready.who), { kind: 'not_born' });
    await assert.rejects(own.service.readReceipt({ userId: own.ready.who.userId, tokenHash: other.ready.who.tokenHash }, key), code('AUTH_REQUIRED'));
    const otherBorn = await other.service.birth(other.ready.who, other.body, key);
    assert.equal(otherBorn.replayed, false); assert.notEqual(otherBorn.receipt.id, born.receipt.id);
    assert.notEqual(otherBorn.receipt.main.id, born.receipt.main.id); assert.notEqual(otherBorn.receipt.identity.companionId, born.receipt.identity.companionId);
    assert.deepEqual(await own.service.birth(own.ready.who, own.body, key), { ...born, replayed: true });
    assert.deepEqual(await other.service.readReceipt(other.ready.who, key), { kind: 'found', receipt: otherBorn.receipt });
    for (const who of [own.ready.who, other.ready.who]) for (const rows of Object.values(await birthRows(who))) assert.equal(rows.length, 1);
    assert.equal(requests.length, count);
  });
});

test('a real late receipt trigger rejects after all four child inserts and the original transaction rolls back every birth effect', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const f = await readyBirth(fixture, runtime), before = await birthRows(f.ready.who), sources = await predecessors(f.ready.who), count = requests.length;
    const name = 'birth_late_' + randomUUID().replaceAll('-', '');
    await fixture.db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${f.ready.who.userId}'::uuid THEN
        IF (SELECT count(*) FROM platform_conversations WHERE id=NEW.main_conversation_id AND birth_receipt_id=NEW.id)<>1
          OR (SELECT count(*) FROM platform_messages WHERE id=NEW.event_message_id AND birth_receipt_id=NEW.id)<>1
          OR (SELECT count(*) FROM platform_companion_birth_assets WHERE id=NEW.seal_asset_id AND birth_receipt_id=NEW.id)<>1
          OR (SELECT count(*) FROM platform_companion_birth_receipts WHERE id=NEW.id)<>1 THEN
          RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Fictional late birth gate did not observe all four actual child rows';
        END IF;
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Fictional intentional late birth rollback';
      END IF;
      RETURN NEW; END $$`);
    await fixture.db.query(`CREATE TRIGGER ${name} AFTER INSERT ON platform_companion_birth_receipts FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await assert.rejects(f.service.birth(f.ready.who, f.body, f.key), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'P0001');
      assert.deepEqual(await birthRows(f.ready.who), before); assert.deepEqual(await predecessors(f.ready.who), sources);
      assert.deepEqual(await f.service.readReceipt(f.ready.who, f.key), { kind: 'not_found' });
      assert.equal(requests.length, count);
    } finally {
      await fixture.db.query(`DROP TRIGGER IF EXISTS ${name} ON platform_companion_birth_receipts`);
      await fixture.db.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
    const retry = await f.service.birth(f.ready.who, f.body, f.key); assert.equal(retry.replayed, false);
    for (const rows of Object.values(await birthRows(f.ready.who))) assert.equal(rows.length, 1);
    assert.equal(requests.length, count);
  });
});

test('a missing actual glyph or a complete-looking direct identity without genuine full-L0 provenance cannot birth a companion', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const f = await readyBirth(fixture, runtime), before = await birthRows(f.ready.who), sources = await predecessors(f.ready.who), count = requests.length;
    for (const glyphs of [null, { lookup: () => null }]) {
      const birth = createFixtureBirthService(fixture, f, glyphs);
      await assert.rejects(birth.birth(f.ready.who, f.body, f.key), code('COMPANION_SEAL_GLYPH_UNAVAILABLE'));
      assert.deepEqual(await birthRows(f.ready.who), before); assert.deepEqual(await predecessors(f.ready.who), sources);
    }
    assert.equal(requests.length, count);
    const ready = await fixture.ready(runtime);
    const identity = (await ready.names.save(ready.who, { taskId: ready.prepared.taskId, expectedRevision: 0, operationId: randomUUID(), name: 'Juno' })).draft;
    const body = { name: identity.name, sealChar: identity.sealCandidates[0].char };
    await ready.names.saveSelection(ready.who, { taskId: ready.prepared.taskId, expectedIdentityRevision: 1, expectedRevision: 0, operationId: randomUUID(), sealChar: body.sealChar });
    const namesService = new CompanionNameSafety(fixture.db, fixture.config, FICTIONAL_LEGAL, ready.background, ready.names, fixture.resources);
    const prebirth = new CompanionPrebirthSafety(fixture.db, fixture.config, FICTIONAL_LEGAL, ready.background, namesService, ready.names);
    let glyphLookups = 0;
    const birth = createFixtureBirthService(fixture, { ready, namesService, prebirth }, fictionalBirthGlyphs(body.sealChar, () => glyphLookups++));
    const directBefore = await birthRows(ready.who), directSources = await predecessors(ready.who), calls = requests.length;
    await assert.rejects(birth.birth(ready.who, body, randomUUID()), code('COMPANION_NAME_SAFETY_UNAVAILABLE'));
    assert.equal(glyphLookups, 0); assert.deepEqual(await birthRows(ready.who), directBefore); assert.deepEqual(await predecessors(ready.who), directSources);
    assert.equal(requests.length, calls);
  });
});

/** This scheduling barrier waits for a real independent PostgreSQL mutation
 * begun at the actual first glyph lookup. It retains the original bounded
 * transaction implementation and its actual admission/COMMIT/rollback. No
 * query result, authority, origin, renderer or model response is substituted. */
async function withRenderMutation(f: ReadyBirth, mutate: () => Promise<unknown>, run: (birth: CompanionBirthService) => Promise<void>) {
  const original = fixture.db.withBoundedTransaction.bind(fixture.db);
  let order = 0, mutation: Promise<unknown> | undefined, completed = false, lookups = 0, startingMutation = false;
  fixture.db.withBoundedTransaction = function<T>(execute: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean; timeoutMs?: number } = {}): Promise<T> {
    // A real source writer begun by the observation uses the original DB path;
    // it is not the birth service's second transaction and cannot wait on itself.
    if (startingMutation) return original(execute, options);
    const transaction = ++order;
    return original(async client => {
      if (transaction === 2) { assert(mutation); await mutation; assert.equal(completed, true); }
      return execute(client);
    }, options);
  };
  const birth = createFixtureBirthService(fixture, f, fictionalBirthGlyphs(f.body.sealChar, () => {
    lookups++;
    if (lookups === 1) {
      assert.equal(fixture.db.pool.totalCount, fixture.db.pool.idleCount);
      startingMutation = true;
      try { mutation = mutate().then(result => { completed = true; return result; }); mutation.catch(() => {}); }
      finally { startingMutation = false; }
    }
  }));
  try { await run(birth); assert.equal(order, 2); assert.equal(lookups, 1); assert.equal(completed, true); }
  finally { fixture.db.withBoundedTransaction = original; await mutation; }
}

test('actual session, current user name, completed call, new raw name and new explicit selection during native rendering are rechecked before any birth write', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    for (const mode of ['session', 'user_name', 'completion', 'pending_name', 'selection'] as const) {
      const f = await readyBirth(fixture, runtime), before = await birthRows(f.ready.who), count = requests.length;
      await withRenderMutation(f, async () => {
        if (mode === 'pending_name') {
          const saved = await f.ready.safety.submit(f.ready.who, { taskId: f.ready.prepared.taskId, expectedEntryRevision: 1,
            expectedIdentityRevision: 1, operationId: randomUUID(), name: 'Other' });
          assert.equal(saved.entry.revision, 2); assert.equal(saved.entry.status, 'pending'); return;
        }
        if (mode === 'selection') {
          const candidate = f.identity.sealCandidates.find(item => item.char !== f.body.sealChar)!;
          const saved = await f.prebirth.select(f.ready.who, { taskId: f.ready.prepared.taskId, expectedIdentityRevision: 1,
            expectedRevision: 1, operationId: randomUUID(), sealChar: candidate.char });
          assert.equal(saved.selection.revision, 2); assert.equal(saved.selection.selectedSeal, candidate.char); assert.equal(saved.operation.replayed, false); return;
        }
        const changed = mode === 'session'
          ? await fixture.db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [f.ready.who.tokenHash])
          : mode === 'user_name'
            ? await fixture.db.query('UPDATE platform_users SET name=$2 WHERE id=$1', [f.ready.who.userId, f.body.name])
            : await fixture.db.query("UPDATE platform_companion_generation_calls SET status='failed' WHERE user_id=$1", [f.ready.who.userId]);
        assert.equal(changed.rowCount, 1);
      }, async birth => {
        const expected = mode === 'session' ? code('AUTH_REQUIRED') : mode === 'user_name' ? code('NAME_REJECTED')
          : mode === 'pending_name' ? code('COMPANION_NAME_SAFETY_REVIEW_REQUIRED') : mode === 'selection' ? code('SEAL_REJECTED')
          : (error: unknown) => error instanceof ApiError && error.status === 503 && ['DATA_STORAGE_UNAVAILABLE', 'COMPANION_GENERATION_UNAVAILABLE'].includes(error.code);
        await assert.rejects(birth.birth(f.ready.who, f.body, f.key), expected);
      });
      assert.deepEqual(await birthRows(f.ready.who), before); assert.equal(requests.length, count);
    }
  });
});

test('withdrawal preserves the actual immutable birth origin and deleting the actual owner removes the complete origin and all child data', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const f = await readyBirth(fixture, runtime), born = await f.service.birth(f.ready.who, f.body, f.key), saved = await birthRows(f.ready.who), count = requests.length;
    const withdrawn = await fixture.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [f.ready.who.userId]); assert.equal(withdrawn.rowCount, 1);
    assert.deepEqual(await f.service.readReceipt(f.ready.who, f.key), { kind: 'found', receipt: born.receipt });
    assert.deepEqual(await f.service.birth(f.ready.who, f.body, f.key), { ...born, replayed: true });
    assert.deepEqual(await birthRows(f.ready.who), saved);
    const deleted = await fixture.db.query('DELETE FROM platform_users WHERE id=$1', [f.ready.who.userId]); assert.equal(deleted.rowCount, 1);
    for (const rows of Object.values(await birthRows(f.ready.who))) assert.deepEqual(rows, []);
    for (const rows of Object.values(await predecessors(f.ready.who))) assert.deepEqual(rows, []);
    assert.equal((await fixture.db.query('SELECT id FROM platform_messages WHERE id=$1', [born.receipt.event.id])).rowCount, 0);
    assert.equal((await fixture.db.query('SELECT token_hash FROM platform_sessions WHERE user_id=$1', [f.ready.who.userId])).rowCount, 0);
    await assert.rejects(f.service.readReceipt(f.ready.who, f.key), code('AUTH_REQUIRED'));
    assert.equal(requests.length, count);
  });
});
