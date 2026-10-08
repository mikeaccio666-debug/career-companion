import type { CompanionStudentJourneyState, CompanionSealSelectionSaved, PlatformProviderRuntime, PublicCompanionPreview } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { BackgroundGeneration } from './background-generation.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import type { LegalBundle } from './legal-documents.ts';
import { ApiError } from './errors.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { CompanionIdentityDrafts } from './companion-identity-drafts.ts';
import { CompanionNameSafety } from './companion-name-safety.ts';
import { CompanionNameSafetyRunner, createCompanionNameSafetyRunner } from './companion-name-safety-runner.ts';
import { CompanionNamingEntry } from './companion-naming-entry.ts';
import { CompanionPrebirthSafety } from './companion-prebirth-safety.ts';
import { verifyPrebirthInventoryInTransaction } from './companion-prebirth-protocol.ts';
import { CompanionNameSafetyResponses } from './companion-name-safety-responses.ts';
import { CompanionNameSafetyDelivery } from './companion-name-safety-delivery.ts';
import { readSafetyResponseBundle, type SafetyResponseBundle } from './safety-response-bundle.ts';
import { readSafetyDeliveryReview, type SafetyDeliveryReview } from './safety-delivery-review.ts';
import { companionNameNotification, readNameDispatchInTransaction } from './companion-name-dispatch-protocol.ts';
import { companionNameUuid } from './companion-name-safety-protocol.ts';

export interface CompanionStudentOnboardingServices {
  readonly identities: CompanionIdentityDrafts; readonly names: CompanionNameSafety;
  readonly resources: CompanionNameSafetyResponses; readonly nameDelivery: CompanionNameSafetyDelivery;
  readonly runner: CompanionNameSafetyRunner; readonly prebirth: CompanionPrebirthSafety; readonly naming: CompanionNamingEntry;
}
const unavailable = () => new ApiError(503, 'COMPANION_JOURNEY_UNAVAILABLE', 'The saved companion preparation could not be confirmed.');
const changed = () => new ApiError(409, 'COMPANION_JOURNEY_CHANGED', 'Read the current companion preparation again.');
const fixed = (context: FixedSessionContext) => Object.freeze({ userId: context.userId, tokenHash: context.tokenHash });

/** Shared actual services for O6–O8. Reads observe authenticated persisted
 * facts; only an explicit select enters the complete same-transaction barrier.
 * No preparation state returned here is permission to birth or execute. */
