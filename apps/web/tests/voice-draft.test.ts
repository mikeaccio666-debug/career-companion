import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountOperationScope } from '../src/account-operations.ts';
import { MAX_VOICE_DRAFTS, openVoiceDraft, VoiceDraftLimitError, VoiceDraftStore, StaleVoiceDraft, voiceDepartureNotice } from '../src/voice-draft.ts';
import { excerptInput, quotedVoiceText, RealtimeTranscriptBuffer } from '../src/voice-history.ts';

function context() {
  const account = new AccountOperationScope(), store = new VoiceDraftStore();
  const authenticate = (id: string | null) => { account.changeSession(id); store.changeSession(account.snapshot()); };
  authenticate('fictional-a');
  return { account, store, authenticate };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
function completeTurns() {
  const buffer = new RealtimeTranscriptBuffer('17e8fb18-39ec-4e0a-8a82-7452c6ae4b90');
  buffer.receive({ type: 'response.output_audio_transcript.delta', item_id: 'partial', delta: 'Must not be retained.' });
  buffer.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'question', transcript: 'Fictional practice question.' });
  buffer.receive({ type: 'response.output_audio_transcript.done', item_id: 'answer', transcript: 'Fictional practice answer.' });
  return buffer.turns();
}

test('leaving and returning keeps edited text and all complete turns, including turns not brought to chat', () => {
  const { store } = context(), draft = store.open('conversation-a'), editor = draft.edit();
  const turns = completeTurns();
  editor.update((value) => ({ ...value, text: 'Fictional edited transcript.', hasTranscription: true, turns }));
  const sent = quotedVoiceText('realtime_transcript', turns[0].text, turns[0].role);
  assert.match(sent, /未经服务端核验/); editor.close();
  const restored = store.open('conversation-a');
  assert.equal(restored, draft); assert.equal(restored.getSnapshot().text, 'Fictional edited transcript.');
  assert.deepEqual(restored.getSnapshot().turns, turns);
  assert.equal(restored.getSnapshot().turns.some((turn) => turn.itemId === 'partial'), false);
});

test('restored transcript, realtime turns and speech snapshot retain exact UUIDs and private audio reference', () => {
  const { store } = context(), draft = store.open('conversation-a'), editor = draft.edit();
  const speech = excerptInput('speech_excerpt', 'Fictional spoken text.', ['private-audio-id']);
  editor.update((value) => ({ ...value, text: 'Fictional transcript.', turns: completeTurns(), speechSnapshot: { input: speech, audio: { id: 'private-audio-id', name: 'speech.mp3', mime: 'audio/mpeg', url: '/api/platform/uploads/private-audio-id' } } }));
  const input = editor.transcript();
  editor.update((value) => ({ ...value, savedClientIds: [value.turns[0].inputs[0].clientRecordId] }));
  const before = structuredClone(draft.getSnapshot()); editor.close();
  const restored = store.open('conversation-a'), next = restored.edit();
  assert.deepEqual(next.transcript(), input); assert.deepEqual(restored.getSnapshot().turns, before.turns);
  assert.deepEqual(restored.getSnapshot().savedClientIds, before.savedClientIds);
  next.update((value) => ({ ...value, text: 'Fictional edited after speaking.' }));
  assert.deepEqual(restored.getSnapshot().speechSnapshot, before.speechSnapshot);
  assert.notEqual(next.transcript().clientRecordId, input.clientRecordId);
});

test('conversation and unbound drafts are separate, and a delayed old mount cannot write after selecting another conversation', async () => {
  const { store } = context(), old = store.open('conversation-a'), editor = old.edit(), reply = deferred<string>();
  editor.update((value) => ({ ...value, text: 'Fictional A.' }));
  const completion = reply.promise.then((text) => editor.update((value) => ({ ...value, text })));
  editor.close();
  const selected = store.open('conversation-b'); selected.edit().update((value) => ({ ...value, text: 'Fictional B.' }));
  const unbound = store.open(null); unbound.edit().update((value) => ({ ...value, text: 'Fictional unbound.' }));
  reply.resolve('Must not replace A or B.'); assert.equal(await completion, false);
  assert.equal(old.getSnapshot().text, 'Fictional A.'); assert.equal(selected.getSnapshot().text, 'Fictional B.');
  assert.equal(unbound.getSnapshot().text, 'Fictional unbound.');
});

