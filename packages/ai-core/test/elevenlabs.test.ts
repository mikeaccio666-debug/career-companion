import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import type { SpeechInput } from '@companion/platform-contracts';
import { elevenLabsConfiguration, ELEVENLABS_SPEECH_MODELS, speechElevenLabs } from '../src/elevenlabs.ts';
import { ProviderError } from '../src/errors.ts';
import { HttpClient, type Fetch } from '../src/http.ts';

const configured = { ELEVENLABS_API_KEY: 'synthetic-server-key', ELEVENLABS_TTS_MODEL: 'eleven_v4', ELEVENLABS_TTS_VOICE_ID: 'SyntheticVoice000001' };
const speech: SpeechInput = { provider: 'elevenlabs', text: 'This is invented interview practice text.' };
// Synthetic MPEG frame bytes exercise transport only; these tests make no quality or voice-ownership claim.
const mp3 = new Uint8Array(417); mp3.set([0xff, 0xfb, 0x90, 0]);
const maxBytes = 30 * 1024 * 1024;
function audio(bytes: Uint8Array = mp3, headers: HeadersInit = {}) {
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'audio/mpeg', ...headers } });
}
function code(expected: string) {
  return (error: unknown) => {
    assert(error instanceof ProviderError); assert.equal(error.code, expected);
    for (const privateValue of [configured.ELEVENLABS_API_KEY, configured.ELEVENLABS_TTS_VOICE_ID, speech.text, 'synthetic-private-body']) {
      assert(!error.publicMessage.includes(privateValue)); assert(!error.message.includes(privateValue));
    }
    assert.equal(error.cause, undefined); return true;
  };
}

test('configuration requires all explicit server bindings and rejects malformed or unsupported values', () => {
  assert.deepEqual(elevenLabsConfiguration(configured), { key: configured.ELEVENLABS_API_KEY, model: 'eleven_v4', voice: configured.ELEVENLABS_TTS_VOICE_ID, allowProviderHistory: false });
  for (const field of ['ELEVENLABS_API_KEY', 'ELEVENLABS_TTS_MODEL', 'ELEVENLABS_TTS_VOICE_ID']) {
    for (const value of [undefined, '', ' ']) assert.throws(() => elevenLabsConfiguration({ ...configured, [field]: value }), code('PROVIDER_NOT_CONFIGURED'));
  }
  for (const extra of [{ ELEVENLABS_API_KEY: '\r\nsynthetic-header' }, { ELEVENLABS_API_KEY: ' spaced-key' }, { ELEVENLABS_API_KEY: 'x'.repeat(4097) },
    { ELEVENLABS_TTS_MODEL: 'eleven_v4_turbo' }, { ELEVENLABS_TTS_MODEL: 'scribe_v2' }, { ELEVENLABS_TTS_MODEL: 'eleven_multilingual_sts_v2' },
    { ELEVENLABS_TTS_MODEL: 'unknown' }, { ELEVENLABS_TTS_MODEL: ' eleven_v4' }, { ELEVENLABS_TTS_VOICE_ID: '../private-target' },
    { ELEVENLABS_TTS_VOICE_ID: 'voice?enable_logging=true' }, { ELEVENLABS_TTS_VOICE_ID: 'voice#target' }, { ELEVENLABS_TTS_VOICE_ID: 'voice\nheader' },
    { ELEVENLABS_TTS_VOICE_ID: 'x'.repeat(101) }, { ELEVENLABS_ALLOW_PROVIDER_HISTORY: '' }, { ELEVENLABS_ALLOW_PROVIDER_HISTORY: 'true' },
    { ELEVENLABS_ALLOW_PROVIDER_HISTORY: '2' }, { ELEVENLABS_ALLOW_PROVIDER_HISTORY: ' 1' }]) {
    assert.throws(() => elevenLabsConfiguration({ ...configured, ...extra }), code('INVALID_PROVIDER_CONFIG'));
  }
  for (const model of ELEVENLABS_SPEECH_MODELS) assert.equal(elevenLabsConfiguration({ ...configured, ELEVENLABS_TTS_MODEL: model }).model, model);
});

