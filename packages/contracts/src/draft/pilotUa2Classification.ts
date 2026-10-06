import {
  PILOT_UA1_MAX_CONTROLS,
  PILOT_UA1_SCHEMA_VERSION,
  parsePilotUa1DiscoveryPacket,
  type PilotUa1DiscoveryPacket,
  type PilotUa1PageBinding,
} from './pilotUa1Discovery.ts';
export type { PilotUa1VisibleControl } from './pilotUa1Discovery.ts';

/** UA-2 online classification is value-free and grants no write authority. */
export const PILOT_UA2_SCHEMA_VERSION = 1 as const;
export const PILOT_UA2_TRIGGER = 'USER_EXACT_PAGE' as const;
export const PILOT_UA2_CLASSIFICATION_ERROR_CODE =
  'PILOT_CLASSIFICATION_INPUT_INVALID' as const;

export const PILOT_UA2_FAILURE_CODES = [
  'PILOT_CAPABILITY_DISABLED',
  'PILOT_CLASSIFICATION_INPUT_INVALID',
  'PILOT_CLASSIFICATION_UNAVAILABLE',
  'PILOT_TARGET_DRIFT',
] as const;
export type PilotUa2FailureCode = (typeof PILOT_UA2_FAILURE_CODES)[number];

export const PILOT_UA2_CLASSIFICATION_KINDS = [
  'CANONICAL_FIELD',
  'STRUCTURED_CHOICE',
  'STRUCTURED_DATE',
  'STRUCTURED_NUMBER',
  'STRUCTURED_FILE',
  'OPEN_QUESTION',
  'HUMAN_ACTION_REQUIRED',
  'UNRESOLVED',
] as const;
export type PilotUa2ClassificationKind =
  (typeof PILOT_UA2_CLASSIFICATION_KINDS)[number];

export const PILOT_UA2_CANONICAL_FIELDS = [
  'NAME_FULL',
  'NAME_GIVEN',
  'NAME_FAMILY',
  'EMAIL',
  'PHONE',
  'ADDRESS_LINE_1',
  'ADDRESS_LINE_2',
  'CITY',
  'REGION',
  'POSTAL_CODE',
  'COUNTRY',
  'ORGANIZATION',
  'JOB_TITLE',
  'URL',
  'LINKEDIN_URL',
  'GITHUB_URL',
  'PORTFOLIO_URL',
] as const;
export type PilotUa2CanonicalField = (typeof PILOT_UA2_CANONICAL_FIELDS)[number];

export const PILOT_UA2_CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type PilotUa2Confidence = (typeof PILOT_UA2_CONFIDENCE_LEVELS)[number];

export const PILOT_UA2_PROVENANCE_SOURCES = [
  'AUTOCOMPLETE',
  'CONTROL_SEMANTICS',
  'BACKEND_TEXT_CLASSIFIER',
] as const;
export type PilotUa2ProvenanceSource =
  (typeof PILOT_UA2_PROVENANCE_SOURCES)[number];

export const PILOT_UA2_REASON_CODES = [
  'CANONICAL_AUTOCOMPLETE_MATCH',
  'CANONICAL_SEMANTIC_MATCH',
  'STRUCTURED_CHOICE_CONTROL',
  'STRUCTURED_DATE_CONTROL',
  'STRUCTURED_NUMBER_CONTROL',
  'STRUCTURED_FILE_CONTROL',
  'OPEN_QUESTION_CONTROL',
  'HUMAN_PASSWORD_CONTROL',
  'HUMAN_SUBMIT_CONTROL',
  'HUMAN_ACTION_CONTROL',
  'SEMANTIC_CLASSIFICATION_UNRESOLVED',
] as const;
export type PilotUa2ReasonCode = (typeof PILOT_UA2_REASON_CODES)[number];

export type PilotUa2ClassificationRequest = {
  readonly schemaVersion: typeof PILOT_UA2_SCHEMA_VERSION;
  readonly trigger: typeof PILOT_UA2_TRIGGER;
  readonly discovery: PilotUa1DiscoveryPacket;
};

export type PilotUa2Classification = {
  readonly identityDigest: string;
  readonly kind: PilotUa2ClassificationKind;
  readonly canonicalField: PilotUa2CanonicalField | null;
  readonly confidence: PilotUa2Confidence;
  readonly provenance: Readonly<{
    source: PilotUa2ProvenanceSource;
    semanticDigest: string;
  }>;
  readonly reasonCode: PilotUa2ReasonCode;
};

export type PilotUa2ClassificationSuccess = {
  readonly ok: true;
  readonly schemaVersion: typeof PILOT_UA2_SCHEMA_VERSION;
  readonly binding: PilotUa1PageBinding;
  readonly classifications: readonly PilotUa2Classification[];
  readonly constraints: Readonly<{
    writerAuthority: 'NOT_GRANTED';
    submit: 'HUMAN_ONLY';
    activationState: 'DEFAULT_OFF';
    releaseState: 'NOT_RELEASED';
  }>;
};

