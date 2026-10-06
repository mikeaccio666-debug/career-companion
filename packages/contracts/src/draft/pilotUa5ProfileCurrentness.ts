import { parseUuid, type Uuid } from '../common.ts';
import type { PilotUa1PageBinding } from './pilotUa1Discovery.ts';
import {
  parsePilotUa4PageBinding, parsePilotUa4QuestionAuthorization, parsePilotUa4WriteAuthorityRequest,
  type PilotUa4QuestionAuthorization, type PilotUa4WriteAuthorityRequest,
} from './pilotUa4WriteAuthority.ts';
import {
  isPilotUa5OriginalBindingSeal, parsePilotUa5ProfileBinding, type PilotUa5ProfileBinding,
} from './pilotUa5ProfilePayloads.ts';

export const PILOT_UA5_ORIGINAL_BINDING_PURPOSE = 'PILOT_UA5_ORIGINAL_PROFILE_BINDING' as const;
export const PILOT_UA5_ORIGINAL_BINDING_TYPE = 'edaix-ua5-original-binding+jws' as const;
export type PilotUa5OriginalBinding = Readonly<{
  schemaVersion: 1; purpose: typeof PILOT_UA5_ORIGINAL_BINDING_PURPOSE;
  runRequestId: string; owner: Readonly<{ sub: Uuid; sid: Uuid }>;
  issuedAtMs: number; expiresAtMs: number; profileBinding: PilotUa5ProfileBinding;
  request: PilotUa4WriteAuthorityRequest;
  questionAuthorizations: readonly PilotUa4QuestionAuthorization[];
}>;
export type PilotUa5ProfileCheck = Readonly<{
  runRequestId: string; ordinal: number; binding: PilotUa1PageBinding;
  profileBinding: PilotUa5ProfileBinding; questionId: string; answerDigest: string;
}>;
export type PilotUa5ProfileCurrentnessRequest = Readonly<{
  schemaVersion: 1; check: PilotUa5ProfileCheck; originalBindingSeal: string;
}>;
export type PilotUa5ProfileCurrentnessResponse =
  | Readonly<{ ok: true; schemaVersion: 1; kind: 'MATCH_AT_READ'; check: PilotUa5ProfileCheck }>
  | Readonly<{ ok: false; schemaVersion: 1; code: 'PILOT_UA5_PROFILE_UNAVAILABLE' }>;
const INVALID = Object.freeze({ ok: false, code: 'PILOT_UA5_PROFILE_PAYLOAD_INVALID' } as const);
export const PILOT_UA5_PROFILE_CURRENTNESS_UNAVAILABLE = Object.freeze({
  ok: false, schemaVersion: 1, code: 'PILOT_UA5_PROFILE_UNAVAILABLE',
} as const);
type Parsed<T> = Readonly<{ ok: true; value: T }> | typeof INVALID;
const runId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Exact own data only: never execute caller accessors or repair sparse arrays. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !('value' in field) || !field.enumerable) return null;
    result[key] = field.value;
  }
  return result;
}

