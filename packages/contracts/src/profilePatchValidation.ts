import {
  PROFILE_V2_ACHIEVEMENT_CONTEXT_TYPES,
  PROFILE_V2_ACHIEVEMENT_FIELD_CODES,
  PROFILE_V2_REFERRAL_FIELD_CODES,
  PROFILE_V2_ACHIEVEMENT_KINDS,
  PROFILE_V2_COLLECTION_LIMITS,
  PROFILE_V2_DEGREE_LEVELS,
  PROFILE_V2_EDUCATION_FIELD_CODES,
  PROFILE_V2_EMPLOYMENT_TYPES,
  PROFILE_V2_EXPERIENCE_FIELD_CODES,
  PROFILE_V2_LANGUAGE_FIELD_CODES,
  PROFILE_V2_LANGUAGE_PROFICIENCIES,
  PROFILE_V2_LINK_FIELD_CODES,
  PROFILE_V2_LINK_KINDS,
  PROFILE_V2_LEGACY_FIELD_KEYS,
  PROFILE_V2_PHONE_TYPES,
  PROFILE_V2_PROJECT_FIELD_CODES,
  PROFILE_V2_SCALAR_PATHS,
  PROFILE_V2_SCHEMA_VERSION,
  PROFILE_V2_SKILL_CATEGORIES,
  PROFILE_V2_SKILL_FIELD_CODES,
  PROFILE_V2_WORK_AUTHORIZATION_ANSWERS,
  PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES,
  type CandidateProfileScalarPatchV2,
  type CandidateProfileScalarPathV2,
  type DatePart,
  type PatchCandidateProfileV2,
  type PrimaryLinkIdsV2,
  type ProfileAchievementMutationV2,
  type ProfileReferralMutationV2,
  type ProfileEducationMutationV2,
  type ProfileExperienceMutationV2,
  type ProfileLanguageMutationV2,
  type ProfileLegacyResolutionV2,
  type ProfileLinkMutationV2,
  type ProfileProjectMutationV2,
  type ProfileSkillMutationV2,
  type ProfileWorkAuthorizationMutationV2,
} from './profileV2.ts';
import { parseLocalDate, parseUuid } from './common.ts';
import { parseIsoCountryCode } from './sensitiveWrite.ts';
const INVALID_PATCH = Symbol('INVALID_PROFILE_PATCH');

const PATCH_KEYS = [
  'schemaVersion',
  'expectedRevision',
  'expectedDeletionEpoch',
  'fields',
  'links',
  'primaryLinkIdByKind',
  'experiences',
  'primaryCurrentExperienceId',
  'educations',
  'skills',
  'languages',
  'projects',
  'achievements',
  'referrals',
  'workAuthorizations',
  'legacyResolution',
] as const;
const MUTATION_KEYS = PATCH_KEYS.filter(
  (key) => key !== 'schemaVersion' && key !== 'expectedRevision' && key !== 'expectedDeletionEpoch',
);
const LINK_KINDS = new Set<string>(PROFILE_V2_LINK_KINDS);
const PHONE_TYPES = new Set<string>(PROFILE_V2_PHONE_TYPES);
const EMPLOYMENT_TYPES = new Set<string>(PROFILE_V2_EMPLOYMENT_TYPES);
const DEGREE_LEVELS = new Set<string>(PROFILE_V2_DEGREE_LEVELS);
const SKILL_CATEGORIES = new Set<string>(PROFILE_V2_SKILL_CATEGORIES);
const LANGUAGE_PROFICIENCIES = new Set<string>(PROFILE_V2_LANGUAGE_PROFICIENCIES);
const ACHIEVEMENT_KINDS = new Set<string>(PROFILE_V2_ACHIEVEMENT_KINDS);
const ACHIEVEMENT_CONTEXT_TYPES = new Set<string>(PROFILE_V2_ACHIEVEMENT_CONTEXT_TYPES);
const WORK_AUTHORIZATION_ANSWERS = new Set<string>(
  PROFILE_V2_WORK_AUTHORIZATION_ANSWERS,
);
const SCALAR_PATHS = new Set<string>(PROFILE_V2_SCALAR_PATHS);
const DECIMAL_STRING = /^(?:0|[1-9][0-9]*)$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CALLING_CODE = /^\+[1-9][0-9]{0,2}$/u;
const E164 = /^\+[1-9][0-9]{1,14}$/u;
const COUNTRY_CODE = /^[A-Z]{2}$/u;

