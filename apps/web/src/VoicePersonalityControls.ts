import { createElement as h, type ChangeEvent, type ReactElement } from 'react';
import type { Provider } from './types.ts';
import { VOICE_PERSONALITIES, voiceOptionState, voicePersonality, type VoiceAudioConfiguration, type VoicePersonalityId, type VoiceTurnTaking } from './voice-personality.ts';

export function VoicePersonalityPicker({ value, disabled, onChange }: { value: VoicePersonalityId; disabled: boolean; onChange: (id: VoicePersonalityId) => void }): ReactElement {
  return h('fieldset', { className: 'voice-personality-picker', disabled }, h('legend', null, '今天想怎么聊？'),
    h('div', { className: 'voice-personality-options' }, ...VOICE_PERSONALITIES.map((entry) => h('button', { type: 'button', key: entry.id, className: `voice-personality-option${value === entry.id ? ' selected' : ''}`, 'aria-pressed': value === entry.id, disabled, onClick: () => { if (!disabled) onChange(entry.id); } }, h('strong', null, entry.label), h('span', null, entry.description)))),
    h('p', { className: 'helper-text' }, disabled ? '结束当前操作后，可以换角色和声音。实时连接期间使用开始时的选择。' : '角色影响接下来的文字交流；声音与表达方式以所选服务支持的能力为准。'));
}
export function VoiceSoundPicker({ provider, capability, value, disabled, onChange }: { provider?: Provider; capability: 'speech' | 'realtime'; value: string; disabled: boolean; onChange: (voice: string) => void }): ReactElement {
  const state = voiceOptionState(provider, capability, value), label = capability === 'speech' ? '朗读声线' : '实时声线';
  return h('div', { className: 'voice-sound-choice' }, h('label', null, h('span', null, label),
    state.known && (state.voices.length > 1 || state.unavailable) ? h('select', { 'aria-label': label, value: state.value, disabled: disabled || !state.ready, onChange: (event: ChangeEvent<HTMLSelectElement>) => { if (!disabled && state.ready && state.voices.includes(event.target.value)) onChange(event.target.value); } },
      state.unavailable ? h('option', { value: state.value }, `${state.value} · 当前不可用`) : null, ...state.voices.map((voice) => h('option', { key: voice, value: voice }, voice)))
      : h('span', { className: 'voice-fixed-sound' }, state.known ? `${state.value} · 固定声线` : '服务默认声音')),
    h('p', { className: 'helper-text' }, state.unavailable ? '请重新选择一条可用声线。' : !state.known ? '所选服务尚未提供可选声线信息，不发送自定义声音。' : capability === 'speech' && !state.instructions ? '此服务未声明朗读表达控制，角色只影响文字交流。' : '只使用所选服务实际提供的声音。'));
}
export function VoiceTurnTakingPicker({ provider, value, disabled, onChange }: { provider?: Provider; value: VoiceTurnTaking; disabled: boolean; onChange: (value: VoiceTurnTaking) => void }): ReactElement | null {
  const state = voiceOptionState(provider, 'realtime');
  if (!state.turnTaking) return null;
  const choices = [{ id: 'patient', label: '多等一会儿' }, { id: 'balanced', label: '自然接话' }, { id: 'quick', label: '快速接话' }] as const;
  return h('label', { className: 'voice-turn-taking' }, h('span', null, '接话节奏'), h('select', { value, 'aria-label': '实时接话节奏', disabled: disabled || !state.ready, onChange: (event: ChangeEvent<HTMLSelectElement>) => { const choice = choices.find((entry) => entry.id === event.target.value); if (!disabled && state.ready && choice) onChange(choice.id); } }, ...choices.map((choice) => h('option', { key: choice.id, value: choice.id }, choice.label))));
}

export function VoiceAudioLabel({ configuration }: { configuration: VoiceAudioConfiguration }): ReactElement {
  return h('p', { className: 'voice-role-stamp' }, `${configuration.expressionApplied ? `${voicePersonality(configuration.roleId).label}表达 · ` : ''}${configuration.voice || '服务默认声音'} · ${configuration.providerId}${configuration.expressionApplied ? '' : ' · 服务默认表达'}`);
}
