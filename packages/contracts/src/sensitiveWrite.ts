/** Strict sensitive assisted-write wire mirror from AGENT-API-CONTRACT.md §5.9. */

import {
  parseIsoDateTime,
  parseSha256Digest,
  type DecimalString,
  type IsoDateTime,
  type Sha256Digest,
  type Uuid,
} from './common.ts';

declare const safeTokenBrand: unique symbol;
declare const base64Url43Brand: unique symbol;
declare const isoCountryCodeBrand: unique symbol;
declare const localeBrand: unique symbol;
declare const statementTextBrand: unique symbol;
declare const keyedDigestBrand: unique symbol;
declare const statementDigestBrand: unique symbol;

export type SafeToken = string & { readonly [safeTokenBrand]: true };
/** Canonical, unpadded RFC 4648 §5 encoding of exactly 32 bytes. */
export type Base64Url43 = string & { readonly [base64Url43Brand]: true };
export type IsoCountryCode = string & { readonly [isoCountryCodeBrand]: true };
export type CanonicalBcp47Locale = string & { readonly [localeBrand]: true };
export type SensitiveStatementTextV1 = string & { readonly [statementTextBrand]: true };
export type KeyedDigest = `hmac-sha256:v1:${string}:${string}` & {
  readonly [keyedDigestBrand]: true;
};
export type SensitiveStatementDigestV1 = `hmac-sha256:v1:${string}:${string}` & {
  readonly [statementDigestBrand]: true;
};

export const ISO_3166_1_ALPHA2_VERSION = 'iso-3166-1-alpha-2-2026-08-19' as const;

/*
 * Fixed contract table. Do not replace this with a platform locale lookup: membership must
 * not change underneath a deployed decoder. XK is intentionally absent because it is not an
 * ISO 3166-1 assignment.
 */
