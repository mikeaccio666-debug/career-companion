/**
 * UA-5 connected-development Profile payload plane.
 *
 * This is deliberately a sibling of the value-free UA-5 composition wire, not
 * an expansion of it. `composition.constraints.rawValues = NEVER_TRANSMITTED`
 * applies only to the nested `composition` object. The sibling `payloads`
 * array is an explicit Data-L1 wire: it may exist only in authenticated,
 * owner-bound connected development and must remain request/run-local memory.
 */

import {
  parseSha256Digest,
  type DecimalString,
  type Sha256Digest,
} from '../common.ts';
import type { ApplicationProfileFieldKey } from '../executionIntent.ts';
import { PILOT_UA1_MAX_CONTROLS } from './pilotUa1Discovery.ts';
import type { PilotUa2CanonicalField, PilotUa2Classification } from './pilotUa2Classification.ts';
import {
  PILOT_UA5_FAILURE_CODES,
  parsePilotUa5CompositionResponse,
  parsePilotUa5CompositionRequest,
  type PilotUa5CompositionRequest,
  type PilotUa5CompositionResponse,
  type PilotUa5FailureCode,
} from './pilotUa5Certification.ts';

export const PILOT_UA5_PROFILE_PAYLOAD_SCHEMA_VERSION = 1 as const;

export const PILOT_UA5_PROFILE_PAYLOAD_FAILURE_CODES = Object.freeze([
  ...PILOT_UA5_FAILURE_CODES,
  'PILOT_UA5_PROFILE_UNAVAILABLE',
] as const);
export type PilotUa5ProfilePayloadFailureCode =
  (typeof PILOT_UA5_PROFILE_PAYLOAD_FAILURE_CODES)[number];

/** Confirmed scalar fields carried by the connected-dev Profile value plane. */
export const PILOT_UA5_PROFILE_PAYLOAD_FIELD_BY_CANONICAL = Object.freeze({
  NAME_FULL: 'fullName',
  NAME_GIVEN: 'firstName',
  NAME_FAMILY: 'lastName',
  EMAIL: 'email',
  PHONE: 'phone',
  CITY: 'city',
  LINKEDIN_URL: 'linkedinUrl',
  GITHUB_URL: 'githubUrl',
  PORTFOLIO_URL: 'portfolioUrl',
} as const satisfies Partial<Record<PilotUa2CanonicalField, ApplicationProfileFieldKey>>);

export type PilotUa5ProfilePayloadFieldKey =
  (typeof PILOT_UA5_PROFILE_PAYLOAD_FIELD_BY_CANONICAL)[keyof typeof PILOT_UA5_PROFILE_PAYLOAD_FIELD_BY_CANONICAL];

export const PILOT_UA5_PROFILE_PAYLOAD_CONSTRAINTS = Object.freeze({
  compositionValueBoundary: 'VALUE_FREE_SUBOBJECT_ONLY' as const,
  payloadWire: 'DEV_ONLY_DATA_L1' as const,
  dataLifetime: 'EPHEMERAL_MEMORY_ONLY' as const,
  panelExposure: 'FORBIDDEN' as const,
  persistence: 'FORBIDDEN' as const,
  logging: 'FORBIDDEN' as const,
});

export type PilotUa5ProfilePayloadRequest = PilotUa5CompositionRequest;

export type PilotUa5ProfileBinding = Readonly<{
  fieldSchemaVersion: 1;
  fieldKeys: readonly PilotUa5ProfilePayloadFieldKey[];
  revision: DecimalString;
  deletionEpoch: DecimalString;
  snapshotDigest: Sha256Digest;
}>;

export type PilotUa5ProfilePayloadEntry = Readonly<{
  questionId: string;
  payloadRef: string;
  /** Must equal the exact UA-4 authorization for `questionId`. */
  answerDigest: string;
  /** Data-L1. Never log, persist, telemetry-project, or expose in the Panel. */
  value: string;
}>;

export type PilotUa5CompositionSuccess = Extract<PilotUa5CompositionResponse, { ok: true }>;

export type PilotUa5ProfilePayloadResponse =
  | Readonly<{
      ok: true;
      schemaVersion: typeof PILOT_UA5_PROFILE_PAYLOAD_SCHEMA_VERSION;
      /** This subobject remains the existing value-free UA-5 wire unchanged. */
      composition: PilotUa5CompositionSuccess;
      profileBinding: PilotUa5ProfileBinding;
      /** Explicit connected-dev Data-L1 sibling wire; request/run-local only. */
      payloads: readonly PilotUa5ProfilePayloadEntry[];
      constraints: typeof PILOT_UA5_PROFILE_PAYLOAD_CONSTRAINTS;
    }>
  | Readonly<{
      ok: false;
      schemaVersion: typeof PILOT_UA5_PROFILE_PAYLOAD_SCHEMA_VERSION;
      code: PilotUa5ProfilePayloadFailureCode;
    }>;

