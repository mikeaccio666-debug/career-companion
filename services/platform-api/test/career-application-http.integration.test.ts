import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER, parseCareerApplication } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword, tokenHash } from '../src/auth.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
const origin = 'https://fictional-application.example.invalid', prefix = '/api/platform/career/applications', password = 'Fictional-application-password-123';
let f: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>, system: Awaited<ReturnType<typeof buildApp>>, calls = 0;
before(async () => { f = await createCompanionNameSafetyFixture(); system = await buildApp({ db: f.db, legalBundle: FICTIONAL_LEGAL, config: { ...readConfig(), dataCrypto: f.crypto, requireVerifiedEmail: true, allowedOrigins: new Set([origin]) }, enableQueue: false, runtime: createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: async () => { calls++; throw Error('No external request is allowed'); } }) }); });
after(async () => { await system?.app.close(); assert.equal(calls, 0); await f?.close(); });
async function actor() { const who = await f.actor(); await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1', [who.userId, await hashPassword(password)]); const r = await system.app.inject({ method: 'POST', url: '/api/platform/auth/login', headers: { origin }, payload: { email: who.userId + '@example.invalid', password } }); assert.equal(r.statusCode, 200); const raw = r.headers['set-cookie'], cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0]; return { id: who.userId, headers: { origin, cookie, [PLATFORM_ACCOUNT_HEADER]: who.userId } }; }
async function make(a: Awaited<ReturnType<typeof actor>>) {
    const r = await system.app.inject({ method: 'POST', url: '/api/platform/career/job-observations', headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 0, employer: 'Fictional Company', title: 'Fictional Analyst', canonicalUrl: 'https://example.invalid/jobs/' + randomUUID(), roleFamily: 'da', location: '', deadlineAt: null, deadlineTimeZone: null, privateNote: 'Fictional source note', jobText: 'Fictional position.' } });
    assert.equal(r.statusCode, 201, r.body);
    const payload = { operationId: randomUUID(), expectedRevision: 0, jobObservationId: r.json().job.id, jobObservationRevision: 1, privateNote: 'Fictional application note' }, created = await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload });
    assert.equal(created.statusCode, 201, created.body);
    return { payload, app: parseCareerApplication(created.json().application) };
}
test('real login routes save, stage, observe, edit, append history and delete without provider requests', async () => {
    const a = await actor(), { payload, app } = await make(a);
    const read = await system.app.inject({ url: prefix + '/' + app.id, headers: a.headers });
    assert.equal(read.statusCode, 200);
    assert.equal(read.headers['cache-control'], 'private, no-store');
    const update = { operationId: randomUUID(), expectedRevision: 1, stage: 'applied' };
    const staged = await system.app.inject({ method: 'POST', url: prefix + '/' + app.id + '/stage', headers: a.headers, payload: update });
    assert.equal(staged.statusCode, 200, staged.body);
    assert.equal(staged.json().application.submittedVia, 'user_sends');
    const observed = await system.app.inject({ url: prefix + '/operations/' + payload.operationId, headers: a.headers });
    assert.equal(observed.json().application.revision, 2);
    assert.equal(observed.json().operation.replayed, true);
    const list = await system.app.inject({ url: prefix + '?stage=applied', headers: a.headers });
    assert.equal(list.json().applications.length, 1);
    assert(!('privateNote' in list.json().applications[0]));
    const edited = await system.app.inject({ method: 'PATCH', url: prefix + '/' + app.id, headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 2, privateNote: 'Fictional updated' } });
    assert.equal(edited.statusCode, 200, edited.body);
    const history = await system.app.inject({ url: prefix + '/' + app.id + '/events', headers: a.headers });
    assert.deepEqual(history.json().events.map((e: any) => e.action), ['create', 'stage', 'edit']);
    const removed = await system.app.inject({ method: 'DELETE', url: prefix + '/' + app.id, headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 3 } });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().application, null);
    assert.equal((await system.app.inject({ url: prefix + '/operations/' + payload.operationId, headers: a.headers })).json().application, null);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload })).statusCode, 200);
    assert.equal(calls, 0);
});
test('foreign owners, CSRF, stale account window, unsupported metadata and repeated queries are rejected by HTTP', async () => {
    const a = await actor(), b = await actor(), { app, payload } = await make(a);
    for (const path of ['/' + app.id, '/' + app.id + '/events', '/operations/' + payload.operationId])
        assert.equal((await system.app.inject({ url: prefix + path, headers: b.headers })).statusCode, 404);
    for (const method of ['PATCH', 'DELETE'] as const)
        assert.equal((await system.app.inject({ method, url: prefix + '/' + app.id, headers: b.headers, payload: { operationId: randomUUID(), expectedRevision: 1, ...(method === 'PATCH' ? { privateNote: '' } : {}) } })).statusCode, 404);
    assert.equal((await system.app.inject({ url: prefix, headers: { ...b.headers, [PLATFORM_ACCOUNT_HEADER]: a.id } })).statusCode, 409);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix, headers: { ...a.headers, origin: 'https://evil.invalid' }, payload })).statusCode, 403);
    for (const extra of [{ ownerId: b.id }, { source: 'extension' }, { packetId: randomUUID() }, { submittedVia: 'extension' }, { actor: 'receipt' }, { careWindow: { kind: 'post_rejection' } }])
        assert.equal((await system.app.inject({ method: 'POST', url: prefix, headers: a.headers, payload: { ...payload, operationId: randomUUID(), ...extra } })).statusCode, 400);
    for (const query of ['?ownerId=' + b.id, '?stage=saved&stage=closed', '?stage=unknown', '?after=invalid'])
        assert.equal((await system.app.inject({ url: prefix + query, headers: a.headers })).statusCode, 400);
    assert.equal((await system.app.inject({ url: prefix })).statusCode, 401);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix + '/' + app.id + '/stage', headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 1, stage: 'closed' } })).statusCode, 400);
});
test('buildApp composes actual password-login-created application and JD into preparation with that same cookie session', async () => {
    const a = await actor(), { app } = await make(a), cookieValue = a.headers.cookie.slice(a.headers.cookie.indexOf('=') + 1);
    const context = { userId: a.id, tokenHash: tokenHash(decodeURIComponent(cookieValue)) };
    const index = await system.careerPreparationSources.read(context);
    assert.equal(index.applications!.length, 1);
    assert.equal(index.savedJobs!.length, 1);
    assert.equal(index.applications![0].job!.id, app.job.id);
    assert(!JSON.stringify(index).includes('Fictional application note'));
    assert(!JSON.stringify(index).includes('Fictional Company'));
    const prepared = await system.careerPreparationSources.prepare(context, { skillId: 'application-preparation', selection: { targetJobId: app.id } });
    assert.equal(prepared.built.context.inputs.find(r => r.input === 'target-job')!.id, app.id);
    assert.deepEqual(prepared.built.sourceDependencies[0].members, [{ id: app.job.id, revision: 1 }]);
    const closed = await system.app.inject({ method: 'POST', url: prefix + '/' + app.id + '/stage', headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 1, stage: 'closed', closedReason: 'withdrawn' } });
    assert.equal(closed.statusCode, 200, closed.body);
    const after = await system.careerPreparationSources.prepare(context, { skillId: 'application-preparation', selection: { targetJobId: app.id } });
    assert.equal(after.built.context.inputs.some(r => r.input === 'target-job'), false);
    assert.notEqual(after.sourceIndex.indexId, index.indexId);
    assert.equal(calls, 0);
});

