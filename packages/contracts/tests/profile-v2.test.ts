import { describe, expect, it } from 'vitest';

import {
  COMMON_PRIVATE_ERROR_CODES,
  OWNER_PROFILE_V2_ENDPOINTS,
  OWNER_PROFILE_V2_ENDPOINT_ERROR_CODES,
  PROFILE_V2_ACHIEVEMENT_FIELD_CODES,
  PROFILE_V2_CACHE_POLICY,
  PROFILE_V2_COLLECTION_LIMITS,
  PROFILE_V2_EDUCATION_FIELD_CODES,
  PROFILE_V2_EXPERIENCE_FIELD_CODES,
  PROFILE_V2_MAX_REQUEST_BYTES,
  PROFILE_V2_SALARY_PERIODS,
  PROFILE_V2_WORK_MODES,
  PROFILE_V2_LINK_KINDS,
  PROFILE_V2_SCALAR_PATHS,
  PROFILE_V2_TRAVEL_PERCENTS,
  PROFILE_V2_SCHEMA_VERSION,
  PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES,
  type BoundedString,
  type IsoCountryCode,
  type PatchCandidateProfileV2,
  type ProfileLegacyUnresolvedV2,
  type ProfileExperienceMutationV2,
  type Uuid,
} from '../src/index.ts';

