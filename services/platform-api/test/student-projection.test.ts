import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AccountUsage, AudioTranscriptionReceipt, Capability, ChatAttachmentSupport,
  Message, ReviewedAudioTranscript, VoiceRecord, VoiceSessionResponse,
} from '@companion/platform-contracts';
import {
  projectPlatformFeatures, projectPublicAccountUsage, projectPublicAudioTranscriptionReceipt,
  projectPublicCapabilities, projectPublicChatAttachmentSupport, projectPublicMessage,
  projectPublicReviewedAudioTranscript, projectPublicVoiceRecord, projectPublicVoiceSessionResponse,
} from '../src/student-projection.ts';

const createdAt = '2026-10-06T00:00:00.000Z';
const originalText = '我想申请 OpenAI；课程比较过 IBM、GPT 和 Claude。provider/model 是报告的原文。';
const sourceSha256 = 'a'.repeat(64);

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function availability(): Record<Capability, boolean> {
  return {
    chat: true, agent: false, image: false, video: false,
    speech: true, transcription: false, realtime: true,
    browser: false, cli: false, workflow: false, mcp: false,
  };
}

function attachmentSupport(): ChatAttachmentSupport {
  return {
    directMimeTypes: ['text/plain', 'image/png'], maxAttachments: 8, maxTotalBytes: 25 * 1024 * 1024,
    audioTranscripts: {
      mimeTypes: ['audio/wav'], provider: 'faster-whisper', model: 'whisper-tiny',
      maxAudioBytes: 20 * 1024 * 1024, maxDurationSeconds: 120, maxPerMessage: 2,
      maxReviewedCharacters: 8_000, available: false, reviewRequired: true,
      reason: 'Synthetic whisper-tiny configuration detail.',
    },
  };
}

function receipt(text = originalText): AudioTranscriptionReceipt {
  return {
    id: 'synthetic-receipt', sourceAttachmentId: 'synthetic-audio',
    sourceName: 'OpenAI-course-recording.wav', sourceMime: 'audio/wav', sourceSha256,
    provider: 'faster-whisper', model: 'whisper-tiny', text,
    provenance: 'untrusted_audio_transcript', createdAt,
  };
}

function reviewed(text = originalText, textModified = false): ReviewedAudioTranscript {
  return {
    receiptId: 'synthetic-receipt', sourceAttachmentId: 'synthetic-audio',
    sourceName: 'OpenAI-course-recording.wav', sourceMime: 'audio/wav', sourceSha256,
    provider: 'faster-whisper', model: 'whisper-tiny', text, textModified,
    provenance: 'untrusted_audio_transcript',
  };
}

function message(): Message {
  return {
    id: 'synthetic-message', conversationId: 'synthetic-conversation',
    role: 'user', content: originalText, status: 'complete', createdAt,
    provider: 'synthetic-internal-provider', model: 'synthetic-internal-model',
    attachments: [{ id: 'synthetic-file', name: 'OpenAI-report.txt', mime: 'text/plain', size: 0, url: '/api/platform/uploads/synthetic-file' }],
    audioTranscripts: [reviewed()],
  };
}

test('features and capabilities copy actual policy/availability without constructing provider profiles or absent attachment support', () => {
  const policy = freezeDeep({ workbench: false, providerDetails: false, isAdmin: true, provider: 'synthetic-private' });
  assert.deepEqual(projectPlatformFeatures(policy), { version: 1, workbench: false, providerDetails: false });
  assert.deepEqual(projectPlatformFeatures({ workbench: true, providerDetails: true }), { version: 1, workbench: true, providerDetails: true });
  const actual = freezeDeep({ ...availability(), privateVendor: true });
  const result = projectPublicCapabilities(actual);
  assert.deepEqual(result, { capabilities: availability() });
  assert.equal(Object.hasOwn(result, 'chatAttachments'), false);
  result.capabilities.chat = false;
  assert.equal(actual.chat, true);
  assert.equal(actual.privateVendor, true);
});