test('real password-authenticated progress route composes actual current applications and projects with explicit coverage', async () => {
    const a = await actor(), b = await actor(), { app } = await make(a), url = '/api/platform/career/progress';
    const ownedProgress = await system.app.inject({ url, headers: a.headers }); assert.equal(ownedProgress.json().ownerId, a.id);
    const read = () => system.app.inject({ url, headers: a.headers });
    assert.equal((await read()).json().progress.provisionalCounts.application, 0);
    const staged = await system.app.inject({ method: 'POST', url: prefix + '/' + app.id + '/stage', headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 1, stage: 'applied' } });
    assert.equal(staged.statusCode, 200, staged.body);
    const response = await read(); assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(response.json().coverage, ['project', 'application', 'interview']);
    assert.equal(response.json().progress.provisionalCounts.application, 1);
    assert.equal(response.json().progress.counts.application, 0);
    assert(!response.body.includes('Fictional'));
    const created=await system.app.inject({method:'POST',url:'/api/platform/career/interviews',headers:a.headers,payload:{
      operationId:randomUUID(),expectedRevision:0,applicationId:app.id,applicationRevision:2,roundType:'sql',
      startsAt:'2026-11-01T05:30:00.000Z',timeZone:'America/New_York',durationMin:45}});
    assert.equal(created.statusCode,201,created.body);const interview=created.json().interview;
    assert.equal((await read()).json().progress.provisionalCounts.interview,0);
    const completed=await system.app.inject({method:'POST',url:'/api/platform/career/interviews/'+interview.id+'/status',headers:a.headers,
      payload:{operationId:randomUUID(),expectedRevision:interview.revision,status:'done'}});
    assert.equal(completed.statusCode,200,completed.body);
    const withInterview=await read();assert.equal(withInterview.json().progress.provisionalCounts.interview,1);assert.equal(withInterview.json().progress.counts.interview,0);
    assert.equal((await system.app.inject({url,headers:b.headers})).json().progress.provisionalCounts.interview,0);

    assert.equal((await system.app.inject({ url, headers: b.headers })).json().progress.provisionalCounts.application, 0);
    assert.equal((await system.app.inject({ url })).statusCode, 401);
    assert.equal((await system.app.inject({ url: url + '?ownerId=' + a.id, headers: b.headers })).statusCode, 400);
    assert.equal((await system.app.inject({ url, headers: { ...b.headers, [PLATFORM_ACCOUNT_HEADER]: a.id } })).statusCode, 409);
    await system.app.inject({ method: 'DELETE', url: prefix + '/' + app.id, headers: a.headers, payload: { operationId: randomUUID(), expectedRevision: 2 } });
    assert.equal((await read()).json().progress.provisionalCounts.application, 0);
});
