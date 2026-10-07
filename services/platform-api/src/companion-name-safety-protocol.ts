import { ApiError } from './errors.ts';

export const MAX_COMPANION_NAME_SOURCE_BYTES = 4096;
const MAX_REVISION = 2147483647;
const MAX_AUTH_VERSION = '9223372036854775807';
export interface CompanionNameSubmissionRequest {
  readonly taskId: string; readonly expectedEntryRevision: number; readonly expectedIdentityRevision: number;
  readonly operationId: string; readonly name: string;
}
/** Concrete immutable name-source coordinates. A copied claim is not a lease or authority. */
export interface CompanionNameSafetyClaim {
  readonly submissionId: string; readonly userId: string; readonly operationId: string; readonly entryId: string;
  readonly taskId: string; readonly companionId: string; readonly previewRevision: 1; readonly submittedAtRevision: number;
  readonly expectedIdentityRevision: number; readonly generation: number; readonly authVersion: string;
  readonly leaseToken: string; readonly detectorRevision: number;
}
export interface CompanionNameSafetyDecision {
  readonly level: 'L0' | 'L1' | 'L2'; readonly mode: 'full' | 'keyword_only';
}
const invalid = () => new ApiError(400, 'INVALID_INPUT', 'Use a valid companion name source operation.');
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
export function companionNameUuid(value: unknown): string {
  if (typeof value !== 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] !== value) throw invalid();
  return value;
}
function revision(value: unknown, minimum = 0, maximum = MAX_REVISION): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) throw invalid();
  return value;
}
/** Transport integrity only. Exact raw text is retained, including empty,
 * multiline and semantically invalid names, before any classification/validation. */
export function parseCompanionNameSubmissionRequest(value: unknown): Readonly<CompanionNameSubmissionRequest> {
  const data = record(value, ['taskId', 'expectedEntryRevision', 'expectedIdentityRevision', 'operationId', 'name']);
  if (typeof data.name !== 'string' || data.name.length > MAX_COMPANION_NAME_SOURCE_BYTES
    || Buffer.byteLength(data.name, 'utf8') > MAX_COMPANION_NAME_SOURCE_BYTES || Buffer.from(data.name, 'utf8').toString('utf8') !== data.name) throw invalid();
  return Object.freeze({ taskId: companionNameUuid(data.taskId), expectedEntryRevision: revision(data.expectedEntryRevision, 0, MAX_REVISION - 1),
    expectedIdentityRevision: revision(data.expectedIdentityRevision, 0, MAX_REVISION - 1), operationId: companionNameUuid(data.operationId), name: data.name });
}
export function parseCompanionNameTask(value: unknown): string { return companionNameUuid(record(value, ['taskId']).taskId); }
export function parseCompanionNameApplication(value: unknown): Readonly<{ taskId: string; submissionId: string }> {
  const data = record(value, ['taskId', 'submissionId']); return Object.freeze({ taskId: companionNameUuid(data.taskId), submissionId: companionNameUuid(data.submissionId) });
}
export function parseCompanionNameSafetyClaim(value: unknown): Readonly<CompanionNameSafetyClaim> {
  const data = record(value, ['submissionId', 'userId', 'operationId', 'entryId', 'taskId', 'companionId', 'previewRevision', 'submittedAtRevision',
    'expectedIdentityRevision', 'generation', 'authVersion', 'leaseToken', 'detectorRevision']);
  if (data.previewRevision !== 1 || typeof data.authVersion !== 'string' || data.authVersion.length > MAX_AUTH_VERSION.length
    || /^(0|[1-9][0-9]*)$/.exec(data.authVersion)?.[0] !== data.authVersion
    || data.authVersion.length === MAX_AUTH_VERSION.length && data.authVersion > MAX_AUTH_VERSION) throw invalid();
  return Object.freeze({ submissionId: companionNameUuid(data.submissionId), userId: companionNameUuid(data.userId), operationId: companionNameUuid(data.operationId),
    entryId: companionNameUuid(data.entryId), taskId: companionNameUuid(data.taskId), companionId: companionNameUuid(data.companionId), previewRevision: 1,
    submittedAtRevision: revision(data.submittedAtRevision, 1), expectedIdentityRevision: revision(data.expectedIdentityRevision, 0, MAX_REVISION - 1),
    generation: revision(data.generation, 1), authVersion: data.authVersion, leaseToken: companionNameUuid(data.leaseToken), detectorRevision: revision(data.detectorRevision, 1) });
}
export function parseCompanionNameSafetyDecision(value: unknown): Readonly<CompanionNameSafetyDecision> {
  const data = record(value, ['level', 'mode']);
  if (!['L0', 'L1', 'L2'].includes(data.level as string) || !['full', 'keyword_only'].includes(data.mode as string)
    || data.level === 'L0' && data.mode !== 'full') throw invalid();
  return Object.freeze({ level: data.level as CompanionNameSafetyDecision['level'], mode: data.mode as CompanionNameSafetyDecision['mode'] });
}
