import type { VoiceRecordInput } from '@companion/platform-contracts';
import type { AccountOperationToken } from './account-operations.ts';
import type { Artifact } from './types.ts';
import { excerptInput, realtimeTurnRecordCount, type RealtimeTurn } from './voice-history.ts';
import { copyVoiceAudioConfiguration, copyVoicePreferences, defaultVoicePreferences, voicePersonalityId, type VoiceAudioConfiguration, type VoicePreferences } from './voice-personality.ts';

export interface VoiceDraft {
  providerId: string;
  transcriptionProviderId: string; speechProviderId: string; chatProviderId: string; chatModel: string;
  voicePreferences: VoicePreferences;
  text: string;
  hasTranscription: boolean;
  turns: RealtimeTurn[];
  inputTranscriptionEnabled: boolean | null;
  transcriptInput: VoiceRecordInput | null;
  speechSnapshot: { audio: Artifact; input: VoiceRecordInput; audioConfiguration?: VoiceAudioConfiguration } | null;
  savedClientIds: string[];
  notice: string;
}
type DraftChange = (draft: VoiceDraft) => VoiceDraft;
export const MAX_VOICE_DRAFTS = 32;
const MAX_REALTIME_BYTES = 1024 * 1024;
const MAX_REALTIME_RECORDS = 500;
const emptyDraft = (): VoiceDraft => ({ providerId: '', transcriptionProviderId: '', speechProviderId: '', chatProviderId: '', chatModel: '', voicePreferences: defaultVoicePreferences(), text: '', hasTranscription: false, turns: [], inputTranscriptionEnabled: null, transcriptInput: null, speechSnapshot: null, savedClientIds: [], notice: '' });

function copyInput(input: VoiceRecordInput): VoiceRecordInput {
  return { clientRecordId: input.clientRecordId, source: input.source, role: input.role, text: input.text,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.attachmentIds ? { attachmentIds: [...input.attachmentIds] } : {}) };
}
// Only display text and private attachment metadata cross a page boundary. In particular,
// no RTC connection, microphone, raw event, recording Blob or ephemeral credential belongs here.
function copyDraft(draft: VoiceDraft): VoiceDraft {
  if (draft.text.length > 8000) throw new VoiceDraftLimitError('本次语音文字最多保留 8,000 字，请精简已有文字后继续。');
  if (draft.speechSnapshot && draft.speechSnapshot.input.text.length > 4000) throw new VoiceDraftLimitError('朗读草稿每次最多保留 4,000 字。');
  const bytes = draft.turns.reduce((total, turn) => total + new TextEncoder().encode(turn.text).byteLength, 0);
  const records = draft.turns.reduce((total, turn) => total + realtimeTurnRecordCount(turn), 0);
  if (bytes > MAX_REALTIME_BYTES || records > MAX_REALTIME_RECORDS) throw new VoiceDraftLimitError('本次实时转写已达到 500 个片段或 1 MiB 上限，请先保存已有片段。');
  if (draft.turns.some((turn) => turn.inputs.some((input) => input.text.length > 8000))) throw new VoiceDraftLimitError('每个转写摘录最多保留 8,000 字。');
  if (draft.savedClientIds.length > MAX_REALTIME_RECORDS + 2) throw new VoiceDraftLimitError('本次语音草稿的保存记录已达到上限。');
  const snapshot = draft.speechSnapshot;
  return { providerId: draft.providerId, transcriptionProviderId: draft.transcriptionProviderId, speechProviderId: draft.speechProviderId, chatProviderId: draft.chatProviderId, chatModel: draft.chatModel, voicePreferences: copyVoicePreferences(draft.voicePreferences), text: draft.text, hasTranscription: draft.hasTranscription,
    turns: draft.turns.map((turn) => {
      const status = turn.status || (turn.role === 'user' ? 'complete' : 'unconfirmed');
      return { key: turn.key, itemId: turn.itemId, contentIndex: turn.contentIndex, revision: turn.revision, role: turn.role, status, text: turn.text, inputs: status === 'complete' ? turn.inputs.map(copyInput) : [], ...(turn.voiceRoleId ? { voiceRoleId: voicePersonalityId(turn.voiceRoleId) } : {}) };
    }),
    inputTranscriptionEnabled: draft.inputTranscriptionEnabled,
    transcriptInput: draft.transcriptInput ? copyInput(draft.transcriptInput) : null,
    speechSnapshot: snapshot ? { audio: { id: snapshot.audio.id, name: snapshot.audio.name, mime: snapshot.audio.mime, url: snapshot.audio.url, ...(snapshot.audio.size === undefined ? {} : { size: snapshot.audio.size }) }, input: copyInput(snapshot.input), ...(copyVoiceAudioConfiguration(snapshot.audioConfiguration) ? { audioConfiguration: copyVoiceAudioConfiguration(snapshot.audioConfiguration) } : {}) } : null,
    savedClientIds: [...new Set(draft.savedClientIds)], notice: draft.notice };
}

