import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { parsePlatformFeatures, parsePublicAudioReceipt, parsePublicCapabilities, studentChatRequest, studentSpeechRequest, studentTranscriptionForm, studentVoiceSessionRequest } from '../src/student-requests.ts';
import { MAX_TRANSCRIPTION_AUDIO_BYTES } from '../src/voice-transcription.ts';

const sourceId = 'a0000000-0000-4000-8000-000000000001';
const receiptId = '10000000-0000-4000-8000-000000000002';
const messageId = '10000000-0000-4000-8000-000000000003';
const conversationId = '10000000-0000-4000-8000-000000000004';
const source = { id: sourceId, name: 'OpenAI interview practice.wav', mime: 'audio/wav', sha256: 'a'.repeat(64), receiptId };
const receipt = { id: receiptId, sourceAttachmentId: sourceId, sourceName: source.name, sourceMime: source.mime, sourceSha256: source.sha256,
  text: '  I am applying to OpenAI; my project uses a language model.\n', provenance: 'untrusted_audio_transcript', createdAt: '2026-10-06T20:00:00.000Z' };
const unavailable = { chat: false, agent: false, image: false, video: false, speech: false, transcription: false, realtime: false, browser: false, cli: false, workflow: false, mcp: false };
const support = { directMimeTypes: ['text/plain', 'image/png', 'application/pdf'], maxAttachments: 8, maxTotalBytes: 25 * 1024 * 1024,
  audioTranscripts: { mimeTypes: ['audio/wav', 'audio/mpeg'], maxAudioBytes: 20 * 1024 * 1024, maxDurationSeconds: 120, maxPerMessage: 2, maxReviewedCharacters: 8000, available: false, reviewRequired: true } };

