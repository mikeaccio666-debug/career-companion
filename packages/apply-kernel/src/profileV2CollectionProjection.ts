/**
 * Candidate Profile V2 -> owner-bound, UUID-keyed collection values for apply-kernel.
 *
 * This is deliberately an input adapter, not runtime wiring. It knows no ATS, selector,
 * DOM node, row-add action, writer or Submit path. A future caller must still recheck the
 * returned owner/revision/deletion fence before it gives any value to a writer.
 *
 * Profile V2 item UUIDs are the row identity. Source order is retained only as presentation
 * order; it is never promoted to identity. `ApplyProfileCollections` remains the existing
 * three-collection compatibility view, plus (2026-10-04) the confirmed languages: they are no
 * row-fill role, only the evidence the kernel answers language questions from
 * (dict/languages.ts). Projects and achievements stay only in the keyed rows for future
 * Answer Resolution / UA-5 consumers, so this adapter does not invent execution-field
 * authority for them. An invalid sibling never shifts another row's identity.
 */

import {
  PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1,
  PROFILE_V2_ACHIEVEMENT_CONTEXT_TYPES,
  PROFILE_V2_ACHIEVEMENT_KINDS,
  PROFILE_V2_COLLECTION_LIMITS,
  PROFILE_V2_DEGREE_LEVELS,
  PROFILE_V2_EMPLOYMENT_TYPES,
  PROFILE_V2_LANGUAGE_PROFICIENCIES,
  parseIsoDateTime,
  parseSafeToken,
  parseUuid,
  type CandidateProfileSnapshotV2,
  type DecimalString,
  type ProfileAchievementV2,
  type ProfileAnswerSourceReasonCodeV1,
  type ProfileEducationV2,
  type ProfileExperienceV2,
  type ProfileLanguageV2,
  type ProfileProjectV2,
  type ProfileSkillV2,
  type Uuid,
} from '@edaix/contracts';

import {
  type ApplyProfileCollections,
  type ConfirmedDatePart,
  type DegreeLevel,
  type EmploymentType,
  type ProfileEducation,
  type ProfileExperience,
  type ProfileLanguage,
} from './profileCollections.ts';

export type OwnerBoundCandidateProfileCollectionSnapshot = Readonly<{
  /** Must be supplied by the same authenticated owner read that produced `snapshot`. */
  ownerId: Uuid;
  snapshot: CandidateProfileSnapshotV2;
}>;

export type ProfileV2CollectionProjectionInput = Readonly<{
  authenticatedOwnerId: Uuid;
  ownerBoundSnapshot: OwnerBoundCandidateProfileCollectionSnapshot;
  /** Independently revalidated current Profile fence; never copy it from an untrusted payload. */
  expectedProfileRevision: CandidateProfileSnapshotV2['revision'];
  /** Independently revalidated current deletion fence. */
  expectedDeletionEpoch: CandidateProfileSnapshotV2['deletionEpoch'];
}>;

type ProfileV2ProjectionFence = Readonly<{
  revision: CandidateProfileSnapshotV2['revision'];
  deletionEpoch: CandidateProfileSnapshotV2['deletionEpoch'];
}>;

export type ProfileV2CollectionProjectionFailureReason =
  | Extract<
      ProfileAnswerSourceReasonCodeV1,
      | 'PROFILE_SOURCE_PROFILE_MISSING'
      | 'PROFILE_SOURCE_PROFILE_DELETED'
      | 'PROFILE_SOURCE_OWNER_MISMATCH'
      | 'PROFILE_SOURCE_REVISION_STALE'
      | 'PROFILE_SOURCE_DELETION_EPOCH_STALE'
    >
  /** Local parser boundary only; this code is not an HTTP or cross-process wire. */
  | 'PROFILE_V2_COLLECTION_SNAPSHOT_INVALID';

export type ProfileV2CollectionRow<Value> = Readonly<{
  rowKey: Uuid;
  value: Value;
}>;

/** Values are derived from the executable Profile V2 contract, never re-declared here. */
export type ProfileV2LanguageProjectionValue = Readonly<
  Omit<ProfileLanguageV2, 'id' | 'factAuthorityByField'>
>;
export type ProfileV2ProjectProjectionValue = Readonly<
  Omit<ProfileProjectV2, 'id' | 'factAuthorityByField'>
>;
export type ProfileV2AchievementProjectionValue = Readonly<
  Omit<ProfileAchievementV2, 'id' | 'factAuthorityByField'>
>;

type ProfileV2CollectionFieldCode =
  | keyof ProfileExperienceV2['factAuthorityByField']
  | keyof ProfileEducationV2['factAuthorityByField']
  | keyof ProfileSkillV2['factAuthorityByField']
  | keyof ProfileLanguageV2['factAuthorityByField']
  | keyof ProfileProjectV2['factAuthorityByField']
  | keyof ProfileAchievementV2['factAuthorityByField'];

export type ProfileV2CollectionProjection = Readonly<{
  ownerId: Uuid;
  profileRevision: CandidateProfileSnapshotV2['revision'];
  deletionEpoch: CandidateProfileSnapshotV2['deletionEpoch'];
  /** Compatibility view consumed by the existing projection engine. */
  collections: ApplyProfileCollections;
  /** Canonical association between each projected value and its Profile item UUID. */
  rows: Readonly<{
    experiences: readonly ProfileV2CollectionRow<ProfileExperience>[];
    educations: readonly ProfileV2CollectionRow<ProfileEducation>[];
    skills: readonly ProfileV2CollectionRow<string>[];
    languages: readonly ProfileV2CollectionRow<ProfileV2LanguageProjectionValue>[];
    projects: readonly ProfileV2CollectionRow<ProfileV2ProjectProjectionValue>[];
    achievements: readonly ProfileV2CollectionRow<ProfileV2AchievementProjectionValue>[];
  }>;
}>;

