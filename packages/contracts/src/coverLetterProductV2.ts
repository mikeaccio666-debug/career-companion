/** Explicit aggregate dialect. V1 parsers and historical semantics are unchanged. */
import {
  parseCoverLetterProductRequestV1, parseCoverLetterProductResultV1,
  parseCoverLetterRequirementRequestV1, parseCoverLetterRequirementResultV1,
  type CoverLetterProductFailureV1, type CoverLetterProductRequestV1, type CoverLetterProductCandidateV1,
  type CoverLetterRequirementContextV1,
} from './coverLetterProduct.ts';

type MaterialRevisionV2 = Readonly<{ schemaVersion: 2; revisionDialect: 'AGGREGATE_V1'; statusProjectionRevision: string }>;
export type CoverLetterProductFailureV2 = Omit<CoverLetterProductFailureV1, 'schemaVersion'> & Readonly<{ schemaVersion: 2 }>;
export type CoverLetterRequirementRequestV2 = Readonly<{ schemaVersion: 2; revisionDialect: 'AGGREGATE_V1'; jobId: string }>;
export type CoverLetterProductRequestV2 = CoverLetterProductRequestV1 & MaterialRevisionV2;
export type CoverLetterRequirementContextV2 = Omit<CoverLetterRequirementContextV1, 'schemaVersion'> & MaterialRevisionV2;
export type CoverLetterProductCandidateV2 = Omit<CoverLetterProductCandidateV1, 'schemaVersion'> & MaterialRevisionV2;
export type CoverLetterRequirementResultV2 = CoverLetterProductFailureV2 | Readonly<{ schemaVersion: 2; ok: true; context: CoverLetterRequirementContextV2 }>;
export type CoverLetterProductResultV2 = CoverLetterProductFailureV2 | Readonly<{ schemaVersion: 2; ok: true; candidate: CoverLetterProductCandidateV2 }>;

export function parseCoverLetterRequirementRequestV2(value: unknown): CoverLetterRequirementRequestV2 | null {
  if (!record(value) || value.schemaVersion !== 2 || value.revisionDialect !== 'AGGREGATE_V1') return null;
  const { schemaVersion: _version, revisionDialect: _dialect, ...legacy } = value;
  return parseCoverLetterRequirementRequestV1(legacy) ? value as CoverLetterRequirementRequestV2 : null;
}
export function parseCoverLetterProductRequestV2(value: unknown): CoverLetterProductRequestV2 | null {
  const projected = projectBinding(value, false);
  return projected && parseCoverLetterProductRequestV1(projected) ? value as CoverLetterProductRequestV2 : null;
}
export function parseCoverLetterRequirementResultV2(value: unknown): CoverLetterRequirementResultV2 | null {
  if (!record(value) || value.schemaVersion !== 2) return null;
  if (value.ok === false) return parseCoverLetterRequirementResultV1({ ...value, schemaVersion: 1 }) ? value as CoverLetterRequirementResultV2 : null;
  const projected = projectBinding(value.context, true);
  return projected && parseCoverLetterRequirementResultV1({ ...value, schemaVersion: 1, context: projected })
    ? value as CoverLetterRequirementResultV2 : null;
}
export function parseCoverLetterProductResultV2(value: unknown): CoverLetterProductResultV2 | null {
  if (!record(value) || value.schemaVersion !== 2) return null;
  if (value.ok === false) return parseCoverLetterProductResultV1({ ...value, schemaVersion: 1 }) ? value as CoverLetterProductResultV2 : null;
  const projected = projectBinding(value.candidate, true);
  return projected && parseCoverLetterProductResultV1({ ...value, schemaVersion: 1, candidate: projected })
    ? value as CoverLetterProductResultV2 : null;
}
function projectBinding(value: unknown, response: boolean): Record<string, unknown> | null {
  if (!record(value) || value.schemaVersion !== 2 || value.revisionDialect !== 'AGGREGATE_V1' ||
    !revision(value.canonicalJobRevision, true) || !revision(value.statusProjectionRevision, false)) return null;
  const { schemaVersion: _version, revisionDialect: _dialect, statusProjectionRevision: _status, ...legacy } = value;
  return response ? { ...legacy, schemaVersion: 1 } : legacy;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function revision(value: unknown, positive: boolean): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9_223_372_036_854_775_807n && (!positive || BigInt(value) > 0n);
}
