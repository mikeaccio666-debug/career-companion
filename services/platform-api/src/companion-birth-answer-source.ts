import type { PoolClient } from 'pg';
import { careerRecordId, careerRecordObject } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import type { BackgroundGeneration } from './background-generation.ts';
import { CompanionBirthOriginStore } from './companion-birth-origin-store.ts';
import { parseCapturedCompanionAnswers } from './companion-captured-answers.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';

const unavailable = () => new ApiError(503, 'COMPANION_BIRTH_ANSWERS_UNAVAILABLE', 'The saved birth answers could not be confirmed.');
function fixed(value: FixedSessionContext): FixedSessionContext {
  try {
    const s = careerRecordObject(value, ['userId', 'tokenHash']);
    if (typeof s.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(s.tokenHash)) throw unavailable();
    return Object.freeze({ userId: careerRecordId(s.userId), tokenHash: s.tokenHash });
  } catch { throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.'); }
}

/** Internal authenticated birth snapshot, including private answers.
 * Never expose this object to HTTP, logs or model input. Each consumer must
 * project an explicit purpose-specific whitelist. It grants no live safety,
 * model, generation, memory confirmation or student-entry permission. */
export class CompanionBirthAnswerSources {
  private readonly storage: OnboardingStorage;
  private readonly origins: CompanionBirthOriginStore;
  constructor(private readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>,
    legal: LegalBundle | null,
    private readonly generations: Pick<BackgroundGeneration, 'readSavedCompletedForViewerInTransaction'>) {
    this.storage = new OnboardingStorage(config, legal);
    this.origins = new CompanionBirthOriginStore(config.dataCrypto);
  }

  async readInTransaction(c: PoolClient, value: FixedSessionContext, signal?: AbortSignal) {
    const s = fixed(value);
    await authorizeFixedSession(c, s, signal);
    const owner = (await c.query('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [s.userId])).rows[0];
    if (owner?.account_kind !== 'student') throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account.');
    await this.storage.authorizeSession(c, s, signal);
    if (!this.storage.crypto) throw unavailable();
    const original = await this.origins.readActiveContextOrigin(c, s.userId);
    if (!original) throw new ApiError(409, 'COMPANION_BIRTH_REQUIRED', 'Complete companion birth first.');
    const { snapshot } = original, { capture, receipt } = snapshot, task = capture.task;
    // Authenticates the complete saved answer/command prefix, rule seed and
    // completed generation; merely decrypting a mutable answer row is not proof.
    const proof = await this.generations.readSavedCompletedForViewerInTransaction(c, s, { taskId: task.id }, signal);
    if (!proof) throw unavailable();
    const source = proof.envelope.source;
    if (snapshot.ownerId !== s.userId || capture.ownerId !== s.userId
      || receipt.identity.companionId !== task.companionId || source.companionId !== task.companionId
      || source.taskId !== task.id || source.generation !== task.generation || source.answersId !== task.answersId
      || source.sourceDraftId !== task.sourceDraftId || source.sourceRevision !== task.sourceRevision
      || source.previewRevision !== 1 || source.questionnaireRevision !== 1 || source.rulesRevision !== 1
      || (task.sourceReceiptVersion !== null && proof.kind !== 'historical_completed_preview')) throw unavailable();
    const rows = (await c.query(`SELECT a.*,t.source_receipt_version FROM platform_companion_answers a
      JOIN platform_companion_generation_tasks t ON t.answers_id=a.id AND t.user_id=a.user_id
      WHERE t.id=$1 AND t.user_id=$2 FOR SHARE OF a,t`, [task.id, s.userId])).rows;
    if (rows.length !== 1) throw unavailable();
    const row = rows[0];
    let answers: ReturnType<typeof parseCapturedCompanionAnswers>;
    try {
      const raw = this.storage.crypto.openUtf8(row.payload_ciphertext, { table: 'platform_companion_answers',
        column: 'payload_ciphertext', rowId: task.answersId, ownerId: s.userId, revision: task.sourceRevision });
      answers = parseCapturedCompanionAnswers(JSON.parse(raw));
      if (JSON.stringify(answers) !== raw || answers.id !== task.answersId || answers.userId !== s.userId
        || answers.sourceDraftId !== task.sourceDraftId || answers.sourceRevision !== task.sourceRevision
        || row.id !== task.answersId || row.user_id !== s.userId || row.source_draft_id !== task.sourceDraftId
        || row.source_revision !== task.sourceRevision || row.source_receipt_version !== task.sourceReceiptVersion) throw unavailable();
    } catch { throw unavailable(); }
    await authorizeFixedSession(c, s, signal); signal?.throwIfAborted();
    return Object.freeze({
      ownerId:s.userId, companionId:task.companionId, conversationId:receipt.main.id,
      birthReceiptId:receipt.id, bornAt:receipt.bornAt, answers,
      provenance:Object.freeze({taskId:task.id,generation:task.generation,answersId:answers.id,
        sourceDraftId:answers.sourceDraftId,sourceRevision:answers.sourceRevision,
        sourceReceiptVersion:task.sourceReceiptVersion,proofKind:proof.kind}),
    });
  }

  async read(value: FixedSessionContext, signal?: AbortSignal) {
    const s = fixed(value);
    return this.db.withBoundedTransaction(c => this.readInTransaction(c, s, signal));
  }
}
