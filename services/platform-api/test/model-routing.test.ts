import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderStatus } from '@companion/platform-contracts';
import { readConfig } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';
import { MODEL_ROUTE_PURPOSES, modelRouteAvailability, resolveModelRoute, type ModelRoutePurpose } from '../src/model-routing.ts';

const config = readConfig({
  PLATFORM_CHAT_PROVIDER: 'route-fixture', PLATFORM_AGENT_PROVIDER: 'route-fixture',
  PLATFORM_REALTIME_PROVIDER: 'route-fixture', PLATFORM_TRANSCRIPTION_PROVIDER: 'route-fixture', PLATFORM_SPEECH_PROVIDER: 'route-fixture',
});
function provider(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id: 'route-fixture', name: 'Fictional route catalogue', enabled: true, keyConfigured: true,
    capabilities: [...MODEL_ROUTE_PURPOSES], models: ['flat-model-never-selected'],
    modelsByCapability: Object.fromEntries(MODEL_ROUTE_PURPOSES.map(purpose => [purpose, [`fictional-${purpose}-model`]])),
    voiceOptions: {
      speech: { voices: ['fictional-speech-voice', 'fictional-other-voice'], defaultVoice: 'fictional-speech-voice' },
      realtime: { voices: ['fictional-realtime-voice'], defaultVoice: 'fictional-realtime-voice' },
    },
    envVariables: ['FICTIONAL_PRIVATE_VARIABLE'], reason: 'fictional-private-catalogue-reason',
    ...overrides,
  };
}
function runtime(statuses: ProviderStatus[]) { return { capabilities: () => statuses }; }
function unavailable(run: () => unknown) {
  assert.throws(run, error => {
    assert(error instanceof ApiError);
    assert.equal(error.status, 503); assert.equal(error.code, 'MODEL_ROUTE_UNAVAILABLE');
    assert.equal(error.publicMessage, 'The requested capability is unavailable.');
    assert(!/route-fixture|fictional|PRIVATE|provider|model/i.test(error.publicMessage));
    return true;
  });
}

test('each explicit server purpose resolves only its capability model and actual default voice', () => {
  const selected = runtime([provider()]);
  for (const purpose of MODEL_ROUTE_PURPOSES) {
    assert.deepEqual(resolveModelRoute(config, selected, purpose), {
      purpose, provider: 'route-fixture', model: `fictional-${purpose}-model`,
      ...(purpose === 'speech' || purpose === 'realtime' ? { voice: `fictional-${purpose}-voice` } : {}),
    });
  }
  assert.deepEqual(modelRouteAvailability(config, selected), { chat: true, agent: true, realtime: true, transcription: true, speech: true });
});

test('unbound purposes remain unavailable even with enabled providers and another purpose binding', () => {
  const selected = runtime([provider()]), partial = readConfig({ PLATFORM_CHAT_PROVIDER: 'route-fixture' });
  unavailable(() => resolveModelRoute(readConfig({}), selected, 'chat'));
  for (const purpose of MODEL_ROUTE_PURPOSES.filter(purpose => purpose !== 'chat')) unavailable(() => resolveModelRoute(partial, selected, purpose));
  assert.deepEqual(modelRouteAvailability(partial, selected), { chat: true, agent: false, realtime: false, transcription: false, speech: false });
});

test('unknown, disabled and capability-incompatible bindings never choose a different enabled provider', () => {
  const alternate = provider({ id: 'alternate-fixture' });
  const variants = [[], [provider({ id: 'unknown-fixture' })], [provider({ enabled: false })], [provider({ capabilities: ['speech'] })]];
  for (const statuses of variants) {
    const selected = runtime([...statuses, alternate]);
    unavailable(() => resolveModelRoute(config, selected, 'chat'));
    assert.equal(modelRouteAvailability(config, selected).chat, false);
  }
});

test('ambiguous provider identities and malformed bindings fail without choosing a catalogue entry', () => {
  unavailable(() => resolveModelRoute(config, runtime([provider(), provider()]), 'chat'));
  for (const value of ['', ' route-fixture', 'route-fixture\n', 'x'.repeat(81)]) {
    unavailable(() => resolveModelRoute({ modelRoutes: { chat: { provider: value } } }, runtime([provider()]), 'chat'));
  }
  unavailable(() => resolveModelRoute(config, runtime([provider()]), 'image' as ModelRoutePurpose));
});

test('explicit empty, missing and multiple capability models cannot fall back to flat models', () => {
  for (const modelsByCapability of [{ chat: [] }, {}, { agent: ['fictional-agent-only'] }, { chat: ['fictional-first', 'fictional-second'] }, { chat: ['fictional-same', 'fictional-same'] }]) {
    const selected = runtime([provider({ models: ['fictional-valid-flat'], modelsByCapability })]);
    unavailable(() => resolveModelRoute(config, selected, 'chat'));
    assert.equal(modelRouteAvailability(config, selected).chat, false);
  }
});

