import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId, careerRecordObject, parseCareerInterview, parseCareerInterviewCommand, type CareerInterview, type CareerInterviewAction, type CareerInterviewOperation } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import type { CareerApplications } from './career-applications.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { ApiError } from './errors.ts';
const unavailable = () => new ApiError(503, 'CAREER_INTERVIEW_STORAGE_UNAVAILABLE', '面试记录暂时无法核对，请重新读取。');
const bad = () => new ApiError(400, 'CAREER_INTERVIEW_INPUT_INVALID', '请核对面试时间、时区和当前版本。');
const missing = () => new ApiError(404, 'NOT_FOUND', '没有找到这场面试。');
const canonical = (v: unknown) => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
interface Receipt {
    schemaVersion: 1;
    ownerId: string;
    operationId: string;
    interviewId: string;
    action: CareerInterviewAction;
    appliedRevision: number;
    commandDigest: string;
    recordDigest: string;
    acceptedAuthVersion: string;
    createdAt: string;
}
/** Owner-entered schedules only. No conversation, model, calendar, reminder, or application-stage writes. */
export class CareerInterviews {
    private readonly storage: OnboardingStorage;
    constructor(private readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail'>, legal: LegalBundle | null, private readonly applications: Pick<CareerApplications, 'readInTransaction'>) { this.storage = new OnboardingStorage(config, legal); }
    private fixed(value: FixedSessionContext): FixedSessionContext {
        try {
            const v = careerRecordObject(value, ['userId', 'tokenHash']);
            if (typeof v.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.tokenHash))
                throw bad();
            return Object.freeze({ userId: careerRecordId(v.userId), tokenHash: v.tokenHash });
        }
        catch {
            throw new ApiError(401, 'AUTH_REQUIRED', '请重新登录。');
        }
    }
    private async authorize(c: PoolClient, s: FixedSessionContext, signal?: AbortSignal) {
        await authorizeFixedSession(c, s, signal);
        const row = (await c.query('SELECT account_kind,auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [s.userId])).rows[0];
        if (row?.account_kind !== 'student')
            throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', '请使用学生账号。');
        if (!this.storage.crypto)
            throw unavailable();
        signal?.throwIfAborted();
        return String(row.auth_version);
    }
    private receipt(s: FixedSessionContext, row: any): Receipt {
        try {
            const raw = this.storage.crypto!.openUtf8(row.receipt_ciphertext, { table: 'platform_career_interview_operations', column: 'receipt_ciphertext', rowId: row.operation_id, ownerId: s.userId, revision: row.applied_revision });
            const r = careerRecordObject(JSON.parse(raw), ['schemaVersion', 'ownerId', 'operationId', 'interviewId', 'action', 'appliedRevision', 'commandDigest', 'recordDigest', 'acceptedAuthVersion', 'createdAt']);
            if (canonical(r) !== raw || r.schemaVersion !== 1 || r.ownerId !== s.userId || r.operationId !== row.operation_id || r.interviewId !== row.interview_id || r.action !== row.action || r.appliedRevision !== row.applied_revision || r.createdAt !== row.created_at.toISOString() || ![r.commandDigest, r.recordDigest].every(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) || typeof r.acceptedAuthVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(r.acceptedAuthVersion))
                throw unavailable();
            return r as unknown as Receipt;
        }
        catch {
            throw unavailable();
        }
    }
    private async operation(c: PoolClient, s: FixedSessionContext, id: string) { return (await c.query('SELECT * FROM platform_career_interview_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [s.userId, id])).rows[0]; }
    private async latest(c: PoolClient, s: FixedSessionContext, id: string) {
        const row = (await c.query('SELECT * FROM platform_career_interview_operations WHERE user_id=$1 AND interview_id=$2 ORDER BY applied_revision DESC LIMIT 1 FOR SHARE', [s.userId, id])).rows[0];
        if (!row)
            throw unavailable();
        return this.receipt(s, row);
    }
    private async row(c: PoolClient, s: FixedSessionContext, id: string) { return (await c.query('SELECT * FROM platform_career_interviews WHERE user_id=$1 AND id=$2 FOR UPDATE', [s.userId, id])).rows[0]; }
    private async record(c: PoolClient, s: FixedSessionContext, row: any, known?: Receipt): Promise<Readonly<CareerInterview>> {
        try {
            const raw = this.storage.crypto!.openUtf8(row.record_ciphertext, { table: 'platform_career_interviews', column: 'record_ciphertext', rowId: row.id, ownerId: s.userId, revision: row.revision });
            const v = parseCareerInterview(JSON.parse(raw)), r = known ?? await this.latest(c, s, row.id);
            if (canonical(v) !== raw || digest(v) !== r.recordDigest || v.id !== row.id || v.ownerId !== s.userId || v.application.id !== row.application_id || v.status !== row.status || v.revision !== row.revision || v.lastOperationId !== row.last_operation_id || v.createdAt !== row.created_at.toISOString() || v.updatedAt !== row.updated_at.toISOString() || r.interviewId !== v.id || r.action === 'delete' || r.operationId !== v.lastOperationId || r.appliedRevision !== v.revision || r.createdAt !== v.updatedAt)
                throw unavailable();
            return v;
        }
        catch {
            throw unavailable();
        }
    }
    private async result(c: PoolClient, s: FixedSessionContext, r: Receipt) {
        const row = await this.row(c, s, r.interviewId);
        if (row)
            return this.record(c, s, row);
        const latest = await this.latest(c, s, r.interviewId);
        if (latest.action !== 'delete' || latest.recordDigest !== digest(null))
            throw unavailable();
        return null;
    }
    private ack(r: Receipt, replayed: boolean): Readonly<CareerInterviewOperation> { return Object.freeze({ id: r.operationId, interviewId: r.interviewId, action: r.action, appliedRevision: r.appliedRevision, replayed }); }
    private key(value: unknown) { try {
        return careerRecordId(value);
    }
    catch {
        throw bad();
    } }
    async get(value: FixedSessionContext, key: unknown, signal?: AbortSignal) {
        const s = this.fixed(value), id = this.key(key);
        return this.db.withBoundedTransaction(async (c) => { await this.authorize(c, s, signal); const row = await this.row(c, s, id); if (!row)
            throw missing(); const result = await this.record(c, s, row); await authorizeFixedSession(c, s, signal); return result; });
    }
    async observe(value: FixedSessionContext, key: unknown, signal?: AbortSignal) {
        const s = this.fixed(value), id = this.key(key);
        return this.db.withBoundedTransaction(async (c) => { await this.authorize(c, s, signal); const row = await this.operation(c, s, id); if (!row)
            throw missing(); const r = this.receipt(s, row), interview = await this.result(c, s, r); await authorizeFixedSession(c, s, signal); return Object.freeze({ interview, operation: this.ack(r, true) }); });
    }
    async list(value: FixedSessionContext, query: unknown = {}, signal?: AbortSignal) {
        const s = this.fixed(value);
        let after: string | null, status: string | null;
        try {
            const q = careerRecordObject(query, [], ['after', 'status']);
            after = Object.hasOwn(q, 'after') ? careerRecordId(q.after) : null;
            status = Object.hasOwn(q, 'status') ? q.status as string : null;
            if (status !== null && !['scheduled', 'rescheduled', 'done', 'cancelled'].includes(status))
                throw bad();
        }
        catch {
            throw bad();
        }
        return this.db.withBoundedTransaction(async (c) => {
            await this.authorize(c, s, signal);
            let cursor: any = null;
            if (after) {
                cursor = (await c.query('SELECT *,created_at::text AS cursor_time FROM platform_career_interviews WHERE user_id=$1 AND id=$2 FOR UPDATE', [s.userId, after])).rows[0];
                if (!cursor)
                    throw missing();
                await this.record(c, s, cursor);
            }
            const rows = (await c.query('SELECT * FROM platform_career_interviews WHERE user_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51 FOR SHARE', [s.userId, status, cursor?.cursor_time ?? null, after])).rows;
            const page = rows.slice(0, 50), proofs = page.length ? (await c.query(`SELECT o.* FROM platform_career_interview_operations o JOIN
    (SELECT interview_id,max(applied_revision) AS revision FROM platform_career_interview_operations WHERE user_id=$1 AND interview_id=ANY($2::uuid[]) GROUP BY interview_id) latest
    ON latest.interview_id=o.interview_id AND latest.revision=o.applied_revision WHERE o.user_id=$1 FOR SHARE OF o`, [s.userId, page.map(r => r.id)])).rows : [];
            const latest = new Map<string, Receipt>();
            for (const row of proofs) {
                signal?.throwIfAborted();
                const r = this.receipt(s, row);
                if (latest.has(r.interviewId))
                    throw unavailable();
                latest.set(r.interviewId, r);
            }
            const interviews = [];
            for (const row of page) {
                signal?.throwIfAborted();
                const r = latest.get(row.id);
                if (!r)
                    throw unavailable();
                interviews.push(await this.record(c, s, row, r));
            }
            await authorizeFixedSession(c, s, signal);
            return Object.freeze({ interviews: Object.freeze(interviews), nextAfter: rows.length > 50 ? interviews.at(-1)!.id : null });
        });
    }
    async mutate(value: FixedSessionContext, action: CareerInterviewAction, key: unknown, input: unknown, signal?: AbortSignal) {
        const s = this.fixed(value);
        let command: ReturnType<typeof parseCareerInterviewCommand>, requested: string | null;
        try {
            command = parseCareerInterviewCommand(action, input);
            requested = action === 'create' ? null : careerRecordId(key);
        }
        catch {
            throw bad();
        }
        const commandDigest = digest({ action, interviewId: requested, command });
        return this.db.withBoundedTransaction(async (c) => {
            const version = await this.authorize(c, s, signal), prior = await this.operation(c, s, command.operationId);
            if (prior) {
                const r = this.receipt(s, prior);
                if (r.commandDigest !== commandDigest || r.action !== action || requested !== null && r.interviewId !== requested)
                    throw new ApiError(409, 'CAREER_INTERVIEW_OPERATION_CONFLICT', '这个操作已用于其他记录，请重新核对。');
                const interview = await this.result(c, s, r);
                await authorizeFixedSession(c, s, signal);
                return Object.freeze({ interview, operation: this.ack(r, true) });
            }
            if (action !== 'delete')
                await this.storage.authorizeSession(c, s, signal);
            const id = requested ?? randomUUID();
            let base: Readonly<CareerInterview> | null = null, application: CareerInterview['application'] | null = null;
            if (command.action === 'create') {
                const source = await this.applications.readInTransaction(c, s, command.applicationId, signal);
                if (source.revision !== command.applicationRevision)
                    throw new ApiError(409, 'CAREER_INTERVIEW_SOURCE_CHANGED', '申请记录有变化，请重新读取。');
                application = { id: source.id, ownerId: s.userId, revision: source.revision, employer: source.job.employer, title: source.job.title, roleFamily: source.job.roleFamily };
                if ((await c.query('SELECT count(*)::integer AS count FROM platform_career_interviews WHERE user_id=$1', [s.userId])).rows[0].count >= 500)
                    throw new ApiError(409, 'CAREER_INTERVIEW_CAPACITY', '面试记录已满，请先整理。');
            }
            else {
                const row = await this.row(c, s, id);
                if (!row)
                    throw missing();
                base = await this.record(c, s, row);
                if (base.revision !== command.expectedRevision || base.revision === 2147483647)
                    throw new ApiError(409, 'CAREER_INTERVIEW_REVISION_CONFLICT', '面试记录有变化，请先读取最新版本。');
            }
            const at = (await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString(), revision = (base?.revision ?? 0) + 1;
            let interview: Readonly<CareerInterview> | null = null;
            if (command.action === 'create')
                interview = parseCareerInterview({ id, ownerId: s.userId, revision, lastOperationId: command.operationId, createdAt: at, updatedAt: at, source: 'user_recorded', application, roundType: command.roundType, startsAt: command.startsAt, timeZone: command.timeZone, durationMin: command.durationMin, status: 'scheduled', briefId: null, debrief: null });
            else if (command.action !== 'delete') {
                const patch = command.action === 'edit' ? { roundType: command.roundType, durationMin: command.durationMin } : command.action === 'reschedule' ? { startsAt: command.startsAt, timeZone: command.timeZone, status: 'rescheduled' as const } : { status: command.status };
                interview = parseCareerInterview({ ...base!, ...patch, revision, lastOperationId: command.operationId, updatedAt: at });
            }
            const r: Receipt = { schemaVersion: 1, ownerId: s.userId, operationId: command.operationId, interviewId: id, action, appliedRevision: revision, commandDigest, recordDigest: digest(interview), acceptedAuthVersion: version, createdAt: at };
            const receipt = this.storage.crypto!.sealUtf8(canonical(r), { table: 'platform_career_interview_operations', column: 'receipt_ciphertext', rowId: command.operationId, ownerId: s.userId, revision });
            await c.query('INSERT INTO platform_career_interview_operations(user_id,operation_id,interview_id,action,applied_revision,created_at,receipt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)', [s.userId, command.operationId, id, action, revision, at, receipt]);
            if (interview) {
                const cipher = this.storage.crypto!.sealUtf8(canonical(interview), { table: 'platform_career_interviews', column: 'record_ciphertext', rowId: id, ownerId: s.userId, revision });
                if (action === 'create')
                    await c.query('INSERT INTO platform_career_interviews(id,user_id,application_id,revision,last_operation_id,status,created_at,updated_at,record_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)', [id, s.userId, application!.id, revision, command.operationId, interview.status, at, cipher]);
                else
                    await c.query('UPDATE platform_career_interviews SET revision=$3,last_operation_id=$4,status=$5,updated_at=$6,record_ciphertext=$7 WHERE id=$1 AND user_id=$2', [id, s.userId, revision, command.operationId, interview.status, at, cipher]);
            }
            else
                await c.query('DELETE FROM platform_career_interviews WHERE id=$1 AND user_id=$2', [id, s.userId]);
            await authorizeFixedSession(c, s, signal);
            signal?.throwIfAborted();
            return Object.freeze({ interview, operation: this.ack(r, false) });
        });
    }
}
