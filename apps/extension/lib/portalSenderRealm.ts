/**
 * Resolve a web-page sender to one exact origin. Chrome may expose both
 * `origin` and `url`; disagreement is hostile rather than a fallback choice.
 */
export function resolvePortalSenderOrigin(sender: unknown): string | null {
  if (sender === null || typeof sender !== 'object' || Array.isArray(sender)) return null;
  const record = sender as Record<string, unknown>;
  const explicit = canonicalOrigin(record['origin']);
  const fromUrl = originFromUrl(record['url']);
  if (record['origin'] !== undefined && explicit === null) return null;
  if (record['url'] !== undefined && fromUrl === null) return null;
  if (explicit !== null && fromUrl !== null && explicit !== fromUrl) return null;
  return explicit ?? fromUrl;
}

export function isAllowedPortalSender(
  sender: unknown,
  allowedOrigins: readonly string[],
): boolean {
  const origin = resolvePortalSenderOrigin(sender);
  return origin !== null && allowedOrigins.includes(origin);
}

function canonicalOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        parsed.origin === value &&
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.pathname === '/' &&
        parsed.search === '' &&
        parsed.hash === ''
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function originFromUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        parsed.username === '' &&
        parsed.password === ''
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}
