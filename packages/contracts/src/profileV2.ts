/** Strict owner Profile V2 wire mirror from AGENT-API-CONTRACT.md §5.13. */

import type { DecimalString, IsoDateTime, LocalDate, Uuid } from './common.ts';
import type { IsoCountryCode, SafeToken } from './sensitiveWrite.ts';

declare const profileV2WireBrand: unique symbol;

export type BoundedString<Min extends number, Max extends number> = string & {
  readonly [profileV2WireBrand]: readonly ['BoundedString', Min, Max];
};
export type EmailString<Max extends number> = string & {
  readonly [profileV2WireBrand]: readonly ['EmailString', Max];
};
export type SafeHttpUrl<Max extends number> = string & {
  readonly [profileV2WireBrand]: readonly ['SafeHttpUrl', Max];
};
export type E164CountryCallingCode = string & {
  readonly [profileV2WireBrand]: 'E164CountryCallingCode';
};
export type E164PhoneNumber = string & {
  readonly [profileV2WireBrand]: 'E164PhoneNumber';
};

export const PROFILE_V2_SCHEMA_VERSION = 2 as const;
// A full Profile at the collection and description bounds above no longer fits
// in 512 KiB; this stays under the 2 MB host JSON body limit.
export const PROFILE_V2_MAX_REQUEST_BYTES = 1536 * 1024;
export const PROFILE_V2_CACHE_POLICY = {
  responseHeaders: { 'Cache-Control': 'private, no-store' },
  etag: 'forbidden',
} as const;

export const PROFILE_V2_SCALAR_PATHS = [
  'identity.firstName',
  'identity.middleName',
  'identity.lastName',
  'identity.fullName',
  'identity.preferredName',
  'contact.email',
  'contact.phone.countryCode',
  'contact.phone.e164',
  'contact.phone.display',
  'contact.phone.type',
  'address.line1',
  'address.line2',
  'address.city',
  'address.region',
  'address.postalCode',
  'address.countryCode',
  'summary',
  'noExperience',
  'availability.earliestStartDate',
  'availability.noticePeriodDays',
  'referralSource',
  // 2026-09-21 填写键扩展（P1-5）：ats-lab 306 张真实申请页里，规则认得出控件却
  // 没有档案键可对的一档，最常缺的就是这些——代词、期望薪资、是否年满 18、
  // 搬迁意愿与城市、办公模式。全部可空：NULL 是「还没问过」，不替用户答。
  'identity.pronouns',
  'compensation.expectedSalaryAmount',
  'compensation.expectedSalaryCurrency',
  'compensation.expectedSalaryPeriod',
  'preferences.workModes',
  'preferences.openToRelocation',
  'preferences.openToRelocationCities',
  // 2026-09-28（argoland，负责人当天的决定）：「可以联系你现在的雇主吗？」是／否，默认没答（NULL）。插件答
  // 「能不能联系现在的雇主」一类的题照它答；只问以前的雇主或推荐人的题也照同一个回答答。它不进扁平填写键：
  // 插件的 worker 本来就读 Profile V2，在那里投影出来（旧服务端不发这一项时读成 null = 没答）。
  'preferences.contactCurrentEmployer',
  // 2026-10-04（argoland #738）：「出差最多能接受多少？」，工作时间的百分比上限（0 / 25 / 50 / 75 / 100），默认没答
  // （NULL）。插件答「能不能出差、能出差多少」一类的题照它答；同样不进扁平填写键，worker 从 Profile V2 投影
  // （旧服务端不发这一项时读成 null = 没答）。
  'preferences.travelPercentMax',
  'eligibility.over18',
] as const;
export type CandidateProfileScalarPathV2 = (typeof PROFILE_V2_SCALAR_PATHS)[number];

export const PROFILE_V2_FACT_SOURCES = [
  'USER',
  'RESUME',
  'PORTAL',
  'DERIVED',
  'LEGACY_MIGRATION',
] as const;
export type ProfileFactSourceV2 = (typeof PROFILE_V2_FACT_SOURCES)[number];

export const PROFILE_V2_AUTHORITY_STATES = [
  'SUGGESTED',
  'USER_CONFIRMED',
  'DERIVED_CONFIRMED',
  'LEGACY_CONFIRMED',
] as const;
export type ProfileAuthorityStateV2 = (typeof PROFILE_V2_AUTHORITY_STATES)[number];

export const PROFILE_V2_SOURCE_REF_KINDS = [
  'RESUME_FACT',
  'DERIVATION',
  'LEGACY_PROFILE',
] as const;
export type ProfileSourceRefKindV2 = (typeof PROFILE_V2_SOURCE_REF_KINDS)[number];

