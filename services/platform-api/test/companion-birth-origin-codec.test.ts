import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCompanionSealRenderer } from '../src/companion-seal-rendering.ts';
import { sealCompanionBirthAssets } from '../src/companion-birth-assets.ts';
import { readDataCrypto } from '../src/data-crypto.ts';
import { ApiError } from '../src/errors.ts';
import {
  companionBirthDigest, openCompanionBirthOrigin, parseCompanionBirthOrigin, sealCompanionBirthOrigin,
} from '../src/companion-birth-origin-codec.ts';

// Synthetic source coordinates establish codec/storage integrity only. These
// unit cases do not establish live sessions, review or permission to give birth.
const crypto = readDataCrypto({ PLATFORM_DATA_KEY: 'c3'.repeat(32) })!;
const failed = (error: unknown) => error instanceof ApiError && error.status === 503
  && error.code === 'COMPANION_BIRTH_STORAGE_UNAVAILABLE';
const rendered = createCompanionSealRenderer({ lookup: () => ({ path: 'M20 20 H80 V80 H20 Z', assetDigest: 'a'.repeat(64) }) })
  .render({ sealChar: '墨', inkToken: 'yanzhi' });

async function fixture() {
  const ownerId = randomUUID(), companionId = randomUUID(), taskId = randomUUID(), receiptId = randomUUID(), assetId = randomUUID();
  const mainId = randomUUID(), eventId = randomUUID(), idempotencyKey = randomUUID(), bornAt = '2026-10-08T08:01:02.003Z';
  const assets = sealCompanionBirthAssets(crypto, { id: assetId, ownerId, companionId, birthReceiptId: receiptId,
    bornAt, sealChar: '墨', inkToken: 'yanzhi' }, await rendered);
  const value = { schemaVersion: 1, ownerId, command: { idempotencyKey, request: { name: 'Juno', sealChar: '墨' } },
    capture: { ownerId, acceptedAuthVersion: '0', terms: { version: 'fictional-terms-v1', contentDigest: 'b'.repeat(64), reviewDigest: 'c'.repeat(64) },
      task: { id: taskId, companionId, answersId: randomUUID(), generation: 1, sourceDraftId: randomUUID(), sourceRevision: 4, sourceReceiptVersion: null },
      prefix: null, inventory: { tipId: randomUUID(), revision: 8, tipDigest: 'd'.repeat(64) },
      identity: { identityDraftId: randomUUID(), companionId, taskId, identityRevision: 2, name: 'Juno', nameOrigin: 'user_typed', sealChar: '墨',
        sealCandidates: [{ char: '墨', reason: 'Fictional first choice.' }, { char: '舟', reason: 'Fictional second choice.' }, { char: '如', reason: 'Fictional third choice.' }],
        inkToken: 'yanzhi', selectionId: randomUUID(), selectionOperationId: randomUUID(), selectionRevision: 3,
        nameApplicationOperationId: randomUUID(), nameSubmissionId: randomUUID(), nameGeneration: 1, bundleRevision: 7,
        contentDigest: 'e'.repeat(64), reviewDigest: 'f'.repeat(64), identityPayloadDigest: '1'.repeat(64),
        selectionPayloadDigest: '2'.repeat(64), selectionOperationPayloadDigest: '3'.repeat(64) } },
    receipt: { kind: 'birth_receipt', id: receiptId, idempotencyKey, bornAt,
      identity: { companionId, name: 'Juno', nameOrigin: 'user_typed', sealChar: '墨', inkToken: 'yanzhi', personaRevision: 1,
        identityRevision: 2, selectionRevision: 3, sealAssetId: assetId },
      main: { id: mainId, kind: 'main', companionId }, event: { id: eventId, conversationId: mainId, companionId, kind: 'event',
        event: 'companion_born', speakerKind: 'system', createdAt: bornAt,
        speakerSnapshot: { displayName: '系统', roleLabel: '系统', sealChar: null, inkToken: null, personaRevision: null } } }, asset: assets.snapshot };
  return { value, sealed: sealCompanionBirthOrigin(crypto, value) };
}
function open(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<{
  ownerId: string; rowId: string; request: Buffer; snapshot: Buffer; digest: string;
}> = {}) {
  return openCompanionBirthOrigin(crypto, overrides.ownerId ?? f.value.ownerId, overrides.rowId ?? f.value.receipt.id,
    overrides.request ?? f.sealed.requestCiphertext, overrides.snapshot ?? f.sealed.snapshotCiphertext, overrides.digest ?? f.sealed.requestDigest);
}

test('birth origin authenticates actual request/capture/receipt/asset and preserves historical auth coordinates', async () => {
  const f = await fixture(), result = open(f);
  assert.deepEqual(result, parseCompanionBirthOrigin(f.value));
  assert.equal(result.capture.acceptedAuthVersion, '0');
  assert.equal(result.asset.svgCipherDigest, f.value.asset.svgCipherDigest);
  assert(Object.isFrozen(result) && Object.isFrozen(result.capture.identity.sealCandidates));
  assert.notEqual(f.sealed.requestCiphertext.toString('utf8'), JSON.stringify(result.command));
});

