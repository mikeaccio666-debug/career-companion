import {
  parsePilotUa2ClassificationResponse,
  type PilotUa2Classification,
  type PilotUa2ClassificationSuccess,
} from './pilotUa2Classification.ts';
import type { PilotUa1PageBinding } from './pilotUa1Discovery.ts';

/** UA-3 produces only a request-local, page-bound candidate classification rule. */
export const PILOT_UA3_SCHEMA_VERSION = 1 as const;
export const PILOT_UA3_TRIGGER = 'USER_EXACT_PAGE' as const;
export const PILOT_UA3_RULE_KIND = 'EPHEMERAL_PAGE_CANDIDATE' as const;
export const PILOT_UA3_MAX_LIFETIME_MS = 60_000 as const;
export const PILOT_UA3_DEFAULT_LIFETIME_MS = 30_000 as const;
export const PILOT_UA3_CANDIDATE_RULE_ERROR_CODE =
  'PILOT_EPHEMERAL_RULE_INPUT_INVALID' as const;

export const PILOT_UA3_FAILURE_CODES = [
  'PILOT_CAPABILITY_DISABLED',
  'PILOT_EPHEMERAL_RULE_INPUT_INVALID',
  'PILOT_EPHEMERAL_RULE_EXPIRED',
  'PILOT_TARGET_DRIFT',
] as const;
export type PilotUa3FailureCode = (typeof PILOT_UA3_FAILURE_CODES)[number];

export type PilotUa3CandidateRuleRequest = Readonly<{
  schemaVersion: typeof PILOT_UA3_SCHEMA_VERSION;
  trigger: typeof PILOT_UA3_TRIGGER;
  classification: PilotUa2ClassificationSuccess;
}>;

export type PilotUa3CandidateRule = Readonly<{
  schemaVersion: typeof PILOT_UA3_SCHEMA_VERSION;
  kind: typeof PILOT_UA3_RULE_KIND;
  binding: PilotUa1PageBinding;
  pageIdentityDigest: string;
  issuedAtMs: number;
  expiresAtMs: number;
  classifications: readonly PilotUa2Classification[];
  constraints: Readonly<{
    remoteCode: 'FORBIDDEN';
    automaticPublication: 'FORBIDDEN';
    writerAuthority: 'NOT_GRANTED';
    submit: 'HUMAN_ONLY';
    activationState: 'DEFAULT_OFF';
    releaseState: 'NOT_RELEASED';
  }>;
}>;

export type PilotUa3CandidateRuleSuccess = Readonly<{
  ok: true;
  schemaVersion: typeof PILOT_UA3_SCHEMA_VERSION;
  rule: PilotUa3CandidateRule;
}>;

export type PilotUa3CandidateRuleFailure = Readonly<{
  ok: false;
  schemaVersion: typeof PILOT_UA3_SCHEMA_VERSION;
  code: PilotUa3FailureCode;
}>;

export type PilotUa3CandidateRuleResponse =
  | PilotUa3CandidateRuleSuccess
  | PilotUa3CandidateRuleFailure;

export type PilotUa3ParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: typeof PILOT_UA3_CANDIDATE_RULE_ERROR_CODE }>;

type DataValues = Readonly<Record<string, unknown>>;
const FAILURE_CODES = new Set<string>(PILOT_UA3_FAILURE_CODES);
const SHA256_HEX = /^[a-f0-9]{64}$/;

function failure<T>(): PilotUa3ParseResult<T> {
  return Object.freeze({ ok: false, code: PILOT_UA3_CANDIDATE_RULE_ERROR_CODE });
}

function exactDataValues(value: unknown, keys: readonly string[]): DataValues | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(
    (key) => typeof key !== 'string' || !keys.includes(key),
  )) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function parseClassificationSuccess(value: unknown): PilotUa2ClassificationSuccess | null {
  const parsed = parsePilotUa2ClassificationResponse(value);
  return parsed.ok && parsed.value.ok ? parsed.value : null;
}

function parseConstraints(value: unknown): PilotUa3CandidateRule['constraints'] | null {
  const fields = exactDataValues(value, [
    'remoteCode',
    'automaticPublication',
    'writerAuthority',
    'submit',
    'activationState',
    'releaseState',
  ]);
  if (
    !fields ||
    fields.remoteCode !== 'FORBIDDEN' ||
    fields.automaticPublication !== 'FORBIDDEN' ||
    fields.writerAuthority !== 'NOT_GRANTED' ||
    fields.submit !== 'HUMAN_ONLY' ||
    fields.activationState !== 'DEFAULT_OFF' ||
    fields.releaseState !== 'NOT_RELEASED'
  ) return null;
  return Object.freeze({
    remoteCode: 'FORBIDDEN',
    automaticPublication: 'FORBIDDEN',
    writerAuthority: 'NOT_GRANTED',
    submit: 'HUMAN_ONLY',
    activationState: 'DEFAULT_OFF',
    releaseState: 'NOT_RELEASED',
  });
}

