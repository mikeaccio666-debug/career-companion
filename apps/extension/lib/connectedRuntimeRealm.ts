import { PRIVATE_PREVIEW } from '@edaix/contracts';

export const CONNECTED_DEVELOPMENT_REALM = Object.freeze({
  apiBase: 'http://localhost:3000', portalOrigin: 'http://localhost:3100',
});
/** Reserved staging pair for the new product. No previous product realm is inherited.
 * These .invalid origins are not deployed services; tests use synthetic fetch ports.
 */
export const CONNECTED_STAGING_REALM = Object.freeze({
  apiBase: 'https://staging-api.career-companion.invalid', portalOrigin: 'https://staging.career-companion.invalid',
});
/** The SSH-forwarded local preview, kept for the offline preview path. */
export const CONNECTED_LOCAL_PREVIEW_REALM = Object.freeze({
  apiBase: PRIVATE_PREVIEW.apiOrigin, portalOrigin: PRIVATE_PREVIEW.portalOrigin,
});

/** Closed build-owned pairs; no page, storage, redirect or production fallback. */
export function resolveConnectedRuntimeRealm(input: Readonly<{
  stagingEnabled?: boolean;
  apiBase: string | null;
  portalOrigin: string | null | undefined;
}>): Readonly<{ apiBase: string; portalOrigin: string }> | null {
  const expected = input.stagingEnabled === true ? CONNECTED_STAGING_REALM : CONNECTED_DEVELOPMENT_REALM;
  return input.apiBase === expected.apiBase && input.portalOrigin === expected.portalOrigin ? expected : null;
}
