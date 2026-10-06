import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeTranscriptBuffer, excerptInput, quotedVoiceText, splitVoiceText } from '../src/voice-history.ts';
const sessionId = '4f1ca211-477d-41ee-ad8d-f0ca638c5aaf';
const userEvent = (itemId: string, text: string) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, content_index: 0, transcript: text });
const assistantEvent = (itemId: string, text: string) => ({ type: 'response.output_audio_transcript.done', item_id: itemId, content_index: 0, transcript: text });

test('only complete transcript events produce sourced user and assistant excerpts', () => {
  const buffer = new RealtimeTranscriptBuffer(sessionId);
  buffer.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a', delta: 'partial' });
  buffer.receive({ type: 'unexpected.transcript.done', item_id: 'b', transcript: 'unknown' });
  assert.deepEqual(buffer.turns(), []);
  buffer.receive(userEvent('u', 'A fictional interview question.'));
  buffer.receive(assistantEvent('a', 'A fictional practice answer.'));
  assert.deepEqual(buffer.turns().map((turn) => turn.role), ['user', 'assistant']);
  for (const turn of buffer.turns()) {
    assert.equal(turn.inputs[0].source, 'realtime_transcript');
    assert.equal(turn.inputs[0].sessionId, sessionId);
    assert.equal(turn.inputs[0].role, turn.role);
  }
});

test('duplicate final events preserve UUID and exact retry payload', () => {
  const buffer = new RealtimeTranscriptBuffer(sessionId);
  const event = assistantEvent('a', 'A complete fictional response.');
  buffer.receive(event);
  const original = structuredClone(buffer.turns()[0].inputs);
  assert.deepEqual(buffer.receive(event), { changed: false });
  assert.deepEqual(buffer.turns()[0].inputs, original);
});

test('item predecessor metadata corrects out-of-order final events and late lifecycle events', () => {
  const buffer = new RealtimeTranscriptBuffer(sessionId);
  buffer.receive(assistantEvent('answer', 'Answer.'));
  buffer.receive(userEvent('question', 'Question.'));
  buffer.receive({ type: 'conversation.item.added', item: { id: 'answer' }, previous_item_id: 'question' });
  buffer.receive({ type: 'input_audio_buffer.committed', item_id: 'question', previous_item_id: null });
  assert.deepEqual(buffer.turns().map((turn) => turn.itemId), ['question', 'answer']);
});

test('long Unicode turns preserve text without splitting surrogate pairs or exceeding record limits', () => {
  const text = '🌱'.repeat(9001);
  const buffer = new RealtimeTranscriptBuffer(sessionId);
  buffer.receive(assistantEvent('a', text));
  const records = buffer.turns()[0].inputs;
  assert.equal(records.length, 3);
  assert.equal(records.map((record) => record.text).join(''), text);
  for (const record of records) {
    assert.ok(record.text.length <= 8000);
    assert.ok(new TextEncoder().encode(record.text).byteLength <= 32 * 1024);
    assert.equal(record.text.isWellFormed(), true);
  }
  assert.throws(() => splitVoiceText('text', 0), RangeError);
});

test('revised final text creates an explicit revision with new idempotency keys', () => {
  const buffer = new RealtimeTranscriptBuffer(sessionId);
  buffer.receive(userEvent('u', 'Earlier wording.'));
  const priorId = buffer.turns()[0].inputs[0].clientRecordId;
  buffer.receive(userEvent('u', 'Corrected wording.'));
  assert.equal(buffer.turns()[0].revision, 1);
  assert.notEqual(buffer.turns()[0].inputs[0].clientRecordId, priorId);
});

test('buffer bounds include lifecycle-only items and invalid event metadata', () => {
  const buffer = new RealtimeTranscriptBuffer(sessionId);
  for (let index = 0; index < buffer.maximumTrackedItems; index++) buffer.receive({ type: 'conversation.item.added', item: { id: `item-${index}` }, previous_item_id: index ? `item-${index - 1}` : null });
  assert.equal(buffer.receive({ type: 'conversation.item.added', item: { id: 'overflow' } }).limitReached, true);
  assert.deepEqual(buffer.turns(), []);
  const clean = new RealtimeTranscriptBuffer(sessionId);
  assert.equal(clean.receive({ ...userEvent('u', 'text'), content_index: -1 }).changed, false);
  assert.equal(clean.receive(userEvent('x'.repeat(257), 'text')).limitReached, true);
  assert.equal(clean.receive(userEvent('u', 'x'.repeat(1024 * 1024 + 1))).limitReached, true);
  assert.deepEqual(clean.turns(), []);
});

test('excerpt payloads exclude credentials and drafts retain unverified-source attribution', () => {
  const input = excerptInput('speech_excerpt', 'Fictional text.', ['audio-id']);
  assert.deepEqual(Object.keys(input).sort(), ['attachmentIds', 'clientRecordId', 'role', 'source', 'text']);
  const draft = quotedVoiceText('realtime_transcript', 'Fictional answer.', 'assistant');
  assert.match(draft, /未经服务端核验/);
  assert.match(draft, /AI/);
  assert.ok(draft.endsWith('Fictional answer.'));
});
