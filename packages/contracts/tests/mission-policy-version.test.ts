import { describe, expect, it } from 'vitest';
import {
  composeMissionPolicyVersion,
  missionRuntimePolicyVersion,
} from '../src/missions.ts';

describe('mission policy version composition', () => {
  it('round-trips the runtime half through composition', () => {
    const composed = composeMissionPolicyVersion('apply-policy-2026-08-13', 3);
    expect(composed).toBe('apply-policy-2026-08-13.q3');
    expect(missionRuntimePolicyVersion(composed as string)).toBe('apply-policy-2026-08-13');
  });

  it('leaves a value without a quota suffix untouched', () => {
    // The published runtime bundle carries the plain version, and so do
    // missions approved before any quota assignment existed.
    expect(missionRuntimePolicyVersion('apply-policy-2026-08-13')).toBe(
      'apply-policy-2026-08-13',
    );
  });

  it('refuses a runtime version that already ends in a quota suffix', () => {
    // Composing over it would produce a value that decomposes into a different
    // runtime version than the caller supplied.
    expect(composeMissionPolicyVersion('apply-policy.q1', 2)).toBeNull();
  });

  it('refuses quota versions that are not positive integers', () => {
    for (const quota of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(composeMissionPolicyVersion('apply-policy', quota)).toBeNull();
    }
  });

  it('refuses an empty runtime version', () => {
    expect(composeMissionPolicyVersion('', 1)).toBeNull();
  });

  it('takes the last quota suffix so a dotted runtime version survives', () => {
    expect(missionRuntimePolicyVersion('apply.policy.2026.q7')).toBe('apply.policy.2026');
  });
});
