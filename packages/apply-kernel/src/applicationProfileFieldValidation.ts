/**
 * Pure, shared account-profile field contract.
 *
 * The same bounded-value rule applies at legacy-storage parsing, runtime IPC,
 * and HTTP. Keeping it here prevents a value accepted for migration from
 * reaching a stricter next boundary and stranding the candidate in a failed
 * upload with no edit path.
 */

import type { ApplyFieldKey } from './contracts';

export const APPLICATION_PROFILE_FIELD_MAX_LENGTH: Readonly<Record<ApplyFieldKey, number>> = {
  firstName: 256,
  lastName: 256,
  fullName: 256,
  preferredName: 256,
  email: 320,
  phone: 64,
  linkedinUrl: 2_048,
  githubUrl: 2_048,
  portfolioUrl: 2_048,
  city: 256,
  location: 256,
  // 上限取自库里的列宽，不另定：address_line1 VarChar(200)、
  // address_region VarChar(120)、经历行的 company VarChar(160)。
  // 取宽了会让一个存得下的值在这里被拒，取窄了会让它在写库时才炸。
  addressLine1: 200,
  addressRegion: 120,
  currentCompany: 160,
  // address_country_code Char(2)、address_postal_code VarChar(16)、经历行 title VarChar(160)。
  addressCountry: 2,
  addressPostalCode: 16,
  currentJobTitle: 160,
  // 值是闭集里的枚举名；最长的是 NATIVE_HAWAIIAN_OR_OTHER_PACIFIC_ISLANDER（41）。
  eeoGender: 24,
  eeoRace: 48,
  eeoVeteran: 24,
  eeoDisability: 8,
  heardAboutSource: 64,
  // 2026-09-21 填写键扩展：与 argoland application-profile-fields.contract 的上限逐字相同。
  preferredPronouns: 40,
  earliestStartDate: 10,
  noticePeriodDays: 3,
  profileSummary: 2000,
  expectedSalaryAmount: 16,
  expectedSalaryCurrency: 3,
  expectedSalaryPeriod: 5,
  over18: 5,
  openToRelocation: 5,
  openToRelocationCities: 256,
  preferredWorkModes: 20,
  profileTwitterUrl: 2_048,
  otherWebsiteUrl: 2_048,
};

const URL_FIELD_KEYS = new Set<ApplyFieldKey>(['linkedinUrl', 'githubUrl', 'portfolioUrl']);

/** Reject whitespace-only and raw overlong values rather than repairing them. */
export function isBoundedApplicationProfileString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function isSafeApplicationProfileHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

export function isValidApplicationProfileFieldValue(
  key: ApplyFieldKey,
  value: unknown,
): value is string {
  return (
    isBoundedApplicationProfileString(value, APPLICATION_PROFILE_FIELD_MAX_LENGTH[key]) &&
    (!URL_FIELD_KEYS.has(key) || isSafeApplicationProfileHttpUrl(value))
  );
}
