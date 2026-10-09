import {decodePaidSettingsReceipt,decodePaidSettingsSnapshot,paidSettingsCanonical as canonical,paidSettingsDigest as digest,type PaidSettingsReceipt as Receipt} from './companion-paid-settings-snapshot.ts';
import type { PoolClient } from 'pg';
import { careerRecordObject as object, careerRecordId as id, parseCompanionPaidSettings, parseCompanionPaidSettingsCommand, type CompanionPaidSettings, type CompanionPaidSettingsCommand, type CompanionPaidSettingsResult } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { CompanionBirthOriginStore } from './companion-birth-origin-store.ts';
import { ApiError } from './errors.ts';
const unavailable = () => new ApiError(503, 'PAID_SETTINGS_UNAVAILABLE', 'The saved preference could not be confirmed.');
const changed = () => new ApiError(409, 'PAID_SETTINGS_REVISION_CHANGED', 'Read the current preference first.');
/** Real owner preference only. This does not enable a trigger, reserve frequency or sign a recommendation grant. */
export class CompanionPaidSettingsService {
    private readonly storage: OnboardingStorage;
    private readonly origins: CompanionBirthOriginStore;
    constructor(private readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, legal: LegalBundle | null) { this.storage = new OnboardingStorage(config, legal); this.origins = new CompanionBirthOriginStore(config.dataCrypto); }
    private fixed(value: FixedSessionContext) { try {
        const v = object(value, ['userId', 'tokenHash']);
        if (typeof v.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.tokenHash))
            throw unavailable();
        return Object.freeze({ userId: id(v.userId), tokenHash: v.tokenHash });
    }
    catch {
        throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    } }
    private async authorize(client: PoolClient, s: FixedSessionContext, signal?: AbortSignal) { await authorizeFixedSession(client, s, signal); const user = (await client.query('SELECT account_kind,auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [s.userId])).rows[0]; if (user?.account_kind !== 'student')
        throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account.'); if (!this.storage.crypto)
        throw unavailable(); signal?.throwIfAborted(); return user; }
    private async receipt(s: FixedSessionContext, row: any): Promise<Receipt> {
        return decodePaidSettingsReceipt(this.storage.crypto,s.userId,row);
    }
    private async current(client: PoolClient, s: FixedSessionContext): Promise<Readonly<CompanionPaidSettings>> {
        const born = await this.origins.readCurrent(client, s.userId);
        if (born.kind !== 'active')
            throw new ApiError(409, 'COMPANION_NOT_BORN', 'The companion is not born yet.');
        const row = (await client.query('SELECT * FROM platform_companions WHERE id=$1 AND user_id=$2 FOR UPDATE', [born.companion.companionId, s.userId])).rows[0];
        if (!row)
            throw unavailable();
        const latest = (await client.query('SELECT * FROM platform_companion_paid_setting_operations WHERE user_id=$1 AND companion_id=$2 ORDER BY applied_revision DESC LIMIT 1 FOR SHARE', [s.userId, row.id])).rows[0];
        return decodePaidSettingsSnapshot(this.storage.crypto,s.userId,row,latest);
    }

    async read(context: FixedSessionContext, signal?: AbortSignal) { const s = this.fixed(context); return this.db.withBoundedTransaction(async (c) => { await this.authorize(c, s, signal); const settings = await this.current(c, s); await authorizeFixedSession(c, s, signal); return Object.freeze({ settings }); }); }
    /** Future cross-channel policy service reads this live source inside its owner-locked transaction. No HTTP snapshot is accepted. */
    async readForPolicyInTransaction(c: PoolClient, context: FixedSessionContext, signal?: AbortSignal) { const s = this.fixed(context); await this.authorize(c, s, signal); await this.storage.authorizeSession(c, s, signal); const settings = await this.current(c, s); await authorizeFixedSession(c, s, signal); return settings; }
    private result(settings: Readonly<CompanionPaidSettings>, r: Receipt, replayed: boolean): Readonly<CompanionPaidSettingsResult> { return Object.freeze({ settings, operation: Object.freeze({ id: r.command.operationId, appliedRevision: r.appliedRevision, paidSuggestionsMode: r.command.paidSuggestionsMode, replayed }) }); }
    async operation(context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
        const s = this.fixed(context);
        let key: string;
        try {
            key = id(value);
        }
        catch {
            throw new ApiError(400, 'PAID_SETTINGS_INPUT_INVALID', 'Use a valid operation.');
        }
        return this.db.withBoundedTransaction(async (c) => { await this.authorize(c, s, signal); const row = (await c.query('SELECT * FROM platform_companion_paid_setting_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [s.userId, key])).rows[0]; if (!row)
            throw new ApiError(404, 'NOT_FOUND', 'The operation was not found.'); const proof = await this.receipt(s, row), settings = await this.current(c, s); if (settings.companionId !== proof.command.companionId)
            throw changed(); await authorizeFixedSession(c, s, signal); return this.result(settings, proof, true); });
    }
    async change(context: FixedSessionContext, value: unknown, signal?: AbortSignal) {
        const s = this.fixed(context);
        let command: Readonly<CompanionPaidSettingsCommand>;
        try {
            command = parseCompanionPaidSettingsCommand(value);
        }
        catch {
            throw new ApiError(400, 'PAID_SETTINGS_INPUT_INVALID', 'Choose a paid-suggestion preference.');
        }
        return this.db.withBoundedTransaction(async (c) => {
            const user = await this.authorize(c, s, signal), base = await this.current(c, s);
            if (base.companionId !== command.companionId)
                throw changed();
            const previous = (await c.query('SELECT * FROM platform_companion_paid_setting_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [s.userId, command.operationId])).rows[0];
            if (previous) {
                const r = await this.receipt(s, previous);
                if (r.commandDigest !== digest(s.userId, command))
                    throw new ApiError(409, 'PAID_SETTINGS_OPERATION_CONFLICT', 'The operation already describes another preference.');
                await authorizeFixedSession(c, s, signal);
                return this.result(base, r, true);
            }
            if (base.revision !== command.expectedRevision)
                throw changed();
            await this.storage.authorizeSession(c, s, signal);
            const revision = base.revision + 1, at = (await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
            const settings = parseCompanionPaidSettings({ ...base, paidSuggestionsMode: command.paidSuggestionsMode, revision, updatedAt: at, lastOperationId: command.operationId });
            const receipt: Receipt = { schemaVersion: 1, ownerId: s.userId, command, commandDigest: digest(s.userId, command), appliedRevision: revision, acceptedAuthVersion: String(user.auth_version), createdAt: at };
            const sealed = this.storage.crypto!.sealUtf8(canonical(receipt), { table: 'platform_companion_paid_setting_operations', column: 'receipt_ciphertext', rowId: command.operationId, ownerId: s.userId, revision });
            await c.query('INSERT INTO platform_companion_paid_setting_operations(user_id,companion_id,operation_id,applied_revision,receipt_ciphertext,created_at) VALUES($1,$2,$3,$4,$5,$6)', [s.userId, base.companionId, command.operationId, revision, sealed, at]);
            const encrypted = this.storage.crypto!.sealUtf8(canonical(settings), { table: 'platform_companions', column: 'paid_suggestions_ciphertext', rowId: base.companionId, ownerId: s.userId, revision });
            await c.query('UPDATE platform_companions SET paid_suggestions_mode=$3,paid_suggestions_revision=$4,paid_suggestions_ciphertext=$5,paid_suggestions_updated_at=$6,paid_suggestions_operation_id=$7 WHERE id=$1 AND user_id=$2', [base.companionId, s.userId, settings.paidSuggestionsMode, revision, encrypted, at, command.operationId]);
            await authorizeFixedSession(c, s, signal);
            signal?.throwIfAborted();
            return this.result(settings, receipt, false);
        });
    }
}
