/**
 * Adapted from argoland 013d5128bd474f98b78df8c9878e1321712b134b.
 * Pure migration seam; importing this file grants no execution authority.
 */
const LOOPBACK_HTTP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Parses the exact external API origin allowed in an ExecutionIntent issuer.
 * Public deployments use HTTPS; plaintext is limited to an explicit-port
 * loopback origin for local development and synthetic Docker validation.
 */
export function parseExternalApiOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('external API origin must be a string');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('external API origin must be a valid URL');
  }

  if (url.origin !== value || url.username || url.password) {
    throw new Error('external API origin must be canonical and contain no URL components');
  }
  if (url.protocol === 'https:') return url.origin;
  if (
    url.protocol === 'http:' &&
    url.port.length > 0 &&
    LOOPBACK_HTTP_HOSTNAMES.has(url.hostname.toLowerCase())
  ) {
    return url.origin;
  }

  throw new Error('external API origin must use https or loopback http with an explicit port');
}

export function isExternalApiOrigin(value: unknown): value is string {
  try {
    parseExternalApiOrigin(value);
    return true;
  } catch {
    return false;
  }
}
