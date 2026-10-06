import { describe, expect, it } from 'vitest';

import { createPilotUa3CandidateRuleRuntime } from '../lib/pilotUa3CandidateRuleRuntime';

const digest = (ordinal: number): string => ordinal.toString(16).padStart(64, '0');
const binding = {
  origin: 'https://careers.example.test',
  pathname: '/jobs/engineer',
  domGeneration: digest(900),
};
const rule = {
  schemaVersion: 1,
  kind: 'EPHEMERAL_PAGE_CANDIDATE',
  binding,
  pageIdentityDigest: digest(88),
  issuedAtMs: 1_800_000_000_000,
  expiresAtMs: 1_800_000_030_000,
  classifications: [{
    identityDigest: digest(1),
    kind: 'CANONICAL_FIELD',
    canonicalField: 'EMAIL',
    confidence: 'HIGH',
    provenance: { source: 'AUTOCOMPLETE', semanticDigest: digest(2) },
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
} as const;

describe('UA-3 Extension-owned candidate-rule runtime', () => {
  it('is default-off with zero admission', () => {
    const runtime = createPilotUa3CandidateRuleRuntime({ enabled: false });
    expect(runtime.admit(input())).toEqual({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
  });

  it('admits a live candidate without exposing a host action', () => {
    const runtime = createPilotUa3CandidateRuleRuntime({ enabled: true });
    expect(runtime.admit(input())).toEqual({ ok: true, value: rule });
    expect(Object.keys(runtime)).toEqual(['admit']);
  });

  it('fails closed after expiry or exact-page/control drift', () => {
    const runtime = createPilotUa3CandidateRuleRuntime({ enabled: true });
    expect(runtime.admit({ ...input(), nowMs: rule.expiresAtMs })).toEqual({
      ok: false,
      code: 'PILOT_EPHEMERAL_RULE_EXPIRED',
    });
    expect(runtime.admit({
      ...input(),
      currentBinding: { ...binding, domGeneration: digest(901) },
    })).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
  });
});

function input() {
  return {
    rule,
    currentBinding: binding,
    currentControlIdentityDigests: [digest(1)],
    nowMs: 1_800_000_010_000,
  };
}
