import { PLATFORM_ACCOUNT_HEADER, PLATFORM_ACCOUNT_QUERY, type PlatformProviderRuntime } from '@companion/platform-contracts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { LocalBlobStorage, type BlobReadOptions } from '../src/storage.ts';

// Real sessions and PostgreSQL, with fictional actors and injected providers.
// Node explicitly replays cookies; this does not reproduce a browser's cookie jar.
const prefix = '/api/platform', origin = 'http://localhost:4321';
const password = 'Fictional-account-context-password-2026';
const base = readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1', PLATFORM_CHAT_PROVIDER: 'account-context-fixture', PLATFORM_AGENT_PROVIDER: 'account-context-fixture', PLATFORM_REALTIME_PROVIDER: 'account-context-fixture', PLATFORM_TRANSCRIPTION_PROVIDER: 'account-context-fixture', PLATFORM_SPEECH_PROVIDER: 'account-context-fixture' }), schema = `account_context_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(base.databaseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname), 'This fixture must use a loopback PostgreSQL instance.');
databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Database(base.databaseUrl), db = new Database(databaseUrl.toString());
type Actor = { id: string; cookie: string; email: string };
type Response = { status: number; headers: IncomingHttpHeaders; bytes: Buffer };
type Options = { method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'; cookie?: string; expected?: string | string[]; rawHeaders?: string[];
  headers?: Record<string, string | string[]>; payload?: Record<string, unknown> | Buffer };
let system: Awaited<ReturnType<typeof buildApp>>, storage: TrackingStorage, directory: string, port: number;
let alice: Actor, bob: Actor, aliceConversation: string, bobConversation: string, uploadId: string, artifactId: string;
let createdSchema = false;
const calls = { chat: 0, jobs: 0, transcription: 0, speech: 0, realtime: 0 };
function wav() {
  const bytes = Buffer.alloc(92); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}
