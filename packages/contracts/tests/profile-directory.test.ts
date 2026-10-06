import { describe, expect, it } from 'vitest';

import {
  APPLICATION_PROFILE_FIELD_KEYS,
  OWNER_PROFILE_V2_ENDPOINTS,
  PROFILE_DIRECTORY_WRITABLE_FIELD_KEYS,
  parseProfileDirectoryPersonalUpdateV1,
  parseProfileDirectoryPreferencesUpdateV1,
  parseProfileDirectoryWorkAuthorizationUpdateV1,
} from '../src/index.ts';

const personal = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, expectedRevision: '3', expectedDeletionEpoch: '0',
  fields: { firstName: 'Ada' }, ...overrides,
});

const workAuthorization = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, expectedProfileRevision: '3', expectedDeletionEpoch: '0',
  expectedPreferencesRevision: '2', reuseEnabled: true,
  entries: [{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }],
  ...overrides,
});

const preferences = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, expectedRevision: '1', workAuthorizationReuseEnabled: false, ...overrides,
});

describe('profile directory channels', () => {
  it('gives each section its own path, and never routes EEO through one of them', () => {
    const directory = Object.values(OWNER_PROFILE_V2_ENDPOINTS)
      .filter((endpoint) => endpoint.path.includes('/profile-directory/'));
    expect(directory.map((endpoint) => endpoint.path).sort()).toEqual([
      '/users/me/profile-directory/personal', '/users/me/profile-directory/personal',
      '/users/me/profile-directory/preferences', '/users/me/profile-directory/preferences',
      '/users/me/profile-directory/work-authorization', '/users/me/profile-directory/work-authorization',
    ]);
    // Self-identification is reached only through its own endpoint. Keeping it
    // off these paths is what makes the fill chain's PROFILE_SENSITIVE_SMUGGLED
    // rejection a fact about the wire rather than one caller's good manners.
    expect(directory.some((endpoint) => endpoint.path.includes('eeo'))).toBe(false);
    expect(OWNER_PROFILE_V2_ENDPOINTS.getOwnerEeoSelfIdentificationV1.path)
      // 权威（argoland src/career-team/contracts/http.ts）只有 agent 路由；/users/me/… 在生产上 404。
      .toBe('/api/v1/agent/eeo-self-identification');
  });

  it('offers every ordinary key for writing except the unauthorable legacy one', () => {
    expect([...PROFILE_DIRECTORY_WRITABLE_FIELD_KEYS].sort())
      .toEqual(APPLICATION_PROFILE_FIELD_KEYS.filter((key) => key !== 'location').slice().sort());
  });
});

describe('parseProfileDirectoryPersonalUpdateV1', () => {
  it('accepts an edit to a subset of the writable keys', () => {
    expect(parseProfileDirectoryPersonalUpdateV1(personal())).not.toBeNull();
    expect(parseProfileDirectoryPersonalUpdateV1(personal({ fields: { email: null } }))).not.toBeNull();
  });

  it('refuses a write to the read-only legacy location key', () => {
    expect(parseProfileDirectoryPersonalUpdateV1(personal({ fields: { location: 'Berlin' } }))).toBeNull();
  });

  it('refuses a self-identification answer arriving on the ordinary channel', () => {
    for (const smuggled of ['gender', 'raceEthnicity', 'veteranStatus', 'disabilityStatus']) {
      expect(parseProfileDirectoryPersonalUpdateV1(personal({ fields: { [smuggled]: 'Male' } }))).toBeNull();
    }
  });

  it('requires a revision to fence the write against', () => {
    expect(parseProfileDirectoryPersonalUpdateV1(personal({ expectedRevision: undefined }))).toBeNull();
    expect(parseProfileDirectoryPersonalUpdateV1(personal({ expectedRevision: 3 }))).toBeNull();
    expect(parseProfileDirectoryPersonalUpdateV1(personal({ expectedRevision: '-1' }))).toBeNull();
  });
});

describe('parseProfileDirectoryWorkAuthorizationUpdateV1', () => {
  it('accepts the confirmed answers together with their reuse switch', () => {
    expect(parseProfileDirectoryWorkAuthorizationUpdateV1(workAuthorization())).not.toBeNull();
    expect(parseProfileDirectoryWorkAuthorizationUpdateV1(workAuthorization({ reuseEnabled: false }))).not.toBeNull();
  });

  it('fences the answers and the reuse switch on separate revisions', () => {
    expect(parseProfileDirectoryWorkAuthorizationUpdateV1(
      workAuthorization({ expectedPreferencesRevision: undefined }))).toBeNull();
    expect(parseProfileDirectoryWorkAuthorizationUpdateV1(
      workAuthorization({ expectedProfileRevision: undefined }))).toBeNull();
  });

  it('refuses an answer value the user could not have chosen', () => {
    expect(parseProfileDirectoryWorkAuthorizationUpdateV1(workAuthorization({
      entries: [{ regionCode: 'US', authorizedToWork: 'PROBABLY', requiresSponsorship: 'NO' }],
    }))).toBeNull();
  });

  it('refuses two contradictory answers for one region', () => {
    expect(parseProfileDirectoryWorkAuthorizationUpdateV1(workAuthorization({
      entries: [
        { regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' },
        { regionCode: 'US', authorizedToWork: 'NO', requiresSponsorship: 'YES' },
      ],
    }))).toBeNull();
  });
});

describe('parseProfileDirectoryPreferencesUpdateV1', () => {
  it('accepts the reuse switch', () => {
    expect(parseProfileDirectoryPreferencesUpdateV1(preferences())).not.toBeNull();
    expect(parseProfileDirectoryPreferencesUpdateV1(
      preferences({ workAuthorizationReuseEnabled: true }))).not.toBeNull();
  });

  it('will not write the account time zone, whose writer also reschedules the daily report', () => {
    expect(parseProfileDirectoryPreferencesUpdateV1(
      preferences({ primaryTimeZone: 'America/Los_Angeles' }))).toBeNull();
  });

  it('refuses a preference the product has no durable home for', () => {
    // Salary and relocation stay user-confirmed per occurrence until an
    // additive-DDL owner supplies scoped storage; accepting them here would
    // hand the fill chain an answer nobody confirmed.
    expect(parseProfileDirectoryPreferencesUpdateV1(
      preferences({ expectedSalaryMinor: 120000 }))).toBeNull();
  });

  it('will not write the EEO reuse switch through this channel', () => {
    expect(parseProfileDirectoryPreferencesUpdateV1(preferences({ eeoReuseEnabled: true }))).toBeNull();
  });
});
