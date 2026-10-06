import {
  parsePilotUa3CandidateRule,
  type PilotUa3CandidateRule,
  type PilotUa3FailureCode,
} from '@edaix/contracts/draft/pilot-ua3-candidate-rule';
import {
  PILOT_UA1_SCHEMA_VERSION,
  parsePilotUa1DiscoveryPacket,
  type PilotUa1PageBinding,
} from '@edaix/contracts/draft';

export type PilotUa3CandidateRuleRuntimeInput = Readonly<{
  rule: unknown;
  currentBinding: unknown;
  currentControlIdentityDigests: unknown;
  nowMs: unknown;
}>;

export type PilotUa3CandidateRuleRuntimeResult =
  | Readonly<{ ok: true; value: PilotUa3CandidateRule }>
  | Readonly<{ ok: false; code: PilotUa3FailureCode }>;

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Pure UA-3 interpreter. It can only admit an already validated candidate for
 * the same live page and controls; it has no DOM, network, writer or publisher.
 */
export function resolvePilotUa3CandidateRule(
  input: PilotUa3CandidateRuleRuntimeInput,
): PilotUa3CandidateRuleRuntimeResult {
  try {
    const rule = parsePilotUa3CandidateRule(input.rule);
    if (!rule.ok) return failure('PILOT_EPHEMERAL_RULE_INPUT_INVALID');
    const currentBinding = parseBinding(input.currentBinding);
    const identities = parseIdentities(input.currentControlIdentityDigests);
    if (
      !currentBinding ||
      !identities ||
      typeof input.nowMs !== 'number' ||
      !Number.isSafeInteger(input.nowMs) ||
      input.nowMs < 0
    ) return failure('PILOT_EPHEMERAL_RULE_INPUT_INVALID');
    if (input.nowMs < rule.value.issuedAtMs || input.nowMs >= rule.value.expiresAtMs) {
      return failure('PILOT_EPHEMERAL_RULE_EXPIRED');
    }
    if (
      currentBinding.origin !== rule.value.binding.origin ||
      currentBinding.pathname !== rule.value.binding.pathname ||
      currentBinding.domGeneration !== rule.value.binding.domGeneration ||
      identities.length !== rule.value.classifications.length ||
      !identities.every(
        (identity, index) => identity === rule.value.classifications[index]?.identityDigest,
      )
    ) return failure('PILOT_TARGET_DRIFT');
    return Object.freeze({ ok: true, value: rule.value });
  } catch {
    return failure('PILOT_EPHEMERAL_RULE_INPUT_INVALID');
  }
}

function parseBinding(value: unknown): PilotUa1PageBinding | null {
  const parsed = parsePilotUa1DiscoveryPacket({ schemaVersion: PILOT_UA1_SCHEMA_VERSION, binding: value, controls: [], observation: { suppressedControls: [], hiddenNotObservedCount: 0, opaqueBoundaries: [] } });
  return parsed.ok ? parsed.value.binding : null;
}

function parseIdentities(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key !== 'string')) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    const identity = descriptor.value;
    if (typeof identity !== 'string' || !SHA256_HEX.test(identity) || seen.has(identity)) return null;
    seen.add(identity);
    result.push(identity);
  }
  return Object.freeze(result);
}

function failure(code: PilotUa3FailureCode): PilotUa3CandidateRuleRuntimeResult {
  return Object.freeze({ ok: false, code });
}
