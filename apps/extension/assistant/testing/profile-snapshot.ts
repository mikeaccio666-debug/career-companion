import { parseCandidateProfileSnapshotV2, PROFILE_V2_EXPERIENCE_FIELD_CODES, PROFILE_V2_EDUCATION_FIELD_CODES } from '@edaix/contracts';

/** Fictional payload, reachable from previews/tests only. Every payload passes the production decoder. */
function emptySnapshot(): unknown {
  return {
    schemaVersion: 2,
    revision: '0',
    deletionEpoch: '0',
    hasStoredProfile: false,
    updatedAt: null,
    profile: {
      identity: {
        firstName: null,
        middleName: null,
        lastName: null,
        fullName: null,
        preferredName: null,
      },
      contact: {
        email: null,
        phone: { countryCode: null, e164: null, display: null, type: null },
      },
      address: {
        line1: null,
        line2: null,
        city: null,
        region: null,
        postalCode: null,
        countryCode: null,
      },
      summary: null,
      noExperience: null,
      links: [],
      primaryLinkIdByKind: {
        LINKEDIN: null,
        GITHUB: null,
        PORTFOLIO: null,
        WEBSITE: null,
        OTHER: null,
      },
      experiences: [],
      primaryCurrentExperienceId: null,
      educations: [],
      skills: [],
      languages: [],
      projects: [],
      achievements: [],
      referrals: [],
      legacyUnresolved: { profileLocation: null, experienceLocations: [], fieldValues: [] },
      availability: { earliestStartDate: null, noticePeriodDays: null },
      referralSource: null,
      workAuthorizations: [],
      scalarAuthorityByPath: {},
      referenceAuthority: { primaryLinkIdByKind: {}, primaryCurrentExperienceId: null },
    },
  };
}

export function fictionalProfileSnapshot(name: string) {
  const s = emptySnapshot() as any;
  s.hasStoredProfile = true; s.revision = '1'; s.updatedAt = '2026-09-13T00:00:00.000Z';
  s.profile.identity.fullName = name; s.profile.summary = '虚构简介 · Fictional profile content';
  const authority = (fields: readonly string[]) => Object.fromEntries(fields.map((key, i) => [key, {
    factId: `70000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, factRevision: '1', deletionEpoch: '0',
    meta: { source: 'USER', authorityState: 'USER_CONFIRMED', confidence: null, userConfirmedAt: '2026-09-13T00:00:00.000Z', sourceRef: null },
  }]));
  s.profile.experiences = [{ id: '50000000-0000-4000-8000-000000000001', company: 'Example Company', title: 'Product designer', city: null, region: null,
    employmentType: 'FULL_TIME', startDate: { year: 2022, month: 6 }, endDate: null, isCurrent: true, description: '虚构经历 · Fictional experience', factAuthorityByField: authority(PROFILE_V2_EXPERIENCE_FIELD_CODES) }];
  s.profile.educations = [{ id: '60000000-0000-4000-8000-000000000001', school: 'Example University', degree: 'BA', degreeLevel: 'BACHELOR', fieldOfStudy: 'Design', city: null, region: null,
    startDate: { year: 2018, month: 9 }, endDate: { year: 2022, month: 5 }, expectedGraduationDate: null, isCurrent: false, gpa: null, gpaScale: null, coursework: null, factAuthorityByField: authority(PROFILE_V2_EDUCATION_FIELD_CODES) }];
  return parseCandidateProfileSnapshotV2(s);
}