test('fixed convert POST uses xi-api-key, configured model and one voice with explicit history policy', async () => {
  const requests: { target: URL; init: RequestInit }[] = [];
  const client = new HttpClient(async (target, init) => {
    requests.push({ target: new URL(String(target)), init: init! }); return audio(mp3, { 'content-length': String(mp3.byteLength) });
  });
  for (const model of ELEVENLABS_SPEECH_MODELS) {
    for (const history of [undefined, '0', '1']) {
      const env = { ...configured, ELEVENLABS_TTS_MODEL: model, ELEVENLABS_ALLOW_PROVIDER_HISTORY: history };
      const result = await speechElevenLabs(client, env, { ...speech, model, voice: configured.ELEVENLABS_TTS_VOICE_ID });
      assert.deepEqual(result, { name: 'speech.mp3', mime: 'audio/mpeg', bytes: mp3 });
      const request = requests.at(-1)!;
      assert.equal(request.target.origin, 'https://api.elevenlabs.io');
      assert.equal(request.target.pathname, '/v1/text-to-speech/' + configured.ELEVENLABS_TTS_VOICE_ID);
      assert.deepEqual([...request.target.searchParams], [['output_format', 'mp3_44100_128'], ['enable_logging', String(history === '1')]]);
      const headers = new Headers(request.init.headers);
      assert.equal(headers.get('xi-api-key'), configured.ELEVENLABS_API_KEY); assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('content-type'), 'application/json'); assert.equal(request.init.redirect, 'error');
      assert(request.init.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(String(request.init.body)), { text: speech.text, model_id: model, use_pvc_as_ivc: false });
    }
  }
  assert.equal(requests.length, ELEVENLABS_SPEECH_MODELS.length * 3);
});

test('input cannot replace server model, voice, instructions, URLs, retention or synthesis options', async () => {
  let calls = 0;
  const client = new HttpClient(async () => { calls++; return audio(); });
  for (const extra of [{ voice: 'unknown' }, { voice: null }, { model: 'eleven_multilingual_v2' }, { model: null }, { provider: 'openai' },
    { text: '' }, { text: ' ' }, { text: 'A'.repeat(4097) }, { text: 1 }, { instructions: 'synthetic instructions' }, { instructions: null },
    { enable_logging: true }, { output_format: 'wav' }, { url: 'https://external.example' }, { voice_settings: { stability: 0 } },
    { use_pvc_as_ivc: true }, { voice_id: 'unbound' }, { inputs: [] }]) {
    await assert.rejects(speechElevenLabs(client, configured, { ...speech, ...extra } as any), code('INVALID_PROVIDER_INPUT'));
  }
  for (const extra of [{ ELEVENLABS_TTS_MODEL: '' }, { ELEVENLABS_TTS_VOICE_ID: 'voice/target' }]) {
    await assert.rejects(speechElevenLabs(client, { ...configured, ...extra }, speech), code(extra.ELEVENLABS_TTS_MODEL === '' ? 'PROVIDER_NOT_CONFIGURED' : 'INVALID_PROVIDER_CONFIG'));
  }
  assert.equal(calls, 0);
  await speechElevenLabs(client, configured, { text: 'A'.repeat(4096) });
  assert.equal(calls, 1, 'v4 keeps the existing single-speaker 4096-character input bound');
});

test('provider rejection is sanitized and never retries history, model, voice or another endpoint', async () => {
  for (const [status, expected] of [[401, 'PROVIDER_AUTH_FAILED'], [403, 'PROVIDER_AUTH_FAILED'], [429, 'PROVIDER_RATE_LIMIT'], [422, 'PROVIDER_REJECTED'], [500, 'PROVIDER_REJECTED']] as const) {
    let calls = 0, cancelled = false;
    const client = new HttpClient(async (target) => {
      calls++; assert.equal(new URL(String(target)).searchParams.get('enable_logging'), 'false');
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('synthetic-private-body')); }, cancel() { cancelled = true; } }), { status });
    });
    await assert.rejects(speechElevenLabs(client, configured, speech), code(expected));
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
  const unreachable = new HttpClient(async () => { throw new Error('synthetic-private-body ' + configured.ELEVENLABS_API_KEY); });
  await assert.rejects(speechElevenLabs(unreachable, configured, speech), code('PROVIDER_UNREACHABLE'));
});

