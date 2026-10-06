import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, getEventListeners } from 'node:events';
import type { SpeechInput, CreateJobInput } from '@companion/platform-contracts';
import { createProviderRuntime, ProviderError } from '../src/index.ts';
import { workflowStore } from './fixtures/workflow-store.ts';

const maxBytes = 30 * 1024 * 1024;
const configured = { KOKORO_BASE_URL: 'http://127.0.0.1:8880/v1', KOKORO_TTS_MODEL: 'kokoro-82m', KOKORO_TTS_VOICE: 'af_heart', PLATFORM_ALLOW_PROVIDER_CALLS: '0' };
function wav(length = 8) {
  const bytes = Buffer.alloc(44 + length); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(length, 40); return bytes;
}
type Reply = (request: http.IncomingMessage, reply: http.ServerResponse) => void | Promise<void>;
async function localServer(handler: Reply) {
  const server = http.createServer((request, reply) => { void Promise.resolve(handler(request, reply)).catch(() => { reply.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`, async dispose() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const speech: SpeechInput = { provider: 'kokoro', text: 'This is fictional American English speech.' };
const rejectCode = (code: string) => (error: unknown) => error instanceof ProviderError && error.code === code && !error.message.includes(speech.text);

test('local English capability requires all valid server env and ignores the commercial gate without probing', async () => {
  let requests = 0;
  for (const env of [{}, { ...configured, KOKORO_BASE_URL: '' }, { ...configured, KOKORO_TTS_MODEL: '' }, { ...configured, KOKORO_TTS_VOICE: '' }, { ...configured, KOKORO_TTS_MODEL: 'unknown' }, { ...configured, KOKORO_TTS_VOICE: 'unknown' }]) {
    const runtime = createProviderRuntime({ env, fetch: async () => { requests++; throw new Error('No probing or fallback is allowed.'); } }), status = runtime.capabilities().find(provider => provider.id === 'kokoro')!;
    assert.equal(status.enabled, false); assert.equal(status.keyConfigured, false); assert.deepEqual(status.modelsByCapability?.speech, []);
    await assert.rejects(runtime.speech(speech), rejectCode('PROVIDER_NOT_CONFIGURED'));
  }
  for (const flag of ['0', '1']) {
    const runtime = createProviderRuntime({ env: { ...configured, PLATFORM_ALLOW_PROVIDER_CALLS: flag }, fetch: async () => { requests++; throw new Error('No probing is allowed.'); } }), status = runtime.capabilities().find(provider => provider.id === 'kokoro')!;
    assert.equal(status.enabled, true); assert.equal(status.keyConfigured, true); assert.deepEqual(status.capabilities, ['speech']); assert.deepEqual(status.models, ['kokoro-82m']); assert.deepEqual(status.modelsByCapability, { speech: ['kokoro-82m'] }); assert.deepEqual(status.speechLanguages, ['en-US']);
    assert(!status.envVariables.includes('PLATFORM_ALLOW_PROVIDER_CALLS')); assert.match(status.name, /English/);
    await assert.rejects(runtime.createVoiceSession({ provider: 'kokoro' }), rejectCode('PROVIDER_UNSUPPORTED'));
    await assert.rejects(runtime.transcribe({ name: 'fictional.wav', mime: 'audio/wav', bytes: wav() }, { provider: 'kokoro' }), rejectCode('PROVIDER_UNSUPPORTED'));
    await assert.rejects(runtime.speech({ text: speech.text }), rejectCode('PROVIDER_NOT_CONFIGURED'));
  }
  assert.equal(requests, 0);
});

test('literal loopback HTTP configuration rejects normalized private aliases, credentials, queries and fragments before transport', async () => {
  let requests = 0;
  for (const base of ['https://127.0.0.1:8880/v1', 'http://127.0.0.2:8880/v1', 'http://localhost.example/v1', 'http://0.0.0.0:8880/v1', 'http://2130706433:8880/v1', 'http://0x7f000001:8880/v1', 'http://0177.0.0.1:8880/v1', 'http://127.1:8880/v1', 'http://user:password@localhost:8880/v1', 'http://localhost:8880/v1?input=no', 'http://localhost:8880/v1#private', ' http://localhost:8880/v1', 'http://localhost:0/v1', 'http://localhost:65536/v1', 'http://localhost:8880/v1/../private']) {
    const runtime = createProviderRuntime({ env: { ...configured, KOKORO_BASE_URL: base }, fetch: async () => { requests++; throw new Error('No requests are allowed.'); } });
    assert.equal(runtime.capabilities().find(provider => provider.id === 'kokoro')?.enabled, false); await assert.rejects(runtime.speech(speech), rejectCode('PROVIDER_NOT_CONFIGURED'));
  }
  for (const base of ['http://localhost:8880/v1/', 'http://127.0.0.1:8880/v1', 'http://[::1]:8880/v1']) {
    let target = '';
    const runtime = createProviderRuntime({ env: { ...configured, KOKORO_BASE_URL: base }, fetch: async url => { target = String(url); return new Response(wav(), { headers: { 'content-type': 'audio/wav' } }); } });
    assert.equal((await runtime.speech(speech)).mime, 'audio/wav'); assert.equal(target, base.replace(/\/$/, '') + '/audio/speech');
  }
  assert.equal(requests, 0);
});

test('real local HTTP POST delivers only fixed WAV model/voice and defaults without authorization keys or client URLs', async () => {
  const requests: { url?: string; body: any; authorization?: string }[] = [], audio = wav();
  const fixture = await localServer(async (request, reply) => {
    const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(chunk); requests.push({ url: request.url, body: JSON.parse(Buffer.concat(bytes).toString()), authorization: request.headers.authorization });
    reply.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length }); for (let i = 0; i < audio.length; i += 3) reply.write(audio.subarray(i, i + 3)); reply.end();
  });
  try {
    const runtime = createProviderRuntime({ env: { ...configured, KOKORO_BASE_URL: fixture.base } });
    for (const input of [speech, { ...speech, model: 'kokoro-82m', voice: 'af_heart' }]) assert.deepEqual(await runtime.speech(input), { name: 'speech.wav', mime: 'audio/wav', bytes: new Uint8Array(audio) });
    assert.equal(requests.length, 2); for (const request of requests) { assert.equal(request.url, '/v1/audio/speech'); assert.equal(request.authorization, undefined); assert.deepEqual(request.body, { model: 'kokoro-82m', voice: 'af_heart', input: speech.text, response_format: 'wav' }); }
  } finally { await fixture.dispose(); }
});

test('unknown models, voices, response options, non-English scripts and unsupported job options fail before transport', async () => {
  let requests = 0; const runtime = createProviderRuntime({ env: configured, fetch: async () => { requests++; throw new Error('Invalid input cannot call any provider.'); } });
  for (const extra of [{ model: 'unknown' }, { model: null }, { voice: 'marin' }, { voice: null }, { text: '' }, { text: ' ' }, { text: 'A'.repeat(4001) }, { text: '虚构测试语音' }, { response_format: 'mp3' }, { baseUrl: 'http://external.example' }, { text: 1 }]) await assert.rejects(runtime.speech({ ...speech, ...extra } as any), rejectCode('INVALID_PROVIDER_INPUT'));
  for (const options of [{ voice: null }, { voice: 1 }, { response_format: 'mp3' }, { url: 'http://external.example' }]) await assert.rejects(runtime.executeJob({ kind: 'speech', provider: 'kokoro', prompt: speech.text, options }, { jobId: 'fictional', userId: 'fictional', workspaceDirectory: '/tmp/fictional' }), rejectCode('INVALID_PROVIDER_INPUT'));
  assert.equal(requests, 0);
});

test('real HTTP MIME, RIFF length, PCM16 mono 24kHz fields and data bounds reject malformed recordings safely', async () => {
  const invalid: Buffer[] = [Buffer.from('Fictional server error: ' + speech.text), wav(0)];
  for (const [offset, value, width] of [[4, 1, 4], [16, 17, 4], [20, 3, 2], [22, 2, 2], [24, 22050, 4], [28, 1, 4], [32, 4, 2], [34, 24, 2], [40, 20, 4]] as const) { const bytes = wav(); if (width === 2) bytes.writeUInt16LE(value, offset); else bytes.writeUInt32LE(value, offset); invalid.push(bytes); }
  for (const offset of [0, 8, 12, 36]) { const bytes = wav(); bytes[offset] |= 0x80; invalid.push(bytes); }
  const odd = wav(3); invalid.push(odd); const wrong = wav(); wrong.write('NOTW', 8); invalid.push(wrong); invalid.push(wav().subarray(0, 48));
  const duplicate = Buffer.concat([wav(), wav().subarray(36)]); duplicate.writeUInt32LE(duplicate.length - 8, 4); invalid.push(duplicate);
  let body: Buffer = wav(), mime = 'audio/wav';
  const fixture = await localServer(async (request, reply) => { for await (const _part of request) {} reply.writeHead(200, { 'content-type': mime }); reply.end(body); });
  try {
    const runtime = createProviderRuntime({ env: { ...configured, KOKORO_BASE_URL: fixture.base } });
    for (const bytes of invalid) { body = bytes; await assert.rejects(runtime.speech(speech), rejectCode('INVALID_PROVIDER_RESPONSE')); }
    body = wav(); for (const value of ['audio/mpeg', 'application/json', 'audio/x-wav']) { mime = value; await assert.rejects(runtime.speech(speech), rejectCode('INVALID_PROVIDER_RESPONSE')); }
  } finally { await fixture.dispose(); }
});

test('a real HTTP redirect is not followed and provider errors never leak their body', async () => {
  let followed = 0, mode = 'redirect'; const fixture = await localServer(async (request, reply) => {
    for await (const _part of request) {} if (request.url === '/private-target') followed++;
    if (mode === 'redirect') { reply.writeHead(302, { location: '/private-target' }); reply.end(); }
    else { reply.writeHead(500, { 'content-type': 'application/json' }); reply.end(JSON.stringify({ error: 'Fictional private failure ' + speech.text })); }
  });
  try {
    const runtime = createProviderRuntime({ env: { ...configured, KOKORO_BASE_URL: fixture.base } });
    await assert.rejects(runtime.speech(speech), rejectCode('PROVIDER_UNREACHABLE')); assert.equal(followed, 0);
    mode = 'error'; await assert.rejects(runtime.speech(speech), rejectCode('PROVIDER_REJECTED'));
  } finally { await fixture.dispose(); }
});

test('real HTTP declared and chunked overflows are bounded and close the response connection', async () => {
  let mode = 'declared', closed: Promise<unknown> | undefined;
  const fixture = await localServer(async (request, reply) => {
    for await (const _part of request) {} closed = once(reply, 'close');
    reply.writeHead(200, { 'content-type': 'audio/wav', ...(mode === 'declared' ? { 'content-length': maxBytes + 1 } : {}) }); reply.flushHeaders();
    if (mode === 'declared') return;
    const block = Buffer.alloc(1024 * 1024);
    for (let i = 0; i <= 30 && !reply.destroyed; i++) {
      if (!reply.write(block)) await new Promise<void>(resolve => {
        const done = () => { reply.removeListener('drain', done); reply.removeListener('close', done); resolve(); };
        reply.once('drain', done); reply.once('close', done);
        if (reply.destroyed) done();
      });
    }
    if (!reply.destroyed) reply.end();
  });
  try {
    const runtime = createProviderRuntime({ env: { ...configured, KOKORO_BASE_URL: fixture.base } });
    for (const value of ['declared', 'chunked']) { mode = value; await assert.rejects(runtime.speech(speech), rejectCode('PROVIDER_OUTPUT_TOO_LARGE')); await closed; }
  } finally { await fixture.dispose(); }
});

test('cancellation before upload, while awaiting headers and during actual HTTP body reading returns no audio and closes the connection', async () => {
  let requests = 0, mode = 'headers', arrived!: () => void, closed: Promise<unknown> | undefined;
  const fixture = await localServer(async (request, reply) => {
    requests++; for await (const _part of request) {} closed = once(reply, 'close');
    if (mode === 'body') { reply.writeHead(200, { 'content-type': 'audio/wav' }); reply.write(wav().subarray(0, 40)); }
    arrived();
  });
  try {
    let bodyReading!: () => void;
    const runtime = createProviderRuntime({ env: { ...configured, KOKORO_BASE_URL: fixture.base }, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (mode !== 'body') return response;
      return new Response(response.body!.pipeThrough(new TransformStream({ transform(chunk, output) { output.enqueue(chunk); bodyReading(); } })), { status: response.status, headers: response.headers });
    } }), before = new AbortController(); before.abort();
    await assert.rejects(runtime.speech(speech, { signal: before.signal }), rejectCode('PROVIDER_INTERRUPTED')); assert.equal(requests, 0);
    for (const value of ['headers', 'body']) {
      mode = value; const received = new Promise<void>(resolve => { arrived = resolve; }), reading = new Promise<void>(resolve => { bodyReading = resolve; }), controller = new AbortController();
      const rejected = assert.rejects(runtime.speech(speech, { signal: controller.signal }), rejectCode('PROVIDER_INTERRUPTED'));
      await received; if (mode === 'body') await reading; controller.abort(); await rejected; await closed;
    }
    assert.equal(requests, 2);
  } finally { await fixture.dispose(); }
});

test('reading honours cancellation even when an injected transport ignores the signal and removes its listener', async () => {
  let arrived!: () => void, cancelled = false; const started = new Promise<void>(resolve => { arrived = resolve; }), controller = new AbortController();
  const runtime = createProviderRuntime({ env: configured, fetch: async () => new Response(new ReadableStream({ pull(stream) { stream.enqueue(wav().subarray(0, 20)); arrived(); return new Promise(() => {}); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'audio/wav' } }) });
  const rejected = assert.rejects(runtime.speech(speech, { signal: controller.signal }), rejectCode('PROVIDER_INTERRUPTED'));
  await started; controller.abort(); await rejected; assert.equal(cancelled, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('speech jobs and durable workflow steps dispatch to Kokoro and preserve the actual private WAV bytes', async () => {
  const bytes = wav(), bodies: any[] = [], runtime = createProviderRuntime({ env: configured, fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(bytes, { headers: { 'content-type': 'audio/wav' } }); } });
  const context = { jobId: 'fictional-job', userId: 'fictional-user', workspaceDirectory: '/tmp/fictional-workspace' };
  const result = await runtime.executeJob({ kind: 'speech', provider: 'kokoro', prompt: speech.text, model: 'kokoro-82m', options: { voice: 'af_heart' } }, context);
  assert.deepEqual(result.artifacts, [{ name: 'speech.wav', mime: 'audio/wav', bytes: new Uint8Array(bytes) }]);
  const input: CreateJobInput = { kind: 'workflow', provider: 'workflow', prompt: speech.text, options: { steps: [{ kind: 'speech', provider: 'kokoro', prompt: '{{input}}', model: 'kokoro-82m', options: { voice: 'af_heart' } }] } }, store = workflowStore(input, context);
  const workflow = await runtime.executeJob(input, store.context()); assert.deepEqual(workflow.artifacts, []); assert.equal(store.published.length, 1); assert.equal(store.published[0].name, 'step-1-speech.wav'); assert.deepEqual(store.published[0].bytes, new Uint8Array(bytes));
  assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]);
});
