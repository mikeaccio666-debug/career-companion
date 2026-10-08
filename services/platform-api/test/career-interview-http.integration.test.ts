import { readInterviewRecords, readInterviewRecord, changeInterviewRecord, observeInterviewRecord, type InterviewRecordClient, type InterviewIntent } from '../../../apps/web/src/career-interview-api.ts';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER, parseCareerApplication, parseCareerInterview } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword, tokenHash } from '../src/auth.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
const origin = 'https://fictional-application.example.invalid', applicationPrefix = '/api/platform/career/applications', prefix = '/api/platform/career/interviews', password = 'Fictional-application-password-123';
let f: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>, system: Awaited<ReturnType<typeof buildApp>>, calls = 0;
before(async () => { f = await createCompanionNameSafetyFixture(); system = await buildApp({ db: f.db, legalBundle: FICTIONAL_LEGAL, config: { ...readConfig(), dataCrypto: f.crypto, requireVerifiedEmail: true, allowedOrigins: new Set([origin]) }, enableQueue: false, runtime: createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: async () => { calls++; throw Error('No external request is allowed'); } }) }); });
after(async () => { await system?.app.close(); assert.equal(calls, 0); await f?.close(); });
async function actor() { const who = await f.actor(); await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1', [who.userId, await hashPassword(password)]); const r = await system.app.inject({ method: 'POST', url: '/api/platform/auth/login', headers: { origin }, payload: { email: who.userId + '@example.invalid', password } }); assert.equal(r.statusCode, 200); const raw = r.headers['set-cookie'], cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0]; return { id: who.userId, headers: { origin, cookie, [PLATFORM_ACCOUNT_HEADER]: who.userId } }; }
async function make(a: Awaited<ReturnType<typeof actor>>) {
    const r = await system.app.inject({ method: 'POST', url: '/api/platform/career/job-observations', headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 0, employer: 'Fictional Company', title: 'Fictional Analyst', canonicalUrl: 'https://example.invalid/jobs/' + randomUUID(), roleFamily: 'da', location: '', deadlineAt: null, deadlineTimeZone: null, privateNote: 'Fictional source note', jobText: 'Fictional position.' } });
    assert.equal(r.statusCode, 201, r.body);
    const payload = { operationId: randomUUID(), expectedRevision: 0, jobObservationId: r.json().job.id, jobObservationRevision: 1, privateNote: 'Fictional application note' }, created = await system.app.inject({ method: 'POST', url: applicationPrefix, headers: a.headers, payload });
    assert.equal(created.statusCode, 201, created.body);
    return { payload, app: parseCareerApplication(created.json().application) };
}
const command = (app: Awaited<ReturnType<typeof make>>['app']) => ({ operationId: randomUUID(), expectedRevision: 0, applicationId: app.id, applicationRevision: app.revision, roundType: 'behavioral', startsAt: '2026-11-01T05:30:00.000Z', timeZone: 'America/New_York', durationMin: 45 });
test('real cookie login routes record, reschedule, mark done, observe, and physically remove the same interview', async () => {
    const a = await actor(), { app } = await make(a), payload = command(app);
    const created = await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.headers['cache-control'], 'private, no-store');
    let record = parseCareerInterview(created.json().interview);
    assert.equal(record.application.id, app.id);
    assert.equal(created.json().operation.action, 'create');
    const moved = await system.app.inject({ method: 'POST', url: prefix + '/' + record.id + '/reschedule', headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 1, startsAt: '2026-11-01T06:30:00.000Z', timeZone: 'America/New_York' } });
    assert.equal(moved.statusCode, 200, moved.body);
    record = parseCareerInterview(moved.json().interview);
    assert.equal(record.status, 'rescheduled');
    const done = await system.app.inject({ method: 'POST', url: prefix + '/' + record.id + '/status', headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 2, status: 'done' } });
    assert.equal(done.statusCode, 200, done.body);
    const observed = await system.app.inject({ url: prefix + '/operations/' + payload.operationId, headers: a.headers });
    assert.equal(observed.statusCode, 200);
    assert.equal(observed.json().interview.revision, 3);
    const list = await system.app.inject({ url: prefix + '?status=done', headers: a.headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().interviews.length, 1);
    const source = await system.app.inject({ url: applicationPrefix + '/' + app.id, headers: a.headers });
    assert.equal(source.json().application.stage, 'saved');
    const removed = await system.app.inject({ method: 'DELETE', url: prefix + '/' + record.id, headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 3 } });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().interview, null);
    const replay = await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().interview, null);
});
test('foreign account, wrong window, CSRF, unsupported query and invented calendar/model fields cannot disclose or write records', async () => {
    const a = await actor(), b = await actor(), { app } = await make(a), payload = command(app), created = await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().interview.id;
    assert.equal((await system.app.inject({ url: prefix + '/' + id, headers: b.headers })).statusCode, 404);
    assert.equal((await system.app.inject({ url: prefix + '/operations/' + payload.operationId, headers: b.headers })).statusCode, 404);
    assert.equal((await system.app.inject({ url: prefix + '/' + id, headers: { ...a.headers, [PLATFORM_ACCOUNT_HEADER]: b.id } })).statusCode, 409);
    assert.equal((await system.app.inject({ url: prefix })).statusCode, 401);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix, headers: { ...a.headers, origin: 'https://foreign.example.invalid' }, payload })).statusCode, 403);
    for (const extra of [{ ownerId: b.id }, { source: 'calendar' }, { status: 'done' }, { briefId: randomUUID() }, { debrief: 'Fake review' }, { model: 'fake' }, { calendarEventId: 'fake' }])
        assert.equal((await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload: { ...payload, operationId: randomUUID(), ...extra } })).statusCode, 400);
    for (const query of ['?ownerId=' + b.id, '?status=done&status=cancelled', '?status=unknown', '?after=invalid'])
        assert.equal((await system.app.inject({ url: prefix + query, headers: a.headers })).statusCode, 400);
    assert.equal((await system.app.inject({ url: prefix + '/' + id + '?model=fake', headers: a.headers })).statusCode, 400);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix + '/' + id + '/status', headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 1, status: 'scheduled' } })).statusCode, 400);
});
test('revoked actual cookie session cannot read or recover owner schedule operations', async () => {
    const a = await actor(), { app } = await make(a), payload = command(app);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload })).statusCode, 201);
    await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [a.id]);
    assert.equal((await system.app.inject({ url: prefix, headers: a.headers })).statusCode, 401);
    assert.equal((await system.app.inject({ url: prefix + '/operations/' + payload.operationId, headers: a.headers })).statusCode, 401);
});

