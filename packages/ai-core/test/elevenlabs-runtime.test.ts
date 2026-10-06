import test from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CreateJobInput, JobExecutionContext, SpeechInput } from '@companion/platform-contracts';
import { createProviderRuntime, ProviderError } from '../src/index.ts';
import { workflowStore } from './fixtures/workflow-store.ts';
import { voiceCapabilities } from '../../../apps/web/src/voice-capabilities.ts';
import { voiceAudioConfiguration, voiceOptionState, voiceSpeechBody } from '../../../apps/web/src/voice-personality.ts';
import { modelsForStep, workflowReadiness } from '../../../apps/web/src/workflow-editor.ts';

const voice = 'fictional-server-voice', model = 'eleven_v4', text = 'A fictional interview practice narration.';
const configured: NodeJS.ProcessEnv = { PLATFORM_ALLOW_PROVIDER_CALLS: '1', ELEVENLABS_API_KEY: 'fictional-elevenlabs-key',
  ELEVENLABS_TTS_MODEL: model, ELEVENLABS_TTS_VOICE_ID: voice };
const context: JobExecutionContext = { jobId: 'fictional-elevenlabs-job', userId: 'fictional-elevenlabs-user', workspaceDirectory: '/tmp/fictional-elevenlabs-workspace' };
// A synthetic MPEG frame tests transport bytes and signatures, not decoding or
// acoustic quality. No model provider is contacted by this fixture.
const audio = new Uint8Array(417); audio.set([0xff, 0xfb, 0x90, 0x00]);
type Request = { method: string; path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };
type Fixture = { requests: Request[]; runtime: (env?: NodeJS.ProcessEnv) => ReturnType<typeof createProviderRuntime> };
async function loopback(run: (fixture: Fixture) => Promise<void>, respond?: (request: Request, response: ServerResponse) => void) {
  const requests: Request[] = []; let failure: unknown;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const recorded = { method: request.method!, path: request.url!, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
      requests.push(recorded);
      if (respond) { respond(recorded, response); return; }
      response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.byteLength });
      for (let offset = 0; offset < audio.length; offset += 13) response.write(audio.subarray(offset, offset + 13));
      response.end();
    } catch (error) { failure = error; response.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ requests, runtime: (env = {}) => createProviderRuntime({ env: { ...configured, ...env }, fetch: async (url, init) => {
      const target = new URL(String(url));
      assert.equal(target.origin, 'https://api.elevenlabs.io', 'Provider requests must keep the fixed official origin.');
      // The normal runtime/adapters make real HTTP requests to this owned fixture;
      // this transport substitution never sends keys or prompts off this machine.
      return globalThis.fetch(base + target.pathname + target.search, init);
    } }) });
    if (failure) throw failure;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function speechJob(options: Record<string, unknown> = {}): CreateJobInput {
  return { kind: 'speech', provider: 'elevenlabs', model, prompt: text, options };
}
function workflow(options: Record<string, unknown> = {}): CreateJobInput {
  return { kind: 'workflow', provider: 'workflow', prompt: text, options: { steps: [
    { kind: 'speech', provider: 'elevenlabs', model, prompt: '{{input}}', options },
  ] } };
}
function contract(request: Request, narration: string, history = false) {
  assert.equal(request.method, 'POST');
  const target = new URL(request.path, 'https://api.elevenlabs.io');
  assert.equal(target.pathname, `/v1/text-to-speech/${voice}`);
  assert.deepEqual(Object.fromEntries(target.searchParams), { output_format: 'mp3_44100_128', enable_logging: String(history) });
  assert.equal(request.headers['xi-api-key'], configured.ELEVENLABS_API_KEY);
  assert.equal(request.headers.authorization, undefined);
  assert.match(String(request.headers['content-type']), /^application\/json/);
  assert.deepEqual(request.body, { text: narration, model_id: model, use_pvc_as_ivc: false });
}
const invalidInput = (error: unknown) => error instanceof ProviderError && error.code === 'INVALID_PROVIDER_INPUT' && !error.message.includes(text);

