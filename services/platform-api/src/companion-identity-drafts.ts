import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { companionSealCandidates, companionSealCandidatesV2, validateCompanionName, validateCompanionNameV2, CompanionNameError, CompanionIdentityError } from '@companion/career-core';
import type { CompanionNameCategory, CompanionSealCandidates } from '@companion/career-core';
import type { PublicCompanionIdentityDraft, CompanionSealSelection, CompanionSealSelectionRequest, CompanionSealSelectionSaved, CompanionIdentityObservation } from '@companion/platform-contracts';
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
import { verifyPrebirthInventoryInTransaction } from './companion-prebirth-protocol.ts';
import { readNameRawSourceInTransaction, readNameResourceSourceInTransaction } from './companion-name-resource-source.ts';

interface Command { readonly taskId: string; readonly expectedRevision: number; readonly operationId: string; readonly name: string; }
interface DraftRow {
  id: string; user_id: string; companion_id: string; task_id: string; preview_revision: number; revision: number;
  bundle_revision: number; content_digest: string; review_digest: string; payload_ciphertext: Buffer;
}
interface OperationRow { operation_id: string; draft_id: string; applied_revision: number; request_ciphertext: Buffer; }
interface SelectionRow {
  id: string; user_id: string; draft_id: string; companion_id: string; task_id: string; preview_revision: number;
  identity_revision: number; revision: number; bundle_revision: number; content_digest: string; review_digest: string; payload_ciphertext: Buffer;
}
interface SelectionOperationRow {
  user_id: string; operation_id: string; selection_id: string; identity_revision: number; applied_revision: number;
  bundle_revision: number; content_digest: string; review_digest: string; request_ciphertext: Buffer;
}
export interface CompanionIdentityDraft extends PublicCompanionIdentityDraft {}
export interface CompanionIdentitySaveResult {
  readonly draft: Readonly<CompanionIdentityDraft>;
  readonly operation: Readonly<{ id: string; appliedRevision: number; replayed: boolean }>;
}
export class CompanionIdentityNameRejected extends ApiError {
  constructor(readonly category: CompanionNameCategory) { super(422, 'NAME_REJECTED', 'Choose another companion name.'); }
}
const unavailable = () => new ApiError(503, 'COMPANION_IDENTITY_UNAVAILABLE', 'The companion name and seal candidates could not be confirmed.');
const changed = () => new ApiError(409, 'COMPANION_IDENTITY_REVISION_CHANGED', 'Read the current name before making another change.');
const selectionChanged = () => new ApiError(409, 'COMPANION_SEAL_SELECTION_REVISION_CHANGED', 'Read the current seal selection before choosing again.');
const sealRejected = () => new ApiError(422, 'SEAL_REJECTED', 'Choose a seal from the current candidates.');
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
export function selectionCommand(value: unknown): Readonly<CompanionSealSelectionRequest> {
  const data = record(value, ['taskId', 'expectedIdentityRevision', 'expectedRevision', 'operationId', 'sealChar']);
  if (!uuid(data.taskId) || !uuid(data.operationId)
    || !Number.isSafeInteger(data.expectedIdentityRevision) || Object.is(data.expectedIdentityRevision, -0)
    || (data.expectedIdentityRevision as number) < 1 || (data.expectedIdentityRevision as number) > 2147483647
    || !Number.isSafeInteger(data.expectedRevision) || Object.is(data.expectedRevision, -0)
    || (data.expectedRevision as number) < 0 || (data.expectedRevision as number) > 2147483646) throw invalid();
  if (typeof data.sealChar !== 'string' || !/^\p{Script=Han}$/u.test(data.sealChar)) throw sealRejected();
  return Object.freeze({ taskId: data.taskId, expectedIdentityRevision: data.expectedIdentityRevision as number,
    expectedRevision: data.expectedRevision as number, operationId: data.operationId, sealChar: data.sealChar });
}

