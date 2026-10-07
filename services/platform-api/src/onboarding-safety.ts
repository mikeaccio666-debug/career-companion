import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OnboardingDraft, ProviderRequestAdmission } from '@companion/platform-contracts';
import { resolveOnboardingText, resumeOnboardingDraft } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import { ApiError } from './errors.ts';
import { intakeUnavailable, OnboardingStorage, safetyClaimChanged, type IntakeOperationRow, type SafetySubmissionRow } from './onboarding-storage.ts';
import { parseOnboardingSafetyClaim, parseOnboardingSafetyDecision, type OnboardingSafetyClaim } from './onboarding-safety-protocol.ts';
import { enqueueSafetyResponse } from './onboarding-safety-response-outbox.ts';

export type SafetyFailure = 'unavailable' | 'timeout' | 'invalid_result';
/** Injected only by a trusted server runtime. Tests use explicit fictional fixtures, never an HTTP-supplied decision. */
export type IntakeClassifier = (input: Readonly<{ text: string; questionId: OnboardingSafetyClaim['questionId'] }>, admission: ProviderRequestAdmission) => Promise<unknown>;
/** Server-bound policy guard, called under the actual claim locks before launch and result acceptance. Never HTTP input. */
export type IntakeExecutionGuard = (client: PoolClient, signal?: AbortSignal) => Promise<void>;
export interface SafetyProcessReceipt { submissionId: string; status: 'detected'; advanced: boolean; replayed: boolean; }
const MAX_REVISION = 2147483647;
function options(value: { detectorRevision: number; leaseMs?: number }) {
  const detectorRevision = value.detectorRevision, leaseMs = value.leaseMs ?? 5000;
  if (!Number.isSafeInteger(detectorRevision) || detectorRevision < 1 || detectorRevision > MAX_REVISION
    || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 60000) throw new ApiError(400, 'INVALID_INPUT', 'Use a bounded detection lease and revision.');
  return Object.freeze({ detectorRevision, leaseMs });
}
function captured(value: unknown): Readonly<OnboardingSafetyClaim> {
  try { return parseOnboardingSafetyClaim(value); } catch { throw safetyClaimChanged(); }
}

