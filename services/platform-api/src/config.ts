import path from 'node:path';
import { orgKnowledgeBrand } from '@companion/platform-contracts';
import { fileURLToPath } from 'node:url';
import { readAccountEmailConfig, type AccountEmailConfig } from './account-mail.ts';
import { readMcpConfig, type McpCatalogConfig } from './mcp-config.ts';
import { readDataCrypto, type DataCrypto } from './data-crypto.ts';
import type { ModelRoutePurpose } from './model-routing.ts';
import { readCompanionSealGlyphConfiguration, type CompanionSealGlyphConfiguration } from './companion-seal-glyphs.ts';

export const workspaceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');

export interface PlatformConfig {
  databaseUrl: string; redisUrl: string; storageDir: string; port: number;
  databasePoolMax: number; databaseConnectTimeoutMs: number; codeVersion: string;
  host: '127.0.0.1' | 'localhost' | '::1' | '0.0.0.0'; webStaticDir?: string;
  allowedOrigins: Set<string>; sessionDays: number; maxActiveJobs: number;
  secureCookies: boolean; queueName: string; s3?: { endpoint?: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };
  accountEmail?: AccountEmailConfig; requireVerifiedEmail: boolean;
  requireInvite: boolean; legalBundlePath?: string; safetyDetectorProfilePath?: string; safetyResponseBundlePath?: string; safetyDeliveryReviewPath?: string; companionIdentityBundlePath?: string; companionIdentityReviewPath?: string; safetyDailyModelCallLimit: number;
  dataCrypto?: DataCrypto;
  orgContentBrand?: string;
  companionSealGlyphs?: Readonly<CompanionSealGlyphConfiguration>;
  workbenchEnabled: boolean;
  modelRoutes: Partial<Record<ModelRoutePurpose, { provider: string }>>;
  exposeProviderDetails: boolean;
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

function modelRoutes(env: NodeJS.ProcessEnv): PlatformConfig['modelRoutes'] {
  const variables: Record<ModelRoutePurpose, string> = {
    chat: 'PLATFORM_CHAT_PROVIDER', agent: 'PLATFORM_AGENT_PROVIDER',
    realtime: 'PLATFORM_REALTIME_PROVIDER', transcription: 'PLATFORM_TRANSCRIPTION_PROVIDER', speech: 'PLATFORM_SPEECH_PROVIDER',
    safety_classify: 'PLATFORM_SAFETY_CLASSIFY_PROVIDER',
    companion_generation: 'PLATFORM_COMPANION_GENERATION_PROVIDER',
  };
  const routes: PlatformConfig['modelRoutes'] = {};
  for (const purpose of Object.keys(variables) as ModelRoutePurpose[]) {
    const name = variables[purpose], provider = env[name];
    if (provider === undefined) continue;
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.exec(provider)?.[0] !== provider) {
      throw new Error(`${name} must be a bounded provider identifier`);
    }
    routes[purpose] = { provider };
  }
  return routes;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const production = env.NODE_ENV === 'production';
  if (env.PLATFORM_REQUIRE_INVITE !== undefined && !['0','1'].includes(env.PLATFORM_REQUIRE_INVITE)) throw new Error('PLATFORM_REQUIRE_INVITE must be 0 or 1');
  if (production && env.PLATFORM_REQUIRE_INVITE === '0') throw new Error('Production requires invitations');
  const requireInvite = production || env.PLATFORM_REQUIRE_INVITE !== '0';
  const dataCrypto = readDataCrypto(env);
  const companionSealGlyphs = readCompanionSealGlyphConfiguration(env, workspaceRoot);
  if (env.PLATFORM_LEGAL_BUNDLE_FILE !== undefined && (!env.PLATFORM_LEGAL_BUNDLE_FILE.trim() || /[\x00-\x1f\x7f]/.test(env.PLATFORM_LEGAL_BUNDLE_FILE))) throw new Error('PLATFORM_LEGAL_BUNDLE_FILE must name a server-controlled file');
  const legalBundlePath = env.PLATFORM_LEGAL_BUNDLE_FILE === undefined ? undefined : path.resolve(workspaceRoot,env.PLATFORM_LEGAL_BUNDLE_FILE);
  if (env.PLATFORM_SAFETY_PROFILE_FILE !== undefined && (!env.PLATFORM_SAFETY_PROFILE_FILE.trim() || /[\x00-\x1f\x7f]/.test(env.PLATFORM_SAFETY_PROFILE_FILE))) throw new Error('PLATFORM_SAFETY_PROFILE_FILE must name a server-controlled file');
  const safetyDetectorProfilePath = env.PLATFORM_SAFETY_PROFILE_FILE === undefined ? undefined : path.resolve(workspaceRoot, env.PLATFORM_SAFETY_PROFILE_FILE);
  if (env.PLATFORM_SAFETY_RESPONSE_BUNDLE_FILE !== undefined && (!env.PLATFORM_SAFETY_RESPONSE_BUNDLE_FILE.trim() || /[\x00-\x1f\x7f]/.test(env.PLATFORM_SAFETY_RESPONSE_BUNDLE_FILE))) throw new Error('PLATFORM_SAFETY_RESPONSE_BUNDLE_FILE must name a server-controlled file');
  const safetyResponseBundlePath = env.PLATFORM_SAFETY_RESPONSE_BUNDLE_FILE === undefined ? undefined : path.resolve(workspaceRoot, env.PLATFORM_SAFETY_RESPONSE_BUNDLE_FILE);
  if (env.PLATFORM_SAFETY_DELIVERY_REVIEW_FILE !== undefined && (!env.PLATFORM_SAFETY_DELIVERY_REVIEW_FILE.trim() || /[\x00-\x1f\x7f]/.test(env.PLATFORM_SAFETY_DELIVERY_REVIEW_FILE))) {
    throw new Error('PLATFORM_SAFETY_DELIVERY_REVIEW_FILE must name a server-controlled file');
  }
  const safetyDeliveryReviewPath = env.PLATFORM_SAFETY_DELIVERY_REVIEW_FILE === undefined ? undefined : path.resolve(workspaceRoot, env.PLATFORM_SAFETY_DELIVERY_REVIEW_FILE);
  if (env.PLATFORM_COMPANION_IDENTITY_BUNDLE_FILE !== undefined && (!env.PLATFORM_COMPANION_IDENTITY_BUNDLE_FILE.trim() || /[\x00-\x1f\x7f]/.test(env.PLATFORM_COMPANION_IDENTITY_BUNDLE_FILE))) {
    throw new Error('PLATFORM_COMPANION_IDENTITY_BUNDLE_FILE must name a server-controlled file');
  }
  const companionIdentityBundlePath = env.PLATFORM_COMPANION_IDENTITY_BUNDLE_FILE === undefined ? undefined : path.resolve(workspaceRoot, env.PLATFORM_COMPANION_IDENTITY_BUNDLE_FILE);
  if (env.PLATFORM_COMPANION_IDENTITY_REVIEW_FILE !== undefined && (!env.PLATFORM_COMPANION_IDENTITY_REVIEW_FILE.trim() || /[\x00-\x1f\x7f]/.test(env.PLATFORM_COMPANION_IDENTITY_REVIEW_FILE))) {
    throw new Error('PLATFORM_COMPANION_IDENTITY_REVIEW_FILE must name a server-controlled file');
  }
  const companionIdentityReviewPath = env.PLATFORM_COMPANION_IDENTITY_REVIEW_FILE === undefined ? undefined : path.resolve(workspaceRoot, env.PLATFORM_COMPANION_IDENTITY_REVIEW_FILE);
  const safetyLimit = env.PLATFORM_SAFETY_DAILY_MODEL_CALL_LIMIT ?? '0';
  if (/^(0|[1-9][0-9]{0,4})$/.exec(safetyLimit)?.[0] !== safetyLimit || Number(safetyLimit) > 10000) throw new Error('PLATFORM_SAFETY_DAILY_MODEL_CALL_LIMIT must be an integer from 0 to 10000');
  const safetyDailyModelCallLimit = Number(safetyLimit);
  if (env.PLATFORM_ENABLE_WORKBENCH !== undefined && !['0', '1'].includes(env.PLATFORM_ENABLE_WORKBENCH)) {
    throw new Error('PLATFORM_ENABLE_WORKBENCH must be 0 or 1');
  }
  const workbenchEnabled = env.PLATFORM_ENABLE_WORKBENCH === '1';
  // Internal deployment mode is not employee authorization. Production cannot
  // expose this mode before the separate staff-role boundary is implemented.
  if (production && workbenchEnabled) throw new Error('PLATFORM_ENABLE_WORKBENCH cannot enable a public production workbench before staff authorization is implemented');
  if (env.PLATFORM_EXPOSE_PROVIDER_DETAILS !== undefined && !['0', '1'].includes(env.PLATFORM_EXPOSE_PROVIDER_DETAILS)) {
    throw new Error('PLATFORM_EXPOSE_PROVIDER_DETAILS must be 0 or 1');
  }
  // Deployment diagnostics never grant a caller model-selection or staff rights.
  const exposeProviderDetails = env.NODE_ENV === 'development' && workbenchEnabled && env.PLATFORM_EXPOSE_PROVIDER_DETAILS === '1';
  const configuredModelRoutes = modelRoutes(env);
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
    orgContentBrand: orgKnowledgeBrand(env.PLATFORM_ORG_CONTENT_BRAND ?? '蔓藤'),
    storageDir: path.resolve(workspaceRoot,env.PLATFORM_STORAGE_DIR ?? '.local/platform/blobs'),
    host: host as PlatformConfig['host'], port: hostedPort ?? platformPort ?? 4320,
    webStaticDir: env.PLATFORM_WEB_STATIC_DIR === undefined ? undefined : path.resolve(workspaceRoot, env.PLATFORM_WEB_STATIC_DIR),
    allowedOrigins,
    sessionDays: 14, maxActiveJobs, secureCookies: production, accountEmail, requireVerifiedEmail, requireInvite, legalBundlePath, safetyDetectorProfilePath, safetyResponseBundlePath, safetyDeliveryReviewPath, companionIdentityBundlePath, companionIdentityReviewPath, safetyDailyModelCallLimit, workbenchEnabled,
    modelRoutes: configuredModelRoutes, exposeProviderDetails, dataCrypto, companionSealGlyphs,
    queueName, s3, mcp: readMcpConfig(env),
  };
}
