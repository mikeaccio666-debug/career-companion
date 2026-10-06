/**
 * Value-free T3 Profile answer-source disposition contract.
 *
 * The result only says whether current owner Profile authority can supply a
 * concept and names the exact Profile references that justify that decision.
 * It never carries a Profile value, ATS question text, AI output, or writer
 * authority. T9/T10 may consume this as a handoff, but neither capability is
 * activated by importing this module.
 */

import type { DecimalString, Sha256Digest, Uuid } from './common.ts';
import type {
  CandidateProfileScalarPathV2,
  ProfileAchievementFieldCodeV2,
  ProfileEducationFieldCodeV2,
  ProfileExperienceFieldCodeV2,
  ProfileFactSourceRefV2,
  ProfileFactSourceV2,
  ProfileLanguageFieldCodeV2,
  ProfileLinkKindV2,
  ProfileProjectFieldCodeV2,
  ProfileSkillFieldCodeV2,
  ProfileWorkAuthorizationFieldCodeV2,
} from './profileV2.ts';
import type { IsoCountryCode, SafeToken } from './sensitiveWrite.ts';

export const PROFILE_ANSWER_SOURCE_SCHEMA_VERSION_V1 = 1 as const;

export const PROFILE_ANSWER_SOURCE_CONCEPTS_V1 = [
  'IDENTITY_FIRST_NAME',
  'IDENTITY_MIDDLE_NAME',
  'IDENTITY_LAST_NAME',
  'IDENTITY_FULL_NAME',
  'IDENTITY_PREFERRED_NAME',
  'CONTACT_EMAIL',
  'CONTACT_PHONE',
  'ADDRESS_LINE1',
  'ADDRESS_LINE2',
  'ADDRESS_CITY',
  'ADDRESS_REGION',
  'ADDRESS_POSTAL_CODE',
  'ADDRESS_COUNTRY',
  'PROFILE_SUMMARY',
  'NO_EXPERIENCE',
  'LINKEDIN',
  'GITHUB',
  'PORTFOLIO',
  'CURRENT_COMPANY',
  'CURRENT_JOB_TITLE',
  'WORK_HISTORY',
  'EDUCATION_HISTORY',
  'SKILLS',
  'LANGUAGES',
  'PROJECTS',
  'ACHIEVEMENTS',
  'EARLIEST_START_DATE',
  'NOTICE_PERIOD_DAYS',
  'AUTHORIZED_TO_WORK',
  'REQUIRES_SPONSORSHIP',
  'WILLING_TO_RELOCATE',
  'SALARY_EXPECTATION',
  // EEO 自我认同。每一档的 DECLINE 都是一个**用户作答过**的答案，不是空值。
  'SELF_ID_GENDER',
  'SELF_ID_RACE',
  'SELF_ID_VETERAN',
  'SELF_ID_DISABILITY',
  /** 「你从哪听说这个职位的」——一次填写、每份申请复用。 */
  'REFERRAL_SOURCE',
  // 2026-09-21 填写键扩展（P1-5）。SALARY_EXPECTATION / WILLING_TO_RELOCATE 早就在
  // 清单里但一直答「没有存储」；现在有列了，这里补上它们的伴随项与另外几类。
  'PRONOUNS',
  'SALARY_CURRENCY',
  'SALARY_PERIOD',
  'WORK_MODES',
  'RELOCATION_CITIES',
  'OVER_18',
  'TWITTER',
  'OTHER_WEBSITE',
] as const;
export type ProfileAnswerSourceConceptV1 =
  (typeof PROFILE_ANSWER_SOURCE_CONCEPTS_V1)[number];

export const PROFILE_ANSWER_SOURCE_DISPOSITIONS_V1 = [
  'PROFILE_CONFIRMED',
  'AI_SUGGESTION_THEN_USER_CONFIRMATION',
  'USER_CONFIRMATION_REQUIRED',
  'POLICY_BLOCKED',
] as const;
export type ProfileAnswerSourceDispositionV1 =
  (typeof PROFILE_ANSWER_SOURCE_DISPOSITIONS_V1)[number];

