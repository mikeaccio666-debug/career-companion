import type { AssistantController } from '../app/controller';
import { isAssistantLocale, resolveAssistantLocale, type AssistantLocale } from './index';

export const ASSISTANT_LOCALE_KEY = 'argo.assistant.ui-locale.v1';
export type LocalePreferenceResult = { ok: true } | { ok: false; code: 'LOCALE_PREFERENCE_UNAVAILABLE' };
export interface LocalePreferenceStore { read(): Promise<unknown>; write(locale: AssistantLocale): Promise<void> }

/** Persists this non-sensitive UI preference only; an old read can never overwrite a new selection. */
export function attachLocalePreference(ui: AssistantController, storage: LocalePreferenceStore) {
  let disposed = false, revision = 0, previous = resolveAssistantLocale(ui.ctx.state.locale);
  let pending: Promise<LocalePreferenceResult> = Promise.resolve({ ok: true });
  const unsubscribe = ui.store.subscribe(() => {
    const locale = resolveAssistantLocale(ui.ctx.state.locale);
    if (locale === previous) return;
    previous = locale; revision++;
    pending = pending.then(async () => {
      if (disposed) return { ok: true };
      try { await storage.write(locale); return { ok: true }; }
      catch { return { ok: false, code: 'LOCALE_PREFERENCE_UNAVAILABLE' }; }
    });
  });
  const ready: Promise<LocalePreferenceResult> = (async () => {
    try {
      const value = await storage.read();
      if (!disposed && revision === 0 && isAssistantLocale(value)) {
        previous = value; ui.ctx.patch({ locale: value });
      }
      return { ok: true };
    } catch { return { ok: false, code: 'LOCALE_PREFERENCE_UNAVAILABLE' }; }
  })();
  return { ready, flush: () => pending, dispose() { disposed = true; unsubscribe(); } };
}

/** Local previews do not request browser storage permissions. No credentials use this storage. */
export const previewLocaleStorage = (): LocalePreferenceStore => ({
  async read() { return localStorage.getItem(ASSISTANT_LOCALE_KEY); },
  async write(locale) { localStorage.setItem(ASSISTANT_LOCALE_KEY, locale); },
});
