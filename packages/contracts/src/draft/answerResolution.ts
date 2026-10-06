/**
 * Answer Resolution composition — value-free, default-off, NOT_RELEASED.
 *
 * UA-2 says what a control *is* (`packages/contracts/src/draft/pilotUa2Classification.ts`).
 * The T3 Profile answer-resolution projection says what owner authority can supply a
 * *concept* (`packages/contracts/src/profileAnswerSources.ts`). Nothing joined the two:
 * `PilotUa4Question` originally carried a caller-supplied `answerAuthority`, which let any
 * request mint `PROFILE_CONFIRMED` for any field. That field is gone: UA-4 now derives the
 * authority in-process from this composition, and this module is its only producer.
 *
 * It carries no Profile value, question text, option text, AI output, or page HTML. It
 * decides which authority may supply an answer; it does not decide that a field may be
 * written. Per PRODUCT-AUTHORITY §3 a field enters the UA-4 deterministic writer only when
 * the answer comes from an authoritative first-party source, the written value is verified
 * by readback, and the write is individually reversible. Only the first is knowable here:
 * readback and reversibility are runtime facts, and this repo has measured both failing in
 * ways a resolver cannot anticipate — an immediate readback can match while the write never
 * landed, and native Undo does not cover choice controls. They leave here as outstanding
 * obligations for the UA-4 runtime to discharge, never as assumptions.
 *
 * Importing this module activates nothing and grants no writer, persistence, or Submit
 * authority.
 */

import { parseUuid, type Uuid } from '../common.ts';
import { parseIsoCountryCode, parseSafeToken } from '../sensitiveWrite.ts';
import {
  PROFILE_ANSWER_RESOLUTION_CATEGORIES_V1,
  PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1,
  PROFILE_ANSWER_RESOLUTION_SCHEMA_VERSION_V1,
  PROFILE_ANSWER_SOURCE_CONCEPTS_V1,
  type ProfileAnswerResolutionCandidateV1,
  type ProfileAnswerResolutionItemV1,
  type ProfileAnswerResolutionProfileFactRefV1,
  type ProfileAnswerResolutionScopeRefV1,
  type ProfileAnswerSourceConceptV1,
  type ProfileAnswerSourceRefV1,
} from '../profileAnswerSources.ts';
import {
  PROFILE_V2_ACHIEVEMENT_FIELD_CODES,
  PROFILE_V2_EDUCATION_FIELD_CODES,
  PROFILE_V2_EXPERIENCE_FIELD_CODES,
  PROFILE_V2_FACT_SOURCES,
  PROFILE_V2_LANGUAGE_FIELD_CODES,
  PROFILE_V2_PROJECT_FIELD_CODES,
  PROFILE_V2_SCALAR_PATHS,
  PROFILE_V2_SKILL_FIELD_CODES,
  PROFILE_V2_SOURCE_REF_KINDS,
  PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES,
} from '../profileV2.ts';
import type {
  PilotUa2CanonicalField,
  PilotUa2Classification,
  PilotUa2ClassificationKind,
} from './pilotUa2Classification.ts';
import type { PilotUa4AnswerAuthority } from './pilotUa4WriteAuthority.ts';

export const ANSWER_RESOLUTION_SCHEMA_VERSION = 1 as const;

/**
 * Fail-closed result codes for the composition. `PILOT_CAPABILITY_DISABLED` is the
 * default-off answer and is never inferred away from env, cache, or a shipped bundle.
 */
export const ANSWER_RESOLUTION_FAILURE_CODES = [
  'PILOT_CAPABILITY_DISABLED',
  'PILOT_ANSWER_RESOLUTION_INPUT_INVALID',
] as const;
export type AnswerResolutionFailureCode =
  (typeof ANSWER_RESOLUTION_FAILURE_CODES)[number];

/**
 * The five source dispositions, in priority order. Each says where an answer may come
 * from, never what happened to the field: the outcome ladder is UA-4's
 * `PilotUa4TerminalState`, and this module deliberately does not restate it.
 */
export const ANSWER_RESOLUTION_DISPOSITIONS = [
  /** 1 · A confirmed T3/Profile fact backs this question. */
  'PROFILE_CONFIRMED_FACT',
  /** 2 · Reliably mapped, but the basis is an inference the user must confirm. */
  'MAPPED_REQUIRES_CONFIRMATION',
  /** 3 · No fact, generation permitted; the existing T9 suggestion path reviews it. */
  'GENERATION_ALLOWED',
  /** 4 · No answer available and none may be invented: ask the user. */
  'USER_INPUT_REQUIRED',
  /** 5 · The field class itself keeps this with the person. Not an answer gap. */
  'HUMAN_ONLY',
] as const;
export type AnswerResolutionDisposition =
  (typeof ANSWER_RESOLUTION_DISPOSITIONS)[number];

/**
 * Whether a question *can* be answered by the system at all.
 *
 * This exists because "we have no answer" and "we must not answer" are different facts
 * that must not be interchangeable. A gap closes when the user supplies something; a
 * `NOT_ANSWERABLE_BY_SYSTEM` question has nothing to close and is not a coverage defect.
 */
export const ANSWER_RESOLUTION_ANSWERABILITY = [
  'ANSWERABLE_BY_SYSTEM',
  'ANSWERABLE_ONLY_BY_USER',
  'NOT_ANSWERABLE_BY_SYSTEM',
] as const;
export type AnswerResolutionAnswerability =
  (typeof ANSWER_RESOLUTION_ANSWERABILITY)[number];

/**
 * The three PRODUCT-AUTHORITY §3 write preconditions, named so that the two this
 * composition cannot prove stay visible instead of being silently assumed.
 */
export const ANSWER_RESOLUTION_WRITE_OBLIGATIONS = [
  'FIRST_PARTY_SOURCE',
  'SEMANTIC_READBACK',
  'OWNED_UNDO',
] as const;
export type AnswerResolutionWriteObligation =
  (typeof ANSWER_RESOLUTION_WRITE_OBLIGATIONS)[number];

/**
 * Obligations still outstanding after a confirmed Profile fact is resolved. The source
 * precondition is discharged by the disposition itself; the other two are runtime facts.
 */
export const ANSWER_RESOLUTION_RUNTIME_OBLIGATIONS = [
  'SEMANTIC_READBACK',
  'OWNED_UNDO',
] as const;

