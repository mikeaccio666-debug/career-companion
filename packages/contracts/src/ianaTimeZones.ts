/** Stable IANA timezone wire primitive from AGENT-API-CONTRACT.md §§1 and 3.7. */

import {
  IANA_TIME_ZONE_CANONICAL_NAMES_2026C,
  IANA_TIME_ZONE_LINK_TARGET_ENTRIES_2026C,
} from './ianaTimeZones2026c.generated.ts';

export {
  IANA_TIME_ZONE_CANONICAL_ZONE_COUNT,
  IANA_TIME_ZONE_LINK_COUNT,
  IANA_TIME_ZONE_REGISTRY_SHA256,
  IANA_TIME_ZONE_REGISTRY_SOURCE_SHA256,
  IANA_TIME_ZONE_REGISTRY_SOURCE_URL,
  IANA_TIME_ZONE_REGISTRY_VERSION,
  /** Resolved IANA Link alias → canonical Zone pairs used for runtime closure checks. */
  IANA_TIME_ZONE_LINK_TARGET_ENTRIES_2026C,
} from './ianaTimeZones2026c.generated.ts';

declare const ianaTimeZoneCandidateBrand: unique symbol;
declare const ianaTimeZoneBrand: unique symbol;

/**
 * A 2026c Zone or Link spelling detected at a client boundary.
 *
 * This is not a formal account wire type. Callers must canonicalize it before
 * sending or persisting an account time zone.
 */
export type IanaTimeZoneCandidate = string & {
  readonly [ianaTimeZoneCandidateBrand]: 'IanaTimeZoneCandidate';
};

/** A canonical 2026c account Zone name used on formal wires and in persistence. */
export type IanaTimeZone = string & {
  readonly [ianaTimeZoneBrand]: 'IanaTimeZone';
};

/** @deprecated Use `IanaTimeZone`; retained as a source-compatible T12 export. */
export type CanonicalIanaTimeZone = IanaTimeZone;

const ACCOUNT_FORBIDDEN_CANONICAL_NAMES = new Set<string>(['Factory']);
const accountCanonicalNames = IANA_TIME_ZONE_CANONICAL_NAMES_2026C.filter(
  (name) => !ACCOUNT_FORBIDDEN_CANONICAL_NAMES.has(name),
);

/** Raw TZDB contains 341 Zones; account scheduling intentionally excludes `Factory`. */
export const ACCOUNT_IANA_TIME_ZONE_CANONICAL_ZONE_COUNT = 340 as const;

/** Canonical account Zone names for settings selectors; Link aliases are intentionally excluded. */
export const CANONICAL_IANA_TIME_ZONES = Object.freeze(accountCanonicalNames) as
  readonly IanaTimeZone[];
/** Version-explicit alias for consumers that pin selector data by release. */
export const IANA_TIME_ZONE_NAMES_2026C = CANONICAL_IANA_TIME_ZONES;

const canonicalNames = new Set<string>(accountCanonicalNames);
const linkTargets = new Map<string, string>(IANA_TIME_ZONE_LINK_TARGET_ENTRIES_2026C);

/**
 * Validate a Zone-or-Link candidate while preserving its detected spelling.
 * Alias acceptance is intentionally limited to this client-detection helper.
 */
export function parseIanaTimeZoneCandidate(value: unknown): IanaTimeZoneCandidate | null {
  if (typeof value !== 'string') return null;
  const target = canonicalNames.has(value) ? value : linkTargets.get(value);
  return target !== undefined && canonicalNames.has(target)
    ? value as IanaTimeZoneCandidate
    : null;
}

/**
 * Parse a formal account time-zone wire value.
 *
 * Only canonical, account-admissible 2026c Zone names are accepted. Link aliases
 * are rejected, and host Node/browser/OS Intl data is never consulted.
 */
export function parseIanaTimeZone(value: unknown): IanaTimeZone | null {
  return typeof value === 'string' && canonicalNames.has(value)
    ? value as IanaTimeZone
    : null;
}

/** Source-compatible canonical-only parser name retained for T12 consumers. */
export function parseCanonicalIanaTimeZone(value: unknown): IanaTimeZone | null {
  return parseIanaTimeZone(value);
}

/**
 * Canonicalize a detected 2026c Zone-or-Link spelling for a client to place on
 * a formal account wire. This is the only helper that resolves Link aliases.
 */
export function canonicalizeIanaTimeZone(value: unknown): IanaTimeZone | null {
  const candidate = parseIanaTimeZoneCandidate(value);
  if (!candidate) return null;
  return parseIanaTimeZone(candidate) ?? parseIanaTimeZone(linkTargets.get(candidate));
}