export function parsePilotUa5ProfileCheck(value: unknown): PilotUa5ProfileCheck | null {
  try {
    const f = record(value, ['runRequestId', 'ordinal', 'binding', 'profileBinding', 'questionId', 'answerDigest']);
    if (!f || !runId(f.runRequestId) || !Number.isSafeInteger(f.ordinal) || (f.ordinal as number) < 1 || (f.ordinal as number) > 500 ||
        typeof f.questionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(f.questionId) ||
        typeof f.answerDigest !== 'string' || !/^[a-f0-9]{64}$/.test(f.answerDigest)) return null;
    const binding = parsePilotUa4PageBinding(f.binding);
    const profileBinding = parsePilotUa5ProfileBinding(f.profileBinding);
    return binding && profileBinding ? Object.freeze({ runRequestId: f.runRequestId, ordinal: f.ordinal as number,
      binding, profileBinding, questionId: f.questionId, answerDigest: f.answerDigest }) : null;
  } catch { return null; }
}
export function samePilotUa5ProfileCheck(a: PilotUa5ProfileCheck, b: PilotUa5ProfileCheck): boolean {
  // Parser-built keys and arrays are canonical; no caller JSON ordering is trusted.
  const left = parsePilotUa5ProfileCheck(a), right = parsePilotUa5ProfileCheck(b);
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}
export function parsePilotUa5ProfileCurrentnessRequest(value: unknown): Parsed<PilotUa5ProfileCurrentnessRequest> {
  try {
    const f = record(value, ['schemaVersion', 'check', 'originalBindingSeal']);
    if (!f || f.schemaVersion !== 1 || !isPilotUa5OriginalBindingSeal(f.originalBindingSeal)) return INVALID;
    const check = parsePilotUa5ProfileCheck(f.check);
    return check ? Object.freeze({ ok: true, value: Object.freeze({ schemaVersion: 1, check, originalBindingSeal: f.originalBindingSeal }) }) : INVALID;
  } catch { return INVALID; }
}
export function parsePilotUa5ProfileCurrentnessResponse(value: unknown): Parsed<PilotUa5ProfileCurrentnessResponse> {
  try {
    const failed = record(value, ['ok', 'schemaVersion', 'code']);
    if (failed) return failed.ok === false && failed.schemaVersion === 1 && failed.code === 'PILOT_UA5_PROFILE_UNAVAILABLE'
      ? Object.freeze({ ok: true, value: PILOT_UA5_PROFILE_CURRENTNESS_UNAVAILABLE }) : INVALID;
    const f = record(value, ['ok', 'schemaVersion', 'kind', 'check']);
    if (!f || f.ok !== true || f.schemaVersion !== 1 || f.kind !== 'MATCH_AT_READ') return INVALID;
    const check = parsePilotUa5ProfileCheck(f.check);
    return check ? Object.freeze({ ok: true, value: Object.freeze({ ok: true, schemaVersion: 1, kind: 'MATCH_AT_READ', check }) }) : INVALID;
  } catch { return INVALID; }
}

/** Value-free original provenance. A valid shape alone is never authenticity. */
export function parsePilotUa5OriginalBinding(value: unknown): PilotUa5OriginalBinding | null {
  try {
    const f = record(value, ['schemaVersion', 'purpose', 'runRequestId', 'owner', 'issuedAtMs', 'expiresAtMs', 'profileBinding', 'request', 'questionAuthorizations']);
    if (!f || f.schemaVersion !== 1 || f.purpose !== PILOT_UA5_ORIGINAL_BINDING_PURPOSE || !runId(f.runRequestId) ||
        !timestamp(f.issuedAtMs) || !timestamp(f.expiresAtMs) || f.expiresAtMs <= f.issuedAtMs) return null;
    const owner = record(f.owner, ['sub', 'sid']);
    const sub = parseUuid(owner?.sub), sid = parseUuid(owner?.sid);
    const profileBinding = parsePilotUa5ProfileBinding(f.profileBinding);
    const request = parsePilotUa4WriteAuthorityRequest(f.request);
    if (!sub || !sid || !profileBinding || !request.ok || f.expiresAtMs > request.value.candidateRule.expiresAtMs ||
        f.issuedAtMs < request.value.candidateRule.issuedAtMs) return null;
    const source = f.questionAuthorizations;
    if (!Array.isArray(source)) return null;
    const length = Object.getOwnPropertyDescriptor(source, 'length')?.value;
    if (!Number.isInteger(length) || length < 1 || length > 500 || Reflect.ownKeys(source).length !== length + 1) return null;
    const authorizations: PilotUa4QuestionAuthorization[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(source, String(i));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      const auth = parsePilotUa4QuestionAuthorization(descriptor.value);
      const question = request.value.questions.find((q) => q.questionId === auth?.questionId);
      if (!auth || !question || seen.has(auth.questionId) || question.controlKind !== auth.controlKind || question.required !== auth.required ||
          JSON.stringify(question.identityDigests) !== JSON.stringify(auth.identityDigests)) return null;
      seen.add(auth.questionId); authorizations.push(auth);
    }
    return Object.freeze({ schemaVersion: 1, purpose: PILOT_UA5_ORIGINAL_BINDING_PURPOSE, runRequestId: f.runRequestId,
      owner: Object.freeze({ sub, sid }), issuedAtMs: f.issuedAtMs, expiresAtMs: f.expiresAtMs, profileBinding,
      request: request.value, questionAuthorizations: Object.freeze(authorizations) });
  } catch { return null; }
}
