import type { CompanionNamingAccepted, CompanionNamingNameCategory, CompanionNamingProgress,
  CompanionNamingRequest, CompanionNamingState } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';

const MAX_REVISION = 2147483647;
function invalid(): never { throw new Error('起名的进度暂时无法确认，请重新读取。'); }
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
function member<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(); return value as T;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function rawName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) invalid();
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength > 4096 || new TextDecoder('utf-8', { fatal: true }).decode(encoded) !== value) invalid();
  return value;
}
export type CompanionNamingInput = Omit<CompanionNamingRequest, 'operationId'>;
/** Preserve the entire original text before semantic rules or classification. */
export function parseCompanionNamingInput(value: unknown): Readonly<CompanionNamingInput> {
  const data = record(value, ['taskId', 'expectedEntryRevision', 'expectedIdentityRevision', 'name']);
  return Object.freeze({ taskId: uuid(data.taskId), expectedEntryRevision: integer(data.expectedEntryRevision, 0, MAX_REVISION - 1),
    expectedIdentityRevision: integer(data.expectedIdentityRevision, 0, MAX_REVISION - 1), name: rawName(data.name) });
}
export function parseCompanionNamingRequest(value: unknown): Readonly<CompanionNamingRequest> {
  const data = record(value, ['taskId', 'expectedEntryRevision', 'expectedIdentityRevision', 'operationId', 'name']);
  return Object.freeze({ taskId: uuid(data.taskId), expectedEntryRevision: integer(data.expectedEntryRevision, 0, MAX_REVISION - 1),
    expectedIdentityRevision: integer(data.expectedIdentityRevision, 0, MAX_REVISION - 1), operationId: uuid(data.operationId), name: rawName(data.name) });
}
/** Transport validation is not evidence of classification, permission or birth. */
export function parseCompanionNamingProgress(value: unknown): Readonly<CompanionNamingProgress> {
  const data = record(value, ['dispatchId', 'taskId', 'submissionId', 'submittedRevision', 'phase', 'hold', 'detection', 'application', 'resource']);
  const detected = record(data.detection, ['status', 'generation', 'level', 'mode']);
  const detection = Object.freeze({ status: member(detected.status, ['pending', 'running', 'detected']), generation: integer(detected.generation),
    level: detected.level === null ? null : member(detected.level, ['L0', 'L1', 'L2']),
    mode: detected.mode === null ? null : member(detected.mode, ['full', 'keyword_only']) });
  const applied = record(data.application, ['status', 'rejectedCategory', 'identityRevision']);
  const application = Object.freeze({ status: member(applied.status, ['pending', 'applied', 'name_rejected', 'superseded', 'not_eligible']),
    rejectedCategory: applied.rejectedCategory === null ? null : member<CompanionNamingNameCategory>(applied.rejectedCategory,
      ['family_or_partner', 'team_or_org', 'same_as_user', 'abusive', 'public_figure', 'length']),
    identityRevision: applied.identityRevision === null ? null : integer(applied.identityRevision, 1) });
  const phase = member(data.phase, ['queued', 'checking', 'held', 'detected']);
  const hold = data.hold === null ? null : member(data.hold, ['authorization_required', 'configuration_unavailable', 'requires_review']);
  if ((phase === 'held') !== (hold !== null)
    || (detection.status === 'detected') !== (detection.level !== null && detection.mode !== null)
    || detection.status !== 'detected' && (detection.level !== null || detection.mode !== null)
    || detection.status !== 'pending' && detection.generation === 0
    || detection.level === 'L0' && detection.mode !== 'full'
    || phase === 'queued' && (detection.status !== 'pending' || detection.generation !== 0)
    || phase === 'checking' && detection.status !== 'running'
    || phase === 'detected' && detection.status !== 'detected'
    || (application.status === 'applied') !== (application.identityRevision !== null)
    || (application.status === 'name_rejected') !== (application.rejectedCategory !== null)
    || application.status !== 'pending' && detection.status !== 'detected'
    || ['applied', 'name_rejected'].includes(application.status) && (detection.level !== 'L0' || detection.mode !== 'full')) invalid();
  const resource = member(data.resource, ['not_determined', 'not_required', 'pending', 'ready', 'unavailable']);
  if ((detection.status !== 'detected') !== (resource === 'not_determined')
    || detection.status === 'detected' && (detection.level === 'L0') !== (resource === 'not_required')) invalid();
  return Object.freeze({ dispatchId: uuid(data.dispatchId), taskId: uuid(data.taskId), submissionId: uuid(data.submissionId),
    submittedRevision: integer(data.submittedRevision, 1), phase, hold, detection, application, resource });
}
export function parseCompanionNamingState(value: unknown): Readonly<CompanionNamingState> {
  if (!value || typeof value !== 'object') invalid();
  const discriminator = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!discriminator || !('value' in discriminator)) invalid();
  if (discriminator.value === 'not_started') { record(value, ['kind']); return Object.freeze({ kind: 'not_started' }); }
  if (discriminator.value !== 'naming') invalid();
  const data = record(value, ['kind', 'entry', 'latest']), input = record(data.entry, ['taskId', 'companionId', 'revision', 'latestSubmissionId']);
  const entry = Object.freeze({ taskId: uuid(input.taskId), companionId: uuid(input.companionId), revision: integer(input.revision, 1),
    latestSubmissionId: uuid(input.latestSubmissionId) });
  const latest = data.latest === null ? null : parseCompanionNamingProgress(data.latest);
  if (latest && (latest.taskId !== entry.taskId || latest.submissionId !== entry.latestSubmissionId || latest.submittedRevision !== entry.revision)) invalid();
  return Object.freeze({ kind: 'naming', entry, latest });
}
export function parseCompanionNamingAccepted(value: unknown): Readonly<CompanionNamingAccepted> {
  const data = record(value, ['acceptance', 'progress']);
  const input = record(data.acceptance, ['dispatchId', 'taskId', 'submissionId', 'operation']);
  const op = record(input.operation, ['id', 'appliedRevision', 'replayed']);
  const acceptance = Object.freeze({ dispatchId: uuid(input.dispatchId), taskId: uuid(input.taskId), submissionId: uuid(input.submissionId),
    operation: Object.freeze({ id: uuid(op.id), appliedRevision: integer(op.appliedRevision, 1), replayed: boolean(op.replayed) }) });
  const progress = parseCompanionNamingProgress(data.progress);
  if (acceptance.dispatchId !== progress.dispatchId || acceptance.taskId !== progress.taskId || acceptance.submissionId !== progress.submissionId
    || acceptance.operation.appliedRevision !== progress.submittedRevision) invalid();
  return Object.freeze({ acceptance, progress });
}
export async function readCompanionNaming(client: BoundPlatformClient, signal?: AbortSignal): Promise<Readonly<CompanionNamingState>> {
  const data = record(await client.request('/companion/naming', { signal }), ['state']); return parseCompanionNamingState(data.state);
}
export async function readCompanionNamingOperation(client: BoundPlatformClient, operation: string, signal?: AbortSignal): Promise<Readonly<CompanionNamingAccepted> | null> {
  const operationId = uuid(operation);
  const data = record(await client.request('/companion/naming/submissions/' + operationId, { signal }), ['accepted']);
  if (data.accepted === null) return null;
  const accepted = parseCompanionNamingAccepted(data.accepted);
  if (accepted.acceptance.operation.id !== operationId) invalid(); return accepted;
}
export async function acceptCompanionNaming(client: BoundPlatformClient, input: CompanionNamingRequest, signal?: AbortSignal): Promise<Readonly<CompanionNamingAccepted>> {
  const command = parseCompanionNamingRequest(input);
  const accepted = parseCompanionNamingAccepted(await client.request('/companion/naming/submissions', {
    method: 'POST', body: JSON.stringify(command), signal,
  }));
  if (accepted.acceptance.operation.id !== command.operationId || accepted.acceptance.taskId !== command.taskId
    || accepted.acceptance.operation.appliedRevision !== command.expectedEntryRevision + 1) invalid();
  return accepted;
}
