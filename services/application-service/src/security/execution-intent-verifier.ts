/**
 * Adapted from argoland 013d5128bd474f98b78df8c9878e1321712b134b.
 * Pure migration seam; importing this file grants no execution authority.
 */
import { createPublicKey, verify as verifyBytes, type KeyObject } from 'node:crypto';
import {
  SORTED_APPLICATION_PROFILE_CANONICAL_FIELD_KEYS,
  type ApplicationProfileCanonicalFieldKey,
} from './application-profile-fields.contract.ts';
import { isExternalApiOrigin } from './external-api-origin.ts';
import { parseExecutionIntentPublicKeySet } from './execution-intent-jwks.config.ts';
import {
  assertCanonicalAllowedActionsV1,
  assertCanonicalFieldKeysV1,
  EXECUTION_INTENT_ALLOWED_ACTIONS,
  EXECUTION_INTENT_ATS_PROVIDERS,
  EXECUTION_INTENT_SOURCE_PLATFORMS,
  type ExecutionIntentAllowedAction,
  type ExecutionIntentAtsProvider,
  type ExecutionIntentSourcePlatform,
} from './execution-intent-digests.ts';

const MAX_COMPACT_JWS_LENGTH = 8192;
const MAX_INTENT_TTL_SECONDS = 120;
const NOT_BEFORE_CLOCK_SKEW_SECONDS = 30;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const PROTECTED_TYPE = 'edaix-execution-intent+jwt';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const JTI_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CANONICAL_NON_NEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;

const HEADER_KEYS = Object.freeze(['alg', 'kid', 'typ'] as const);
const PAYLOAD_KEYS = Object.freeze([
  'ver',
  'iss',
  'aud',
  'sub',
  'jti',
  'iat',
  'nbf',
  'exp',
  'missionId',
  'missionRevision',
  'missionStepId',
  'stepAttempt',
  'intentVersion',
  'extensionInstallId',
  'target',
  'fieldKeys',
  'fieldSchemaVersion',
  'automationLevel',
  'allowedActions',
  'planDigest',
  'approvalMessageId',
  'profile',
  'resume',
  'policyVersion',
  'killSwitchVersion',
  'consentVersion',
] as const);
const TARGET_KEYS = Object.freeze([
  'jobId',
  'sourcePlatform',
  'atsProvider',
  'canonicalOrigin',
  'pathRuleId',
  'postingFingerprint',
] as const);
const PROFILE_KEYS = Object.freeze(['revision', 'deletionEpoch', 'snapshotDigest'] as const);
const RESUME_KEYS = Object.freeze([
  'versionId',
  'contentHash',
  'contentRevision',
  'libraryRevision',
] as const);
const AUTOMATION_LEVELS = new Set<string>([
  'L0_PREVIEW_ONLY',
  'L1_FILL_STOP_BEFORE_SUBMIT',
  'L2_CONFIRM_EACH_SUBMISSION',
  'L3_MANAGED_BATCH',
]);
const SOURCE_PLATFORMS = new Set<string>(EXECUTION_INTENT_SOURCE_PLATFORMS);
const ATS_PROVIDERS = new Set<string>(EXECUTION_INTENT_ATS_PROVIDERS);
const ALLOWED_ACTIONS = new Set<string>(EXECUTION_INTENT_ALLOWED_ACTIONS);

export type ExecutionIntentAutomationLevel =
  | 'L0_PREVIEW_ONLY'
  | 'L1_FILL_STOP_BEFORE_SUBMIT'
  | 'L2_CONFIRM_EACH_SUBMISSION'
  | 'L3_MANAGED_BATCH';

export type ExecutionIntentPayloadV1 = Readonly<{
  ver: 1;
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  missionId: string;
  missionRevision: string;
  missionStepId: string;
  stepAttempt: number;
  intentVersion: number;
  extensionInstallId: string;
  target: Readonly<{
    jobId: string;
    sourcePlatform: ExecutionIntentSourcePlatform;
    atsProvider: ExecutionIntentAtsProvider;
    canonicalOrigin: string;
    pathRuleId: string;
    postingFingerprint: string;
  }>;
  fieldKeys: readonly ApplicationProfileCanonicalFieldKey[];
  fieldSchemaVersion: 1;
  automationLevel: ExecutionIntentAutomationLevel;
  allowedActions: readonly ExecutionIntentAllowedAction[];
  planDigest: string;
  approvalMessageId: string;
  profile: Readonly<{
    revision: string;
    deletionEpoch: string;
    snapshotDigest: string;
  }>;
  resume: Readonly<{
    versionId: string;
    contentHash: string;
    contentRevision: string;
    libraryRevision: string;
  }>;
  policyVersion: string;
  killSwitchVersion: string;
  consentVersion: string;
}>;

