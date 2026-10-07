import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssistantController } from '../assistant/app/controller';
import { createAssistantView } from '../assistant/app/view-model';
import { createViewContext } from '../assistant/app/view-context';
import type { AssistantEvents } from '../assistant/app/view-types';
import { createPresentationData } from '../assistant/presentation-data';
import { messages } from '../assistant/i18n';
import { initialAssistantState } from '../assistant/state/initial';
import { panelDimensions } from '../assistant/shell/geometry';
import { ShellHeader } from '../assistant/shell/ShellHeader';
import { WelcomeScene } from '../assistant/scenes/WelcomeScene';
import { PrivateIntakeScene } from '../assistant/features/intake/PrivateIntakeScene';
import { previewData } from '../assistant/testing/fixtures';
import { createPreviewPorts } from '../assistant/testing/preview-ports';

const events: AssistantEvents = { active: true, reduced: true, onInput: () => {}, onChange: () => {}, onStreamDone: () => {} };
const locked = { access: 'locked' as const };

describe('extension presentation after historical asset removal', () => {
  it.each(['en-US', 'zh-CN'] as const)('renders current chrome in %s with no portrait fallback or renamed user data', locale => {
    const data = { ...previewData, profile: { ...previewData.profile, nick: 'Fictional ArgoLand researcher' } };
    const state = initialAssistantState(data, { persona: 'out', locale, entitlements: { ats: locked, jobs: locked, letters: locked, chat: locked, voice: locked } });
    const ui = createAssistantController(data, createPreviewPorts().ports, state);
    try {
      for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
        const view = createAssistantView(createViewContext(ui.ctx.state, ui.ctx.data, panelDimensions('welcome', viewport)));
        expect(view.mentors).toEqual([]);
        const welcome = renderToStaticMarkup(<WelcomeScene view={view} events={events}/>);
        const header = renderToStaticMarkup(<ShellHeader view={view} events={events}/>);
        const intake = renderToStaticMarkup(<PrivateIntakeScene controller={ui}/>);
        expect(welcome).toContain('CAREER COMPANION');
        expect(welcome).not.toContain('data-mentor=');
        expect(header).toContain('Career Companion');
        expect(intake).toContain('Career Companion');
        expect(welcome + header + intake).not.toMatch(/argoland/i);
      }
      expect(ui.ctx.state.profile.nick).toBe('Fictional ArgoLand researcher');
      expect(createPresentationData(locale).usageLabels.chat).toContain('Career Companion');
      expect(Object.values(messages[locale]).some(text => /argoland/i.test(text))).toBe(false);
    } finally { ui.dispose(); }
  });

  it('ships no former Portal portrait files', () => {
    expect(previewData.mentors).toEqual([]);
    for (const name of ['alice', 'charlie', 'darren', 'xena']) {
      expect(existsSync(resolve(__dirname, `../assistant/assets/mentors/${name}.webp`))).toBe(false);
    }
  });
});
