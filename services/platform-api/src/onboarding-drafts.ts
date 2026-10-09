import { CareerProfiles } from './career-profiles.ts';
import { randomUUID } from 'node:crypto';
import type { OnboardingCommand, OnboardingDraft, OnboardingSaveResult } from '@companion/platform-contracts';
import { createOnboardingDraft, parseOnboardingCommand, transitionOnboardingDraft } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import { DataCryptoError, type DataCrypto } from './data-crypto.ts';
import { ApiError } from './errors.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { OnboardingSafety, type IntakeClassifier, type IntakeExecutionGuard, type SafetyFailure } from './onboarding-safety.ts';
import type { OnboardingSafetyClaim } from './onboarding-safety-protocol.ts';
import { syncPrebirthInventoryInTransaction, verifyPrebirthInventoryInTransaction } from './companion-prebirth-protocol.ts';

interface OperationRow {
  operation_id: string; draft_id: string; applied_revision: number; request_ciphertext: Buffer;
}
const unavailable = () => new ApiError(503, 'DATA_STORAGE_UNAVAILABLE', 'Private intake data could not be saved or read.');
const changed = () => new ApiError(409, 'ONBOARDING_REVISION_CHANGED', 'Read the current intake progress before making another change.');

/** Unreleased preparation service. It grants no room, companion, memory, tool or first-letter completion. */
export class OnboardingDrafts {
  private readonly crypto: DataCrypto | undefined;
  private readonly storage: OnboardingStorage;
  private readonly safety: OnboardingSafety;
  private readonly profiles: CareerProfiles;
  constructor(readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, readonly bundle: LegalBundle | null) {
    this.crypto = config.dataCrypto;
    this.storage = new OnboardingStorage(config, bundle);
    this.profiles = new CareerProfiles(db, config, bundle);
    this.safety = new OnboardingSafety(db, this.storage, this.profiles);
  }
  claimSafety(context: FixedSessionContext, options: { detectorRevision: number; leaseMs?: number }, signal?: AbortSignal) {
    return this.safety.claim(context, options, signal);
  }
  processSafety(claim: OnboardingSafetyClaim, classify: IntakeClassifier, signal?: AbortSignal, guard?: IntakeExecutionGuard) {
    return this.safety.process(claim, classify, signal, guard);
  }
  failSafety(claim: OnboardingSafetyClaim, failure: SafetyFailure, signal?: AbortSignal) {
    return this.safety.fail(claim, failure, signal);
  }
  readSafety(context: FixedSessionContext, signal?: AbortSignal) {
    return this.safety.read(context, signal);
  }
  private fixed(context: FixedSessionContext): FixedSessionContext {
    return Object.freeze({ userId: context.userId, tokenHash: context.tokenHash });
  }
  async read(context: FixedSessionContext, signal?: AbortSignal): Promise<OnboardingDraft | null> {
    const fixed = this.fixed(context);
    return this.db.withBoundedTransaction(async client => {
      await this.storage.authorizeSession(client, fixed, signal);
      const row = await this.storage.row(client, fixed.userId);
      const draft = row ? this.storage.decode(row) : null;
      if (draft) await this.storage.recover(client, draft);
      await authorizeFixedSession(client, fixed, signal);
      return draft;
    });
  }
  async save(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<OnboardingSaveResult> {
    const fixed = this.fixed(context);
    let command: OnboardingCommand;
    try { command = parseOnboardingCommand(value); }
    catch { throw new ApiError(400, 'INVALID_INPUT', 'Use a valid intake operation.'); }
    // Snapshot only the closed, normalized command. Later mutation of the caller's input cannot change this save.
    const canonical = JSON.stringify(command);
    command = JSON.parse(canonical) as OnboardingCommand;
    try {
      return await this.db.withBoundedTransaction(async client => {
        const authVersion = await this.storage.authorizeSession(client, fixed, signal);
        await verifyPrebirthInventoryInTransaction(client, this.crypto, fixed.userId, signal);
        const row = await this.storage.row(client, fixed.userId);
        const previous = row ? this.storage.decode(row) : null;
        const submissions = previous ? await this.storage.recover(client, previous) : [];
        const followupCollision = await client.query(`SELECT operation_id FROM platform_onboarding_safety_followups
          WHERE user_id=$1 AND operation_id=$2 FOR UPDATE`, [fixed.userId, command.operationId]);
        if (followupCollision.rowCount) throw new ApiError(409, 'ONBOARDING_OPERATION_CONFLICT', 'Use a new operation identifier for a different intake change.');
        const found = await client.query<OperationRow>(`SELECT operation_id,draft_id,applied_revision,request_ciphertext
          FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2 FOR UPDATE`, [fixed.userId, command.operationId]);
        const operation = found.rows[0];
        if (operation) {
          if (!previous || operation.draft_id !== previous.id || operation.applied_revision > previous.revision) throw unavailable();
          let old: OnboardingCommand;
          try {
            old = parseOnboardingCommand(JSON.parse(this.crypto!.openUtf8(operation.request_ciphertext, {
              table: 'platform_onboarding_operations', column: 'request_ciphertext', rowId: operation.operation_id,
              ownerId: fixed.userId, revision: operation.applied_revision,
            })));
          } catch { throw unavailable(); }
          if (old.operationId !== operation.operation_id || old.expectedRevision + 1 !== operation.applied_revision) throw unavailable();
          if (JSON.stringify(old) !== canonical) throw new ApiError(409, 'ONBOARDING_OPERATION_CONFLICT', 'Use a new operation identifier for a different intake change.');
          await authorizeFixedSession(client, fixed, signal);
          return { draft: previous, operation: { id: operation.operation_id, appliedRevision: operation.applied_revision, replayed: true } };
        }
        const handled = previous ? await this.storage.handledSources(client, previous, submissions) : new Set<string>();
        if (this.storage.safetyState(submissions, handled).status === 'blocked') throw new ApiError(409, 'ONBOARDING_SAFETY_REVIEW_REQUIRED', 'The intake safety response must be handled before continuing.');
        if (command.expectedRevision !== (previous?.revision ?? 0)) throw changed();
        const at = await this.storage.at(client);
        const initial = previous ?? createOnboardingDraft({ id: randomUUID(), userId: fixed.userId, at });
        let draft: OnboardingDraft;
        try { draft = transitionOnboardingDraft(initial, command, { at, textId: command.operationId }); }
        catch { throw new ApiError(409, 'ONBOARDING_STATE_CHANGED', 'Read the current intake question before continuing.'); }
        // Legal/draft waits may consume the remaining session time. Recheck before any write.
        await authorizeFixedSession(client, fixed, signal);
        const ciphertext = this.crypto!.sealUtf8(JSON.stringify(draft), {
          table: 'platform_onboarding_drafts', column: 'payload_ciphertext', rowId: draft.id,
          ownerId: fixed.userId, revision: draft.revision,
        });
        if (previous) {
          const saved = await client.query(`UPDATE platform_onboarding_drafts SET revision=$3,payload_ciphertext=$4,updated_at=$5
            WHERE id=$1 AND user_id=$2 AND revision=$6 RETURNING id`, [previous.id, fixed.userId, draft.revision, ciphertext, at, previous.revision]);
          if (!saved.rowCount) throw changed();
        } else {
          await client.query(`INSERT INTO platform_onboarding_drafts(id,user_id,revision,payload_ciphertext,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$5)`, [draft.id, fixed.userId, draft.revision, ciphertext, at]);
        }
        const requestCiphertext = this.crypto!.sealUtf8(canonical, {
          table: 'platform_onboarding_operations', column: 'request_ciphertext', rowId: command.operationId,
          ownerId: fixed.userId, revision: draft.revision,
        });
        await client.query(`INSERT INTO platform_onboarding_operations(user_id,operation_id,draft_id,applied_revision,request_ciphertext)
          VALUES($1,$2,$3,$4,$5)`, [fixed.userId, command.operationId, draft.id, draft.revision, requestCiphertext]);
        if (command.action.kind === 'text') await this.storage.recover(client, draft);
        await syncPrebirthInventoryInTransaction(client, this.crypto, fixed.userId, signal);
        await this.profiles.projectIntakeInTransaction(client, initial, draft, authVersion, signal);
        // Admission is checked after the writes. The transaction helper confirms COMMIT
        // before returning; expiry/cancellation after this check does not undo an accepted write.
        await authorizeFixedSession(client, fixed, signal);
        signal?.throwIfAborted();
        return { draft, operation: { id: command.operationId, appliedRevision: draft.revision, replayed: false } };
      });
    } catch (error) {
      if (error instanceof DataCryptoError) throw unavailable();
      throw error;
    }
  }
}