export type ExecutionIntentVerificationContext = Readonly<{
  expectedIssuer: string;
  expectedAudience: string;
  expectedSubject: string;
  now: Date;
}>;

export type VerifiedExecutionIntentV1 = Readonly<{
  payload: ExecutionIntentPayloadV1;
  kid: string;
}>;

export type ExecutionIntentVerificationFailureReason =
  | 'KEYSET_UNAVAILABLE'
  | 'MALFORMED'
  | 'HEADER_INVALID'
  | 'KID_UNKNOWN'
  | 'SIGNATURE_INVALID'
  | 'CLAIMS_INVALID'
  | 'ISSUER_MISMATCH'
  | 'AUDIENCE_MISMATCH'
  | 'SUBJECT_MISMATCH'
  | 'NOT_YET_VALID'
  | 'EXPIRED';

export class ExecutionIntentVerificationError extends Error {
  readonly reason: ExecutionIntentVerificationFailureReason;

  constructor(reason: ExecutionIntentVerificationFailureReason) {
    super(`EXECUTION_INTENT_VERIFICATION_FAILED:${reason}`);
    this.name = 'ExecutionIntentVerificationError';
    this.reason = reason;
  }
}

export type ExecutionIntentVerifierConfigurationInput = Readonly<{
  publishedPublicKeys?: string | null;
}>;

export type ParsedExecutionIntentVerifierConfiguration = Readonly<{
  keys: readonly Readonly<{ kid: string; key: KeyObject }>[];
}> | null;

/**
 * Builds the verifier from the exact same validated public material published
 * by JWKS. An empty deployment configuration deliberately disables claim;
 * malformed non-empty material remains a startup error in the shared parser.
 */
export function parseExecutionIntentVerifierConfiguration(
  input: ExecutionIntentVerifierConfigurationInput,
): ParsedExecutionIntentVerifierConfiguration {
  const configuredKeys = input.publishedPublicKeys;
  if (configuredKeys === undefined || configuredKeys === null || configuredKeys === '') return null;

  const parsed = parseExecutionIntentPublicKeySet(configuredKeys);
  const keys = parsed.jwks.keys.map((jwk) =>
    Object.freeze({
      kid: jwk.kid,
      key: createPublicKey({ key: jwk, format: 'jwk' }),
    }),
  );
  return Object.freeze({ keys: Object.freeze(keys) });
}

/** Only the shared, verified V1 subset is active in this extraction. */
export type ExecutionIntentPayload = ExecutionIntentPayloadV1;

/** Strict V1 verifier. V2/V3 fail closed until contracts and authority are migrated together. */
export class ExecutionIntentVerifier {
  constructor(private readonly configuration: ParsedExecutionIntentVerifierConfiguration) {}

  verify(
    compactJws: string,
    context: ExecutionIntentVerificationContext,
  ): ExecutionIntentPayload {
    return this.verifyDetailed(compactJws, context).payload;
  }

  verifyDetailed(
    compactJws: string,
    context: ExecutionIntentVerificationContext,
  ): Readonly<{ payload: ExecutionIntentPayload; kid: string }> {
    if (!this.configuration) fail('KEYSET_UNAVAILABLE');
    if (
      typeof compactJws !== 'string' ||
      compactJws.length === 0 ||
      compactJws.length > MAX_COMPACT_JWS_LENGTH
    ) {
      fail('MALFORMED');
    }

    const segments = compactJws.split('.');
    if (segments.length !== 3) fail('MALFORMED');
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    const header = parseCanonicalJsonObject(encodedHeader);

    if (
      !hasExactKeys(header, HEADER_KEYS) ||
      header.alg !== 'ES256' ||
      header.typ !== PROTECTED_TYPE ||
      typeof header.kid !== 'string' ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(header.kid)
    ) {
      fail('HEADER_INVALID');
    }

    const configuredKey = this.configuration.keys.find((candidate) => candidate.kid === header.kid);
    if (!configuredKey) fail('KID_UNKNOWN');
    const signature = decodeCanonicalBase64Url(encodedSignature);
    if (signature.length !== 64) fail('MALFORMED');

    let signatureValid = false;
    try {
      signatureValid = verifyBytes(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
        { key: configuredKey.key, dsaEncoding: 'ieee-p1363' },
        signature,
      );
    } catch {
      fail('SIGNATURE_INVALID');
    }
    if (!signatureValid) fail('SIGNATURE_INVALID');

    const untrustedPayload = parseCanonicalJsonObject(encodedPayload);
    const payload = validatePayloadV1(untrustedPayload);
    validateContextAndTime(payload, context);
    return Object.freeze({ payload: deepFreeze(payload), kid: header.kid });
  }
}

