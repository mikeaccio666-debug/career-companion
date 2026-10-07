import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeTranscriptBuffer, excerptInput, quotedVoiceText, realtimeTurnCanSave, realtimeTurnStatusText, splitVoiceText } from '../src/voice-history.ts';
const sessionId = '4f1ca211-477d-41ee-ad8d-f0ca638c5aaf';
const userEvent = (itemId: string, text: string) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, content_index: 0, transcript: text });
const assistantEvent = (itemId: string, text: string) => ({ type: 'response.output_audio_transcript.done', response_id: `${itemId}-response`, item_id: itemId, content_index: 0, transcript: text });
const responseEvent = (itemId: string, status = 'completed') => ({ type: 'response.done', response: { id: `${itemId}-response`, status, output: [{ type: 'message', role: 'assistant', id: itemId }] } });

test('only complete transcript events produce sourced user and assistant excerpts', () => {
  const buffer = new RealtimeTranscriptBuffer(sessionId);
  buffer.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a', delta: 'partial' });
  buffer.receive({ type: 'unexpected.transcript.done', item_id: 'b', transcript: 'unknown' });
  assert.deepEqual(buffer.turns(), []);
  buffer.receive(userEvent('u', 'A fictional interview question.'));
  buffer.receive(assistantEvent('a', 'A fictional practice answer.'));
  buffer.receive(responseEvent('a'));
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
  buffer.receive(responseEvent('a'));
  const original = structuredClone(buffer.turns()[0].inputs);
  assert.deepEqual(buffer.receive(event), { changed: false });
  assert.deepEqual(buffer.receive(responseEvent('a')), { changed: false });
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
  buffer.receive(responseEvent('a'));
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

test('assistant transcript completion stays unconfirmed until a successful response receipt, independent of user ASR', () => {
  const buffer = new RealtimeTranscriptBuffer(sessionId);
  buffer.receive(assistantEvent('a', 'Fictional generated text.'));
  assert.equal(buffer.turns()[0].status, 'unconfirmed');
  assert.equal(realtimeTurnCanSave(buffer.turns()[0]), false);
  assert.deepEqual(buffer.turns()[0].inputs, []);
  assert.match(realtimeTurnStatusText(buffer.turns()[0]), /未收到/);
  buffer.receive(userEvent('u', 'Fictional ASR text.'));
  assert.equal(buffer.turns().find((turn) => turn.role === 'user')!.status, 'complete');
  assert.equal(realtimeTurnCanSave(buffer.turns().find((turn) => turn.role === 'user')!), true);
  assert.equal(buffer.receive(responseEvent('a')).changed, true);
  const assistant = buffer.turns().find((turn) => turn.role === 'assistant')!;
  assert.equal(assistant.status, 'complete'); assert.equal(realtimeTurnCanSave(assistant), true);
  assert.match(realtimeTurnStatusText(assistant), /不代表音频已播放完/);
});

test('cancelled, failed and incomplete responses never become complete excerpts in either event order', () => {
  for (const status of ['cancelled', 'failed', 'incomplete'] as const) for (const receiptFirst of [false, true]) {
    const buffer = new RealtimeTranscriptBuffer(sessionId);
    if (receiptFirst) buffer.receive(responseEvent('a', status));
    buffer.receive(assistantEvent('a', 'Fictional unfinished text.'));
    if (!receiptFirst) buffer.receive(responseEvent('a', status));
    buffer.receive(userEvent('u', 'Fictional complete input.'));
    const assistant = buffer.turns().find((turn) => turn.role === 'assistant')!;
    assert.equal(assistant.status, status); assert.deepEqual(assistant.inputs, []);
    assert.equal(realtimeTurnCanSave(assistant), false);
    assert.equal(realtimeTurnCanSave(buffer.turns().find((turn) => turn.role === 'user')!), true);
  }
});

test('a success receipt before transcript and legacy transcript aliases without response ids use exact output item association', () => {
  for (const receiptFirst of [false, true]) for (const type of ['response.output_audio_transcript.done', 'response.audio_transcript.done']) {
    const buffer = new RealtimeTranscriptBuffer(sessionId);
    const transcript = { type, item_id: 'a', content_index: 0, transcript: 'Fictional legacy shape.' };
    if (receiptFirst) buffer.receive(responseEvent('a'));
    buffer.receive(transcript);
    if (!receiptFirst) {
      assert.equal(buffer.turns()[0].status, 'unconfirmed');
      buffer.receive(responseEvent('a'));
    }
    assert.equal(realtimeTurnCanSave(buffer.turns()[0]), true);
    assert.equal(buffer.turns()[0].inputs[0].text, transcript.transcript);
  }
  const unlinked = new RealtimeTranscriptBuffer(sessionId);
  unlinked.receive({ type: 'response.audio_transcript.done', item_id: 'a', transcript: 'Fictional unlinked text.' });
  unlinked.receive({ type: 'response.done', response: { id: 'unknown', status: 'completed', output: [] } });
  assert.equal(unlinked.turns()[0].status, 'unconfirmed'); assert.deepEqual(unlinked.turns()[0].inputs, []);
});

test('truncation removes saveable inputs and later success or duplicate transcripts cannot restore them', () => {
  for (const truncateFirst of [false, true]) {
    const buffer = new RealtimeTranscriptBuffer(sessionId), truncated = { type: 'conversation.item.truncated', item_id: 'a', content_index: 0, audio_end_ms: 1500 };
    if (truncateFirst) buffer.receive(truncated);
    buffer.receive(assistantEvent('a', 'Fictional full generated words.')); buffer.receive(responseEvent('a'));
    if (!truncateFirst) { assert.equal(realtimeTurnCanSave(buffer.turns()[0]), true); assert.equal(buffer.receive(truncated).changed, true); }
    buffer.receive(responseEvent('a')); buffer.receive(assistantEvent('a', 'Fictional full generated words.'));
    assert.equal(buffer.turns()[0].status, 'truncated'); assert.deepEqual(buffer.turns()[0].inputs, []);
    assert.match(realtimeTurnStatusText(buffer.turns()[0]), /无法精确对应/);
  }
});

test('deletion removes text and tombstones the item against late transcript or lifecycle events', () => {
  for (const deleteFirst of [false, true]) {
    const buffer = new RealtimeTranscriptBuffer(sessionId), deleted = { type: 'conversation.item.deleted', item_id: 'a' };
    if (deleteFirst) buffer.receive(deleted);
    buffer.receive(assistantEvent('a', 'Fictional removed text.')); buffer.receive(responseEvent('a'));
    if (!deleteFirst) assert.equal(buffer.receive(deleted).changed, true);
    buffer.receive({ type: 'conversation.item.added', item: { id: 'a' }, previous_item_id: null });
    buffer.receive(assistantEvent('a', 'Fictional late text.')); assert.deepEqual(buffer.turns(), []);
  }
});

test('conflicting response receipts and item-to-response associations fail closed', () => {
  const buffer = new RealtimeTranscriptBuffer(sessionId);
  buffer.receive(assistantEvent('a', 'Fictional text.')); buffer.receive(responseEvent('a'));
  buffer.receive(responseEvent('a', 'failed')); buffer.receive(responseEvent('a'));
  assert.equal(buffer.turns()[0].status, 'incomplete'); assert.deepEqual(buffer.turns()[0].inputs, []);
  const linked = new RealtimeTranscriptBuffer(sessionId);
  linked.receive(assistantEvent('a', 'Fictional text.')); linked.receive(responseEvent('a'));
  linked.receive({ type: 'response.done', response: { id: 'different', status: 'completed', output: [{ type: 'message', role: 'assistant', id: 'a' }] } });
  assert.equal(linked.turns()[0].status, 'incomplete'); assert.deepEqual(linked.turns()[0].inputs, []);
  const inconsistent = new RealtimeTranscriptBuffer(sessionId);
  inconsistent.receive(assistantEvent('a', 'Fictional text.'));
  inconsistent.receive({ type: 'response.done', response: { id: 'a-response', status: 'completed', output: [{ type: 'message', role: 'assistant', id: 'a', status: 'incomplete' }] } });
  assert.equal(inconsistent.turns()[0].status, 'incomplete'); assert.deepEqual(inconsistent.turns()[0].inputs, []);
});

test('response tracking and unconfirmed fragments remain bounded without relying on saveable inputs', () => {
  const responses = new RealtimeTranscriptBuffer(sessionId);
  for (let index = 0; index < responses.maximumTrackedItems; index++) responses.receive({ type: 'response.done', response: { id: `response-${index}`, status: 'completed', output: [] } });
  assert.equal(responses.receive({ type: 'response.done', response: { id: 'overflow', status: 'completed' } }).limitReached, true);
  const fragments = new RealtimeTranscriptBuffer(sessionId);
  for (let index = 0; index < fragments.maximumRecords; index++) fragments.receive(assistantEvent(`item-${index}`, 'Fictional fragment.'));
  assert.equal(fragments.turns().flatMap((turn) => turn.inputs).length, 0);
  assert.equal(fragments.receive(assistantEvent('overflow', 'Fictional fragment.')).limitReached, true);
});

test('a malformed or oversized terminal output atomically revokes an already saveable response before reporting the limit', () => {
  for (const status of ['failed', 'cancelled', 'completed']) for (const malformed of ['invalid-id', 'oversized', 'wrong-shape', 'item-capacity']) {
    const buffer = new RealtimeTranscriptBuffer(sessionId);
    buffer.receive(assistantEvent('a', 'Fictional successful text.')); buffer.receive(responseEvent('a'));
    assert.equal(realtimeTurnCanSave(buffer.turns()[0]), true);
    if (malformed === 'item-capacity') for (let index = 1; index < buffer.maximumTrackedItems; index++) buffer.receive({ type: 'conversation.item.added', item: { id: `filled-${index}` } });
    const output = malformed === 'invalid-id' ? [{ type: 'message', role: 'assistant', id: 'would-partially-associate' }, { type: 'message', role: 'assistant', id: '' }]
      : malformed === 'oversized' ? Array.from({ length: buffer.maximumTrackedItems + 1 }, () => ({ type: 'message', role: 'assistant', id: 'a' }))
      : malformed === 'item-capacity' ? [{ type: 'message', role: 'assistant', id: 'new-overflow' }] : {};
    const result = buffer.receive({ type: 'response.done', response: { id: 'a-response', status, output } });
    assert.deepEqual(result, { changed: true, limitReached: true });
    assert.equal(buffer.turns()[0].status, 'incomplete'); assert.deepEqual(buffer.turns()[0].inputs, []);
    buffer.receive(responseEvent('a')); assert.equal(realtimeTurnCanSave(buffer.turns()[0]), false);
    if (malformed === 'invalid-id') {
      buffer.receive({ type: 'response.output_audio_transcript.done', item_id: 'would-partially-associate', transcript: 'Fictional unrelated legacy text.' });
      assert.equal(buffer.turns().find((turn) => turn.itemId === 'would-partially-associate')!.status, 'unconfirmed', 'the rejected output must not partly associate its earlier items');
    }
  }
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
