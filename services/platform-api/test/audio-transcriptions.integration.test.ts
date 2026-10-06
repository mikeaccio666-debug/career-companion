import { PLATFORM_ACCOUNT_HEADER, type ChatInput, type PlatformProviderRuntime } from '@companion/platform-contracts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.ts';
import { AudioTranscriptions } from '../src/audio-transcriptions.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { LocalBlobStorage, type BlobReadOptions } from '../src/storage.ts';

const prefix = '/api/platform', origin = 'http://localhost:4321';
const base = readConfig(), schema = `audio_receipts_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(base.databaseUrl);
assert(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname), 'Audio receipt fixtures require a loopback PostgreSQL instance.');
databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Database(base.databaseUrl), db = new Database(databaseUrl.toString());
type Actor = { id: string; cookie: string };
type Source = { id: string; key: string; name: string; mime: string; bytes: Buffer };
type Receipt = { id: string; sourceAttachmentId: string; sourceName: string; sourceMime: string; sourceSha256: string;
  provider: 'faster-whisper'; model: 'whisper-tiny'; text: string; createdAt: string };
type Exchange = { status: number; headers: IncomingHttpHeaders; body: string };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
type Gate = { entered: ReturnType<typeof deferred<AbortSignal>>; release: ReturnType<typeof deferred<void>>; obeyAbort: boolean };
let gate: Gate | undefined, directory: string, port: number, createdSchema = false;
let system: Awaited<ReturnType<typeof buildApp>>, storage: TrackingStorage, alice: Actor, bob: Actor;
let lastChat: ChatInput | undefined;
const calls = { transcription: 0, transcriptionFinished: 0, chat: 0, jobs: 0 };
const transcript = 'Fictional ASR transcript: I want to practice explaining a sample project.';
const audioKeys = new Set<string>();
class TrackingStorage extends LocalBlobStorage {
  stats = 0; opens = 0; gets = 0;
  override async stat(key: string, signal?: AbortSignal) { ++this.stats; return super.stat(key, signal); }
  override async openRead(key: string, options: BlobReadOptions) { ++this.opens; return super.openRead(key, options); }
  override async get(key: string) { ++this.gets; assert(!audioKeys.has(key), 'Raw audio must never use an unbounded read or enter chat attachments.'); return super.get(key); }
}
const forbidden = async (): Promise<never> => { throw new Error('Only injected transcription and chat fixtures are allowed.'); };
const runtime: PlatformProviderRuntime = {
  capabilities: () => [
    { id: 'faster-whisper', name: 'Fictional local ASR', enabled: true, keyConfigured: true, capabilities: ['transcription'],
      models: ['whisper-tiny'], modelsByCapability: { transcription: ['whisper-tiny'] }, envVariables: [] },
    { id: 'audio-chat-fixture', name: 'Fictional text chat', enabled: true, keyConfigured: true, capabilities: ['chat'], models: ['synthetic-chat'], envVariables: [] },
  ],
  async *streamChat(input) { ++calls.chat; lastChat = input; yield { type: 'delta', text: 'Fictional reviewed-audio response.' }; },
  executeJob: async () => { ++calls.jobs; return forbidden(); }, createVoiceSession: forbidden, speech: forbidden,
  async transcribe(input, context) {
    ++calls.transcription;
    assert.equal(context?.provider, 'faster-whisper'); assert(context?.signal, 'The ASR adapter must receive request cancellation.');
    assert.equal(input.mime, 'audio/wav'); assert.equal(input.name, 'fictional-recording.wav');
    assert.equal(Buffer.from(input.bytes).subarray(0, 4).toString(), 'RIFF');
    const current = gate;
    try {
      if (current) {
        current.entered.resolve(context.signal);
        if (current.obeyAbort) await new Promise<void>((resolve, reject) => {
          const abort = () => { context.signal!.removeEventListener('abort', abort); reject(context.signal!.reason); };
          if (context.signal!.aborted) { abort(); return; }
          context.signal!.addEventListener('abort', abort, { once: true });
          void current.release.promise.then(() => { context.signal!.removeEventListener('abort', abort); resolve(); });
        }); else await current.release.promise;
      }
      return { text: transcript };
    } finally { ++calls.transcriptionFinished; }
  },
};
function exchange(route: string, actor?: Actor, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Exchange> {
  const body = Buffer.isBuffer(options.body) ? options.body : options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: prefix + route, agent: false, method: options.method ?? 'GET', headers: {
      ...(actor ? { cookie: actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id } : {}),
      ...(options.method === 'POST' ? { origin } : {}),
      ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}), ...options.headers,
    } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.setTimeout(10_000, () => request.destroy(new Error('Fictional audio HTTP fixture timed out.')));
    if (body) request.write(body); request.end();
  });
}
function json(result: Exchange) { return JSON.parse(result.body); }
async function register(): Promise<Actor> {
  const result = await exchange('/auth/register', undefined, { method: 'POST', body: { name: 'Fictional audio reviewer',
    email: `${randomUUID()}@example.invalid`, password: 'Fictional-audio-review-password-2026' } });
  assert.equal(result.status, 201, result.body); return { id: json(result).user.id, cookie: result.headers['set-cookie']![0]!.split(';')[0]! };
}
function wav(sample = 0) {
  const bytes = Buffer.alloc(92, sample); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}
async function upload(actor = alice, bytes = wav(), name = 'fictional-recording.wav', mime = 'audio/wav'): Promise<Source> {
  const boundary = `fictional-audio-${randomUUID()}`;
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const result = await exchange('/uploads', actor, { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(result.status, 201, result.body);
  const id = json(result).attachment.id, row = (await db.query('SELECT storage_key FROM platform_uploads WHERE id=$1', [id])).rows[0];
  if (mime.startsWith('audio/')) audioKeys.add(row.storage_key);
  return { id, key: row.storage_key, name, mime, bytes };
}
function transcribe(source: Source, clientRequestId = randomUUID(), actor = alice, extra = {}) {
  return exchange(`/uploads/${source.id}/transcriptions`, actor, { method: 'POST', body: { clientRequestId, ...extra } });
}
function recovery(source: Source, clientRequestId: string, actor = alice) { return exchange(`/uploads/${source.id}/transcriptions/${clientRequestId}`, actor); }
async function conversation(actor = alice) {
  const result = await exchange('/conversations', actor, { method: 'POST', body: { mode: 'chat', title: 'Fictional recording review' } });
  assert.equal(result.status, 201, result.body); return json(result).conversation.id as string;
}
function message(id: string, source: Source, receipt: Receipt, actor = alice, extra = {}) {
  return exchange(`/conversations/${id}/messages`, actor, { method: 'POST', body: { content: 'Discuss this fictional recording.', mode: 'chat',
    provider: 'audio-chat-fixture', attachmentIds: [source.id], audioTranscripts: [{ receiptId: receipt.id, reviewedText: receipt.text }], ...extra } });
}
async function receiptCount(source: Source) { return (await db.query('SELECT count(*)::integer AS n FROM platform_audio_transcriptions WHERE source_upload_id=$1', [source.id])).rows[0].n as number; }
async function effects() {
  return (await db.query(`SELECT (SELECT count(*)::integer FROM platform_jobs) AS jobs,
    (SELECT count(*)::integer FROM platform_approvals) AS approvals, (SELECT count(*)::integer FROM platform_job_outbox) AS outbox,
    (SELECT count(*)::integer FROM platform_uploads) AS uploads, (SELECT count(*)::integer FROM platform_messages) AS messages,
    (SELECT count(*)::integer FROM platform_audio_transcriptions) AS receipts, (SELECT count(*)::integer FROM platform_runtime_leases) AS leases`)).rows[0];
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000; while (!await check()) { if (Date.now() > end) assert.fail('Fictional audio cleanup did not settle.'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function begin(source: Source, clientRequestId: string, actor: Actor, controller: AbortController) {
  return fetch(`http://127.0.0.1:${port}${prefix}/uploads/${source.id}/transcriptions`, { method: 'POST', headers: {
    origin, cookie: actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id, 'content-type': 'application/json',
  }, body: JSON.stringify({ clientRequestId }), signal: controller.signal }).then(async response => ({ status: response.status, body: await response.text(), aborted: false }),
    () => ({ status: 0, body: '', aborted: true }));
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); createdSchema = true; await db.migrate();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-audio-receipts-')); storage = new TrackingStorage(directory);
  system = await buildApp({ db, storage, runtime, enableQueue: false,
    requestLimits: { policies: { api: { max: 1000, windowSeconds: 60 }, chat: { max: 1000, windowSeconds: 60 }, transcription: { max: 1000, windowSeconds: 60 } } },
    config: { ...base, databaseUrl: databaseUrl.toString(), storageDir: directory, s3: undefined, webStaticDir: undefined,
      accountEmail: undefined, requireVerifiedEmail: false, allowedOrigins: new Set([origin]) } });
  await system.app.listen({ host: '127.0.0.1', port: 0 }); port = (system.app.server.address() as AddressInfo).port;
  alice = await register(); bob = await register();
});
after(async () => {
  gate?.release.resolve(); await system?.app.close(); await db.close();
  if (createdSchema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test('actual HTTP ASR saves one immutable receipt; completed retries and recovery reuse it without another provider call or task', async () => {
  const source = await upload(), requestId = randomUUID(), before = await effects(), files = await fs.readdir(directory), asr = calls.transcription, gets = storage.gets;
  const created = await transcribe(source, requestId); assert.equal(created.status, 201, created.body);
  const { receipt, created: isNew } = json(created) as { receipt: Receipt; created: boolean };
  assert.equal(isNew, true); assert.match(receipt.id, /^[\da-f-]{36}$/); assert.equal(receipt.sourceAttachmentId, source.id);
  assert.equal(receipt.sourceName, source.name); assert.equal(receipt.sourceMime, source.mime);
  assert.equal(receipt.sourceSha256, createHash('sha256').update(source.bytes).digest('hex'));
  assert.equal(receipt.provider, 'faster-whisper'); assert.equal(receipt.model, 'whisper-tiny'); assert.equal(receipt.text, transcript);
  assert(Number.isFinite(Date.parse(receipt.createdAt))); assert.equal(created.headers['cache-control'], 'private, no-store');
  assert(!created.body.includes(source.key)); assert(!created.body.includes(directory));
  const again = await transcribe(source, requestId); assert.equal(again.status, 200, again.body); assert.deepEqual(json(again), { receipt, created: false });
  const recovered = await recovery(source, requestId); assert.equal(recovered.status, 200, recovered.body); assert.deepEqual(json(recovered), { receipt });
  const original = await exchange(`/audio-transcriptions/${receipt.id}`,alice);assert.equal(original.status,200,original.body);assert.deepEqual(json(original),{receipt});
  assert.equal((await exchange(`/audio-transcriptions/${receipt.id}`,bob)).status,404);
  assert.equal(calls.transcription, asr + 1); assert.equal(storage.gets, gets); assert.equal(await receiptCount(source), 1);
  assert.deepEqual(await effects(), { ...before, receipts: before.receipts + 1 }); assert.deepEqual(await fs.readdir(directory), files);
  const saved = (await db.query('SELECT content,source_sha256,provider,model FROM platform_audio_transcriptions WHERE id=$1', [receipt.id])).rows[0];
  assert.deepEqual(saved, { content: transcript, source_sha256: receipt.sourceSha256, provider: 'faster-whisper', model: 'whisper-tiny' });
  await assert.rejects(db.query('UPDATE platform_audio_transcriptions SET content=$2 WHERE id=$1', [receipt.id, 'Fictional prohibited receipt rewrite.']));
  assert.equal((await db.query('SELECT content FROM platform_audio_transcriptions WHERE id=$1', [receipt.id])).rows[0].content, transcript);
  const another = await upload(), clash = await transcribe(another, requestId); assert.equal(clash.status, 409, clash.body); assert.equal(calls.transcription, asr + 1);
});

test('owned upload lookup and strict receipt inputs reject foreign, guessed and unsupported sources before ASR', async () => {
  const source = await upload(), asr = calls.transcription, stats = storage.stats, opened = storage.opens;
  assert.equal((await transcribe(source, randomUUID(), bob)).status, 404);
  assert.equal((await exchange(`/uploads/${source.id}/transcriptions`, undefined, { method: 'POST', body: { clientRequestId: randomUUID() } })).status, 401);
  assert.equal((await exchange(`/uploads/${randomUUID()}/transcriptions`, alice, { method: 'POST', body: { clientRequestId: randomUUID() } })).status, 404);
  for (const body of [{}, { clientRequestId: 'invalid' }, { clientRequestId: randomUUID(), provider: 'openai' },
    { clientRequestId: randomUUID(), model: 'other' }, { clientRequestId: randomUUID(), text: 'Fictional forged ASR text.' }]) {
    assert.equal((await exchange(`/uploads/${source.id}/transcriptions`, alice, { method: 'POST', body })).status, 400);
  }
  assert.equal(storage.stats, stats); assert.equal(storage.opens, opened); assert.equal(calls.transcription, asr);
  const text = await upload(alice, Buffer.from('Fictional text fixture.'), 'fictional.txt', 'text/plain');
  const unsupported = await transcribe(text); assert.equal(unsupported.status, 400, unsupported.body);
  assert.equal(json(unsupported).error.code, 'AUDIO_TRANSCRIPTION_UNSUPPORTED'); assert.equal(calls.transcription, asr);
  assert.equal((await recovery(source, randomUUID(), bob)).status, 404); assert.equal(await receiptCount(source), 0);
});

test('an in-progress duplicate is bounded by the voice lease and cannot invoke ASR twice', async () => {
  const source = await upload(), requestId = randomUUID(), asr = calls.transcription;
  const current: Gate = { entered: deferred<AbortSignal>(), release: deferred<void>(), obeyAbort: false }; gate = current;
  try {
    const first = transcribe(source, requestId); await current.entered.promise;
    assert.equal((await effects()).leases, 1);
    const duplicate = await transcribe(source, requestId); assert.equal(duplicate.status, 429, duplicate.body);
    assert.equal(calls.transcription, asr + 1); current.release.resolve();
    const completed = await first; assert.equal(completed.status, 201, completed.body);
    const retry = await transcribe(source, requestId); assert.equal(retry.status, 200, retry.body);
    assert.equal(json(retry).receipt.id, json(completed).receipt.id); assert.equal(calls.transcription, asr + 1); assert.equal(await receiptCount(source), 1);
  } finally { current.release.resolve(); gate = undefined; }
});

test('source changes during ASR or after receipt creation reject completion, recovery and chat without inventing another transcript', async () => {
  const source = await upload(), requestId = randomUUID();
  const current: Gate = { entered: deferred<AbortSignal>(), release: deferred<void>(), obeyAbort: false }; gate = current;
  try {
    const pending = transcribe(source, requestId); await current.entered.promise;
    await fs.writeFile(path.join(directory, source.key), wav(1)); current.release.resolve();
    const changed = await pending; assert.equal(changed.status, 409, changed.body); assert.equal(json(changed).error.code, 'AUDIO_TRANSCRIPTION_SOURCE_CHANGED');
    assert.equal(await receiptCount(source), 0);
  } finally { current.release.resolve(); gate = undefined; }
  const completedSource = await upload(), completedId = randomUUID(), made = await transcribe(completedSource, completedId);
  const receipt = json(made).receipt as Receipt, id = await conversation(), asr = calls.transcription, chat = calls.chat;
  await fs.writeFile(path.join(directory, completedSource.key), wav(2));
  for (const response of [await recovery(completedSource, completedId), await message(id, completedSource, receipt)]) {
    assert.equal(response.status, 409, response.body); assert.equal(json(response).error.code, 'AUDIO_TRANSCRIPTION_SOURCE_CHANGED');
  }
  assert.equal(calls.transcription, asr); assert.equal(calls.chat, chat); assert.equal(await receiptCount(completedSource), 1);
});

test('real HTTP cancellation reaches ASR and prevents both cooperative and late ignored results from becoming receipts', async () => {
  for (const obeyAbort of [true, false]) {
    const source = await upload(), controller = new AbortController(), before = calls.transcriptionFinished;
    const current: Gate = { entered: deferred<AbortSignal>(), release: deferred<void>(), obeyAbort }; gate = current;
    try {
      const pending = begin(source, randomUUID(), alice, controller), signal = await current.entered.promise;
      assert.equal((await effects()).leases, 1); controller.abort(); assert.equal((await pending).aborted, true);
      await until(() => signal.aborted); current.release.resolve();
      await until(async () => calls.transcriptionFinished > before && (await effects()).leases === 0);
      assert.equal(await receiptCount(source), 0);
    } finally { controller.abort(); current.release.resolve(); gate = undefined; }
  }
  const source = await upload(), controller = new AbortController(); controller.abort();
  const before = { asr: calls.transcription, stats: storage.stats, opens: storage.opens };
  await assert.rejects(new AudioTranscriptions(db, storage, runtime).create(alice.id, source.id, { clientRequestId: randomUUID() }, controller.signal,async()=>assert.fail('A pre-aborted request must not authorize.')));
  assert.deepEqual({ asr: calls.transcription, stats: storage.stats, opens: storage.opens }, before); assert.equal(await receiptCount(source), 0);
});

test('an expired runtime lease cannot authorize persistence of a late ASR result', async () => {
  const source = await upload(), current: Gate = { entered: deferred<AbortSignal>(), release: deferred<void>(), obeyAbort: false }; gate = current;
  try {
    const pending = transcribe(source); await current.entered.promise;
    const expired = await db.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='voice' RETURNING id", [alice.id]);
    assert.equal(expired.rowCount, 1); current.release.resolve();
    const result = await pending; assert.equal(result.status, 409, result.body); assert.equal(json(result).error.code, 'AUDIO_TRANSCRIPTION_LEASE_INACTIVE');
    assert.equal(await receiptCount(source), 0); assert.equal((await effects()).leases, 0);
  } finally { current.release.resolve(); gate = undefined; }
});

test('logout during ASR invalidates its original session before any receipt can be persisted', async () => {
  const actor = await register(), source = await upload(actor);
  const current: Gate = { entered: deferred<AbortSignal>(), release: deferred<void>(), obeyAbort: false }; gate = current;
  try {
    const pending = transcribe(source, randomUUID(), actor); await current.entered.promise;
    assert.equal((await exchange('/auth/logout', actor, { method: 'POST', body: {} })).status, 200); current.release.resolve();
    const result = await pending; assert.equal(result.status, 401, result.body); assert.equal(json(result).error.code, 'AUTH_REQUIRED');
    assert.equal(await receiptCount(source), 0); assert.equal((await effects()).leases, 0);
  } finally { current.release.resolve(); gate = undefined; }
});

test('real session and source lock waits recheck logout and wall-clock auth/lease expiry before receipt commit', async () => {
  for (const scenario of ['session-deleted','session-expired','lease-expired'] as const) {
    const actor = await register(),source = await upload(actor),holder = await db.pool.connect();
    const current: Gate = { entered:deferred<AbortSignal>(),release:deferred<void>(),obeyAbort:false };gate=current;
    let held=false;
    try {
      const pending=transcribe(source,randomUUID(),actor);await current.entered.promise;
      await holder.query('BEGIN');held=true;
      const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      if(scenario==='lease-expired')await holder.query('SELECT id FROM platform_uploads WHERE id=$1 FOR UPDATE',[source.id]);
      else await holder.query('SELECT token_hash FROM platform_sessions WHERE user_id=$1 FOR UPDATE',[actor.id]);
      current.release.resolve();
      await until(async()=>{const blocked=await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,[holderPid,scenario==='lease-expired'?'%SELECT id FROM platform_uploads%':'%SELECT token_hash FROM platform_sessions%']);return blocked.rows[0].n===1;});
      if(scenario==='session-deleted')await holder.query('DELETE FROM platform_sessions WHERE user_id=$1',[actor.id]);
      else {
        const target=scenario==='session-expired'?'platform_sessions':'platform_runtime_leases';
        await (scenario==='session-expired'?holder:db).query(`UPDATE ${target} SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE user_id=$1`,[actor.id]);
        // The save transaction began before this expiry, so transaction now() would wrongly authorize it.
        await new Promise(resolve=>setTimeout(resolve,400));
      }
      await holder.query('COMMIT');held=false;
      const result=await pending;
      assert.equal(result.status,scenario==='lease-expired'?409:401,result.body);
      assert.equal(json(result).error.code,scenario==='lease-expired'?'AUDIO_TRANSCRIPTION_LEASE_INACTIVE':'AUTH_REQUIRED');
      assert.equal(await receiptCount(source),0);assert.equal((await effects()).leases,0);
    } finally { if(held)await holder.query('ROLLBACK');holder.release();current.release.resolve();gate=undefined; }
  }
});

test('existing receipts remain readable and sendable when local ASR is disabled, with no paid or alternate-provider fallback',async()=>{
  const source=await upload(),requestId=randomUUID(),made=await transcribe(source,requestId),receipt=json(made).receipt as Receipt;
  const another=await upload(),id=await conversation(),asr=calls.transcription,capabilities=runtime.capabilities;
  runtime.capabilities=()=>[...capabilities().map(provider=>provider.id==='faster-whisper'?{...provider,enabled:false}:provider),
    {id:'openai',name:'Forbidden paid fallback fixture',enabled:true,keyConfigured:true,capabilities:['transcription'],models:['forbidden-paid-asr'],envVariables:[]}];
  try{
    const denied=await transcribe(another);assert.equal(denied.status,503,denied.body);assert.equal(json(denied).error.code,'LOCAL_TRANSCRIPTION_UNAVAILABLE');
    assert.equal((await recovery(source,requestId)).status,200);assert.equal((await exchange(`/audio-transcriptions/${receipt.id}`,alice)).status,200);
    const sent=await message(id,source,receipt);assert.equal(sent.status,200,sent.body);assert.match(sent.body,/event: done/);
    assert.equal(calls.transcription,asr);assert.equal(calls.jobs,0);
  }finally{runtime.capabilities=capabilities;}
});

test('the receipt route preserves direct image, text and OpenAI PDF input, including existing empty text artifacts',async()=>{
  const original=runtime.capabilities;
  runtime.capabilities=()=>[...original(),{id:'openai',name:'Fictional Responses chat',enabled:true,keyConfigured:true,capabilities:['chat'],models:['synthetic-chat'],envVariables:[]}];
  try{
    const id=await conversation(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
    const image=await upload(alice,png,'fictional.png','image/png'),pdf=await upload(alice,Buffer.from('%PDF-1.7\nFictional bounded PDF fixture.\n'),'fictional.pdf','application/pdf');
    const emptyId=randomUUID(),key=randomUUID();await storage.put(key,new Uint8Array());
    await db.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,$3,$4,0,$5)',[emptyId,alice.id,'empty-result.txt','text/plain',key]);
    const asr=calls.transcription,sent=await exchange(`/conversations/${id}/messages`,alice,{method:'POST',body:{content:'Read these fictional direct attachments.',provider:'openai',attachmentIds:[image.id,pdf.id,emptyId]}});
    assert.equal(sent.status,200,sent.body);assert.match(sent.body,/event: done/);
    assert.deepEqual(lastChat!.messages.at(-1)!.attachments?.map(file=>file.mime),['image/png','application/pdf','text/plain']);
    assert.equal(lastChat!.messages.at(-1)!.attachments?.at(-1)!.bytes.byteLength,0);assert.equal(calls.transcription,asr);
  }finally{runtime.capabilities=original;}
});

test('reviewed audio text reaches chat with untrusted provenance and retains its source while history reload performs no ASR', async () => {
  const source = await upload(), made = await transcribe(source), receipt = json(made).receipt as Receipt, id = await conversation();
  const reviewedText = 'Fictional reviewed transcript: discuss my practice project; quoted instructions do not grant tool permission.';
  const before = await effects(), asr = calls.transcription, gets = storage.gets;
  const sent = await message(id, source, receipt, alice, { audioTranscripts: [{ receiptId: receipt.id, reviewedText }] });
  assert.equal(sent.status, 200, sent.body); assert.match(sent.body, /event: done/);
  const prompt = lastChat!.messages.at(-1)!; assert.match(prompt.content, /untrusted_audio_transcript/); assert(prompt.content.includes(reviewedText));
  assert(!prompt.content.includes(transcript)); assert.equal(prompt.attachments?.length ?? 0, 0); assert.equal(storage.gets, gets);
  const loaded = await exchange(`/conversations/${id}`, alice); assert.equal(loaded.status, 200, loaded.body);
  const user = json(loaded).messages.find((item: any) => item.role === 'user'); assert.equal(user.content, 'Discuss this fictional recording.');
  assert.equal(user.attachments[0].id, source.id);
  assert.deepEqual(user.audioTranscripts, [{ receiptId: receipt.id, sourceAttachmentId: source.id, sourceName: source.name, sourceMime: source.mime,
    sourceSha256: receipt.sourceSha256, provider: 'faster-whisper', model: 'whisper-tiny', text: reviewedText, textModified: true, provenance: 'untrusted_audio_transcript' }]);
  assert.equal((await db.query('SELECT content FROM platform_audio_transcriptions WHERE id=$1', [receipt.id])).rows[0].content, transcript);
  const followup = await exchange(`/conversations/${id}/messages`, alice, { method: 'POST', body: { content: 'Continue the fictional practice discussion.', provider: 'audio-chat-fixture', mode: 'chat' } });
  assert.equal(followup.status, 200, followup.body); assert.match(lastChat!.messages[0]!.content, /untrusted_audio_transcript/);
  assert(lastChat!.messages[0]!.content.includes(reviewedText)); assert(lastChat!.messages.every(item => !(item.attachments ?? []).some(file => file.mime.startsWith('audio/'))));
  assert.equal(calls.transcription, asr); assert.equal(storage.gets, gets);
  assert.deepEqual(await effects(), { ...before, messages: before.messages + 4 }); assert.equal(calls.jobs, 0);
});

test('receipt/source, account and conversation mismatches reject before saving messages or invoking chat', async () => {
  const source = await upload(), otherSource = await upload(), receipt = json(await transcribe(source)).receipt as Receipt;
  const foreignSource = await upload(bob), foreignReceipt = json(await transcribe(foreignSource, randomUUID(), bob)).receipt as Receipt;
  const id = await conversation(), foreignConversation = await conversation(bob), before = await effects(), chat = calls.chat;
  const cases = [
    { audioTranscripts: undefined },
    { audioTranscripts: [{ receiptId: receipt.id, reviewedText: receipt.text }], attachmentIds: [otherSource.id] },
    { audioTranscripts: [{ receiptId: randomUUID(), reviewedText: 'Fictional missing receipt.' }] },
    { audioTranscripts: [{ receiptId: foreignReceipt.id, reviewedText: foreignReceipt.text }] },
    { audioTranscripts: [{ receiptId: receipt.id }] },
    { audioTranscripts: [{ receiptId: receipt.id, reviewedText: receipt.text }, { receiptId: receipt.id, reviewedText: receipt.text }] },
  ];
  for (const extra of cases) {
    const result = await message(id, source, receipt, alice, extra); assert([400, 404].includes(result.status), result.body);
    assert(!result.body.includes('event: '));
  }
  const missing = await message(id, source, receipt, alice, { audioTranscripts: undefined }); assert.equal(json(missing).error.code, 'AUDIO_TRANSCRIPT_REQUIRED');
  assert.equal((await message(foreignConversation, source, receipt)).status, 404);
  const switched = await exchange(`/conversations/${id}/messages`, bob, { method: 'POST', headers: { [PLATFORM_ACCOUNT_HEADER]: alice.id },
    body: { content: 'Fictional stale-window message.', provider: 'audio-chat-fixture', attachmentIds: [source.id], audioTranscripts: [{ receiptId: receipt.id, reviewedText: receipt.text }] } });
  assert.equal(switched.status, 409, switched.body); assert.equal(json(switched).error.code, 'ACCOUNT_CONTEXT_CHANGED');
  const staleASR = await exchange(`/uploads/${source.id}/transcriptions`, bob, { method: 'POST', headers: { [PLATFORM_ACCOUNT_HEADER]: alice.id }, body: { clientRequestId: randomUUID() } });
  assert.equal(staleASR.status, 409, staleASR.body); assert.equal(json(staleASR).error.code, 'ACCOUNT_CONTEXT_CHANGED');
  assert.equal(calls.chat, chat); assert.deepEqual(await effects(), before); assert.equal(calls.jobs, 0);
});