export type PilotUa5ProfilePayloadParseResult =
  | Readonly<{ ok: true; value: PilotUa5ProfilePayloadResponse }>
  | Readonly<{ ok: false; code: 'PILOT_UA5_PROFILE_PAYLOAD_INVALID' }>;

type DataValues = Readonly<Record<string, unknown>>;
const RAW_SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PROFILE_FIELDS = Object.keys(PILOT_UA5_PROFILE_PAYLOAD_FIELD_BY_CANONICAL).length;
const MAX_SAFE_SCALAR_LENGTH = 320;
const FAILURE_CODES = new Set<string>(PILOT_UA5_PROFILE_PAYLOAD_FAILURE_CODES);
const SAFE_FIELD_KEYS = new Set<string>(
  Object.values(PILOT_UA5_PROFILE_PAYLOAD_FIELD_BY_CANONICAL),
);
const SAFE_SCALAR_CONTROL_KINDS = new Set<string>([
  'TEXT', 'TEXTAREA', 'NATIVE_SELECT', 'RADIO_GROUP', 'COMBOBOX',
]);

function invalid(): Extract<PilotUa5ProfilePayloadParseResult, { ok: false }> {
  return Object.freeze({ ok: false, code: 'PILOT_UA5_PROFILE_PAYLOAD_INVALID' });
}

function exactDataValues(value: unknown, keys: readonly string[]): DataValues | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
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

