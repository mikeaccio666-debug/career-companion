import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { companionSealCandidates, validateCompanionName, CompanionNameError, CompanionIdentityError } from '@companion/career-core';
import type { CompanionNameCategory, CompanionSealCandidates, CompanionInkToken } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { BackgroundGeneration, VerifiedCompanionPreviewEnvelope } from './background-generation.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import type { LegalBundle } from './legal-documents.ts';
import { ApiError } from './errors.ts';
import { DataCryptoError } from './data-crypto.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { parseCompanionIdentityBundle, readCompanionIdentityBundle, type CompanionIdentityBundle } from './companion-identity-bundle.ts';
import { assertActiveCompanionIdentityBundle, parseCompanionIdentityReview, readCompanionIdentityReview, type CompanionIdentityReview } from './companion-identity-review.ts';

interface Command { readonly taskId: string; readonly expectedRevision: number; readonly operationId: string; readonly name: string; }
interface DraftRow {
  id: string; user_id: string; companion_id: string; task_id: string; preview_revision: number; revision: number;
  bundle_revision: number; content_digest: string; review_digest: string; payload_ciphertext: Buffer;
}
interface OperationRow { operation_id: string; draft_id: string; applied_revision: number; request_ciphertext: Buffer; }
export interface CompanionIdentityDraft {
  readonly companionId: string; readonly taskId: string; readonly previewRevision: 1; readonly revision: number;
  readonly name: string; readonly nameOrigin: 'user_typed'; readonly sealCandidates: CompanionSealCandidates; readonly inkToken: CompanionInkToken;
}
export interface CompanionIdentitySaveResult {
  readonly draft: Readonly<CompanionIdentityDraft>;
  readonly operation: Readonly<{ id: string; appliedRevision: number; replayed: boolean }>;
}
export class CompanionIdentityNameRejected extends ApiError {
  constructor(readonly category: CompanionNameCategory) { super(422, 'NAME_REJECTED', 'Choose another companion name.'); }
}
const unavailable = () => new ApiError(503, 'COMPANION_IDENTITY_UNAVAILABLE', 'The companion name and seal candidates could not be confirmed.');
const changed = () => new ApiError(409, 'COMPANION_IDENTITY_REVISION_CHANGED', 'Read the current name before making another change.');
const invalid = () => new ApiError(400, 'INVALID_INPUT', 'Use a valid companion naming operation.');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value)?.[0] === value;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(entry => !('value' in entry) || !entry.enumerable)) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function command(value: unknown): Readonly<Command> {
  const data = record(value, ['taskId', 'expectedRevision', 'operationId', 'name']);
  if (!uuid(data.taskId) || !uuid(data.operationId) || !Number.isSafeInteger(data.expectedRevision) || Object.is(data.expectedRevision, -0)
    || (data.expectedRevision as number) < 0 || (data.expectedRevision as number) > 2147483646) throw invalid();
  if (typeof data.name !== 'string' || data.name.length > 128
    || /[<>\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(data.name)) throw new CompanionIdentityNameRejected('length');
  // Preserve NFC spelling/case in the idempotency payload. A comparison key is
  // not permission to silently change the displayed name on an old operation.
  return Object.freeze({ taskId: data.taskId, expectedRevision: data.expectedRevision as number,
    operationId: data.operationId, name: data.name.trim().normalize('NFC') });
}
function taskInput(value: unknown): string {
  const data = record(value, ['taskId']); if (!uuid(data.taskId)) throw invalid(); return data.taskId;
}

/** Internal preparation. Every read/write verifies the actual completed preview
 * in the SAME bounded transaction. A saved candidate is neither a selected seal
 * nor birth, reroll, model, room, memory or external execution permission.
 */
export class CompanionIdentityDrafts {
  private readonly storage: OnboardingStorage;
  private readonly bundle: Readonly<CompanionIdentityBundle> | null;
  private readonly review: Readonly<CompanionIdentityReview> | null;
  constructor(readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, legal: LegalBundle | null,
    private readonly background: BackgroundGeneration, bundle: CompanionIdentityBundle | null, review: CompanionIdentityReview | null) {
    this.storage = new OnboardingStorage(config, legal);
    try { this.bundle = bundle === null ? null : parseCompanionIdentityBundle(bundle); this.review = review === null ? null : parseCompanionIdentityReview(review); }
    catch { throw unavailable(); }
  }
  /** Server composition only. Missing/invalid current files disable NEW writes;
   * existing encrypted drafts can still recover their saved resource snapshots.
   * Loading files creates no authority row or student HTTP access.
   */
  static async fromConfiguration(db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail' | 'companionIdentityBundlePath' | 'companionIdentityReviewPath'>,
    legal: LegalBundle | null, background: BackgroundGeneration): Promise<CompanionIdentityDrafts> {
    const captured = Object.freeze({ dataCrypto: config.dataCrypto, requireVerifiedEmail: config.requireVerifiedEmail,
      companionIdentityBundlePath: config.companionIdentityBundlePath, companionIdentityReviewPath: config.companionIdentityReviewPath });
    const [bundle, review] = await Promise.allSettled([readCompanionIdentityBundle(captured.companionIdentityBundlePath),
      readCompanionIdentityReview(captured.companionIdentityReviewPath)]);
    return new CompanionIdentityDrafts(db, captured, legal, background,
      bundle.status === 'fulfilled' && review.status === 'fulfilled' ? bundle.value : null,
      bundle.status === 'fulfilled' && review.status === 'fulfilled' ? review.value : null);
  }
  private async source(client: PoolClient, fixed: FixedSessionContext, taskId: string, signal?: AbortSignal) {
    // No caller-supplied preview/dimensions/auth claim crosses this boundary.
    await this.storage.authorizeSession(client, fixed, signal);
    const verified = await this.background.readInTransaction(client, fixed, { taskId }, signal);
    if (!verified) throw new ApiError(409, 'COMPANION_PREVIEW_REQUIRED', 'Wait for the completed companion preview before naming it.');
    return verified;
  }
  private async row(client: PoolClient, fixed: FixedSessionContext, companionId: string): Promise<DraftRow | undefined> {
    return (await client.query<DraftRow>('SELECT * FROM platform_companion_identity_drafts WHERE companion_id=$1 AND user_id=$2 FOR UPDATE',
      [companionId, fixed.userId])).rows[0];
  }
  private async assets(client: PoolClient, row: Pick<DraftRow, 'bundle_revision' | 'content_digest' | 'review_digest'>) {
    const saved = (await client.query<{ revision: number; bundle_json: string; review_json: string }>(
      'SELECT revision,bundle_json,review_json FROM platform_companion_identity_assets WHERE content_digest=$1 AND review_digest=$2 FOR SHARE',
      [row.content_digest, row.review_digest])).rows[0];
    try {
      if (!saved) throw unavailable();
      const bundle = parseCompanionIdentityBundle(JSON.parse(saved.bundle_json)), review = parseCompanionIdentityReview(JSON.parse(saved.review_json));
      if (saved.revision !== row.bundle_revision || bundle.revision !== row.bundle_revision || review.bundleRevision !== bundle.revision
        || bundle.contentDigest !== row.content_digest || review.bundleDigest !== bundle.contentDigest || review.reviewDigest !== row.review_digest
        || JSON.stringify(bundle) !== saved.bundle_json || JSON.stringify(review) !== saved.review_json) throw unavailable();
      return { bundle, review };
    } catch { throw unavailable(); }
  }
  private payload(row: DraftRow, verified: VerifiedCompanionPreviewEnvelope, userName: string, name: string, candidates: CompanionSealCandidates) {
    return { schemaVersion: 1, id: row.id, userId: row.user_id, companionId: row.companion_id, taskId: row.task_id,
      previewRevision: 1, revision: row.revision, source: verified.source, bundleRevision: row.bundle_revision,
      contentDigest: row.content_digest, reviewDigest: row.review_digest, userNameAtSave: userName,
      name, nameOrigin: 'user_typed', sealCandidates: candidates, inkToken: verified.preview.inkToken };
  }
  private view(row: DraftRow, name: string, candidates: CompanionSealCandidates, verified: VerifiedCompanionPreviewEnvelope): Readonly<CompanionIdentityDraft> {
    return Object.freeze({ companionId: row.companion_id, taskId: row.task_id, previewRevision: 1, revision: row.revision,
      name, nameOrigin: 'user_typed', sealCandidates: candidates, inkToken: verified.preview.inkToken });
  }
  private async decode(client: PoolClient, row: DraftRow, fixed: FixedSessionContext, verified: VerifiedCompanionPreviewEnvelope) {
    try {
      if (row.user_id !== fixed.userId || row.companion_id !== verified.source.companionId || row.task_id !== verified.source.taskId
        || row.preview_revision !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1) throw unavailable();
      const assets = await this.assets(client, row);
      const text = this.storage.crypto!.openUtf8(row.payload_ciphertext, { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext',
        rowId: row.id, ownerId: fixed.userId, revision: row.revision });
      const data = JSON.parse(text);
      const name = validateCompanionName({ name: data?.name, userName: data?.userNameAtSave, policy: assets.bundle.policy });
      const candidates = companionSealCandidates({ companionId: row.companion_id, name, dimensions: verified.dimensions, policy: assets.bundle.policy });
      if (text !== JSON.stringify(this.payload(row, verified, data.userNameAtSave, name, candidates))) throw unavailable();
      return this.view(row, name, candidates, verified);
    } catch { throw unavailable(); }
  }
  async read(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionIdentityDraft> | null> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), taskId = taskInput(value);
    return this.db.withBoundedTransaction(async client => {
      const verified = await this.source(client, fixed, taskId, signal), row = await this.row(client, fixed, verified.source.companionId);
      const result = row ? await this.decode(client, row, fixed, verified) : null;
      await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return result;
    });
  }
  async save(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionIdentitySaveResult>> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), input = command(value), canonical = JSON.stringify(input);
    try {
      return await this.db.withBoundedTransaction(async client => {
        const verified = await this.source(client, fixed, input.taskId, signal), previous = await this.row(client, fixed, verified.source.companionId);
        const current = previous ? await this.decode(client, previous, fixed, verified) : null;
        const operation = (await client.query<OperationRow>('SELECT operation_id,draft_id,applied_revision,request_ciphertext '
          + 'FROM platform_companion_identity_operations WHERE user_id=$1 AND operation_id=$2 FOR UPDATE', [fixed.userId, input.operationId])).rows[0];
        if (operation) {
          if (!previous || operation.draft_id !== previous.id || operation.applied_revision > previous.revision) throw unavailable();
          let text: string, old: Readonly<Command>;
          try {
            text = this.storage.crypto!.openUtf8(operation.request_ciphertext, { table: 'platform_companion_identity_operations', column: 'request_ciphertext',
              rowId: operation.operation_id, ownerId: fixed.userId, revision: operation.applied_revision });
            old = command(JSON.parse(text));
            if (JSON.stringify(old) !== text || old.operationId !== operation.operation_id || old.taskId !== input.taskId
              || old.expectedRevision + 1 !== operation.applied_revision) throw unavailable();
          } catch { throw unavailable(); }
          if (text !== canonical) throw new ApiError(409, 'COMPANION_IDENTITY_OPERATION_CONFLICT', 'Use a new operation identifier for a different name.');
          await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
          return Object.freeze({ draft: current!, operation: Object.freeze({ id: input.operationId, appliedRevision: operation.applied_revision, replayed: true }) });
        }
        if (input.expectedRevision !== (previous?.revision ?? 0)) throw changed();
        const bundle = await assertActiveCompanionIdentityBundle(client, this.bundle, this.review, signal);
        const userName = (await client.query<{ name: string }>('SELECT name FROM platform_users WHERE id=$1 FOR SHARE', [fixed.userId])).rows[0]?.name;
        let name: string, candidates: CompanionSealCandidates;
        try {
          name = validateCompanionName({ name: input.name, userName: userName!, policy: bundle.policy });
          candidates = companionSealCandidates({ companionId: verified.source.companionId, name, dimensions: verified.dimensions, policy: bundle.policy });
        } catch (error) {
          if (error instanceof CompanionNameError) throw new CompanionIdentityNameRejected(error.category);
          if (error instanceof CompanionIdentityError && error.code === 'SEAL_CANDIDATES_UNAVAILABLE') throw new ApiError(503, error.code, 'The seal candidates are not available for this name.');
          throw unavailable();
        }
        await authorizeFixedSession(client, fixed, signal);
        await client.query('INSERT INTO platform_companion_identity_assets(content_digest,review_digest,revision,bundle_json,review_json) '
          + 'VALUES($1,$2,$3,$4,$5) ON CONFLICT(content_digest,review_digest) DO NOTHING',
          [bundle.contentDigest, this.review!.reviewDigest, bundle.revision, JSON.stringify(bundle), JSON.stringify(this.review)]);
        const row: DraftRow = { id: previous?.id ?? randomUUID(), user_id: fixed.userId, companion_id: verified.source.companionId,
          task_id: input.taskId, preview_revision: 1, revision: input.expectedRevision + 1, bundle_revision: bundle.revision,
          content_digest: bundle.contentDigest, review_digest: this.review!.reviewDigest, payload_ciphertext: Buffer.alloc(0) };
        // An existing snapshot under the same hashes must also contain the exact
        // canonical assets. Never overwrite corrupted evidence with live config.
        const captured = await this.assets(client, row);
        if (JSON.stringify(captured.bundle) !== JSON.stringify(bundle) || JSON.stringify(captured.review) !== JSON.stringify(this.review)) throw unavailable();
        row.payload_ciphertext = this.storage.crypto!.sealUtf8(JSON.stringify(this.payload(row, verified, userName!, name, candidates)),
          { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext', rowId: row.id, ownerId: fixed.userId, revision: row.revision });
        if (previous) {
          const saved = await client.query('UPDATE platform_companion_identity_drafts SET revision=$3,bundle_revision=$4,content_digest=$5,review_digest=$6,'
            + 'payload_ciphertext=$7,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND revision=$8 RETURNING id',
            [row.id, fixed.userId, row.revision, row.bundle_revision, row.content_digest, row.review_digest, row.payload_ciphertext, previous.revision]);
          if (!saved.rowCount) throw changed();
        } else {
          await client.query('INSERT INTO platform_companion_identity_drafts(id,user_id,companion_id,task_id,preview_revision,revision,bundle_revision,'
            + 'content_digest,review_digest,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [row.id, fixed.userId, row.companion_id, row.task_id, 1, row.revision, row.bundle_revision, row.content_digest, row.review_digest, row.payload_ciphertext]);
        }
        const request = this.storage.crypto!.sealUtf8(canonical, { table: 'platform_companion_identity_operations', column: 'request_ciphertext',
          rowId: input.operationId, ownerId: fixed.userId, revision: row.revision });
        await client.query('INSERT INTO platform_companion_identity_operations(user_id,operation_id,draft_id,applied_revision,request_ciphertext) '
          + 'VALUES($1,$2,$3,$4,$5)', [fixed.userId, input.operationId, row.id, row.revision, request]);
        await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
        return Object.freeze({ draft: this.view(row, name, candidates, verified),
          operation: Object.freeze({ id: input.operationId, appliedRevision: row.revision, replayed: false }) });
      });
    } catch (error) { if (error instanceof DataCryptoError) throw unavailable(); throw error; }
  }
}