export type ProfileV2CollectionProjectionResult =
  | Readonly<{ ok: true; value: ProfileV2CollectionProjection }>
  | Readonly<{ ok: false; reasonCode: ProfileV2CollectionProjectionFailureReason }>;

const CONFIRMED_AUTHORITY_STATES: ReadonlySet<unknown> = new Set(
  PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1,
);

const MAX_COMPANY_OR_SCHOOL = 160;
const MAX_TITLE = 160;
const MAX_FIELD_OF_STUDY = 120;
const MAX_PROFILE_V2_GPA = 16;
const MAX_SKILL_NAME = 80;
const MAX_LANGUAGE_NAME = 80;
const MAX_PROJECT_OR_ACHIEVEMENT_TITLE = 160;
const MAX_PROJECT_LOCATION = 256;
const MAX_PROJECT_DESCRIPTION = 2_000;
const MAX_ACHIEVEMENT_STATEMENT = 1_000;
const MAX_HTTP_URL = 2_048;
const INVALID = Symbol('invalid-profile-v2-collection-input');

type CapturedEvidenceFact = Readonly<{
  factId: unknown;
  factRevision: unknown;
}>;

type CapturedSourceRef =
  | Readonly<{
      kind: 'DERIVATION';
      policyVersion: unknown;
      evidenceFacts: readonly CapturedEvidenceFact[];
    }>
  | Readonly<{
      kind: 'LEGACY_PROFILE';
      migrationId: unknown;
    }>;

type CapturedAuthorityMeta = Readonly<{
  source: unknown;
  authorityState: unknown;
  confidence: unknown;
  userConfirmedAt: unknown;
  sourceRef: CapturedSourceRef | null | typeof INVALID;
}>;

type CapturedAuthority = Readonly<{
  factId: unknown;
  factRevision: unknown;
  deletionEpoch: unknown;
  meta: CapturedAuthorityMeta;
}>;

type ProjectionCaptureContext = Readonly<{
  authorities: WeakMap<object, CapturedAuthority | null>;
  authorityMetas: WeakMap<object, CapturedAuthorityMeta | null>;
  sourceRefs: WeakMap<object, CapturedSourceRef | null>;
  evidenceArrays: WeakMap<object, readonly CapturedEvidenceFact[] | null>;
  evidenceFacts: WeakMap<object, CapturedEvidenceFact | null>;
  dateParts: WeakMap<object, ConfirmedDatePart | null>;
  skillReferences: WeakMap<object, readonly Uuid[] | null>;
  achievementContexts: WeakMap<object, ProfileAchievementV2['context'] | null>;
}>;

type CapturedProfileV2Field = Readonly<{
  candidate: unknown | null;
  authority: CapturedAuthority | null;
}>;

type CapturedProfileV2Item = Readonly<{
  rowKey: Uuid;
  fields: Readonly<Record<string, CapturedProfileV2Field>>;
}>;

type ProfileV2FieldParser = (
  value: unknown,
  context: ProjectionCaptureContext,
) => unknown | null;

type ProfileV2FieldSpec = Readonly<Record<string, ProfileV2FieldParser>>;

