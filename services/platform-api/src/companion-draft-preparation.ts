import { createHash, randomUUID } from 'node:crypto';
import { compileFallbackCompanionStyle } from '@companion/career-core';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import type { FixedSessionContext } from './auth.ts';
import { authorizeFixedSession } from './auth.ts';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import type { LegalBundle } from './legal-documents.ts';
import { ApiError } from './errors.ts';
import { CompanionIntakePreparation } from './companion-intake-preparation.ts';
import { OnboardingStorage, intakeUnavailable } from './onboarding-storage.ts';
import { resolveModelRoute } from './model-routing.ts';

export interface CompanionDraftTaskPreparation {
  readonly companionId: string;
  readonly taskId: string;
  readonly status: 'pending';
  readonly source: Readonly<{ draftId: string; draftRevision: number; questionnaireRevision: 1; rulesRevision: 1 }>;
}
interface TaskRow {
  id: string; user_id: string; companion_id: string; answers_id: string;
  source_draft_id: string; source_revision: number; auth_version: string;
  questionnaire_revision: number; rules_revision: number; generator_version: number;
  purpose: string; status: string; seed_ciphertext: Buffer;
  answers_ciphertext: Buffer; fingerprint: string; companion_status: string;
  current_revision: number; draft_rerolls: number; quirk_draw: number;
}
type Configuration = Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail' | 'modelRoutes'>;
const changed = () => new ApiError(409, 'COMPANION_DRAFT_SOURCE_CHANGED', 'The prepared companion draft belongs to a different intake or account version.');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Actual durable drafting entity and pending work, not a model attempt or preview.
 * There is deliberately no dispatch, lease, admission, output, birth or student
 * route here. Future dispatch must recheck source/history/identity/consent, take a
 * background lease, reserve CostGuard funds, and fence the actual provider call.
 */
