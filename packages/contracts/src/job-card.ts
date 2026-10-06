/** Shared decoder for the existing JobCard wire; formal recommendation admission remains separate. */
import type { JobCardView } from './conversations.ts';
import { LOCATION_TIERS, PENDING_CONFIRMATION_CODES, QUALIFICATION_ELIGIBILITIES, QUALIFICATION_MISSING_CODES, QUALIFICATION_REASON_CODES, QUALIFICATION_RISK_CODES,
  REFERRAL_AVAILABILITIES, SPONSORSHIP_SOURCE_CODES, SPONSORSHIP_STATUSES } from './conversations.ts';
import { SAFE_DISPLAY_PARAM_KEYS } from './actionCards.ts';
import { ATS_PROVIDER_CODES, SOURCE_PLATFORM_CODES } from './missions.ts';
export function parseJobCardView(value: unknown): JobCardView | null { return isJobCard(value) ? value : null; }

function isJobCard(value: unknown): value is JobCardView {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'atsProvider', 'company', 'employmentType', 'jobId', 'location',
    'qualification', 'sourcePlatform', 'title',
  ])) return false;
  if (
    !isBoundedString(value.jobId, 1, 512) ||
    !isBoundedString(value.title, 1, 512) ||
    !isBoundedString(value.company, 1, 512) ||
    !isNullableBoundedString(value.location, 512) ||
    !isNullableBoundedString(value.employmentType, 256) ||
    !SOURCE_PLATFORM_CODES.includes(value.sourcePlatform as never) ||
    !ATS_PROVIDER_CODES.includes(value.atsProvider as never) ||
    !isPlainRecord(value.qualification) ||
    !hasExactKeys(value.qualification, [
      'eligibility', 'missingRequirements', 'reasons', 'referralAvailability',
      'risks', 'score', 'scoreScale', 'sponsorship',
    ], ['locationTier', 'pendingConfirmations'])
  ) return false;
  const qualification = value.qualification;
  if (Object.hasOwn(qualification,'locationTier') !== Object.hasOwn(qualification,'pendingConfirmations')) return false;
  return QUALIFICATION_ELIGIBILITIES.includes(qualification.eligibility as never) &&
    (qualification.score === null || isFiniteNumber(qualification.score)) &&
    qualification.scoreScale === 100 &&
    isDisplayCodeArray(qualification.reasons, QUALIFICATION_REASON_CODES) &&
    isDisplayCodeArray(qualification.risks, QUALIFICATION_RISK_CODES) &&
    isDisplayCodeArray(qualification.missingRequirements, QUALIFICATION_MISSING_CODES) &&
    isSponsorship(qualification.sponsorship) &&
    REFERRAL_AVAILABILITIES.includes(qualification.referralAvailability as never) &&
    (!Object.hasOwn(qualification,'locationTier') || qualification.locationTier === null || LOCATION_TIERS.includes(qualification.locationTier as never)) &&
    (!Object.hasOwn(qualification,'pendingConfirmations') || isDisplayCodeArray(qualification.pendingConfirmations,PENDING_CONFIRMATION_CODES));
}

function isDisplayCodeArray(value: unknown, codes: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length > 50) return false;
  return value.every((item) => isPlainRecord(item) &&
    hasExactKeys(item, ['code', 'defaultText', 'safeParams']) &&
    typeof item.code === 'string' && codes.includes(item.code) &&
    isBoundedString(item.defaultText, 0, 1024) &&
    isSafeDisplayParams(item.safeParams));
}

function isSafeDisplayParams(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(([key, item]) =>
    (SAFE_DISPLAY_PARAM_KEYS as readonly string[]).includes(key) &&
    (typeof item === 'boolean' || isFiniteNumber(item) || isBoundedString(item, 0, 1024)));
}

function isSponsorship(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['confidence', 'sourceCode', 'status'])) {
    return false;
  }
  return SPONSORSHIP_STATUSES.includes(value.status as never) &&
    SPONSORSHIP_SOURCE_CODES.includes(value.sourceCode as never) &&
    (value.confidence === null || (
      isFiniteNumber(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    ));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value,key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isNullableBoundedString(value: unknown, max: number): value is string | null {
  return value === null || isBoundedString(value, 0, max);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