export const PROFILE_V2_PHONE_TYPES = ['MOBILE', 'HOME', 'WORK', 'OTHER'] as const;

/** 期望薪资的计价周期。申请表上三种都常见（年薪、月薪、时薪）。 */
export const PROFILE_V2_SALARY_PERIODS = ['YEAR', 'MONTH', 'HOUR'] as const;
export type ProfileSalaryPeriodV2 = (typeof PROFILE_V2_SALARY_PERIODS)[number];

/** 可接受的办公模式；一个人可以同时接受几种，所以值是子集而不是单选。 */
export const PROFILE_V2_WORK_MODES = ['REMOTE', 'HYBRID', 'ONSITE'] as const;

/**
 * 出差最多能接受多少（工作时间的百分比上限，2026-10-04，argoland #738）：0 不出差、25 偶尔、50、75、100 多少都行。
 */
export const PROFILE_V2_TRAVEL_PERCENTS = [0, 25, 50, 75, 100] as const;
export type ProfileTravelPercentV2 = (typeof PROFILE_V2_TRAVEL_PERCENTS)[number];
export type ProfileWorkModeV2 = (typeof PROFILE_V2_WORK_MODES)[number];

/**
 * 期望薪资金额的规范写法：十进制、不带千分位与货币符号、最多两位小数、无前导零。
 * 存的就是这个字符串（不走浮点），读回来逐字相等。
 */
export const PROFILE_V2_SALARY_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/u;
/** ISO 4217 三字母码，大写。 */
export const PROFILE_V2_CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/u;
export type ProfilePhoneTypeV2 = (typeof PROFILE_V2_PHONE_TYPES)[number];

export const PROFILE_V2_LINK_KINDS = [
  'LINKEDIN',
  'GITHUB',
  'PORTFOLIO',
  'WEBSITE',
  'OTHER',
  // 2026-09-21：Twitter / X。申请表上单独一栏问它（ats-lab 语料 34 次），与
  // LINKEDIN / GITHUB 一样按站点分类，才能作为一个确定的填写键投影出去。
  'TWITTER',
] as const;
export type ProfileLinkKindV2 = (typeof PROFILE_V2_LINK_KINDS)[number];

export const PROFILE_V2_EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'INTERNSHIP',
  'CONTRACT',
  'FREELANCE',
  'VOLUNTEER',
] as const;
export type ProfileEmploymentTypeV2 = (typeof PROFILE_V2_EMPLOYMENT_TYPES)[number];

export const PROFILE_V2_DEGREE_LEVELS = [
  'HIGH_SCHOOL',
  'ASSOCIATE',
  'BACHELOR',
  'MASTER',
  'MBA',
  'JD',
  'MD',
  'PHD',
  'OTHER',
] as const;
export type ProfileDegreeLevelV2 = (typeof PROFILE_V2_DEGREE_LEVELS)[number];

export const PROFILE_V2_SKILL_CATEGORIES = ['TECHNICAL', 'TOOL', 'SOFT'] as const;
export type ProfileSkillCategoryV2 = (typeof PROFILE_V2_SKILL_CATEGORIES)[number];

export const PROFILE_V2_LANGUAGE_PROFICIENCIES = [
  'NATIVE_OR_BILINGUAL',
  'PROFESSIONAL',
  'CONVERSATIONAL',
  'BASIC',
] as const;
export type ProfileLanguageProficiencyV2 =
  (typeof PROFILE_V2_LANGUAGE_PROFICIENCIES)[number];

export const PROFILE_V2_ACHIEVEMENT_KINDS = [
  'IMPACT',
  'LEADERSHIP',
  'AWARD',
  'CERTIFICATION',
  'PUBLICATION',
  'OTHER',
] as const;
export type ProfileAchievementKindV2 = (typeof PROFILE_V2_ACHIEVEMENT_KINDS)[number];

export const PROFILE_V2_ACHIEVEMENT_CONTEXT_TYPES = [
  'EXPERIENCE',
  'PROJECT',
  'EDUCATION',
  'STANDALONE',
] as const;
export type ProfileAchievementContextTypeV2 =
  (typeof PROFILE_V2_ACHIEVEMENT_CONTEXT_TYPES)[number];

export const PROFILE_V2_WORK_AUTHORIZATION_ANSWERS = [
  'YES',
  'NO',
  'UNSPECIFIED',
] as const;
export type ProfileWorkAuthorizationAnswerV2 =
  (typeof PROFILE_V2_WORK_AUTHORIZATION_ANSWERS)[number];

