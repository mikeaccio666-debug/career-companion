import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeContextBridge, RealtimeVoiceBootstrap, type ContextCreateEvent } from '../src/realtime-context.ts';
import { RealtimeTranscriptBuffer } from '../src/voice-history.ts';
import type { VoiceSession } from '../src/types.ts';

const conversationId = '504515c7-d337-423d-babf-d6b102e8b12a';
const sessionId = '7bd26b86-7308-429f-a0e9-4c940c1c26b2';
const userId = '60708fc4-a499-465e-acd0-f100ebf90c52', assistantId = '35c4d80f-20b5-4bd4-b684-3936aa8a4735';
function session(): VoiceSession { return { sessionId, clientSecret: 'synthetic-session-secret', model: 'synthetic-voice', endpoint: 'https://voice-fixture.invalid/calls', serverContext: { source: 'server_conversation', conversationId, items: [{ messageId: userId, role: 'user', text: 'Fictional source question.' }, { messageId: assistantId, role: 'assistant', text: 'Fictional completed answer.' }], truncated: false } }; }
function receipt(sent: ContextCreateEvent, type = 'conversation.item.done', status = 'completed') { return { type, item: { ...sent.item, status }, previous_item_id: sent.previous_item_id === 'root' ? null : sent.previous_item_id }; }
function fixture(value: VoiceSession = session(), expected: string | undefined = value.serverContext?.conversationId) {
  const bridge = new RealtimeContextBridge(value, expected), tracks = [{ enabled: true }, { enabled: true }], sent: ContextCreateEvent[] = [], notices: string[] = [];
  let current = true, ready = 0, cancelCount = 0, expire!: () => void;
  const gate = new RealtimeVoiceBootstrap(bridge, tracks, { isCurrent: () => current, ready: () => ready++, failed: (message) => notices.push(message) }, (callback) => { expire = callback; return () => { cancelCount++; }; });
  return { bridge, gate, tracks, sent, notices, expire: () => expire(), stale: () => { current = false; }, open: () => gate.channelOpened((event) => sent.push(event)), get ready() { return ready; }, get cancelled() { return cancelCount; } };
}

test('actual bootstrap keeps every microphone off until RTC and all ordered final receipts succeed', () => {
  const f = fixture(); assert(f.tracks.every((track) => !track.enabled));
  f.gate.connectionEstablished(); f.open(); assert.equal(f.sent.length, 1); assert.equal(f.ready, 0);
  assert.equal(f.sent[0].item.role, 'user'); assert.equal(f.sent[0].item.content[0].type, 'input_text'); assert.equal(f.sent[0].previous_item_id, 'root');
  f.gate.receive(receipt(f.sent[0], 'conversation.item.added', 'in_progress'));
  assert.equal(f.sent.length, 1); assert(f.tracks.every((track) => !track.enabled));
  f.gate.receive(receipt(f.sent[0])); assert.equal(f.sent.length, 2); assert.equal(f.ready, 0);
  assert.equal(f.sent[1].item.role, 'assistant'); assert.equal(f.sent[1].item.content[0].type, 'output_text'); assert.equal(f.sent[1].previous_item_id, f.sent[0].item.id);
  f.gate.receive(receipt(f.sent[1])); assert.equal(f.ready, 1); assert(f.tracks.every((track) => track.enabled));
  f.gate.receive(receipt(f.sent[1])); f.gate.connectionEstablished(); assert.equal(f.ready, 1);
  assert(f.sent.every((event) => event.type === 'conversation.item.create')); f.gate.stop(); assert(f.tracks.every((track) => !track.enabled));
});

test('final context before RTC connection does not open microphone and legacy created completion works', () => {
  const f = fixture(); f.open(); f.gate.receive(receipt(f.sent[0], 'conversation.item.created')); f.gate.receive(receipt(f.sent[1], 'conversation.item.created'));
  assert.equal(f.ready, 0); assert(f.tracks.every((track) => !track.enabled));
  f.gate.connectionEstablished(); assert.equal(f.ready, 1); f.gate.stop();
});

test('a transport that returns to connecting before final acknowledgment cannot release microphone', () => {
  const f = fixture(); f.open(); f.gate.connectionEstablished(); f.gate.receive(receipt(f.sent[0])); f.gate.connectionPending(); f.gate.receive(receipt(f.sent[1]));
  assert.equal(f.ready, 0); assert(f.tracks.every((track) => !track.enabled));
  f.gate.connectionEstablished(); assert.equal(f.ready, 1); f.gate.connectionPending();
  assert.equal(f.gate.ready, false); assert(f.tracks.every((track) => !track.enabled)); assert.equal(f.notices.length, 1);
});

