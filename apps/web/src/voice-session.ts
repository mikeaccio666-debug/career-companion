import type { VoiceSessionInput } from '@companion/platform-contracts';
import type { VoiceSession } from './types.ts';
interface RecordingResource { state: string; onstop: unknown; ondataavailable: unknown; onerror?: unknown; stop(): void; }
interface RecognitionResource { onresult: unknown; onerror: unknown; onend: unknown; stop(): void; }
export interface VoiceSessionResources {
  controllers: Iterable<AbortController>;
  recognition?: RecognitionResource | null;
  recording?: { cancel(): void } | null;
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
  release(() => resources.recording?.cancel());
  const recorder = resources.recorder;
  if (recorder) release(() => { recorder.onstop = null; recorder.ondataavailable = null; recorder.onerror = null; if (recorder.state !== 'inactive') recorder.stop(); });
  release(() => { for (const track of resources.microphone?.getTracks() || []) release(() => track.stop()); });
  if (resources.audio) {
    release(() => resources.audio!.pause());
    release(() => { resources.audio!.srcObject = null; });
  }
}

/** Browser/device details never become product error text. */
export function microphoneErrorText(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return '麦克风权限未获允许。请在浏览器的网站设置中允许使用麦克风，或导入音频。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到可用麦克风。请连接录音设备，或导入音频。';
  if (name === 'NotReadableError' || name === 'TrackStartError') return '暂时无法读取麦克风。请检查设备和其他正在使用麦克风的应用，再重试。';
  if (name === 'SecurityError') return '当前网页无法使用麦克风。请检查 HTTPS 地址和浏览器的网站权限。';
  return '麦克风未能启动。原有文字仍在，你可以重试或导入音频。';
}

/** Creation uses the same cancellation boundary as negotiation; late leases are released without publishing credentials. */
export async function requestVoiceSession(body: VoiceSessionInput, signal: AbortSignal, isCurrent: () => boolean, read: (path: string, init: RequestInit) => Promise<unknown>, release: (sessionId: string) => void): Promise<VoiceSession | null> {
  signal.throwIfAborted();
  if (!isCurrent()) return null;
  const session = await read('/voice/session', { method: 'POST', body: JSON.stringify(body), signal }) as VoiceSession;
  if (signal.aborted || !isCurrent()) { if (typeof session?.sessionId === 'string' && session.sessionId) release(session.sessionId); return null; }
  return session;
}