export const PROFILE_V2_LEGACY_FIELD_KEYS = [
  'firstName',
  'lastName',
  'fullName',
  'preferredName',
  'email',
  'phone',
  'linkedinUrl',
  'githubUrl',
  'portfolioUrl',
  'city',
] as const;
export type ProfileLegacyFieldKeyV2 = (typeof PROFILE_V2_LEGACY_FIELD_KEYS)[number];

export const PROFILE_V2_LINK_FIELD_CODES = ['kind', 'label', 'url'] as const;
export type ProfileLinkFieldCodeV2 = (typeof PROFILE_V2_LINK_FIELD_CODES)[number];

export const PROFILE_V2_EXPERIENCE_FIELD_CODES = [
  'company',
  'title',
  'city',
  'region',
  'employmentType',
  'startDate',
  'endDate',
  'isCurrent',
  'description',
] as const;
export type ProfileExperienceFieldCodeV2 =
  (typeof PROFILE_V2_EXPERIENCE_FIELD_CODES)[number];

export const PROFILE_V2_EDUCATION_FIELD_CODES = [
  'school',
  'degree',
  'degreeLevel',
  'fieldOfStudy',
  'city',
  'region',
  'startDate',
  'endDate',
  'expectedGraduationDate',
  'isCurrent',
  'gpa',
  'gpaScale',
  'coursework',
] as const;
export type ProfileEducationFieldCodeV2 =
  (typeof PROFILE_V2_EDUCATION_FIELD_CODES)[number];

export const PROFILE_V2_SKILL_FIELD_CODES = ['name', 'categories'] as const;
export type ProfileSkillFieldCodeV2 = (typeof PROFILE_V2_SKILL_FIELD_CODES)[number];

export const PROFILE_V2_LANGUAGE_FIELD_CODES = ['language', 'proficiency'] as const;
export type ProfileLanguageFieldCodeV2 =
  (typeof PROFILE_V2_LANGUAGE_FIELD_CODES)[number];

export const PROFILE_V2_PROJECT_FIELD_CODES = [
  'title',
  'organization',
  'role',
  'location',
  'url',
  'startDate',
  'endDate',
  'isCurrent',
  'description',
  'skillIds',
] as const;
export type ProfileProjectFieldCodeV2 = (typeof PROFILE_V2_PROJECT_FIELD_CODES)[number];

export const PROFILE_V2_ACHIEVEMENT_FIELD_CODES = [
  'kind',
  'title',
  'statement',
  'occurredAt',
  'url',
  'context',
] as const;
export type ProfileAchievementFieldCodeV2 =
  (typeof PROFILE_V2_ACHIEVEMENT_FIELD_CODES)[number];

export const PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES = [
  'regionCode',
  'authorizedToWork',
  'requiresSponsorship',
] as const;
export type ProfileWorkAuthorizationFieldCodeV2 =
  (typeof PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES)[number];

/**
 * 推荐人（P1-9，2026-09-21）：用户**亲手**存的「谁把我推荐到哪家公司」。只在申请那家公司时、
 * 且只有推荐人姓名会被预填等放行；邮箱、电话一律不代填。`relationship` 是给用户自己看的备注。
 */
export const PROFILE_V2_REFERRAL_FIELD_CODES = ['name', 'company', 'relationship'] as const;
export type ProfileReferralFieldCodeV2 = (typeof PROFILE_V2_REFERRAL_FIELD_CODES)[number];

/**
 * How many rows of each kind one Profile may carry.
 *
 * These are the bounds a resume import has to fit inside, not a guess at a
 * tidy resume. A real senior resume carries far more than twelve roles' worth
 * of history once internships and part-time work are counted, and a skills
 * section of fifty entries is ordinary; the earlier numbers (12 experiences,
 * 6 educations, 40 skills, 20 projects) were below what students actually
 * upload, so an import that read the resume correctly still could not be
 * saved. Raise only with the matching column widths and request-byte budget.
 */
export const PROFILE_V2_COLLECTION_LIMITS = {
  links: 20,
  experiences: 24,
  educations: 12,
  skills: 120,
  languages: 20,
  projects: 40,
  // Full portfolios may carry several outcomes per experience/project; AI byte budgets remain separate.
  achievements: 100,
  workAuthorizations: 20,
  referrals: 20,
  derivationEvidenceFacts: 16,
} as const;

/**
 * How much prose one experience or project may carry.
 *
 * This is the whole bullet list of a single role, not a headline: a senior
 * role on a two-page resume routinely runs a dozen statements. The bound is
 * also handed to the extraction model as a JSON-schema `maxLength`, so a value
 * that merely "looks generous" is not neutral — the model writes to fit it and
 * silently drops the last bullets of a long role. It was 2000, which is about
 * five statements, and long roles came back short because of it.
 */