export const ANSWER_RESOLUTION_REASON_CODES = [
  'ANSWER_FROM_CONFIRMED_PROFILE_FACT',
  'ANSWER_MAPPED_DERIVATION_REQUIRES_CONFIRMATION',
  'ANSWER_MAPPED_PROFILE_AUTHORITY_UNCONFIRMED',
  'ANSWER_OPEN_QUESTION_GENERATION_ALLOWED',
  'ANSWER_PROFILE_CONCEPT_GENERATION_ALLOWED',
  'ANSWER_GAP_NO_PROFILE_CONCEPT_FOR_CANONICAL_FIELD',
  'ANSWER_GAP_CANONICAL_FIELD_AMBIGUOUS',
  'ANSWER_GAP_STRUCTURED_CONTROL_WITHOUT_CONCEPT',
  'ANSWER_GAP_CLASSIFICATION_UNRESOLVED',
  'ANSWER_GAP_PROFILE_CONCEPT_NOT_RESOLVED',
  'ANSWER_HUMAN_ACTION_REQUIRED_BY_FIELD_CLASS',
] as const;
export type AnswerResolutionReasonCode =
  (typeof ANSWER_RESOLUTION_REASON_CODES)[number];

/**
 * Why a question stays with the person. The member set mirrors UA-4's `MANUAL_REQUIRED`
 * reasons rather than introducing a second taxonomy for the same fact.
 *
 * `PASSWORD` records the field's *current* recorded state — `MANUAL_REQUIRED`,
 * `DEFAULT_OFF`, `PENDING_L2P`. It is not a statement that automatic password entry is
 * permanently prohibited: the approved direction is a device-local encrypted credential
 * store bound to an exact origin and exact control with per-occurrence authorization.
 * PRODUCT-AUTHORITY §3 is the authority for that state; this enum only reflects it.
 */
export const ANSWER_RESOLUTION_HUMAN_ACTIONS = [
  'PASSWORD',
  'OTP_OR_2FA',
  'CAPTCHA_OR_HUMAN_CHALLENGE',
  'LEGAL_OR_SUBSTANTIVE_AUTHORIZATION',
  'MARKETING_SUBSCRIPTION',
  'CONTACT_CURRENT_EMPLOYER',
  'OTHER_PERSON',
  'HUMAN_ACTION',
  'FINAL_SUBMIT',
] as const;
export type AnswerResolutionHumanAction =
  (typeof ANSWER_RESOLUTION_HUMAN_ACTIONS)[number];

/**
 * UA-2 canonical field to Profile concept.
 *
 * `URL` does not resolve to a single concept. This is a property of the input rather than
 * a gap in this table:
 *
 * - `URL` — `LINKEDIN | GITHUB | PORTFOLIO` are three distinct concepts. UA-2 is
 *   value-free by construction, so choosing between them here would mean having read the
 *   value. The ambiguity is what correctness looks like; the user resolves it.
 */
export const CANONICAL_FIELD_CONCEPT_MAP = Object.freeze({
  NAME_FULL: 'IDENTITY_FULL_NAME',
  NAME_GIVEN: 'IDENTITY_FIRST_NAME',
  NAME_FAMILY: 'IDENTITY_LAST_NAME',
  EMAIL: 'CONTACT_EMAIL',
  PHONE: 'CONTACT_PHONE',
  ADDRESS_LINE_1: 'ADDRESS_LINE1',
  ADDRESS_LINE_2: 'ADDRESS_LINE2',
  CITY: 'ADDRESS_CITY',
  REGION: 'ADDRESS_REGION',
  POSTAL_CODE: 'ADDRESS_POSTAL_CODE',
  COUNTRY: 'ADDRESS_COUNTRY',
  ORGANIZATION: 'CURRENT_COMPANY',
  JOB_TITLE: 'CURRENT_JOB_TITLE',
  URL: Object.freeze(['LINKEDIN', 'GITHUB', 'PORTFOLIO'] as const),
  LINKEDIN_URL: 'LINKEDIN',
  GITHUB_URL: 'GITHUB',
  PORTFOLIO_URL: 'PORTFOLIO',
} as const satisfies Record<
  PilotUa2CanonicalField,
  ProfileAnswerSourceConceptV1 | null | readonly ProfileAnswerSourceConceptV1[]
>);

/** A confirmed Profile fact. Only `PROFILE_CONFIRMED_FACT` may carry this basis. */
export type AnswerResolutionConfirmedBasis = Readonly<{
  basis: 'CONFIRMED_FACT';
  candidates: readonly [
    Extract<ProfileAnswerResolutionCandidateV1, { source: 'PROFILE' }>,
    ...Extract<ProfileAnswerResolutionCandidateV1, { source: 'PROFILE' }>[],
  ];
}>;

/**
 * An inference. Structurally separate from a confirmed fact so that no field rename can
 * turn one into the other, and so a caller cannot read a candidate as settled truth.
 */
export type AnswerResolutionInferredBasis = Readonly<{
  basis: 'INFERRED_CANDIDATE';
  candidates: readonly ProfileAnswerResolutionCandidateV1[];
}>;

/** What is missing, for a question the user can still answer. */
export type AnswerResolutionGap = Readonly<{
  /** The concept sought, or null when no single Profile concept applies. */
  soughtConcept: ProfileAnswerSourceConceptV1 | null;
  /** Concepts a value-free classification cannot choose between. Empty when unambiguous. */
  ambiguousConcepts: readonly ProfileAnswerSourceConceptV1[];
}>;

type ItemBase = Readonly<{
  identityDigest: string;
  classificationKind: PilotUa2ClassificationKind;
  canonicalField: PilotUa2CanonicalField | null;
}>;

/**
 * Exactly one disposition per question.
 *
 * `HUMAN_ONLY` carries `humanAction` and cannot carry `gap`, `concept`, or any candidate:
 * a question that must not be answered has nothing missing. Every other disposition can
 * carry a concept and none can carry a `humanAction`. The `never` members make the two
 * shapes non-interchangeable at the type level rather than by convention.
 */
