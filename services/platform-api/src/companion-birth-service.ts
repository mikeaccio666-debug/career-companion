/** Atomic companion birth and account-scoped observation. Preparation creates
 * no birth rows; native rendering runs outside the transaction, and admission is
 * checked again before origin, assets, main room and event commit together.
 * Ordinary C1 messages and the first letter use their own generation paths.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  parseCompanionBirthCommand, parseCompanionBirthReceipt,
  parseCompanionBirthResult, parseCompanionBirthViewerState,
  parseCompanionBirthReceiptObservation, parseCompanionBirthIdempotencyKey,
  CompanionBirthContractError,
  type CompanionBirthCommand, type CompanionBirthRequest,
  type CompanionBirthResult, type PublicCompanionBirthReceipt,
  type CompanionBirthViewerState, type CompanionBirthReceiptObservation,
} from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { assertActiveLegal, type LegalBundle } from './legal-documents.ts';
import type { BirthCapture, BirthOriginStore } from './companion-birth-types.ts';
import type { CompanionIdentityDrafts } from './companion-identity-drafts.ts';
import type { BackgroundGeneration } from './background-generation.ts';
import type { CompanionPrebirthSafety } from './companion-prebirth-safety.ts';
import type { CompanionNameSafety } from './companion-name-safety.ts';
import { verifyPrebirthInventoryInTransaction } from './companion-prebirth-protocol.ts';
import {
  createCompanionSealRenderer, inspectCompanionSealPNG,
  readCompanionSealWorkerSVG, validateCompanionSealGlyphPath,
  CompanionSealRenderingError,
  type CompanionSealGlyphLookup, type CompanionSealRendered,
} from './companion-seal-rendering.ts';
import { ApiError } from './errors.ts';

const fixed = (context: FixedSessionContext) => Object.freeze({ userId: context.userId, tokenHash: context.tokenHash });
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sourceChanged = () => new ApiError(409, 'COMPANION_BIRTH_SOURCE_CHANGED', 'Read the current saved name and seal before continuing.');
const storageUnavailable = () => new ApiError(503, 'COMPANION_BIRTH_STORAGE_UNAVAILABLE', 'The saved companion birth could not be confirmed.');
const conflict = () => new ApiError(409, 'COMPANION_BIRTH_OPERATION_CONFLICT', 'This key belongs to a different birth request.');
function parseCommand(body: unknown, header: unknown) {
  try { return parseCompanionBirthCommand(body, header); }
  catch (error) {
    if (error instanceof CompanionBirthContractError) throw new ApiError(400, 'INVALID_INPUT', 'Use a name, a seal choice and one birth operation key.');
    throw error;
  }
}
function parseKey(value: unknown) {
  try { return parseCompanionBirthIdempotencyKey(value); }
  catch (error) {
    if (error instanceof CompanionBirthContractError) throw new ApiError(400, 'INVALID_INPUT', 'Use one birth operation key.');
    throw error;
  }
}
function parseAssetId(value: unknown) {
  try { return parseCompanionBirthIdempotencyKey(value); }
  catch (error) {
    if (error instanceof CompanionBirthContractError) throw new ApiError(400, 'INVALID_INPUT', 'Use one saved seal asset identifier.');
    throw error;
  }
}

export class CompanionBirthService {
  private readonly storage: OnboardingStorage;
  private readonly renderer: ReturnType<typeof createCompanionSealRenderer> | null;
  constructor(readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>,
    private readonly legal: LegalBundle | null,
    private readonly prebirth: CompanionPrebirthSafety,
    private readonly names: CompanionNameSafety,
    private readonly background: BackgroundGeneration,
    private readonly identities: CompanionIdentityDrafts,
    private readonly origins: BirthOriginStore,
    private readonly glyphs: CompanionSealGlyphLookup | null) {
    this.storage = new OnboardingStorage(config, legal);
    this.renderer = glyphs ? createCompanionSealRenderer(glyphs) : null;
  }

  private async viewer(client: PoolClient, session: FixedSessionContext, signal?: AbortSignal) {
    await authorizeFixedSession(client, session, signal);
    const owner = (await client.query<{ account_kind: string }>(
      'SELECT account_kind FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [session.userId])).rows[0];
    if (!owner || owner.account_kind !== 'student') throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account for the saved companion.');
    if (!this.storage.crypto) throw storageUnavailable();
  }

  private async replay(client: PoolClient, session: FixedSessionContext,
    command: Readonly<CompanionBirthCommand>, signal?: AbortSignal): Promise<CompanionBirthResult | null> {
    // New genuine login is allowed. accepted_auth_version and originating
    // session are historical facts, NEVER a comparison against today's login.
    const saved = await this.origins.findOwn(client, session.userId, command.idempotencyKey);
    if (!saved) return null;
    if (JSON.stringify(saved.request) !== JSON.stringify(command)) throw conflict();
    const receipt = parseCompanionBirthReceipt(saved.receipt);
    if (receipt.idempotencyKey !== command.idempotencyKey) throw storageUnavailable();
    await authorizeFixedSession(client, session, signal); signal?.throwIfAborted();
    return parseCompanionBirthResult({ kind: 'birth_result', receipt, replayed: true });
  }

  private async capture(client: PoolClient, session: FixedSessionContext,
    request: Readonly<CompanionBirthRequest>, signal?: AbortSignal): Promise<Readonly<BirthCapture>> {
    const acceptedAuthVersion = await this.storage.authorizeSession(client, session, signal);
    const tasks = (await client.query<{
      id: string; companion_id: string; answers_id: string; generation: number;
      source_draft_id: string; source_revision: number; source_receipt_version: 1 | 2 | null;
    }>(`SELECT id,companion_id,answers_id,generation,source_draft_id,source_revision,source_receipt_version
      FROM platform_companion_generation_tasks t WHERE t.user_id=$1
      AND EXISTS(SELECT 1 FROM platform_companions c WHERE c.id=t.companion_id
        AND c.user_id=t.user_id AND c.status='awaiting_name' AND c.current_revision=1) ORDER BY t.id FOR UPDATE`, [session.userId])).rows;
    if (!tasks.length) throw new ApiError(409, 'COMPANION_PREVIEW_REQUIRED', 'Wait for the completed companion preview.');
    if (tasks.length !== 1) throw storageUnavailable();
    const task = tasks[0];
    await this.prebirth.assertCurrentWriteInTransaction(client, session, { taskId: task.id }, signal);
    await this.names.assertCurrentIdentityProvenanceInTransaction(client, session, { taskId: task.id }, signal);
    const preview = await this.background.readInTransaction(client, session, { taskId: task.id }, signal);
    if (!preview) throw new ApiError(409, 'COMPANION_PREVIEW_REQUIRED', 'Wait for the completed companion preview.');
    if (preview.source.companionId !== task.companion_id || preview.source.generation !== task.generation
      || preview.source.answersId !== task.answers_id || preview.source.sourceDraftId !== task.source_draft_id
      || preview.source.sourceRevision !== task.source_revision) throw storageUnavailable();
    const identity = await this.identities.captureBirthSelectionInTransaction(client, session,
      { taskId: task.id, request }, signal);
    if (identity.taskId !== task.id || identity.companionId !== task.companion_id
      || identity.name !== request.name || identity.sealChar !== request.sealChar
      || identity.inkToken !== preview.preview.inkToken) throw sourceChanged();

    // The full source gate above verifies the authenticated 045 manifest/seed.
    // Only capture its already checked locked coordinates; never INSERT a prefix.
    const prefixes = (await client.query<{ id: string; schema_version: 1 | 2; payload_digest: string;
      companion_id: string; answers_id: string; source_draft_id: string; source_revision: number }>(
      'SELECT * FROM platform_companion_source_prefixes WHERE task_id=$1 AND user_id=$2 FOR SHARE',
      [task.id, session.userId])).rows;
    let prefix: BirthCapture['prefix'] = null;
    if (task.source_receipt_version === null) {
      if (prefixes.length) throw storageUnavailable();
      // Genuine legacy NULL remains NULL; it passed the actual current-source gate.
    } else {
      const row = prefixes[0];
      if (![1, 2].includes(task.source_receipt_version) || prefixes.length !== 1
        || row.id !== task.id || row.schema_version !== task.source_receipt_version
        || row.companion_id !== task.companion_id || row.answers_id !== task.answers_id
        || row.source_draft_id !== task.source_draft_id || row.source_revision !== task.source_revision) throw storageUnavailable();
      prefix = Object.freeze({ id: row.id, version: row.schema_version, digest: row.payload_digest });
    }
    await verifyPrebirthInventoryInTransaction(client, this.storage.crypto, session.userId, signal);
    const head = (await client.query<{ revision: number; tip_id: string | null; tip_digest: string }>(
      'SELECT revision,tip_id,tip_digest FROM platform_companion_prebirth_heads WHERE user_id=$1 FOR UPDATE', [session.userId])).rows[0];
    if (!head || head.revision < 1 || !head.tip_id) throw storageUnavailable();
    const terms = await assertActiveLegal(client, this.legal, signal);
    await authorizeFixedSession(client, session, signal); signal?.throwIfAborted();
    return Object.freeze({ ownerId: session.userId, acceptedAuthVersion,
      terms: Object.freeze({ version: terms.version, contentDigest: terms.digest, reviewDigest: terms.reviewDigest }),
      task: Object.freeze({ id: task.id, companionId: task.companion_id, answersId: task.answers_id,
        generation: task.generation, sourceDraftId: task.source_draft_id, sourceRevision: task.source_revision,
        sourceReceiptVersion: task.source_receipt_version }), prefix,
      inventory: Object.freeze({ tipId: head.tip_id, revision: head.revision, tipDigest: head.tip_digest }), identity });
  }

  private inspectRendered(rendered: CompanionSealRendered): void {
    // Byte buffers cannot be frozen. They remain private, copied once after the
    // worker, and rehashed before encryption by the actual repository.
    readCompanionSealWorkerSVG(rendered.svg);
    const png = inspectCompanionSealPNG(rendered.png);
    if (rendered.svg.length !== rendered.svgByteLength || rendered.png.length !== rendered.pngByteLength
      || sha(rendered.svg) !== rendered.svgSha256 || png.sha256 !== rendered.pngSha256) throw storageUnavailable();
  }

  async birth(context: FixedSessionContext, body: unknown, header: unknown,
    signal?: AbortSignal): Promise<Readonly<CompanionBirthResult>> {
    const session = fixed(context), command = parseCommand(body, header);
    const prepared = await this.db.withBoundedTransaction(async client => {
      await this.viewer(client, session, signal);
      const replay = await this.replay(client, session, command, signal);
      if (replay) return { kind: 'replayed' as const, replay };
      await this.origins.assertUnborn(client, session.userId);
      return { kind: 'prepared' as const, capture: await this.capture(client, session, command.request, signal) };
    });
    if (prepared.kind === 'replayed') return prepared.replay;

    // No DB client/transaction is held during the bounded child-process render.
    // This preparation creates no birth receipt, main room, model request or C1.
    if (!this.renderer || !this.glyphs) throw new ApiError(503, 'COMPANION_SEAL_GLYPH_UNAVAILABLE', 'The companion seal glyph is not configured.');
    let output: Readonly<CompanionSealRendered>;
    try {
      output = await this.renderer.render({ sealChar: prepared.capture.identity.sealChar,
        inkToken: prepared.capture.identity.inkToken }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CompanionSealRenderingError) throw new ApiError(503, error.code, 'The companion seal could not be rendered. Try again later.');
      throw error;
    }
    const rendered = Object.freeze({ ...output, svg: Buffer.from(output.svg), png: Buffer.from(output.png) });
    this.inspectRendered(rendered);
    return this.db.withBoundedTransaction(async client => {
      await this.viewer(client, session, signal);
      // Another same-key caller may have committed during rendering. Its actual
      // own receipt wins without entering any awaiting_name/current-consent gate.
      const replay = await this.replay(client, session, command, signal);
      if (replay) return replay;
      await this.origins.assertUnborn(client, session.userId);
      const current = await this.capture(client, session, command.request, signal);
      if (JSON.stringify(current) !== JSON.stringify(prepared.capture)) throw sourceChanged();
      const glyph = this.glyphs!.lookup(current.identity.sealChar);
      if (!glyph || glyph.assetDigest !== rendered.glyphAssetDigest
        || sha(validateCompanionSealGlyphPath(glyph.path)) !== rendered.pathSha256) {
        throw new ApiError(503, 'COMPANION_SEAL_GLYPH_UNAVAILABLE', 'The actual companion seal glyph is not available.');
      }
      this.inspectRendered(rendered);
      const receipt = await this.origins.writeAtomic(client, session, command, current, rendered, signal);
      await authorizeFixedSession(client, session, signal); signal?.throwIfAborted();
      return parseCompanionBirthResult({ kind: 'birth_result', receipt, replayed: false });
    });
  }

  async readReceipt(context: FixedSessionContext, key: unknown, signal?: AbortSignal): Promise<Readonly<CompanionBirthReceiptObservation>> {
    const session = fixed(context), idempotencyKey = parseKey(key);
    return this.db.withBoundedTransaction(async client => {
      await this.viewer(client, session, signal);
      const saved = await this.origins.findOwn(client, session.userId, idempotencyKey);
      const result = saved ? { kind: 'found', receipt: saved.receipt } : { kind: 'not_found' };
      await authorizeFixedSession(client, session, signal); signal?.throwIfAborted();
      return parseCompanionBirthReceiptObservation(result);
    });
  }

  async read(context: FixedSessionContext, signal?: AbortSignal): Promise<Readonly<CompanionBirthViewerState>> {
    const session = fixed(context);
    return this.db.withBoundedTransaction(async client => {
      await this.viewer(client, session, signal);
      const result = parseCompanionBirthViewerState(await this.origins.readCurrent(client, session.userId));
      await authorizeFixedSession(client, session, signal); signal?.throwIfAborted(); return result;
    });
  }

  async readSealAsset(context: FixedSessionContext, id: unknown, signal?: AbortSignal): Promise<Readonly<CompanionSealRendered>> {
    const session = fixed(context), assetId = parseAssetId(id);
    return this.db.withBoundedTransaction(async client => {
      await this.viewer(client, session, signal);
      const rendered = await this.origins.readSealAsset(client, session.userId, assetId);
      if (!rendered) throw new ApiError(404, 'NOT_FOUND', 'The saved seal was not found.');
      // Only saved authenticated bytes are returned. Reading does not render a
      // replacement or re-enter current naming, review or model admission.
      await authorizeFixedSession(client, session, signal); signal?.throwIfAborted();
      return rendered;
    });
  }
}
