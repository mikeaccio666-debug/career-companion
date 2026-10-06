/** Operational staging exception. Never a business, Auth realm or production release grant. */
export const PRIVATE_PREVIEW = Object.freeze({
  mode: 'staging-private-preview' as const,
  portalOrigin: 'https://localhost:18443' as const,
  apiOrigin: 'https://127.0.0.1:18444' as const,
  authOrigin: 'https://auth-gateway' as const,
});
export type PrivatePreviewAdmission = Readonly<{
  schemaVersion: 1;
  mode: typeof PRIVATE_PREVIEW.mode;
  environment: 'staging';
  revision: string;
  releaseId: string;
  publicConfigSha256: string;
  configurationSha256: string;
  approvedAt: string;
  expiresAt: string;
  portalOrigin: typeof PRIVATE_PREVIEW.portalOrigin;
  apiOrigin: typeof PRIVATE_PREVIEW.apiOrigin;
  authOrigin: typeof PRIVATE_PREVIEW.authOrigin;
}>;
const fields = ['schemaVersion', 'mode', 'environment', 'revision', 'releaseId', 'publicConfigSha256',
  'configurationSha256', 'approvedAt', 'expiresAt', 'portalOrigin', 'apiOrigin', 'authOrigin'];
export function parsePrivatePreviewAdmission(value: unknown, now = Date.now()): PrivatePreviewAdmission | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== fields.length || !fields.every(key => Object.hasOwn(item, key))
    || item.schemaVersion !== 1 || item.mode !== PRIVATE_PREVIEW.mode || item.environment !== 'staging'
    || item.portalOrigin !== PRIVATE_PREVIEW.portalOrigin || item.apiOrigin !== PRIVATE_PREVIEW.apiOrigin
    || item.authOrigin !== PRIVATE_PREVIEW.authOrigin || typeof item.revision !== 'string'
    || !/^[a-f0-9]{40}$/u.test(item.revision) || typeof item.releaseId !== 'string'
    || !new RegExp(`^${item.revision}-staging-private-preview-(?:x64|arm64)-[a-f0-9]{12}$`, 'u').test(item.releaseId)
    || !['publicConfigSha256', 'configurationSha256'].every(key => typeof item[key] === 'string' && /^[a-f0-9]{64}$/u.test(item[key]))
    || !['approvedAt', 'expiresAt'].every(key => typeof item[key] === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(item[key]))) return null;
  const start = Date.parse(item.approvedAt as string); const end = Date.parse(item.expiresAt as string);
  if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end)
    || start > now || end <= now || end <= start || end - start > 7 * 24 * 60 * 60 * 1000) return null;
  return item as PrivatePreviewAdmission;
}

/** Launcher overwrites all these bindings from the immutable manifest and protected host admission. */
export function deploymentPrivatePreview(
  environment: Readonly<Record<string, string | undefined>>, now = Date.now(),
): PrivatePreviewAdmission | null {
  const variant = environment.EDAIX_RELEASE_VARIANT;
  const raw = environment.EDAIX_PRIVATE_PREVIEW_ADMISSION;
  if (variant !== PRIVATE_PREVIEW.mode && raw === undefined) return null;
  let value: unknown;
  try { value = raw && JSON.parse(raw); } catch { throw new Error('DEPLOY_PRIVATE_PREVIEW_INVALID'); }
  const admission = parsePrivatePreviewAdmission(value, now);
  if (!admission || variant !== PRIVATE_PREVIEW.mode || environment.NODE_ENV !== 'production'
    || admission.revision !== environment.EDAIX_RELEASE_REVISION || admission.releaseId !== environment.EDAIX_RELEASE_ID
    || admission.publicConfigSha256 !== environment.EDAIX_PUBLIC_CONFIG_SHA256) throw new Error('DEPLOY_PRIVATE_PREVIEW_INVALID');
  return admission;
}
export function deploymentBackgroundWorkersAllowed(
  environment: Readonly<Record<string, string | undefined>>, now = Date.now(),
): boolean {
  return deploymentPrivatePreview(environment, now) === null;
}