export type AnswerResolutionItem =
  | (ItemBase &
      AnswerResolutionConfirmedBasis &
      Readonly<{
        disposition: 'PROFILE_CONFIRMED_FACT';
        reasonCode: 'ANSWER_FROM_CONFIRMED_PROFILE_FACT';
        concept: ProfileAnswerSourceConceptV1;
        answerAuthority: Extract<PilotUa4AnswerAuthority, 'PROFILE_CONFIRMED'>;
        outstandingWriteObligations: typeof ANSWER_RESOLUTION_RUNTIME_OBLIGATIONS;
        gap?: never;
        humanAction?: never;
      }>)
  | (ItemBase &
      AnswerResolutionInferredBasis &
      Readonly<{
        disposition: 'MAPPED_REQUIRES_CONFIRMATION';
        reasonCode: Extract<
          AnswerResolutionReasonCode,
          | 'ANSWER_MAPPED_DERIVATION_REQUIRES_CONFIRMATION'
          | 'ANSWER_MAPPED_PROFILE_AUTHORITY_UNCONFIRMED'
        >;
        concept: ProfileAnswerSourceConceptV1;
        answerAuthority?: never;
        gap?: never;
        humanAction?: never;
      }>)
  | (ItemBase &
      AnswerResolutionInferredBasis &
      Readonly<{
        disposition: 'GENERATION_ALLOWED';
        reasonCode: Extract<
          AnswerResolutionReasonCode,
          'ANSWER_OPEN_QUESTION_GENERATION_ALLOWED' | 'ANSWER_PROFILE_CONCEPT_GENERATION_ALLOWED'
        >;
        concept: ProfileAnswerSourceConceptV1 | null;
        answerAuthority?: never;
        gap?: never;
        humanAction?: never;
      }>)
  | (ItemBase &
      Readonly<{
        disposition: 'USER_INPUT_REQUIRED';
        reasonCode: Extract<
          AnswerResolutionReasonCode,
          | 'ANSWER_GAP_NO_PROFILE_CONCEPT_FOR_CANONICAL_FIELD'
          | 'ANSWER_GAP_CANONICAL_FIELD_AMBIGUOUS'
          | 'ANSWER_GAP_STRUCTURED_CONTROL_WITHOUT_CONCEPT'
          | 'ANSWER_GAP_CLASSIFICATION_UNRESOLVED'
          | 'ANSWER_GAP_PROFILE_CONCEPT_NOT_RESOLVED'
        >;
        gap: AnswerResolutionGap;
        answerAuthority?: never;
        humanAction?: never;
      }>)
  | (ItemBase &
      Readonly<{
        disposition: 'HUMAN_ONLY';
        reasonCode: 'ANSWER_HUMAN_ACTION_REQUIRED_BY_FIELD_CLASS';
        humanAction: AnswerResolutionHumanAction;
        answerAuthority?: never;
        gap?: never;
        concept?: never;
      }>);

export interface AnswerResolutionSnapshot {
  readonly schemaVersion: typeof ANSWER_RESOLUTION_SCHEMA_VERSION;
  /** Exactly one result per classification, in input order. No silent omission. */
  readonly items: readonly AnswerResolutionItem[];
  readonly constraints: Readonly<{
    writerAuthority: 'NOT_GRANTED';
    submit: 'HUMAN_ONLY';
    activationState: 'DEFAULT_OFF';
    releaseState: 'NOT_RELEASED';
  }>;
}

const ANSWERABILITY_BY_DISPOSITION = Object.freeze({
  PROFILE_CONFIRMED_FACT: 'ANSWERABLE_BY_SYSTEM',
  MAPPED_REQUIRES_CONFIRMATION: 'ANSWERABLE_BY_SYSTEM',
  GENERATION_ALLOWED: 'ANSWERABLE_BY_SYSTEM',
  USER_INPUT_REQUIRED: 'ANSWERABLE_ONLY_BY_USER',
  HUMAN_ONLY: 'NOT_ANSWERABLE_BY_SYSTEM',
} as const satisfies Record<AnswerResolutionDisposition, AnswerResolutionAnswerability>);

const HUMAN_ACTION_BY_REASON = Object.freeze({
  HUMAN_PASSWORD_CONTROL: 'PASSWORD',
  HUMAN_SUBMIT_CONTROL: 'FINAL_SUBMIT',
  HUMAN_ACTION_CONTROL: 'HUMAN_ACTION',
} as const);

export function answerResolutionAnswerability(
  item: AnswerResolutionItem,
): AnswerResolutionAnswerability {
  return ANSWERABILITY_BY_DISPOSITION[item.disposition];
}

/** Which dispositions carry a given answerability. Keeps the two sets in one place. */
export function answerResolutionDispositionOf(
  answerability: AnswerResolutionAnswerability,
): readonly AnswerResolutionDisposition[] {
  return ANSWER_RESOLUTION_DISPOSITIONS.filter(
    (disposition) => ANSWERABILITY_BY_DISPOSITION[disposition] === answerability,
  );
}

function gapItem(
  base: ItemBase,
  reasonCode: Extract<AnswerResolutionItem, { disposition: 'USER_INPUT_REQUIRED' }>['reasonCode'],
  gap: AnswerResolutionGap,
): AnswerResolutionItem {
  return Object.freeze({
    ...base,
    disposition: 'USER_INPUT_REQUIRED',
    reasonCode,
    gap: Object.freeze({
      soughtConcept: gap.soughtConcept,
      ambiguousConcepts: Object.freeze([...gap.ambiguousConcepts]),
    }),
  });
}

function fromProfileItem(
  base: ItemBase,
  concept: ProfileAnswerSourceConceptV1,
  profile: ProfileAnswerResolutionItemV1,
): AnswerResolutionItem {
  switch (profile.category) {
    case 'DETERMINISTIC_MAPPING':
      return Object.freeze({
        ...base,
        disposition: 'PROFILE_CONFIRMED_FACT',
        reasonCode: 'ANSWER_FROM_CONFIRMED_PROFILE_FACT',
        concept,
        basis: 'CONFIRMED_FACT',
        candidates: profile.candidates,
        answerAuthority: 'PROFILE_CONFIRMED',
        outstandingWriteObligations: ANSWER_RESOLUTION_RUNTIME_OBLIGATIONS,
      });
    case 'EXPLAINABLE_DERIVATION':
      return Object.freeze({
        ...base,
        disposition: 'MAPPED_REQUIRES_CONFIRMATION',
        reasonCode: 'ANSWER_MAPPED_DERIVATION_REQUIRES_CONFIRMATION',
        concept,
        basis: 'INFERRED_CANDIDATE',
        candidates: profile.candidates,
      });
    case 'AI_SUGGESTION_REQUIRED':
      return Object.freeze({
        ...base,
        disposition: 'GENERATION_ALLOWED',
        reasonCode: 'ANSWER_PROFILE_CONCEPT_GENERATION_ALLOWED',
        concept,
        basis: 'INFERRED_CANDIDATE',
        candidates: profile.candidates,
      });
    case 'USER_CONFIRMATION_REQUIRED':
      return profile.candidates.length > 0
        ? Object.freeze({
            ...base,
            disposition: 'MAPPED_REQUIRES_CONFIRMATION',
            reasonCode: 'ANSWER_MAPPED_PROFILE_AUTHORITY_UNCONFIRMED',
            concept,
            basis: 'INFERRED_CANDIDATE',
            candidates: profile.candidates,
          })
        : gapItem(base, 'ANSWER_GAP_PROFILE_CONCEPT_NOT_RESOLVED', {
            soughtConcept: concept,
            ambiguousConcepts: [],
          });
  }
}

/**
 * Resolve one question.
 *
 * The field class is read before any answer lookup, so a question that must stay with the
 * person is never reclassified by whether an answer happens to exist for it.
 */