type PlainRecord = Record<string, unknown>;

/** Shared normalization/validation source; HTTP consumers map null to VALIDATION_FAILED. */
export function parseCandidateProfileV2Patch(input: unknown): PatchCandidateProfileV2 | null {
  try { return parsePatch(input); }
  catch (error) { if (error === INVALID_PATCH) return null; throw error; }
}

function parsePatch(input: unknown): PatchCandidateProfileV2 {
  const object = exactObject(input, PATCH_KEYS);
  if (object.schemaVersion !== PROFILE_V2_SCHEMA_VERSION) invalid();
  const expectedRevision = decimalString(object.expectedRevision);
  const expectedDeletionEpoch = decimalString(object.expectedDeletionEpoch);
  if (!MUTATION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(object, key))) invalid();

  const parsed: Record<string, unknown> = {
    schemaVersion: PROFILE_V2_SCHEMA_VERSION,
    expectedRevision,
    expectedDeletionEpoch,
  };
  if ('fields' in object) parsed.fields = parseScalarPatch(object.fields);
  if ('links' in object) {
    parsed.links = parseCollection(
      object.links,
      PROFILE_V2_COLLECTION_LIMITS.links,
      parseLink,
      'id',
    );
  }
  if ('primaryLinkIdByKind' in object) {
    parsed.primaryLinkIdByKind = parsePrimaryLinks(object.primaryLinkIdByKind);
  }
  if ('experiences' in object) {
    parsed.experiences = parseCollection(
      object.experiences,
      PROFILE_V2_COLLECTION_LIMITS.experiences,
      parseExperience,
      'id',
    );
  }
  if ('primaryCurrentExperienceId' in object) {
    parsed.primaryCurrentExperienceId = nullableUuid(object.primaryCurrentExperienceId);
  }
  if ('educations' in object) {
    parsed.educations = parseCollection(
      object.educations,
      PROFILE_V2_COLLECTION_LIMITS.educations,
      parseEducation,
      'id',
    );
  }
  if ('skills' in object) {
    const skills = parseCollection(
      object.skills,
      PROFILE_V2_COLLECTION_LIMITS.skills,
      parseSkill,
      'id',
    );
    uniqueNormalized(skills.map((skill) => skill.name));
    parsed.skills = skills;
  }
  if ('languages' in object) {
    const languages = parseCollection(
      object.languages,
      PROFILE_V2_COLLECTION_LIMITS.languages,
      parseLanguage,
      'id',
    );
    uniqueNormalized(languages.map((language) => language.language));
    parsed.languages = languages;
  }
  if ('projects' in object) {
    parsed.projects = parseCollection(
      object.projects,
      PROFILE_V2_COLLECTION_LIMITS.projects,
      parseProject,
      'id',
    );
  }
  if ('achievements' in object) {
    parsed.achievements = parseCollection(
      object.achievements,
      PROFILE_V2_COLLECTION_LIMITS.achievements,
      parseAchievement,
      'id',
    );
  }
  if ('referrals' in object) {
    parsed.referrals = parseCollection(
      object.referrals,
      PROFILE_V2_COLLECTION_LIMITS.referrals,
      parseReferral,
      'id',
    );
  }
  if ('workAuthorizations' in object) {
    const workAuthorizations = parseCollection(
      object.workAuthorizations,
      PROFILE_V2_COLLECTION_LIMITS.workAuthorizations,
      parseWorkAuthorization,
      'regionCode',
    );
    assertSortedUnique(workAuthorizations.map((entry) => entry.regionCode));
    parsed.workAuthorizations = workAuthorizations;
  }
  if ('legacyResolution' in object) {
    parsed.legacyResolution = parseLegacyResolution(object.legacyResolution);
  }
  validateSuppliedPhonePair(parsed.fields as CandidateProfileScalarPatchV2 | undefined);
  return parsed as unknown as PatchCandidateProfileV2;
}

