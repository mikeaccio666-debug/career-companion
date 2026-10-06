import { parseCandidateProfileSnapshotV2, type CandidateProfileSnapshotV2 } from '@edaix/contracts';
import { describe, expect, it } from 'vitest';

import { confirmedReferrals } from '../src/profileV2Referrals';
import { currentWorkAuthorizations } from '../src/profileV2WorkAuthorizations';
import { projectProfileV2Collections } from '../src/profileV2CollectionProjection';

/**
 * 契约解析器从 2026-09-28 起对事实权威元数据里**这一版不认识的值**容错：陌生的来源、确认状态、
 * 来源种类原样留着，不再整份拒收（`packages/contracts/src/profileSnapshotValidation.ts`）。
 *
 * 这一组钉的是容错的另一半：陌生值**不算已确认**。走真实的解析器，再交给三个消费端——
 * 工作授权、推荐人、集合投影——带陌生元数据的那一条一律不替用户填，同一份快照里元数据认得的
 * 兄弟条目照常可用。一个陌生值能让一条事实失效，但不能让它升格。
 */

const OWNER_ID = '76000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-09-28T00:00:00.000Z');

function authority(meta: Record<string, unknown> = {}) {
  return {
    factId: '30000000-0000-4000-8000-000000000001', factRevision: '2', deletionEpoch: '4',
    meta: {
      source: 'USER', authorityState: 'USER_CONFIRMED', confidence: null,
      userConfirmedAt: '2026-09-04T00:00:00.000Z', sourceRef: null, ...meta,
    },
  };
}

const UNRECOGNIZED = [
  ['来源', { source: 'LINKEDIN_IMPORT' }],
  ['确认状态', { authorityState: 'IMPORT_CONFIRMED' }],
  ['来源种类', { sourceRef: { kind: 'LINKEDIN_PROFILE', importId: 'imp_1' } }],
] as const;

function snapshot(meta: Record<string, unknown>): CandidateProfileSnapshotV2 {
  const raw = {
    schemaVersion: 2, revision: '9', deletionEpoch: '4', hasStoredProfile: true, updatedAt: null,
    profile: {
      identity: { firstName: null, middleName: null, lastName: null, fullName: null, preferredName: null, pronouns: null },
      contact: { email: null, phone: { countryCode: null, e164: null, display: null, type: null } },
      address: { line1: null, line2: null, city: null, region: null, postalCode: null, countryCode: null },
      summary: null, noExperience: null, links: [],
      primaryLinkIdByKind: { LINKEDIN: null, GITHUB: null, PORTFOLIO: null, WEBSITE: null, OTHER: null, TWITTER: null },
      experiences: [
        {
          id: '76000000-0000-4000-8000-000000000011', company: 'Acme', title: 'Engineer', city: null, region: null,
          employmentType: 'FULL_TIME', startDate: { year: 2021, month: 3 }, endDate: null, isCurrent: true, description: null,
          factAuthorityByField: {
            company: authority(meta), title: authority(), city: authority(), region: authority(),
            employmentType: authority(), startDate: authority(), endDate: authority(), isCurrent: authority(),
            description: authority(),
          },
        },
        {
          id: '76000000-0000-4000-8000-000000000012', company: 'Globex', title: 'Intern', city: null, region: null,
          employmentType: 'INTERNSHIP', startDate: { year: 2020, month: 6 }, endDate: { year: 2020, month: 9 }, isCurrent: false,
          description: null,
          factAuthorityByField: {
            company: authority(), title: authority(), city: authority(), region: authority(),
            employmentType: authority(), startDate: authority(), endDate: authority(), isCurrent: authority(),
            description: authority(),
          },
        },
      ],
      primaryCurrentExperienceId: null,
      educations: [], skills: [], languages: [], projects: [], achievements: [],
      referrals: [
        {
          id: '40000000-0000-4000-8000-000000000001', name: 'Dana Li', company: 'Acme', relationship: null,
          factAuthorityByField: { name: authority(meta), company: authority(), relationship: authority() },
        },
        {
          id: '40000000-0000-4000-8000-000000000002', name: 'Sam Wu', company: 'Globex', relationship: null,
          factAuthorityByField: { name: authority(), company: authority(), relationship: authority() },
        },
      ],
      legacyUnresolved: { profileLocation: null, experienceLocations: [], fieldValues: [] },
      availability: { earliestStartDate: null, noticePeriodDays: null },
      referralSource: null,
      workAuthorizations: [
        {
          regionCode: 'CA', authorizedToWork: 'YES', requiresSponsorship: 'NO', revision: '1',
          effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: null, revokedAt: null,
          factAuthorityByField: { regionCode: authority(meta), authorizedToWork: authority(), requiresSponsorship: authority() },
        },
        {
          regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO', revision: '1',
          effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: null, revokedAt: null,
          factAuthorityByField: { regionCode: authority(), authorizedToWork: authority(), requiresSponsorship: authority() },
        },
      ],
      scalarAuthorityByPath: {},
      referenceAuthority: { primaryLinkIdByKind: {}, primaryCurrentExperienceId: null },
    },
  };
  const parsed = parseCandidateProfileSnapshotV2(raw);
  if (parsed === null) throw new Error('解析器把整份快照拒了——陌生元数据本该只让那一条失效');
  return parsed;
}

describe('事实权威元数据里的陌生值：解析得出来，但不算已确认', () => {
  it.each(UNRECOGNIZED)('陌生的%s：那一条不替用户填，元数据认得的兄弟照常', (_label, meta) => {
    const parsed = snapshot(meta);

    expect(currentWorkAuthorizations(parsed, NOW).map(({ regionCode }) => regionCode)).toEqual(['US']);
    expect(confirmedReferrals(parsed).map(({ name }) => name)).toEqual(['Sam Wu']);

    const projected = projectProfileV2Collections({
      authenticatedOwnerId: OWNER_ID as never,
      ownerBoundSnapshot: { ownerId: OWNER_ID as never, snapshot: parsed },
      expectedProfileRevision: parsed.revision,
      expectedDeletionEpoch: parsed.deletionEpoch,
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    // 带陌生元数据的那一格（Acme 的公司名）不进投影；Globex 那一行整行照常。
    const companies = (projected.value.collections.experiences ?? []).map((row) => row.company);
    expect(companies).not.toContain('Acme');
    expect(companies).toContain('Globex');
  });

  it('对照：同一份快照元数据全认得时，三条都算已确认', () => {
    const parsed = snapshot({});
    expect(currentWorkAuthorizations(parsed, NOW).map(({ regionCode }) => regionCode)).toEqual(['CA', 'US']);
    expect(confirmedReferrals(parsed).map(({ name }) => name)).toEqual(['Dana Li', 'Sam Wu']);
  });
});