/** Real Web protocol client -> password-authenticated HTTP -> isolated PostgreSQL.
 * These use fictional actors and actual route authorization, not a fake signer. */
function webClient(a: Awaited<ReturnType<typeof actor>>): InterviewRecordClient {
    return {
        account: { accountId: a.id }, isCurrent: () => true,
        async request<T>(path: string, init: RequestInit = {}) {
            init.signal?.throwIfAborted();
            const response = await system.app.inject({
                method: (init.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE',
                url: '/api/platform' + path, headers: a.headers,
                ...(init.body ? { payload: JSON.parse(String(init.body)) } : {}),
            });
            init.signal?.throwIfAborted();
            if (response.statusCode >= 400) throw Object.assign(Error('Fictional HTTP request rejected'), { status: response.statusCode });
            return response.json() as T;
        },
    };
}
test('actual portable Web client reads the owner page and verifies all five authenticated command acknowledgements', async () => {
    const a = await actor(), { app } = await make(a), client = webClient(a);
    const original: InterviewIntent = { action: 'create', id: null, body: command(app) };
    let result = await changeInterviewRecord(client, original);
    const id = result.interview!.id;
    assert.equal(result.operation.appliedRevision, 1);
    assert.equal((await readInterviewRecords(client)).interviews[0].id, id);
    assert.equal((await readInterviewRecord(client, id)).application.id, app.id);
    result = await changeInterviewRecord(client, { action: 'edit', id, body: { operationId: randomUUID(), expectedRevision: 1, roundType: 'sql', durationMin: 60 } });
    assert.equal(result.interview!.roundType, 'sql');
    result = await changeInterviewRecord(client, { action: 'reschedule', id, body: { operationId: randomUUID(), expectedRevision: 2, startsAt: '2026-11-01T06:30:17.123Z', timeZone: 'America/New_York' } });
    assert.equal(result.interview!.startsAt, '2026-11-01T06:30:17.123Z');
    assert.equal(result.interview!.status, 'rescheduled');
    result = await changeInterviewRecord(client, { action: 'status', id, body: { operationId: randomUUID(), expectedRevision: 3, status: 'done' } });
    assert.equal(result.interview!.status, 'done');
    const observed = await observeInterviewRecord(client, original);
    assert.equal(observed.interview!.revision, 4);
    assert.equal(observed.operation.replayed, true);
    assert.equal((await readInterviewRecords(client, null, 'done')).interviews.length, 1);
    result = await changeInterviewRecord(client, { action: 'delete', id, body: { operationId: randomUUID(), expectedRevision: 4 } });
    assert.equal(result.interview, null);
    assert.equal((await observeInterviewRecord(client, original)).interview, null);
    assert.equal((await changeInterviewRecord(client, original)).interview, null);
    assert.equal((await readInterviewRecords(client)).interviews.length, 0);
    const unchanged = await system.app.inject({ url: applicationPrefix + '/' + app.id, headers: a.headers });
    assert.equal(unchanged.json().application.stage, 'saved');
});
test('an actual accepted creation whose Web response is lost is recovered with the same nonce and only one database effect', async () => {
    const a = await actor(), { app } = await make(a), transport = webClient(a);
    const original: InterviewIntent = { action: 'create', id: null, body: command(app) };
    let drop = true;
    const client: InterviewRecordClient = {
        ...transport, async request<T>(path: string, init?: RequestInit) {
            const value = await transport.request<T>(path, init);
            if (drop && init?.method === 'POST') { drop = false; throw Error('Fictional response lost after acceptance'); }
            return value;
        },
    };
    await assert.rejects(changeInterviewRecord(client, original), /response lost/);
    const observed = await observeInterviewRecord(client, original);
    assert.equal(observed.operation.replayed, true);
    const retry = await changeInterviewRecord(client, original);
    assert.equal(retry.interview!.id, observed.interview!.id);
    const operationId = (original.body as { operationId: string }).operationId;
    assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM platform_career_interviews WHERE user_id=$1', [a.id])).rows[0].n), 1);
    assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM platform_career_interview_operations WHERE user_id=$1 AND operation_id=$2', [a.id, operationId])).rows[0].n), 1);
});
test('the actual Web read/observer cannot use another owner cookie or a revoked authenticated session', async () => {
    const a = await actor(), b = await actor(), { app } = await make(a);
    const original: InterviewIntent = { action: 'create', id: null, body: command(app) }, client = webClient(a);
    const created = await changeInterviewRecord(client, original);
    await assert.rejects(readInterviewRecord(webClient(b), created.interview!.id), { status: 404 });
    await assert.rejects(observeInterviewRecord(webClient(b), original), { status: 404 });
    await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [a.id]);
    await assert.rejects(readInterviewRecords(client), { status: 401 });
    await assert.rejects(observeInterviewRecord(client, original), { status: 401 });
});