test('origin AEAD rejects another owner, another receipt, swapped columns, corrupt ciphertext and missing key', async () => {
  const f = await fixture();
  assert.throws(() => open(f, { ownerId: randomUUID() }), failed);
  assert.throws(() => open(f, { rowId: randomUUID() }), failed);
  assert.throws(() => open(f, { request: f.sealed.snapshotCiphertext, snapshot: f.sealed.requestCiphertext }), failed);
  const corrupt = Buffer.from(f.sealed.snapshotCiphertext); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => open(f, { snapshot: corrupt }), failed);
  assert.throws(() => open(f, { digest: '0'.repeat(64) }), failed);
  assert.throws(() => openCompanionBirthOrigin(undefined, f.value.ownerId, f.value.receipt.id,
    f.sealed.requestCiphertext, f.sealed.snapshotCiphertext, f.sealed.requestDigest), failed);
});

test('authenticated reordered or duplicate-field JSON is rejected rather than normalized', async () => {
  const f = await fixture(), rowId = f.value.receipt.id, ownerId = f.value.ownerId;
  const binding = { table: 'platform_companion_birth_receipts', rowId, ownerId, revision: 1 };
  const reordered = JSON.stringify({ request: f.sealed.snapshot.command.request, idempotencyKey: f.value.command.idempotencyKey });
  assert.throws(() => open(f, { request: crypto.sealUtf8(reordered, { ...binding, column: 'request_ciphertext' }),
    digest: companionBirthDigest(reordered) }), failed);
  const original = JSON.stringify(f.sealed.snapshot);
  const duplicate = original.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
  assert.throws(() => open(f, { snapshot: crypto.sealUtf8(duplicate, { ...binding, column: 'snapshot_ciphertext' }) }), failed);
});

test('origin closed descriptors reject getters, hidden fields, symbols and custom prototypes without executing them', async () => {
  const f = await fixture(); let invoked = 0;
  const getter = { ...f.value }; Object.defineProperty(getter, 'capture', { enumerable: true, get() { invoked++; return f.value.capture; } });
  assert.throws(() => parseCompanionBirthOrigin(getter), failed);
  const hidden = { ...f.value }; Object.defineProperty(hidden, 'privateOverride', { value: true });
  assert.throws(() => parseCompanionBirthOrigin(hidden), failed);
  assert.throws(() => parseCompanionBirthOrigin({ ...f.value, [Symbol('extra')]: 1 }), failed);
  assert.throws(() => parseCompanionBirthOrigin(Object.assign(Object.create({ inherited: true }), f.value)), failed);
  const badCandidates = [...f.value.capture.identity.sealCandidates];
  Object.defineProperty(badCandidates, '0', { enumerable: true, get() { invoked++; return f.value.capture.identity.sealCandidates[0]; } });
  assert.throws(() => parseCompanionBirthOrigin({ ...f.value, capture: { ...f.value.capture,
    identity: { ...f.value.capture.identity, sealCandidates: badCandidates } } }), failed);
  assert.equal(invoked, 0);
});

test('capture, receipt and encrypted asset cannot be mixed across legitimate-shaped origins', async () => {
  const f = await fixture(), other = await fixture();
  for (const change of [
    { capture: other.value.capture }, { receipt: other.value.receipt }, { asset: other.value.asset },
    { receipt: { ...f.value.receipt, identity: { ...f.value.receipt.identity, identityRevision: 3 } } },
    { command: { ...f.value.command, request: { ...f.value.command.request, name: '  Juno  ' } } },
    { capture: { ...f.value.capture, identity: { ...f.value.capture.identity, sealChar: '舟' } } },
  ]) assert.throws(() => sealCompanionBirthOrigin(crypto, { ...f.value, ...change }), failed);
});

test('historical prefix and task version remain exact, with no legacy prefix manufactured on decode', async () => {
  const f = await fixture(); assert.equal(open(f).capture.prefix, null);
  const prefix = { id: f.value.capture.task.id, version: 2, digest: '4'.repeat(64) };
  assert.throws(() => parseCompanionBirthOrigin({ ...f.value, capture: { ...f.value.capture, prefix } }), failed);
  const modern = { ...f.value, capture: { ...f.value.capture, task: { ...f.value.capture.task, sourceReceiptVersion: 2 }, prefix } };
  assert.equal(sealCompanionBirthOrigin(crypto, modern).snapshot.capture.prefix?.version, 2);
  assert.throws(() => parseCompanionBirthOrigin({ ...modern, capture: { ...modern.capture, prefix: { ...prefix, id: randomUUID() } } }), failed);
  for (const version of ['00', '-1', '9223372036854775808']) assert.throws(() => parseCompanionBirthOrigin({ ...f.value,
    capture: { ...f.value.capture, acceptedAuthVersion: version } }), failed);
});
