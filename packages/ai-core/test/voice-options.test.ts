import test from 'node:test';
import assert from 'node:assert/strict';
import http, { type ServerResponse } from 'node:http';
import type { CreateJobInput, SpeechInput, VoiceSessionInput } from '@companion/platform-contracts';
import { createProviderRuntime, ProviderError } from '../src/index.ts';
import { workflowStore } from './fixtures/workflow-store.ts';

const enabled = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'synthetic-voice-key' };
const speechVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const realtimeVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const legacyVoices = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];
const text = 'A fictional speech sample.';
const instructions = 'Speak warmly and leave space between ideas.';
const invalidInput = (error: unknown) => error instanceof ProviderError && error.code === 'INVALID_PROVIDER_INPUT' && !error.message.includes(text) && !error.message.includes(instructions);
type Request = { path: string; body: Record<string, any> };
type Fixture = { runtime: ReturnType<typeof createProviderRuntime>; requests: Request[]; base: string };
async function loopback(env: NodeJS.ProcessEnv, run: (fixture: Fixture) => Promise<void>, handler?: (request: Request, response: ServerResponse) => void) {
  const requests: Request[] = []; let failure: unknown;
  const server = http.createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const record = { path: request.url!, body: JSON.parse(raw) }; requests.push(record);
      if (handler) handler(record, response);
      else if (record.path.endsWith('/client_secrets')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ value: 'synthetic-ephemeral-credential', expires_at: 123 }));
      } else {
        assert.equal(record.path, '/v1/audio/speech');
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' }); response.end(Buffer.from([1, 2, 3]));
      }
    } catch (error) { failure = error; response.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const runtime = createProviderRuntime({ env: { ...enabled, ...env, KOKORO_BASE_URL: base + '/v1' }, fetch: async (url, init) => {
    const target = new URL(String(url)); assert(['api.openai.com', '127.0.0.1'].includes(target.hostname));
    // Real HTTP validates provider JSON and cancellation against an owned local
    // server. No request reaches a model provider and all keys are synthetic.
    return globalThis.fetch(base + target.pathname, init);
  } });
  try { await run({ runtime, requests, base }); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function voiceOptions(env: NodeJS.ProcessEnv = {}) {
  return createProviderRuntime({ env: { ...enabled, ...env } }).capabilities().find(provider => provider.id === 'openai')!.voiceOptions!;
}

test('catalog distinguishes TTS, Realtime and fixed Kokoro controls without sharing mutable arrays', () => {
  const runtime = createProviderRuntime({ env: enabled }), options = runtime.capabilities().find(provider => provider.id === 'openai')!.voiceOptions!;
  assert.deepEqual(options.speech, { voices: speechVoices, defaultVoice: 'marin', instructions: true });
  assert.deepEqual(options.realtime, { voices: realtimeVoices, defaultVoice: 'marin', instructions: true, turnTaking: true });
  assert.deepEqual(runtime.capabilities().find(provider => provider.id === 'kokoro')!.voiceOptions, { speech: { voices: ['af_heart'], defaultVoice: 'af_heart', instructions: false } });
  options.speech!.voices.push('synthetic-unverified-voice');
  assert.deepEqual(runtime.capabilities().find(provider => provider.id === 'openai')!.voiceOptions!.speech!.voices, speechVoices);
});

test('catalog advertises instructions only for verified snapshots and legacy voices/defaults match dispatch', async () => {
  for (const model of ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts-2025-12-15']) {
    assert.deepEqual(voiceOptions({ OPENAI_TTS_MODEL: model }).speech, { voices: speechVoices, defaultVoice: 'marin', instructions: true });
  }
  for (const model of ['gpt-4o-mini-tts-2099-01-01', 'synthetic-custom-speech']) assert.equal(voiceOptions({ OPENAI_TTS_MODEL: model }).speech, undefined);
  for (const model of ['tts-1', 'tts-1-hd']) {
    assert.deepEqual(voiceOptions({ OPENAI_TTS_MODEL: model }).speech, { voices: legacyVoices, defaultVoice: 'alloy', instructions: false });
    await loopback({ OPENAI_TTS_MODEL: model }, async ({ runtime, requests }) => {
      await runtime.speech({ text }); assert.equal(requests[0].body.model, model); assert.equal(requests[0].body.voice, 'alloy'); assert.equal(requests[0].body.instructions, undefined);
    });
  }
});

test('all advertised TTS voices and verified snapshot instructions reach real loopback JSON unmodified', async () => {
  await loopback({}, async ({ runtime, requests }) => {
    for (const voice of speechVoices) assert.equal((await runtime.speech({ provider: 'openai', text, voice, instructions })).mime, 'audio/mpeg');
    for (const model of ['gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts-2025-12-15']) await runtime.speech({ text, model, voice: 'cedar', instructions: ' '.repeat(1999) + 'x' });
    assert.equal(requests.length, 15);
    for (const [index, request] of requests.entries()) {
      assert.equal(request.path, '/v1/audio/speech');
      assert.deepEqual(Object.keys(request.body).sort(), ['input', 'instructions', 'model', 'response_format', 'voice']);
      assert.equal(request.body.input, text); assert.equal(request.body.response_format, 'mp3');
      if (index < 13) { assert.equal(request.body.voice, speechVoices[index]); assert.equal(request.body.instructions, instructions); }
      else assert.equal(request.body.instructions.length, 2000);
    }
  });
});

test('server voice defaults and explicit overrides match catalog while legacy omission adds no new turn detector', async () => {
  await loopback({ OPENAI_TTS_VOICE: 'echo', OPENAI_REALTIME_VOICE: 'cedar' }, async ({ runtime, requests }) => {
    const options = runtime.capabilities().find(provider => provider.id === 'openai')!.voiceOptions!;
    assert.equal(options.speech!.defaultVoice, 'echo'); assert.equal(options.realtime!.defaultVoice, 'cedar');
    await runtime.speech({ text }); await runtime.speech({ text, voice: 'marin' });
    await runtime.createVoiceSession(); await runtime.createVoiceSession({ voice: 'ash' });
    assert.equal(requests[0].body.voice, 'echo'); assert.equal(requests[1].body.voice, 'marin');
    assert.deepEqual(requests[2].body.session.audio, { output: { voice: 'cedar' } });
    assert.deepEqual(requests[3].body.session.audio, { output: { voice: 'ash' } });
  });
});

test('Realtime uses its ten voices and maps turn-taking modes under audio.input with transcription preserved', async () => {
  await loopback({ OPENAI_REALTIME_TRANSCRIBE_MODEL: 'gpt-4o-mini-transcribe' }, async ({ runtime, requests }) => {
    const modes = ['patient', 'balanced', 'quick'] as const, eager = ['low', 'medium', 'high'];
    for (const [index, voice] of realtimeVoices.entries()) {
      const result = await runtime.createVoiceSession({ provider: 'openai', persona: instructions, voice, turnTaking: modes[index % 3] });
      assert.equal(result.inputTranscriptionEnabled, true);
      assert.equal(result.endpoint, 'https://api.openai.com/v1/realtime/calls');
    }
    assert.equal(requests.length, 10);
    for (const [index, request] of requests.entries()) {
      assert.equal(request.path, '/v1/realtime/client_secrets');
      assert.deepEqual(request.body.session.audio, { output: { voice: realtimeVoices[index] }, input: {
        transcription: { model: 'gpt-4o-mini-transcribe' }, turn_detection: { type: 'semantic_vad', eagerness: eager[index % 3], create_response: true, interrupt_response: true },
      } });
      assert.equal(request.body.session.instructions, instructions);
      assert.deepEqual(Object.keys(request.body.session).sort(), ['audio', 'instructions', 'model', 'type']);
    }
  });
});

test('malformed speech controls and unknown fields fail before any real HTTP request', async () => {
  await loopback({}, async ({ runtime, requests }) => {
    for (const instructions of [null, false, 4, [], {}, '', '   ', 'x'.repeat(2001)]) await assert.rejects(runtime.speech({ text, instructions } as unknown as SpeechInput), invalidInput);
    for (const extra of [{ voice: null }, { voice: 3 }, { voice: '' }, { voice: 'unknown' }, { voice: [] }, { model: null }, { model: 2 }, { model: '' }, { model: 'x'.repeat(161) }, { speed: 1 }, { text: ' ' }]) await assert.rejects(runtime.speech({ text, ...extra } as unknown as SpeechInput), invalidInput);
    assert.equal(requests.length, 0);
  });
});

test('unsupported expression models and legacy-only/realtime-only voice mismatches cannot silently fall back', async () => {
  await loopback({}, async ({ runtime, requests }) => {
    for (const model of ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts-2099-01-01', 'synthetic-custom-speech']) await assert.rejects(runtime.speech({ text, model, instructions }), invalidInput);
    for (const model of ['tts-1', 'tts-1-hd']) for (const voice of ['ballad', 'verse', 'marin', 'cedar']) await assert.rejects(runtime.speech({ text, model, voice }), invalidInput);
    for (const voice of ['fable', 'nova', 'onyx', '', ' unknown', null, 3, [], {}]) await assert.rejects(runtime.createVoiceSession({ voice } as unknown as VoiceSessionInput), invalidInput);
    for (const turnTaking of ['', 'auto', 'slow', null, 3, [], {}]) await assert.rejects(runtime.createVoiceSession({ turnTaking } as unknown as VoiceSessionInput), invalidInput);
    for (const extra of [{ voice: 'x'.repeat(101) }, { model: null }, { model: [] }, { persona: 'x'.repeat(2001) }, { instructions }, { tools: [] }]) await assert.rejects(runtime.createVoiceSession(extra as VoiceSessionInput), invalidInput);
    assert.equal(requests.length, 0);
  });
});

test('invalid server defaults are not published or used in provider requests', async () => {
  for (const env of [{ OPENAI_TTS_VOICE: 'synthetic-private-config' }, { OPENAI_TTS_MODEL: 'tts-1', OPENAI_TTS_VOICE: 'marin' }]) {
    assert.equal(voiceOptions(env).speech, undefined);
    await loopback(env, async ({ runtime, requests }) => { await assert.rejects(runtime.speech({ text }), invalidInput); assert.equal(requests.length, 0); });
  }
  assert.equal(voiceOptions({ OPENAI_REALTIME_VOICE: 'synthetic-private-config' }).realtime, undefined);
  await loopback({ OPENAI_REALTIME_VOICE: 'fable' }, async ({ runtime, requests }) => { await assert.rejects(runtime.createVoiceSession(), invalidInput); assert.equal(requests.length, 0); });
});

test('Kokoro explicitly rejects expression instructions in direct calls, speech jobs and workflow steps', async () => {
  await loopback({ KOKORO_TTS_MODEL: 'kokoro-82m', KOKORO_TTS_VOICE: 'af_heart' }, async ({ runtime, requests }) => {
    await assert.rejects(runtime.speech({ provider: 'kokoro', text, instructions }), invalidInput);
    const context = { jobId: 'synthetic-job', userId: 'synthetic-user', workspaceDirectory: '/tmp/synthetic-voice' };
    const input: CreateJobInput = { kind: 'speech', provider: 'kokoro', prompt: text, options: { voice: 'af_heart', instructions } };
    await assert.rejects(runtime.executeJob(input, context), invalidInput);
    const workflow: CreateJobInput = { kind: 'workflow', provider: 'workflow', prompt: text, options: { steps: [{ kind: 'speech', provider: 'kokoro', model: 'kokoro-82m', prompt: '{{input}}', options: { instructions } }] } };
    await assert.rejects(runtime.executeJob(workflow, workflowStore(workflow, context).context()), invalidInput);
    assert.equal(requests.length, 0);
  });
});

test('speech jobs and durable workflow steps deliver instructions through the same validator without ignoring options', async () => {
  await loopback({}, async ({ runtime, requests }) => {
    const context = { jobId: 'synthetic-job', userId: 'synthetic-user', workspaceDirectory: '/tmp/synthetic-voice' };
    const input: CreateJobInput = { kind: 'speech', provider: 'openai', prompt: text, options: { voice: 'cedar', instructions } };
    await runtime.executeJob(input, context);
    const workflow: CreateJobInput = { kind: 'workflow', provider: 'workflow', prompt: text, options: { steps: [{ kind: 'speech', provider: 'openai', model: 'gpt-4o-mini-tts', prompt: '{{input}}', options: { voice: 'marin', instructions } }] } };
    const store = workflowStore(workflow, context); await runtime.executeJob(workflow, store.context());
    assert.equal(store.published.length, 1); assert.equal(requests.length, 2);
    assert.equal(requests[0].body.voice, 'cedar'); assert.equal(requests[1].body.voice, 'marin');
    for (const request of requests) assert.equal(request.body.instructions, instructions);
    for (const options of [{ instructions: '' }, { instructions: 2 }, { voice: null }, { speed: 1 }, [], null]) await assert.rejects(runtime.executeJob({ ...input, options } as CreateJobInput, context), invalidInput);
    assert.equal(requests.length, 2);
  });
});

test('Realtime session creation propagates abort before credentials and during the private credential body', async () => {
  for (const phase of ['headers', 'body']) {
    let started!: () => void; const received = new Promise<void>(resolve => { started = resolve; });
    let closed!: () => void; const disconnected = new Promise<void>(resolve => { closed = resolve; });
    await loopback({}, async ({ runtime, requests }) => {
      const controller = new AbortController();
      const rejected = assert.rejects(runtime.createVoiceSession({ voice: 'cedar', turnTaking: 'patient' }, { signal: controller.signal }), { code: 'PROVIDER_INTERRUPTED' });
      await received; controller.abort(); await rejected; await disconnected;
      assert.equal(requests.length, 1);
    }, (_request, response) => {
      response.on('close', closed);
      if (phase === 'body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"value":"synthetic-'); }
      started();
    });
  }
  await loopback({}, async ({ runtime, requests }) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runtime.createVoiceSession({}, { signal: controller.signal }), { code: 'PROVIDER_INTERRUPTED' });
    assert.equal(requests.length, 0);
  });
});
