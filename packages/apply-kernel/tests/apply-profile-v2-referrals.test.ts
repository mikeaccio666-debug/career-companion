import type { CandidateProfileSnapshotV2, ProfileFieldAuthorityV2 } from '@edaix/contracts';
import { describe, expect, it } from 'vitest';

import { confirmedReferrals } from '../src/profileV2Referrals';

/** 推荐人只投影用户确认过姓名与公司两格的记录（P1-9）；快照里没有这一组 → 空。 */
function authority(state = 'USER_CONFIRMED'): ProfileFieldAuthorityV2 {
  return {
    factId: '76000000-0000-4000-8000-000000000002', factRevision: '1', deletionEpoch: '4',
    meta: { source: 'USER', authorityState: state, confidence: null, userConfirmedAt: state === 'USER_CONFIRMED' ? '2026-09-04T00:00:00.000Z' : null, sourceRef: null },
  } as unknown as ProfileFieldAuthorityV2;
}

function snapshot(referrals: unknown): CandidateProfileSnapshotV2 {
  return { schemaVersion: 2, revision: '3', deletionEpoch: '4', hasStoredProfile: true, updatedAt: null, profile: { referrals } } as unknown as CandidateProfileSnapshotV2;
}

const item = (over: Record<string, unknown> = {}) => ({
  id: '76000000-0000-4000-8000-000000000021', name: 'Dana Li', company: 'Acme', relationship: 'former manager',
  factAuthorityByField: { name: authority(), company: authority(), relationship: authority() },
  ...over,
});

describe('确认过的推荐人才投影', () => {
  it('姓名与公司都确认过 → 带出姓名与公司，不带备注', () => {
    expect(confirmedReferrals(snapshot([item()]))).toEqual([{ name: 'Dana Li', company: 'Acme' }]);
  });

  it('姓名或公司没确认 → 整条不带；备注没确认不影响', () => {
    expect(confirmedReferrals(snapshot([item({ factAuthorityByField: { name: authority('SUGGESTED'), company: authority(), relationship: authority() } })]))).toEqual([]);
    expect(confirmedReferrals(snapshot([item({ factAuthorityByField: { name: authority(), company: authority('SUGGESTED'), relationship: authority() } })]))).toEqual([]);
    expect(confirmedReferrals(snapshot([item({ factAuthorityByField: { name: authority(), company: authority(), relationship: authority('SUGGESTED') } })]))).toHaveLength(1);
  });

  it('快照里没有这一组（老后端）→ 空', () => {
    expect(confirmedReferrals(snapshot(undefined))).toEqual([]);
  });
});
