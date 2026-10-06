import type { DecimalString } from './common.ts';
import {
  SKILL_CATEGORIES,
  type Evidence,
  type SkillCategory,
  type StrengthTag,
} from './gap-strength.ts';

export type ProfileStrengthSource = 'USER_CONFIRMED' | 'USER_FREEFORM';

export type ProfileStrengthSnapshot = {
  readonly schemaVersion: 1;
  readonly revision: DecimalString;
  readonly strengths: readonly StrengthTag[];
};

export type SaveProfileStrengthRequest = {
  readonly label: string;
  readonly source: ProfileStrengthSource;
  readonly category: SkillCategory;
  readonly evidence: readonly Evidence[];
};

export type RemoveProfileStrengthRequest = {
  readonly tagId: string;
};

export type ProfileStrengthParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: 'PROFILE_STRENGTH_MALFORMED' };

const malformed = <T>(): ProfileStrengthParseResult<T> => ({
  ok: false,
  code: 'PROFILE_STRENGTH_MALFORMED',
});

export function parseProfileStrengthSnapshot(
  input: unknown,
): ProfileStrengthParseResult<ProfileStrengthSnapshot> {
  if (!exactRecord(input, ['schemaVersion', 'revision', 'strengths'])) return malformed();
  if (input.schemaVersion !== 1 || !isDecimalString(input.revision) || !Array.isArray(input.strengths)) {
    return malformed();
  }
  const strengths: StrengthTag[] = [];
  for (const raw of input.strengths) {
    const strength = parsePersistedStrength(raw);
    if (!strength) return malformed();
    strengths.push(strength);
  }
  return { ok: true, value: { schemaVersion: 1, revision: input.revision, strengths } };
}

export function parseSaveProfileStrengthRequest(
  input: unknown,
): ProfileStrengthParseResult<SaveProfileStrengthRequest> {
  if (!exactRecord(input, ['label', 'source', 'category', 'evidence'])) return malformed();
  if (!validLabel(input.label) || !isProfileStrengthSource(input.source) || !isCategory(input.category)) {
    return malformed();
  }
  const evidence = parseEvidenceArray(input.evidence);
  if (!evidence) return malformed();
  if (input.source === 'USER_FREEFORM' && evidence.length !== 0) return malformed();
  if (
    input.source === 'USER_CONFIRMED' &&
    (evidence.length === 0 || evidence.some((item) => item.profileRef === null))
  ) return malformed();
  return {
    ok: true,
    value: { label: input.label.trim(), source: input.source, category: input.category, evidence },
  };
}

export function parseRemoveProfileStrengthRequest(
  input: unknown,
): ProfileStrengthParseResult<RemoveProfileStrengthRequest> {
  if (!exactRecord(input, ['tagId']) || typeof input.tagId !== 'string' || input.tagId.length === 0) {
    return malformed();
  }
  return { ok: true, value: { tagId: input.tagId } };
}

function parsePersistedStrength(input: unknown): StrengthTag | null {
  if (!exactRecord(input, ['id', 'label', 'source', 'category', 'evidence'])) return null;
  if (
    typeof input.id !== 'string' || input.id.length === 0 ||
    !validLabel(input.label) || !isProfileStrengthSource(input.source) || !isCategory(input.category)
  ) return null;
  const evidence = parseEvidenceArray(input.evidence);
  if (!evidence) return null;
  if (input.source === 'USER_FREEFORM' && evidence.length !== 0) return null;
  if (input.source === 'USER_CONFIRMED' && (evidence.length === 0 || evidence.some((item) => item.profileRef === null))) {
    return null;
  }
  return { id: input.id, label: input.label, source: input.source, category: input.category, evidence };
}

function parseEvidenceArray(input: unknown): readonly Evidence[] | null {
  if (!Array.isArray(input) || input.length > 20) return null;
  const result: Evidence[] = [];
  for (const raw of input) {
    if (!exactRecord(raw, ['profileRef', 'note'])) return null;
    if (!(raw.profileRef === null || (typeof raw.profileRef === 'string' && raw.profileRef.length > 0))) return null;
    if (typeof raw.note !== 'string' || raw.note.length > 500) return null;
    result.push({ profileRef: raw.profileRef, note: raw.note });
  }
  return result;
}

function exactRecord(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const actual = Object.keys(input);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(input, key));
}

function validLabel(input: unknown): input is string {
  return typeof input === 'string' && input.trim().length > 0 && input.trim().length <= 120;
}

function isDecimalString(input: unknown): input is DecimalString {
  return typeof input === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(input);
}

function isCategory(input: unknown): input is SkillCategory {
  return typeof input === 'string' && (SKILL_CATEGORIES as readonly string[]).includes(input);
}

function isProfileStrengthSource(input: unknown): input is ProfileStrengthSource {
  return input === 'USER_CONFIRMED' || input === 'USER_FREEFORM';
}
