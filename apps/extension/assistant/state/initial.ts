import type { AssistantData, AssistantState, Entitlement, RunState, UsageKind } from './types';
import { createTranslator, resolveAssistantLocale, type AssistantLocale } from '../i18n';

export const emptyRun = (): RunState => ({ status: 'idle', count: 0, rows: [], failed: false });

export function initialAssistantState(
  data: AssistantData,
  options: { persona: 'out' | 'new' | 'connected'; reduced?: boolean; locale?: AssistantLocale; entitlements: Record<UsageKind, Entitlement> },
): AssistantState {
  const hasResume = options.persona === 'connected';
  const locale = resolveAssistantLocale(options.locale), t = createTranslator(locale);
  const profile = structuredClone(data.profile);
  if (options.persona === 'new') {
    profile.education = ''; profile.experience = []; profile.skills = [];
    profile.projects = ''; profile.languages = ''; profile.summary = '';
  }
  return {
    locale,
    scene: 'welcome', reduced: options.reduced ?? false, panelOpen: true, launcherHidden: false, hiddenNote: false, launcherTop: 180,
    session: options.persona === 'out' ? 'out' : 'connected', hasResume,
    resumeId: data.resumeVersions[0]?.id ?? '', profile, confirmed: { 0: false, 1: false, 2: false }, privacy: 'unset', profileDone: false,
    targets: hasResume ? [{ id: 't-portal', role: profile.role, locations: profile.locations, workMode: profile.workMode, salary: profile.salary, start: profile.start, source: 'Portal', savedAt: t('来自 Portal') }] : [],
    currentTargetId: hasResume ? 't-portal' : null, addingTarget: false,
    chat: { phase: 0, messages: [], input: '', stage: 'idle', privacyPrompt: false, reviewPrompt: false, morePrompt: false, initialized: false },
    voice: { state: 'idle', secs: 0, notice: '', draft: '' },
    deck: { items: [], index: 0, cursor: 0, batchNo: 0, selected: [], skipped: [], history: [], busy: false, closedJob: '' },
    atsResults: {}, staleIds: {}, entitlements: structuredClone(options.entitlements), prep: {}, preparedResume: {}, letters: {}, coverId: '', fillId: '', run: emptyRun(),
    sheet: null, modal: null, toast: '', hostHighlight: false,
  };
}
