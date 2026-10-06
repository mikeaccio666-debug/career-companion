import { describe, expect, it } from 'vitest';

import {
  ANSWER_RESOLUTION_ANSWERABILITY,
  ANSWER_RESOLUTION_DISPOSITIONS,
  ANSWER_RESOLUTION_REASON_CODES,
  ANSWER_RESOLUTION_SCHEMA_VERSION,
  ANSWER_RESOLUTION_WRITE_OBLIGATIONS,
  CANONICAL_FIELD_CONCEPT_MAP,
  answerResolutionAnswerability,
  answerResolutionDispositionOf,
  resolveAnswerDisposition,
  resolveAnswerDispositions,
  type AnswerResolutionItem,
} from '../src/draft/answerResolution';
import {
  PILOT_UA2_CANONICAL_FIELDS,
  PILOT_UA2_CLASSIFICATION_KINDS,
  type PilotUa2CanonicalField,
  type PilotUa2Classification,
  type PilotUa2ClassificationKind,
  type PilotUa2ReasonCode,
} from '../src/draft/pilotUa2Classification';
import {
  PROFILE_ANSWER_SOURCE_CONCEPTS_V1,
  type ProfileAnswerResolutionItemV1,
} from '../src/profileAnswerSources';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const SEMANTIC = 'c'.repeat(64);

function classification(
  overrides: Partial<PilotUa2Classification> & { kind: PilotUa2ClassificationKind },
): PilotUa2Classification {
  const reasonByKind: Record<PilotUa2ClassificationKind, PilotUa2ReasonCode> = {
    CANONICAL_FIELD: 'CANONICAL_SEMANTIC_MATCH',
    STRUCTURED_CHOICE: 'STRUCTURED_CHOICE_CONTROL',
    STRUCTURED_DATE: 'STRUCTURED_DATE_CONTROL',
    STRUCTURED_NUMBER: 'STRUCTURED_NUMBER_CONTROL',
    STRUCTURED_FILE: 'STRUCTURED_FILE_CONTROL',
    OPEN_QUESTION: 'OPEN_QUESTION_CONTROL',
    HUMAN_ACTION_REQUIRED: 'HUMAN_ACTION_CONTROL',
    UNRESOLVED: 'SEMANTIC_CLASSIFICATION_UNRESOLVED',
  };
  return Object.freeze({
    identityDigest: DIGEST_A,
    canonicalField: overrides.kind === 'CANONICAL_FIELD' ? 'EMAIL' : null,
    confidence: 'HIGH',
    provenance: Object.freeze({
      source:
        overrides.kind === 'CANONICAL_FIELD' || overrides.kind === 'UNRESOLVED'
          ? 'BACKEND_TEXT_CLASSIFIER'
          : 'CONTROL_SEMANTICS',
      semanticDigest: SEMANTIC,
    }),
    reasonCode: reasonByKind[overrides.kind],
    ...overrides,
  }) as PilotUa2Classification;
}

function profileItem(
  overrides: Partial<ProfileAnswerResolutionItemV1> = {},
): ProfileAnswerResolutionItemV1 {
  return Object.freeze({
    concept: 'CONTACT_EMAIL',
    category: 'AI_SUGGESTION_REQUIRED',
    disposition: 'AI_SUGGESTION_THEN_USER_CONFIRMATION',
    reasonCode: 'PROFILE_SOURCE_VALUE_MISSING',
    candidates: Object.freeze([]),
    ...overrides,
  }) as ProfileAnswerResolutionItemV1;
}

const CONFIRMED_EMAIL: ProfileAnswerResolutionItemV1 = Object.freeze({
  concept: 'CONTACT_EMAIL',
  category: 'DETERMINISTIC_MAPPING',
  disposition: 'PROFILE_CONFIRMED',
  reasonCode: 'PROFILE_SOURCE_CONFIRMED',
  candidates: Object.freeze([
    Object.freeze({
      confidence: null,
      regionCode: null,
      scopeRef: Object.freeze({ scope: 'USER' }),
      source: 'PROFILE',
      provenance: Object.freeze({
        kind: 'PROFILE_FACTS',
        ownerId: '00000000-0000-4000-8000-000000000001',
        profileRevision: '7',
        deletionEpoch: '0',
        sourceRef: Object.freeze({ shape: 'SCALAR', paths: Object.freeze(['contact.email']) }),
        facts: Object.freeze([
          Object.freeze({
            factId: '00000000-0000-4000-8000-000000000002',
            factRevision: '3',
            deletionEpoch: '0',
            source: 'USER_INPUT',
            authorityState: 'USER_CONFIRMED',
            confidence: null,
            sourceRef: Object.freeze({ kind: 'USER_INPUT' }),
          }),
        ]),
      }),
    }),
  ]),
}) as unknown as ProfileAnswerResolutionItemV1;

