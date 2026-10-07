import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'node:http';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { VoiceAudioLabel, VoicePersonalityPicker, VoiceSoundPicker, VoiceTurnTakingPicker } from '../src/VoicePersonalityControls.ts';
import { VOICE_PERSONALITIES, copyVoicePreferences, defaultVoicePreferences, retainedVoice, voiceAudioConfiguration, voiceOptionState, voicePersona, voicePersonality, voiceRealtimeBody, voiceSelectionProblem, voiceSpeechBody, type VoicePreferences } from '../src/voice-personality.ts';
import { VoiceConversationSession, type VoiceConversationTransport } from '../src/voice-conversation.ts';
import { VoiceDraftStore } from '../src/voice-draft.ts';
import { disposeVoiceSession, requestVoiceSession } from '../src/voice-session.ts';
import { excerptInput } from '../src/voice-history.ts';
import type { Provider } from '../src/types.ts';

const provider: Provider = { id: 'fictional-voice', name: 'Fictional voice', keyConfigured: true, enabled: true, capabilities: ['speech', 'realtime'], models: [], envVariables: [], voiceOptions: { speech: { voices: ['coral', 'sage'], defaultVoice: 'coral', instructions: true }, realtime: { voices: ['marin', 'cedar'], defaultVoice: 'marin', instructions: true, turnTaking: true } } };
const kokoro: Provider = { id: 'kokoro', name: 'Fictional local speech', keyConfigured: true, enabled: true, capabilities: ['speech'], models: ['kokoro-82m'], envVariables: [], voiceOptions: { speech: { voices: ['af_heart'], defaultVoice: 'af_heart', instructions: false } } };
const chat: Provider = { id: 'ollama', name: 'Fictional text', keyConfigured: true, enabled: true, capabilities: ['chat'], models: ['fixture-model'], envVariables: [] };
const conversationId = '56e12235-7f30-4a0e-acce-45527a42c9cd', messageId = '0efb31eb-bb8b-43c3-af79-b8c70a620e05', audioId = '598f7b05-43d8-424d-a55d-6d579677c6d1';
const accountId = '799c7d39-2d4d-4c43-8004-71872d3a021a';
const audio = { id: audioId, name: 'fictional-speech.wav', mime: 'audio/wav', url: `/api/platform/uploads/${audioId}` };
const turnInput = () => ({ text: 'Fictional practice question.', roleId: 'warm' as const, provider: chat, model: 'fixture-model', ensureConversation: async () => conversationId });
const transport = (): VoiceConversationTransport => ({ async streamMessage(_, __, ___, receive) { receive({ event: 'start', data: { messageId } }); receive({ event: 'done', data: { message: { id: messageId, conversationId, role: 'assistant', status: 'complete', content: 'Fictional complete reply.' } } }); }, async request() { return { attachment: audio }; } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function elements(value: unknown): ReactElement<Record<string, any>>[] { if (Array.isArray(value)) return value.flatMap(elements); if (!value || typeof value !== 'object' || !('props' in value)) return []; const element = value as ReactElement<Record<string, any>>; return [element, ...elements(element.props.children)]; }

test('three distinct roles default to gentle practice and produce bounded short spoken instructions without free prompt input', () => {
  assert.deepEqual(VOICE_PERSONALITIES.map((entry) => entry.label), ['温柔陪练', '轻松职业搭子', '清晰面试官']);
  assert.equal(defaultVoicePreferences().roleId, 'warm'); assert.equal(defaultVoicePreferences().turnTaking, 'patient');
  for (const role of VOICE_PERSONALITIES) { assert.match(voicePersona(role.id), /one to three sentences/); assert.match(voicePersona(role.id), /language the user/); assert.ok(voicePersona(role.id).length < 2000); assert.ok(role.expression.length < 2000); }
  assert.equal(new Set(VOICE_PERSONALITIES.map((role) => voicePersona(role.id))).size, 3); assert.equal(voicePersonality('unknown').id, 'warm');
});

test('unknown metadata and unadvertised capabilities send neither invented voices nor expression or turn-taking controls', () => {
  for (const unknown of [{ ...provider, voiceOptions: undefined }, { ...provider, capabilities: [] }]) {
    assert.deepEqual(voiceSpeechBody(unknown, 'Fictional text.', 'career', 'invented'), { provider: provider.id, text: 'Fictional text.' });
    assert.deepEqual(voiceRealtimeBody(unknown, { ...defaultVoicePreferences(), realtimeVoices: { [provider.id]: 'invented' }, turnTaking: 'quick' }), { provider: provider.id });
  }
  const invalid = { ...provider, voiceOptions: { speech: { voices: 'not-an-array', defaultVoice: 'coral', instructions: true } } } as unknown as Provider;
  assert.equal(voiceOptionState(invalid, 'speech').known, false);
});

test('fixed local af_heart is real metadata and never receives fabricated emotion instructions', () => {
  const body = voiceSpeechBody(kokoro, 'Fictional English text.', 'career');
  assert.deepEqual(body, { provider: 'kokoro', text: 'Fictional English text.', voice: 'af_heart' });
  assert.equal(voiceAudioConfiguration(kokoro, 'career').expressionApplied, false);
  assert.equal(voiceOptionState(kokoro, 'realtime').known, false);
  const html = renderToStaticMarkup(createElement(VoiceSoundPicker, { provider: kokoro, capability: 'speech', value: '', disabled: false, onChange() {} }));
  assert.match(html, /af_heart · 固定声线/); assert.match(html, /未声明朗读表达控制/); assert.equal(html.includes('<select'), false);
  const stamp = renderToStaticMarkup(createElement(VoiceAudioLabel, { configuration: voiceAudioConfiguration(kokoro, 'career') }));
  assert.match(stamp, /服务默认表达/); assert.equal(stamp.includes('职业搭子表达'), false);
});

test('actual advertised selections map independently into speech and realtime requests', () => {
  assert.deepEqual(voiceSpeechBody(provider, 'Fictional text.', 'interviewer', 'sage'), { provider: provider.id, text: 'Fictional text.', voice: 'sage', instructions: voicePersonality('interviewer').expression });
  const preferences: VoicePreferences = { ...defaultVoicePreferences(), roleId: 'career', realtimeVoices: { [provider.id]: 'cedar' }, turnTaking: 'quick' };
  assert.deepEqual(voiceRealtimeBody(provider, preferences), { provider: provider.id, voice: 'cedar', persona: voicePersona('career'), turnTaking: 'quick' });
  const unsupported = { ...provider, voiceOptions: { ...provider.voiceOptions, realtime: { voices: ['marin'], defaultVoice: 'marin', instructions: false, turnTaking: false } } };
  assert.deepEqual(voiceRealtimeBody(unsupported, defaultVoicePreferences()), { provider: provider.id, voice: 'marin' });
  const disabled = { ...provider, enabled: false };
  assert.deepEqual(voiceSpeechBody(disabled, 'Fictional text.', 'warm', 'sage'), { provider: provider.id, text: 'Fictional text.' });
  assert.deepEqual(voiceRealtimeBody(disabled, preferences), { provider: provider.id });
  assert.equal(disabled.enabled, false);
});

test('retired choices stay visible and must be corrected rather than silently selecting another voice', () => {
  assert.equal(voiceOptionState(provider, 'speech', 'retired').value, 'retired');
  assert.match(voiceSelectionProblem(provider, 'speech', 'retired'), /当前不可用/);
  assert.throws(() => voiceSpeechBody(provider, 'Fictional.', 'warm', 'retired'), /当前不可用/);
  const html = renderToStaticMarkup(createElement(VoiceSoundPicker, { provider, capability: 'speech', value: 'retired', disabled: false, onChange() {} }));
  assert.match(html, /retired · 当前不可用/); assert.match(html, /请重新选择/);
});

test('the real role and sound controls render independently and locked callbacks do not change current session settings', () => {
  const selected: string[] = [];
  const picker = VoicePersonalityPicker({ value: 'warm', disabled: false, onChange: (id) => selected.push(id) });
  const html = renderToStaticMarkup(picker); assert.match(html, /aria-pressed="true"/); assert.match(html, /清晰面试官/); assert.equal(html.includes('<textarea'), false);
  const role = elements(picker).find((element) => element.type === 'button' && element.props.children[0].props.children === '轻松职业搭子')!;
  role.props.onClick(); assert.deepEqual(selected, ['career']);
  for (const button of elements(VoicePersonalityPicker({ value: 'warm', disabled: true, onChange: (id) => selected.push(id) })).filter((element) => element.type === 'button')) button.props.onClick();
  assert.deepEqual(selected, ['career']);
  const sound = VoiceSoundPicker({ provider, capability: 'speech', value: 'sage', disabled: true, onChange: (voice) => selected.push(voice) });
  assert.match(renderToStaticMarkup(sound), /aria-label="朗读声线"[^>]*disabled=""/);
  elements(sound).find((element) => element.type === 'select')!.props.onChange({ target: { value: 'coral' } }); assert.deepEqual(selected, ['career']);
  const available = VoiceSoundPicker({ provider, capability: 'speech', value: '', disabled: false, onChange: (voice) => selected.push(voice) });
  const select = elements(available).find((element) => element.type === 'select')!;
  select.props.onChange({ target: { value: 'invented' } }); select.props.onChange({ target: { value: 'sage' } }); assert.deepEqual(selected, ['career', 'sage']);
  assert.equal(VoiceTurnTakingPicker({ provider: kokoro, value: 'patient', disabled: false, onChange() {} }), null);
  const realtime = renderToStaticMarkup(createElement(VoiceTurnTakingPicker, { provider, value: 'patient', disabled: true, onChange() {} }));
  assert.match(realtime, /实时接话节奏/); assert.match(realtime, /多等一会儿/); assert.match(realtime, /disabled=""/);
});

test('preferences and completed audio configuration survive navigation while credential-like extra fields are projected out', () => {
  const store = new VoiceDraftStore(); store.changeSession({ accountId: 'fictional-a', generation: 1 }); const draft = store.open(conversationId), editor = draft.edit();
  const audioConfiguration = voiceAudioConfiguration(provider, 'warm', 'sage');
  editor.update((value) => ({ ...value, speechProviderId: provider.id, transcriptionProviderId: 'faster-whisper', chatProviderId: 'ollama', chatModel: 'fictional-model', voicePreferences: { roleId: 'career', speechVoices: { [provider.id]: 'sage' }, realtimeVoices: { [provider.id]: 'cedar' }, turnTaking: 'quick', vendorSecret: 'fictional-not-to-retain' } as VoicePreferences,
    speechSnapshot: { audio, input: excerptInput('speech_excerpt', 'Fictional text.', [audio.id]), audioConfiguration: { ...audioConfiguration, rawEvent: { type: 'fictional' } } as typeof audioConfiguration },
    turns: [{ key: 'fictional-turn', itemId: 'fictional-item', contentIndex: 0, revision: 0, role: 'assistant', status: 'complete', text: 'Fictional complete excerpt.', inputs: [], voiceRoleId: 'interviewer' }] }));
  editor.close(); const restored = store.open(conversationId).getSnapshot();
  assert.equal(restored.voicePreferences.roleId, 'career'); assert.equal(restored.chatModel, 'fictional-model'); assert.equal(restored.speechProviderId, provider.id);
  assert.equal(restored.voicePreferences.realtimeVoices[provider.id], 'cedar'); assert.equal(restored.voicePreferences.turnTaking, 'quick');
  assert.deepEqual(restored.speechSnapshot!.audioConfiguration, audioConfiguration); assert.equal(restored.turns[0].voiceRoleId, 'interviewer');
  const json = JSON.stringify(restored); assert.equal(json.includes('vendorSecret'), false); assert.equal(json.includes('rawEvent'), false);
  const next = draft.edit(); next.update((value) => ({ ...value, voicePreferences: { ...value.voicePreferences, roleId: 'interviewer' } }));
  assert.equal(draft.getSnapshot().speechSnapshot!.audioConfiguration!.roleId, 'warm');
  assert.equal(editor.update((value) => ({ ...value, voicePreferences: defaultVoicePreferences() })), false);
  store.changeSession({ accountId: 'fictional-a', generation: 2 }); assert.equal(draft.isCurrent(), false);
  assert.equal(store.open(conversationId).getSnapshot().voicePreferences.roleId, 'warm');
  assert.equal(store.open(conversationId).getSnapshot().voicePreferences.speechVoices[provider.id], undefined);
});

test('preference projection is bounded, copied and does not accept unknown roles, pacing or inherited voice keys', () => {
  const source = { ...defaultVoicePreferences(), speechVoices: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`fictional-${i}`, `voice-${i}`])) };
  const copied = copyVoicePreferences(source); assert.equal(Object.keys(copied.speechVoices).length, 32); source.speechVoices['fictional-0'] = 'changed'; assert.equal(copied.speechVoices['fictional-0'], 'voice-0');
  assert.equal(retainedVoice(defaultVoicePreferences(), 'speech', 'toString'), '');
  const unknown = copyVoicePreferences({ roleId: 'unknown', turnTaking: 'unknown', speechVoices: { fixture: 'bad\nvoice' } } as unknown as VoicePreferences);
  assert.equal(unknown.roleId, 'warm'); assert.equal(unknown.turnTaking, 'patient'); assert.deepEqual(unknown.speechVoices, {});
});

