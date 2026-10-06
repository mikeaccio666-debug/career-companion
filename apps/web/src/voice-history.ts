import type { VoicePersonalityId } from './voice-personality.ts';
import type { VoiceRecordInput } from '@companion/platform-contracts';

export interface RealtimeTurn {
  key: string;
  itemId: string;
  contentIndex: number;
  revision: number;
  role: 'user' | 'assistant';
  text: string;
  inputs: VoiceRecordInput[];
  voiceRoleId?: VoicePersonalityId;
}
export function splitVoiceText(text: string, codePoints = 4000): string[] {
  if (!Number.isSafeInteger(codePoints) || codePoints <= 0) throw new RangeError('Voice excerpt chunk size must be a positive integer.');
  const points = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += codePoints) chunks.push(points.slice(index, index + codePoints).join(''));
  return chunks;
}
export function excerptInput(source: VoiceRecordInput['source'], text: string, attachmentIds: string[] = []): VoiceRecordInput {
  return { clientRecordId: crypto.randomUUID(), source, role: 'user', text, ...(attachmentIds.length ? { attachmentIds } : {}) };
}
// Only final transcript events become excerpts. Neither the event source nor its text is
// treated as verified model output: all saved records use the server's client-submitted provenance.
export class RealtimeTranscriptBuffer {
  private items: string[] = [];
  private entries = new Map<string, RealtimeTurn>();
  private previousItems = new Map<string, string | null>();
  private bytes = 0;
  readonly maximumBytes = 1024 * 1024;
  readonly maximumRecords = 500;
  readonly maximumTrackedItems = 1024;
  private readonly sessionId: string;
  constructor(sessionId: string) { this.sessionId = sessionId; }
  receive(event: unknown): { changed: boolean; limitReached?: boolean } {
    if (!event || typeof event !== 'object') return { changed: false };
    const data = event as Record<string, any>;
    if (['conversation.item.added', 'conversation.item.created', 'input_audio_buffer.committed'].includes(data.type)) {
      const id = data.item?.id || data.item_id;
      if (typeof id === 'string') {
        if (id.length > 256 || (typeof data.previous_item_id === 'string' && data.previous_item_id.length > 256)) return { changed: false, limitReached: true };
        if (!this.items.includes(id) && this.items.length >= this.maximumTrackedItems) return { changed: false, limitReached: true };
        if (!this.items.includes(id)) this.items.push(id);
        if (typeof data.previous_item_id === 'string' || data.previous_item_id === null) this.previousItems.set(id, data.previous_item_id);
      }
      return { changed: true };
    }
    const role = data.type === 'conversation.item.input_audio_transcription.completed' ? 'user'
      : data.type === 'response.output_audio_transcript.done' || data.type === 'response.audio_transcript.done' ? 'assistant' : null;
    if (!role || typeof data.item_id !== 'string' || typeof data.transcript !== 'string' || !data.transcript.trim()) return { changed: false };
    if (data.item_id.length > 256 || (!this.items.includes(data.item_id) && this.items.length >= this.maximumTrackedItems)) return { changed: false, limitReached: true };
    const contentIndex = typeof data.content_index === 'number' ? data.content_index : 0;
    if (!Number.isSafeInteger(contentIndex) || contentIndex < 0 || contentIndex > 99) return { changed: false };
    const key = `${this.sessionId}:${role}:${data.item_id}:${contentIndex}`;
    const prior = this.entries.get(key);
    if (prior?.text === data.transcript) return { changed: false };
    const parts = splitVoiceText(data.transcript);
    const nextBytes = this.bytes - (prior ? new TextEncoder().encode(prior.text).byteLength : 0) + new TextEncoder().encode(data.transcript).byteLength;
    const count = [...this.entries.values()].reduce((total, entry) => total + entry.inputs.length, 0) - (prior?.inputs.length || 0) + parts.length;
    if (nextBytes > this.maximumBytes || count > this.maximumRecords) return { changed: false, limitReached: true };
    this.bytes = nextBytes;
    this.entries.set(key, { key, itemId: data.item_id, contentIndex, revision: prior ? prior.revision + 1 : 0, role, text: data.transcript, inputs: parts.map((text) => ({ clientRecordId: crypto.randomUUID(), source: 'realtime_transcript', role, text, sessionId: this.sessionId })) });
    if (!this.items.includes(data.item_id)) this.items.push(data.item_id);
    return { changed: true };
  }
  turns(): RealtimeTurn[] {
    const ordered: string[] = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const previous = this.previousItems.get(id);
      if (previous && this.items.includes(previous)) visit(previous);
      ordered.push(id);
    };
    for (const id of this.items) visit(id);
    return [...this.entries.values()].sort((a, b) => ordered.indexOf(a.itemId) - ordered.indexOf(b.itemId) || a.contentIndex - b.contentIndex);
  }
}
export function voiceSourceLabel(source: VoiceRecordInput['source']) {
  return { realtime_transcript: '实时转写摘录', transcription_excerpt: '转写文字摘录', speech_excerpt: '朗读文本摘录' }[source];
}
export function quotedVoiceText(source: VoiceRecordInput['source'], text: string, role: 'user' | 'assistant' | 'unknown' = 'unknown'): string {
  const speaker = role === 'user' ? '用户' : role === 'assistant' ? 'AI' : '未标注说话者';
  return `以下是${voiceSourceLabel(source)}，由客户端提交，未经服务端核验（${speaker}）：\n\n${text}`;
}
