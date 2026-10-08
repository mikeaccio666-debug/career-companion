import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createCompanionSealRenderer } from '../src/companion-seal-rendering.ts';
import { sealCompanionBirthAssets } from '../src/companion-birth-assets.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { ApiError } from '../src/errors.ts';
import { sealCompanionBirthOrigin } from '../src/companion-birth-origin-codec.ts';
import { CompanionBirthOriginStore } from '../src/companion-birth-origin-store.ts';

// These synthetic persisted rows exercise the authenticated read boundary.
// The row provider is not a session, authorization or a PostgreSQL COMMIT proof;
// service integration tests separately exercise actual transactions and gates.
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: 'c4'.repeat(32) })!;
const store = new CompanionBirthOriginStore(crypto);
const failed = (error: unknown) => error instanceof ApiError && error.status === 503
  && error.code === 'COMPANION_BIRTH_STORAGE_UNAVAILABLE';
const renderer = createCompanionSealRenderer({ lookup: () => ({ path: 'M20 20 H80 V80 H20 Z', assetDigest: 'a'.repeat(64) }) });
const rendered = renderer.render({ sealChar: '墨', inkToken: 'yanzhi' });
type Row = Record<string, any>;

async function fixture() {
  const ownerId = randomUUID(), companionId = randomUUID(), taskId = randomUUID(), receiptId = randomUUID(), assetId = randomUUID();
  const mainId = randomUUID(), eventId = randomUUID(), idempotencyKey = randomUUID(), bornAt = '2026-10-08T08:01:02.003Z', bornDate = new Date(bornAt);
  const assets = sealCompanionBirthAssets(crypto, { id: assetId, ownerId, companionId, birthReceiptId: receiptId,
    bornAt, sealChar: '墨', inkToken: 'yanzhi' }, await rendered);
  const capture = { ownerId, acceptedAuthVersion: '0', terms: { version: 'fictional-terms-v1', contentDigest: 'b'.repeat(64), reviewDigest: 'c'.repeat(64) },
    task: { id: taskId, companionId, answersId: randomUUID(), generation: 1, sourceDraftId: randomUUID(), sourceRevision: 4, sourceReceiptVersion: null },
    prefix: null, inventory: { tipId: randomUUID(), revision: 8, tipDigest: 'd'.repeat(64) },
    identity: { identityDraftId: randomUUID(), companionId, taskId, identityRevision: 2, name: 'Juno', nameOrigin: 'user_typed', sealChar: '墨',
      sealCandidates: [{ char: '墨', reason: 'Fictional first choice.' }, { char: '舟', reason: 'Fictional second choice.' }, { char: '如', reason: 'Fictional third choice.' }],
      inkToken: 'yanzhi', selectionId: randomUUID(), selectionOperationId: randomUUID(), selectionRevision: 3,
      nameApplicationOperationId: randomUUID(), nameSubmissionId: randomUUID(), nameGeneration: 1, bundleRevision: 7,
      contentDigest: 'e'.repeat(64), reviewDigest: 'f'.repeat(64), identityPayloadDigest: '1'.repeat(64),
      selectionPayloadDigest: '2'.repeat(64), selectionOperationPayloadDigest: '3'.repeat(64) } };
  const request = { idempotencyKey, request: { name: 'Juno', sealChar: '墨' } };
  const sealed = sealCompanionBirthOrigin(crypto, { schemaVersion: 1, ownerId, command: request, capture, asset: assets.snapshot,
    receipt: { kind: 'birth_receipt', id: receiptId, idempotencyKey, bornAt,
      identity: { companionId, name: 'Juno', nameOrigin: 'user_typed', sealChar: '墨', inkToken: 'yanzhi', personaRevision: 1,
        identityRevision: 2, selectionRevision: 3, sealAssetId: assetId },
      main: { id: mainId, kind: 'main', companionId }, event: { id: eventId, conversationId: mainId, companionId, kind: 'event',
        event: 'companion_born', speakerKind: 'system', createdAt: bornAt,
        speakerSnapshot: { displayName: '系统', roleLabel: '系统', sealChar: null, inkToken: null, personaRevision: null } } } });
  const { task, identity, inventory } = capture;
  const receiptRow: Row = { id: receiptId, user_id: ownerId, companion_id: companionId, idempotency_key: idempotencyKey,
    request_digest: sealed.requestDigest, request_ciphertext: sealed.requestCiphertext, snapshot_ciphertext: sealed.snapshotCiphertext,
    snapshot_schema_version: 1, accepted_auth_version: '0', terms_version: capture.terms.version, terms_content_digest: capture.terms.contentDigest,
    task_id: task.id, generation: task.generation, answers_id: task.answersId, source_draft_id: task.sourceDraftId, source_revision: task.sourceRevision,
    preview_revision: 1, source_prefix_id: null, source_prefix_version: null, source_prefix_digest: null,
    inventory_tip_id: inventory.tipId, inventory_revision: inventory.revision, inventory_tip_digest: inventory.tipDigest,
    identity_draft_id: identity.identityDraftId, identity_revision: 2, name_application_operation_id: identity.nameApplicationOperationId,
    name_submission_id: identity.nameSubmissionId, name_generation: 1, selection_id: identity.selectionId,
    selection_operation_id: identity.selectionOperationId, selection_revision: 3, bundle_revision: 7, content_digest: identity.contentDigest,
    review_digest: identity.reviewDigest, born_name: 'Juno', name_origin: 'user_typed', seal_char: '墨', ink_token: 'yanzhi',
    main_conversation_id: mainId, event_message_id: eventId, seal_asset_id: assetId, born_at: bornDate };
  const companionRow: Row = { id: companionId, user_id: ownerId, status: 'active', current_revision: 1,
    birth_receipt_id: receiptId, birth_idempotency_key: idempotencyKey, born_at: bornDate, name: 'Juno', name_origin: 'user_typed',
    seal_char: '墨', seal_candidates: identity.sealCandidates, seal_changed_at: null, ink_token: 'yanzhi',
    relationship_stage: 'acquainting', stage_changed_at: bornDate, retired_at: null, seal_asset_id: assetId, overlays: null };
  const rows: Record<string, Row[]> = {
    platform_companion_birth_receipts: [receiptRow], platform_companion_birth_assets: [{ ...assets.row }], platform_companions: [companionRow],
    platform_conversations: [{ id: mainId, user_id: ownerId, kind: 'main', companion_id: companionId, birth_receipt_id: receiptId,
      mode: 'companion', persona: null, created_at: bornDate }],
    platform_messages: [{ id: eventId, conversation_id: mainId, user_id: ownerId, companion_id: companionId, room_kind: 'main',
      birth_receipt_id: receiptId, role: 'system', kind: 'event', content: '', status: 'complete', provider: null, model: null, lease_until: null,
      speaker_kind: 'system', speaker_key: null, speaker_ref: null, channel: 'system', created_at: bornDate, attachments: [],
      speaker_snapshot: { displayName: '系统', roleLabel: '系统', sealChar: null, ink_token: null, personaRevision: null },
      payload: { event: 'companion_born', birthReceiptId: receiptId, companionId } }],
  };
  const queries: string[] = [];
  const client = { async query(sql: string, args: any[]) {
    queries.push(sql);
    assert(sql.startsWith('SELECT'), 'The own-origin read must have no writes or execution side effects.');
    const table = /FROM ([a-z_]+)/.exec(sql)?.[1]; assert(table && Object.hasOwn(rows, table));
    assert(sql.includes('FOR SHARE') || sql.includes('FOR UPDATE'));
    let result: Row[];
    if (table === 'platform_companion_birth_receipts' && sql.includes('user_id=$1 AND idempotency_key=$2')) {
      result = rows[table].filter(row => row.user_id === args[0] && row.idempotency_key === args[1]);
    } else if (table === 'platform_companions' && sql.includes('status IN')) {
      assert(sql.includes('user_id=$1'));
      result = rows[table].filter(row => row.user_id === args[0] && ['drafting', 'awaiting_name', 'active'].includes(row.status));
    } else {
      assert(sql.includes('id=$1 AND user_id=$2'));
      result = rows[table].filter(row => row.id === args[0] && row.user_id === args[1]);
    }
    return { rowCount: result.length, rows: result };
  } } as unknown as PoolClient;
  return { ownerId, idempotencyKey, sealed, rows, client, queries, capture, request };
}