function parseScalarPatch(value: unknown): CandidateProfileScalarPatchV2 {
  const object = plainObject(value);
  if (Object.keys(object).length === 0) invalid();
  const parsed: Record<string, unknown> = {};
  for (const [path, rawValue] of Object.entries(object)) {
    if (!SCALAR_PATHS.has(path)) invalid();
    parsed[path] = parseScalar(path as CandidateProfileScalarPathV2, rawValue);
  }
  return parsed as CandidateProfileScalarPatchV2;
}

function parseScalar(path: CandidateProfileScalarPathV2, value: unknown): unknown {
  if (value === null) return null;
  switch (path) {
    case 'identity.firstName':
    case 'identity.middleName':
    case 'identity.lastName':
    case 'identity.preferredName':
      return boundedString(value, 80);
    case 'identity.fullName':
      return boundedString(value, 256);
    case 'contact.email': {
      const email = boundedString(value, 254);
      if (!EMAIL.test(email)) invalid();
      return email;
    }
    case 'contact.phone.countryCode': {
      const callingCode = boundedString(value, 4);
      if (!CALLING_CODE.test(callingCode)) invalid();
      return callingCode;
    }
    case 'contact.phone.e164': {
      const phone = boundedString(value, 16);
      if (!E164.test(phone)) invalid();
      return phone;
    }
    case 'contact.phone.display':
      return boundedString(value, 64);
    case 'contact.phone.type':
      return enumValue(value, PHONE_TYPES);
    case 'address.line1':
    case 'address.line2':
      return boundedString(value, 200);
    case 'address.city':
    case 'address.region':
      return boundedString(value, 120);
    case 'address.postalCode':
      return boundedString(value, 16);
    case 'address.countryCode':
      return isoCountryCode(value);
    case 'summary':
      return boundedString(value, 2000);
    case 'noExperience':
      if (typeof value !== 'boolean') invalid();
      return value;
    case 'availability.earliestStartDate': {
      const date = parseLocalDate(value);
      if (date === null) invalid();
      return date;
    }
    case 'availability.noticePeriodDays':
      if (!Number.isInteger(value) || typeof value !== 'number' || value < 0 || value > 365) {
        invalid();
      }
      return value;
    // `mobility.*` 在 argoland 2026-09 的契约变更里换成了 `referralSource`；
    // 这边跟版（RULE-EXT-CONTRACT-CONSUMER，权威在 argoland）。
    case 'referralSource':
      if (typeof value !== 'string' || value.length < 1 || value.length > 64) invalid();
      return value;
  }
}

function parseLink(value: unknown): ProfileLinkMutationV2 {
  const object = exactObject(value, ['id', 'kind', 'label', 'url', 'confirmFields']);
  return {
    ...optionalId(object),
    kind: enumValue(object.kind, LINK_KINDS),
    label: nullableBoundedString(object.label, 80),
    url: safeHttpUrl(object.url),
    confirmFields: confirmFields(object, PROFILE_V2_LINK_FIELD_CODES),
  } as ProfileLinkMutationV2;
}

function parseExperience(value: unknown): ProfileExperienceMutationV2 {
  const object = exactObject(value, [
    'id',
    ...PROFILE_V2_EXPERIENCE_FIELD_CODES,
    'confirmFields',
  ]);
  const startDate = nullableDatePart(object.startDate);
  const endDate = nullableDatePart(object.endDate);
  const isCurrent = booleanValue(object.isCurrent);
  if (isCurrent && endDate !== null) invalid();
  validateDateRange(startDate, endDate);
  return {
    ...optionalId(object),
    company: boundedString(object.company, 160),
    title: boundedString(object.title, 160),
    city: nullableBoundedString(object.city, 120),
    region: nullableBoundedString(object.region, 120),
    employmentType:
      object.employmentType === null ? null : enumValue(object.employmentType, EMPLOYMENT_TYPES),
    startDate,
    endDate,
    isCurrent,
    description: nullableBoundedString(object.description, 2000),
    confirmFields: confirmFields(object, PROFILE_V2_EXPERIENCE_FIELD_CODES),
  } as ProfileExperienceMutationV2;
}

