/** Runtime exact decoders for the negotiated §5.9 issue/claim/receipt wire unions. */

import {
  parseIsoDateTime,
  parseSha256Digest,
  type DecimalString,
  type IsoDateTime,
  type Uuid,
} from './common.ts';
import {
  APPLICATION_FIELD_OUTCOMES,
  APPLICATION_FIELD_REASON_CODES,
  APPLICATION_PROFILE_FIELD_KEYS,
  APPLICATION_RECEIPT_OUTCOMES,
  CLIENT_RECEIPT_OUTCOMES,
  RECEIPT_VERIFICATION_LEVELS,
  SENSITIVE_RECEIPT_OUTCOMES,
  type ApplicationFieldOutcomeCode,
  type ApplicationFieldReasonCode,
  type ClaimExecutionIntentRequestV2,
  type ClaimExecutionIntentResponseV2,
  type ExecutionIntentIssueRequestV2,
  type IssueExecutionIntentResponseV2,
  type SensitiveApplicationReceiptFieldResultV2,
  type SubmitApplicationReceiptRequestV2,
  type SubmitApplicationReceiptResponseV2,
} from './executionIntent.ts';
import { MISSION_STATUSES } from './missions.ts';
import {
  parseActualSensitiveItemsV2,
  parseSafeToken,
  parseSensitiveWriteReleaseRefV1,
} from './sensitiveWrite.ts';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOneToTwentyItems(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 20;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isExecutionIntentKid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

function isCanonicalHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.origin === value
    );
  } catch {
    return false;
  }
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

function isMember<T extends string>(value: unknown, members: readonly T[]): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value);
}

function parseActualTargetV2(value: unknown): boolean {
  return (
    hasExactKeys(value, ['canonicalOrigin', 'pathRuleId', 'postingFingerprint']) &&
    isCanonicalHttpsOrigin(value.canonicalOrigin) &&
    Boolean(parseSafeToken(value.pathRuleId)) &&
    Boolean(parseSha256Digest(value.postingFingerprint))
  );
}

function parseTimeline(started: unknown, finished: unknown): [IsoDateTime, IsoDateTime] | null {
  const parsedStarted = parseIsoDateTime(started);
  const parsedFinished = parseIsoDateTime(finished);
  return parsedStarted && parsedFinished && Date.parse(parsedStarted) <= Date.parse(parsedFinished)
    ? [parsedStarted, parsedFinished]
    : null;
}

function parseStandardFieldKeys(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= APPLICATION_PROFILE_FIELD_KEYS.length &&
    value.every((key) => isMember(key, APPLICATION_PROFILE_FIELD_KEYS)) &&
    isStrictlyAsciiSortedUnique(value as string[], (key) => key)
  );
}

function parseStandardAllowedActions(value: unknown): boolean {
  const members = ['FILL', 'SUBMIT', 'DISCOVER_SENSITIVE'] as const;
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= members.length &&
    value.every((action) => isMember(action, members)) &&
    isStrictlyAsciiSortedUnique(value as string[], (action) => action)
  );
}

function parseApplicationFieldResult(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    !(keys.length === 2 || keys.length === 3) ||
    !keys.includes('fieldKey') ||
    !keys.includes('outcomeCode') ||
    keys.some((key) => !['fieldKey', 'outcomeCode', 'reasonCode'].includes(key)) ||
    !isMember(value.fieldKey, APPLICATION_PROFILE_FIELD_KEYS) ||
    !isMember(value.outcomeCode, APPLICATION_FIELD_OUTCOMES)
  ) {
    return false;
  }
  return !keys.includes('reasonCode') || isMember(value.reasonCode, APPLICATION_FIELD_REASON_CODES);
}

function parseStandardFieldResults(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length > APPLICATION_PROFILE_FIELD_KEYS.length ||
    !value.every(parseApplicationFieldResult)
  ) {
    return false;
  }
  const fieldKeys = (value as Array<{ fieldKey: string }>).map((result) => result.fieldKey);
  return new Set(fieldKeys).size === fieldKeys.length;
}

function parseSensitiveFieldResult(value: unknown): value is SensitiveApplicationReceiptFieldResultV2 {
  return (
    hasExactKeys(value, ['sensitivity', 'releaseItemId', 'outcomeCode', 'reasonCode']) &&
    value.sensitivity === 'USER_RELEASE_REQUIRED' &&
    isUuidV4(value.releaseItemId) &&
    isMember(value.outcomeCode, APPLICATION_FIELD_OUTCOMES) &&
    (value.reasonCode === null || isMember(value.reasonCode, APPLICATION_FIELD_REASON_CODES))
  );
}

function parseSensitiveFieldResults(value: unknown): boolean {
  return (
    hasOneToTwentyItems(value) &&
    value.every(parseSensitiveFieldResult) &&
    isStrictlyAsciiSortedUnique(
      value as SensitiveApplicationReceiptFieldResultV2[],
      (result) => result.releaseItemId,
    )
  );
}