test('own replay returns immutable original identity while current projection reflects a later name/stage', async () => {
  const f = await fixture();
  Object.assign(f.rows.platform_companions[0], { name: 'Nova', relationship_stage: 'familiar', stage_changed_at: new Date('2026-10-09T00:00:00.000Z') });
  const replay = await store.findOwn(f.client, f.ownerId, f.idempotencyKey); assert(replay);
  assert.equal(replay.receipt.identity.name, 'Juno');
  const current = await store.readCurrent(f.client, f.ownerId); assert.equal(current.kind, 'active');
  if (current.kind === 'active') { assert.equal(current.companion.identity.name, 'Nova'); assert.equal(current.companion.relationshipStage, 'familiar'); }
  assert(f.queries.every(sql => !/policy|legal|sessions|generation_tasks|identity_drafts/.test(sql)));
  assert.equal(f.rows.platform_companions[0].overlays, null);
});

test('same key is owner scoped, absent receipt stays absent, and damaged existing receipt never becomes not found', async () => {
  const f = await fixture();
  assert.equal(await store.findOwn(f.client, randomUUID(), f.idempotencyKey), null);
  assert.equal(await store.findOwn(f.client, f.ownerId, randomUUID()), null);
  const corrupt = Buffer.from(f.rows.platform_companion_birth_receipts[0].snapshot_ciphertext); corrupt[30] ^= 1;
  f.rows.platform_companion_birth_receipts[0].snapshot_ciphertext = corrupt;
  await assert.rejects(store.findOwn(f.client, f.ownerId, f.idempotencyKey), failed);
  await assert.rejects(store.readCurrent(f.client, f.ownerId), failed);
});

