import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, AudioLines, Check, CircleStop, Headphones, MessageCircle, Mic, Play, Radio, Save, Upload, Volume2 } from 'lucide-react';
import type { VoiceRecord, VoiceRecordInput } from '@companion/platform-contracts';
import { entity, errorText, type BoundPlatformClient } from './api';
import { useRequiredPlatformAccountClient } from './account-client';
import { ArtifactView, Badge, ProviderSelect } from './ui';
import type { Artifact, Conversation, Provider } from './types';
import VoiceRecords from './VoiceRecords';
import { excerptInput, quotedVoiceText, RealtimeTranscriptBuffer } from './voice-history';
import { voiceDepartureNotice, type VoiceDraftHandle, type VoiceDraftEditor } from './voice-draft';
import { disposeVoiceSession, microphoneErrorText, requestVoiceSession } from './voice-session';
import { voiceCapabilities, voiceControls } from './voice-capabilities';
import { appendTranscriptionText, transcribeAudio, TRANSCRIPTION_AUDIO_ACCEPT } from './voice-transcription';
import { BrowserVoiceRecording, supportedRecordingMimeType } from './voice-recording';
import { holdPrivateResource } from './private-media';
import { selectedConversationProvider, voiceAnswerSpeechProblem, voiceConversationFor, voiceConversationModels, voiceConversationProviderReady } from './voice-conversation';
import { copyVoicePreferences, retainedVoice, voiceAudioConfiguration, voicePersonality, voiceRealtimeBody, voiceSelectionProblem, voiceSpeechBody, type VoicePreferences } from './voice-personality';
import { VoiceAudioLabel, VoicePersonalityPicker, VoiceSoundPicker, VoiceTurnTakingPicker } from './VoicePersonalityControls';
import './voice-conversation.css';
import './voice-personality.css';
interface Recognition { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: any) => void) | null; onerror: ((event: any) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void }
type RecognitionConstructor = new () => Recognition;
interface VoicePanelProps {
  draft: VoiceDraftHandle;
  providers: Provider[];
  conversation?: Conversation;
  records: VoiceRecord[];
  onEnsureConversation: () => Promise<string>;
  onSaveRecord: (conversationId: string, input: VoiceRecordInput) => Promise<VoiceRecord>;
  onBringToChat: (text: string) => void;
  onOpenConversation?: (conversationId: string) => void;
  onConversationChanged?: (conversationId: string) => void;
  onError: (error: string) => void;
}
export default function VoicePanel({ draft, providers, conversation, records, onEnsureConversation, onSaveRecord, onBringToChat: bringToChat, onOpenConversation: openConversation, onConversationChanged, onError }: VoicePanelProps) {
  const accountClient = useRequiredPlatformAccountClient();
  const { request, streamMessage } = accountClient;
  const { providerId, transcriptionProviderId, speechProviderId, chatProviderId, chatModel, voicePreferences, text, hasTranscription, speechSnapshot, turns, inputTranscriptionEnabled, notice, savedClientIds } = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const voiceConversation = useMemo(() => voiceConversationFor(draft), [draft]);
  const turn = useSyncExternalStore(voiceConversation.subscribe, voiceConversation.getSnapshot);
  const [recording, setRecording] = useState(false);
  const [requestingMicrophone, setRequestingMicrophone] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedIds = new Set(savedClientIds);
  const [live, setLive] = useState<'idle' | 'connecting' | 'connected'>('idle');
  const [status, setStatus] = useState('');
  const recorder = useRef<BrowserVoiceRecording | null>(null);
  const audioInput = useRef<HTMLInputElement | null>(null);
  const importChoice = useRef<{ origin: VoiceDraftEditor; provider: string } | null>(null);
  const transcriptionRequest = useRef<AbortController | null>(null);
  const speechRequest = useRef<AbortController | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const microphonePending = useRef(false);
  const recognition = useRef<Recognition | null>(null);
  const peer = useRef<RTCPeerConnection | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  const connectionActive = useRef(false);
  const connectionAttempt = useRef(0);
  const sessionLease = useRef<{ sessionId: string; client: BoundPlatformClient } | null>(null);
  const sessionCreation = useRef<AbortController | null>(null);
  const leaseTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editor = useRef(draft.edit());
  const pendingRequests = useRef(new Set<AbortController>());
  const negotiation = useRef<AbortController | null>(null);
  const activeWork = useRef({ recording: false, transcribing: false, speaking: false, recognizing: false, realtime: false });
  const savingActive = useRef(false);
  const recognitionType = (window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: RecognitionConstructor }).webkitSpeechRecognition;
  const microphoneProblem = !window.isSecureContext ? '录音需要 HTTPS 或本机 localhost。请使用安全地址打开网页，也可以导入音频。'
    : !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' ? '当前浏览器不支持网页录音。请换用支持录音的浏览器，或导入音频。'
    : !supportedRecordingMimeType((mime) => MediaRecorder.isTypeSupported(mime)) ? '当前浏览器没有可上传的录音格式。你仍可以导入音频转写。' : '';
  const canRecord = !microphoneProblem;
  const provider = providers.find((entry) => entry.id === providerId);
  const capabilities = voiceCapabilities(provider);
  const transcriptionProvider = providers.find((entry) => entry.id === transcriptionProviderId);
  const speechProvider = providers.find((entry) => entry.id === speechProviderId);
  const chatProvider = providers.find((entry) => entry.id === chatProviderId);
  const transcriptionCapabilities = voiceCapabilities(transcriptionProvider);
  const speechCapabilities = voiceCapabilities(speechProvider);
  const turnBusy = voiceConversation.busy();
  const controls = voiceControls({ realtime: capabilities.realtime, transcription: transcriptionCapabilities.transcription, speech: speechCapabilities.speech }, { recording: recording || requestingMicrophone, recognizing, transcribing, speaking: speaking || turnBusy, live: live !== 'idle' }, { canRecord, canRecognize: !!recognitionType }, text);
  const busy = recording || requestingMicrophone || recognizing || transcribing || speaking || live !== 'idle' || turnBusy;
  const chatModels = voiceConversationModels(chatProvider);
  const speechVoice = retainedVoice(voicePreferences, 'speech', speechProviderId);
  const realtimeVoice = retainedVoice(voicePreferences, 'realtime', providerId);
  const speechVoiceProblem = voiceSelectionProblem(speechProvider, 'speech', speechVoice);
  const realtimeVoiceProblem = voiceSelectionProblem(provider, 'realtime', realtimeVoice);
  const answerSpeechProblem = speechVoiceProblem || voiceAnswerSpeechProblem(turn.answer, speechProvider);
  const allRealtimeInputs = turns.flatMap((turn) => turn.inputs);
  const hasUnsavedTurns = allRealtimeInputs.some((input) => !savedIds.has(input.clientRecordId));
  const currentOrigin = (origin: VoiceDraftEditor) => accountClient.isCurrent() && origin.isCurrent();
  const onBringToChat = (content: string) => { if (currentOrigin(editor.current)) bringToChat(content); };
  const onOpenConversation = openConversation ? (id: string) => { if (currentOrigin(editor.current)) openConversation(id); } : undefined;
  function setProviderId(id: string) { editor.current.update((value) => ({ ...value, providerId: id })); }
  function setTranscriptionProviderId(id: string) { editor.current.update((value) => ({ ...value, transcriptionProviderId: id })); }
  function setSpeechProviderId(id: string) { editor.current.update((value) => ({ ...value, speechProviderId: id })); }
  function setChatProviderId(id: string) { editor.current.update((value) => ({ ...value, chatProviderId: id })); }
  function setChatModel(model: string) { editor.current.update((value) => ({ ...value, chatModel: model })); }
  function setVoicePreferences(change: (preferences: VoicePreferences) => VoicePreferences) { if (!busy && !voiceConversation.busy() && !connectionActive.current && !savingActive.current && !microphonePending.current && !Object.values(activeWork.current).some(Boolean)) editor.current.update((value) => ({ ...value, voicePreferences: change(value.voicePreferences) })); }
  function setText(content: string) { editor.current.update((value) => ({ ...value, text: content, notice: '' })); }
  useEffect(() => {
    // The retained legacy voice choice may have been a speech-only service.
    // These controls now select each capability separately.
    if (!providerId || provider && !provider.capabilities.includes('realtime')) setProviderId(selectedConversationProvider(providers, 'realtime'));
    if (!transcriptionProviderId) setTranscriptionProviderId(selectedConversationProvider(providers, 'transcription'));
    if (!speechProviderId) setSpeechProviderId(selectedConversationProvider(providers, 'speech'));
    if (!chatProviderId) { const selected = selectedConversationProvider(providers, 'chat'); setChatProviderId(selected); setChatModel(voiceConversationModels(providers.find((entry) => entry.id === selected))[0] || ''); }
  }, [providers, providerId, transcriptionProviderId, speechProviderId, chatProviderId]);
  function releaseMedia() { const stream = microphone.current; microphone.current = null; disposeVoiceSession({ controllers: [], microphone: stream }); }
  function releaseLease() {
    const lease = sessionLease.current; sessionLease.current = null;
    if (leaseTimeout.current) { clearTimeout(leaseTimeout.current); leaseTimeout.current = null; }
    if (lease) lease.client.cleanup('/voice/session/release', { body: JSON.stringify({ sessionId: lease.sessionId }) }).catch(() => {});
  }
  function stopLive() {
    connectionAttempt.current++; releaseLease(); connectionActive.current = false; activeWork.current.realtime = false;
    disposeVoiceSession({ controllers: [...(sessionCreation.current ? [sessionCreation.current] : []), ...(negotiation.current ? [negotiation.current] : [])], peer: peer.current, microphone: microphone.current, audio: remoteAudio.current });
    sessionCreation.current = null; negotiation.current = null; peer.current = null; remoteAudio.current = null; microphone.current = null;
    if (accountClient.isCurrent()) { setLive('idle'); setStatus('实时会话已结束；收到的完整转写片段仍可保存'); }
  }
  useEffect(() => {
    editor.current = draft.edit();
    voiceConversation.activate(() => accountClient.isCurrent() && editor.current.isCurrent());
    const unsubscribe = draft.subscribe(() => { if (!draft.isCurrent()) voiceConversation.clear(); });
    const dispose = () => {
      editor.current.close(); connectionAttempt.current++; releaseLease(); connectionActive.current = false;
      voiceConversation.deactivate();
      disposeVoiceSession({ controllers: [...pendingRequests.current, ...(negotiation.current ? [negotiation.current] : [])], recognition: recognition.current, recording: recorder.current, peer: peer.current, microphone: recorder.current ? null : microphone.current, audio: remoteAudio.current });
      pendingRequests.current.clear(); negotiation.current = null; transcriptionRequest.current = null; speechRequest.current = null; importChoice.current = null; recognition.current = null; recorder.current = null; peer.current = null; microphone.current = null; remoteAudio.current = null;
      activeWork.current = { recording: false, transcribing: false, speaking: false, recognizing: false, realtime: false };
    };
    const stopAccount = holdPrivateResource(accountClient, () => { dispose(); if (!accountClient.isCurrent()) voiceConversation.clear(); });
    return () => {
      const departure = accountClient.isCurrent() ? voiceDepartureNotice(activeWork.current) : '';
      if (departure) draft.update((value) => ({ ...value, notice: departure }));
      unsubscribe(); stopAccount();
    };
  }, [accountClient, draft, voiceConversation]);
  async function saveInputs(inputs: VoiceRecordInput[]) {
    if (!accountClient.isCurrent() || savingActive.current || !inputs.length || !draft.isCurrent()) return;
    const origin = editor.current;
    savingActive.current = true; setSaving(true);
    try {
      const targetId = await onEnsureConversation();
      if (!currentOrigin(origin)) return;
      let added = 0;
      for (const input of inputs) {
        if (!currentOrigin(origin)) return;
        if (draft.getSnapshot().savedClientIds.includes(input.clientRecordId)) continue;
        await onSaveRecord(targetId, input);
        if (!currentOrigin(origin)) return;
        draft.update((value) => ({ ...value, savedClientIds: [...value.savedClientIds, input.clientRecordId] })); added++;
      }
      if (currentOrigin(origin)) setStatus(added ? `已保存 ${added} 条语音摘录到会话历史` : '这些摘录已经保存');
    } catch (error) { if (currentOrigin(origin)) onError(`语音摘录未全部保存，可重试继续保存：${errorText(error)}`); }
    finally { savingActive.current = false; if (currentOrigin(origin)) setSaving(false); }
  }
  function currentTranscriptInput() {
    return editor.current.transcript();
  }
  async function transcribe(audio: Blob, source: '录音' | '音频文件', origin: VoiceDraftEditor, chosenProvider: string) {
    if (!currentOrigin(origin) || transcriptionRequest.current || microphonePending.current) return;
    const capability = voiceCapabilities(providers.find((entry) => entry.id === chosenProvider)).transcription;
    if (!capability.available) { onError(capability.reason); return; }
    const controller = new AbortController(); transcriptionRequest.current = controller; pendingRequests.current.add(controller);
    activeWork.current.transcribing = true; setTranscribing(true); setStatus(`正在将${source}交给所选服务转写；原有文字会保留。`);
    try {
      const result = await transcribeAudio(audio, chosenProvider, controller.signal, request);
      if (!currentOrigin(origin)) return;
      if (!result) { setStatus('没有检测到清晰的语音；原有文字已保留，没有新增摘录。'); return; }
      if (origin.update((value) => ({ ...value, text: appendTranscriptionText(value.text, result), hasTranscription: true, notice: '' }))) setStatus(`${source}已转成文字；请审阅后保存或带回对话草稿。`);
    } catch (error) { if (currentOrigin(origin)) { if (controller.signal.aborted) setStatus('转写已取消，原有文字已保留。'); else onError(errorText(error)); } }
    finally {
      pendingRequests.current.delete(controller);
      if (transcriptionRequest.current === controller) transcriptionRequest.current = null;
      if (currentOrigin(origin)) { activeWork.current.transcribing = false; setTranscribing(false); }
    }
  }
  function chooseAudio() {
    if (controls.importDisabled || microphonePending.current || !currentOrigin(editor.current)) return;
    importChoice.current = { origin: editor.current, provider: transcriptionProviderId };
    audioInput.current?.click();
  }
  function importAudio(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0], choice = importChoice.current;
    event.currentTarget.value = ''; importChoice.current = null;
    if (!file || !choice || !currentOrigin(choice.origin) || controls.importDisabled || microphonePending.current || choice.provider !== transcriptionProviderId) return;
    void transcribe(file, '音频文件', choice.origin, choice.provider);
  }
  async function startRecording() {
    if (!currentOrigin(editor.current) || microphonePending.current || transcriptionRequest.current || voiceConversation.busy() || Object.values(activeWork.current).some(Boolean)) return;
    if (!canRecord) { onError(microphoneProblem); return; }
    if (!transcriptionCapabilities.transcription.available) { onError(transcriptionCapabilities.transcription.reason); return; }
    const origin = editor.current, chosenProvider = transcriptionProviderId;
    microphonePending.current = true; setRequestingMicrophone(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!currentOrigin(origin) || voiceConversation.busy() || transcriptionRequest.current || Object.values(activeWork.current).some(Boolean)) { disposeVoiceSession({ controllers: [], microphone: stream }); return; }
      microphone.current = stream;
      const instance = new BrowserVoiceRecording(stream, {
        isCurrent: () => currentOrigin(origin),
        onStopped: () => {
          if (microphone.current === stream) microphone.current = null;
          if (recorder.current === instance) recorder.current = null;
          activeWork.current.recording = false; setRecording(false);
        },
        onComplete: (audio) => { void transcribe(audio, '录音', origin, chosenProvider); },
        onError: (message) => { setStatus('录音未完成，原有文字仍在。'); onError(message); },
      });
      recorder.current = instance;
      instance.start();
      if (recorder.current === instance) { activeWork.current.recording = true; setRecording(true); setStatus('正在录音。点击结束后会上传至转写服务；取消或离开本页会丢弃未转写音频。'); }
    } catch (error) { if (currentOrigin(origin)) { releaseMedia(); onError(microphoneErrorText(error)); } }
    finally { microphonePending.current = false; if (currentOrigin(origin)) setRequestingMicrophone(false); }
  }
  function cancelRecording() {
    const current = recorder.current; recorder.current = null; current?.cancel(); microphone.current = null;
    activeWork.current.recording = false; setRecording(false); setStatus('录音已取消，没有上传。原有文字仍在。');
  }
  function startRecognition() {
    if (!currentOrigin(editor.current) || !recognitionType || microphonePending.current || voiceConversation.busy() || Object.values(activeWork.current).some(Boolean)) return;
    const origin = editor.current;
    const instance = new recognitionType(); recognition.current = instance; instance.lang = 'zh-CN'; instance.continuous = true; instance.interimResults = false;
    instance.onresult = (event) => {
      let content = ''; for (let index = event.resultIndex; index < event.results.length; index++) if (event.results[index].isFinal) content += event.results[index][0].transcript;
      if (!content || !currentOrigin(origin)) return;
      try { origin.update((value) => ({ ...value, text: `${value.text}${value.text ? ' ' : ''}${content}`, hasTranscription: true, notice: '' })); }
      catch (failure) { instance.stop(); activeWork.current.recognizing = false; setRecognizing(false); onError(errorText(failure)); }
    };
    instance.onerror = (event) => { if (currentOrigin(origin)) { onError(`浏览器听写未完成：${event.error || '未知错误'}`); activeWork.current.recognizing = false; setRecognizing(false); } };
    instance.onend = () => { if (currentOrigin(origin)) { activeWork.current.recognizing = false; setRecognizing(false); } };
    try { instance.start(); activeWork.current.recognizing = true; setRecognizing(true); setStatus('浏览器听写中；识别处理方式由浏览器提供商决定'); } catch (error) { if (currentOrigin(origin)) onError(errorText(error)); }
  }
  async function speak() {
    if (!currentOrigin(editor.current) || microphonePending.current || voiceConversation.busy() || Object.values(activeWork.current).some(Boolean)) return;
    const spokenText = text.trim();
    if (!spokenText) return;
    if (!speechCapabilities.speech.available) { onError(speechCapabilities.speech.reason); return; }
    const speechProblem = speechVoiceProblem || voiceAnswerSpeechProblem(spokenText, speechProvider); if (speechProblem) { onError(speechProblem); return; }
    const origin = editor.current, controller = new AbortController(); pendingRequests.current.add(controller);
    const roleId = voicePreferences.roleId, body = voiceSpeechBody(speechProvider!, spokenText, roleId, speechVoice), audioConfiguration = voiceAudioConfiguration(speechProvider!, roleId, speechVoice);
    speechRequest.current = controller;
    activeWork.current.speaking = true; setSpeaking(true);
    try {
      const result = entity<Artifact>(await request('/voice/speech', { method: 'POST', body: JSON.stringify(body), signal: controller.signal }), 'attachment');
      if (!currentOrigin(origin)) return;
      if (!result.url || !result.id) throw new Error('语音服务没有返回音频记录。');
      if (origin.update((value) => ({ ...value, speechSnapshot: { audio: result, input: excerptInput('speech_excerpt', spokenText, [result.id]), audioConfiguration }, notice: '' }))) setStatus('语音已生成，可以播放，或明确保存朗读文本与音频');
    } catch (error) { if (currentOrigin(origin)) { if (controller.signal.aborted) setStatus('朗读生成已取消，原有文字和音频仍可查看。'); else onError(errorText(error)); } }
    finally { pendingRequests.current.delete(controller); if (speechRequest.current === controller) speechRequest.current = null; if (currentOrigin(origin)) { activeWork.current.speaking = false; setSpeaking(false); } }
  }
  async function answerQuestion() {
    if (!currentOrigin(editor.current) || microphonePending.current || Object.values(activeWork.current).some(Boolean) || voiceConversation.busy()) return;
    const origin = editor.current;
    try {
      await voiceConversation.answer({ text, roleId: voicePreferences.roleId, provider: chatProvider, model: chatModel, conversation, ensureConversation: onEnsureConversation, onConversationChanged }, { request, streamMessage });
    } catch (error) { if (currentOrigin(origin)) onError(errorText(error)); }
  }
  async function speakAnswer() {
    if (!currentOrigin(editor.current) || microphonePending.current || Object.values(activeWork.current).some(Boolean) || voiceConversation.busy()) return;
    const origin = editor.current;
    try {
      await voiceConversation.speak(speechProvider, { request, streamMessage }, speechVoice);
      const current = voiceConversation.getSnapshot();
      if (currentOrigin(origin) && current.audio && !current.speechError) {
        const input = { ...excerptInput('speech_excerpt', current.answer, [current.audio.id]), role: 'assistant' as const };
        origin.update((value) => ({ ...value, speechSnapshot: { audio: current.audio!, input, ...(current.audioConfiguration ? { audioConfiguration: current.audioConfiguration } : {}) }, notice: '' }));
      }
    }
    catch (error) { if (currentOrigin(origin)) onError(errorText(error)); }
  }
  async function startLive() {
    if (!currentOrigin(editor.current) || microphonePending.current || voiceConversation.busy() || Object.values(activeWork.current).some(Boolean)) return;
    if (!capabilities.realtime.available) { onError(capabilities.realtime.reason); return; }
    if (realtimeVoiceProblem) { onError(realtimeVoiceProblem); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') { onError('当前浏览器不支持实时语音所需的麦克风或 WebRTC。'); return; }
    const origin = editor.current, preferences = copyVoicePreferences(voicePreferences), controller = new AbortController();
    sessionCreation.current = controller; pendingRequests.current.add(controller);
    setLive('connecting'); connectionActive.current = true; activeWork.current.realtime = true;
    const attempt = ++connectionAttempt.current;
    const stillActive = () => currentOrigin(origin) && connectionActive.current && connectionAttempt.current === attempt;
    try {
      const sessionBody = voiceRealtimeBody(provider!, preferences);
      const session = await requestVoiceSession(sessionBody, controller.signal, stillActive, request, (sessionId) => { accountClient.cleanup('/voice/session/release', { body: JSON.stringify({ sessionId }) }).catch(() => {}); });
      if (!session) return;
      sessionLease.current = session.sessionId ? { sessionId: session.sessionId, client: accountClient } : null;
      leaseTimeout.current = setTimeout(() => { stopLive(); setStatus('已达到 10 分钟会话时限。可以重新开始实时交流。'); }, 10 * 60 * 1000);
      const token = session.clientSecret;
      if (!token || !session.endpoint || !session.sessionId) throw new Error('服务没有返回有效的实时语音会话。');
      origin.update((value) => ({ ...value, inputTranscriptionEnabled: !!session.inputTranscriptionEnabled, notice: '' }));
      const buffer = new RealtimeTranscriptBuffer(session.sessionId), priorTurns = draft.getSnapshot().turns;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!stillActive()) { disposeVoiceSession({ controllers: [], microphone: stream }); return; }
      microphone.current = stream;
      const pc = new RTCPeerConnection(); peer.current = pc;
      const speaker = new Audio(); speaker.autoplay = true; remoteAudio.current = speaker;
      pc.ontrack = (event) => { if (!stillActive()) return; speaker.srcObject = event.streams[0]; speaker.play().catch(() => { if (stillActive()) setStatus('浏览器阻止自动播放，请点击播放对话音频'); }); };
      microphone.current.getTracks().forEach((track) => pc.addTrack(track, microphone.current!));
      const channel = pc.createDataChannel('oai-events');
      channel.onmessage = (event) => {
        if (!stillActive() || peer.current !== pc) return;
        if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) { stopLive(); onError('实时片段超过本页接收上限，连接已结束。已收到的完整片段可以保存。'); return; }
        try {
          const entry = JSON.parse(event.data);
          const result = buffer.receive(entry);
          const captured = [...priorTurns, ...buffer.turns().map((turn) => ({ ...turn, ...(sessionBody.persona ? { voiceRoleId: preferences.roleId } : {}) }))];
          const totalBytes = captured.reduce((total, turn) => total + new TextEncoder().encode(turn.text).byteLength, 0);
          const totalRecords = captured.reduce((total, turn) => total + turn.inputs.length, 0);
          if (result.limitReached || totalBytes > 1024 * 1024 || totalRecords > 500) { stopLive(); onError('本次实时转写已达到保存上限，连接已结束。请保存已收到的完整片段。'); return; }
          if (result.changed) origin.update((value) => ({ ...value, turns: captured }));
          if (entry.type === 'error') onError(entry.error?.message || '实时语音服务返回错误。');
        } catch { /* Unsupported vendor events never become history records. */ }
      };
      pc.onconnectionstatechange = () => { if (!stillActive() || peer.current !== pc) return; if (pc.connectionState === 'connected') { setLive('connected'); setStatus(`已连接实时语音 · ${session.model}`); } else if (['failed', 'disconnected'].includes(pc.connectionState)) { stopLive(); onError('实时语音连接已断开。'); } };
      const offer = await pc.createOffer(); if (!stillActive()) return; await pc.setLocalDescription(offer); if (!stillActive()) return;
      const negotiationController = new AbortController(); negotiation.current = negotiationController;
      const response = await fetch(session.endpoint, { method: 'POST', credentials: 'omit', redirect: 'error', body: offer.sdp, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sdp' }, signal: negotiationController.signal });
      if (!response.ok) throw new Error(`实时语音连接失败 (${response.status})`);
      if (!stillActive()) return;
      const answer = await response.text(); if (!stillActive()) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      if (negotiation.current === negotiationController) negotiation.current = null;
    } catch (error) { if (stillActive()) { stopLive(); onError(errorText(error)); } }
    finally { pendingRequests.current.delete(controller); if (sessionCreation.current === controller) sessionCreation.current = null; }
  }
  if (!accountClient.isCurrent()) return <section className="feature-page"><p role="status">登录状态已变化，语音工作台已关闭。</p></section>;
  return <section className="feature-page voice-page">
    <div className="page-kicker"><AudioLines size={15} />VOICE STUDIO</div>
    <h1>有些想法，<span>说出来更好。</span></h1>
    <p className="page-description">实时交流、录音转写，或把文字变成声音。每次麦克风连接都由你开始。</p>
    <VoicePersonalityPicker value={voicePreferences.roleId} disabled={busy || saving} onChange={(roleId) => setVoicePreferences((value) => ({ ...value, roleId }))} />
    <div className="voice-hero"><div className={`voice-orb ${live !== 'idle' || recording || recognizing ? 'active' : ''}`}><AudioLines size={54} strokeWidth={1.4} /></div><div>
      <Badge tone={live === 'connected' ? 'green' : 'neutral'}>{live === 'connected' ? '正在实时对话' : live === 'connecting' ? '建立连接中' : '准备好时，开口就好'}</Badge><h2>你的声音，也是一种输入。</h2><p>自然地思考、练习表达，和 AI 一起推进一个想法。</p>
      <ProviderSelect providers={providers} value={providerId} onChange={setProviderId} capability="realtime" label="实时语音服务" disabled={busy} />
      <VoiceSoundPicker provider={provider} capability="realtime" value={realtimeVoice} disabled={busy || saving} onChange={(voice) => setVoicePreferences((value) => ({ ...value, realtimeVoices: { ...value.realtimeVoices, [providerId]: voice } }))} />
      <VoiceTurnTakingPicker provider={provider} value={voicePreferences.turnTaking} disabled={busy || saving} onChange={(turnTaking) => setVoicePreferences((value) => ({ ...value, turnTaking }))} />
      {realtimeVoiceProblem && <p className="helper-text">{realtimeVoiceProblem}</p>}
      <p id="voice-realtime-availability" aria-live="polite">实时对话：{capabilities.realtime.reason}</p>
      <div className="voice-controls">{live === 'idle' ? <button className="primary" onClick={startLive} disabled={controls.realtimeDisabled || !!realtimeVoiceProblem} aria-describedby="voice-realtime-availability"><Radio size={16} />开始实时对话</button> : <button className="primary stop" onClick={stopLive}><CircleStop size={16} />结束实时对话</button>}<button className="secondary" onClick={() => remoteAudio.current?.play()} disabled={live === 'idle'}><Headphones size={16} />播放对话音频</button></div>
    </div></div>
    {status && <div className="voice-status" aria-live="polite">{status}</div>}
    {notice && <div className="voice-status" aria-live="polite">{notice}</div>}
    <p className="voice-save-target">当前会话：{conversation?.title || '首次发送或保存时创建“语音笔记”会话'}。发送问题和 AI 回答会保存到对话；语音摘录仍需点击保存。</p>
    {(turns.length > 0 || inputTranscriptionEnabled !== null) && <section className="live-transcript">
      <div className="section-title"><h3>实时对话转写</h3><span>FINAL EXCERPTS</span></div>
      <p className="voice-provenance">浏览器收到的未核验文本，只保留实际收到的完整片段。{inputTranscriptionEnabled === false && '用户音频转写待配置，可能仅有 AI 的转写。'}</p>
      {turns.map((turn) => <article className="live-turn" key={turn.key}><div className="voice-record-heading"><Badge>{turn.role === 'user' ? '用户' : turn.voiceRoleId ? `${voicePersonality(turn.voiceRoleId).label} · AI 转写` : 'AI 转写'}</Badge>{turn.inputs.every((input) => savedIds.has(input.clientRecordId)) && <span><Check size={12} />已保存</span>}</div><p>{turn.text}</p>{turn.revision > 0 && <p className="voice-provenance">服务更新了这个片段；再次保存会新增修订摘录。</p>}<div className="voice-excerpt-actions"><button className="text-button" disabled={saving || turn.inputs.every((input) => savedIds.has(input.clientRecordId))} onClick={() => saveInputs(turn.inputs)}><Save size={13} />保存完整片段</button><button className="text-button" disabled={saving} onClick={() => onBringToChat(quotedVoiceText('realtime_transcript', turn.text, turn.role))}><ArrowRight size={13} />带回对话草稿</button></div></article>)}
      {!!turns.length && <button className="secondary" disabled={saving || !hasUnsavedTurns} onClick={() => saveInputs(allRealtimeInputs)}><Save size={14} />{saving ? '保存中…' : hasUnsavedTurns ? '保存全部完整片段' : '完整片段已保存'}</button>}
    </section>}
    <div className="voice-editor"><div className="section-title"><h3>逐回合语音交流</h3><span>听清 · 审阅 · 回答 · 朗读</span></div>
      <p className="helper-text">录音或导入音频后，先审阅文字，再明确发送这一轮问题。你可以分别选择转写、对话和朗读服务。</p>
      <div className="voice-service-row"><span>录音转写</span><ProviderSelect providers={providers} value={transcriptionProviderId} onChange={setTranscriptionProviderId} capability="transcription" label="录音转写服务" disabled={busy} /></div>
      <textarea aria-label="语音文本" maxLength={8000} value={text} onChange={(event) => setText(event.target.value)} disabled={turnBusy} placeholder="录下一段话，审阅转写后让 AI 回答，或直接输入问题…" rows={6} />
      <div className="voice-toolbar"><div>{recognitionType && <button className="secondary" onClick={() => recognizing ? recognition.current?.stop() : startRecognition()} disabled={controls.recognitionDisabled || !recognizing && busy} aria-describedby="voice-browser-recognition"><Mic size={15} />{recognizing ? '结束听写' : '浏览器听写'}</button>}<button className="secondary" disabled={requestingMicrophone || controls.recordingDisabled} aria-describedby="voice-transcription-availability voice-microphone-availability" onClick={() => recording ? recorder.current?.stop() : startRecording()}>{recording ? <CircleStop size={15} /> : <Mic size={15} />}{recording ? '结束并转写' : requestingMicrophone ? '等待麦克风…' : transcribing ? '转写中…' : '录音转文字'}</button>{recording && <button className="secondary" onClick={cancelRecording}><CircleStop size={15} />取消录音</button>}<button className="secondary" onClick={chooseAudio} disabled={controls.importDisabled} aria-describedby="voice-transcription-availability"><Upload size={15} />导入音频转写</button>{transcribing && <button className="secondary" onClick={() => transcriptionRequest.current?.abort()}><CircleStop size={15} />取消转写</button>}<input ref={audioInput} type="file" accept={TRANSCRIPTION_AUDIO_ACCEPT} onChange={importAudio} hidden aria-label="选择转写音频" /></div></div>
      {microphoneProblem && <p className="helper-text" id="voice-microphone-availability">{microphoneProblem}</p>}
      <p className="helper-text">导入音频最多 20 MiB，交给当前所选服务转写。音频不会自动保存；文字仍需审阅后明确保存。</p>
      <p className="helper-text" id="voice-transcription-availability" aria-live="polite">录音转写：{transcriptionCapabilities.transcription.reason}</p>
      <div className="voice-answer-controls"><div className="voice-service-row"><span>AI 对话</span><ProviderSelect providers={providers} value={chatProviderId} onChange={(id) => { setChatProviderId(id); setChatModel(voiceConversationModels(providers.find((entry) => entry.id === id))[0] || ''); }} capability="chat" label="语音交流对话服务" disabled={busy} /><label className="voice-model-choice"><span>模型</span><select aria-label="语音交流对话模型" value={chatModel} onChange={(event) => setChatModel(event.target.value)} disabled={busy}><option value="">选择模型</option>{chatModel && !chatModels.includes(chatModel) && <option value={chatModel}>{chatModel} · 当前不可用</option>}{chatModels.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div>
        {conversation?.mode === 'agent' && <p className="helper-text">请开启普通或陪伴会话进行语音交流。</p>}
        {!voiceConversationProviderReady(chatProvider, 'chat') && <p className="helper-text">对话服务待配置或未启用，请选择可用服务。</p>}
        <div className="voice-excerpt-actions"><button className="primary" onClick={answerQuestion} disabled={busy || !text.trim() || !voiceConversationProviderReady(chatProvider, 'chat') || !chatModels.includes(chatModel) || conversation?.mode === 'agent' || voiceConversation.alreadySent(text, conversation?.id)}><MessageCircle size={15} />{turn.stage === 'preparing' ? '准备会话…' : turn.stage === 'answering' ? 'AI 回答中…' : '发送这一轮问题'}</button>{turnBusy && <button className="secondary" onClick={() => voiceConversation.cancel()}><CircleStop size={15} />{turn.stage === 'speaking' ? '停止朗读生成' : '停止回答'}</button>}{!busy && text && <button className="text-button" onClick={() => { setText(''); editor.current.update((value) => ({ ...value, hasTranscription: false, transcriptInput: null })); }}>清空文字，准备下一轮</button>}</div>
        {voiceConversation.alreadySent(text, conversation?.id) && <p className="helper-text">这段问题已经发送，未自动重发。查看会话中的结果，或清空文字准备下一轮。</p>}
      </div>
      <div className="voice-service-row"><span>文字朗读</span><ProviderSelect providers={providers} value={speechProviderId} onChange={setSpeechProviderId} capability="speech" label="文字朗读服务" disabled={busy} /></div>
      <VoiceSoundPicker provider={speechProvider} capability="speech" value={speechVoice} disabled={busy || saving} onChange={(voice) => setVoicePreferences((value) => ({ ...value, speechVoices: { ...value.speechVoices, [speechProviderId]: voice } }))} />
      {speechVoiceProblem && <p className="helper-text">{speechVoiceProblem}</p>}
      <p className="helper-text" id="voice-speech-availability" aria-live="polite">语音合成：{speechCapabilities.speech.reason}</p>
      {speechProvider?.id === 'kokoro' && <p className="helper-text">Kokoro 目前只支持美式英语朗读。可以用英语交流练习；其他语言的文字仍可保存。</p>}
      <div className="voice-excerpt-actions"><button className="secondary" onClick={speak} disabled={controls.speechDisabled || !!speechVoiceProblem} aria-describedby="voice-speech-availability"><Volume2 size={15} />{speaking ? '朗读生成中…' : '朗读编辑框文字'}</button>{speaking && <button className="secondary" onClick={() => speechRequest.current?.abort()}><CircleStop size={15} />取消朗读生成</button>}</div>
      {recognitionType && <p className="helper-text" id="voice-browser-recognition">浏览器听写由浏览器提供，独立于所选语音服务。</p>}
      {text.length > 4000 && <p className="helper-text">朗读合成每次最多 4,000 字；转写摘录最多保存 8,000 字，请审阅后编辑。</p>}
      {hasTranscription && <><p className="voice-provenance">录音、听写或你修改后的文字会作为客户端摘录保存，未经服务端核验。音频不会自动加入摘录。</p><div className="voice-excerpt-actions"><button className="secondary" disabled={saving || !text.trim() || text.length > 8000 || transcribing || recording || recognizing} onClick={() => saveInputs([currentTranscriptInput()])}><Save size={14} />{saving ? '保存中…' : '保存转写摘录'}</button><button className="text-button" disabled={!text.trim() || saving} onClick={() => onBringToChat(quotedVoiceText('transcription_excerpt', text.trim(), 'user'))}><ArrowRight size={14} />带回对话草稿</button></div></>}
      {speechSnapshot && speechSnapshot.audio.id !== turn.audio?.id && <div className="speech-snapshot"><ArtifactView artifact={speechSnapshot.audio} />{speechSnapshot.audioConfiguration && <VoiceAudioLabel configuration={speechSnapshot.audioConfiguration} />}<p className="voice-provenance">保存的是此次合成使用的文本和生成音频。编辑上方文字不会改变这份摘录。</p><p className="speech-snapshot-text">{speechSnapshot.input.text}</p><button className="secondary" disabled={saving || savedIds.has(speechSnapshot.input.clientRecordId)} onClick={() => saveInputs([speechSnapshot.input])}><Save size={14} />{savedIds.has(speechSnapshot.input.clientRecordId) ? '朗读摘录已保存' : '保存朗读文本与音频'}</button></div>}
      {turn.question && <section className="voice-conversation-result" aria-label="本轮语音交流"><div className="section-title"><h3>{turn.complete ? '本轮回答' : '本轮交流'}</h3><Badge tone={turn.complete ? 'green' : turn.error ? 'amber' : 'neutral'}>{turn.complete ? '已保存到对话' : turn.stage === 'answering' ? '正在回答' : turn.stage === 'preparing' ? '准备会话' : '尚未确认完整回答'}</Badge></div>{turn.roleId && <p className="voice-role-stamp">这一轮：{voicePersonality(turn.roleId).label}</p>}<p className="voice-question-label">你审阅并发送的问题</p><p className="voice-question-text">{turn.question}</p>{turn.answer && <p className="voice-answer-text">{turn.answer}</p>}{turn.error && <p className="voice-turn-error" role="status">{turn.error}</p>}{turn.speechError && <p className="voice-turn-error" role="status">{turn.speechError} 回答仍在，重新生成朗读不会再次发送问题。</p>}{turn.complete && <><div className="voice-excerpt-actions"><button className="secondary" onClick={speakAnswer} disabled={busy || !!answerSpeechProblem}><Volume2 size={15} />{turn.stage === 'speaking' ? '朗读生成中…' : turn.audio ? '重新生成回答朗读' : '朗读这次回答'}</button>{answerSpeechProblem && <span className="helper-text">{answerSpeechProblem}</span>}</div>{turn.audio && <><ArtifactView artifact={turn.audio} />{turn.audioConfiguration && <VoiceAudioLabel configuration={turn.audioConfiguration} />}</>}{speechSnapshot && speechSnapshot.audio.id === turn.audio?.id && <div className="voice-excerpt-actions"><button className="secondary" disabled={saving || savedIds.has(speechSnapshot.input.clientRecordId)} onClick={() => saveInputs([speechSnapshot.input])}><Save size={14} />{savedIds.has(speechSnapshot.input.clientRecordId) ? '回答朗读已保存' : '保存回答朗读'}</button><span className="helper-text">保存后可以从语音历史找回音频。</span></div>}</>}{onOpenConversation && turn.conversationId && <button className="text-button" disabled={busy} onClick={() => onOpenConversation(turn.conversationId!)}><ArrowRight size={14} />查看这次会话</button>}</section>}
    </div>
    <VoiceRecords records={records} onBringToChat={onBringToChat} />
    <p className="feature-footnote"><Play size={12} />切页后可继续当前会话的文字与朗读草稿；刷新页面或退出登录会清空。保存历史仍需点击保存。离开本页会结束麦克风与实时连接，未转写音频无法恢复。</p>
  </section>;
}