/** Internal preparation. Every read/write verifies the actual completed preview
 * in the SAME bounded transaction. Naming and explicit seal selection are private
 * preparation, never birth, reroll, model, room, memory or execution permission.
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
  private async capturedSource(client: PoolClient, fixed: FixedSessionContext, taskId: string, signal?: AbortSignal) {
    await this.storage.authorizeSession(client, fixed, signal);
    const proof = await this.background.readSavedCompletedInTransaction(client, fixed, { taskId }, signal);
    if (!proof) throw unavailable();
    return proof.envelope;
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
        || review.schemaVersion !== bundle.schemaVersion
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
      const text = this.storage.crypto!.openUtf8(row.payload_ciphertext, { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext',
        rowId: row.id, ownerId: fixed.userId, revision: row.revision });
      return (await this.decodeSnapshot(client, row, fixed, verified, text)).draft;
    } catch { throw unavailable(); }
  }
  private async decodeSnapshot(client: PoolClient, row: DraftRow, fixed: FixedSessionContext, verified: VerifiedCompanionPreviewEnvelope, text: string) {
    try {
      if (row.user_id !== fixed.userId || row.companion_id !== verified.source.companionId || row.task_id !== verified.source.taskId
        || row.preview_revision !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1) throw unavailable();
      const assets = await this.assets(client, row);
      const data = JSON.parse(text);
      const name = assets.bundle.schemaVersion === 1
        ? validateCompanionName({ name: data?.name, userName: data?.userNameAtSave, policy: assets.bundle.policy })
        : validateCompanionNameV2({ name: data?.name, userName: data?.userNameAtSave, policy: assets.bundle.policy });
      const candidates = assets.bundle.schemaVersion === 1
        ? companionSealCandidates({ companionId: row.companion_id, name, dimensions: verified.dimensions, policy: assets.bundle.policy })
        : companionSealCandidatesV2({ companionId: row.companion_id, name, dimensions: verified.dimensions, policy: assets.bundle.policy });
      if (text !== JSON.stringify(this.payload(row, verified, data.userNameAtSave, name, candidates))) throw unavailable();
      return { draft: this.view(row, name, candidates, verified), payload: this.payload(row, verified, data.userNameAtSave, name, candidates) };
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
  /** Trusted composition only: use the caller's actual bounded transaction.
   * This verifies the source anew and does not grant authority to later writes. */
  async readInTransaction(client: PoolClient, context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionIdentityDraft> | null> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), taskId = taskInput(value);
    const verified = await this.source(client, fixed, taskId, signal), row = await this.row(client, fixed, verified.source.companionId);
    const result = row ? await this.decode(client, row, fixed, verified) : null;
    await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return result;
  }
  private async viewer(client: PoolClient, fixed: FixedSessionContext, signal?: AbortSignal) {
    await authorizeFixedSession(client, fixed, signal);
    const owner = (await client.query<{ account_kind: string }>('SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [fixed.userId])).rows[0];
    if (!owner || owner.account_kind !== 'student') throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account for the saved companion.');
    if (!this.storage.crypto) throw unavailable();
    await verifyPrebirthInventoryInTransaction(client, this.storage.crypto, fixed.userId, signal);
  }
  /** The current saved identity must be the genuine classified application,
   * not merely a syntactically valid direct internal identity draft. */
  private async savedProvenance(client: PoolClient, fixed: FixedSessionContext, row: DraftRow, signal?: AbortSignal) {
    try {
      const proof = (await client.query('SELECT * FROM platform_companion_name_identity_provenance WHERE user_id=$1 AND draft_id=$2 AND identity_revision=$3 FOR SHARE',
        [fixed.userId, row.id, row.revision])).rows;
      if (proof.length !== 1) throw unavailable();
      const provenance = proof[0], target = await readNameResourceSourceInTransaction(client, this.storage.crypto, provenance.submission_id, signal);
      const source = target.source, raw = await readNameRawSourceInTransaction(client, this.storage.crypto, source.id, signal);
      if (source.user_id !== fixed.userId || source.task_id !== row.task_id || source.companion_id !== row.companion_id
        || source.level !== 'L0' || source.detector_mode !== 'full' || source.application_status !== 'applied' || source.rejected_category !== null
        || source.applied_identity_revision !== row.revision || source.expected_identity_revision + 1 !== row.revision
        || provenance.operation_id !== source.application_operation_id || provenance.generation !== source.generation) throw unavailable();
      const identityText = this.storage.crypto!.openUtf8(row.payload_ciphertext, { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext',
        rowId: row.id, ownerId: fixed.userId, revision: row.revision });
      const resultText = this.storage.crypto!.openUtf8(source.result_ciphertext!, { table: 'platform_companion_name_submissions', column: 'result_ciphertext',
        rowId: source.id, ownerId: fixed.userId, revision: source.generation });
      const application = { schemaVersion: 1, submissionId: source.id, userId: fixed.userId, generation: source.generation,
        sourceCapture: raw.sourceCapture, resultCapture: JSON.parse(resultText), application: { status: 'applied', rejectedCategory: null, appliedIdentityRevision: row.revision },
        identityCapture: JSON.parse(identityText) };
      const applicationText = JSON.stringify(application);
      if (this.storage.crypto!.openUtf8(source.application_ciphertext!, { table: 'platform_companion_name_submissions', column: 'application_ciphertext', rowId: source.id,
        ownerId: fixed.userId, revision: source.generation }) !== applicationText
        || this.storage.crypto!.openUtf8(provenance.payload_ciphertext, { table: 'platform_companion_name_identity_provenance', column: 'payload_ciphertext',
          rowId: row.id, ownerId: fixed.userId, revision: row.revision }) !== applicationText) throw unavailable();
      const receipt = (await client.query('SELECT * FROM platform_companion_name_identity_receipts WHERE user_id=$1 AND operation_id=$2 FOR SHARE',
        [fixed.userId, source.application_operation_id])).rows[0];
      if (!receipt || receipt.draft_id !== row.id || receipt.identity_revision !== row.revision || receipt.submission_id !== source.id
        || receipt.generation !== source.generation || receipt.level !== 'L0' || receipt.detector_mode !== 'full'
        || this.storage.crypto!.openUtf8(receipt.payload_ciphertext, { table: 'platform_companion_name_identity_receipts', column: 'payload_ciphertext',
          rowId: receipt.operation_id, ownerId: fixed.userId, revision: row.revision }) !== JSON.stringify({ schemaVersion: 1, userId: fixed.userId,
          operationId: source.application_operation_id, draftId: row.id, identityRevision: row.revision,
          submissionId: source.id, generation: source.generation, identityCapture: JSON.parse(identityText) })) throw unavailable();
      const operation = (await client.query<OperationRow>('SELECT operation_id,draft_id,applied_revision,request_ciphertext FROM platform_companion_identity_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',
        [fixed.userId, source.application_operation_id])).rows[0];
      if (!operation || operation.draft_id !== row.id || operation.applied_revision !== row.revision) throw unavailable();
      const requestText = this.storage.crypto!.openUtf8(operation.request_ciphertext, { table: 'platform_companion_identity_operations', column: 'request_ciphertext',
        rowId: operation.operation_id, ownerId: fixed.userId, revision: row.revision });
      if (requestText !== JSON.stringify(command({ taskId: row.task_id, expectedRevision: row.revision - 1, operationId: operation.operation_id,
        name: raw.sourceCapture.request.name }))) throw unavailable();
    } catch { signal?.throwIfAborted(); throw unavailable(); }
  }
  /** Independent historical observation: actual viewer + original source,
   * immutable reviewed assets, classified application and selection receipts.
   * It neither consults a later intake nor repairs/saves/applies anything. */
  async readSavedInTransaction(client: PoolClient, context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionIdentityObservation>> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), taskId = taskInput(value);
    await this.viewer(client, fixed, signal);
    const proof = await this.background.readSavedCompletedForViewerInTransaction(client, fixed, { taskId }, signal);
    if (!proof) return Object.freeze({ identity: null, selection: null });
    const verified = proof.envelope, draftRow = await this.row(client, fixed, verified.source.companionId);
    let result: CompanionIdentityObservation = { identity: null, selection: null };
    if (draftRow) {
      const draft = await this.decode(client, draftRow, fixed, verified);
      await this.savedProvenance(client, fixed, draftRow, signal);
      const selection = await this.selectionRow(client, fixed, draftRow.id);
      const sealChar = selection ? await this.decodeSelection(client, selection, draftRow, fixed, verified) : undefined;
      result = { identity: draft, selection: this.selectionView(draft, selection, sealChar) };
    }
    await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return Object.freeze(result);
  }
  async readSaved(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionIdentityObservation>> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), taskId = taskInput(value);
    return this.db.withBoundedTransaction(client => this.readSavedInTransaction(client, fixed, { taskId }, signal));
  }
  /** Server-owned encrypted history composition only. A capture must match the
   * actual immutable naming operation, historical reviewed assets and source;
   * equal current revisions additionally match the actual current ciphertext. */
  async validateCapturedInTransaction(client: PoolClient, context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), input = record(value, ['taskId', 'operationId', 'payload']);
    if (!uuid(input.taskId) || !uuid(input.operationId) || typeof input.payload !== 'string' || Buffer.byteLength(input.payload, 'utf8') > 65536) throw unavailable();
    try {
      const verified = await this.capturedSource(client, fixed, input.taskId, signal), current = await this.row(client, fixed, verified.source.companionId);
      if (!current) throw unavailable();
      await this.decode(client, current, fixed, verified);
      const data = JSON.parse(input.payload);
      if (data?.id !== current.id || !Number.isSafeInteger(data?.revision) || data.revision < 1 || data.revision > current.revision) throw unavailable();
      const row: DraftRow = { ...current, revision: data.revision, bundle_revision: data.bundleRevision,
        content_digest: data.contentDigest, review_digest: data.reviewDigest };
      const snapshot = await this.decodeSnapshot(client, row, fixed, verified, input.payload);
      if (row.revision === current.revision && this.storage.crypto!.openUtf8(current.payload_ciphertext, { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext',
        rowId: current.id, ownerId: fixed.userId, revision: current.revision }) !== input.payload) throw unavailable();
      const operation = (await client.query<OperationRow>('SELECT operation_id,draft_id,applied_revision,request_ciphertext FROM platform_companion_identity_operations '
        + 'WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [fixed.userId, input.operationId])).rows[0];
      if (!operation || operation.draft_id !== row.id || operation.applied_revision !== row.revision) throw unavailable();
      const text = this.storage.crypto!.openUtf8(operation.request_ciphertext, { table: 'platform_companion_identity_operations', column: 'request_ciphertext',
        rowId: operation.operation_id, ownerId: fixed.userId, revision: operation.applied_revision });
      const request = command(JSON.parse(text));
      if (text !== JSON.stringify(request) || text !== JSON.stringify({ taskId: row.task_id, expectedRevision: row.revision - 1,
        operationId: input.operationId, name: snapshot.draft.name })) throw unavailable();
      await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return snapshot.draft;
    } catch { throw unavailable(); }
  }
  private async selectionRow(client: PoolClient, fixed: FixedSessionContext, draftId: string): Promise<SelectionRow | undefined> {
    return (await client.query<SelectionRow>('SELECT * FROM platform_companion_identity_selections WHERE draft_id=$1 AND user_id=$2 FOR UPDATE',
      [draftId, fixed.userId])).rows[0];
  }
  private historicalIdentity(row: SelectionRow): DraftRow {
    return { id: row.draft_id, user_id: row.user_id, companion_id: row.companion_id, task_id: row.task_id,
      preview_revision: row.preview_revision, revision: row.identity_revision, bundle_revision: row.bundle_revision,
      content_digest: row.content_digest, review_digest: row.review_digest, payload_ciphertext: Buffer.alloc(0) };
  }
  private selectionPayload(row: SelectionRow, verified: VerifiedCompanionPreviewEnvelope,
    identitySnapshot: ReturnType<CompanionIdentityDrafts['payload']>, sealChar: string) {
    return { schemaVersion: 1, id: row.id, userId: row.user_id, draftId: row.draft_id, companionId: row.companion_id,
      taskId: row.task_id, previewRevision: 1, identityRevision: row.identity_revision, revision: row.revision,
      source: verified.source, bundleRevision: row.bundle_revision, contentDigest: row.content_digest, reviewDigest: row.review_digest,
      identitySnapshot, sealChar };
  }
  private async decodeSelection(client: PoolClient, row: SelectionRow, draft: DraftRow, fixed: FixedSessionContext,
    verified: VerifiedCompanionPreviewEnvelope): Promise<string> {
    try {
      if (row.user_id !== fixed.userId || row.draft_id !== draft.id || row.companion_id !== draft.companion_id
        || row.task_id !== draft.task_id || row.preview_revision !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1
        || row.revision > 2147483647 || !Number.isSafeInteger(row.identity_revision) || row.identity_revision < 1
        || row.identity_revision > draft.revision) throw unavailable();
      const text = this.storage.crypto!.openUtf8(row.payload_ciphertext, { table: 'platform_companion_identity_selections', column: 'payload_ciphertext',
        rowId: row.id, ownerId: fixed.userId, revision: row.revision });
      const data = JSON.parse(text), historical = await this.decodeSnapshot(client, this.historicalIdentity(row), fixed, verified, JSON.stringify(data?.identitySnapshot));
      if (!historical.draft.sealCandidates.some(candidate => candidate.char === data?.sealChar)
        || text !== JSON.stringify(this.selectionPayload(row, verified, historical.payload, data.sealChar))) throw unavailable();
      const receipt = (await client.query<SelectionOperationRow>('SELECT * FROM platform_companion_identity_selection_operations '
        + 'WHERE selection_id=$1 AND user_id=$2 AND applied_revision=$3 FOR UPDATE', [row.id, fixed.userId, row.revision])).rows[0];
      if (!receipt || receipt.identity_revision !== row.identity_revision || receipt.bundle_revision !== row.bundle_revision
        || receipt.content_digest !== row.content_digest || receipt.review_digest !== row.review_digest) throw unavailable();
      const operation = await this.decodeSelectionOperation(client, receipt, row, draft, fixed, verified);
      if (operation.request.sealChar !== data.sealChar
        || JSON.stringify(operation.identitySnapshot) !== JSON.stringify(historical.payload)) throw unavailable();
      if (row.identity_revision === draft.revision) {
        const currentText = this.storage.crypto!.openUtf8(draft.payload_ciphertext, { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext',
          rowId: draft.id, ownerId: fixed.userId, revision: draft.revision });
        if (currentText !== JSON.stringify(historical.payload)) throw unavailable();
      }
      return data.sealChar as string;
    } catch { throw unavailable(); }
  }
  private selectionView(draft: CompanionIdentityDraft, row?: SelectionRow, sealChar?: string): Readonly<CompanionSealSelection> {
    return Object.freeze({ companionId: draft.companionId, taskId: draft.taskId, previewRevision: 1,
      identityRevision: draft.revision, revision: row?.revision ?? 0,
      selectedSeal: row?.identity_revision === draft.revision ? sealChar! : null });
  }
  /** Observes explicit private selection only. An invalidated choice still has
   * authenticated historical evidence and keeps its independent CAS revision. */
  async readSelection(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionSealSelection> | null> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), taskId = taskInput(value);
    return this.db.withBoundedTransaction(client => this.readSelectionInTransaction(client, fixed, { taskId }, signal));
  }
  async readSelectionInTransaction(client: PoolClient, context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionSealSelection> | null> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), taskId = taskInput(value);
    const verified = await this.source(client, fixed, taskId, signal), draftRow = await this.row(client, fixed, verified.source.companionId);
    let result: Readonly<CompanionSealSelection> | null = null;
    if (draftRow) {
      const draft = await this.decode(client, draftRow, fixed, verified), row = await this.selectionRow(client, fixed, draftRow.id);
      const sealChar = row ? await this.decodeSelection(client, row, draftRow, fixed, verified) : undefined;
      result = this.selectionView(draft, row, sealChar);
    }
    await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return result;
  }
  async readSelectionOperation(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionSealSelectionSaved> | null> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), input = record(value, ['taskId', 'operationId']);
    if (!uuid(input.taskId) || !uuid(input.operationId)) throw invalid();
    const taskId = input.taskId, operationId = input.operationId;
    return this.db.withBoundedTransaction(async client => {
      await this.viewer(client, fixed, signal);
      const own = (await client.query<SelectionOperationRow>('SELECT * FROM platform_companion_identity_selection_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE',
        [fixed.userId, operationId])).rows[0];
      if (!own) { await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return null; }
      const proof = await this.background.readSavedCompletedForViewerInTransaction(client, fixed, { taskId }, signal);
      if (!proof) throw unavailable();
      const verified = proof.envelope, draftRow = await this.row(client, fixed, verified.source.companionId);
      if (!draftRow) throw unavailable();
      const selection = await this.selectionRow(client, fixed, draftRow.id);
      if (!selection || own.selection_id !== selection.id) { await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted(); return null; }
      const draft = await this.decode(client, draftRow, fixed, verified);
      await this.savedProvenance(client, fixed, draftRow, signal);
      const sealChar = await this.decodeSelection(client, selection, draftRow, fixed, verified);
      await this.decodeSelectionOperation(client, own, selection, draftRow, fixed, verified);
      await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
      return Object.freeze({ selection: this.selectionView(draft, selection, sealChar),
        operation: Object.freeze({ id: own.operation_id, appliedRevision: own.applied_revision, replayed: true }) });
    });
  }
  private selectionOperationPayload(row: SelectionOperationRow, verified: VerifiedCompanionPreviewEnvelope,
    identitySnapshot: ReturnType<CompanionIdentityDrafts['payload']>, request: Readonly<CompanionSealSelectionRequest>) {
    return { schemaVersion: 1, userId: row.user_id, operationId: row.operation_id, selectionId: row.selection_id,
      identityRevision: row.identity_revision, appliedRevision: row.applied_revision, source: verified.source,
      bundleRevision: row.bundle_revision, contentDigest: row.content_digest, reviewDigest: row.review_digest, identitySnapshot, request };
  }
  private async decodeSelectionOperation(client: PoolClient, row: SelectionOperationRow, selection: SelectionRow, draft: DraftRow,
    fixed: FixedSessionContext, verified: VerifiedCompanionPreviewEnvelope): Promise<{
      request: Readonly<CompanionSealSelectionRequest>; identitySnapshot: ReturnType<CompanionIdentityDrafts['payload']>;
    }> {
    try {
      if (row.user_id !== fixed.userId || row.selection_id !== selection.id || !Number.isSafeInteger(row.applied_revision)
        || row.applied_revision < 1 || row.applied_revision > selection.revision || !Number.isSafeInteger(row.identity_revision)
        || row.identity_revision < 1 || row.identity_revision > draft.revision || row.identity_revision > selection.identity_revision) throw unavailable();
      const text = this.storage.crypto!.openUtf8(row.request_ciphertext, { table: 'platform_companion_identity_selection_operations', column: 'request_ciphertext',
        rowId: row.operation_id, ownerId: fixed.userId, revision: row.applied_revision });
      const data = JSON.parse(text), request = selectionCommand(data?.request);
      const historical = await this.decodeSnapshot(client, { ...draft, revision: row.identity_revision, bundle_revision: row.bundle_revision,
        content_digest: row.content_digest, review_digest: row.review_digest }, fixed, verified, JSON.stringify(data?.identitySnapshot));
      if (request.operationId !== row.operation_id || request.taskId !== verified.source.taskId
        || request.expectedRevision + 1 !== row.applied_revision || request.expectedIdentityRevision !== row.identity_revision
        || !historical.draft.sealCandidates.some(candidate => candidate.char === request.sealChar)
        || text !== JSON.stringify(this.selectionOperationPayload(row, verified, historical.payload, request))) throw unavailable();
      if (row.identity_revision === draft.revision) {
        const currentText = this.storage.crypto!.openUtf8(draft.payload_ciphertext, { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext',
          rowId: draft.id, ownerId: fixed.userId, revision: draft.revision });
        if (currentText !== JSON.stringify(historical.payload)) throw unavailable();
      }
      return { request, identitySnapshot: historical.payload };
    } catch { throw unavailable(); }
  }
  /** Uses the actual current stored candidates. No fallback pool, caller asset,
   * implicit first choice, generation call or birth side effect is permitted. */
  async saveSelection(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionSealSelectionSaved>> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), input = selectionCommand(value), canonical = JSON.stringify(input);
    return this.db.withBoundedTransaction(client => this.saveSelectionInTransaction(client, fixed, JSON.parse(canonical), signal));
  }
  /** Selection composition shares the actual owner/source/identity transaction. */
  async saveSelectionInTransaction(client: PoolClient, context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionSealSelectionSaved>> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), input = selectionCommand(value), canonical = JSON.stringify(input);
    try {
        const verified = await this.source(client, fixed, input.taskId, signal), draftRow = await this.row(client, fixed, verified.source.companionId);
        if (!draftRow) throw new ApiError(409, 'COMPANION_IDENTITY_REQUIRED', 'Save a companion name before choosing its seal.');
        const draft = await this.decode(client, draftRow, fixed, verified), previous = await this.selectionRow(client, fixed, draftRow.id);
        const previousChar = previous ? await this.decodeSelection(client, previous, draftRow, fixed, verified) : undefined;
        const current = this.selectionView(draft, previous, previousChar);
        const operation = (await client.query<SelectionOperationRow>('SELECT * FROM platform_companion_identity_selection_operations '
          + 'WHERE user_id=$1 AND operation_id=$2 FOR UPDATE', [fixed.userId, input.operationId])).rows[0];
        if (operation) {
          if (!previous) throw unavailable();
          const old = await this.decodeSelectionOperation(client, operation, previous, draftRow, fixed, verified);
          if (JSON.stringify(old.request) !== canonical) throw new ApiError(409, 'COMPANION_SEAL_SELECTION_OPERATION_CONFLICT', 'Use a new operation identifier for a different seal selection.');
          await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
          return Object.freeze({ selection: current, operation: Object.freeze({ id: input.operationId, appliedRevision: operation.applied_revision, replayed: true }) });
        }
        if (input.expectedIdentityRevision !== draft.revision) throw changed();
        if (input.expectedRevision !== current.revision) throw selectionChanged();
        if (!draft.sealCandidates.some(candidate => candidate.char === input.sealChar)) throw sealRejected();
        const bundle = await assertActiveCompanionIdentityBundle(client, this.bundle, this.review, signal);
        if (bundle.revision !== draftRow.bundle_revision || bundle.contentDigest !== draftRow.content_digest
          || this.review!.reviewDigest !== draftRow.review_digest) throw unavailable();
        const userName = (await client.query<{ name: string }>('SELECT name FROM platform_users WHERE id=$1 FOR SHARE', [fixed.userId])).rows[0]?.name;
        try { if (bundle.schemaVersion === 1) validateCompanionName({ name: draft.name, userName: userName!, policy: bundle.policy });
          else validateCompanionNameV2({ name: draft.name, userName: userName!, policy: bundle.policy }); }
        catch (error) {
          if (error instanceof CompanionNameError) throw new CompanionIdentityNameRejected(error.category);
          throw unavailable();
        }
        const snapshotText = this.storage.crypto!.openUtf8(draftRow.payload_ciphertext, { table: 'platform_companion_identity_drafts', column: 'payload_ciphertext',
          rowId: draftRow.id, ownerId: fixed.userId, revision: draftRow.revision });
        const { payload: identitySnapshot } = await this.decodeSnapshot(client, draftRow, fixed, verified, snapshotText);
        const row: SelectionRow = { id: previous?.id ?? randomUUID(), user_id: fixed.userId, draft_id: draftRow.id, companion_id: draft.companionId,
          task_id: input.taskId, preview_revision: 1, identity_revision: draft.revision, revision: input.expectedRevision + 1,
          bundle_revision: draftRow.bundle_revision, content_digest: draftRow.content_digest, review_digest: draftRow.review_digest, payload_ciphertext: Buffer.alloc(0) };
        row.payload_ciphertext = this.storage.crypto!.sealUtf8(JSON.stringify(this.selectionPayload(row, verified, identitySnapshot, input.sealChar)),
          { table: 'platform_companion_identity_selections', column: 'payload_ciphertext', rowId: row.id, ownerId: fixed.userId, revision: row.revision });
        await authorizeFixedSession(client, fixed, signal);
        if (previous) {
          const saved = await client.query('UPDATE platform_companion_identity_selections SET identity_revision=$3,revision=$4,bundle_revision=$5,'
            + 'content_digest=$6,review_digest=$7,payload_ciphertext=$8,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND revision=$9 RETURNING id',
          [row.id, fixed.userId, row.identity_revision, row.revision, row.bundle_revision, row.content_digest, row.review_digest, row.payload_ciphertext, previous.revision]);
          if (!saved.rowCount) throw selectionChanged();
        } else {
          await client.query('INSERT INTO platform_companion_identity_selections(id,user_id,draft_id,companion_id,task_id,preview_revision,identity_revision,revision,'
            + 'bundle_revision,content_digest,review_digest,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
          [row.id, fixed.userId, row.draft_id, row.companion_id, row.task_id, 1, row.identity_revision, row.revision,
            row.bundle_revision, row.content_digest, row.review_digest, row.payload_ciphertext]);
        }
        const receipt: SelectionOperationRow = { user_id: fixed.userId, operation_id: input.operationId, selection_id: row.id,
          identity_revision: row.identity_revision, applied_revision: row.revision, bundle_revision: row.bundle_revision,
          content_digest: row.content_digest, review_digest: row.review_digest, request_ciphertext: Buffer.alloc(0) };
        receipt.request_ciphertext = this.storage.crypto!.sealUtf8(JSON.stringify(this.selectionOperationPayload(receipt, verified, identitySnapshot, input)),
          { table: 'platform_companion_identity_selection_operations', column: 'request_ciphertext', rowId: input.operationId, ownerId: fixed.userId, revision: row.revision });
        await client.query('INSERT INTO platform_companion_identity_selection_operations(user_id,operation_id,selection_id,identity_revision,applied_revision,'
          + 'bundle_revision,content_digest,review_digest,request_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [receipt.user_id, receipt.operation_id, receipt.selection_id, receipt.identity_revision, receipt.applied_revision,
          receipt.bundle_revision, receipt.content_digest, receipt.review_digest, receipt.request_ciphertext]);
        await authorizeFixedSession(client, fixed, signal); signal?.throwIfAborted();
        return Object.freeze({ selection: this.selectionView(draft, row, input.sealChar),
          operation: Object.freeze({ id: input.operationId, appliedRevision: row.revision, replayed: false }) });
    } catch (error) { if (error instanceof DataCryptoError) throw unavailable(); throw error; }
  }
  async save(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionIdentitySaveResult>> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), input = command(value), canonical = JSON.stringify(input);
    return this.db.withBoundedTransaction(client => this.saveInTransaction(client, fixed, JSON.parse(canonical), signal));
  }
  /** Internal semantic/application stage. The caller owns the transaction and
   * must commit actual name classification before entering this stage. */
  async saveInTransaction(client: PoolClient, context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionIdentitySaveResult>> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash }), input = command(value), canonical = JSON.stringify(input);
    try {
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
          if (bundle.schemaVersion === 1) {
            name = validateCompanionName({ name: input.name, userName: userName!, policy: bundle.policy });
            candidates = companionSealCandidates({ companionId: verified.source.companionId, name, dimensions: verified.dimensions, policy: bundle.policy });
          } else {
            name = validateCompanionNameV2({ name: input.name, userName: userName!, policy: bundle.policy });
            candidates = companionSealCandidatesV2({ companionId: verified.source.companionId, name, dimensions: verified.dimensions, policy: bundle.policy });
          }
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
    } catch (error) { if (error instanceof DataCryptoError) throw unavailable(); throw error; }
  }
}
