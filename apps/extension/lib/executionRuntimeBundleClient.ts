import {
  canonicalizeExecutionRuntimeJsonV1,
  classifyExecutionRuntimeBundleTimeV1,
  compareExecutionRuntimeSemverV1,
  parseExecutionRuntimeBundleEtagV1,
  parseExecutionRuntimeBundleJsonV1,
  type ExecutionRuntimeBundleV1,
} from '@edaix/contracts';
import type { ExecutionRuntimeBundleStore } from './executionRuntimeBundleStore';

export const EXECUTION_RUNTIME_BUNDLE_ENDPOINT = '/api/v1/ext/execution-runtime-bundle';

const MAX_RUNTIME_BUNDLE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

export const EXECUTION_RUNTIME_BUNDLE_CLIENT_CODES = [
  'RUNTIME_BUNDLE_CONFIG_UNAVAILABLE',
  'RUNTIME_BUNDLE_CLIENT_UNAVAILABLE',
  'RUNTIME_BUNDLE_STORAGE_UNAVAILABLE',
  // Stable cache-boundary codes remain exported for source/mirror parity even
  // though transport failure no longer selects a cache fallback path.
  'RUNTIME_BUNDLE_CACHE_UNAVAILABLE',
  'RUNTIME_BUNDLE_CACHE_MALFORMED',
  'RUNTIME_BUNDLE_TIME_INVALID',
  'RUNTIME_BUNDLE_STALE',
  'RUNTIME_BUNDLE_HARD_EXPIRED',
  'RUNTIME_BUNDLE_HTTP_REJECTED',
  'RUNTIME_BUNDLE_RESPONSE_MALFORMED',
  'RUNTIME_BUNDLE_ETAG_INVALID',
  'RUNTIME_BUNDLE_NOT_MODIFIED_MISMATCH',
  'RUNTIME_BUNDLE_ROLLBACK',
  'RUNTIME_BUNDLE_RELEASE_COLLISION',
  'RUNTIME_BUNDLE_EXTENSION_INCOMPATIBLE',
  'RUNTIME_BUNDLE_PERSIST_FAILED',
] as const;

export type ExecutionRuntimeBundleClientCode =
  (typeof EXECUTION_RUNTIME_BUNDLE_CLIENT_CODES)[number];

export type ExecutionRuntimeBundleResolution =
  | Readonly<{
      ok: true;
      source: 'NETWORK' | 'NOT_MODIFIED';
      etag: string;
      bundle: ExecutionRuntimeBundleV1;
    }>
  | Readonly<{ ok: false; code: ExecutionRuntimeBundleClientCode }>;

/**
 * Narrow seam used to isolate the fetch/cache state machine in tests.  The
 * production default delegates every wire decision to @edaix/contracts; it
 * does not maintain a second permissive parser in the extension.
 */
export interface ExecutionRuntimeBundleContractCodec {
  /** Raw decoder is mandatory so duplicate-key evidence survives cache reads. */
  decodeJson(value: string): Promise<ExecutionRuntimeBundleV1 | null>;
  /** Exact canonical-body fence used both before persistence and after read. */
  isCanonicalRaw(value: string, bundle: ExecutionRuntimeBundleV1): boolean;
  classifyTime(
    value: ExecutionRuntimeBundleV1,
    nowMs: number,
  ): 'FRESH' | 'TIME_INVALID' | 'STALE' | 'HARD_EXPIRED';
  etagMatches(etag: string | null, value: ExecutionRuntimeBundleV1): boolean;
}

export interface ExecutionRuntimeBundleClient {
  refresh(): Promise<ExecutionRuntimeBundleResolution>;
}

export interface CreateExecutionRuntimeBundleClientInput {
  /** Null is the default-off state for this stacked predecessor. */
  readonly apiBase: string | null;
  readonly store: ExecutionRuntimeBundleStore;
  readonly extensionVersion: () => string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly codec?: ExecutionRuntimeBundleContractCodec;
}

type ValidCache = Readonly<{
  etag: string;
  bundle: ExecutionRuntimeBundleV1;
  rawBody: string;
}>;

type CacheState =
  | Readonly<{ kind: 'ABSENT' }>
  | Readonly<{ kind: 'INVALID' }>
  | Readonly<{ kind: 'VALID'; value: ValidCache }>;

