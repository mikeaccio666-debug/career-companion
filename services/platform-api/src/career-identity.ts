import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordObject, careerRecordId, parseCareerIdentityCommand, parseCareerIdentityRecord, type CareerIdentityAction, type CareerIdentityRecord } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';
const unavailable = () => new ApiError(503, 'CAREER_IDENTITY_STORAGE_UNAVAILABLE', 'The private identity record could not be confirmed.');
const bad = () => new ApiError(400, 'CAREER_IDENTITY_INPUT_INVALID', 'Use an explicit owner record.');
const missing = () => new ApiError(404, 'NOT_FOUND', 'The private identity record was not found.');
const conflict = () => new ApiError(409, 'CAREER_IDENTITY_REVISION_CHANGED', 'Read the current private record before changing it.');
const canonical = (v: unknown) => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
interface Receipt {
    schemaVersion: 1;
    ownerId: string;
    operationId: string;
    recordId: string;
    action: CareerIdentityAction;
    commandDigest: string;
    appliedRevision: number;
    acceptedAuthVersion: string;
    createdAt: string;
}
/** Explicit owner-only Web storage. Never registered as a model/MCP/voice port.
 * No reminder scheduler, status inference, upload interpretation or countdown. */
export class CareerIdentityRecords {
    private readonly storage: OnboardingStorage;
    constructor(private readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, legal: LegalBundle | null) { this.storage = new OnboardingStorage(config, legal); }
    private fixed(input: FixedSessionContext) { try {
        const v = careerRecordObject(input, ['userId', 'tokenHash']);
        if (typeof v.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.tokenHash))
            throw bad();
        return Object.freeze({ userId: careerRecordId(v.userId), tokenHash: v.tokenHash });
    }
    catch {
        throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    } }
    private async authorize(client: PoolClient, s: FixedSessionContext, signal?: AbortSignal) {
        await authorizeFixedSession(client, s, signal);
        const user = (await client.query('SELECT account_kind,auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [s.userId])).rows[0];
        if (user?.account_kind !== 'student')
            throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account.');
        if (!this.storage.crypto)
            throw unavailable();
        signal?.throwIfAborted();
        return user;
    }
    private receipt(s: FixedSessionContext, row: any): Receipt {
        try {
            const raw = this.storage.crypto!.openUtf8(row.receipt_ciphertext, { table: 'platform_career_identity_operations', column: 'receipt_ciphertext', rowId: row.operation_id, ownerId: s.userId, revision: row.applied_revision }), v = careerRecordObject(JSON.parse(raw), ['schemaVersion', 'ownerId', 'operationId', 'recordId', 'action', 'commandDigest', 'appliedRevision', 'acceptedAuthVersion', 'createdAt']);
            if (canonical(v) !== raw || v.schemaVersion !== 1 || v.ownerId !== s.userId || v.operationId !== row.operation_id || v.recordId !== row.record_id || v.action !== row.action || v.appliedRevision !== row.applied_revision || v.createdAt !== row.created_at.toISOString() || !['create', 'edit', 'delete'].includes(v.action as string) || typeof v.commandDigest !== 'string' || !/^[0-9a-f]{64}$/.test(v.commandDigest) || typeof v.acceptedAuthVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v.acceptedAuthVersion))
                throw unavailable();
            return v as unknown as Receipt;
        }
        catch {
            throw unavailable();
        }
    }
    private async latest(client: PoolClient, s: FixedSessionContext, id: string) { const row = (await client.query('SELECT * FROM platform_career_identity_operations WHERE user_id=$1 AND record_id=$2 ORDER BY applied_revision DESC LIMIT 1 FOR SHARE', [s.userId, id])).rows[0]; if (!row)
        throw unavailable(); return this.receipt(s, row); }
    private decode(s: FixedSessionContext, row: any, latest: Receipt | undefined): Readonly<CareerIdentityRecord> {
        try {
            const raw = this.storage.crypto!.openUtf8(row.value_ciphertext, { table: 'platform_career_identity_dates', column: 'value_ciphertext', rowId: row.id, ownerId: s.userId, revision: row.revision }), record = parseCareerIdentityRecord(JSON.parse(raw));
            if (canonical(record) !== raw || record.id !== row.id || record.ownerId !== s.userId || record.field !== row.field || record.sensitivity !== row.sensitivity || record.source !== row.source || record.revision !== row.revision || record.lastOperationId !== row.last_operation_id || record.createdAt !== row.created_at.toISOString() || record.updatedAt !== row.updated_at.toISOString() || record.confirmedAt !== row.confirmed_at.toISOString() || !latest || latest.action === 'delete' || latest.appliedRevision !== record.revision || latest.operationId !== record.lastOperationId || latest.createdAt !== record.updatedAt)
                throw unavailable();
            return record;
        }
        catch {
            throw unavailable();
        }
    }
    private async all(client: PoolClient, s: FixedSessionContext, signal?: AbortSignal) {
        const rows = (await client.query('SELECT * FROM platform_career_identity_dates WHERE user_id=$1 ORDER BY created_at,id LIMIT 101 FOR SHARE', [s.userId])).rows;
        if (rows.length > 100)
            throw new ApiError(409, 'CAREER_IDENTITY_CAPACITY', 'Reduce the private record list before continuing.');
        const ids = rows.map(r => r.id), proofs = (await client.query('SELECT o.* FROM platform_career_identity_operations o JOIN (SELECT record_id,MAX(applied_revision) revision FROM platform_career_identity_operations WHERE user_id=$1 AND record_id=ANY($2::uuid[]) GROUP BY record_id) p ON p.record_id=o.record_id AND p.revision=o.applied_revision WHERE o.user_id=$1 FOR SHARE OF o', [s.userId, ids])).rows;
        const latest = new Map(proofs.map(r => [r.record_id, this.receipt(s, r)]));
        return Object.freeze(rows.map(row => { signal?.throwIfAborted(); return this.decode(s, row, latest.get(row.id)); }));
    }
    async list(value: FixedSessionContext, query: unknown = {}, signal?: AbortSignal) {
        const s = this.fixed(value);
        try {
            careerRecordObject(query, []);
        }
        catch {
            throw bad();
        }
        return this.db.withBoundedTransaction(async (client) => { await this.authorize(client, s, signal); const records = await this.all(client, s, signal); await authorizeFixedSession(client, s, signal); return Object.freeze({ records }); });
    }
    async get(value: FixedSessionContext, key: unknown, signal?: AbortSignal) {
        const s = this.fixed(value);
        let id: string;
        try {
            id = careerRecordId(key);
        }
        catch {
            throw bad();
        }
        return this.db.withBoundedTransaction(async (client) => { await this.authorize(client, s, signal); const row = (await client.query('SELECT * FROM platform_career_identity_dates WHERE id=$1 AND user_id=$2 FOR SHARE', [id, s.userId])).rows[0]; if (!row)
            throw missing(); const record = this.decode(s, row, await this.latest(client, s, id)); await authorizeFixedSession(client, s, signal); return record; });
    }
    async operation(value: FixedSessionContext, key: unknown, signal?: AbortSignal) {
        const s = this.fixed(value);
        let id: string;
        try {
            id = careerRecordId(key);
        }
        catch {
            throw bad();
        }
        return this.db.withBoundedTransaction(async (client) => { await this.authorize(client, s, signal); const row = (await client.query('SELECT * FROM platform_career_identity_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [s.userId, id])).rows[0]; if (!row)
            throw missing(); const receipt = this.receipt(s, row), result = await this.result(client, s, receipt, true); await authorizeFixedSession(client, s, signal); return result; });
    }
    private async result(client: PoolClient, s: FixedSessionContext, r: Receipt, replayed: boolean) {
        const row = (await client.query('SELECT * FROM platform_career_identity_dates WHERE id=$1 AND user_id=$2 FOR SHARE', [r.recordId, s.userId])).rows[0], latest = await this.latest(client, s, r.recordId);
        if (!row && latest.action !== 'delete')
            throw unavailable();
        const record = row ? this.decode(s, row, latest) : null;
        return Object.freeze({ record, operation: Object.freeze({ id: r.operationId, recordId: r.recordId, appliedRevision: r.appliedRevision, replayed }) });
    }
    async mutate(value: FixedSessionContext, action: CareerIdentityAction, key: unknown, input: unknown, signal?: AbortSignal) {
        const s = this.fixed(value);
        let command: ReturnType<typeof parseCareerIdentityCommand>, requested: string | null;
        try {
            command = parseCareerIdentityCommand(action, input);
            requested = action === 'create' ? null : careerRecordId(key);
        }
        catch {
            throw bad();
        }
        const digest = createHash('sha256').update(canonical({ action, recordId: requested, command })).digest('hex');
        return this.db.withBoundedTransaction(async (client) => {
            const auth = await this.authorize(client, s, signal), old = (await client.query('SELECT * FROM platform_career_identity_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [s.userId, command.operationId])).rows[0];
            if (old) {
                const receipt = this.receipt(s, old);
                if (receipt.commandDigest !== digest || receipt.action !== action || requested !== null && requested !== receipt.recordId)
                    throw new ApiError(409, 'CAREER_IDENTITY_OPERATION_CONFLICT', 'This operation identifier was already used.');
                const result = await this.result(client, s, receipt, true);
                await authorizeFixedSession(client, s, signal);
                return result;
            }
            const id = requested ?? randomUUID();
            let base: Readonly<CareerIdentityRecord> | null = null;
            if (action !== 'create') {
                const row = (await client.query('SELECT * FROM platform_career_identity_dates WHERE user_id=$1 AND id=$2 FOR UPDATE', [s.userId, id])).rows[0];
                if (!row)
                    throw missing();
                base = this.decode(s, row, await this.latest(client, s, id));
                if (command.expectedRevision !== base.revision)
                    throw conflict();
            }
            if (action !== 'delete')
                await this.storage.authorizeSession(client, s, signal);
            if (action === 'edit' && (base!.field !== command.field || base!.field === 'h1b_registration' && (base!.value as {
                year: number;
            }).year !== (command.value as {
                year: number;
            }).year))
                throw new ApiError(409, 'CAREER_IDENTITY_FIELD_CHANGED', 'Use the original field and reporting year.');
            if (action !== 'delete') {
                const all = await this.all(client, s, signal);
                if (action === 'create' && all.length >= 100)
                    throw new ApiError(409, 'CAREER_IDENTITY_CAPACITY', 'Save at most 100 private records.');
                if (action === 'create' && command.field !== 'custom_status_date' && all.some(r => r.field === command.field && (r.field !== 'h1b_registration' || (r.value as {
                    year: number;
                }).year === (command.value as {
                    year: number;
                }).year)))
                    throw new ApiError(409, 'CAREER_IDENTITY_FIELD_EXISTS', 'Edit the existing private field instead.');
            }
            const revision = (base?.revision ?? 0) + 1;
            if (revision > 2147483647)
                throw conflict();
            const at = (await client.query('SELECT date_trunc(\'milliseconds\',clock_timestamp()) at')).rows[0].at.toISOString();
            let record: Readonly<CareerIdentityRecord> | null = null;
            if (action !== 'delete')
                record = parseCareerIdentityRecord({ ...base, id, ownerId: s.userId, field: command.field, value: command.field === 'unemployment_days_reported' ? { ...(command.value as {
                            days: number;
                        }), reportedAt: at } : command.value, label: command.label, source: 'user_entered', sensitivity: command.field === 'program_end_date' || command.field === 'stem_designated' ? 'sensitive' : 'restricted', remindBeforeDays: null, confirmedAt: at, revision, createdAt: base?.createdAt ?? at, updatedAt: at, lastOperationId: command.operationId });
            const receipt: Receipt = { schemaVersion: 1, ownerId: s.userId, operationId: command.operationId, recordId: id, action, commandDigest: digest, appliedRevision: revision, acceptedAuthVersion: String(auth.auth_version), createdAt: at }, sealed = this.storage.crypto!.sealUtf8(canonical(receipt), { table: 'platform_career_identity_operations', column: 'receipt_ciphertext', rowId: command.operationId, ownerId: s.userId, revision });
            await client.query('INSERT INTO platform_career_identity_operations(user_id,operation_id,record_id,action,applied_revision,created_at,receipt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)', [s.userId, command.operationId, id, action, revision, at, sealed]);
            if (record) {
                const encrypted = this.storage.crypto!.sealUtf8(canonical(record), { table: 'platform_career_identity_dates', column: 'value_ciphertext', rowId: id, ownerId: s.userId, revision });
                await client.query('INSERT INTO platform_career_identity_dates(id,user_id,field,sensitivity,source,revision,last_operation_id,value_ciphertext,created_at,updated_at,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,last_operation_id=EXCLUDED.last_operation_id,value_ciphertext=EXCLUDED.value_ciphertext,updated_at=EXCLUDED.updated_at,confirmed_at=EXCLUDED.confirmed_at', [id, s.userId, record.field, record.sensitivity, record.source, revision, command.operationId, encrypted, record.createdAt, at]);
            }
            else
                await client.query('DELETE FROM platform_career_identity_dates WHERE id=$1 AND user_id=$2', [id, s.userId]);
            await authorizeFixedSession(client, s, signal);
            signal?.throwIfAborted();
            return Object.freeze({ record, operation: Object.freeze({ id: command.operationId, recordId: id, appliedRevision: revision, replayed: false }) });
        });
    }
}