export const PROFILE_V2_DESCRIPTION_MAX_LENGTH = 12_000;

/**
 * How long one skill name may be.
 *
 * Resume skill lines are not always single words: "Design and delivery of
 * regulated clinical data pipelines (CDISC SDTM/ADaM)" arrives as one entry,
 * and at 80 characters the whole save was rejected rather than that one row
 * flagged. The storage column is widened with this bound.
 */
export const PROFILE_V2_SKILL_NAME_MAX_LENGTH = 120;

export interface DatePart {
  readonly year: number;
  readonly month: number | null;
}

export interface ProfileFactVersionRefV2 {
  readonly factId: Uuid;
  readonly factRevision: DecimalString;
}

export type ProfileFactSourceRefV2 =
  | {
      readonly kind: 'RESUME_FACT';
      readonly resumeVersionId: Uuid;
      readonly parserVersion: SafeToken;
      readonly factId: Uuid;
    }
  | {
      readonly kind: 'DERIVATION';
      readonly policyVersion: SafeToken;
      readonly evidenceFacts: readonly [ProfileFactVersionRefV2, ...ProfileFactVersionRefV2[]];
    }
  | {
      readonly kind: 'LEGACY_PROFILE';
      readonly migrationId: SafeToken;
    }
  | ProfileFactUnrecognizedSourceRefV2
  | null;

/**
 * 读侧（插件）：**更新的服务端**发来的、这一版不认识的来源种类（2026-09-28）。只留 `kind`，
 * 别的成员不读不转发。它对不上任何一种已知来源，于是依赖来源的判断（内核投影的「已确认」）
 * 一律不成立。服务端从不产出这一种——它只存在于旧包读新数据的那段窗口里。
 */
export interface ProfileFactUnrecognizedSourceRefV2 {
  readonly kind: string;
}

export interface ProfileFactMetaV2 {
  /**
   * 已知值见 `PROFILE_V2_FACT_SOURCES`。读侧可能遇到**更新的服务端**加的来源（2026-09-28 起
   * 不再因此整份拒收），所以这里是 `string`：消费端只能拿已知值逐一比对，陌生值对不上，
   * 这条事实就不算已确认。
   */
  readonly source: ProfileFactSourceV2 | string;
  /** 已知值见 `PROFILE_V2_AUTHORITY_STATES`；读侧同上（陌生状态不在确认闭集里 → 不算已确认）。 */
  readonly authorityState: ProfileAuthorityStateV2 | string;
  readonly confidence: number | null;
  readonly userConfirmedAt: IsoDateTime | null;
  readonly sourceRef: ProfileFactSourceRefV2;
}

export interface ProfileFieldAuthorityV2 extends ProfileFactVersionRefV2 {
  readonly deletionEpoch: DecimalString;
  readonly meta: ProfileFactMetaV2;
}

export interface ProfileLinkV2 {
  readonly id: Uuid;
  readonly kind: ProfileLinkKindV2;
  readonly label: BoundedString<1, 80> | null;
  readonly url: SafeHttpUrl<2048>;
  readonly factAuthorityByField: Readonly<
    Record<ProfileLinkFieldCodeV2, ProfileFieldAuthorityV2>
  >;
}

export type PrimaryLinkIdsV2 = Readonly<Record<ProfileLinkKindV2, Uuid | null>>;

export interface ProfileExperienceV2 {
  readonly id: Uuid;
  readonly company: BoundedString<1, 160>;
  readonly title: BoundedString<1, 160>;
  readonly city: BoundedString<1, 120> | null;
  readonly region: BoundedString<1, 120> | null;
  readonly employmentType: ProfileEmploymentTypeV2 | null;
  readonly startDate: DatePart | null;
  readonly endDate: DatePart | null;
  readonly isCurrent: boolean;
  readonly description: BoundedString<1, typeof PROFILE_V2_DESCRIPTION_MAX_LENGTH> | null;
  readonly factAuthorityByField: Readonly<
    Record<ProfileExperienceFieldCodeV2, ProfileFieldAuthorityV2>
  >;
}

export interface ProfileEducationV2 {
  readonly id: Uuid;
  readonly school: BoundedString<1, 160>;
  readonly degree: BoundedString<1, 120> | null;
  readonly degreeLevel: ProfileDegreeLevelV2 | null;
  readonly fieldOfStudy: BoundedString<1, 120> | null;
  readonly city: BoundedString<1, 120> | null;
  readonly region: BoundedString<1, 120> | null;
  readonly startDate: DatePart | null;
  readonly endDate: DatePart | null;
  readonly expectedGraduationDate: DatePart | null;
  readonly isCurrent: boolean;
  readonly gpa: BoundedString<1, 16> | null;
  readonly gpaScale: BoundedString<1, 16> | null;
  readonly coursework: BoundedString<1, 2000> | null;
  readonly factAuthorityByField: Readonly<
    Record<ProfileEducationFieldCodeV2, ProfileFieldAuthorityV2>
  >;
}

