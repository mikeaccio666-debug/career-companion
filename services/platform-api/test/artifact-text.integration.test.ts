import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ArtifactTextResult } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { ARTIFACT_TEXT_SOURCE_BYTES, parseArtifactTextInput } from '../src/artifact-text.ts';
import { LocalBlobStorage, type BlobReadOptions, type BlobReadResult } from '../src/storage.ts';

const prefix = '/api/platform', origin = 'http://localhost:4321', base = readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1', PLATFORM_CHAT_PROVIDER: 'openai', PLATFORM_AGENT_PROVIDER: 'openai' }), schema = `artifact_text_${randomUUID().replaceAll('-', '')}`;
const admin = new Database(base.databaseUrl), url = new URL(base.databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(url.toString());
type Actor = { id: string; cookie: string };
type Saved = { artifactId: string; uploadId: string; jobId: string; key: string; bytes: Buffer };
class Storage extends LocalBlobStorage {
  statCalls = 0; openCalls = 0; getCalls = 0;
  beforeOpen?: (key: string, options: BlobReadOptions) => Promise<BlobReadResult | undefined>;
  beforeStat?: () => Promise<void>;
  opened: { stream: Readable; signal?: AbortSignal; closed: boolean }[] = [];
  override async get(_key: string): Promise<never> { ++this.getCalls; throw new Error('Unbounded get is forbidden.'); }
  override async stat(key: string, signal?: AbortSignal) { ++this.statCalls; await this.beforeStat?.(); return super.stat(key, signal); }
  override async openRead(key: string, options: BlobReadOptions) {
    ++this.openCalls; const result = await this.beforeOpen?.(key, options) ?? await super.openRead(key, options);
    const tracked = { stream: result.stream, signal: options.signal, closed: result.stream.closed }; this.opened.push(tracked); result.stream.once('close', () => { tracked.closed = true; }); return result;
  }
}
let directory: string, storage: Storage, system: Awaited<ReturnType<typeof buildApp>>, port: number, alice: Actor, bob: Actor;
let agentSource: Saved, recoveredSource: Saved, agentMode: 'chain' | 'recover' = 'chain', agentTurn = 0, responses = 0;
const expectedCode = 'export const fictionalResult = "saved-private-content";\n';
const transport = (async (target: unknown, init?: RequestInit) => {
  assert(String(target).endsWith('/responses'), 'Only injected Responses transport is allowed; no external provider requests.'); ++responses;
  const body = JSON.parse(String(init?.body)), definition = body.tools.find((tool: any) => tool.name === 'read_artifact_text');
  assert.equal(definition.parameters.additionalProperties, false); assert.equal(definition.parameters.properties.maxBytes.maximum, 16384);
  const outputs = body.input.filter((item: any) => item.type === 'function_call_output'), last = outputs.length ? JSON.parse(outputs.at(-1).output) : undefined;
  const turn = ++agentTurn;
  let name: string, args: Record<string, unknown>;
  if (turn === 1) { name = agentMode === 'recover' ? 'read_artifact_text' : 'list_jobs'; args = agentMode === 'recover' ? { artifactId: agentSource.artifactId } : {}; }
  else if (turn === 2) {
    if (agentMode === 'recover') { assert.equal(last.error.code, 'NOT_FOUND'); name = 'read_artifact_text'; args = { artifactId: recoveredSource.artifactId, token: 'Fictional forbidden extra field.' }; }
    else { assert(last.jobs.some((job: any) => job.id === agentSource.jobId && job.artifacts.some((artifact: any) => artifact.id === agentSource.artifactId))); name = 'read_artifact_text'; args = { artifactId: agentSource.artifactId }; }
  } else if (turn === 3 && agentMode === 'recover') { assert.equal(last.error.code, 'INVALID_INPUT'); name = 'read_artifact_text'; args = { artifactId: recoveredSource.artifactId }; }
  else {
    const expected = agentMode === 'recover' ? recoveredSource : agentSource;
    assert.equal(last.text, expectedCode); assert.equal(last.provenance, 'untrusted_artifact'); assert.equal(last.source.artifactId, expected.artifactId); assert.equal(last.source.jobId, expected.jobId);
    return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Synthetic adapter received the actual saved text.' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'function_call', name, call_id: `fixture-${turn}`, arguments: JSON.stringify(args) }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}) as typeof fetch;
const runtime = createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-only', OPENAI_CHAT_MODEL: 'synthetic-text-reader' }, fetch: transport });
function exchange(route: string, actor?: Actor, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = http.request({ host: '127.0.0.1', port, path: prefix + route, agent: false, method: options.method ?? 'GET', headers: { ...(actor ? { cookie: actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id } : {}), ...(body ? { origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...options.headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }); request.on('error', reject); request.setTimeout(10000, () => request.destroy(new Error('Fictional HTTP fixture timed out.'))); if (body) request.write(body); request.end();
  });
}
async function register(): Promise<Actor> {
  const result = await exchange('/auth/register', undefined, { method: 'POST', body: { name: 'Fictional text reader', email: `${randomUUID()}@example.invalid`, password: 'Fictional-password-123' } });
  assert.equal(result.status, 201, result.body); return { id: JSON.parse(result.body).user.id, cookie: result.headers['set-cookie']![0]!.split(';')[0]! };
}
async function saved(user: Actor, content: string | Buffer = expectedCode, mime = 'text/plain', kind = 'cli', metadata = {}): Promise<Saved> {
  const artifactId = randomUUID(), uploadId = randomUUID(), jobId = randomUUID(), key = randomUUID(), bytes = typeof content === 'string' ? Buffer.from(content) : content;
  await storage.put(key, bytes);
  await db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,$3,'fictional-fixture','Fictional saved bytes, not generated by a model',$4)", [jobId, user.id, kind, kind === 'workflow' ? 'failed' : 'succeeded']);
  await db.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,\'fictional-code.ts\',$3,$4,$5)', [uploadId, user.id, mime, bytes.length, key]);
  await db.query('INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,filename,upload_id,metadata) VALUES($1,$2,$3,$4,$5,\'fictional-code.ts\',$6,$7)', [artifactId, user.id, jobId, kind === 'workflow' ? 'chat' : kind, mime, uploadId, JSON.stringify(metadata)]);
  return { artifactId, uploadId, jobId, key, bytes };
}
async function read(source: Saved, query = '', user = alice) { return exchange(`/artifacts/${source.artifactId}/text${query}`, user); }
async function until(condition: () => boolean) { const end = Date.now() + 3000; while (!condition()) { if (Date.now() > end) assert.fail('Expected artifact read cleanup did not settle.'); await new Promise(resolve => setTimeout(resolve, 5)); } }
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); await db.migrate(); directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-text-fixture-')); storage = new Storage(directory);
  system = await buildApp({ db, storage, config: { ...base, databaseUrl: url.toString(), storageDir: directory }, runtime, enableQueue: false });
  await system.app.listen({ host: '127.0.0.1', port: 0 }); port = (system.app.server.address() as import('node:net').AddressInfo).port;
  alice = await register(); bob = await register();
});
after(async () => { await system?.app.close(); await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

test('owned actual HTTP text reads preserve private source identities, bytes and file counts without creating or copying anything', async () => {
  const source = await saved(alice), files = await fs.readdir(directory), count = (await db.query('SELECT count(*) AS count FROM platform_jobs')).rows[0].count, before = responses;
  const response = await read(source); assert.equal(response.status, 200, response.body);
  const result: ArtifactTextResult = JSON.parse(response.body);
  assert.equal(result.text, expectedCode); assert.deepEqual(result.source, { artifactId: source.artifactId, jobId: source.jobId, name: 'fictional-code.ts', mime: 'text/plain', size: source.bytes.length });
  assert.equal(result.offset, 0); assert.equal(result.nextOffset, null); assert.equal(result.truncated, false); assert.equal(result.provenance, 'untrusted_artifact'); assert.equal(result.encoding, 'utf-8'); assert.match(result.version, /^"local-/);
  assert.equal(response.headers['cache-control'], 'private, no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.match(String(response.headers['content-type']), /application\/json/);
  assert.equal(response.body.includes(source.key), false); assert.equal(response.body.includes(directory), false); assert.deepEqual(await fs.readdir(directory), files); assert.equal((await db.query('SELECT count(*) AS count FROM platform_jobs')).rows[0].count, count); assert.equal(responses, before); assert.equal(storage.getCalls, 0);
  const partial = await saved(alice, 'Fictional completed workflow step.', 'text/plain', 'workflow', { workflowStep: 2, partialCompleted: true });
  assert.equal(JSON.parse((await read(partial)).body).source.workflowStep, 2);
});

test('owner checks cover artifact, upload and source job before any storage access, including guessed raw storage keys', async () => {
  for (const owner of ['foreign-request', 'artifact', 'upload', 'job']) {
    const source = await saved(alice), stat = storage.statCalls, opened = storage.openCalls;
    if (owner === 'artifact') await db.query('UPDATE platform_artifacts SET user_id=$2 WHERE id=$1', [source.artifactId, bob.id]);
    if (owner === 'upload') await db.query('UPDATE platform_uploads SET user_id=$2 WHERE id=$1', [source.uploadId, bob.id]);
    if (owner === 'job') await db.query('UPDATE platform_jobs SET user_id=$2 WHERE id=$1', [source.jobId, bob.id]);
    const result = await read(source, '', owner === 'foreign-request' ? bob : alice); assert.equal(result.status, 404, result.body); assert.equal(storage.statCalls, stat); assert.equal(storage.openCalls, opened);
    assert.equal((await exchange(`/artifacts/${source.key}/text`, alice)).status, 404);
  }
  const source = await saved(alice); assert.equal((await exchange(`/artifacts/${source.artifactId}/text`)).status, 401);
});

test('strict tool inputs and actual HTTP query validation reject unknown fields, unsafe numbers and unversioned continuation', async () => {
  const source = await saved(alice);
  for (const extra of [{ token: 'never-accepted' }, { offset: NaN }, { offset: 1.5 }, { offset: Infinity }, { offset: -1 }, { maxBytes: '100' }, { maxBytes: 16385 }, { maxBytes: 1 }, { maxBytes: false }, { version: 'W/"weak"' }, { offset: 1 }]) assert.throws(() => parseArtifactTextInput({ artifactId: source.artifactId, ...extra }));
  for (const query of ['?token=no', '?offset=1.5', '?offset=-1', '?offset=1', '?maxBytes=16385', '?maxBytes=100&maxBytes=200', '?version=W%2F%22weak%22']) assert.equal((await read(source, query)).status, 400);
});

test('UTF-8 pages preserve Unicode/BOM and exact retry offsets, are bounded including JSON escaping, and reassemble actual text', async () => {
  const content = '\ufeff' + '\t"\\🌱中文\n'.repeat(5000), source = await saved(alice, content, 'text/markdown');
  let offset = 0, version = '', collected = '', pages = 0;
  do {
    const query = `?offset=${offset}&maxBytes=16384${version ? `&version=${encodeURIComponent(version)}` : ''}`, response = await read(source, query); assert.equal(response.status, 200, response.body);
    const page: ArtifactTextResult = JSON.parse(response.body); assert.equal(page.offset, offset); assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(page.text)), page.text); assert(Buffer.byteLength(page.text) <= 16384); assert(response.body.length <= 48000); assert(Buffer.byteLength(response.body) < 64000);
    if (version) assert.equal(page.version, version); version = page.version; collected += page.text; ++pages;
    assert.equal(page.truncated, page.nextOffset !== null); if (page.nextOffset === null) break;
    assert.equal(page.nextOffset, offset + Buffer.byteLength(page.text)); assert(page.nextOffset > offset); offset = page.nextOffset;
  } while (pages < 20);
  assert(pages > 1); assert.equal(collected, content);
  assert.equal((await read(source, `?offset=1&version=${encodeURIComponent(version)}`)).status, 400);
  assert.equal((await read(source, `?offset=${source.bytes.length + 1}&version=${encodeURIComponent(version)}`)).status, 400);
});

test('strict MIME, full bounded UTF-8 validation and binary checks reject disguised files including invalid bytes beyond the first page', async () => {
  const fixtures: [Buffer | string, string][] = [[Buffer.from([0x89, 80, 78, 71, 13, 10, 26, 10]), 'text/plain'], ['%PDF-1.7\nFictional disguised PDF.', 'text/plain'], [Buffer.from([65, 0, 66]), 'text/plain'], [Buffer.from([65, 1, 66]), 'text/plain'], [Buffer.concat([Buffer.alloc(20000, 65), Buffer.from([0xff])]), 'text/plain'], ['<svg></svg>', 'image/svg+xml'], ['<html>fixture</html>', 'text/html'], ['Fictional bytes', 'application/octet-stream']];
  for (const [bytes, mime] of fixtures) { const source = await saved(alice, bytes, mime); assert.equal((await read(source)).status, 415); }
  for (const mime of ['text/csv', 'application/json']) { const source = await saved(alice, mime === 'text/csv' ? 'a,b\n1,2\n' : '{"fictional":true}', mime); assert.equal((await read(source)).status, 200); }
  const browser = await saved(alice, '{}', 'application/json', 'browser'); assert.equal((await read(browser)).status, 415);
});

test('metadata and source limits are checked before openRead, and zero-byte supported text is a complete empty page', async () => {
  const oversized = await saved(alice); await db.query('UPDATE platform_uploads SET byte_size=$2 WHERE id=$1', [oversized.uploadId, ARTIFACT_TEXT_SOURCE_BYTES + 1]);
  const before = storage.statCalls; assert.equal((await read(oversized)).status, 413); assert.equal(storage.statCalls, before);
  const mismatch = await saved(alice); await db.query('UPDATE platform_artifacts SET mime=\'text/markdown\' WHERE id=$1', [mismatch.artifactId]); assert.equal((await read(mismatch)).status, 409);
  const wrongSize = await saved(alice); await db.query('UPDATE platform_uploads SET byte_size=byte_size+1 WHERE id=$1', [wrongSize.uploadId]); const opened = storage.openCalls; assert.equal((await read(wrongSize)).status, 409); assert.equal(storage.openCalls, opened);
  const empty = await saved(alice, ''); const result = JSON.parse((await read(empty)).body); assert.equal(result.text, ''); assert.equal(result.nextOffset, null); assert.equal(result.truncated, false);
  const listed = await exchange('/jobs', alice); assert.equal(JSON.parse(listed.body).jobs.find((job: any) => job.id === empty.jobId).artifacts[0].size, 0);
});

test('a mutable blob cannot mix versions across pages or between stat and pinned openRead', async () => {
  const source = await saved(alice, 'A'.repeat(20000)), first = JSON.parse((await read(source)).body); await fs.writeFile(path.join(directory, source.key), 'B'.repeat(20000));
  const opened = storage.openCalls; const changed = await read(source, `?offset=${first.nextOffset}&version=${encodeURIComponent(first.version)}`); assert.equal(changed.status, 409, changed.body); assert.equal(JSON.parse(changed.body).error.code, 'ARTIFACT_CHANGED'); assert.equal(storage.openCalls, opened);
  const fresh = await saved(alice); storage.beforeOpen = async key => { if (key === fresh.key) await fs.writeFile(path.join(directory, key), 'C'.repeat(fresh.bytes.length)); return undefined; };
  try { const pinned = await read(fresh); assert.equal(pinned.status, 409, pinned.body); assert.equal(JSON.parse(pinned.body).error.code, 'ARTIFACT_CHANGED'); } finally { storage.beforeOpen = undefined; }
});

test('storage failures and oversized/short streams return safe errors without raw paths or messages', async () => {
  const source = await saved(alice);
  storage.beforeStat = async () => { throw new Error(`private-key ${source.key} ${directory}`); };
  try { const failed = await read(source); assert.equal(failed.status, 503); assert.equal(failed.body.includes(directory), false); assert.equal(failed.body.includes(source.key), false); } finally { storage.beforeStat = undefined; }
  for (const bytes of [Buffer.alloc(source.bytes.length + 1, 65), Buffer.alloc(source.bytes.length - 1, 65)]) {
    storage.beforeOpen = async () => ({ stream: Readable.from([bytes]), length: source.bytes.length });
    try { assert.equal((await read(source)).status, 503); } finally { storage.beforeOpen = undefined; }
  }
});

test('actual Responses adapter lists a private CLI result and receives its saved source text, not its download URL', async () => {
  agentSource = await saved(alice); agentMode = 'chain'; agentTurn = 0;
  const count = (await db.query('SELECT count(*) AS count FROM platform_jobs')).rows[0].count;
  const conv = await exchange('/conversations', alice, { method: 'POST', body: { mode: 'agent' } }); const conversationId = JSON.parse(conv.body).conversation.id;
  const result = await exchange(`/conversations/${conversationId}/messages`, alice, { method: 'POST', body: { mode: 'agent', content: 'Read the fictional code I saved and discuss it; do not execute anything.' } });
  assert.equal(result.status, 200, result.body); assert.match(result.body, /event: done/); assert.match(result.body, /actual saved text/); assert.equal(agentTurn, 3); assert.equal(storage.getCalls, 0); assert.equal((await db.query('SELECT count(*) AS count FROM platform_jobs')).rows[0].count, count);
});

test('actual Agent tool returns safe owner errors as data so it can make a subsequent tool call', async () => {
  agentSource = await saved(bob); recoveredSource = await saved(alice); agentMode = 'recover'; agentTurn = 0;
  const conv = await exchange('/conversations', alice, { method: 'POST', body: { mode: 'agent' } }); const conversationId = JSON.parse(conv.body).conversation.id;
  const result = await exchange(`/conversations/${conversationId}/messages`, alice, { method: 'POST', body: { mode: 'agent', content: 'Fictional invalid private-artifact lookup, no permission to execute.' } });
  assert.equal(result.status, 200); assert.equal(agentTurn, 4); assert.match(result.body, /NOT_FOUND/); assert.match(result.body, /INVALID_INPUT/); assert.match(result.body, /event: done/); assert.equal(result.body.includes(directory), false);
});

test('successful and rejected reads wait for asynchronous stream cleanup, and late cleanup failures remain safe errors', async () => {
  const source = await saved(alice); let cleaned = false;
  storage.beforeOpen = async () => ({ stream: new Readable({ read() { this.push(source.bytes); this.push(null); }, destroy(_error, done) { setTimeout(() => { cleaned = true; done(); }, 30); } }), length: source.bytes.length });
  try { const result = await read(source); assert.equal(result.status, 200, result.body); assert.equal(cleaned, true); assert.equal(storage.opened.at(-1)!.closed, true); } finally { storage.beforeOpen = undefined; }
  cleaned = false;
  storage.beforeOpen = async () => ({ stream: new Readable({ read() {}, destroy(_error, done) { setTimeout(() => { cleaned = true; done(); }, 30); } }), length: source.bytes.length + 1 });
  try { assert.equal((await read(source)).status, 503); assert.equal(cleaned, true); assert.equal(storage.opened.at(-1)!.closed, true); } finally { storage.beforeOpen = undefined; }
  storage.beforeOpen = async () => ({ stream: new Readable({ read() { this.push(source.bytes); this.push(null); }, destroy(_error, done) { setTimeout(() => done(new Error(`Fictional private cleanup ${directory}`)), 30); } }), length: source.bytes.length });
  try { const result = await read(source); assert.equal(result.status, 503, result.body); assert.equal(result.body.includes(directory), false); assert.equal(storage.opened.at(-1)!.closed, true); } finally { storage.beforeOpen = undefined; }
});

test('real HTTP disconnect aborts a slow text read, destroys its stream and rejects pre-cancelled reads before storage', async () => {
  const source = await saved(alice, 'S'.repeat(100000)); let destroyed = false, timer: ReturnType<typeof setTimeout> | undefined;
  storage.beforeOpen = async (_key, options) => {
    const stream = new Readable({ read() { timer = setTimeout(() => this.push(Buffer.alloc(1000, 83)), 100); }, destroy(error, done) { if (timer) clearTimeout(timer); destroyed = true; done(error); } });
    const abort = () => stream.destroy(new ApiError(499, 'STORAGE_ABORTED', 'Fictional cancelled read.')); options.signal?.addEventListener('abort', abort, { once: true }); stream.once('close', () => options.signal?.removeEventListener('abort', abort));
    return { stream, length: source.bytes.length };
  };
  try {
    const count = storage.opened.length, request = http.get({ host: '127.0.0.1', port, path: prefix + `/artifacts/${source.artifactId}/text`, agent: false, headers: { cookie: alice.cookie, [PLATFORM_ACCOUNT_HEADER]: alice.id } }); request.on('error', () => {});
    await until(() => storage.opened.length > count); const active = storage.opened.at(-1)!; request.destroy();
    await until(() => destroyed && active.closed && !!active.signal?.aborted); assert.equal(storage.getCalls, 0);
  } finally { storage.beforeOpen = undefined; }
  const controller = new AbortController(); controller.abort(); const count = storage.statCalls;
  await assert.rejects(system.jobs.artifactText(alice.id, { artifactId: source.artifactId }, controller.signal), (error: any) => error.code === 'ARTIFACT_READ_CANCELLED'); assert.equal(storage.statCalls, count);
});

test('actual HTTP cancellation closes the real local file descriptor before the reader settles', async () => {
  const source = await saved(alice, 'F'.repeat(ARTIFACT_TEXT_SOURCE_BYTES)), originalOpen = fs.open;
  let fd = -1, sourceClosed = false, native: BlobReadResult | undefined, signal: AbortSignal | undefined, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fs.open = (async (...args: any[]) => {
    const handle = await (originalOpen as any)(...args);
    if (args[0] === path.join(directory, source.key)) {
      const create = handle.createReadStream.bind(handle);
      handle.createReadStream = (options: any) => { fd = handle.fd; const stream = create(options); stream.once('close', () => { sourceClosed = true; }); return stream; };
    }
    return handle;
  }) as typeof fs.open;
  storage.beforeOpen = async (key, options) => {
    native = await LocalBlobStorage.prototype.openRead.call(storage, key, options); signal = options.signal;
    native.stream.on('error', () => {}); await gate; return native;
  };
  let request: http.ClientRequest | undefined;
  try {
    request = http.get({ host: '127.0.0.1', port, path: prefix + `/artifacts/${source.artifactId}/text`, agent: false, headers: { cookie: alice.cookie, [PLATFORM_ACCOUNT_HEADER]: alice.id } }); request.on('error', () => {});
    await until(() => !!native && fd >= 0); fs.open = originalOpen; assert.equal(fstatSync(fd).isFile(), true);
    request.destroy(); await until(() => !!signal?.aborted && !!native?.stream.closed && sourceClosed);
    assert.throws(() => fstatSync(fd), (error: any) => error.code === 'EBADF'); release();
    await until(() => storage.opened.some(item => item.stream === native!.stream && item.closed));
    assert.equal(storage.getCalls, 0);
  } finally { fs.open = originalOpen; request?.destroy(); release(); storage.beforeOpen = undefined; }
});
