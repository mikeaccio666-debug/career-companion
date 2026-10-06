export const MAX_TRANSCRIPTION_AUDIO_BYTES = 20 * 1024 * 1024;
export const TRANSCRIPTION_AUDIO_ACCEPT = 'audio/*,video/webm,.wav,.mp3,.m4a,.webm,.ogg,.flac';
const extensions: Record<string, string> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
};
const inferredTypes: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' };
const canonicalTypes: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'video/webm': 'audio/webm', 'audio/m4a': 'audio/mp4', 'audio/x-m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg', 'audio/x-flac': 'audio/flac' };
export type TranscriptionRequest = (path: string, init: RequestInit) => Promise<unknown>;

/** The original filename never travels to the model; the server validates actual audio. */
export function transcriptionForm(audio: Blob, provider: string): FormData {
  if (!audio.size) throw new Error('请选择非空音频文件。');
  if (audio.size > MAX_TRANSCRIPTION_AUDIO_BYTES) throw new Error('音频最多 20 MiB，请缩短录音后重试。');
  if (!provider || provider.length > 80) throw new Error('请选择已配置的转写服务。');
  let mime = audio.type.split(';')[0].trim().toLowerCase();
  if (!mime && 'name' in audio && typeof audio.name === 'string') { const extension = audio.name.split('.').pop()?.toLowerCase() || ''; mime = Object.hasOwn(inferredTypes, extension) ? inferredTypes[extension] : ''; }
  if (Object.hasOwn(canonicalTypes, mime)) mime = canonicalTypes[mime];
  if (!Object.hasOwn(extensions, mime)) throw new Error('请选择 WAV、MP3、M4A、WebM、OGG 或 FLAC 音频。');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `recording.${extensions[mime]}`);
  form.append('provider', provider);
  return form;
}

export async function transcribeAudio(audio: Blob, provider: string, signal: AbortSignal, request: TranscriptionRequest): Promise<string> {
  signal.throwIfAborted();
  const result = await request('/voice/transcribe', { method: 'POST', body: transcriptionForm(audio, provider), signal });
  signal.throwIfAborted();
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as { text?: unknown }).text !== 'string') throw new Error('转写服务没有返回有效文字。');
  const text = (result as { text: string }).text;
  if (new TextEncoder().encode(text).byteLength > 64 * 1024 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) throw new Error('转写结果超过本页限制或格式无效，原文字已保留。');
  return text.trim();
}

export function appendTranscriptionText(previous: string, transcript: string): string {
  const combined = transcript ? `${previous}${previous ? '\n' : ''}${transcript}` : previous;
  if (combined.length > 8000) throw new Error('合并后的转写文字超过 8,000 字，请先保存并精简原文字后重试。');
  return combined;
}
