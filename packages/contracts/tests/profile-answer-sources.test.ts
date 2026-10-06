import { describe, expect, it } from 'vitest';
import {
  PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1,
  PROFILE_ANSWER_RESOLUTION_CATEGORIES_V1,
  PROFILE_ANSWER_RESOLUTION_REASON_CODES_V1,
  PROFILE_ANSWER_SOURCE_CONCEPTS_V1,
  PROFILE_ANSWER_SOURCE_DISPOSITIONS_V1,
  PROFILE_ANSWER_SOURCE_REASON_CODES_V1,
  type ProfileAnswerResolutionConfirmedAuthorityStateV1,
  type ProfileAnswerResolutionProfileFactRefV1,
} from '../src/profileAnswerSources.ts';

type ConfirmedAuthorityStateRejectsSuggested =
  'SUGGESTED' extends ProfileAnswerResolutionConfirmedAuthorityStateV1 ? never : true;
const CONFIRMED_AUTHORITY_STATE_REJECTS_SUGGESTED: ConfirmedAuthorityStateRejectsSuggested = true;
type ProfileFactAuthorityStateRejectsSuggested =
  'SUGGESTED' extends ProfileAnswerResolutionProfileFactRefV1['authorityState']
    ? never
    : true;
const PROFILE_FACT_AUTHORITY_STATE_REJECTS_SUGGESTED:
  ProfileFactAuthorityStateRejectsSuggested = true;

describe('Profile answer-source disposition contract', () => {
  it('keeps the common Profile concepts and fallback states closed and duplicate-free', () => {
    expect(new Set(PROFILE_ANSWER_SOURCE_CONCEPTS_V1).size).toBe(
      PROFILE_ANSWER_SOURCE_CONCEPTS_V1.length,
    );
    expect(PROFILE_ANSWER_SOURCE_CONCEPTS_V1).toEqual(
      expect.arrayContaining([
        'IDENTITY_FIRST_NAME',
        'CONTACT_EMAIL',
        'CONTACT_PHONE',
        'CURRENT_COMPANY',
        'CURRENT_JOB_TITLE',
        'WORK_HISTORY',
        'EDUCATION_HISTORY',
        'SKILLS',
        'AUTHORIZED_TO_WORK',
        'REQUIRES_SPONSORSHIP',
        'WILLING_TO_RELOCATE',
        'SALARY_EXPECTATION',
      ]),
    );
    expect(PROFILE_ANSWER_SOURCE_DISPOSITIONS_V1).toEqual([
      'PROFILE_CONFIRMED',
      'AI_SUGGESTION_THEN_USER_CONFIRMATION',
      'USER_CONFIRMATION_REQUIRED',
      'POLICY_BLOCKED',
    ]);
    expect(new Set(PROFILE_ANSWER_SOURCE_REASON_CODES_V1).size).toBe(
      PROFILE_ANSWER_SOURCE_REASON_CODES_V1.length,
    );
    expect(PROFILE_ANSWER_SOURCE_REASON_CODES_V1).not.toContain('UNSUPPORTED');
  });

  it('has precise no-storage reasons instead of a generic unsupported escape hatch', () => {
    expect(PROFILE_ANSWER_SOURCE_REASON_CODES_V1).toEqual(
      expect.arrayContaining([
        'PROFILE_SOURCE_OWNER_MISMATCH',
        'PROFILE_SOURCE_REVISION_STALE',
        'PROFILE_SOURCE_SALARY_STORAGE_UNAVAILABLE',
        'PROFILE_SOURCE_RELOCATION_STORAGE_UNAVAILABLE',
        'PROFILE_SOURCE_WORK_AUTHORIZATION_UNSPECIFIED',
        'PROFILE_SOURCE_WORK_AUTHORIZATION_NOT_EFFECTIVE',
        'PROFILE_SOURCE_WORK_AUTHORIZATION_TIME_INVALID',
        'PROFILE_SOURCE_REGION_NOT_FOUND',
      ]),
    );
  });

  it('keeps answer resolution in four explicit classes with precise hostile-source reasons', () => {
    expect(CONFIRMED_AUTHORITY_STATE_REJECTS_SUGGESTED).toBe(true);
    expect(PROFILE_FACT_AUTHORITY_STATE_REJECTS_SUGGESTED).toBe(true);
    expect(PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1).toEqual([
      'USER_CONFIRMED',
      'DERIVED_CONFIRMED',
      'LEGACY_CONFIRMED',
    ]);
    expect(PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1).not.toContain('SUGGESTED');
    expect(PROFILE_ANSWER_RESOLUTION_CATEGORIES_V1).toEqual([
      'DETERMINISTIC_MAPPING',
      'EXPLAINABLE_DERIVATION',
      'AI_SUGGESTION_REQUIRED',
      'USER_CONFIRMATION_REQUIRED',
    ]);
    expect(new Set(PROFILE_ANSWER_RESOLUTION_CATEGORIES_V1).size).toBe(4);
    expect(PROFILE_ANSWER_RESOLUTION_REASON_CODES_V1).toEqual(
      expect.arrayContaining([
        'ANSWER_RESOLUTION_DERIVATION_REQUIRES_CONFIRMATION',
        'ANSWER_RESOLUTION_RESUME_SUGGESTION_REQUIRES_CONFIRMATION',
        'ANSWER_RESOLUTION_RESUME_OWNER_MISMATCH',
        'ANSWER_RESOLUTION_RESUME_VERSION_NOT_SELECTED',
        'ANSWER_RESOLUTION_RESUME_VERSION_NOT_FINAL',
        'ANSWER_RESOLUTION_RESUME_VERSION_NOT_READY',
        'ANSWER_RESOLUTION_RESUME_REVISION_STALE',
        'ANSWER_RESOLUTION_RESUME_PROFILE_FENCE_STALE',
        'ANSWER_RESOLUTION_RESUME_CONTENT_HASH_INVALID',
        'ANSWER_RESOLUTION_RESUME_SOURCE_INVALID',
        'ANSWER_RESOLUTION_RESUME_SUGGESTION_SET_INVALID',
        'ANSWER_RESOLUTION_RESUME_COLLECTION_TRUNCATED',
      ]),
    );
    expect(PROFILE_ANSWER_RESOLUTION_REASON_CODES_V1).not.toContain('UNSUPPORTED');
  });
});
