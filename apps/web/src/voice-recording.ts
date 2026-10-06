import { MAX_TRANSCRIPTION_AUDIO_BYTES } from './voice-transcription.ts';

/** Explicit containers accepted by the transcription client; no browser-default MIME guessing. */
export const RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4',
  'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg',
] as const;

export function supportedRecordingMimeType(isTypeSupported: (mime: string) => boolean): string {
  for (const mime of RECORDING_MIME_TYPES) {
    try { if (isTypeSupported(mime)) return mime; } catch { /* A broken probe must not hide another supported container. */ }
  }
  return '';
}

export type RecordingRecorder = Pick<MediaRecorder, 'mimeType' | 'state' | 'ondataavailable' | 'onstop' | 'onerror' | 'start' | 'stop'>;
export interface VoiceRecordingCallbacks {
  isCurrent(): boolean;
  onComplete(audio: Blob): void | Promise<void>;
  onStopped(): void | Promise<void>;
  onError(message: string): void | Promise<void>;
}
export interface VoiceRecordingDependencies {
  isTypeSupported(mime: string): boolean;
  createRecorder(stream: MediaStream, options: MediaRecorderOptions): RecordingRecorder;
  /** Smaller limits support deterministic tests; never expands the application's upload limit. */
  maxBytes?: number;
}

const messages = {
  unsupported: '当前浏览器无法生成支持的录音格式。请改用音频文件转写。',
  starting: '录音未能开始，麦克风已释放。请重试或导入音频文件。',
  interrupted: '录音已中断，未上传音频。请重新录制。',
  stopping: '录音未能正常结束，未上传音频。请重新录制。',
  excessive: '录音超过 20 MiB，已停止且未上传。请缩短录音后重试。',
  empty: '没有收到可用录音，未上传音频。请重新录制或导入音频文件。',
} as const;
const containers = new Set(['audio/webm', 'audio/mp4', 'audio/ogg']);
function recordingContainer(mime: string): string {
  const container = mime.split(';', 1)[0].trim().toLowerCase();
  return containers.has(container) ? container : '';
}
function safely(action: () => void | Promise<void>): void {
  try { const pending = action(); if (pending) void Promise.resolve(pending).catch(() => {}); } catch { /* A callback failure never leaks microphone resources or browser details. */ }
}

/**
 * A microphone stream has one recording owner. Only explicit stop() can complete;
 * errors, ended tracks, stale editors and cancel() discard every captured byte.
 */
export class BrowserVoiceRecording {
  private stage: 'idle' | 'recording' | 'stopping' | 'terminal' = 'idle';
  private recorder: RecordingRecorder | null = null;
  private tracks: MediaStreamTrack[] | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private container = '';
  private readonly stream: MediaStream;
  private readonly callbacks: VoiceRecordingCallbacks;
  private readonly dependencies: VoiceRecordingDependencies;
  private readonly onTrackEnded: EventListener = () => this.fail(messages.interrupted);

  constructor(stream: MediaStream, callbacks: VoiceRecordingCallbacks, dependencies?: VoiceRecordingDependencies) {
    this.stream = stream; this.callbacks = callbacks;
    this.dependencies = dependencies ?? {
      isTypeSupported: (mime) => typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(mime),
      createRecorder: (source, options) => new MediaRecorder(source, options),
    };
  }

  start(): void {
    if (this.stage !== 'idle') return;
    if (!this.current()) { this.cancel(); return; }
    const mimeType = supportedRecordingMimeType(this.dependencies.isTypeSupported);
    if (!mimeType) { this.fail(messages.unsupported); return; }
    const maximum = this.maximumBytes();
    if (!Number.isSafeInteger(maximum) || maximum <= 0) { this.fail(messages.starting); return; }
    try {
      this.tracks = this.stream.getTracks();
      if (!this.tracks.length || this.tracks.some((track) => track.readyState === 'ended')) { this.fail(messages.interrupted); return; }
      for (const track of this.tracks) track.addEventListener('ended', this.onTrackEnded);
      if (!this.current() || this.terminated()) { this.cancel(); return; }
      const recorder = this.dependencies.createRecorder(this.stream, { mimeType });
      if (this.terminated()) {
        // A track/editor may end synchronously inside an injected/native constructor.
        safely(() => { recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null; if (recorder.state !== 'inactive') recorder.stop(); });
        return;
      }
      this.recorder = recorder;
      if (!this.current() || this.terminated()) { this.cancel(); return; }
      if (recorder.mimeType && !this.acceptContainer(recorder.mimeType)) { this.fail(messages.unsupported); return; }
      recorder.ondataavailable = (event) => this.receive(event.data);
      recorder.onerror = () => this.fail(messages.interrupted);
      recorder.onstop = () => this.finish();
      this.stage = 'recording';
      recorder.start(1000);
      if (!this.current()) this.cancel();
      else if (this.stage === 'recording' && recorder.state !== 'recording') this.fail(messages.starting);
    } catch { this.fail(messages.starting); }
  }

