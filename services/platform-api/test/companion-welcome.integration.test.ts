import {CompanionDailySettingsService} from '../src/companion-daily-settings.ts';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProviderRuntime } from '@companion/ai-core';
import { PLATFORM_ACCOUNT_HEADER, parseCompanionWelcomeObservation, parseCompanionWelcomeChoiceResult } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword, tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { createPrebirthFixture, withPrebirthLoopback, type PrebirthFixture } from './fixtures/companion-prebirth.ts';
import { readyBirth } from './fixtures/companion-birth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
let fixture: PrebirthFixture, system: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
const origin = 'https://fictional-welcome.example.invalid', prefix = '/api/platform/companion/welcome', password = 'Fictional-welcome-password-only';
type Actor = {
    who: FixedSessionContext;
    cookie: string;
    email: string;
};
before(async () => {
    fixture = await createPrebirthFixture();
    system = await buildApp({ db: fixture.db, legalBundle: FICTIONAL_LEGAL,
        config: { ...readConfig(), expertRoster:{schemaVersion:1,revision:1,enabledExperts:[]}, dataCrypto: fixture.crypto, requireVerifiedEmail: true, allowedOrigins: new Set([origin]) }, enableQueue: false,
        runtime: createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-blocked' }, fetch: async () => { providerCalls++; throw Error('External providers are forbidden'); } }) });
});
after(async () => { try {
    await system?.app.close();
    assert.equal(providerCalls, 0);
}
finally {
    await fixture?.close();
} });
async function login(userId: string): Promise<Actor> {
    const email = userId + '@example.invalid';
    const r = await system.app.inject({ method: 'POST', url: '/api/platform/auth/login', headers: { origin }, payload: { email, password } });
    assert.equal(r.statusCode, 200);
    const value = r.headers['set-cookie'];
    const cookie = (Array.isArray(value) ? value[0] : value)!.split(';')[0];
    return { who: { userId, tokenHash: tokenHash(cookie.slice(cookie.indexOf('=') + 1)) }, cookie, email };
}
async function actor() { const who = await fixture.actor(); await fixture.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1', [who.userId, await hashPassword(password)]); return login(who.userId); }
const headers = (a: Actor) => ({ origin, cookie: a.cookie, [PLATFORM_ACCOUNT_HEADER]: a.who.userId });
const read = (a: Actor) => system.app.inject({ url: prefix, headers: headers(a) });
const open = async (a: Actor, body?: Record<string, unknown>) => { if (body === undefined) {
    const c = (await system.app.inject({ url: '/api/platform/companion', headers: headers(a) })).json();
    body = { expectedCompanionId: c.kind === 'active' ? c.companion.companionId : randomUUID() };
} return system.app.inject({ method: 'POST', url: prefix + '/open', headers: headers(a), payload: body }); };
const choose = async (a: Actor, body: unknown) => { const state = (await read(a)).json(); return system.app.inject({ method: 'POST', url: prefix + '/choice', headers: headers(a), payload: { welcomeId: state.id, ...body as object } }); };
async function born(a: Actor) { await withPrebirthLoopback(async (runtime, calls) => { const f = await readyBirth(fixture, runtime, { who: a.who }); await f.service.birth(a.who, f.body, f.key); assert.equal(calls.length, 2); }); }
async function count(a: Actor) {
    return (await fixture.db.query(`SELECT (SELECT count(*)::int FROM platform_companion_welcome WHERE user_id=$1) AS welcomes,
 (SELECT count(*)::int FROM platform_companion_welcome_operations WHERE user_id=$1) AS operations,
 (SELECT count(*)::int FROM platform_messages WHERE user_id=$1 AND speaker_kind='companion') AS intros,
 (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs`, [a.who.userId])).rows[0];
}
test('welcome GET is read-only; uncommitted birth, forged bodies, foreign account and unauthenticated access cannot publish C1', async () => {
    const a = await actor(), foreign = await actor();
    assert.deepEqual((await read(a)).json(), { kind: 'not_opened' });
    assert.deepEqual(await count(a), { welcomes: 0, operations: 0, intros: 0, jobs: 0 });
    assert.equal((await open(a)).statusCode, 409);
    assert.equal((await open(a, { name: 'Forged' })).statusCode, 400);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix + '/open', headers: { origin }, payload: {} })).statusCode, 401);
    assert.equal((await system.app.inject({ method: 'POST', url: prefix + '/open', headers: { ...headers(a), [PLATFORM_ACCOUNT_HEADER]: foreign.who.userId }, payload: {} })).statusCode, 409);
    assert.equal((await system.app.inject({ url: prefix + '?userId=' + foreign.who.userId, headers: headers(a) })).statusCode, 400);
    assert.deepEqual(await count(a), { welcomes: 0, operations: 0, intros: 0, jobs: 0 });
});
test('concurrent C1 opens publish exactly one real ordinary companion message after actual birth, with encrypted body and actual speaker snapshot', async () => {
    const a = await actor();
    await born(a);
    assert.deepEqual((await read(a)).json(), { kind: 'not_opened' });
    const results = await Promise.all([open(a), open(a)]);
    results.forEach(r => assert.equal(r.statusCode, 200));
    const state = parseCompanionWelcomeObservation(results[0].json());
    assert.equal(state.kind, 'welcome');
    if (state.kind !== 'welcome')
        return;
    assert.deepEqual(results[1].json(), state);
    assert.equal(state.step, 'C1');
    assert.equal(state.intro.rendering, 'fixed_intro_v1');
    assert.match(state.intro.content, /我是 AI/);
    assert.match(state.intro.content, /名字是你起的/);
    assert.deepEqual(await count(a), { welcomes: 1, operations: 0, intros: 1, jobs: 0 });
    assert.equal((await read(a)).headers['cache-control'], 'private, no-store');
    const row = (await fixture.db.query('SELECT w.*,m.content,m.payload,m.speaker_snapshot FROM platform_companion_welcome w JOIN platform_messages m ON m.id=w.intro_message_id WHERE w.user_id=$1', [a.who.userId])).rows[0];
    assert.equal(row.content, '');
    assert(!row.intro_ciphertext.includes(Buffer.from(state.intro.content)));
    assert.equal(row.speaker_snapshot.displayName, state.intro.speaker.name);
    assert.equal(row.payload.type, 'companion_intro');
});
test('saved C1 reads and duplicate open survive a fresh real login and changed write admission; a new choice still requires actual current consent and email', async () => {
    const a = await actor();
    await born(a);
    const first = (await open(a)).json();
    await fixture.db.query('UPDATE platform_users SET auth_version=auth_version+1,email_verified_at=NULL WHERE id=$1', [a.who.userId]);
    await fixture.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [a.who.userId]);
    const fresh = await login(a.who.userId);
    assert.equal((await read(a)).statusCode, 401);
    assert.deepEqual((await read(fresh)).json(), first);
    assert.deepEqual((await open(fresh)).json(), first);
    assert.equal((await choose(fresh, { operationId: randomUUID(), expectedRevision: 1, choice: 'begin' })).statusCode, 403);
    assert.equal((await read(fresh)).json().step, 'C1');
});
test('explicit next-path choice is revision guarded and recoverable without repetition; altered intent and a second device cannot overwrite it', async () => {
    const a = await actor();
    await born(a);
    await open(a);
    const command = { operationId: randomUUID(), expectedRevision: 1, choice: 'begin' };
    const accepted = await choose(a, command);
    assert.equal(accepted.statusCode, 200);
    const result = parseCompanionWelcomeChoiceResult(accepted.json());
    assert.equal(result.state.step, 'C2');
    assert.equal(result.operation.replayed, false);
    const again = await choose(a, command);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().operation.replayed, true);
    assert.deepEqual(again.json().state, result.state);
    assert.equal((await choose(a, { ...command, choice: 'direct_letter' })).statusCode, 409);
    assert.equal((await choose(a, { ...command, operationId: randomUUID() })).statusCode, 409);
    for (const body of [{ ...command, persona: 'caller' }, { ...command, expectedRevision: 2 }, { ...command, operationId: command.operationId.toUpperCase() }])
        assert.equal((await choose(a, body)).statusCode, 400);
    assert.deepEqual(await count(a), { welcomes: 1, operations: 1, intros: 1, jobs: 0 });
    await fixture.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [a.who.userId]);
    assert.equal((await choose(a, command)).statusCode, 200);
});
test('direct letter records C7 intention, never fabricates a delivered letter, model call, job or main chat turn', async () => {
    const a = await actor();
    await born(a);
    await open(a);
    const r = await choose(a, { operationId: randomUUID(), expectedRevision: 1, choice: 'direct_letter' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().state.step, 'C7');
    assert.equal(r.json().state.choice, 'direct_letter');
    assert.deepEqual(await count(a), { welcomes: 1, operations: 1, intros: 1, jobs: 0 });
    assert.equal(providerCalls, 0);
});
test('authenticated message/source damage closes private reads, and database constraints reject a forged next path', async () => {
    const a = await actor();
    await born(a);
    const first = (await open(a)).json();
    await choose(a, { operationId: randomUUID(), expectedRevision: 1, choice: 'begin' });
    await fixture.db.query("UPDATE platform_companion_welcome SET step='C7',choice='direct_letter' WHERE user_id=$1", [a.who.userId]);
    assert.equal((await read(a)).statusCode, 503);
    await fixture.db.query("UPDATE platform_companion_welcome SET step='C2',choice='begin' WHERE user_id=$1", [a.who.userId]);
    assert.equal((await read(a)).statusCode, 200);
    await fixture.db.query("UPDATE platform_messages SET payload='{}' WHERE id=$1", [first.intro.id]);
    assert.equal((await read(a)).statusCode, 503);
    assert.equal((await open(a)).statusCode, 503);
    await assert.rejects(fixture.db.query("UPDATE platform_companion_welcome SET revision=1 WHERE user_id=$1", [a.who.userId]));
});
test('new C1 opening refuses damaged authentic protected name evidence rather than borrowing the committed birth as current safety clearance', async () => {
    const a = await actor();
    await born(a);
    await fixture.db.query("UPDATE platform_companion_name_submissions SET result_ciphertext=$2 WHERE user_id=$1", [a.who.userId, Buffer.from('fictional damaged classifier capture')]);
    assert.equal((await open(a)).statusCode, 503);
    assert.deepEqual(await count(a), { welcomes: 0, operations: 0, intros: 0, jobs: 0 });
});


test('damaged authentic safety evidence after opening blocks a new choice, while the immutable introduction stays readable', async () => {
    const a = await actor();
    await born(a);
    const first = (await open(a)).json();
    await fixture.db.query("UPDATE platform_companion_name_submissions SET result_ciphertext=$2 WHERE user_id=$1",
        [a.who.userId, Buffer.from('fictional changed authentic safety evidence')]);
    assert.deepEqual((await read(a)).json(), first);
    assert.equal((await choose(a, { operationId: randomUUID(), expectedRevision: 1, choice: 'begin' })).statusCode, 503);
    assert.deepEqual(await count(a), { welcomes: 1, operations: 0, intros: 1, jobs: 0 });
});

test('actual source IDs, non-null stage choices and account deletion preserve the closed welcome ownership boundary', async () => {
    const a = await actor();
    await born(a);
    assert.equal((await open(a, { expectedCompanionId: randomUUID() })).statusCode, 409);
    assert.equal((await count(a)).welcomes, 0);
    const first = (await open(a)).json();
    const wrong = await system.app.inject({ method: 'POST', url: prefix + '/choice', headers: headers(a),
        payload: { operationId: randomUUID(), welcomeId: randomUUID(), expectedRevision: 1, choice: 'begin' } });
    assert.equal(wrong.statusCode, 409);
    await assert.rejects(fixture.db.query("UPDATE platform_companion_welcome SET revision=2,step='C2',choice=NULL WHERE user_id=$1", [a.who.userId]));
    await choose(a, { operationId: randomUUID(), expectedRevision: 1, choice: 'begin' });
    await fixture.db.query('DELETE FROM platform_users WHERE id=$1', [a.who.userId]);
    assert.deepEqual(await count(a), { welcomes: 0, operations: 0, intros: 0, jobs: 0 });
    assert.equal((await fixture.db.query('SELECT id FROM platform_messages WHERE id=$1', [first.intro.id])).rowCount, 0);
});

test('first-letter progress HTTP is a private read of actual preparation and never publishes or starts a model',async()=>{
 const a=await actor(),url='/api/platform/companion/first-letter/progress';
 assert.equal((await system.app.inject({url,headers:headers(a)})).statusCode,409);
 await born(a);await open(a);
 assert.equal((await system.app.inject({url,headers:headers(a)})).statusCode,409);
 await choose(a,{operationId:randomUUID(),expectedRevision:1,choice:'direct_letter'});
 let result=await system.app.inject({url,headers:headers(a)});assert.equal(result.statusCode,200,result.body);
 assert.equal(result.json().state,'not_started');assert.equal(result.headers['cache-control'],'private, no-store');
 const before=await count(a);
 const daily=new CompanionDailySettingsService(fixture.db,fixture.config,FICTIONAL_LEGAL);
 await daily.change(a.who,{operationId:randomUUID(),expectedRevision:0,companionId:(await read(a)).json().companionId,
  preferences:{timeZone:'America/New_York',morningTime:'09:00',quietStart:'22:30',quietEnd:'08:30',dailyMinutes:90,webAlert:'none'}});
 await system.firstLetterTasks.prepare(a.who,await system.firstLetterSettings.read(a.who));
 result=await system.app.inject({url,headers:headers(a)});assert.equal(result.statusCode,200,result.body);
 assert.equal(result.json().state,'prepared');assert.equal(result.json().delivered,false);assert.equal(result.json().ownerId,a.who.userId);
 assert.equal((await system.app.inject({url})).statusCode,401);
 assert.equal((await system.app.inject({url,headers:{...headers(a),[PLATFORM_ACCOUNT_HEADER]:randomUUID()}})).statusCode,409);
 assert.equal((await system.app.inject({url:url+'?taskId='+randomUUID(),headers:headers(a)})).statusCode,400);
 assert.equal((await system.app.inject({method:'POST',url,headers:headers(a),payload:{state:'reviewed'}})).statusCode,404);
 assert.deepEqual(await count(a),before);assert.equal((await read(a)).json().step,'C7');assert.equal(providerCalls,0);
});
