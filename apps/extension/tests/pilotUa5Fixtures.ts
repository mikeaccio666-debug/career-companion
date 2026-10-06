import { PILOT_UA5_PROFILE_PAYLOAD_CONSTRAINTS, type PilotUa5ProfilePayloadRequest } from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
const hex = (seed: string): string => seed.repeat(64).slice(0, 64);
export const binding = Object.freeze({
  origin: 'https://job-boards.greenhouse.io',
  pathname: '/acme/jobs/123',
  domGeneration: hex('a'),
});
const identityDigest = hex('b');
export const answerDigest = hex('c');

export const request: PilotUa5ProfilePayloadRequest = Object.freeze({
  schemaVersion: 1,
  trigger: 'USER_CURRENT_PAGE_REQUEST',
  discovery: Object.freeze({
    schemaVersion: 2,
    binding,
    controls: Object.freeze([Object.freeze({
      identityDigest,
      role: 'textbox' as const,
      inputType: 'email' as const,
      autocomplete: Object.freeze(['email']),
      required: true,
      accessibleName: 'Email',
      fileAccept: null,
      label: 'Email',
      legend: null,
      options: Object.freeze([]),
    })]),
    observation: Object.freeze({
      suppressedControls: Object.freeze([]),
      hiddenNotObservedCount: 0, opaqueBoundaries: [],
    }),
  }),
  structure: Object.freeze({
    schemaVersion: 1,
    packetDigest: hex('d'),
    epochIndex: 0,
    compilerVersion: 'semantic-compiler-1',
    counts: Object.freeze({ controls: 1, entries: 1, suppressed: 0, hiddenNotObserved: 0 }),
    entries: Object.freeze([Object.freeze({
      identityDigest,
      elementToken: hex('e'),
      groupKeyDigest: null,
      row: null,
      documentOrder: 0,
      memberOfGroupControl: null,
      placeholderShape: null,
      optionsOverflow: false,
      placeholderOptionIndexes: Object.freeze([]),
      disabled: false,
      readOnly: false,
      multiple: false,
    })]),
  }),
});

export function success() {
  return {
    ok: true,
    schemaVersion: 1,
    composition: {
      ok: true,
      schemaVersion: 1,
      candidateRule: {
        schemaVersion: 1,
        kind: 'EPHEMERAL_PAGE_CANDIDATE',
        binding,
        pageIdentityDigest: hex('f'),
        issuedAtMs: 1_000,
        expiresAtMs: 31_000,
        classifications: [{
          identityDigest,
          kind: 'CANONICAL_FIELD',
          canonicalField: 'EMAIL',
          confidence: 'HIGH',
          provenance: { source: 'AUTOCOMPLETE', semanticDigest: hex('1') },
          reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH',
        }],
        constraints: {
          remoteCode: 'FORBIDDEN',
          automaticPublication: 'FORBIDDEN',
          writerAuthority: 'NOT_GRANTED',
          submit: 'HUMAN_ONLY',
          activationState: 'DEFAULT_OFF',
          releaseState: 'NOT_RELEASED',
        },
      },
      authority: {
        authorityId: hex('2'),
        binding,
        pageIdentityDigest: hex('f'),
        observedControlIdentityDigests: [identityDigest],
        expiresAtMs: 31_000,
        questionAuthorizations: [{
          questionId: 'question.email',
          controlKind: 'TEXT',
          identityDigests: [identityDigest],
          required: true,
          answerAuthority: 'PROFILE_CONFIRMED',
          answerDigest,
        }],
        blockedQuestions: [],
        constraints: {
          exactTargetBinding: 'REQUIRED',
          semanticReadback: 'REQUIRED',
          hostValidation: 'REQUIRED',
          lateRecheck: 'REQUIRED',
          undo: 'REQUIRED',
          submit: 'FORBIDDEN',
          activationState: 'DEFAULT_OFF',
          releaseState: 'NOT_RELEASED',
        },
      },
      projection: {
        schemaVersion: 1,
        binding,
        rows: [{
          questionId: 'question.email',
          required: true,
          writerKind: 'TEXT',
          memberCount: 1,
          admission: 'AUTHORIZED',
        }],
        summary: {
          observableQuestions: 1,
          requiredQuestions: 1,
          authorizedQuestions: 1,
          requiredAuthorizedQuestions: 1,
        },
      },
      constraints: {
        submit: 'FORBIDDEN',
        remoteCode: 'FORBIDDEN',
        rawValues: 'NEVER_TRANSMITTED',
        activationState: 'DEFAULT_OFF',
        releaseState: 'NOT_RELEASED',
      },
    },
    profileBinding: {
      fieldSchemaVersion: 1,
      fieldKeys: ['email'],
      revision: '7',
      deletionEpoch: '0',
      snapshotDigest: `sha256:${hex('3')}`,
    },
    payloads: [{
      questionId: 'question.email',
      payloadRef: 'ua5.profile.question.email',
      answerDigest,
      value: 'ada@example.invalid',
    }],
    constraints: PILOT_UA5_PROFILE_PAYLOAD_CONSTRAINTS,
  };
}