test('legacy role/model/voice values stay out of server-routed requests and cannot stamp audio attribution', async () => {
  const value = new VoiceConversationSession(); value.activate(() => true); const binding = deferred<string>();
  let body: any; const mutable = { ...turnInput(), available: true, roleId: 'warm' as 'warm' | 'career', ensureConversation: () => binding.promise };
  const answer = value.answer(mutable, { ...transport(), async streamMessage(id, input, signal, receive) { body = input; await transport().streamMessage(id, input, signal, receive); } });
  mutable.roleId = 'career'; binding.resolve(conversationId); await answer;
  assert.deepEqual(Object.keys(body).sort(), ['attachmentIds', 'content']); assert.equal(value.getSnapshot().roleId, null);
  let speechBody: any; const release = deferred<unknown>();
  const speaking = value.speak({ ...transport(), async request(_, init) { speechBody = JSON.parse(String(init.body)); return release.promise; } }, true);
  assert.deepEqual(speechBody, { text: value.getSnapshot().answer });
  release.resolve({ attachment: audio }); await speaking; assert.equal(value.getSnapshot().audioConfiguration, null);
  const before = structuredClone(value.getSnapshot()); await value.speak({ ...transport(), async request() { throw new Error('Fictional speech failed.'); } }, true);
  assert.deepEqual(value.getSnapshot().audio, before.audio); assert.deepEqual(value.getSnapshot().audioConfiguration, before.audioConfiguration); assert.equal(value.getSnapshot().answer, before.answer);
});