test('empty context and explicit standalone both still wait for the data channel', () => {
  const empty = session(); empty.serverContext!.items = [];
  for (const f of [fixture(empty), fixture({ ...session(), serverContext: undefined }, undefined)]) {
    f.gate.connectionEstablished(); assert.equal(f.ready, 0); assert(f.tracks.every((track) => !track.enabled));
    f.open(); assert.equal(f.ready, 1); assert.deepEqual(f.sent, []); f.gate.stop();
  }
});

test('unknown item receipts leave context pending and a deadline closes the gate only once', () => {
  const f = fixture(); f.gate.connectionEstablished(); f.open();
  assert.equal(f.gate.receive({ ...receipt(f.sent[0]), item: { ...f.sent[0].item, id: 'unrelated-item', status: 'completed' } }), false);
  assert.equal(f.ready, 0); f.expire(); f.expire();
  assert.equal(f.notices.length, 1); assert.match(f.notices[0], /超时/); assert(f.tracks.every((track) => !track.enabled));
  f.gate.receive(receipt(f.sent[0])); assert.equal(f.ready, 0); assert.equal(f.sent.length, 1);
});

test('wrong role, content, predecessor and incomplete receipts fail without enabling any track', () => {
  const corrupt = [
    (r: any) => { r.item.role = 'system'; },
    (r: any) => { r.item.content = [{ type: 'input_text', text: 'Fictional altered context.' }]; },
    (r: any) => { r.item.content = [{ type: 'output_text', text: r.item.content[0].text }]; },
    (r: any) => { r.item.status = 'incomplete'; },
    (r: any) => { r.previous_item_id = 'wrong-predecessor'; },
    (r: any) => { r.item.content.push({ type: 'input_text', text: 'Fictional extra content.' }); },
  ];
  for (const change of corrupt) {
    const f = fixture(); f.gate.connectionEstablished(); f.open(); const r = structuredClone(receipt(f.sent[0])); change(r); f.gate.receive(r);
    assert.equal(f.notices.length, 1); assert.equal(f.ready, 0); assert(f.tracks.every((track) => !track.enabled)); assert.equal(f.sent.length, 1);
  }
});

test('future acknowledgments and channel send errors close the gate instead of skipping a message', () => {
  const f = fixture(); f.gate.connectionEstablished(); f.open();
  f.gate.receive({ type: 'conversation.item.done', item: { ...f.sent[0].item, id: `voice_context_${sessionId}_1`, status: 'completed' } });
  assert.equal(f.ready, 0); assert.equal(f.notices.length, 1); assert(f.tracks.every((track) => !track.enabled));
  const g = fixture(); g.gate.channelOpened(() => { throw new Error('Fictional transport failure with private details'); });
  assert.equal(g.notices.length, 1); assert.doesNotMatch(g.notices[0], /private details/); assert(g.tracks.every((track) => !track.enabled));
});

test('provider handshake error and context deletion fail closed even after successful handoff', () => {
  const f = fixture(); f.gate.connectionEstablished(); f.open(); f.gate.receive({ type: 'error', error: { message: 'Fictional provider-private detail' } });
  assert.equal(f.notices.length, 1); assert.doesNotMatch(f.notices[0], /provider-private/); assert.equal(f.ready, 0);
  const g = fixture(); g.gate.connectionEstablished(); g.open(); g.gate.receive(receipt(g.sent[0])); g.gate.receive(receipt(g.sent[1]));
  assert.equal(g.ready, 1); g.gate.receive({ type: 'conversation.item.deleted', item_id: g.sent[0].item.id });
  assert(g.tracks.every((track) => !track.enabled)); assert.equal(g.notices.length, 1);
});

test('same account through three login generations cannot acknowledge an old gate or enable its microphone', () => {
  const first = fixture(); first.gate.connectionEstablished(); first.open(); first.stale();
  const second = fixture({ ...session(), sessionId: '2feac504-92d0-4e0f-8de9-973d1e528dbe' }); second.gate.connectionEstablished(); second.open(); second.stale();
  const third = fixture({ ...session(), sessionId: 'b1fd07c0-74ba-46fc-aeec-4e0070d2b019' }); third.gate.connectionEstablished(); third.open();
  first.gate.receive(receipt(first.sent[0])); second.gate.receive(receipt(second.sent[0])); third.gate.receive(receipt(first.sent[0]));
  assert.equal(first.ready, 0); assert.equal(second.ready, 0); assert.equal(third.ready, 0); assert.equal(third.sent.length, 1);
  third.gate.receive(receipt(third.sent[0])); third.gate.receive(receipt(third.sent[1])); assert.equal(third.ready, 1); third.gate.stop();
  assert(first.tracks.every((track) => !track.enabled)); assert(second.tracks.every((track) => !track.enabled));
});