function failure(
  reasonCode: ProfileV2CollectionProjectionFailureReason,
): ProfileV2CollectionProjectionResult {
  return Object.freeze({ ok: false, reasonCode });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwnData(value: unknown, key: PropertyKey): unknown | typeof INVALID {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return INVALID;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : INVALID;
}

function readOwnEnumerableData(
  value: unknown,
  key: PropertyKey,
): unknown | typeof INVALID {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return INVALID;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined &&
    descriptor.enumerable === true &&
    'value' in descriptor
    ? descriptor.value
    : INVALID;
}

function exactOwnDataValues(
  value: unknown,
  keys: readonly string[],
): readonly unknown[] | null {
  if (!isRecord(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || keys.some((key) => !ownKeys.includes(key))) return null;
  const values = keys.map((key) => readOwnEnumerableData(value, key));
  return values.includes(INVALID) ? null : Object.freeze(values);
}

function createCaptureContext(): ProjectionCaptureContext {
  return Object.freeze({
    authorities: new WeakMap<object, CapturedAuthority | null>(),
    authorityMetas: new WeakMap<object, CapturedAuthorityMeta | null>(),
    sourceRefs: new WeakMap<object, CapturedSourceRef | null>(),
    evidenceArrays: new WeakMap<object, readonly CapturedEvidenceFact[] | null>(),
    evidenceFacts: new WeakMap<object, CapturedEvidenceFact | null>(),
    dateParts: new WeakMap<object, ConfirmedDatePart | null>(),
    skillReferences: new WeakMap<object, readonly Uuid[] | null>(),
    achievementContexts: new WeakMap<object, ProfileAchievementV2['context'] | null>(),
  });
}

function isCanonicalDecimal(value: unknown): value is DecimalString {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function isPositiveCanonicalDecimal(value: unknown): value is DecimalString {
  return isCanonicalDecimal(value) && value !== '0';
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
    ) {
      return null;
    }
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function enumValue<T extends string>(value: unknown, members: readonly T[]): T | null {
  return typeof value === 'string' && (members as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function compareCanonicalDecimal(left: DecimalString, right: DecimalString): number {
  if (left.length !== right.length) return left.length - right.length;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareFactVersion(
  left: Readonly<{ factId: Uuid; factRevision: DecimalString }>,
  right: Readonly<{ factId: Uuid; factRevision: DecimalString }>,
): number {
  const idOrder = left.factId === right.factId ? 0 : left.factId < right.factId ? -1 : 1;
  return idOrder === 0 ? compareCanonicalDecimal(left.factRevision, right.factRevision) : idOrder;
}

function captureEvidenceFact(
  value: unknown,
  context: ProjectionCaptureContext,
): CapturedEvidenceFact | null {
  if (!isRecord(value)) return null;
  if (context.evidenceFacts.has(value)) return context.evidenceFacts.get(value) ?? null;
  context.evidenceFacts.set(value, null);
  const fields = exactOwnDataValues(value, ['factId', 'factRevision']);
  if (fields === null) return null;
  const captured = Object.freeze({ factId: fields[0], factRevision: fields[1] });
  context.evidenceFacts.set(value, captured);
  return captured;
}

function captureEvidenceFacts(
  value: unknown,
  context: ProjectionCaptureContext,
): readonly CapturedEvidenceFact[] | null {
  if (!Array.isArray(value)) return null;
  if (context.evidenceArrays.has(value)) return context.evidenceArrays.get(value) ?? null;
  context.evidenceArrays.set(value, null);
  const rawFacts = denseOwnDataArray(
    value,
    PROFILE_V2_COLLECTION_LIMITS.derivationEvidenceFacts,
  );
  if (rawFacts === null) return null;
  const captured: CapturedEvidenceFact[] = [];
  for (const rawFact of rawFacts) {
    const fact = captureEvidenceFact(rawFact, context);
    if (fact === null) return null;
    captured.push(fact);
  }
  const immutable = Object.freeze(captured);
  context.evidenceArrays.set(value, immutable);
  return immutable;
}

function captureSourceRef(
  value: unknown,
  expectedKind: CapturedSourceRef['kind'],
  context: ProjectionCaptureContext,
): CapturedSourceRef | null {
  if (!isRecord(value)) return null;
  if (context.sourceRefs.has(value)) {
    const cached = context.sourceRefs.get(value) ?? null;
    return cached?.kind === expectedKind ? cached : null;
  }
  context.sourceRefs.set(value, null);
  if (expectedKind === 'DERIVATION') {
    const fields = exactOwnDataValues(value, ['kind', 'policyVersion', 'evidenceFacts']);
    if (fields === null || fields[0] !== expectedKind) return null;
    const evidenceFacts = captureEvidenceFacts(fields[2], context);
    if (evidenceFacts === null) return null;
    const captured = Object.freeze({
      kind: expectedKind,
      policyVersion: fields[1],
      evidenceFacts,
    });
    context.sourceRefs.set(value, captured);
    return captured;
  }
  const fields = exactOwnDataValues(value, ['kind', 'migrationId']);
  if (fields === null || fields[0] !== expectedKind) return null;
  const captured = Object.freeze({ kind: expectedKind, migrationId: fields[1] });
  context.sourceRefs.set(value, captured);
  return captured;
}

function captureAuthorityMeta(
  value: unknown,
  context: ProjectionCaptureContext,
): CapturedAuthorityMeta | null {
  if (!isRecord(value)) return null;
  if (context.authorityMetas.has(value)) return context.authorityMetas.get(value) ?? null;
  context.authorityMetas.set(value, null);
  const fields = exactOwnDataValues(value, [
    'source',
    'authorityState',
    'confidence',
    'userConfirmedAt',
    'sourceRef',
  ]);
  if (fields === null) return null;
  let sourceRef: CapturedSourceRef | null | typeof INVALID = INVALID;
  if (fields[4] === null) {
    sourceRef = null;
  } else if (fields[1] === 'DERIVED_CONFIRMED') {
    const capturedSourceRef = captureSourceRef(fields[4], 'DERIVATION', context);
    sourceRef = capturedSourceRef === null ? INVALID : capturedSourceRef;
  } else if (fields[1] === 'LEGACY_CONFIRMED') {
    const capturedSourceRef = captureSourceRef(fields[4], 'LEGACY_PROFILE', context);
    sourceRef = capturedSourceRef === null ? INVALID : capturedSourceRef;
  }
  const captured: CapturedAuthorityMeta = Object.freeze({
    source: fields[0],
    authorityState: fields[1],
    confidence: fields[2],
    userConfirmedAt: fields[3],
    sourceRef,
  });
  context.authorityMetas.set(value, captured);
  return captured;
}

function captureAuthority(
  value: unknown,
  context: ProjectionCaptureContext,
): CapturedAuthority | null {
  if (!isRecord(value)) return null;
  if (context.authorities.has(value)) return context.authorities.get(value) ?? null;
  context.authorities.set(value, null);
  const fields = exactOwnDataValues(value, [
    'factId',
    'factRevision',
    'deletionEpoch',
    'meta',
  ]);
  if (fields === null) return null;
  const meta = captureAuthorityMeta(fields[3], context);
  if (meta === null) return null;
  const captured = Object.freeze({
    factId: fields[0],
    factRevision: fields[1],
    deletionEpoch: fields[2],
    meta,
  });
  context.authorities.set(value, captured);
  return captured;
}

function validDerivationSourceRef(
  sourceRef: CapturedSourceRef | null | typeof INVALID,
  enclosingFact: Readonly<{ factId: Uuid; factRevision: DecimalString }>,
): boolean {
  if (sourceRef === null ||
    sourceRef === INVALID ||
    sourceRef.kind !== 'DERIVATION' ||
    parseSafeToken(sourceRef.policyVersion) === null ||
    sourceRef.evidenceFacts.length === 0
  ) return false;
  let previous: Readonly<{ factId: Uuid; factRevision: DecimalString }> | null = null;
  for (const evidenceFact of sourceRef.evidenceFacts) {
    const factId = parseUuid(evidenceFact.factId);
    const factRevision = evidenceFact.factRevision;
    if (factId === null || !isPositiveCanonicalDecimal(factRevision)) return false;
    const current = Object.freeze({ factId, factRevision });
    if (
      compareFactVersion(current, enclosingFact) === 0 ||
      (previous !== null && compareFactVersion(previous, current) >= 0)
    ) return false;
    previous = current;
  }
  return true;
}

function validLegacySourceRef(
  sourceRef: CapturedSourceRef | null | typeof INVALID,
): boolean {
  return sourceRef !== null &&
    sourceRef !== INVALID &&
    sourceRef.kind === 'LEGACY_PROFILE' &&
    parseSafeToken(sourceRef.migrationId) !== null;
}

function confirmedSourceMatchesState(
  authorityState: unknown,
  source: unknown,
  userConfirmedAt: unknown,
  sourceRef: CapturedSourceRef | null | typeof INVALID,
  enclosingFact: Readonly<{ factId: Uuid; factRevision: DecimalString }>,
): boolean {
  switch (authorityState) {
    case 'USER_CONFIRMED':
      return source === 'USER' && parseIsoDateTime(userConfirmedAt) !== null && sourceRef === null;
    case 'DERIVED_CONFIRMED':
      return source === 'DERIVED' &&
        userConfirmedAt === null &&
        validDerivationSourceRef(sourceRef, enclosingFact);
    case 'LEGACY_CONFIRMED':
      return (
        source === 'LEGACY_MIGRATION' &&
        userConfirmedAt === null &&
        validLegacySourceRef(sourceRef)
      );
    default:
      return false;
  }
}

/** Same current-fact fence used by the Profile answer-resolution projection. */
function isCurrentConfirmedAuthority(
  authority: CapturedAuthority,
  fence: ProfileV2ProjectionFence,
): boolean {
  const parsedFactId = parseUuid(authority.factId);
  return (
    authority.deletionEpoch === fence.deletionEpoch &&
    parsedFactId !== null &&
    isPositiveCanonicalDecimal(authority.factRevision) &&
    CONFIRMED_AUTHORITY_STATES.has(authority.meta.authorityState) &&
    confirmedSourceMatchesState(
      authority.meta.authorityState,
      authority.meta.source,
      authority.meta.userConfirmedAt,
      authority.meta.sourceRef,
      { factId: parsedFactId, factRevision: authority.factRevision },
    ) &&
    (authority.meta.confidence === null ||
      (typeof authority.meta.confidence === 'number' &&
        Number.isFinite(authority.meta.confidence) &&
        authority.meta.confidence >= 0 &&
        authority.meta.confidence <= 1))
  );
}

function confirmedField<T>(
  item: CapturedProfileV2Item,
  field: ProfileV2CollectionFieldCode,
  fence: ProfileV2ProjectionFence,
): T | null {
  const captured = item.fields[field];
  if (
    captured === undefined ||
    captured.authority === null ||
    !isCurrentConfirmedAuthority(captured.authority, fence)
  ) return null;
  return captured.candidate as T | null;
}

function uniqueKeyedItems(
  items: readonly unknown[],
): readonly Readonly<{ item: unknown; rowKey: Uuid }>[] {
  const captured = items.map((item) => {
    try {
      return Object.freeze({
        item,
        rowKey: isRecord(item) ? parseUuid(readOwnEnumerableData(item, 'id')) : null,
      });
    } catch {
      return Object.freeze({ item, rowKey: null });
    }
  });
  const counts = new Map<Uuid, number>();
  for (const { rowKey } of captured) {
    if (rowKey !== null) counts.set(rowKey, (counts.get(rowKey) ?? 0) + 1);
  }
  return captured.filter(
    (entry): entry is Readonly<{ item: unknown; rowKey: Uuid }> =>
      entry.rowKey !== null && counts.get(entry.rowKey) === 1,
  );
}

function denseOwnDataArray(value: unknown, maximum: number): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximum
  ) {
    return null;
  }
  const expectedKeys = new Set<string>(['length']);
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    expectedKeys.add(String(index));
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.size ||
    ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))
  ) return null;
  const captured: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !('value' in descriptor)
    ) return null;
    captured.push(descriptor.value);
  }
  return Object.freeze(captured);
}

