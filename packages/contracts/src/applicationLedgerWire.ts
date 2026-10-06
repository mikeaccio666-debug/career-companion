import {
  APPLICATION_LEDGER_DATE_STATES,
  APPLICATION_LEDGER_MILESTONES,
  APPLICATION_LEDGER_OUTCOMES,
  APPLICATION_LEDGER_STATUSES,
  type ApplicationLedgerItem,
  type ApplicationLedgerReceiptView,
  type ListApplicationLedgerResponse,
  type UpdatePrimaryTimeZoneResponse,
} from './applicationLedger.ts';
import { APPLICATION_RECEIPT_OUTCOMES, RECEIPT_VERIFICATION_LEVELS } from './executionIntent.ts';
import { parseIanaTimeZone } from './ianaTimeZones.ts';
import { parseIsoDateTime, parseUuid, parseSha256Digest } from './common.ts';

const MAX_LEDGER_PAGE_ITEMS = 100;
const MAX_RECEIPTS_PER_APPLICATION = 100;

export function decodeListApplicationLedgerResponse(
  value: unknown,
): ListApplicationLedgerResponse | null {
  if (
    !exactRecord(value, ["schemaVersion", "primaryTimeZone", "items", "nextCursor"]) ||
    value.schemaVersion !== 1 ||
    !(value.primaryTimeZone === null || parseIanaTimeZone(value.primaryTimeZone)) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_LEDGER_PAGE_ITEMS ||
    !value.items.every(isApplicationLedgerItem) ||
    !(value.nextCursor === null || parseUuid(value.nextCursor))
  ) {
    return null;
  }

  const applicationIds = value.items.map((item) => item.applicationId);
  if (new Set(applicationIds).size !== applicationIds.length) return null;
  if (applicationIds.some((applicationId, index) =>
    index > 0 && applicationIds[index - 1]! >= applicationId
  )) return null;
  if (
    value.nextCursor !== null &&
    (applicationIds.length === 0 ||
      value.nextCursor !== applicationIds[applicationIds.length - 1])
  ) return null;
  if (value.items.some((item) =>
    (item.dateState === "KNOWN" && value.primaryTimeZone === null) ||
    (item.dateState === "UNKNOWN_MISSING_TIME_ZONE" &&
      value.primaryTimeZone !== null)
  )) return null;

  return value as unknown as ListApplicationLedgerResponse;
}

export function decodeUpdatePrimaryTimeZoneResponse(
  value: unknown,
): UpdatePrimaryTimeZoneResponse | null {
  if (
    !exactRecord(value, ["schemaVersion", "primaryTimeZone"]) ||
    value.schemaVersion !== 1 ||
    !parseIanaTimeZone(value.primaryTimeZone)
  ) {
    return null;
  }
  return value as unknown as UpdatePrimaryTimeZoneResponse;
}

function isApplicationLedgerItem(value: unknown): value is ApplicationLedgerItem {
  if (!exactRecord(value, [
    "applicationId",
    "canonicalJobId",
    "applicationBundleVersion",
    "status",
    "dateState",
    "firstProviderConfirmedSubmittedAt",
    "receipts",
    "milestones",
    "outcome",
    ...(typeof value === "object" && value !== null && Object.hasOwn(value, "activity") ? ["activity"] : []),
    ...(typeof value === "object" && value !== null && Object.hasOwn(value, "jobSummary") ? ["jobSummary"] : []),
  ])) return false;
  if (Object.hasOwn(value, "jobSummary") && value.jobSummary !== null &&
    !isJobSummary(value.jobSummary, value.canonicalJobId)) return false;

  if (
    !parseUuid(value.applicationId) ||
    !parseUuid(value.canonicalJobId) ||
    !isCanonicalDecimalString(value.applicationBundleVersion) ||
    !APPLICATION_LEDGER_STATUSES.includes(value.status as never) ||
    !APPLICATION_LEDGER_DATE_STATES.includes(value.dateState as never) ||
    !(value.firstProviderConfirmedSubmittedAt === null ||
      parseIsoDateTime(value.firstProviderConfirmedSubmittedAt)) ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > MAX_RECEIPTS_PER_APPLICATION ||
    !value.receipts.every(isApplicationLedgerReceipt) ||
    !Array.isArray(value.milestones) ||
    !value.milestones.every((milestone) =>
      APPLICATION_LEDGER_MILESTONES.includes(milestone as never)
    ) ||
    !(value.outcome === null ||
      APPLICATION_LEDGER_OUTCOMES.includes(value.outcome as never))
  ) return false;

  if (Object.hasOwn(value, "activity") && value.activity !== null) {
    const activity = value.activity;
    const milestones = value.milestones;
    if (!exactRecord(activity, ["source", "milestones"]) || activity.source !== "REFERRAL" ||
      !Array.isArray(activity.milestones) || activity.milestones.length > 3 ||
      !activity.milestones.every((event) => exactRecord(event, ["milestone", "recordedAt"]) &&
        milestones.includes(event.milestone) && parseIsoDateTime(event.recordedAt)) ||
      !isCanonicalMilestoneOrder(activity.milestones.map((event) => event.milestone))) return false;
    if (activity.milestones.length !== value.milestones.length) return false;
  }

  const receiptIds = value.receipts.map((receipt) => receipt.receiptId);
  if (new Set(receiptIds).size !== receiptIds.length) return false;
  if (new Set(value.milestones).size !== value.milestones.length) return false;
  if (!isCanonicalMilestoneOrder(value.milestones)) return false;

  const providerSubmittedAt = value.receipts
    .filter((receipt) => receipt.verificationLevel === "PROVIDER_CONFIRMED")
    .map((receipt) => receipt.submittedAt)
    .filter((submittedAt): submittedAt is NonNullable<typeof submittedAt> =>
      submittedAt !== null
    )
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;

  if (value.status === "VERIFIED" && providerSubmittedAt === null) return false;
  if (
    value.status === "VERIFIED" &&
    !["KNOWN", "UNKNOWN_MISSING_TIME_ZONE"].includes(value.dateState as never)
  ) return false;
  if (
    value.dateState === "KNOWN" &&
    (providerSubmittedAt === null ||
      value.firstProviderConfirmedSubmittedAt !== providerSubmittedAt)
  ) return false;
  if (
    [
      "UNKNOWN_MISSING_SUBMITTED_AT",
      "UNKNOWN_CONFLICT",
      "UNKNOWN_EVIDENCE",
    ].includes(value.dateState as never) &&
    value.firstProviderConfirmedSubmittedAt !== null
  ) return false;
  if (
    value.dateState === "UNKNOWN_MISSING_TIME_ZONE" &&
    value.firstProviderConfirmedSubmittedAt !== providerSubmittedAt
  ) return false;

  return true;
}

