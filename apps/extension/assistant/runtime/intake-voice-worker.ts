import { browser } from 'wxt/browser';
import { INTAKE_RECORDER_PORT, parseIntakeRecorderMessage, type IntakeVoiceControl, type IntakeVoiceEvent, type IntakeRecorderCommand,
  type AssistantSessionIdentity, type IntakeClientCode, type IntakeSession, type IntakeConfiguration, type Uuid } from '@edaix/contracts';
import type { createOwnerIntake } from '../features/intake/owner-intake';
import { decodeIntakeAudio } from '../features/intake/audio';
type VoiceEventData = IntakeVoiceEvent extends infer E ? E extends IntakeVoiceEvent ? Omit<E, 'kind' | 'id'> : never : never;
type Port = ReturnType<typeof browser.runtime.connect>;
type Job = { id: string; parent: Port; identity: AssistantSessionIdentity; abort: AbortController; admitted(): Promise<boolean>; tabId?: number;
  url?: string; recorder?: Port; session?: IntakeSession; config?: IntakeConfiguration; maximum: number; samples: number; index: number; queued: number;
  stopped: boolean; ready: boolean; chain: Promise<void>; deadline?: ReturnType<typeof setTimeout> };
/** Only the authenticated Assistant can create a recorder capability; an arbitrary extension tab cannot upload audio. */
export function installIntakeVoiceWorker(intake: ReturnType<typeof createOwnerIntake>, current: () => Promise<AssistantSessionIdentity | null>, locale: () => 'en-US' | 'zh-CN') {
  let job: Job | null = null;
  const emit = (j: Job, event: VoiceEventData) => {
    if (job !== j || j.abort.signal.aborted) return;
    try { j.parent.postMessage({ kind: 'assistant/voice-event-v1', id: j.id, ...event }); } catch { end(j, 'UNAVAILABLE'); }
  };
  function command(j: Job, value: IntakeRecorderCommand) { try { j.recorder?.postMessage(value); } catch { end(j, 'UNAVAILABLE'); } }
  function end(j: Job, code: IntakeClientCode | null) {
    if (job !== j) return;
    // Revoke before disconnect callbacks or asynchronous provider completions can run.
    job = null; clearTimeout(j.deadline); j.abort.abort();
    try { j.recorder?.postMessage({ kind: 'CANCEL' } satisfies IntakeRecorderCommand); j.recorder?.disconnect(); } catch { code ??= 'UNAVAILABLE'; }
    try { j.parent.postMessage({ kind: 'assistant/voice-event-v1', id: j.id, event: 'END', code } satisfies IntakeVoiceEvent); } catch { return; }
  }
  async function valid(j: Job) { const identity = await current(); return job === j && !j.abort.signal.aborted && identity?.ownerId === j.identity.ownerId && identity.generation === j.identity.generation && await j.admitted(); }
  async function control(parent: Port, request: IntakeVoiceControl, identity: AssistantSessionIdentity, signal: AbortSignal, admitted: () => Promise<boolean>) {
    if (request.operation !== 'START') {
      if (job?.parent !== parent || job.id !== request.id) return;
      if (request.operation === 'CANCEL') end(job, 'CANCELLED'); else command(job, { kind: 'STOP' }); return;
    }
    if (job) { parent.postMessage({ kind: 'assistant/voice-event-v1', id: request.id, event: 'END', code: 'LOCKED' } satisfies IntakeVoiceEvent); return; }
    const j: Job = { id: request.id, parent, identity, abort: new AbortController(), admitted, maximum: 0, samples: 0, index: 0, queued: 0, stopped: false, ready: false, chain: Promise.resolve() }; job = j;
    signal.addEventListener('abort', () => end(j, 'CANCELLED'), { once: true });
    if (signal.aborted) { end(j, 'CANCELLED'); return; }
    try {
      if (!await valid(j)) { end(j, 'OWNER_CHANGED'); return; }
      let result = await intake.execute(identity, { operation: 'CURRENT' }, j.abort.signal, admitted);
      if (!result.ok) { end(j, result.code); return; }
      if (!result.value.session) result = await intake.execute(identity, { operation: 'START', request: { clientRequestId: crypto.randomUUID() as Uuid, locale: locale() } }, j.abort.signal, admitted);
      if (!result.ok) { end(j, result.code); return; }
      const view = result.value;
      if (!view.session || !view.configuration || view.usage.speechSeconds.state !== 'AVAILABLE') { end(j, view.usage.speechSeconds.state === 'EXHAUSTED' ? 'USAGE_EXHAUSTED' : 'UNAVAILABLE'); return; }
      j.session = view.session; j.config = view.configuration; j.maximum = Math.min(view.configuration.maxRecordingSeconds, view.usage.speechSeconds.remaining ?? 900);
      if (!await valid(j)) { end(j, 'OWNER_CHANGED'); return; }
      const tab = await browser.tabs.create({ url: 'about:blank', active: true });
      if (typeof tab.id !== 'number') { end(j, 'UNAVAILABLE'); return; } j.tabId = tab.id;
      if (!await valid(j)) { await browser.tabs.remove(tab.id); end(j, 'OWNER_CHANGED'); return; }
      j.url = browser.runtime.getURL('/intake-recorder.html') + '?job=' + crypto.randomUUID() + '&locale=' + locale();
      j.deadline = setTimeout(() => end(j, 'CANCELLED'), (j.maximum + 180) * 1000);
      await browser.tabs.update(tab.id, { url: j.url }); emit(j, { event: 'STATE', state: 'recording' });
    } catch { end(j, 'UNAVAILABLE'); }
  }
  browser.runtime.onConnect.addListener(port => {
    if (port.name !== INTAKE_RECORDER_PORT) return;
    const j = job, sender = port.sender;
    if (!j || j.recorder || sender?.id !== browser.runtime.id || sender.tab?.id !== j.tabId || sender.frameId !== 0 || !sender.documentId || sender.url !== j.url) { port.disconnect(); return; }
    j.recorder = port;
    port.onDisconnect.addListener(() => end(j, 'CANCELLED'));
    port.onMessage.addListener(raw => {
      if (job !== j) return;
      const value = parseIntakeRecorderMessage(raw); if (!value) { end(j, 'VALIDATION_FAILED'); return; }
      if (value.kind === 'ERROR') { end(j, value.code); return; }
      if (value.kind === 'READY') {
        if (j.ready || !j.config) { end(j, 'VALIDATION_FAILED'); return; } j.ready = true;
        void (async () => {
          const contexts = await browser.runtime.getContexts({ tabIds: [j.tabId!], documentUrls: [j.url!] });
          if (!contexts.some(c => c.documentId === sender.documentId) || !await valid(j)) { end(j, 'SENDER_REJECTED'); return; }
          command(j, { kind: 'START', maximumSeconds: j.maximum, chunkSeconds: Math.min(30, j.config!.chunkSeconds) });
        })().catch(() => end(j, 'UNAVAILABLE')); return;
      }
      if (!j.ready || j.stopped) { end(j, 'VALIDATION_FAILED'); return; }
      if (value.kind === 'STOPPED') { j.stopped = true; emit(j, { event: 'STATE', state: 'processing' }); void j.chain.then(() => end(j, null)); return; }
      if (value.index !== j.index++ || j.queued >= 3) { end(j, 'LIMIT_REACHED'); return; }
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(value.base64), c => c.charCodeAt(0)); } catch { end(j, 'AUDIO_INVALID'); return; }
      const audio = decodeIntakeAudio(bytes);
      if (!audio || audio.samples > Math.min(30, j.config!.chunkSeconds) * 16000 || j.samples + audio.samples > j.maximum * 16000) { end(j, 'AUDIO_INVALID'); return; }
      j.samples += audio.samples; j.queued++;
      j.chain = j.chain.then(async () => {
        if (!await valid(j)) { end(j, 'OWNER_CHANGED'); return; }
        const requestId = crypto.randomUUID();
        const result = await intake.speech(j.identity, j.session!.id, requestId, j.session!.revision, bytes, j.abort.signal, () => valid(j));
        if (!await valid(j)) { end(j, 'OWNER_CHANGED'); return; }
        if (!result.ok) { end(j, result.code); return; }
        const session = result.value.session, turn = session?.turns.find(t => t.id === requestId);
        if (!session || turn?.status !== 'COMPLETED' || turn.kind !== 'SPEECH') { end(j, 'UNAVAILABLE'); return; }
        j.session = session; emit(j, { event: 'TRANSCRIPT', text: turn.text }); command(j, { kind: 'ACK', index: value.index });
      }).catch(() => end(j, 'UNAVAILABLE')).finally(() => { j.queued--; });
    });
  });
  browser.tabs.onRemoved.addListener(id => { if (job?.tabId === id) end(job, 'CANCELLED'); });
  return { control, invalidate: () => { if (job) end(job, 'OWNER_CHANGED'); } };
}