describe('Answer Resolution composition · closed sets', () => {
  it('pins the schema version and the five source dispositions', () => {
    expect(ANSWER_RESOLUTION_SCHEMA_VERSION).toBe(1);
    expect(ANSWER_RESOLUTION_DISPOSITIONS).toEqual([
      'PROFILE_CONFIRMED_FACT',
      'MAPPED_REQUIRES_CONFIRMATION',
      'GENERATION_ALLOWED',
      'USER_INPUT_REQUIRED',
      'HUMAN_ONLY',
    ]);
  });

  it('never admits a generic unsupported disposition or reason code', () => {
    for (const value of [...ANSWER_RESOLUTION_DISPOSITIONS, ...ANSWER_RESOLUTION_REASON_CODES]) {
      expect(value).not.toMatch(/UNSUPPORTED|UNKNOWN|OTHER|FALLBACK|GENERIC/);
    }
  });

  it('states the three write preconditions without discharging the runtime ones', () => {
    expect(ANSWER_RESOLUTION_WRITE_OBLIGATIONS).toEqual([
      'FIRST_PARTY_SOURCE',
      'SEMANTIC_READBACK',
      'OWNED_UNDO',
    ]);
  });
});

describe('Answer Resolution composition · totality and uniqueness', () => {
  it('gives every UA-2 classification kind exactly one disposition', () => {
    for (const kind of PILOT_UA2_CLASSIFICATION_KINDS) {
      const item = resolveAnswerDisposition(classification({ kind }), null);
      const matches = ANSWER_RESOLUTION_DISPOSITIONS.filter((d) => d === item.disposition);
      expect(matches).toHaveLength(1);
      expect(ANSWER_RESOLUTION_REASON_CODES).toContain(item.reasonCode);
    }
  });

  it('gives every canonical field a disposition, mapped or not', () => {
    for (const field of PILOT_UA2_CANONICAL_FIELDS) {
      const item = resolveAnswerDisposition(
        classification({ kind: 'CANONICAL_FIELD', canonicalField: field }),
        null,
      );
      expect(ANSWER_RESOLUTION_DISPOSITIONS).toContain(item.disposition);
    }
  });

  it('returns exactly one result per input, in input order, with no omission', () => {
    const inputs = [
      classification({ kind: 'CANONICAL_FIELD', identityDigest: DIGEST_A }),
      classification({ kind: 'HUMAN_ACTION_REQUIRED', identityDigest: DIGEST_B }),
    ];
    const snapshot = resolveAnswerDispositions(inputs, new Map());
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.map((i) => i.identityDigest)).toEqual([DIGEST_A, DIGEST_B]);
  });

  it('maps each canonical concept target into the profile concept closed set', () => {
    for (const concept of Object.values(CANONICAL_FIELD_CONCEPT_MAP)) {
      if (concept === null || Array.isArray(concept)) continue;
      expect(PROFILE_ANSWER_SOURCE_CONCEPTS_V1).toContain(concept);
    }
  });
});

describe('Answer Resolution composition · a gap is not a prohibition', () => {
  it('routes HUMAN_ACTION_REQUIRED to HUMAN_ONLY regardless of an available answer', () => {
    const item = resolveAnswerDisposition(
      classification({ kind: 'HUMAN_ACTION_REQUIRED' }),
      CONFIRMED_EMAIL,
    );
    expect(item.disposition).toBe('HUMAN_ONLY');
    expect(answerResolutionAnswerability(item)).toBe('NOT_ANSWERABLE_BY_SYSTEM');
  });

  it('makes HUMAN_ONLY structurally incapable of carrying a gap or a concept', () => {
    const item = resolveAnswerDisposition(classification({ kind: 'HUMAN_ACTION_REQUIRED' }), null);
    expect(item).not.toHaveProperty('gap');
    expect(item).not.toHaveProperty('concept');
    expect(item).toHaveProperty('humanAction');
  });

  it('makes USER_INPUT_REQUIRED carry a gap and never a human action', () => {
    const item = resolveAnswerDisposition(classification({ kind: 'UNRESOLVED' }), null);
    expect(item.disposition).toBe('USER_INPUT_REQUIRED');
    expect(answerResolutionAnswerability(item)).toBe('ANSWERABLE_ONLY_BY_USER');
    expect(item).toHaveProperty('gap');
    expect(item).not.toHaveProperty('humanAction');
  });

  it('maps JOB_TITLE to the exact confirmed current-experience title concept', () => {
    expect(CANONICAL_FIELD_CONCEPT_MAP.JOB_TITLE).toBe('CURRENT_JOB_TITLE');

    const item = resolveAnswerDisposition(
      classification({ kind: 'CANONICAL_FIELD', canonicalField: 'JOB_TITLE' }),
      null,
    );
    expect(item.disposition).toBe('USER_INPUT_REQUIRED');
    expect(item.reasonCode).toBe('ANSWER_GAP_PROFILE_CONCEPT_NOT_RESOLVED');
    if (item.disposition !== 'USER_INPUT_REQUIRED') throw new Error('unreachable');
    expect(item.gap.soughtConcept).toBe('CURRENT_JOB_TITLE');
  });

  it('treats a value-free-ambiguous canonical field as a gap the user closes', () => {
    const item = resolveAnswerDisposition(
      classification({ kind: 'CANONICAL_FIELD', canonicalField: 'URL' }),
      null,
    );
    expect(item.disposition).toBe('USER_INPUT_REQUIRED');
    expect(item.reasonCode).toBe('ANSWER_GAP_CANONICAL_FIELD_AMBIGUOUS');
  });

  it('separates answerability across every disposition', () => {
    expect(ANSWER_RESOLUTION_ANSWERABILITY).toEqual([
      'ANSWERABLE_BY_SYSTEM',
      'ANSWERABLE_ONLY_BY_USER',
      'NOT_ANSWERABLE_BY_SYSTEM',
    ]);
    expect(answerResolutionDispositionOf('NOT_ANSWERABLE_BY_SYSTEM')).toEqual(['HUMAN_ONLY']);
    expect(answerResolutionDispositionOf('ANSWERABLE_ONLY_BY_USER')).toEqual([
      'USER_INPUT_REQUIRED',
    ]);
  });
});

