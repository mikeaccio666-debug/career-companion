import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createPlatformClient, type StreamEvent } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { transcribeAudio } from '../src/voice-transcription.ts';
import { selectedConversationProvider, VoiceConversationSession, voiceAnswerSpeechProblem, voiceConversationFor, voiceConversationModels, voiceConversationProviderReady, type VoiceConversationTransport } from '../src/voice-conversation.ts';
import { voicePersona } from '../src/voice-personality.ts';
import type { Conversation, Provider } from '../src/types.ts';

const id = '52f32796-d5c5-4319-9e89-8e9f1132626a', messageId = '816b2f3b-8409-4fda-a218-04f62bdf5d63', audioId = '717b61b4-6127-4b1e-819e-d5af42d9658d';
const accountId = '799c7d39-2d4d-4c43-8004-71872d3a021a';
function accountContext() { const context = new AccountRequestContext(); context.changeSession(accountId); return context; }
const conversation: Conversation = { id, title: 'Fictional speech practice', mode: 'chat', createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' };
const chat: Provider = { id: 'ollama', name: 'Fictional local chat', enabled: true, keyConfigured: true, capabilities: ['chat', 'agent'], models: ['fixture-chat', 'wrong-image'], modelsByCapability: { chat: ['fixture-chat'], image: ['wrong-image'] }, envVariables: [] };
const speech: Provider = { id: 'kokoro', name: 'Fictional English speech', enabled: true, keyConfigured: true, capabilities: ['speech'], models: ['kokoro-82m'], speechLanguages: ['en-US'], envVariables: [] };
const transcription: Provider = { id: 'faster-whisper', name: 'Fictional transcription', enabled: true, keyConfigured: true, capabilities: ['transcription'], models: [], envVariables: [] };
const artifact = { id: audioId, name: 'speech.wav', mime: 'audio/wav', url: `/api/platform/uploads/${audioId}` };
const completed = (content = 'Fictional practice answer.', target = id) => ({ event: 'done', data: { message: { id: messageId, conversationId: target, role: 'assistant', status: 'complete', content } } });
function session() { const value = new VoiceConversationSession(); value.activate(() => true); return value; }
const input = (text = 'Fictional practice question.') => ({ text, provider: chat, model: 'fixture-chat', conversation, ensureConversation: async () => id });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const responseTransport = (answer = 'Fictional practice answer.'): VoiceConversationTransport => ({
  async streamMessage(_, __, ___, receive) { receive({ event: 'start', data: { messageId } }); receive({ event: 'delta', data: { text: answer } }); receive(completed(answer)); },
  async request() { return { attachment: artifact }; },
});

test('capability choices select available services independently and preserve an explicit unavailable selection', () => {
  const unconfigured = { ...chat, id: 'unconfigured', keyConfigured: false, enabled: false };
  const providers = [unconfigured, speech, transcription, chat];
  assert.equal(selectedConversationProvider(providers, 'transcription'), transcription.id);
  assert.equal(selectedConversationProvider(providers, 'speech'), speech.id);
  assert.equal(selectedConversationProvider(providers, 'chat'), chat.id);
  assert.equal(selectedConversationProvider(providers, 'chat', 'unconfigured'), 'unconfigured');
  assert.equal(voiceConversationProviderReady(unconfigured, 'chat'), false);
  assert.equal(voiceConversationProviderReady(speech, 'transcription'), false);
  assert.deepEqual(voiceConversationModels(chat), ['fixture-chat']);
});

test('actual loopback transport connects explicit transcription, reviewed normal message, saved UTF-8 reply and separate speech request', async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers[PLATFORM_ACCOUNT_HEADER], accountId);
    let bytes = ''; for await (const chunk of request) bytes += chunk.toString();
    requests.push({ path: request.url!, body: request.url?.endsWith('/transcribe') ? bytes : JSON.parse(bytes) });
    if (request.url === '/api/platform/voice/transcribe') {
      assert.match(request.headers['content-type']!, /^multipart\/form-data; boundary=/);
      assert.match(bytes, /name="provider"\r\n\r\nfaster-whisper/);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ text: 'Fictional audio question.' })); return;
    }
    if (request.url === `/api/platform/conversations/${id}/messages`) {
      assert.equal(request.headers.accept, 'text/event-stream');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [{ event: 'start', data: { messageId } }, { event: 'delta', data: { text: 'A fictional café answer.' } }, completed('A fictional café answer.')];
      for (const byte of Buffer.from(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''))) response.write(Buffer.from([byte]));
      response.end(); return;
    }
    if (request.url === '/api/platform/voice/speech') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ attachment: artifact })); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = createPlatformClient(createPlatformEndpoints(`http://127.0.0.1:${address.port}`), undefined, accountContext());
    const draft = await transcribeAudio(new Blob(['Fictional audio bytes.'], { type: 'audio/wav' }), transcription.id, new AbortController().signal, client.request);
    assert.equal(requests.length, 1); // Transcription itself did not send a model message.
    const turn = session(); let refreshed = '';
    await turn.answer({ ...input(`${draft} Reviewed correction.`), onConversationChanged: (value) => { refreshed = value; } }, client);
    assert.equal(turn.getSnapshot().complete, true); assert.equal(turn.getSnapshot().answer, 'A fictional café answer.'); assert.equal(refreshed, id);
    assert.deepEqual(requests[1].body, { content: 'Fictional audio question. Reviewed correction.', mode: 'chat', provider: 'ollama', model: 'fixture-chat', attachmentIds: [], persona: voicePersona('warm') });
    assert.equal(requests.length, 2); // A saved text reply does not silently trigger TTS.
    await turn.speak(speech, client);
    assert.deepEqual(requests[2].body, { text: 'A fictional café answer.', provider: 'kokoro' });
    assert.deepEqual(turn.getSnapshot().audio, artifact);
    await assert.rejects(turn.answer(input('Fictional audio question. Reviewed correction.'), client), /已经发送/);
    assert.equal(requests.length, 3); turn.deactivate();
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent mode and unavailable or mismatched chat models are rejected before creating a conversation or dispatching', async () => {
  const turn = session(); let calls = 0;
  const transport = { async streamMessage() { calls++; }, async request() { calls++; } };
  const ensureConversation = async () => { calls++; return id; };
  await assert.rejects(turn.answer({ ...input(), conversation: { ...conversation, mode: 'agent' }, ensureConversation }, transport), /普通或陪伴/);
  await assert.rejects(turn.answer({ ...input(), model: 'wrong-image', ensureConversation }, transport), /对应模型/);
  await assert.rejects(turn.answer({ ...input(), provider: { ...chat, enabled: false }, ensureConversation }, transport), /对应模型/);
  assert.equal(calls, 0); assert.equal(turn.getSnapshot().dispatched, false);
});