test('public attachment limits retain unavailable ASR and review requirements while isolating configuration and mutable MIME arrays', () => {
  const support = freezeDeep(attachmentSupport()), before = structuredClone(support);
  const result = projectPublicCapabilities(freezeDeep(availability()), support).chatAttachments!;
  assert.deepEqual(result, {
    directMimeTypes: ['text/plain', 'image/png'], maxAttachments: 8, maxTotalBytes: 25 * 1024 * 1024,
    audioTranscripts: {
      mimeTypes: ['audio/wav'], maxAudioBytes: 20 * 1024 * 1024, maxDurationSeconds: 120,
      maxPerMessage: 2, maxReviewedCharacters: 8_000, available: false, reviewRequired: true,
    },
  });
  result.directMimeTypes.push('application/pdf'); result.audioTranscripts.mimeTypes[0] = 'audio/ogg';
  assert.deepEqual(support, before);
  assert.equal(support.audioTranscripts.provider, 'faster-whisper');
  assert.equal(support.audioTranscripts.model, 'whisper-tiny');
  assert.equal(support.audioTranscripts.reason, 'Synthetic whisper-tiny configuration detail.');
  assert.deepEqual(projectPublicChatAttachmentSupport({ ...support, directMimeTypes: [], audioTranscripts: { ...support.audioTranscripts, mimeTypes: [], available: true } }).audioTranscripts.mimeTypes, []);
});

test('audio projection preserves immutable evidence, silence and separately reviewed text without claiming verified speech', () => {
  const source = freezeDeep(receipt()), selected = freezeDeep(reviewed('用户修改后仍写 OpenAI / Claude / model。', true));
  const sourceBefore = structuredClone(source), selectedBefore = structuredClone(selected);
  const immutable = projectPublicAudioTranscriptionReceipt(source), excerpt = projectPublicReviewedAudioTranscript(selected);
  assert.deepEqual(immutable, {
    id: source.id, sourceAttachmentId: source.sourceAttachmentId, sourceName: source.sourceName,
    sourceMime: source.sourceMime, sourceSha256, text: originalText,
    provenance: 'untrusted_audio_transcript', createdAt,
  });
  assert.deepEqual(excerpt, {
    receiptId: selected.receiptId, sourceAttachmentId: selected.sourceAttachmentId,
    sourceName: selected.sourceName, sourceMime: selected.sourceMime, sourceSha256,
    text: selected.text, textModified: true, provenance: 'untrusted_audio_transcript',
  });
  assert.equal(projectPublicAudioTranscriptionReceipt(freezeDeep(receipt(''))).text, '');
  assert.equal(projectPublicReviewedAudioTranscript(freezeDeep(reviewed('', false))).textModified, false);
  immutable.text = 'A later public edit'; excerpt.text = 'Another public edit';
  assert.deepEqual(source, sourceBefore); assert.deepEqual(selected, selectedBefore);
});

test('message projection keeps user, assistant and tool text verbatim but excludes route controls and unrelated future metadata at every projected boundary', () => {
  const original = freezeDeep({
    ...message(), metadata: { model: 'synthetic-future-control' }, error: { message: 'Synthetic configuration detail' },
    attachments: [{ ...message().attachments![0], provider: 'synthetic-attachment-control' }],
    audioTranscripts: [{ ...reviewed(), futureMetadata: { provider: 'synthetic-audio-control' } }],
  });
  const before = structuredClone(original), result = projectPublicMessage(original);
  assert.deepEqual(Object.keys(result).sort(), ['id', 'conversationId', 'role', 'content', 'status', 'createdAt', 'attachments', 'audioTranscripts'].sort());
  assert.equal(result.content, originalText);
  assert.deepEqual(result.attachments, message().attachments);
  assert.deepEqual(result.audioTranscripts, [projectPublicReviewedAudioTranscript(reviewed())]);
  for (const role of ['user', 'assistant', 'tool'] as const) {
    for (const status of ['complete', 'streaming', 'failed', 'cancelled'] as const) {
      const projected = projectPublicMessage(freezeDeep({ ...message(), role, status }));
      assert.equal(projected.role, role); assert.equal(projected.status, status); assert.equal(projected.content, originalText);
    }
  }
  result.attachments![0].name = 'Public renamed file'; result.audioTranscripts![0].text = 'Public reviewed edit';
  assert.deepEqual(original, before);
  assert.equal(original.provider, 'synthetic-internal-provider'); assert.equal(original.model, 'synthetic-internal-model');
});

