import type { ProviderAttachment, TranscriptionContext } from '@companion/platform-contracts';
import { ProviderError, invalid } from './errors.ts';
import type { HttpClient } from './http.ts';

const MODEL = 'whisper-tiny';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 128 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm',
  'audio/ogg': 'ogg', 'audio/flac': 'flac',
};

export function localTranscriptionConfiguration(env: NodeJS.ProcessEnv) {
  const base = env.FASTER_WHISPER_BASE_URL;
  if (!base || !env.FASTER_WHISPER_MODEL) throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Configure the local transcription service on the server.', 503);
  // Match the literal authority before URL normalization accepts alternative IP forms.
  const match = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?\/v1\/?$/.exec(base);
  if (!match || match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535) || env.FASTER_WHISPER_MODEL !== MODEL)
    throw new ProviderError('INVALID_PROVIDER_CONFIG', 'Configure a literal loopback HTTP service with the supported transcription model.', 503);
  return { base: base.replace(/\/$/, ''), model: MODEL };
}

function interrupted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ProviderError('PROVIDER_INTERRUPTED', 'The local transcription request was interrupted.', 502);
}
function malformed(): never {
  throw new ProviderError('INVALID_PROVIDER_RESPONSE', 'The local transcription service returned an invalid response.');
}
function oversized(): never {
  throw new ProviderError('PROVIDER_OUTPUT_TOO_LARGE', 'The local transcription exceeded its size limit.', 413);
}
function validUnicode(value: string) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

async function transcription(response: Response, signal?: AbortSignal): Promise<{ text: string }> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel().catch(() => {}); malformed();
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    await response.body?.cancel().catch(() => {}); malformed();
  }
  if (declared !== null && Number(declared) > MAX_JSON_BYTES) { await response.body?.cancel().catch(() => {}); oversized(); }
  if (!response.body) malformed();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    interrupted(signal);
    while (true) {
      const part = await reader.read(); interrupted(signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_JSON_BYTES) oversized();
      chunks.push(part.value);
    }
    if (declared !== null && Number(declared) !== length) malformed();
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { malformed(); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'text')) malformed();
    const text = (value as { text: unknown }).text;
    if (typeof text !== 'string' || !validUnicode(text)) malformed();
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) oversized();
    interrupted(signal);
    // Empty text is a real no-speech result; no transcript is fabricated for silence.
    return { text };
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

export async function transcribeLocal(http: HttpClient, env: NodeJS.ProcessEnv, input: ProviderAttachment, context: TranscriptionContext = {}): Promise<{ text: string }> {
  const configured = localTranscriptionConfiguration(env);
  if (Object.keys(input).some(key => !['name', 'mime', 'bytes'].includes(key)) || Object.keys(context).some(key => !['provider', 'signal'].includes(key)))
    invalid('Unsupported local transcription input field.');
  const mime = typeof input.mime === 'string' ? input.mime.split(';')[0].trim().toLowerCase() : '';
  const extension = EXTENSIONS[mime];
  if (!Object.hasOwn(EXTENSIONS, mime) || !extension || typeof input.name !== 'string' || !(input.bytes instanceof Uint8Array) || !input.bytes.byteLength)
    invalid('Upload a supported audio recording.');
  if (input.bytes.byteLength > MAX_AUDIO_BYTES) invalid('The recording exceeds the 20 MiB local transcription limit.');
  interrupted(context.signal);
  const form = new FormData(); form.append('model', configured.model);
  // The service receives unchanged audio bytes, a canonical MIME and a generated filename.
  form.append('file', new Blob([new Uint8Array(input.bytes)], { type: mime }), `recording.${extension}`);
  try {
    const response = await http.request(`${configured.base}/audio/transcriptions`, { method: 'POST', body: form, signal: context.signal });
    return await transcription(response, context.signal);
  } catch (error) {
    interrupted(context.signal);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('LOCAL_TRANSCRIPTION_FAILED', 'The local transcription service could not complete the recording. Try again later.');
  }
}
