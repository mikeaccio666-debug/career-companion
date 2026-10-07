import { studentTranscriptionForm } from './student-requests.ts';
export { MAX_TRANSCRIPTION_AUDIO_BYTES } from './voice-audio-limits.ts';
export const TRANSCRIPTION_AUDIO_ACCEPT = 'audio/*,video/webm,.wav,.mp3,.m4a,.webm,.ogg,.flac';
export type TranscriptionRequest = (path: string, init: RequestInit) => Promise<unknown>;
/** The server chooses the route; only normalized audio, never its original filename or selectors, travels. */
export const transcriptionForm = studentTranscriptionForm;
export async function transcribeAudio(audio: Blob, signal: AbortSignal, request: TranscriptionRequest): Promise<string> {
  signal.throwIfAborted();
  const result = await request('/voice/transcribe', { method: 'POST', body: transcriptionForm(audio), signal });
  return transcriptionText(result, signal);
}
export const transcribeRoutedAudio = transcribeAudio;
function transcriptionText(result: unknown, signal: AbortSignal): string {
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