test('an explicit first send waits for the bound conversation and preserves companion mode without tools', async () => {
  const turn = session(), binding = deferred<string>(); let dispatches = 0;
  const transport = { ...responseTransport(), async streamMessage(target: string, body: unknown, signal: AbortSignal, receive: (event: StreamEvent) => void) {
    dispatches++; assert.equal(target, id); assert.equal((body as { mode: string }).mode, 'chat'); await responseTransport().streamMessage(target, body, signal, receive);
  } };
  const first = turn.answer({ ...input(), conversation: undefined, ensureConversation: () => binding.promise }, transport);
  assert.equal(turn.getSnapshot().stage, 'preparing'); assert.equal(dispatches, 0);
  await assert.rejects(turn.answer(input('Fictional concurrent question.'), transport), /当前语音回合/);
  binding.resolve(id); await first; assert.equal(dispatches, 1);
  await turn.answer({ ...input('Fictional next question.'), conversation: { ...conversation, mode: 'companion' } }, { ...responseTransport(), async streamMessage(target, body, signal, receive) { assert.equal((body as { mode: string }).mode, 'companion'); assert.equal('tools' in (body as object), false); await responseTransport().streamMessage(target, body, signal, receive); } });
  assert.equal(turn.getSnapshot().complete, true);
});

