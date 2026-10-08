import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CompanionDraftAccepted, CompanionDraftEntryState, CompanionDraftRequest, PlatformProviderRuntime } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import { BackgroundGeneration, type CompanionGenerationTaskStatus } from './background-generation.ts';
import { CompanionDraftPreparation } from './companion-draft-preparation.ts';
import type { PlatformConfig } from './config.ts';
import { DatabaseOperationTimeout, type Database } from './database.ts';
import { DatabaseError } from 'pg';
import { ApiError } from './errors.ts';
import type { LegalBundle } from './legal-documents.ts';
import { resolveModelRoute } from './model-routing.ts';
import { OnboardingStorage, intakeUnavailable } from './onboarding-storage.ts';

/** Delivery may be tried again only after this initial verification failed.
 * It is not a claim, a replacement session, or proof of a model outcome. */
export class CompanionNotificationReadUnavailable extends Error {
  constructor(){super('Companion notification source verification must be tried again.');this.name='CompanionNotificationReadUnavailable';}
}
export interface CompanionNotification { readonly requestId: string; readonly taskId: string; }
interface RequestRow {
  id: string; user_id: string; task_id: string; companion_id: string;
  source_draft_id: string; source_revision: number; auth_version: string;
  initial_generation: number; payload_digest: string; payload_ciphertext: Buffer;
}
interface AcceptedSnapshot {
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
function command(value: unknown): Readonly<CompanionDraftRequest> {
  const data = fields(value, ['operationId', 'expectedRevision']);
  if (!uuid(data.operationId) || !Number.isSafeInteger(data.expectedRevision)
    || (data.expectedRevision as number) < 1 || (data.expectedRevision as number) > 2147483647
    || Object.is(data.expectedRevision, -0)) throw invalid();
  return Object.freeze({ operationId: data.operationId, expectedRevision: data.expectedRevision as number });
}
export function companionNotification(value: unknown): Readonly<CompanionNotification> {
  const data = fields(value, ['requestId', 'taskId']);
  if (!uuid(data.requestId) || !uuid(data.taskId)) throw invalid();
  return Object.freeze({ requestId: data.requestId, taskId: data.taskId });
}

/** Durable student intent and read projection. Every execution uses the original
 * accepted real session; a queue delivery or status read cannot replace it.
 */
export class CompanionEntry {
  readonly generation: BackgroundGeneration;
  private readonly preparation: CompanionDraftPreparation;
  private readonly storage: OnboardingStorage;
  constructor(readonly db: Database, readonly config: PlatformConfig, legal: LegalBundle | null,
    private readonly runtime: PlatformProviderRuntime) {
    this.storage = new OnboardingStorage(config, legal);
    this.preparation = new CompanionDraftPreparation(db, config, legal, runtime);
    this.generation = new BackgroundGeneration(db, config, legal, runtime);
  }
  private fixed(context: FixedSessionContext): FixedSessionContext {
    return Object.freeze({ userId: context.userId, tokenHash: context.tokenHash });
  }
  private available(): boolean {
    try {
      const route = resolveModelRoute(this.config, this.runtime, 'companion_generation');
      const providers = this.runtime.capabilities().filter(item => item.id === route.provider);
      return providers.length === 1 && providers[0].keyConfigured === true && typeof this.runtime.streamChat === 'function';
    } catch { return false; }
  }
  private projection(status: CompanionGenerationTaskStatus, heldReason: string | null): CompanionDraftEntryState {
    if (status.status === 'completed') {
      const preview = status.preview;
      if (!preview) throw intakeUnavailable();
      return { kind: 'preview', preview: { taskId: status.taskId, companionId: preview.companionId,
        revision: preview.revision, generatedBy: preview.generatedBy, summary: preview.summary,
        samples: [...preview.samples] as [string, string, string], inkToken: preview.inkToken } };
    }
    return { kind: 'generation', taskId: status.taskId, companionId: status.companionId,
      generation: status.generation, status: status.status,
      hold: heldReason === null ? null : heldReason === 'authorization' ? 'authorization_required'
        : heldReason === 'configuration' ? 'configuration_unavailable' : 'requires_review' };
  }
  private decode(row: RequestRow): AcceptedSnapshot {
    try {
      const text = this.storage.crypto!.openUtf8(row.payload_ciphertext, {
        table: 'platform_companion_generation_requests', column: 'payload_ciphertext',
        rowId: row.id, ownerId: row.user_id, revision: row.source_revision,
      });
      const data = fields(JSON.parse(text), ['schemaVersion', 'operationId', 'userId', 'tokenHash', 'authVersion',
        'taskId', 'companionId', 'sourceDraftId', 'sourceRevision', 'initialGeneration', 'command']);
      const input = command(data.command);
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
  private async request(client: PoolClient, notification: CompanionNotification): Promise<RequestRow> {
    const row = (await client.query<RequestRow>(`SELECT r.* FROM platform_companion_generation_requests r
      JOIN platform_companion_generation_outbox o ON o.request_id=r.id AND o.user_id=r.user_id AND o.task_id=r.task_id
      WHERE r.id=$1 AND r.task_id=$2 FOR UPDATE OF r,o`, [notification.requestId, notification.taskId])).rows[0];
    if (!row) throw intakeUnavailable();
    return row;
  }
  private async readCurrent(client: PoolClient, fixed: FixedSessionContext, signal?: AbortSignal): Promise<CompanionDraftEntryState> {
    // Lock the real identity first. Existing tasks then perform the complete
    // current student/legal/intake check once in the generation service.
    await authorizeFixedSession(client, fixed, signal);
    const tasks = (await client.query<{ id: string; status: string }>(
      'SELECT id,status FROM platform_companion_generation_tasks WHERE user_id=$1 FOR UPDATE', [fixed.userId])).rows;
    if (tasks.length > 1) throw intakeUnavailable();
    const task = tasks[0];
    if (!task) {
      await this.storage.authorizeSession(client, fixed, signal);
      const source = await this.storage.row(client, fixed.userId);
      if (!source || this.storage.decode(source).state !== 'intake_ready') return { kind: 'intake_required' };
      return { kind: 'not_prepared', intakeRevision: source.revision, generationAvailable: this.available() };
    }
    const status = await this.generation.readTaskStatusInTransaction(client, fixed, { taskId: task.id }, signal);
    const requests = (await client.query<RequestRow>('SELECT * FROM platform_companion_generation_requests WHERE user_id=$1 AND task_id=$2 FOR UPDATE', [fixed.userId, task.id])).rows;
    if (requests.length > 1) throw intakeUnavailable();
    if (!requests.length && status.status === 'pending') {
      return { kind: 'not_prepared', intakeRevision: status.source.sourceRevision, generationAvailable: this.available() };
    }
    const request = requests[0] ? this.decode(requests[0]) : null;
    const outbox = request ? (await client.query<{ held_reason: string | null }>(`SELECT held_reason
      FROM platform_companion_generation_outbox WHERE request_id=$1 AND task_id=$2 AND user_id=$3 FOR UPDATE`,
    [request.operationId, task.id, fixed.userId])).rows[0] : null;
    if (request && (!outbox || request.sourceDraftId !== status.source.sourceDraftId
      || request.sourceRevision !== status.source.sourceRevision || request.companionId !== status.companionId)) throw intakeUnavailable();
    return this.projection(status, outbox?.held_reason ?? null);
  }
  async read(context: FixedSessionContext, signal?: AbortSignal): Promise<CompanionDraftEntryState> {
    const fixed = this.fixed(context);
    return this.db.withBoundedTransaction(async client => {
      // A burst of observers may wait briefly for one owner's current write.
      // Keep the unchanged two-second operation deadline and final session check.
      await client.query("SET LOCAL lock_timeout='1500ms'");
      const result = await this.readCurrent(client, fixed, signal);
      await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return result;
    });
  }
  async accept(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<CompanionDraftAccepted> {
    const fixed = this.fixed(context), input = command(value);
    return this.db.withBoundedTransaction(async client => {
      const version = await this.storage.authorizeSession(client, fixed, signal);
      const previous = (await client.query<RequestRow>('SELECT * FROM platform_companion_generation_requests WHERE id=$1 FOR UPDATE', [input.operationId])).rows[0];
      if (previous) {
        if (previous.user_id !== fixed.userId) throw new ApiError(409, 'COMPANION_OPERATION_CONFLICT', 'Use a new operation ID.');
        const snapshot = this.decode(previous);
        if (JSON.stringify(snapshot.command) !== JSON.stringify(input)) throw new ApiError(409, 'COMPANION_OPERATION_CONFLICT', 'This operation ID belongs to a different request.');
        if (snapshot.authVersion !== version) throw new ApiError(409, 'COMPANION_DRAFT_SOURCE_CHANGED', 'Read the current intake before continuing.');
        await this.request(client, { requestId: previous.id, taskId: previous.task_id });
        const entry = await this.readCurrent(client, fixed, signal);
        await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
        return { entry, operation: { id: input.operationId, replayed: true } };
      }
      const accepted = (await client.query<RequestRow>('SELECT * FROM platform_companion_generation_requests WHERE user_id=$1 FOR UPDATE', [fixed.userId])).rows;
      if (accepted.length) throw new ApiError(409, 'COMPANION_REQUEST_EXISTS', 'Read the already accepted companion task.');
      if (!this.available()) throw new ApiError(503, 'MODEL_ROUTE_UNAVAILABLE', 'Companion generation is not available yet.');
      const prepared = await this.preparation.prepareInTransaction(client, fixed, { expectedRevision: input.expectedRevision }, signal);
      const snapshot: AcceptedSnapshot = { schemaVersion: 1, operationId: input.operationId, userId: fixed.userId,
        tokenHash: fixed.tokenHash, authVersion: version, taskId: prepared.taskId, companionId: prepared.companionId,
        sourceDraftId: prepared.source.draftId, sourceRevision: prepared.source.draftRevision, initialGeneration: 0, command: input };
      const text = JSON.stringify(snapshot), ciphertext = this.storage.crypto!.sealUtf8(text, {
        table: 'platform_companion_generation_requests', column: 'payload_ciphertext', rowId: input.operationId,
        ownerId: fixed.userId, revision: prepared.source.draftRevision,
      });
      await client.query(`INSERT INTO platform_companion_generation_requests(id,user_id,task_id,companion_id,
        source_draft_id,source_revision,auth_version,payload_digest,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [input.operationId, fixed.userId, prepared.taskId, prepared.companionId, prepared.source.draftId, prepared.source.draftRevision, version, sha(text), ciphertext]);
      await client.query('INSERT INTO platform_companion_generation_outbox(request_id,user_id,task_id) VALUES($1,$2,$3)', [input.operationId, fixed.userId, prepared.taskId]);
      const entry = await this.readCurrent(client, fixed, signal);
      await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
      return { entry, operation: { id: input.operationId, replayed: false } };
    });
  }
  /** Redis supplies references only. Decrypt and verify the actual accepted DB
   * request, then recheck the original session/source at every core boundary.
   */
  async executeNotification(value: unknown, signal?: AbortSignal): Promise<void> {
    const notification = companionNotification(value);
    const accepted = await this.db.withBoundedTransaction(async client => {
      // Observers and source writers serialize on the same actual account.
      // Allow their brief queue to drain inside the unchanged two-second bound.
      await client.query("SET LOCAL lock_timeout='1500ms'");
      // Discover the private canonical owner/session without taking request
      // locks. All source writers and readers lock the real user first.
      const found = (await client.query<RequestRow>(`SELECT * FROM platform_companion_generation_requests
        WHERE id=$1 AND task_id=$2`, [notification.requestId, notification.taskId])).rows[0];
      if (!found) throw intakeUnavailable();
      const initial = this.decode(found), fixed = this.fixed({ userId: initial.userId, tokenHash: initial.tokenHash });
      const version = await this.storage.authorizeSession(client, fixed, signal);
      const row = await this.request(client, notification), snapshot = this.decode(row);
      if (JSON.stringify(snapshot) !== JSON.stringify(initial)) throw intakeUnavailable();
      if (version !== snapshot.authVersion) throw new ApiError(409, 'COMPANION_DRAFT_SOURCE_CHANGED', 'The accepted account version changed.');
      const status = await this.generation.readTaskStatusInTransaction(client, fixed, { taskId: row.task_id }, signal);
      if (status.source.sourceDraftId !== snapshot.sourceDraftId || status.source.sourceRevision !== snapshot.sourceRevision
        || status.companionId !== snapshot.companionId || status.generation > 1) throw intakeUnavailable();
      return { fixed, status };
    }).catch(error=>{
      // This transaction only reads/locks source and status. This invocation
      // has not entered generate/recover or admitted any provider request.
      // Retry only the delivery; durable core state decides what may execute.
      if(error instanceof DatabaseOperationTimeout||error instanceof DatabaseError&&error.code==='57014')throw new CompanionNotificationReadUnavailable();
      throw error;
    });
    if (accepted.status.status === 'pending') await this.generation.generate(accepted.fixed, { taskId: notification.taskId }, signal);
    else if (accepted.status.status !== 'completed') await this.generation.recover(accepted.fixed,
      { taskId: notification.taskId, expectedGeneration: accepted.status.generation }, signal);
  }
}