function strictProfileV2DatePart(
  value: unknown,
  context: ProjectionCaptureContext,
): ConfirmedDatePart | null {
  if (!isRecord(value)) return null;
  if (context.dateParts.has(value)) return context.dateParts.get(value) ?? null;
  context.dateParts.set(value, null);
  const fields = exactOwnDataValues(value, ['year', 'month']);
  if (fields === null) return null;
  const [year, month] = fields;
  if (
    !Number.isInteger(year) ||
    (year as number) < 1900 ||
    (year as number) > 2100 ||
    (month !== null &&
      (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12))
  ) {
    return null;
  }
  const captured = Object.freeze({
    year: year as number,
    month: month as number | null,
  });
  context.dateParts.set(value, captured);
  return captured;
}

function captureProfileItem(
  item: unknown,
  rowKey: Uuid,
  spec: ProfileV2FieldSpec,
  context: ProjectionCaptureContext,
): CapturedProfileV2Item | null {
  try {
    if (!isRecord(item)) return null;
    const fieldNames = Object.keys(spec);
    const rawAuthorityByField = readOwnEnumerableData(item, 'factAuthorityByField');
    const authorities: (CapturedAuthority | null)[] = [];
    for (const field of fieldNames) {
      const authority = isRecord(rawAuthorityByField)
        ? readOwnEnumerableData(rawAuthorityByField, field)
        : INVALID;
      authorities.push(
        authority === INVALID ? null : captureAuthority(authority, context),
      );
    }
    const fields = Object.create(null) as Record<string, CapturedProfileV2Field>;
    for (let index = 0; index < fieldNames.length; index += 1) {
      const field = fieldNames[index]!;
      const rawCandidate = readOwnEnumerableData(item, field);
      let candidate: unknown | null = null;
      if (rawCandidate !== INVALID) {
        try {
          candidate = spec[field]!(rawCandidate, context);
        } catch {
          candidate = null;
        }
      }
      fields[field] = Object.freeze({
        candidate,
        authority: authorities[index] ?? null,
      });
    }
    return Object.freeze({ rowKey, fields: Object.freeze(fields) });
  } catch {
    return null;
  }
}