test('authenticated private history must agree with every clear receipt coordinate', async () => {
  const f = await fixture(), row = f.rows.platform_companion_birth_receipts[0];
  for (const [key, changed] of Object.entries({ accepted_auth_version: '1', terms_content_digest: '0'.repeat(64), task_id: randomUUID(),
    generation: 2, source_revision: 5, inventory_tip_digest: '0'.repeat(64), name_generation: 2, born_name: 'Nova',
    identity_revision: 3, selection_revision: 4, review_digest: '0'.repeat(64), main_conversation_id: randomUUID(), seal_asset_id: randomUUID() })) {
    const original = row[key]; row[key] = changed;
    await assert.rejects(store.findOwn(f.client, f.ownerId, f.idempotencyKey), failed); row[key] = original;
  }
  row.born_at = new Date('2026-10-08T08:01:02.004Z');
  await assert.rejects(store.findOwn(f.client, f.ownerId, f.idempotencyKey), failed);
});

test('missing, foreign-owned or relinked main/event/companion/asset cannot be accepted as an intact origin', async () => {
  const f = await fixture();
  for (const table of ['platform_companions', 'platform_conversations', 'platform_messages', 'platform_companion_birth_assets']) {
    const original = f.rows[table]; f.rows[table] = [];
    await assert.rejects(store.findOwn(f.client, f.ownerId, f.idempotencyKey), failed); f.rows[table] = original;
    const owner = original[0].user_id; original[0].user_id = randomUUID();
    await assert.rejects(store.findOwn(f.client, f.ownerId, f.idempotencyKey), failed); original[0].user_id = owner;
    const receipt = original[0].birth_receipt_id; original[0].birth_receipt_id = randomUUID();
    await assert.rejects(store.findOwn(f.client, f.ownerId, f.idempotencyKey), failed); original[0].birth_receipt_id = receipt;
  }
});

test('system event rejects provider/model/lease data, invented text, malformed system snapshot and payload', async () => {
  const f = await fixture(), row = f.rows.platform_messages[0];
  for (const [key, changed] of Object.entries({ provider: 'fictional-provider', model: 'fictional-model', content: 'Invented first letter.',
    speaker_kind: 'companion', speaker_snapshot: { ...row.speaker_snapshot, displayName: 'Juno' },
    payload: { ...row.payload, extra: 'invented' }, attachments: [randomUUID()], lease_until: new Date() })) {
    const original = row[key]; row[key] = changed;
    await assert.rejects(store.findOwn(f.client, f.ownerId, f.idempotencyKey), failed); row[key] = original;
  }
});

test('original asset ciphertext remains bound to origin, and current safety/stage is not inferred from birth', async () => {
  const f = await fixture(), assets = f.rows.platform_companion_birth_assets[0];
  const corrupt = Buffer.from(assets.png_base64_ciphertext); corrupt[corrupt.length - 1] ^= 1;
  assets.png_base64_ciphertext = corrupt;
  await assert.rejects(store.findOwn(f.client, f.ownerId, f.idempotencyKey), failed);
  const fresh = await fixture(); fresh.rows.platform_companions[0].stage_changed_at = new Date('2026-10-07T00:00:00.000Z');
  await assert.rejects(store.readCurrent(fresh.client, fresh.ownerId), failed);
  assert.equal(fresh.rows.platform_companions[0].overlays, null);
});

