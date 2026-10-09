import type { PlatformConfig } from './config.ts';

/** Deployment-owned public API origin, never Host, Origin or forwarded headers. */
export function readWebApiOrigin(value: string | undefined, production: boolean): string | undefined {
  if (value === undefined || value === '') return undefined;
  const invalid = () => new Error('PLATFORM_WEB_API_ORIGIN must be an exact HTTPS origin (HTTP loopback is allowed only outside production).');
  if (/[\x00-\x20\x7f;'"<>\\]/.test(value)) throw invalid();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw invalid(); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== value || parsed.username || parsed.password || parsed.hostname.includes('*')
    || !(parsed.protocol === 'https:' || !production && parsed.protocol === 'http:' && loopback)) throw invalid();
  return value;
}

/** Applied before routing, including preflight, errors and hijacked SSE.
 * Private document routes may replace CSP with their existing stricter sandbox.
 * No reporting endpoint: reports can contain private document URLs. */
export function platformSecurityHeaders(config: Pick<PlatformConfig, 'secureCookies' | 'webApiOrigin' | 'modelRoutes'>): Readonly<Record<string, string>> {
  const api = readWebApiOrigin(config.webApiOrigin, config.secureCookies);
  const resources = ["'self'", ...(api ? [api] : [])].join(' ');
  const connections = [resources, ...(config.modelRoutes.realtime?.provider === 'openai'
    ? ['https://api.openai.com/v1/realtime/calls'] : [])].join(' ');
  return Object.freeze({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)',
    'Content-Security-Policy': [
      "default-src 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
      "frame-src 'none'", "form-action 'self'", "script-src 'self'", "script-src-attr 'none'",
      "style-src 'self' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com", "manifest-src 'self'", "worker-src 'self'",
      'connect-src ' + connections, 'img-src ' + resources + ' data: blob:', 'media-src ' + resources + ' blob:',
    ].join('; '),
    // The TLS edge serves production. Do not trust caller-supplied proxy headers,
    // preload the domain, or impose a policy on unrelated subdomains.
    ...(config.secureCookies ? {'Strict-Transport-Security': 'max-age=15552000'} : {}),
  });
}