export function resolveAnswerDisposition(
  classification: PilotUa2Classification,
  profile: ProfileAnswerResolutionItemV1 | null,
): AnswerResolutionItem {
  const base: ItemBase = Object.freeze({
    identityDigest: classification.identityDigest,
    classificationKind: classification.kind,
    canonicalField: classification.canonicalField,
  });

  if (classification.kind === 'HUMAN_ACTION_REQUIRED') {
    const humanAction =
      classification.reasonCode in HUMAN_ACTION_BY_REASON
        ? HUMAN_ACTION_BY_REASON[classification.reasonCode as keyof typeof HUMAN_ACTION_BY_REASON]
        : 'HUMAN_ACTION';
    return Object.freeze({
      ...base,
      disposition: 'HUMAN_ONLY',
      reasonCode: 'ANSWER_HUMAN_ACTION_REQUIRED_BY_FIELD_CLASS',
      humanAction,
    });
  }

  if (classification.kind === 'OPEN_QUESTION') {
    return Object.freeze({
      ...base,
      disposition: 'GENERATION_ALLOWED',
      reasonCode: 'ANSWER_OPEN_QUESTION_GENERATION_ALLOWED',
      concept: null,
      basis: 'INFERRED_CANDIDATE',
      candidates: Object.freeze([]),
    });
  }

  if (classification.kind === 'UNRESOLVED') {
    return gapItem(base, 'ANSWER_GAP_CLASSIFICATION_UNRESOLVED', {
      soughtConcept: null,
      ambiguousConcepts: [],
    });
  }

  if (classification.kind !== 'CANONICAL_FIELD' || classification.canonicalField === null) {
    return gapItem(base, 'ANSWER_GAP_STRUCTURED_CONTROL_WITHOUT_CONCEPT', {
      soughtConcept: null,
      ambiguousConcepts: [],
    });
  }

  const mapped = CANONICAL_FIELD_CONCEPT_MAP[classification.canonicalField];

  if (mapped === null) {
    return gapItem(base, 'ANSWER_GAP_NO_PROFILE_CONCEPT_FOR_CANONICAL_FIELD', {
      soughtConcept: null,
      ambiguousConcepts: [],
    });
  }

  if (Array.isArray(mapped)) {
    return gapItem(base, 'ANSWER_GAP_CANONICAL_FIELD_AMBIGUOUS', {
      soughtConcept: null,
      ambiguousConcepts: mapped as readonly ProfileAnswerSourceConceptV1[],
    });
  }

  const concept = mapped as ProfileAnswerSourceConceptV1;
  if (profile === null || profile.concept !== concept) {
    return gapItem(base, 'ANSWER_GAP_PROFILE_CONCEPT_NOT_RESOLVED', {
      soughtConcept: concept,
      ambiguousConcepts: [],
    });
  }

  return fromProfileItem(base, concept, profile);
}

/**
 * Resolve a whole page. Every classification produces exactly one item, in input order.
 * A question is never dropped for lacking an answer.
 */
export function resolveAnswerDispositions(
  classifications: readonly PilotUa2Classification[],
  profileByConcept: ReadonlyMap<ProfileAnswerSourceConceptV1, ProfileAnswerResolutionItemV1>,
): AnswerResolutionSnapshot {
  const items = classifications.map((classification) => {
    const mapped =
      classification.kind === 'CANONICAL_FIELD' && classification.canonicalField !== null
        ? CANONICAL_FIELD_CONCEPT_MAP[classification.canonicalField]
        : null;
    const concept =
      mapped !== null && !Array.isArray(mapped)
        ? (mapped as ProfileAnswerSourceConceptV1)
        : null;
    return resolveAnswerDisposition(
      classification,
      concept === null ? null : (profileByConcept.get(concept) ?? null),
    );
  });
  return Object.freeze({
    schemaVersion: ANSWER_RESOLUTION_SCHEMA_VERSION,
    items: Object.freeze(items),
    constraints: Object.freeze({
      writerAuthority: 'NOT_GRANTED',
      submit: 'HUMAN_ONLY',
      activationState: 'DEFAULT_OFF',
      releaseState: 'NOT_RELEASED',
    }),
  });
}

/* ------------------------------------------------------------------------- *
 * Trusted Profile intake
 *
 * The types above are erased at runtime, so a caller-supplied snapshot is
 * untrusted input, not a `ProfileAnswerResolutionSnapshotV1`. Without this
 * layer a forged snapshot carrying a RESUME-source candidate under a
 * stranger's ownerId is promoted to `CONFIRMED_FACT` — measured, not
 * hypothetical.
 *
 * Two rules hold throughout:
 *
 * 1. Nothing reads an untrusted property directly. Every read goes through a
 *    property descriptor and requires a data property, so a getter planted on
 *    the input is never invoked — not even once, and not by an object spread.
 * 2. Nothing caller-supplied is retained. Every ref, array and object is
 *    rebuilt from validated primitives and frozen, so a mutation after the
 *    call cannot change what was already resolved.
 *
 * Every parser is total: it returns a value or null, never throws, and never
 * falls through to a permissive default.
 * ------------------------------------------------------------------------- */

const CONCEPTS = new Set<string>(PROFILE_ANSWER_SOURCE_CONCEPTS_V1);
const CONFIRMED_AUTHORITY_STATES = new Set<string>(
  PROFILE_ANSWER_RESOLUTION_CONFIRMED_AUTHORITY_STATES_V1,
);
const FACT_SOURCES = new Set<string>(PROFILE_V2_FACT_SOURCES);
const SOURCE_REF_KINDS = new Set<string>(PROFILE_V2_SOURCE_REF_KINDS);
const WORK_AUTHORIZATION_FIELD_CODES = new Set<string>(
  PROFILE_V2_WORK_AUTHORIZATION_FIELD_CODES,
);
const SCALAR_PATHS = new Set<string>(PROFILE_V2_SCALAR_PATHS);
const PRIMARY_LINK_KINDS = new Set(['LINKEDIN', 'GITHUB', 'PORTFOLIO']);

/** Field codes each collection may legitimately confirm, mirroring the T3 producer. */
const COLLECTION_FIELD_CODES = Object.freeze({
  experiences: new Set<string>(PROFILE_V2_EXPERIENCE_FIELD_CODES),
  educations: new Set<string>(PROFILE_V2_EDUCATION_FIELD_CODES),
  skills: new Set<string>(PROFILE_V2_SKILL_FIELD_CODES),
  languages: new Set<string>(PROFILE_V2_LANGUAGE_FIELD_CODES),
  projects: new Set<string>(PROFILE_V2_PROJECT_FIELD_CODES),
  achievements: new Set<string>(PROFILE_V2_ACHIEVEMENT_FIELD_CODES),
} as const);

/**
 * Which source reference each concept may legitimately be backed by.
 *
 * A reference can be structurally perfect and still belong to a different concept.
 * Without this binding, `CONTACT_EMAIL` backed by `SCALAR['identity.firstName']` — or by
 * a path that does not exist at all — was accepted and minted as a confirmed email fact.
 * Structural validity is not provenance.
 *
 * The table mirrors exactly what the T3 producer emits per concept; a concept absent from
 * it can never reach the confirmed tier.
 */