test('seal lookup is owner scoped and missing or foreign opaque ids expose no origin rows', async () => {
  const f = await fixture(), assetId = f.sealed.snapshot.asset.id;
  assert.equal(await store.readSealAsset(f.client, randomUUID(), assetId), null);
  assert.equal(await store.readSealAsset(f.client, f.ownerId, randomUUID()), null);
  assert.equal(f.queries.length, 2);
  assert(f.queries.every(sql => sql === 'SELECT * FROM platform_companion_birth_assets WHERE id=$1 AND user_id=$2 FOR SHARE'));
});

test('an existing protected seal cannot be read without crypto or from ambiguous persisted coordinates', async () => {
  const f = await fixture(), assetId = f.sealed.snapshot.asset.id;
  await assert.rejects(new CompanionBirthOriginStore(undefined).readSealAsset(f.client, f.ownerId, assetId), failed);
  f.rows.platform_companion_birth_assets.push({ ...f.rows.platform_companion_birth_assets[0] });
  await assert.rejects(store.readSealAsset(f.client, f.ownerId, assetId), failed);
});

test('protected delivery returns the original native SVG and PNG with independent buffers on every read', async () => {
  const f = await fixture(), assetId = f.sealed.snapshot.asset.id, original = await rendered;
  const first = await store.readSealAsset(f.client, f.ownerId, assetId); assert(first);
  assert.deepEqual(first.svg, original.svg); assert.deepEqual(first.png, original.png);
  assert.equal(first.svgSha256, original.svgSha256); assert.equal(first.pngSha256, original.pngSha256);
  assert.equal(first.pathSha256, original.pathSha256); assert.equal(first.glyphAssetDigest, original.glyphAssetDigest);
  assert(Object.isFrozen(first));
  first.svg.fill(0); first.png.fill(0);
  const second = await store.readSealAsset(f.client, f.ownerId, assetId); assert(second);
  assert.notStrictEqual(second.svg, first.svg); assert.notStrictEqual(second.png, first.png);
  assert.deepEqual(second.svg, original.svg); assert.deepEqual(second.png, original.png);
  assert(f.queries.every(sql => !/policy|legal|sessions|generation_tasks|identity_drafts|glyph/.test(sql)));
  assert.equal(f.rows.platform_companions[0].overlays, null);
});

test('an existing owned seal needs its intact owned immutable receipt and all origin children', async () => {
  const f = await fixture(), assetId = f.sealed.snapshot.asset.id;
  for (const table of ['platform_companion_birth_receipts', 'platform_companions', 'platform_conversations', 'platform_messages']) {
    const original = f.rows[table]; f.rows[table] = [];
    await assert.rejects(store.readSealAsset(f.client, f.ownerId, assetId), failed); f.rows[table] = original;
    const owner = original[0].user_id; original[0].user_id = randomUUID();
    await assert.rejects(store.readSealAsset(f.client, f.ownerId, assetId), failed); original[0].user_id = owner;
  }
  for (const table of ['platform_companions', 'platform_conversations', 'platform_messages', 'platform_companion_birth_assets']) {
    const row = f.rows[table][0], original = row.birth_receipt_id; row.birth_receipt_id = randomUUID();
    await assert.rejects(store.readSealAsset(f.client, f.ownerId, assetId), failed); row.birth_receipt_id = original;
  }
  const receipt = f.rows.platform_companion_birth_receipts[0], original = receipt.seal_asset_id;
  receipt.seal_asset_id = randomUUID();
  await assert.rejects(store.readSealAsset(f.client, f.ownerId, assetId), failed); receipt.seal_asset_id = original;
});