export const PROFILE_ANSWER_SOURCE_REASON_CODES_V1 = [
  'PROFILE_SOURCE_CONFIRMED',
  'PROFILE_SOURCE_PROFILE_MISSING',
  'PROFILE_SOURCE_PROFILE_DELETED',
  'PROFILE_SOURCE_OWNER_MISMATCH',
  'PROFILE_SOURCE_REVISION_STALE',
  'PROFILE_SOURCE_VALUE_MISSING',
  'PROFILE_SOURCE_AUTHORITY_MISSING',
  'PROFILE_SOURCE_AUTHORITY_NOT_CONFIRMED',
  'PROFILE_SOURCE_DELETION_EPOCH_STALE',
  'PROFILE_SOURCE_PRIMARY_REFERENCE_MISSING',
  'PROFILE_SOURCE_PRIMARY_REFERENCE_NOT_CONFIRMED',
  'PROFILE_SOURCE_COLLECTION_EMPTY',
  'PROFILE_SOURCE_COLLECTION_PARTIALLY_CONFIRMED',
  'PROFILE_SOURCE_REGION_REQUIRED',
  'PROFILE_SOURCE_REGION_NOT_FOUND',
  'PROFILE_SOURCE_WORK_AUTHORIZATION_UNSPECIFIED',
  'PROFILE_SOURCE_WORK_AUTHORIZATION_EXPIRED',
  'PROFILE_SOURCE_WORK_AUTHORIZATION_NOT_EFFECTIVE',
  'PROFILE_SOURCE_WORK_AUTHORIZATION_TIME_INVALID',
  'PROFILE_SOURCE_SALARY_STORAGE_UNAVAILABLE',
  'PROFILE_SOURCE_RELOCATION_STORAGE_UNAVAILABLE',
  'PROFILE_SOURCE_POLICY_BLOCKED',
] as const;
export type ProfileAnswerSourceReasonCodeV1 =
  (typeof PROFILE_ANSWER_SOURCE_REASON_CODES_V1)[number];

export type ProfileAnswerSourceRequestV1 =
  | {
      readonly concept: Exclude<
        ProfileAnswerSourceConceptV1,
        'AUTHORIZED_TO_WORK' | 'REQUIRES_SPONSORSHIP'
      >;
      readonly regionCode?: never;
    }
  | {
      readonly concept: 'AUTHORIZED_TO_WORK' | 'REQUIRES_SPONSORSHIP';
      readonly regionCode: IsoCountryCode;
    };

export type ProfileAnswerSourceCollectionV1 =
  | 'experiences'
  | 'educations'
  | 'skills'
  | 'languages'
  | 'projects'
  | 'achievements'
  | 'referrals';

export type ProfileAnswerSourceCollectionFieldCodeV1 =
  | ProfileExperienceFieldCodeV2
  | ProfileEducationFieldCodeV2
  | ProfileSkillFieldCodeV2
  | ProfileLanguageFieldCodeV2
  | ProfileProjectFieldCodeV2
  | ProfileAchievementFieldCodeV2;

export type ProfileAnswerSourceRefV1 =
  | {
      readonly shape: 'SCALAR';
      readonly paths: readonly [
        CandidateProfileScalarPathV2,
        ...CandidateProfileScalarPathV2[],
      ];
    }
  | {
      readonly shape: 'PRIMARY_LINK';
      readonly kind: Extract<ProfileLinkKindV2, 'LINKEDIN' | 'GITHUB' | 'PORTFOLIO' | 'WEBSITE' | 'TWITTER'>;
      readonly linkId: Uuid;
    }
  | {
      readonly shape: 'PRIMARY_CURRENT_EXPERIENCE';
      readonly experienceId: Uuid;
      readonly fields: readonly ['company' | 'title'];
    }
  | {
      readonly shape: 'COLLECTION';
      readonly collection: ProfileAnswerSourceCollectionV1;
      readonly itemIds: readonly [Uuid, ...Uuid[]];
      readonly confirmedFields: readonly [
        ProfileAnswerSourceCollectionFieldCodeV1,
        ...ProfileAnswerSourceCollectionFieldCodeV1[],
      ];
    }
  | {
      readonly shape: 'WORK_AUTHORIZATION';
      readonly regionCode: IsoCountryCode;
      readonly fields: readonly [
        ProfileWorkAuthorizationFieldCodeV2,
        ...ProfileWorkAuthorizationFieldCodeV2[],
      ];
    };

export type ProfileAnswerSourceDispositionItemV1 =
  | {
      readonly concept: ProfileAnswerSourceConceptV1;
      readonly disposition: 'PROFILE_CONFIRMED';
      readonly reasonCode: 'PROFILE_SOURCE_CONFIRMED';
      readonly sourceRefs: readonly [ProfileAnswerSourceRefV1, ...ProfileAnswerSourceRefV1[]];
    }
  | {
      readonly concept: ProfileAnswerSourceConceptV1;
      readonly disposition: Exclude<ProfileAnswerSourceDispositionV1, 'PROFILE_CONFIRMED'>;
      readonly reasonCode: Exclude<
        ProfileAnswerSourceReasonCodeV1,
        'PROFILE_SOURCE_CONFIRMED'
      >;
      readonly sourceRefs: readonly [];
    };

