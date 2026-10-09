import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordObject, careerRecordId, careerProfileRevision, parseCareerProfile, parseCareerProfileCommand, type CareerProfile, type CareerProfileAction, type CareerProfileSnapshot } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import type { OwnedCareerProfile } from './career-run-context.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { accountExportRows } from './account-export-rows.ts';
import { ApiError } from './errors.ts';
const canonical = (value: unknown): string => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const unavailable = () => new ApiError(503, 'CAREER_PROFILE_UNAVAILABLE', 'The saved career profile could not be confirmed.');
const bad = () => new ApiError(400, 'CAREER_PROFILE_INPUT_INVALID', 'Use explicit career profile facts.');
const missing = () => new ApiError(404, 'NOT_FOUND', 'The career profile operation was not found.');
const changed = () => new ApiError(409, 'CAREER_PROFILE_REVISION_CHANGED', 'Read the current career profile before changing it.');
interface Receipt {
    schemaVersion: 1;
    ownerId: string;
    operationId: string;
    action: CareerProfileAction;
    commandDigest: string;
    recordDigest: string | null;
    appliedRevision: number;
    acceptedAuthVersion: string;
    createdAt: string;
}
/** A single owner-confirmed record. Unknown fields stay unknown; this does not
 * rewrite intake history, create active targets or authorize model execution. */