type ConceptRefRule =
  | Readonly<{ shape: 'SCALAR'; paths: readonly string[]; exact: true }>
  | Readonly<{ shape: 'SCALAR_PHONE' }>
  | Readonly<{ shape: 'PRIMARY_LINK'; kind: 'LINKEDIN' | 'GITHUB' | 'PORTFOLIO' }>
  | Readonly<{ shape: 'PRIMARY_CURRENT_EXPERIENCE'; field: 'company' | 'title' }>
  | Readonly<{ shape: 'COLLECTION'; collection: keyof typeof COLLECTION_FIELD_CODES }>
  | Readonly<{ shape: 'WORK_AUTHORIZATION'; fields: readonly [string, string] }>;

const scalarRule = (path: string): ConceptRefRule =>
  Object.freeze({ shape: 'SCALAR', paths: Object.freeze([path]), exact: true });

const CONCEPT_SOURCE_REF_RULES: Readonly<Record<string, readonly ConceptRefRule[]>> =
  Object.freeze({
    IDENTITY_FIRST_NAME: [scalarRule('identity.firstName')],
    IDENTITY_MIDDLE_NAME: [scalarRule('identity.middleName')],
    IDENTITY_LAST_NAME: [scalarRule('identity.lastName')],
    IDENTITY_FULL_NAME: [scalarRule('identity.fullName')],
    IDENTITY_PREFERRED_NAME: [scalarRule('identity.preferredName')],
    CONTACT_EMAIL: [scalarRule('contact.email')],
    CONTACT_PHONE: [Object.freeze({ shape: 'SCALAR_PHONE' })],
    ADDRESS_LINE1: [scalarRule('address.line1')],
    ADDRESS_LINE2: [scalarRule('address.line2')],
    ADDRESS_CITY: [scalarRule('address.city')],
    ADDRESS_REGION: [scalarRule('address.region')],
    ADDRESS_POSTAL_CODE: [scalarRule('address.postalCode')],
    ADDRESS_COUNTRY: [scalarRule('address.countryCode')],
    PROFILE_SUMMARY: [scalarRule('summary')],
    NO_EXPERIENCE: [scalarRule('noExperience')],
    LINKEDIN: [Object.freeze({ shape: 'PRIMARY_LINK', kind: 'LINKEDIN' })],
    GITHUB: [Object.freeze({ shape: 'PRIMARY_LINK', kind: 'GITHUB' })],
    PORTFOLIO: [Object.freeze({ shape: 'PRIMARY_LINK', kind: 'PORTFOLIO' })],
    CURRENT_COMPANY: [Object.freeze({
      shape: 'PRIMARY_CURRENT_EXPERIENCE',
      field: 'company',
    })],
    CURRENT_JOB_TITLE: [Object.freeze({
      shape: 'PRIMARY_CURRENT_EXPERIENCE',
      field: 'title',
    })],
    // A profile with no experience confirms WORK_HISTORY through the noExperience flag.
    WORK_HISTORY: [
      Object.freeze({ shape: 'COLLECTION', collection: 'experiences' }),
      scalarRule('noExperience'),
    ],
    EDUCATION_HISTORY: [Object.freeze({ shape: 'COLLECTION', collection: 'educations' })],
    SKILLS: [Object.freeze({ shape: 'COLLECTION', collection: 'skills' })],
    LANGUAGES: [Object.freeze({ shape: 'COLLECTION', collection: 'languages' })],
    PROJECTS: [Object.freeze({ shape: 'COLLECTION', collection: 'projects' })],
    ACHIEVEMENTS: [Object.freeze({ shape: 'COLLECTION', collection: 'achievements' })],
    EARLIEST_START_DATE: [scalarRule('availability.earliestStartDate')],
    NOTICE_PERIOD_DAYS: [scalarRule('availability.noticePeriodDays')],
    // The producer emits exactly ['regionCode', answerField], and the answer field is
    // decided by the concept. A sponsorship question backed by the authorization answer
    // is a different question.
    AUTHORIZED_TO_WORK: [Object.freeze({
      shape: 'WORK_AUTHORIZATION',
      fields: Object.freeze(['regionCode', 'authorizedToWork'] as const),
    })],
    REQUIRES_SPONSORSHIP: [Object.freeze({
      shape: 'WORK_AUTHORIZATION',
      fields: Object.freeze(['regionCode', 'requiresSponsorship'] as const),
    })],
    // WILLING_TO_RELOCATE and SALARY_EXPECTATION have no confirmed storage yet, so no
    // reference can back them. Their absence is what keeps them out of the confirmed tier.
  });

/** The phone reference is the calling code plus exactly one dialable representation. */
const PHONE_CALLING_CODE = 'contact.phone.countryCode';
const PHONE_NUMBER_PATHS = new Set(['contact.phone.e164', 'contact.phone.display']);

/** Concepts the producer scopes to a region. Every other concept is USER-scoped. */
const REGION_SCOPED_CONCEPTS = new Set(['AUTHORIZED_TO_WORK', 'REQUIRES_SPONSORSHIP']);

/**
 * The producer derives one region for the whole candidate: `regionCode` is the request's
 * region for a region-scoped concept and null otherwise, and `scopeRef` is built from that
 * same value. So the candidate region, the scope region and the reference region are
 * always the same value, and a non-region concept is always USER-scoped.
 *
 * Checking them independently is not enough: each was individually well-formed in the
 * measured bypass while naming three different regions.
 */
function regionBindingHolds(
  concept: string,
  candidateRegion: string | null,
  scopeRef: ProfileAnswerResolutionScopeRefV1,
  ref: ProfileAnswerSourceRefV1,
): boolean {
  if (!REGION_SCOPED_CONCEPTS.has(concept)) {
    return candidateRegion === null
      && scopeRef.scope === 'USER'
      && ref.shape !== 'WORK_AUTHORIZATION';
  }
  return candidateRegion !== null
    && scopeRef.scope === 'REGION'
    && scopeRef.regionCode === candidateRegion
    && ref.shape === 'WORK_AUTHORIZATION'
    && ref.regionCode === candidateRegion;
}

