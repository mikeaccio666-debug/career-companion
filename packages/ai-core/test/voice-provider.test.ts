import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRuntime } from '../src/index.ts';

const audio = { name: 'fictional.wav', mime: 'audio/wav', bytes: new Uint8Array([1, 2, 3]) };
const enabled = {
  PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-key',
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1', OLLAMA_CHAT_MODEL: 'fictional-local',
  OPENROUTER_API_KEY: 'fictional-key', OPENROUTER_CHAT_MODEL: 'fictional-router',
  ARK_API_KEY: 'fictional-key', ARK_CHAT_MODEL: 'fictional-ark', PLATFORM_ENABLE_BROWSER: '1',
};

test('explicit unsupported voice providers never fall back to OpenAI or call transport', async () => {
  let requests = 0;
  const runtime = createProviderRuntime({ env: enabled, fetch: async () => { requests++; throw new Error('Transport must not be called.'); } });
  for (const provider of ['unknown', 'ollama', 'openrouter', 'ark', 'browser', 'workflow']) {
    await assert.rejects(runtime.createVoiceSession({ provider }), { code: 'PROVIDER_UNSUPPORTED' });
    await assert.rejects(runtime.transcribe(audio, { provider }), { code: 'PROVIDER_UNSUPPORTED' });
    await assert.rejects(runtime.speech({ provider, text: 'Fictional speech.' }), { code: 'PROVIDER_UNSUPPORTED' });
  }
  for (const provider of ['', ' openai', 'OpenAI', null, 0] as any[]) {
    await assert.rejects(runtime.createVoiceSession({ provider }), { code: 'INVALID_PROVIDER_INPUT' });
    await assert.rejects(runtime.transcribe(audio, { provider }), { code: 'INVALID_PROVIDER_INPUT' });
    await assert.rejects(runtime.speech({ provider, text: 'Fictional speech.' }), { code: 'INVALID_PROVIDER_INPUT' });
  }
  assert.equal(requests, 0);
});

test('OpenAI voice requires explicit commercial opt-in for omitted and selected provider', async () => {
  let requests = 0;
  const runtime = createProviderRuntime({ env: { OPENAI_API_KEY: 'fictional-key', PLATFORM_ALLOW_PROVIDER_CALLS: '0' },
    fetch: async () => { requests++; throw new Error('Transport must not be called.'); } });
  for (const provider of [undefined, 'openai']) {
    await assert.rejects(runtime.createVoiceSession({ provider }), { code: 'PROVIDER_NOT_CONFIGURED' });
    await assert.rejects(runtime.transcribe(audio, { provider }), { code: 'PROVIDER_NOT_CONFIGURED' });
    await assert.rejects(runtime.speech({ provider, text: 'Fictional speech.' }), { code: 'PROVIDER_NOT_CONFIGURED' });
  }
  assert.equal(requests, 0);
});

test('omitted provider preserves legacy OpenAI routing; explicit OpenAI uses the same adapters', async () => {
  const requests: { url: string; body: any }[] = [];
  const runtime = createProviderRuntime({ env: { ...enabled, OPENAI_REALTIME_MODEL: 'fictional-realtime',
    OPENAI_TRANSCRIBE_MODEL: 'fictional-transcription', OPENAI_TTS_MODEL: 'fictional-speech' },
    fetch: async (url, init = {}) => {
      const address = String(url); assert.equal(new URL(address).hostname, 'api.openai.com');
      requests.push({ url: address, body: init.body instanceof FormData ? init.body : JSON.parse(String(init.body)) });
      if (address.endsWith('/client_secrets')) return Response.json({ value: 'fictional-ephemeral' });
      if (address.endsWith('/transcriptions')) return Response.json({ text: 'Fictional transcript.' });
      assert.ok(address.endsWith('/speech')); return new Response(new Uint8Array([1, 2, 3]));
    } });
  for (const provider of [undefined, 'openai']) {
    assert.equal((await runtime.createVoiceSession({ provider })).model, 'fictional-realtime');
    assert.equal((await runtime.transcribe(audio, { provider })).text, 'Fictional transcript.');
    assert.equal((await runtime.speech({ provider, text: 'Fictional speech.', voice: 'marin' })).mime, 'audio/mpeg');
  }
  assert.equal(requests.length, 6);
  assert.deepEqual(requests[0].body, requests[3].body);
  for (const index of [1, 4]) {
    assert.equal(requests[index].body.get('model'), 'fictional-transcription');
    assert.ok(requests[index].body.get('file') instanceof Blob);
    assert.equal(requests[index].body.get('provider'), null);
  }
  assert.deepEqual(requests[2].body, requests[5].body);
  assert.equal(requests[2].body.provider, undefined);
});