function parseReceiptRequestCommon(value: Record<string, unknown>): boolean {
  return (
    isUuidV4(value.clientReceiptId) &&
    isNonEmptyString(value.executionLease) &&
    isUuidV4(value.missionStepId) &&
    isPositiveInteger(value.intentVersion) &&
    Boolean(parseSha256Digest(value.jobIdentityHash)) &&
    Boolean(parseSha256Digest(value.planDigest)) &&
    Boolean(parseTimeline(value.executionStartedAt, value.executionFinishedAt))
  );
}

export function parseExecutionIntentIssueRequestV2(
  value: unknown,
): ExecutionIntentIssueRequestV2 | null {
  if (
    !hasExactKeys(value, [
      'executionProtocolVersion',
      'missionRevision',
      'extensionInstallId',
      'authority',
    ]) ||
    value.executionProtocolVersion !== 2 ||
    !isDecimalString(value.missionRevision) ||
    !isUuidV4(value.extensionInstallId) ||
    !isPlainRecord(value.authority)
  ) {
    return null;
  }
  const authority = value.authority;
  if (
    hasExactKeys(authority, ['kind', 'missionStepId']) &&
    authority.kind === 'APPROVAL' &&
    isUuidV4(authority.missionStepId)
  ) {
    return value as unknown as ExecutionIntentIssueRequestV2;
  }
  return hasExactKeys(authority, ['kind', 'sensitiveWriteRelease']) &&
    authority.kind === 'SENSITIVE_WRITE_RELEASE' &&
    parseSensitiveWriteReleaseRefV1(authority.sensitiveWriteRelease)
    ? (value as unknown as ExecutionIntentIssueRequestV2)
    : null;
}

export function parseIssueExecutionIntentResponseV2(
  value: unknown,
): IssueExecutionIntentResponseV2 | null {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'executionProtocolVersion',
      'executionIntent',
      'expiresAt',
      'intentVersion',
      'kid',
    ]) ||
    value.schemaVersion !== 2 ||
    value.executionProtocolVersion !== 2 ||
    !isNonEmptyString(value.executionIntent) ||
    !parseIsoDateTime(value.expiresAt) ||
    !isPositiveInteger(value.intentVersion) ||
    !isExecutionIntentKid(value.kid)
  ) {
    return null;
  }
  return value as unknown as IssueExecutionIntentResponseV2;
}

export function parseClaimExecutionIntentRequestV2(
  value: unknown,
): ClaimExecutionIntentRequestV2 | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  const hasStandard = keys.includes('actualFieldKeys');
  const hasSensitive = keys.includes('actualSensitiveItems');
  const expectedKeys = [
    'executionProtocolVersion',
    'executionIntent',
    'extensionInstallId',
    'actualTarget',
    hasStandard ? 'actualFieldKeys' : 'actualSensitiveItems',
    'scanDigest',
  ];
  if (
    hasStandard === hasSensitive ||
    !hasExactKeys(value, expectedKeys) ||
    value.executionProtocolVersion !== 2 ||
    !isNonEmptyString(value.executionIntent) ||
    !isUuidV4(value.extensionInstallId) ||
    !parseActualTargetV2(value.actualTarget) ||
    !parseSha256Digest(value.scanDigest)
  ) {
    return null;
  }
  if (
    hasStandard
      ? !parseStandardFieldKeys(value.actualFieldKeys)
      : !parseActualSensitiveItemsV2(value.actualSensitiveItems)
  ) {
    return null;
  }
  return value as unknown as ClaimExecutionIntentRequestV2;
}

export function parseClaimExecutionIntentResponseV2(
  value: unknown,
): ClaimExecutionIntentResponseV2 | null {
  if (
    !hasExactKeys(value, ['schemaVersion', 'executionProtocolVersion', 'claim']) ||
    value.schemaVersion !== 2 ||
    value.executionProtocolVersion !== 2 ||
    !hasExactKeys(value.claim, [
      'missionId',
      'missionStepId',
      'intentVersion',
      'executionLease',
      'leaseExpiresAt',
      'allowedActions',
      'sensitiveWriteRelease',
    ])
  ) {
    return null;
  }
  const claim = value.claim;
  if (
    !isUuidV4(claim.missionId) ||
    !isUuidV4(claim.missionStepId) ||
    !isPositiveInteger(claim.intentVersion) ||
    !isNonEmptyString(claim.executionLease) ||
    !parseIsoDateTime(claim.leaseExpiresAt)
  ) {
    return null;
  }
  if (claim.sensitiveWriteRelease === null) {
    if (!parseStandardAllowedActions(claim.allowedActions)) return null;
  } else if (
    !Array.isArray(claim.allowedActions) ||
    claim.allowedActions.length !== 1 ||
    claim.allowedActions[0] !== 'FILL_SENSITIVE' ||
    !parseSensitiveWriteReleaseRefV1(claim.sensitiveWriteRelease)
  ) {
    return null;
  }
  return value as unknown as ClaimExecutionIntentResponseV2;
}