test('stop then start cannot turn a late final receipt into a new context acknowledgment', () => {
  const old = fixture(); old.open(); old.gate.stop();
  const fresh = fixture({ ...session(), sessionId: '73de52a5-7e86-4634-8cb1-7d8107ccf3c5' }); fresh.gate.connectionEstablished(); fresh.open();
  old.gate.receive(receipt(old.sent[0])); fresh.gate.receive(receipt(old.sent[0]));
  assert.equal(old.sent.length, 1); assert.equal(fresh.sent.length, 1); assert.equal(fresh.ready, 0); fresh.gate.stop();
});

test('seed IDs stay out of new excerpts after acknowledgment, including nested mixed response completion', () => {
  const f = fixture(); f.gate.connectionEstablished(); f.open(); f.gate.receive(receipt(f.sent[0])); f.gate.receive(receipt(f.sent[1]));
  const buffer = new RealtimeTranscriptBuffer(sessionId), seed = f.sent[1].item.id, fresh = 'fresh-audio-item';
  const receive = (event: unknown) => { if (f.gate.receive(event)) return; const forward = f.bridge.forTranscript(event); if (forward !== undefined) buffer.receive(forward); };
  receive({ type: 'response.done', response: { id: 'response-seed-only', status: 'completed', output: [{ type: 'message', role: 'assistant', id: seed }] } });
  receive({ type: 'response.output_audio_transcript.done', item_id: seed, response_id: 'response-seed-only', content_index: 0, transcript: 'Fictional imported context misreported as new audio.' });
  receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: f.sent[0].item.id, transcript: 'Fictional imported user context.' });
  assert.deepEqual(buffer.turns(), []);
  receive({ type: 'response.output_audio_transcript.done', item_id: fresh, response_id: 'response-mixed', content_index: 0, transcript: 'Fictional newly generated audio text.' });
  const mixed = { type: 'response.done', response: { id: 'response-mixed', status: 'completed', output: [{ type: 'message', role: 'assistant', id: seed }, { type: 'message', role: 'assistant', id: fresh }] } };
  receive(mixed); assert.equal(mixed.response.output.length, 2); assert.equal(buffer.turns().length, 1); assert.equal(buffer.turns()[0].itemId, fresh); assert.equal(buffer.turns()[0].status, 'complete');
  f.gate.stop();
});

test('server context must match the explicit conversation, source and unique owned message identifiers', () => {
  const invalid = [
    (s: any) => { s.serverContext.conversationId = userId; },
    (s: any) => { s.serverContext.source = 'client_submitted'; },
    (s: any) => { s.serverContext.items[1].messageId = userId; },
    (s: any) => { s.serverContext.items[1].role = 'system'; },
    (s: any) => { s.serverContext.items[1].text = ' '; },
    (s: any) => { s.serverContext.truncated = undefined; },
    (s: any) => { delete s.serverContext; },
    (s: any) => { s.serverContext.items = Array.from({ length: 21 }, () => s.serverContext.items[0]); },
  ];
  for (const change of invalid) { const value = session(); change(value); assert.throws(() => new RealtimeContextBridge(value, conversationId), /上下文/); }
  assert.throws(() => new RealtimeContextBridge(session()), /上下文/);
});

test('context enforces code point and UTF8 cumulative boundaries without clipping a message', () => {
  const accepted = session(); accepted.serverContext!.items = [{ messageId: userId, role: 'user', text: 'x'.repeat(8000) }]; assert.equal(new RealtimeContextBridge(accepted, conversationId).count, 1);
  accepted.serverContext!.items[0].text += 'x'; assert.throws(() => new RealtimeContextBridge(accepted, conversationId));
  accepted.serverContext!.items[0].text = '😀'.repeat(6144); assert.equal(new RealtimeContextBridge(accepted, conversationId).count, 1);
  accepted.serverContext!.items[0].text += '😀'; assert.throws(() => new RealtimeContextBridge(accepted, conversationId));
  const multibyte = session(); multibyte.serverContext!.items.forEach((item) => { item.text = '文'.repeat(5000); }); assert.throws(() => new RealtimeContextBridge(multibyte, conversationId));
});
