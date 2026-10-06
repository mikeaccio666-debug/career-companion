import { PILOT_UA1_MAX_CONTROLS, PILOT_UA1_MAX_PATHNAME_LENGTH } from '@edaix/contracts/draft';

/**
 * Selector-free, extension-internal UA-1 trigger envelope.
 *
 * This is deliberately not a portal/backend wire. The only producer is the
 * background user-triggered lanes: the development browser action, or the
 * connected-dev Product Panel's current-page click. The content script accepts
 * one fresh envelope for the exact requested page and then tombstones its id.
 */

export const PILOT_UA1_DISCOVERY_REQUEST_KIND = 'pilot-ua1/discover-exact-page' as const;
export const PILOT_UA1_DISCOVERY_PROTOCOL_VERSION = 1 as const;
export const PILOT_UA1_DISCOVERY_REQUEST_TTL_MS = 5_000;
export const PILOT_UA1_MAX_EXACT_HREF_LENGTH = 4_096;

export type PilotUa1DiscoveryFailureCode =
  | 'PILOT_CAPABILITY_DISABLED'
  | 'PILOT_NOT_USER_TRIGGERED'
  | 'PILOT_TARGET_DRIFT'
  | 'PILOT_DISCOVERY_UNAVAILABLE';

export interface PilotUa1DiscoveryRequest {
  readonly kind: typeof PILOT_UA1_DISCOVERY_REQUEST_KIND;
  readonly version: typeof PILOT_UA1_DISCOVERY_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly targetOrigin: string;
  readonly targetPathname: string;
  /** SHA-256 of the transient exact href; raw query/hash never enters a message. */
  readonly targetUrlDigest: string;
}

export interface PilotUa1DiscoveryFailure {
  readonly ok: false;
  readonly code: PilotUa1DiscoveryFailureCode;
}

export interface PilotUa1DiscoverySuccessSummary {
  readonly ok: true;
  readonly detectedControlCount: number;
}

export type PilotUa1DiscoveryRuntimeResponse =
  | PilotUa1DiscoverySuccessSummary
  | PilotUa1DiscoveryFailure;

