/**
 * EEO self-identification kept in the first-party Profile after the user enters it
 * (PRODUCT-AUTHORITY §3 four-tier set, §6). Values are the option wording the user chose,
 * kept verbatim so a host option is only ever matched exactly, never rewritten or inferred.
 *
 * `revision` counts every replace and every delete for the owner's row and never resets: a
 * delete leaves a tombstone, so a stale save from another tab cannot recreate the answers or
 * undo a reuse opt-out. Each mutation names the revision it was based on and is refused when
 * the row has moved on.
 */
import type { DecimalString } from './common.ts';
import { isBoundedQuestionText } from './applicationQuestionCandidates.ts';

export const EEO_SELF_IDENTIFICATION_FIELD_CODES = [
  'genderIdentity', 'eeoSex', 'transgenderStatus', 'hispanicLatino', 'raceEthnicity',
  'sexualOrientation', 'veteranStatus', 'disabilityStatus',
] as const;
export type EeoSelfIdentificationFieldCode = typeof EEO_SELF_IDENTIFICATION_FIELD_CODES[number];

/** One or more chosen wordings per field (race is multi-select; a self-description is its own wording). */
export type EeoSelfIdentificationAnswersV1 = Readonly<Partial<Record<EeoSelfIdentificationFieldCode, readonly string[]>>>;

export type EeoSelfIdentificationV1 = Readonly<{
  schemaVersion: 1; answers: EeoSelfIdentificationAnswersV1; reuseEnabled: boolean;
  disclosureVersion: string | null; revision: DecimalString; updatedAt: string | null;
}>;
export type EeoSelfIdentificationUpdateV1 = Readonly<{
  schemaVersion: 1; expectedRevision: DecimalString; answers: EeoSelfIdentificationAnswersV1; reuseEnabled: boolean; disclosureVersion: string;
}>;
export type EeoSelfIdentificationDeleteV1 = Readonly<{ schemaVersion: 1; expectedRevision: DecimalString }>;

const MAX_VALUES_PER_FIELD = 12;
const VALUE_LIMIT_BYTES = 200;

export function parseEeoSelfIdentificationUpdateV1(value: unknown): EeoSelfIdentificationUpdateV1 | null {
  if (!object(value, ['schemaVersion', 'expectedRevision', 'answers', 'reuseEnabled', 'disclosureVersion']) || value.schemaVersion !== 1
    || !revision(value.expectedRevision) || typeof value.reuseEnabled !== 'boolean'
    || !isBoundedQuestionText(value.disclosureVersion, 64) || !answers(value.answers)) return null;
  return value as EeoSelfIdentificationUpdateV1;
}

export function parseEeoSelfIdentificationDeleteV1(value: unknown): EeoSelfIdentificationDeleteV1 | null {
  return object(value, ['schemaVersion', 'expectedRevision']) && value.schemaVersion === 1 && revision(value.expectedRevision)
    ? value as EeoSelfIdentificationDeleteV1 : null;
}

const revision = (v: unknown): v is DecimalString => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(v);

function answers(v: unknown): v is EeoSelfIdentificationAnswersV1 {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v as Record<string, unknown>).every(([code, values]) =>
    (EEO_SELF_IDENTIFICATION_FIELD_CODES as readonly string[]).includes(code) && Array.isArray(values)
    && values.length >= 1 && values.length <= MAX_VALUES_PER_FIELD && new Set(values).size === values.length
    && values.every((text) => isBoundedQuestionText(text, VALUE_LIMIT_BYTES)));
}

function object(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}
