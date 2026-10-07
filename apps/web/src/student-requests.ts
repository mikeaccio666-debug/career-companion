import type { AudioTranscriptReference, Capability, PlatformFeatures, PublicAudioTranscriptionReceipt, PublicCapabilities, PublicChatAttachmentSupport } from '@companion/platform-contracts';
import { MAX_TRANSCRIPTION_AUDIO_BYTES } from './voice-transcription.ts';

/** Preparation only: App, bootstrap and the existing HTTP endpoints do not use these helpers yet.
 * The future student channel supplies content and owned record references, never runtime choices.
 * Deployment feature flags are not staff authorization or permission to override a model.
 */
export interface StudentChatRequest {
  content: string;
  attachmentIds?: string[];
  audioTranscripts?: AudioTranscriptReference[];
}
export interface StudentVoiceSessionRequest { conversationId?: string; }
/** docs/product/12 §5.1: the server reads the owned message; arbitrary speech text is not accepted. */
export interface StudentSpeechRequest { message_id: string; }
export interface PublicAudioReceiptExpectation { id: string; name: string; mime: string; sha256?: string; receiptId?: string; }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/;
const mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
// JavaScript's $ may match before a final line break; identifiers require every byte.
const fullMatch = (pattern: RegExp, value: string): boolean => pattern.exec(value)?.[0] === value;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const capabilityKeys = ['chat', 'agent', 'image', 'video', 'speech', 'transcription', 'realtime', 'browser', 'cli', 'workflow', 'mcp'] as const satisfies readonly Capability[];
const invalidRequest = () => new Error('这项学生请求包含不支持的字段或无效内容。');
const invalidResponse = () => new Error('服务没有返回有效的学生能力信息，请重试。');
const invalidReceipt = () => new Error('无法核对这份音频转写回执。请保留原音频并读取已保存结果。');

/** Accept JSON data only; inherited overrides, accessors and toJSON cannot enter serialization. */
function record(value: unknown, keys: readonly string[], invalid: () => Error): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, nonempty = true): value is string {
  if (typeof value !== 'string' || value.length > maximum || nonempty && !value.trim() || controls.test(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function identifier(value: unknown, invalid = invalidRequest): string {
  if (typeof value !== 'string' || !fullMatch(uuid, value)) throw invalid();
  return value;
}
function unique(values: string[]): boolean { return new Set(values.map(value => value.toLowerCase())).size === values.length; }

export function studentChatRequest(value: StudentChatRequest): StudentChatRequest {
  const input = record(value, ['content', 'attachmentIds', 'audioTranscripts'], invalidRequest);
  if (!text(input.content, 20_000)) throw invalidRequest();
  const result: StudentChatRequest = { content: input.content };
  if (input.attachmentIds !== undefined) {
    if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > 10) throw invalidRequest();
    const ids = Array.from(input.attachmentIds, id => identifier(id));
    if (!unique(ids)) throw invalidRequest();
    result.attachmentIds = ids;
  }
  if (input.audioTranscripts !== undefined) {
    if (!Array.isArray(input.audioTranscripts) || input.audioTranscripts.length > 2) throw invalidRequest();
    const references = Array.from(input.audioTranscripts, value => {
      const reference = record(value, ['receiptId', 'reviewedText'], invalidRequest);
      if (!text(reference.reviewedText, 8_000)) throw invalidRequest();
      return { receiptId: identifier(reference.receiptId), reviewedText: reference.reviewedText };
    });
    if (!unique(references.map(reference => reference.receiptId))) throw invalidRequest();
    result.audioTranscripts = references;
  }
  return result;
}
export function studentVoiceSessionRequest(value: StudentVoiceSessionRequest = {}): StudentVoiceSessionRequest {
  const input = record(value, ['conversationId'], invalidRequest);
  return input.conversationId === undefined ? {} : { conversationId: identifier(input.conversationId) };
}
export function studentSpeechRequest(value: StudentSpeechRequest): StudentSpeechRequest {
  const input = record(value, ['message_id'], invalidRequest);
  return { message_id: identifier(input.message_id) };
}

const audioExtensions: Record<string, string> = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };
const inferredAudioTypes: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' };
const canonicalAudioTypes: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'video/webm': 'audio/webm', 'audio/m4a': 'audio/mp4', 'audio/x-m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg', 'audio/x-flac': 'audio/flac' };
/** Browser-owned multipart boundary; the original filename and provider fields never travel. */
export function studentTranscriptionForm(audio: Blob): FormData {
  if (!(audio instanceof Blob) || !audio.size || audio.size > MAX_TRANSCRIPTION_AUDIO_BYTES) throw invalidRequest();
  let mime = audio.type.split(';')[0].trim().toLowerCase();
  if (!mime && audio instanceof File) {
    const extension = audio.name.split('.').pop()?.toLowerCase() || '';
    mime = Object.hasOwn(inferredAudioTypes, extension) ? inferredAudioTypes[extension] : '';
  }
  if (Object.hasOwn(canonicalAudioTypes, mime)) mime = canonicalAudioTypes[mime];
  if (!Object.hasOwn(audioExtensions, mime)) throw invalidRequest();
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `recording.${audioExtensions[mime]}`);
  return form;
}

