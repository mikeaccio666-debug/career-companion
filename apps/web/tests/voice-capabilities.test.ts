import assert from 'node:assert/strict';
import test from 'node:test';
import type { Provider } from '../src/types.ts';
import { selectedVoiceProvider, voiceCapabilities, voiceControls, voiceSpeechInformation } from '../src/voice-capabilities.ts';

const idle = { recording: false, recognizing: false, transcribing: false, speaking: false, live: false };
const browser = { canRecord: true, canRecognize: true };
function provider(overrides: Partial<Provider> = {}): Provider {
  return { id: 'fictional-voice', name: 'Fictional voice', enabled: true, keyConfigured: true, capabilities: ['speech', 'transcription', 'realtime'], models: [], envVariables: [], ...overrides };
}

test('audio import works without microphone support only for the selected available transcription provider', () => {
  const capabilities = voiceCapabilities(provider({ capabilities: ['transcription'] }));
  const noMicrophone = { canRecord: false, canRecognize: false };
  assert.equal(voiceControls(capabilities, idle, noMicrophone, '').importDisabled, false);
  assert.equal(voiceControls(capabilities, idle, noMicrophone, '').recordingDisabled, true);
  for (const active of ['recording', 'recognizing', 'transcribing', 'speaking', 'live'] as const) assert.equal(voiceControls(capabilities, { ...idle, [active]: true }, noMicrophone, '').importDisabled, true);
  assert.equal(voiceControls(voiceCapabilities(provider({ capabilities: ['speech'] })), idle, noMicrophone, '').importDisabled, true);
  assert.equal(voiceControls(voiceCapabilities(provider({ enabled: false })), idle, noMicrophone, '').importDisabled, true);
});

test('a configured speech-only catalog provider is selected ahead of unconfigured providers without replacing retained choices', () => {
  const openai = provider({ id: 'openai', enabled: false, keyConfigured: false });
  const kokoro = provider({ id: 'kokoro', capabilities: ['speech'], modelsByCapability: { speech: ['kokoro'] }, speechLanguages: ['en-US'] });
  assert.equal(selectedVoiceProvider([openai, kokoro], ''), 'kokoro');
  const controls = voiceControls(voiceCapabilities(kokoro), idle, browser, 'A fictional English script.');
  assert.equal(controls.speechDisabled, false); assert.equal(controls.recordingDisabled, true); assert.equal(controls.realtimeDisabled, true);
  assert.equal(selectedVoiceProvider([openai, kokoro], 'openai'), 'openai');
  assert.equal(selectedVoiceProvider([openai, kokoro], 'previously-configured'), 'previously-configured');
  assert.equal(selectedVoiceProvider([openai, { ...kokoro, id: 'another-local-service' }], ''), 'another-local-service');
  assert.equal(selectedVoiceProvider([openai], ''), 'openai');
  assert.equal(selectedVoiceProvider([provider({ capabilities: ['chat'] })], ''), '');
});

test('speech language and missing capabilities are described from catalog metadata without provider id assumptions', () => {
  const speechOnly = provider({ id: 'kokoro', capabilities: ['speech'], speechLanguages: ['en-US'] });
  const description = voiceSpeechInformation(speechOnly);
  assert.match(description, /文字朗读支持：.*英语/); assert.match(description, /录音转写或实时对话/); assert.match(description, /另一个已配置/);
  assert.equal(voiceSpeechInformation({ ...speechOnly, id: 'a-future-local-service' }), description);
  const multilingual = voiceSpeechInformation(provider({ speechLanguages: ['en-US', 'zh-CN', 'en-US'] }));
  assert.match(multilingual, /英语/); assert.match(multilingual, /中文/); assert.doesNotMatch(multilingual, /另一个/);
  assert.equal(multilingual.match(/英语/g)?.length, 1);
  assert.doesNotMatch(voiceSpeechInformation({ ...speechOnly, speechLanguages: undefined }), /支持：|英语|多语言/);
  assert.doesNotMatch(voiceSpeechInformation({ ...speechOnly, speechLanguages: ['not a language'] }), /支持：|英语/);
  assert.equal(voiceSpeechInformation(provider({ capabilities: ['transcription'], speechLanguages: ['en-US'] })), '');
});