/** True when the reference is one the concept may legitimately be backed by. */
function sourceRefMatchesConcept(concept: string, ref: ProfileAnswerSourceRefV1): boolean {
  const rules = CONCEPT_SOURCE_REF_RULES[concept];
  if (!rules) return false;
  return rules.some((rule) => {
    switch (rule.shape) {
      case 'SCALAR':
        return ref.shape === 'SCALAR'
          && ref.paths.length === rule.paths.length
          && ref.paths.every((path, index) => path === rule.paths[index]);
      case 'SCALAR_PHONE':
        return ref.shape === 'SCALAR'
          && ref.paths.length === 2
          && ref.paths[0] === PHONE_CALLING_CODE
          && PHONE_NUMBER_PATHS.has(ref.paths[1] as string);
      case 'PRIMARY_LINK':
        return ref.shape === 'PRIMARY_LINK' && ref.kind === rule.kind;
      case 'PRIMARY_CURRENT_EXPERIENCE':
        return ref.shape === 'PRIMARY_CURRENT_EXPERIENCE'
          && ref.fields.length === 1
          && ref.fields[0] === rule.field;
      case 'COLLECTION': {
        // The producer only confirms a collection when every canonical field of every
        // item is confirmed, so it always emits the complete field set. A partial set
        // is not producer output.
        if (ref.shape !== 'COLLECTION' || ref.collection !== rule.collection) return false;
        const canonical = COLLECTION_FIELD_CODES[rule.collection];
        return ref.confirmedFields.length === canonical.size
          && ref.confirmedFields.every((field) => canonical.has(field));
      }
      case 'WORK_AUTHORIZATION':
        return ref.shape === 'WORK_AUTHORIZATION'
          && ref.fields.length === rule.fields.length
          && ref.fields.every((field, index) => field === rule.fields[index]);
    }
  });
}
const DECIMAL_STRING = /^(0|[1-9][0-9]{0,38})$/;

/** Bounds. An unbounded collection is a denial-of-service surface, so each is capped. */
const MAX_ITEMS = PROFILE_ANSWER_SOURCE_CONCEPTS_V1.length;
const MAX_CANDIDATES_PER_ITEM = 32;
const MAX_FACTS_PER_CANDIDATE = 64;
const MAX_REF_MEMBERS = 64;

const CATEGORY_RULES = Object.freeze({
  DETERMINISTIC_MAPPING: {
    disposition: 'PROFILE_CONFIRMED',
    reasonCode: 'PROFILE_SOURCE_CONFIRMED',
  },
} as const);

/**
 * Exact-key object read. Rejects a non-plain prototype, a missing or extra key,
 * and any accessor or non-enumerable property, then copies the values onto a
 * null-prototype object. Reading through descriptors is what keeps a planted
 * getter from ever running.
 */
function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) return null;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

/** Dense, bounded, index-exact array read. Rejects holes, accessors and extra keys. */
function denseArray(value: unknown, max: number): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : null;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;
  if (length > max) return null;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    copy.push(descriptor.value);
  }
  return copy;
}

function decimalString(value: unknown): string | null {
  return typeof value === 'string' && DECIMAL_STRING.test(value) ? value : null;
}

function positiveDecimalString(value: unknown): string | null {
  const parsed = decimalString(value);
  return parsed !== null && parsed !== '0' ? parsed : null;
}

/** Confidence is a finite number in [0,1] or null. NaN and Infinity are not confidences. */
function confidence(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

function boundedTokens(
  value: unknown,
  allowed: ReadonlySet<string>,
  max: number,
): readonly string[] | null {
  const raw = denseArray(value, max);
  if (!raw || raw.length === 0) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || !allowed.has(entry) || seen.has(entry)) return null;
    seen.add(entry);
    out.push(entry);
  }
  return Object.freeze(out);
}

function boundedUuids(value: unknown, max: number): readonly Uuid[] | null {
  const raw = denseArray(value, max);
  if (!raw || raw.length === 0) return null;
  const out: Uuid[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const uuid = parseUuid(entry);
    if (!uuid || seen.has(uuid)) return null;
    seen.add(uuid);
    out.push(uuid);
  }
  return Object.freeze(out);
}

/** `{ scope: 'USER' } | { scope: 'REGION', regionCode }` — discriminated on `scope`. */
function parseScopeRef(value: unknown): ProfileAnswerResolutionScopeRefV1 | null {
  const user = exactKeys(value, ['scope']);
  if (user) return user.scope === 'USER' ? Object.freeze({ scope: 'USER' as const }) : null;
  const region = exactKeys(value, ['scope', 'regionCode']);
  if (!region || region.scope !== 'REGION') return null;
  const regionCode = parseIsoCountryCode(region.regionCode);
  return regionCode ? Object.freeze({ scope: 'REGION' as const, regionCode }) : null;
}

/** Discriminated on `shape`. Every arm is rebuilt from validated primitives. */
function parseAnswerSourceRef(value: unknown): ProfileAnswerSourceRefV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const shapeDescriptor = Object.getOwnPropertyDescriptor(value, 'shape');
  if (!shapeDescriptor || !('value' in shapeDescriptor)) return null;

  switch (shapeDescriptor.value) {
    case 'SCALAR': {
      const fields = exactKeys(value, ['shape', 'paths']);
      if (!fields) return null;
      // Canonical closed set, not an arbitrary string: `attacker.nonexistent.path`
      // was accepted here and minted as a confirmed fact.
      const paths = boundedTokens(fields.paths, SCALAR_PATHS, MAX_REF_MEMBERS);
      if (!paths) return null;
      return Object.freeze({
        shape: 'SCALAR' as const,
        paths,
      }) as unknown as ProfileAnswerSourceRefV1;
    }
    case 'PRIMARY_LINK': {
      const fields = exactKeys(value, ['shape', 'kind', 'linkId']);
      const linkId = fields ? parseUuid(fields.linkId) : null;
      if (
        !fields || !linkId
        || typeof fields.kind !== 'string' || !PRIMARY_LINK_KINDS.has(fields.kind)
      ) return null;
      return Object.freeze({
        shape: 'PRIMARY_LINK' as const,
        kind: fields.kind,
        linkId,
      }) as unknown as ProfileAnswerSourceRefV1;
    }
    case 'PRIMARY_CURRENT_EXPERIENCE': {
      const fields = exactKeys(value, ['shape', 'experienceId', 'fields']);
      const experienceId = fields ? parseUuid(fields.experienceId) : null;
      if (!fields || !experienceId) return null;
      const refFields = boundedTokens(fields.fields, new Set(['company', 'title']), 1);
      if (!refFields) return null;
      return Object.freeze({
        shape: 'PRIMARY_CURRENT_EXPERIENCE' as const,
        experienceId,
        fields: refFields,
      }) as unknown as ProfileAnswerSourceRefV1;
    }
    case 'COLLECTION': {
      const fields = exactKeys(value, ['shape', 'collection', 'itemIds', 'confirmedFields']);
      if (
        !fields
        || typeof fields.collection !== 'string'
        || !(fields.collection in COLLECTION_FIELD_CODES)
      ) return null;
      const collection = fields.collection as keyof typeof COLLECTION_FIELD_CODES;
      const itemIds = boundedUuids(fields.itemIds, MAX_REF_MEMBERS);
      // Field codes must belong to *this* collection: an education field code on an
      // experiences reference is a mispaired ref, not a confirmed one.
      const confirmedFields = boundedTokens(
        fields.confirmedFields,
        COLLECTION_FIELD_CODES[collection],
        MAX_REF_MEMBERS,
      );
      if (!itemIds || !confirmedFields) return null;
      return Object.freeze({
        shape: 'COLLECTION' as const,
        collection,
        itemIds,
        confirmedFields,
      }) as unknown as ProfileAnswerSourceRefV1;
    }
    case 'WORK_AUTHORIZATION': {
      const fields = exactKeys(value, ['shape', 'regionCode', 'fields']);
      const regionCode = fields ? parseIsoCountryCode(fields.regionCode) : null;
      if (!fields || !regionCode) return null;
      const refFields = boundedTokens(
        fields.fields,
        WORK_AUTHORIZATION_FIELD_CODES,
        MAX_REF_MEMBERS,
      );
      if (!refFields) return null;
      return Object.freeze({
        shape: 'WORK_AUTHORIZATION' as const,
        regionCode,
        fields: refFields,
      }) as unknown as ProfileAnswerSourceRefV1;
    }
    default:
      return null;
  }
}