test('ElevenLabs catalog works with the existing generic voice and workflow helpers without claiming account readiness', async () => {
  await loopback(async ({ runtime: create, requests }) => {
    const runtime = create(), provider = runtime.capabilities().find(item => item.id === 'elevenlabs')!;
    assert.ok(provider); assert.equal(provider.enabled, true); assert.equal(provider.keyConfigured, true);
    assert.deepEqual(provider.capabilities, ['speech']); assert.deepEqual(provider.models, [model]);
    assert.deepEqual(provider.modelsByCapability, { speech: [model] }); assert.deepEqual(provider.speechLanguages, ['en', 'zh-CN']);
    assert.deepEqual(provider.voiceOptions, { speech: { voices: [voice], defaultVoice: voice, instructions: false } });
    assert(!JSON.stringify(provider).includes(configured.ELEVENLABS_API_KEY!));
    assert.equal(voiceCapabilities(provider).speech.available, true);
    assert.equal(voiceCapabilities(provider).realtime.available, false); assert.equal(voiceCapabilities(provider).transcription.available, false);
    const state = voiceOptionState(provider, 'speech');
    assert.equal(state.known, true); assert.equal(state.ready, true); assert.equal(state.instructions, false); assert.equal(state.turnTaking, false);
    assert.deepEqual(voiceSpeechBody(provider, text, 'interviewer'), { provider: 'elevenlabs', text, voice });
    assert.deepEqual(voiceAudioConfiguration(provider, 'interviewer'), { providerId: 'elevenlabs', roleId: 'interviewer', voice, expressionApplied: false });
    assert.throws(() => voiceSpeechBody(provider, text, 'warm', 'fictional-custom-voice'), /当前不可用/);
    assert.deepEqual(modelsForStep(provider, 'speech'), [model]);
    assert.deepEqual(workflowReadiness([{ kind: 'speech', provider: 'elevenlabs', model, prompt: '{{input}}' }], runtime.capabilities()), []);
    await assert.rejects(runtime.createVoiceSession({ provider: 'elevenlabs' }), { code: 'PROVIDER_UNSUPPORTED' });
    await assert.rejects(runtime.transcribe({ name: 'fictional.mp3', mime: 'audio/mpeg', bytes: audio }, { provider: 'elevenlabs' }), { code: 'PROVIDER_UNSUPPORTED' });
    assert.equal(requests.length, 0, 'Catalog readiness and generic controls must never probe an account or call a provider.');
  });
});

test('commercial opt-in and complete explicit configuration are required before speech, jobs or workflow dispatch', async () => {
  await loopback(async ({ runtime: create, requests }) => {
    for (const env of [
      { PLATFORM_ALLOW_PROVIDER_CALLS: undefined }, { PLATFORM_ALLOW_PROVIDER_CALLS: '0', ELEVENLABS_ALLOW_PROVIDER_HISTORY: '1' },
      { ELEVENLABS_API_KEY: undefined }, { ELEVENLABS_TTS_MODEL: undefined }, { ELEVENLABS_TTS_VOICE_ID: undefined },
      { ELEVENLABS_TTS_MODEL: 'fictional-unreviewed-model' }, { ELEVENLABS_TTS_VOICE_ID: '../fictional-voice' },
    ]) {
      const runtime = create(env); assert.equal(runtime.capabilities().find(item => item.id === 'elevenlabs')?.enabled, false);
      await assert.rejects(runtime.speech({ provider: 'elevenlabs', text }), { code: 'PROVIDER_NOT_CONFIGURED' });
      await assert.rejects(runtime.executeJob(speechJob(), context), { code: 'PROVIDER_NOT_CONFIGURED' });
      const input = workflow(), store = workflowStore(input, context);
      await assert.rejects(runtime.executeJob(input, store.context()), { code: 'WORKFLOW_PROVIDER_UNAVAILABLE' });
      assert.deepEqual(store.events, []); assert.deepEqual(store.published, []);
    }
    assert.equal(requests.length, 0);
  });
});