/**
 * Compile-time assertion helper. `IsAssignable<Bad, AnswerResolutionItem>` resolves to
 * `true` the moment a guard stops biting, and assigning `true` to a `false` binding is a
 * type error — so weakening a guard turns the build red instead of quietly allowing the
 * two shapes to become interchangeable.
 */
type IsAssignable<T, U> = [T] extends [U] ? true : false;

type Base = { identityDigest: string; canonicalField: null };
type Gap = { soughtConcept: 'CONTACT_EMAIL'; ambiguousConcepts: readonly [] };

type HumanOnlyWithGap = Base & {
  classificationKind: 'HUMAN_ACTION_REQUIRED';
  disposition: 'HUMAN_ONLY';
  reasonCode: 'ANSWER_HUMAN_ACTION_REQUIRED_BY_FIELD_CLASS';
  humanAction: 'PASSWORD';
  gap: Gap;
};

type HumanOnlyWithConcept = Base & {
  classificationKind: 'HUMAN_ACTION_REQUIRED';
  disposition: 'HUMAN_ONLY';
  reasonCode: 'ANSWER_HUMAN_ACTION_REQUIRED_BY_FIELD_CLASS';
  humanAction: 'PASSWORD';
  concept: 'CONTACT_EMAIL';
};

type GapWithHumanAction = Base & {
  classificationKind: 'UNRESOLVED';
  disposition: 'USER_INPUT_REQUIRED';
  reasonCode: 'ANSWER_GAP_CLASSIFICATION_UNRESOLVED';
  gap: Gap;
  humanAction: 'PASSWORD';
};

type InferenceClaimingAuthority = Base & {
  classificationKind: 'CANONICAL_FIELD';
  disposition: 'GENERATION_ALLOWED';
  reasonCode: 'ANSWER_PROFILE_CONCEPT_GENERATION_ALLOWED';
  concept: 'CONTACT_EMAIL';
  basis: 'INFERRED_CANDIDATE';
  candidates: readonly [];
  answerAuthority: 'PROFILE_CONFIRMED';
};

type FactDischargingRuntimeObligations = Base & {
  classificationKind: 'CANONICAL_FIELD';
  disposition: 'PROFILE_CONFIRMED_FACT';
  reasonCode: 'ANSWER_FROM_CONFIRMED_PROFILE_FACT';
  concept: 'CONTACT_EMAIL';
  basis: 'CONFIRMED_FACT';
  answerAuthority: 'PROFILE_CONFIRMED';
  outstandingWriteObligations: readonly [];
};

