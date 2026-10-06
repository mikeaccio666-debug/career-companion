import { PLATFORM_ACCOUNT_QUERY, platformAccountId } from '@companion/platform-contracts';
const prefix = '/api/platform';
const privatePath = /^\/api\/platform\/(?:uploads|artifacts)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const configurationError = '工作台 API 地址配置无效。请使用完整 HTTPS origin，或 HTTP localhost、127.0.0.1、[::1] origin，不含路径、凭据或查询参数。';

export interface PlatformEndpoints {
  readonly origin?: string;
  apiUrl(path: string): string;
  privateFileUrl(value: unknown, options?: PrivateFileOptions): string | undefined;
}
export interface PrivateFileOptions { download?: boolean; accountId?: string; }

/** Deployment-owned origin only. Response data never selects a credential destination. */
export function createPlatformEndpoints(configuredOrigin?: unknown): PlatformEndpoints {
  let origin: string | undefined;
  if (configuredOrigin !== undefined && configuredOrigin !== '') {
    if (typeof configuredOrigin !== 'string' || /[\x00-\x20\x7f]/.test(configuredOrigin)) throw new Error(configurationError);
    let parsed: URL;
    try { parsed = new URL(configuredOrigin); } catch { throw new Error(configurationError); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.origin !== configuredOrigin || parsed.username || parsed.password || parsed.hostname.includes('*')
      || !(parsed.protocol === 'https:' || parsed.protocol === 'http:' && loopback)) throw new Error(configurationError);
    origin = configuredOrigin;
  }
  return Object.freeze({
    origin,
    apiUrl(path: string) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\x00-\x20\x7f\\#]/.test(path)) throw new Error('工作台请求路径无效。');
      const pathname = path.split('?', 1)[0];
      let decoded: string;
      try { decoded = decodeURIComponent(pathname); } catch { throw new Error('工作台请求路径无效。'); }
      if (/[\x00-\x20\x7f\\%]/.test(decoded) || /%2f|%5c/i.test(pathname) || decoded.includes('//')
        || decoded.split('/').some(part => part === '.' || part === '..')) throw new Error('工作台请求路径无效。');
      return `${origin ?? ''}${prefix}${path}`;
    },
    privateFileUrl(value: unknown, options?: PrivateFileOptions) {
      if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value) || !privatePath.test(value) || !platformAccountId(options?.accountId)) return undefined;
      const query = new URLSearchParams({ [PLATFORM_ACCOUNT_QUERY]: options.accountId });
      if (options.download) query.set('download', '1');
      return `${origin ?? ''}${value}?${query}`;
    },
  });
}