  /** Stops and completes only this explicitly reviewed recording action. */
  stop(): void {
    if (this.stage !== 'recording') return;
    if (!this.current()) { this.cancel(); return; }
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') { this.fail(messages.interrupted); return; }
    this.stage = 'stopping';
    try { recorder.stop(); } catch { this.fail(messages.stopping, false); }
  }

  /** Leaving, switching account or canceling never invokes completion/error callbacks. */
  cancel(): void {
    if (this.stage === 'terminal') return;
    this.stage = 'terminal';
    this.release();
  }

  private current(): boolean {
    try { return this.callbacks.isCurrent(); } catch { return false; }
  }
  private terminated(): boolean { return this.stage === 'terminal'; }
  private maximumBytes(): number {
    return Math.min(this.dependencies.maxBytes ?? MAX_TRANSCRIPTION_AUDIO_BYTES, MAX_TRANSCRIPTION_AUDIO_BYTES);
  }
  private acceptContainer(mime: string): boolean {
    const container = recordingContainer(mime);
    if (!container || this.container && this.container !== container) return false;
    this.container = container;
    return true;
  }
  private receive(chunk: Blob): void {
    if (this.stage !== 'recording' && this.stage !== 'stopping') return;
    if (!this.current()) { this.cancel(); return; }
    if (!(chunk instanceof Blob)) { this.fail(messages.unsupported); return; }
    if (!chunk.size) return;
    if (chunk.type && !this.acceptContainer(chunk.type)) { this.fail(messages.unsupported); return; }
    if (this.recorder?.mimeType && !this.acceptContainer(this.recorder.mimeType)) { this.fail(messages.unsupported); return; }
    this.bytes += chunk.size;
    if (this.bytes > this.maximumBytes()) { this.fail(messages.excessive); return; }
    this.chunks.push(chunk);
  }
  private finish(): void {
    if (this.stage === 'terminal') return;
    if (!this.current()) { this.cancel(); return; }
    if (this.stage !== 'stopping') { this.fail(messages.interrupted); return; }
    if (this.recorder?.mimeType && !this.acceptContainer(this.recorder.mimeType)) { this.fail(messages.unsupported); return; }
    if (!this.container) { this.fail(messages.unsupported); return; }
    if (!this.bytes) { this.fail(messages.empty); return; }
    const audio = new Blob(this.chunks, { type: this.container });
    this.stage = 'terminal';
    this.release();
    this.notify(() => this.callbacks.onStopped());
    this.notify(() => this.callbacks.onComplete(audio));
  }
  private fail(message: string, stopRecorder = true): void {
    if (this.stage === 'terminal') return;
    this.stage = 'terminal';
    this.release(stopRecorder);
    this.notify(() => this.callbacks.onStopped());
    this.notify(() => this.callbacks.onError(message));
  }
  private notify(action: () => void | Promise<void>): void {
    if (this.current()) safely(action);
  }
  private release(stopRecorder = true): void {
    const recorder = this.recorder; this.recorder = null;
    this.chunks.length = 0; this.bytes = 0; this.container = '';
    if (recorder) {
      safely(() => { recorder.ondataavailable = null; });
      safely(() => { recorder.onstop = null; });
      safely(() => { recorder.onerror = null; });
      if (stopRecorder) safely(() => { if (recorder.state !== 'inactive') recorder.stop(); });
    }
    let tracks = this.tracks; this.tracks = [];
    if (!tracks) { try { tracks = this.stream.getTracks(); } catch { tracks = []; } }
    for (const track of tracks) {
      safely(() => track.removeEventListener('ended', this.onTrackEnded));
      safely(() => track.stop());
    }
  }
}
