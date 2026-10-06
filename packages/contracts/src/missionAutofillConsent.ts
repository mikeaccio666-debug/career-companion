/**
 * Mission autofill consent: the account holder's own recorded decision about letting the
 * product fill application form fields for them (PRODUCT-AUTHORITY §3 feature-level
 * disclosure, §5 human authorization).
 *
 * The record is a consent ledger keyed by purpose. The Mission admission authority reads
 * only the latest event for a purpose and admits it only when that event is a grant at the
 * exact policy version currently in force, so an older grant, a withdrawal, or no record at
 * all all refuse. Nothing on this wire authorizes a submission: filling stops before Submit.
 */

export const MISSION_AUTOFILL_CONSENT_DECISIONS = ['GRANT', 'WITHDRAW'] as const;
export type MissionAutofillConsentDecision = typeof MISSION_AUTOFILL_CONSENT_DECISIONS[number];

/**
 * `SUPERSEDED` means the owner's latest act is a grant made against a different policy
 * version than the one now in force: it never admits, and the owner must decide again.
 */
export const MISSION_AUTOFILL_CONSENT_STATES = [
  'NOT_RECORDED',
  'GRANTED',
  'WITHDRAWN',
  'SUPERSEDED',
] as const;
export type MissionAutofillConsentState = typeof MISSION_AUTOFILL_CONSENT_STATES[number];

/** Event type written for a withdrawal; reserved, so a deployment may never configure it as the granted type. */
export const MISSION_AUTOFILL_CONSENT_WITHDRAWN_EVENT_TYPE = 'MISSION_AUTOFILL_CONSENT_WITHDRAWN';

/** Provenance schema stored beside the event; it carries no Data-L1 content. */
export const MISSION_AUTOFILL_CONSENT_METADATA_SCHEMA_VERSION = 1;

export type MissionAutofillConsentV1 = Readonly<{
  schemaVersion: 1;
  /** The purpose and policy version currently in force; a decision must name both exactly. */
  purpose: string;
  policyVersion: string;
  state: MissionAutofillConsentState;
  /** Disclosure the owner reported seeing when they last decided, and when that was. */
  disclosureVersion: string | null;
  decidedAt: string | null;
}>;

export type RecordMissionAutofillConsentV1 = Readonly<{
  schemaVersion: 1;
  purpose: string;
  policyVersion: string;
  decision: MissionAutofillConsentDecision;
  disclosureVersion: string;
}>;

const TOKEN_LIMIT = 64;

export function parseRecordMissionAutofillConsentV1(
  value: unknown,
): RecordMissionAutofillConsentV1 | null {
  return object(value, ['schemaVersion', 'purpose', 'policyVersion', 'decision', 'disclosureVersion']) &&
    value.schemaVersion === 1 &&
    isMissionAutofillConsentToken(value.purpose) &&
    isMissionAutofillConsentToken(value.policyVersion) &&
    isMissionAutofillConsentToken(value.disclosureVersion) &&
    member(MISSION_AUTOFILL_CONSENT_DECISIONS, value.decision)
    ? (value as RecordMissionAutofillConsentV1)
    : null;
}

/** Printable, trimmed, bounded single-line token — the same shape the runtime configuration accepts. */
export function isMissionAutofillConsentToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= TOKEN_LIMIT &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function member<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
