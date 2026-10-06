import { describe, expect, it } from 'vitest';

import { resolvePilotUa3CandidateRule } from '../src/pilotUa3CandidateRule';

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

describe('UA-3 deterministic ephemeral-rule interpreter', () => {
  it('admits only the live exact page and complete control identity set', () => {
    expect(resolvePilotUa3CandidateRule({
      rule,
      currentBinding: binding,
      currentControlIdentityDigests: [digest(1)],
      nowMs: 1_800_000_010_000,
    })).toEqual({ ok: true, value: rule });
  });

  it('fails closed on expiry, page drift, DOM replacement and control drift', () => {
    expect(resolvePilotUa3CandidateRule({ ...input(), nowMs: rule.expiresAtMs })).toEqual({
      ok: false,
      code: 'PILOT_EPHEMERAL_RULE_EXPIRED',
    });
    for (const currentBinding of [
      { ...binding, origin: 'https://other.example.test' },
      { ...binding, pathname: '/jobs/other' },
      { ...binding, domGeneration: digest(901) },
    ]) {
      expect(resolvePilotUa3CandidateRule({ ...input(), currentBinding })).toEqual({
        ok: false,
        code: 'PILOT_TARGET_DRIFT',
      });
    }
    expect(resolvePilotUa3CandidateRule({ ...input(), currentControlIdentityDigests: [] })).toEqual({
      ok: false,
      code: 'PILOT_TARGET_DRIFT',
    });
  });

  it('exposes no browser, network, write, selector, event or Submit operation', () => {
    const result = resolvePilotUa3CandidateRule(input());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/"(?:selector|javascript|writePlan|answerValue)"/i);
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