export class StaleVoiceDraft extends Error {
  constructor() { super('语音草稿所属的登录或会话已变化。'); this.name = 'StaleVoiceDraft'; }
}
export class VoiceDraftLimitError extends Error { constructor(message: string) { super(message); this.name = 'VoiceDraftLimitError'; } }
function hasUnsavedContent(draft: VoiceDraft): boolean {
  const saved = new Set(draft.savedClientIds);
  if (draft.text.trim() && (!draft.transcriptInput || draft.transcriptInput.text !== draft.text.trim() || !saved.has(draft.transcriptInput.clientRecordId))) return true;
  if (draft.turns.some((turn) => turn.status !== 'complete' && !!turn.text.trim() || turn.inputs.some((input) => !saved.has(input.clientRecordId)))) return true;
  return !!draft.speechSnapshot && !saved.has(draft.speechSnapshot.input.clientRecordId);
}

export class VoiceDraftHandle {
  readonly id = crypto.randomUUID();
  private value = emptyDraft();
  private listeners = new Set<() => void>();
  private targetRequest: Promise<string> | null = null;
  private valid = true;
  private readonly store: VoiceDraftStore;
  conversationId: string | null;
  constructor(store: VoiceDraftStore, conversationId: string | null) { this.store = store; this.conversationId = conversationId; }
  isCurrent = () => this.valid && this.store.owns(this);
  getSnapshot = (): VoiceDraft => this.value;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  update(change: DraftChange): boolean {
    if (!this.isCurrent()) return false;
    this.value = copyDraft(change(this.value));
    for (const listener of this.listeners) listener();
    return true;
  }
  edit(): VoiceDraftEditor { return new VoiceDraftEditor(this); }
  invalidate() {
    this.valid = false; this.value = emptyDraft(); this.targetRequest = null;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  async ensureConversation(create: () => Promise<string>): Promise<string> {
    if (!this.isCurrent()) throw new StaleVoiceDraft();
    if (this.conversationId) return this.conversationId;
    if (this.targetRequest) return this.targetRequest;
    const operation = (async () => {
      const id = await create();
      if (!this.store.bind(this, id)) throw new StaleVoiceDraft();
      return id;
    })();
    this.targetRequest = operation;
    try { return await operation; } finally { if (this.targetRequest === operation) this.targetRequest = null; }
  }
}

// A completion captured by an old mount cannot write into a restored page, even when
// React immediately mounts the same draft again or the account logs back in with the same ID.
export class VoiceDraftEditor {
  private active = true;
  private readonly draft: VoiceDraftHandle;
  constructor(draft: VoiceDraftHandle) { this.draft = draft; }
  isCurrent = () => this.active && this.draft.isCurrent();
  close() { this.active = false; }
  update(change: DraftChange): boolean { return this.isCurrent() && this.draft.update(change); }
  transcript(): VoiceRecordInput {
    if (!this.isCurrent()) throw new StaleVoiceDraft();
    const current = this.draft.getSnapshot(), text = current.text.trim();
    const input = current.transcriptInput?.text === text ? current.transcriptInput : excerptInput('transcription_excerpt', text);
    this.update((draft) => ({ ...draft, transcriptInput: input }));
    return input;
  }
}

/** Apply source-state downgrades before the caller ends a limited connection. */
export function applyRealtimeDraftResult(origin: VoiceDraftEditor, captured: RealtimeTurn[], result: { changed: boolean; limitReached?: boolean }, onLimit?: () => void): { applied: boolean; limitReached: boolean } {
  const oversized = captured.reduce((total, turn) => total + new TextEncoder().encode(turn.text).byteLength, 0) > MAX_REALTIME_BYTES
    || captured.reduce((total, turn) => total + realtimeTurnRecordCount(turn), 0) > MAX_REALTIME_RECORDS;
  let applied = false;
  if (result.changed) {
    const incoming = new Map(captured.map((turn) => [turn.key, turn]));
    applied = origin.update((value) => ({ ...value, turns: oversized ? value.turns.flatMap((turn) => {
      const next = incoming.get(turn.key);
      if (!next) return [];
      // Keep the bounded text already displayed, but never keep revoked save inputs.
      return [{ ...turn, ...(next.status === 'complete' ? {} : { status: next.status, inputs: [] }) }];
    }) : captured }));
  }
  const limitReached = !!result.limitReached || oversized;
  if (limitReached && origin.isCurrent()) onLimit?.();
  return { applied, limitReached };
}

export class VoiceDraftStore {
  private session: Pick<AccountOperationToken, 'accountId' | 'generation'> = { accountId: null, generation: -1 };
  private entries = new Map<string | null, VoiceDraftHandle>();
  changeSession(session: Pick<AccountOperationToken, 'accountId' | 'generation'>) {
    if (session.accountId === this.session.accountId && session.generation === this.session.generation) return;
    this.clear(); this.session = { accountId: session.accountId, generation: session.generation };
  }
  clear() { for (const draft of this.entries.values()) draft.invalidate(); this.entries.clear(); }
  open(conversationId: string | null): VoiceDraftHandle {
    if (!this.session.accountId) throw new StaleVoiceDraft();
    let draft = this.entries.get(conversationId);
    if (!draft) {
      if (this.entries.size >= MAX_VOICE_DRAFTS) {
        const expendable = [...this.entries.entries()].find(([, value]) => !hasUnsavedContent(value.getSnapshot()));
        if (!expendable) throw new VoiceDraftLimitError('临时语音草稿已达到 32 份上限。请回到已有会话保存摘录或清空编辑文字后，再开启新的语音草稿。');
        expendable[1].invalidate(); this.entries.delete(expendable[0]);
      }
      draft = new VoiceDraftHandle(this, conversationId);
    } else this.entries.delete(conversationId);
    this.entries.set(conversationId, draft);
    return draft;
  }
  owns(draft: VoiceDraftHandle) { return !!this.session.accountId && this.entries.get(draft.conversationId) === draft; }
  bind(draft: VoiceDraftHandle, conversationId: string): boolean {
    if (!draft.isCurrent() || !conversationId || draft.conversationId && draft.conversationId !== conversationId) return false;
    const existing = this.entries.get(conversationId);
    if (existing && existing !== draft) return false;
    this.entries.delete(draft.conversationId); draft.conversationId = conversationId; this.entries.set(conversationId, draft);
    return true;
  }
  delete(conversationId: string) { const draft = this.entries.get(conversationId); draft?.invalidate(); this.entries.delete(conversationId); }
}

// Used directly by App's render path: a full draft store leaves the rest of the
// workspace usable, and opening other panels never allocates an empty voice draft.
export function openVoiceDraft(store: VoiceDraftStore, conversationId: string | null, visible: boolean): { draft: VoiceDraftHandle | null; error: string } {
  if (!visible) return { draft: null, error: '' };
  try { return { draft: store.open(conversationId), error: '' }; }
  catch (failure) { return { draft: null, error: failure instanceof VoiceDraftLimitError || failure instanceof StaleVoiceDraft ? failure.message : '暂时无法打开语音草稿，请重新打开语音页。' }; }
}

export function voiceDepartureNotice(active: { recording: boolean; transcribing: boolean; speaking: boolean; recognizing: boolean; realtime: boolean }): string {
  if (active.recording) return '离开时录音已结束；尚未转写的音频没有保留。已收到的文字草稿仍可继续。';
  if (active.transcribing) return '离开时转写尚未完成，已停止等待；尚未收到的转写结果没有保留。';
  if (active.speaking) return '离开时语音生成尚未完成，已停止等待；尚未收到的音频结果没有保留。';
  if (active.realtime) return '离开时实时连接已结束；已收到的完整转写草稿仍可继续。';
  if (active.recognizing) return '离开时听写已结束；已收到的完整文字草稿仍可继续。';
  return '';
}
