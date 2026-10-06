import {
  resolvePilotUa3CandidateRule,
  type PilotUa3CandidateRuleRuntimeInput,
  type PilotUa3CandidateRuleRuntimeResult,
} from '@edaix/apply-kernel/pilotUa3CandidateRule';

export type PilotUa3CandidateRuleRuntime = Readonly<{
  admit(input: PilotUa3CandidateRuleRuntimeInput): PilotUa3CandidateRuleRuntimeResult;
}>;

export function createPilotUa3CandidateRuleRuntime(
  policy: Readonly<{ enabled: boolean }>,
): PilotUa3CandidateRuleRuntime {
  return Object.freeze({
    admit(input: PilotUa3CandidateRuleRuntimeInput): PilotUa3CandidateRuleRuntimeResult {
      if (!policy.enabled) return Object.freeze({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
      return resolvePilotUa3CandidateRule(input);
    },
  });
}