const EXPERIENCE_FIELD_SPEC: ProfileV2FieldSpec = Object.freeze({
  company: (value) => boundedText(value, MAX_COMPANY_OR_SCHOOL),
  title: (value) => boundedText(value, MAX_TITLE),
  employmentType: (value) =>
    enumValue(value, PROFILE_V2_EMPLOYMENT_TYPES) as EmploymentType | null,
  startDate: (value, context) => strictProfileV2DatePart(value, context),
  endDate: (value, context) => strictProfileV2DatePart(value, context),
  isCurrent: booleanValue,
});

const EDUCATION_FIELD_SPEC: ProfileV2FieldSpec = Object.freeze({
  school: (value) => boundedText(value, MAX_COMPANY_OR_SCHOOL),
  degreeLevel: (value) =>
    enumValue(value, PROFILE_V2_DEGREE_LEVELS) as DegreeLevel | null,
  fieldOfStudy: (value) => boundedText(value, MAX_FIELD_OF_STUDY),
  startDate: (value, context) => strictProfileV2DatePart(value, context),
  endDate: (value, context) => strictProfileV2DatePart(value, context),
  expectedGraduationDate: (value, context) => strictProfileV2DatePart(value, context),
  gpa: (value) => boundedText(value, MAX_PROFILE_V2_GPA),
  gpaScale: (value) => boundedText(value, MAX_PROFILE_V2_GPA),
  isCurrent: booleanValue,
});

const SKILL_FIELD_SPEC: ProfileV2FieldSpec = Object.freeze({
  name: (value) => boundedText(value, MAX_SKILL_NAME),
});

function strictSafeHttpUrl(value: unknown): ProfileProjectV2['url'] | null {
  if (value === null) return null;
  const raw = boundedText(value, MAX_HTTP_URL);
  if (raw === null) return null;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      return null;
    }
    return raw as ProfileProjectV2['url'];
  } catch {
    return null;
  }
}

function uniqueItemIds(
  items: readonly Readonly<{ item: unknown; rowKey: Uuid }>[],
): ReadonlySet<Uuid> {
  return new Set(items.map(({ rowKey }) => rowKey));
}

function strictUuidReferences(
  value: unknown,
  allowedIds: ReadonlySet<Uuid>,
  context: ProjectionCaptureContext,
): readonly Uuid[] | null {
  if (!Array.isArray(value)) return null;
  if (context.skillReferences.has(value)) return context.skillReferences.get(value) ?? null;
  context.skillReferences.set(value, null);
  const entries = denseOwnDataArray(value, PROFILE_V2_COLLECTION_LIMITS.skills);
  if (entries === null) return null;
  const references: Uuid[] = [];
  let previous: Uuid | null = null;
  for (const entry of entries) {
    const parsed = parseUuid(entry);
    if (
      parsed === null ||
      !allowedIds.has(parsed) ||
      (previous !== null && previous >= parsed)
    ) {
      return null;
    }
    references.push(parsed);
    previous = parsed;
  }
  const captured = Object.freeze(references);
  context.skillReferences.set(value, captured);
  return captured;
}

function strictAchievementContext(
  value: unknown,
  referenceIds: Readonly<{
    experiences: ReadonlySet<Uuid>;
    educations: ReadonlySet<Uuid>;
    projects: ReadonlySet<Uuid>;
  }>,
  context: ProjectionCaptureContext,
): ProfileAchievementV2['context'] | null {
  if (!isRecord(value)) return null;
  if (context.achievementContexts.has(value)) return context.achievementContexts.get(value) ?? null;
  context.achievementContexts.set(value, null);
  const fields = exactOwnDataValues(value, ['type', 'itemId']);
  if (fields === null) return null;
  const type = enumValue(fields[0], PROFILE_V2_ACHIEVEMENT_CONTEXT_TYPES);
  if (type === null) return null;
  if (type === 'STANDALONE') {
    if (fields[1] !== null) return null;
    const captured = Object.freeze({ type, itemId: null });
    context.achievementContexts.set(value, captured);
    return captured;
  }
  const itemId = parseUuid(fields[1]);
  if (itemId === null) return null;
  const allowed = type === 'EXPERIENCE'
    ? referenceIds.experiences
    : type === 'EDUCATION'
      ? referenceIds.educations
      : referenceIds.projects;
  if (!allowed.has(itemId)) return null;
  const captured = Object.freeze({ type, itemId });
  context.achievementContexts.set(value, captured);
  return captured;
}

const LANGUAGE_FIELD_SPEC: ProfileV2FieldSpec = Object.freeze({
  language: (value) => boundedText(value, MAX_LANGUAGE_NAME),
  proficiency: (value) => enumValue(value, PROFILE_V2_LANGUAGE_PROFICIENCIES),
});

function projectFieldSpec(allowedSkillIds: ReadonlySet<Uuid>): ProfileV2FieldSpec {
  return Object.freeze({
    title: (value) => boundedText(value, MAX_PROJECT_OR_ACHIEVEMENT_TITLE),
    organization: (value) => boundedText(value, MAX_PROJECT_OR_ACHIEVEMENT_TITLE),
    role: (value) => boundedText(value, MAX_PROJECT_OR_ACHIEVEMENT_TITLE),
    location: (value) => boundedText(value, MAX_PROJECT_LOCATION),
    url: strictSafeHttpUrl,
    startDate: strictProfileV2DatePart,
    endDate: strictProfileV2DatePart,
    isCurrent: booleanValue,
    description: (value) => boundedText(value, MAX_PROJECT_DESCRIPTION),
    skillIds: (value, context) => strictUuidReferences(value, allowedSkillIds, context),
  });
}

