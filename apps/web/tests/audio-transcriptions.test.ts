import assert from 'node:assert/strict';
import test from 'node:test';
import type { Attachment, AudioTranscriptionReceipt, ChatAttachmentSupport, ProviderStatus } from '@companion/platform-contracts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { ApiError, createPlatformClient } from '../src/api.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { createAudioTranscriptionClient, parseAudioReceipt } from '../src/audio-transcriptions-api.ts';
import { AudioTranscriptionController, reviewedAudioTextValid } from '../src/audio-transcriptions-controller.ts';
import { assessChatAttachments } from '../src/chat-attachments.ts';

const sourceId = '10000000-0000-4000-8000-000000000001', requestId = '20000000-0000-4000-8000-000000000001', receiptId = '30000000-0000-4000-8000-000000000001';
const source: Attachment = { id: sourceId, name: 'fictional-practice.wav', mime: 'audio/wav', size: 1200, url: `/api/platform/uploads/${sourceId}` };
const receipt: AudioTranscriptionReceipt = { id: receiptId, sourceAttachmentId: sourceId, sourceName: source.name, sourceMime: source.mime, sourceSha256: 'a'.repeat(64), provider: 'faster-whisper', model: 'whisper-tiny', text: 'Fictional interview practice.', provenance: 'untrusted_audio_transcript', createdAt: '2026-10-06T20:00:00Z' };
const support: ChatAttachmentSupport = { directMimeTypes: ['text/plain', 'image/png', 'application/pdf'], maxAttachments: 8, maxTotalBytes: 25 * 1024 * 1024, audioTranscripts: { mimeTypes: ['audio/wav', 'audio/mpeg'], provider: 'faster-whisper', model: 'whisper-tiny', maxAudioBytes: 20 * 1024 * 1024, maxDurationSeconds: 120, maxPerMessage: 2, maxReviewedCharacters: 8000, available: true, reviewRequired: true } };
const provider: ProviderStatus = { id: 'fictional-local-chat', name: 'Fictional local chat', enabled: true, keyConfigured: true, capabilities: ['chat'], models: [], envVariables: [], chatAttachments: support };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const calls: Array<{ method: string; signal: AbortSignal; id: string }> = [];
  const creations: Array<ReturnType<typeof deferred<AudioTranscriptionReceipt>>> = [], recoveries: Array<ReturnType<typeof deferred<AudioTranscriptionReceipt>>> = [];
  let current = true, online = true;
  const controller = new AudioTranscriptionController({ create: async (_source, id, signal) => { calls.push({ method: 'POST', signal, id }); const work = deferred<AudioTranscriptionReceipt>(); creations.push(work); return work.promise; }, recover: async (_source, id, signal) => { calls.push({ method: 'GET', signal, id }); const work = deferred<AudioTranscriptionReceipt>(); recoveries.push(work); return work.promise; } }, { isCurrent: () => current, isOnline: () => online, requestId: () => requestId });
  controller.start(); controller.setSources([source]);
  return { controller, calls, creations, recoveries, changeAccount: () => { current = false; }, offline: () => { online = false; } };
}

test('receipt parsing requires exact source, hash, local provenance and a bounded real ASR result', () => {
  assert.deepEqual(parseAudioReceipt(receipt, source), receipt);
  for (const patch of [{ sourceAttachmentId: requestId }, { sourceName: 'other.wav' }, { sourceMime: 'audio/mpeg' }, { sourceSha256: 'invalid' }, { provider: 'paid-service' }, { model: 'other-model' }, { provenance: 'verified_career_evidence' }, { text: 'x'.repeat(65537) }, { createdAt: 'invalid' }]) assert.throws(() => parseAudioReceipt({ ...receipt, ...patch }, source), /回执/);
  assert.throws(() => parseAudioReceipt(receipt, { ...source, sha256: 'b'.repeat(64) }), /回执/);
  assert.throws(() => parseAudioReceipt(receipt, { ...source, receiptId: requestId }), /回执/);
});

test('bound API sends one idempotency key and recovery/history are GET-only, even while ASR unavailable', async () => {
  const context = new AccountRequestContext(); context.changeSession(sourceId);
  const calls: Array<{ path: string; method: string; body: unknown; account: string | null }> = [];
  const client = createPlatformClient(createPlatformEndpoints(), async (path, init) => { calls.push({ path: String(path), method: init?.method || 'GET', body: init?.body, account: new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER) }); return Response.json({ receipt, created: true }); }, context).capture(context.capture()!);
  const api = createAudioTranscriptionClient(client.request), signal = new AbortController().signal;
  await api.create(source, requestId, signal); await api.recover(source, requestId, signal); await api.readReceipt({ ...source, receiptId, sha256: receipt.sourceSha256 }, signal);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'GET']);
  assert.deepEqual(JSON.parse(String(calls[0].body)), { clientRequestId: requestId });
  assert.equal(calls[0].path, `/api/platform/uploads/${sourceId}/transcriptions`); assert.equal(calls[1].path, `/api/platform/uploads/${sourceId}/transcriptions/${requestId}`); assert.equal(calls[2].path, `/api/platform/audio-transcriptions/${receiptId}`);
  // All requests use the immutable captured account header, not a later global user.
  assert.ok(calls.every((call) => call.account === sourceId));
  context.changeSession(requestId); await assert.rejects(api.recover(source, requestId, signal), { name: 'AbortError' }); assert.equal(calls.length, 3);
});