export class CareerProfiles {
    private readonly storage: OnboardingStorage;
    constructor(private readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, legal: LegalBundle | null) { this.storage = new OnboardingStorage(config, legal); }
    private fixed(value: FixedSessionContext): Readonly<FixedSessionContext> {
        try {
            const v = careerRecordObject(value, ['userId', 'tokenHash']);
            if (typeof v.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.tokenHash))
                throw bad();
            return Object.freeze({ userId: careerRecordId(v.userId), tokenHash: v.tokenHash });
        }
        catch {
            throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
        }
    }
    private async authorize(c: PoolClient, s: FixedSessionContext, signal?: AbortSignal) {
        await authorizeFixedSession(c, s, signal);
        const row = (await c.query('SELECT account_kind,auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [s.userId])).rows[0];
        if (row?.account_kind !== 'student')
            throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', 'Use a student account.');
        if (!this.storage.crypto)
            throw unavailable();
        signal?.throwIfAborted();
        return row;
    }
    private receipt(s: FixedSessionContext, row: any): Receipt {
        try {
            const raw = this.storage.crypto!.openUtf8(row.receipt_ciphertext, { table: 'platform_career_profile_operations', column: 'receipt_ciphertext', rowId: row.operation_id, ownerId: s.userId, revision: row.applied_revision });
            const r = careerRecordObject(JSON.parse(raw), ['schemaVersion', 'ownerId', 'operationId', 'action', 'commandDigest', 'recordDigest', 'appliedRevision', 'acceptedAuthVersion', 'createdAt']);
            if (canonical(r) !== raw || r.schemaVersion !== 1 || r.ownerId !== s.userId || r.operationId !== row.operation_id || r.action !== row.action
                || !['save', 'delete'].includes(String(r.action)) || r.appliedRevision !== row.applied_revision || r.createdAt !== row.created_at.toISOString()
                || typeof r.commandDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.commandDigest)
                || typeof r.acceptedAuthVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(r.acceptedAuthVersion)
                || (r.action === 'delete' ? r.recordDigest !== null : typeof r.recordDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.recordDigest)))
                throw unavailable();
            careerProfileRevision(r.appliedRevision, 1);
            careerRecordId(r.operationId);
            return r as unknown as Receipt;
        }
        catch {
            throw unavailable();
        }
    }
    private async state(c: PoolClient, s: FixedSessionContext): Promise<Readonly<CareerProfileSnapshot>> {
        const row = (await c.query('SELECT * FROM platform_career_profiles WHERE user_id=$1 FOR UPDATE', [s.userId])).rows[0];
        const last = (await c.query('SELECT * FROM platform_career_profile_operations WHERE user_id=$1 ORDER BY applied_revision DESC LIMIT 1 FOR SHARE', [s.userId])).rows[0];
        const receipt = last ? this.receipt(s, last) : null;
        if (!row) {
            if (receipt && receipt.action !== 'delete')
                throw unavailable();
            return Object.freeze({ ownerId: s.userId, revision: receipt?.appliedRevision ?? 0, profile: null });
        }
        try {
            if (!receipt || receipt.action !== 'save')
                throw unavailable();
            const raw = this.storage.crypto!.openUtf8(row.record_ciphertext, { table: 'platform_career_profiles', column: 'record_ciphertext', rowId: s.userId, ownerId: s.userId, revision: row.revision });
            const profile = parseCareerProfile(JSON.parse(raw));
            if (canonical(profile) !== raw || profile.ownerId !== s.userId || profile.revision !== row.revision || profile.lastOperationId !== row.last_operation_id
                || profile.createdAt !== row.created_at.toISOString() || profile.updatedAt !== row.updated_at.toISOString()
                || receipt.appliedRevision !== profile.revision || receipt.operationId !== profile.lastOperationId || receipt.createdAt !== profile.updatedAt
                || receipt.recordDigest !== digest(profile))
                throw unavailable();
            return Object.freeze({ ownerId: s.userId, revision: profile.revision, profile });
        }
        catch {
            throw unavailable();
        }
    }
    async get(value: FixedSessionContext, signal?: AbortSignal) {
        const s = this.fixed(value);
        return this.db.withBoundedTransaction(async (c) => {
            await this.authorize(c, s, signal);
            const current = await this.state(c, s);
            await authorizeFixedSession(c, s, signal);
            signal?.throwIfAborted();
            return current;
        });
    }
    async observe(value: FixedSessionContext, key: unknown, signal?: AbortSignal) {
        const s = this.fixed(value);
        let id: string;
        try {
            id = careerRecordId(key);
        }
        catch {
            throw bad();
        }
        return this.db.withBoundedTransaction(async (c) => {
            await this.authorize(c, s, signal);
            const row = (await c.query('SELECT * FROM platform_career_profile_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [s.userId, id])).rows[0];
            if (!row)
                throw missing();
            const r = this.receipt(s, row), current = await this.state(c, s);
            await authorizeFixedSession(c, s, signal);
            signal?.throwIfAborted();
            return Object.freeze({ ...current, operation: Object.freeze({ id: r.operationId, action: r.action, appliedRevision: r.appliedRevision, replayed: true }) });
        });
    }
    async mutate(value: FixedSessionContext, action: CareerProfileAction, input: unknown, signal?: AbortSignal) {
        const s = this.fixed(value);
        let command: ReturnType<typeof parseCareerProfileCommand>;
        try {
            command = parseCareerProfileCommand(action, input);
        }
        catch {
            throw bad();
        }
        const commandDigest = digest({ action, command });
        return this.db.withBoundedTransaction(async (c) => {
            const auth = await this.authorize(c, s, signal), prior = (await c.query('SELECT * FROM platform_career_profile_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [s.userId, command.operationId])).rows[0];
            const current = await this.state(c, s);
            if (prior) {
                const r = this.receipt(s, prior);
                if (r.commandDigest !== commandDigest || r.action !== action)
                    throw new ApiError(409, 'CAREER_PROFILE_OPERATION_CONFLICT', 'The profile operation was already used.');
                await authorizeFixedSession(c, s, signal);
                signal?.throwIfAborted();
                return Object.freeze({ ...current, operation: Object.freeze({ id: r.operationId, action: r.action, appliedRevision: r.appliedRevision, replayed: true }) });
            }
            if (command.expectedRevision !== current.revision)
                throw changed();
            if (action === 'delete' && !current.profile)
                throw missing();
            if (action === 'save')
                await this.storage.authorizeSession(c, s, signal);
            const revision = current.revision + 1;
            if (revision > 2147483647)
                throw changed();
            const at = (await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
            const profile: Readonly<CareerProfile> | null = action === 'delete' ? null : parseCareerProfile({ ...command.facts, id: s.userId, ownerId: s.userId, revision, source: 'user_entered',
                createdAt: current.profile?.createdAt ?? at, updatedAt: at, confirmedAt: at, lastOperationId: command.operationId });
            const receipt: Receipt = { schemaVersion: 1, ownerId: s.userId, operationId: command.operationId, action, commandDigest, recordDigest: profile ? digest(profile) : null,
                appliedRevision: revision, acceptedAuthVersion: String(auth.auth_version), createdAt: at };
            const encrypted = this.storage.crypto!.sealUtf8(canonical(receipt), { table: 'platform_career_profile_operations', column: 'receipt_ciphertext', rowId: command.operationId, ownerId: s.userId, revision });
            await c.query('INSERT INTO platform_career_profile_operations(user_id,operation_id,action,applied_revision,created_at,receipt_ciphertext) VALUES($1,$2,$3,$4,$5,$6)', [s.userId, command.operationId, action, revision, at, encrypted]);
            if (profile) {
                const sealed = this.storage.crypto!.sealUtf8(canonical(profile), { table: 'platform_career_profiles', column: 'record_ciphertext', rowId: s.userId, ownerId: s.userId, revision });
                await c.query(`INSERT INTO platform_career_profiles(user_id,revision,last_operation_id,record_ciphertext,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,last_operation_id=EXCLUDED.last_operation_id,record_ciphertext=EXCLUDED.record_ciphertext,
      created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at`, [s.userId, revision, command.operationId, sealed, profile.createdAt, at]);
            }
            else
                await c.query('DELETE FROM platform_career_profiles WHERE user_id=$1', [s.userId]);
            await authorizeFixedSession(c, s, signal);
            signal?.throwIfAborted();
            return Object.freeze({ ownerId: s.userId, revision, profile, operation: Object.freeze({ id: command.operationId, action, appliedRevision: revision, replayed: false }) });
        });
    }
    /** Structured normal-sensitivity fields only; no identity dates or free text. */
    async readForPreparationInTransaction(c: PoolClient, value: FixedSessionContext, signal?: AbortSignal): Promise<Readonly<OwnedCareerProfile> | null> {
        const s = this.fixed(value);
        await this.authorize(c, s, signal);
        await this.storage.authorizeSession(c, s, signal);
        const { profile: p } = await this.state(c, s);
        await authorizeFixedSession(c, s, signal);
        signal?.throwIfAborted();
        if (!p)
            return null;
        const degrees = { cs: 'CS', ds_statistics: 'DS / 统计', ece_ee: 'ECE / EE', other_stem: '其他 STEM' };
        const roles = { swe: 'Software Engineering', mle: 'Machine Learning Engineering', ds: 'Data Science', da: 'Data Analytics', de: 'Data Engineering', hw: 'Hardware', other: '其他方向' };
        return Object.freeze({ ownerId: s.userId, id: p.id, revision: p.revision, state: 'current',
            confirmed: Object.freeze({ degree: p.degreeField !== null, graduation: p.graduationMonth !== null, roleFamily: p.targetTracks.length > 0 }),
            normalSummary: `本人确认的专业方向：${p.degreeField ? degrees[p.degreeField] : '未填写'}；毕业年月：${p.graduationMonth ?? '未填写'}；已毕业：${p.graduated === null ? '未填写' : p.graduated ? '是' : '否'}；岗位家族：${p.targetTracks.map(t => roles[t]).join('、') || '未确定'}。` });
    }
    async *exportInTransaction(c: PoolClient, value: FixedSessionContext, signal?: AbortSignal) {
        const s = this.fixed(value);
        await this.authorize(c, s, signal);
        const current = await this.state(c, s);
        if (current.profile)
            yield { section: 'careerProfile' as const, record: current.profile };
        for await (const row of accountExportRows(c, s.userId, 'platform_career_profile_operations', signal)) {
            const r = this.receipt(s, row);
            yield { section: 'careerProfileOperations' as const, record: { id: r.operationId, action: r.action, revision: r.appliedRevision, createdAt: r.createdAt } };
        }
        await authorizeFixedSession(c, s, signal);
        signal?.throwIfAborted();
    }
}
