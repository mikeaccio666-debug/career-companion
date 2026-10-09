import {ProductEvents} from './product-events.ts';
import { accountExportRows } from './account-export-rows.ts';
import type { OwnedCareerApplication, OwnedCareerSavedJob } from './career-run-context.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId, careerRecordObject, parseCareerApplication, parseCareerApplicationCommand, parseCareerApplicationEvent, careerApplicationSummary, manualJobSummary, type CareerApplication, type CareerApplicationAction, type CareerApplicationEvent, type ApplicationStageState } from '@companion/platform-contracts';
import { type CareerEvidence, planApplicationStageChange, applicationNeedsPostRejection } from '@companion/career-core';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import type { ManualJobs } from './manual-jobs.ts';
import { ApiError } from './errors.ts';
const unavailable = () => new ApiError(503, 'CAREER_APPLICATION_STORAGE_UNAVAILABLE', '申请记录暂时无法核对，请重新读取。');
const bad = () => new ApiError(400, 'CAREER_APPLICATION_INPUT_INVALID', '请使用当前申请版本和明确的阶段信息。');
const missing = () => new ApiError(404, 'NOT_FOUND', '没有找到这份申请记录。');
const canonical = (v: unknown) => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const state = (v: CareerApplication): ApplicationStageState => ({ stage: v.stage, closedReason: v.closedReason, closedAtStage: v.closedAtStage, offerState: v.offerState, submittedVia: v.submittedVia });
interface Receipt {
    schemaVersion: 1;
    ownerId: string;
    operationId: string;
    applicationId: string;
    action: CareerApplicationAction;
    appliedRevision: number;
    commandDigest: string;
    recordDigest: string;
    eventDigest: string;
    acceptedAuthVersion: string;
    createdAt: string;
}
interface PreparationProofs {
    latest: ReadonlyMap<string, Receipt>;
    operations: ReadonlyMap<string, Receipt>;
    events: ReadonlyMap<string, any>;
}
/** Owner records and restriction sources only. No model, receipt issuer,
 * trusted click, overlay-clearing, notification or execution port. */
