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
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { LocalBlobStorage, type BlobReadOptions } from '../src/storage.ts';

// These are real HTTP/session/PG protocol tests. A Node client explicitly replays
// cookies; it cannot prove that a browser will send Secure/SameSite cookies.
const prefix = '/api/platform', origin = 'https://app.cors-fixture.invalid', secondOrigin = 'https://studio.cors-fixture.invalid';
const schema = `cors_${randomUUID().replaceAll('-', '')}`, base = readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1', PLATFORM_CHAT_PROVIDER: 'cors-fixture', PLATFORM_AGENT_PROVIDER: 'cors-fixture' }), admin = new Database(base.databaseUrl);
const databaseUrl = new URL(base.databaseUrl); databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(databaseUrl.toString());
type Actor = { id: string; cookie: string };
type Response = { status: number; headers: IncomingHttpHeaders; bytes: Buffer };
let system: Awaited<ReturnType<typeof buildApp>>, directory: string, port: number, alice: Actor, bob: Actor;
let artifactId: string, uploadId: string, media: Buffer, modelCalls = 0, cancelled = false;
let releaseStream: (() => void) | undefined, streamGate: Promise<void> | undefined;

class TrackingStorage extends LocalBlobStorage {
  statCalls = 0; openCalls = 0; putCalls = 0;
  override async stat(key: string, signal?: AbortSignal) { this.statCalls++; return super.stat(key, signal); }
  override async openRead(key: string, options: BlobReadOptions) { this.openCalls++; return super.openRead(key, options); }
  override async put(key: string, bytes: Uint8Array) { this.putCalls++; return super.put(key, bytes); }
}
let storage: TrackingStorage;
const forbidden = async (): Promise<never> => { throw new Error('No commercial model or task is used by the CORS fixture.'); };
const runtime: PlatformProviderRuntime = {
  capabilities: () => [{ id: 'cors-fixture', name: 'Synthetic CORS transport', keyConfigured: true, enabled: true, capabilities: ['chat'], models: ['synthetic'], envVariables: [] }],
  async *streamChat(input, context) {
    modelCalls++;
    yield { type: 'delta', text: 'Fictional ' };
    const content = input.messages.at(-1)?.content;
    if (content === 'fixture-error') throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'The synthetic transport failed.');
    if (content === 'fixture-cancel') {
      await new Promise<void>(resolve => {
        const aborted = () => { cancelled = true; context?.signal?.removeEventListener('abort', aborted); resolve(); };
        if (context?.signal?.aborted) aborted(); else context?.signal?.addEventListener('abort', aborted, { once: true });
      });
      return;
    }
    if (content === 'fixture-held-stream') await streamGate;
    yield { type: 'delta', text: 'CORS response' };
  },
  executeJob: forbidden, createVoiceSession: forbidden, transcribe: forbidden, speech: forbidden,
};

