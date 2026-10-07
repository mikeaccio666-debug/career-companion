import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OnboardingCommand, OnboardingDraft, OnboardingSafetyResult } from '@companion/platform-contracts';
import { parseOnboardingCommand, parseOnboardingDraft, parseOnboardingSafetyResult } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import type { DataCrypto } from './data-crypto.ts';
import { ApiError } from './errors.ts';
import { assertActiveLegal, type LegalBundle } from './legal-documents.ts';
import { parseOnboardingSafetyClaim, type OnboardingSafetyClaim } from './onboarding-safety-protocol.ts';

export interface IntakeDraftRow { id: string; user_id: string; revision: number; payload_ciphertext: Buffer; updated_at: Date; }
export interface IntakeOperationRow { operation_id: string; draft_id: string; applied_revision: number; request_ciphertext: Buffer; }
export interface SafetySubmissionRow {
  id: string; user_id: string; operation_id: string; draft_id: string; question_id: OnboardingSafetyClaim['questionId'];
  submitted_revision: number; status: 'pending' | 'running' | 'detected'; generation: number; auth_version: string | null;
  lease_token: string | null; lease_until: Date | null; execution_token: string | null; detector_revision: number | null; result_ciphertext: Buffer | null;
  level: 'L0' | 'L1' | 'L2' | null; detector_mode: 'full' | 'keyword_only' | null;
}
export const intakeUnavailable = () => new ApiError(503, 'DATA_STORAGE_UNAVAILABLE', 'Private intake data could not be saved or read.');
export const safetyClaimChanged = () => new ApiError(409, 'ONBOARDING_SAFETY_CLAIM_CHANGED', 'The intake detection claim is no longer current.');
export interface IntakeSafetyState { status: 'clear' | 'pending' | 'blocked'; pendingCount: number; blockedLevel: 'L1' | 'L2' | null; }

