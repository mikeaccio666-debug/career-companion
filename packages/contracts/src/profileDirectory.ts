/**
 * The standing, grant-free view of the profile the user can open at any time.
 *
 * The autofill read (`GET /agent/application-profile`) only answers inside an
 * authorized fill: it is bound to a signed grant's field keys and snapshot
 * digest, so there is nothing to show a user who simply wants to check what we
 * hold on them. This directory is that second, owner-scoped door — same stored
 * profile, no grant, and the user may write as well as read.
 *
 * It is four channels, not one envelope. The eleven ordinary keys and an EEO
 * self-identification answer travel separately all the way down the wire, so a
 * self-identification answer can never arrive on the ordinary profile pipe —
 * the fill-chain client rejects that whole response as `PROFILE_SENSITIVE_SMUGGLED`,
 * and keeping the channels apart here is what makes that rejection a statement
 * about the wire rather than a lucky property of one caller. EEO therefore has
 * no shape in this file at all: it keeps its own contract in
 * `eeoSelfIdentification.ts` and is read and written there.
 *
 * Every write names the revision it was based on. Two surfaces edit this data —
 * the web onboarding and the extension panel — so a save that did not check
 * would silently drop whatever the other one had just stored.
 */

import type { DecimalString, IsoDateTime } from './common.ts';
import type { ApplicationProfileFieldKey } from './executionIntent.ts';
import { APPLICATION_PROFILE_FIELD_KEYS } from './executionIntent.ts';
import type { IanaTimeZone } from './ianaTimeZones.ts';
import type {
  ProfileWorkAuthorizationAnswerV2,
} from './profileV2.ts';
import { PROFILE_V2_WORK_AUTHORIZATION_ANSWERS } from './profileV2.ts';
import type { IsoCountryCode } from './sensitiveWrite.ts';

export const PROFILE_DIRECTORY_SCHEMA_VERSION = 1 as const;

/*
 * There is deliberately no list of channel names here. The channels are kept
 * apart by there being separate endpoints carrying separate shapes, which is a
 * stronger guarantee than a list of names, and the panel's own section table
 * already names its sections. A second naming here would be a second place to
 * ask which contract an answer belongs to.
 */

/* ------------------------------------------------------------------ *
 * APPLICATION_PROFILE — the eleven ordinary keys
 * ------------------------------------------------------------------ */

/**
 * The ten ordinary keys the owner may author here.
 *
 * `location` is the eleventh key and is readable but not writable: it is
 * free text carried over from the pre-V2 profile, which the current store can
 * only clear, never re-author. Accepting a write for it would mean either
 * silently dropping it or inventing a second place to keep it.
 */
export const PROFILE_DIRECTORY_WRITABLE_FIELD_KEYS = Object.freeze(
  APPLICATION_PROFILE_FIELD_KEYS.filter((key) => key !== 'location'),
) as readonly Exclude<ApplicationProfileFieldKey, 'location'>[];
export type ProfileDirectoryWritableFieldKey =
  (typeof PROFILE_DIRECTORY_WRITABLE_FIELD_KEYS)[number];

export type ProfileDirectoryPersonalV1 = Readonly<{
  schemaVersion: 1;
  /** `ApplicationProfile.revision`; `0` when nothing is stored. */
  revision: DecimalString;
  /** Bumped by a profile deletion, so a pre-deletion save cannot revive it. */
  deletionEpoch: DecimalString;
  /** All eleven keys, always present, so an absent key is never read as "unchanged". */
  fields: Readonly<Record<ApplicationProfileFieldKey, string | null>>;
  updatedAt: IsoDateTime | null;
}>;

export type ProfileDirectoryPersonalUpdateV1 = Readonly<{
  schemaVersion: 1;
  expectedRevision: DecimalString;
  expectedDeletionEpoch: DecimalString;
  /** Only the keys the user edited; `null` clears one. */
  fields: Readonly<Partial<Record<ProfileDirectoryWritableFieldKey, string | null>>>;
}>;

/* ------------------------------------------------------------------ *
 * WORK_AUTHORIZATION — predicates the user entered, plus their reuse switch
 * ------------------------------------------------------------------ */

/**
 * One region's two predicates, exactly as the user answered them.
 *
 * Nothing here may be derived from a name, a resume, a nationality, a model, or
 * a default: an unanswered predicate stays `UNSPECIFIED` rather than being
 * guessed, because a guessed work-authorization answer is one we would go on to
 * write into a real employer's form.
 */
export type ProfileDirectoryWorkAuthorizationEntryV1 = Readonly<{
  regionCode: IsoCountryCode;
  authorizedToWork: ProfileWorkAuthorizationAnswerV2;
  requiresSponsorship: ProfileWorkAuthorizationAnswerV2;
}>;

export type ProfileDirectoryWorkAuthorizationV1 = Readonly<{
  schemaVersion: 1;
  /** `ApplicationProfile.revision` — the answers live on the profile row. */
  profileRevision: DecimalString;
  deletionEpoch: DecimalString;
  /**
   * The reuse switch's own counter. The switch is an account preference, stored
   * apart from the answers, so it carries the preferences revision rather than
   * the profile's: one shared number would fence a save that only touched the
   * switch behind an unrelated edit to the answers, and would lose one of the
   * two writes. The same switch is also readable and writable on the
   * preferences channel; both doors compare and set this one counter, so there
   * is a single stored bit and neither door can overwrite the other blindly.
   */
  preferencesRevision: DecimalString;
  /**
   * Whether the stored answers may be reused for a future form. Turning this
   * off stops the reuse and leaves the answers alone; the user's stated facts
   * are never rewritten as a side effect of withdrawing reuse.
   */
  reuseEnabled: boolean;
  entries: readonly ProfileDirectoryWorkAuthorizationEntryV1[];
}>;

