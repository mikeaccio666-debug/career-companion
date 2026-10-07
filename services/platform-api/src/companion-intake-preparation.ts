import type { CompanionDimensions, OnboardingDimensionPreparation, ClassifiedOnboardingText } from '@companion/career-core';
import { prepareOnboardingDimensions } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import { ApiError } from './errors.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage, intakeUnavailable, type IntakeOperationRow } from './onboarding-storage.ts';

export interface CompanionIntakePreparationResult extends Omit<OnboardingDimensionPreparation, 'dimensions'> {
  readonly dimensions: Readonly<CompanionDimensions>;
}
function revisionInput(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), revision = descriptors.expectedRevision;
  if (Reflect.ownKeys(value).length !== 1 || !revision || !('value' in revision) || !revision.enumerable
    || !Number.isSafeInteger(revision.value) || revision.value < 0 || revision.value > 2147483647
    || Object.is(revision.value, -0)) throw invalid();
  return revision.value;
}
const invalid = () => new ApiError(400, 'INVALID_INPUT', 'Use the current intake revision.');

/** Internal source preparation only. The result is a snapshot, never generation or execution permission.
 * Consumers must revalidate the account, draft revision and complete safety history when committing work.
 * Recovery can repair reference-only detection/response inboxes; no companion, room, memory or lease is created.
 */
export class CompanionIntakePreparation {
  private readonly storage: OnboardingStorage;
  constructor(readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, legal: LegalBundle | null) {
    this.storage = new OnboardingStorage(config, legal);
  }
  async prepare(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionIntakePreparationResult>> {
    const expectedRevision = revisionInput(value), fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash });
    return this.db.withBoundedTransaction(async client => {
      await this.storage.authorizeSession(client, fixed, signal);
      const row = await this.storage.row(client, fixed.userId);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Complete the intake before preparing a companion.');
      const draft = this.storage.decode(row), submissions = await this.storage.recover(client, draft);
      const safety = this.storage.safetyState(submissions);
      if (safety.status === 'blocked') throw new ApiError(409, 'ONBOARDING_SAFETY_REVIEW_REQUIRED', 'The intake safety response must be handled before continuing.');
      if (safety.status !== 'clear' || submissions.some(item => item.level !== 'L0' || item.detector_mode !== 'full')) {
        throw new ApiError(409, 'ONBOARDING_SAFETY_REQUIRED', 'Wait for the complete intake safety check before continuing.');
      }
      if (draft.revision !== expectedRevision) throw new ApiError(409, 'ONBOARDING_REVISION_CHANGED', 'Read the current intake progress before making another change.');
      if (draft.state !== 'intake_ready') throw new ApiError(409, 'ONBOARDING_STATE_CHANGED', 'Complete the intake questions before preparing a companion.');
      let classified: ClassifiedOnboardingText | undefined;
      if (draft.answersPartial.extra?.kind === 'answered') {
        const textId = draft.answersPartial.extra.value.textId, source = submissions.find(item => item.operation_id === textId);
        if (!source || source.question_id !== 'extra' || source.submitted_revision + 1 !== draft.answersPartial.extra.appliedRevision) throw intakeUnavailable();
        const operation = (await client.query<IntakeOperationRow>(`SELECT operation_id,draft_id,applied_revision,request_ciphertext
          FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2 FOR UPDATE`, [fixed.userId, textId])).rows[0];
        if (!operation || operation.draft_id !== draft.id || operation.applied_revision !== source.submitted_revision) throw intakeUnavailable();
        const command = this.storage.decodeOperation(operation, fixed.userId), result = this.storage.decodeResult(source);
        if (command.action.kind !== 'text' || command.action.questionId !== 'extra' || result.level !== 'L0' || result.mode !== 'full') throw intakeUnavailable();
        classified = { textId, questionId: 'extra', submittedAtRevision: source.submitted_revision,
          level: 'L0', detectorRevision: result.detectorRevision, mode: 'full', text: command.action.text };
      }
      let prepared: OnboardingDimensionPreparation;
      try { prepared = prepareOnboardingDimensions(draft, classified); } catch { throw intakeUnavailable(); }
      await authorizeFixedSession(client, fixed, signal);
      signal?.throwIfAborted();
      return Object.freeze({ ...prepared, dimensions: Object.freeze({ ...prepared.dimensions }) });
    });
  }
}