export interface ProfileAnswerSourceDispositionSnapshotV1 {
  readonly schemaVersion: typeof PROFILE_ANSWER_SOURCE_SCHEMA_VERSION_V1;
  readonly ownerId: Uuid;
  readonly profileRevision: DecimalString;
  readonly deletionEpoch: DecimalString;
  /** Exactly one result per request, in request order. No silent omission. */
  readonly items: readonly ProfileAnswerSourceDispositionItemV1[];
}

/**
 * Dormant, value-free Answer Resolution support contract.
 *
 * Candidate references bind exact Profile/Resume authority without carrying
 * the underlying value. A downstream resolver must still load that authority
 * in-process and apply its own question/option policy. This contract grants no
 * writer, T10 execution-key, persistence, or Submit authority.
 */
export const PROFILE_ANSWER_RESOLUTION_SCHEMA_VERSION_V1 = 1 as const;

/** Closed authority subset that may back a deterministic Profile candidate. */
export const PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1 = [
  'USER_CONFIRMED',
  'DERIVED_CONFIRMED',
  'LEGACY_CONFIRMED',
] as const;
export type ProfileAnswerResolutionConfirmedAuthorityStateV1 =
  (typeof PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1)[number];

export const PROFILE_ANSWER_RESOLUTION_CATEGORIES_V1 = [
  'DETERMINISTIC_MAPPING',
  'EXPLAINABLE_DERIVATION',
  'AI_SUGGESTION_REQUIRED',
  'USER_CONFIRMATION_REQUIRED',
] as const;
export type ProfileAnswerResolutionCategoryV1 =
  (typeof PROFILE_ANSWER_RESOLUTION_CATEGORIES_V1)[number];

export const PROFILE_ANSWER_RESOLUTION_REASON_CODES_V1 = [
  ...PROFILE_ANSWER_SOURCE_REASON_CODES_V1,
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
] as const;
export type ProfileAnswerResolutionReasonCodeV1 =
  (typeof PROFILE_ANSWER_RESOLUTION_REASON_CODES_V1)[number];

export type ProfileAnswerResolutionScopeRefV1 =
  | { readonly scope: 'USER' }
  | { readonly scope: 'REGION'; readonly regionCode: IsoCountryCode };

export interface ProfileAnswerResolutionProfileFactRefV1 {
  readonly factId: Uuid;
  readonly factRevision: DecimalString;
  readonly deletionEpoch: DecimalString;
  readonly source: ProfileFactSourceV2;
  readonly authorityState: ProfileAnswerResolutionConfirmedAuthorityStateV1;
  readonly confidence: number | null;
  readonly sourceRef: ProfileFactSourceRefV2;
}

/**
 * Value-free proof that the two facts behind a primary current-experience candidate
 * discharge two different authority obligations. The fact ids bind each role to the
 * corresponding fact record; no Profile value crosses this boundary.
 */
export type ProfileAnswerResolutionCurrentExperienceFactBindingV1 =
  | {
      readonly role: 'PRIMARY_CURRENT_EXPERIENCE_REFERENCE';
      readonly factId: Uuid;
      readonly experienceId: Uuid;
    }
  | {
      readonly role: 'PRIMARY_CURRENT_EXPERIENCE_FIELD';
      readonly factId: Uuid;
      readonly experienceId: Uuid;
      readonly field: 'company' | 'title';
    };

export type ProfileAnswerResolutionResumeSuggestionRefV1 =
  | {
      readonly shape: 'CONTACT';
      readonly field: 'fullName' | 'preferredName' | 'email' | 'phone' | 'city';
    }
  | {
      readonly shape: 'LINK';
      readonly kind: 'linkedin' | 'github';
      readonly itemIndexes: readonly [number, ...number[]];
    }
  | {
      readonly shape: 'EXPERIENCE_FIELD';
      readonly itemId: SafeToken;
      readonly field: 'company';
    }
  | {
      readonly shape: 'COLLECTION';
      readonly collection: 'experiences' | 'educations';
      readonly itemIds: readonly [SafeToken, ...SafeToken[]];
    }
  | {
      readonly shape: 'SKILLS';
      readonly itemIndexes: readonly [number, ...number[]];
    };

