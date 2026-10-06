import {
  PROFILE_V2_COLLECTION_LIMITS,
  PROFILE_V2_ACHIEVEMENT_FIELD_CODES,
  PROFILE_V2_EDUCATION_FIELD_CODES,
  PROFILE_V2_EXPERIENCE_FIELD_CODES,
  PROFILE_V2_LANGUAGE_FIELD_CODES,
  PROFILE_V2_PROJECT_FIELD_CODES,
  PROFILE_V2_SKILL_FIELD_CODES,
  parseUuid,
  type CandidateProfileSnapshotV2,
  type DecimalString,
  type ProfileAchievementV2,
  type ProfileAuthorityStateV2,
  type ProfileEducationV2,
  type ProfileExperienceV2,
  type ProfileFactSourceV2,
  type ProfileFieldAuthorityV2,
  type ProfileLanguageV2,
  type ProfileProjectV2,
  type ProfileSkillV2,
  type Uuid,
} from '@edaix/contracts';
import { describe, expect, it } from 'vitest';

import { projectCollectionField } from '../src/collectionProjection';
import { parseApplyProfileCollections } from '../src/profileCollections';
import {
  projectProfileV2Collections,
  type ProfileV2CollectionProjectionInput,
} from '../src/profileV2CollectionProjection';

const OWNER_ID = parseUuid('76000000-0000-4000-8000-000000000001')!;
const FOREIGN_OWNER_ID = parseUuid('76000000-0000-4000-8000-000000000099')!;
const FACT_ID = parseUuid('76000000-0000-4000-8000-000000000002')!;
const EVIDENCE_FACT_ID = parseUuid('76000000-0000-4000-8000-000000000003')!;
const EVIDENCE_FACT_ID_2 = parseUuid('76000000-0000-4000-8000-000000000004')!;
const EXPERIENCE_ID = parseUuid('76000000-0000-4000-8000-000000000011')!;
const EXPERIENCE_ID_2 = parseUuid('76000000-0000-4000-8000-000000000012')!;
const EXPERIENCE_ID_3 = parseUuid('76000000-0000-4000-8000-000000000013')!;
const EDUCATION_ID = parseUuid('76000000-0000-4000-8000-000000000021')!;
const EDUCATION_ID_2 = parseUuid('76000000-0000-4000-8000-000000000022')!;
const SKILL_ID = parseUuid('76000000-0000-4000-8000-000000000031')!;
const SKILL_ID_2 = parseUuid('76000000-0000-4000-8000-000000000032')!;
const LANGUAGE_ID = parseUuid('76000000-0000-4000-8000-000000000041')!;
const LANGUAGE_ID_2 = parseUuid('76000000-0000-4000-8000-000000000042')!;
const PROJECT_ID = parseUuid('76000000-0000-4000-8000-000000000051')!;
const PROJECT_ID_2 = parseUuid('76000000-0000-4000-8000-000000000052')!;
const PROJECT_ID_3 = parseUuid('76000000-0000-4000-8000-000000000053')!;
const PROJECT_ID_4 = parseUuid('76000000-0000-4000-8000-000000000054')!;
const ACHIEVEMENT_ID = parseUuid('76000000-0000-4000-8000-000000000061')!;
const ACHIEVEMENT_ID_2 = parseUuid('76000000-0000-4000-8000-000000000062')!;
const ACHIEVEMENT_ID_3 = parseUuid('76000000-0000-4000-8000-000000000063')!;
const ACHIEVEMENT_ID_4 = parseUuid('76000000-0000-4000-8000-000000000064')!;

function indexedId(namespace: '41' | '51' | '61', index: number): Uuid {
  return parseUuid(
    `76000000-0000-4000-8000-${namespace}${String(index + 1).padStart(10, '0')}`,
  )!;
}

type AuthorityOverrides = Readonly<{
  authorityState?: ProfileAuthorityStateV2;
  deletionEpoch?: DecimalString;
  factId?: Uuid;
  factRevision?: DecimalString;
  source?: ProfileFactSourceV2;
  confidence?: number | null;
  userConfirmedAt?: ProfileFieldAuthorityV2['meta']['userConfirmedAt'];
  sourceRef?: ProfileFieldAuthorityV2['meta']['sourceRef'];
}>;

function authority(overrides: AuthorityOverrides = {}): ProfileFieldAuthorityV2 {
  const authorityState = overrides.authorityState ?? 'USER_CONFIRMED';
  const source = overrides.source ?? 'USER';
  const defaultSourceRef: ProfileFieldAuthorityV2['meta']['sourceRef'] =
    authorityState === 'DERIVED_CONFIRMED' && source === 'DERIVED'
      ? {
          kind: 'DERIVATION',
          policyVersion: 'profile-v2-test' as never,
          evidenceFacts: [{ factId: EVIDENCE_FACT_ID, factRevision: '1' }],
        }
      : authorityState === 'LEGACY_CONFIRMED' && source === 'LEGACY_MIGRATION'
        ? { kind: 'LEGACY_PROFILE', migrationId: 'profile-v2-test' as never }
        : null;
  return {
    factId: overrides.factId ?? FACT_ID,
    factRevision: overrides.factRevision ?? '1',
    deletionEpoch: overrides.deletionEpoch ?? '4',
    meta: {
      source,
      authorityState,
      confidence: overrides.confidence ?? null,
      userConfirmedAt: overrides.userConfirmedAt !== undefined
        ? overrides.userConfirmedAt
        : authorityState === 'USER_CONFIRMED' && source === 'USER'
          ? '2026-09-04T00:00:00.000Z' as never
          : null,
      sourceRef: overrides.sourceRef !== undefined ? overrides.sourceRef : defaultSourceRef,
    },
  };
}

function authorityRecord<const Field extends string>(
  fields: readonly Field[],
  overrides: AuthorityOverrides = {},
): Record<Field, ProfileFieldAuthorityV2> {
  return Object.fromEntries(fields.map((field) => [field, authority(overrides)])) as Record<
    Field,
    ProfileFieldAuthorityV2
  >;
}

function defineOwnData<T extends object>(
  target: T,
  key: PropertyKey,
  value: unknown,
  enumerable = true,
): T {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable,
    value,
    writable: true,
  });
  return target;
}

function experience(
  id: Uuid = EXPERIENCE_ID,
  overrides: Partial<ProfileExperienceV2> = {},
): ProfileExperienceV2 {
  return {
    id,
    company: 'Analytical Engines' as never,
    title: 'Mathematician' as never,
    city: 'London' as never,
    region: 'England' as never,
    employmentType: 'FULL_TIME',
    startDate: { year: 2021, month: 3 },
    endDate: null,
    isCurrent: true,
    description: 'Must not enter the collection projection.' as never,
    factAuthorityByField: authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES),
    ...overrides,
  };
}

function education(overrides: Partial<ProfileEducationV2> = {}): ProfileEducationV2 {
  return {
    id: EDUCATION_ID,
    school: 'University of London' as never,
    degree: 'Bachelor of Science' as never,
    degreeLevel: 'BACHELOR',
    fieldOfStudy: 'Mathematics' as never,
    city: 'London' as never,
    region: 'England' as never,
    startDate: { year: 2017, month: 9 },
    endDate: { year: 2021, month: 6 },
    expectedGraduationDate: null,
    isCurrent: false,
    gpa: '3.9/4.0' as never,
    gpaScale: '4.0' as never,
    coursework: 'Must not enter the collection projection.' as never,
    factAuthorityByField: authorityRecord(PROFILE_V2_EDUCATION_FIELD_CODES),
    ...overrides,
  };
}

