import type { Provider } from './types.ts';

export const VOICE_CAPABILITY_LABELS = {
  realtime: '实时对话',
  transcription: '录音转写',
  speech: '语音合成',
} as const;
export type VoiceCapability = keyof typeof VOICE_CAPABILITY_LABELS;
export interface VoiceCapabilityStatus { available: boolean; reason: string }
export type VoiceCapabilities = Record<VoiceCapability, VoiceCapabilityStatus>;

export function voiceCapabilities(provider?: Provider): VoiceCapabilities {
  const status = (capability: VoiceCapability): VoiceCapabilityStatus => {
    const label = VOICE_CAPABILITY_LABELS[capability];
    if (!provider) return { available: false, reason: `请选择支持${label}的语音服务。` };
    if (!Array.isArray(provider.capabilities) || !provider.capabilities.includes(capability)) return { available: false, reason: `所选服务不支持${label}。` };
    if (provider.keyConfigured !== true) return { available: false, reason: `所选服务的${label}待配置，请在设置页查看连接状态。` };
    if (provider.enabled !== true) return { available: false, reason: `所选服务的${label}未启用，请在设置页查看连接状态。` };
    return { available: true, reason: '已配置并启用；实际调用结果以服务响应为准。' };
  };
  return { realtime: status('realtime'), transcription: status('transcription'), speech: status('speech') };
}

/** Catalog order decides defaults; a user's retained choice is never silently replaced. */
export function selectedVoiceProvider(providers: Provider[], currentId: string): string {
  if (currentId) return currentId;
  return providers.find((provider) => Object.values(voiceCapabilities(provider)).some((capability) => capability.available))?.id
    || providers.find((provider) => Array.isArray(provider.capabilities) && provider.capabilities.some((capability) => Object.hasOwn(VOICE_CAPABILITY_LABELS, capability)))?.id
    || '';
}

export function voiceSpeechInformation(provider?: Provider): string {
  if (!provider || !Array.isArray(provider.capabilities) || !provider.capabilities.includes('speech')) return '';
  const languages: string[] = [];
  for (const value of Array.isArray(provider.speechLanguages) ? provider.speechLanguages.slice(0, 16) : []) {
    if (typeof value !== 'string' || value.length > 100) continue;
    try {
      const language = Intl.getCanonicalLocales(value)[0];
      if (!language || languages.includes(language)) continue;
      languages.push(language);
    } catch { /* Unknown or invalid catalog language values never imply a supported language. */ }
  }
  const labels = languages.map((language) => {
    try { return new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(language) || language; }
    catch { return language; }
  });
  const missing = [!provider.capabilities.includes('transcription') ? '录音转写' : '', !provider.capabilities.includes('realtime') ? '实时对话' : ''].filter(Boolean);
  return [labels.length ? `文字朗读支持：${labels.join('、')}。` : '', missing.length ? `如需${missing.join('或')}，请选择另一个已配置且支持该能力的服务。` : ''].join('');
}

export interface VoiceControlActivity {
  recording: boolean; recognizing: boolean; transcribing: boolean; speaking: boolean; live: boolean;
}
export function voiceControls(capabilities: VoiceCapabilities, activity: VoiceControlActivity, browser: { canRecord: boolean; canRecognize: boolean }, text: string) {
  return {
    // Ending a running local resource remains possible after a catalog refresh disables its provider.
    realtimeDisabled: !activity.live && (!capabilities.realtime.available || activity.recording || activity.recognizing || activity.transcribing || activity.speaking),
    recordingDisabled: !activity.recording && (!browser.canRecord || !capabilities.transcription.available || activity.transcribing || activity.recognizing || activity.speaking || activity.live),
    importDisabled: !capabilities.transcription.available || activity.recording || activity.recognizing || activity.transcribing || activity.speaking || activity.live,
    recognitionDisabled: !activity.recognizing && (!browser.canRecognize || activity.recording || activity.transcribing || activity.live),
    speechDisabled: !capabilities.speech.available || !text.trim() || text.length > 4000 || activity.speaking || activity.recording || activity.recognizing || activity.transcribing || activity.live,
    providerDisabled: activity.live || activity.recording || activity.transcribing || activity.speaking,
  };
}