export function parseSubmitApplicationReceiptRequestV2(
  value: unknown,
): SubmitApplicationReceiptRequestV2 | null {
  if (!isPlainRecord(value) || value.executionProtocolVersion !== 2) return null;
  if (value.receiptMode === 'STANDARD') {
    if (
      !hasExactKeys(value, [
        'executionProtocolVersion',
        'receiptMode',
        'clientReceiptId',
        'executionLease',
        'missionStepId',
        'intentVersion',
        'jobIdentityHash',
        'planDigest',
        'outcome',
        'fieldResults',
        'executionStartedAt',
        'executionFinishedAt',
      ]) ||
      !parseReceiptRequestCommon(value) ||
      !isMember(value.outcome, CLIENT_RECEIPT_OUTCOMES) ||
      !parseStandardFieldResults(value.fieldResults)
    ) {
      return null;
    }
    return value as unknown as SubmitApplicationReceiptRequestV2;
  }
  if (
    value.receiptMode !== 'SENSITIVE_RELEASE' ||
    !hasExactKeys(value, [
      'executionProtocolVersion',
      'receiptMode',
      'clientReceiptId',
      'executionLease',
      'missionStepId',
      'intentVersion',
      'jobIdentityHash',
      'planDigest',
      'sensitiveReleaseSnapshot',
      'outcome',
      'fieldResults',
      'executionStartedAt',
      'executionFinishedAt',
    ]) ||
    !parseReceiptRequestCommon(value) ||
    !parseSensitiveWriteReleaseRefV1(value.sensitiveReleaseSnapshot) ||
    !isMember(value.outcome, SENSITIVE_RECEIPT_OUTCOMES) ||
    !parseSensitiveFieldResults(value.fieldResults)
  ) {
    return null;
  }
  return value as unknown as SubmitApplicationReceiptRequestV2;
}

function parseReceiptResponseCommon(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    !keys.every((key) =>
      [
        'id',
        'clientReceiptId',
        'missionId',
        'missionStepId',
        'intentVersion',
        'outcome',
        'verificationLevel',
        'createdAt',
        'sensitiveReleaseSnapshot',
        'fieldResults',
      ].includes(key),
    ) ||
    !isUuidV4(value.id) ||
    !isUuidV4(value.clientReceiptId) ||
    !isUuidV4(value.missionId) ||
    !isUuidV4(value.missionStepId) ||
    !isPositiveInteger(value.intentVersion) ||
    !isMember(value.verificationLevel, RECEIPT_VERIFICATION_LEVELS) ||
    !parseIsoDateTime(value.createdAt)
  ) {
    return false;
  }
  return true;
}

export function parseSubmitApplicationReceiptResponseV2(
  value: unknown,
): SubmitApplicationReceiptResponseV2 | null {
  if (
    !hasExactKeys(value, ['schemaVersion', 'receipt', 'mission']) ||
    value.schemaVersion !== 2 ||
    !parseReceiptResponseCommon(value.receipt) ||
    !hasExactKeys(value.mission, ['id', 'revision', 'status']) ||
    !isUuidV4(value.mission.id) ||
    !isDecimalString(value.mission.revision) ||
    !isMember(value.mission.status, MISSION_STATUSES)
  ) {
    return null;
  }
  const receipt = value.receipt;
  const hasRelease = Object.hasOwn(receipt, 'sensitiveReleaseSnapshot');
  const hasResults = Object.hasOwn(receipt, 'fieldResults');
  if (hasRelease !== hasResults) return null;
  const expectedCommonKeys = [
    'id',
    'clientReceiptId',
    'missionId',
    'missionStepId',
    'intentVersion',
    'outcome',
    'verificationLevel',
    'createdAt',
  ];
  if (!hasRelease) {
    return hasExactKeys(receipt, expectedCommonKeys) &&
      isMember(receipt.outcome, APPLICATION_RECEIPT_OUTCOMES)
      ? (value as unknown as SubmitApplicationReceiptResponseV2)
      : null;
  }
  return hasExactKeys(receipt, [
    ...expectedCommonKeys,
    'sensitiveReleaseSnapshot',
    'fieldResults',
  ]) &&
    isMember(receipt.outcome, SENSITIVE_RECEIPT_OUTCOMES) &&
    parseSensitiveWriteReleaseRefV1(receipt.sensitiveReleaseSnapshot) &&
    parseSensitiveFieldResults(receipt.fieldResults)
    ? (value as unknown as SubmitApplicationReceiptResponseV2)
    : null;
}