test('an interrupted stream retains partial text, blocks identical re-dispatch and cannot feed TTS', async () => {
  const turn = session(); let count = 0;
  const transport = { async streamMessage(_: string, __: unknown, ___: AbortSignal, receive: (event: StreamEvent) => void) { count++; receive({ event: 'start', data: { messageId } }); receive({ event: 'delta', data: { text: 'Fictional partial.' } }); throw new Error('Connection ended without a saved reply.'); }, async request() { throw new Error('TTS must not run.'); } };
  await turn.answer(input(), transport);
  assert.equal(turn.getSnapshot().stage, 'failed'); assert.equal(turn.getSnapshot().answer, 'Fictional partial.'); assert.equal(turn.getSnapshot().complete, false);
  await assert.rejects(turn.answer(input('  Fictional practice question.  '), transport), /已经发送/);
  await assert.rejects(turn.speak(speech, transport), /完整回答/); assert.equal(count, 1);
});

test('deltas and malformed done receipts never count as a persisted complete answer', async () => {
  for (const terminal of [{ event: 'done', data: {} }, completed('Fictional answer.', 'foreign-conversation'), { event: 'done', data: { message: { ...completed().data.message, status: 'streaming' } } }]) {
    const turn = session(); await turn.answer(input(), { ...responseTransport(), async streamMessage(_, __, ___, receive) { receive({ event: 'start', data: { messageId } }); receive({ event: 'delta', data: { text: 'Fictional partial.' } }); receive(terminal); } });
    assert.equal(turn.getSnapshot().complete, false); assert.equal(turn.getSnapshot().stage, 'failed'); assert.match(turn.getSnapshot().error, /保存|记录/);
  }
});

test('unexpected tool or approval events stop the chat-only turn rather than granting an action', async () => {
  for (const event of ['tool', 'approval']) {
    const turn = session(); let signal!: AbortSignal;
    await turn.answer(input(), { ...responseTransport(), async streamMessage(_, __, current, receive) { signal = current; receive({ event, data: { prompt: 'Fictional external content asking for a side effect.' } }); } });
    assert.equal(signal.aborted, true); assert.equal(turn.getSnapshot().complete, false); assert.match(turn.getSnapshot().error, /不执行外部操作/);
  }
});