/** Durable inbox/claim/result path. This does not provide a detector, reviewed templates, crisis delivery or student release. */
export class OnboardingSafety {
  constructor(readonly db: Database, private readonly storage: OnboardingStorage) {}
  async read(context: FixedSessionContext, signal?: AbortSignal) {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash });
    return this.db.withBoundedTransaction(async client => {
      await this.storage.authorizeSession(client, fixed, signal);
      const row = await this.storage.row(client, fixed.userId);
      const draft = row ? this.storage.decode(row) : null;
      const rows = draft ? await this.storage.recover(client, draft) : [];
      const handled = draft ? await this.storage.handledSources(client, draft, rows) : new Set<string>();
      await authorizeFixedSession(client, fixed, signal); return this.storage.safetyState(rows, handled);
    });
  }
  async claim(context: FixedSessionContext, value: { detectorRevision: number; leaseMs?: number }, signal?: AbortSignal): Promise<Readonly<OnboardingSafetyClaim> | null> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), opt = options(value);
    return this.db.withBoundedTransaction(async client => {
      const version = await this.storage.authorizeSession(client, fixed, signal);
      const draft = await this.storage.row(client, fixed.userId);
      if (!draft) { await authorizeFixedSession(client, fixed, signal); return null; }
      await this.storage.recover(client, this.storage.decode(draft));
      const found = await client.query<SafetySubmissionRow>(`SELECT * FROM platform_onboarding_safety_submissions
        WHERE user_id=$1 AND (status='pending' OR status='running' AND lease_until<=clock_timestamp())
        ORDER BY submitted_revision,id LIMIT 1 FOR UPDATE`, [fixed.userId]);
      const row = found.rows[0];
      if (!row) { await authorizeFixedSession(client, fixed, signal); return null; }
      if (row.generation === MAX_REVISION) throw intakeUnavailable();
      await authorizeFixedSession(client, fixed, signal);
      const updated = await client.query<SafetySubmissionRow>(`UPDATE platform_onboarding_safety_submissions
        SET status='running',generation=generation+1,auth_version=$2,lease_token=$3,execution_token=NULL,
          lease_until=clock_timestamp()+($4::int*interval '1 millisecond'),detector_revision=$5,failure=NULL,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [row.id, version, randomUUID(), opt.leaseMs, opt.detectorRevision]);
      await authorizeFixedSession(client, fixed, signal); return this.storage.claim(updated.rows[0]);
    });
  }
  private async owned(client: PoolClient, claim: Readonly<OnboardingSafetyClaim>, signal?: AbortSignal, allowDetected = false, executionToken?: string) {
    await this.storage.authorizeAccount(client, claim.userId, claim.authVersion, signal);
    const draftRow = await this.storage.row(client, claim.userId);
    if (!draftRow || draftRow.id !== claim.draftId) throw safetyClaimChanged();
    const draft = this.storage.decode(draftRow), rows = await this.storage.recover(client, draft);
    const row = rows.find(item => item.id === claim.submissionId);
    if (!row || row.status !== 'running' && !(allowDetected && row.status === 'detected')
      || executionToken !== undefined && row.execution_token !== executionToken
      || JSON.stringify(this.storage.claim(row)) !== JSON.stringify(claim)) throw safetyClaimChanged();
    const valid = await client.query(`SELECT id FROM platform_onboarding_safety_submissions WHERE id=$1
      AND (status='running' AND lease_until>clock_timestamp() ${allowDetected ? "OR status='detected'" : ''})`, [row.id]);
    signal?.throwIfAborted(); if (!valid.rowCount) throw safetyClaimChanged();
    return { draft, rows, row };
  }
  private admission(claim: Readonly<OnboardingSafetyClaim>, executionToken: string, parent?: AbortSignal, onComplete?: () => void, guard?: IntakeExecutionGuard): ProviderRequestAdmission {
    return async <T>(launch: (signal: AbortSignal) => Promise<T>, requestSignal?: AbortSignal): Promise<T> => {
      const cancelled = new AbortController(), signal = AbortSignal.any([cancelled.signal, ...(parent ? [parent] : []), ...(requestSignal ? [requestSignal] : [])]);
      let pending: Promise<T> | undefined;
      try {
        const started = await this.db.withBoundedTransaction(async client => {
          await this.owned(client, claim, signal, false, executionToken);
          await guard?.(client, signal);
          // Policy lock waits also consume time. Recheck the exact claim before launch.
          await this.owned(client, claim, signal, false, executionToken); signal.throwIfAborted();
          // Launch is accepted under the real claim locks. Wait for classifier/provider I/O after COMMIT.
          pending = Promise.resolve(launch(signal)); pending.catch(() => {}); return { pending };
        });
        const result = await started.pending; signal.throwIfAborted(); onComplete?.(); return result;
      } catch (error) {
        cancelled.abort();
        void pending?.then(value => { if (value instanceof Response && !value.body?.locked) return value.body?.cancel().catch(() => {}); }, () => {}).catch(() => {});
        throw error;
      }
    };
  }
  private async advance(client: PoolClient, draft: OnboardingDraft, rows: SafetySubmissionRow[]): Promise<boolean> {
    const handled = await this.storage.handledSources(client, draft, rows);
    const safety = this.storage.safetyState(rows, handled);
    if (draft.state === 'safety_paused' && draft.safety && safety.status === 'clear') {
      const paused = rows.find(row => row.operation_id === draft.safety!.textId);
      // A previous explicit continuation may have waited for another source to finish.
      // Consume that authenticated request, never infer permission from classification alone.
      if (!paused || !handled.has(paused.id)) return false;
      const next = resumeOnboardingDraft(draft, { expectedRevision: draft.revision, at: await this.storage.at(client) });
      await this.storage.write(client, draft, next); return true;
    }
    if (draft.state !== 'safety_pending' || !draft.pendingText) return false;
    const row = rows.find(item => item.operation_id === draft.pendingText!.id);
    if (!row || row.status !== 'detected') return false;
    const result = this.storage.decodeResult(row);
    // A previous high-risk result remains a separate barrier. Never attribute it to the new message.
    if (result.level === 'L0' && safety.status !== 'clear') return false;
    const next = resolveOnboardingText(draft, result, { at: await this.storage.at(client) });
    await this.storage.write(client, draft, next); return true;
  }
  async process(value: OnboardingSafetyClaim, classify: IntakeClassifier, signal?: AbortSignal, guard?: IntakeExecutionGuard): Promise<SafetyProcessReceipt> {
    const claim = captured(value);
    const input = await this.db.withBoundedTransaction(async client => {
      const owned = await this.owned(client, claim, signal, true);
      await guard?.(client, signal);
      if (owned.row.status === 'detected') return { replay: true as const };
      if (owned.row.execution_token !== null) throw safetyClaimChanged();
      const operation = (await client.query<IntakeOperationRow>(`SELECT operation_id,draft_id,applied_revision,request_ciphertext
        FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2`, [claim.userId, claim.operationId])).rows[0];
      if (!operation) throw intakeUnavailable();
      const command = this.storage.decodeOperation(operation, claim.userId);
      if (command.action.kind !== 'text' || command.action.questionId !== claim.questionId) throw intakeUnavailable();
      const executionToken = randomUUID();
      const started = await client.query(`UPDATE platform_onboarding_safety_submissions SET execution_token=$2,updated_at=clock_timestamp()
        WHERE id=$1 AND status='running' AND execution_token IS NULL AND lease_until>clock_timestamp() RETURNING id`, [claim.submissionId, executionToken]);
      signal?.throwIfAborted(); if (!started.rowCount) throw safetyClaimChanged();
      return { replay: false as const, text: command.action.text, executionToken };
    });
    if (input.replay) return { submissionId: claim.submissionId, status: 'detected', advanced: false, replayed: true };
    // The internal classifier must use this admission at each actual provider request; merely returning a guessed decision is insufficient.
    let admitted = false;
    const deadline = AbortSignal.timeout(1000), requestSignal = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    const pending = this.admission(claim, input.executionToken, requestSignal, undefined, guard)(async guardedSignal => {
      // Outer transaction failure cancels the actual request admission as well, not just this wait.
      const admission = this.admission(claim, input.executionToken, guardedSignal, () => { admitted = true; }, guard);
      return classify(Object.freeze({ text: input.text, questionId: claim.questionId }), admission);
    });
    pending.catch(() => {});
    let decision: unknown;
    let onAbort: () => void = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(requestSignal.reason);
        requestSignal.addEventListener('abort', onAbort, { once: true });
        if (requestSignal.aborted) onAbort();
      });
      decision = await Promise.race([pending, aborted]);
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) {
        // A failed provider never fabricates a safety level. Only a still-current real claim may be released for recovery.
        await this.fail(claim, 'timeout').catch(() => {});
        throw new ApiError(503, 'ONBOARDING_SAFETY_UNAVAILABLE', 'Intake detection did not finish within its deadline.');
      }
      throw error;
    } finally { requestSignal.removeEventListener('abort', onAbort); }
    if (!admitted) throw new ApiError(400, 'INVALID_SAFETY_RESULT', 'A detection result requires a current admitted request.');
    let result;
    try { result = parseOnboardingSafetyDecision(decision, claim); }
    catch { throw new ApiError(400, 'INVALID_SAFETY_RESULT', 'Use a valid bound intake detection result.'); }
    return this.db.withBoundedTransaction(async client => {
      const owned = await this.owned(client, claim, signal, true, input.executionToken);
      await guard?.(client, signal);
      if (owned.row.status === 'detected') {
        if (JSON.stringify(this.storage.decodeResult(owned.row)) !== JSON.stringify(result)) throw new ApiError(409, 'ONBOARDING_SAFETY_RESULT_CONFLICT', 'The detection result was already saved.');
        return { submissionId: claim.submissionId, status: 'detected', advanced: false, replayed: true };
      }
      const ciphertext = this.storage.crypto!.sealUtf8(JSON.stringify(result), {
        table: 'platform_onboarding_safety_submissions', column: 'result_ciphertext', rowId: claim.submissionId, ownerId: claim.userId, revision: claim.generation,
      });
      const saved = await client.query<SafetySubmissionRow>(`UPDATE platform_onboarding_safety_submissions
        SET status='detected',result_ciphertext=$2,level=$3,detector_mode=$4,failure=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND status='running' AND generation=$5 AND lease_token=$6 AND lease_until>clock_timestamp() RETURNING *`,
      [claim.submissionId, ciphertext, result.level, result.mode, claim.generation, claim.leaseToken]);
      if (!saved.rowCount) throw safetyClaimChanged();
      await enqueueSafetyResponse(client, saved.rows[0], this.storage.decodeResult(saved.rows[0]));
      const rows = owned.rows.map(row => row.id === claim.submissionId ? saved.rows[0] : row);
      const advanced = await this.advance(client, owned.draft, rows);
      // Writes linearize at this final lease-time check; later expiry does not undo an accepted COMMIT.
      const stillValid = await client.query('SELECT id FROM platform_onboarding_safety_submissions WHERE id=$1 AND lease_until>clock_timestamp()', [claim.submissionId]);
      signal?.throwIfAborted(); if (!stillValid.rowCount) throw safetyClaimChanged();
      return { submissionId: claim.submissionId, status: 'detected', advanced, replayed: false };
    });
  }
  async fail(value: OnboardingSafetyClaim, failure: SafetyFailure, signal?: AbortSignal): Promise<void> {
    const claim = captured(value);
    if (!['unavailable', 'timeout', 'invalid_result'].includes(failure)) throw new ApiError(400, 'INVALID_INPUT', 'Use a bounded detection failure.');
    await this.db.withBoundedTransaction(async client => {
      await this.owned(client, claim, signal);
      const saved = await client.query(`UPDATE platform_onboarding_safety_submissions SET status='pending',lease_token=NULL,lease_until=NULL,execution_token=NULL,
        failure=$2,updated_at=clock_timestamp() WHERE id=$1 AND generation=$3 AND lease_token=$4 AND lease_until>clock_timestamp() RETURNING id`,
      [claim.submissionId, failure, claim.generation, claim.leaseToken]);
      signal?.throwIfAborted(); if (!saved.rowCount) throw safetyClaimChanged();
    });
  }
}