function achievementFieldSpec(referenceIds: Readonly<{
  experiences: ReadonlySet<Uuid>;
  educations: ReadonlySet<Uuid>;
  projects: ReadonlySet<Uuid>;
}>): ProfileV2FieldSpec {
  return Object.freeze({
    kind: (value) => enumValue(value, PROFILE_V2_ACHIEVEMENT_KINDS),
    title: (value) => boundedText(value, MAX_PROJECT_OR_ACHIEVEMENT_TITLE),
    statement: (value) => boundedText(value, MAX_ACHIEVEMENT_STATEMENT),
    occurredAt: strictProfileV2DatePart,
    url: strictSafeHttpUrl,
    context: (value, context) => strictAchievementContext(value, referenceIds, context),
  });
}

function dateRangeIsValid(
  startDate: ConfirmedDatePart | null,
  endDate: ConfirmedDatePart | null,
): boolean {
  if (startDate === null || endDate === null) return true;
  const startLowerBound = startDate.year * 12 + (startDate.month ?? 1);
  const endUpperBound = endDate.year * 12 + (endDate.month ?? 12);
  return startLowerBound <= endUpperBound;
}

function projectExperience(
  item: CapturedProfileV2Item,
  fence: ProfileV2ProjectionFence,
): ProfileV2CollectionRow<ProfileExperience> | null {
  const company = confirmedField<string>(
    item,
    'company',
    fence,
  );
  // Existing ApplyProfileCollections uses company as the safe item anchor. If that
  // exact field is not current+confirmed, only this item is omitted.
  if (company === null) return null;
  const isCurrent = confirmedField<boolean>(
    item,
    'isCurrent',
    fence,
  );
  // `false` is a material Profile value, not a fallback for missing authority.
  if (isCurrent === null) return null;
  const startDate = confirmedField<ConfirmedDatePart>(
    item,
    'startDate',
    fence,
  );
  const endDate = confirmedField<ConfirmedDatePart>(
    item,
    'endDate',
    fence,
  );
  if ((isCurrent && endDate !== null) || !dateRangeIsValid(startDate, endDate)) return null;
  const value = Object.freeze({
    company,
    title: confirmedField<string>(item, 'title', fence),
    employmentType: confirmedField<EmploymentType>(
      item,
      'employmentType',
      fence,
    ),
    startDate,
    endDate,
    // Profile V2 has distinct city + region. Concatenating either into one legacy
    // location string would be inference, so the existing location slot stays empty.
    location: null,
    isCurrent,
  });
  return Object.freeze({ rowKey: item.rowKey, value });
}

function projectEducation(
  item: CapturedProfileV2Item,
  fence: ProfileV2ProjectionFence,
): ProfileV2CollectionRow<ProfileEducation> | null {
  const school = confirmedField<string>(
    item,
    'school',
    fence,
  );
  if (school === null) return null;
  const isCurrent = confirmedField<boolean>(
    item,
    'isCurrent',
    fence,
  );
  if (isCurrent === null) return null;
  const startDate = confirmedField<ConfirmedDatePart>(
    item,
    'startDate',
    fence,
  );
  const endDate = confirmedField<ConfirmedDatePart>(
    item,
    'endDate',
    fence,
  );
  if ((isCurrent && endDate !== null) || !dateRangeIsValid(startDate, endDate)) return null;
  // 预计毕业时间（2026-10-01 argoland 交接）：同样要当前、确认过；早于入学的是脏数据，不用（只丢这一格，整段照常）。
  const expectedGraduationDate = confirmedField<ConfirmedDatePart>(
    item,
    'expectedGraduationDate',
    fence,
  );
  const graduation = expectedGraduationDate !== null && dateRangeIsValid(startDate, expectedGraduationDate)
    ? expectedGraduationDate
    : null;
  const value = Object.freeze({
    school,
    degreeLevel: confirmedField<DegreeLevel>(item, 'degreeLevel', fence),
    fieldOfStudy: confirmedField<string>(item, 'fieldOfStudy', fence),
    startDate,
    endDate,
    location: null,
    gpa: confirmedField<string>(item, 'gpa', fence),
    gpaScale: confirmedField<string>(item, 'gpaScale', fence),
    isCurrent,
    ...(graduation === null ? {} : { expectedGraduationDate: graduation }),
  });
  return Object.freeze({ rowKey: item.rowKey, value });
}

function projectSkill(
  item: CapturedProfileV2Item,
  fence: ProfileV2ProjectionFence,
): ProfileV2CollectionRow<string> | null {
  const value = confirmedField<string>(
    item,
    'name',
    fence,
  );
  return value === null ? null : Object.freeze({ rowKey: item.rowKey, value });
}

function projectLanguage(
  item: CapturedProfileV2Item,
  fence: ProfileV2ProjectionFence,
): ProfileV2CollectionRow<ProfileV2LanguageProjectionValue> | null {
  const language = confirmedField<ProfileV2LanguageProjectionValue['language']>(
    item,
    'language',
    fence,
  );
  const proficiency = confirmedField<ProfileV2LanguageProjectionValue['proficiency']>(
    item,
    'proficiency',
    fence,
  );
  if (language === null || proficiency === null) return null;
  const value = Object.freeze({
    language,
    proficiency,
  }) satisfies ProfileV2LanguageProjectionValue;
  return Object.freeze({ rowKey: item.rowKey, value });
}

