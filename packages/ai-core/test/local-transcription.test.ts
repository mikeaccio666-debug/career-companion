import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getEventListeners } from 'node:events';
import type { ProviderAttachment } from '@companion/platform-contracts';
import { createProviderRuntime, ProviderError } from '../src/index.ts';

const configured = { FASTER_WHISPER_BASE_URL: 'http://127.0.0.1:8881/v1', FASTER_WHISPER_MODEL: 'whisper-tiny', PLATFORM_ALLOW_PROVIDER_CALLS: '0' };
const audio: ProviderAttachment = { name: 'Fictional-private-recording.wav', mime: 'audio/wav', bytes: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]) };
const transcript = 'This is a fictional local transcript. 虚构转写 🐈';
const maxAudio = 20 * 1024 * 1024, maxJson = 128 * 1024, maxText = 64 * 1024;
const context = { provider: 'faster-whisper' };
const errorCode = (code: string) => (error: unknown) => error instanceof ProviderError && error.code === code &&
  !error.message.includes(transcript) && !error.message.includes('PRIVATE_FIXTURE');

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>;
async function localServer(handler: Handler) {
  const server = http.createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => response.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}/v1`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function within<T>(value: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([value, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The fictional HTTP fixture did not settle.')), 3000); })]); }
  finally { clearTimeout(timer); }
}

test('local transcription requires complete fixed server configuration without probing, paid gating or voice fallbacks', async () => {
  let calls = 0;
  for (const env of [{}, { ...configured, FASTER_WHISPER_BASE_URL: '' }, { ...configured, FASTER_WHISPER_MODEL: '' }, { ...configured, FASTER_WHISPER_MODEL: 'tiny.en' }]) {
    const runtime = createProviderRuntime({ env, fetch: async () => { calls++; throw new Error('No probing or fallback'); } });
    const status = runtime.capabilities().find(provider => provider.id === 'faster-whisper')!;
    assert.equal(status.enabled, false); assert.equal(status.keyConfigured, false); assert.deepEqual(status.models, []);
    await assert.rejects(runtime.transcribe(audio, context), errorCode('PROVIDER_NOT_CONFIGURED'));
  }
  for (const flag of ['0', '1']) {
    const runtime = createProviderRuntime({ env: { ...configured, PLATFORM_ALLOW_PROVIDER_CALLS: flag }, fetch: async () => { calls++; throw new Error('No probing or fallback'); } });
    const status = runtime.capabilities().find(provider => provider.id === 'faster-whisper')!;
    assert.equal(status.enabled, true); assert.equal(status.keyConfigured, true);
    assert.deepEqual(status.capabilities, ['transcription']); assert.deepEqual(status.models, ['whisper-tiny']);
    assert.deepEqual(status.modelsByCapability, { transcription: ['whisper-tiny'] }); assert.equal(status.speechLanguages, undefined);
    assert(!status.envVariables.includes('PLATFORM_ALLOW_PROVIDER_CALLS'));
    await assert.rejects(runtime.speech({ provider: 'faster-whisper', text: 'Fictional speech.' }), errorCode('PROVIDER_UNSUPPORTED'));
    await assert.rejects(runtime.createVoiceSession({ provider: 'faster-whisper' }), errorCode('PROVIDER_UNSUPPORTED'));
    await assert.rejects(runtime.transcribe(audio), errorCode('PROVIDER_NOT_CONFIGURED'), 'omitted provider retains the legacy OpenAI route');
  }
  assert.equal(calls, 0);
});

test('local transcription accepts only literal loopback HTTP configuration and never a normalized alias or client URL', async () => {
  let calls = 0;
  for (const base of ['https://localhost:8881/v1', 'http://127.0.0.2:8881/v1', 'http://localhost.example/v1', 'http://0.0.0.0/v1', 'http://2130706433/v1', 'http://0x7f000001/v1', 'http://0177.0.0.1/v1', 'http://127.1/v1', 'http://user:PRIVATE_FIXTURE@localhost/v1', 'http://localhost/v1?file=PRIVATE_FIXTURE', 'http://localhost/v1#PRIVATE_FIXTURE', ' http://localhost/v1', 'http://localhost:0/v1', 'http://localhost:65536/v1', 'http://localhost/v1/../private']) {
    const runtime = createProviderRuntime({ env: { ...configured, FASTER_WHISPER_BASE_URL: base }, fetch: async () => { calls++; throw new Error('No transport'); } });
    assert.equal(runtime.capabilities().find(provider => provider.id === 'faster-whisper')!.enabled, false);
    await assert.rejects(runtime.transcribe(audio, context), errorCode('PROVIDER_NOT_CONFIGURED'));
  }
  for (const base of ['http://localhost:8881/v1/', 'http://127.0.0.1:8881/v1', 'http://[::1]:8881/v1']) {
    let target = '';
    const runtime = createProviderRuntime({ env: { ...configured, FASTER_WHISPER_BASE_URL: base }, fetch: async url => { target = String(url); return Response.json({ text: transcript }); } });
    assert.deepEqual(await runtime.transcribe(audio, context), { text: transcript }); assert.equal(target, base.replace(/\/$/, '') + '/audio/transcriptions');
  }
  assert.equal(calls, 0);
});

test('actual loopback multipart preserves raw recording bytes with fixed model, canonical MIME and a generated filename', async () => {
  const requests: { url?: string; fields: [string, FormDataEntryValue][]; authorization?: string; raw: Buffer }[] = [];
  const fixture = await localServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks), form = await new Response(raw, { headers: { 'content-type': request.headers['content-type']! } }).formData();
    const fields: [string, FormDataEntryValue][] = []; form.forEach((value, key) => fields.push([key, value]));
    requests.push({ url: request.url, fields, authorization: request.headers.authorization, raw });
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ text: transcript }));
  });
  const formats = [['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/wave', 'wav'], ['audio/mpeg', 'mp3'], ['audio/mp4', 'm4a'], ['audio/webm;codecs=opus', 'webm'], ['audio/ogg', 'ogg'], ['audio/flac', 'flac']] as const;
  try {
    const runtime = createProviderRuntime({ env: { ...configured, FASTER_WHISPER_BASE_URL: fixture.base } });
    for (const [mime] of formats) assert.deepEqual(await runtime.transcribe({ ...audio, mime }, context), { text: transcript });
    assert.equal(requests.length, formats.length);
    for (const [index, request] of requests.entries()) {
      assert.equal(request.url, '/v1/audio/transcriptions'); assert.equal(request.authorization, undefined);
      assert.deepEqual(request.fields.map(([key]) => key).sort(), ['file', 'model']);
      assert.equal(request.fields.find(([key]) => key === 'model')![1], 'whisper-tiny');
      const file = request.fields.find(([key]) => key === 'file')![1] as File;
      assert.equal(file.name, `recording.${formats[index][1]}`); assert.equal(file.type, formats[index][0].split(';')[0]);
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audio.bytes);
      assert.equal(request.raw.includes(Buffer.from(audio.name)), false, 'original names are not sent to the ASR service');
    }
  } finally { await fixture.close(); }
});

test('unsupported containers, empty/oversized audio and extra fields cannot reach any transcription transport', async () => {
  let calls = 0;
  const runtime = createProviderRuntime({ env: configured, fetch: async () => { calls++; return Response.json({ text: '' }); } });
  for (const input of [{ ...audio, bytes: new Uint8Array() }, { ...audio, bytes: new Uint8Array(maxAudio + 1) }, { ...audio, bytes: [1, 2] }, { ...audio, mime: 'video/mp4' }, { ...audio, mime: 'application/octet-stream' }, { ...audio, mime: 'image/png' }, { ...audio, mime: '__proto__' }, { ...audio, name: 123 }, { ...audio, url: 'http://external.example' }])
    await assert.rejects(runtime.transcribe(input as any, context), errorCode('INVALID_PROVIDER_INPUT'));
  for (const extra of [{ model: 'tiny.en' }, { baseUrl: 'http://external.example' }, { response_format: 'text' }, { key: 'PRIVATE_FIXTURE' }])
    await assert.rejects(runtime.transcribe(audio, { ...context, ...extra } as any), errorCode('INVALID_PROVIDER_INPUT'));
  assert.equal(calls, 0);
  assert.deepEqual(await runtime.transcribe({ ...audio, bytes: new Uint8Array(maxAudio) }, context), { text: '' });
  assert.equal(calls, 1, 'the exact 20 MiB input bound is inclusive');
});

test('actual split UTF8 JSON returns only faithful text and represents silence as an empty transcript', async () => {
  let text = transcript;
  const fixture = await localServer(async (request, response) => {
    for await (const _chunk of request) {} response.writeHead(200, { 'content-type': 'application/json' });
    const bytes = Buffer.from(JSON.stringify({ text })); for (const byte of bytes) response.write(Buffer.from([byte])); response.end();
  });
  try {
    const runtime = createProviderRuntime({ env: { ...configured, FASTER_WHISPER_BASE_URL: fixture.base } });
    for (const value of [transcript, '', 'Fictional <script>text only</script>\nSecond line.']) { text = value; assert.deepEqual(await runtime.transcribe(audio, context), { text: value }); }
  } finally { await fixture.close(); }
});

test('actual HTTP rejects non-JSON MIME, malformed/invalid UTF8 JSON and unexpected transcription shapes safely', async () => {
  let body: Buffer = Buffer.from('{}'), mime = 'application/json';
  const fixture = await localServer(async (request, response) => { for await (const _chunk of request) {} response.writeHead(200, { 'content-type': mime }); response.end(body); });
  try {
    const runtime = createProviderRuntime({ env: { ...configured, FASTER_WHISPER_BASE_URL: fixture.base } });
    for (const value of ['PRIVATE_FIXTURE', 'null', '[]', '{}', '{"text":123}', '{"text":null}', '{"text":{}}', '{"text":"ok","url":"PRIVATE_FIXTURE"}', '{"text":"\\ud800"}', '{"text":"\\udfff"}']) {
      body = Buffer.from(value); await assert.rejects(runtime.transcribe(audio, context), errorCode('INVALID_PROVIDER_RESPONSE'));
    }
    body = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')]); await assert.rejects(runtime.transcribe(audio, context), errorCode('INVALID_PROVIDER_RESPONSE'));
    body = Buffer.from(JSON.stringify({ text: transcript }));
    for (const value of ['text/plain', 'application/octet-stream', 'text/html']) { mime = value; await assert.rejects(runtime.transcribe(audio, context), errorCode('INVALID_PROVIDER_RESPONSE')); }
  } finally { await fixture.close(); }
});

test('transcript UTF8 byte bounds are inclusive and independent of the JSON body budget', async () => {
  let text = '🐈'.repeat(maxText / 4);
  const runtime = createProviderRuntime({ env: configured, fetch: async () => Response.json({ text }) });
  assert.equal(Buffer.byteLength((await runtime.transcribe(audio, context)).text), maxText);
  text += 'a'; await assert.rejects(runtime.transcribe(audio, context), errorCode('PROVIDER_OUTPUT_TOO_LARGE'));
  text = 'a'.repeat(maxText); assert.equal((await runtime.transcribe(audio, context)).text.length, maxText);
  text += 'a'; await assert.rejects(runtime.transcribe(audio, context), errorCode('PROVIDER_OUTPUT_TOO_LARGE'));
});

test('real HTTP declared and streaming JSON overflow cancel the response connection instead of buffering an unbounded body', async () => {
  let mode = 'declared', closed!: () => void;
  const fixture = await localServer(async (request, response) => {
    for await (const _chunk of request) {} response.once('close', () => closed());
    response.writeHead(200, { 'content-type': 'application/json', ...(mode === 'declared' ? { 'content-length': String(maxJson + 1) } : {}) });
    if (mode === 'declared') { response.flushHeaders(); return; }
    const chunk = Buffer.alloc(16 * 1024, 97);
    response.write('{"text":"');
    for (let index = 0; index < 20; index++) response.write(chunk);
  });
  try {
    const runtime = createProviderRuntime({ env: { ...configured, FASTER_WHISPER_BASE_URL: fixture.base } });
    for (const value of ['declared', 'streaming']) {
      mode = value; const close = new Promise<void>(resolve => { closed = resolve; });
      await assert.rejects(runtime.transcribe(audio, context), errorCode('PROVIDER_OUTPUT_TOO_LARGE')); await within(close);
    }
  } finally { await fixture.close(); }
});

test('redirects and service failures never follow external locations or reveal response bodies', async () => {
  let mode = 'redirect', followed = 0;
  const fixture = await localServer(async (request, response) => {
    for await (const _chunk of request) {} if (request.url === '/private-target') followed++;
    if (mode === 'redirect') { response.writeHead(302, { location: '/private-target' }); response.end(); }
    else { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'PRIVATE_FIXTURE ' + transcript })); }
  });
  try {
    const runtime = createProviderRuntime({ env: { ...configured, FASTER_WHISPER_BASE_URL: fixture.base } });
    await assert.rejects(runtime.transcribe(audio, context), errorCode('PROVIDER_UNREACHABLE')); assert.equal(followed, 0);
    mode = 'failure'; await assert.rejects(runtime.transcribe(audio, context), errorCode('PROVIDER_REJECTED'));
  } finally { await fixture.close(); }
});

test('actual HTTP cancellation stops multipart upload, header wait and response reading without returning a transcript', async () => {
  for (const mode of ['upload', 'headers', 'body']) {
    let started!: () => void, closed!: () => void, observed!: () => void;
    let uploadRequest: http.IncomingMessage | undefined, received = 0;
    const ready = new Promise<void>(resolve => { started = resolve; }), gone = new Promise<void>(resolve => { closed = resolve; });
    const bodyRead = new Promise<void>(resolve => { observed = resolve; });
    const fixture = await localServer(async (request, response) => {
      response.once('close', closed);
      if (mode === 'upload') {
        uploadRequest = request; request.on('data', chunk => { received += chunk.length; });
        request.once('data', () => { request.pause(); started(); }); return;
      }
      for await (const _chunk of request) {} started();
      if (mode === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"text":"'); }
    });
    const caller = new AbortController();
    try {
      const runtime = createProviderRuntime({ env: { ...configured, FASTER_WHISPER_BASE_URL: fixture.base },
        fetch: mode !== 'body' ? undefined : async (url, init) => {
          const response = await fetch(url, init); assert.ok(response.body);
          return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) { observed(); controller.enqueue(chunk); } })), { headers: response.headers });
        } });
      const result = runtime.transcribe({ ...audio, ...(mode === 'upload' ? { bytes: new Uint8Array(maxAudio) } : {}) }, { ...context, signal: caller.signal });
      await within(mode === 'body' ? bodyRead : ready);
      caller.abort(); await assert.rejects(result, errorCode('PROVIDER_INTERRUPTED'));
      // A paused receiving socket must drain queued bytes to observe the peer's FIN/reset.
      // The request remains incomplete: cancellation cannot finish uploading the recording.
      uploadRequest?.resume(); await within(gone);
      if (mode === 'upload') assert.ok(received < maxAudio, 'the recording did not finish uploading after cancellation');
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    } finally { caller.abort(); await fixture.close(); }
  }
});

test('cancellation before upload calls no transport, and ignored transport signals still cancel the active response reader', async () => {
  const before = new AbortController(); before.abort(); let calls = 0, cancelled = false, ready!: () => void;
  const reading = new Promise<void>(resolve => { ready = resolve; });
  const runtime = createProviderRuntime({ env: configured, fetch: async () => {
    calls++; return new Response(new ReadableStream<Uint8Array>({ pull() { ready(); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(runtime.transcribe(audio, { ...context, signal: before.signal }), errorCode('PROVIDER_INTERRUPTED')); assert.equal(calls, 0);
  const caller = new AbortController(), result = runtime.transcribe(audio, { ...context, signal: caller.signal });
  await reading; caller.abort(); await assert.rejects(result, errorCode('PROVIDER_INTERRUPTED'));
  assert.equal(cancelled, true); assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});
