/**
 * Adapted from argoland 013d5128bd474f98b78df8c9878e1321712b134b.
 * Pure migration seam; importing this file grants no execution authority.
 */
import {
  APPLICATION_PROFILE_FIELD_KEYS,
  type ApplicationProfileFieldKey,
} from '@edaix/contracts';

/** Code-owned field registry shared by Application Profile and Agent execution. */
export const APPLICATION_PROFILE_FIELD_SCHEMA_VERSION = 1 as const;

export const APPLICATION_PROFILE_CANONICAL_FIELD_KEYS =
  APPLICATION_PROFILE_FIELD_KEYS;

export type ApplicationProfileCanonicalFieldKey = ApplicationProfileFieldKey;

/** Read/write wire limits, aligned with the ApplicationProfile column widths. */
export const APPLICATION_PROFILE_FIELD_MAX_LENGTHS = Object.freeze({
  firstName: 256,
  lastName: 256,
  fullName: 256,
  preferredName: 256,
  email: 320,
  phone: 64,
  linkedinUrl: 2048,
  githubUrl: 2048,
  portfolioUrl: 2048,
  city: 256,
  location: 256,
  // 与 application_profiles 的列宽对齐：address_line1 / address_region 与
  // application_profile_v2_experiences.company。
  addressLine1: 200,
  addressRegion: 120,
  currentCompany: 160,
  // address_country_code Char(2)、address_postal_code VarChar(16)、
  // application_profile_v2_experiences.title VarChar(160)。
  addressCountry: 2,
  addressPostalCode: 16,
  currentJobTitle: 160,
  // 值是闭集里的枚举名，不是自由文本；最长的是
  // NATIVE_HAWAIIAN_OR_OTHER_PACIFIC_ISLANDER（41）。
  eeoGender: 24,
  eeoRace: 48,
  eeoVeteran: 24,
  eeoDisability: 8,
  heardAboutSource: 64,
  // 2026-09-21 填写键扩展（P1-5）。与列宽对齐：pronouns VarChar(40)、
  // expected_salary_amount VarChar(16)、expected_salary_currency Char(3)、
  // open_to_relocation_cities VarChar(256)；布尔发 'true'/'false'（5）、
  // 日期发 YYYY-MM-DD（10）、通知期最多 365 天（3）、办公模式子集最长
  // 'REMOTE,HYBRID,ONSITE'（20）、链接与其它 url 同 2048。
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
  profileTwitterUrl: 2048,
  otherWebsiteUrl: 2048,
} satisfies Readonly<Record<ApplicationProfileCanonicalFieldKey, number>>);

/** Deterministic wire/digest order; derived here so consumers cannot fork the registry. */
export const SORTED_APPLICATION_PROFILE_CANONICAL_FIELD_KEYS = Object.freeze(
  [...APPLICATION_PROFILE_CANONICAL_FIELD_KEYS].sort(),
);
