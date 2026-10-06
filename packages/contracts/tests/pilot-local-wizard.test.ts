import { describe, expect, it } from 'vitest';
import { parsePilotLocalWizardProjection } from '../src/draft/pilotLocalWizard';

const projection = () => ({ schemaVersion: 1, scope: 'LOCAL_SESSION',
  sessionDigest: 'a'.repeat(64), currentStep: { stepIndex: 1, identityDigest: 'c'.repeat(64) },
  checkpoints: [{ stepIndex: 0, identityDigest: 'b'.repeat(64), discoveryComplete: false,
    requiredDispositions: [{ questionId: 'question-one', disposition: { state: 'POLICY_BLOCKED', reason: 'HOST_REJECTED', writeEffect: 'MAY_HAVE_CHANGED' } }],
    unobservedRegions: [{ regionId: 'd'.repeat(64), reason: 'FRAME_NOT_OBSERVED' }],
  }],
});

describe('LOCAL_SESSION wizard projection', () => {
  it('preserves required dispositions and unknown regions without a total-page denominator', () => {
    const value = projection();
    const parsed = parsePilotLocalWizardProjection(value);
    expect(parsed).toEqual({ ok: true, value });
    if (!parsed.ok) throw new Error(parsed.code);
    expect(Object.isFrozen(parsed.value.checkpoints[0]!.requiredDispositions[0]!.disposition)).toBe(true);
  });
  it('rejects Mission scope, raw fields, getters, duplicate questions, step gaps and invented completion', () => {
    const base = projection();
    const getter = Object.defineProperty({ ...base }, 'checkpoints', { enumerable: true, get() { throw new Error('must not invoke'); } });
    const invalid = [
      { ...base, scope: 'MISSION' }, { ...base, selectors: '#host' }, getter,
      { ...base, currentStep: { stepIndex: 4, identityDigest: 'e'.repeat(64) } },
      { ...base, checkpoints: [{ ...base.checkpoints[0], stepIndex: 1 }] },
      { ...base, checkpoints: [{ ...base.checkpoints[0], discoveryComplete: true }] },
      { ...base, checkpoints: [{ ...base.checkpoints[0], requiredDispositions: [...base.checkpoints[0]!.requiredDispositions, ...base.checkpoints[0]!.requiredDispositions] }] },
      { ...base, currentStep: { ...base.currentStep, identityDigest: base.checkpoints[0]!.identityDigest } },
    ];
    for (const candidate of invalid) expect(parsePilotLocalWizardProjection(candidate).ok).toBe(false);
    expect(parsePilotLocalWizardProjection({ ...base, currentStep: null }).ok).toBe(true);
    expect(parsePilotLocalWizardProjection({ ...base, checkpoints: [], currentStep: { stepIndex: 0, identityDigest: 'b'.repeat(64) } }).ok).toBe(true);
  });
});