const media = wav();
class TrackingStorage extends LocalBlobStorage {
  puts = 0; stats = 0; opens = 0;
  override async put(key: string, bytes: Uint8Array) { ++this.puts; return super.put(key, bytes); }
  override async stat(key: string, signal?: AbortSignal) { ++this.stats; return super.stat(key, signal); }
  override async openRead(key: string, options: BlobReadOptions) { ++this.opens; return super.openRead(key, options); }
}
const runtime: PlatformProviderRuntime = {
  capabilities: () => [{ id: 'account-context-fixture', name: 'Fictional account transport', enabled: true, keyConfigured: true,
    capabilities: ['chat', 'image', 'speech', 'transcription', 'realtime'], models: ['synthetic'], voiceOptions: { speech: { voices: ['fictional-fixed-voice'], defaultVoice: 'fictional-fixed-voice' }, realtime: { voices: ['fictional-fixed-voice'], defaultVoice: 'fictional-fixed-voice', turnTaking: true } }, envVariables: [] }],
  async *streamChat() { ++calls.chat; yield { type: 'delta', text: 'Fictional account-bound response.' }; },
  async executeJob() { ++calls.jobs; throw new Error('The account-context fixture does not execute queued jobs.'); },
  async transcribe() { ++calls.transcription; return { text: 'Fictional account-bound transcript.' }; },
  async speech() { ++calls.speech; return { name: 'fictional-speech.wav', mime: 'audio/wav', bytes: media }; },
  async createVoiceSession() { ++calls.realtime; return { clientSecret: 'fictional-ephemeral-session', model: 'synthetic', endpoint: 'https://voice-fixture.invalid/calls' }; },
};
function prepared(options: Options) {
  const body = Buffer.isBuffer(options.payload) ? options.payload : options.payload === undefined ? undefined : Buffer.from(JSON.stringify(options.payload));
  const headers = { ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.expected !== undefined ? { [PLATFORM_ACCOUNT_HEADER]: options.expected } : {}),
    ...(options.method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method) ? { origin } : {}),
    ...(body ? { 'content-length': String(body.length), ...(Buffer.isBuffer(options.payload) ? {} : { 'content-type': 'application/json' }) } : {}), ...options.headers };
  return { body, headers };
}
async function inject(route: string, options: Options = {}): Promise<Response> {
  const { body, headers } = prepared(options);
  const response = await system.app.inject({ method: options.method ?? 'GET', url: prefix + route, headers, payload: body });
  return { status: response.statusCode, headers: response.headers as IncomingHttpHeaders, bytes: response.rawPayload };
}
function exchange(route: string, options: Options = {}): Promise<Response> {
  const { body, headers } = prepared(options);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: prefix + route, method: options.method ?? 'GET', agent: false, headers: options.rawHeaders ?? headers }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.setTimeout(10_000, () => request.destroy(new Error('Account-context HTTP fixture timed out.')));
    if (body) request.write(body); request.end();
  });
}
function json(response: Response) { return JSON.parse(response.bytes.toString('utf8')); }
function expectError(response: Response, status: number, code: string, head = false) {
  assert.equal(response.status, status, response.bytes.toString());
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['content-range'], undefined); assert.equal(response.headers['content-disposition'], undefined);
  assert.equal(response.headers.etag, undefined); assert.equal(response.headers['x-accel-buffering'], undefined);
  if (head) assert.equal(response.bytes.length, 0); else { assert.equal(json(response).error.code, code); assert(!response.bytes.toString().includes('event: ')); }
}
function multipart(provider = false) {
  const boundary = `context-${randomUUID()}`;
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fictional-recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`), media,
    Buffer.from(`\r\n${provider ? `--${boundary}\r\nContent-Disposition: form-data; name="provider"\r\n\r\naccount-context-fixture\r\n` : ''}--${boundary}--\r\n`)]);
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
async function register(name: string): Promise<Actor> {
  const email = `context-${randomUUID()}@example.invalid`;
  const response = await exchange('/auth/register', { method: 'POST', payload: { name, email, password } });
  assert.equal(response.status, 201, response.bytes.toString());
  assert.match(response.headers['set-cookie']![0]!, /Path=\//); assert.match(response.headers['set-cookie']![0]!, /HttpOnly/);
  return { id: json(response).user.id, email, cookie: response.headers['set-cookie']![0]!.split(';')[0]! };
}
async function state() {
  return (await db.query(`SELECT
    (SELECT count(*)::integer FROM platform_conversations) AS conversations,
    (SELECT count(*)::integer FROM platform_messages) AS messages,
    (SELECT count(*)::integer FROM platform_memories) AS memories,
    (SELECT count(*)::integer FROM platform_uploads) AS uploads,
    (SELECT count(*)::integer FROM platform_jobs) AS jobs,
    (SELECT count(*)::integer FROM platform_approvals) AS approvals,
    (SELECT count(*)::integer FROM platform_voice_sessions) AS voice_sessions,
    (SELECT count(*)::integer FROM platform_voice_records) AS voice_records,
    (SELECT count(*)::integer FROM platform_runtime_leases) AS leases,
    (SELECT count(*)::integer FROM platform_usage) AS usage,
    (SELECT count(*)::integer FROM platform_account_actions) AS account_actions,
    (SELECT count(*)::integer FROM platform_account_email_outbox) AS mail,
    (SELECT count(*)::integer FROM platform_sessions) AS sessions,
    (SELECT coalesce(sum(request_count),0)::integer FROM platform_request_limits WHERE subject_type='user') AS user_requests`)).rows[0];
}
function sideEffects() { return { ...calls, puts: storage.puts, stats: storage.stats, opens: storage.opens }; }
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); createdSchema = true; await db.migrate();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-account-context-')); storage = new TrackingStorage(directory);
  system = await buildApp({ db, storage, runtime, enableQueue: false,
    config: { ...base, databaseUrl: databaseUrl.toString(), storageDir: directory, s3: undefined, webStaticDir: undefined,
      accountEmail: undefined, requireVerifiedEmail: false, allowedOrigins: new Set([origin]) } });
  await system.app.listen({ host: '127.0.0.1', port: 0 }); port = (system.app.server.address() as AddressInfo).port;
  alice = await register('Fictional account A'); bob = await register('Fictional account B');
  for (const actor of [alice, bob]) {
    const response = await inject('/conversations', { method: 'POST', cookie: actor.cookie, expected: actor.id, payload: { title: 'Fictional account-bound conversation' } });
    assert.equal(response.status, 201, response.bytes.toString());
    if (actor === alice) aliceConversation = json(response).conversation.id; else bobConversation = json(response).conversation.id;
  }
  const uploaded = await inject('/uploads', { method: 'POST', cookie: alice.cookie, expected: alice.id, ...multipart() });
  assert.equal(uploaded.status, 201, uploaded.bytes.toString()); uploadId = json(uploaded).attachment.id;
  artifactId = randomUUID(); const jobId = randomUUID();
  await db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,'speech','account-context-fixture','Fictional fixture bytes','succeeded')", [jobId, alice.id]);
  await db.query("INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id) VALUES($1,$2,$3,'audio','audio/wav','fictional-recording.wav',$4)", [artifactId, alice.id, jobId, uploadId]);
});
after(async () => {
  await system?.app.close(); await db.close();
  try { if (createdSchema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.close(); }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test('each private request authenticates its real cookie before validating an account assertion', async () => {
  for (const send of [inject, exchange]) {
    for (const expected of [undefined, alice.id, 'not-an-account']) {
      expectError(await send('/conversations', { expected }), 401, 'AUTH_REQUIRED');
      expectError(await send('/conversations', { method: 'POST', expected, payload: { title: 'Fictional rejected anonymous draft' } }), 401, 'AUTH_REQUIRED');
    }
    expectError(await send('/conversations', { cookie: alice.cookie }), 409, 'ACCOUNT_CONTEXT_REQUIRED');
    expectError(await send('/conversations', { cookie: bob.cookie, expected: alice.id }), 409, 'ACCOUNT_CONTEXT_CHANGED');
    expectError(await send('/conversations', { cookie: alice.cookie, expected: bob.id }), 409, 'ACCOUNT_CONTEXT_CHANGED');
    const upper = await send('/conversations', { cookie: alice.cookie, expected: alice.id.toUpperCase() });
    assert.equal(upper.status, 200, upper.bytes.toString()); assert.deepEqual(json(upper).conversations.map((item: { id: string }) => item.id), [aliceConversation]);
  }
});

test('malformed, repeated and misplaced assertions fail before private reads, counters or provider work', async () => {
  const saved = await state(), effects = sideEffects();
  for (const expected of ['', ` ${alice.id}`, `${alice.id} `, 'not-an-account', `${alice.id}, ${alice.id}`, [alice.id, alice.id]]) {
    expectError(await inject('/conversations', { cookie: alice.cookie, expected }), 400, 'ACCOUNT_CONTEXT_INVALID');
  }
  // A real HTTP client preserves repeated header lines, including identical UUIDs.
  expectError(await exchange('/conversations', { cookie: alice.cookie, expected: [alice.id, alice.id] }), 400, 'ACCOUNT_CONTEXT_INVALID');
  expectError(await exchange('/conversations', { rawHeaders: ['Host', `127.0.0.1:${port}`, 'Cookie', alice.cookie, PLATFORM_ACCOUNT_HEADER, alice.id, PLATFORM_ACCOUNT_HEADER.toUpperCase(), alice.id] }), 400, 'ACCOUNT_CONTEXT_INVALID');
  for (const route of [`/conversations?${PLATFORM_ACCOUNT_QUERY}=${alice.id}`, `/artifacts/${artifactId}/text?${PLATFORM_ACCOUNT_QUERY}=${alice.id}`]) {
    expectError(await exchange(route, { cookie: alice.cookie }), 400, 'ACCOUNT_CONTEXT_INVALID');
    expectError(await exchange(route, { cookie: alice.cookie, expected: alice.id }), 400, 'ACCOUNT_CONTEXT_INVALID');
  }
  assert.deepEqual(await state(), saved); assert.deepEqual(sideEffects(), effects);
});

test('account drift blocks reads, writes, SSE, uploads and all voice controls before any domain effects', async () => {
  const session = await inject('/voice/session', { method: 'POST', cookie: bob.cookie, expected: bob.id, payload: {} });
  assert.equal(session.status, 200, session.bytes.toString()); const sessionId = json(session).sessionId;
  const saved = await state(), effects = sideEffects(), fakeId = randomUUID();
  const routes: Array<[Options['method'], string, Record<string, unknown> | undefined]> = [
    ['GET', '/conversations', undefined], ['GET', `/conversations/${bobConversation}`, undefined],
    ['POST', '/conversations', { title: 'Fictional stale-window draft' }], ['DELETE', `/conversations/${bobConversation}`, undefined],
    ['POST', `/conversations/${bobConversation}/messages`, { content: 'Fictional stale-window prompt', mode: 'chat' }],
    ['GET', `/conversations/${bobConversation}/voice-records`, undefined],
    ['POST', `/conversations/${bobConversation}/voice-records`, { clientRecordId: fakeId, source: 'transcription_excerpt', role: 'user', text: 'Fictional stale excerpt' }],
    ['GET', '/usage', undefined], ['GET', '/workflow-templates', undefined], ['POST', '/workflow-templates', {}],
    ['PUT', `/workflow-templates/${fakeId}`, {}], ['DELETE', `/workflow-templates/${fakeId}`, undefined],
    ['GET', '/jobs', undefined], ['GET', `/jobs/${fakeId}`, undefined],
    ['POST', '/jobs', { kind: 'image', provider: 'account-context-fixture', prompt: 'Fictional blocked image' }],
    ['POST', `/jobs/${fakeId}/cancel`, {}], ['POST', `/jobs/${fakeId}/retry`, {}],
    ['GET', '/approvals', undefined], ['POST', `/approvals/${fakeId}/decision`, { decision: 'approved' }],
    ['GET', '/memories', undefined], ['POST', '/memories', { content: 'Fictional blocked memory' }], ['DELETE', `/memories/${fakeId}`, undefined],
    ['GET', '/knowledge-sources', undefined], ['GET', `/knowledge-sources/${fakeId}`, undefined],
    ['POST', '/knowledge-sources', {}], ['PUT', `/knowledge-sources/${fakeId}`, {}], ['DELETE', `/knowledge-sources/${fakeId}`, {}],
    ['POST', '/knowledge-search', { query: 'Fictional query' }], ['GET', `/artifacts/${artifactId}/reference-attachment`, undefined], ['GET', `/artifacts/${artifactId}/text`, undefined],
    ['POST', '/voice/session', {}], ['POST', '/voice/session/release', { sessionId }],
    ['POST', '/voice/speech', { text: 'Fictional stale-window narration' }],
    ['POST', '/auth/logout', {}], ['POST', '/auth/email-verification/request', {}], ['POST', '/auth/email-verification/complete', { token: 'fictional-invalid-token' }],
  ];
  for (const [method, route, payload] of routes) {
    expectError(await inject(route, { method, cookie: bob.cookie, expected: alice.id, payload }), 409, 'ACCOUNT_CONTEXT_CHANGED');
  }
  for (const route of ['/uploads', '/voice/transcribe']) for (const send of [inject, exchange]) {
    expectError(await send(route, { method: 'POST', cookie: bob.cookie, expected: alice.id, ...multipart(route.includes('transcribe')) }), 409, 'ACCOUNT_CONTEXT_CHANGED');
  }
  // The real SSE endpoint returns JSON before entering or writing a stream.
  expectError(await exchange(`/conversations/${bobConversation}/messages`, { method: 'POST', cookie: bob.cookie, expected: alice.id,
    payload: { content: 'Fictional blocked SSE prompt' } }), 409, 'ACCOUNT_CONTEXT_CHANGED');
  assert.deepEqual(await state(), saved); assert.deepEqual(sideEffects(), effects);
  assert.equal((await db.query('SELECT released_at FROM platform_voice_sessions WHERE id=$1', [sessionId])).rows[0].released_at, null);
  const release = await inject('/voice/session/release', { method: 'POST', cookie: bob.cookie, expected: bob.id, payload: { sessionId } });
  assert.equal(release.status, 200, release.bytes.toString());
});

test('native media URLs bind GET, HEAD, Range and download to their expected cookie owner', async () => {
  for (const file of [`/uploads/${uploadId}`, `/artifacts/${artifactId}`]) {
    const url = `${file}?${PLATFORM_ACCOUNT_QUERY}=${alice.id}`, effects = sideEffects(), saved = await state();
    for (const method of ['GET', 'HEAD'] as const) {
      expectError(await exchange(url, { method, cookie: bob.cookie, headers: { range: 'bytes=0-7' } }), 409, 'ACCOUNT_CONTEXT_CHANGED', method === 'HEAD');
      expectError(await exchange(file, { method, cookie: alice.cookie }), 409, 'ACCOUNT_CONTEXT_REQUIRED', method === 'HEAD');
      expectError(await exchange(url, { method, expected: alice.id }), 401, 'AUTH_REQUIRED', method === 'HEAD');
      expectError(await exchange(url, { method, cookie: alice.cookie, expected: bob.id }), 400, 'ACCOUNT_CONTEXT_INVALID', method === 'HEAD');
      expectError(await exchange(`${url}&${PLATFORM_ACCOUNT_QUERY}=${alice.id}`, { method, cookie: alice.cookie }), 400, 'ACCOUNT_CONTEXT_INVALID', method === 'HEAD');
      expectError(await exchange(`${file}?${PLATFORM_ACCOUNT_QUERY}=not-an-account`, { method, cookie: alice.cookie }), 400, 'ACCOUNT_CONTEXT_INVALID', method === 'HEAD');
    }
    assert.deepEqual(sideEffects(), effects); assert.deepEqual(await state(), saved);
    const full = await exchange(url, { cookie: alice.cookie }); assert.equal(full.status, 200, full.bytes.toString()); assert.deepEqual(full.bytes, media);
    const partial = await exchange(url, { cookie: alice.cookie, headers: { range: 'bytes=0-7', 'if-range': String(full.headers.etag) } });
    assert.equal(partial.status, 206, partial.bytes.toString()); assert.deepEqual(partial.bytes, media.subarray(0, 8)); assert.equal(partial.headers['content-range'], `bytes 0-7/${media.length}`);
    const opens = storage.opens;
    const head = await exchange(url, { method: 'HEAD', cookie: alice.cookie }); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(storage.opens, opens);
    const downloaded = await exchange(`${url}&download=1`, { cookie: alice.cookie, expected: alice.id.toUpperCase() });
    assert.equal(downloaded.status, 200); assert.match(String(downloaded.headers['content-disposition']), /^attachment;/); assert.deepEqual(downloaded.bytes, media);
    expectError(await exchange(`${file}?${PLATFORM_ACCOUNT_QUERY}=${bob.id}`, { cookie: bob.cookie }), 404, 'NOT_FOUND');
  }
});

test('bootstrap and authentication endpoints remain usable while logout and verification require binding', async () => {
  for (const route of ['/health', '/capabilities', '/auth/options']) assert.equal((await exchange(route)).status, 200);
  for (const actor of [alice, bob]) {
    const me = await exchange('/auth/me', { cookie: actor.cookie, expected: 'malformed-and-exempt' });
    assert.equal(me.status, 200); assert.equal(json(me).user.id, actor.id);
    for (const route of ['/auth/logout', '/auth/email-verification/request', '/auth/email-verification/complete']) {
      expectError(await exchange(route, { method: 'POST', cookie: actor.cookie, payload: { token: 'fictional-invalid-token' } }), 409, 'ACCOUNT_CONTEXT_REQUIRED');
    }
  }
  const reset = await exchange('/auth/password-reset/request', { method: 'POST', expected: 'malformed-and-exempt', payload: { email: alice.email } });
  assert.equal(reset.status, 503); assert.equal(json(reset).error.code, 'ACCOUNT_EMAIL_UNAVAILABLE');
  const complete = await exchange('/auth/password-reset/complete', { method: 'POST', payload: { token: 'fictional-invalid-token', password } });
  assert.equal(complete.status, 400); assert.equal(json(complete).error.code, 'ACCOUNT_ACTION_INVALID');
  const verification = await exchange('/auth/email-verification/request', { method: 'POST', cookie: alice.cookie, expected: alice.id, payload: {} });
  assert.equal(verification.status, 503); assert.equal(json(verification).error.code, 'ACCOUNT_EMAIL_UNAVAILABLE');
});

test('an auth/me result cannot authorize a later request after the shared cookie changes, and matched requests still work', async () => {
  let sharedCookie = alice.cookie;
  const me = await exchange('/auth/me', { cookie: sharedCookie }); assert.equal(me.status, 200); const windowAccount = json(me).user.id;
  const login = await exchange('/auth/login', { method: 'POST', payload: { email: bob.email, password } });
  assert.equal(login.status, 200); assert.equal(json(login).user.id, bob.id); sharedCookie = login.headers['set-cookie']![0]!.split(';')[0]!;
  const saved = await state(), effects = sideEffects();
  expectError(await exchange('/memories', { method: 'POST', cookie: sharedCookie, expected: windowAccount, payload: { content: 'Fictional stale-window memory' } }), 409, 'ACCOUNT_CONTEXT_CHANGED');
  const racing = await Promise.all([
    exchange('/memories', { method: 'POST', cookie: alice.cookie, expected: alice.id, payload: { content: 'Fictional current-window memory' } }),
    exchange('/memories', { method: 'POST', cookie: sharedCookie, expected: alice.id, payload: { content: 'Fictional stale-window race' } }),
  ]);
  assert.equal(racing[0]!.status, 201, racing[0]!.bytes.toString()); expectError(racing[1]!, 409, 'ACCOUNT_CONTEXT_CHANGED');
  const memories = await db.query('SELECT user_id,content FROM platform_memories');
  assert.deepEqual(memories.rows, [{ user_id: alice.id, content: 'Fictional current-window memory' }]);
  const afterRace = await state(); assert.equal(afterRace.memories, saved.memories + 1); assert.equal(afterRace.user_requests, saved.user_requests + 1);
  assert.deepEqual(sideEffects(), effects);
  const chat = await exchange(`/conversations/${bobConversation}/messages`, { method: 'POST', cookie: sharedCookie, expected: bob.id,
    payload: { content: 'Fictional correctly bound chat', mode: 'chat' } });
  assert.equal(chat.status, 200, chat.bytes.toString()); assert.match(String(chat.headers['content-type']), /^text\/event-stream/); assert.match(chat.bytes.toString(), /event: done/);
  const transcript = await exchange('/voice/transcribe', { method: 'POST', cookie: sharedCookie, expected: bob.id, ...multipart() });
  assert.equal(transcript.status, 200, transcript.bytes.toString()); assert.equal(json(transcript).text, 'Fictional account-bound transcript.');
  const speech = await inject('/voice/speech', { method: 'POST', cookie: sharedCookie, expected: bob.id, payload: { text: 'Fictional correctly bound speech' } });
  assert.equal(speech.status, 201, speech.bytes.toString());
  assert.equal(calls.chat, effects.chat + 1); assert.equal(calls.transcription, effects.transcription + 1); assert.equal(calls.speech, effects.speech + 1);
  const logout = await exchange('/auth/logout', { method: 'POST', cookie: sharedCookie, expected: bob.id, payload: {} });
  assert.equal(logout.status, 200); expectError(await exchange('/conversations', { cookie: sharedCookie, expected: bob.id }), 401, 'AUTH_REQUIRED');
});