test('a delayed completion from a closed mount stays rejected when the very same draft is immediately restored', async () => {
  const { store } = context(), draft = store.open('conversation-a'), old = draft.edit(), reply = deferred<string>();
  const completion = reply.promise.then((text) => old.update((value) => ({ ...value, text })));
  old.close(); const current = draft.edit(); current.update((value) => ({ ...value, text: 'Fictional restored edit.' }));
  reply.resolve('Fictional stale transcription.'); assert.equal(await completion, false);
  assert.equal(draft.getSnapshot().text, 'Fictional restored edit.');
});

test('logout, account switch and same-account authentication generation change clear snapshots and reject late completions', async () => {
  for (const nextAccount of ['fictional-b', 'fictional-a']) {
    const { store, authenticate } = context(), old = store.open('conversation-a'), editor = old.edit(), reply = deferred<string>();
    editor.update((value) => ({ ...value, text: 'Fictional private A.', turns: completeTurns() }));
    const completion = reply.promise.then((text) => editor.update((value) => ({ ...value, text })));
    authenticate(null); assert.equal(old.getSnapshot().text, ''); assert.deepEqual(old.getSnapshot().turns, []);
    assert.throws(() => store.open('conversation-a'), StaleVoiceDraft);
    authenticate(nextAccount); const current = store.open('conversation-a');
    current.edit().update((value) => ({ ...value, text: 'Fictional new login.' }));
    reply.resolve('Must not restore a previous login.'); assert.equal(await completion, false);
    assert.equal(current.getSnapshot().text, 'Fictional new login.'); assert.notEqual(current.id, old.id);
  }
});

test('first save shares one pending conversation creation and binds the original draft without changing UUIDs', async () => {
  const { store } = context(), draft = store.open(null), editor = draft.edit(), reply = deferred<string>();
  editor.update((value) => ({ ...value, text: 'Fictional unbound transcript.', turns: completeTurns() }));
  const input = editor.transcript(), before = structuredClone(draft.getSnapshot()); let creations = 0;
  const create = () => { ++creations; return reply.promise; };
  const first = draft.ensureConversation(create), second = draft.ensureConversation(create);
  reply.resolve('fictional-created-conversation');
  assert.equal(await first, 'fictional-created-conversation'); assert.equal(await second, 'fictional-created-conversation'); assert.equal(creations, 1);
  assert.equal(store.open('fictional-created-conversation'), draft); assert.deepEqual(draft.getSnapshot(), before);
  assert.deepEqual(draft.edit().transcript(), input); assert.notEqual(store.open(null).id, draft.id);
  assert.equal(await draft.ensureConversation(create), 'fictional-created-conversation'); assert.equal(creations, 1);
});

test('a delayed conversation creation cannot bind or restore a draft into a later authentication generation', async () => {
  const { store, authenticate } = context(), old = store.open(null), reply = deferred<string>();
  const creation = old.ensureConversation(() => reply.promise); authenticate('fictional-b');
  reply.resolve('fictional-old-created-conversation'); await assert.rejects(creation, StaleVoiceDraft);
  assert.equal(store.open('fictional-old-created-conversation').getSnapshot().text, '');
  assert.equal(old.isCurrent(), false);
});

test('deleting a conversation invalidates its held editors and prevents a late save marking a recreated draft', () => {
  const { store } = context(), old = store.open('conversation-a'), editor = old.edit();
  editor.update((value) => ({ ...value, text: 'Fictional deleted.' })); store.delete('conversation-a');
  assert.equal(editor.update((value) => ({ ...value, text: 'Fictional late result.' })), false);
  assert.equal(old.update((value) => ({ ...value, savedClientIds: ['late-saved-id'] })), false);
  assert.equal(store.open('conversation-a').getSnapshot().text, '');
});

test('draft projection discards vendor events, credentials, connections and raw audio, including nested extra fields', () => {
  const { store } = context(), draft = store.open(null), input = excerptInput('speech_excerpt', 'Fictional text.', ['private-audio-id']);
  draft.update((value) => ({ ...value, text: 'Fictional text.', clientSecret: 'never-retain', rawEvent: { type: 'vendor.event' }, recordingBlob: new Blob(['fictional bytes']), connection: {}, speechSnapshot: { input: { ...input, clientSecret: 'nested-secret' }, audio: { id: 'private-audio-id', name: 'speech.mp3', mime: 'audio/mpeg', url: '/api/platform/uploads/private-audio-id', rawEvent: {} } } }));
  const saved = JSON.stringify(draft.getSnapshot());
  for (const key of ['clientSecret', 'rawEvent', 'recordingBlob', 'connection', 'nested-secret']) assert.equal(saved.includes(key), false);
  assert.deepEqual(draft.getSnapshot().speechSnapshot!.input.attachmentIds, ['private-audio-id']);
});

