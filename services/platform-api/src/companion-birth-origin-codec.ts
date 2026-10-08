import { createHash } from 'node:crypto';
import {
  COMPANION_INK_TOKENS, parseCompanionBirthCommand, parseCompanionBirthReceipt,
  type CompanionBirthCommand, type CompanionPublicInkToken, type PublicCompanionBirthReceipt, type PublicCompanionSealCandidates,
} from '@companion/platform-contracts';
import type { BirthCapture, BirthIdentityCapture } from './companion-birth-types.ts';
import { parseCompanionBirthAssetSnapshot, type CompanionBirthAssetSnapshot } from './companion-birth-assets.ts';
import { MAX_DATA_PLAINTEXT_BYTES, type DataCrypto } from './data-crypto.ts';
import { ApiError } from './errors.ts';

/** Historical facts authenticated at commit, never current admission or a
 * reconstructed session. No raw questionnaire text or model output is copied. */
export interface CompanionBirthOriginSnapshot {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly command: Readonly<CompanionBirthCommand>;
  readonly capture: Readonly<BirthCapture>;
  readonly receipt: Readonly<PublicCompanionBirthReceipt>;
  readonly asset: Readonly<CompanionBirthAssetSnapshot>;
}

export const companionBirthStorageUnavailable = () => new ApiError(503,
  'COMPANION_BIRTH_STORAGE_UNAVAILABLE', 'The saved companion birth is not available.');
function bad(): never { throw companionBirthStorageUnavailable(); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export const companionBirthDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Closed data descriptors avoid evaluating accessors, toJSON or prototypes. */
export function birthFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad();
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(entry => !('value' in entry) || !entry.enumerable)) bad();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function matching(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) bad();
  return value;
}
export const birthUUID = (value: unknown) => matching(value, UUID);
const digest = (value: unknown) => matching(value, HASH);
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < 1 || (value as number) > 2147483647) bad();
  return value as number;
}
function authVersion(value: unknown): string {
  const result = matching(value, /^(0|[1-9][0-9]{0,18})$/);
  if (BigInt(result) > 9223372036854775807n) bad();
  return result;
}
function candidates(value: unknown): PublicCompanionSealCandidates {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3) bad();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 4 || !['0', '1', '2', 'length'].every(key => Object.hasOwn(descriptors, key))
    || ['0', '1', '2'].some(key => !('value' in descriptors[key]) || !descriptors[key].enumerable)) bad();
  const result = ['0', '1', '2'].map(key => {
    const item = birthFields(descriptors[key].value, ['char', 'reason']);
    const char = matching(item.char, /^\p{Script=Han}$/u);
    if (typeof item.reason !== 'string' || !item.reason.trim() || Buffer.byteLength(item.reason, 'utf8') > 1200
      || /[\p{Cc}\ud800-\udfff]/u.test(item.reason) || Buffer.from(item.reason, 'utf8').toString('utf8') !== item.reason) bad();
    return Object.freeze({ char, reason: item.reason });
  });
  if (new Set(result.map(item => item.char)).size !== 3) bad();
  return Object.freeze(result) as unknown as PublicCompanionSealCandidates;
}