function parseEducation(value: unknown): ProfileEducationMutationV2 {
  const object = exactObject(value, [
    'id',
    ...PROFILE_V2_EDUCATION_FIELD_CODES,
    'confirmFields',
  ]);
  const startDate = nullableDatePart(object.startDate);
  const endDate = nullableDatePart(object.endDate);
  const expectedGraduationDate = nullableDatePart(object.expectedGraduationDate);
  const isCurrent = booleanValue(object.isCurrent);
  if (isCurrent) {
    if (endDate !== null || expectedGraduationDate === null) invalid();
    validateDateRange(startDate, expectedGraduationDate);
  } else {
    if (expectedGraduationDate !== null) invalid();
    validateDateRange(startDate, endDate);
  }
  return {
    ...optionalId(object),
    school: boundedString(object.school, 160),
    degree: nullableBoundedString(object.degree, 120),
    degreeLevel:
      object.degreeLevel === null ? null : enumValue(object.degreeLevel, DEGREE_LEVELS),
    fieldOfStudy: nullableBoundedString(object.fieldOfStudy, 120),
    city: nullableBoundedString(object.city, 120),
    region: nullableBoundedString(object.region, 120),
    startDate,
    endDate,
    expectedGraduationDate,
    isCurrent,
    gpa: nullableBoundedString(object.gpa, 16),
    gpaScale: nullableBoundedString(object.gpaScale, 16),
    coursework: nullableBoundedString(object.coursework, 2000),
    confirmFields: confirmFields(object, PROFILE_V2_EDUCATION_FIELD_CODES),
  } as ProfileEducationMutationV2;
}

function parseSkill(value: unknown): ProfileSkillMutationV2 {
  const object = exactObject(value, ['id', ...PROFILE_V2_SKILL_FIELD_CODES, 'confirmFields']);
  return {
    ...optionalId(object),
    name: boundedString(object.name, 80),
    categories: sortedUniqueEnums(object.categories, SKILL_CATEGORIES, true),
    confirmFields: confirmFields(object, PROFILE_V2_SKILL_FIELD_CODES),
  } as unknown as ProfileSkillMutationV2;
}

function parseLanguage(value: unknown): ProfileLanguageMutationV2 {
  const object = exactObject(value, ['id', ...PROFILE_V2_LANGUAGE_FIELD_CODES, 'confirmFields']);
  return {
    ...optionalId(object),
    language: boundedString(object.language, 80),
    proficiency: enumValue(object.proficiency, LANGUAGE_PROFICIENCIES),
    confirmFields: confirmFields(object, PROFILE_V2_LANGUAGE_FIELD_CODES),
  } as ProfileLanguageMutationV2;
}

function parseProject(value: unknown): ProfileProjectMutationV2 {
  const object = exactObject(value, ['id', ...PROFILE_V2_PROJECT_FIELD_CODES, 'confirmFields']);
  const startDate = nullableDatePart(object.startDate);
  const endDate = nullableDatePart(object.endDate);
  const isCurrent = booleanValue(object.isCurrent);
  if (isCurrent && endDate !== null) invalid();
  validateDateRange(startDate, endDate);
  return {
    ...optionalId(object),
    title: boundedString(object.title, 160),
    organization: nullableBoundedString(object.organization, 160),
    role: nullableBoundedString(object.role, 160),
    location: nullableBoundedString(object.location, 256),
    url: object.url === null ? null : safeHttpUrl(object.url),
    startDate,
    endDate,
    isCurrent,
    description: nullableBoundedString(object.description, 2000),
    skillIds: sortedUniqueUuids(object.skillIds),
    confirmFields: confirmFields(object, PROFILE_V2_PROJECT_FIELD_CODES),
  } as unknown as ProfileProjectMutationV2;
}

function parseReferral(value: unknown): ProfileReferralMutationV2 {
  const object = exactObject(value, ['id', ...PROFILE_V2_REFERRAL_FIELD_CODES, 'confirmFields']);
  return {
    ...optionalId(object),
    name: boundedString(object.name, 160),
    company: boundedString(object.company, 160),
    relationship: nullableBoundedString(object.relationship, 80),
    confirmFields: confirmFields(object, PROFILE_V2_REFERRAL_FIELD_CODES),
  } as ProfileReferralMutationV2;
}

