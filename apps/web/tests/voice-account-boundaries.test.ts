import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { holdPrivateResource } from '../src/private-media.ts';
import { VoiceDraftStore } from '../src/voice-draft.ts';
import { VoiceConversationSession } from '../src/voice-conversation.ts';
import { disposeVoiceSession, requestVoiceSession } from '../src/voice-session.ts';
import { appendTranscriptionText, transcribeAudio } from '../src/voice-transcription.ts';
import type { Provider, VoiceSession } from '../src/types.ts';

const accountA = '799c7d39-2d4d-4c43-8004-71872d3a021a';
const accountB = '0c7a9552-29c6-4d6f-968d-4ca66ea00464';
const conversationId = '278771cc-7d2c-455d-b031-722e73006ab0';
const messageId = '36d5580e-1d36-4e05-b850-76c9b2e0e61a';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test('a delayed multipart transcription cannot publish into a still-mounted A editor after the account context changes', async () => {
  const context = new AccountRequestContext(); context.changeSession(accountA);
  const store = new VoiceDraftStore(); store.changeSession({ accountId: accountA, generation: 1 });
  const origin = store.open(null).edit(); origin.update((value) => ({ ...value, text: 'Original fictional draft.' }));
  const response = deferred<Response>(), started = deferred<void>(); let calls = 0, requestSignal: AbortSignal | null = null;
  const client = createPlatformClient(createPlatformEndpoints(), async (input, init) => {
    calls++; assert.equal(input, '/api/platform/voice/transcribe');
    assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), accountA);
    assert.equal(new Headers(init?.headers).has('Content-Type'), false);
    assert.ok(init?.body instanceof FormData); assert.equal(init.body.get('provider'), 'fictional-transcriber');
    requestSignal = init.signal!; started.resolve(); return response.promise;
  }, context).capture();
  const pending = transcribeAudio(new Blob(['fictional encoded audio'], { type: 'audio/wav' }), 'fictional-transcriber', new AbortController().signal, client.request)
    .then((text) => origin.update((value) => ({ ...value, text: appendTranscriptionText(value.text, text) })));
  await started.promise;
  context.changeSession(accountB);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((requestSignal as unknown as AbortSignal).aborted, true);
  response.resolve(Response.json({ text: 'Late fictional A transcription.' }));
  await Promise.resolve();
  assert.equal(origin.isCurrent(), true, 'the request boundary protects even before the React/draft reset');
  assert.equal(store.open(null).getSnapshot().text, 'Original fictional draft.');
  await assert.rejects(client.request('/voice/speech', { method: 'POST', body: JSON.stringify({ text: 'Must not reach B.' }) }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('late realtime creation releases its A lease under the captured assertion without invalidating B', async () => {
  const context = new AccountRequestContext(); context.changeSession(accountA);
  let cleanupAccount = '', cleanupBody: unknown;
  const client = createPlatformClient(createPlatformEndpoints(), async (input, init) => {
    assert.equal(input, '/api/platform/voice/session/release'); assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'include'); assert.equal(init?.keepalive, true);
    cleanupAccount = new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER)!;
    cleanupBody = JSON.parse(String(init?.body));
    return Response.json({ error: { code: 'ACCOUNT_CONTEXT_CHANGED', message: 'Fictional account changed.' } }, { status: 409 });
  }, context).capture();
  const creation = deferred<VoiceSession>(), controller = new AbortController();
  const cleanups: Promise<void>[] = [];
  // Simulate a creation transport that ignores cancellation; never use a human microphone or vendor endpoint.
  const pending = requestVoiceSession({ provider: 'fictional-realtime' }, controller.signal, client.isCurrent, async () => creation.promise, (sessionId) => {
    cleanups.push(client.cleanup('/voice/session/release', { body: JSON.stringify({ sessionId }) }).catch(() => {}));
  });
  context.changeSession(accountB); controller.abort();
  creation.resolve({ sessionId: 'fictional-A-lease', endpoint: 'https://fictional.invalid', clientSecret: 'fictional-ephemeral-fixture', model: 'fixture' });
  assert.equal(await pending, null); await Promise.all(cleanups);
  assert.equal(cleanupAccount, accountA); assert.deepEqual(cleanupBody, { sessionId: 'fictional-A-lease' });
  assert.equal(context.getSnapshot().accountId, accountB);
  assert.equal(context.isCurrent(context.capture()!), true);
});

test('account invalidation aborts an active voice SSE, clears the answer and stops every native resource while cleanup remains A', async () => {
  const context = new AccountRequestContext(); context.changeSession(accountA);
  const sawPartial = deferred<void>(), cleanupDone = deferred<void>();
  let streamingAccount = '', cleanupAccount = '', streamCancelled = false;
  const client = createPlatformClient(createPlatformEndpoints(), async (input, init) => {
    if (input === '/api/platform/voice/session/release') {
      cleanupAccount = new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER)!; cleanupDone.resolve(); return Response.json({ released: false });
    }
    assert.equal(input, `/api/platform/conversations/${conversationId}/messages`);
    streamingAccount = new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER)!;
    return new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode(`event: start\ndata: {"messageId":"${messageId}"}\n\nevent: delta\ndata: {"text":"Fictional partial answer."}\n\n`)); },
      cancel() { streamCancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  }, context).capture();
  const conversation = new VoiceConversationSession(); conversation.activate(client.isCurrent);
  const unsubscribe = conversation.subscribe(() => { if (conversation.getSnapshot().answer === 'Fictional partial answer.') sawPartial.resolve(); });
  const events: string[] = [], audio = { srcObject: {} as unknown, pause() { events.push('audio'); } };
  const controller = new AbortController();
  const stop = holdPrivateResource(client, () => {
    void client.cleanup('/voice/session/release', { body: JSON.stringify({ sessionId: 'fictional-A-lease' }) }).catch(() => {});
    conversation.clear();
    disposeVoiceSession({ controllers: [controller], recording: { cancel() { events.push('discard-recording'); } }, peer: { close() { events.push('RTC'); } }, audio, microphone: { getTracks() { return [{ stop() { events.push('first-track'); throw new Error('Fictional device failure'); } }, { stop() { events.push('second-track'); } }]; } } });
  });
  const provider: Provider = { id: 'fictional-chat', keyConfigured: true, enabled: true, capabilities: ['chat'], models: ['fixture'], envVariables: [] };
  const pending = conversation.answer({ text: 'Fictional reviewed question.', provider, model: 'fixture', ensureConversation: async () => conversationId }, client);
  await sawPartial.promise; context.changeSession(accountB); await pending; await cleanupDone.promise;
  assert.equal(streamingAccount, accountA); assert.equal(cleanupAccount, accountA);
  assert.equal(controller.signal.aborted, true); assert.equal(audio.srcObject, null);
  assert.deepEqual(events, ['RTC', 'discard-recording', 'first-track', 'second-track', 'audio']);
  assert.equal(conversation.getSnapshot().answer, ''); assert.equal(conversation.getSnapshot().question, '');
  assert.equal(streamCancelled, true);
  assert.equal(context.getSnapshot().accountId, accountB);
  stop(); unsubscribe();
});