export function parseBirthCapture(value: unknown): Readonly<BirthCapture> {
  try {
    const data = birthFields(value, ['ownerId', 'acceptedAuthVersion', 'terms', 'task', 'prefix', 'inventory', 'identity']);
    const terms = birthFields(data.terms, ['version', 'contentDigest', 'reviewDigest']);
    const task = birthFields(data.task, ['id', 'companionId', 'answersId', 'generation', 'sourceDraftId', 'sourceRevision', 'sourceReceiptVersion']);
    const inventory = birthFields(data.inventory, ['tipId', 'revision', 'tipDigest']);
    const identity = birthFields(data.identity, ['identityDraftId', 'companionId', 'taskId', 'identityRevision', 'name', 'nameOrigin',
      'sealChar', 'sealCandidates', 'inkToken', 'selectionId', 'selectionOperationId', 'selectionRevision',
      'nameApplicationOperationId', 'nameSubmissionId', 'nameGeneration', 'bundleRevision', 'contentDigest', 'reviewDigest',
      'identityPayloadDigest', 'selectionPayloadDigest', 'selectionOperationPayloadDigest']);
    const parsedRequest = parseCompanionBirthCommand({ name: identity.name, sealChar: identity.sealChar }, task.id).request;
    if (parsedRequest.name !== identity.name || identity.nameOrigin !== 'user_typed') bad();
    const sealCandidates = candidates(identity.sealCandidates);
    if (!sealCandidates.some(item => item.char === identity.sealChar)) bad();
    if (typeof identity.inkToken !== 'string' || !(COMPANION_INK_TOKENS as readonly string[]).includes(identity.inkToken)) bad();
    const parsedIdentity: Readonly<BirthIdentityCapture> = Object.freeze({
      identityDraftId: birthUUID(identity.identityDraftId), companionId: birthUUID(identity.companionId), taskId: birthUUID(identity.taskId),
      identityRevision: revision(identity.identityRevision), name: parsedRequest.name, nameOrigin: 'user_typed', sealChar: parsedRequest.sealChar,
      sealCandidates, inkToken: identity.inkToken as CompanionPublicInkToken, selectionId: birthUUID(identity.selectionId),
      selectionOperationId: birthUUID(identity.selectionOperationId), selectionRevision: revision(identity.selectionRevision),
      nameApplicationOperationId: birthUUID(identity.nameApplicationOperationId), nameSubmissionId: birthUUID(identity.nameSubmissionId),
      nameGeneration: revision(identity.nameGeneration), bundleRevision: revision(identity.bundleRevision),
      contentDigest: digest(identity.contentDigest), reviewDigest: digest(identity.reviewDigest),
      identityPayloadDigest: digest(identity.identityPayloadDigest), selectionPayloadDigest: digest(identity.selectionPayloadDigest),
      selectionOperationPayloadDigest: digest(identity.selectionOperationPayloadDigest),
    });
    if (![null, 1, 2].includes(task.sourceReceiptVersion as number | null)) bad();
    const parsedTask = Object.freeze({ id: birthUUID(task.id), companionId: birthUUID(task.companionId), answersId: birthUUID(task.answersId),
      generation: revision(task.generation), sourceDraftId: birthUUID(task.sourceDraftId), sourceRevision: revision(task.sourceRevision),
      sourceReceiptVersion: task.sourceReceiptVersion as 1 | 2 | null });
    let prefix: BirthCapture['prefix'] = null;
    if (data.prefix !== null) {
      const item = birthFields(data.prefix, ['id', 'version', 'digest']);
      if (item.version !== 1 && item.version !== 2) bad();
      prefix = Object.freeze({ id: birthUUID(item.id), version: item.version, digest: digest(item.digest) });
    }
    if (parsedIdentity.taskId !== parsedTask.id || parsedIdentity.companionId !== parsedTask.companionId
      || (parsedTask.sourceReceiptVersion === null ? prefix !== null : !prefix || prefix.id !== parsedTask.id || prefix.version !== parsedTask.sourceReceiptVersion)) bad();
    return Object.freeze({ ownerId: birthUUID(data.ownerId), acceptedAuthVersion: authVersion(data.acceptedAuthVersion),
      terms: Object.freeze({ version: matching(terms.version, /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
        contentDigest: digest(terms.contentDigest), reviewDigest: digest(terms.reviewDigest) }), task: parsedTask, prefix,
      inventory: Object.freeze({ tipId: birthUUID(inventory.tipId), revision: revision(inventory.revision), tipDigest: digest(inventory.tipDigest) }),
      identity: parsedIdentity });
  } catch { bad(); }
}

function command(value: unknown): Readonly<CompanionBirthCommand> {
  const data = birthFields(value, ['idempotencyKey', 'request']);
  const parsed = parseCompanionBirthCommand(data.request, data.idempotencyKey);
  const raw = birthFields(data.request, ['name', 'sealChar']);
  if (parsed.request.name !== raw.name) bad();
  return parsed;
}

export function parseCompanionBirthOrigin(value: unknown): Readonly<CompanionBirthOriginSnapshot> {
  try {
    const data = birthFields(value, ['schemaVersion', 'ownerId', 'command', 'capture', 'receipt', 'asset']);
    if (data.schemaVersion !== 1) bad();
    const ownerId = birthUUID(data.ownerId), request = command(data.command), capture = parseBirthCapture(data.capture);
    const receipt = parseCompanionBirthReceipt(data.receipt), asset = parseCompanionBirthAssetSnapshot(data.asset);
    const identity = capture.identity;
    if (ownerId !== capture.ownerId || ownerId !== asset.ownerId || request.idempotencyKey !== receipt.idempotencyKey
      || request.request.name !== identity.name || request.request.sealChar !== identity.sealChar
      || receipt.identity.companionId !== identity.companionId || receipt.identity.name !== identity.name
      || receipt.identity.nameOrigin !== identity.nameOrigin || receipt.identity.sealChar !== identity.sealChar
      || receipt.identity.inkToken !== identity.inkToken || receipt.identity.identityRevision !== identity.identityRevision
      || receipt.identity.selectionRevision !== identity.selectionRevision || receipt.identity.sealAssetId !== asset.id
      || asset.companionId !== identity.companionId || asset.birthReceiptId !== receipt.id || asset.bornAt !== receipt.bornAt
      || asset.sealChar !== identity.sealChar || asset.inkToken !== identity.inkToken) bad();
    return Object.freeze({ schemaVersion: 1, ownerId, command: request, capture, receipt, asset });
  } catch { bad(); }
}

function bounded(text: string): string {
  if (text.length > MAX_DATA_PLAINTEXT_BYTES || Buffer.byteLength(text, 'utf8') > MAX_DATA_PLAINTEXT_BYTES
    || Buffer.from(text, 'utf8').toString('utf8') !== text) bad();
  return text;
}
const binding = (rowId: string, ownerId: string, column: 'request_ciphertext' | 'snapshot_ciphertext') => ({
  table: 'platform_companion_birth_receipts', column, rowId: birthUUID(rowId), ownerId: birthUUID(ownerId), revision: 1,
});

export function sealCompanionBirthOrigin(crypto: DataCrypto | undefined, value: unknown): Readonly<{
  snapshot: Readonly<CompanionBirthOriginSnapshot>; requestDigest: string; requestCiphertext: Buffer; snapshotCiphertext: Buffer;
}> {
  try {
    if (!crypto) bad();
    const snapshot = parseCompanionBirthOrigin(value);
    const requestText = bounded(JSON.stringify(snapshot.command)), snapshotText = bounded(JSON.stringify(snapshot));
    return Object.freeze({ snapshot, requestDigest: companionBirthDigest(requestText),
      requestCiphertext: crypto.sealUtf8(requestText, binding(snapshot.receipt.id, snapshot.ownerId, 'request_ciphertext')),
      snapshotCiphertext: crypto.sealUtf8(snapshotText, binding(snapshot.receipt.id, snapshot.ownerId, 'snapshot_ciphertext')) });
  } catch { bad(); }
}

/** Decode authentic origin before using any clear storage metadata or child.
 * Reordered, duplicate-field, normalized or extra-field JSON is never repaired. */
export function openCompanionBirthOrigin(crypto: DataCrypto | undefined, ownerId: string, rowId: string,
  requestCiphertext: unknown, snapshotCiphertext: unknown, requestDigest: unknown): Readonly<CompanionBirthOriginSnapshot> {
  try {
    if (!crypto || !Buffer.isBuffer(requestCiphertext) || !Buffer.isBuffer(snapshotCiphertext)) bad();
    const requestText = bounded(crypto.openUtf8(requestCiphertext, binding(rowId, ownerId, 'request_ciphertext')));
    const snapshotText = bounded(crypto.openUtf8(snapshotCiphertext, binding(rowId, ownerId, 'snapshot_ciphertext')));
    const request = command(JSON.parse(requestText)), snapshot = parseCompanionBirthOrigin(JSON.parse(snapshotText));
    if (JSON.stringify(request) !== requestText || JSON.stringify(snapshot) !== snapshotText
      || companionBirthDigest(requestText) !== digest(requestDigest) || snapshot.ownerId !== ownerId
      || snapshot.receipt.id !== rowId || JSON.stringify(snapshot.command) !== requestText) bad();
    return snapshot;
  } catch { bad(); }
}
