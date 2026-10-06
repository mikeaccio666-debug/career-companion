import { ProviderError } from './errors.ts';

/** Server-only test overrides; a malformed entry invalidates the entire override. */
export function browserFixtureOrigins(value: string | undefined): string[] {
  const origins = new Set<string>();
  for (const raw of (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean)) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new ProviderError('EXECUTOR_CONFIGURATION', 'Browser fixture origins must be exact loopback HTTP(S) origins.', 503); }
    if (!['http:','https:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase()) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new ProviderError('EXECUTOR_CONFIGURATION', 'Browser fixture origins must be exact loopback HTTP(S) origins.', 503);
    origins.add(url.origin);
  }
  return [...origins];
}