export function parsePilotUa3CandidateRuleRequest(
  value: unknown,
): PilotUa3ParseResult<PilotUa3CandidateRuleRequest> {
  try {
    const fields = exactDataValues(value, ['schemaVersion', 'trigger', 'classification']);
    if (!fields || fields.schemaVersion !== 1 || fields.trigger !== PILOT_UA3_TRIGGER) return failure();
    const classification = parseClassificationSuccess(fields.classification);
    if (!classification) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        schemaVersion: 1,
        trigger: PILOT_UA3_TRIGGER,
        classification,
      }),
    });
  } catch {
    return failure();
  }
}

export function parsePilotUa3CandidateRule(
  value: unknown,
): PilotUa3ParseResult<PilotUa3CandidateRule> {
  try {
    const fields = exactDataValues(value, [
      'schemaVersion',
      'kind',
      'binding',
      'pageIdentityDigest',
      'issuedAtMs',
      'expiresAtMs',
      'classifications',
      'constraints',
    ]);
    if (
      !fields ||
      fields.schemaVersion !== 1 ||
      fields.kind !== PILOT_UA3_RULE_KIND ||
      typeof fields.pageIdentityDigest !== 'string' ||
      !SHA256_HEX.test(fields.pageIdentityDigest) ||
      typeof fields.issuedAtMs !== 'number' ||
      !Number.isSafeInteger(fields.issuedAtMs) ||
      fields.issuedAtMs < 0 ||
      typeof fields.expiresAtMs !== 'number' ||
      !Number.isSafeInteger(fields.expiresAtMs) ||
      fields.expiresAtMs <= fields.issuedAtMs ||
      fields.expiresAtMs - fields.issuedAtMs > PILOT_UA3_MAX_LIFETIME_MS
    ) return failure();
    const constraints = parseConstraints(fields.constraints);
    if (!constraints) return failure();
    const classification = parseClassificationSuccess({
      ok: true,
      schemaVersion: 1,
      binding: fields.binding,
      classifications: fields.classifications,
      constraints: {
        writerAuthority: 'NOT_GRANTED',
        submit: 'HUMAN_ONLY',
        activationState: 'DEFAULT_OFF',
        releaseState: 'NOT_RELEASED',
      },
    });
    if (!classification) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        schemaVersion: 1,
        kind: PILOT_UA3_RULE_KIND,
        binding: classification.binding,
        pageIdentityDigest: fields.pageIdentityDigest,
        issuedAtMs: fields.issuedAtMs,
        expiresAtMs: fields.expiresAtMs,
        classifications: classification.classifications,
        constraints,
      }),
    });
  } catch {
    return failure();
  }
}

export function parsePilotUa3CandidateRuleResponse(
  value: unknown,
): PilotUa3ParseResult<PilotUa3CandidateRuleResponse> {
  try {
    const failed = exactDataValues(value, ['ok', 'schemaVersion', 'code']);
    if (failed) {
      if (
        failed.ok !== false ||
        failed.schemaVersion !== 1 ||
        typeof failed.code !== 'string' ||
        !FAILURE_CODES.has(failed.code)
      ) return failure();
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          ok: false,
          schemaVersion: 1,
          code: failed.code as PilotUa3FailureCode,
        }),
      });
    }
    const fields = exactDataValues(value, ['ok', 'schemaVersion', 'rule']);
    if (!fields || fields.ok !== true || fields.schemaVersion !== 1) return failure();
    const rule = parsePilotUa3CandidateRule(fields.rule);
    if (!rule.ok) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({ ok: true, schemaVersion: 1, rule: rule.value }),
    });
  } catch {
    return failure();
  }
}

export function pilotUa3RuleMatchesClassification(
  ruleValue: unknown,
  classificationValue: unknown,
): boolean {
  const parsedRule = parsePilotUa3CandidateRule(ruleValue);
  const classification = parseClassificationSuccess(classificationValue);
  if (!parsedRule.ok || !classification) return false;
  const rule = parsedRule.value;
  if (
    rule.binding.origin !== classification.binding.origin ||
    rule.binding.pathname !== classification.binding.pathname ||
    rule.binding.domGeneration !== classification.binding.domGeneration ||
    rule.classifications.length !== classification.classifications.length
  ) return false;
  return rule.classifications.every((item, index) => {
    const expected = classification.classifications[index];
    return expected !== undefined &&
      item.identityDigest === expected.identityDigest &&
      item.kind === expected.kind &&
      item.canonicalField === expected.canonicalField &&
      item.confidence === expected.confidence &&
      item.reasonCode === expected.reasonCode &&
      item.provenance.source === expected.provenance.source &&
      item.provenance.semanticDigest === expected.provenance.semanticDigest;
  });
}