/**
 * Discriminated on `kind`, with `null` a legitimate member.
 *
 * A user-entered fact carries no source reference, and the real T3 producer
 * emits `sourceRef: null` for exactly that case, so rejecting null would reject
 * the most common confirmed fact there is. `USER_INPUT` is not a member of the
 * kind set: the contract defines RESUME_FACT, DERIVATION and LEGACY_PROFILE.
 */
function parseFactSourceRef(value: unknown): { ok: true; value: unknown } | null {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (
    !kindDescriptor || !('value' in kindDescriptor)
    || typeof kindDescriptor.value !== 'string'
    || !SOURCE_REF_KINDS.has(kindDescriptor.value)
  ) return null;

  switch (kindDescriptor.value) {
    case 'RESUME_FACT': {
      const fields = exactKeys(value, ['kind', 'resumeVersionId', 'parserVersion', 'factId']);
      if (!fields) return null;
      const resumeVersionId = parseUuid(fields.resumeVersionId);
      const factId = parseUuid(fields.factId);
      const parserVersion = parseSafeToken(fields.parserVersion);
      if (!resumeVersionId || !factId || !parserVersion) return null;
      return {
        ok: true,
        value: Object.freeze({
          kind: 'RESUME_FACT' as const, resumeVersionId, parserVersion, factId,
        }),
      };
    }
    case 'DERIVATION': {
      const fields = exactKeys(value, ['kind', 'policyVersion', 'evidenceFacts']);
      if (!fields) return null;
      const policyVersion = parseSafeToken(fields.policyVersion);
      const raw = denseArray(fields.evidenceFacts, MAX_FACTS_PER_CANDIDATE);
      if (!policyVersion || !raw || raw.length === 0) return null;
      const evidenceFacts: unknown[] = [];
      for (const entry of raw) {
        const ref = exactKeys(entry, ['factId', 'factRevision']);
        const factId = ref ? parseUuid(ref.factId) : null;
        const factRevision = ref ? decimalString(ref.factRevision) : null;
        if (!factId || factRevision === null) return null;
        evidenceFacts.push(Object.freeze({ factId, factRevision }));
      }
      return {
        ok: true,
        value: Object.freeze({
          kind: 'DERIVATION' as const, policyVersion, evidenceFacts: Object.freeze(evidenceFacts),
        }),
      };
    }
    case 'LEGACY_PROFILE': {
      const fields = exactKeys(value, ['kind', 'migrationId']);
      const migrationId = fields ? parseSafeToken(fields.migrationId) : null;
      if (!migrationId) return null;
      return { ok: true, value: Object.freeze({ kind: 'LEGACY_PROFILE' as const, migrationId }) };
    }
    default:
      return null;
  }
}

/**
 * A Profile fact that may back a confirmed candidate. `authorityState` must be
 * a confirmed state: a `SUGGESTED` fact is an inference and can never be one.
 */
function parseFact(
  value: unknown,
  deletionEpoch: string,
): ProfileAnswerResolutionProfileFactRefV1 | null {
  const fields = exactKeys(value, [
    'factId', 'factRevision', 'deletionEpoch', 'source',
    'authorityState', 'confidence', 'sourceRef',
  ]);
  if (!fields) return null;
  const factId = parseUuid(fields.factId);
  const factRevision = positiveDecimalString(fields.factRevision);
  const factEpoch = decimalString(fields.deletionEpoch);
  const factConfidence = confidence(fields.confidence);
  const sourceRef = parseFactSourceRef(fields.sourceRef);
  if (
    !factId
    || factRevision === null
    || factEpoch === null || factEpoch !== deletionEpoch
    || typeof fields.source !== 'string' || !FACT_SOURCES.has(fields.source)
    || typeof fields.authorityState !== 'string'
    || !CONFIRMED_AUTHORITY_STATES.has(fields.authorityState)
    || factConfidence === undefined
    || !sourceRef
  ) return null;
  return Object.freeze({
    factId,
    factRevision,
    deletionEpoch: factEpoch,
    source: fields.source,
    authorityState: fields.authorityState,
    confidence: factConfidence,
    sourceRef: sourceRef.value,
  }) as unknown as ProfileAnswerResolutionProfileFactRefV1;
}

/**
 * A candidate that may back the confirmed tier. It must be Profile-sourced and
 * fenced to the same owner, revision and deletion epoch as the snapshot: a
 * RESUME suggestion or a foreign owner is an inference, never a fact.
 */
function parseConfirmedCandidate(
  value: unknown,
  concept: string,
  ownerId: string,
  profileRevision: string,
  deletionEpoch: string,
): ProfileAnswerResolutionCandidateV1 | null {
  const fields = exactKeys(value, ['confidence', 'regionCode', 'scopeRef', 'source', 'provenance']);
  if (!fields || fields.source !== 'PROFILE') return null;
  const candidateConfidence = confidence(fields.confidence);
  const scopeRef = parseScopeRef(fields.scopeRef);
  const regionCode = fields.regionCode === null ? null : parseIsoCountryCode(fields.regionCode);
  if (
    candidateConfidence === undefined
    || !scopeRef
    || (fields.regionCode !== null && !regionCode)
  ) return null;
  const provenanceWithBindings = exactKeys(fields.provenance, [
    'kind', 'ownerId', 'profileRevision', 'deletionEpoch', 'sourceRef', 'facts', 'factBindings',
  ]);
  const provenance = provenanceWithBindings ?? exactKeys(fields.provenance, [
    'kind', 'ownerId', 'profileRevision', 'deletionEpoch', 'sourceRef', 'facts',
  ]);
  if (
    !provenance
    || provenance.kind !== 'PROFILE_FACTS'
    || provenance.ownerId !== ownerId
    || provenance.profileRevision !== profileRevision
    || provenance.deletionEpoch !== deletionEpoch
  ) return null;
  const sourceRef = parseAnswerSourceRef(provenance.sourceRef);
  const rawFacts = denseArray(provenance.facts, MAX_FACTS_PER_CANDIDATE);
  // A structurally valid reference belonging to another concept is not provenance
  // for this one.
  if (
    !sourceRef
    || !sourceRefMatchesConcept(concept, sourceRef)
    || !regionBindingHolds(concept, regionCode, scopeRef, sourceRef)
    || !rawFacts || rawFacts.length === 0
  ) return null;
  const facts: ProfileAnswerResolutionProfileFactRefV1[] = [];
  const seen = new Set<string>();
  for (const raw of rawFacts) {
    const fact = parseFact(raw, deletionEpoch);
    if (!fact || seen.has(fact.factId)) return null;
    seen.add(fact.factId);
    facts.push(fact);
  }
  if (!factBindingsMatchSourceRef(sourceRef, facts, provenanceWithBindings?.factBindings)) {
    return null;
  }
  return Object.freeze({
    confidence: candidateConfidence,
    regionCode,
    scopeRef,
    source: 'PROFILE',
    provenance: Object.freeze({
      kind: 'PROFILE_FACTS',
      ownerId,
      profileRevision,
      deletionEpoch,
      sourceRef,
      facts: Object.freeze(facts),
    }),
  }) as unknown as ProfileAnswerResolutionCandidateV1;
}

