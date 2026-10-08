import type { PoolClient } from 'pg';
import type { CompanionContextSnapshot, CompanionPersonaSnapshot } from './context-assembly.ts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { BackgroundGeneration } from './background-generation.ts';
import type { CompanionBirthOriginStore } from './companion-birth-origin-store.ts';
import type { CompanionPrebirthSafety } from './companion-prebirth-safety.ts';
import { birthFields, birthUUID } from './companion-birth-origin-codec.ts';
import { ApiError } from './errors.ts';

export interface OwnedCompanionContextSource {
  readonly kind: 'owned_companion_context_source'; readonly ownerId: string;
  readonly companionId: string; readonly conversationId: string;
  readonly persona: CompanionPersonaSnapshot;
  readonly relationship: CompanionContextSnapshot['relationship'];
  readonly provenance: Readonly<{
    birthReceiptId: string; bornAt: string; taskId: string; generation: number; answersId: string;
    sourceDraftId: string; sourceRevision: number; sourceReceiptVersion: 1 | 2 | null;
    previewRevision: 1; generatedBy: 'model' | 'fallback'; proofKind: 'historical_completed_preview' | 'current_completed_preview';
  }>;
}
export interface CompanionContextSourceSelection { readonly companionId: string; readonly conversationId: string; }
const unavailable = () => new ApiError(503, 'COMPANION_CONTEXT_SOURCE_UNAVAILABLE', 'The saved companion context could not be confirmed.');
function session(value: FixedSessionContext): FixedSessionContext {
  try {
    const r = birthFields(value, ['userId', 'tokenHash']);
    if (typeof r.tokenHash !== 'string' || /^[0-9a-f]{64}$/.exec(r.tokenHash)?.[0] !== r.tokenHash) throw unavailable();
    return Object.freeze({ userId: birthUUID(r.userId), tokenHash: r.tokenHash });
  } catch { throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.'); }
}
function selection(value: CompanionContextSourceSelection): CompanionContextSourceSelection {
  try { const r = birthFields(value, ['companionId', 'conversationId']); return Object.freeze({ companionId: birthUUID(r.companionId), conversationId: birthUUID(r.conversationId) }); }
  catch { throw new ApiError(400, 'CONTEXT_SELECTION_INVALID', 'Use the saved companion and its main room.'); }
}
/** Genuine persisted source composition. No method launches a model, confirms
 * memory, creates a turn, issues a lease or relaxes paid/consent/output gates. */
export class CompanionContextSources {
  constructor(private readonly db: Database, private readonly origins: Pick<CompanionBirthOriginStore, 'readActiveContextOrigin'>,
    private readonly generations: Pick<BackgroundGeneration, 'readSavedCompletedForViewerInTransaction'>,
    private readonly safety: Pick<CompanionPrebirthSafety, 'assertCurrentSafetyInTransaction'>) {}

  private async readOwned(client: PoolClient, context: FixedSessionContext, expected: CompanionContextSourceSelection,
    signal?: AbortSignal): Promise<Readonly<OwnedCompanionContextSource>> {
    await authorizeFixedSession(client, context, signal);
    const owner = (await client.query('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [context.userId])).rows[0];
    if (!owner || owner.account_kind !== 'student') throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account.');
    try {
      const original = await this.origins.readActiveContextOrigin(client, context.userId);
      if (!original) throw new ApiError(409, 'COMPANION_BIRTH_REQUIRED', 'Complete companion birth first.');
      const { snapshot, originalRelationship } = original, capture = snapshot.capture, receipt = snapshot.receipt;
      if (receipt.identity.companionId !== expected.companionId || receipt.main.id !== expected.conversationId)
        throw new ApiError(404, 'NOT_FOUND', 'The saved companion room was not found.');
      if (snapshot.ownerId !== context.userId || capture.ownerId !== context.userId || capture.task.companionId !== expected.companionId) throw unavailable();
      const proof = await this.generations.readSavedCompletedForViewerInTransaction(client, context, { taskId: capture.task.id }, signal);
      if (!proof) throw unavailable();
      // The historical decoder authenticates this locked task's manifest;
      // bind its actual version to the immutable birth capture as well.
      const tasks = (await client.query('SELECT source_receipt_version FROM platform_companion_generation_tasks WHERE id=$1 AND user_id=$2 FOR SHARE',
        [capture.task.id, context.userId])).rows;
      if (tasks.length !== 1 || tasks[0].source_receipt_version !== capture.task.sourceReceiptVersion) throw unavailable();
      const { preview, source } = proof.envelope;
      if (source.taskId !== capture.task.id || source.companionId !== expected.companionId || source.generation !== capture.task.generation
        || source.answersId !== capture.task.answersId || source.sourceDraftId !== capture.task.sourceDraftId || source.sourceRevision !== capture.task.sourceRevision
        || source.previewRevision !== 1 || preview.companionId !== expected.companionId || preview.revision !== 1
        || preview.inkToken !== capture.identity.inkToken
        || (capture.task.sourceReceiptVersion !== null && proof.kind !== 'historical_completed_preview')) throw unavailable();
      const result: Readonly<OwnedCompanionContextSource> = Object.freeze({ kind: 'owned_companion_context_source', ownerId: context.userId,
        companionId: expected.companionId, conversationId: expected.conversationId,
        persona: Object.freeze({ ownerId: context.userId, speaker: 'companion', revision: 1, name: capture.identity.name,
          styleCard: preview.styleCard, samples: Object.freeze([...preview.samples]) }),
        relationship: originalRelationship === null ? null : Object.freeze({ ownerId: context.userId, revision: 1, nickname: null, stage: originalRelationship }),
        provenance: Object.freeze({ birthReceiptId: receipt.id, bornAt: receipt.bornAt, taskId: source.taskId, generation: source.generation,
          answersId: source.answersId, sourceDraftId: source.sourceDraftId, sourceRevision: source.sourceRevision,
          sourceReceiptVersion: capture.task.sourceReceiptVersion, previewRevision: 1, generatedBy: preview.generatedBy, proofKind: proof.kind }) });
      await authorizeFixedSession(client, context, signal); signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ApiError && [401, 403, 404, 409].includes(error.status)) throw error;
      throw unavailable();
    }
  }
  /** Private observation survives changed generation/provider availability and
   * current terms, but never bypasses a live source/turn admission gate. */
  async observe(value: FixedSessionContext, requested: CompanionContextSourceSelection, signal?: AbortSignal) {
    const context = session(value), expected = selection(requested);
    return this.db.withBoundedTransaction(client => this.readOwned(client, context, expected, signal));
  }
  /** Called only inside a genuine owner's bounded turn-preparation transaction.
   * The existing live intake/name/legal barrier may adopt surviving legacy raw
   * input into its real inventory. It never invents a detection or grants a turn. */
  async prepareInTransaction(client: PoolClient, value: FixedSessionContext, requested: CompanionContextSourceSelection,
    signal?: AbortSignal): Promise<Readonly<OwnedCompanionContextSource>> {
    const context = session(value), expected = selection(requested);
    // Validate birth/room/source before any current-source adoption is attempted.
    const result = await this.readOwned(client, context, expected, signal);
    await this.safety.assertCurrentSafetyInTransaction(client, context, signal);
    await authorizeFixedSession(client, context, signal); signal?.throwIfAborted();
    return result;
  }
}
