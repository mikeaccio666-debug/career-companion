import type { StreamEvent } from './api.ts';
import type { Artifact, Conversation, Provider } from './types.ts';
import { voiceAudioConfiguration, voicePersonalityId, voicePersona, voiceSpeechBody, type VoiceAudioConfiguration, type VoicePersonalityId } from './voice-personality.ts';

export type VoiceConversationStage = 'idle' | 'preparing' | 'answering' | 'complete' | 'failed' | 'cancelled' | 'speaking';
export interface VoiceConversationSnapshot {
  stage: VoiceConversationStage;
  question: string;
  answer: string;
  conversationId: string | null;
  messageId: string | null;
  complete: boolean;
  dispatched: boolean;
  error: string;
  speechError: string;
  audio: Artifact | null;
  roleId: VoicePersonalityId | null;
  audioConfiguration: VoiceAudioConfiguration | null;
}
export interface VoiceConversationTransport {
  streamMessage(id: string, body: unknown, signal: AbortSignal, onEvent: (event: StreamEvent) => void): Promise<void>;
  request(path: string, init: RequestInit): Promise<unknown>;
}
const empty = (): VoiceConversationSnapshot => ({ stage: 'idle', question: '', answer: '', conversationId: null, messageId: null, complete: false, dispatched: false, error: '', speechError: '', audio: null, roleId: null, audioConfiguration: null });
const privateAudio = /^\/api\/platform\/(?:uploads|artifacts)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function safeText(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length <= maximum && !controlCharacters.test(value); }
function aborted(): never { throw new DOMException('语音回合已停止。', 'AbortError'); }

export function voiceConversationModels(provider?: Provider): string[] {
  const source = provider?.modelsByCapability ? provider.modelsByCapability.chat : provider?.models;
  return [...new Set((source || []).filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 150))];
}
export function voiceConversationProviderReady(provider: Provider | undefined, capability: 'chat' | 'transcription' | 'speech' | 'realtime'): boolean {
  return !!provider && provider.keyConfigured === true && provider.enabled === true && provider.capabilities.includes(capability);
}
/** A retained choice is never silently replaced after a catalog refresh. */
export function selectedConversationProvider(providers: Provider[], capability: 'chat' | 'transcription' | 'speech' | 'realtime', retained = ''): string {
  return retained || providers.find((entry) => voiceConversationProviderReady(entry, capability))?.id || providers.find((entry) => entry.capabilities.includes(capability))?.id || '';
}
export function voiceAnswerSpeechProblem(answer: string, provider?: Provider): string {
  if (!voiceConversationProviderReady(provider, 'speech')) return '请选择已配置并启用的朗读服务。';
  if (!answer.trim()) return '收到完整回答后，可以生成朗读。';
  if (answer.length > 4000) return '这次回答超过朗读的 4,000 字上限；文字已保留，可以在对话中选择需要朗读的部分。';
  if (provider?.id === 'kokoro' && Array.from(answer).some((character) => /\p{Letter}/u.test(character) && !/\p{Script=Latin}/u.test(character))) return 'Kokoro 目前只支持英语朗读。这次回答包含其他语言，文字已保留；可以选择另一个已配置的朗读服务。';
  return '';
}