function validatePayloadV1(value: Record<string, unknown>): ExecutionIntentPayloadV1 {
  if (!hasExactKeys(value, PAYLOAD_KEYS)) fail('CLAIMS_INVALID');

  if (
    value.ver !== 1 ||
    !isBoundedString(value.iss, 255) ||
    !isExternalApiOrigin(value.iss) ||
    !isBoundedString(value.aud, 128) ||
    !isUuid(value.sub) ||
    !isCanonicalJti(value.jti) ||
    !isNumericDate(value.iat) ||
    !isNumericDate(value.nbf) ||
    !isNumericDate(value.exp) ||
    !isUuid(value.missionId) ||
    !isCanonicalBigintString(value.missionRevision, false) ||
    !isUuid(value.missionStepId) ||
    !isPositiveInt(value.stepAttempt) ||
    !isPositiveInt(value.intentVersion) ||
    !isUuid(value.extensionInstallId) ||
    value.fieldSchemaVersion !== 1 ||
    !isAutomationLevel(value.automationLevel) ||
    !isSha256Digest(value.planDigest) ||
    !isUuid(value.approvalMessageId) ||
    !isBoundedSafeToken(value.policyVersion, 64) ||
    !isBoundedSafeToken(value.killSwitchVersion, 64) ||
    !isBoundedSafeToken(value.consentVersion, 64)
  ) {
    fail('CLAIMS_INVALID');
  }

  const target = validateTarget(value.target);
  const profile = validateProfile(value.profile);
  const resume = validateResume(value.resume);
  const fieldKeys = validateFieldKeys(value.fieldKeys);
  const allowedActions = validateAllowedActions(value.allowedActions);

  return {
    ver: 1,
    iss: value.iss,
    aud: value.aud,
    sub: value.sub,
    jti: value.jti,
    iat: value.iat,
    nbf: value.nbf,
    exp: value.exp,
    missionId: value.missionId,
    missionRevision: value.missionRevision,
    missionStepId: value.missionStepId,
    stepAttempt: value.stepAttempt,
    intentVersion: value.intentVersion,
    extensionInstallId: value.extensionInstallId,
    target,
    fieldKeys,
    fieldSchemaVersion: 1,
    automationLevel: value.automationLevel,
    allowedActions,
    planDigest: value.planDigest,
    approvalMessageId: value.approvalMessageId,
    profile,
    resume,
    policyVersion: value.policyVersion,
    killSwitchVersion: value.killSwitchVersion,
    consentVersion: value.consentVersion,
  };
}

function validateTarget(value: unknown): ExecutionIntentPayloadV1['target'] {
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, TARGET_KEYS) ||
    !isBoundedSafeToken(value.jobId, 512) ||
    !isSourcePlatform(value.sourcePlatform) ||
    !isAtsProvider(value.atsProvider) ||
    !isHttpsOrigin(value.canonicalOrigin) ||
    !isBoundedSafeToken(value.pathRuleId, 128) ||
    !isSha256Digest(value.postingFingerprint)
  ) {
    fail('CLAIMS_INVALID');
  }
  return {
    jobId: value.jobId,
    sourcePlatform: value.sourcePlatform,
    atsProvider: value.atsProvider,
    canonicalOrigin: value.canonicalOrigin,
    pathRuleId: value.pathRuleId,
    postingFingerprint: value.postingFingerprint,
  };
}

function validateProfile(value: unknown): ExecutionIntentPayloadV1['profile'] {
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, PROFILE_KEYS) ||
    !isCanonicalBigintString(value.revision, true) ||
    !isCanonicalBigintString(value.deletionEpoch, true) ||
    !isSha256Digest(value.snapshotDigest)
  ) {
    fail('CLAIMS_INVALID');
  }
  return {
    revision: value.revision,
    deletionEpoch: value.deletionEpoch,
    snapshotDigest: value.snapshotDigest,
  };
}

function validateResume(value: unknown): ExecutionIntentPayloadV1['resume'] {
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, RESUME_KEYS) ||
    !isUuid(value.versionId) ||
    !isSha256Digest(value.contentHash) ||
    !isCanonicalBigintString(value.contentRevision, false) ||
    !isCanonicalBigintString(value.libraryRevision, true)
  ) {
    fail('CLAIMS_INVALID');
  }
  return {
    versionId: value.versionId,
    contentHash: value.contentHash,
    contentRevision: value.contentRevision,
    libraryRevision: value.libraryRevision,
  };
}