test('each action follows the selected provider capability rather than another configured voice provider', () => {
  for (const capability of ['speech', 'transcription', 'realtime'] as const) {
    const capabilities = voiceCapabilities(provider({ capabilities: [capability] }));
    const controls = voiceControls(capabilities, idle, browser, 'Fictional script.');
    assert.equal(controls.speechDisabled, capability !== 'speech');
    assert.equal(controls.recordingDisabled, capability !== 'transcription');
    assert.equal(controls.realtimeDisabled, capability !== 'realtime');
    for (const other of ['speech', 'transcription', 'realtime'] as const) {
      if (other !== capability) assert.match(capabilities[other].reason, /不支持/);
    }
  }
});

test('missing, unconfigured, disabled and incomplete provider metadata fail closed with specific reasons', () => {
  const cases = [
    { value: undefined, reason: /请选择/ },
    { value: provider({ keyConfigured: false }), reason: /待配置/ },
    { value: provider({ enabled: false }), reason: /未启用/ },
    { value: provider({ enabled: undefined } as unknown as Partial<Provider>), reason: /未启用/ },
    { value: provider({ keyConfigured: undefined } as unknown as Partial<Provider>), reason: /待配置/ },
    { value: provider({ capabilities: undefined } as unknown as Partial<Provider>), reason: /不支持/ },
  ];
  for (const { value, reason } of cases) {
    const capabilities = voiceCapabilities(value), controls = voiceControls(capabilities, idle, browser, 'Fictional script.');
    assert.equal(controls.speechDisabled, true); assert.equal(controls.recordingDisabled, true); assert.equal(controls.realtimeDisabled, true);
    for (const status of Object.values(capabilities)) { assert.equal(status.available, false); assert.match(status.reason, reason); }
  }
});

test('browser dictation remains independent of provider configuration and respects actual browser support', () => {
  const capabilities = voiceCapabilities(provider({ enabled: false, keyConfigured: false, capabilities: ['chat'] }));
  assert.equal(voiceControls(capabilities, idle, browser, '').recognitionDisabled, false);
  assert.equal(voiceControls(capabilities, idle, { ...browser, canRecognize: false }, '').recognitionDisabled, true);
  assert.equal(voiceControls(capabilities, { ...idle, recording: true }, browser, '').recognitionDisabled, true);
});

test('ending a started recording, realtime session or browser dictation remains available when provider status changes', () => {
  const capabilities = voiceCapabilities(provider({ enabled: false }));
  assert.equal(voiceControls(capabilities, { ...idle, recording: true }, { ...browser, canRecord: false }, '').recordingDisabled, false);
  assert.equal(voiceControls(capabilities, { ...idle, live: true }, browser, '').realtimeDisabled, false);
  assert.equal(voiceControls(capabilities, { ...idle, recognizing: true }, { ...browser, canRecognize: false }, '').recognitionDisabled, false);
});

test('provider selection is held for audio requests while text edits and independent browser dictation remain possible', () => {
  const capabilities = voiceCapabilities(provider());
  for (const pending of ['recording', 'transcribing', 'speaking', 'live'] as const) assert.equal(voiceControls(capabilities, { ...idle, [pending]: true }, browser, 'Fictional script.').providerDisabled, true);
  assert.equal(voiceControls(capabilities, { ...idle, recognizing: true }, browser, '').providerDisabled, false);
  assert.equal(voiceControls(capabilities, idle, browser, '   ').speechDisabled, true);
  assert.equal(voiceControls(capabilities, idle, browser, 'x'.repeat(4001)).speechDisabled, true);
  assert.equal(voiceControls(capabilities, idle, browser, 'Fictional script.').speechDisabled, false);
  assert.equal(voiceControls(capabilities, idle, { ...browser, canRecord: false }, 'Fictional script.').recordingDisabled, true);
  for (const active of ['recording', 'recognizing', 'transcribing', 'live'] as const) assert.equal(voiceControls(capabilities, { ...idle, [active]: true }, browser, 'Fictional script.').speechDisabled, true);
  assert.equal(voiceControls(capabilities, { ...idle, speaking: true }, browser, '').recordingDisabled, true);
});
