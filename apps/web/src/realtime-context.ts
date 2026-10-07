import { VOICE_CONTEXT_LIMITS } from '@companion/platform-contracts';
import type { VoiceSession } from './types.ts';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const contextFailure = () => new Error('对话上下文未能接通，实时语音已结束。可以重试，或不带历史开始。');
interface ContextItem { id: string; type: 'message'; role: 'user' | 'assistant'; content: { type: 'input_text' | 'output_text'; text: string }[]; }
export interface ContextCreateEvent { type: 'conversation.item.create'; event_id: string; previous_item_id: string; item: ContextItem; }

/** Microphone transmission waits for ordered, matching text-item completion receipts. */
export class RealtimeContextBridge {
  private readonly items: ContextItem[];
  private readonly indices: Map<string, number>;
  private cursor = 0;
  private started = false;
  private stopped = false;
  private send?: (event: ContextCreateEvent) => void;
  readonly truncated: boolean;
  constructor(session: VoiceSession, expectedConversationId?: string) {
    const context = session.serverContext;
    if (expectedConversationId === undefined) {
      if (context !== undefined) throw contextFailure();
      this.items = []; this.indices = new Map(); this.truncated = false; return;
    }
    if (!uuid(session.sessionId) || !uuid(expectedConversationId) || !context || context.source !== 'server_conversation' || context.conversationId !== expectedConversationId || !Array.isArray(context.items) || context.items.length > VOICE_CONTEXT_LIMITS.messages || typeof context.truncated !== 'boolean') throw contextFailure();
    let bytes = 0; const messageIds = new Set<string>();
    this.items = context.items.map((item, index) => {
      if (!item || !uuid(item.messageId) || messageIds.has(item.messageId) || !['user', 'assistant'].includes(item.role) || typeof item.text !== 'string' || !item.text.trim() || Array.from(item.text).length > VOICE_CONTEXT_LIMITS.messageCharacters) throw contextFailure();
      messageIds.add(item.messageId); bytes += new TextEncoder().encode(item.text).byteLength;
      if (bytes > VOICE_CONTEXT_LIMITS.textBytes) throw contextFailure();
      return { id: `voice_context_${session.sessionId}_${index}`, type: 'message', role: item.role, content: [{ type: item.role === 'user' ? 'input_text' : 'output_text', text: item.text }] };
    });
    this.indices = new Map(this.items.map((item, index) => [item.id, index]));
    this.truncated = context.truncated;
  }
  get ready(): boolean { return this.started && !this.stopped && this.cursor === this.items.length; }
  get count(): number { return this.items.length; }
  stop(): void { this.stopped = true; this.send = undefined; }
  start(send: (event: ContextCreateEvent) => void): void {
    if (this.started || this.stopped) throw contextFailure();
    this.started = true; this.send = send; this.sendNext();
  }
  private sendNext(): void {
    if (this.stopped || !this.started || this.cursor === this.items.length) return;
    const item = this.items[this.cursor];
    this.send!({ type: 'conversation.item.create', event_id: `create_${item.id}`, previous_item_id: this.cursor ? this.items[this.cursor - 1].id : 'root', item });
  }
  /** Seeded text is never newly spoken text and must stay out of excerpt saving. */
  receive(value: unknown): boolean {
    if (this.stopped || !value || typeof value !== 'object') return false;
    const event = value as Record<string, any>, id = event.item?.id ?? event.item_id;
    if (event.type === 'error' && !this.ready) throw contextFailure();
    if (typeof id !== 'string' || !this.indices.has(id)) return false;
    const index = this.indices.get(id)!;
    if (!['conversation.item.added', 'conversation.item.created', 'conversation.item.done'].includes(event.type)) {
      if (['conversation.item.deleted', 'conversation.item.truncated'].includes(event.type)) throw contextFailure();
      return true;
    }
    if (!this.started || index > this.cursor || this.cursor === 0 && index !== 0) throw contextFailure();
    const expected = this.items[index], actual = event.item;
    if (!actual || actual.type !== 'message' || actual.role !== expected.role || !Array.isArray(actual.content) || actual.content.length !== 1 || actual.content[0]?.type !== expected.content[0].type || actual.content[0]?.text !== expected.content[0].text || event.previous_item_id !== undefined && event.previous_item_id !== (index ? this.items[index - 1].id : null)) throw contextFailure();
    if (event.type === 'conversation.item.added') return true;
    if (actual.status !== 'completed') throw contextFailure();
    if (index === this.cursor) { this.cursor++; this.sendNext(); }
    return true;
  }
  forTranscript(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const event = value as Record<string, any>, id = event.item?.id ?? event.item_id;
    if (typeof id === 'string' && this.indices.has(id)) return undefined;
    if (event.type === 'response.done' && Array.isArray(event.response?.output)) {
      const output = event.response.output.filter((item: any) => !this.indices.has(item?.id));
      if (output.length !== event.response.output.length) return output.length ? { ...event, response: { ...event.response, output } } : undefined;
    }
    return value;
  }
}