export interface ProfileSkillV2 {
  readonly id: Uuid;
  readonly name: BoundedString<1, typeof PROFILE_V2_SKILL_NAME_MAX_LENGTH>;
  readonly categories: readonly ProfileSkillCategoryV2[];
  readonly factAuthorityByField: Readonly<
    Record<ProfileSkillFieldCodeV2, ProfileFieldAuthorityV2>
  >;
}

export interface ProfileLanguageV2 {
  readonly id: Uuid;
  readonly language: BoundedString<1, 80>;
  readonly proficiency: ProfileLanguageProficiencyV2;
  readonly factAuthorityByField: Readonly<
    Record<ProfileLanguageFieldCodeV2, ProfileFieldAuthorityV2>
  >;
}

export interface ProfileProjectV2 {
  readonly id: Uuid;
  readonly title: BoundedString<1, 160>;
  readonly organization: BoundedString<1, 160> | null;
  readonly role: BoundedString<1, 160> | null;
  readonly location: BoundedString<1, 256> | null;
  readonly url: SafeHttpUrl<2048> | null;
  readonly startDate: DatePart | null;
  readonly endDate: DatePart | null;
  readonly isCurrent: boolean;
  readonly description: BoundedString<1, typeof PROFILE_V2_DESCRIPTION_MAX_LENGTH> | null;
  readonly skillIds: readonly Uuid[];
  readonly factAuthorityByField: Readonly<
    Record<ProfileProjectFieldCodeV2, ProfileFieldAuthorityV2>
  >;
}

export type ProfileAchievementContextV2 =
  | { readonly type: 'EXPERIENCE'; readonly itemId: Uuid }
  | { readonly type: 'PROJECT'; readonly itemId: Uuid }
  | { readonly type: 'EDUCATION'; readonly itemId: Uuid }
  | { readonly type: 'STANDALONE'; readonly itemId: null };

export interface ProfileAchievementV2 {
  readonly id: Uuid;
  readonly kind: ProfileAchievementKindV2;
  readonly title: BoundedString<1, 160>;
  readonly statement: BoundedString<1, 1000>;
  readonly occurredAt: DatePart | null;
  readonly url: SafeHttpUrl<2048> | null;
  readonly context: ProfileAchievementContextV2;
  readonly factAuthorityByField: Readonly<
    Record<ProfileAchievementFieldCodeV2, ProfileFieldAuthorityV2>
  >;
}

export type CollectionFactRefV2 =
  | {
      readonly shape: 'COLLECTION_FIELD';
      readonly collection: 'experiences';
      readonly itemId: Uuid;
      readonly field: ProfileExperienceFieldCodeV2;
    }
  | {
      readonly shape: 'COLLECTION_FIELD';
      readonly collection: 'educations';
      readonly itemId: Uuid;
      readonly field: ProfileEducationFieldCodeV2;
    }
  | {
      readonly shape: 'COLLECTION_FIELD';
      readonly collection: 'skills';
      readonly itemId: Uuid;
      readonly field: ProfileSkillFieldCodeV2;
    }
  | {
      readonly shape: 'COLLECTION_FIELD';
      readonly collection: 'languages';
      readonly itemId: Uuid;
      readonly field: ProfileLanguageFieldCodeV2;
    }
  | {
      readonly shape: 'COLLECTION_FIELD';
      readonly collection: 'projects';
      readonly itemId: Uuid;
      readonly field: ProfileProjectFieldCodeV2;
    }
  | {
      readonly shape: 'COLLECTION_FIELD';
      readonly collection: 'achievements';
      readonly itemId: Uuid;
      readonly field: ProfileAchievementFieldCodeV2;
    }
  | {
      readonly shape: 'COLLECTION_FIELD';
      readonly collection: 'referrals';
      readonly itemId: Uuid;
      readonly field: ProfileReferralFieldCodeV2;
    };

export interface ProfileReferralV2 {
  readonly id: Uuid;
  readonly name: BoundedString<1, 160>;
  readonly company: BoundedString<1, 160>;
  readonly relationship: BoundedString<1, 80> | null;
  readonly factAuthorityByField: Readonly<
    Record<ProfileReferralFieldCodeV2, ProfileFieldAuthorityV2>
  >;
}