export type ProfileAnswerResolutionCandidateV1 = Readonly<{
  confidence: number | null;
  regionCode: IsoCountryCode | null;
  scopeRef: ProfileAnswerResolutionScopeRefV1;
}> & (
  | {
      readonly source: 'PROFILE';
      readonly provenance: {
        readonly kind: 'PROFILE_FACTS';
        readonly ownerId: Uuid;
        readonly profileRevision: DecimalString;
        readonly deletionEpoch: DecimalString;
        readonly sourceRef: ProfileAnswerSourceRefV1;
        readonly facts: readonly [
          ProfileAnswerResolutionProfileFactRefV1,
          ...ProfileAnswerResolutionProfileFactRefV1[],
        ];
        /** Present only for PRIMARY_CURRENT_EXPERIENCE candidates. */
        readonly factBindings?: readonly [
          Extract<
            ProfileAnswerResolutionCurrentExperienceFactBindingV1,
            { role: 'PRIMARY_CURRENT_EXPERIENCE_REFERENCE' }
          >,
          Extract<
            ProfileAnswerResolutionCurrentExperienceFactBindingV1,
            { role: 'PRIMARY_CURRENT_EXPERIENCE_FIELD' }
          >,
        ];
      };
    }
  | {
      readonly source: 'RESUME';
      readonly provenance: {
        readonly kind: 'RESUME_SUGGESTION';
        readonly ownerId: Uuid;
        readonly resumeVersionId: Uuid;
        readonly trackId: Uuid;
        readonly contentHash: Sha256Digest;
        readonly contentRevision: DecimalString;
        readonly libraryRevision: DecimalString;
        readonly profileRevision: DecimalString;
        readonly profileDeletionEpoch: DecimalString;
        readonly suggestionSetDigest: Sha256Digest;
        readonly extractorName: 'resume-profile-suggestions';
        readonly extractorVersion: 'v1';
        readonly suggestionRefs: readonly [
          ProfileAnswerResolutionResumeSuggestionRefV1,
          ...ProfileAnswerResolutionResumeSuggestionRefV1[],
        ];
      };
    }
  | {
      readonly source: 'DERIVATION';
      readonly provenance: {
        readonly kind: 'DERIVATION';
        readonly ownerId: Uuid;
        readonly profileRevision: DecimalString;
        readonly deletionEpoch: DecimalString;
        readonly policyVersion: SafeToken;
        readonly evidenceFacts: readonly [
          ProfileAnswerResolutionProfileFactRefV1,
          ...ProfileAnswerResolutionProfileFactRefV1[],
        ];
      };
    }
);

export type ProfileAnswerResolutionItemV1 =
  | {
      readonly concept: ProfileAnswerSourceConceptV1;
      readonly category: 'DETERMINISTIC_MAPPING';
      readonly disposition: 'PROFILE_CONFIRMED';
      readonly reasonCode: 'PROFILE_SOURCE_CONFIRMED';
      readonly candidates: readonly [
        Extract<ProfileAnswerResolutionCandidateV1, { source: 'PROFILE' }>,
        ...Extract<ProfileAnswerResolutionCandidateV1, { source: 'PROFILE' }>[],
      ];
    }
  | {
      readonly concept: ProfileAnswerSourceConceptV1;
      readonly category: 'EXPLAINABLE_DERIVATION';
      readonly disposition: 'USER_CONFIRMATION_REQUIRED';
      readonly reasonCode: 'ANSWER_RESOLUTION_DERIVATION_REQUIRES_CONFIRMATION';
      readonly candidates: readonly [
        Extract<ProfileAnswerResolutionCandidateV1, { source: 'DERIVATION' }>,
        ...Extract<ProfileAnswerResolutionCandidateV1, { source: 'DERIVATION' }>[],
      ];
    }
  | {
      readonly concept: ProfileAnswerSourceConceptV1;
      readonly category: 'AI_SUGGESTION_REQUIRED';
      readonly disposition: 'AI_SUGGESTION_THEN_USER_CONFIRMATION';
      readonly reasonCode: Exclude<
        ProfileAnswerResolutionReasonCodeV1,
        'PROFILE_SOURCE_CONFIRMED'
      >;
      readonly candidates: readonly [];
    }
  | {
      readonly concept: ProfileAnswerSourceConceptV1;
      readonly category: 'USER_CONFIRMATION_REQUIRED';
      readonly disposition: 'USER_CONFIRMATION_REQUIRED' | 'POLICY_BLOCKED';
      readonly reasonCode: Exclude<
        ProfileAnswerResolutionReasonCodeV1,
        'PROFILE_SOURCE_CONFIRMED'
      >;
      readonly candidates: readonly ProfileAnswerResolutionCandidateV1[];
    };

export interface ProfileAnswerResolutionSnapshotV1 {
  readonly schemaVersion: typeof PROFILE_ANSWER_RESOLUTION_SCHEMA_VERSION_V1;
  readonly ownerId: Uuid;
  readonly profileRevision: DecimalString;
  readonly deletionEpoch: DecimalString;
  /** Exactly one result per request, in request order. No silent omission. */
  readonly items: readonly ProfileAnswerResolutionItemV1[];
}
