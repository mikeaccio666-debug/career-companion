import type { VoiceSessionInput } from '@companion/platform-contracts';
import type { VoiceSession } from './types.ts';
interface RecordingResource { state: string; onstop: unknown; ondataavailable: unknown; stop(): void; }
interface RecognitionResource { onresult: unknown; onerror: unknown; onend: unknown; stop(): void; }
export interface VoiceSessionResources {
  controllers: Iterable<AbortController>;
  recognition?: RecognitionResource | null;
  recorder?: RecordingResource | null;
  peer?: { close(): void } | null;
  microphone?: { getTracks(): { stop(): void }[] } | null;
  audio?: { pause(): void; srcObject: unknown } | null;
}
// A browser's individual stop/close call may throw. Still release every other resource,
// and detach recording handlers before stop so leaving never starts a transcription upload.
export function disposeVoiceSession(resources: VoiceSessionResources): void {
  const release = (action: () => void) => { try { action(); } catch { /* Cleanup never publishes browser/resource details. */ } };
  for (const controller of resources.controllers) release(() => controller.abort());
  const recognition = resources.recognition;
  if (recognition) release(() => { recognition.onresult = null; recognition.onerror = null; recognition.onend = null; recognition.stop(); });
  release(() => resources.peer?.close());
  const recorder = resources.recorder;
  if (recorder) release(() => { recorder.onstop = null; recorder.ondataavailable = null; if (recorder.state !== 'inactive') recorder.stop(); });
  release(() => { for (const track of resources.microphone?.getTracks() || []) release(() => track.stop()); });
  if (resources.audio) {
    release(() => resources.audio!.pause());
    release(() => { resources.audio!.srcObject = null; });
  }
}

/** Creation uses the same cancellation boundary as negotiation; late leases are released without publishing credentials. */
export async function requestVoiceSession(body: VoiceSessionInput, signal: AbortSignal, isCurrent: () => boolean, read: (path: string, init: RequestInit) => Promise<unknown>, release: (sessionId: string) => void): Promise<VoiceSession | null> {
  signal.throwIfAborted();
  if (!isCurrent()) return null;
  const session = await read('/voice/session', { method: 'POST', body: JSON.stringify(body), signal }) as VoiceSession;
  if (signal.aborted || !isCurrent()) { if (typeof session?.sessionId === 'string' && session.sessionId) release(session.sessionId); return null; }
  return session;
}
