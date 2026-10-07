import type { Attachment, AudioTranscriptionReceipt } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export type AudioSource = Pick<Attachment, 'id' | 'name' | 'mime' | 'size'>;
export interface ReceiptExpectation { id: string; name: string; mime: string; sha256?: string; receiptId?: string; }
const invalid = () => new Error('无法核对这份音频转写回执。请保留原音频并读取已保存结果。');
function identifier(value: string) { if (!uuid.test(value)) throw invalid(); return encodeURIComponent(value); }
export function parseAudioReceipt(value: unknown, source: ReceiptExpectation): AudioTranscriptionReceipt {
  if (!object(value) || typeof value.id !== 'string' || !uuid.test(value.id) || value.sourceAttachmentId !== source.id || value.sourceName !== source.name || value.sourceMime !== source.mime || typeof value.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sourceSha256) || source.sha256 && value.sourceSha256 !== source.sha256 || source.receiptId && value.id !== source.receiptId || value.provider !== 'faster-whisper' || value.model !== 'whisper-tiny' || value.provenance !== 'untrusted_audio_transcript' || typeof value.text !== 'string' || new TextEncoder().encode(value.text).byteLength > 64 * 1024 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw invalid();
  return { id: value.id, sourceAttachmentId: source.id, sourceName: source.name, sourceMime: source.mime, sourceSha256: value.sourceSha256, provider: 'faster-whisper', model: 'whisper-tiny', text: value.text, provenance: 'untrusted_audio_transcript', createdAt: value.createdAt };
}
/** The transport is the caller's immutable account capture; no late global account lookup. */
export function createAudioTranscriptionClient(request: BoundPlatformClient['request']) {
  const result = (value: unknown, source: ReceiptExpectation) => { if (!object(value)) throw invalid(); return parseAudioReceipt(value.receipt, source); };
  return {
    async create(source: AudioSource, clientRequestId: string, signal: AbortSignal) {
      const value = await request<unknown>(`/uploads/${identifier(source.id)}/transcriptions`, { method: 'POST', body: JSON.stringify({ clientRequestId: decodeURIComponent(identifier(clientRequestId)) }), signal });
      if (!object(value) || typeof value.created !== 'boolean') throw invalid();
      return result(value, source);
    },
    async recover(source: AudioSource, clientRequestId: string, signal: AbortSignal) {
      return result(await request<unknown>(`/uploads/${identifier(source.id)}/transcriptions/${identifier(clientRequestId)}`, { signal }), source);
    },
    async readReceipt(source: ReceiptExpectation, signal: AbortSignal) {
      if (!source.receiptId) throw invalid();
      return result(await request<unknown>(`/audio-transcriptions/${identifier(source.receiptId)}`, { signal }), source);
    },
  };
}
export type AudioTranscriptionClient = ReturnType<typeof createAudioTranscriptionClient>;