test('audio cannot be sent before real transcription and explicit review; editing clears review', async () => {
  const f = fixture();
  assert.ok(assessChatAttachments([source], provider, f.controller.getSnapshot()).issues.length);
  const pending = f.controller.transcribe(sourceId, support.audioTranscripts); f.creations[0].resolve(receipt); await pending;
  assert.equal(f.controller.getSnapshot().entries[sourceId].reviewed, false);
  assert.ok(assessChatAttachments([source], provider, f.controller.getSnapshot()).issues.length);
  f.controller.review(sourceId, true, 8000);
  let assessment = assessChatAttachments([source], provider, f.controller.getSnapshot());
  assert.deepEqual(assessment.issues, []); assert.deepEqual(assessment.audioTranscripts, [{ receiptId, reviewedText: receipt.text }]); assert.equal(assessment.reviewedAudio[0].textModified, false); assert.equal(assessment.reviewedAudio[0].sourceAttachmentId, sourceId);
  f.controller.edit(sourceId, 'My fictional edited practice.');
  assert.equal(f.controller.getSnapshot().entries[sourceId].reviewed, false); assert.ok(assessChatAttachments([source], provider, f.controller.getSnapshot()).issues.length);
  f.controller.review(sourceId, true, 8000); assessment = assessChatAttachments([source], provider, f.controller.getSnapshot());
  assert.equal(assessment.reviewedAudio[0].textModified, true); assert.equal(assessment.reviewedAudio[0].text, 'My fictional edited practice.'); assert.equal(f.controller.getSnapshot().entries[sourceId].receipt?.text, receipt.text);
  assert.deepEqual(assessChatAttachments([], provider, f.controller.getSnapshot()).audioTranscripts, []);
});

test('lost POST response preserves key and GET 404 remains uncertain without replaying ASR', async () => {
  const f = fixture(), pending = f.controller.transcribe(sourceId, support.audioTranscripts);
  f.creations[0].reject(new ApiError('Connection lost')); await pending;
  assert.equal(f.controller.getSnapshot().entries[sourceId].phase, 'uncertain'); assert.equal(f.controller.getSnapshot().entries[sourceId].clientRequestId, requestId);
  await f.controller.transcribe(sourceId, support.audioTranscripts); assert.equal(f.calls.length, 1);
  const recovery = f.controller.recover(sourceId); f.recoveries[0].reject(new ApiError('No completed receipt', 404)); await recovery;
  assert.equal(f.controller.getSnapshot().entries[sourceId].phase, 'uncertain'); assert.match(f.controller.getSnapshot().entries[sourceId].error, /不证明原请求已停止/);
  const second = f.controller.recover(sourceId); f.recoveries[1].resolve(receipt); await second;
  assert.equal(f.controller.getSnapshot().entries[sourceId].phase, 'complete'); assert.deepEqual(f.calls.map((call) => call.method), ['POST', 'GET', 'GET']); assert.ok(f.calls.every((call) => call.id === requestId));
});

test('canceling ignores late POST result and preserves key for read-only recovery', async () => {
  const f = fixture(), pending = f.controller.transcribe(sourceId, support.audioTranscripts);
  f.controller.cancel(sourceId); assert.equal(f.calls[0].signal.aborted, true);
  f.creations[0].resolve(receipt); await pending;
  assert.equal(f.controller.getSnapshot().entries[sourceId].phase, 'uncertain'); assert.equal(f.controller.getSnapshot().entries[sourceId].receipt, undefined);
  const recovery = f.controller.recover(sourceId); f.recoveries[0].resolve(receipt); await recovery; assert.equal(f.controller.getSnapshot().entries[sourceId].phase, 'complete');
});

test('removal, changed source, conversation navigation and unmount discard late receipts', async () => {
  for (const action of ['remove', 'replace', 'navigate', 'unmount'] as const) {
    const f = fixture(), pending = f.controller.transcribe(sourceId, support.audioTranscripts);
    if (action === 'remove') f.controller.remove(sourceId);
    if (action === 'replace') f.controller.setSources([{ ...source, name: 'different-fictional.wav' }]);
    if (action === 'navigate') f.controller.invalidateContext();
    if (action === 'unmount') f.controller.stop();
    assert.equal(f.calls[0].signal.aborted, true); f.creations[0].resolve(receipt); await pending;
    assert.equal(f.controller.getSnapshot().entries[sourceId]?.receipt, undefined);
    if (action === 'navigate') { assert.equal(f.controller.getSnapshot().entries[sourceId].clientRequestId, requestId); assert.equal(f.controller.getSnapshot().entries[sourceId].phase, 'uncertain'); }
    if (action === 'unmount') { f.controller.start(); assert.equal(f.controller.getSnapshot().entries[sourceId].phase, 'uncertain'); assert.equal(f.controller.getSnapshot().entries[sourceId].clientRequestId, requestId); }
  }
});