const defaultCodec: ExecutionRuntimeBundleContractCodec = Object.freeze({
  async decodeJson(value: string) {
    const result = await parseExecutionRuntimeBundleJsonV1(value, {});
    return result.ok ? result.value : null;
  },
  isCanonicalRaw(value: string, bundle: ExecutionRuntimeBundleV1) {
    const canonical = canonicalizeExecutionRuntimeJsonV1(bundle);
    return canonical.ok && value === canonical.value;
  },
  classifyTime(value: ExecutionRuntimeBundleV1, nowMs: number) {
    const result = classifyExecutionRuntimeBundleTimeV1(value, nowMs);
    if (result.ok) return 'FRESH';
    if (result.code === 'RUNTIME_BUNDLE_HARD_EXPIRED') return 'HARD_EXPIRED';
    if (result.code === 'RUNTIME_BUNDLE_STALE') return 'STALE';
    return 'TIME_INVALID';
  },
  etagMatches(etag: string | null, value: ExecutionRuntimeBundleV1) {
    return parseExecutionRuntimeBundleEtagV1(etag, value).ok;
  },
});

export function createExecutionRuntimeBundleClient(
  input: CreateExecutionRuntimeBundleClientInput,
): ExecutionRuntimeBundleClient {
  const endpoint = resolveEndpoint(input.apiBase);
  const fetchFn = input.fetchFn ?? fetch;
  const now = input.now ?? Date.now;
  const codec = input.codec ?? defaultCodec;
  let pending: Promise<ExecutionRuntimeBundleResolution> | null = null;

  async function executeRefresh(): Promise<ExecutionRuntimeBundleResolution> {
    if (endpoint === null) return failure('RUNTIME_BUNDLE_CONFIG_UNAVAILABLE');

    let cache: CacheState;
    try {
      cache = await readCache(input.store, codec);
    } catch {
      return failure('RUNTIME_BUNDLE_STORAGE_UNAVAILABLE');
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (cache.kind === 'VALID') headers['if-none-match'] = cache.value.etag;

    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: 'GET',
        headers,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: timeoutSignal(FETCH_TIMEOUT_MS),
      });
    } catch {
      return failure('RUNTIME_BUNDLE_CLIENT_UNAVAILABLE');
    }

    if (response.status === 304) {
      if (cache.kind !== 'VALID' || response.headers.get('etag') !== cache.value.etag) {
        return failure('RUNTIME_BUNDLE_NOT_MODIFIED_MISMATCH');
      }
      // A 304 is only representation confirmation.  It never changes any
      // bundle-owned time and never writes a local fetchedAt extension.
      const usable = classifyUsable(cache.value.bundle, codec, now(), safeExtensionVersion(input));
      if (!usable.ok) return usable;
      return success('NOT_MODIFIED', cache.value);
    }

    if (response.status !== 200 || !response.ok) {
      return failure('RUNTIME_BUNDLE_HTTP_REJECTED');
    }

    const responseEtag = response.headers.get('etag');
    if (!isStrongRuntimeBundleEtag(responseEtag)) {
      return failure('RUNTIME_BUNDLE_ETAG_INVALID');
    }
    if (!isJsonContentType(response.headers.get('content-type'))) {
      return failure('RUNTIME_BUNDLE_RESPONSE_MALFORMED');
    }

    const body = await readBoundedBody(response, MAX_RUNTIME_BUNDLE_BYTES);
    if (body === null) return failure('RUNTIME_BUNDLE_RESPONSE_MALFORMED');

    let decoded: ExecutionRuntimeBundleV1 | null;
    try {
      decoded = await codec.decodeJson(body);
    } catch {
      decoded = null;
    }
    if (decoded === null) return failure('RUNTIME_BUNDLE_RESPONSE_MALFORMED');
    if (!codec.isCanonicalRaw(body, decoded)) {
      return failure('RUNTIME_BUNDLE_RESPONSE_MALFORMED');
    }
    if (!codec.etagMatches(responseEtag, decoded)) {
      return failure('RUNTIME_BUNDLE_ETAG_INVALID');
    }

    const usable = classifyUsable(decoded, codec, now(), safeExtensionVersion(input));
    if (!usable.ok) return usable;

    if (cache.kind === 'VALID') {
      const ordering = compareDecimalRevisions(
        decoded.releaseRevision,
        cache.value.bundle.releaseRevision,
      );
      if (ordering < 0) return failure('RUNTIME_BUNDLE_ROLLBACK');
      if (
        ordering === 0 &&
        decoded.runtimeBundleVersion !== cache.value.bundle.runtimeBundleVersion
      ) {
        return failure('RUNTIME_BUNDLE_RELEASE_COLLISION');
      }
    }

    try {
      await input.store.write(responseEtag, decoded, body);
    } catch {
      return failure('RUNTIME_BUNDLE_PERSIST_FAILED');
    }
    return success('NETWORK', { etag: responseEtag, bundle: decoded, rawBody: body });
  }

  return Object.freeze({
    refresh() {
      if (pending) return pending;
      pending = executeRefresh()
        .catch(() => failure('RUNTIME_BUNDLE_CLIENT_UNAVAILABLE'))
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  });
}