function parseAchievement(value: unknown): ProfileAchievementMutationV2 {
  const object = exactObject(value, [
    'id',
    ...PROFILE_V2_ACHIEVEMENT_FIELD_CODES,
    'confirmFields',
  ]);
  const context = exactObject(object.context, ['type', 'itemId']);
  const type = enumValue(context.type, ACHIEVEMENT_CONTEXT_TYPES);
  const itemId = type === 'STANDALONE' ? nullValue(context.itemId) : requiredUuid(context.itemId);
  return {
    ...optionalId(object),
    kind: enumValue(object.kind, ACHIEVEMENT_KINDS),
    title: boundedString(object.title, 160),
    statement: boundedString(object.statement, 1000),
    occurredAt: nullableDatePart(object.occurredAt),
    url: object.url === null ? null : safeHttpUrl(object.url),
    context: { type, itemId },
    confirmFields: confirmFields(object, PROFILE_V2_ACHIEVEMENT_FIELD_CODES),
  } as ProfileAchievementMutationV2;
}

function parseWorkAuthorization(value: unknown): ProfileWorkAuthorizationMutationV2 {
  const object = exactObject(value, [
    ...PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES,
    'confirmFields',
  ]);
  const regionCode = parseIsoCountryCode(object.regionCode);
  if (regionCode === null) invalid();
  return {
    regionCode,
    authorizedToWork: enumValue(object.authorizedToWork, WORK_AUTHORIZATION_ANSWERS),
    requiresSponsorship: enumValue(
      object.requiresSponsorship,
      WORK_AUTHORIZATION_ANSWERS,
    ),
    confirmFields: confirmFields(object, PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES),
  } as ProfileWorkAuthorizationMutationV2;
}

function parsePrimaryLinks(value: unknown): PrimaryLinkIdsV2 {
  const object = exactObject(value, PROFILE_V2_LINK_KINDS);
  return Object.freeze(
    Object.fromEntries(
      PROFILE_V2_LINK_KINDS.map((kind) => [kind, nullableUuid(object[kind])]),
    ),
  ) as PrimaryLinkIdsV2;
}

function parseLegacyResolution(value: unknown): ProfileLegacyResolutionV2 {
  const object = exactObject(value, [
    'clearProfileLocation',
    'clearExperienceLocationIds',
    'clearFieldKeys',
  ]);
  return {
    clearProfileLocation: booleanValue(object.clearProfileLocation),
    clearExperienceLocationIds: sortedUniqueUuids(object.clearExperienceLocationIds),
    clearFieldKeys: canonicalUniqueEnums(
      object.clearFieldKeys,
      PROFILE_V2_LEGACY_FIELD_KEYS,
    ),
  } as unknown as ProfileLegacyResolutionV2;
}

function canonicalUniqueEnums<const Value extends string>(
  value: unknown,
  canonicalOrder: readonly Value[],
): readonly Value[] {
  if (!Array.isArray(value)) invalid();
  const index = new Map<string, number>(canonicalOrder.map((item, position) => [item, position]));
  let previous = -1;
  for (const item of value) {
    if (typeof item !== 'string') invalid();
    const position = index.get(item);
    if (position === undefined || position <= previous) invalid();
    previous = position;
  }
  return value as Value[];
}

function confirmFields<const Field extends string>(
  object: PlainRecord,
  fields: readonly Field[],
): readonly Field[] {
  const values = sortedUniqueEnums(object.confirmFields, new Set<string>(fields), false) as Field[];
  if (!('id' in object) && !sameSet(values, fields)) invalid();
  return values;
}

function parseCollection<T>(
  value: unknown,
  maximum: number,
  parser: (input: unknown) => T,
  idKey: string,
): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  const parsed = value.map(parser);
  const ids = parsed
    .map((item) =>
      item !== null && typeof item === 'object'
        ? (item as Readonly<Record<string, unknown>>)[idKey]
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string');
  if (new Set(ids).size !== ids.length) invalid();
  return parsed;
}

