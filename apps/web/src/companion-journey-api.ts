import { COMPANION_INK_TOKENS, type CompanionSealSelection, type CompanionSealSelectionRequest,
  type CompanionSealSelectionSaved, type CompanionStudentJourneyState, type PublicCompanionIdentityDraft,
  type PublicCompanionSealCandidates } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
import { parseCompanionNamingAccepted, parseCompanionNamingState } from './companion-naming-api.ts';
import { parsePublicCompanionPreview } from './companion-preview-api.ts';

const MAX_REVISION = 2147483647;
function invalid(): never { throw new Error('主理人的准备进度暂时无法确认，请重新读取。'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] !== value) invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = MAX_REVISION): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) invalid();
  return value;
}
function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(); return value as T;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum
    || /[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value)) invalid();
  return value;
}
function seal(value: unknown): string {
  const char = text(value, 1); if (!/^[\u4e00-\u9fff]$/.test(char)) invalid(); return char;
}
/** Transport validation does not approve a character, classify a name, or grant
 * execution. Those facts are checked against original evidence on the server. */
export function parseCompanionIdentity(value: unknown): Readonly<PublicCompanionIdentityDraft> {
  const data = record(value, ['companionId', 'taskId', 'previewRevision', 'revision', 'name', 'nameOrigin', 'sealCandidates', 'inkToken']);
  if (data.previewRevision !== 1 || data.nameOrigin !== 'user_typed'
    || !Array.isArray(data.sealCandidates) || Object.getPrototypeOf(data.sealCandidates) !== Array.prototype) invalid();
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(data.sealCandidates);
  if (descriptors.length?.value !== 3 || Reflect.ownKeys(data.sealCandidates).some(key => !['0', '1', '2', 'length'].includes(key as string))
    || Object.values(descriptors).some(item => !('value' in item)) || ['0', '1', '2'].some(key => !descriptors[key]?.enumerable)) invalid();
  const candidates = ['0', '1', '2'].map(key => {
    const candidate = record(descriptors[key].value, ['char', 'reason']);
    return Object.freeze({ char: seal(candidate.char), reason: text(candidate.reason, 4096) });
  });
  if (new Set(candidates.map(candidate => candidate.char)).size !== 3) invalid();
  return Object.freeze({ taskId: uuid(data.taskId), companionId: uuid(data.companionId), previewRevision: 1,
    revision: integer(data.revision, 1), name: text(data.name, 64), nameOrigin: 'user_typed',
    sealCandidates: Object.freeze(candidates) as unknown as PublicCompanionSealCandidates,
    inkToken: member(data.inkToken, COMPANION_INK_TOKENS) });
}
export function parseCompanionSealSelection(value: unknown): Readonly<CompanionSealSelection> {
  const data = record(value, ['companionId', 'taskId', 'previewRevision', 'identityRevision', 'revision', 'selectedSeal']);
  if (data.previewRevision !== 1) invalid();
  const revision = integer(data.revision), selectedSeal = data.selectedSeal === null ? null : seal(data.selectedSeal);
  if (revision === 0 && selectedSeal !== null) invalid();
  return Object.freeze({ taskId: uuid(data.taskId), companionId: uuid(data.companionId), previewRevision: 1,
    identityRevision: integer(data.identityRevision, 1), revision, selectedSeal });
}
export function parseCompanionSealSelectionSaved(value: unknown): Readonly<CompanionSealSelectionSaved> {
  const data = record(value, ['selection', 'operation']), operation = record(data.operation, ['id', 'appliedRevision', 'replayed']);
  if (typeof operation.replayed !== 'boolean') invalid();
  const selection = parseCompanionSealSelection(data.selection), appliedRevision = integer(operation.appliedRevision, 1);
  if (appliedRevision > selection.revision) invalid();
  return Object.freeze({ selection, operation: Object.freeze({ id: uuid(operation.id), appliedRevision, replayed: operation.replayed }) });
}
export function parseCompanionJourney(value: unknown): Readonly<CompanionStudentJourneyState> {
  if (!value || typeof value !== 'object') invalid();
  const discriminator = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!discriminator || !('value' in discriminator)) invalid();
  if (discriminator.value === 'not_started') {
    const data = record(value, ['kind', 'naming']), naming = parseCompanionNamingState(data.naming);
    if (naming.kind !== 'not_started') invalid(); return Object.freeze({ kind: 'not_started', naming });
  }
  if (discriminator.value !== 'journey') invalid();
  const data = record(value, ['kind', 'taskId', 'companionId', 'stage', 'preview', 'naming', 'latestNamingOperationId', 'identity', 'selection']);
  const taskId = uuid(data.taskId), companionId = uuid(data.companionId);
  const stage = member(data.stage, ['preview', 'naming', 'seal_ready', 'seal_saved']);
  const preview = data.preview === null ? null : parsePublicCompanionPreview(data.preview);
  const naming = parseCompanionNamingState(data.naming), identity = data.identity === null ? null : parseCompanionIdentity(data.identity);
  const latestNamingOperationId = data.latestNamingOperationId === null ? null : uuid(data.latestNamingOperationId);
  if (latestNamingOperationId !== null && (naming.kind !== 'naming' || naming.latest === null)) invalid();
  const selection = data.selection === null ? null : parseCompanionSealSelection(data.selection);
  for (const item of [preview, identity, selection, naming.kind === 'naming' ? naming.entry : null])
    if (item && (item.taskId !== taskId || item.companionId !== companionId)) invalid();
  if (selection && (!identity || selection.identityRevision !== identity.revision
    || selection.selectedSeal !== null && !identity.sealCandidates.some(candidate => candidate.char === selection.selectedSeal))) invalid();
  if (stage === 'preview' && (identity !== null || naming.kind !== 'not_started')
    || stage === 'naming' && naming.kind !== 'naming'
    || stage === 'seal_ready' && (!identity || selection?.selectedSeal !== null)
    || stage === 'seal_saved' && (!identity || !selection || selection.selectedSeal === null)) invalid();
  return Object.freeze({ kind: 'journey', taskId, companionId, stage, preview, naming, latestNamingOperationId, identity, selection });
}
export async function readCompanionJourney(client: BoundPlatformClient, signal?: AbortSignal) {
  const data = record(await client.request('/companion/journey', { signal }), ['journey']);
  return parseCompanionJourney(data.journey);
}
export type CompanionSealSelectionInput = Omit<CompanionSealSelectionRequest, 'operationId'>;
export function parseCompanionSealSelectionInput(value: unknown): Readonly<CompanionSealSelectionInput> {
  const data = record(value, ['taskId', 'expectedIdentityRevision', 'expectedRevision', 'sealChar']);
  return Object.freeze({ taskId: uuid(data.taskId), expectedIdentityRevision: integer(data.expectedIdentityRevision, 1),
    expectedRevision: integer(data.expectedRevision, 0, MAX_REVISION - 1), sealChar: seal(data.sealChar) });
}
export async function saveCompanionSealSelection(client: BoundPlatformClient, value: CompanionSealSelectionRequest, signal?: AbortSignal) {
  const data = record(value, ['taskId', 'expectedIdentityRevision', 'expectedRevision', 'sealChar', 'operationId']);
  const input = parseCompanionSealSelectionInput({ taskId: data.taskId, expectedIdentityRevision: data.expectedIdentityRevision,
    expectedRevision: data.expectedRevision, sealChar: data.sealChar }), operationId = uuid(data.operationId);
  const response = record(await client.request('/companion/journey/seal', {
    method: 'POST', body: JSON.stringify({ ...input, operationId }), signal,
  }), ['saved']), saved = parseCompanionSealSelectionSaved(response.saved);
  if (saved.operation.id !== operationId || saved.selection.taskId !== input.taskId
    || saved.operation.appliedRevision !== input.expectedRevision + 1) invalid(); return saved;
}
export async function readCompanionSealOperation(client: BoundPlatformClient, task: string, operation: string, signal?: AbortSignal) {
  const taskId = uuid(task), operationId = uuid(operation);
  const data = record(await client.request('/companion/journey/seal/' + taskId + '/operations/' + operationId, { signal }), ['saved']);
  if (data.saved === null) return null;
  const saved = parseCompanionSealSelectionSaved(data.saved);
  if (saved.operation.id !== operationId || saved.selection.taskId !== taskId) invalid(); return saved;
}
/** Explicitly apply one genuinely saved/classified operation; never resubmit raw
 * text or manufacture a new classification intent on reconnect. */
export async function resumeCompanionNamePreparation(client: BoundPlatformClient, operation: string, signal?: AbortSignal) {
  const operationId = uuid(operation), data = record(await client.request('/companion/journey/name-preparation', {
    method: 'POST', body: JSON.stringify({ operationId }), signal,
  }), ['accepted']), accepted = parseCompanionNamingAccepted(data.accepted);
  if (accepted.acceptance.operation.id !== operationId) invalid(); return accepted;
}