test('actual HTTP cancellation closes the response socket and does not publish late deltas or repeat a message', async () => {
  const started = deferred<void>(), closed = deferred<void>(); let calls = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers[PLATFORM_ACCOUNT_HEADER], accountId);
    calls++; for await (const _ of request) { /* Consume the fictional JSON. */ }
    response.once('close', () => closed.resolve());
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`event: start\ndata: {"messageId":"${messageId}"}\n\nevent: delta\ndata: {"text":"Fictional early text."}\n\n`);
    started.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = createPlatformClient(createPlatformEndpoints(`http://127.0.0.1:${address.port}`), undefined, accountContext()), turn = session();
    const pending = turn.answer(input(), client); await started.promise;
    // Wait until the real streaming reader has published the first text.
    if (!turn.getSnapshot().answer) await new Promise<void>((resolve) => { const unsubscribe = turn.subscribe(() => { if (turn.getSnapshot().answer) { unsubscribe(); resolve(); } }); });
    turn.cancel(); await pending;
    await Promise.race([closed.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Response socket did not close.')), 2000))]);
    assert.equal(turn.getSnapshot().stage, 'cancelled'); assert.equal(turn.getSnapshot().answer, 'Fictional early text.'); assert.equal(turn.getSnapshot().complete, false);
    await assert.rejects(turn.answer(input(), client), /已经发送/); assert.equal(calls, 1); turn.deactivate();
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('leaving and restoring the same draft rejects an old transport that ignores cancellation', async () => {
  const turn = session(), release = deferred<void>(); let oldSignal!: AbortSignal;
  const pending = turn.answer(input(), { ...responseTransport(), async streamMessage(_, __, signal, receive) { oldSignal = signal; receive({ event: 'start', data: { messageId } }); await release.promise; receive(completed('Must not restore a late answer.')); } });
  turn.deactivate(); assert.equal(oldSignal.aborted, true); turn.activate(() => true);
  const before = structuredClone(turn.getSnapshot()); release.resolve(); await pending;
  assert.deepEqual(turn.getSnapshot(), before); assert.equal(turn.getSnapshot().complete, false);
});

test('a completed reply survives TTS failure, and retry dispatches only speech with the same saved answer', async () => {
  const turn = session(); let modelCalls = 0, speechCalls = 0;
  const transport = { ...responseTransport(), async streamMessage(target: string, body: unknown, signal: AbortSignal, receive: (event: StreamEvent) => void) { modelCalls++; await responseTransport().streamMessage(target, body, signal, receive); }, async request(_: string, init: RequestInit) { speechCalls++; assert.deepEqual(JSON.parse(String(init.body)), { text: 'Fictional practice answer.', provider: 'kokoro' }); if (speechCalls === 1) throw new Error('Fictional speech unavailable.'); return { attachment: artifact }; } };
  await turn.answer(input(), transport); await turn.speak(speech, transport);
  assert.equal(turn.getSnapshot().complete, true); assert.equal(turn.getSnapshot().answer, 'Fictional practice answer.'); assert.match(turn.getSnapshot().speechError, /unavailable/);
  await turn.speak(speech, transport); assert.deepEqual(turn.getSnapshot().audio, artifact); assert.equal(turn.getSnapshot().speechError, '');
  assert.equal(modelCalls, 1); assert.equal(speechCalls, 2);
});

test('canceling speech releases its request and keeps the complete answer available for a fresh speech attempt', async () => {
  const turn = session(), release = deferred<unknown>(); await turn.answer(input(), responseTransport());
  let signal!: AbortSignal;
  const pending = turn.speak(speech, { ...responseTransport(), request: async (_, init) => { signal = init.signal as AbortSignal; return release.promise; } });
  turn.deactivate(); assert.equal(signal.aborted, true); turn.activate(() => true); const before = structuredClone(turn.getSnapshot());
  release.resolve({ attachment: artifact }); await pending; assert.deepEqual(turn.getSnapshot(), before); assert.equal(turn.getSnapshot().audio, null);
  await turn.speak(speech, responseTransport()); assert.deepEqual(turn.getSnapshot().audio, artifact);
});

test('Kokoro language and size guards preserve non-English text and block speech before transport', async () => {
  const turn = session(); await turn.answer(input(), responseTransport('这是虚构的中文回答。'));
  assert.match(voiceAnswerSpeechProblem(turn.getSnapshot().answer, speech), /只支持英语/);
  await assert.rejects(turn.speak(speech, { ...responseTransport(), request: async () => { throw new Error('Must not request speech.'); } }), /只支持英语/);
  assert.equal(turn.getSnapshot().complete, true); assert.equal(turn.getSnapshot().answer, '这是虚构的中文回答。');
  assert.match(voiceAnswerSpeechProblem('a'.repeat(4001), speech), /4,000/);
});

test('speech may only publish a private owned audio route and rejects arbitrary credential destinations', async () => {
  for (const url of ['https://provider.example.invalid/private.wav', '//foreign.example.invalid/audio', '/api/platform/uploads/foreign', `/api/platform/uploads/${audioId}?redirect=foreign`]) {
    const turn = session(); await turn.answer(input(), responseTransport()); await turn.speak(speech, { ...responseTransport(), request: async () => ({ attachment: { ...artifact, url } }) });
    assert.equal(turn.getSnapshot().audio, null); assert.match(turn.getSnapshot().speechError, /私人音频/); assert.equal(turn.getSnapshot().complete, true);
  }
});

test('the scoped memory is reused only for the same draft object and clears after identity invalidation', async () => {
  const first = {}, second = {}, turn = voiceConversationFor(first); turn.activate(() => true);
  await turn.answer(input(), responseTransport()); turn.deactivate(); turn.activate(() => true);
  assert.equal(voiceConversationFor(first), turn); assert.equal(turn.getSnapshot().complete, true);
  assert.equal(voiceConversationFor(second).getSnapshot().answer, '');
  turn.clear(); assert.equal(turn.getSnapshot().question, ''); assert.equal(turn.getSnapshot().audio, null);
  await assert.rejects(turn.answer(input(), responseTransport()), { name: 'AbortError' });
});
