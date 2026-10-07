import type { VoicePersonalityId } from './voice-personality.ts';
import type { VoiceRecordInput } from '@companion/platform-contracts';

export type RealtimeTurnStatus = 'complete' | 'unconfirmed' | 'cancelled' | 'failed' | 'incomplete' | 'truncated';
export interface RealtimeTurn {
  key: string;
  itemId: string;
  contentIndex: number;
  revision: number;
  role: 'user' | 'assistant';
  status: RealtimeTurnStatus;
  text: string;
  inputs: VoiceRecordInput[];
  voiceRoleId?: VoicePersonalityId;
}
export function realtimeTurnCanSave(turn: RealtimeTurn): boolean { return turn.status === 'complete' && turn.inputs.length > 0; }
export function realtimeTurnRecordCount(turn: RealtimeTurn): number { return Math.max(turn.inputs.length, Math.ceil(Array.from(turn.text).length / 4000)); }
export function realtimeTurnStatusText(turn: RealtimeTurn): string {
  return { complete: turn.role === 'user' ? '用户音频转写完成' : 'AI 文字生成完成，不代表音频已播放完', unconfirmed: '未收到 AI 成功完成回执，不能保存为完整摘录', cancelled: 'AI 回复已取消，不能保存为完整摘录', failed: 'AI 回复失败，不能保存为完整摘录', incomplete: 'AI 回复未完成，不能保存为完整摘录', truncated: 'AI 回复已截断；收到的文字无法精确对应已播放音频，不能保存为完整摘录' }[turn.status];
}
function eventIdentifier(value: unknown): value is string { return typeof value === 'string' && !!value && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value); }
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
// User ASR completion is independent of assistant response completion. Transcript.done
// alone also occurs for cancelled/incomplete output, so it is never a success receipt.
// Neither the event source nor its text is treated as verified model output:
// all saved records use the server's client-submitted provenance.
export class RealtimeTranscriptBuffer {
  private items: string[] = [];
  private entries = new Map<string, RealtimeTurn>();
  private previousItems = new Map<string, string | null>();
  private responses = new Map<string, Exclude<RealtimeTurnStatus, 'complete' | 'unconfirmed' | 'truncated'> | 'completed'>();
  private itemResponses = new Map<string, string>();
  private truncated = new Set<string>();
  private deleted = new Set<string>();
  private conflictingItems = new Set<string>();
  private bytes = 0;
  readonly maximumBytes = 1024 * 1024;
  readonly maximumRecords = 500;
  readonly maximumTrackedItems = 1024;
  private readonly sessionId: string;
  constructor(sessionId: string) { this.sessionId = sessionId; }
  private track(id: unknown): boolean {
    if (!eventIdentifier(id)) return false;
    if (!this.items.includes(id)) {
      if (this.items.length >= this.maximumTrackedItems) return false;
      this.items.push(id);
    }
    return true;
  }
  private associate(itemId: string, responseId: string): void {
    const previous = this.itemResponses.get(itemId);
    if (previous && previous !== responseId) this.conflictingItems.add(itemId);
    else this.itemResponses.set(itemId, responseId);
  }
  private status(itemId: string, contentIndex: number): RealtimeTurnStatus {
    if (this.truncated.has(`${itemId}:${contentIndex}`)) return 'truncated';
    if (this.conflictingItems.has(itemId)) return 'incomplete';
    const responseId = this.itemResponses.get(itemId), status = responseId ? this.responses.get(responseId) : undefined;
    return status === 'completed' ? 'complete' : status || 'unconfirmed';
  }
  private refreshAssistant(): boolean {
    let changed = false;
    for (const [key, turn] of this.entries) {
      if (turn.role !== 'assistant') continue;
      const status = this.status(turn.itemId, turn.contentIndex);
      if (status === turn.status) continue;
      this.entries.set(key, { ...turn, status, inputs: status === 'complete' ? this.inputs(turn.role, turn.text) : [] });
      changed = true;
    }
    return changed;
  }
  private inputs(role: 'user' | 'assistant', text: string): VoiceRecordInput[] {
    return splitVoiceText(text).map((part) => ({ clientRecordId: crypto.randomUUID(), source: 'realtime_transcript', role, text: part, sessionId: this.sessionId }));
  }
  receive(event: unknown): { changed: boolean; limitReached?: boolean } {
    if (!event || typeof event !== 'object') return { changed: false };
    const data = event as Record<string, any>;
    if (['conversation.item.added', 'conversation.item.created', 'input_audio_buffer.committed'].includes(data.type)) {
      const id = data.item?.id || data.item_id;
      if (typeof id === 'string') {
        if (!this.track(id) || (typeof data.previous_item_id === 'string' && data.previous_item_id.length > 256)) return { changed: false, limitReached: true };
        if (typeof data.previous_item_id === 'string' || data.previous_item_id === null) this.previousItems.set(id, data.previous_item_id);
      }
      return { changed: true };
    }
    if (data.type === 'response.done') {
      const response = data.response;
      if (!response || !eventIdentifier(response.id) || !['completed', 'cancelled', 'failed', 'incomplete'].includes(response.status)) return { changed: false };
      if (!this.responses.has(response.id) && this.responses.size >= this.maximumTrackedItems) return { changed: false, limitReached: true };
      // Validate the entire output before associating any items. A rejected receipt
      // still invalidates this response's old success; publish that downgrade before closing.
      const output: { id: string; status?: unknown }[] = [], newItems = new Set<string>();
      let invalidOutput = response.output !== undefined && (!Array.isArray(response.output) || response.output.length > this.maximumTrackedItems);
      if (!invalidOutput && Array.isArray(response.output)) for (const item of response.output) {
        if (item?.type !== 'message' || item.role !== 'assistant') continue;
        if (!eventIdentifier(item.id)) { invalidOutput = true; break; }
        output.push(item);
        if (!this.items.includes(item.id)) newItems.add(item.id);
      }
      invalidOutput ||= this.items.length + newItems.size > this.maximumTrackedItems;
      if (invalidOutput) {
        this.responses.set(response.id, 'incomplete');
        return { changed: this.refreshAssistant(), limitReached: true };
      }
      // Conflicting terminal receipts fail closed, regardless of their arrival order.
      const prior = this.responses.get(response.id);
      this.responses.set(response.id, prior && prior !== response.status ? 'incomplete' : response.status);
      for (const item of output) {
        this.track(item.id);
        this.associate(item.id, response.id);
        if (item.status !== undefined && item.status !== 'completed') this.conflictingItems.add(item.id);
      }
      return { changed: this.refreshAssistant() };
    }
    if (data.type === 'conversation.item.deleted') {
      if (!this.track(data.item_id)) return { changed: false, limitReached: true };
      this.deleted.add(data.item_id);
      let changed = false;
      for (const [key, turn] of this.entries) if (turn.itemId === data.item_id) {
        this.bytes -= new TextEncoder().encode(turn.text).byteLength;
        this.entries.delete(key); changed = true;
      }
      return { changed };
    }
    if (data.type === 'conversation.item.truncated') {
      if (!this.track(data.item_id)) return { changed: false, limitReached: true };
      if (!Number.isSafeInteger(data.content_index) || data.content_index < 0 || data.content_index > 99 || typeof data.audio_end_ms !== 'number' || !Number.isFinite(data.audio_end_ms) || data.audio_end_ms < 0) return { changed: false };
      this.truncated.add(`${data.item_id}:${data.content_index}`);
      return { changed: this.refreshAssistant() };
    }
    const role = data.type === 'conversation.item.input_audio_transcription.completed' ? 'user'
      : data.type === 'response.output_audio_transcript.done' || data.type === 'response.audio_transcript.done' ? 'assistant' : null;
    if (!role || typeof data.item_id !== 'string' || typeof data.transcript !== 'string' || !data.transcript.trim()) return { changed: false };
    if (!this.track(data.item_id)) return { changed: false, limitReached: true };
    if (this.deleted.has(data.item_id)) return { changed: false };
    if (role === 'assistant' && data.response_id !== undefined && !eventIdentifier(data.response_id)) return { changed: false };
    const contentIndex = typeof data.content_index === 'number' ? data.content_index : 0;
    if (!Number.isSafeInteger(contentIndex) || contentIndex < 0 || contentIndex > 99) return { changed: false };
    const key = `${this.sessionId}:${role}:${data.item_id}:${contentIndex}`;
    const prior = this.entries.get(key);
    if (prior?.text === data.transcript) {
      if (role === 'assistant' && data.response_id !== undefined) this.associate(data.item_id, data.response_id);
      return { changed: this.refreshAssistant() };
    }
    const parts = splitVoiceText(data.transcript);
    const nextBytes = this.bytes - (prior ? new TextEncoder().encode(prior.text).byteLength : 0) + new TextEncoder().encode(data.transcript).byteLength;
    const count = [...this.entries.values()].reduce((total, entry) => total + realtimeTurnRecordCount(entry), 0) - (prior ? realtimeTurnRecordCount(prior) : 0) + parts.length;
    if (nextBytes > this.maximumBytes || count > this.maximumRecords) return { changed: false, limitReached: true };
    if (role === 'assistant' && data.response_id !== undefined) this.associate(data.item_id, data.response_id);
    this.bytes = nextBytes;
    const status = role === 'user' ? 'complete' : this.status(data.item_id, contentIndex);
    this.entries.set(key, { key, itemId: data.item_id, contentIndex, revision: prior ? prior.revision + 1 : 0, role, status, text: data.transcript, inputs: status === 'complete' ? this.inputs(role, data.transcript) : [] });
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