function skill(
  id: Uuid = SKILL_ID,
  overrides: Partial<ProfileSkillV2> = {},
): ProfileSkillV2 {
  return {
    id,
    name: 'TypeScript' as never,
    categories: ['TECHNICAL'],
    factAuthorityByField: authorityRecord(PROFILE_V2_SKILL_FIELD_CODES),
    ...overrides,
  };
}

function language(
  id: Uuid = LANGUAGE_ID,
  overrides: Partial<ProfileLanguageV2> = {},
): ProfileLanguageV2 {
  return {
    id,
    language: 'English' as never,
    proficiency: 'PROFESSIONAL',
    factAuthorityByField: authorityRecord(PROFILE_V2_LANGUAGE_FIELD_CODES),
    ...overrides,
  };
}

function project(
  id: Uuid = PROJECT_ID,
  overrides: Partial<ProfileProjectV2> = {},
): ProfileProjectV2 {
  return {
    id,
    title: 'Analytical Engine Notes' as never,
    organization: 'Independent' as never,
    role: 'Author' as never,
    location: 'London' as never,
    url: 'https://example.test/projects/analytical-engine' as never,
    startDate: { year: 2022, month: 1 },
    endDate: null,
    isCurrent: true,
    description: 'Documented a programmable mechanical computer.' as never,
    skillIds: [SKILL_ID],
    factAuthorityByField: authorityRecord(PROFILE_V2_PROJECT_FIELD_CODES),
    ...overrides,
  };
}

function achievement(
  id: Uuid = ACHIEVEMENT_ID,
  overrides: Partial<ProfileAchievementV2> = {},
): ProfileAchievementV2 {
  return {
    id,
    kind: 'PUBLICATION',
    title: 'Notes on the Analytical Engine' as never,
    statement: 'Published the first algorithm intended for machine execution.' as never,
    occurredAt: { year: 2023, month: null },
    url: 'https://example.test/achievements/analytical-engine-notes' as never,
    context: { type: 'PROJECT', itemId: PROJECT_ID },
    factAuthorityByField: authorityRecord(PROFILE_V2_ACHIEVEMENT_FIELD_CODES),
    ...overrides,
  };
}

function snapshot(overrides: Readonly<{
  revision?: DecimalString;
  deletionEpoch?: DecimalString;
  hasStoredProfile?: boolean;
  experiences?: readonly ProfileExperienceV2[];
  educations?: readonly ProfileEducationV2[];
  skills?: readonly ProfileSkillV2[];
  languages?: readonly ProfileLanguageV2[];
  projects?: readonly ProfileProjectV2[];
  achievements?: readonly ProfileAchievementV2[];
}> = {}): CandidateProfileSnapshotV2 {
  return {
    schemaVersion: 2,
    revision: overrides.revision ?? '9',
    deletionEpoch: overrides.deletionEpoch ?? '4',
    hasStoredProfile: overrides.hasStoredProfile ?? true,
    updatedAt: '2026-09-04T00:00:00.000Z' as never,
    profile: {
      experiences: overrides.experiences ?? [experience()],
      educations: overrides.educations ?? [education()],
      skills: overrides.skills ?? [skill()],
      languages: overrides.languages ?? [],
      projects: overrides.projects ?? [],
      achievements: overrides.achievements ?? [],
    },
  } as unknown as CandidateProfileSnapshotV2;
}

function input(
  candidate: CandidateProfileSnapshotV2,
  overrides: Partial<ProfileV2CollectionProjectionInput> = {},
): ProfileV2CollectionProjectionInput {
  return {
    authenticatedOwnerId: OWNER_ID,
    ownerBoundSnapshot: { ownerId: OWNER_ID, snapshot: candidate },
    expectedProfileRevision: candidate.revision,
    expectedDeletionEpoch: candidate.deletionEpoch,
    ...overrides,
  };
}