test('creation request cancellation propagates to actual loopback HTTP without microphone or provider execution', async () => {
  const started = deferred<void>(), closed = deferred<void>(); let requestBody: any;
  const server = createServer(async (incoming, response) => { assert.equal(incoming.headers[PLATFORM_ACCOUNT_HEADER], accountId); let body = ''; for await (const bytes of incoming) body += bytes.toString(); requestBody = JSON.parse(body); response.once('close', () => closed.resolve()); started.resolve(); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const context = new AccountRequestContext(); context.changeSession(accountId);
    const client = createPlatformClient(createPlatformEndpoints(`http://127.0.0.1:${address.port}`), undefined, context);
    const controller = new AbortController(), preferences = defaultVoicePreferences();
    const pending = requestVoiceSession({}, controller.signal, () => true, client.request, () => assert.fail('No acknowledged lease to release.'));
    await started.promise; assert.deepEqual(requestBody, {});
    disposeVoiceSession({ controllers: [controller] }); await assert.rejects(pending, { name: 'AbortError' });
    await Promise.race([closed.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Fixture socket stayed open.')), 2000))]);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});

test('a transport ignoring cancellation releases its late lease without returning credentials or touching a later session', async () => {
  for (const cancel of [true, false]) {
    const response = deferred<unknown>(), controller = new AbortController(); let current = true; const released: string[] = [];
    const pending = requestVoiceSession({}, controller.signal, () => current, (_, init) => { assert.equal(init.signal, controller.signal); return response.promise; }, (id) => released.push(id));
    if (cancel) controller.abort(); else current = false;
    response.resolve({ sessionId: 'fictional-late-lease', clientSecret: 'fictional-ephemeral-value' });
    assert.equal(await pending, null); assert.deepEqual(released, ['fictional-late-lease']);
  }
});

test('a pre-aborted or stale creation never dispatches a request', async () => {
  let calls = 0; const read = async () => { calls++; return {}; }, aborted = new AbortController(); aborted.abort();
  await assert.rejects(requestVoiceSession({}, aborted.signal, () => true, read, () => {}), { name: 'AbortError' });
  assert.equal(await requestVoiceSession({}, new AbortController().signal, () => false, read, () => {}), null); assert.equal(calls, 0);
});


test('active realtime creation rejects legacy selector bodies before HTTP while accepting only optional conversation context', async () => {
  let calls = 0; const read = async () => { ++calls; return {}; };
  for (const key of ['provider', 'model', 'voice', 'persona', 'instructions', 'turnTaking']) {
    await assert.rejects(requestVoiceSession({ conversationId, [key]: 'fictional-old-value' } as any, new AbortController().signal, () => true, read, () => {}));
  }
  assert.equal(calls, 0);
});