export interface ProfileWorkAuthorizationV2 {
  readonly regionCode: IsoCountryCode;
  readonly authorizedToWork: ProfileWorkAuthorizationAnswerV2;
  readonly requiresSponsorship: ProfileWorkAuthorizationAnswerV2;
  readonly revision: DecimalString;
  readonly effectiveAt: IsoDateTime;
  readonly expiresAt: IsoDateTime | null;
  readonly revokedAt: IsoDateTime | null;
  readonly factAuthorityByField: Readonly<
    Record<ProfileWorkAuthorizationFieldCodeV2, ProfileFieldAuthorityV2>
  >;
}

export interface CandidateProfileScalarValueByPathV2 {
  readonly 'identity.firstName': BoundedString<1, 80> | null;
  readonly 'identity.middleName': BoundedString<1, 80> | null;
  readonly 'identity.lastName': BoundedString<1, 80> | null;
  readonly 'identity.fullName': BoundedString<1, 256> | null;
  readonly 'identity.preferredName': BoundedString<1, 80> | null;
  readonly 'contact.email': EmailString<254> | null;
  readonly 'contact.phone.countryCode': E164CountryCallingCode | null;
  readonly 'contact.phone.e164': E164PhoneNumber | null;
  readonly 'contact.phone.display': BoundedString<1, 64> | null;
  readonly 'contact.phone.type': ProfilePhoneTypeV2 | null;
  readonly 'address.line1': BoundedString<1, 200> | null;
  readonly 'address.line2': BoundedString<1, 200> | null;
  readonly 'address.city': BoundedString<1, 120> | null;
  readonly 'address.region': BoundedString<1, 120> | null;
  readonly 'address.postalCode': BoundedString<1, 16> | null;
  readonly 'address.countryCode': IsoCountryCode | null;
  readonly summary: BoundedString<1, 2000> | null;
  readonly noExperience: boolean | null;
  readonly 'availability.earliestStartDate': LocalDate | null;
  readonly 'availability.noticePeriodDays': number | null;
  readonly referralSource: BoundedString<1, 64> | null;
  readonly 'identity.pronouns': BoundedString<1, 40> | null;
  readonly 'compensation.expectedSalaryAmount': BoundedString<1, 16> | null;
  readonly 'compensation.expectedSalaryCurrency': BoundedString<3, 3> | null;
  readonly 'compensation.expectedSalaryPeriod': ProfileSalaryPeriodV2 | null;
  readonly 'preferences.workModes': readonly ProfileWorkModeV2[] | null;
  readonly 'preferences.openToRelocation': boolean | null;
  readonly 'preferences.openToRelocationCities': BoundedString<1, 256> | null;
  readonly 'preferences.contactCurrentEmployer': boolean | null;
  readonly 'preferences.travelPercentMax': ProfileTravelPercentV2 | null;
  readonly 'eligibility.over18': boolean | null;
}

export interface ProfileLegacyExperienceLocationV2 {
  readonly experienceId: Uuid;
  readonly value: BoundedString<1, 256>;
}

export interface ProfileLegacyFieldValueV2 {
  readonly fieldKey: ProfileLegacyFieldKeyV2;
  readonly value: BoundedString<1, 2048>;
}

export interface ProfileLegacyUnresolvedV2 {
  readonly profileLocation: BoundedString<1, 256> | null;
  readonly experienceLocations: readonly ProfileLegacyExperienceLocationV2[];
  readonly fieldValues: readonly ProfileLegacyFieldValueV2[];
}