describe('Answer Resolution composition · the distinction is enforced by the type, not by convention', () => {
  it('rejects a HUMAN_ONLY item that carries a gap', () => {
    const rejected: IsAssignable<HumanOnlyWithGap, AnswerResolutionItem> = false;
    expect(rejected).toBe(false);
  });

  it('rejects a HUMAN_ONLY item that carries a Profile concept', () => {
    const rejected: IsAssignable<HumanOnlyWithConcept, AnswerResolutionItem> = false;
    expect(rejected).toBe(false);
  });

  it('rejects a USER_INPUT_REQUIRED item that carries a human action', () => {
    const rejected: IsAssignable<GapWithHumanAction, AnswerResolutionItem> = false;
    expect(rejected).toBe(false);
  });

  it('rejects an inferred candidate that claims a confirmed answer authority', () => {
    const rejected: IsAssignable<InferenceClaimingAuthority, AnswerResolutionItem> = false;
    expect(rejected).toBe(false);
  });

  it('rejects a confirmed fact that declares its runtime obligations discharged', () => {
    const rejected: IsAssignable<FactDischargingRuntimeObligations, AnswerResolutionItem> = false;
    expect(rejected).toBe(false);
  });

  it('still admits the shapes the resolver actually produces', () => {
    const confirmed = resolveAnswerDisposition(
      classification({ kind: 'CANONICAL_FIELD', canonicalField: 'EMAIL' }),
      CONFIRMED_EMAIL,
    );
    const humanOnly = resolveAnswerDisposition(
      classification({ kind: 'HUMAN_ACTION_REQUIRED' }),
      null,
    );
    expect([confirmed.disposition, humanOnly.disposition]).toEqual([
      'PROFILE_CONFIRMED_FACT',
      'HUMAN_ONLY',
    ]);
  });
});

describe('Answer Resolution composition · an inference is never a fact', () => {
  it('carries a confirmed basis only for a confirmed Profile fact', () => {
    const item = resolveAnswerDisposition(
      classification({ kind: 'CANONICAL_FIELD', canonicalField: 'EMAIL' }),
      CONFIRMED_EMAIL,
    );
    expect(item.disposition).toBe('PROFILE_CONFIRMED_FACT');
    if (item.disposition !== 'PROFILE_CONFIRMED_FACT') throw new Error('unreachable');
    expect(item.basis).toBe('CONFIRMED_FACT');
    expect(item.answerAuthority).toBe('PROFILE_CONFIRMED');
  });

  it('never labels a derivation as a fact and never grants it write authority', () => {
    const derived = profileItem({
      category: 'EXPLAINABLE_DERIVATION',
      disposition: 'USER_CONFIRMATION_REQUIRED',
      reasonCode: 'ANSWER_RESOLUTION_DERIVATION_REQUIRES_CONFIRMATION',
    });
    const item = resolveAnswerDisposition(
      classification({ kind: 'CANONICAL_FIELD', canonicalField: 'EMAIL' }),
      derived,
    );
    expect(item.disposition).toBe('MAPPED_REQUIRES_CONFIRMATION');
    if (item.disposition !== 'MAPPED_REQUIRES_CONFIRMATION') throw new Error('unreachable');
    expect(item.basis).toBe('INFERRED_CANDIDATE');
    expect(item).not.toHaveProperty('answerAuthority');
  });

  it('routes an AI suggestion to review and never to a direct write', () => {
    const item = resolveAnswerDisposition(
      classification({ kind: 'CANONICAL_FIELD', canonicalField: 'EMAIL' }),
      profileItem(),
    );
    expect(item.disposition).toBe('GENERATION_ALLOWED');
    if (item.disposition !== 'GENERATION_ALLOWED') throw new Error('unreachable');
    expect(item.basis).toBe('INFERRED_CANDIDATE');
    expect(item).not.toHaveProperty('answerAuthority');
  });

  it('grants a UA-4 answer authority on exactly one disposition', () => {
    const granted = PILOT_UA2_CANONICAL_FIELDS.flatMap((field: PilotUa2CanonicalField) =>
      [CONFIRMED_EMAIL, profileItem(), null].map((profile) =>
        resolveAnswerDisposition(
          classification({ kind: 'CANONICAL_FIELD', canonicalField: field }),
          profile,
        ),
      ),
    ).filter((item: AnswerResolutionItem) => 'answerAuthority' in item);
    expect(granted.length).toBeGreaterThan(0);
    for (const item of granted) expect(item.disposition).toBe('PROFILE_CONFIRMED_FACT');
  });
});

describe('Answer Resolution composition · write eligibility is not decided here', () => {
  it('leaves both runtime obligations outstanding on a confirmed fact', () => {
    const item = resolveAnswerDisposition(
      classification({ kind: 'CANONICAL_FIELD', canonicalField: 'EMAIL' }),
      CONFIRMED_EMAIL,
    );
    if (item.disposition !== 'PROFILE_CONFIRMED_FACT') throw new Error('unreachable');
    expect(item.outstandingWriteObligations).toEqual(['SEMANTIC_READBACK', 'OWNED_UNDO']);
  });

  it('never emits an item that claims the field is writable', () => {
    for (const kind of PILOT_UA2_CLASSIFICATION_KINDS) {
      const item = resolveAnswerDisposition(classification({ kind }), CONFIRMED_EMAIL);
      expect(item).not.toHaveProperty('writable');
      expect(item).not.toHaveProperty('written');
      expect(item).not.toHaveProperty('undoAvailable');
    }
  });
});
