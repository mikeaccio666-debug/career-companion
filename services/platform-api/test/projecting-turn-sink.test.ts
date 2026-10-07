import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '@companion/platform-contracts';
import type { TurnPreparation, TurnSink, TurnSinkCallbacks } from '../src/turn-sinks.ts';
import { ProjectingTurnSink } from '../src/projecting-turn-sink.ts';

const text = '用户报告包含 OpenAI、Claude、provider/model 原词，原文应保留。';
function fixture() {
  const order: string[] = [], events: { event: string; payload: unknown }[] = [];
  const controller = new AbortController(); let callbacks: TurnSinkCallbacks | undefined;
  const preparation: TurnPreparation = { signal: controller.signal, dispose() { order.push('dispose'); } };
  const inner: TurnSink = {
    prepare() { order.push('prepare'); return preparation; },
    open(value) { order.push('open'); callbacks = value; },
    emit(event, payload) { order.push(event); events.push({ event, payload: structuredClone(payload) }); },
    settle() { order.push('settle'); }, close() { order.push('close'); },
  };
  return { inner, preparation, controller, order, events, callbacks: () => callbacks };
}
function message(): Message {
  return { id: 'synthetic-message', conversationId: 'synthetic-conversation', role: 'assistant', content: text, provider: 'private-provider', model: 'private-model', status: 'complete', createdAt: '2026-10-06T00:00:00.000Z' };
}

test('public sink keeps synchronous lifecycle, exact preparation/callback identities and cancellation/heartbeat semantics', () => {
  const f = fixture(), sink = new ProjectingTurnSink(f.inner); let cancelled = 0, heartbeat = 0;
  const preparation = sink.prepare(); assert.equal(preparation, f.preparation); assert.equal(preparation.signal, f.controller.signal);
  const callbacks = { cancel() { cancelled++; f.controller.abort(); }, heartbeat() { heartbeat++; } };
  sink.open(callbacks); assert.equal(f.callbacks(), callbacks);
  f.callbacks()!.heartbeat(); f.callbacks()!.cancel(); assert.equal(heartbeat, 1); assert.equal(cancelled, 1); assert.equal(preparation.signal.aborted, true);
  sink.settle(); preparation.dispose(); sink.close(); assert.deepEqual(f.order, ['prepare', 'open', 'settle', 'dispose', 'close']);
});

test('start/delta/done retain real message ID and untouched content while public completion removes routing metadata', () => {
  const f = fixture(), sink = new ProjectingTurnSink(f.inner), source = Object.freeze(message());
  sink.prepare(); sink.emit('start', { messageId: source.id, provider: 'private-provider' });
  sink.emit('delta', { text, provider: 'private-provider' }); sink.emit('done', { message: source, model: 'private-model' });
  assert.deepEqual(f.events, [
    { event: 'start', payload: { messageId: source.id } }, { event: 'delta', payload: { text } },
    { event: 'done', payload: { message: { id: source.id, conversationId: source.conversationId, role: 'assistant', content: text, status: 'complete', createdAt: source.createdAt } } },
  ]);
  assert.equal(source.provider, 'private-provider'); assert.equal(source.status, 'complete');
});

test('tool progress requires a real start and uses own result presence including undefined without inferring task success', () => {
  const f = fixture(), sink = new ProjectingTurnSink(f.inner); sink.prepare();
  sink.emit('tool', { name: 'read_artifact_text', callId: 'synthetic-call', input: { text } }); assert.equal(f.events.length, 0);
  sink.emit('start', { messageId: 'synthetic-message' });
  sink.emit('tool', { name: 'read_artifact_text', callId: 'synthetic-call', input: { token: 'synthetic-secret' } });
  for (const result of [undefined, null, false, 0, '', { error: 'Synthetic vendor detail.', provider: 'business data' }]) sink.emit('tool', { name: 'read_artifact_text', callId: 'synthetic-call', input: { text }, result });
  assert.deepEqual(f.events[1], { event: 'tool', payload: { messageId: 'synthetic-message', name: 'read_artifact_text', status: 'started' } });
  for (const event of f.events.slice(2)) assert.deepEqual(event, { event: 'tool', payload: { messageId: 'synthetic-message', name: 'read_artifact_text', status: 'completed' } });
  sink.emit('tool', { name: 'read_artifact_text' }); assert.equal(f.events.length, 8);
  sink.prepare(); sink.emit('tool', { name: 'read_artifact_text', input: {} }); assert.equal(f.events.length, 8);
});

test('student streams expose no approval, usage, future or malformed payload and never fall back to raw events', () => {
  const f = fixture(), sink = new ProjectingTurnSink(f.inner);
  for (const [event, payload] of [
    ['approval', { id: 'synthetic-approval', args: { model: 'private-model', token: 'synthetic-secret' } }],
    ['usage', { inputTokens: 1, outputTokens: 2 }], ['future_event', { provider: 'private-provider' }],
    ['start', {}], ['delta', {}], ['done', null], ['done', { message: { id: 'malformed', audioTranscripts: false } }],
  ] as const) assert.doesNotThrow(() => sink.emit(event, payload));
  assert.deepEqual(f.events, []);
});

test('error frames use controlled semantic errors rather than provider text or arbitrary private code', () => {
  const f = fixture(), sink = new ProjectingTurnSink(f.inner);
  sink.emit('error', { code: 'PROVIDER_NOT_CONFIGURED', message: 'Synthetic OPENAI_API_KEY detail.', privateMetadata: { provider: 'private-provider' } });
  sink.emit('error', { code: 'ACCOUNT_CONTEXT_CHANGED', message: 'Synthetic vendor detail.' });
  assert.deepEqual(f.events, [
    { event: 'error', payload: { code: 'CAPABILITY_UNAVAILABLE', message: 'The requested capability is unavailable.' } },
    { event: 'error', payload: { code: 'ACCOUNT_CONTEXT_CHANGED', message: 'Reload the current account before continuing.' } },
  ]);
});

test('a closed/throwing presentation transport does not throw into completion persistence and lifecycle is still delegated', () => {
  const f = fixture(); f.inner.emit = () => { throw new Error('Synthetic closed output.'); };
  const sink = new ProjectingTurnSink(f.inner); sink.prepare(); sink.open({ cancel() {}, heartbeat() {} });
  for (const [event, payload] of [['start', { messageId: 'synthetic-message' }], ['delta', { text }], ['done', { message: message() }], ['error', { code: 'AUTH_REQUIRED', message: '' }]] as const) assert.doesNotThrow(() => sink.emit(event, payload));
  sink.settle(); sink.close(); assert.deepEqual(f.order, ['prepare', 'open', 'settle', 'close']);
});

test('synchronous lifecycle errors remain underlying lifecycle errors, rather than fake successful preparation or closure', () => {
  const f = fixture(), failure = new Error('Synthetic lifecycle failure.'); f.inner.prepare = () => { throw failure; };
  const sink = new ProjectingTurnSink(f.inner); assert.throws(() => sink.prepare(), error => error === failure);
  f.inner.open = () => { throw failure; }; assert.throws(() => sink.open({ cancel() {}, heartbeat() {} }), error => error === failure);
  f.inner.settle = () => { throw failure; }; assert.throws(() => sink.settle(), error => error === failure);
  f.inner.close = () => { throw failure; }; assert.throws(() => sink.close(), error => error === failure);
});