test('optional and empty message fields remain distinct and never fabricate an audio receipt or source', () => {
  const minimal: Message = { id: 'empty', conversationId: 'synthetic-conversation', role: 'assistant', content: '', status: 'streaming', createdAt };
  const projected = projectPublicMessage(freezeDeep(minimal));
  assert.deepEqual(projected, minimal);
  assert.equal(Object.hasOwn(projected, 'attachments'), false);
  assert.equal(Object.hasOwn(projected, 'audioTranscripts'), false);
  assert.deepEqual(projectPublicMessage(freezeDeep({ ...minimal, attachments: [], audioTranscripts: [] })), { ...minimal, attachments: [], audioTranscripts: [] });
});

test('voice records preserve client-submitted provenance, source/session binding and private attachments without internal model identity', () => {
  const record: VoiceRecord = freezeDeep({
    id: 'synthetic-record', conversationId: 'synthetic-conversation', clientRecordId: 'synthetic-client-record',
    source: 'realtime_transcript', role: 'unknown', text: originalText, provenance: 'client_submitted',
    sessionId: 'synthetic-session', provider: 'synthetic-internal-provider', model: 'synthetic-internal-model',
    attachments: message().attachments!, createdAt,
  });
  const before = structuredClone(record), result = projectPublicVoiceRecord(record);
  assert.equal(result.provenance, 'client_submitted'); assert.equal(result.source, 'realtime_transcript');
  assert.equal(result.role, 'unknown'); assert.equal(result.sessionId, record.sessionId); assert.equal(result.text, originalText);
  assert.equal(Object.hasOwn(result, 'provider'), false); assert.equal(Object.hasOwn(result, 'model'), false);
  result.attachments[0].url = '/synthetic-public-edit';
  assert.deepEqual(record, before);
  const unbound = projectPublicVoiceRecord(freezeDeep({ ...record, sessionId: undefined, attachments: [], source: 'speech_excerpt' }));
  assert.equal(Object.hasOwn(unbound, 'sessionId'), false); assert.deepEqual(unbound.attachments, []);
});

test('direct WebRTC projection retains actual transport material and owned text context without copying model or native protocol metadata', () => {
  const session = freezeDeep({
    clientSecret: 'synthetic-temporary-credential', model: 'synthetic-internal-realtime-model',
    endpoint: 'https://api.openai.com/v1/realtime/calls', expiresAt: 0, inputTranscriptionEnabled: false,
    sessionId: 'synthetic-session',
    serverContext: {
      source: 'server_conversation' as const, conversationId: 'synthetic-conversation', truncated: true,
      items: [{ messageId: 'synthetic-context-message', role: 'user' as const, text: originalText, model: 'synthetic-future-control' }],
    },
    nativeSession: { voice: 'synthetic-native-voice' },
  });
  const before = structuredClone(session), result = projectPublicVoiceSessionResponse(session);
  assert.deepEqual(result, {
    clientSecret: session.clientSecret, endpoint: session.endpoint, expiresAt: 0,
    inputTranscriptionEnabled: false, sessionId: session.sessionId,
    serverContext: {
      source: 'server_conversation', conversationId: 'synthetic-conversation', truncated: true,
      items: [{ messageId: 'synthetic-context-message', role: 'user', text: originalText }],
    },
  });
  result.serverContext!.items[0].text = 'Public context edit'; result.serverContext!.items.push({ messageId: 'new', role: 'assistant', text: '' });
  assert.deepEqual(session, before);
  const minimal: VoiceSessionResponse = { clientSecret: 'synthetic-temporary-credential', model: 'synthetic-internal-model', endpoint: 'https://rtc.example.invalid/calls', sessionId: 'synthetic-session' };
  assert.deepEqual(projectPublicVoiceSessionResponse(freezeDeep(minimal)), { clientSecret: minimal.clientSecret, endpoint: minimal.endpoint, sessionId: minimal.sessionId });
  const emptyContext = projectPublicVoiceSessionResponse(freezeDeep({ ...minimal, serverContext: { source: 'server_conversation', conversationId: 'empty', items: [], truncated: false } }));
  assert.deepEqual(emptyContext.serverContext?.items, []); assert.equal(emptyContext.serverContext?.truncated, false);
});