test('departure notice distinguishes untranscribed audio and unfinished requests from retained complete text', () => {
  const idle = { recording: false, transcribing: false, speaking: false, recognizing: false, realtime: false };
  assert.equal(voiceDepartureNotice(idle), '');
  assert.match(voiceDepartureNotice({ ...idle, recording: true }), /尚未转写的音频没有保留/);
  assert.match(voiceDepartureNotice({ ...idle, transcribing: true }), /尚未收到的转写结果没有保留/);
  assert.match(voiceDepartureNotice({ ...idle, speaking: true }), /尚未收到的音频结果没有保留/);
  assert.match(voiceDepartureNotice({ ...idle, realtime: true }), /实时连接已结束.*完整转写草稿仍可继续/);
});

test('a full store preserves every unsaved draft and returns a recoverable view error instead of throwing during render', () => {
  const { store } = context();
  const drafts = Array.from({ length: MAX_VOICE_DRAFTS }, (_, index) => {
    const draft = store.open(`conversation-${index}`); draft.edit().update((value) => ({ ...value, text: `Fictional unsaved ${index}.` })); return draft;
  });
  assert.deepEqual(openVoiceDraft(store, 'extra-conversation', false), { draft: null, error: '' });
  let result!: ReturnType<typeof openVoiceDraft>;
  assert.doesNotThrow(() => { result = openVoiceDraft(store, 'extra-conversation', true); });
  assert.equal(result.draft, null); assert.match(result.error, /32 份上限/);
  drafts.forEach((draft, index) => { assert.equal(draft.isCurrent(), true); assert.equal(draft.getSnapshot().text, `Fictional unsaved ${index}.`); });
  drafts[0].edit().update((value) => ({ ...value, text: '' }));
  const retry = openVoiceDraft(store, 'extra-conversation', true); assert.equal(retry.error, ''); assert.ok(retry.draft);
  assert.equal(drafts[0].isCurrent(), false); assert.equal(drafts[1].getSnapshot().text, 'Fictional unsaved 1.');
});

test('only empty or completely explicitly saved drafts can make room; edited text and unsaved audio are retained', () => {
  const { store } = context(), saved = store.open('saved-conversation'), editor = saved.edit();
  editor.update((value) => ({ ...value, text: 'Fictional saved text.', turns: completeTurns() }));
  const input = editor.transcript();
  editor.update((value) => ({ ...value, savedClientIds: [input.clientRecordId, ...value.turns.flatMap((turn) => turn.inputs.map((entry) => entry.clientRecordId))] }));
  for (let index = 1; index < MAX_VOICE_DRAFTS; ++index) store.open(`unsaved-${index}`).edit().update((value) => ({ ...value, text: `Fictional unsaved ${index}.` }));
  assert.ok(openVoiceDraft(store, 'new-conversation', true).draft); assert.equal(saved.isCurrent(), false);
});

test('oversized text, speech and realtime content fail without changing the existing bounded snapshot', () => {
  const { store } = context(), draft = store.open(null), editor = draft.edit(); editor.update((value) => ({ ...value, text: 'Fictional prior text.' }));
  const before = draft.getSnapshot(), turns = completeTurns();
  const candidates = [
    (value: typeof before) => ({ ...value, text: 'x'.repeat(8001) }),
    (value: typeof before) => ({ ...value, turns: [{ ...turns[0], text: 'x'.repeat(1024 * 1024 + 1) }] }),
    (value: typeof before) => ({ ...value, turns: [{ ...turns[0], inputs: Array.from({ length: 501 }, () => turns[0].inputs[0]) }] }),
    (value: typeof before) => ({ ...value, speechSnapshot: { audio: { id: 'audio-id', url: '/api/platform/uploads/audio-id', name: 'speech.mp3', mime: 'audio/mpeg' }, input: excerptInput('speech_excerpt', 'x'.repeat(4001), ['audio-id']) } }),
  ];
  for (const candidate of candidates) { assert.throws(() => editor.update(candidate), VoiceDraftLimitError); assert.equal(draft.getSnapshot(), before); }
});