const REQUEST_KEYS = [
  'expiresAtMs',
  'issuedAtMs',
  'kind',
  'requestId',
  'targetOrigin',
  'targetPathname',
  'targetUrlDigest',
  'version',
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataValues(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!isPlainRecord(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function parseExactHttpTarget(
  origin: unknown,
  pathname: unknown,
): { readonly origin: string; readonly pathname: string } | null {
  if (typeof origin !== 'string' || typeof pathname !== 'string') return null;
  if (
    origin.length === 0 ||
    origin.length > 255 ||
    pathname.length === 0 ||
    pathname.length > PILOT_UA1_MAX_PATHNAME_LENGTH ||
    !pathname.startsWith('/') ||
    pathname.startsWith('//') ||
    pathname.includes('?') ||
    pathname.includes('#') ||
    /[\u0000-\u001f\u007f]/u.test(pathname)
  ) return null;
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.origin !== origin ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) return null;
    const parsedPath = new URL(pathname, 'https://pilot.invalid');
    if (parsedPath.pathname !== pathname) return null;
    return { origin: parsed.origin, pathname };
  } catch {
    return null;
  }
}

export function canonicalizePilotUa1ActionUrl(pageUrl: unknown): string | null {
  if (
    typeof pageUrl !== 'string' ||
    pageUrl.length === 0 ||
    pageUrl.length > PILOT_UA1_MAX_EXACT_HREF_LENGTH
  ) return null;
  try {
    const page = new URL(pageUrl);
    if (
      page.username !== '' ||
      page.password !== '' ||
      page.href.length > PILOT_UA1_MAX_EXACT_HREF_LENGTH ||
      parseExactHttpTarget(page.origin, page.pathname) === null
    ) return null;
    return page.href;
  } catch {
    return null;
  }
}

/** Strict decoder: extra fields cannot become a covert packet channel. */
export function parsePilotUa1DiscoveryRequest(value: unknown): PilotUa1DiscoveryRequest | null {
  try {
    const fields = exactDataValues(value, REQUEST_KEYS);
    if (fields === null) return null;
    if (
      fields.kind !== PILOT_UA1_DISCOVERY_REQUEST_KIND ||
      fields.version !== PILOT_UA1_DISCOVERY_PROTOCOL_VERSION ||
      typeof fields.requestId !== 'string' ||
      !/^[0-9a-f]{32}$/u.test(fields.requestId) ||
      typeof fields.issuedAtMs !== 'number' ||
      !Number.isSafeInteger(fields.issuedAtMs) ||
      typeof fields.expiresAtMs !== 'number' ||
      !Number.isSafeInteger(fields.expiresAtMs) ||
      fields.issuedAtMs < 0 ||
      fields.expiresAtMs <= fields.issuedAtMs ||
      fields.expiresAtMs - fields.issuedAtMs > PILOT_UA1_DISCOVERY_REQUEST_TTL_MS
    ) return null;
    const target = parseExactHttpTarget(fields.targetOrigin, fields.targetPathname);
    if (
      target === null ||
      typeof fields.targetUrlDigest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(fields.targetUrlDigest)
    ) return null;
    return Object.freeze({
      kind: PILOT_UA1_DISCOVERY_REQUEST_KIND,
      version: PILOT_UA1_DISCOVERY_PROTOCOL_VERSION,
      requestId: fields.requestId,
      issuedAtMs: fields.issuedAtMs,
      expiresAtMs: fields.expiresAtMs,
      targetOrigin: target.origin,
      targetPathname: target.pathname,
      targetUrlDigest: fields.targetUrlDigest,
    });
  } catch {
    return null;
  }
}

export function createPilotUa1DiscoveryRequest(input: Readonly<{
  pageUrl: string;
  requestId: string;
  issuedAtMs: number;
  targetUrlDigest: string;
}>): PilotUa1DiscoveryRequest | null {
  if (!Number.isSafeInteger(input.issuedAtMs) || input.issuedAtMs < 0) return null;
  const canonicalHref = canonicalizePilotUa1ActionUrl(input.pageUrl);
  if (canonicalHref === null) return null;
  const page = new URL(canonicalHref);
  const candidate = {
    kind: PILOT_UA1_DISCOVERY_REQUEST_KIND,
    version: PILOT_UA1_DISCOVERY_PROTOCOL_VERSION,
    requestId: input.requestId,
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.issuedAtMs + PILOT_UA1_DISCOVERY_REQUEST_TTL_MS,
    targetOrigin: page.origin,
    targetPathname: page.pathname,
    targetUrlDigest: input.targetUrlDigest,
  };
  return parsePilotUa1DiscoveryRequest(candidate);
}

export function parsePilotUa1DiscoveryRuntimeResponse(
  value: unknown,
): PilotUa1DiscoveryRuntimeResponse | null {
  try {
    if (!isPlainRecord(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      descriptors.ok === undefined ||
      !('value' in descriptors.ok) ||
      !descriptors.ok.enumerable
    ) return null;
    if (descriptors.ok.value === true) {
      if (
        ownKeys.length !== 2 ||
        !Object.hasOwn(descriptors, 'detectedControlCount') ||
        !('value' in descriptors.detectedControlCount) ||
        !descriptors.detectedControlCount.enumerable ||
        typeof descriptors.detectedControlCount.value !== 'number' ||
        !Number.isSafeInteger(descriptors.detectedControlCount.value) ||
        descriptors.detectedControlCount.value < 0 ||
        descriptors.detectedControlCount.value > PILOT_UA1_MAX_CONTROLS
      ) return null;
      return Object.freeze({
        ok: true,
        detectedControlCount: descriptors.detectedControlCount.value,
      });
    }
    if (
      descriptors.ok.value !== false ||
      ownKeys.length !== 2 ||
      !Object.hasOwn(descriptors, 'code') ||
      !('value' in descriptors.code) ||
      !descriptors.code.enumerable ||
      descriptors.code.value !== 'PILOT_CAPABILITY_DISABLED' &&
        descriptors.code.value !== 'PILOT_NOT_USER_TRIGGERED' &&
        descriptors.code.value !== 'PILOT_TARGET_DRIFT' &&
        descriptors.code.value !== 'PILOT_DISCOVERY_UNAVAILABLE'
    ) return null;
    return pilotUa1DiscoveryFailure(descriptors.code.value);
  } catch {
    return null;
  }
}

export function pilotUa1DiscoveryFailure(
  code: PilotUa1DiscoveryFailureCode,
): PilotUa1DiscoveryFailure {
  return Object.freeze({ ok: false, code });
}
