import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { buildApp, type AppOptions } from '../src/app.ts';
import { tokenHash } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';

// Real HTTP, authentication and database fixtures. Every actor connects from the
// same loopback address; only verified sessions distinguish account limits.
const prefix = '/api/platform', origin = 'https://limits-fixture.invalid';
const base = readConfig(), schema = `request_limits_${randomUUID().replaceAll('-', '')}`;
const admin = new Database(base.databaseUrl), url = new URL(base.databaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const databases = [new Database(url.toString()), new Database(url.toString())];
type System = Awaited<ReturnType<typeof buildApp>>;
type Actor = { id: string; email: string; cookie: string };
type Response = { status: number; headers: IncomingHttpHeaders; bytes: Buffer };
let systems: System[] = [], ports: number[] = [], directory: string;
let schemaCreated = false;
const calls = { chat: 0, speech: 0, transcription: 0, realtime: 0, job: 0 };
const requestLimits: NonNullable<AppOptions['requestLimits']> = { policies: {
  api: { max: 4, windowSeconds: 60 }, chat: { max: 2, windowSeconds: 60 },
  speech: { max: 2, windowSeconds: 60 }, transcription: { max: 2, windowSeconds: 60 }, realtime: { max: 2, windowSeconds: 60 },
  control: { max: 100, windowSeconds: 60 }, public: { max: 1000, windowSeconds: 60 },
  'auth-login': { max: 100, windowSeconds: 60 }, 'auth-register': { max: 100, windowSeconds: 60 },
} };

function wav() {
  const bytes = Buffer.alloc(92);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}
const runtime: PlatformProviderRuntime = {
  capabilities: () => [{ id: 'limits-fixture', name: 'Synthetic request limit transport', enabled: true, keyConfigured: true,
    capabilities: ['chat', 'speech', 'transcription', 'realtime'], models: ['synthetic-model'], envVariables: [] }],
  async *streamChat() { calls.chat++; yield { type: 'delta', text: 'Fictional limiter response' }; },
  async executeJob() { calls.job++; throw new Error('This fixture does not execute jobs.'); },
  async speech() { calls.speech++; return { name: 'fictional-limiter.wav', mime: 'audio/wav', bytes: wav() }; },
  async transcribe() { calls.transcription++; return { text: 'Fictional limiter transcript' }; },
  async createVoiceSession() {
    calls.realtime++;
    return { clientSecret: 'fictional-ephemeral-session', model: 'synthetic-model', endpoint: 'https://voice-fixture.invalid/calls' };
  },
};

function exchange(instance: number, route: string, actor?: Actor, options: {
  method?: string; headers?: Record<string, string>; body?: Buffer | string;
} = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const request = http.request({ host: '127.0.0.1', port: ports[instance], path: prefix + route, method: options.method ?? 'GET', agent: false,
      headers: { origin, ...(actor ? { cookie: actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id } : {}), ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}), ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.setTimeout(10_000, () => request.destroy(new Error('Request-limit HTTP fixture timed out.')));
    if (body !== undefined) request.write(body); request.end();
  });
}
function post(instance: number, route: string, actor: Actor | undefined, body: unknown, headers: Record<string, string> = {}) {
  return exchange(instance, route, actor, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function json(response: Response) {
  assert.match(String(response.headers['content-type']), /application\/json/);
  return JSON.parse(response.bytes.toString('utf8'));
}
function cookie(response: Response) {
  const value = response.headers['set-cookie']?.[0]; assert.ok(value, 'Real registration/login must issue a session cookie.');
  assert.match(value, /HttpOnly/); assert.match(value, /SameSite=Lax/); return value.split(';')[0]!;
}
async function register(instance = 0): Promise<Actor> {
  const email = `limits-${randomUUID()}@example.invalid`;
  const response = await post(instance, '/auth/register', undefined, { name: 'Fictional limiter tester', email, password: 'Fictional-limiter-password-2026' });
  assert.equal(response.status, 201, response.bytes.toString()); return { id: json(response).user.id, email, cookie: cookie(response) };
}
async function login(actor: Actor, instance = 1): Promise<Actor> {
  const response = await post(instance, '/auth/login', undefined, { email: actor.email, password: 'Fictional-limiter-password-2026' });
  assert.equal(response.status, 200, response.bytes.toString()); assert.equal(json(response).user.id, actor.id);
  return { ...actor, cookie: cookie(response) };
}
function tokens(value: string | string[] | undefined) {
  return String(value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
}
function limited(response: Response, windowSeconds = 60) {
  assert.equal(response.status, 429, response.bytes.toString());
  assert.equal(json(response).error.code, 'REQUEST_LIMIT_REACHED');
  const retry = Number(response.headers['retry-after']);
  assert(Number.isInteger(retry) && retry > 0 && retry <= windowSeconds, 'Retry-After must state a bounded positive number of seconds.');
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert(tokens(response.headers['access-control-expose-headers']).includes('retry-after'));
  assert.equal(response.headers['cache-control'], 'private, no-store');
}
async function transcription(instance: number, actor: Actor) {
  const boundary = `fictional-limits-${randomUUID()}`;
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fictional-limiter.wav"\r\nContent-Type: audio/wav\r\n\r\n`), wav(),
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="provider"\r\n\r\nlimits-fixture\r\n--${boundary}--\r\n`)]);
  return exchange(instance, '/voice/transcribe', actor, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
}
async function insertConversation(actor: Actor) {
  const id = randomUUID();
  await databases[0]!.query("INSERT INTO platform_conversations(id,user_id,title,mode) VALUES($1,$2,'Fictional limiter conversation','chat')", [id, actor.id]);
  return id;
}
async function exhaustApi(actor: Actor) {
  for (let index = 0; index < 4; index++) {
    const response = await exchange(index % 2, '/auth/me', actor); assert.equal(response.status, 200, response.bytes.toString());
  }
  limited(await exchange(1, '/auth/me', actor));
}

async function start(instance: number, limits = requestLimits) {
  systems[instance] = await buildApp({ db: databases[instance], runtime, enableQueue: false, requestLimits: limits,
    config: { ...base, databaseUrl: url.toString(), storageDir: directory, s3: undefined, webStaticDir: undefined,
      allowedOrigins: new Set([origin]), secureCookies: true } });
  await systems[instance]!.app.listen({ host: '127.0.0.1', port: 0 });
  ports[instance] = (systems[instance]!.app.server.address() as AddressInfo).port;
}
before(async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.databaseUrl).hostname), 'Only a local test database is allowed.');
  await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true; await databases[0]!.migrate();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-request-limits-'));
  await start(0); await start(1);
});
after(async () => {
  await Promise.all(systems.map(system => system.app.close()));
  await Promise.all(databases.map(db => db.close()));
  try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
  finally { await admin.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); }
});

test('verified account limits share paths and instances while same-IP accounts and real session rotation remain isolated', async () => {
  const alice = await register(), bob = await register(1);
  const paths = ['/auth/me', '/conversations', '/jobs', '/usage'];
  for (const [index, route] of paths.entries()) {
    const response = await exchange(index % 2, route, alice); assert.equal(response.status, 200, response.bytes.toString());
    if (route === '/auth/me') assert.equal(json(response).user.id, alice.id);
  }
  limited(await exchange(0, '/auth/me', alice));
  const other = await exchange(1, '/auth/me', bob); assert.equal(other.status, 200, other.bytes.toString()); assert.equal(json(other).user.id, bob.id);
  const secondSession = await login(alice); assert.notEqual(secondSession.cookie, alice.cookie);
  limited(await exchange(1, '/auth/me', secondSession));
});

test('rebuilding an API instance preserves the verified user counter in PostgreSQL', async () => {
  const actor = await register();
  for (const instance of [0, 1]) assert.equal((await exchange(instance, '/auth/me', actor)).status, 200);
  await systems[1]!.app.close(); await start(1);
  for (const instance of [1, 0]) assert.equal((await exchange(instance, '/auth/me', actor)).status, 200);
  limited(await exchange(1, '/auth/me', actor));
});

test('simultaneous real HTTP requests at both instances atomically accept only the configured maximum', async () => {
  const actor = await register();
  const responses = await Promise.all(Array.from({ length: 24 }, (_, index) => exchange(index % 2, '/auth/me', actor)));
  assert.equal(responses.filter(response => response.status === 200).length, 4);
  assert.equal(responses.filter(response => response.status === 429).length, 20);
  for (const response of responses) {
    if (response.status === 200) assert.equal(json(response).user.id, actor.id); else limited(response);
  }
  const row = await databases[0]!.query("SELECT request_count FROM platform_request_limits WHERE subject_type='user' AND subject_key=$1 AND scope='api'", [actor.id]);
  assert.equal(row.rows[0].request_count, 4, 'Denied requests must not grow the persisted counter past its configured maximum.');
});

test('a PostgreSQL-expired window restores the full shared allowance without rebuilding either API instance', async () => {
  const actor = await register(); await exhaustApi(actor);
  const expired = await databases[0]!.query(`UPDATE platform_request_limits SET expires_at=clock_timestamp()-interval '1 second'
    WHERE subject_type='user' AND subject_key=$1 AND scope='api' RETURNING request_count`, [actor.id]);
  assert.equal(expired.rowCount, 1); assert.equal(expired.rows[0].request_count, 4);
  const first = await exchange(1, '/auth/me', actor); assert.equal(first.status, 200, first.bytes.toString()); assert.equal(json(first).user.id, actor.id);
  const renewed = await databases[0]!.query(`SELECT request_count,expires_at > clock_timestamp() AS active
    FROM platform_request_limits WHERE subject_type='user' AND subject_key=$1 AND scope='api'`, [actor.id]);
  assert.deepEqual(renewed.rows, [{ request_count: 1, active: true }], 'The database starts a new window with its own current time.');
  for (const instance of [0, 1, 0]) assert.equal((await exchange(instance, '/auth/me', actor)).status, 200);
  limited(await exchange(1, '/auth/me', actor));
  const exhausted = await databases[0]!.query("SELECT request_count FROM platform_request_limits WHERE subject_type='user' AND subject_key=$1 AND scope='api'", [actor.id]);
  assert.equal(exhausted.rows[0].request_count, 4);
});

test('missing, forged and expired cookies retain 401 instead of acquiring or exhausting an alleged account key', async () => {
  const owner = await register(), expired = await register(1); await exhaustApi(owner);
  const expiredToken = expired.cookie.slice(expired.cookie.indexOf('=') + 1);
  await databases[0]!.query("UPDATE platform_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [tokenHash(expiredToken)]);
  for (const cookieValue of [undefined, `companion_session=${owner.id}`, 'companion_session=fictional-unknown-session', expired.cookie, `companion_session=${'x'.repeat(129)}`]) {
    for (let index = 0; index < 6; index++) {
      const response = await exchange(index % 2, '/auth/me', undefined, { headers: cookieValue === undefined ? {} : { cookie: cookieValue } });
      assert.equal(response.status, 401, response.bytes.toString()); assert.equal(json(response).error.code, 'AUTH_REQUIRED');
      assert.equal(response.headers['retry-after'], undefined);
    }
  }
  const active = await login(expired);
  assert.equal((await exchange(1, '/auth/me', active)).status, 200, 'Rejected cookies must not consume that verified account limit.');
  limited(await exchange(0, '/auth/me', owner));
});

test('speech and transcription have independent shared generation scopes without consuming the account API allowance', async () => {
  const actor = await register(), before = { ...calls };
  for (const instance of [0, 1]) {
    const response = await post(instance, '/voice/speech', actor, { provider: 'limits-fixture', text: 'Fictional speech limit script' });
    assert.equal(response.status, 201, response.bytes.toString());
  }
  limited(await post(0, '/voice/speech', actor, { provider: 'limits-fixture', text: 'Fictional rejected script' }));
  for (const instance of [1, 0]) {
    const response = await transcription(instance, actor); assert.equal(response.status, 200, response.bytes.toString());
    assert.equal(json(response).text, 'Fictional limiter transcript');
  }
  limited(await transcription(1, actor));
  assert.equal(calls.speech - before.speech, 2); assert.equal(calls.transcription - before.transcription, 2);
  await exhaustApi(actor);
});

test('chat uses a shared dedicated scope and exhausted generation limits leave private reads available', async () => {
  const actor = await register(), id = await insertConversation(actor), before = calls.chat;
  for (const instance of [0, 1]) {
    const response = await post(instance, `/conversations/${id}/messages`, actor, { provider: 'limits-fixture', content: 'Fictional request limit prompt', mode: 'chat' });
    assert.equal(response.status, 200, response.bytes.toString()); assert.match(String(response.headers['content-type']), /^text\/event-stream/);
    assert.match(response.bytes.toString(), /event: done/);
  }
  limited(await post(1, `/conversations/${id}/messages`, actor, { provider: 'limits-fixture', content: 'Fictional rejected prompt', mode: 'chat' }));
  assert.equal(calls.chat - before, 2);
  const messages = await databases[0]!.query('SELECT count(*)::integer AS n FROM platform_messages WHERE conversation_id=$1', [id]);
  assert.equal(messages.rows[0].n, 4, 'Rejected generation must not persist a user or assistant message.');
  const read = await exchange(0, `/conversations/${id}`, actor); assert.equal(read.status, 200, read.bytes.toString());
  assert.equal(json(read).messages.length, 4);
});

test('exhausted generation and API scopes retain owned cancellation, voice release and logout with Origin and ownership guards', async () => {
  const owner = await register(), other = await register(1);
  for (const instance of [0, 1]) {
    const response = await post(instance, '/voice/speech', owner, { provider: 'limits-fixture', text: 'Fictional cleanup fixture' });
    assert.equal(response.status, 201, response.bytes.toString());
  }
  limited(await post(0, '/voice/speech', owner, { provider: 'limits-fixture', text: 'Fictional exhausted script' }));
  await exhaustApi(owner);
  const first = await post(0, '/voice/session', owner, { provider: 'limits-fixture' }); assert.equal(first.status, 200, first.bytes.toString());
  const firstSession = json(first).sessionId;
  assert.equal((await post(1, '/voice/session/release', owner, { sessionId: firstSession })).status, 200);
  const second = await post(1, '/voice/session', owner, { provider: 'limits-fixture' }); assert.equal(second.status, 200, second.bytes.toString());
  const sessionId = json(second).sessionId;
  limited(await post(0, '/voice/session', owner, { provider: 'limits-fixture' }));
  const jobId = randomUUID();
  await databases[0]!.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,'image','limits-fixture','Fictional queued task','queued')", [jobId, owner.id]);
  const leaseCount = async () => (await databases[0]!.query("SELECT count(*)::integer AS n FROM platform_runtime_leases WHERE user_id=$1 AND kind='voice'", [owner.id])).rows[0].n;
  assert.equal(await leaseCount(), 1);

  const wrongOwner = await post(0, `/jobs/${jobId}/cancel`, other, {});
  assert.equal(wrongOwner.status, 404, wrongOwner.bytes.toString()); assert.equal(json(wrongOwner).error.code, 'NOT_FOUND');
  assert.equal((await post(1, '/voice/session/release', other, { sessionId })).status, 200);
  assert.equal(await leaseCount(), 1, 'A different account cannot release the owned voice lease.');
  const wrongOrigin = await exchange(0, '/voice/session/release', owner, { method: 'POST',
    headers: { origin: 'https://untrusted-fixture.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) });
  assert.equal(wrongOrigin.status, 403); assert.equal(json(wrongOrigin).error.code, 'ORIGIN_REJECTED'); assert.equal(await leaseCount(), 1);
  assert.equal((await databases[0]!.query('SELECT status FROM platform_jobs WHERE id=$1', [jobId])).rows[0].status, 'queued');

  const cancelled = await post(1, `/jobs/${jobId}/cancel`, owner, {});
  assert.equal(cancelled.status, 200, cancelled.bytes.toString()); assert.equal(json(cancelled).job.status, 'cancelled');
  const release = await post(0, '/voice/session/release', owner, { sessionId }); assert.equal(release.status, 200, release.bytes.toString());
  assert.equal(await leaseCount(), 0);
  assert.equal((await databases[0]!.query('SELECT released_at IS NOT NULL AS released FROM platform_voice_sessions WHERE id=$1', [sessionId])).rows[0].released, true);
  assert.equal((await post(1, '/voice/session/release', owner, { sessionId })).status, 200, 'Owned release remains idempotent.');
  const loggedOut = await post(1, '/auth/logout', owner, {}); assert.equal(loggedOut.status, 200, loggedOut.bytes.toString());
  assert.equal(json(loggedOut).ok, true); assert.match(String(loggedOut.headers['set-cookie']), /companion_session=;/);
  const afterLogout = await exchange(0, '/auth/me', owner); assert.equal(afterLogout.status, 401); assert.equal(json(afterLogout).error.code, 'AUTH_REQUIRED');
  const ownerToken = owner.cookie.slice(owner.cookie.indexOf('=') + 1);
  assert.equal((await databases[0]!.query('SELECT count(*)::integer AS n FROM platform_sessions WHERE token_hash=$1', [tokenHash(ownerToken)])).rows[0].n, 0);
});

test('an unavailable shared limiter returns safe 503 before providers, leases, persisted messages or SSE headers', async () => {
  const actor = await register(), conversationId = await insertConversation(actor), before = { ...calls };
  const state = async () => (await databases[0]!.query(`SELECT
    (SELECT count(*)::integer FROM platform_messages WHERE conversation_id=$1) AS messages,
    (SELECT count(*)::integer FROM platform_uploads WHERE user_id=$2) AS uploads,
    (SELECT count(*)::integer FROM platform_runtime_leases WHERE user_id=$2) AS leases,
    (SELECT count(*)::integer FROM platform_usage WHERE user_id=$2) AS usage`, [conversationId, actor.id])).rows[0];
  const saved = await state();
  await databases[0]!.query('ALTER TABLE platform_request_limits RENAME TO platform_request_limits_unavailable');
  try {
    const responses = [
      await post(0, '/voice/speech', actor, { provider: 'limits-fixture', text: 'Fictional blocked script' }),
      await transcription(1, actor),
      await post(0, '/voice/session', actor, { provider: 'limits-fixture' }),
      await post(1, `/conversations/${conversationId}/messages`, actor, { provider: 'limits-fixture', content: 'Fictional blocked prompt', mode: 'chat' }),
    ];
    for (const response of responses) {
      assert.equal(response.status, 503, response.bytes.toString()); assert.equal(json(response).error.code, 'REQUEST_LIMIT_UNAVAILABLE');
      assert.equal(response.headers['access-control-allow-origin'], origin);
      assert(!response.bytes.toString().includes('platform_request_limits')); assert(!response.bytes.toString().includes(schema));
      assert(!response.bytes.toString().includes('event: ')); assert.equal(response.headers['x-accel-buffering'], undefined);
    }
    assert.deepEqual(calls, before); assert.deepEqual(await state(), saved);
  } finally { await databases[0]!.query('ALTER TABLE platform_request_limits_unavailable RENAME TO platform_request_limits'); }
  const recovered = await post(1, '/voice/speech', actor, { provider: 'limits-fixture', text: 'Fictional recovered script' });
  assert.equal(recovered.status, 201, recovered.bytes.toString()); assert.equal(calls.speech - before.speech, 1);
});

test('a locked PostgreSQL counter times out safely before the provider and recovers after the independent lock is released', async () => {
  const actor = await register();
  const first = await post(0, '/voice/speech', actor, { provider: 'limits-fixture', text: 'Fictional lock fixture' });
  assert.equal(first.status, 201, first.bytes.toString());
  await systems[1]!.app.close(); await start(1, { ...requestLimits, counterTimeoutMs: 100 });
  const before = { ...calls }, client = await databases[0]!.pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query("SELECT request_count FROM platform_request_limits WHERE subject_type='user' AND subject_key=$1 AND scope='speech' FOR UPDATE", [actor.id]);
    assert.equal(locked.rows[0].request_count, 1);
    const response = await post(1, '/voice/speech', actor, { provider: 'limits-fixture', text: 'Fictional blocked lock request' });
    assert.equal(response.status, 503, response.bytes.toString()); assert.equal(json(response).error.code, 'REQUEST_LIMIT_UNAVAILABLE');
    assert(!response.bytes.toString().includes('statement timeout')); assert(!response.bytes.toString().includes('platform_request_limits'));
    assert.deepEqual(calls, before);
    const saved = await databases[0]!.query(`SELECT
      (SELECT request_count FROM platform_request_limits WHERE subject_type='user' AND subject_key=$1 AND scope='speech') AS requests,
      (SELECT count(*)::integer FROM platform_uploads WHERE user_id=$2) AS uploads,
      (SELECT count(*)::integer FROM platform_runtime_leases WHERE user_id=$2) AS leases`, [actor.id, actor.id]);
    assert.deepEqual(saved.rows, [{ requests: 1, uploads: 1, leases: 0 }], 'A timed-out counter must roll back without granting execution.');
  } finally { await client.query('ROLLBACK'); client.release(); }
  const recovered = await post(1, '/voice/speech', actor, { provider: 'limits-fixture', text: 'Fictional recovered lock request' });
  assert.equal(recovered.status, 201, recovered.bytes.toString()); assert.equal(calls.speech - before.speech, 1);
  limited(await post(0, '/voice/speech', actor, { provider: 'limits-fixture', text: 'Fictional exhausted recovered window' }));
  await systems[1]!.app.close(); await start(1);
});

test('anonymous public, login and registration quotas share the socket identity across instances despite forged forwarding headers and cookies', async () => {
  const actor = await register(), before = { ...calls };
  const users = (await databases[0]!.query('SELECT count(*)::integer AS n FROM platform_users')).rows[0].n;
  const anonymousLimits: NonNullable<AppOptions['requestLimits']> = { ...requestLimits, policies: { ...requestLimits.policies,
    public: { max: 2, windowSeconds: 60 }, 'auth-login': { max: 2, windowSeconds: 60 }, 'auth-register': { max: 2, windowSeconds: 60 },
  } };
  await systems[0]!.app.close(); await systems[1]!.app.close();
  // Clear only this isolated schema's setup IP windows before applying smaller
  // server-side policies. Existing verified account/session data is retained.
  await databases[0]!.query("DELETE FROM platform_request_limits WHERE subject_type='ip'");
  await start(0, anonymousLimits); await start(1, anonymousLimits);
  const spoof = (index: number) => ({ 'x-forwarded-for': `198.51.100.${index + 10}`,
    forwarded: `for=203.0.113.${index + 10}`, cookie: `companion_session=fictional-forwarded-cookie-${index}` });
  for (const instance of [0, 1]) {
    const response = await exchange(instance, '/capabilities', undefined, { headers: spoof(instance) });
    assert.equal(response.status, 200, response.bytes.toString()); assert.equal(json(response).providers[0].id, 'limits-fixture');
  }
  limited(await exchange(0, '/capabilities', actor, { headers: spoof(2) }));

  for (const instance of [1, 0]) {
    const response = await post(instance, '/auth/login', undefined,
      { email: actor.email, password: 'Fictional-wrong-password-2026' }, spoof(instance + 3));
    assert.equal(response.status, 401, response.bytes.toString()); assert.equal(json(response).error.code, 'INVALID_CREDENTIALS');
  }
  limited(await post(1, '/auth/login', actor, { email: actor.email, password: 'Fictional-limiter-password-2026' }, spoof(5)));

  for (const instance of [0, 1]) {
    const response = await post(instance, '/auth/register', undefined, { name: 'Fictional forwarded registration',
      email: `limits-forwarded-${randomUUID()}@example.invalid`, password: 'Fictional-limiter-password-2026' }, spoof(instance + 6));
    assert.equal(response.status, 201, response.bytes.toString()); cookie(response);
  }
  limited(await post(0, '/auth/register', undefined, { name: 'Fictional rejected registration',
    email: `limits-forwarded-${randomUUID()}@example.invalid`, password: 'Fictional-limiter-password-2026' }, spoof(8)));
  assert.equal((await databases[0]!.query('SELECT count(*)::integer AS n FROM platform_users')).rows[0].n, users + 2);
  const windows = await databases[0]!.query("SELECT subject_key,scope,request_count FROM platform_request_limits WHERE subject_type='ip' ORDER BY scope");
  assert.deepEqual(windows.rows.map(row => ({ scope: row.scope, request_count: row.request_count })), [
    { scope: 'auth-login', request_count: 2 }, { scope: 'auth-register', request_count: 2 }, { scope: 'public', request_count: 2 },
  ]);
  assert.equal(new Set(windows.rows.map(row => row.subject_key)).size, 1, 'All three scopes must bind the same real socket address.');
  assert.match(windows.rows[0].subject_key, /^[0-9a-f]{64}$/, 'The fixture stores a socket digest rather than raw forwarding headers or cookies.');
  assert.deepEqual(calls, before);
});