export type PilotUa2ClassificationFailure = {
  readonly ok: false;
  readonly schemaVersion: typeof PILOT_UA2_SCHEMA_VERSION;
  readonly code: PilotUa2FailureCode;
};

export type PilotUa2ClassificationResponse =
  | PilotUa2ClassificationSuccess
  | PilotUa2ClassificationFailure;

export type PilotUa2ParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: typeof PILOT_UA2_CLASSIFICATION_ERROR_CODE }>;

type DataValues = Readonly<Record<string, unknown>>;
type ReasonRule = Readonly<{
  kind: PilotUa2ClassificationKind;
  source: PilotUa2ProvenanceSource;
}>;

const FAILURE_CODES = new Set<string>(PILOT_UA2_FAILURE_CODES);
const KINDS = new Set<string>(PILOT_UA2_CLASSIFICATION_KINDS);
const CANONICAL_FIELDS = new Set<string>(PILOT_UA2_CANONICAL_FIELDS);
const CONFIDENCE_LEVELS = new Set<string>(PILOT_UA2_CONFIDENCE_LEVELS);
const PROVENANCE_SOURCES = new Set<string>(PILOT_UA2_PROVENANCE_SOURCES);
const SHA256_HEX = /^[a-f0-9]{64}$/;

const REASON_RULES = Object.freeze({
  CANONICAL_AUTOCOMPLETE_MATCH: { kind: 'CANONICAL_FIELD', source: 'AUTOCOMPLETE' },
  CANONICAL_SEMANTIC_MATCH: { kind: 'CANONICAL_FIELD', source: 'BACKEND_TEXT_CLASSIFIER' },
  STRUCTURED_CHOICE_CONTROL: { kind: 'STRUCTURED_CHOICE', source: 'CONTROL_SEMANTICS' },
  STRUCTURED_DATE_CONTROL: { kind: 'STRUCTURED_DATE', source: 'CONTROL_SEMANTICS' },
  STRUCTURED_NUMBER_CONTROL: { kind: 'STRUCTURED_NUMBER', source: 'CONTROL_SEMANTICS' },
  STRUCTURED_FILE_CONTROL: { kind: 'STRUCTURED_FILE', source: 'CONTROL_SEMANTICS' },
  OPEN_QUESTION_CONTROL: { kind: 'OPEN_QUESTION', source: 'CONTROL_SEMANTICS' },
  HUMAN_PASSWORD_CONTROL: { kind: 'HUMAN_ACTION_REQUIRED', source: 'CONTROL_SEMANTICS' },
  HUMAN_SUBMIT_CONTROL: { kind: 'HUMAN_ACTION_REQUIRED', source: 'CONTROL_SEMANTICS' },
  HUMAN_ACTION_CONTROL: { kind: 'HUMAN_ACTION_REQUIRED', source: 'CONTROL_SEMANTICS' },
  SEMANTIC_CLASSIFICATION_UNRESOLVED: { kind: 'UNRESOLVED', source: 'BACKEND_TEXT_CLASSIFIER' },
} as const satisfies Record<PilotUa2ReasonCode, ReasonRule>);

function failure<T>(): PilotUa2ParseResult<T> {
  return Object.freeze({ ok: false, code: PILOT_UA2_CLASSIFICATION_ERROR_CODE });
}

function exactDataValues(value: unknown, keys: readonly string[]): DataValues | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function denseDataArray(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key !== 'string')) return null;
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    copy.push(descriptor.value);
  }
  return copy;
}

function parseBinding(value: unknown): PilotUa1PageBinding | null {
  // A binding is validated by running it through the packet parser, so this
  // synthetic packet must stay a complete one; an omitted field reads as a
  // malformed binding rather than a missing field.
  const parsed = parsePilotUa1DiscoveryPacket({
    schemaVersion: PILOT_UA1_SCHEMA_VERSION,
    binding: value,
    controls: [],
    observation: { suppressedControls: [], hiddenNotObservedCount: 0, opaqueBoundaries: [] },
  });
  return parsed.ok ? parsed.value.binding : null;
}

function parseClassification(value: unknown): PilotUa2Classification | null {
  const fields = exactDataValues(value, [
    'identityDigest',
    'kind',
    'canonicalField',
    'confidence',
    'provenance',
    'reasonCode',
  ]);
  if (!fields || typeof fields.identityDigest !== 'string' || !SHA256_HEX.test(fields.identityDigest)) return null;
  if (typeof fields.kind !== 'string' || !KINDS.has(fields.kind)) return null;
  const kind = fields.kind as PilotUa2ClassificationKind;
  const canonicalField = fields.canonicalField === null
    ? null
    : typeof fields.canonicalField === 'string' && CANONICAL_FIELDS.has(fields.canonicalField)
      ? fields.canonicalField as PilotUa2CanonicalField
      : undefined;
  if (canonicalField === undefined || (kind === 'CANONICAL_FIELD') !== (canonicalField !== null)) return null;
  if (typeof fields.confidence !== 'string' || !CONFIDENCE_LEVELS.has(fields.confidence)) return null;
  const provenance = exactDataValues(fields.provenance, ['source', 'semanticDigest']);
  if (
    !provenance ||
    typeof provenance.source !== 'string' ||
    !PROVENANCE_SOURCES.has(provenance.source) ||
    typeof provenance.semanticDigest !== 'string' ||
    !SHA256_HEX.test(provenance.semanticDigest) ||
    typeof fields.reasonCode !== 'string' ||
    !(fields.reasonCode in REASON_RULES)
  ) return null;
  const reasonCode = fields.reasonCode as PilotUa2ReasonCode;
  const rule = REASON_RULES[reasonCode];
  if (rule.kind !== kind || rule.source !== provenance.source) return null;
  return Object.freeze({
    identityDigest: fields.identityDigest,
    kind,
    canonicalField,
    confidence: fields.confidence as PilotUa2Confidence,
    provenance: Object.freeze({
      source: provenance.source as PilotUa2ProvenanceSource,
      semanticDigest: provenance.semanticDigest,
    }),
    reasonCode,
  });
}