function projectProject(
  item: CapturedProfileV2Item,
  fence: ProfileV2ProjectionFence,
): ProfileV2CollectionRow<ProfileV2ProjectProjectionValue> | null {
  const title = confirmedField<ProfileV2ProjectProjectionValue['title']>(
    item,
    'title',
    fence,
  );
  const organization = confirmedField<ProfileV2ProjectProjectionValue['organization']>(
    item,
    'organization',
    fence,
  );
  const role = confirmedField<ProfileV2ProjectProjectionValue['role']>(
    item,
    'role',
    fence,
  );
  const location = confirmedField<ProfileV2ProjectProjectionValue['location']>(
    item,
    'location',
    fence,
  );
  const url = confirmedField<ProfileV2ProjectProjectionValue['url']>(
    item,
    'url',
    fence,
  );
  const startDate = confirmedField<ProfileV2ProjectProjectionValue['startDate']>(
    item,
    'startDate',
    fence,
  );
  const endDate = confirmedField<ProfileV2ProjectProjectionValue['endDate']>(
    item,
    'endDate',
    fence,
  );
  const isCurrent = confirmedField<ProfileV2ProjectProjectionValue['isCurrent']>(
    item,
    'isCurrent',
    fence,
  );
  const description = confirmedField<ProfileV2ProjectProjectionValue['description']>(
    item,
    'description',
    fence,
  );
  const skillIds = confirmedField<ProfileV2ProjectProjectionValue['skillIds']>(
    item,
    'skillIds',
    fence,
  );
  if (title === null || isCurrent === null || skillIds === null) return null;
  if ((isCurrent && endDate !== null) || !dateRangeIsValid(startDate, endDate)) return null;
  const value = Object.freeze({
    title,
    organization,
    role,
    location,
    url,
    startDate,
    endDate,
    isCurrent,
    description,
    skillIds,
  }) satisfies ProfileV2ProjectProjectionValue;
  return Object.freeze({ rowKey: item.rowKey, value });
}

function projectAchievement(
  item: CapturedProfileV2Item,
  fence: ProfileV2ProjectionFence,
): ProfileV2CollectionRow<ProfileV2AchievementProjectionValue> | null {
  const kind = confirmedField<ProfileV2AchievementProjectionValue['kind']>(
    item,
    'kind',
    fence,
  );
  const title = confirmedField<ProfileV2AchievementProjectionValue['title']>(
    item,
    'title',
    fence,
  );
  const statement = confirmedField<ProfileV2AchievementProjectionValue['statement']>(
    item,
    'statement',
    fence,
  );
  const occurredAt = confirmedField<ProfileV2AchievementProjectionValue['occurredAt']>(
    item,
    'occurredAt',
    fence,
  );
  const url = confirmedField<ProfileV2AchievementProjectionValue['url']>(
    item,
    'url',
    fence,
  );
  const context = confirmedField<ProfileV2AchievementProjectionValue['context']>(
    item,
    'context',
    fence,
  );
  if (kind === null || title === null || statement === null || context === null) return null;
  const value = Object.freeze({
    kind,
    title,
    statement,
    occurredAt,
    url,
    context,
  }) satisfies ProfileV2AchievementProjectionValue;
  return Object.freeze({ rowKey: item.rowKey, value });
}

