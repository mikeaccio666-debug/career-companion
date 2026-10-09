import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordObject as object, careerRecordId as id, parseTodayRestSettings, parseTodayRestCommand, type TodayRestSettings, type TodayRestCommand, type TodayRestResult } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { CompanionBirthOriginStore } from './companion-birth-origin-store.ts';
import { CompanionDailySettingsService } from './companion-daily-settings.ts';
import { ApiError } from './errors.ts';
const unavailable = () => new ApiError(503, 'TODAY_REST_UNAVAILABLE', 'The rest choice could not be confirmed.');
const conflict = () => new ApiError(409, 'TODAY_REST_REVISION_CHANGED', 'Read the current preference first.');
const canonical = (v: unknown) => JSON.stringify(v, (_key, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const digest = (ownerId: string, command: TodayRestCommand) => createHash('sha256').update(canonical({ ownerId, command })).digest('hex');
interface SavedChoice { schemaVersion: 1; settings: Readonly<TodayRestSettings>; command: Readonly<TodayRestCommand>; commandDigest: string; acceptedAuthVersion: string; }
/** Saved owner choices. Does not create plans, schedules or notification jobs. */
export class TodayRestService {
  private readonly storage: OnboardingStorage;
  private readonly origins: CompanionBirthOriginStore;
  private readonly daily: CompanionDailySettingsService;
  constructor(private readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, legal: LegalBundle | null) { this.daily = new CompanionDailySettingsService(db, config, legal); this.storage = new OnboardingStorage(config, legal); this.origins = new CompanionBirthOriginStore(config.dataCrypto); }
  private fixed(value: FixedSessionContext) {
    try { const v = object(value, ['userId', 'tokenHash']); if (typeof v.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.tokenHash)) throw unavailable(); return Object.freeze({ userId: id(v.userId), tokenHash: v.tokenHash }); }
    catch { throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.'); }
  }
  private async authorize(c: PoolClient, s: FixedSessionContext, signal?: AbortSignal, lock = true) {
    await authorizeFixedSession(c, s, signal);
    const user = (await c.query('SELECT account_kind,auth_version FROM platform_users WHERE id=$1' + (lock ? ' FOR NO KEY UPDATE' : ''), [s.userId])).rows[0];
    if (user?.account_kind !== 'student') throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account.');
    if (!this.storage.crypto) throw unavailable(); signal?.throwIfAborted(); return user;
  }
  private decode(s: FixedSessionContext, row: any): SavedChoice {
    try {
      if (row.user_id !== s.userId) throw unavailable();
      const raw = this.storage.crypto!.openUtf8(row.record_ciphertext, { table: 'platform_today_rest', column: 'record_ciphertext', rowId: row.operation_id, ownerId: s.userId, revision: row.revision });
      const v = object(JSON.parse(raw), ['schemaVersion', 'settings', 'command', 'commandDigest', 'acceptedAuthVersion']);
      const settings = parseTodayRestSettings(v.settings), command = parseTodayRestCommand(v.command);
      if (canonical(v) !== raw || v.schemaVersion !== 1 || settings.ownerId !== s.userId || settings.companionId !== row.companion_id || settings.revision !== row.revision || settings.lastOperationId !== row.operation_id || settings.updatedAt !== row.created_at.toISOString()
        || command.companionId !== settings.companionId || command.operationId !== settings.lastOperationId || command.expectedRevision + 1 !== settings.revision
        || v.commandDigest !== digest(s.userId, command) || typeof v.acceptedAuthVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v.acceptedAuthVersion)) throw unavailable();
      return { schemaVersion: 1, settings, command, commandDigest: v.commandDigest as string, acceptedAuthVersion: v.acceptedAuthVersion };
    } catch { throw unavailable(); }
  }
  private async current(c: PoolClient, s: FixedSessionContext): Promise<Readonly<TodayRestSettings>> {
    const born = await this.origins.readCurrent(c, s.userId);
    if (born.kind !== 'active') throw new ApiError(409, 'COMPANION_NOT_BORN', 'The companion is not born yet.');
    const companionId = born.companion.companionId;
    const row = (await c.query('SELECT * FROM platform_today_rest WHERE user_id=$1 AND companion_id=$2 ORDER BY revision DESC LIMIT 1 FOR SHARE', [s.userId, companionId])).rows[0];
    return row ? this.decode(s, row).settings : parseTodayRestSettings({ ownerId: s.userId, companionId, timeZone: null, optedOutDate: null, optedOutUntil: null, pauseUntil: null, reminders: 'keep', revision: 0, updatedAt: null, lastOperationId: null });
  }
  private result(settings: Readonly<TodayRestSettings>, original: SavedChoice, replayed: boolean): Readonly<TodayRestResult> {
    return Object.freeze({ settings, operation: Object.freeze({ id: original.command.operationId, appliedRevision: original.settings.revision, choice: original.command.choice, replayed }) });
  }
  /** Used only inside the fresh-proof account archive transaction. */
  async *exportInTransaction(c: PoolClient, context: FixedSessionContext, signal?: AbortSignal) {
    const s = this.fixed(context); await this.authorize(c, s, signal, false); let after: string | null = null;
    for (;;) {
      signal?.throwIfAborted();
      const rows: any[] = (await c.query('SELECT * FROM platform_today_rest WHERE user_id=$1 AND ($2::uuid IS NULL OR operation_id>$2) ORDER BY operation_id LIMIT 100', [s.userId, after])).rows;
      for (const row of rows) { signal?.throwIfAborted(); const saved = this.decode(s, row); yield { section: 'todayRest' as const, record: saved.settings }; }
      if (rows.length < 100) break; after = id(rows.at(-1).operation_id);
    }
    await authorizeFixedSession(c, s, signal); signal?.throwIfAborted();
  }
  /** Owner-private same-transaction read, including after model/legal admission withdrawal. */
  async readOwnedInTransaction(c: PoolClient, context: FixedSessionContext, signal?: AbortSignal) {
    const s=this.fixed(context);await this.authorize(c,s,signal);const settings=await this.current(c,s);
    await authorizeFixedSession(c,s,signal);signal?.throwIfAborted();return settings;
  }
  async read(context: FixedSessionContext, signal?: AbortSignal) {
    const s = this.fixed(context); return this.db.withBoundedTransaction(async c => { await this.authorize(c, s, signal); const settings = await this.current(c, s); await authorizeFixedSession(c, s, signal); signal?.throwIfAborted(); return Object.freeze({ settings }); });
  }
  /** Same-transaction consumer: no guessed timezone or browser preference. */
  async readForPolicyInTransaction(c: PoolClient, context: FixedSessionContext, signal?: AbortSignal) {
    const s = this.fixed(context); await this.authorize(c, s, signal); await this.storage.authorizeSession(c, s, signal);
    const settings = await this.current(c, s);
    await authorizeFixedSession(c, s, signal); signal?.throwIfAborted(); return settings;
  }
  async operation(context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
    const s = this.fixed(context); let key: string; try { key = id(value); } catch { throw new ApiError(400, 'TODAY_REST_INPUT_INVALID', 'Use a valid operation.'); }
    return this.db.withBoundedTransaction(async c => {
      await this.authorize(c, s, signal); const row = (await c.query('SELECT * FROM platform_today_rest WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [s.userId, key])).rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'The operation was not found.');
      const original = this.decode(s, row), settings = await this.current(c, s); if (settings.companionId !== original.command.companionId) throw conflict();
      await authorizeFixedSession(c, s, signal); signal?.throwIfAborted(); return this.result(settings, original, true);
    });
  }
  async change(context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
    const s = this.fixed(context); let command: Readonly<TodayRestCommand>;
    try { command = parseTodayRestCommand(value); } catch { throw new ApiError(400, 'TODAY_REST_INPUT_INVALID', 'Choose a valid rest option.'); }
    return this.db.withBoundedTransaction(async c => {
      const user = await this.authorize(c, s, signal), base = await this.current(c, s);
      if (base.companionId !== command.companionId) throw conflict();
      const old = (await c.query('SELECT * FROM platform_today_rest WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [s.userId, command.operationId])).rows[0];
      if (old) { const original = this.decode(s, old); if (original.commandDigest !== digest(s.userId, command)) throw new ApiError(409, 'TODAY_REST_OPERATION_CONFLICT', 'The operation already describes another choice.'); await authorizeFixedSession(c, s, signal); signal?.throwIfAborted(); return this.result(base, original, true); }
      if (base.revision !== command.expectedRevision) throw conflict(); await this.storage.authorizeSession(c, s, signal);
      const at = (await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
      const daily = await this.daily.readForPolicyInTransaction(c, s, signal);
      const timeZone = daily.preferences!.timeZone;
      const active = (base.optedOutUntil !== null && base.optedOutUntil > at) || (base.pauseUntil !== null && base.pauseUntil > at);
      if (command.choice === 'reminders_off' && !active) throw new ApiError(409, 'TODAY_REST_NOT_ACTIVE', 'Choose a rest period before muting its reminders.');
      let optedOutDate = base.optedOutDate, optedOutUntil = base.optedOutUntil, pauseUntil = base.pauseUntil;
      // PostgreSQL resolves local calendar boundaries, including DST. Never trust a client clock.
      if (command.choice === 'today') {
        const row = (await c.query("SELECT to_char($1::timestamptz AT TIME ZONE $2,'YYYY-MM-DD') AS local_day, ((date_trunc('day',$1::timestamptz AT TIME ZONE $2)+interval '1 day') AT TIME ZONE $2) until", [at,timeZone])).rows[0];
        optedOutDate = row.local_day; optedOutUntil = row.until.toISOString();
      } else if (command.choice !== 'reminders_off') {
        const days = command.choice === '1_day' ? 1 : command.choice === '3_days' ? 3 : 7;
        pauseUntil = (await c.query("SELECT (($1::timestamptz AT TIME ZONE $2 + make_interval(days => $3)) AT TIME ZONE $2) until", [at,timeZone,days])).rows[0].until.toISOString();
      }
      const settings = parseTodayRestSettings({ ...base, timeZone, optedOutDate, optedOutUntil, pauseUntil, reminders:command.choice === 'reminders_off' ? 'off' : active ? base.reminders : 'keep', revision: base.revision + 1, updatedAt: at, lastOperationId: command.operationId });
      const original: SavedChoice = { schemaVersion: 1, settings, command, commandDigest: digest(s.userId, command), acceptedAuthVersion: String(user.auth_version) };
      const encrypted = this.storage.crypto!.sealUtf8(canonical(original), { table: 'platform_today_rest', column: 'record_ciphertext', rowId: command.operationId, ownerId: s.userId, revision: settings.revision });
      await c.query('INSERT INTO platform_today_rest(user_id,companion_id,revision,operation_id,record_ciphertext,created_at) VALUES($1,$2,$3,$4,$5,$6)', [s.userId, settings.companionId, settings.revision, command.operationId, encrypted, at]);
      await authorizeFixedSession(c, s, signal); signal?.throwIfAborted(); return this.result(settings, original, false);
    });
  }
}