function sortedUniqueEnums(
  value: unknown,
  allowed: ReadonlySet<string>,
  requireNonEmpty: boolean,
): string[] {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) invalid();
  if (!value.every((item): item is string => typeof item === 'string' && allowed.has(item))) {
    invalid();
  }
  assertSortedUnique(value);
  return [...value];
}

function sortedUniqueUuids(value: unknown): string[] {
  if (!Array.isArray(value)) invalid();
  const parsed = value.map(requiredUuid);
  assertSortedUnique(parsed);
  return parsed;
}

function assertSortedUnique(values: readonly string[]): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) invalid();
  }
}

function optionalId(object: PlainRecord): Readonly<{ id?: string }> {
  return 'id' in object ? { id: requiredUuid(object.id) } : {};
}

function decimalString(value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL_STRING.test(value)) invalid();
  return value;
}

function requiredUuid(value: unknown): string {
  const parsed = parseUuid(value);
  if (parsed === null) invalid();
  return parsed;
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : requiredUuid(value);
}

function isoCountryCode(value: unknown): string {
  if (typeof value !== 'string' || !COUNTRY_CODE.test(value)) invalid();
  return value;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || containsControlCharacter(value)) invalid();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) invalid();
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))) {
      return true;
    }
  }
  return false;
}

function nullableBoundedString(value: unknown, maximum: number): string | null {
  return value === null ? null : boundedString(value, maximum);
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): string {
  if (typeof value !== 'string' || !allowed.has(value)) invalid();
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function nullableDatePart(value: unknown): DatePart | null {
  if (value === null) return null;
  const object = exactObject(value, ['year', 'month']);
  if (typeof object.year !== 'number' || !Number.isInteger(object.year)) invalid();
  if (object.year < 1900 || object.year > 2100) invalid();
  if (
    object.month !== null &&
    (typeof object.month !== 'number' ||
      !Number.isInteger(object.month) ||
      object.month < 1 ||
      object.month > 12)
  ) {
    invalid();
  }
  return { year: object.year, month: object.month };
}

function validateDateRange(start: DatePart | null, end: DatePart | null): void {
  if (start === null || end === null) return;
  const startLowerBound = start.year * 12 + (start.month ?? 1);
  const endUpperBound = end.year * 12 + (end.month ?? 12);
  if (startLowerBound > endUpperBound) invalid();
}

function validateSuppliedPhonePair(fields: CandidateProfileScalarPatchV2 | undefined): void {
  if (!fields) return;
  const hasCallingCode = Object.prototype.hasOwnProperty.call(
    fields,
    'contact.phone.countryCode',
  );
  const hasPhone = Object.prototype.hasOwnProperty.call(fields, 'contact.phone.e164');
  if (!hasCallingCode || !hasPhone) return;
  const callingCode = fields['contact.phone.countryCode'];
  const phone = fields['contact.phone.e164'];
  if (
    typeof phone === 'string' &&
    (typeof callingCode !== 'string' ||
      !phone.startsWith(callingCode) ||
      String(phone) === String(callingCode))
  ) {
    invalid();
  }
}

function safeHttpUrl(value: unknown): string {
  const raw = boundedString(value, 2048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    invalid();
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    invalid();
  }
  return raw;
}

function nullValue(value: unknown): null {
  if (value !== null) invalid();
  return null;
}

function uniqueNormalized(values: readonly string[]): void {
  const normalized = values.map((value) => value.normalize('NFKC').toLocaleLowerCase('en-US').trim());
  if (new Set(normalized).size !== normalized.length) invalid();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function exactObject<const Key extends string>(value: unknown, keys: readonly Key[]): PlainRecord {
  const object = plainObject(value);
  const allowed = new Set<string>(keys);
  if (Object.keys(object).some((key) => !allowed.has(key))) invalid();
  return object;
}

function plainObject(value: unknown): PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (
    Object.prototype.hasOwnProperty.call(value, '__proto__') ||
    Object.prototype.hasOwnProperty.call(value, 'prototype') ||
    Object.prototype.hasOwnProperty.call(value, 'constructor')
  ) {
    invalid();
  }
  return value as PlainRecord;
}

function invalid(): never {
  throw INVALID_PATCH;
}