function removeDuplicateNormalizedLanguages(
  rows: readonly ProfileV2CollectionRow<ProfileV2LanguageProjectionValue>[],
): readonly ProfileV2CollectionRow<ProfileV2LanguageProjectionValue>[] {
  const normalized = rows.map(({ value }) =>
    value.language.normalize('NFKC').toLocaleLowerCase('en-US').trim());
  const counts = new Map<string, number>();
  for (const language of normalized) {
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return Object.freeze(rows.filter((_row, index) => counts.get(normalized[index]!) === 1));
}

function projectKeyedRows<Value>(
  items: readonly Readonly<{ item: unknown; rowKey: Uuid }>[],
  fence: ProfileV2ProjectionFence,
  spec: ProfileV2FieldSpec,
  context: ProjectionCaptureContext,
  project: (
    item: CapturedProfileV2Item,
    fence: ProfileV2ProjectionFence,
  ) =>
    ProfileV2CollectionRow<Value> | null,
): readonly ProfileV2CollectionRow<Value>[] {
  return Object.freeze(
    items
      .map(({ item, rowKey }) => captureProfileItem(item, rowKey, spec, context))
      .filter((item): item is CapturedProfileV2Item => item !== null)
      .map((item) => project(item, fence))
      .filter((row): row is ProfileV2CollectionRow<Value> => row !== null),
  );
}

function buildProjection(
  ownerId: Uuid,
  fence: ProfileV2ProjectionFence,
  experiences: readonly unknown[],
  educations: readonly unknown[],
  skills: readonly unknown[],
  languages: readonly unknown[],
  projects: readonly unknown[],
  achievements: readonly unknown[],
): ProfileV2CollectionProjection {
  const context = createCaptureContext();
  // Capture each UUID descriptor exactly once. Reference validation and emitted
  // row identity must share this same observation even for hostile Proxies.
  const keyedExperiences = uniqueKeyedItems(experiences);
  const keyedEducations = uniqueKeyedItems(educations);
  const keyedSkills = uniqueKeyedItems(skills);
  const keyedLanguages = uniqueKeyedItems(languages);
  const keyedProjects = uniqueKeyedItems(projects);
  const keyedAchievements = uniqueKeyedItems(achievements);
  const projectedExperiences = projectKeyedRows(
    keyedExperiences,
    fence,
    EXPERIENCE_FIELD_SPEC,
    context,
    projectExperience,
  );
  const projectedEducations = projectKeyedRows(
    keyedEducations,
    fence,
    EDUCATION_FIELD_SPEC,
    context,
    projectEducation,
  );
  const projectedSkills = projectKeyedRows(
    keyedSkills,
    fence,
    SKILL_FIELD_SPEC,
    context,
    projectSkill,
  );
  const skillIds = uniqueItemIds(keyedSkills);
  const projectIds = uniqueItemIds(keyedProjects);
  const referenceIds = Object.freeze({
    experiences: uniqueItemIds(keyedExperiences),
    educations: uniqueItemIds(keyedEducations),
    projects: projectIds,
  });
  const projectedLanguages = removeDuplicateNormalizedLanguages(
    projectKeyedRows(keyedLanguages, fence, LANGUAGE_FIELD_SPEC, context, projectLanguage),
  );
  const projectedProjects = projectKeyedRows(
    keyedProjects,
    fence,
    projectFieldSpec(skillIds),
    context,
    projectProject,
  );
  const projectedAchievements = projectKeyedRows(
    keyedAchievements,
    fence,
    achievementFieldSpec(referenceIds),
    context,
    projectAchievement,
  );
  const collections: {
    experiences?: readonly ProfileExperience[];
    educations?: readonly ProfileEducation[];
    skills?: readonly string[];
    languages?: readonly ProfileLanguage[];
  } = {};
  if (projectedExperiences.length > 0) {
    collections.experiences = Object.freeze(projectedExperiences.map(({ value }) => value));
  }
  if (projectedEducations.length > 0) {
    collections.educations = Object.freeze(projectedEducations.map(({ value }) => value));
  }
  if (projectedSkills.length > 0) {
    collections.skills = Object.freeze(projectedSkills.map(({ value }) => value));
  }
  // 语言（2026-10-04）：不按行填进页面，只用来答语言题（dict/languages.ts）。同样只有确认过的那几条，名字重复的已去掉。
  if (projectedLanguages.length > 0) {
    collections.languages = Object.freeze(projectedLanguages.map(({ value }) => Object.freeze({ language: value.language, proficiency: value.proficiency })));
  }
  return Object.freeze({
    ownerId,
    profileRevision: fence.revision,
    deletionEpoch: fence.deletionEpoch,
    collections: Object.freeze(collections),
    rows: Object.freeze({
      experiences: projectedExperiences,
      educations: projectedEducations,
      skills: projectedSkills,
      languages: projectedLanguages,
      projects: projectedProjects,
      achievements: projectedAchievements,
    }),
  });
}

export function projectProfileV2Collections(
  input: ProfileV2CollectionProjectionInput,
): ProfileV2CollectionProjectionResult {
  try {
    const authenticatedOwnerId = parseUuid(readOwnData(input, 'authenticatedOwnerId'));
    const ownerBoundSnapshot = readOwnData(input, 'ownerBoundSnapshot');
    const boundOwnerId = isRecord(ownerBoundSnapshot)
      ? parseUuid(readOwnData(ownerBoundSnapshot, 'ownerId'))
      : null;
    if (
      authenticatedOwnerId === null ||
      boundOwnerId === null ||
      authenticatedOwnerId !== boundOwnerId
    ) {
      // Deliberately before `ownerBoundSnapshot.snapshot`: a foreign owner has no
      // authority to make this adapter inspect any Profile value.
      return failure('PROFILE_SOURCE_OWNER_MISMATCH');
    }

    const snapshot = readOwnData(ownerBoundSnapshot, 'snapshot');
    if (!isRecord(snapshot) || readOwnData(snapshot, 'schemaVersion') !== 2) {
      return failure('PROFILE_V2_COLLECTION_SNAPSHOT_INVALID');
    }
    const hasStoredProfile = readOwnData(snapshot, 'hasStoredProfile');
    if (typeof hasStoredProfile !== 'boolean') {
      return failure('PROFILE_V2_COLLECTION_SNAPSHOT_INVALID');
    }
    const expectedDeletionEpoch = readOwnData(input, 'expectedDeletionEpoch');
    const deletionEpoch = readOwnData(snapshot, 'deletionEpoch');
    if (
      !isCanonicalDecimal(expectedDeletionEpoch) ||
      !isCanonicalDecimal(deletionEpoch) ||
      expectedDeletionEpoch !== deletionEpoch
    ) {
      return failure('PROFILE_SOURCE_DELETION_EPOCH_STALE');
    }
    const expectedProfileRevision = readOwnData(input, 'expectedProfileRevision');
    const revision = readOwnData(snapshot, 'revision');
    if (
      !isCanonicalDecimal(expectedProfileRevision) ||
      !isCanonicalDecimal(revision) ||
      expectedProfileRevision !== revision ||
      (hasStoredProfile ? revision === '0' : revision !== '0')
    ) {
      return failure('PROFILE_SOURCE_REVISION_STALE');
    }
    if (!hasStoredProfile) {
      return failure(
        deletionEpoch === '0'
          ? 'PROFILE_SOURCE_PROFILE_MISSING'
          : 'PROFILE_SOURCE_PROFILE_DELETED',
      );
    }
    const profile = readOwnData(snapshot, 'profile');
    if (!isRecord(profile)) return failure('PROFILE_V2_COLLECTION_SNAPSHOT_INVALID');
    const experiences = denseOwnDataArray(
      readOwnData(profile, 'experiences'),
      PROFILE_V2_COLLECTION_LIMITS.experiences,
    );
    const educations = denseOwnDataArray(
      readOwnData(profile, 'educations'),
      PROFILE_V2_COLLECTION_LIMITS.educations,
    );
    const skills = denseOwnDataArray(
      readOwnData(profile, 'skills'),
      PROFILE_V2_COLLECTION_LIMITS.skills,
    );
    const languages = denseOwnDataArray(
      readOwnData(profile, 'languages'),
      PROFILE_V2_COLLECTION_LIMITS.languages,
    );
    const projects = denseOwnDataArray(
      readOwnData(profile, 'projects'),
      PROFILE_V2_COLLECTION_LIMITS.projects,
    );
    const achievements = denseOwnDataArray(
      readOwnData(profile, 'achievements'),
      PROFILE_V2_COLLECTION_LIMITS.achievements,
    );
    if (
      experiences === null ||
      educations === null ||
      skills === null ||
      languages === null ||
      projects === null ||
      achievements === null
    ) {
      return failure('PROFILE_V2_COLLECTION_SNAPSHOT_INVALID');
    }
    const fence: ProfileV2ProjectionFence = Object.freeze({ revision, deletionEpoch });

    return Object.freeze({
      ok: true,
      value: buildProjection(
        authenticatedOwnerId,
        fence,
        experiences,
        educations,
        skills,
        languages,
        projects,
        achievements,
      ),
    });
  } catch {
    // No exception text or candidate value crosses this boundary.
    return failure('PROFILE_V2_COLLECTION_SNAPSHOT_INVALID');
  }
}