test('speech, job execution and durable workflow recovery deliver the same fixed PVC HTTP request and preserve actual bytes', async () => {
  await loopback(async ({ runtime: create, requests }) => {
    const runtime = create(), provider = runtime.capabilities().find(item => item.id === 'elevenlabs')!;
    const generated = await runtime.speech(voiceSpeechBody(provider, text, 'career'));
    assert.deepEqual(generated, { name: 'speech.mp3', mime: 'audio/mpeg', bytes: audio });
    const job = await runtime.executeJob(speechJob({ voice }), context);
    assert.deepEqual(job.artifacts, [generated]);
    const secondText = 'A second fictional interview narration.';
    const input: CreateJobInput = { kind: 'workflow', provider: 'workflow', prompt: text, options: { steps: [
      { kind: 'speech', provider: 'elevenlabs', model, prompt: '{{input}}', options: { voice } },
      { kind: 'speech', provider: 'elevenlabs', model, prompt: secondText, options: { voice } },
    ] } }, store = workflowStore(input, context), controller = new AbortController();
    await assert.rejects(runtime.executeJob(input, store.context({ signal: controller.signal, onProgress: async () => { controller.abort(); } })), { name: 'AbortError' });
    assert.equal(requests.length, 3); assert.equal(store.published.length, 1);
    assert.equal(store.snapshot().steps[0].state, 'completed'); assert.equal(store.snapshot().steps.length, 1);
    assert.deepEqual(store.published[0], { ...generated, name: 'step-1-speech.mp3' });
    const resumed = await runtime.executeJob(input, store.context());
    assert.deepEqual(resumed, { artifacts: [] }); assert.equal(requests.length, 4); assert.equal(store.published.length, 2);
    assert.deepEqual(store.published[1], { ...generated, name: 'step-2-speech.mp3' });
    assert.deepEqual(store.snapshot().steps.map(step => step.state), ['completed', 'completed']);
    assert.deepEqual(await runtime.executeJob(input, store.context()), { artifacts: [] });
    assert.equal(requests.length, 4, 'Completed checkpoint receipts must prevent duplicate paid requests.');
    assert.equal(store.published.length, 2, 'Recovery must not publish a completed speech artifact twice.');
    for (const [index, request] of requests.entries()) contract(request, index === 3 ? secondText : text);
  });
});

test('expression instructions and client model or voice overrides fail across direct calls, speech jobs and workflow steps before HTTP', async () => {
  await loopback(async ({ runtime: create, requests }) => {
    const runtime = create();
    for (const options of [{ instructions: 'Fictional expression instructions.' }, { voice: 'fictional-custom-voice' }, { speed: 1 }]) {
      await assert.rejects(runtime.speech({ provider: 'elevenlabs', text, ...options } as SpeechInput), invalidInput);
      await assert.rejects(runtime.executeJob(speechJob(options), context), invalidInput);
      const input = workflow(options), store = workflowStore(input, context);
      await assert.rejects(runtime.executeJob(input, store.context()), invalidInput);
      assert.deepEqual(store.snapshot().steps.map(step => step.state), ['failed']); assert.deepEqual(store.published, []);
    }
    await assert.rejects(runtime.speech({ provider: 'elevenlabs', text, model: 'eleven_v3' }), invalidInput);
    await assert.rejects(runtime.executeJob({ ...speechJob(), model: 'eleven_v3' }, context), invalidInput);
    const input = workflow(); (input.options!.steps as { model: string }[])[0].model = 'eleven_v3';
    await assert.rejects(runtime.executeJob(input, workflowStore(input, context).context()), invalidInput);
    assert.equal(requests.length, 0);
  });
});

test('provider history requires an explicit server flag and the default sends strict logging and PVC controls', async () => {
  await loopback(async ({ runtime: create, requests }) => {
    for (const flag of [undefined, '0', '1']) await create({ ELEVENLABS_ALLOW_PROVIDER_HISTORY: flag }).speech({ provider: 'elevenlabs', text });
    assert.equal(requests.length, 3);
    for (const [index, request] of requests.entries()) contract(request, text, index === 2);
  });
});

test('account rejection never changes the reviewed model or PVC behavior and uncertain workflows cannot repeat the request', async () => {
  await loopback(async ({ runtime: create, requests }) => {
    const runtime = create();
    await assert.rejects(runtime.speech({ provider: 'elevenlabs', text }), (error: unknown) => error instanceof ProviderError
      && error.code === 'PROVIDER_REJECTED' && !error.message.includes('fictional-private-account-access'));
    assert.equal(requests.length, 1); contract(requests[0], text);
    const input = workflow(), store = workflowStore(input, context);
    await assert.rejects(runtime.executeJob(input, store.context()), { code: 'WORKFLOW_STEP_UNCERTAIN' });
    assert.deepEqual(store.snapshot().steps.map(step => step.state), ['uncertain']); assert.deepEqual(store.published, []);
    assert.equal(requests.length, 2); contract(requests[1], text);
    await assert.rejects(runtime.executeJob(input, store.context()), { code: 'WORKFLOW_STEP_UNCERTAIN' });
    assert.equal(requests.length, 2, 'An uncertain receipt cannot silently repeat or downgrade the provider request.');
  }, (_request, response) => {
    response.writeHead(422, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'fictional-private-account-access', model, voice }));
  });
});