describe('Profile V2 -> existing ApplyProfileCollections adapter', () => {
  it('projects languages, projects and achievements from confirmed fields with stable UUID row keys', () => {
    const result = projectProfileV2Collections(input(snapshot({
      languages: [language()],
      projects: [project()],
      achievements: [achievement()],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.languages).toEqual([
      {
        rowKey: LANGUAGE_ID,
        value: { language: 'English', proficiency: 'PROFESSIONAL' },
      },
    ]);
    expect(result.value.rows.projects).toEqual([
      {
        rowKey: PROJECT_ID,
        value: {
          title: 'Analytical Engine Notes',
          organization: 'Independent',
          role: 'Author',
          location: 'London',
          url: 'https://example.test/projects/analytical-engine',
          startDate: { year: 2022, month: 1 },
          endDate: null,
          isCurrent: true,
          description: 'Documented a programmable mechanical computer.',
          skillIds: [SKILL_ID],
        },
      },
    ]);
    expect(result.value.rows.achievements).toEqual([
      {
        rowKey: ACHIEVEMENT_ID,
        value: {
          kind: 'PUBLICATION',
          title: 'Notes on the Analytical Engine',
          statement: 'Published the first algorithm intended for machine execution.',
          occurredAt: { year: 2023, month: null },
          url: 'https://example.test/achievements/analytical-engine-notes',
          context: { type: 'PROJECT', itemId: PROJECT_ID },
        },
      },
    ]);
    // 语言（2026-10-04）也进兼容视图：内核拿它答语言题（dict/languages.ts），不按行填。项目与成就仍只在行里。
    expect(result.value.collections).toEqual({
      experiences: [result.value.rows.experiences[0]?.value],
      educations: [result.value.rows.educations[0]?.value],
      skills: [result.value.rows.skills[0]?.value],
      languages: [{ language: 'English', proficiency: 'PROFESSIONAL' }],
    });
  });

  it('contains invalid new items without shifting surviving UUID rows or reading rejected values', () => {
    let rejectedReads = 0;
    const rejectedLanguage = Object.defineProperty(language(LANGUAGE_ID, {
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_LANGUAGE_FIELD_CODES),
        proficiency: authority({ authorityState: 'SUGGESTED', source: 'RESUME' }),
      },
    }), 'proficiency', {
      enumerable: true,
      get() {
        rejectedReads += 1;
        throw new Error('unconfirmed language value must not be read');
      },
    });
    const rejectedProject = Object.defineProperty(project(PROJECT_ID, {
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_PROJECT_FIELD_CODES),
        skillIds: authority({ deletionEpoch: '3' }),
      },
    }), 'skillIds', {
      enumerable: true,
      get() {
        rejectedReads += 1;
        throw new Error('stale project references must not be read');
      },
    });
    const rejectedAchievement = Object.defineProperty(achievement(ACHIEVEMENT_ID, {
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_ACHIEVEMENT_FIELD_CODES),
        context: authority({ authorityState: 'SUGGESTED', source: 'PORTAL' }),
      },
    }), 'context', {
      enumerable: true,
      get() {
        rejectedReads += 1;
        throw new Error('unconfirmed achievement context must not be read');
      },
    });

    const result = projectProfileV2Collections(input(snapshot({
      languages: [
        rejectedLanguage,
        language(LANGUAGE_ID_2, { language: 'French' as never }),
      ],
      projects: [
        rejectedProject,
        project(PROJECT_ID_2, { title: 'Stable project' as never }),
      ],
      achievements: [
        rejectedAchievement,
        achievement(ACHIEVEMENT_ID_2, {
          title: 'Stable achievement' as never,
          context: { type: 'STANDALONE', itemId: null },
        }),
      ],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.languages.map(({ rowKey }) => rowKey)).toEqual([LANGUAGE_ID_2]);
    expect(result.value.rows.projects.map(({ rowKey }) => rowKey)).toEqual([PROJECT_ID_2]);
    expect(result.value.rows.achievements.map(({ rowKey }) => rowKey)).toEqual([
      ACHIEVEMENT_ID_2,
    ]);
    expect(rejectedReads).toBe(0);
  });

  it('requires current confirmed authority for every non-null new collection field', () => {
    const result = projectProfileV2Collections(input(snapshot({
      languages: [language(LANGUAGE_ID, {
        factAuthorityByField: {
          ...authorityRecord(PROFILE_V2_LANGUAGE_FIELD_CODES),
          proficiency: authority({ authorityState: 'SUGGESTED', source: 'RESUME' }),
        },
      })],
      projects: [project(PROJECT_ID, {
        factAuthorityByField: {
          ...authorityRecord(PROFILE_V2_PROJECT_FIELD_CODES),
          skillIds: authority({ deletionEpoch: '3' }),
        },
      })],
      achievements: [achievement(ACHIEVEMENT_ID, {
        context: { type: 'STANDALONE', itemId: null },
        factAuthorityByField: {
          ...authorityRecord(PROFILE_V2_ACHIEVEMENT_FIELD_CODES),
          context: authority({ authorityState: 'USER_CONFIRMED', source: 'DERIVED' }),
        },
      })],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.languages).toEqual([]);
    expect(result.value.rows.projects).toEqual([]);
    expect(result.value.rows.achievements).toEqual([]);
  });

  it('does not read stale optional fields and emits no guessed replacement value', () => {
    let optionalReads = 0;
    const candidateProject = Object.defineProperties(project(PROJECT_ID, {
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_PROJECT_FIELD_CODES),
        url: authority({ deletionEpoch: '3' }),
        description: authority({ authorityState: 'SUGGESTED', source: 'RESUME' }),
      },
    }), {
      url: {
        enumerable: true,
        get() {
          optionalReads += 1;
          throw new Error('stale optional project URL must not be read');
        },
      },
      description: {
        enumerable: true,
        get() {
          optionalReads += 1;
          throw new Error('stale optional project description must not be read');
        },
      },
    });
    const candidateAchievement = Object.defineProperties(achievement(ACHIEVEMENT_ID, {
      context: { type: 'STANDALONE', itemId: null },
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_ACHIEVEMENT_FIELD_CODES),
        occurredAt: authority({ deletionEpoch: '3' }),
        url: authority({ authorityState: 'SUGGESTED', source: 'PORTAL' }),
      },
    }), {
      occurredAt: {
        enumerable: true,
        get() {
          optionalReads += 1;
          throw new Error('stale optional achievement date must not be read');
        },
      },
      url: {
        enumerable: true,
        get() {
          optionalReads += 1;
          throw new Error('unconfirmed optional achievement URL must not be read');
        },
      },
    });
    const result = projectProfileV2Collections(input(snapshot({
      projects: [candidateProject],
      achievements: [candidateAchievement],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.projects[0]?.value).toMatchObject({
      url: null,
      description: null,
    });
    expect(result.value.rows.achievements[0]?.value).toMatchObject({
      occurredAt: null,
      url: null,
    });
    expect(optionalReads).toBe(0);
  });

  it('preserves confirmed empty project skill references and rejects non-canonical references per item', () => {
    const result = projectProfileV2Collections(input(snapshot({
      skills: [skill(SKILL_ID), skill(SKILL_ID_2, { name: 'Rust' as never })],
      projects: [
        project(PROJECT_ID, { title: 'Empty refs' as never, skillIds: [] }),
        project(PROJECT_ID_2, {
          title: 'Unsorted refs' as never,
          skillIds: [SKILL_ID_2, SKILL_ID],
        }),
        project(PROJECT_ID_3, {
          title: 'Duplicate refs' as never,
          skillIds: [SKILL_ID, SKILL_ID],
        }),
        project(PROJECT_ID_4, {
          title: 'Dangling ref' as never,
          skillIds: [parseUuid('76000000-0000-4000-8000-000000000099')!],
        }),
      ],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.projects).toEqual([
      expect.objectContaining({
        rowKey: PROJECT_ID,
        value: expect.objectContaining({ skillIds: [] }),
      }),
    ]);
  });

  it('accepts only exact same-snapshot achievement contexts', () => {
    const result = projectProfileV2Collections(input(snapshot({
      projects: [project()],
      achievements: [
        achievement(ACHIEVEMENT_ID),
        achievement(ACHIEVEMENT_ID_2, {
          context: { type: 'EXPERIENCE', itemId: EXPERIENCE_ID },
        }),
        achievement(ACHIEVEMENT_ID_3, {
          context: { type: 'STANDALONE', itemId: null },
        }),
        achievement(ACHIEVEMENT_ID_4, {
          context: {
            type: 'EDUCATION',
            itemId: parseUuid('76000000-0000-4000-8000-000000000099')!,
          },
        }),
      ],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.achievements.map(({ rowKey }) => rowKey)).toEqual([
      ACHIEVEMENT_ID,
      ACHIEVEMENT_ID_2,
      ACHIEVEMENT_ID_3,
    ]);
  });

  it('captures a referenced item UUID once so descriptor drift cannot split identity', () => {
    let idReads = 0;
    const target = project(PROJECT_ID);
    const shiftingProject = new Proxy(target, {
      getOwnPropertyDescriptor(object, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
        if (property !== 'id' || descriptor === undefined) return descriptor;
        idReads += 1;
        return { ...descriptor, value: idReads === 1 ? PROJECT_ID : PROJECT_ID_2 };
      },
    });
    const result = projectProfileV2Collections(input(snapshot({
      projects: [shiftingProject],
      achievements: [achievement()],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(idReads).toBe(1);
    expect(result.value.rows.projects[0]?.rowKey).toBe(PROJECT_ID);
    expect(result.value.rows.achievements[0]?.value.context).toEqual({
      type: 'PROJECT',
      itemId: PROJECT_ID,
    });
  });

  it('validates new closed sets, bounds, URLs and dates without poisoning valid siblings', () => {
    const result = projectProfileV2Collections(input(snapshot({
      languages: [
        language(LANGUAGE_ID, { proficiency: 'FLUENT' as never }),
        language(LANGUAGE_ID_2, { language: 'French' as never }),
      ],
      projects: [
        project(PROJECT_ID, { title: 'x'.repeat(161) as never }),
        project(PROJECT_ID_2, {
          title: 'Safe project' as never,
          startDate: { year: 1899, month: 12 },
          url: 'https://user:secret@example.test/project' as never,
        }),
      ],
      achievements: [
        achievement(ACHIEVEMENT_ID, { kind: 'PRIZE' as never }),
        achievement(ACHIEVEMENT_ID_2, {
          title: 'Safe achievement' as never,
          occurredAt: { year: 1899, month: null },
          url: 'file:///tmp/evidence' as never,
          context: { type: 'STANDALONE', itemId: null },
        }),
      ],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.languages).toEqual([
      expect.objectContaining({ rowKey: LANGUAGE_ID_2 }),
    ]);
    expect(result.value.rows.projects).toEqual([
      expect.objectContaining({
        rowKey: PROJECT_ID_2,
        value: expect.objectContaining({ startDate: null, url: null }),
      }),
    ]);
    expect(result.value.rows.achievements).toEqual([
      expect.objectContaining({
        rowKey: ACHIEVEMENT_ID_2,
        value: expect.objectContaining({ occurredAt: null, url: null }),
      }),
    ]);
  });

  it('drops normalized duplicate languages while preserving an unrelated UUID row', () => {
    const result = projectProfileV2Collections(input(snapshot({
      languages: [
        language(LANGUAGE_ID, { language: 'English' as never }),
        language(LANGUAGE_ID_2, { language: '  ENGLISH  ' as never }),
        language(parseUuid('76000000-0000-4000-8000-000000000043')!, {
          language: 'French' as never,
        }),
      ],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.languages).toEqual([
      expect.objectContaining({
        rowKey: '76000000-0000-4000-8000-000000000043',
        value: { language: 'French', proficiency: 'PROFESSIONAL' },
      }),
    ]);
  });

  it('projects only experiences, educations and skills while preserving UUID row keys', () => {
    const result = projectProfileV2Collections(input(snapshot()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      ownerId: OWNER_ID,
      profileRevision: '9',
      deletionEpoch: '4',
      rows: {
        experiences: [{ rowKey: EXPERIENCE_ID }],
        educations: [{ rowKey: EDUCATION_ID }],
        skills: [{ rowKey: SKILL_ID }],
      },
    });
    expect(result.value.collections.experiences).toEqual([
      {
        company: 'Analytical Engines',
        title: 'Mathematician',
        employmentType: 'FULL_TIME',
        startDate: { year: 2021, month: 3 },
        endDate: null,
        location: null,
        isCurrent: true,
      },
    ]);
    expect(result.value.collections.educations).toEqual([
      {
        school: 'University of London',
        degreeLevel: 'BACHELOR',
        fieldOfStudy: 'Mathematics',
        startDate: { year: 2017, month: 9 },
        endDate: { year: 2021, month: 6 },
        location: null,
        gpa: '3.9/4.0',
        gpaScale: '4.0',
        isCurrent: false,
      },
    ]);
    expect(result.value.collections.skills).toEqual(['TypeScript']);
    expect(projectCollectionField(result.value.collections, 'skills.all', 0)).toEqual(['TypeScript']);
  });

  it.each([
    ['user-confirmed USER fact', 'USER_CONFIRMED', 'USER', true],
    ['derived-confirmed DERIVED fact', 'DERIVED_CONFIRMED', 'DERIVED', true],
    ['legacy-confirmed migration fact', 'LEGACY_CONFIRMED', 'LEGACY_MIGRATION', true],
    ['suggested Resume fact', 'SUGGESTED', 'RESUME', false],
    ['wrong source/state pairing', 'USER_CONFIRMED', 'DERIVED', false],
  ] as const)(
    'uses the executable confirmed-authority closed set for a %s',
    (_label, authorityState, source, accepted) => {
      const candidateExperience = experience(EXPERIENCE_ID, {
        factAuthorityByField: {
          ...authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES),
          company: authority({ authorityState, source }),
        },
      });

      const result = projectProfileV2Collections(input(snapshot({
        experiences: [candidateExperience],
      })));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rows.experiences).toHaveLength(accepted ? 1 : 0);
    },
  );

  it.each([
    [
      'non-canonical user confirmation time',
      authority({ userConfirmedAt: 'not-an-iso-time' as never }),
    ],
    [
      'derived confirmation without a derivation reference',
      authority({
        authorityState: 'DERIVED_CONFIRMED',
        source: 'DERIVED',
        sourceRef: null,
      }),
    ],
    [
      'malformed derivation reference payload',
      authority({
        authorityState: 'DERIVED_CONFIRMED',
        source: 'DERIVED',
        sourceRef: {
          kind: 'DERIVATION',
          policyVersion: 'contains whitespace' as never,
          evidenceFacts: [{ factId: EVIDENCE_FACT_ID, factRevision: '1' }],
        },
      }),
    ],
    [
      'malformed legacy reference payload',
      authority({
        authorityState: 'LEGACY_CONFIRMED',
        source: 'LEGACY_MIGRATION',
        sourceRef: {
          kind: 'LEGACY_PROFILE',
          migrationId: 'contains whitespace' as never,
        },
      }),
    ],
    [
      'self-referential derivation evidence',
      authority({
        authorityState: 'DERIVED_CONFIRMED',
        source: 'DERIVED',
        sourceRef: {
          kind: 'DERIVATION',
          policyVersion: 'profile-v2-test' as never,
          evidenceFacts: [{ factId: FACT_ID, factRevision: '1' }],
        },
      }),
    ],
    [
      'duplicate derivation evidence',
      authority({
        authorityState: 'DERIVED_CONFIRMED',
        source: 'DERIVED',
        sourceRef: {
          kind: 'DERIVATION',
          policyVersion: 'profile-v2-test' as never,
          evidenceFacts: [
            { factId: EVIDENCE_FACT_ID, factRevision: '1' },
            { factId: EVIDENCE_FACT_ID, factRevision: '1' },
          ],
        },
      }),
    ],
    [
      'non-canonical derivation evidence order',
      authority({
        authorityState: 'DERIVED_CONFIRMED',
        source: 'DERIVED',
        sourceRef: {
          kind: 'DERIVATION',
          policyVersion: 'profile-v2-test' as never,
          evidenceFacts: [
            { factId: EVIDENCE_FACT_ID_2, factRevision: '1' },
            { factId: EVIDENCE_FACT_ID, factRevision: '1' },
          ],
        },
      }),
    ],
  ] as const)('rejects a confirmed authority with %s', (_label, companyAuthority) => {
    const result = projectProfileV2Collections(input(snapshot({
      experiences: [experience(EXPERIENCE_ID, {
        factAuthorityByField: {
          ...authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES),
          company: companyAuthority,
        },
      })],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([]);
  });

  it.each([
    [
      'an extra authority key',
      defineOwnData(authority(), 'extra', true),
    ],
    [
      'an authority symbol key',
      defineOwnData(authority(), Symbol('authority-extra'), true),
    ],
    [
      'a non-enumerable authority field',
      defineOwnData(authority(), 'factRevision', '1', false),
    ],
    [
      'an extra meta key',
      (() => {
        const candidate = authority();
        defineOwnData(candidate.meta, 'extra', true);
        return candidate;
      })(),
    ],
    [
      'a meta symbol key',
      (() => {
        const candidate = authority();
        defineOwnData(candidate.meta, Symbol('meta-extra'), true);
        return candidate;
      })(),
    ],
    [
      'a non-enumerable meta field',
      (() => {
        const candidate = authority();
        defineOwnData(candidate.meta, 'source', 'USER', false);
        return candidate;
      })(),
    ],
  ] as const)('contains %s to the malformed item', (_label, companyAuthority) => {
    const result = projectProfileV2Collections(input(snapshot({
      experiences: [
        experience(EXPERIENCE_ID, {
          factAuthorityByField: {
            ...authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES),
            company: companyAuthority,
          },
        }),
        experience(EXPERIENCE_ID_2),
      ],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([
      expect.objectContaining({ rowKey: EXPERIENCE_ID_2 }),
    ]);
  });

  it.each([
    [
      'an extra string key',
      defineOwnData(
        [{ factId: EVIDENCE_FACT_ID, factRevision: '1' }],
        'extra',
        true,
      ),
    ],
    [
      'a symbol key',
      defineOwnData(
        [{ factId: EVIDENCE_FACT_ID, factRevision: '1' }],
        Symbol('evidence-extra'),
        true,
      ),
    ],
    [
      'a non-enumerable index',
      defineOwnData(
        [{ factId: EVIDENCE_FACT_ID, factRevision: '1' }],
        '0',
        { factId: EVIDENCE_FACT_ID, factRevision: '1' },
        false,
      ),
    ],
  ] as const)('contains a derivation evidence array with %s', (_label, evidenceFacts) => {
    const companyAuthority = authority({
      authorityState: 'DERIVED_CONFIRMED',
      source: 'DERIVED',
      sourceRef: {
        kind: 'DERIVATION',
        policyVersion: 'profile-v2-test' as never,
        evidenceFacts,
      } as never,
    });
    const result = projectProfileV2Collections(input(snapshot({
      experiences: [
        experience(EXPERIENCE_ID, {
          factAuthorityByField: {
            ...authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES),
            company: companyAuthority,
          },
        }),
        experience(EXPERIENCE_ID_2),
      ],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([
      expect.objectContaining({ rowKey: EXPERIENCE_ID_2 }),
    ]);
  });

  it('rejects a foreign owner before reading any Profile value', () => {
    let snapshotReads = 0;
    const ownerBoundSnapshot = Object.defineProperty(
      { ownerId: FOREIGN_OWNER_ID },
      'snapshot',
      {
        enumerable: true,
        get() {
          snapshotReads += 1;
          throw new Error('must not read Data-L1 after owner rejection');
        },
      },
    );

    const result = projectProfileV2Collections({
      authenticatedOwnerId: OWNER_ID,
      ownerBoundSnapshot:
        ownerBoundSnapshot as ProfileV2CollectionProjectionInput['ownerBoundSnapshot'],
      expectedProfileRevision: '9',
      expectedDeletionEpoch: '4',
    });

    expect(result).toEqual({ ok: false, reasonCode: 'PROFILE_SOURCE_OWNER_MISMATCH' });
    expect(snapshotReads).toBe(0);
  });

  it.each([
    ['revision', 'PROFILE_SOURCE_REVISION_STALE'],
    ['deletionEpoch', 'PROFILE_SOURCE_DELETION_EPOCH_STALE'],
    ['hasStoredProfile', 'PROFILE_V2_COLLECTION_SNAPSHOT_INVALID'],
    ['profile', 'PROFILE_V2_COLLECTION_SNAPSHOT_INVALID'],
  ] as const)('rejects a root %s accessor without reading it', (field, reasonCode) => {
    let reads = 0;
    const candidate = Object.defineProperty(snapshot(), field, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('root snapshot accessors are not current-fence evidence');
      },
    });

    const result = projectProfileV2Collections({
      authenticatedOwnerId: OWNER_ID,
      ownerBoundSnapshot: { ownerId: OWNER_ID, snapshot: candidate },
      expectedProfileRevision: '9',
      expectedDeletionEpoch: '4',
    });

    expect(result).toEqual({ ok: false, reasonCode });
    expect(reads).toBe(0);
  });

  it.each([
    ['stale revision', { expectedProfileRevision: '10' }, 'PROFILE_SOURCE_REVISION_STALE'],
    [
      'non-canonical revision',
      { expectedProfileRevision: '09' as unknown as DecimalString },
      'PROFILE_SOURCE_REVISION_STALE',
    ],
    [
      'stale deletion epoch',
      { expectedDeletionEpoch: '5' },
      'PROFILE_SOURCE_DELETION_EPOCH_STALE',
    ],
    [
      'non-canonical deletion epoch',
      { expectedDeletionEpoch: '04' as unknown as DecimalString },
      'PROFILE_SOURCE_DELETION_EPOCH_STALE',
    ],
  ] as const)('fails closed for %s', (_label, overrides, reasonCode) => {
    const candidate = snapshot();
    const result = projectProfileV2Collections(input(candidate, overrides));

    expect(result).toEqual({ ok: false, reasonCode });
    expect('value' in result).toBe(false);
  });

  it('rejects a stale root fence before reading any new collection', () => {
    let languageReads = 0;
    const candidate = snapshot();
    Object.defineProperty(candidate.profile, 'languages', {
      enumerable: true,
      get() {
        languageReads += 1;
        throw new Error('stale root must stop before collection values');
      },
    });

    expect(projectProfileV2Collections(input(candidate, {
      expectedProfileRevision: '10',
    }))).toEqual({ ok: false, reasonCode: 'PROFILE_SOURCE_REVISION_STALE' });
    expect(languageReads).toBe(0);
  });

  it.each([
    [
      'missing',
      snapshot({ revision: '0', deletionEpoch: '0', hasStoredProfile: false }),
      'PROFILE_SOURCE_PROFILE_MISSING',
    ],
    [
      'deleted',
      snapshot({ revision: '0', deletionEpoch: '4', hasStoredProfile: false }),
      'PROFILE_SOURCE_PROFILE_DELETED',
    ],
  ] as const)('never revives values from a %s Profile', (_label, candidate, reasonCode) => {
    expect(projectProfileV2Collections(input(candidate))).toEqual({ ok: false, reasonCode });
  });

  it('degrades unconfirmed or stale fields per item without shifting the surviving UUID identity', () => {
    const rejectedAnchor = experience(EXPERIENCE_ID, {
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES),
        company: authority({ authorityState: 'SUGGESTED', source: 'RESUME' }),
      },
    });
    const rejectedCurrent = experience(EXPERIENCE_ID_3, {
      company: 'Unconfirmed Current State' as never,
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES),
        isCurrent: authority({ authorityState: 'SUGGESTED', source: 'PORTAL' }),
      },
    });
    let rejectedTitleReads = 0;
    const surviving = Object.defineProperty(experience(EXPERIENCE_ID_2, {
      company: 'Difference Engine' as never,
      isCurrent: false,
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES),
        title: authority({ deletionEpoch: '3' }),
        employmentType: authority({ factRevision: '0' }),
      },
    }), 'title', {
      enumerable: true,
      get() {
        rejectedTitleReads += 1;
        throw new Error('unconfirmed Data-L1 field must not be read');
      },
    });

    const result = projectProfileV2Collections(input(snapshot({
      experiences: [rejectedAnchor, rejectedCurrent, surviving],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([
      {
        rowKey: EXPERIENCE_ID_2,
        value: {
          company: 'Difference Engine',
          title: null,
          employmentType: null,
          startDate: { year: 2021, month: 3 },
          endDate: null,
          location: null,
          isCurrent: false,
        },
      },
    ]);
    expect(rejectedTitleReads).toBe(0);
    expect(result.value.rows.experiences[0]?.rowKey).not.toBe('0');
  });

  it.each([
    ['languages', () => language(), ['language', 'proficiency']],
    ['projects', () => project(), ['title', 'isCurrent', 'skillIds']],
    ['achievements', () => achievement(), ['kind', 'title', 'statement', 'context']],
  ] as const)('single-captures %s authority before any candidate decision', (collection, makeItem, fields) => {
    let mapReads = 0;
    const hostile = new Proxy(makeItem(), {
      getOwnPropertyDescriptor(target, key) {
        if (key !== 'factAuthorityByField') return Reflect.getOwnPropertyDescriptor(target, key);
        const field = fields[mapReads % fields.length]!;
        mapReads += 1;
        return { configurable: true, enumerable: true, writable: true, value: { [field]: authority() } };
      },
    });
    const result = projectProfileV2Collections(input(snapshot({
      projects: [project()],
      [collection]: [hostile],
    })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows[collection]).toEqual([]);
    expect(mapReads).toBe(1);
  });

  it('single-captures shared project skill references and achievement contexts', () => {
    let skillReads = 0;
    const skillIds = new Proxy([SKILL_ID], {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== '0' || descriptor === undefined) return descriptor;
        skillReads += 1;
        return { ...descriptor, value: skillReads === 1 ? SKILL_ID : SKILL_ID_2 };
      },
    });
    let contextReads = 0;
    const context = new Proxy({ type: 'PROJECT' as const, itemId: PROJECT_ID }, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== 'itemId' || descriptor === undefined) return descriptor;
        contextReads += 1;
        return { ...descriptor, value: contextReads === 1 ? PROJECT_ID : PROJECT_ID_2 };
      },
    });
    const result = projectProfileV2Collections(input(snapshot({
      skills: [skill(SKILL_ID), skill(SKILL_ID_2)],
      projects: [project(PROJECT_ID, { skillIds }), project(PROJECT_ID_2, { skillIds })],
      achievements: [achievement(ACHIEVEMENT_ID, { context }), achievement(ACHIEVEMENT_ID_2, { context })],
    })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.projects.map(({ value }) => value.skillIds)).toEqual([[SKILL_ID], [SKILL_ID]]);
    expect(result.value.rows.achievements.map(({ value }) => value.context)).toEqual([
      { type: 'PROJECT', itemId: PROJECT_ID }, { type: 'PROJECT', itemId: PROJECT_ID },
    ]);
    expect(skillReads).toBe(1);
    expect(contextReads).toBe(1);
  });

  it('single-captures an item authority map before making any field authority decision', () => {
    const fieldSequence = [
      'company',
      'isCurrent',
      'startDate',
      'endDate',
      'title',
      'employmentType',
    ] as const;
    let authorityMapDescriptorReads = 0;
    const hostile = new Proxy(experience(), {
      getOwnPropertyDescriptor(target, property) {
        if (property !== 'factAuthorityByField') {
          return Reflect.getOwnPropertyDescriptor(target, property);
        }
        const field = fieldSequence[authorityMapDescriptorReads % fieldSequence.length]!;
        authorityMapDescriptorReads += 1;
        return {
          configurable: true,
          enumerable: true,
          value: { [field]: authority() },
          writable: true,
        };
      },
    });

    const result = projectProfileV2Collections(input(snapshot({ experiences: [hostile] })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([]);
    expect(result.value.collections.experiences).toBeUndefined();
    expect(authorityMapDescriptorReads).toBe(1);
  });

  it('does not let candidate descriptor traps upgrade a captured authority', () => {
    let authorityStateDescriptorReads = 0;
    let dateYearDescriptorReads = 0;
    const metaTarget = authority({
      authorityState: 'SUGGESTED',
      source: 'RESUME',
    }).meta;
    const hostileMeta = new Proxy(metaTarget, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'authorityState') authorityStateDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const companyAuthority = {
      ...authority({ authorityState: 'SUGGESTED', source: 'RESUME' }),
      meta: hostileMeta,
    };
    const hostileDate = new Proxy({ year: 2021, month: 3 }, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'year') {
          dateYearDescriptorReads += 1;
          Reflect.set(metaTarget, 'source', 'USER');
          Reflect.set(metaTarget, 'authorityState', 'USER_CONFIRMED');
          Reflect.set(metaTarget, 'userConfirmedAt', '2026-09-04T00:00:00.000Z');
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const result = projectProfileV2Collections(input(snapshot({
      experiences: [experience(EXPERIENCE_ID, {
        startDate: hostileDate,
        factAuthorityByField: {
          ...authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES),
          company: companyAuthority,
        },
      })],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([]);
    expect(authorityStateDescriptorReads).toBe(1);
    expect(dateYearDescriptorReads).toBe(1);
  });

  it('captures authority before a top-level candidate descriptor can mutate it', () => {
    let authorityStateDescriptorReads = 0;
    let companyDescriptorReads = 0;
    const metaTarget = authority({
      authorityState: 'SUGGESTED',
      source: 'RESUME',
    }).meta;
    const hostileMeta = new Proxy(metaTarget, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'authorityState') authorityStateDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const companyAuthority = {
      ...authority({ authorityState: 'SUGGESTED', source: 'RESUME' }),
      meta: hostileMeta,
    };
    const target = experience(EXPERIENCE_ID, {
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES),
        company: companyAuthority,
      },
    });
    const hostileItem = new Proxy(target, {
      getOwnPropertyDescriptor(candidate, property) {
        if (property === 'company') {
          companyDescriptorReads += 1;
          Reflect.set(metaTarget, 'source', 'USER');
          Reflect.set(metaTarget, 'authorityState', 'USER_CONFIRMED');
          Reflect.set(metaTarget, 'userConfirmedAt', '2026-09-04T00:00:00.000Z');
        }
        return Reflect.getOwnPropertyDescriptor(candidate, property);
      },
    });

    const result = projectProfileV2Collections(input(snapshot({ experiences: [hostileItem] })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([]);
    expect(authorityStateDescriptorReads).toBe(1);
    expect(companyDescriptorReads).toBe(1);
  });

  it('single-captures an aliased authority object and its meta object', () => {
    let authorityFactIdDescriptorReads = 0;
    let metaSourceDescriptorReads = 0;
    const base = authority();
    const sharedMeta = new Proxy(base.meta, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'source') metaSourceDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const sharedAuthority = new Proxy({ ...base, meta: sharedMeta }, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'factId') authorityFactIdDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const factAuthorityByField = authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES);
    for (const field of [
      'company',
      'title',
      'employmentType',
      'startDate',
      'endDate',
      'isCurrent',
    ] as const) {
      factAuthorityByField[field] = sharedAuthority;
    }

    const result = projectProfileV2Collections(input(snapshot({
      experiences: [experience(EXPERIENCE_ID, { factAuthorityByField })],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toHaveLength(1);
    expect(authorityFactIdDescriptorReads).toBe(1);
    expect(metaSourceDescriptorReads).toBe(1);
  });

  it('single-captures an aliased derivation sourceRef and evidence array', () => {
    let sourceRefKindDescriptorReads = 0;
    let evidenceLengthDescriptorReads = 0;
    const evidenceFacts = new Proxy(
      [{ factId: EVIDENCE_FACT_ID, factRevision: '1' }],
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === 'length') evidenceLengthDescriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    const sharedSourceRef = new Proxy({
      kind: 'DERIVATION' as const,
      policyVersion: 'profile-v2-test' as never,
      evidenceFacts,
    }, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'kind') sourceRefKindDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const factAuthorityByField = authorityRecord(PROFILE_V2_EXPERIENCE_FIELD_CODES);
    for (const field of [
      'company',
      'title',
      'employmentType',
      'startDate',
      'endDate',
      'isCurrent',
    ] as const) {
      factAuthorityByField[field] = authority({
        authorityState: 'DERIVED_CONFIRMED',
        source: 'DERIVED',
        sourceRef: sharedSourceRef as never,
      });
    }

    const result = projectProfileV2Collections(input(snapshot({
      experiences: [experience(EXPERIENCE_ID, { factAuthorityByField })],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toHaveLength(1);
    expect(sourceRefKindDescriptorReads).toBe(1);
    expect(evidenceLengthDescriptorReads).toBe(1);
  });

  it.each([
    ['missing month', { year: 2021 }],
    ['out-of-range month', { year: 2021, month: 13 }],
  ] as const)('degrades a strictly malformed Profile V2 %s date field to null', (_label, startDate) => {
    const candidateExperience = experience(EXPERIENCE_ID, {
      startDate: startDate as never,
    });

    const result = projectProfileV2Collections(input(snapshot({
      experiences: [candidateExperience],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([
      expect.objectContaining({
        rowKey: EXPERIENCE_ID,
        value: expect.objectContaining({ startDate: null }),
      }),
    ]);
  });

  it.each([
    ['an extra string key', defineOwnData({ year: 2021, month: 3 }, 'extra', true)],
    [
      'a symbol key',
      defineOwnData({ year: 2021, month: 3 }, Symbol('date-extra'), true),
    ],
    [
      'a non-enumerable month',
      defineOwnData({ year: 2021, month: 3 }, 'month', 3, false),
    ],
  ] as const)('degrades a DatePart with %s to null', (_label, startDate) => {
    const result = projectProfileV2Collections(input(snapshot({
      experiences: [experience(EXPERIENCE_ID, { startDate: startDate as never })],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([
      expect.objectContaining({
        rowKey: EXPERIENCE_ID,
        value: expect.objectContaining({ startDate: null }),
      }),
    ]);
  });

  it('never re-reads a hostile DatePart accessor after validation', () => {
    let monthReads = 0;
    const hostileDate = Object.defineProperty({ year: 2021 }, 'month', {
      enumerable: true,
      get() {
        monthReads += 1;
        return monthReads === 1 ? 1 : 13;
      },
    });
    const result = projectProfileV2Collections(input(snapshot({
      experiences: [experience(EXPERIENCE_ID, { startDate: hostileDate as never })],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences[0]?.value.startDate).toBeNull();
    expect(monthReads).toBe(0);
  });

  it('rejects Profile V2 C0/C1 text without poisoning valid sibling rows', () => {
    const result = projectProfileV2Collections(input(snapshot({
      experiences: [
        experience(EXPERIENCE_ID, { company: 'Unsafe\u0000Company' as never }),
        experience(EXPERIENCE_ID_2, { title: 'Unsafe\nTitle' as never }),
      ],
      educations: [
        education({ school: 'Unsafe\u0085School' as never }),
        education({ id: EDUCATION_ID_2 }),
      ],
      skills: [
        skill(SKILL_ID, { name: 'Unsafe\tSkill' as never }),
        skill(SKILL_ID_2),
      ],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([
      expect.objectContaining({
        rowKey: EXPERIENCE_ID_2,
        value: expect.objectContaining({ title: null }),
      }),
    ]);
    expect(result.value.rows.educations).toEqual([
      expect.objectContaining({ rowKey: EDUCATION_ID_2 }),
    ]);
    expect(result.value.rows.skills).toEqual([
      { rowKey: SKILL_ID_2, value: 'TypeScript' },
    ]);
  });

  it.each([
    [
      'experiences',
      snapshot({ experiences: Array.from({ length: PROFILE_V2_COLLECTION_LIMITS.experiences + 1 }, () => experience()) }),
    ],
    [
      'educations',
      snapshot({ educations: Array.from({ length: PROFILE_V2_COLLECTION_LIMITS.educations + 1 }, () => education()) }),
    ],
    [
      'skills',
      snapshot({ skills: Array.from({ length: PROFILE_V2_COLLECTION_LIMITS.skills + 1 }, () => skill()) }),
    ],
    [
      'languages',
      snapshot({ languages: Array.from({ length: PROFILE_V2_COLLECTION_LIMITS.languages + 1 }, () => language()) }),
    ],
    [
      'projects',
      snapshot({ projects: Array.from({ length: PROFILE_V2_COLLECTION_LIMITS.projects + 1 }, () => project()) }),
    ],
    [
      // 上限 2026-09 从 60 提到 100（argoland 契约变更：一份完整的作品集每段
      // 经历/项目都可能带好几条成果）。这里跟着上限走，不是跟着那个数字走。
      'achievements',
      snapshot({ achievements: Array.from({ length: PROFILE_V2_COLLECTION_LIMITS.achievements + 1 }, () => achievement()) }),
    ],
  ] as const)('rejects an oversized %s collection before projection', (_label, candidate) => {
    expect(projectProfileV2Collections(input(candidate))).toEqual({
      ok: false,
      reasonCode: 'PROFILE_V2_COLLECTION_SNAPSHOT_INVALID',
    });
  });

  it.each([
    [
      'languages',
      snapshot({
        languages: Array.from({ length: 20 }, (_, index) => language(
          indexedId('41', index),
          { language: `Language ${index + 1}` as never },
        )),
      }),
      20,
    ],
    [
      'projects',
      snapshot({
        projects: Array.from({ length: 20 }, (_, index) =>
          project(indexedId('51', index))),
      }),
      20,
    ],
    [
      'achievements',
      snapshot({
        achievements: Array.from({ length: 60 }, (_, index) => achievement(
          indexedId('61', index),
          { context: { type: 'STANDALONE', itemId: null } },
        )),
      }),
      60,
    ],
  ] as const)('accepts and projects the exact %s collection limit', (collection, candidate, count) => {
    const result = projectProfileV2Collections(input(candidate));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows[collection]).toHaveLength(count);
  });

  it.each(['languages', 'projects', 'achievements'] as const)(
    'rejects an accessor-backed %s item before reading the accessor',
    (collection) => {
      let reads = 0;
      const values = Object.defineProperty([{}], 0, {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error('collection accessor must not be read');
        },
      });
      const candidate = snapshot({ [collection]: values } as never);

      expect(projectProfileV2Collections(input(candidate))).toEqual({
        ok: false,
        reasonCode: 'PROFILE_V2_COLLECTION_SNAPSHOT_INVALID',
      });
      expect(reads).toBe(0);
    },
  );

  it('rejects sparse or accessor-backed collection entries without reading accessors', () => {
    const sparse = new Array<ProfileExperienceV2>(2);
    sparse[1] = experience(EXPERIENCE_ID_2);
    expect(projectProfileV2Collections(input(snapshot({ experiences: sparse })))).toEqual({
      ok: false,
      reasonCode: 'PROFILE_V2_COLLECTION_SNAPSHOT_INVALID',
    });

    let itemReads = 0;
    const accessorBacked = Object.defineProperty([experience()], 0, {
      enumerable: true,
      get() {
        itemReads += 1;
        throw new Error('collection item accessor must not be read');
      },
    });
    expect(projectProfileV2Collections(input(snapshot({
      experiences: accessorBacked,
    })))).toEqual({
      ok: false,
      reasonCode: 'PROFILE_V2_COLLECTION_SNAPSHOT_INVALID',
    });
    expect(itemReads).toBe(0);
  });

  it.each([
    [
      'an extra string key',
      defineOwnData([experience()], 'extra', true),
    ],
    [
      'a symbol key',
      defineOwnData([experience()], Symbol('collection-extra'), true),
    ],
    [
      'a non-enumerable index',
      defineOwnData([experience()], '0', experience(), false),
    ],
  ] as const)('rejects a collection array with %s', (_label, experiences) => {
    expect(projectProfileV2Collections(input(snapshot({ experiences })))).toEqual({
      ok: false,
      reasonCode: 'PROFILE_V2_COLLECTION_SNAPSHOT_INVALID',
    });
  });

  it.each([
    [
      'reversed confirmed range',
      experience(EXPERIENCE_ID, {
        startDate: { year: 2025, month: 1 },
        endDate: { year: 2024, month: 12 },
        isCurrent: false,
      }),
    ],
    [
      'current row with confirmed end date',
      experience(EXPERIENCE_ID, {
        endDate: { year: 2024, month: 12 },
        isCurrent: true,
      }),
    ],
  ] as const)('contains a %s violation to its item', (_label, invalidExperience) => {
    const result = projectProfileV2Collections(input(snapshot({
      experiences: [invalidExperience, experience(EXPERIENCE_ID_2)],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([
      expect.objectContaining({ rowKey: EXPERIENCE_ID_2 }),
    ]);
  });

  it('does not infer location or revive malformed dates, and one bad education field does not poison siblings', () => {
    const candidateEducation = education({
      startDate: { year: 9999, month: 1 },
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_EDUCATION_FIELD_CODES),
        gpa: authority({ factId: 'not-a-uuid' as Uuid }),
      },
    });

    const result = projectProfileV2Collections(input(snapshot({ educations: [candidateEducation] })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.educations).toEqual([
      {
        rowKey: EDUCATION_ID,
        value: {
          school: 'University of London',
          degreeLevel: 'BACHELOR',
          fieldOfStudy: 'Mathematics',
          startDate: null,
          endDate: { year: 2021, month: 6 },
          location: null,
          gpa: null,
          gpaScale: '4.0',
          isCurrent: false,
        },
      },
    ]);
  });

  it('admits a skill only from its own current confirmed name authority and keeps its UUID', () => {
    const confirmedName = skill(SKILL_ID, {
      factAuthorityByField: {
        name: authority(),
        categories: authority({ authorityState: 'SUGGESTED', source: 'RESUME' }),
      },
    });
    const staleName = skill(SKILL_ID_2, {
      name: 'Rust' as never,
      factAuthorityByField: {
        name: authority({ deletionEpoch: '3' }),
        categories: authority(),
      },
    });

    const result = projectProfileV2Collections(input(snapshot({ skills: [confirmedName, staleName] })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.skills).toEqual([{ rowKey: SKILL_ID, value: 'TypeScript' }]);
    expect(result.value.collections.skills).toEqual(['TypeScript']);
  });

  it('drops every duplicate UUID instead of choosing an item by array position', () => {
    const result = projectProfileV2Collections(input(snapshot({
      experiences: [
        experience(EXPERIENCE_ID, { company: 'First' as never }),
        experience(EXPERIENCE_ID, { company: 'Second' as never }),
        experience(EXPERIENCE_ID_2, { company: 'Stable' as never }),
      ],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.experiences).toEqual([
      expect.objectContaining({ rowKey: EXPERIENCE_ID_2 }),
    ]);
    expect(result.value.collections.experiences?.map(({ company }) => company)).toEqual(['Stable']);
  });

  it('drops duplicate UUIDs from each new collection while keeping unique siblings', () => {
    const result = projectProfileV2Collections(input(snapshot({
      languages: [
        language(LANGUAGE_ID, { language: 'English' as never }),
        language(LANGUAGE_ID, { language: 'French' as never }),
        language(LANGUAGE_ID_2, { language: 'Spanish' as never }),
      ],
      projects: [
        project(PROJECT_ID, { title: 'First duplicate' as never }),
        project(PROJECT_ID, { title: 'Second duplicate' as never }),
        project(PROJECT_ID_2, { title: 'Stable project' as never }),
      ],
      achievements: [
        achievement(ACHIEVEMENT_ID, { context: { type: 'STANDALONE', itemId: null } }),
        achievement(ACHIEVEMENT_ID, { context: { type: 'STANDALONE', itemId: null } }),
        achievement(ACHIEVEMENT_ID_2, {
          title: 'Stable achievement' as never,
          context: { type: 'STANDALONE', itemId: null },
        }),
      ],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.languages.map(({ rowKey }) => rowKey)).toEqual([LANGUAGE_ID_2]);
    expect(result.value.rows.projects.map(({ rowKey }) => rowKey)).toEqual([PROJECT_ID_2]);
    expect(result.value.rows.achievements.map(({ rowKey }) => rowKey)).toEqual([
      ACHIEVEMENT_ID_2,
    ]);
  });

  it('freezes new keyed values and their nested reference/date objects', () => {
    const result = projectProfileV2Collections(input(snapshot({
      languages: [language()],
      projects: [project()],
      achievements: [achievement()],
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value.rows)).toBe(true);
    expect(Object.isFrozen(result.value.rows.languages)).toBe(true);
    expect(Object.isFrozen(result.value.rows.languages[0]?.value)).toBe(true);
    expect(Object.isFrozen(result.value.rows.projects[0]?.value)).toBe(true);
    expect(Object.isFrozen(result.value.rows.projects[0]?.value.skillIds)).toBe(true);
    expect(Object.isFrozen(result.value.rows.projects[0]?.value.startDate)).toBe(true);
    expect(Object.isFrozen(result.value.rows.achievements[0]?.value)).toBe(true);
    expect(Object.isFrozen(result.value.rows.achievements[0]?.value.context)).toBe(true);
    expect(Object.isFrozen(result.value.rows.achievements[0]?.value.occurredAt)).toBe(true);
  });
});

/**
 * 在读学生的毕业时间（2026-10-01 argoland 交接清单第 1 件）：档案的保存规则是在读（`isCurrent: true`）时 `endDate`
 * 必须为空、毕业时间存在 `expectedGraduationDate`——门户手填的在读学生、资料页新加的「在读」勾选、简历上写
 * 「Expected May 2027」的导入（argoland #697）都这样存。从前内核只读 `endDate`，申请表上的毕业时间是空的。
 */
describe('在读学生的毕业时间：endDate 为空用 expectedGraduationDate', () => {
  const current = (overrides: Partial<ProfileEducationV2> = {}) => education({
    startDate: { year: 2023, month: 9 },
    endDate: null,
    expectedGraduationDate: { year: 2027, month: 5 },
    isCurrent: true,
    ...overrides,
  });
  const project = (educations: readonly ProfileEducationV2[]) => {
    const result = projectProfileV2Collections(input(snapshot({ educations })));
    if (!result.ok) throw new Error(`projection rejected: ${result.reasonCode}`);
    return result.value.collections;
  };
  /** 同一个日期当作实际毕业时间时填出来的样子：在读学生的毕业时间要与它一字不差。 */
  const asIfGraduated = (year: number, month: number | null) => parseApplyProfileCollections({
    educations: [{ school: 'University of London', endDate: { year, month }, isCurrent: false }],
  });

  it('在读、确认过：毕业年、月、整段日期都按预计毕业时间填', () => {
    const collections = project([current()]);
    expect(collections.educations?.[0]?.expectedGraduationDate).toEqual({ year: 2027, month: 5 });
    const graduated = asIfGraduated(2027, 5);
    for (const role of ['education.endYear', 'education.endMonth', 'education.endDate'] as const) {
      expect(projectCollectionField(collections, role, 0)).not.toEqual([]);
      expect(projectCollectionField(collections, role, 0)).toEqual(projectCollectionField(graduated, role, 0));
    }
    expect(projectCollectionField(collections, 'education.endYear', 0)).toEqual(['2027']);
  });

  it('只有年份也照填年份', () => {
    const collections = project([current({ expectedGraduationDate: { year: 2028, month: null } })]);
    expect(projectCollectionField(collections, 'education.endYear', 0)).toEqual(['2028']);
    expect(projectCollectionField(collections, 'education.endMonth', 0)).toEqual([]);
  });

  it('预计毕业时间没确认（简历建议）：不用，毕业时间照旧空着', () => {
    const collections = project([current({
      factAuthorityByField: {
        ...authorityRecord(PROFILE_V2_EDUCATION_FIELD_CODES),
        expectedGraduationDate: authority({ authorityState: 'SUGGESTED', source: 'RESUME' }),
      },
    })]);
    expect(collections.educations).toHaveLength(1);
    expect(collections.educations?.[0]?.expectedGraduationDate).toBeUndefined();
    expect(projectCollectionField(collections, 'education.endYear', 0)).toEqual([]);
  });

  it('早于入学的预计毕业时间是脏数据：只丢这一格，整段照常', () => {
    const collections = project([current({ expectedGraduationDate: { year: 2022, month: 1 } })]);
    expect(collections.educations).toHaveLength(1);
    expect(projectCollectionField(collections, 'education.school', 0)).toEqual(['University of London']);
    expect(projectCollectionField(collections, 'education.endYear', 0)).toEqual([]);
  });

  it('已经毕业的照旧用实际毕业时间；没有预计毕业时间的不出这个键', () => {
    const collections = project([education()]);
    expect(collections.educations?.[0]).not.toHaveProperty('expectedGraduationDate');
    expect(projectCollectionField(collections, 'education.endYear', 0)).toEqual(['2021']);
  });

  it('内容脚本再读一遍（有界读）时不丢', () => {
    const reparsed = parseApplyProfileCollections(JSON.parse(JSON.stringify(project([current()]))));
    expect(reparsed.educations?.[0]?.expectedGraduationDate).toEqual({ year: 2027, month: 5 });
    expect(projectCollectionField(reparsed, 'education.endYear', 0)).toEqual(['2027']);
  });
});