export type ProfileDirectoryWorkAuthorizationUpdateV1 = Readonly<{
  schemaVersion: 1;
  expectedProfileRevision: DecimalString;
  expectedDeletionEpoch: DecimalString;
  expectedPreferencesRevision: DecimalString;
  reuseEnabled: boolean;
  /** The full set the user confirmed; a region left out is withdrawn. */
  entries: readonly ProfileDirectoryWorkAuthorizationEntryV1[];
}>;

/* ------------------------------------------------------------------ *
 * APPLICATION_PREFERENCES — account-level, never written to a host form
 * ------------------------------------------------------------------ */

/**
 * Preferences that belong to the account rather than to any application.
 *
 * This is deliberately only what the product already stores: the reuse switch
 * for work authorization, and the account's primary time zone for display.
 * The EEO reuse switch is not mirrored here — it is read and written on the EEO
 * contract, and a copy on this channel would be a second place to ask what the
 * user had decided about their self-identification answers. Salary, notice
 * period and relocation are *not* here — they have no durable owner-scoped home
 * yet, and inventing one would give the fill chain an answer the user never
 * actually confirmed.
 */
export type ProfileDirectoryPreferencesV1 = Readonly<{
  schemaVersion: 1;
  revision: DecimalString;
  workAuthorizationReuseEnabled: boolean;
  /**
   * Shown so the panel can state the account's time zone, and not writable
   * here: changing it also reschedules the daily report, and the account
   * endpoint that already owns that work stays its only writer.
   */
  primaryTimeZone: IanaTimeZone | null;
  updatedAt: IsoDateTime | null;
}>;

export type ProfileDirectoryPreferencesUpdateV1 = Readonly<{
  schemaVersion: 1;
  expectedRevision: DecimalString;
  workAuthorizationReuseEnabled: boolean;
}>;

/* ------------------------------------------------------------------ *
 * Parsers
 * ------------------------------------------------------------------ */

const FIELD_VALUE_LIMIT_BYTES = 2048;
const MAX_WORK_AUTHORIZATION_ENTRIES = 20;

const WRITABLE_FIELD_KEYS: ReadonlySet<string> = new Set(PROFILE_DIRECTORY_WRITABLE_FIELD_KEYS);
const WORK_AUTHORIZATION_ANSWERS: ReadonlySet<string> = new Set(
  PROFILE_V2_WORK_AUTHORIZATION_ANSWERS,
);

export function parseProfileDirectoryPersonalUpdateV1(
  value: unknown,
): ProfileDirectoryPersonalUpdateV1 | null {
  if (!object(value, ['schemaVersion', 'expectedRevision', 'expectedDeletionEpoch', 'fields'])
    || value.schemaVersion !== PROFILE_DIRECTORY_SCHEMA_VERSION
    || !revision(value.expectedRevision) || !revision(value.expectedDeletionEpoch)
    || !personalFields(value.fields)) return null;
  return value as ProfileDirectoryPersonalUpdateV1;
}

export function parseProfileDirectoryWorkAuthorizationUpdateV1(
  value: unknown,
): ProfileDirectoryWorkAuthorizationUpdateV1 | null {
  if (!object(value, [
    'schemaVersion', 'expectedProfileRevision', 'expectedDeletionEpoch',
    'expectedPreferencesRevision', 'reuseEnabled', 'entries',
  ])
    || value.schemaVersion !== PROFILE_DIRECTORY_SCHEMA_VERSION
    || !revision(value.expectedProfileRevision) || !revision(value.expectedDeletionEpoch)
    || !revision(value.expectedPreferencesRevision) || typeof value.reuseEnabled !== 'boolean'
    || !workAuthorizationEntries(value.entries)) return null;
  return value as ProfileDirectoryWorkAuthorizationUpdateV1;
}

export function parseProfileDirectoryPreferencesUpdateV1(
  value: unknown,
): ProfileDirectoryPreferencesUpdateV1 | null {
  if (!object(value, ['schemaVersion', 'expectedRevision', 'workAuthorizationReuseEnabled'])
    || value.schemaVersion !== PROFILE_DIRECTORY_SCHEMA_VERSION
    || !revision(value.expectedRevision)
    || typeof value.workAuthorizationReuseEnabled !== 'boolean') return null;
  return value as ProfileDirectoryPreferencesUpdateV1;
}

const revision = (v: unknown): v is DecimalString =>
  typeof v === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(v);

function personalFields(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v as Record<string, unknown>).every(([key, value]) =>
    WRITABLE_FIELD_KEYS.has(key)
    && (value === null
      || (typeof value === 'string' && value.length > 0
        && new TextEncoder().encode(value).length <= FIELD_VALUE_LIMIT_BYTES)));
}

function workAuthorizationEntries(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > MAX_WORK_AUTHORIZATION_ENTRIES) return false;
  const regions = new Set<string>();
  for (const entry of v) {
    if (!object(entry, ['regionCode', 'authorizedToWork', 'requiresSponsorship'])) return false;
    const { regionCode, authorizedToWork, requiresSponsorship } = entry;
    if (typeof regionCode !== 'string' || !/^[A-Z]{2}$/u.test(regionCode)) return false;
    // One region, one answer: two rows for the same place would leave the fill
    // chain picking between contradictory statements the user never reconciled.
    if (regions.has(regionCode)) return false;
    regions.add(regionCode);
    if (!WORK_AUTHORIZATION_ANSWERS.has(authorizedToWork as string)
      || !WORK_AUTHORIZATION_ANSWERS.has(requiresSponsorship as string)) return false;
  }
  return true;
}

function object(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}
