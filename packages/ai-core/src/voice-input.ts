import type { ProviderStatus, SpeechInput, VoiceSessionInput } from '@companion/platform-contracts';
import { invalid } from './errors.ts';

type VoiceOptions = NonNullable<NonNullable<ProviderStatus['voiceOptions']>['speech']>;
// Official TTS and Realtime guides, verified 2026-10-06. These sets differ.
export const OPENAI_SPEECH_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;
export const OPENAI_REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;
const LEGACY_SPEECH_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'] as const;
// Do not infer support from a future snapshot's name or an arbitrary prefix.
const INSTRUCTION_MODELS = new Set(['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts-2025-12-15']);
const LEGACY_MODELS = new Set(['tts-1', 'tts-1-hd']);
export const KOKORO_MODEL = 'kokoro-82m', KOKORO_VOICE = 'af_heart';

function fields(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('Unsupported voice input field.');
}
function optionalText(value: unknown, name: string, maximum: number) {
  if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > maximum)) invalid(`Provide a nonempty ${name} of at most ${maximum} characters.`);
}
export function validateSpeechInput(input: SpeechInput) {
  fields(input, ['provider', 'text', 'voice', 'model', 'instructions']);
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4096) invalid('Speech input must contain between 1 and 4096 characters.');
  optionalText(input.model, 'speech model', 160);
  optionalText(input.voice, 'speech voice', 100);
  optionalText(input.instructions, 'speech instructions', 2000);
}
export function validateVoiceSessionInput(input: VoiceSessionInput) {
  fields(input, ['provider', 'model', 'persona', 'voice', 'turnTaking']);
  optionalText(input.model, 'voice model', 160);
  optionalText(input.persona, 'voice persona', 2000);
  optionalText(input.voice, 'realtime voice', 100);
  if (input.turnTaking !== undefined && !['patient', 'balanced', 'quick'].includes(input.turnTaking)) invalid('Select patient, balanced or quick turn taking.');
}
function speechVoices(selectedModel: string): readonly string[] {
  return LEGACY_MODELS.has(selectedModel) ? LEGACY_SPEECH_VOICES : OPENAI_SPEECH_VOICES;
}
function speechDefault(selectedModel: string, configuredVoice?: string) {
  return configuredVoice ?? (LEGACY_MODELS.has(selectedModel) ? 'alloy' : 'marin');
}
export function openAISpeechVoiceOptions(selectedModel: string, configuredVoice?: string): VoiceOptions | undefined {
  if (!INSTRUCTION_MODELS.has(selectedModel) && !LEGACY_MODELS.has(selectedModel)) return undefined;
  const voices = speechVoices(selectedModel), defaultVoice = speechDefault(selectedModel, configuredVoice);
  // Never publish an invalid configuration value as a public voice option.
  if (!voices.includes(defaultVoice)) return undefined;
  return { voices: [...voices], defaultVoice, instructions: INSTRUCTION_MODELS.has(selectedModel) };
}
export function openAIRealtimeVoiceOptions(configuredVoice?: string): VoiceOptions | undefined {
  const defaultVoice = configuredVoice ?? 'marin';
  if (!(OPENAI_REALTIME_VOICES as readonly string[]).includes(defaultVoice)) return undefined;
  return { voices: [...OPENAI_REALTIME_VOICES], defaultVoice, instructions: true, turnTaking: true };
}
export function kokoroVoiceOptions(): VoiceOptions {
  return { voices: [KOKORO_VOICE], defaultVoice: KOKORO_VOICE, instructions: false };
}
export function openAISpeechParameters(input: SpeechInput, selectedModel: string, configuredVoice?: string) {
  validateSpeechInput(input);
  const voice = input.voice ?? speechDefault(selectedModel, configuredVoice);
  if (!speechVoices(selectedModel).includes(voice)) invalid('Select a supported speech voice.');
  if (input.instructions !== undefined && !INSTRUCTION_MODELS.has(selectedModel)) invalid('The selected speech model does not support expression instructions.');
  return { voice, ...(input.instructions !== undefined ? { instructions: input.instructions } : {}) };
}
export function openAIRealtimeParameters(input: VoiceSessionInput, configuredVoice?: string) {
  validateVoiceSessionInput(input);
  const voice = input.voice ?? configuredVoice ?? 'marin';
  if (!(OPENAI_REALTIME_VOICES as readonly string[]).includes(voice)) invalid('Select a supported realtime voice.');
  const eagerness = input.turnTaking === 'patient' ? 'low' : input.turnTaking === 'balanced' ? 'medium' : 'high';
  return { voice, ...(input.turnTaking !== undefined ? { turnDetection: {
    type: 'semantic_vad', eagerness, create_response: true, interrupt_response: true,
  } } : {}) };
}
export function speechJobOptions(value: unknown): Pick<SpeechInput, 'voice' | 'instructions'> {
  if (value === undefined) return {};
  fields(value, ['voice', 'instructions']);
  const options = value as Pick<SpeechInput, 'voice' | 'instructions'>;
  optionalText(options.voice, 'speech voice', 100);
  optionalText(options.instructions, 'speech instructions', 2000);
  return { voice: options.voice, instructions: options.instructions };
}
