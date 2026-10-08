import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER, parseCareerIdentityRecord } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword } from '../src/auth.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import type { IdentityRecordClient } from '../../../apps/web/src/career-identity-api.ts';
import { readIdentityEntry, readIdentityRecords, changeIdentityRecord, observeIdentityRecord } from '../../../apps/web/src/career-identity-api.ts';
const origin = 'https://fictional-identity.example.invalid', prefix = '/api/platform/career/identity', password = 'Fictional-memory-password-123';
let f: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>, system: Awaited<ReturnType<typeof buildApp>>, calls = 0;
before(async () => {
    f = await createCompanionNameSafetyFixture();
    system = await buildApp({ db: f.db, legalBundle: FICTIONAL_LEGAL, config: { ...readConfig(), dataCrypto: f.crypto, requireVerifiedEmail: true, allowedOrigins: new Set([origin]) }, enableQueue: false,
        runtime: createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: async () => { calls++; throw Error('No external provider is allowed'); } }) });
});
after(async () => { await system?.app.close(); assert.equal(calls, 0); await f?.close(); });
async function actor() {
    const who = await f.actor();
    await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1', [who.userId, await hashPassword(password)]);
    const r = await system.app.inject({ method: 'POST', url: '/api/platform/auth/login', headers: { origin }, payload: { email: who.userId + '@example.invalid', password } });
    assert.equal(r.statusCode, 200);
    const raw = r.headers['set-cookie'], cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0];
    return { id: who.userId, headers: { origin, cookie, [PLATFORM_ACCOUNT_HEADER]: who.userId } };
}
const command = (field = 'program_end_date', value: unknown = '2028-02-29', label: unknown = null) => ({ operationId: randomUUID(), expectedRevision: 0, field, value, label });
test('actual password-login HTTP recording/editing/forgetting and original-operation observer remain private and account-bound', async () => {
    const a = await actor(), payload = command(), first = await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.headers['cache-control'], 'private, no-store');
    const r = parseCareerIdentityRecord(first.json().record);
    assert.equal(r.ownerId, a.id);
    assert.equal(r.value, payload.value);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload })).json().operation.replayed, true);
    const edit = await system.app.inject({ method: 'PATCH', url: prefix + '/' + r.id, headers: a.headers, payload: { ...command('program_end_date', '2029-01-01'), expectedRevision: 1 } });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal(edit.json().record.confirmedAt, edit.json().record.updatedAt);
    const list = await system.app.inject({ url: prefix, headers: a.headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().records.length, 1);
    assert.equal(list.headers['cache-control'], 'private, no-store');
    const observer = await system.app.inject({ url: prefix + '/operations/' + payload.operationId, headers: a.headers });
    assert.equal(observer.statusCode, 200, observer.body);
    assert.equal(observer.json().record.revision, 2);
    const deleted = await system.app.inject({ method: 'DELETE', url: prefix + '/' + r.id, headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 2 } });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal((await system.app.inject({ url: prefix + '/operations/' + payload.operationId, headers: a.headers })).json().record, null);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload })).json().record, null);
    assert.equal((await system.app.inject({ url: prefix + '/' + r.id, headers: a.headers })).statusCode, 404);
    assert.equal(calls, 0);
});
test('cross-owner IDs, staff, account-window mismatch, CSRF, derived classification and reminder fields cannot record or disclose data', async () => {
    const a = await actor(), b = await actor(), payload = command(), saved = await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload }), id = saved.json().record.id;
    for (const read of [prefix + '/' + id, prefix + '/operations/' + payload.operationId])
        assert.equal((await system.app.inject({ url: read, headers: b.headers })).statusCode, 404);
    assert.equal((await system.app.inject({ method: 'PATCH', url: prefix + '/' + id, headers: b.headers, payload: { ...command(), expectedRevision: 1 } })).statusCode, 404);
    assert.equal((await system.app.inject({ method: 'DELETE', url: prefix + '/' + id, headers: b.headers, payload: { operationId: randomUUID(), expectedRevision: 1 } })).statusCode, 404);
    assert.equal((await system.app.inject({ url: prefix, headers: { ...b.headers, [PLATFORM_ACCOUNT_HEADER]: a.id } })).statusCode, 409);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix, headers: { ...a.headers, origin: 'https://evil.invalid' }, payload: command() })).statusCode, 403);
    for (const patch of [{ source: 'derived' }, { ownerId: b.id }, { sensitivity: 'normal' }, { confirmedAt: '2026-01-01T00:00:00.000Z' }, { remindBeforeDays: 30 }, { field: 'unemployment_reminder_days', value: 10 }, { value: '2026-02-29' }])
        assert.equal((await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload: { ...command(), ...patch } })).statusCode, 400);
    for (const path of [prefix + '?ownerId=' + a.id, prefix + '?field=program_end_date&field=opt_status', prefix + '/' + id + '?source=derived'])
        assert.equal((await system.app.inject({ url: path, headers: a.headers })).statusCode, 400);
    assert.equal((await system.app.inject({ url: prefix })).statusCode, 401);
    await f.db.query("UPDATE platform_users SET account_kind='staff' WHERE id=$1", [b.id]);
    assert.equal((await system.app.inject({ url: prefix, headers: b.headers })).statusCode, 403);
    assert.equal(calls, 0);
});
test('actual owner-reported unemployment count keeps its confirmation time and cannot become a ticking derived count', async () => {
    const a = await actor(), r = await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload: command('unemployment_days_reported', { days: 1000 }) });
    assert.equal(r.statusCode, 201, r.body);
    const record = parseCareerIdentityRecord(r.json().record);
    assert.deepEqual(record.value, { days: 1000, reportedAt: record.confirmedAt });
    assert.equal((await system.app.inject({ url: prefix + '/' + record.id, headers: a.headers })).json().record.value.days, 1000);
    const before = await system.careerPreparationSources.read({ userId: a.id, tokenHash: (await f.db.query('SELECT token_hash FROM platform_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [a.id])).rows[0].token_hash });
    assert(!JSON.stringify(before).includes('unemployment_days_reported'));
    assert(!JSON.stringify(before).includes(record.id));
    assert.equal(calls, 0);
});
test('real HTTP personal entry reads only authenticated original O2 choices, rejects source query injection and rechecks sessions', async () => {
    const a = await actor(), context = { userId: a.id, tokenHash: (await f.db.query('SELECT token_hash FROM platform_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [a.id])).rows[0].token_hash };
    assert.equal((await system.app.inject({ url: prefix + '/entry', headers: a.headers })).json().kind, 'hidden');
    let d = (await f.store.save(context, { operationId: randomUUID(), expectedRevision: 0, action: { kind: 'start', mode: 'fast_track' } })).draft;
    while (d.currentQuestion)
        d = (await f.store.save(context, { operationId: randomUUID(), expectedRevision: d.revision, action: d.currentQuestion === 'identity_stage' ? { kind: 'answer', questionId: 'identity_stage', value: 'f1_student' } : { kind: 'skip', questionId: d.currentQuestion } })).draft;
    const entry = await system.app.inject({ url: prefix + '/entry', headers: a.headers });
    assert.equal(entry.statusCode, 200, entry.body);
    assert.equal(entry.headers['cache-control'], 'private, no-store');
    assert.deepEqual(entry.json(), { kind: 'available', ownerId: a.id, stage: 'f1_student', source: { draftId: d.id, revision: d.revision } });
    for (const query of ['?ownerId=' + a.id, '?stage=opt', '?stage=opt&stage=opt'])
        assert.equal((await system.app.inject({ url: prefix + '/entry' + query, headers: a.headers })).statusCode, 400);
    const b = await actor();
    assert.deepEqual((await system.app.inject({ url: prefix + '/entry', headers: b.headers })).json(), { kind: 'hidden', ownerId: b.id });
    await f.db.query("UPDATE platform_users SET account_kind='staff' WHERE id=$1", [b.id]);
    assert.equal((await system.app.inject({ url: prefix + '/entry', headers: b.headers })).statusCode, 403);
    await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [a.id]);
    assert.equal((await system.app.inject({ url: prefix + '/entry', headers: a.headers })).statusCode, 401);
    assert.equal(calls, 0);
});
test('actual Web request client and password-login HTTP/DB agree on source entry, saved values, action receipts and deletion observation', async () => {
    const a = await actor(), context = { userId: a.id, tokenHash: (await f.db.query('SELECT token_hash FROM platform_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [a.id])).rows[0].token_hash };
    let d = (await f.store.save(context, { operationId: randomUUID(), expectedRevision: 0, action: { kind: 'start', mode: 'fast_track' } })).draft;
    while (d.currentQuestion)
        d = (await f.store.save(context, { operationId: randomUUID(), expectedRevision: d.revision, action: d.currentQuestion === 'identity_stage' ? { kind: 'answer', questionId: 'identity_stage', value: 'opt' } : { kind: 'skip', questionId: d.currentQuestion } })).draft;
    const client = { account: { accountId: a.id, generation: 1 }, isCurrent: () => true, subscribe: () => () => { }, request: async (path: string, init: RequestInit = {}) => {
            const r = await system.app.inject({ url: '/api/platform' + path, method: (init.method ?? 'GET') as any, headers: a.headers, ...(init.body ? { payload: JSON.parse(String(init.body)) } : {}) });
            assert(r.statusCode >= 200 && r.statusCode < 300, r.body);
            return r.json();
        } } as unknown as IdentityRecordClient;
    assert.equal((await readIdentityEntry(client)).kind, 'available');
    const original = { action: 'create' as const, id: null, body: command('unemployment_days_reported', { days: 0 }) }, first = await changeIdentityRecord(client, original);
    assert(first.record);
    assert.equal(first.operation.action, 'create');
    assert.deepEqual(first.record.value, { days: 0, reportedAt: first.record.confirmedAt });
    assert.equal((await readIdentityRecords(client)).length, 1);
    assert.equal((await observeIdentityRecord(client, original)).operation.replayed, true);
    await changeIdentityRecord(client, { action: 'delete', id: first.record.id, body: { operationId: randomUUID(), expectedRevision: 1 } });
    assert.equal((await observeIdentityRecord(client, original)).record, null);
    assert.equal((await changeIdentityRecord(client, original)).record, null);
    assert.equal((await readIdentityRecords(client)).length, 0);
    assert.equal(calls, 0);
});
