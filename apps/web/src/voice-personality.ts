import type { SpeechInput, VoiceSessionInput } from '@companion/platform-contracts';
import type { Provider } from './types.ts';

export const VOICE_PERSONALITIES = [
  { id: 'warm', label: '温柔陪练', description: '慢慢说，一起把想法讲清楚。', persona: 'Be a gentle practice partner. Acknowledge one specific feeling or effort, help the user put their thoughts into words, and ask one small question at a time. Avoid exaggerated praise or reassurance.', expression: 'Speak gently and calmly, with a natural conversational pace and short pauses. Sound attentive and encouraging without exaggerated enthusiasm.' },
  { id: 'career', label: '轻松职业搭子', description: '聊聊方向，找到下一小步。', persona: 'Be a relaxed, candid career companion. Help compare options and connect experiences to work. Suggest one concrete next step, then ask one relevant question. Do not invent qualifications, achievements or job-market facts.', expression: 'Speak in a relaxed, friendly, conversational tone, with natural rhythm and clear phrasing. Avoid sales enthusiasm or dramatic emphasis.' },
  { id: 'interviewer', label: '清晰面试官', description: '一个问题，一次练习，具体反馈。', persona: 'Be a clear, composed interview practice partner. Ask one realistic interview question at a time and wait for the user. When feedback is requested, give one specific strength and one actionable improvement. Do not claim to predict a hiring decision.', expression: 'Speak clearly and evenly in a composed interview tone. Use brief natural pauses, precise phrasing and measured delivery, without sounding stern or theatrical.' },
] as const;
export type VoicePersonalityId = typeof VOICE_PERSONALITIES[number]['id'];
export type VoiceTurnTaking = 'patient' | 'balanced' | 'quick';
export interface VoicePreferences {
  roleId: VoicePersonalityId;
  speechVoices: Record<string, string>;
  realtimeVoices: Record<string, string>;
  turnTaking: VoiceTurnTaking;
}
export function voicePersonalityId(value: unknown): VoicePersonalityId { return VOICE_PERSONALITIES.some((entry) => entry.id === value) ? value as VoicePersonalityId : 'warm'; }
export function voicePersonality(value?: unknown) { return VOICE_PERSONALITIES.find((entry) => entry.id === voicePersonalityId(value))!; }
export function voicePersona(value?: unknown): string {
  return `${voicePersonality(value).persona} Reply in the language the user is speaking. Use short, natural spoken sentences, usually one to three sentences. Avoid Markdown, long lists and monologues. Listen before giving advice; do not interrupt with multiple questions.`;
}
export function defaultVoicePreferences(): VoicePreferences { return { roleId: 'warm', speechVoices: {}, realtimeVoices: {}, turnTaking: 'patient' }; }
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 150 && !/[\u0000-\u0020\u007f]/.test(value);
function voiceChoices(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([provider, voice]) => safeId(provider) && safeId(voice)).slice(0, 32));
}
/** Only bounded selections survive page navigation; no raw prompt, service payload or credentials. */
export function copyVoicePreferences(value?: Partial<VoicePreferences>): VoicePreferences {
  return { roleId: voicePersonalityId(value?.roleId), speechVoices: voiceChoices(value?.speechVoices), realtimeVoices: voiceChoices(value?.realtimeVoices), turnTaking: ['patient', 'balanced', 'quick'].includes(value?.turnTaking || '') ? value!.turnTaking! : 'patient' };
}
export interface VoiceOptionState { voices: string[]; value: string; known: boolean; unavailable: boolean; ready: boolean; instructions: boolean; turnTaking: boolean; }
export function retainedVoice(preferences: VoicePreferences, capability: 'speech' | 'realtime', providerId: string): string {
  const choices = capability === 'speech' ? preferences.speechVoices : preferences.realtimeVoices;
  return Object.hasOwn(choices, providerId) && safeId(choices[providerId]) ? choices[providerId] : '';
}
export function voiceOptionState(provider: Provider | undefined, capability: 'speech' | 'realtime', retained = ''): VoiceOptionState {
  const supported = !!provider?.capabilities.includes(capability);
  const options = supported ? provider?.voiceOptions?.[capability] : undefined;
  const voices = [...new Set((Array.isArray(options?.voices) ? options.voices : []).filter(safeId))];
  const known = !!options && voices.length > 0 && voices.includes(options.defaultVoice);
  return { voices: known ? voices : [], value: retained || (known ? options!.defaultVoice : ''), known,
    unavailable: known && !!retained && !voices.includes(retained), ready: supported && provider?.enabled === true && provider.keyConfigured === true,
    instructions: known && options?.instructions === true, turnTaking: known && options?.turnTaking === true };
}
export function voiceSelectionProblem(provider: Provider | undefined, capability: 'speech' | 'realtime', retained = ''): string {
  return voiceOptionState(provider, capability, retained).unavailable ? '这条声线当前不可用，请选择所选服务提供的声线。' : '';
}
export function voiceSpeechBody(provider: Provider, text: string, roleId: VoicePersonalityId = 'warm', retainedVoice = ''): SpeechInput {
  const state = voiceOptionState(provider, 'speech', retainedVoice);
  if (state.unavailable) throw new Error(voiceSelectionProblem(provider, 'speech', retainedVoice));
  return { provider: provider.id, text, ...(state.ready && state.known ? { voice: state.value } : {}), ...(state.ready && state.instructions ? { instructions: voicePersonality(roleId).expression } : {}) };
}
export function voiceRealtimeBody(provider: Provider, preferences: VoicePreferences): VoiceSessionInput {
  const state = voiceOptionState(provider, 'realtime', retainedVoice(preferences, 'realtime', provider.id));
  if (state.unavailable) throw new Error(voiceSelectionProblem(provider, 'realtime', state.value));
  return { provider: provider.id, ...(state.ready && state.known ? { voice: state.value } : {}),
    ...(state.ready && state.instructions ? { persona: voicePersona(preferences.roleId) } : {}), ...(state.ready && state.turnTaking ? { turnTaking: preferences.turnTaking } : {}) };
}

export interface VoiceAudioConfiguration { roleId: VoicePersonalityId; providerId: string; voice?: string; expressionApplied: boolean; }
export function copyVoiceAudioConfiguration(value?: VoiceAudioConfiguration): VoiceAudioConfiguration | undefined {
  return value && safeId(value.providerId) ? { roleId: voicePersonalityId(value.roleId), providerId: value.providerId, expressionApplied: value.expressionApplied === true, ...(safeId(value.voice) ? { voice: value.voice } : {}) } : undefined;
}
export function voiceAudioConfiguration(provider: Provider, roleId: VoicePersonalityId, retainedVoice = ''): VoiceAudioConfiguration {
  const state = voiceOptionState(provider, 'speech', retainedVoice);
  return { roleId, providerId: provider.id, expressionApplied: state.ready && state.instructions, ...(state.ready && state.known && !state.unavailable ? { voice: state.value } : {}) };
}