test('trusted legacy metadata without any capability map permits only one flat model', () => {
  assert.deepEqual(resolveModelRoute(config, runtime([provider({ modelsByCapability: undefined, models: ['fictional-legacy-model'] })]), 'agent'),
    { purpose: 'agent', provider: 'route-fixture', model: 'fictional-legacy-model' });
  for (const models of [[], ['fictional-one', 'fictional-two']]) unavailable(() => resolveModelRoute(config, runtime([provider({ modelsByCapability: undefined, models })]), 'agent'));
});

test('empty, whitespace, control and oversized model metadata is unavailable without normalization', () => {
  for (const model of ['', '   ', ' fictional-model', 'fictional-model ', 'fictional\nmodel', 'fictional\x7fmodel', 'x'.repeat(151)]) {
    for (const metadata of [{ modelsByCapability: { chat: [model] } }, { modelsByCapability: undefined, models: [model] }]) {
      unavailable(() => resolveModelRoute(config, runtime([provider(metadata)]), 'chat'));
    }
  }
  assert.equal(resolveModelRoute(config, runtime([provider({ modelsByCapability: { chat: ['m'.repeat(150)] } })]), 'chat').model.length, 150);
});

test('speech and realtime require their own advertised valid default voice', () => {
  for (const purpose of ['speech', 'realtime'] as const) {
    const other = purpose === 'speech' ? 'realtime' : 'speech';
    for (const options of [undefined, { voices: [], defaultVoice: 'fictional-voice' }, { voices: ['fictional-voice'], defaultVoice: 'fictional-absent' },
      { voices: ['fictional-voice'], defaultVoice: '' }, { voices: [' fictional-voice'], defaultVoice: ' fictional-voice' },
      { voices: ['fictional\nvoice'], defaultVoice: 'fictional\nvoice' }, { voices: ['x'.repeat(101)], defaultVoice: 'x'.repeat(101) },
      { voices: ['fictional-voice', ''], defaultVoice: 'fictional-voice' }]) {
      const selected = runtime([provider({ voiceOptions: { [other]: { voices: ['fictional-other'], defaultVoice: 'fictional-other' }, ...(options ? { [purpose]: options } : {}) } })]);
      unavailable(() => resolveModelRoute(config, selected, purpose));
      assert.equal(modelRouteAvailability(config, selected)[purpose], false);
      assert.equal(modelRouteAvailability(config, selected)[other], true);
    }
  }
});

test('text and transcription routing make no voice or separate API-key assumption', () => {
  const selected = runtime([provider({ voiceOptions: undefined, keyConfigured: false })]);
  for (const purpose of ['chat', 'agent', 'transcription'] as const) assert.equal(resolveModelRoute(config, selected, purpose).model, `fictional-${purpose}-model`);
  assert.deepEqual(modelRouteAvailability(config, selected), { chat: true, agent: true, realtime: false, transcription: true, speech: false });
});

test('provider disabled state cannot be enabled by route, workbench or details configuration', () => {
  const diagnostics = { ...config, ...readConfig({ NODE_ENV: 'development', PLATFORM_ENABLE_WORKBENCH: '1', PLATFORM_EXPOSE_PROVIDER_DETAILS: '1' }), modelRoutes: config.modelRoutes };
  const selected = runtime([provider({ enabled: false })]);
  for (const purpose of MODEL_ROUTE_PURPOSES) unavailable(() => resolveModelRoute(diagnostics, selected, purpose));
  assert.deepEqual(modelRouteAvailability(diagnostics, selected), { chat: false, agent: false, realtime: false, transcription: false, speech: false });
});

test('availability takes one catalogue snapshot and agrees with resolution without generation or voice calls', () => {
  let reads = 0, calls = 0;
  const forbidden = () => { calls++; throw new Error('No execution is permitted in this pure fixture.'); };
  const selected = { capabilities() { reads++; return [provider()]; }, streamChat: forbidden, executeJob: forbidden,
    createVoiceSession: forbidden, transcribe: forbidden, speech: forbidden };
  assert.deepEqual(modelRouteAvailability(config, selected), { chat: true, agent: true, realtime: true, transcription: true, speech: true });
  assert.equal(reads, 1); assert.equal(calls, 0);
  for (const purpose of MODEL_ROUTE_PURPOSES) resolveModelRoute(config, selected, purpose);
  assert.equal(reads, 6); assert.equal(calls, 0);
});

test('catalogue failures stay neutral, do not fall back and produce unavailable booleans', () => {
  const selected = { capabilities(): ProviderStatus[] { throw new Error('fictional-private-provider-configuration'); } };
  unavailable(() => resolveModelRoute(config, selected, 'chat'));
  assert.deepEqual(modelRouteAvailability(config, selected), { chat: false, agent: false, realtime: false, transcription: false, speech: false });
});

test('routing returns independent values without modifying runtime metadata or configuration', () => {
  const status = provider(), before = JSON.stringify({ config, status }), selected = runtime([status]);
  const first = resolveModelRoute(config, selected, 'speech');
  first.provider = 'changed-local-result'; first.model = 'changed-local-result'; first.voice = 'changed-local-result';
  assert.deepEqual(resolveModelRoute(config, selected, 'speech'), { purpose: 'speech', provider: 'route-fixture', model: 'fictional-speech-model', voice: 'fictional-speech-voice' });
  modelRouteAvailability(config, selected);
  assert.equal(JSON.stringify({ config, status }), before);
});
