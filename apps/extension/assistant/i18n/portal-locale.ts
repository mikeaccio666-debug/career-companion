/**
 * 门户支持的语言集合。
 *
 * 权威在 **argoland 的门户**（argoland.ai 的 career 产品面）。本仓是插件，
 * 拿不到门户源码，所以这里钉一份拷贝，由 `tests/assistant-locale.test.ts`
 * 保证插件自己的语言集合不和它漂移。
 *
 * 门户加语言时这份要跟着重钉——否则用户在门户切到新语言、插件跟不上，
 * 两边显示不同语言。
 */
export const PORTAL_LOCALES = ['en-US', 'zh-CN'] as const;

export type PortalLocale = (typeof PORTAL_LOCALES)[number];

export const DEFAULT_PORTAL_LOCALE: PortalLocale = 'en-US';

export function isPortalLocale(value: unknown): value is PortalLocale {
  return PORTAL_LOCALES.some((locale) => locale === value);
}
