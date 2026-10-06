import { describe, expect, it } from 'vitest';

import {
  parseProfileStrengthSnapshot,
  parseSaveProfileStrengthRequest,
} from '../src/profile-strength';

describe('T5 profile strength contract', () => {
  it('accepts user-entered and confirmed strengths with DecimalString revision', () => {
    expect(parseProfileStrengthSnapshot({
      schemaVersion: 1,
      revision: '9007199254740993',
      strengths: [{
        id: 'str_1',
        label: 'Systems thinking',
        source: 'USER_CONFIRMED',
        category: 'SOFT',
        evidence: [{ profileRef: 'profile-v2/achievements/a1', note: 'Confirmed Profile achievement' }],
      }],
    }).ok).toBe(true);
  });

  it('rejects DERIVED writes and unknown keys', () => {
    expect(parseSaveProfileStrengthRequest({
      label: 'Systems thinking',
      source: 'DERIVED',
      category: 'SOFT',
      evidence: [],
    }).ok).toBe(false);
    expect(parseSaveProfileStrengthRequest({
      label: 'Systems thinking',
      source: 'USER_FREEFORM',
      category: 'SOFT',
      evidence: [],
      extra: true,
    }).ok).toBe(false);
  });

  it('requires confirmed strengths to keep grounded evidence', () => {
    expect(parseSaveProfileStrengthRequest({
      label: 'Systems thinking',
      source: 'USER_CONFIRMED',
      category: 'SOFT',
      evidence: [],
    }).ok).toBe(false);
  });
});
