/**
 * The user asked, from our own panel, to be taken to the portal.
 *
 * The dock offers three doors into ArgoLand -- connect the browser, manage the
 * profile, look at the applications -- and none of them may carry a URL: a
 * content script names a page by a closed word, and the worker resolves that
 * word against the portal origin it was built with. A page that has been taken
 * over can ask for one of three known pages and for nothing else.
 */
export const DOCK_PORTAL_PAGES = ['CONNECT', 'PROFILE', 'APPLICATIONS', 'PRICING', 'SIGNING_SCOPE', 'SIGNING_SCOPE_ZH'] as const;
export type DockPortalPage = (typeof DOCK_PORTAL_PAGES)[number];

/** Where each word lands, relative to the portal origin. Connect carries the extension id; see portalConnectUrl. */
export const DOCK_PORTAL_PATHS: Readonly<Record<Exclude<DockPortalPage, 'CONNECT'>, string>> = Object.freeze({
  PROFILE: '/career/profile',
  APPLICATIONS: '/career/applications',
  // 「AI 次数用完了」那张卡片上的「升级会员」（2026-09-24）：门户的套餐页，来源记成 paywall（门户按它归因）。
  PRICING: '/plan?source=paywall',
  // 代填授权那一句里的「隐私政策」（2026-09-28）：隐私政策里写明代填范围、版本与同意书相同的那一节（英文页、中文页）。
  SIGNING_SCOPE: '/privacy#application-signing',
  SIGNING_SCOPE_ZH: '/zh/privacy#application-signing',
});

export interface DockPortalIntent {
  readonly kind: 'dock/open-portal';
  readonly page: DockPortalPage;
}

const KEYS = ['kind', 'page'] as const;

export function parseDockPortalIntent(value: unknown): DockPortalIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  // Exact keys: an extra field is a shape we did not agree to, and this message
  // opens a tab on the user's behalf.
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'dock/open-portal') return null;
  const page = DOCK_PORTAL_PAGES.find((known) => known === candidate.page);
  return page === undefined ? null : Object.freeze({ kind: 'dock/open-portal', page });
}

/** The message the dock sends; null for a page this build does not know. */
export function createDockPortalIntent(page: DockPortalPage): DockPortalIntent | null {
  return parseDockPortalIntent({ kind: 'dock/open-portal', page });
}