function isApplicationLedgerReceipt(
  value: unknown,
): value is ApplicationLedgerReceiptView {
  if (!exactRecord(value, [
    "receiptId",
    "sourceOutcome",
    "effectiveOutcome",
    "verificationLevel",
    "submittedAt",
    "verifiedAt",
  ])) return false;

  if (
    !parseUuid(value.receiptId) ||
    !APPLICATION_RECEIPT_OUTCOMES.includes(value.sourceOutcome as never) ||
    !APPLICATION_RECEIPT_OUTCOMES.includes(value.effectiveOutcome as never) ||
    !RECEIPT_VERIFICATION_LEVELS.includes(value.verificationLevel as never) ||
    !(value.submittedAt === null || parseIsoDateTime(value.submittedAt)) ||
    !(value.verifiedAt === null || parseIsoDateTime(value.verifiedAt))
  ) return false;

  if (value.verificationLevel === "PROVIDER_CONFIRMED") {
    return ["SUBMISSION_TRIGGERED", "SUBMISSION_CONFIRMED"].includes(
      value.sourceOutcome as never,
    ) &&
      value.effectiveOutcome === "SUBMISSION_CONFIRMED" &&
      value.submittedAt !== null &&
      value.verifiedAt !== null;
  }

  const expectedEffectiveOutcome = value.sourceOutcome === "SUBMISSION_CONFIRMED"
    ? "SUBMISSION_TRIGGERED"
    : value.sourceOutcome;
  return value.effectiveOutcome === expectedEffectiveOutcome &&
    value.submittedAt === null &&
    value.verifiedAt === null;
}

function isCanonicalMilestoneOrder(value: readonly unknown[]) {
  let previousIndex = -1;
  for (const milestone of value) {
    const index = APPLICATION_LEDGER_MILESTONES.indexOf(milestone as never);
    if (index <= previousIndex) return false;
    previousIndex = index;
  }
  return true;
}

function isCanonicalDecimalString(value: unknown) {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isJobSummary(value: unknown, canonicalJobId: unknown): boolean {
  if (!exactRecord(value, ["canonicalJobId", "canonicalJobRevision", "listingId",
    "listingGenerationKey", "descriptionDigest", "title", "company", "checkedAt", "freshUntil"])) return false;
  return value.canonicalJobId === canonicalJobId && !!parseUuid(value.canonicalJobId) &&
    typeof value.canonicalJobRevision === "string" && /^(0|[1-9]\d*)$/.test(value.canonicalJobRevision) &&
    value.canonicalJobRevision.length <= 19 && BigInt(value.canonicalJobRevision) <= 9_223_372_036_854_775_807n &&
    !!parseUuid(value.listingId) && boundedLine(value.listingGenerationKey, 512) &&
    !!parseSha256Digest(value.descriptionDigest) && boundedLine(value.title, 256) && boundedLine(value.company, 256) &&
    !!parseIsoDateTime(value.checkedAt) && !!parseIsoDateTime(value.freshUntil) &&
    Date.parse(value.freshUntil as string) > Date.parse(value.checkedAt as string);
}
function boundedLine(value: unknown, maximum: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= maximum &&
    ![...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}