async function readCache(
  store: ExecutionRuntimeBundleStore,
  codec: ExecutionRuntimeBundleContractCodec,
): Promise<CacheState> {
  const raw = await store.read();
  if (raw === undefined) return { kind: 'ABSENT' };
  if (!isPlainRecord(raw) || !hasExactKeys(raw, [
    'schemaVersion',
    'etag',
    'runtimeBundleVersion',
    'releaseRevision',
    'rawBody',
  ])) {
    return { kind: 'INVALID' };
  }
  if (
    raw['schemaVersion'] !== 1 ||
    typeof raw['etag'] !== 'string' ||
    typeof raw['runtimeBundleVersion'] !== 'string' ||
    typeof raw['releaseRevision'] !== 'string' ||
    typeof raw['rawBody'] !== 'string'
  ) {
    return { kind: 'INVALID' };
  }
  const decoded = await codec.decodeJson(raw['rawBody']);
  if (
    decoded === null ||
    !codec.isCanonicalRaw(raw['rawBody'], decoded) ||
    decoded.runtimeBundleVersion !== raw['runtimeBundleVersion'] ||
    decoded.releaseRevision !== raw['releaseRevision'] ||
    !codec.etagMatches(raw['etag'], decoded)
  ) {
    return { kind: 'INVALID' };
  }
  return {
    kind: 'VALID',
    value: Object.freeze({
      etag: raw['etag'],
      bundle: decoded,
      rawBody: raw['rawBody'],
    }),
  };
}

function classifyUsable(
  bundle: ExecutionRuntimeBundleV1,
  codec: ExecutionRuntimeBundleContractCodec,
  nowMs: number,
  extensionVersion: string | null,
): Readonly<{ ok: true }> | Readonly<{ ok: false; code: ExecutionRuntimeBundleClientCode }> {
  const time = codec.classifyTime(bundle, nowMs);
  if (time === 'HARD_EXPIRED') return failure('RUNTIME_BUNDLE_HARD_EXPIRED');
  if (time === 'STALE') return failure('RUNTIME_BUNDLE_STALE');
  if (time !== 'FRESH') return failure('RUNTIME_BUNDLE_TIME_INVALID');
  if (
    extensionVersion === null ||
    !isVersionAtLeast(extensionVersion, bundle.compatibility.minExtensionVersion)
  ) {
    return failure('RUNTIME_BUNDLE_EXTENSION_INCOMPATIBLE');
  }
  return { ok: true };
}

function success(
  source: 'NETWORK' | 'NOT_MODIFIED',
  value: ValidCache,
): ExecutionRuntimeBundleResolution {
  return Object.freeze({ ok: true, source, etag: value.etag, bundle: value.bundle });
}

function failure(code: ExecutionRuntimeBundleClientCode): Readonly<{ ok: false; code: ExecutionRuntimeBundleClientCode }> {
  return Object.freeze({ ok: false, code });
}

function resolveEndpoint(apiBase: string | null): URL | null {
  if (apiBase === null) return null;
  let base: URL;
  try {
    base = new URL(apiBase);
  } catch {
    return null;
  }
  if (
    (base.protocol !== 'https:' && !isLoopbackHttp(base)) ||
    base.username !== '' ||
    base.password !== '' ||
    (base.pathname !== '' && base.pathname !== '/') ||
    base.search !== '' ||
    base.hash !== ''
  ) return null;
  return new URL(EXECUTION_RUNTIME_BUNDLE_ENDPOINT, base.origin);
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function safeExtensionVersion(input: CreateExecutionRuntimeBundleClientInput): string | null {
  try {
    return input.extensionVersion();
  } catch {
    return null;
  }
}

function isVersionAtLeast(current: string, minimum: string): boolean {
  const comparison = compareExecutionRuntimeSemverV1(current, minimum);
  return comparison !== null && comparison >= 0;
}

function compareDecimalRevisions(left: string, right: string): -1 | 0 | 1 {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  } catch {
    // The contract parser already rejects these.  Defensive failure treats a
    // surprise as a rollback instead of guessing an ordering.
    return -1;
  }
}

function isStrongRuntimeBundleEtag(value: string | null): value is string {
  return typeof value === 'string' && /^"rb1_[0-9a-f]{64}"$/.test(value);
}

function isJsonContentType(value: string | null): boolean {
  return typeof value === 'string' && /^application\/json(?:\s*;.*)?$/i.test(value);
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let output = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return null;
      }
      output += decoder.decode(part.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function timeoutSignal(milliseconds: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(milliseconds);
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
