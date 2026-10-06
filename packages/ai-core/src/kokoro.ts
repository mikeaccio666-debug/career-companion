import type { GeneratedArtifact, SpeechInput } from '@companion/platform-contracts';
import { ProviderError, invalid } from './errors.ts';
import type { HttpClient } from './http.ts';
import { KOKORO_MODEL as MODEL, KOKORO_VOICE as VOICE, validateSpeechInput } from './voice-input.ts';

const MAX_WAV_BYTES = 30 * 1024 * 1024;
export function kokoroConfiguration(env: NodeJS.ProcessEnv) {
  const base = env.KOKORO_BASE_URL;
  if (!base || !env.KOKORO_TTS_MODEL || !env.KOKORO_TTS_VOICE) throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Configure the local English speech service on the server.', 503);
  // Validate the literal authority before URL parsing, which otherwise normalizes
  // hexadecimal, decimal and shortened IP forms into a loopback address.
  const match = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?\/v1\/?$/.exec(base);
  if (!match || match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535) || env.KOKORO_TTS_MODEL !== MODEL || env.KOKORO_TTS_VOICE !== VOICE) throw new ProviderError('INVALID_PROVIDER_CONFIG', 'Configure a literal loopback HTTP service with the supported English model and voice.', 503);
  return { base: base.replace(/\/$/, ''), model: MODEL, voice: VOICE };
}
function interrupted(signal?: AbortSignal) { if (signal?.aborted) throw new ProviderError('PROVIDER_INTERRUPTED', 'The local speech request was interrupted.', 502); }
function malformed(): never { throw new ProviderError('INVALID_PROVIDER_RESPONSE', 'The local speech service returned an invalid WAV recording.'); }
function validateWav(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 44 || buffer.length > MAX_WAV_BYTES || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE' || buffer.readUInt32LE(4) !== buffer.length - 8) malformed();
  let offset = 12, format = false, data = false;
  while (offset + 8 <= buffer.length) {
    const kind = buffer.toString('latin1', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8, end = start + size;
    if (end > buffer.length || end + size % 2 > buffer.length) malformed();
    if (kind === 'fmt ') {
      if (format || data || (size !== 16 && size !== 18) || size === 18 && buffer.readUInt16LE(start + 16) !== 0 || buffer.readUInt16LE(start) !== 1 || buffer.readUInt16LE(start + 2) !== 1 || buffer.readUInt32LE(start + 4) !== 24000 || buffer.readUInt32LE(start + 8) !== 48000 || buffer.readUInt16LE(start + 12) !== 2 || buffer.readUInt16LE(start + 14) !== 16) malformed();
      format = true;
    } else if (kind === 'data') {
      if (!format || data || !size || size % 2) malformed(); data = true;
    }
    offset = end + size % 2;
  }
  if (!format || !data || offset !== buffer.length) malformed();
}
async function recording(response: Response, signal?: AbortSignal) {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'audio/wav') { await response.body?.cancel().catch(() => {}); malformed(); }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) { await response.body?.cancel().catch(() => {}); malformed(); }
  if (declared !== null && Number(declared) > MAX_WAV_BYTES) { await response.body?.cancel().catch(() => {}); throw new ProviderError('PROVIDER_OUTPUT_TOO_LARGE', 'The local speech recording exceeded its size limit.', 413); }
  if (!response.body) malformed();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    interrupted(signal);
    while (true) {
      const part = await reader.read(); interrupted(signal); if (part.done) break;
      if ((length += part.value.byteLength) > MAX_WAV_BYTES) throw new ProviderError('PROVIDER_OUTPUT_TOO_LARGE', 'The local speech recording exceeded its size limit.', 413);
      chunks.push(part.value);
    }
    if (declared !== null && length !== Number(declared)) malformed();
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    validateWav(bytes); interrupted(signal); return bytes;
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function speechKokoro(http: HttpClient, env: NodeJS.ProcessEnv, input: SpeechInput, signal?: AbortSignal): Promise<GeneratedArtifact> {
  const configured = kokoroConfiguration(env);
  validateSpeechInput(input);
  if (input.instructions !== undefined) invalid('The local speech model does not support expression instructions.');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000) invalid('English speech input must contain between 1 and 4000 characters.');
  if (Array.from(input.text).some(character => /\p{Letter}/u.test(character) && !/\p{Script=Latin}/u.test(character))) invalid('This local speech voice supports English text only.');
  if (input.model !== undefined && input.model !== configured.model || input.voice !== undefined && input.voice !== configured.voice) invalid('Select the supported local English model and voice.');
  interrupted(signal);
  try {
    const response = await http.request(`${configured.base}/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: configured.model, input: input.text, voice: configured.voice, response_format: 'wav' }), signal });
    return { name: 'speech.wav', mime: 'audio/wav', bytes: await recording(response, signal) };
  } catch (error) {
    interrupted(signal);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('LOCAL_SPEECH_FAILED', 'The local speech service could not complete the recording. Try again later.');
  }
}