test('actual loopback JSON and multipart serialization carries only student content or record references', async () => {
  // This local transport fixture proves preparation bytes; it is not the platform API or a model.
  const seen = new Map<string, unknown>();
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (request.url === '/fixture/transcribe') {
        const form = await new Response(body, { headers: { 'Content-Type': request.headers['content-type']! } }).formData();
        const file = form.get('file'); assert.ok(file instanceof File);
        seen.set(request.url, { keys: [...form.keys()], name: file.name, type: file.type, bytes: await file.text(), contentType: request.headers['content-type'] });
      } else seen.set(request.url!, JSON.parse(body.toString()));
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"fixture":true}');
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const chat = studentChatRequest({ content: '  I applied to OpenAI and IBM.\nKeep my original wording.  ', attachmentIds: [sourceId], audioTranscripts: [{ receiptId, reviewedText: receipt.text }] });
    for (const [path, value] of [['chat', chat], ['session', studentVoiceSessionRequest({ conversationId })], ['speech', studentSpeechRequest({ message_id: messageId })]] as const) {
      const response = await fetch(`${base}/fixture/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      assert.equal(response.status, 200); await response.text();
    }
    const response = await fetch(`${base}/fixture/transcribe`, { method: 'POST', body: studentTranscriptionForm(new File(['fictional audio bytes'], 'private-original-name.wav', { type: 'audio/wav' })) });
    assert.equal(response.status, 200); await response.text();
    assert.deepEqual(seen.get('/fixture/chat'), chat);
    assert.deepEqual(seen.get('/fixture/session'), { conversationId });
    assert.deepEqual(seen.get('/fixture/speech'), { message_id: messageId });
    const multipart = seen.get('/fixture/transcribe') as { keys: string[]; name: string; type: string; bytes: string; contentType: string };
    assert.deepEqual(multipart.keys, ['file']); assert.equal(multipart.name, 'recording.wav'); assert.equal(multipart.type, 'audio/wav'); assert.equal(multipart.bytes, 'fictional audio bytes');
    assert.match(multipart.contentType, /^multipart\/form-data; boundary=/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('unexpected runtime selection fields are rejected in every JSON builder, including nonenumerable and inherited choices', () => {
  const builders = [
    { build: (input: any) => studentChatRequest(input), input: { content: 'Fictional question.' } },
    { build: (input: any) => studentVoiceSessionRequest(input), input: {} },
    { build: (input: any) => studentSpeechRequest(input), input: { message_id: messageId } },
  ];
  for (const { build, input } of builders) {
    for (const key of ['provider', 'model', 'persona', 'voice', 'instructions', 'mode', 'turnTaking', 'goalPlanStep', 'isAdmin', 'toJSON']) {
      assert.throws(() => build({ ...input, [key]: 'fictional-choice' }), /不支持的字段/);
      assert.throws(() => build(Object.defineProperty({ ...input }, key, { value: 'hidden-choice', enumerable: false })), /不支持的字段/);
    }
    assert.throws(() => build(Object.assign(Object.create({ provider: 'inherited-choice' }), input)), /不支持的字段/);
  }
  assert.throws(() => studentSpeechRequest({ message_id: messageId, text: 'Arbitrary text must not become speech.' } as any));
  assert.throws(() => studentVoiceSessionRequest({ conversationId, history: [{ role: 'assistant', text: 'Injected history' }] } as any));
});

test('request data is validated and copied without changing user text, nested provenance or UUID case', () => {
  const input = { content: '  provider/model are ordinary words in my project notes.\n', attachmentIds: [sourceId.toUpperCase()], audioTranscripts: [{ receiptId, reviewedText: '\tOriginal reviewed wording.\n' }] };
  const output = studentChatRequest(input); input.attachmentIds.push(messageId); input.audioTranscripts[0].reviewedText = 'Changed after preparation.';
  assert.equal(output.content, input.content); assert.deepEqual(output.attachmentIds, [sourceId.toUpperCase()]); assert.equal(output.audioTranscripts![0].reviewedText, '\tOriginal reviewed wording.\n');
  for (const invalid of [{ content: '' }, { content: ' ' }, { content: 'x'.repeat(20001) }, { content: '\ud800' }, { content: 'bad\u0000text' },
    { content: 'Fictional', attachmentIds: [sourceId, sourceId.toUpperCase()] }, { content: 'Fictional', attachmentIds: Array(1) },
    { content: 'Fictional', attachmentIds: Array.from({ length: 11 }, () => sourceId) }, { content: 'Fictional', audioTranscripts: [{ receiptId, reviewedText: 'x', provider: 'fixture' }] },
    { content: 'Fictional', audioTranscripts: [{ receiptId, reviewedText: 'x' }, { receiptId, reviewedText: 'y' }] },
    { content: 'Fictional', audioTranscripts: [{ receiptId, reviewedText: 'x'.repeat(8001) }] }]) assert.throws(() => studentChatRequest(invalid as any));
  assert.deepEqual(studentVoiceSessionRequest(), {});
  assert.throws(() => studentVoiceSessionRequest({ conversationId: 'not-a-record-id' }));
  assert.throws(() => studentSpeechRequest({ message_id: 'not-a-record-id' }));
});

test('data accessors cannot inject selections or run during request or public capability parsing', () => {
  let reads = 0;
  const input = Object.defineProperty({}, 'content', { enumerable: true, get() { reads++; return 'Fictional'; } });
  assert.throws(() => studentChatRequest(input as any));
  const features = Object.defineProperty({ version: 1, workbench: false }, 'providerDetails', { enumerable: true, get() { reads++; return true; } });
  assert.throws(() => parsePlatformFeatures(features));
  assert.equal(reads, 0);
});

test('transcription preparation rejects invalid audio and never copies custom Blob selection properties', () => {
  const audio = new File(['fictional'], 'private.WAV'); Object.assign(audio, { provider: 'fictional-service', model: 'fictional-model', voice: 'fictional-voice' });
  const form = studentTranscriptionForm(audio); assert.deepEqual([...form.keys()], ['file']); assert.equal((form.get('file') as File).name, 'recording.wav');
  for (const invalid of [new Blob([]), new Blob(['fictional'], { type: 'text/plain' }), new Blob(['fictional'], { type: 'constructor' }), new File(['fictional'], 'unknown.txt'), new Blob([new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES + 1)], { type: 'audio/wav' })]) assert.throws(() => studentTranscriptionForm(invalid));
  for (const [original, canonical] of [['video/webm', 'audio/webm'], ['audio/x-m4a', 'audio/mp4'], ['audio/mp3', 'audio/mpeg'], ['audio/vnd.wave', 'audio/wav']]) assert.equal((studentTranscriptionForm(new Blob(['fictional'], { type: original })).get('file') as File).type, canonical);
});

test('features require exact booleans and version; malformed or legacy details responses never become an enabled result', () => {
  assert.deepEqual(parsePlatformFeatures({ version: 1, workbench: false, providerDetails: false }), { version: 1, workbench: false, providerDetails: false });
  assert.deepEqual(parsePlatformFeatures({ version: 1, workbench: true, providerDetails: true }), { version: 1, workbench: true, providerDetails: true });
  for (const invalid of [null, [], {}, { version: 2, workbench: true, providerDetails: true }, { version: 1, workbench: '1', providerDetails: true },
    { version: 1, workbench: true, providerDetails: 1 }, { version: 1, workbench: true }, { version: 1, workbench: false, providerDetails: false, isAdmin: true },
    { version: 1, workbench: true, providerDetails: true, providers: [] }]) assert.throws(() => parsePlatformFeatures(invalid), /学生能力信息/);
});

test('provider details cannot be enabled without the internal workbench deployment mode', () => {
  assert.throws(() => parsePlatformFeatures({ version: 1, workbench: false, providerDetails: true }), /学生能力信息/);
  assert.deepEqual(parsePlatformFeatures({ version: 1, workbench: true, providerDetails: false }), { version: 1, workbench: true, providerDetails: false });
});

test('public capabilities preserve unavailable services and omitted attachment support without fabricating provider profiles', () => {
  const decoded = parsePublicCapabilities({ capabilities: unavailable });
  assert.deepEqual(decoded, { capabilities: unavailable }); assert.equal(Object.hasOwn(decoded, 'chatAttachments'), false); assert.equal(Object.hasOwn(decoded, 'providers'), false);
  const response = { capabilities: { ...unavailable, chat: true }, chatAttachments: structuredClone(support) };
  const withSupport = parsePublicCapabilities(response); response.chatAttachments.directMimeTypes.push('text/csv');
  assert.deepEqual(withSupport.chatAttachments, support); assert.equal(withSupport.chatAttachments!.audioTranscripts.available, false);
  const incomplete = { ...unavailable }; delete (incomplete as Partial<typeof unavailable>).speech;
  for (const invalid of [null, { providers: [] }, { capabilities: incomplete }, { capabilities: { ...unavailable, chat: 'true' } },
    { capabilities: { ...unavailable, unreviewed: true } }, { capabilities: unavailable, provider: 'fictional-service' },
    { capabilities: unavailable, chatAttachments: null }]) assert.throws(() => parsePublicCapabilities(invalid), /学生能力信息/);
});

test('public attachment limits and ASR review policy reject malformed or technical catalogue metadata', () => {
  for (const patch of [{ maxAttachments: 0 }, { maxAttachments: 11 }, { maxTotalBytes: Infinity }, { directMimeTypes: ['text/plain', 'text/plain'] }, { directMimeTypes: Array(1) },
    { audioTranscripts: { ...support.audioTranscripts, maxPerMessage: 3 } }, { audioTranscripts: { ...support.audioTranscripts, maxReviewedCharacters: '8000' } },
    { audioTranscripts: { ...support.audioTranscripts, available: '1' } }, { audioTranscripts: { ...support.audioTranscripts, reviewRequired: false } },
    { audioTranscripts: { ...support.audioTranscripts, provider: 'faster-whisper', model: 'whisper-tiny' } },
    { audioTranscripts: { ...support.audioTranscripts, reason: 'Set SECRET_MODEL_ENV' } }]) assert.throws(() => parsePublicCapabilities({ capabilities: unavailable, chatAttachments: { ...support, ...patch } }), /学生能力信息/);
});

test('public ASR parsing keeps exact source text and hash while requiring no provider or model identity', () => {
  assert.deepEqual(parsePublicAudioReceipt(receipt, source), receipt);
  assert.equal(parsePublicAudioReceipt({ ...receipt, text: '' }, source).text, '');
  for (const patch of [{ id: messageId }, { sourceAttachmentId: messageId }, { sourceName: 'Other source.wav' }, { sourceMime: 'audio/mpeg' },
    { sourceSha256: 'b'.repeat(64) }, { sourceSha256: 'invalid' }, { provenance: 'verified_career_evidence' }, { text: '\ud800' },
    { text: 'bad\u0000text' }, { text: '中'.repeat(22000) }, { createdAt: 'invalid' }, { provider: 'faster-whisper' }, { model: 'whisper-tiny' },
    { sourceSha256: source.sha256, clientSecret: 'fictional-credential' }]) assert.throws(() => parsePublicAudioReceipt({ ...receipt, ...patch }, source), /回执/);
  assert.throws(() => parsePublicAudioReceipt(receipt, { ...source, sha256: 'not-a-hash' }));
  assert.throws(() => parsePublicAudioReceipt(receipt, { ...source, id: 'not-a-source-id' }));
});

test('UUID, source SHA and MIME validation consumes the entire string including final line breaks', () => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => studentChatRequest({ content: 'Fictional', attachmentIds: [sourceId + suffix] }));
    assert.throws(() => studentChatRequest({ content: 'Fictional', audioTranscripts: [{ receiptId: receiptId + suffix, reviewedText: 'Fictional' }] }));
    assert.throws(() => studentVoiceSessionRequest({ conversationId: conversationId + suffix }));
    assert.throws(() => studentSpeechRequest({ message_id: messageId + suffix }));
    assert.throws(() => parsePublicAudioReceipt({ ...receipt, id: receiptId + suffix }, { ...source, receiptId: undefined }));
    assert.throws(() => parsePublicAudioReceipt({ ...receipt, sourceAttachmentId: sourceId + suffix }, { ...source, id: sourceId + suffix }));
    assert.throws(() => parsePublicAudioReceipt({ ...receipt, sourceSha256: source.sha256 + suffix }, { ...source, sha256: undefined }));
    assert.throws(() => parsePublicAudioReceipt({ ...receipt, sourceSha256: source.sha256 + suffix }, { ...source, sha256: source.sha256 + suffix }));
    assert.throws(() => parsePublicAudioReceipt({ ...receipt, sourceMime: source.mime + suffix }, { ...source, mime: source.mime + suffix }));
    assert.throws(() => parsePublicCapabilities({ capabilities: unavailable, chatAttachments: { ...support, directMimeTypes: ['text/plain' + suffix] } }));
    assert.throws(() => parsePublicCapabilities({ capabilities: unavailable, chatAttachments: { ...support, audioTranscripts: { ...support.audioTranscripts, mimeTypes: ['audio/wav' + suffix] } } }));
  }
});