export interface CandidateProfileV2 {
  readonly identity: {
    readonly firstName: BoundedString<1, 80> | null;
    readonly middleName: BoundedString<1, 80> | null;
    readonly lastName: BoundedString<1, 80> | null;
    readonly fullName: BoundedString<1, 256> | null;
    readonly preferredName: BoundedString<1, 80> | null;
    /** 代词（"she/her"）。申请表上是可选题，但问的很多——语料里 130 次。 */
    readonly pronouns: BoundedString<1, 40> | null;
  };
  readonly contact: {
    readonly email: EmailString<254> | null;
    readonly phone: {
      readonly countryCode: E164CountryCallingCode | null;
      readonly e164: E164PhoneNumber | null;
      readonly display: BoundedString<1, 64> | null;
      readonly type: ProfilePhoneTypeV2 | null;
    };
  };
  readonly address: {
    readonly line1: BoundedString<1, 200> | null;
    readonly line2: BoundedString<1, 200> | null;
    readonly city: BoundedString<1, 120> | null;
    readonly region: BoundedString<1, 120> | null;
    readonly postalCode: BoundedString<1, 16> | null;
    readonly countryCode: IsoCountryCode | null;
  };
  readonly summary: BoundedString<1, 2000> | null;
  readonly noExperience: boolean | null;
  readonly links: readonly ProfileLinkV2[];
  readonly primaryLinkIdByKind: PrimaryLinkIdsV2;
  readonly experiences: readonly ProfileExperienceV2[];
  readonly primaryCurrentExperienceId: Uuid | null;
  readonly educations: readonly ProfileEducationV2[];
  readonly skills: readonly ProfileSkillV2[];
  readonly languages: readonly ProfileLanguageV2[];
  readonly projects: readonly ProfileProjectV2[];
  readonly achievements: readonly ProfileAchievementV2[];
  readonly referrals: readonly ProfileReferralV2[];
  readonly legacyUnresolved: ProfileLegacyUnresolvedV2;
  readonly availability: {
    readonly earliestStartDate: LocalDate | null;
    readonly noticePeriodDays: number | null;
  };
  readonly workAuthorizations: readonly ProfileWorkAuthorizationV2[];
  /** 「你从哪听说这个职位的」——一次填写、每份申请复用。 */
  readonly referralSource: string | null;
  /** 期望薪资。三项各自可空；只填了金额没填周期时，填写侧不替他猜是年薪还是时薪。 */
  readonly compensation: {
    readonly expectedSalaryAmount: BoundedString<1, 16> | null;
    readonly expectedSalaryCurrency: BoundedString<3, 3> | null;
    readonly expectedSalaryPeriod: ProfileSalaryPeriodV2 | null;
  };
  /** 工作偏好：办公模式（子集）、是否愿意搬迁、愿意去的城市（自由文本）、可不可以联系现在的雇主。 */
  readonly preferences: {
    readonly workModes: readonly ProfileWorkModeV2[] | null;
    readonly openToRelocation: boolean | null;
    readonly openToRelocationCities: BoundedString<1, 256> | null;
    /** 「可以联系你现在的雇主吗？」（2026-09-28）：null = 还没问过，插件把那一类题交还他本人。 */
    readonly contactCurrentEmployer: boolean | null;
    /**
     * 「出差最多能接受多少？」（2026-10-04，argoland #738）：百分比上限，`PROFILE_V2_TRAVEL_PERCENTS` 之一；null 是没答。
     * 更早的服务端不发这一项：读侧按 null 处理。
     */
    readonly travelPercentMax: ProfileTravelPercentV2 | null;
  };
  /** 资格类的事实题。目前只有「是否年满 18」——美国申请表上的固定一问。 */
  readonly eligibility: {
    readonly over18: boolean | null;
  };
  readonly scalarAuthorityByPath: Partial<
    Readonly<Record<CandidateProfileScalarPathV2, ProfileFieldAuthorityV2>>
  >;
  readonly referenceAuthority: {
    readonly primaryLinkIdByKind: Partial<
      Readonly<Record<ProfileLinkKindV2, ProfileFieldAuthorityV2>>
    >;
    readonly primaryCurrentExperienceId: ProfileFieldAuthorityV2 | null;
  };
}

export interface CandidateProfileSnapshotV2 {
  readonly schemaVersion: 2;
  readonly revision: DecimalString;
  readonly deletionEpoch: DecimalString;
  readonly hasStoredProfile: boolean;
  readonly updatedAt: IsoDateTime | null;
  readonly profile: CandidateProfileV2;
}

export type CandidateProfileScalarPatchV2 = Partial<{
  readonly [Path in CandidateProfileScalarPathV2]:
    CandidateProfileScalarValueByPathV2[Path];
}>;

export type ProfileCollectionItemMutationV2<
  Values,
  FieldCode extends string,
> = Values &
  (
    | { readonly id?: never; readonly confirmFields: readonly FieldCode[] }
    | { readonly id: Uuid; readonly confirmFields: readonly FieldCode[] }
  );

export type ProfileLinkMutationV2 = ProfileCollectionItemMutationV2<
  {
    readonly kind: ProfileLinkKindV2;
    readonly label: BoundedString<1, 80> | null;
    readonly url: SafeHttpUrl<2048>;
  },
  ProfileLinkFieldCodeV2
>;

export type ProfileExperienceMutationV2 = ProfileCollectionItemMutationV2<
  {
    readonly company: BoundedString<1, 160>;
    readonly title: BoundedString<1, 160>;
    readonly city: BoundedString<1, 120> | null;
    readonly region: BoundedString<1, 120> | null;
    readonly employmentType: ProfileEmploymentTypeV2 | null;
    readonly startDate: DatePart | null;
    readonly endDate: DatePart | null;
    readonly isCurrent: boolean;
    readonly description: BoundedString<1, typeof PROFILE_V2_DESCRIPTION_MAX_LENGTH> | null;
  },
  ProfileExperienceFieldCodeV2