/** Internal shared storage. All writers serialize on the real account before draft/operation/submission locks. */
export class OnboardingStorage {
  readonly crypto: DataCrypto | undefined;
  private readonly requireVerifiedEmail: boolean;
  constructor(config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, readonly bundle: LegalBundle | null) {
    this.crypto = config.dataCrypto; this.requireVerifiedEmail = config.requireVerifiedEmail;
  }
  async authorizeAccount(client: PoolClient, userId: string, authVersion?: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const user = await client.query(`SELECT account_kind,email_verified_at,auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE`, [userId]);
    signal?.throwIfAborted();
    if (!user.rowCount || authVersion !== undefined && String(user.rows[0].auth_version) !== authVersion) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    if (user.rows[0].account_kind !== 'student') throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account for intake.');
    if (this.requireVerifiedEmail && !user.rows[0].email_verified_at) throw new ApiError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email before continuing.');
    const policy = await assertActiveLegal(client, this.bundle, signal);
    const consent = await client.query(`SELECT user_id FROM platform_terms_consents
      WHERE user_id=$1 AND terms_version=$2 AND content_digest=$3 FOR SHARE`, [userId, policy.version, policy.digest]);
    signal?.throwIfAborted();
    if (!consent.rowCount) throw new ApiError(403, 'TERMS_CONFIRMATION_REQUIRED', 'Read and confirm the current legal documents before continuing.');
    if (!this.crypto) throw intakeUnavailable();
    return String(user.rows[0].auth_version);
  }
  async authorizeSession(client: PoolClient, context: FixedSessionContext, signal?: AbortSignal): Promise<string> {
    await authorizeFixedSession(client, context, signal);
    const version = await this.authorizeAccount(client, context.userId, undefined, signal);
    await authorizeFixedSession(client, context, signal); return version;
  }
  async row(client: PoolClient, userId: string): Promise<IntakeDraftRow | undefined> {
    return (await client.query<IntakeDraftRow>(`SELECT id,user_id,revision,payload_ciphertext,updated_at
      FROM platform_onboarding_drafts WHERE user_id=$1 FOR UPDATE`, [userId])).rows[0];
  }
  decode(row: IntakeDraftRow): OnboardingDraft {
    try {
      const draft = parseOnboardingDraft(JSON.parse(this.crypto!.openUtf8(row.payload_ciphertext, {
        table: 'platform_onboarding_drafts', column: 'payload_ciphertext', rowId: row.id, ownerId: row.user_id, revision: row.revision,
      })));
      if (draft.id !== row.id || draft.userId !== row.user_id || draft.revision !== row.revision || draft.updatedAt !== row.updated_at.toISOString()) throw intakeUnavailable();
      return draft;
    } catch { throw intakeUnavailable(); }
  }
  decodeOperation(row: IntakeOperationRow, userId: string): OnboardingCommand {
    try {
      const command = parseOnboardingCommand(JSON.parse(this.crypto!.openUtf8(row.request_ciphertext, {
        table: 'platform_onboarding_operations', column: 'request_ciphertext', rowId: row.operation_id, ownerId: userId, revision: row.applied_revision,
      })));
      if (command.operationId !== row.operation_id || command.expectedRevision + 1 !== row.applied_revision) throw intakeUnavailable();
      return command;
    } catch { throw intakeUnavailable(); }
  }
  claim(row: SafetySubmissionRow): Readonly<OnboardingSafetyClaim> {
    try { return parseOnboardingSafetyClaim({ userId: row.user_id, submissionId: row.id, operationId: row.operation_id, draftId: row.draft_id,
      questionId: row.question_id, submittedAtRevision: row.submitted_revision, authVersion: row.auth_version, generation: row.generation,
      leaseToken: row.lease_token, detectorRevision: row.detector_revision }); } catch { throw intakeUnavailable(); }
  }
  decodeResult(row: SafetySubmissionRow): OnboardingSafetyResult {
    try {
      const claim = this.claim(row), result = parseOnboardingSafetyResult(JSON.parse(this.crypto!.openUtf8(row.result_ciphertext!, {
        table: 'platform_onboarding_safety_submissions', column: 'result_ciphertext', rowId: row.id, ownerId: row.user_id, revision: row.generation,
      })));
      if (result.textId !== claim.operationId || result.submittedAtRevision !== claim.submittedAtRevision || result.detectorRevision !== claim.detectorRevision
        || result.level !== row.level || result.mode !== row.detector_mode
        || result.level === 'L0' && (claim.questionId === 'extra' ? result.resolution !== undefined : !result.resolution)
        || result.resolution?.kind === 'answer' && result.resolution.questionId !== claim.questionId) throw intakeUnavailable();
      return result;
    } catch { throw intakeUnavailable(); }
  }
  async at(client: PoolClient): Promise<string> { return (await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0].at.toISOString(); }
  async write(client: PoolClient, previous: OnboardingDraft, draft: OnboardingDraft): Promise<void> {
    const ciphertext = this.crypto!.sealUtf8(JSON.stringify(draft), { table: 'platform_onboarding_drafts', column: 'payload_ciphertext', rowId: draft.id, ownerId: draft.userId, revision: draft.revision });
    const saved = await client.query(`UPDATE platform_onboarding_drafts SET revision=$3,payload_ciphertext=$4,updated_at=$5
      WHERE id=$1 AND user_id=$2 AND revision=$6 RETURNING id`, [draft.id, draft.userId, draft.revision, ciphertext, draft.updatedAt, previous.revision]);
    if (!saved.rowCount) throw new ApiError(409, 'ONBOARDING_REVISION_CHANGED', 'Read the current intake progress before making another change.');
  }
  /** No raw text is copied. This also repairs all unclassified pre-inbox operations, never just the latest reference.
   * A full scan either commits or fails within the transaction deadline; damaged history is not silently skipped.
   */
  async recover(client: PoolClient, draft: OnboardingDraft): Promise<SafetySubmissionRow[]> {
    const operations = await client.query<IntakeOperationRow>(`SELECT operation_id,draft_id,applied_revision,request_ciphertext
      FROM platform_onboarding_operations WHERE user_id=$1 ORDER BY applied_revision,operation_id FOR UPDATE`, [draft.userId]);
    const texts = new Map<string, OnboardingCommand>();
    for (const row of operations.rows) {
      if (row.draft_id !== draft.id || row.applied_revision > draft.revision) throw intakeUnavailable();
      const command = this.decodeOperation(row, draft.userId);
      if (command.action.kind !== 'text') continue;
      texts.set(row.operation_id, command);
      await client.query(`INSERT INTO platform_onboarding_safety_submissions(id,user_id,operation_id,draft_id,question_id,submitted_revision)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,operation_id) DO NOTHING`, [randomUUID(), draft.userId, row.operation_id, draft.id, command.action.questionId, row.applied_revision]);
    }
    const rows = (await client.query<SafetySubmissionRow>(`SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1 ORDER BY submitted_revision,id FOR UPDATE`, [draft.userId])).rows;
    if (rows.length !== texts.size) throw intakeUnavailable();
    for (const row of rows) {
      const command = texts.get(row.operation_id);
      if (!command || command.action.kind !== 'text' || row.draft_id !== draft.id || row.submitted_revision !== command.expectedRevision + 1
        || row.question_id !== command.action.questionId) throw intakeUnavailable();
      if (row.status === 'detected') this.decodeResult(row);
    }
    if (draft.pendingText) {
      const row = rows.find(item => item.operation_id === draft.pendingText!.id);
      if (!row || row.question_id !== draft.pendingText.questionId || row.submitted_revision !== draft.pendingText.submittedAtRevision) throw intakeUnavailable();
    }
    if (draft.safety) {
      const receipt = draft.safety, row = rows.find(item => item.operation_id === receipt.textId);
      if (!row || row.status !== 'detected' || row.question_id !== receipt.questionId || row.submitted_revision !== receipt.submittedAtRevision
        || row.level !== receipt.level || row.detector_mode !== receipt.mode || row.detector_revision !== receipt.detectorRevision) throw intakeUnavailable();
    }
    return rows;
  }
  safetyState(rows: SafetySubmissionRow[]): IntakeSafetyState {
    const blockedLevel = rows.some(row => row.level === 'L2') ? 'L2' : rows.some(row => row.level === 'L1') ? 'L1' : null;
    const pendingCount = rows.filter(row => row.status !== 'detected').length;
    return { status: blockedLevel ? 'blocked' : pendingCount ? 'pending' : 'clear', pendingCount, blockedLevel };
  }
}