function factBindingsMatchSourceRef(
  sourceRef: ProfileAnswerSourceRefV1,
  facts: readonly ProfileAnswerResolutionProfileFactRefV1[],
  value: unknown,
): boolean {
  if (sourceRef.shape !== 'PRIMARY_CURRENT_EXPERIENCE') return value === undefined;
  const bindings = denseArray(value, 2);
  if (!bindings || bindings.length !== 2 || facts.length !== 2) return false;
  const primary = exactKeys(bindings[0], ['role', 'factId', 'experienceId']);
  const field = exactKeys(bindings[1], ['role', 'factId', 'experienceId', 'field']);
  const primaryFactId = primary ? parseUuid(primary.factId) : null;
  const primaryExperienceId = primary ? parseUuid(primary.experienceId) : null;
  const fieldFactId = field ? parseUuid(field.factId) : null;
  const fieldExperienceId = field ? parseUuid(field.experienceId) : null;
  return primary?.role === 'PRIMARY_CURRENT_EXPERIENCE_REFERENCE'
    && field?.role === 'PRIMARY_CURRENT_EXPERIENCE_FIELD'
    && primaryFactId === facts[0]?.factId
    && fieldFactId === facts[1]?.factId
    && primaryExperienceId === sourceRef.experienceId
    && fieldExperienceId === sourceRef.experienceId
    && field.field === sourceRef.fields[0];
}

function parseItem(
  value: unknown,
  ownerId: string,
  profileRevision: string,
  deletionEpoch: string,
): ProfileAnswerResolutionItemV1 | null {
  const fields = exactKeys(value, ['concept', 'category', 'disposition', 'reasonCode', 'candidates']);
  if (
    !fields
    || typeof fields.concept !== 'string' || !CONCEPTS.has(fields.concept)
    || typeof fields.category !== 'string'
    || !(PROFILE_ANSWER_RESOLUTION_CATEGORIES_V1 as readonly string[]).includes(fields.category)
    || typeof fields.disposition !== 'string'
    || typeof fields.reasonCode !== 'string'
  ) return null;
  const rawCandidates = denseArray(fields.candidates, MAX_CANDIDATES_PER_ITEM);
  if (!rawCandidates) return null;

  // Only the confirmed tier may carry a candidate this parser trusts as a fact.
  // Every other tier is an inference and is rebuilt without candidates, so an
  // unverifiable candidate can never be read as settled truth.
  if (fields.category === 'DETERMINISTIC_MAPPING') {
    const rule = CATEGORY_RULES.DETERMINISTIC_MAPPING;
    if (
      fields.disposition !== rule.disposition
      || fields.reasonCode !== rule.reasonCode
      || rawCandidates.length === 0
    ) return null;
    const candidates: ProfileAnswerResolutionCandidateV1[] = [];
    for (const raw of rawCandidates) {
      const candidate = parseConfirmedCandidate(
        raw, fields.concept, ownerId, profileRevision, deletionEpoch,
      );
      if (!candidate) return null;
      candidates.push(candidate);
    }
    return Object.freeze({
      concept: fields.concept,
      category: 'DETERMINISTIC_MAPPING',
      disposition: rule.disposition,
      reasonCode: rule.reasonCode,
      candidates: Object.freeze(candidates),
    }) as unknown as ProfileAnswerResolutionItemV1;
  }

  if (fields.reasonCode === 'PROFILE_SOURCE_CONFIRMED') return null;
  return Object.freeze({
    concept: fields.concept,
    category: fields.category,
    disposition: fields.disposition,
    reasonCode: fields.reasonCode,
    candidates: Object.freeze([]),
  }) as unknown as ProfileAnswerResolutionItemV1;
}

export type AnswerResolutionParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: 'PILOT_ANSWER_RESOLUTION_INPUT_INVALID' }>;

function profileFailure<T>(): AnswerResolutionParseResult<T> {
  return Object.freeze({ ok: false, code: 'PILOT_ANSWER_RESOLUTION_INPUT_INVALID' });
}

/**
 * Validate an untrusted Profile answer-resolution snapshot against an expected
 * owner and return trusted, frozen, concept-keyed entries.
 *
 * `expectedOwnerId` is supplied by the backend from the authenticated session,
 * never read from the snapshot: binding to an owner the payload names would
 * authenticate the attacker's claim rather than the user.
 */
export function parseTrustedProfileAnswerResolution(
  value: unknown,
  expectedOwnerId: string,
): AnswerResolutionParseResult<
  ReadonlyMap<ProfileAnswerSourceConceptV1, ProfileAnswerResolutionItemV1>
> {
  try {
    if (!parseUuid(expectedOwnerId)) return profileFailure();
    const fields = exactKeys(value, [
      'schemaVersion', 'ownerId', 'profileRevision', 'deletionEpoch', 'items',
    ]);
    if (!fields || fields.schemaVersion !== PROFILE_ANSWER_RESOLUTION_SCHEMA_VERSION_V1) {
      return profileFailure();
    }
    const profileRevision = decimalString(fields.profileRevision);
    const deletionEpoch = decimalString(fields.deletionEpoch);
    if (fields.ownerId !== expectedOwnerId || profileRevision === null || deletionEpoch === null) {
      return profileFailure();
    }
    const rawItems = denseArray(fields.items, MAX_ITEMS);
    if (!rawItems) return profileFailure();
    const entries = new Map<ProfileAnswerSourceConceptV1, ProfileAnswerResolutionItemV1>();
    for (const raw of rawItems) {
      const item = parseItem(raw, expectedOwnerId, profileRevision, deletionEpoch);
      // One concept may not carry two dispositions: an ambiguous source is
      // rejected rather than silently resolved to whichever arrived last.
      if (!item || entries.has(item.concept)) return profileFailure();
      entries.set(item.concept, item);
    }
    return Object.freeze({ ok: true, value: entries });
  } catch {
    return profileFailure();
  }
}