function exchange(route: string, actor?: Actor, options: {
  method?: string; headers?: Record<string, string>; body?: Buffer | string;
  outsidePrefix?: boolean; onData?: (bytes: Buffer, headers: IncomingHttpHeaders) => void;
} = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const request = http.request({ host: '127.0.0.1', port, path: (options.outsidePrefix ? '' : prefix) + route, method: options.method ?? 'GET', agent: false,
      headers: { ...(actor ? { cookie: actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id } : {}), ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}), ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); options.onData?.(Buffer.concat(chunks), response.headers); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.setTimeout(10_000, () => request.destroy(new Error('CORS HTTP fixture timed out.')));
    if (body !== undefined) request.write(body); request.end();
  });
}
function jsonRequest(route: string, actor: Actor | undefined, body: unknown, requestedOrigin = origin) {
  return exchange(route, actor, { method: 'POST', headers: { origin: requestedOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function tokens(value: string | string[] | undefined): string[] { return String(value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean); }
function cors(headers: IncomingHttpHeaders, expected = origin) {
  assert.equal(headers['access-control-allow-origin'], expected);
  assert.equal(headers['access-control-allow-credentials'], 'true');
  assert(tokens(headers.vary).includes('origin'));
  assert.notEqual(headers['access-control-allow-origin'], '*');
}
function noCors(headers: IncomingHttpHeaders) { assert.equal(headers['access-control-allow-origin'], undefined); }
function result(response: Response) { assert.match(String(response.headers['content-type']), /application\/json/); return JSON.parse(response.bytes.toString('utf8')); }
async function register(name: string): Promise<Actor> {
  const response = await jsonRequest('/auth/register', undefined, { name, email: `${randomUUID()}@example.invalid`, password: 'Fictional-cors-password-123' });
  assert.equal(response.status, 201, response.bytes.toString()); cors(response.headers);
  const cookie = response.headers['set-cookie']![0]!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Secure/);
  return { id: result(response).user.id, cookie: cookie.split(';')[0]! };
}
async function conversation(title: string) {
  const response = await jsonRequest('/conversations', alice, { title, mode: 'chat' });
  assert.equal(response.status, 201, response.bytes.toString()); return result(response).conversation.id as string;
}
async function state() {
  return (await db.query('SELECT (SELECT count(*) FROM platform_users) AS users,(SELECT count(*) FROM platform_conversations) AS conversations,(SELECT count(*) FROM platform_messages) AS messages,(SELECT count(*) FROM platform_uploads) AS uploads,(SELECT count(*) FROM platform_jobs) AS jobs,(SELECT count(*) FROM platform_approvals) AS approvals')).rows[0];
}
async function until(run: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await run()) { if (Date.now() >= deadline) assert.fail('CORS fixture cleanup did not finish.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CORS stream did not flush before its completion gate.')), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); await db.migrate(); directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-cors-http-'));
  storage = new TrackingStorage(directory);
  system = await buildApp({ db, storage, runtime, enableQueue: false,
    config: { ...base, databaseUrl: databaseUrl.toString(), storageDir: directory, allowedOrigins: new Set([origin, secondOrigin]), secureCookies: true } });
  await system.app.listen({ host: '127.0.0.1', port: 0 }); port = (system.app.server.address() as AddressInfo).port;
  alice = await register('Fictional CORS owner'); bob = await register('Fictional CORS other owner');
  media = Buffer.alloc(1024); for (let index = 0; index < media.length; index++) media[index] = index % 251; media.write('ftyp', 4);
  const boundary = `cors-${randomUUID()}`;
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fictional-cors-media.mp4"\r\nContent-Type: video/mp4\r\n\r\n`), media, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const uploaded = await exchange('/uploads', alice, { method: 'POST', headers: { origin, 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
  assert.equal(uploaded.status, 201, uploaded.bytes.toString()); cors(uploaded.headers); uploadId = result(uploaded).attachment.id;
  artifactId = randomUUID(); const jobId = randomUUID();
  await db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,'video','cors-fixture','Fictional transport bytes; not model-generated','succeeded')", [jobId, alice.id]);
  await db.query("INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id) VALUES($1,$2,$3,'video','video/mp4','fictional-cors-media.mp4',$4)", [artifactId, alice.id, jobId, uploadId]);
});
after(async () => {
  releaseStream?.(); await system?.app.close(); await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test('credentialed exact-origin preflight permits only the reviewed API methods and headers without executing business work', async () => {
  const saved = await state(), calls = modelCalls, puts = storage.putCalls, stats = storage.statCalls, opens = storage.openCalls;
  const headers = `cOnTeNt-TyPe, Accept, RANGE, if-match, If-Range, ${PLATFORM_ACCOUNT_HEADER.toUpperCase()}`;
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await exchange(`/artifacts/${artifactId}`, undefined, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': headers } });
    assert.equal(response.status, 204, response.bytes.toString()); assert.equal(response.bytes.length, 0); cors(response.headers);
    assert(tokens(response.headers['access-control-allow-methods']).includes(method.toLowerCase()));
    assert.deepEqual(new Set(tokens(response.headers['access-control-allow-headers'])), new Set(['content-type', 'accept', 'range', 'if-match', 'if-range', PLATFORM_ACCOUNT_HEADER]));
    assert.equal(response.headers['set-cookie'], undefined);
  }
  const registration = await exchange('/auth/register', undefined, { method: 'OPTIONS', headers: { origin: secondOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(registration.status, 204); cors(registration.headers, secondOrigin);
  assert.deepEqual(await state(), saved); assert.equal(modelCalls, calls); assert.equal(storage.putCalls, puts); assert.equal(storage.statCalls, stats); assert.equal(storage.openCalls, opens);
});

test('untrusted, null, suffix and path origins receive no CORS grant and mutations retain Origin protection', async () => {
  const saved = await state();
  for (const untrusted of ['null', 'https://untrusted.invalid', `${origin}.evil.invalid`, `${origin}/`, `${origin}/path`, `${origin}:444`]) {
    const preflight = await exchange('/conversations', undefined, { method: 'OPTIONS', headers: { origin: untrusted, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    noCors(preflight.headers);
    const read = await exchange('/capabilities', undefined, { headers: { origin: untrusted } }); assert.equal(read.status, 200); noCors(read.headers);
    const mutation = await jsonRequest('/conversations', alice, { title: 'This must not be inserted' }, untrusted);
    assert.equal(mutation.status, 403); assert.equal(result(mutation).error.code, 'ORIGIN_REJECTED'); noCors(mutation.headers);
  }
  assert.deepEqual(await state(), saved);
  const noOrigin = await exchange('/auth/me', alice); assert.equal(noOrigin.status, 200); noCors(noOrigin.headers);
  const noOriginMutation = await exchange('/conversations', alice, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noOriginMutation.status, 403); noCors(noOriginMutation.headers);
});

test('unsupported preflight methods and headers return 400 without advertising permission or touching the database domain', async () => {
  const saved = await state(), calls = modelCalls, reads = storage.statCalls;
  for (const [method, headers] of [['TRACE', 'content-type'], ['CONNECT', 'content-type'], ['OPTIONS', 'content-type'], ['POST', 'authorization'], ['GET', 'Range, X-Fictional-Secret'], ['POST', 'Cookie']] as const) {
    const response = await exchange('/conversations', undefined, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': headers } });
    assert.equal(response.status, 400, `${method}/${headers}: ${response.bytes.toString()}`);
    assert.equal(response.headers['access-control-allow-methods'], undefined); assert.equal(response.headers['access-control-allow-headers'], undefined);
  }
  assert.deepEqual(await state(), saved); assert.equal(modelCalls, calls); assert.equal(storage.statCalls, reads);
});

test('actual JSON requests and safe 400/401/404 responses retain exact credentialed CORS with private caching', async () => {
  for (const requestedOrigin of [origin, secondOrigin]) {
    const own = await exchange('/auth/me', alice, { headers: { origin: requestedOrigin } });
    assert.equal(own.status, 200); assert.equal(result(own).user.id, alice.id); cors(own.headers, requestedOrigin);
    assert(tokens(own.headers['cache-control']).includes('private')); assert(tokens(own.headers['cache-control']).includes('no-store'));
  }
  const id = await conversation('Fictional JSON CORS context');
  for (const [route, actor, status] of [['/auth/me', undefined, 401], [`/conversations/${id}`, bob, 404], ['/unknown-fixture-route', alice, 404]] as const) {
    const response = await exchange(route, actor, { headers: { origin } }); assert.equal(response.status, status); cors(response.headers);
    const error = result(response).error; assert.ok(typeof error === 'string' ? error : error.code);
  }
  const invalid = await jsonRequest('/conversations', alice, { title: 123 }); assert.equal(invalid.status, 400); cors(invalid.headers); assert.ok(result(invalid).error.code);
});

test('multipart upload is private and both owner checks reject before storage while exposing only file response metadata', async () => {
  const stored = await db.query('SELECT user_id,byte_size FROM platform_uploads WHERE id=$1', [uploadId]);
  assert.equal(stored.rows[0].user_id, alice.id); assert.equal(Number(stored.rows[0].byte_size), media.length);
  const stats = storage.statCalls, opens = storage.openCalls;
  for (const route of [`/uploads/${uploadId}`, `/artifacts/${artifactId}`]) {
    for (const [actor, status] of [[undefined, 401], [bob, 404]] as const) for (const method of ['GET', 'HEAD']) {
      const response = await exchange(route, actor, { method, headers: { origin, range: 'bytes=0-3' } });
      assert.equal(response.status, status); cors(response.headers); assert.equal(response.headers['content-range'], undefined);
      if (method === 'HEAD') assert.equal(response.bytes.length, 0); else assert.ok(result(response).error.code);
    }
  }
  assert.equal(storage.statCalls, stats); assert.equal(storage.openCalls, opens);
});

test('private 200/HEAD/206/416 responses retain CORS and expose Range, version and download headers over real HTTP', async () => {
  for (const route of [`/uploads/${uploadId}`, `/artifacts/${artifactId}`]) {
    const full = await exchange(route, alice, { headers: { origin } }); assert.equal(full.status, 200); assert.deepEqual(full.bytes, media); cors(full.headers);
    const exposed = new Set(tokens(full.headers['access-control-expose-headers']));
    for (const name of ['content-range', 'accept-ranges', 'content-length', 'etag', 'content-disposition']) assert(exposed.has(name), `${name} must be readable by the configured frontend.`);
    assert.equal(full.headers['cache-control'], 'private, no-store'); assert.equal(full.headers['x-content-type-options'], 'nosniff');
    const opens = storage.openCalls;
    const head = await exchange(route, alice, { method: 'HEAD', headers: { origin, range: 'bytes=2-7' } });
    assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(head.headers['content-length'], String(media.length)); assert.equal(storage.openCalls, opens); cors(head.headers);
    const partial = await exchange(route, alice, { headers: { origin, range: 'bytes=2-7', 'if-range': String(full.headers.etag) } });
    assert.equal(partial.status, 206); assert.deepEqual(partial.bytes, media.subarray(2, 8)); assert.equal(partial.headers['content-range'], `bytes 2-7/${media.length}`); assert.equal(partial.headers['content-length'], '6'); cors(partial.headers);
    const outside = await exchange(route, alice, { headers: { origin, range: `bytes=${media.length}-` } });
    assert.equal(outside.status, 416); assert.equal(outside.headers['content-range'], `bytes */${media.length}`); assert.equal(outside.bytes.length, 0); cors(outside.headers);
  }
});

test('explicit same private download URL preserves filenames and CORS without bypassing artifact ownership', async () => {
  const route = `/artifacts/${artifactId}?download=1`;
  for (const method of ['GET', 'HEAD']) {
    const response = await exchange(route, alice, { method, headers: { origin } });
    assert.equal(response.status, 200); cors(response.headers);
    assert.equal(response.headers['content-disposition'], "attachment; filename*=UTF-8''fictional-cors-media.mp4");
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.bytes.length, method === 'HEAD' ? 0 : media.length);
  }
  const ranged = await exchange(route, alice, { headers: { origin, range: 'bytes=1-3' } }); assert.equal(ranged.status, 206); cors(ranged.headers); assert.deepEqual(ranged.bytes, media.subarray(1, 4));
  const stats = storage.statCalls;
  const forbiddenDownload = await exchange(route, bob, { headers: { origin } }); assert.equal(forbiddenDownload.status, 404); cors(forbiddenDownload.headers); assert.equal(storage.statCalls, stats);
});

test('hijacked SSE sends credentialed CORS before completion and persists the synthetic response', async () => {
  const id = await conversation('Fictional held CORS stream');
  streamGate = new Promise<void>(resolve => { releaseStream = resolve; });
  let first!: (headers: IncomingHttpHeaders) => void, sawDelta = false;
  const firstDelta = new Promise<IncomingHttpHeaders>(resolve => { first = resolve; });
  const pending = exchange(`/conversations/${id}/messages`, alice, { method: 'POST', headers: { origin: secondOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'fixture-held-stream', mode: 'chat' }),
    onData(bytes, headers) { if (!sawDelta && bytes.toString().includes('event: delta')) { sawDelta = true; first(headers); } } });
  void pending.catch(() => {});
  try {
    const headers = await bounded(firstDelta); cors(headers, secondOrigin); assert.match(String(headers['content-type']), /^text\/event-stream/);
    for (const directive of ['private', 'no-store', 'no-transform']) assert(tokens(headers['cache-control']).includes(directive));
    assert.equal(headers['x-accel-buffering'], 'no');
    const message = await db.query("SELECT status FROM platform_messages WHERE conversation_id=$1 AND role='assistant'", [id]); assert.equal(message.rows[0].status, 'streaming');
  } finally { releaseStream?.(); streamGate = undefined; releaseStream = undefined; }
  const response = await pending; assert.equal(response.status, 200); assert.match(response.bytes.toString(), /event: done/); cors(response.headers, secondOrigin);
  const saved = await db.query("SELECT status,content FROM platform_messages WHERE conversation_id=$1 AND role='assistant'", [id]);
  assert.equal(saved.rows[0].status, 'complete'); assert.equal(saved.rows[0].content, 'Fictional CORS response');
});

test('SSE errors retain raw CORS headers and client disconnect still cancels the synthetic runtime and lease', async () => {
  const errorId = await conversation('Fictional CORS stream failure');
  const failed = await jsonRequest(`/conversations/${errorId}/messages`, alice, { content: 'fixture-error', mode: 'chat' });
  assert.equal(failed.status, 200); cors(failed.headers); assert.match(failed.bytes.toString(), /event: error/); assert.match(failed.bytes.toString(), /PROVIDER_UNAVAILABLE/); assert.doesNotMatch(failed.bytes.toString(), /event: done/);
  assert.equal((await db.query("SELECT status FROM platform_messages WHERE conversation_id=$1 AND role='assistant'", [errorId])).rows[0].status, 'failed');
  const id = await conversation('Fictional CORS stream cancellation'); cancelled = false;
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ content: 'fixture-cancel', mode: 'chat' });
    const request = http.request({ host: '127.0.0.1', port, path: `${prefix}/conversations/${id}/messages`, method: 'POST', agent: false,
      headers: { origin, cookie: alice.cookie, [PLATFORM_ACCOUNT_HEADER]: alice.id, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      cors(response.headers); let text = '';
      response.on('data', chunk => { text += chunk.toString(); if (text.includes('event: delta')) { request.destroy(); response.destroy(); resolve(); } }); response.on('error', () => {});
    });
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(new Error('CORS cancellation fixture timed out.'))); request.end(body);
  });
  await until(async () => cancelled && (await db.query("SELECT status FROM platform_messages WHERE conversation_id=$1 AND role='assistant'", [id])).rows[0]?.status === 'cancelled'
    && (await db.query('SELECT count(*) FROM platform_runtime_leases WHERE user_id=$1', [alice.id])).rows[0].count === '0');
  assert.equal((await db.query('SELECT count(*) FROM platform_runtime_leases WHERE user_id=$1', [alice.id])).rows[0].count, '0');
});

test('CORS is limited to the exact platform path prefix and never grants access to unrelated routes', async () => {
  for (const route of ['/outside-api-fixture', '/api/platform-extra/capabilities', '/api/other-fixture']) {
    const response = await exchange(route, undefined, { outsidePrefix: true, headers: { origin } }); assert.equal(response.status, 404); noCors(response.headers);
    const preflight = await exchange(route, undefined, { outsidePrefix: true, method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } }); noCors(preflight.headers); assert.notEqual(preflight.status, 204);
  }
});