describe('Profile V2 strict mirror', () => {
  it('pins the owner-only CRUD endpoint set and no-store policy', () => {
    expect(OWNER_PROFILE_V2_ENDPOINTS).toEqual({
      getOwnerApplicationProfileV2: {
        method: 'GET',
        path: '/users/me/application-profile',
        sourceSection: '5.13',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      patchOwnerApplicationProfileV2: {
        method: 'PATCH',
        path: '/users/me/application-profile',
        sourceSection: '5.13',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      deleteOwnerApplicationProfileV2: {
        method: 'DELETE',
        path: '/users/me/application-profile',
        sourceSection: '5.13',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      createResumeProfileSuggestionsV1: {
        method: 'POST',
        path: '/users/me/application-profile/resume-suggestions',
        sourceSection: '5.13.4',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        requestEncoding: 'multipart/form-data',
        fileField: 'file',
        consentField: 'consent',
        maxFileBytes: 10 * 1024 * 1024,
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      getOwnerProfileDirectoryPersonalV1: {
        method: 'GET',
        path: '/users/me/profile-directory/personal',
        sourceSection: '5.13.9',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      replaceOwnerProfileDirectoryPersonalV1: {
        method: 'PATCH',
        path: '/users/me/profile-directory/personal',
        sourceSection: '5.13.9',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      getOwnerProfileDirectoryWorkAuthorizationV1: {
        method: 'GET',
        path: '/users/me/profile-directory/work-authorization',
        sourceSection: '5.13.9',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      replaceOwnerProfileDirectoryWorkAuthorizationV1: {
        method: 'PATCH',
        path: '/users/me/profile-directory/work-authorization',
        sourceSection: '5.13.9',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      getOwnerProfileDirectoryPreferencesV1: {
        method: 'GET',
        path: '/users/me/profile-directory/preferences',
        sourceSection: '5.13.9',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      replaceOwnerProfileDirectoryPreferencesV1: {
        method: 'PATCH',
        path: '/users/me/profile-directory/preferences',
        sourceSection: '5.13.9',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      getOwnerEeoSelfIdentificationV1: {
        method: 'GET',
        path: '/api/v1/agent/eeo-self-identification',
        sourceSection: '5.13.8',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      replaceOwnerEeoSelfIdentificationV1: {
        method: 'PATCH',
        path: '/api/v1/agent/eeo-self-identification',
        sourceSection: '5.13.8',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      deleteOwnerEeoSelfIdentificationV1: {
        method: 'DELETE',
        path: '/api/v1/agent/eeo-self-identification',
        sourceSection: '5.13.8',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [204],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      // 2026-09-23 显式扩项：代填条款、声明与签名的同意（跟 argoland #600）。起初插件只读这一条；
      // 同一天负责人要求资料能在插件里直接改，于是同意与撤回也跟上 argoland 已有的那两条（§5.13.9）。
      getOwnerApplicationSigningConsentV1: {
        method: 'GET',
        path: '/api/v1/agent/consents/application-signing',
        sourceSection: '5.13.9',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      grantOwnerApplicationSigningConsentV1: {
        method: 'POST',
        path: '/api/v1/agent/consents/application-signing',
        sourceSection: '5.13.9',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
      revokeOwnerApplicationSigningConsentV1: {
        method: 'DELETE',
        path: '/api/v1/agent/consents/application-signing',
        sourceSection: '5.13.9',
        auth: 'bearer',
        responseKind: 'json',
        callerConstraint: 'owner-bearer',
        successStatuses: [200],
        responseCache: PROFILE_V2_CACHE_POLICY,
      },
    });
  });

  it('keeps the PATCH stale-writer fences in its endpoint allowlist', () => {
    expect(OWNER_PROFILE_V2_ENDPOINT_ERROR_CODES).toEqual({
      getOwnerApplicationProfileV2: [...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED'],
      patchOwnerApplicationProfileV2: [
        ...COMMON_PRIVATE_ERROR_CODES,
        'PAYWALL_REQUIRED',
        'PROFILE_REVISION_MISMATCH',
        'PROFILE_DELETION_EPOCH_MISMATCH',
      ],
      deleteOwnerApplicationProfileV2: [...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED'],
      createResumeProfileSuggestionsV1: [
        ...COMMON_PRIVATE_ERROR_CODES,
        'PAYWALL_REQUIRED',
      ],
      getOwnerProfileDirectoryPersonalV1: [...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED'],
      replaceOwnerProfileDirectoryPersonalV1: [
        ...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED',
        'PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH',
      ],
      getOwnerProfileDirectoryWorkAuthorizationV1: [...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED'],
      // The answers and their reuse switch are fenced separately, so this save
      // can be refused for either without the client refreshing the wrong one.
      replaceOwnerProfileDirectoryWorkAuthorizationV1: [
        ...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED',
        'PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH',
        'PROFILE_PREFERENCES_REVISION_MISMATCH',
      ],
      getOwnerProfileDirectoryPreferencesV1: [...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED'],
      replaceOwnerProfileDirectoryPreferencesV1: [
        ...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED', 'PROFILE_PREFERENCES_REVISION_MISMATCH',
      ],
      getOwnerEeoSelfIdentificationV1: [...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED'],
      replaceOwnerEeoSelfIdentificationV1: [...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED', 'PROFILE_REVISION_MISMATCH'],
      deleteOwnerEeoSelfIdentificationV1: [...COMMON_PRIVATE_ERROR_CODES, 'PAYWALL_REQUIRED', 'PROFILE_REVISION_MISMATCH'],
      // 同意记录不在付费墙后面（argoland 那边这条路由没有挂订阅闸）。
      getOwnerApplicationSigningConsentV1: [...COMMON_PRIVATE_ERROR_CODES],
      grantOwnerApplicationSigningConsentV1: [...COMMON_PRIVATE_ERROR_CODES],
      revokeOwnerApplicationSigningConsentV1: [...COMMON_PRIVATE_ERROR_CODES],
    });
  });

  it('pins behavior-bearing field closures and request bounds', () => {
    expect(PROFILE_V2_SCHEMA_VERSION).toBe(2);
    // argoland 2026-09-18（profile_v2_import_capacity）：一份完整档案在放宽后的集合上限
    // 下装不进 512 KiB，请求体上限提到 1.5 MiB；这边跟版（RULE-EXT-CONTRACT-CONSUMER）。
    expect(PROFILE_V2_MAX_REQUEST_BYTES).toBe(1536 * 1024);
    // 2026-09 契约变更：`mobility.*` 三项换成一个 `referralSource`（23 - 3 + 1 = 21）；
    // 2026-09-21 填写键扩展（argoland #535）再加 8 条：代词、期望薪资三项、办公模式、
    // 搬迁两项、是否年满 18。2026-09-28 再加一条「可以联系你现在的雇主吗」，2026-10-04 再加一条「出差最多能接受多少」。
    expect(PROFILE_V2_SCALAR_PATHS).toHaveLength(31);
    expect(PROFILE_V2_SCALAR_PATHS).toContain('preferences.contactCurrentEmployer');
    expect(PROFILE_V2_SCALAR_PATHS).toContain('preferences.travelPercentMax');
    expect(PROFILE_V2_TRAVEL_PERCENTS).toEqual([0, 25, 50, 75, 100]);
    expect(PROFILE_V2_SCALAR_PATHS).toContain('identity.pronouns');
    expect(PROFILE_V2_SALARY_PERIODS).toEqual(['YEAR', 'MONTH', 'HOUR']);
    expect(PROFILE_V2_WORK_MODES).toEqual(['REMOTE', 'HYBRID', 'ONSITE']);
    expect(PROFILE_V2_LINK_KINDS).toContain('TWITTER');
    expect(PROFILE_V2_EDUCATION_FIELD_CODES).toContain('expectedGraduationDate');
    expect(PROFILE_V2_EDUCATION_FIELD_CODES).toContain('coursework');
    expect(PROFILE_V2_ACHIEVEMENT_FIELD_CODES).toEqual([
      'kind',
      'title',
      'statement',
      'occurredAt',
      'url',
      'context',
    ]);
    expect(PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES).toEqual([
      'regionCode',
      'authorizedToWork',
      'requiresSponsorship',
    ]);
    // 同上：12 段经历、6 段教育、40 项技能低于学生真实上传的简历，导入读对了却存不下。
    // 这边的快照解析用的就是这几个数——停在旧值就是把一份合法档案整份判 malformed。
    expect(PROFILE_V2_COLLECTION_LIMITS).toMatchObject({
      experiences: 24,
      educations: 12,
      skills: 120,
      projects: 40,
      // argoland 2026-09：一份完整的作品集每段经历/项目都可能带好几条成果，上限提到 100。
      achievements: 100,
      workAuthorizations: 20,
      // 推荐人（P1-9）：用户亲手存的「谁把我推荐到哪家」。
      referrals: 20,
    });
    expect(PROFILE_V2_COLLECTION_LIMITS).not.toHaveProperty('userStrengthTags');
    expect(PROFILE_V2_COLLECTION_LIMITS).not.toHaveProperty('strengthTagEvidence');
  });

  it('requires revision and deletion epoch while excluding reserved/sensitive keys', () => {
    const patch: PatchCandidateProfileV2 = {
      schemaVersion: 2,
      expectedRevision: '1',
      expectedDeletionEpoch: '0',
      fields: { summary: null, noExperience: false },
    };
    // @ts-expect-error stale writes must always carry the current deletion fence.
    const invalidMissingDeletionEpoch: PatchCandidateProfileV2 = {
      schemaVersion: 2,
      expectedRevision: '1',
      fields: { summary: null },
    };
    const invalidReserved: PatchCandidateProfileV2 = {
      ...patch,
      fields: {
        // @ts-expect-error identity.ssn is absent from the scalar closure.
        'identity.ssn': null,
      },
    };
    const invalidSensitive: PatchCandidateProfileV2 = {
      ...patch,
      // @ts-expect-error EEO/demographics belong to the independent Sensitive store.
      eeo: { disability: 'YES' },
    };
    const workAuthorization: PatchCandidateProfileV2 = {
      ...patch,
      workAuthorizations: [
        {
          regionCode: 'US' as IsoCountryCode,
          authorizedToWork: 'YES',
          requiresSponsorship: 'NO',
          confirmFields: ['authorizedToWork', 'regionCode', 'requiresSponsorship'],
        },
      ],
    };

    expect(patch.expectedDeletionEpoch).toBe('0');
    expect(invalidMissingDeletionEpoch).not.toHaveProperty('expectedDeletionEpoch');
    expect(invalidReserved.fields).toHaveProperty('identity.ssn');
    expect(invalidSensitive).toHaveProperty('eeo');
    expect(workAuthorization.workAuthorizations).toHaveLength(1);
  });

  it('exposes only owner-view legacy location plaintext and requires explicit clear intent', () => {
    const unresolved: ProfileLegacyUnresolvedV2 = {
      profileLocation: 'Greater Seattle Area' as BoundedString<1, 256>,
      experienceLocations: [
        {
          experienceId: '11111111-1111-4111-8111-111111111111' as Uuid,
          value: 'Remote / Seattle' as BoundedString<1, 256>,
        },
      ],
      fieldValues: [],
    };
    const patch: PatchCandidateProfileV2 = {
      schemaVersion: 2,
      expectedRevision: '4',
      expectedDeletionEpoch: '1',
      legacyResolution: {
        clearProfileLocation: true,
        clearExperienceLocationIds: ['11111111-1111-4111-8111-111111111111' as Uuid],
        clearFieldKeys: [],
      },
    };

    expect(unresolved).not.toHaveProperty('ciphertext');
    expect(patch.legacyResolution?.clearExperienceLocationIds).toHaveLength(1);
  });

  it('does not let collection input forge server authority metadata', () => {
    const mutation: ProfileExperienceMutationV2 = {
      company: 'Example' as BoundedString<1, 160>,
      title: 'Engineer' as BoundedString<1, 160>,
      city: null,
      region: null,
      employmentType: 'FULL_TIME',
      startDate: null,
      endDate: null,
      isCurrent: true,
      description: null,
      confirmFields: [...PROFILE_V2_EXPERIENCE_FIELD_CODES],
    };
    const invalid: ProfileExperienceMutationV2 = {
      ...mutation,
      // @ts-expect-error clients cannot submit factAuthorityByField on collection mutations.
      factAuthorityByField: {},
    };

    expect((invalid as unknown as { factAuthorityByField: object }).factAuthorityByField).toEqual(
      {},
    );
  });
});