function parseConstraints(value: unknown): PilotUa2ClassificationSuccess['constraints'] | null {
  const fields = exactDataValues(value, [
    'writerAuthority',
    'submit',
    'activationState',
    'releaseState',
  ]);
  if (
    !fields ||
    fields.writerAuthority !== 'NOT_GRANTED' ||
    fields.submit !== 'HUMAN_ONLY' ||
    fields.activationState !== 'DEFAULT_OFF' ||
    fields.releaseState !== 'NOT_RELEASED'
  ) return null;
  return Object.freeze({
    writerAuthority: 'NOT_GRANTED',
    submit: 'HUMAN_ONLY',
    activationState: 'DEFAULT_OFF',
    releaseState: 'NOT_RELEASED',
  });
}

export function parsePilotUa2ClassificationRequest(
  value: unknown,
): PilotUa2ParseResult<PilotUa2ClassificationRequest> {
  try {
    const fields = exactDataValues(value, ['schemaVersion', 'trigger', 'discovery']);
    if (!fields || fields.schemaVersion !== 1 || fields.trigger !== PILOT_UA2_TRIGGER) return failure();
    const discovery = parsePilotUa1DiscoveryPacket(fields.discovery);
    if (!discovery.ok) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({ schemaVersion: 1, trigger: PILOT_UA2_TRIGGER, discovery: discovery.value }),
    });
  } catch {
    return failure();
  }
}

export function parsePilotUa2ClassificationResponse(
  value: unknown,
): PilotUa2ParseResult<PilotUa2ClassificationResponse> {
  try {
    const discriminator = exactDataValues(value, ['ok', 'schemaVersion', 'code']);
    if (discriminator) {
      if (
        discriminator.ok !== false ||
        discriminator.schemaVersion !== 1 ||
        typeof discriminator.code !== 'string' ||
        !FAILURE_CODES.has(discriminator.code)
      ) return failure();
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          ok: false,
          schemaVersion: 1,
          code: discriminator.code as PilotUa2FailureCode,
        }),
      });
    }

    const fields = exactDataValues(value, [
      'ok',
      'schemaVersion',
      'binding',
      'classifications',
      'constraints',
    ]);
    if (!fields || fields.ok !== true || fields.schemaVersion !== 1) return failure();
    const binding = parseBinding(fields.binding);
    const rawClassifications = denseDataArray(fields.classifications);
    const constraints = parseConstraints(fields.constraints);
    if (!binding || !rawClassifications || rawClassifications.length > PILOT_UA1_MAX_CONTROLS || !constraints) return failure();
    const classifications: PilotUa2Classification[] = [];
    const digests = new Set<string>();
    for (const raw of rawClassifications) {
      const classification = parseClassification(raw);
      if (!classification || digests.has(classification.identityDigest)) return failure();
      digests.add(classification.identityDigest);
      classifications.push(classification);
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        ok: true,
        schemaVersion: 1,
        binding,
        classifications: Object.freeze(classifications),
        constraints,
      }),
    });
  } catch {
    return failure();
  }
}

export function pilotUa2ResponseMatchesRequest(
  request: PilotUa2ClassificationRequest,
  response: PilotUa2ClassificationResponse,
): boolean {
  const parsedRequest = parsePilotUa2ClassificationRequest(request);
  const parsedResponse = parsePilotUa2ClassificationResponse(response);
  if (!parsedRequest.ok || !parsedResponse.ok) return false;
  if (!parsedResponse.value.ok) return true;
  const expectedBinding = parsedRequest.value.discovery.binding;
  const actualBinding = parsedResponse.value.binding;
  if (
    actualBinding.origin !== expectedBinding.origin ||
    actualBinding.pathname !== expectedBinding.pathname ||
    actualBinding.domGeneration !== expectedBinding.domGeneration
  ) return false;
  const expected = parsedRequest.value.discovery.controls;
  const actual = parsedResponse.value.classifications;
  return expected.length === actual.length && expected.every(
    (control, index) => control.identityDigest === actual[index]?.identityDigest,
  );
}
