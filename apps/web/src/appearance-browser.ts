import {AppearanceStore, type AppearancePreference} from './appearance.ts';
export const APPEARANCE_STORAGE_KEY = 'career-companion.appearance.v1';
export function createBrowserAppearance(window: Window, document: Document): AppearanceStore {
  return new AppearanceStore({
    read: () => window.localStorage.getItem(APPEARANCE_STORAGE_KEY),
    write: value => window.localStorage.setItem(APPEARANCE_STORAGE_KEY, value),
    apply(value: AppearancePreference) {
      if (value === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', value);
      // Media-specific defaults also work before JavaScript loads. Explicit
      // choices override both entries, including browser/PWA chrome.
      for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][data-appearance]')) {
        const tone = value === 'system' ? meta.dataset.appearance : value;
        meta.content = tone === 'dark' ? '#0D131E' : '#F1F3F7';
      }
    },
    listen(change) {
      const onStorage = (event: StorageEvent) => {
        if (event.key !== null && event.key !== APPEARANCE_STORAGE_KEY) return;
        try { if (event.storageArea !== window.localStorage) return; } catch { return; }
        // Read the current value: queued events may describe older writes.
        change();
      };
      const onPageShow = () => change();
      window.addEventListener('storage', onStorage);
      window.addEventListener('pageshow', onPageShow);
      return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('pageshow', onPageShow); };
    },
  });
}
let store: AppearanceStore | undefined;
export function getAppearanceStore(): AppearanceStore {
  if (!store) {
    store = typeof window === 'undefined'
      ? new AppearanceStore({read: () => null, write() {}, apply() {}, listen: () => () => {}})
      : createBrowserAppearance(window, document);
  }
  store.start();
  return store;
}
