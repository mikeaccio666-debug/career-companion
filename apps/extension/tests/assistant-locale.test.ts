import { attachLocalePreference } from '../assistant/i18n/preference';
import { describe, expect, it } from 'vitest';
import { createTranslator, messages, resolveAssistantLocale, ASSISTANT_LOCALES } from '../assistant/i18n';
import { PORTAL_LOCALES, DEFAULT_PORTAL_LOCALE } from '../assistant/i18n/portal-locale';
import { createAssistantController } from '../assistant/app/controller';
import { createAssistantView } from '../assistant/app/view-model';
import { createViewContext } from '../assistant/app/view-context';
import { initialAssistantState } from '../assistant/state/initial';
import { panelDimensions } from '../assistant/shell/geometry';
import { previewData, entitlementScenarios as e } from '../assistant/testing/fixtures';
import { createPreviewPorts } from '../assistant/testing/preview-ports';

describe('assistant language parity with Portal', () => {
  it('shares the exact supported languages and English fallback', () => {
    expect(ASSISTANT_LOCALES).toEqual(PORTAL_LOCALES);
    expect(resolveAssistantLocale(undefined)).toBe(DEFAULT_PORTAL_LOCALE);
    expect(resolveAssistantLocale('fr-FR')).toBe('en-US');
    expect(resolveAssistantLocale('zh-CN')).toBe('zh-CN');
    expect(Object.keys(messages['en-US']).sort()).toEqual(Object.keys(messages['zh-CN']).sort());
    for (const text of Object.values(messages['en-US'])) expect(text.trim()).not.toBe('');
  });
  it('interpolates data once without interpreting user text as another message', () => {
    expect(createTranslator('en-US')('{v0}，欢迎回来。', { v0: '我的简历 {v1}' })).toBe('Welcome back, 我的简历 {v1}.');
  });
  it('switches chrome and read states without changing profile or an unsent draft', async () => {
    const state = initialAssistantState(previewData, { persona: 'connected', entitlements: { ats: e.ats.granted, jobs: e.jobs.plenty, letters: e.letters, chat: e.chat, voice: e.voice } });
    state.reads = { personal: 'ready', resumes: 'unavailable', processingCount: 0, failedCount: 0, hasMoreVersions: false };
    state.chat.input = '我的简历 — do not translate';
    const ui = createAssistantController(previewData, createPreviewPorts().ports, state);
    const view = () => createAssistantView(createViewContext(ui.ctx.state, ui.ctx.data, panelDimensions('home', { width: 1280, height: 720 })));
    const profile = structuredClone(state.profile);
    expect(view().ui.statusLine).toContain('Resume unavailable');
    await ui.dispatch('set-locale', 'zh-CN');
    expect(view().ui.statusLine).toContain('简历暂不可用');
    expect(ui.ctx.state.profile).toEqual(profile);
    expect(ui.ctx.state.chat.input).toBe('我的简历 — do not translate');
    await ui.dispatch('set-locale', 'not-a-locale');
    expect(ui.ctx.state.locale).toBe('zh-CN');
    ui.dispose();
  });
});

it('keeps a new language selection when a saved preference arrives late', async () => {
  const ui = createAssistantController(previewData, createPreviewPorts().ports, initialAssistantState(previewData, { persona: 'out', entitlements: { ats: e.ats.granted, jobs: e.jobs.plenty, letters: e.letters, chat: e.chat, voice: e.voice } }));
  let resolve!: (v: unknown) => void; const written: string[] = [];
  const preference = attachLocalePreference(ui, { read: () => new Promise(r => { resolve = r; }), write: async v => { written.push(v); } });
  await ui.dispatch('set-locale', 'zh-CN'); resolve('en-US'); await preference.ready; await preference.flush();
  expect(ui.ctx.state.locale).toBe('zh-CN'); expect(written).toEqual(['zh-CN']); preference.dispose(); ui.dispose();
});