export class CareerApplications {
    private readonly storage: OnboardingStorage;
    private readonly productEvents:ProductEvents;
    constructor(private readonly db: Database, config: Pick<PlatformConfig, 'dataCrypto' | 'requireVerifiedEmail' | 'productEventsEnabled'>, legal: LegalBundle | null, private readonly jobs: Pick<ManualJobs, 'readInTransaction' | 'readForPreparationInTransaction'>) { this.storage = new OnboardingStorage(config, legal); this.productEvents=new ProductEvents(config); }
    private fixed(value: FixedSessionContext) {
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
    private async authorize(client: PoolClient, context: FixedSessionContext, signal?: AbortSignal) {
        await authorizeFixedSession(client, context, signal);
        const row = (await client.query('SELECT account_kind,auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [context.userId])).rows[0];
        if (row?.account_kind !== 'student')
            throw new ApiError(403, 'STUDENT_ACCOUNT_REQUIRED', '请使用学生账号。');
        if (!this.storage.crypto)
            throw unavailable();
        signal?.throwIfAborted();
        return String(row.auth_version);
    }
    private async receipt(context: FixedSessionContext, row: any): Promise<Receipt> {
        try {
            const raw = this.storage.crypto!.openUtf8(row.receipt_ciphertext, { table: 'platform_career_application_operations', column: 'receipt_ciphertext', rowId: row.operation_id, ownerId: context.userId, revision: row.applied_revision });
            const r = careerRecordObject(JSON.parse(raw), ['schemaVersion', 'ownerId', 'operationId', 'applicationId', 'action', 'appliedRevision', 'commandDigest', 'recordDigest', 'eventDigest', 'acceptedAuthVersion', 'createdAt']);
            if (canonical(r) !== raw || r.schemaVersion !== 1 || r.ownerId !== context.userId || r.operationId !== row.operation_id || r.applicationId !== row.application_id || r.action !== row.action || r.appliedRevision !== row.applied_revision || r.createdAt !== row.created_at.toISOString() || ![r.commandDigest, r.recordDigest, r.eventDigest].every(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) || typeof r.acceptedAuthVersion !== 'string' || !/^(0|[1-9][0-9]*)$/.test(r.acceptedAuthVersion))
                throw unavailable();
            return r as unknown as Receipt;
        }
        catch {
            throw unavailable();
        }
    }
    private async operation(client: PoolClient, context: FixedSessionContext, id: string) { return (await client.query('SELECT * FROM platform_career_application_operations WHERE user_id=$1 AND operation_id=$2 FOR SHARE', [context.userId, id])).rows[0]; }
    private async latest(client: PoolClient, context: FixedSessionContext, id: string) {
        const row = (await client.query('SELECT * FROM platform_career_application_operations WHERE user_id=$1 AND application_id=$2 ORDER BY applied_revision DESC LIMIT 1 FOR SHARE', [context.userId, id])).rows[0];
        if (!row)
            throw unavailable();
        return this.receipt(context, row);
    }
    private async event(client: PoolClient, context: FixedSessionContext, row: any, known?: Receipt): Promise<Readonly<CareerApplicationEvent>> {
        try {
            const r = known ?? await this.receipt(context, await this.operation(client, context, row.id));
            const raw = this.storage.crypto!.openUtf8(row.event_ciphertext, { table: 'platform_career_application_events', column: 'event_ciphertext', rowId: row.id, ownerId: context.userId, revision: row.revision }), v = parseCareerApplicationEvent(JSON.parse(raw));
            if (canonical(v) !== raw || hash(v) !== r.eventDigest || v.id !== row.id || v.ownerId !== context.userId || v.applicationId !== row.application_id || v.revision !== row.revision || v.action !== row.action || v.createdAt !== row.created_at.toISOString() || v.careWindowUntil !== (row.care_until?.toISOString() ?? null) || r.operationId !== v.id || r.applicationId !== v.applicationId || r.appliedRevision !== v.revision || r.action !== v.action || r.createdAt !== v.createdAt)
                throw unavailable();
            return v;
        }
        catch {
            throw unavailable();
        }
    }
    private async row(client: PoolClient, context: FixedSessionContext, id: string) { return (await client.query('SELECT * FROM platform_career_applications WHERE user_id=$1 AND id=$2 FOR UPDATE', [context.userId, id])).rows[0]; }
    private async record(client: PoolClient, context: FixedSessionContext, row: any, proofs?: PreparationProofs): Promise<Readonly<CareerApplication>> {
        try {
            const raw = this.storage.crypto!.openUtf8(row.record_ciphertext, { table: 'platform_career_applications', column: 'record_ciphertext', rowId: row.id, ownerId: context.userId, revision: row.revision }), v = parseCareerApplication(JSON.parse(raw)), r = proofs ? proofs.latest.get(row.id) : await this.latest(client, context, row.id);
            if (!r)
                throw unavailable();
            if (canonical(v) !== raw || hash(v) !== r.recordDigest || v.id !== row.id || v.ownerId !== context.userId || v.job.id !== row.job_observation_id || v.stage !== row.stage || v.revision !== row.revision || v.lastOperationId !== row.last_operation_id || v.createdAt !== row.created_at.toISOString() || v.updatedAt !== row.updated_at.toISOString() || r.action === 'delete' || r.operationId !== v.lastOperationId || r.appliedRevision !== v.revision || r.createdAt !== v.updatedAt)
                throw unavailable();
            const current = proofs ? proofs.events.get(v.lastOperationId) : (await client.query('SELECT * FROM platform_career_application_events WHERE user_id=$1 AND id=$2 FOR SHARE', [context.userId, v.lastOperationId])).rows[0];
            if (!current)
                throw unavailable();
            const event = await this.event(client, context, current, r);
            if (canonical(event.next) !== canonical(state(v)))
                throw unavailable();
            if (v.careWindow) {
                const source = proofs ? proofs.events.get(v.careWindow.sourceEventId) : (await client.query('SELECT * FROM platform_career_application_events WHERE user_id=$1 AND id=$2 FOR SHARE', [context.userId, v.careWindow.sourceEventId])).rows[0];
                if (!source)
                    throw unavailable();
                const sourceReceipt = proofs?.operations.get(v.careWindow.sourceEventId);
                if (proofs && !sourceReceipt)
                    throw unavailable();
                const e = await this.event(client, context, source, sourceReceipt);
                if (e.applicationId !== v.id || e.revision !== v.careWindow.eventRevision || e.createdAt !== v.careWindow.startedAt || e.careWindowUntil !== v.careWindow.until || !applicationNeedsPostRejection(e.next) || applicationNeedsPostRejection(e.previous))
                    throw unavailable();
            }
            return v;
        }
        catch {
            throw unavailable();
        }
    }
    private async result(client: PoolClient, context: FixedSessionContext, r: Receipt) {
        const row = await this.row(client, context, r.applicationId);
        if (row)
            return this.record(client, context, row);
        const latest = await this.latest(client, context, r.applicationId);
        if (latest.action !== 'delete' || latest.recordDigest !== hash(null))
            throw unavailable();
        const tombstone = (await client.query('SELECT * FROM platform_career_application_events WHERE user_id=$1 AND id=$2', [context.userId, latest.operationId])).rows[0];
        if (!tombstone || !(await this.event(client, context, tombstone, latest)).previous)
            throw unavailable();
        return null;
    }
    private ack(r: Receipt, replayed: boolean) { return Object.freeze({ id: r.operationId, applicationId: r.applicationId, action: r.action, appliedRevision: r.appliedRevision, replayed }); }
    /** Caller holds the authenticated owner lock. Batch proofs avoid using a
     * first-page summary or unauthenticated SQL counts as the ledger. */
    private async currentRecords(client: PoolClient, context: FixedSessionContext, signal?: AbortSignal) {
        const rows = (await client.query('SELECT * FROM platform_career_applications WHERE user_id=$1 ORDER BY id LIMIT 501 FOR SHARE', [context.userId])).rows;
        if (rows.length > 500)
            throw unavailable();
        const latestRows = rows.length ? (await client.query(`SELECT o.* FROM platform_career_application_operations o JOIN
          (SELECT application_id,max(applied_revision) AS revision FROM platform_career_application_operations WHERE user_id=$1 AND application_id=ANY($2::uuid[]) GROUP BY application_id) latest
          ON latest.application_id=o.application_id AND latest.revision=o.applied_revision WHERE o.user_id=$1 FOR SHARE OF o`, [context.userId, rows.map(r => r.id)])).rows : [];
        const latest = new Map<string, Receipt>(), operations = new Map<string, Receipt>();
        for (const row of latestRows) {
            signal?.throwIfAborted();
            const r = await this.receipt(context, row);
            if (latest.has(r.applicationId))
                throw unavailable();
            latest.set(r.applicationId, r);
            operations.set(r.operationId, r);
        }
        const eventIds = new Set<string>();
        for (const row of rows) {
            signal?.throwIfAborted();
            try {
                const v = parseCareerApplication(JSON.parse(this.storage.crypto!.openUtf8(row.record_ciphertext, { table: 'platform_career_applications', column: 'record_ciphertext', rowId: row.id, ownerId: context.userId, revision: row.revision })));
                eventIds.add(v.lastOperationId);
                if (v.careWindow)
                    eventIds.add(v.careWindow.sourceEventId);
            }
            catch {
                throw unavailable();
            }
        }
        const missingReceipts = [...eventIds].filter(id => !operations.has(id));
        if (missingReceipts.length) {
            const historical = (await client.query('SELECT * FROM platform_career_application_operations WHERE user_id=$1 AND operation_id=ANY($2::uuid[]) FOR SHARE', [context.userId, missingReceipts])).rows;
            for (const row of historical) {
                signal?.throwIfAborted();
                const r = await this.receipt(context, row);
                if (operations.has(r.operationId))
                    throw unavailable();
                operations.set(r.operationId, r);
            }
        }
        const eventRows = eventIds.size ? (await client.query('SELECT * FROM platform_career_application_events WHERE user_id=$1 AND id=ANY($2::uuid[]) FOR SHARE', [context.userId, [...eventIds]])).rows : [];
        const events = new Map(eventRows.map(row => [row.id, row]));
        if (events.size !== eventIds.size || [...eventIds].some(id => !operations.has(id)))
            throw unavailable();
        const proofs: PreparationProofs = { latest, operations, events };
        const records: Readonly<CareerApplication>[] = [];
        for (const row of rows) {
            signal?.throwIfAborted();
            records.push(await this.record(client, context, row, proofs));
        }
        return records;
    }
    /** Owner-only evidence projection, not a model/context port. A manual
     * "applied" is provisional even after an offer; closed does not undo effort.
     * occurredAt is this declaration's current record time, never a verified
     * submission time. Correcting to saved clears the declaration. */
    async readProgressEvidenceInTransaction(client: PoolClient, value: FixedSessionContext, signal?: AbortSignal): Promise<readonly Readonly<CareerEvidence>[]> {
        const context = this.fixed(value);
        await this.authorize(client, context, signal);
        const records = await this.currentRecords(client, context, signal);
        const evidence = records.filter(v => v.submittedVia === 'user_sends').map(v => Object.freeze({
            id: v.id, ownerId: context.userId, subjectId: v.id, kind: 'application' as const,
            state: 'active' as const, verification: 'self_reported' as const,
            referenceId: 'career-application:' + v.id + ':' + v.revision, occurredAt: v.updatedAt,
        }));
        await authorizeFixedSession(client, context, signal);
        signal?.throwIfAborted();
        return Object.freeze(evidence);
    }
    /** Complete, body-free metadata. Source existence and all immutable proofs
     * are read within the actual consuming transaction, never from UI summaries. */
    async readForPreparationInTransaction(client: PoolClient, value: FixedSessionContext, signal?: AbortSignal) {
        const context = this.fixed(value);
        await this.authorize(client, context, signal);
        await this.storage.authorizeSession(client, context, signal);
        const savedJobs = await this.jobs.readForPreparationInTransaction(client, context, signal);
        const jobById = new Map(savedJobs.map(job => [job.id, job]));
        const records = await this.currentRecords(client, context, signal);
        const applications: Readonly<OwnedCareerApplication>[] = [];
        for (const v of records) {
            const job = jobById.get(v.job.id) ?? null;
            applications.push(Object.freeze({ ownerId: context.userId, id: v.id, revision: v.revision, state: 'current', stage: v.stage, track: v.job.roleFamily, job,
                normalSummary: '本人记录的申请 · ' + v.job.roleFamily + ' · ' + v.stage + ' · ' + (job ? '关联原 JD 存在，未核实是否仍开放。' : '原 JD 已移除。') }));
        }
        await authorizeFixedSession(client, context, signal);
        signal?.throwIfAborted();
        return Object.freeze({ applications: Object.freeze(applications), savedJobs });
    }
    /** Real ledger states for daily planning; free text and old JD bodies stay private. */
    async readForDailyPlanningInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal) {
      const context=this.fixed(value);await this.authorize(client,context,signal);await this.storage.authorizeSession(client,context,signal);
      const records=await this.currentRecords(client,context,signal);
      const result=records.map(v=>Object.freeze({id:v.id,ownerId:context.userId,revision:v.revision,stage:v.stage,offerState:v.offerState,closedReason:v.closedReason,closedAtStage:v.closedAtStage,submittedVia:v.submittedVia,job:Object.freeze({id:v.job.id,revision:v.job.revision,track:v.job.roleFamily}),lastOperationId:v.lastOperationId}));
      await authorizeFixedSession(client,context,signal);signal?.throwIfAborted();return Object.freeze(result);
    }
    /** Current owned source verified within its actual consuming transaction. */
    async readInTransaction(client: PoolClient, value: FixedSessionContext, key: unknown, signal?: AbortSignal) {
        const context = this.fixed(value);
        let id: string;
        try { id = careerRecordId(key); } catch { throw bad(); }
        await this.authorize(client, context, signal);
        const row = await this.row(client, context, id);
        if (!row) throw missing();
        const result = careerApplicationSummary(await this.record(client, context, row));
        await authorizeFixedSession(client, context, signal);
        return result;
    }
    /** Internal reader for the account-export transaction: the coordinator
     * consumes the fresh password proof and commits before exposing any section. */
    async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal){
     const s=this.fixed(value);await this.authorize(client,s,signal);
     for await(const row of accountExportRows(client,s.userId,'platform_career_applications',signal)){
      const record=await this.record(client,s,row);yield {section:'careerApplications' as const,record};
     }
     for await(const row of accountExportRows(client,s.userId,'platform_career_application_operations',signal)){
      const r=await this.receipt(s,row);yield {section:'careerApplicationOperations' as const,record:{id:r.operationId,applicationId:r.applicationId,action:r.action,revision:r.appliedRevision,createdAt:r.createdAt}};
     }
     for await(const row of accountExportRows(client,s.userId,'platform_career_application_events',signal)){
      yield {section:'careerApplicationEvents' as const,record:await this.event(client,s,row)};
     }
     await authorizeFixedSession(client,s,signal);
    }
    async get(value: FixedSessionContext, key: unknown, signal?: AbortSignal) {
        const context = this.fixed(value);
        let id: string;
        try {
            id = careerRecordId(key);
        }
        catch {
            throw bad();
        }
        return this.db.withBoundedTransaction(async (c) => {
            await this.authorize(c, context, signal);
            const row = await this.row(c, context, id);
            if (!row)
                throw missing();
            const application = await this.record(c, context, row);
            await authorizeFixedSession(c, context, signal);
            return application;
        });
    }
    async observe(value: FixedSessionContext, key: unknown, signal?: AbortSignal) {
        const context = this.fixed(value);
        let id: string;
        try {
            id = careerRecordId(key);
        }
        catch {
            throw bad();
        }
        return this.db.withBoundedTransaction(async (c) => {
            await this.authorize(c, context, signal);
            const row = await this.operation(c, context, id);
            if (!row)
                throw missing();
            const receipt = await this.receipt(context, row), application = await this.result(c, context, receipt);
            await authorizeFixedSession(c, context, signal);
            return Object.freeze({ application, operation: this.ack(receipt, true) });
        });
    }
    async list(value: FixedSessionContext, query: unknown = {}, signal?: AbortSignal) {
        const context = this.fixed(value);
        let after: string | null, stage: string | null;
        try {
            const q = careerRecordObject(query, [], ['after', 'stage']);
            after = Object.hasOwn(q, 'after') ? careerRecordId(q.after) : null;
            stage = Object.hasOwn(q, 'stage') ? q.stage as string : null;
            if (stage !== null && !['active', 'saved', 'applied', 'oa', 'interview', 'offer', 'closed'].includes(stage))
                throw bad();
        }
        catch {
            throw bad();
        }
        return this.db.withBoundedTransaction(async (c) => {
            await this.authorize(c, context, signal);
            let cursor: any = null;
            if (after) {
                cursor = (await c.query("SELECT *,created_at::text AS cursor_time FROM platform_career_applications WHERE user_id=$1 AND id=$2 FOR UPDATE", [context.userId, after])).rows[0];
                if (!cursor)
                    throw missing();
                await this.record(c, context, cursor);
            }
            const rows = (await c.query("SELECT *,created_at::text AS cursor_time FROM platform_career_applications WHERE user_id=$1 AND ($2::text IS NULL OR $2='active' AND stage<>'closed' OR stage=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51 FOR SHARE", [context.userId, stage, cursor?.cursor_time ?? null, after])).rows;
            const applications = [];
            for (const row of rows.slice(0, 50)) {
                signal?.throwIfAborted();
                applications.push(careerApplicationSummary(await this.record(c, context, row)));
            }
            await authorizeFixedSession(c, context, signal);
            return Object.freeze({ applications: Object.freeze(applications), nextAfter: rows.length > 50 ? applications.at(-1)!.id : null });
        });
    }
    async history(value: FixedSessionContext, key: unknown, query: unknown = {}, signal?: AbortSignal) {
        const context = this.fixed(value);
        let id: string, after: string | null;
        try {
            id = careerRecordId(key);
            const q = careerRecordObject(query, [], ['after']);
            after = Object.hasOwn(q, 'after') ? careerRecordId(q.after) : null;
        }
        catch {
            throw bad();
        }
        return this.db.withBoundedTransaction(async (c) => {
            await this.authorize(c, context, signal);
            const current = await this.row(c, context, id);
            if (!current)
                throw missing();
            await this.record(c, context, current);
            let revision = 0;
            if (after) {
                const row = (await c.query('SELECT * FROM platform_career_application_events WHERE user_id=$1 AND application_id=$2 AND id=$3', [context.userId, id, after])).rows[0];
                if (!row)
                    throw missing();
                revision = (await this.event(c, context, row)).revision;
            }
            const rows = (await c.query('SELECT * FROM platform_career_application_events WHERE user_id=$1 AND application_id=$2 AND revision>$3 ORDER BY revision LIMIT 51 FOR SHARE', [context.userId, id, revision])).rows, events = [];
            for (const row of rows.slice(0, 50)) {
                signal?.throwIfAborted();
                events.push(await this.event(c, context, row));
            }
            await authorizeFixedSession(c, context, signal);
            return Object.freeze({ applicationId: id, events: Object.freeze(events), nextAfter: rows.length > 50 ? events.at(-1)!.id : null });
        });
    }
    /** Restriction sources from real authenticated immutable events, including
     * a physically removed application's minimal tombstone. Not model input. */
    async readActiveCareWindowsInTransaction(c: PoolClient, value: FixedSessionContext, signal?: AbortSignal) {
        const context = this.fixed(value);
        await this.authorize(c, context, signal);
        const rows = (await c.query('SELECT * FROM platform_career_application_events WHERE user_id=$1 AND care_until>clock_timestamp() ORDER BY care_until,id LIMIT 501 FOR SHARE', [context.userId])).rows;
        if (rows.length > 500)
            throw unavailable();
        const windows = [];
        for (const row of rows) {
            signal?.throwIfAborted();
            const e = await this.event(c, context, row);
            if (e.careWindowUntil === null || !applicationNeedsPostRejection(e.next) || applicationNeedsPostRejection(e.previous))
                throw unavailable();
            windows.push(Object.freeze({ kind: 'post_rejection' as const, sourceEventId: e.id, applicationId: e.applicationId, eventRevision: e.revision, startedAt: e.createdAt, until: e.careWindowUntil }));
        }
        await authorizeFixedSession(c, context, signal);
        return Object.freeze(windows);
    }
    async mutate(value: FixedSessionContext, action: CareerApplicationAction, key: unknown, input: unknown, signal?: AbortSignal) {
        const context = this.fixed(value);
        let command: ReturnType<typeof parseCareerApplicationCommand>, requested: string | null;
        try {
            command = parseCareerApplicationCommand(action, input);
            requested = action === 'create' ? null : careerRecordId(key);
        }
        catch {
            throw bad();
        }
        const commandDigest = hash({ action, applicationId: requested, command });
        return this.db.withBoundedTransaction(async (c) => {
            const version = await this.authorize(c, context, signal), prior = await this.operation(c, context, command.operationId);
            if (prior) {
                const r = await this.receipt(context, prior);
                if (r.commandDigest !== commandDigest || r.action !== action || requested !== null && r.applicationId !== requested)
                    throw new ApiError(409, 'CAREER_APPLICATION_OPERATION_CONFLICT', '这个操作已用于其他记录，请重新核对。');
                const application = await this.result(c, context, r);
                await authorizeFixedSession(c, context, signal);
                return Object.freeze({ application, operation: this.ack(r, true) });
            }
            if (action !== 'delete')
                await this.storage.authorizeSession(c, context, signal);
            const id = requested ?? randomUUID();
            let base: Readonly<CareerApplication> | null = null, job: CareerApplication['job'] | null = null;
            if (action === 'create') {
                const cmd = command as {
                    jobObservationId: string;
                    jobObservationRevision: number;
                    privateNote: string;
                };
                const source = await this.jobs.readInTransaction(c, context, cmd.jobObservationId, signal);
                if (source.revision !== cmd.jobObservationRevision)
                    throw new ApiError(409, 'CAREER_APPLICATION_SOURCE_CHANGED', '收藏的岗位有变化，请重新读取。');
                job = manualJobSummary(source);
                if ((await c.query('SELECT id FROM platform_career_applications WHERE user_id=$1 AND job_observation_id=$2', [context.userId, job.id])).rowCount)
                    throw new ApiError(409, 'CAREER_APPLICATION_EXISTS', '这份收藏已有申请记录，请打开现有记录。');
                if ((await c.query('SELECT count(*)::integer AS count FROM platform_career_applications WHERE user_id=$1', [context.userId])).rows[0].count >= 500)
                    throw new ApiError(409, 'CAREER_APPLICATION_CAPACITY', '请先移除一份旧记录，再建立新的申请记录。');
            }
            else {
                const row = await this.row(c, context, id);
                if (!row)
                    throw missing();
                base = await this.record(c, context, row);
                if (base.revision !== command.expectedRevision)
                    throw new ApiError(409, 'CAREER_APPLICATION_REVISION_CHANGED', '记录有变化，请重新读取再核对。');
                job = base.job;
            }
            const revision = (base?.revision ?? 0) + 1, at = (await c.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")).rows[0].at.toISOString();
            let application: Readonly<CareerApplication> | null = null, careUntil: string | null = null;
            if (action === 'create')
                application = parseCareerApplication({ id, ownerId: context.userId, revision, lastOperationId: command.operationId, createdAt: at, updatedAt: at, source: 'user_recorded', job, privateNote: (command as {
                        privateNote: string;
                    }).privateNote, packetId: null, careWindow: null, stage: 'saved', closedReason: null, closedAtStage: null, offerState: null, submittedVia: null });
            else if (action === 'edit')
                application = parseCareerApplication({ ...base!, revision, lastOperationId: command.operationId, updatedAt: at, privateNote: (command as {
                        privateNote: string;
                    }).privateNote });
            else if (action === 'stage') {
                const { operationId, expectedRevision, ...choice } = command as import('@companion/platform-contracts').ApplicationStageCommand, plan = planApplicationStageChange(state(base!), choice, at);
                careUntil = plan.postRejection?.until ?? null;
                application = parseCareerApplication({ ...base!, ...plan.next, revision, lastOperationId: command.operationId, updatedAt: at,
                    submittedVia: choice.stage === 'applied' ? 'user_sends' : plan.next.submittedVia,
                    careWindow: careUntil ? { kind: 'post_rejection', sourceEventId: command.operationId, eventRevision: revision, startedAt: at, until: careUntil } : base!.careWindow });
            }
            const event = parseCareerApplicationEvent({ id: command.operationId, ownerId: context.userId, applicationId: id, revision, action, actor: 'user', channel: 'web', createdAt: at, previous: base ? state(base) : null, next: application ? state(application) : null, careWindowUntil: careUntil });
            const receipt: Receipt = { schemaVersion: 1, ownerId: context.userId, operationId: command.operationId, applicationId: id, action, appliedRevision: revision, commandDigest, recordDigest: hash(application), eventDigest: hash(event), acceptedAuthVersion: version, createdAt: at };
            const sealedReceipt = this.storage.crypto!.sealUtf8(canonical(receipt), { table: 'platform_career_application_operations', column: 'receipt_ciphertext', rowId: command.operationId, ownerId: context.userId, revision }), sealedEvent = this.storage.crypto!.sealUtf8(canonical(event), { table: 'platform_career_application_events', column: 'event_ciphertext', rowId: event.id, ownerId: context.userId, revision });
            await c.query('INSERT INTO platform_career_application_operations(user_id,operation_id,application_id,action,applied_revision,created_at,receipt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)', [context.userId, command.operationId, id, action, revision, at, sealedReceipt]);
            await c.query('INSERT INTO platform_career_application_events(user_id,id,application_id,revision,action,created_at,care_until,event_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [context.userId, event.id, id, revision, action, at, careUntil, sealedEvent]);
            if (application) {
                const cipher = this.storage.crypto!.sealUtf8(canonical(application), { table: 'platform_career_applications', column: 'record_ciphertext', rowId: id, ownerId: context.userId, revision });
                if (action === 'create')
                    await c.query('INSERT INTO platform_career_applications(id,user_id,job_observation_id,revision,last_operation_id,stage,created_at,updated_at,record_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)', [id, context.userId, job!.id, revision, command.operationId, application.stage, at, cipher]);
                else
                    await c.query('UPDATE platform_career_applications SET revision=$3,last_operation_id=$4,stage=$5,updated_at=$6,record_ciphertext=$7 WHERE id=$1 AND user_id=$2', [id, context.userId, revision, command.operationId, application.stage, at, cipher]);
            }
            else
                await c.query('DELETE FROM platform_career_applications WHERE id=$1 AND user_id=$2', [id, context.userId]);
            if(action==='stage'&&application&&base&&(base.stage!==application.stage||base.closedReason!==application.closedReason))
                await this.productEvents.record(c,context.userId,command.operationId,{event:'application_stage_changed',props:{from_stage:base.stage,to_stage:application.stage,closed_reason:application.closedReason??'none'}});
            await authorizeFixedSession(c, context, signal);
            signal?.throwIfAborted();
            return Object.freeze({ application, operation: this.ack(receipt, false) });
        });
    }
}