interface MicrophoneTrack { enabled: boolean; }
interface BootstrapCallbacks { isCurrent(): boolean; ready(): void; failed(message: string): void; }
type Deadline = (callback: () => void) => () => void;
const connectionDeadline: Deadline = (callback) => { const timer = setTimeout(callback, 20_000); return () => clearTimeout(timer); };

/** Used by the RTC UI itself, so tests exercise the actual microphone gate and deadline. */
export class RealtimeVoiceBootstrap {
  private active = true;
  private connected = false;
  private activated = false;
  private cancelDeadline: () => void = () => {};
  private readonly bridge: RealtimeContextBridge;
  private readonly tracks: MicrophoneTrack[];
  private readonly callbacks: BootstrapCallbacks;
  constructor(bridge: RealtimeContextBridge, tracks: MicrophoneTrack[], callbacks: BootstrapCallbacks, deadline: Deadline = connectionDeadline) {
    this.bridge = bridge; this.tracks = tracks; this.callbacks = callbacks;
    this.tracks.forEach((track) => { track.enabled = false; });
    this.cancelDeadline = deadline(() => this.fail('实时语音或对话上下文连接超时。原有文字仍在，可以重试。'));
  }
  get ready(): boolean { return this.active && this.connected && this.activated && this.callbacks.isCurrent(); }
  stop(): void {
    this.active = false;
    for (const track of this.tracks) { try { track.enabled = false; } catch { /* Other owned tracks and the deadline must still be released. */ } }
    this.cancelDeadline(); this.bridge.stop();
  }
  private fail(message: string): void {
    if (!this.active) return;
    const publish = this.callbacks.isCurrent(); this.stop();
    if (publish) this.callbacks.failed(message);
  }
  private activate(): void {
    if (!this.active || this.activated || !this.connected || !this.bridge.ready) return;
    if (!this.callbacks.isCurrent()) { this.stop(); return; }
    this.activated = true; this.cancelDeadline();
    try { this.tracks.forEach((track) => { track.enabled = true; }); }
    catch { this.fail('麦克风未能开启。原有文字仍在，可以重新连接。'); return; }
    this.callbacks.ready();
  }
  channelOpened(send: (event: ContextCreateEvent) => void): void {
    if (!this.active) return;
    if (!this.callbacks.isCurrent()) { this.stop(); return; }
    try { this.bridge.start(send); this.activate(); }
    catch { this.fail(contextFailure().message); }
  }
  connectionEstablished(): void { if (this.active) { this.connected = true; this.activate(); } }
  connectionPending(): void {
    if (!this.active) return;
    this.connected = false;
    if (this.activated) this.fail('实时语音连接已变化。原有文字仍在，可以重新连接。');
  }
  receive(event: unknown): boolean {
    if (!this.active || !this.callbacks.isCurrent()) { this.stop(); return true; }
    try { const consumed = this.bridge.receive(event); this.activate(); return consumed; }
    catch { this.fail(contextFailure().message); return true; }
  }
}
