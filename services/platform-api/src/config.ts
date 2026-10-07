import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAccountEmailConfig, type AccountEmailConfig } from './account-mail.ts';
import { readMcpConfig, type McpCatalogConfig } from './mcp-config.ts';

export const workspaceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');

export interface PlatformConfig {
  databaseUrl: string; redisUrl: string; storageDir: string; port: number;
  databasePoolMax: number; databaseConnectTimeoutMs: number; codeVersion: string;
  host: '127.0.0.1' | 'localhost' | '::1' | '0.0.0.0'; webStaticDir?: string;
  allowedOrigins: Set<string>; sessionDays: number; maxActiveJobs: number;
  secureCookies: boolean; queueName: string; s3?: { endpoint?: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };
  accountEmail?: AccountEmailConfig; requireVerifiedEmail: boolean;
  workbenchEnabled: boolean;
  mcp?: McpCatalogConfig;
}

function port(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) throw new Error(`${name} must be an integer port from 1 to 65535`);
  return Number(value);
}

function boundedInteger(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (/^[1-9][0-9]*$/.exec(value)?.[0] !== value || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

function runtimeIdentifier(value: string | undefined, name: string, fallback: string): string {
  const result = value ?? fallback;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.exec(result)?.[0] !== result) throw new Error(`${name} must be a bounded runtime identifier`);
  return result;
}

function origins(value: string, production: boolean): Set<string> {
  const values = value.split(',').map(item => item.trim());
  if (!values.length || values.some(item => !item)) throw new Error('Application origins must be explicit, exact origins');
  for (const item of values) {
    let parsed: URL;
    try { parsed = new URL(item); } catch { throw new Error('Application origins must be explicit, exact origins'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== item || parsed.hostname.includes('*') || parsed.username || parsed.password
      || production && parsed.protocol !== 'https:') throw new Error('Production application origins must be exact HTTPS origins; local origins must be exact HTTP(S) origins');
  }
  return new Set(values);
}

function serverUrl(value: string | undefined, name: string, protocols: readonly string[]): string {
  if (!value?.trim()) throw new Error(`${name} must be explicitly configured in production`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid server connection URL`); }
  if (value.trim() !== value || /[\x00-\x20\x7f]/.test(value) || !protocols.includes(parsed.protocol) || !parsed.hostname || parsed.hash) throw new Error(`${name} must be a valid server connection URL`);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const production = env.NODE_ENV === 'production';
  if (env.PLATFORM_ENABLE_WORKBENCH !== undefined && !['0', '1'].includes(env.PLATFORM_ENABLE_WORKBENCH)) {
    throw new Error('PLATFORM_ENABLE_WORKBENCH must be 0 or 1');
  }
  const workbenchEnabled = env.PLATFORM_ENABLE_WORKBENCH === '1';
  // Internal deployment mode is not employee authorization. Production cannot
  // expose this mode before the separate staff-role boundary is implemented.
  if (production && workbenchEnabled) throw new Error('PLATFORM_ENABLE_WORKBENCH cannot enable a public production workbench before staff authorization is implemented');
  const databasePoolMax = boundedInteger(env.PLATFORM_DATABASE_POOL_MAX, 'PLATFORM_DATABASE_POOL_MAX', 12, 1, 100);
  const databaseConnectTimeoutMs = boundedInteger(env.PLATFORM_DATABASE_CONNECT_TIMEOUT_MS, 'PLATFORM_DATABASE_CONNECT_TIMEOUT_MS', 5000, 100, 5000);
  const codeVersion = runtimeIdentifier(env.PLATFORM_BUILD_ID, 'PLATFORM_BUILD_ID', 'development');
  if (production && (env.PLATFORM_BUILD_ID === undefined || ['development', 'unknown'].includes(codeVersion.toLowerCase()))) {
    throw new Error('PLATFORM_BUILD_ID must identify the release explicitly in production');
  }
  const queueName = runtimeIdentifier(env.PLATFORM_QUEUE_NAME, 'PLATFORM_QUEUE_NAME', 'companion-platform-jobs');
  const host = env.PLATFORM_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host)) throw new Error('PLATFORM_HOST must be loopback or an explicitly configured 0.0.0.0');
  const hostedPort = port(env.PORT, 'PORT'), platformPort = port(env.PLATFORM_PORT, 'PLATFORM_PORT');
  if (hostedPort !== undefined && platformPort !== undefined && hostedPort !== platformPort) throw new Error('PORT and PLATFORM_PORT must agree when both are configured');
  const databaseUrl = production ? serverUrl(env.PLATFORM_DATABASE_URL, 'PLATFORM_DATABASE_URL', ['postgres:', 'postgresql:'])
    : env.PLATFORM_DATABASE_URL ?? 'postgresql://companion:local-companion-dev-only@127.0.0.1:5442/companion';
  const redisUrl = production ? serverUrl(env.PLATFORM_REDIS_URL, 'PLATFORM_REDIS_URL', ['redis:', 'rediss:'])
    : env.PLATFORM_REDIS_URL ?? 'redis://:local-companion-redis-only@127.0.0.1:6388/0';
  if (production && [databaseUrl, redisUrl].some(value => value.includes('local-companion-dev-only') || value.includes('local-companion-redis-only'))) {
    throw new Error('Production connections must not use local development credentials');
  }
  if (production && !env.PLATFORM_ALLOWED_ORIGINS?.trim()) throw new Error('Production application origins must be explicitly configured');
  const allowedOrigins = origins(env.PLATFORM_ALLOWED_ORIGINS ?? 'http://localhost:4321,http://127.0.0.1:4321,http://localhost:4320,http://127.0.0.1:4320', production);
  if (env.PLATFORM_REQUIRE_VERIFIED_EMAIL !== undefined && !['0', '1'].includes(env.PLATFORM_REQUIRE_VERIFIED_EMAIL)) throw new Error('PLATFORM_REQUIRE_VERIFIED_EMAIL must be 0 or 1');
  if (production && env.PLATFORM_REQUIRE_VERIFIED_EMAIL === '0') throw new Error('Production requires verified email accounts');
  const requireVerifiedEmail = production || env.PLATFORM_REQUIRE_VERIFIED_EMAIL === '1';
  const accountEmail = readAccountEmailConfig(env, allowedOrigins);
  if (requireVerifiedEmail && !accountEmail) throw new Error('Verified email accounts require explicitly configured account email');
  const s3 = env.PLATFORM_S3_BUCKET ? {
    endpoint: env.PLATFORM_S3_ENDPOINT, bucket: env.PLATFORM_S3_BUCKET,
    region: env.PLATFORM_S3_REGION ?? 'us-east-1',
    accessKeyId: env.PLATFORM_S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.PLATFORM_S3_SECRET_ACCESS_KEY ?? '',
  } : undefined;
  if (s3 && (!s3.accessKeyId.trim() || !s3.secretAccessKey.trim())) throw new Error('S3 credentials must be configured on the server');
  if (production) {
    if (!s3 || !s3.bucket.trim() || !s3.region.trim()) throw new Error('Production requires configured private S3-compatible storage');
    if (s3.endpoint !== undefined) {
      let endpoint: URL;
      try { endpoint = new URL(s3.endpoint); } catch { throw new Error('Production S3 endpoint must be an exact HTTPS origin'); }
      if (endpoint.protocol !== 'https:' || endpoint.origin !== s3.endpoint || endpoint.hostname.includes('*') || endpoint.username || endpoint.password) throw new Error('Production S3 endpoint must be an exact HTTPS origin');
    }
  }
  const maxActiveJobs = Number(env.PLATFORM_MAX_ACTIVE_JOBS ?? 4);
  if (!Number.isSafeInteger(maxActiveJobs) || maxActiveJobs < 1) throw new Error('PLATFORM_MAX_ACTIVE_JOBS must be a positive integer');
  if (env.PLATFORM_WEB_STATIC_DIR !== undefined && !env.PLATFORM_WEB_STATIC_DIR.trim()) throw new Error('PLATFORM_WEB_STATIC_DIR must name the built web directory');
  return {
    databaseUrl, redisUrl, databasePoolMax, databaseConnectTimeoutMs, codeVersion,
    storageDir: path.resolve(workspaceRoot,env.PLATFORM_STORAGE_DIR ?? '.local/platform/blobs'),
    host: host as PlatformConfig['host'], port: hostedPort ?? platformPort ?? 4320,
    webStaticDir: env.PLATFORM_WEB_STATIC_DIR === undefined ? undefined : path.resolve(workspaceRoot, env.PLATFORM_WEB_STATIC_DIR),
    allowedOrigins,
    sessionDays: 14, maxActiveJobs, secureCookies: production, accountEmail, requireVerifiedEmail, workbenchEnabled,
    queueName, s3, mcp: readMcpConfig(env),
  };
}