export class CompanionDraftPreparation {
  private readonly intake: CompanionIntakePreparation;
  private readonly storage: OnboardingStorage;
  private readonly configuration: Configuration;
  constructor(readonly db: Database, config: Configuration, readonly legal: LegalBundle | null,
    private readonly runtime: Pick<PlatformProviderRuntime, 'capabilities'>) {
    this.configuration = Object.freeze({ dataCrypto: config.dataCrypto, requireVerifiedEmail: config.requireVerifiedEmail,
      modelRoutes: Object.freeze(Object.fromEntries(Object.entries(config.modelRoutes).map(([key, value]) =>
        [key, Object.freeze({ provider: value!.provider })]))) });
    this.intake = new CompanionIntakePreparation(db, this.configuration, legal);
    this.storage = new OnboardingStorage(this.configuration, legal);
  }
  async prepare(context: FixedSessionContext, value: unknown, signal?: AbortSignal): Promise<Readonly<CompanionDraftTaskPreparation>> {
    const fixed = Object.freeze({ userId: context.userId, tokenHash: context.tokenHash });
    // The intake codec snapshots the closed request before any await. Never read
    // caller input again after the source check, including during idempotent replay.
    const descriptors = value && typeof value === 'object' && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value)) ? Object.getOwnPropertyDescriptors(value) : undefined;
    const revision = descriptors?.expectedRevision;
    if (!descriptors || Reflect.ownKeys(value as object).length !== 1 || !revision || !('value' in revision)
      || !revision.enumerable || !Number.isSafeInteger(revision.value) || revision.value < 0
      || revision.value > 2147483647 || Object.is(revision.value, -0)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Use the current intake revision.');
    }
    const request = Object.freeze({ expectedRevision: revision.value as number });
    return this.db.withBoundedTransaction(async client => {
      const prepared = await this.intake.prepareInTransaction(client, fixed, request, signal);
      const authVersion = await this.storage.authorizeSession(client, fixed, signal);
      // Existing server route availability is only a configuration check. A model
      // still needs its own real background admission; no fixed reply substitutes.
      const route = resolveModelRoute(this.configuration, this.runtime, 'companion_generation');
      const sourceRow = await this.storage.row(client, fixed.userId);
      if (!sourceRow || sourceRow.id !== prepared.draftId || sourceRow.revision !== prepared.draftRevision) throw intakeUnavailable();
      const source = this.storage.decode(sourceRow);
      const existing = (await client.query<TaskRow>(`SELECT t.*,a.payload_ciphertext AS answers_ciphertext,
        c.fingerprint,c.status AS companion_status,c.current_revision,c.draft_rerolls
        FROM platform_companion_generation_tasks t
        JOIN platform_companion_answers a ON a.id=t.answers_id AND a.user_id=t.user_id
        JOIN platform_companions c ON c.id=t.companion_id AND c.user_id=t.user_id
        WHERE t.user_id=$1 FOR UPDATE OF t,a,c`, [fixed.userId])).rows;
      if (existing.length > 1) throw intakeUnavailable();
      const previous = existing[0], companionId = previous?.companion_id ?? randomUUID();
      const taskId = previous?.id ?? randomUUID(), answersId = previous?.answers_id ?? randomUUID();
      // Only rule metadata is retained. Fallback summary/samples/generatedBy are
      // discarded; creating a task is not an eligible failed generation attempt.
      if (previous && (previous.quirk_draw !== 0 && previous.quirk_draw !== 1 || Object.is(previous.quirk_draw, -0))) throw intakeUnavailable();
      let quirkDraw: 0 | 1 = previous ? previous.quirk_draw as 0 | 1 : 0;
      let compiled = compileFallbackCompanionStyle({ companionId, dimensions: { ...prepared.dimensions }, quirkDraw });
      const fingerprintOf = () => digest({ dimensions: { ...prepared.dimensions }, quirks: { ...compiled.quirks }, inkToken: compiled.inkToken });
      let fingerprint = fingerprintOf();
      // 02 §2.4: one best-effort pre-preview draw. This ordinary-index lookup
      // neither locks other owners nor guarantees global uniqueness. Replays
      // restore their saved draw and never revisit later collisions.
      if (!previous && (await client.query('SELECT 1 FROM platform_companions WHERE fingerprint=$1 AND id<>$2 LIMIT 1', [fingerprint, companionId])).rowCount) {
        quirkDraw = 1;
        compiled = compileFallbackCompanionStyle({ companionId, dimensions: { ...prepared.dimensions }, quirkDraw });
        fingerprint = fingerprintOf();
      }
      const ruleStyle = { dimensions: { ...prepared.dimensions }, quirks: { ...compiled.quirks },
        inkToken: compiled.inkToken, styleCard: compiled.styleCard };
      const answers = { schemaVersion: 1, id: answersId, userId: fixed.userId, sourceDraftId: source.id,
        sourceRevision: source.revision, fastTrack: source.fastTrack, answersPartial: source.answersPartial };
      const seed = { schemaVersion: 1, taskId, userId: fixed.userId, companionId, answersId,
        sourceDraftId: source.id, sourceRevision: source.revision, authVersion, questionnaireRevision: 1,
        rulesRevision: 1, generatorVersion: 1, purpose: 'companion_preview',
        provider: route.provider, model: route.model, ...ruleStyle, ...(quirkDraw === 1 ? { quirkDraw: 1 } : {}) };
      const answersBinding = { table: 'platform_companion_answers', column: 'payload_ciphertext', rowId: answersId,
        ownerId: fixed.userId, revision: source.revision };
      const seedBinding = { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext', rowId: taskId,
        ownerId: fixed.userId, revision: source.revision };
      if (previous) {
        if (previous.source_draft_id !== source.id || previous.source_revision !== source.revision
          || String(previous.auth_version) !== authVersion) throw changed();
        if (previous.status === 'completed' || previous.companion_status === 'awaiting_name') {
          throw new ApiError(409, 'COMPANION_EXISTS', 'A companion preview already exists.');
        }
        if (previous.status !== 'pending' || previous.companion_status !== 'drafting' || previous.current_revision !== 0
          || previous.draft_rerolls !== 0 || previous.questionnaire_revision !== 1 || previous.rules_revision !== 1
          || previous.generator_version !== 1 || previous.purpose !== 'companion_preview' || previous.fingerprint !== fingerprint) throw intakeUnavailable();
        try {
          // Exact canonical snapshots reject swapped owner/row/source ciphertext,
          // changed route and damaged private state. No best-effort partial replay.
          if (this.storage.crypto!.openUtf8(previous.answers_ciphertext, answersBinding) !== JSON.stringify(answers)
            || this.storage.crypto!.openUtf8(previous.seed_ciphertext, seedBinding) !== JSON.stringify(seed)) throw intakeUnavailable();
        } catch { throw intakeUnavailable(); }
      } else {
        if ((await client.query('SELECT id FROM platform_companions WHERE user_id=$1 FOR UPDATE', [fixed.userId])).rowCount) {
          throw new ApiError(409, 'COMPANION_EXISTS', 'A companion draft already exists.');
        }
        const answersCiphertext = this.storage.crypto!.sealUtf8(JSON.stringify(answers), answersBinding);
        const seedCiphertext = this.storage.crypto!.sealUtf8(JSON.stringify(seed), seedBinding);
        await client.query(`INSERT INTO platform_companions(id,user_id,status,fingerprint) VALUES($1,$2,'drafting',$3)`,
          [companionId, fixed.userId, fingerprint]);
        await client.query(`INSERT INTO platform_companion_answers(id,user_id,source_draft_id,source_revision,payload_ciphertext)
          VALUES($1,$2,$3,$4,$5)`, [answersId, fixed.userId, source.id, source.revision, answersCiphertext]);
        await client.query(`INSERT INTO platform_companion_generation_tasks(id,user_id,companion_id,answers_id,source_draft_id,
          source_revision,auth_version,questionnaire_revision,rules_revision,generator_version,purpose,status,seed_ciphertext,quirk_draw)
          VALUES($1,$2,$3,$4,$5,$6,$7,1,1,1,'companion_preview','pending',$8,$9)`,
          [taskId, fixed.userId, companionId, answersId, source.id, source.revision, authVersion, seedCiphertext, quirkDraw]);
      }
      await authorizeFixedSession(client, fixed, signal);
      signal?.throwIfAborted();
      return Object.freeze({ companionId, taskId, status: 'pending' as const,
        source: Object.freeze({ draftId: prepared.draftId, draftRevision: prepared.draftRevision,
          questionnaireRevision: 1 as const, rulesRevision: 1 as const }) });
    });
  }
}