/** One reviewed message becomes one ordinary conversation turn; it never authorizes tools. */
export class VoiceConversationSession {
  private snapshot = empty();
  private listeners = new Set<() => void>();
  private current = () => false;
  private epoch = 0;
  private operation: AbortController | null = null;
  private lastDispatch: { conversationId: string; text: string } | null = null;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<VoiceConversationSnapshot>) { this.snapshot = { ...this.snapshot, ...change }; for (const listener of this.listeners) listener(); }
  activate(current: () => boolean) { this.current = current; this.epoch++; }
  deactivate() {
    this.epoch++; this.current = () => false;
    const pending = this.operation; this.operation = null; pending?.abort();
    if (['preparing', 'answering'].includes(this.snapshot.stage)) this.update({ stage: 'cancelled', error: this.snapshot.dispatched ? '已停止等待回答。请查看会话中的保存结果，未自动再次发送。' : '这轮准备已停止，尚未发送问题。' });
    else if (this.snapshot.stage === 'speaking') this.update({ stage: 'complete', speechError: '朗读生成已停止；完整回答仍在会话中。' });
  }
  clear() { this.deactivate(); this.lastDispatch = null; this.snapshot = empty(); for (const listener of this.listeners) listener(); }
  cancel() { this.operation?.abort(); }
  busy() { return !!this.operation; }
  alreadySent(text: string, conversationId?: string | null) { return !!this.lastDispatch && this.lastDispatch.text === text.trim() && (!conversationId || this.lastDispatch.conversationId === conversationId); }

  async answer(input: { text: string; roleId?: VoicePersonalityId; provider?: Provider; model: string; conversation?: Conversation; ensureConversation: () => Promise<string>; onConversationChanged?: (id: string) => void }, transport: VoiceConversationTransport): Promise<void> {
    if (!this.current()) aborted();
    if (this.operation) throw new Error('请先结束当前语音回合。');
    if (input.conversation?.mode === 'agent') throw new Error('请为语音交流开启普通或陪伴会话，再审阅并发送问题。');
    const question = input.text.trim();
    if (!safeText(question, 8000) || !question) throw new Error('请先审阅这轮问题，最多 8,000 字。');
    if (!voiceConversationProviderReady(input.provider, 'chat') || !voiceConversationModels(input.provider).includes(input.model)) throw new Error('请选择已配置的对话服务和对应模型。');
    if (this.alreadySent(question, input.conversation?.id)) throw new Error('这段问题已经发送过。请查看会话中的保存结果；没有自动重发。');
    const controller = new AbortController(), epoch = this.epoch;
    this.operation = controller;
    const active = () => this.current() && this.epoch === epoch && this.operation === controller;
    const check = () => { if (!active() || controller.signal.aborted) aborted(); };
    const roleId = voicePersonalityId(input.roleId), persona = voicePersona(roleId);
    this.update({ ...empty(), stage: 'preparing', question, roleId });
    let target: string | null = null;
    let completed: { id: string; content: string } | null = null;
    try {
      target = input.conversation?.id || await input.ensureConversation(); check();
      if (!target || target.length > 100) throw new Error('会话尚未准备好，请重新选择会话。');
      this.lastDispatch = { conversationId: target, text: question };
      this.update({ conversationId: target, stage: 'answering', dispatched: true });
      await transport.streamMessage(target, { content: question, mode: input.conversation?.mode === 'companion' ? 'companion' : 'chat', provider: input.provider!.id, model: input.model, attachmentIds: [], persona }, controller.signal, ({ event, data }) => {
        check();
        if (event === 'start') {
          if (typeof data?.messageId !== 'string' || !data.messageId || data.messageId.length > 100 || this.snapshot.messageId && this.snapshot.messageId !== data.messageId) throw new Error('回答的会话记录不一致，请查看已保存的会话。');
          this.update({ messageId: data.messageId });
        } else if (event === 'delta') {
          if (!safeText(data?.text, 150000) || this.snapshot.answer.length + data.text.length > 150000) throw new Error('回答超过本页限制或格式无效。请查看已保存的会话。');
          this.update({ answer: this.snapshot.answer + data.text });
        } else if (event === 'done') {
          const message = data?.message;
          if (!this.snapshot.messageId || message?.id !== this.snapshot.messageId || message.conversationId !== target || message.role !== 'assistant' || message.status !== 'complete' || !safeText(message.content, 150000)) throw new Error('未收到完整的保存记录，请查看会话结果。');
          completed = { id: message.id, content: message.content };
          this.update({ answer: message.content, complete: true, stage: 'complete' });
        } else if (event === 'error') throw new Error(safeText(data?.message, 2000) ? data.message : '回答未完成，请查看会话中的保存结果。');
        else if (event === 'tool' || event === 'approval') throw new Error('语音交流不执行外部操作，这轮回答已停止。');
      });
      if (!active()) return;
      if (!completed) throw new Error('连接结束时没有确认完整回答。请查看已保存的会话，未自动再次发送。');
    } catch (error) {
      if (!active()) return;
      controller.abort();
      if (completed) this.update({ stage: 'complete', complete: true, error: '' });
      else this.update({ stage: controller.signal.reason?.name === 'AbortError' && error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed', complete: false, error: error instanceof Error ? error.message : '回答未完成，请查看会话中的保存结果。' });
    } finally {
      if (active()) { this.operation = null; this.update({}); if (target && this.snapshot.dispatched) input.onConversationChanged?.(target); }
    }
  }

  async speak(provider: Provider | undefined, transport: VoiceConversationTransport, retainedVoice = ''): Promise<void> {
    if (!this.current()) aborted();
    if (this.operation) throw new Error('请先结束当前语音回合。');
    if (!this.snapshot.complete) throw new Error('只有完整回答可以生成朗读。');
    const problem = voiceAnswerSpeechProblem(this.snapshot.answer, provider); if (problem) throw new Error(problem);
    const roleId = this.snapshot.roleId || 'warm';
    const body = voiceSpeechBody(provider!, this.snapshot.answer, roleId, retainedVoice);
    const audioConfiguration = voiceAudioConfiguration(provider!, roleId, retainedVoice);
    const controller = new AbortController(), epoch = this.epoch, answer = this.snapshot.answer;
    this.operation = controller;
    const active = () => this.current() && this.epoch === epoch && this.operation === controller;
    this.update({ stage: 'speaking', speechError: '' });
    try {
      const response = await transport.request('/voice/speech', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (!active() || controller.signal.aborted) aborted();
      const value = response && typeof response === 'object' && 'attachment' in response ? (response as { attachment: unknown }).attachment : response;
      const audio = value as Partial<Artifact> | null;
      if (!audio || typeof audio.id !== 'string' || !safeText(audio.name, 255) || !['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/mp4', 'audio/flac'].includes(audio.mime || '') || typeof audio.url !== 'string' || !privateAudio.test(audio.url)) throw new Error('朗读服务没有返回有效的私人音频，文字回答已保留。');
      this.update({ stage: 'complete', audio: { id: audio.id, name: audio.name, mime: audio.mime!, url: audio.url }, audioConfiguration, speechError: '' });
    } catch (error) {
      if (active()) this.update({ stage: 'complete', speechError: controller.signal.aborted ? '朗读生成已停止；完整回答仍在会话中。' : error instanceof Error ? error.message : '朗读未完成，文字回答已保留，可以重新生成朗读。' });
    } finally { if (active()) { this.operation = null; this.update({}); } }
  }
}

const conversations = new WeakMap<object, VoiceConversationSession>();
/** Only bounded display text/private file references survive leaving this draft; no microphone or token. */
export function voiceConversationFor(scope: object): VoiceConversationSession {
  let value = conversations.get(scope);
  if (!value) { value = new VoiceConversationSession(); conversations.set(scope, value); }
  return value;
}