test('usage projection preserves zero, unknown counts, partial coverage and outcomes without rewriting true internal provider groups', () => {
  const usage: AccountUsage = freezeDeep({
    period: { from: createdAt, to: '2026-11-01T00:00:00.000Z', timeZone: 'UTC' },
    chat: {
      calls: 5, reportedCalls: 2, missingCalls: 1, invalidCalls: 1, pendingCalls: 1,
      inputTokens: 0, outputTokens: 17, coverage: 'partial',
      outcomes: { complete: 1, failed: 1, cancelled: 1, interrupted: 1, running: 1 },
      providers: [{ provider: 'synthetic-internal-provider', model: 'synthetic-internal-model', calls: 5, reportedCalls: 2, inputTokens: 0, outputTokens: 17 }],
      legacyReports: 3,
    },
  });
  const before = structuredClone(usage), result = projectPublicAccountUsage(usage);
  assert.equal(Object.hasOwn(result.chat, 'providers'), false);
  assert.equal(result.chat.calls, 5); assert.equal(result.chat.reportedCalls, 2); assert.equal(result.chat.missingCalls, 1);
  assert.equal(result.chat.invalidCalls, 1); assert.equal(result.chat.pendingCalls, 1); assert.equal(result.chat.legacyReports, 3);
  assert.equal(result.chat.inputTokens, 0); assert.equal(result.chat.outputTokens, 17); assert.equal(result.chat.coverage, 'partial');
  assert.deepEqual(result.chat.outcomes, usage.chat.outcomes); assert.deepEqual(result.period, usage.period);
  result.period.from = 'synthetic-public-edit'; result.chat.outcomes.failed = 99;
  assert.deepEqual(usage, before);
  const unknown = projectPublicAccountUsage(freezeDeep({ ...usage, chat: {
    ...usage.chat, reportedCalls: 0, missingCalls: 5, invalidCalls: 0, pendingCalls: 0,
    inputTokens: null, outputTokens: null, coverage: 'none',
    outcomes: { complete: 2, failed: 1, cancelled: 1, interrupted: 1, running: 0 },
    providers: [{ ...usage.chat.providers[0], reportedCalls: 0, inputTokens: null, outputTokens: null }],
  } }));
  assert.equal(unknown.chat.inputTokens, null); assert.equal(unknown.chat.outputTokens, null); assert.equal(unknown.chat.coverage, 'none');
  const complete = projectPublicAccountUsage(freezeDeep({ ...usage, chat: {
    ...usage.chat, reportedCalls: 5, missingCalls: 0, invalidCalls: 0, pendingCalls: 0, coverage: 'complete',
    outcomes: { complete: 5, failed: 0, cancelled: 0, interrupted: 0, running: 0 },
    providers: [{ ...usage.chat.providers[0], reportedCalls: 5 }],
  } }));
  assert.equal(complete.chat.coverage, 'complete'); assert.equal(complete.chat.reportedCalls, complete.chat.calls);
});

test('later changes to valid internal arrays or nested objects cannot change an already projected DTO', () => {
  const internalMessage = message(), publicMessage = projectPublicMessage(internalMessage), beforeMessage = structuredClone(publicMessage);
  internalMessage.attachments![0].name = 'New internal name'; internalMessage.audioTranscripts![0].text = 'New internal selection';
  assert.deepEqual(publicMessage, beforeMessage);
  const support = attachmentSupport(), publicSupport = projectPublicChatAttachmentSupport(support), beforeSupport = structuredClone(publicSupport);
  support.directMimeTypes.push('application/pdf'); support.audioTranscripts.mimeTypes.push('audio/ogg');
  assert.deepEqual(publicSupport, beforeSupport);
  const session: VoiceSessionResponse = {
    clientSecret: 'synthetic-temporary-credential', model: 'synthetic-internal-model', endpoint: 'https://rtc.example.invalid/calls', sessionId: 'synthetic-session',
    serverContext: { source: 'server_conversation', conversationId: 'synthetic-conversation', items: [{ messageId: 'synthetic-message', role: 'assistant', text: originalText }], truncated: false },
  };
  const publicSession = projectPublicVoiceSessionResponse(session), beforeSession = structuredClone(publicSession);
  session.serverContext!.items[0].text = 'New internal context'; session.serverContext!.items.length = 0;
  assert.deepEqual(publicSession, beforeSession);
});