function exactArray(value: unknown, max: number): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key !== 'string')) {
    return null;
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function canonicalDecimal(value: unknown): value is DecimalString {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false;
  return BigInt(value) <= 9_223_372_036_854_775_807n;
}

function parseBinding(value: unknown): PilotUa5ProfileBinding | null {
  const fields = exactDataValues(value, [
    'fieldSchemaVersion', 'fieldKeys', 'revision', 'deletionEpoch', 'snapshotDigest',
  ]);
  if (
    !fields || fields.fieldSchemaVersion !== 1 ||
    !canonicalDecimal(fields.revision) || !canonicalDecimal(fields.deletionEpoch)
  ) return null;
  const snapshotDigest = parseSha256Digest(fields.snapshotDigest);
  const source = exactArray(fields.fieldKeys, MAX_PROFILE_FIELDS);
  if (!snapshotDigest || !source || source.length === 0) return null;
  const keys: PilotUa5ProfilePayloadFieldKey[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    if (typeof item !== 'string' || !SAFE_FIELD_KEYS.has(item) || seen.has(item)) return null;
    seen.add(item);
    keys.push(item as PilotUa5ProfilePayloadFieldKey);
  }
  if (keys.some((key, index) => key !== [...keys].sort()[index])) return null;
  return Object.freeze({
    fieldSchemaVersion: 1,
    fieldKeys: Object.freeze(keys),
    revision: fields.revision,
    deletionEpoch: fields.deletionEpoch,
    snapshotDigest,
  });
}

/** Snapshot the existing value-free binding for an in-process currentness fence. */
export function parsePilotUa5ProfileBinding(value: unknown): PilotUa5ProfileBinding | null {
  try { return parseBinding(value); } catch { return null; }
}

/** Shared eligibility after wire validation; values never establish authority. */
export function pilotUa5ProfilePayloadFieldForAuthorization(
  candidateClassifications: readonly PilotUa2Classification[],
  authorization: PilotUa5CompositionSuccess['authority']['questionAuthorizations'][number],
): PilotUa5ProfilePayloadFieldKey | null {
  const byIdentity = new Map(
    candidateClassifications.map((item) => [item.identityDigest, item]),
  );
  const classifications = authorization.identityDigests.map((identity) => byIdentity.get(identity));
  const first = classifications[0];
  if (
    authorization.answerAuthority !== 'PROFILE_CONFIRMED' ||
    !SAFE_SCALAR_CONTROL_KINDS.has(authorization.controlKind) ||
    first === undefined || first.kind !== 'CANONICAL_FIELD' || first.canonicalField === null
  ) return null;
  const fieldKey = PILOT_UA5_PROFILE_PAYLOAD_FIELD_BY_CANONICAL[
    first.canonicalField as keyof typeof PILOT_UA5_PROFILE_PAYLOAD_FIELD_BY_CANONICAL
  ];
  if (fieldKey === undefined) return null;
  return classifications.every(
    (item) => item !== undefined &&
      item.kind === 'CANONICAL_FIELD' &&
      item.canonicalField === first.canonicalField,
  ) ? fieldKey : null;
}

/** Hostile-boundary parser for the only response allowed to carry UA-5 values. */
export function parsePilotUa5ProfilePayloadResponse(
  value: unknown,
): PilotUa5ProfilePayloadParseResult {
  try {
    const failed = exactDataValues(value, ['ok', 'schemaVersion', 'code']);
    if (failed) {
      if (
        failed.ok !== false || failed.schemaVersion !== 1 ||
        typeof failed.code !== 'string' || !FAILURE_CODES.has(failed.code)
      ) return invalid();
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          ok: false,
          schemaVersion: 1,
          code: failed.code as PilotUa5ProfilePayloadFailureCode,
        }),
      });
    }

    const fields = exactDataValues(value, [
      'ok', 'schemaVersion', 'composition', 'profileBinding', 'payloads', 'constraints',
    ]);
    if (!fields || fields.ok !== true || fields.schemaVersion !== 1) return invalid();
    const parsedComposition = parsePilotUa5CompositionResponse(fields.composition);
    if (!parsedComposition.ok || !parsedComposition.value.ok) return invalid();
    const composition = parsedComposition.value;
    const binding = parseBinding(fields.profileBinding);
    const payloadSource = exactArray(fields.payloads, PILOT_UA1_MAX_CONTROLS);
    const constraints = exactDataValues(fields.constraints, [
      'compositionValueBoundary', 'payloadWire', 'dataLifetime',
      'panelExposure', 'persistence', 'logging',
    ]);
    if (
      !binding || !payloadSource || payloadSource.length === 0 || !constraints ||
      constraints.compositionValueBoundary !== 'VALUE_FREE_SUBOBJECT_ONLY' ||
      constraints.payloadWire !== 'DEV_ONLY_DATA_L1' ||
      constraints.dataLifetime !== 'EPHEMERAL_MEMORY_ONLY' ||
      constraints.panelExposure !== 'FORBIDDEN' ||
      constraints.persistence !== 'FORBIDDEN' ||
      constraints.logging !== 'FORBIDDEN'
    ) return invalid();

    const eligible = new Map<string, {
      readonly answerDigest: string;
      readonly fieldKey: PilotUa5ProfilePayloadFieldKey;
    }>();
    for (const authorization of composition.authority.questionAuthorizations) {
      const fieldKey = pilotUa5ProfilePayloadFieldForAuthorization(composition.candidateRule.classifications, authorization);
      if (fieldKey !== null) {
        eligible.set(authorization.questionId, Object.freeze({
          answerDigest: authorization.answerDigest,
          fieldKey,
        }));
      }
    }
    if (eligible.size !== payloadSource.length || eligible.size === 0) return invalid();

    const payloads: PilotUa5ProfilePayloadEntry[] = [];
    const seenQuestionIds = new Set<string>();
    const seenPayloadRefs = new Set<string>();
    const emittedFieldKeys = new Set<PilotUa5ProfilePayloadFieldKey>();
    for (const item of payloadSource) {
      const payload = exactDataValues(item, [
        'questionId', 'payloadRef', 'answerDigest', 'value',
      ]);
      if (
        !payload || typeof payload.questionId !== 'string' || !SAFE_ID.test(payload.questionId) ||
        typeof payload.payloadRef !== 'string' || !SAFE_ID.test(payload.payloadRef) ||
        typeof payload.answerDigest !== 'string' || !RAW_SHA256.test(payload.answerDigest) ||
        typeof payload.value !== 'string' || payload.value.length === 0 ||
        payload.value.length > MAX_SAFE_SCALAR_LENGTH ||
        seenQuestionIds.has(payload.questionId) || seenPayloadRefs.has(payload.payloadRef)
      ) return invalid();
      const expected = eligible.get(payload.questionId);
      if (!expected || expected.answerDigest !== payload.answerDigest) return invalid();
      seenQuestionIds.add(payload.questionId);
      seenPayloadRefs.add(payload.payloadRef);
      emittedFieldKeys.add(expected.fieldKey);
      payloads.push(Object.freeze({
        questionId: payload.questionId,
        payloadRef: payload.payloadRef,
        answerDigest: payload.answerDigest,
        value: payload.value,
      }));
    }
    if (seenQuestionIds.size !== eligible.size) return invalid();
    const expectedFieldKeys = [...emittedFieldKeys].sort();
    if (
      expectedFieldKeys.length !== binding.fieldKeys.length ||
      expectedFieldKeys.some((key, index) => key !== binding.fieldKeys[index])
    ) return invalid();

    return Object.freeze({
      ok: true,
      value: Object.freeze({
        ok: true,
        schemaVersion: 1,
        composition,
        profileBinding: binding,
        payloads: Object.freeze(payloads),
        constraints: PILOT_UA5_PROFILE_PAYLOAD_CONSTRAINTS,
      }),
    });
  } catch {
    return invalid();
  }
}

