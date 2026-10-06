import type { GeneratedArtifact, SpeechInput } from '@companion/platform-contracts';
import { ProviderError, invalid } from './errors.ts';
import type { HttpClient } from './http.ts';
import { validateSpeechInput } from './voice-input.ts';

// Official single-speaker Create speech support, verified 2026-10-06:
// https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech
// https://elevenlabs.io/docs/api-reference/text-to-speech/convert
// v4 Turbo is documented for the dialogue WebSocket, not this HTTP adapter.
export const ELEVENLABS_SPEECH_MODELS = ['eleven_v4', 'eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5'] as const;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

export function elevenLabsConfiguration(env: NodeJS.ProcessEnv) {
  const key = env.ELEVENLABS_API_KEY, model = env.ELEVENLABS_TTS_MODEL, voice = env.ELEVENLABS_TTS_VOICE_ID;
  if ([key, model, voice].some(value => value === undefined || typeof value === 'string' && !value.trim())) {
    throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'Configure the speech provider credentials, model and voice on the server.', 503);
  }
  const history = env.ELEVENLABS_ALLOW_PROVIDER_HISTORY;
  if (typeof key !== 'string' || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key) ||
      typeof model !== 'string' || !(ELEVENLABS_SPEECH_MODELS as readonly string[]).includes(model) ||
      typeof voice !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(voice) ||
      history !== undefined && history !== '0' && history !== '1') {
    throw new ProviderError('INVALID_PROVIDER_CONFIG', 'Configure a supported speech model, a valid voice identifier and an explicit provider-history preference.', 503);
  }
  // False requests the provider's enterprise-only zero-retention mode. Account rejection
  // remains visible; only a trusted server opt-in may allow provider generation history.
  return { key, model, voice, allowProviderHistory: history === '1' };
}

function interrupted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ProviderError('PROVIDER_INTERRUPTED', 'The speech request was interrupted.', 502);
}
function malformed(): never {
  throw new ProviderError('INVALID_PROVIDER_RESPONSE', 'The speech provider returned an invalid audio recording.');
}
function validateMp3Signature(bytes: Uint8Array) {
  // This checks the container signature only; decoding and listening remain separate checks.
  const id3 = bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 &&
    [2, 3, 4].includes(bytes[3]) && bytes[4] !== 0xff && bytes.slice(6, 10).every(value => value < 0x80);
  const frame = bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 &&
    ((bytes[1] >> 3) & 3) !== 1 && ((bytes[1] >> 1) & 3) === 1 &&
    (bytes[2] >> 4) > 0 && (bytes[2] >> 4) < 15 && ((bytes[2] >> 2) & 3) !== 3 && (bytes[3] & 3) !== 2;
  if (!id3 && !frame) malformed();
}
async function recording(response: Response, signal?: AbortSignal) {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'audio/mpeg') {
    await response.body?.cancel().catch(() => {}); malformed();
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    await response.body?.cancel().catch(() => {}); malformed();
  }
  if (declared !== null && Number(declared) > MAX_AUDIO_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderError('PROVIDER_OUTPUT_TOO_LARGE', 'The generated output exceeds the size limit.', 413);
  }
  if (!response.body) malformed();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    interrupted(signal);
    while (true) {
      const part = await reader.read(); interrupted(signal); if (part.done) break;
      if ((length += part.value.byteLength) > MAX_AUDIO_BYTES) {
        throw new ProviderError('PROVIDER_OUTPUT_TOO_LARGE', 'The generated output exceeds the size limit.', 413);
      }
      chunks.push(part.value);
    }
    if (length === 0 || declared !== null && length !== Number(declared)) malformed();
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    validateMp3Signature(bytes);
    interrupted(signal); return bytes;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

/** Commercial-call permission and provider selection are enforced by the runtime before dispatch. */
export async function speechElevenLabs(http: HttpClient, env: NodeJS.ProcessEnv, input: SpeechInput, signal?: AbortSignal): Promise<GeneratedArtifact> {
  const configured = elevenLabsConfiguration(env);
  validateSpeechInput(input);
  if (input.instructions !== undefined) invalid('The selected speech provider does not accept expression instructions.');
  if (input.provider !== undefined && input.provider !== 'elevenlabs' ||
      input.model !== undefined && input.model !== configured.model || input.voice !== undefined && input.voice !== configured.voice) {
    invalid('Select the speech provider, model and voice configured on the server.');
  }
  interrupted(signal);
  const target = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(configured.voice)}`);
  target.searchParams.set('output_format', 'mp3_44100_128');
  target.searchParams.set('enable_logging', String(configured.allowProviderHistory));
  try {
    const response = await http.request(target, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'xi-api-key': configured.key, Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: input.text, model_id: configured.model, use_pvc_as_ivc: false }), signal,
    });
    return { name: 'speech.mp3', mime: 'audio/mpeg', bytes: await recording(response, signal) };
  } catch (error) {
    interrupted(signal);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('ELEVENLABS_SPEECH_FAILED', 'The speech provider could not complete the recording. Try again later.');
  }
}
