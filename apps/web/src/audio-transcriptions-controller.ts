import type { AudioTranscriptionReceipt, ChatAttachmentSupport } from '@companion/platform-contracts';
import { ApiError, errorText } from './api.ts';
import type { AudioSource, AudioTranscriptionClient } from './audio-transcriptions-api.ts';

export interface AudioReviewEntry {
  source: AudioSource;
  phase: 'idle' | 'transcribing' | 'uncertain' | 'recovering' | 'complete';
  clientRequestId?: string;
  receipt?: AudioTranscriptionReceipt;
  reviewedText: string;
  reviewed: boolean;
  error: string;
}
export interface AudioReviewSnapshot { entries: Record<string, AudioReviewEntry>; }
interface Environment { isCurrent(): boolean; isOnline(): boolean; subscribe?(listener: () => void): () => void; requestId?(): string; }
const empty: AudioReviewSnapshot = { entries: {} };
const uncertain = '转写结果未确认。停止接收不证明服务端已停止；请只读取已有回执，避免重复转写。';
const pending = (entry: AudioReviewEntry) => entry.phase === 'transcribing' || entry.phase === 'recovering';
export function reviewedAudioTextValid(value: string, maxCharacters: number): boolean {
  if (!value.trim() || value.length > maxCharacters || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return Number.isSafeInteger(maxCharacters) && maxCharacters > 0;
}
/** One account generation. Closing/navigation aborts reception; IDs survive for explicit GET recovery. */
export class AudioTranscriptionController {
  private state: AudioReviewSnapshot = empty;
  private active = false;
  private lifetime = 0;
  private operations = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private api: Pick<AudioTranscriptionClient, 'create' | 'recover'>;
  private environment: Environment;
  constructor(api: Pick<AudioTranscriptionClient, 'create' | 'recover'>, environment: Environment) { this.api = api; this.environment = environment; }
  private current = () => this.active && this.environment.isCurrent();
  getSnapshot = (): AudioReviewSnapshot => this.current() ? this.state : empty;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { for (const listener of this.listeners) listener(); }
  private update(id: string, entry: AudioReviewEntry) { if (!this.current()) return; this.state = { entries: { ...this.state.entries, [id]: entry } }; this.notify(); }
  start() {
    if (this.active) return;
    this.active = true; ++this.lifetime;
    this.unsubscribe = this.environment.subscribe?.(() => { if (!this.environment.isCurrent()) this.stop(); });
    this.notify();
  }
  stop = () => {
    this.active = false; ++this.lifetime;
    const entries = Object.fromEntries(Object.entries(this.state.entries).map(([id, entry]) => [id, pending(entry) ? { ...entry, phase: 'uncertain' as const, reviewed: false, error: uncertain } : entry]));
    this.state = { entries };
    for (const controller of this.operations.values()) controller.abort();
    this.operations.clear(); this.unsubscribe?.(); this.unsubscribe = undefined; this.notify();
  };
  invalidateContext = () => { const wasActive = this.active; this.stop(); if (wasActive) this.start(); };
  setSources(sources: AudioSource[]) {
    const entries: Record<string, AudioReviewEntry> = {};
    for (const source of sources.filter((item) => item.mime.startsWith('audio/'))) {
      const prior = this.state.entries[source.id];
      if (prior && prior.source.name === source.name && prior.source.mime === source.mime && prior.source.size === source.size) entries[source.id] = prior;
      else { this.operations.get(source.id)?.abort(); this.operations.delete(source.id); entries[source.id] = { source: { ...source }, phase: 'idle', reviewedText: '', reviewed: false, error: '' }; }
    }
    for (const id of this.operations.keys()) if (!entries[id]) { this.operations.get(id)?.abort(); this.operations.delete(id); }
    if (Object.keys(entries).length === Object.keys(this.state.entries).length && Object.entries(entries).every(([id, entry]) => entry === this.state.entries[id])) return;
    this.state = { entries }; this.notify();
  }
  remove(id: string) { this.operations.get(id)?.abort(); this.operations.delete(id); const entries = { ...this.state.entries }; delete entries[id]; this.state = { entries }; this.notify(); }
  cancel = (id: string) => {
    const entry = this.state.entries[id]; if (!this.current() || !entry || !pending(entry)) return;
    this.operations.get(id)?.abort(); this.operations.delete(id);
    this.update(id, { ...entry, phase: 'uncertain', reviewed: false, error: uncertain });
  };
  edit = (id: string, reviewedText: string) => {
    const entry = this.state.entries[id]; if (!this.current() || !entry?.receipt || entry.phase !== 'complete' || entry.reviewedText === reviewedText) return;
    this.update(id, { ...entry, reviewedText, reviewed: false });
  };
  review = (id: string, reviewed: boolean, maxCharacters: number) => {
    const entry = this.state.entries[id]; if (!this.current() || !entry?.receipt || entry.phase !== 'complete') return;
    this.update(id, { ...entry, reviewed: reviewed && reviewedAudioTextValid(entry.reviewedText, maxCharacters) });
  };
  transcribe = async (id: string, support?: ChatAttachmentSupport['audioTranscripts']) => {
    const entry = this.state.entries[id];
    if (!this.current() || !entry || entry.clientRequestId || pending(entry)) return;
    if (!this.environment.isOnline() || !support?.available || support.provider !== 'faster-whisper' || support.model !== 'whisper-tiny' || !support.mimeTypes.includes(entry.source.mime) || entry.source.size > support.maxAudioBytes) {
      this.update(id, { ...entry, error: !this.environment.isOnline() ? '当前离线，没有发起转写。' : '本地音频转写尚不可用，或文件不符合声明的格式与大小限制。' }); return;
    }
    const clientRequestId = this.environment.requestId?.() ?? crypto.randomUUID();
    this.update(id, { ...entry, clientRequestId, phase: 'transcribing', reviewed: false, error: '' });
    await this.run(id, 'create');
  };
  recover = async (id: string) => {
    const entry = this.state.entries[id];
    if (!this.current() || !entry?.clientRequestId || entry.phase !== 'uncertain') return;
    if (!this.environment.isOnline()) { this.update(id, { ...entry, error: '当前离线，尚未读取回执。请求编号仍保留。' }); return; }
    this.update(id, { ...entry, phase: 'recovering', error: '' });
    await this.run(id, 'recover');
  };
  private async run(id: string, method: 'create' | 'recover') {
    const entry = this.state.entries[id]; if (!entry?.clientRequestId) return;
    const controller = new AbortController(), lifetime = this.lifetime;
    this.operations.set(id, controller);
    const current = () => this.current() && this.lifetime === lifetime && this.operations.get(id) === controller && !controller.signal.aborted && this.state.entries[id]?.clientRequestId === entry.clientRequestId;
    try {
      const receipt = await this.api[method](entry.source, entry.clientRequestId, controller.signal);
      if (!current()) return;
      this.update(id, { ...this.state.entries[id], receipt, phase: 'complete', reviewedText: receipt.text, reviewed: false, error: '' });
    } catch (error) {
      if (!current()) return;
      const message = method === 'recover' && error instanceof ApiError && error.status === 404 ? '尚未查到已完成回执；这不证明原请求已停止。请求编号保留，可以稍后再次只读查询。' : `${errorText(error)} ${uncertain}`;
      this.update(id, { ...this.state.entries[id], phase: 'uncertain', reviewed: false, error: message });
    } finally { if (this.operations.get(id) === controller) this.operations.delete(id); }
  }
}