test('protected seal rejects damaged origin envelopes, clear hashes, sizes, timestamps and asset ciphertext', async () => {
  const f = await fixture(), assetId = f.sealed.snapshot.asset.id;
  const receipt = f.rows.platform_companion_birth_receipts[0], asset = f.rows.platform_companion_birth_assets[0];
  for (const [row, column] of [[receipt, 'request_ciphertext'], [receipt, 'snapshot_ciphertext'],
    [asset, 'svg_ciphertext'], [asset, 'png_base64_ciphertext']] as const) {
    const original = row[column], corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
    row[column] = corrupt; await assert.rejects(store.readSealAsset(f.client, f.ownerId, assetId), failed); row[column] = original;
  }
  for (const [row, changes] of [[receipt, { request_digest: '0'.repeat(64), born_at: new Date('2026-10-08T08:01:02.004Z') }],
    [asset, { svg_digest: '0'.repeat(64), png_digest: '0'.repeat(64), glyph_source_digest: '0'.repeat(64),
      svg_size_bytes: asset.svg_size_bytes + 1, png_size_bytes: asset.png_size_bytes + 1,
      created_at: new Date('2026-10-08T08:01:02.004Z'), seal_char: '舟', ink_token: 'ganlan' }]] as const) {
    for (const [column, changed] of Object.entries(changes)) {
      const original = row[column]; row[column] = changed;
      await assert.rejects(store.readSealAsset(f.client, f.ownerId, assetId), failed); row[column] = original;
    }
  }
  assert(await store.readSealAsset(f.client, f.ownerId, assetId));
});

test('a newly valid envelope of the same seal bytes cannot replace the original envelope authenticated by the receipt', async () => {
  const f = await fixture(), expected = f.sealed.snapshot.asset;
  const replacement = sealCompanionBirthAssets(crypto, { id: expected.id, ownerId: expected.ownerId,
    companionId: expected.companionId, birthReceiptId: expected.birthReceiptId, bornAt: expected.bornAt,
    sealChar: expected.sealChar, inkToken: expected.inkToken }, await rendered);
  assert.notDeepEqual(replacement.row.svg_ciphertext, f.rows.platform_companion_birth_assets[0].svg_ciphertext);
  assert.equal(replacement.row.svg_digest, expected.svgDigest); assert.equal(replacement.row.png_digest, expected.pngDigest);
  f.rows.platform_companion_birth_assets[0] = { ...replacement.row };
  await assert.rejects(store.readSealAsset(f.client, f.ownerId, expected.id), failed);
});

test('retired companion seal remains readable from its immutable birth independently of its current projection', async () => {
  const f = await fixture(), original = await rendered;
  Object.assign(f.rows.platform_companions[0], { status: 'retired', retired_at: new Date('2026-10-09T00:00:00.000Z'),
    name: 'Nova', relationship_stage: 'familiar', seal_char: '舟', ink_token: 'ganlan' });
  const saved = await store.readSealAsset(f.client, f.ownerId, f.sealed.snapshot.asset.id); assert(saved);
  assert.deepEqual(saved.svg, original.svg); assert.deepEqual(saved.png, original.png);
  assert.equal((await store.readCurrent(f.client, f.ownerId)).kind, 'not_born');
  assert(f.queries.every(sql => !/policy|legal|sessions|generation_tasks|identity_drafts|glyph/.test(sql)));
});

test('different-key birth sees a genuine active origin as conflict; drafting and malformed unborn state remain distinct', async () => {
  const f = await fixture();
  await assert.rejects(store.assertUnborn(f.client, f.ownerId), (error: unknown) => error instanceof ApiError && error.code === 'COMPANION_EXISTS');
  const row = f.rows.platform_companions[0];
  for (const key of ['name', 'name_origin', 'seal_char', 'seal_candidates', 'seal_changed_at', 'ink_token', 'relationship_stage',
    'stage_changed_at', 'birth_receipt_id', 'birth_idempotency_key', 'born_at', 'retired_at', 'seal_asset_id']) row[key] = null;
  row.status = 'awaiting_name';
  await store.assertUnborn(f.client, f.ownerId);
  assert.equal((await store.readCurrent(f.client, f.ownerId)).kind, 'not_born');
  row.name = 'Partial origin'; await assert.rejects(store.assertUnborn(f.client, f.ownerId), failed); row.name = null;
  row.status = 'drafting'; row.current_revision = 0;
  await assert.rejects(store.assertUnborn(f.client, f.ownerId), (error: unknown) => error instanceof ApiError && error.code === 'PERSONA_NOT_ACCEPTED');
});

test('missing protected storage cannot begin writing a birth even when a rendered seal exists', async () => {
  const f = await fixture(); let queries = 0;
  const client = { query() { queries++; throw new Error('No statement should run.'); } } as unknown as PoolClient;
  await assert.rejects(new CompanionBirthOriginStore(undefined).writeAtomic(client, { userId: f.ownerId, tokenHash: 'fictional-unused' },
    f.sealed.snapshot.command, f.sealed.snapshot.capture, await rendered), failed);
  assert.equal(queries, 0);
});
