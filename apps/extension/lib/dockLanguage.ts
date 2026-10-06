import type { DockLocale } from './dock/copy';

/**
 * 用户在账户菜单里选的语言（2026-09-27 负责人：右上角加一个设置，用户可以自己改语言）。
 *
 * 存在插件自己的 `storage.local` 里，按这个浏览器记一份；没选过就照旧跟随浏览器的界面语言（`browserDockLocale`）。
 * 读回来只认 `zh` 与 `en`，别的一律当没选过。
 */
export const DOCK_LOCALE_KEY = 'argolandDockLocale';

export function storedDockLocale(value: unknown): DockLocale | null {
  return value === 'zh' || value === 'en' ? value : null;
}
