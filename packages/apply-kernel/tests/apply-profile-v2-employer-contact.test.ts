import type { CandidateProfileSnapshotV2, ProfileFieldAuthorityV2 } from '@edaix/contracts';
import { describe, expect, it } from 'vitest';

import { confirmedEmployerContact } from '../src/profileV2EmployerContact';

/**
 * 「可以联系你现在的雇主吗？」（2026-09-28）只投影用户确认过的回答；没答、没确认、老服务端不发这一项 → null（交还本人）。
 */
function authority(state = 'USER_CONFIRMED', deletionEpoch = '4'): ProfileFieldAuthorityV2 {
  return {
    factId: '76000000-0000-4000-8000-000000000002', factRevision: '1', deletionEpoch,
    meta: { source: 'USER', authorityState: state, confidence: null, userConfirmedAt: state === 'USER_CONFIRMED' ? '2026-09-28T00:00:00.000Z' : null, sourceRef: null },
  } as unknown as ProfileFieldAuthorityV2;
}

/** `fieldAuthority: null` = 快照里没有这一格的确认记录。 */
function snapshot(value: unknown, fieldAuthority: ProfileFieldAuthorityV2 | null = authority()): CandidateProfileSnapshotV2 {
  return {
    schemaVersion: 2, revision: '3', deletionEpoch: '4', hasStoredProfile: true, updatedAt: null,
    profile: {
      preferences: value === undefined ? undefined : { workModes: null, openToRelocation: null, openToRelocationCities: null, contactCurrentEmployer: value },
      scalarAuthorityByPath: fieldAuthority === null ? {} : { 'preferences.contactCurrentEmployer': fieldAuthority },
    },
  } as unknown as CandidateProfileSnapshotV2;
}

describe('资料里对「可以联系你现在的雇主吗」的回答', () => {
  it('确认过的「可以」→ YES；「不可以」→ NO', () => {
    expect(confirmedEmployerContact(snapshot(true))).toBe('YES');
    expect(confirmedEmployerContact(snapshot(false))).toBe('NO');
  });

  it('没答（null）→ null', () => {
    expect(confirmedEmployerContact(snapshot(null))).toBeNull();
  });

  it('没确认、确认记录缺席、删除纪元对不上 → null', () => {
    expect(confirmedEmployerContact(snapshot(true, authority('SUGGESTED')))).toBeNull();
    expect(confirmedEmployerContact(snapshot(true, null))).toBeNull();
    expect(confirmedEmployerContact(snapshot(false, authority('USER_CONFIRMED', '5')))).toBeNull();
  });

  it('后端先发的加法：这一版不认识的来源或确认状态 → 不算确认过（null，交还本人）', () => {
    const foreign = (over: Record<string, unknown>) => {
      const base = authority() as unknown as { meta: Record<string, unknown> };
      return { ...base, meta: { ...base.meta, ...over } } as unknown as ProfileFieldAuthorityV2;
    };
    expect(confirmedEmployerContact(snapshot(true, foreign({ source: 'LINKEDIN_IMPORT' })))).toBeNull();
    expect(confirmedEmployerContact(snapshot(false, foreign({ authorityState: 'PARTNER_VERIFIED' })))).toBeNull();
    expect(confirmedEmployerContact(snapshot(true, foreign({ sourceRef: { kind: 'PARTNER_SYNC' } })))).toBeNull();
  });

  it('老服务端（快照里没有这一组）→ null', () => {
    expect(confirmedEmployerContact(snapshot(undefined, null))).toBeNull();
  });
});