>;

export type ProfileEducationMutationV2 = ProfileCollectionItemMutationV2<
  {
    readonly school: BoundedString<1, 160>;
    readonly degree: BoundedString<1, 120> | null;
    readonly degreeLevel: ProfileDegreeLevelV2 | null;
    readonly fieldOfStudy: BoundedString<1, 120> | null;
    readonly city: BoundedString<1, 120> | null;
    readonly region: BoundedString<1, 120> | null;
    readonly startDate: DatePart | null;
    readonly endDate: DatePart | null;
    readonly expectedGraduationDate: DatePart | null;
    readonly isCurrent: boolean;
    readonly gpa: BoundedString<1, 16> | null;
    readonly gpaScale: BoundedString<1, 16> | null;
    readonly coursework: BoundedString<1, 2000> | null;
  },
  ProfileEducationFieldCodeV2
>;

export type ProfileSkillMutationV2 = ProfileCollectionItemMutationV2<
  {
    readonly name: BoundedString<1, typeof PROFILE_V2_SKILL_NAME_MAX_LENGTH>;
    readonly categories: readonly ProfileSkillCategoryV2[];
  },
  ProfileSkillFieldCodeV2
>;

export type ProfileLanguageMutationV2 = ProfileCollectionItemMutationV2<
  {
    readonly language: BoundedString<1, 80>;
    readonly proficiency: ProfileLanguageProficiencyV2;
  },
  ProfileLanguageFieldCodeV2
>;

export type ProfileProjectMutationV2 = ProfileCollectionItemMutationV2<
  {
    readonly title: BoundedString<1, 160>;
    readonly organization: BoundedString<1, 160> | null;
    readonly role: BoundedString<1, 160> | null;
    readonly location: BoundedString<1, 256> | null;
    readonly url: SafeHttpUrl<2048> | null;
    readonly startDate: DatePart | null;
    readonly endDate: DatePart | null;
    readonly isCurrent: boolean;
    readonly description: BoundedString<1, typeof PROFILE_V2_DESCRIPTION_MAX_LENGTH> | null;
    readonly skillIds: readonly Uuid[];
  },
  ProfileProjectFieldCodeV2
>;

export type ProfileAchievementMutationV2 = ProfileCollectionItemMutationV2<
  {
    readonly kind: ProfileAchievementKindV2;
    readonly title: BoundedString<1, 160>;
    readonly statement: BoundedString<1, 1000>;
    readonly occurredAt: DatePart | null;
    readonly url: SafeHttpUrl<2048> | null;
    readonly context: ProfileAchievementContextV2;
  },
  ProfileAchievementFieldCodeV2
>;

export type ProfileReferralMutationV2 = ProfileCollectionItemMutationV2<
  {
    readonly name: BoundedString<1, 160>;
    readonly company: BoundedString<1, 160>;
    readonly relationship: BoundedString<1, 80> | null;
  },
  ProfileReferralFieldCodeV2
>;

export interface ProfileWorkAuthorizationMutationV2 {
  readonly regionCode: IsoCountryCode;
  readonly authorizedToWork: ProfileWorkAuthorizationAnswerV2;
  readonly requiresSponsorship: ProfileWorkAuthorizationAnswerV2;
  readonly confirmFields: readonly ProfileWorkAuthorizationFieldCodeV2[];
}

export interface ProfileLegacyResolutionV2 {
  readonly clearProfileLocation: boolean;
  readonly clearExperienceLocationIds: readonly Uuid[];
  readonly clearFieldKeys: readonly ProfileLegacyFieldKeyV2[];
}

export interface PatchCandidateProfileV2 {
  readonly schemaVersion: 2;
  readonly expectedRevision: DecimalString;
  readonly expectedDeletionEpoch: DecimalString;
  readonly fields?: CandidateProfileScalarPatchV2;
  readonly links?: readonly ProfileLinkMutationV2[];
  readonly primaryLinkIdByKind?: PrimaryLinkIdsV2;
  readonly experiences?: readonly ProfileExperienceMutationV2[];
  readonly primaryCurrentExperienceId?: Uuid | null;
  readonly educations?: readonly ProfileEducationMutationV2[];
  readonly skills?: readonly ProfileSkillMutationV2[];
  readonly languages?: readonly ProfileLanguageMutationV2[];
  readonly projects?: readonly ProfileProjectMutationV2[];
  readonly achievements?: readonly ProfileAchievementMutationV2[];
  readonly referrals?: readonly ProfileReferralMutationV2[];
  readonly workAuthorizations?: readonly ProfileWorkAuthorizationMutationV2[];
  readonly legacyResolution?: ProfileLegacyResolutionV2;
}