test('same-account new generation invalidates transport and masks stale review state', async () => {
  const context = new AccountRequestContext(); context.changeSession(sourceId);
  const network = deferred<Response>(); let signal: AbortSignal | null | undefined;
  const bound = createPlatformClient(createPlatformEndpoints(), async (_path, init) => { signal = init?.signal; return network.promise; }, context).capture(context.capture()!);
  const controller = new AudioTranscriptionController(createAudioTranscriptionClient(bound.request), { isCurrent: bound.isCurrent, subscribe: bound.subscribe, isOnline: () => true, requestId: () => requestId });
  controller.start(); controller.setSources([source]);
  const pending = controller.transcribe(sourceId, support.audioTranscripts); context.changeSession(sourceId); assert.equal(signal?.aborted, true);
  network.resolve(Response.json({ receipt, created: true })); await pending;
  assert.deepEqual(controller.getSnapshot().entries, {});
  await controller.recover(sourceId); assert.deepEqual(controller.getSnapshot().entries, {});
});

test('ASR off prevents new requests but completed receipts remain reviewable and sendable', async () => {
  const f = fixture(), off = { ...support.audioTranscripts, available: false };
  await f.controller.transcribe(sourceId, off); assert.equal(f.calls.length, 0);
  const pending = f.controller.transcribe(sourceId, support.audioTranscripts); f.creations[0].resolve(receipt); await pending;
  f.controller.edit(sourceId, 'Edited fictional transcript while ASR is off.'); f.controller.review(sourceId, true, off.maxReviewedCharacters);
  const assessment = assessChatAttachments([source], { ...provider, chatAttachments: { ...support, audioTranscripts: off } }, f.controller.getSnapshot());
  assert.deepEqual(assessment.issues, []); assert.equal(assessment.audioTranscripts.length, 1); assert.equal(f.calls.length, 1);
});

test('capability/size/count limits and source mismatch fail closed, while declared image/text/PDF remain supported', async () => {
  const f = fixture(), pending = f.controller.transcribe(sourceId, support.audioTranscripts); f.creations[0].resolve(receipt); await pending; f.controller.review(sourceId, true, 8000);
  assert.ok(assessChatAttachments([source], { ...provider, chatAttachments: undefined }, f.controller.getSnapshot()).issues.length);
  assert.ok(assessChatAttachments([{ ...source, name: 'wrong-source.wav' }], provider, f.controller.getSnapshot()).issues.length);
  assert.ok(assessChatAttachments([{ ...source, size: 21 * 1024 * 1024 }], provider, f.controller.getSnapshot()).issues.length);
  const files = ['image/png', 'text/plain', 'application/pdf'].map((mime, index) => ({ ...source, id: `fictional-${index}`, name: `fictional-${index}`, mime }));
  assert.deepEqual(assessChatAttachments(files, provider, f.controller.getSnapshot()).issues, []);
  assert.ok(assessChatAttachments([{ ...source, mime: 'video/mp4' }], provider, f.controller.getSnapshot()).issues.some((message) => message.includes('视频')));
  assert.ok(assessChatAttachments([{ ...source, mime: 'application/zip' }], provider, f.controller.getSnapshot()).issues.length);
  assert.ok(assessChatAttachments(Array.from({ length: 9 }, (_, index) => ({ ...files[1], id: `fictional-${index}` })), provider, f.controller.getSnapshot()).issues.some((message) => message.includes('最多 8')));
  assert.ok(assessChatAttachments([{ ...files[1], size: 26 * 1024 * 1024 }], provider, f.controller.getSnapshot()).issues.some((message) => message.includes('合计')));
  assert.ok(assessChatAttachments([source, { ...source, id: requestId }, { ...source, id: receiptId }], provider, f.controller.getSnapshot()).issues.some((message) => message.includes('最多审阅 2')));
  f.controller.edit(sourceId, 'x'.repeat(8001)); f.controller.review(sourceId, true, 8000); assert.equal(f.controller.getSnapshot().entries[sourceId].reviewed, false);
});

test('review requires nonempty bounded safe text and offline actions make no requests', async () => {
  for (const text of ['', '   ', 'x'.repeat(8001), 'text\u0000', 'unpaired\ud800']) assert.equal(reviewedAudioTextValid(text, 8000), false);
  assert.equal(reviewedAudioTextValid('A fictional answer.\nTwo lines 🙂', 8000), true);
  const f = fixture(); f.offline(); await f.controller.transcribe(sourceId, support.audioTranscripts); assert.equal(f.calls.length, 0); assert.equal(f.controller.getSnapshot().entries[sourceId].clientRequestId, undefined);
});