const ISO_3166_1_ALPHA2_CODES = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
   BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
   CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
   DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
   GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
   HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
   KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
   MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
   NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
   QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
   TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ
   VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`
    .trim()
    .split(/\s+/),
);

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function decodeCanonicalBase64Url(value: string): Uint8Array | null {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const output: number[] = [];
  let accumulator = 0;
  let bitCount = 0;
  for (const character of value) {
    const sextet = BASE64URL_ALPHABET.indexOf(character);
    if (sextet < 0) return null;
    accumulator = (accumulator << 6) | sextet;
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      output.push((accumulator >> bitCount) & 0xff);
    }
  }
  if (bitCount > 0 && (accumulator & ((1 << bitCount) - 1)) !== 0) return null;
  return Uint8Array.from(output);
}

function encodeCanonicalBase64Url(bytes: Uint8Array): string {
  let output = '';
  let accumulator = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 6) {
      bitCount -= 6;
      output += BASE64URL_ALPHABET[(accumulator >> bitCount) & 0x3f];
    }
  }
  if (bitCount > 0) output += BASE64URL_ALPHABET[(accumulator << (6 - bitCount)) & 0x3f];
  return output;
}

/**
 * 版本号/标识串。`@` 在 2026-09-18 跟着 argoland 补进来：那边的
 * `resumeProfileSuggestions` 把 `parserVersion` 写死成
 * `'resume-profile-suggestions@v1'`，而它正是 `ProfileFactSourceRefV2.parserVersion`
 * 的取值——服务端发出来的答复违反了双方共有的这道文法。严格解码的这一侧因此对
 * **每一个由简历解析建立过事实的用户**整份拒收，「我的资料」面板一片空白。
 *
 * 权威在 argoland，这边跟版（RULE-EXT-CONTRACT-CONSUMER）。
 */
export function parseSafeToken(value: unknown): SafeToken | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,64}$/.test(value)
    ? (value as SafeToken)
    : null;
}

export function parseBase64Url43(value: unknown): Base64Url43 | null {
  if (typeof value !== 'string' || value.length !== 43) return null;
  const decoded = decodeCanonicalBase64Url(value);
  return decoded?.length === 32 && encodeCanonicalBase64Url(decoded) === value
    ? (value as Base64Url43)
    : null;
}

export function parseIsoCountryCode(value: unknown): IsoCountryCode | null {
  return typeof value === 'string' && ISO_3166_1_ALPHA2_CODES.has(value)
    ? (value as IsoCountryCode)
    : null;
}

export function parseCanonicalBcp47Locale(value: unknown): CanonicalBcp47Locale | null {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 35 ||
    !/^[A-Za-z0-9-]+$/.test(value)
  ) {
    return null;
  }
  try {
    const canonical = Intl.getCanonicalLocales(value);
    return canonical.length === 1 && canonical[0] === value
      ? (value as CanonicalBcp47Locale)
      : null;
  } catch {
    return null;
  }
}

function parseHmacSha256V1(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^hmac-sha256:v1:([A-Za-z0-9._:-]{1,64}):([0-9a-f]{64})$/.exec(value);
  return match && parseSafeToken(match[1]) ? value : null;
}

export function parseKeyedDigest(value: unknown): KeyedDigest | null {
  return parseHmacSha256V1(value) as KeyedDigest | null;
}

export function parseSensitiveStatementDigestV1(
  value: unknown,
): SensitiveStatementDigestV1 | null {
  return parseHmacSha256V1(value) as SensitiveStatementDigestV1 | null;
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isSensitiveStatementEdgeWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    codePoint === 0x0020 ||
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff
  );
}

function isForbiddenStatementControl(codePoint: number): boolean {
  return (
    ((codePoint >= 0x0000 && codePoint <= 0x001f) && codePoint !== 0x0009 && codePoint !== 0x000a) ||
    (codePoint >= 0x007f && codePoint <= 0x009f)
  );
}

/**
 * The one shared §5.9.3 canonicalizer. It returns null for invalid scalar/control/length input;
 * callers that decode a server request must additionally require the return value to equal the
 * supplied string byte-for-byte (see parseSensitiveStatementTextV1).
 */
export function canonicalizeSensitiveStatementV1(
  value: unknown,
): SensitiveStatementTextV1 | null {
  if (typeof value !== 'string' || !hasWellFormedUtf16(value)) return null;
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC');
  if (!hasWellFormedUtf16(normalized)) return null;
  const scalars = Array.from(normalized);
  let start = 0;
  let end = scalars.length;
  while (start < end && isSensitiveStatementEdgeWhitespace(scalars[start]!.codePointAt(0)!)) {
    start += 1;
  }
  while (end > start && isSensitiveStatementEdgeWhitespace(scalars[end - 1]!.codePointAt(0)!)) {
    end -= 1;
  }
  const canonicalScalars = scalars.slice(start, end);
  if (canonicalScalars.length < 1 || canonicalScalars.length > 4096) return null;
  if (canonicalScalars.some((scalar) => isForbiddenStatementControl(scalar.codePointAt(0)!))) {
    return null;
  }
  return canonicalScalars.join('') as SensitiveStatementTextV1;
}

/** Strict server/wire decoder: normalization must not silently alter the received statement. */
export function parseSensitiveStatementTextV1(value: unknown): SensitiveStatementTextV1 | null {
  if (typeof value !== 'string') return null;
  const canonical = canonicalizeSensitiveStatementV1(value);
  return canonical === value ? canonical : null;
}

export const SENSITIVE_MANUAL_ONLY_CLASSES = [
  'PASSWORD',
  'OTP_OR_2FA',
  'CAPTCHA_OR_HUMAN_CHALLENGE',
  'SUBSTANTIVE_AUTHORIZATION',
  'FILE_PICKER',
  'UNKNOWN_HIGH_RISK',
] as const;
export type SensitiveManualOnlyClassV1 = (typeof SENSITIVE_MANUAL_ONLY_CLASSES)[number];

export const SENSITIVE_WRITE_CLASSES = [
  'EEO_SELF_IDENTIFICATION',
  'WORK_AUTHORIZATION',
  'TRUTHFULNESS_ATTESTATION',
] as const;
export type SensitiveWriteClassV1 = (typeof SENSITIVE_WRITE_CLASSES)[number];

export const SENSITIVE_WRITE_CONCEPTS = [
  'EEO_SELF_IDENTIFICATION',
  'WORK_AUTHORIZATION',
  'VISA_IDENTITY',
  'TRUTHFULNESS_ATTESTATION',
] as const;
export type SensitiveWriteConceptV1 = (typeof SENSITIVE_WRITE_CONCEPTS)[number];
export type SensitiveDiscoveryObservedConceptV1 = SensitiveWriteConceptV1;

export const SENSITIVE_WRITE_CONFIRMATION_STATUSES = [
  'PENDING',
  'RELEASED',
  'MANUAL_HANDOFF',
  'EXPIRED',
  'SUPERSEDED',
  'CANCELLED',
] as const;
export type SensitiveWriteConfirmationStatusV1 =
  (typeof SENSITIVE_WRITE_CONFIRMATION_STATUSES)[number];

export const SENSITIVE_WRITE_DECISIONS = ['RELEASE', 'HANDLE_MANUALLY'] as const;
export type SensitiveWriteDecisionV1 = (typeof SENSITIVE_WRITE_DECISIONS)[number];

export const SENSITIVE_WRITE_RELEASE_STATUSES = [
  'ISSUED',
  'CLAIMED',
  'CLAIMED_RECEIPT_ONLY',
  'CONSUMED',
  'EXPIRED',
  'REVOKED',
] as const;
export type SensitiveWriteReleaseStatusV1 = (typeof SENSITIVE_WRITE_RELEASE_STATUSES)[number];

type TupleRangeOneToTwenty<
  T,
  Accumulator extends readonly T[] = readonly [T],
> = Accumulator['length'] extends 20
  ? Accumulator
  : Accumulator | TupleRangeOneToTwenty<T, readonly [...Accumulator, T]>;

/** A statically and dynamically bounded non-empty wire collection. */
export type OneToTwenty<T> = TupleRangeOneToTwenty<T>;

export type SensitiveQuestionSubjectV1 =
  | {
      readonly kind: 'EEO_SELF_IDENTIFICATION';
      readonly jurisdictionCode: IsoCountryCode;
      readonly optionSetCode: SafeToken;
    }
  | {
      readonly kind: 'WORK_AUTHORIZATION';
      readonly questionCode:
        | 'AUTHORIZED_TO_WORK'
        | 'REQUIRES_SPONSORSHIP'
        | 'VISA_IDENTITY';
      readonly regionCode: IsoCountryCode;
      readonly timeFrame: 'CURRENT' | 'CURRENT_OR_FUTURE';
      readonly optionSetCode: SafeToken;
    }
  | {
      readonly kind: 'TRUTHFULNESS_ATTESTATION';
      readonly polarity: 'AFFIRMATIVE';
      readonly optionSetCode: 'BOOLEAN_TRUE';
    };

export interface SensitiveQuestionDefinitionRefV1 {
  readonly definitionCode: SafeToken;
  readonly definitionVersion: SafeToken;
  readonly answerSchemaVersion: SafeToken;
  readonly subject: SensitiveQuestionSubjectV1;
}

export type SensitiveStoredQuestionDefinitionRefV1 = Omit<
  SensitiveQuestionDefinitionRefV1,
  'subject'
> & {
  readonly subject: Exclude<
    SensitiveQuestionSubjectV1,
    { readonly kind: 'TRUTHFULNESS_ATTESTATION' }
  >;
};

export type SensitiveValueAuthorityV1 =
  | {
      readonly kind: 'SENSITIVE_VALUE_RECORD';
      readonly sensitiveValue: {
        readonly id: Uuid;
        readonly revision: DecimalString;
        readonly deletionEpoch: DecimalString;
        readonly digest: KeyedDigest;
        readonly definition: SensitiveStoredQuestionDefinitionRefV1;
      };
    }
  | {
      readonly kind: 'RELEASE_DECISION_BOOLEAN_TRUE';
      readonly sensitiveValue?: never;
    };

export type SensitiveMaterialValueV1 =
  | { readonly kind: 'BOOLEAN'; readonly value: boolean }
  | { readonly kind: 'SINGLE_CHOICE'; readonly optionCode: SafeToken }
  | { readonly kind: 'MULTI_CHOICE'; readonly optionCodes: OneToTwenty<SafeToken> }
  | { readonly kind: 'SHORT_TEXT'; readonly text: string };

export interface SensitiveWriteReleaseRefV1 {
  readonly id: Uuid;
  readonly revision: DecimalString;
  readonly digest: Sha256Digest;
}

export interface SensitiveWriteReleaseSnapshotItemV1 {
  readonly releaseItemId: Uuid;
  readonly confirmationItemId: Uuid;
  readonly targetOccurrenceId: Uuid;
  readonly conceptCode: SensitiveWriteConceptV1;
  readonly regionCode: IsoCountryCode | null;
  readonly definition: SensitiveQuestionDefinitionRefV1;
  readonly statementDigest: SensitiveStatementDigestV1;
  readonly valueAuthority: SensitiveValueAuthorityV1;
}

export interface SensitiveWriteReleaseSnapshotV1 {
  readonly schemaVersion: 1;
  readonly id: Uuid;
  readonly revision: DecimalString;
  readonly userId: Uuid;
  readonly missionId: Uuid;
  readonly missionRevision: DecimalString;
  readonly sourceReceiptId: Uuid;
  readonly confirmationId: Uuid;
  readonly confirmationRevision: DecimalString;
  readonly confirmationStateRevisionAtDecision: DecimalString;
  readonly confirmationDigest: Sha256Digest;
  readonly sourceMissionStepId: Uuid;
  readonly confirmationStepId: Uuid;
  readonly sourceIntentVersion: number;
  readonly extensionInstallId: Uuid;
  readonly jobIdentityHash: Sha256Digest;
  readonly targetCountryCode: IsoCountryCode;
  readonly basePlanDigest: Sha256Digest;
  readonly classifierVersion: SafeToken;
  readonly sensitiveSettingRevision: DecimalString;
  readonly sensitiveConsentVersion: SafeToken;
  readonly sensitiveReleasePolicyVersion: SafeToken;
  readonly uiCopyVersion: SafeToken;
  readonly decidedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly items: OneToTwenty<SensitiveWriteReleaseSnapshotItemV1>;
}

export interface CreateSensitiveWriteConfirmationParams {
  readonly missionId: Uuid;
}

export interface SensitiveDiscoveryItemV2 {
  readonly clientDiscoveryItemId: Uuid;
  readonly observedConceptCode: SensitiveDiscoveryObservedConceptV1;
  readonly regionCode: IsoCountryCode | null;
  readonly locale: CanonicalBcp47Locale;
  readonly statementText: SensitiveStatementTextV1;

  readonly html?: never;
  readonly rawHtml?: never;
  readonly selector?: never;
  readonly answer?: never;
  readonly optionValue?: never;
}

export type SensitiveDiscoveryItemsV2 = OneToTwenty<SensitiveDiscoveryItemV2>;

export interface CreateSensitiveWriteConfirmationRequestV2 {
  readonly executionProtocolVersion: 2;
  readonly extensionInstallId: Uuid;
  readonly clientReceiptId: Uuid;
  readonly executionLease: string;
  readonly missionStepId: Uuid;
  readonly intentVersion: number;
  readonly jobIdentityHash: Sha256Digest;
  readonly planDigest: Sha256Digest;
  readonly outcome: 'USER_ACTION_REQUIRED';
  readonly fieldResults: readonly [];
  readonly discovery: {
    readonly classifierVersion: SafeToken;
    readonly items: SensitiveDiscoveryItemsV2;
  };
  readonly executionStartedAt: IsoDateTime;
  readonly executionFinishedAt: IsoDateTime;

  readonly values?: never;
  readonly valueDigest?: never;
  readonly screenshot?: never;
  readonly rawHtml?: never;
  readonly selector?: never;
  readonly answer?: never;
}

export interface SensitiveWriteConfirmationItemViewV2 {
  readonly confirmationItemId: Uuid;
  readonly clientDiscoveryItemId: Uuid;
  readonly targetOccurrenceId: Uuid;
  readonly conceptCode: SensitiveWriteConceptV1;
  readonly regionCode: IsoCountryCode | null;
  readonly definition: SensitiveQuestionDefinitionRefV1;
  readonly statementDigest: SensitiveStatementDigestV1;
  readonly valueAuthority: SensitiveValueAuthorityV1;

  readonly statementText?: never;
  readonly answer?: never;
  readonly value?: never;
}

export interface SensitiveWriteConfirmationViewV2 {
  readonly kind: 'SENSITIVE_WRITE_CONFIRM';
  readonly id: Uuid;
  readonly revision: DecimalString;
  readonly stateRevision: DecimalString;
  readonly status: 'PENDING';
  readonly missionId: Uuid;
  readonly sourceReceiptId: Uuid;
  readonly sourceMissionStepId: Uuid;
  readonly confirmationStepId: Uuid;
  readonly sourceIntentVersion: number;
  readonly extensionInstallId: Uuid;
  readonly jobIdentityHash: Sha256Digest;
  readonly targetCountryCode: IsoCountryCode;
  readonly basePlanDigest: Sha256Digest;
  readonly confirmationDigest: Sha256Digest;
  readonly classifierVersion: SafeToken;
  readonly sensitiveSettingRevision: DecimalString;
  readonly sensitiveConsentVersion: SafeToken;
  readonly sensitiveReleasePolicyVersion: SafeToken;
  readonly uiCopyVersion: SafeToken;
  readonly expiresAt: IsoDateTime;
  readonly items: OneToTwenty<SensitiveWriteConfirmationItemViewV2>;
}

interface CreateSensitiveWriteConfirmationResponseCommonV2 {
  readonly schemaVersion: 2;
  readonly receipt: { readonly id: Uuid; readonly outcome: 'USER_ACTION_REQUIRED' };
  readonly mission: {
    readonly id: Uuid;
    readonly revision: DecimalString;
    readonly status: 'WAITING_FOR_USER';
  };
}

export type CreateSensitiveWriteConfirmationCreatedResponseV2 =
  CreateSensitiveWriteConfirmationResponseCommonV2 & {
    /** 32-byte capability returned exactly once by the first 201. */
    readonly confirmationDecisionToken: Base64Url43;
    readonly sensitiveWriteConfirmation: SensitiveWriteConfirmationViewV2;
  };

export type CreateSensitiveWriteConfirmationReplayResponseV2 =
  CreateSensitiveWriteConfirmationResponseCommonV2 & {
    readonly confirmationDecisionToken: null;
    readonly sensitiveWriteConfirmation: SensitiveWriteConfirmationViewV2;
  };

export type CreateSensitiveWriteConfirmationWithoutReleaseResponseV2 =
  CreateSensitiveWriteConfirmationResponseCommonV2 & {
    readonly confirmationDecisionToken: null;
    readonly sensitiveWriteConfirmation: null;
  };

export type CreateSensitiveWriteConfirmationResponseV2 =
  | CreateSensitiveWriteConfirmationCreatedResponseV2
  | CreateSensitiveWriteConfirmationReplayResponseV2
  | CreateSensitiveWriteConfirmationWithoutReleaseResponseV2;

export interface DecideSensitiveWriteConfirmationParams {
  readonly missionId: Uuid;
  readonly confirmationId: Uuid;
}

export interface SensitiveWriteDecisionItemV2 {
  readonly confirmationItemId: Uuid;
  readonly statementDigest: SensitiveStatementDigestV1;
  readonly decision: SensitiveWriteDecisionV1;
}

export type SensitiveWriteDecisionItemsV2 = OneToTwenty<SensitiveWriteDecisionItemV2>;

export interface DecideSensitiveWriteConfirmationRequestV2 {
  readonly clientRequestId: Uuid;
  readonly extensionInstallId: Uuid;
  readonly confirmationDecisionToken: Base64Url43;
  readonly expectedStateRevision: DecimalString;
  readonly confirmationDigest: Sha256Digest;
  readonly items: SensitiveWriteDecisionItemsV2;

  readonly statementText?: never;
  readonly answer?: never;
  readonly value?: never;
}

export interface SensitiveWriteReleasedItemViewV2 {
  readonly releaseItemId: Uuid;
  readonly confirmationItemId: Uuid;
  readonly clientDiscoveryItemId: Uuid;
  readonly targetOccurrenceId: Uuid;
}

export type SensitiveWriteDecisionResponseV2 =
  | {
      readonly schemaVersion: 2;
      readonly confirmation: {
        readonly kind: 'SENSITIVE_WRITE_CONFIRM';
        readonly id: Uuid;
        readonly revision: DecimalString;
        readonly stateRevision: DecimalString;
        readonly status: 'RELEASED';
      };
      readonly mission: {
        readonly id: Uuid;
        readonly revision: DecimalString;
        readonly status: 'READY_TO_EXECUTE';
      };
      readonly sensitiveWriteRelease: SensitiveWriteReleaseRefV1;
      readonly releasedItems: OneToTwenty<SensitiveWriteReleasedItemViewV2>;
    }
  | {
      readonly schemaVersion: 2;
      readonly confirmation: {
        readonly kind: 'SENSITIVE_WRITE_CONFIRM';
        readonly id: Uuid;
        readonly revision: DecimalString;
        readonly stateRevision: DecimalString;
        readonly status: 'MANUAL_HANDOFF';
      };
      readonly mission: {
        readonly id: Uuid;
        readonly revision: DecimalString;
        readonly status: 'CANCELLATION_REQUESTED';
      };
      readonly sensitiveWriteRelease: null;
      readonly releasedItems: readonly [];
    };

export interface ActualSensitiveItemV2 {
  readonly releaseItemId: Uuid;
  readonly locale: CanonicalBcp47Locale;
  readonly statementText: SensitiveStatementTextV1;

  readonly statementDigest?: never;
  readonly targetOccurrenceId?: never;
  readonly answer?: never;
  readonly value?: never;
}

export type ActualSensitiveItemsV2 = OneToTwenty<ActualSensitiveItemV2>;

export interface FetchSensitiveExecutionMaterialRequestV2 {
  readonly executionProtocolVersion: 2;
  readonly extensionInstallId: Uuid;
  readonly executionLease: string;
  readonly missionStepId: Uuid;
  readonly intentVersion: number;
  readonly sensitiveWriteRelease: SensitiveWriteReleaseRefV1;

  readonly statementText?: never;
  readonly answer?: never;
  readonly value?: never;
}

interface SensitiveExecutionMaterialItemCommonV2 {
  readonly releaseItemId: Uuid;
  readonly targetOccurrenceId: Uuid;
  readonly statementText?: never;
  readonly statementDigest?: never;
}

export type SensitiveExecutionMaterialItemV2 =
  | (SensitiveExecutionMaterialItemCommonV2 & {
      readonly valueAuthority: { readonly kind: 'RELEASE_DECISION_BOOLEAN_TRUE' };
      readonly answer: { readonly kind: 'BOOLEAN'; readonly value: true };
    })
  | (SensitiveExecutionMaterialItemCommonV2 & {
      readonly valueAuthority: Extract<
        SensitiveValueAuthorityV1,
        { readonly kind: 'SENSITIVE_VALUE_RECORD' }
      >;
      readonly answer: SensitiveMaterialValueV1;
    });

export interface FetchSensitiveExecutionMaterialResponseV2 {
  readonly schemaVersion: 2;
  readonly materialSchemaVersion: 1;
  readonly sensitiveWriteRelease: SensitiveWriteReleaseRefV1;
  readonly items: OneToTwenty<SensitiveExecutionMaterialItemV2>;
}

/** Backward-compatible aliases for the initial mirror's pre-review names. */
export type GetSensitiveExecutionMaterialRequestV2 = FetchSensitiveExecutionMaterialRequestV2;
export type GetSensitiveExecutionMaterialResponseV2 = FetchSensitiveExecutionMaterialResponseV2;

export const SENSITIVE_EXECUTION_MATERIAL_CACHE_POLICY = {
  responseHeaders: {
    'Cache-Control': 'private, no-store, no-transform',
    Pragma: 'no-cache',
    Expires: '0',
  },
  etag: 'forbidden',
} as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isUuidV4(value: unknown): value is Uuid {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isStrictlyAsciiSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1]!) >= key(values[index]!)) return false;
  }
  return true;
}

function hasOneToTwentyItems(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 20;
}

function isSensitiveConcept(value: unknown): value is SensitiveWriteConceptV1 {
  return typeof value === 'string' && (SENSITIVE_WRITE_CONCEPTS as readonly string[]).includes(value);
}

export function parseSensitiveDiscoveryItemsV2(
  value: unknown,
): SensitiveDiscoveryItemsV2 | null {
  if (!hasOneToTwentyItems(value)) return null;
  for (const item of value) {
    if (
      !hasExactKeys(item, [
        'clientDiscoveryItemId',
        'observedConceptCode',
        'regionCode',
        'locale',
        'statementText',
      ]) ||
      !isUuidV4(item.clientDiscoveryItemId) ||
      !isSensitiveConcept(item.observedConceptCode) ||
      !(item.regionCode === null || parseIsoCountryCode(item.regionCode)) ||
      !parseCanonicalBcp47Locale(item.locale) ||
      !parseSensitiveStatementTextV1(item.statementText)
    ) {
      return null;
    }
  }
  return isStrictlyAsciiSortedUnique(
    value as SensitiveDiscoveryItemV2[],
    (item) => item.clientDiscoveryItemId,
  )
    ? (value as unknown as SensitiveDiscoveryItemsV2)
    : null;
}

export function parseSensitiveWriteDecisionItemsV2(
  value: unknown,
): SensitiveWriteDecisionItemsV2 | null {
  if (!hasOneToTwentyItems(value)) return null;
  for (const item of value) {
    if (
      !hasExactKeys(item, ['confirmationItemId', 'statementDigest', 'decision']) ||
      !isUuidV4(item.confirmationItemId) ||
      !parseSensitiveStatementDigestV1(item.statementDigest) ||
      (item.decision !== 'RELEASE' && item.decision !== 'HANDLE_MANUALLY')
    ) {
      return null;
    }
  }
  return isStrictlyAsciiSortedUnique(
    value as SensitiveWriteDecisionItemV2[],
    (item) => item.confirmationItemId,
  )
    ? (value as unknown as SensitiveWriteDecisionItemsV2)
    : null;
}

export function parseActualSensitiveItemsV2(value: unknown): ActualSensitiveItemsV2 | null {
  if (!hasOneToTwentyItems(value)) return null;
  for (const item of value) {
    if (
      !hasExactKeys(item, ['releaseItemId', 'locale', 'statementText']) ||
      !isUuidV4(item.releaseItemId) ||
      !parseCanonicalBcp47Locale(item.locale) ||
      !parseSensitiveStatementTextV1(item.statementText)
    ) {
      return null;
    }
  }
  return isStrictlyAsciiSortedUnique(
    value as ActualSensitiveItemV2[],
    (item) => item.releaseItemId,
  )
    ? (value as unknown as ActualSensitiveItemsV2)
    : null;
}

function parseSensitiveQuestionDefinitionRefV1(
  value: unknown,
): SensitiveQuestionDefinitionRefV1 | null {
  if (!hasExactKeys(value, ['definitionCode', 'definitionVersion', 'answerSchemaVersion', 'subject'])) {
    return null;
  }
  if (
    !parseSafeToken(value.definitionCode) ||
    !parseSafeToken(value.definitionVersion) ||
    !parseSafeToken(value.answerSchemaVersion) ||
    !isPlainRecord(value.subject)
  ) {
    return null;
  }
  const subject = value.subject;
  if (
    hasExactKeys(subject, ['kind', 'jurisdictionCode', 'optionSetCode']) &&
    subject.kind === 'EEO_SELF_IDENTIFICATION' &&
    parseIsoCountryCode(subject.jurisdictionCode) &&
    parseSafeToken(subject.optionSetCode)
  ) {
    return value as unknown as SensitiveQuestionDefinitionRefV1;
  }
  if (
    hasExactKeys(subject, ['kind', 'questionCode', 'regionCode', 'timeFrame', 'optionSetCode']) &&
    subject.kind === 'WORK_AUTHORIZATION' &&
    ['AUTHORIZED_TO_WORK', 'REQUIRES_SPONSORSHIP', 'VISA_IDENTITY'].includes(
      subject.questionCode as string,
    ) &&
    parseIsoCountryCode(subject.regionCode) &&
    (subject.timeFrame === 'CURRENT' || subject.timeFrame === 'CURRENT_OR_FUTURE') &&
    parseSafeToken(subject.optionSetCode)
  ) {
    return value as unknown as SensitiveQuestionDefinitionRefV1;
  }
  return hasExactKeys(subject, ['kind', 'polarity', 'optionSetCode']) &&
    subject.kind === 'TRUTHFULNESS_ATTESTATION' &&
    subject.polarity === 'AFFIRMATIVE' &&
    subject.optionSetCode === 'BOOLEAN_TRUE'
    ? (value as unknown as SensitiveQuestionDefinitionRefV1)
    : null;
}

function parseSensitiveValueAuthorityV1(value: unknown): SensitiveValueAuthorityV1 | null {
  if (hasExactKeys(value, ['kind']) && value.kind === 'RELEASE_DECISION_BOOLEAN_TRUE') {
    return value as unknown as SensitiveValueAuthorityV1;
  }
  if (
    !hasExactKeys(value, ['kind', 'sensitiveValue']) ||
    value.kind !== 'SENSITIVE_VALUE_RECORD' ||
    !hasExactKeys(value.sensitiveValue, [
      'id',
      'revision',
      'deletionEpoch',
      'digest',
      'definition',
    ])
  ) {
    return null;
  }
  const sensitiveValue = value.sensitiveValue;
  const definition = parseSensitiveQuestionDefinitionRefV1(sensitiveValue.definition);
  return isUuidV4(sensitiveValue.id) &&
    isDecimalString(sensitiveValue.revision) &&
    isDecimalString(sensitiveValue.deletionEpoch) &&
    parseKeyedDigest(sensitiveValue.digest) &&
    definition &&
    definition.subject.kind !== 'TRUTHFULNESS_ATTESTATION'
    ? (value as unknown as SensitiveValueAuthorityV1)
    : null;
}

export function parseSensitiveMaterialValueV1(value: unknown): SensitiveMaterialValueV1 | null {
  if (!isPlainRecord(value)) return null;
  if (hasExactKeys(value, ['kind', 'value']) && value.kind === 'BOOLEAN' && typeof value.value === 'boolean') {
    return value as unknown as SensitiveMaterialValueV1;
  }
  if (
    hasExactKeys(value, ['kind', 'optionCode']) &&
    value.kind === 'SINGLE_CHOICE' &&
    parseSafeToken(value.optionCode)
  ) {
    return value as unknown as SensitiveMaterialValueV1;
  }
  if (
    hasExactKeys(value, ['kind', 'optionCodes']) &&
    value.kind === 'MULTI_CHOICE' &&
    hasOneToTwentyItems(value.optionCodes) &&
    value.optionCodes.every((option) => parseSafeToken(option)) &&
    isStrictlyAsciiSortedUnique(value.optionCodes as string[], (option) => option)
  ) {
    return value as unknown as SensitiveMaterialValueV1;
  }
  if (hasExactKeys(value, ['kind', 'text']) && value.kind === 'SHORT_TEXT' && typeof value.text === 'string') {
    const text = value.text;
    const scalarLength = hasWellFormedUtf16(text) ? Array.from(text).length : 0;
    return scalarLength >= 1 && scalarLength <= 256
      ? (value as unknown as SensitiveMaterialValueV1)
      : null;
  }
  return null;
}

export function parseSensitiveExecutionMaterialItemsV2(
  value: unknown,
): OneToTwenty<SensitiveExecutionMaterialItemV2> | null {
  if (!hasOneToTwentyItems(value)) return null;
  for (const item of value) {
    if (
      !hasExactKeys(item, ['releaseItemId', 'targetOccurrenceId', 'valueAuthority', 'answer']) ||
      !isUuidV4(item.releaseItemId) ||
      !isUuidV4(item.targetOccurrenceId)
    ) {
      return null;
    }
    const authority = parseSensitiveValueAuthorityV1(item.valueAuthority);
    if (!authority) return null;
    if (authority.kind === 'RELEASE_DECISION_BOOLEAN_TRUE') {
      if (
        !hasExactKeys(item.answer, ['kind', 'value']) ||
        item.answer.kind !== 'BOOLEAN' ||
        item.answer.value !== true
      ) {
        return null;
      }
    } else if (!parseSensitiveMaterialValueV1(item.answer)) {
      return null;
    }
  }
  return isStrictlyAsciiSortedUnique(
    value as SensitiveExecutionMaterialItemV2[],
    (item) => item.releaseItemId,
  )
    ? (value as unknown as OneToTwenty<SensitiveExecutionMaterialItemV2>)
    : null;
}

export function parseSensitiveWriteReleaseRefV1(
  value: unknown,
): SensitiveWriteReleaseRefV1 | null {
  if (!hasExactKeys(value, ['id', 'revision', 'digest'])) return null;
  return isUuidV4(value.id) && isDecimalString(value.revision) && parseSha256Digest(value.digest)
    ? (value as unknown as SensitiveWriteReleaseRefV1)
    : null;
}

export function parseCreateSensitiveWriteConfirmationRequestV2(
  value: unknown,
): CreateSensitiveWriteConfirmationRequestV2 | null {
  if (
    !hasExactKeys(value, [
      'executionProtocolVersion',
      'extensionInstallId',
      'clientReceiptId',
      'executionLease',
      'missionStepId',
      'intentVersion',
      'jobIdentityHash',
      'planDigest',
      'outcome',
      'fieldResults',
      'discovery',
      'executionStartedAt',
      'executionFinishedAt',
    ]) ||
    value.executionProtocolVersion !== 2 ||
    !isUuidV4(value.extensionInstallId) ||
    !isUuidV4(value.clientReceiptId) ||
    typeof value.executionLease !== 'string' ||
    value.executionLease.length < 1 ||
    !isUuidV4(value.missionStepId) ||
    !isPositiveInteger(value.intentVersion) ||
    !parseSha256Digest(value.jobIdentityHash) ||
    !parseSha256Digest(value.planDigest) ||
    value.outcome !== 'USER_ACTION_REQUIRED' ||
    !Array.isArray(value.fieldResults) ||
    value.fieldResults.length !== 0 ||
    !hasExactKeys(value.discovery, ['classifierVersion', 'items']) ||
    !parseSafeToken(value.discovery.classifierVersion) ||
    !parseSensitiveDiscoveryItemsV2(value.discovery.items)
  ) {
    return null;
  }
  const startedAt = parseIsoDateTime(value.executionStartedAt);
  const finishedAt = parseIsoDateTime(value.executionFinishedAt);
  if (!startedAt || !finishedAt || Date.parse(startedAt) > Date.parse(finishedAt)) return null;
  return value as unknown as CreateSensitiveWriteConfirmationRequestV2;
}

export function parseDecideSensitiveWriteConfirmationRequestV2(
  value: unknown,
): DecideSensitiveWriteConfirmationRequestV2 | null {
  if (
    !hasExactKeys(value, [
      'clientRequestId',
      'extensionInstallId',
      'confirmationDecisionToken',
      'expectedStateRevision',
      'confirmationDigest',
      'items',
    ]) ||
    !isUuidV4(value.clientRequestId) ||
    !isUuidV4(value.extensionInstallId) ||
    !parseBase64Url43(value.confirmationDecisionToken) ||
    !isDecimalString(value.expectedStateRevision) ||
    !parseSha256Digest(value.confirmationDigest) ||
    !parseSensitiveWriteDecisionItemsV2(value.items)
  ) {
    return null;
  }
  return value as unknown as DecideSensitiveWriteConfirmationRequestV2;
}

export function parseFetchSensitiveExecutionMaterialRequestV2(
  value: unknown,
): FetchSensitiveExecutionMaterialRequestV2 | null {
  if (
    !hasExactKeys(value, [
      'executionProtocolVersion',
      'extensionInstallId',
      'executionLease',
      'missionStepId',
      'intentVersion',
      'sensitiveWriteRelease',
    ]) ||
    value.executionProtocolVersion !== 2 ||
    !isUuidV4(value.extensionInstallId) ||
    typeof value.executionLease !== 'string' ||
    value.executionLease.length < 1 ||
    !isUuidV4(value.missionStepId) ||
    !isPositiveInteger(value.intentVersion) ||
    !parseSensitiveWriteReleaseRefV1(value.sensitiveWriteRelease)
  ) {
    return null;
  }
  return value as unknown as FetchSensitiveExecutionMaterialRequestV2;
}

export function parseFetchSensitiveExecutionMaterialResponseV2(
  value: unknown,
): FetchSensitiveExecutionMaterialResponseV2 | null {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'materialSchemaVersion',
      'sensitiveWriteRelease',
      'items',
    ]) ||
    value.schemaVersion !== 2 ||
    value.materialSchemaVersion !== 1 ||
    !parseSensitiveWriteReleaseRefV1(value.sensitiveWriteRelease) ||
    !parseSensitiveExecutionMaterialItemsV2(value.items)
  ) {
    return null;
  }
  return value as unknown as FetchSensitiveExecutionMaterialResponseV2;
}

/** Strict canonical UTC timestamp helper used by release-snapshot decoders. */
export function parseSensitiveIsoDateTime(value: unknown): IsoDateTime | null {
  return parseIsoDateTime(value);
}