test('malformed MIME, empty output, length mismatch and reader exceptions return no fabricated audio', async () => {
  for (const response of [new Response(null, { headers: { 'content-type': 'audio/mpeg' } }), audio(new Uint8Array()),
    audio(mp3, { 'content-type': 'application/json' }), audio(mp3, { 'content-type': 'audio/wav' }), audio(mp3, { 'content-length': 'malformed' }),
    audio(mp3, { 'content-length': String(mp3.length - 1) }), audio(mp3, { 'content-length': String(mp3.length + 1) })]) {
    await assert.rejects(speechElevenLabs(new HttpClient(async () => response), configured, speech), code('INVALID_PROVIDER_RESPONSE'));
  }
  const broken = new HttpClient(async () => new Response(new ReadableStream({ pull() { throw new Error('synthetic-private-body'); } }), { headers: { 'content-type': 'audio/mpeg' } }));
  await assert.rejects(speechElevenLabs(broken, configured, speech), code('ELEVENLABS_SPEECH_FAILED'));
});

test('MP3 requires an ID3 header or a valid MPEG Layer III header; signature tests do not decode audio', async () => {
  const id3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
  for (const bytes of [id3, mp3.subarray(0, 4)]) {
    assert.deepEqual((await speechElevenLabs(new HttpClient(async () => audio(bytes)), configured, speech)).bytes, bytes);
  }
  for (const bytes of [new TextEncoder().encode('synthetic-private-body'), new Uint8Array([0x49, 0x44, 0x33]),
    new Uint8Array([0xff, 0xfb, 0x90]), new Uint8Array([0xff, 0xeb, 0x90, 0]), new Uint8Array([0xff, 0xfd, 0x90, 0]),
    new Uint8Array([0xff, 0xfb, 0x00, 0]), new Uint8Array([0xff, 0xfb, 0xf0, 0]), new Uint8Array([0xff, 0xfb, 0x9c, 0]),
    new Uint8Array([0xff, 0xfb, 0x90, 2]), new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0x80, 0, 0, 0])]) {
    await assert.rejects(speechElevenLabs(new HttpClient(async () => audio(bytes)), configured, speech), code('INVALID_PROVIDER_RESPONSE'));
  }
});

test('declared and streamed audio sizes are bounded and cancel their source', async () => {
  for (const mode of ['declared', 'streamed']) {
    let cancelled = false, produced = 0;
    const client = new HttpClient(async () => new Response(new ReadableStream({
      pull(stream) { produced++; stream.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'audio/mpeg', ...(mode === 'declared' ? { 'content-length': String(maxBytes + 1) } : {}) } }));
    await assert.rejects(speechElevenLabs(client, configured, speech), code('PROVIDER_OUTPUT_TOO_LARGE'));
    assert.equal(cancelled, true); assert(produced <= 32, 'overflow stops reading without unbounded buffering');
  }
});

test('cancellation before transport, while awaiting headers and during body reading keeps errors private', async () => {
  let calls = 0;
  const before = new AbortController(); before.abort();
  await assert.rejects(speechElevenLabs(new HttpClient(async () => { calls++; return audio(); }), configured, speech, before.signal), code('PROVIDER_INTERRUPTED'));
  assert.equal(calls, 0);
  let requested!: () => void;
  const headersStarted = new Promise<void>(resolve => { requested = resolve; }), headers = new AbortController();
  const client = new HttpClient((async (_target, init) => {
    requested(); return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('synthetic-private-body')), { once: true }));
  }) as Fetch);
  const headerFailure = assert.rejects(speechElevenLabs(client, configured, speech, headers.signal), code('PROVIDER_INTERRUPTED'));
  await headersStarted; headers.abort(); await headerFailure;

  let reading!: () => void, cancelled = false;
  const bodyStarted = new Promise<void>(resolve => { reading = resolve; }), body = new AbortController();
  const ignoresAbort = new HttpClient(async () => new Response(new ReadableStream({
    pull(stream) { stream.enqueue(mp3.subarray(0, 4)); reading(); return new Promise(() => {}); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'audio/mpeg' } }));
  const bodyFailure = assert.rejects(speechElevenLabs(ignoresAbort, configured, speech, body.signal), code('PROVIDER_INTERRUPTED'));
  await bodyStarted; body.abort(); await bodyFailure;
  assert.equal(cancelled, true); assert.equal(getEventListeners(body.signal, 'abort').length, 0);
});