/** Preserve the composition's stable failure code in the outer value-plane envelope. */
export function pilotUa5ProfilePayloadFailure(
  code: PilotUa5FailureCode | 'PILOT_UA5_PROFILE_UNAVAILABLE',
): Extract<PilotUa5ProfilePayloadResponse, { ok: false }> {
  return Object.freeze({ ok: false, schemaVersion: 1, code });
}

/** P1 HTTP outer version; the private content payload keeps its own version. */
export type PilotUa5BoundProfilePayloadRequest = Readonly<{
  schemaVersion: 2; runRequestId: string; request: PilotUa5ProfilePayloadRequest;
}>;
export type PilotUa5BoundProfilePayloadResponse =
  | Readonly<{ ok: true; schemaVersion: 2; payload: Extract<PilotUa5ProfilePayloadResponse, { ok: true }>; originalBindingSeal: string }>
  | Readonly<{ ok: false; schemaVersion: 2; code: PilotUa5ProfilePayloadFailureCode }>;
export const PILOT_UA5_MAX_RESPONSE_BYTES = 512 * 1024;
/** Encoded ASCII seal cap; final JSON envelopes must also satisfy HTTP byte limits. */
export function isPilotUa5OriginalBindingSeal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PILOT_UA5_MAX_RESPONSE_BYTES &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}
export function parsePilotUa5BoundProfilePayloadRequest(value: unknown):
  | Readonly<{ ok: true; value: PilotUa5BoundProfilePayloadRequest }>
  | Readonly<{ ok: false; code: 'PILOT_UA5_PROFILE_PAYLOAD_INVALID' }> {
  try {
    const fields = exactDataValues(value, ['schemaVersion', 'runRequestId', 'request']);
    if (!fields || fields.schemaVersion !== 2 || typeof fields.runRequestId !== 'string' ||
        !/^[a-f0-9]{32}$/.test(fields.runRequestId)) return invalid();
    const request = parsePilotUa5CompositionRequest(fields.request);
    return request.ok ? Object.freeze({ ok: true, value: Object.freeze({
      schemaVersion: 2, runRequestId: fields.runRequestId, request: request.value,
    }) }) : invalid();
  } catch { return invalid(); }
}
export function parsePilotUa5BoundProfilePayloadResponse(value: unknown):
  | Readonly<{ ok: true; value: PilotUa5BoundProfilePayloadResponse }>
  | Readonly<{ ok: false; code: 'PILOT_UA5_PROFILE_PAYLOAD_INVALID' }> {
  try {
    const failed = exactDataValues(value, ['ok', 'schemaVersion', 'code']);
    if (failed) {
      if (failed.schemaVersion !== 2 || failed.ok !== false || typeof failed.code !== 'string' || !FAILURE_CODES.has(failed.code)) return invalid();
      return Object.freeze({ ok: true, value: Object.freeze({ ok: false, schemaVersion: 2, code: failed.code as PilotUa5ProfilePayloadFailureCode }) });
    }
    const fields = exactDataValues(value, ['ok', 'schemaVersion', 'payload', 'originalBindingSeal']);
    if (!fields || fields.ok !== true || fields.schemaVersion !== 2 || !isPilotUa5OriginalBindingSeal(fields.originalBindingSeal)) return invalid();
    const payload = parsePilotUa5ProfilePayloadResponse(fields.payload);
    if (!payload.ok || !payload.value.ok) return invalid();
    const result = Object.freeze({ ok: true, schemaVersion: 2, payload: payload.value, originalBindingSeal: fields.originalBindingSeal } as const);
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > PILOT_UA5_MAX_RESPONSE_BYTES) return invalid();
    return Object.freeze({ ok: true, value: result });
  } catch { return invalid(); }
}
