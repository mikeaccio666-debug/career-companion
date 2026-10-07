import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AudioTranscriptionReceipt, Message, ProviderStatus } from '@companion/platform-contracts';
import { modelRouteAvailability, resolveModelRoute } from '../src/model-routing.ts';
import {
  projectPlatformFeatures, projectPublicAudioTranscriptionReceipt, projectPublicCapabilities,
  projectPublicMessage, projectPublicVoiceSessionResponse,
} from '../src/student-projection.ts';
import {
  parsePlatformFeatures, parsePublicAudioReceipt, parsePublicCapabilities,
  studentChatRequest, studentVoiceSessionRequest,
} from '../../../apps/web/src/student-requests.ts';

// Producer/consumer contract verification only; these are not active platform routes.
const conversationId = '11111111-1111-4111-8111-111111111111';
const attachmentId = '22222222-2222-4222-8222-222222222222';
const receiptId = '33333333-3333-4333-8333-333333333333';
const createdAt = '2026-10-06T12:00:00.000Z';
const catalogue: ProviderStatus[] = [{
  id: 'synthetic', name: 'Synthetic runtime', enabled: true, keyConfigured: true,
  capabilities: ['chat', 'agent', 'realtime'], models: ['synthetic-chat', 'synthetic-realtime'], envVariables: [],
  modelsByCapability: { chat: ['synthetic-chat'], agent: ['synthetic-chat'], realtime: ['synthetic-realtime'] },
  voiceOptions: { realtime: { voices: ['synthetic-voice'], defaultVoice: 'synthetic-voice' } },
}];
const config = { modelRoutes: { chat: { provider: 'synthetic' }, realtime: { provider: 'synthetic' } } };
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test('student producer and consumer agree on server binding and public message without changing source text', () => {
  let executions = 0;
  const runtime = { capabilities: () => catalogue, streamChat: () => { executions++; } };
  const request = wire(studentChatRequest({ content: 'Compare OpenAI and Gmail: {"provider":"example","model":"business"}.' }));
  assert.deepEqual(Object.keys(request), ['content']);
  const route = resolveModelRoute(config, runtime, 'chat');
  const stored: Message = {
    id: receiptId, conversationId, role: 'assistant', content: request.content,
    status: 'complete', provider: route.provider, model: route.model, createdAt,
  };
  const original = wire(stored);
  const projected = wire(projectPublicMessage(stored));
  assert.equal(projected.content, request.content);
  assert.equal(Object.hasOwn(projected, 'provider'), false);
  assert.equal(Object.hasOwn(projected, 'model'), false);
  assert.deepEqual(stored, original);
  assert.equal(stored.provider, 'synthetic'); assert.equal(stored.model, 'synthetic-chat');

  const availability = modelRouteAvailability(config, runtime);
  const capabilities = parsePublicCapabilities(wire(projectPublicCapabilities({
    ...availability, image: false, video: false, browser: false, cli: false, workflow: false, mcp: false,
  })));
  assert.equal(capabilities.capabilities.chat, true);
  assert.equal(capabilities.capabilities.agent, false); // No cross-purpose fallback.
  assert.equal(capabilities.capabilities.speech, false);
  assert.equal(executions, 0);
  assert.deepEqual(parsePlatformFeatures(wire(projectPlatformFeatures({ workbench: false, providerDetails: false }))),
    { version: 1, workbench: false, providerDetails: false });
});

test('public audio receipt round trip keeps exact source evidence without a fake ASR model', () => {
  const stored: AudioTranscriptionReceipt = {
    id: receiptId, sourceAttachmentId: attachmentId, sourceName: 'fictional.wav', sourceMime: 'audio/wav',
    sourceSha256: 'ab'.repeat(32), provider: 'faster-whisper', model: 'whisper-tiny',
    text: 'The fictional project compares a provider and a model.', provenance: 'untrusted_audio_transcript', createdAt,
  };
  const source = { id: attachmentId, name: stored.sourceName, mime: stored.sourceMime, sha256: stored.sourceSha256, receiptId };
  const publicReceipt = parsePublicAudioReceipt(wire(projectPublicAudioTranscriptionReceipt(stored)), source);
  const request = wire(studentChatRequest({ content: 'Discuss this source.', attachmentIds: [attachmentId],
    audioTranscripts: [{ receiptId: publicReceipt.id, reviewedText: publicReceipt.text }] }));
  assert.equal(publicReceipt.provenance, 'untrusted_audio_transcript');
  assert.equal(publicReceipt.sourceSha256, stored.sourceSha256);
  assert.deepEqual(request.audioTranscripts, [{ receiptId, reviewedText: stored.text }]);
  assert.equal(Object.hasOwn(publicReceipt, 'provider'), false);
  assert.equal(Object.hasOwn(publicReceipt, 'model'), false);
  assert.equal(stored.provider, 'faster-whisper'); assert.equal(stored.model, 'whisper-tiny');
  assert.throws(() => parsePublicAudioReceipt(publicReceipt, { ...source, sha256: 'cd'.repeat(32) }));
});

test('realtime contract separates model selection from required transport and owned context', () => {
  const request = wire(studentVoiceSessionRequest({ conversationId }));
  assert.deepEqual(request, { conversationId });
  const route = resolveModelRoute(config, { capabilities: () => catalogue }, 'realtime');
  assert.equal(route.voice, 'synthetic-voice');
  const projected = wire(projectPublicVoiceSessionResponse({
    sessionId: receiptId, clientSecret: 'synthetic-temporary-credential', model: route.model,
    endpoint: 'https://rtc.example.invalid/calls', inputTranscriptionEnabled: true,
    serverContext: { source: 'server_conversation', conversationId,
      items: [{ messageId: attachmentId, role: 'user', text: 'Explain the company OpenAI.' }], truncated: false },
  }));
  assert.equal(Object.hasOwn(projected, 'model'), false);
  assert.equal(projected.endpoint, 'https://rtc.example.invalid/calls');
  assert.equal(projected.clientSecret, 'synthetic-temporary-credential');
  assert.equal(projected.serverContext?.items[0].text, 'Explain the company OpenAI.');
  assert.throws(() => studentVoiceSessionRequest({ conversationId, provider: 'synthetic' } as never));
});