export function parsePlatformFeatures(value: unknown): PlatformFeatures {
  const input = record(value, ['version', 'workbench', 'providerDetails'], invalidResponse);
  if (input.version !== 1 || typeof input.workbench !== 'boolean' || typeof input.providerDetails !== 'boolean' || input.providerDetails && !input.workbench) throw invalidResponse();
  return { version: 1, workbench: input.workbench, providerDetails: input.providerDetails };
}
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function mimes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) throw invalidResponse();
  const result = Array.from(value, mime => {
    if (typeof mime !== 'string' || mime.length > 150 || !fullMatch(mimeType, mime)) throw invalidResponse();
    return mime;
  });
  if (!unique(result)) throw invalidResponse();
  return result;
}
function publicAttachmentSupport(value: unknown): PublicChatAttachmentSupport {
  const support = record(value, ['directMimeTypes', 'maxAttachments', 'maxTotalBytes', 'audioTranscripts'], invalidResponse);
  const audio = record(support.audioTranscripts, ['mimeTypes', 'maxAudioBytes', 'maxDurationSeconds', 'maxPerMessage', 'maxReviewedCharacters', 'available', 'reviewRequired'], invalidResponse);
  if (!positiveInteger(support.maxAttachments) || support.maxAttachments > 10 || !positiveInteger(support.maxTotalBytes)
    || !positiveInteger(audio.maxAudioBytes) || !positiveInteger(audio.maxDurationSeconds) || !positiveInteger(audio.maxPerMessage) || audio.maxPerMessage > 2
    || !positiveInteger(audio.maxReviewedCharacters) || audio.maxReviewedCharacters > 8_000 || typeof audio.available !== 'boolean' || audio.reviewRequired !== true) throw invalidResponse();
  return { directMimeTypes: mimes(support.directMimeTypes), maxAttachments: support.maxAttachments, maxTotalBytes: support.maxTotalBytes,
    audioTranscripts: { mimeTypes: mimes(audio.mimeTypes), maxAudioBytes: audio.maxAudioBytes, maxDurationSeconds: audio.maxDurationSeconds,
      maxPerMessage: audio.maxPerMessage, maxReviewedCharacters: audio.maxReviewedCharacters, available: audio.available, reviewRequired: true } };
}
/** A missing capability is an invalid response, never an invented false or a fake ProviderStatus. */
export function parsePublicCapabilities(value: unknown): PublicCapabilities {
  const input = record(value, ['capabilities', 'chatAttachments'], invalidResponse);
  const source = record(input.capabilities, capabilityKeys, invalidResponse);
  const capabilities = Object.fromEntries(capabilityKeys.map(capability => {
    if (typeof source[capability] !== 'boolean') throw invalidResponse();
    return [capability, source[capability]];
  })) as Record<Capability, boolean>;
  return { capabilities, ...(input.chatAttachments === undefined ? {} : { chatAttachments: publicAttachmentSupport(input.chatAttachments) }) };
}

/** Public projection verifies source identity and untrusted provenance, never an ASR model ID. */
export function parsePublicAudioReceipt(value: unknown, expectation: PublicAudioReceiptExpectation): PublicAudioTranscriptionReceipt {
  const source = record(expectation, ['id', 'name', 'mime', 'sha256', 'receiptId'], invalidReceipt);
  identifier(source.id, invalidReceipt);
  if (!text(source.name, 255) || typeof source.mime !== 'string' || !fullMatch(mimeType, source.mime)
    || source.sha256 !== undefined && (typeof source.sha256 !== 'string' || !fullMatch(sha256, source.sha256))) throw invalidReceipt();
  if (source.receiptId !== undefined) identifier(source.receiptId, invalidReceipt);
  const receipt = record(value, ['id', 'sourceAttachmentId', 'sourceName', 'sourceMime', 'sourceSha256', 'text', 'provenance', 'createdAt'], invalidReceipt);
  const id = identifier(receipt.id, invalidReceipt);
  if (receipt.sourceAttachmentId !== source.id || receipt.sourceName !== source.name || receipt.sourceMime !== source.mime
    || typeof receipt.sourceSha256 !== 'string' || !fullMatch(sha256, receipt.sourceSha256) || source.sha256 !== undefined && receipt.sourceSha256 !== source.sha256
    || source.receiptId !== undefined && id !== source.receiptId || receipt.provenance !== 'untrusted_audio_transcript'
    || !text(receipt.text, 64 * 1024, false) || new TextEncoder().encode(receipt.text).byteLength > 64 * 1024
    || typeof receipt.createdAt !== 'string' || !Number.isFinite(Date.parse(receipt.createdAt))) throw invalidReceipt();
  return { id, sourceAttachmentId: source.id as string, sourceName: source.name, sourceMime: source.mime,
    sourceSha256: receipt.sourceSha256, text: receipt.text, provenance: 'untrusted_audio_transcript', createdAt: receipt.createdAt };
}
