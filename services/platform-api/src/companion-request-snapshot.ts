import { createHash } from 'node:crypto';
import type { CompanionDraftRequest } from '@companion/platform-contracts';
import type { PlatformConfig } from './config.ts';
import { ApiError } from './errors.ts';
import { intakeUnavailable } from './onboarding-storage.ts';

export interface RequestRow {
  id: string; user_id: string; task_id: string; companion_id: string;
  source_draft_id: string; source_revision: number; auth_version: string;
  initial_generation: number; payload_digest: string; payload_ciphertext: Buffer;
}
export interface AcceptedSnapshot {
  readonly schemaVersion: 1; readonly operationId: string; readonly userId: string;
  readonly tokenHash: string; readonly authVersion: string; readonly taskId: string;
  readonly companionId: string; readonly sourceDraftId: string; readonly sourceRevision: number;
  readonly initialGeneration: 0; readonly command: Readonly<CompanionDraftRequest>;
}
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] === value;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = () => new ApiError(400, 'INVALID_INPUT', 'Use the current intake revision and one operation ID.');
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !descriptors[key])
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(descriptors).some(item => !('value' in item) || !item.enumerable)) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
export function parseCompanionDraftRequest(value: unknown): Readonly<CompanionDraftRequest> {
  const data = fields(value, ['operationId', 'expectedRevision']);
  if (!uuid(data.operationId) || !Number.isSafeInteger(data.expectedRevision)
    || (data.expectedRevision as number) < 1 || (data.expectedRevision as number) > 2147483647
    || Object.is(data.expectedRevision, -0)) throw invalid();
  return Object.freeze({ operationId: data.operationId, expectedRevision: data.expectedRevision as number });
}
/** Authenticate the original saved request without renewing its session or executing it. */
export function decodeCompanionRequest(row: RequestRow, crypto: PlatformConfig['dataCrypto']): AcceptedSnapshot {
  try {
    const text = crypto!.openUtf8(row.payload_ciphertext, {
      table: 'platform_companion_generation_requests', column: 'payload_ciphertext',
      rowId: row.id, ownerId: row.user_id, revision: row.source_revision,
    });
    const data = fields(JSON.parse(text), ['schemaVersion', 'operationId', 'userId', 'tokenHash', 'authVersion',
      'taskId', 'companionId', 'sourceDraftId', 'sourceRevision', 'initialGeneration', 'command']);
    const input = parseCompanionDraftRequest(data.command);
    const snapshot: AcceptedSnapshot = { schemaVersion: 1, operationId: row.id, userId: row.user_id,
      tokenHash: data.tokenHash as string, authVersion: String(row.auth_version), taskId: row.task_id,
      companionId: row.companion_id, sourceDraftId: row.source_draft_id, sourceRevision: row.source_revision,
      initialGeneration: 0, command: input };
    if (data.schemaVersion !== 1 || data.operationId !== row.id || data.userId !== row.user_id
      || typeof data.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(data.tokenHash)
      || data.authVersion !== String(row.auth_version) || data.taskId !== row.task_id || data.companionId !== row.companion_id
      || data.sourceDraftId !== row.source_draft_id || data.sourceRevision !== row.source_revision
      || data.initialGeneration !== 0 || row.initial_generation !== 0 || input.operationId !== row.id
      || input.expectedRevision !== row.source_revision || text !== JSON.stringify(snapshot) || sha(text) !== row.payload_digest) throw intakeUnavailable();
    return Object.freeze(snapshot);
  } catch { throw intakeUnavailable(); }
}