export class CompanionStudentOnboarding {
  private readonly storage: OnboardingStorage;
  readonly identities: CompanionIdentityDrafts; readonly names: CompanionNameSafety;
  readonly resources: CompanionNameSafetyResponses; readonly nameDelivery: CompanionNameSafetyDelivery;
  readonly runner: CompanionNameSafetyRunner; readonly prebirth: CompanionPrebirthSafety; readonly naming: CompanionNamingEntry;
  constructor(readonly db: Database, readonly config: PlatformConfig, legal: LegalBundle | null,
    readonly background: BackgroundGeneration, services: CompanionStudentOnboardingServices) {
    this.storage = new OnboardingStorage(config, legal);
    this.identities = services.identities; this.names = services.names; this.resources = services.resources;
    this.nameDelivery = services.nameDelivery; this.runner = services.runner; this.prebirth = services.prebirth; this.naming = services.naming;
  }
  async read(context: FixedSessionContext, signal?: AbortSignal): Promise<Readonly<CompanionStudentJourneyState>> {
    const captured = fixed(context);
    // Existing 049 observation remains unchanged. Validate its concrete cursor
    // again under our owner lock; a concurrent raw write asks the observer to
    // retry GET, never permits a save against an outdated projection.
    const naming = await this.naming.read(captured, signal);
    return this.db.withBoundedTransaction(async client => {
      await authorizeFixedSession(client, captured, signal);
      const owner = (await client.query<{ account_kind: string }>('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [captured.userId])).rows[0];
      if (!owner || owner.account_kind !== 'student') throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account for companion preparation.');
      if (!this.storage.crypto) throw unavailable();
      await verifyPrebirthInventoryInTransaction(client, this.storage.crypto, captured.userId, signal);
      const tasks = (await client.query<{ id: string; companion_id: string }>('SELECT id,companion_id FROM platform_companion_generation_tasks WHERE user_id=$1 ORDER BY id FOR SHARE', [captured.userId])).rows;
      if (tasks.length > 1) throw unavailable();
      const task = tasks[0];
      if (!task) {
        if (naming.kind !== 'not_started') throw unavailable();
        await authorizeFixedSession(client, captured, signal); signal?.throwIfAborted();
        return Object.freeze({ kind: 'not_started' as const, naming });
      }
      const entries = (await client.query<{ task_id: string; companion_id: string; revision: number; latest_submission_id: string }>(
        'SELECT task_id,companion_id,revision,latest_submission_id FROM platform_companion_name_entries WHERE user_id=$1 ORDER BY id FOR SHARE', [captured.userId])).rows;
      if (entries.length > 1) throw unavailable();
      const entry = entries[0];
      if (entry) {
        if (naming.kind !== 'naming' || naming.entry.taskId !== entry.task_id || naming.entry.companionId !== entry.companion_id
          || naming.entry.revision !== entry.revision || naming.entry.latestSubmissionId !== entry.latest_submission_id) throw changed();
        if (entry.task_id !== task.id || entry.companion_id !== task.companion_id) throw unavailable();
      } else if (naming.kind !== 'not_started') throw changed();
      const proof = await this.background.readSavedCompletedForViewerInTransaction(client, captured, { taskId: task.id }, signal);
      if (!proof) {
        if (entry) throw unavailable();
        await authorizeFixedSession(client, captured, signal); signal?.throwIfAborted();
        return Object.freeze({ kind: 'not_started' as const, naming });
      }
      const observed = await this.identities.readSavedInTransaction(client, captured, { taskId: task.id }, signal);
      if (observed.identity && !observed.selection) throw unavailable();
      let waitingForName = Boolean(entry), latestNamingOperationId: string | null = null;
      if (entry) {
        const source = await this.names.observeSubmissionInTransaction(client, entry.latest_submission_id, signal);
        if (source.user_id !== captured.userId || source.task_id !== task.id || source.submitted_revision !== entry.revision) throw unavailable();
        if (source.first_name_dispatch_id) {
          const dispatch = await readNameDispatchInTransaction(client, this.storage.crypto, {
            dispatchId: source.first_name_dispatch_id, taskId: source.task_id, submissionId: source.id,
          }, signal);
          if (dispatch.row.user_id !== captured.userId || dispatch.row.submission_id !== entry.latest_submission_id
            || dispatch.row.task_id !== task.id || dispatch.row.companion_id !== task.companion_id
            || dispatch.row.submitted_revision !== entry.revision || dispatch.row.operation_id !== source.operation_id) throw unavailable();
          // Read only the authentic current coordinate. This neither replaces
          // an originating client's unknown intent nor renews its authorization.
          latestNamingOperationId = dispatch.row.operation_id;
        }
        waitingForName = source.status !== 'detected' || source.level !== 'L0' || source.detector_mode !== 'full'
          || source.application_status !== 'applied' || source.applied_identity_revision !== observed.identity?.revision;
        if (naming.kind === 'naming' && naming.latest && (naming.latest.detection.status !== source.status
          || naming.latest.detection.generation !== source.generation || naming.latest.application.status !== source.application_status)) throw changed();
      }
      const stage = waitingForName ? 'naming' : observed.identity
        ? observed.selection?.selectedSeal === null ? 'seal_ready' : 'seal_saved' : 'preview';
      const savedPreview = proof.envelope.preview;
      const preview: PublicCompanionPreview = Object.freeze({ taskId: proof.envelope.source.taskId,
        companionId: savedPreview.companionId, revision: savedPreview.revision, generatedBy: savedPreview.generatedBy,
        summary: savedPreview.summary, samples: Object.freeze([savedPreview.samples[0], savedPreview.samples[1], savedPreview.samples[2]] as const),
        inkToken: savedPreview.inkToken });
      await authorizeFixedSession(client, captured, signal); signal?.throwIfAborted();
      return Object.freeze({ kind: 'journey' as const, taskId: task.id, companionId: task.companion_id, stage,
        preview, naming, latestNamingOperationId, identity: observed.identity, selection: observed.selection });
    });
  }
  readSelectionOperation(context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
    return this.identities.readSelectionOperation(fixed(context), value, signal);
  }
  select(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionSealSelectionSaved>> {
    return this.prebirth.select(fixed(context), value, signal);
  }
  /** User explicitly resumes an already classified original own intent. The
   * authentic journal/session/version are checked before reconstructing its
   * real notification. Nothing pending/running can enter classification here. */
  async resumeNamePreparation(context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
    const captured = fixed(context);
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ApiError(400, 'INVALID_INPUT', 'Use one saved naming operation.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== 1 || !descriptors.operationId || !('value' in descriptors.operationId) || !descriptors.operationId.enumerable) {
      throw new ApiError(400, 'INVALID_INPUT', 'Use one saved naming operation.');
    }
    const operationId = companionNameUuid(descriptors.operationId.value);
    const notification = await this.db.withBoundedTransaction(async client => {
      const version = await this.storage.authorizeSession(client, captured, signal);
      await verifyPrebirthInventoryInTransaction(client, this.storage.crypto, captured.userId, signal);
      const rows = (await client.query<{ id: string; task_id: string; submission_id: string }>('SELECT id,task_id,submission_id FROM platform_companion_name_dispatches WHERE user_id=$1 AND operation_id=$2 FOR UPDATE',
        [captured.userId, operationId])).rows;
      if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'The saved naming operation was not found.');
      if (rows.length !== 1) throw unavailable();
      const row = rows[0], notice = companionNameNotification({ dispatchId: row.id, taskId: row.task_id, submissionId: row.submission_id });
      const dispatch = await readNameDispatchInTransaction(client, this.storage.crypto, notice, signal);
      if (dispatch.row.user_id !== captured.userId || dispatch.snapshot.originalSessionHash !== captured.tokenHash
        || dispatch.snapshot.submittedAuthVersion !== version) throw new ApiError(401, 'AUTH_REQUIRED', 'The original naming authorization has ended.');
      const source = await this.names.observeSubmissionInTransaction(client, row.submission_id, signal);
      if (source.status !== 'detected' || source.level !== 'L0' || source.detector_mode !== 'full') {
        throw new ApiError(409, 'COMPANION_NAME_PREPARATION_NOT_READY', 'Wait for the genuine complete naming check before recovering seal preparation.');
      }
      await authorizeFixedSession(client, captured, signal); signal?.throwIfAborted(); return notice;
    });
    await this.naming.executeNotification(notification, signal);
    const accepted = await this.naming.readOperation(captured, operationId, signal);
    if (!accepted) throw unavailable(); return accepted;
  }
}
/** App and worker share one actual background and this assembly. Configuration
 * loading does not activate any asset/review; missing files truthfully disable
 * new work while authenticated historical archives remain readable. */
export async function createCompanionStudentOnboarding(db: Database, config: PlatformConfig, legal: LegalBundle | null,
  runtime: PlatformProviderRuntime, background: BackgroundGeneration, suppliedReview?: SafetyDeliveryReview | null): Promise<CompanionStudentOnboarding> {
  const identities = await CompanionIdentityDrafts.fromConfiguration(db, config, legal, background);
  let bundle: SafetyResponseBundle | null = null;
  try { bundle = await readSafetyResponseBundle(config.safetyResponseBundlePath); } catch { /* unavailable */ }
  let review: SafetyDeliveryReview | null = suppliedReview ?? null;
  if (suppliedReview === undefined) { try { review = await readSafetyDeliveryReview(config.safetyDeliveryReviewPath); } catch { /* unavailable */ } }
  const resources = new CompanionNameSafetyResponses(db, config, bundle), nameDelivery = new CompanionNameSafetyDelivery(db, config, legal, resources, bundle, review);
  const names = new CompanionNameSafety(db, config, legal, background, identities, nameDelivery);
  let runner: CompanionNameSafetyRunner;
  try { runner = await createCompanionNameSafetyRunner(names, config, runtime); }
  catch { runner = new CompanionNameSafetyRunner(names, config, runtime, null); }
  const prebirth = new CompanionPrebirthSafety(db, config, legal, background, names, identities);
  const naming = new CompanionNamingEntry(db, config, legal, names, runner, prebirth, resources);
  return new CompanionStudentOnboarding(db, config, legal, background, { identities, names, resources, nameDelivery, runner, prebirth, naming });
}