function validateFieldKeys(value: unknown): readonly ApplicationProfileCanonicalFieldKey[] {
  // Every canonical Profile key may be approved (35 since 2026-09-21); this used to stop at
  // the original 11, which failed every intent for a page with a newer field (2026-09-24).
  if (
    !Array.isArray(value) ||
    value.length > SORTED_APPLICATION_PROFILE_CANONICAL_FIELD_KEYS.length ||
    value.some((item) => typeof item !== 'string')
  ) {
    fail('CLAIMS_INVALID');
  }
  try {
    return assertCanonicalFieldKeysV1(value as string[]);
  } catch {
    fail('CLAIMS_INVALID');
  }
}

function validateAllowedActions(value: unknown): readonly ExecutionIntentAllowedAction[] {
  if (
    !Array.isArray(value) ||
    value.length > ALLOWED_ACTIONS.size ||
    value.some((item) => typeof item !== 'string' || !ALLOWED_ACTIONS.has(item))
  ) {
    fail('CLAIMS_INVALID');
  }
  try {
    return assertCanonicalAllowedActionsV1(value as string[]);
  } catch {
    fail('CLAIMS_INVALID');
  }
}

function validateContextAndTime(
  payload: ExecutionIntentPayload,
  context: ExecutionIntentVerificationContext,
): void {
  if (payload.exp <= payload.iat || payload.exp - payload.iat > MAX_INTENT_TTL_SECONDS) {
    fail('CLAIMS_INVALID');
  }
  if (payload.nbf > payload.exp) fail('CLAIMS_INVALID');
  if (payload.iss !== context.expectedIssuer) fail('ISSUER_MISMATCH');
  if (payload.aud !== context.expectedAudience) fail('AUDIENCE_MISMATCH');
  if (payload.sub !== context.expectedSubject) fail('SUBJECT_MISMATCH');

  const nowMs = context.now instanceof Date ? context.now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) fail('CLAIMS_INVALID');
  const now = Math.floor(nowMs / 1000);
  if (payload.exp <= now) fail('EXPIRED');
  if (payload.nbf > now + NOT_BEFORE_CLOCK_SKEW_SECONDS) fail('NOT_YET_VALID');
}

function parseCanonicalJsonObject(encoded: string): Record<string, unknown> {
  const bytes = decodeCanonicalBase64Url(encoded);
  const json = bytes.toString('utf8');
  if (!Buffer.from(json, 'utf8').equals(bytes)) fail('MALFORMED');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    fail('MALFORMED');
  }
  if (!isJsonRecord(parsed)) fail('MALFORMED');

  // The issuer emits compact JSON. Requiring a byte-identical round trip also
  // rejects duplicate members, alternate number spellings, escapes used to
  // hide key names, and whitespace ambiguity without logging decoded claims.
  let roundTrip: string;
  try {
    roundTrip = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
  } catch {
    fail('MALFORMED');
  }
  if (roundTrip !== encoded) fail('MALFORMED');
  return parsed;
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!value || !BASE64URL_PATTERN.test(value)) fail('MALFORMED');
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    fail('MALFORMED');
  }
  if (decoded.length === 0 || decoded.toString('base64url') !== value) fail('MALFORMED');
  return decoded;
}

function hasExactKeys<const TKeys extends readonly string[]>(
  value: Record<string, unknown>,
  expected: TKeys,
): value is Record<TKeys[number], unknown> {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return false;
  const allowed = new Set<string>(expected);
  return keys.every((key) => allowed.has(key));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every(
    (descriptor) =>
      descriptor.enumerable && descriptor.get === undefined && descriptor.set === undefined,
  );
}

function isHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function isCanonicalJti(value: unknown): value is string {
  if (typeof value !== 'string' || !JTI_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value;
}

function isNumericDate(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0 && value <= 2_147_483_647;
}

function isCanonicalBigintString(value: unknown, allowZero: boolean): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 19 ||
    !CANONICAL_NON_NEGATIVE_DECIMAL_PATTERN.test(value)
  ) {
    return false;
  }
  const parsed = BigInt(value);
  return (allowZero || parsed > 0n) && parsed <= MAX_POSTGRES_BIGINT;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST_PATTERN.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isBoundedSafeToken(value: unknown, maxLength: number): value is string {
  return (
    isBoundedString(value, maxLength) &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    }) &&
    value === value.trim()
  );
}

function isAutomationLevel(value: unknown): value is ExecutionIntentAutomationLevel {
  return typeof value === 'string' && AUTOMATION_LEVELS.has(value);
}

function isSourcePlatform(value: unknown): value is ExecutionIntentSourcePlatform {
  return typeof value === 'string' && SOURCE_PLATFORMS.has(value);
}

function isAtsProvider(value: unknown): value is ExecutionIntentAtsProvider {
  return typeof value === 'string' && ATS_PROVIDERS.has(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function fail(reason: ExecutionIntentVerificationFailureReason): never {
  throw new ExecutionIntentVerificationError(reason);
}
