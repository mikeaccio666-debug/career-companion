import type { CandidateProfileSnapshotV2, ProfileFieldAuthorityV2 } from '@edaix/contracts';
import { describe, expect, it } from 'vitest';

import { currentWorkAuthorizations } from '../src/profileV2WorkAuthorizations';

/**
 * 工作授权记录能不能替用户向雇主陈述法律资格——围栏逐字照 argoland 的答案源投影。
 */
const NOW = Date.parse('2026-09-21T12:00:00.000Z');

function authority(over: Partial<{ state: string; deletionEpoch: string; factRevision: string; userConfirmedAt: string | null }> = {}): ProfileFieldAuthorityV2 {
  const state = over.state ?? 'USER_CONFIRMED';
  return {
    factId: '76000000-0000-4000-8000-000000000002',
    factRevision: over.factRevision ?? '1',
    deletionEpoch: over.deletionEpoch ?? '4',
    meta: {
      source: 'USER',
      authorityState: state,
      confidence: null,
      userConfirmedAt: over.userConfirmedAt === undefined ? (state === 'USER_CONFIRMED' ? '2026-09-04T00:00:00.000Z' : null) : over.userConfirmedAt,
      sourceRef: null,
    },
  } as unknown as ProfileFieldAuthorityV2;
}

function record(over: Record<string, unknown> = {}, fields: Record<string, ProfileFieldAuthorityV2> = {}) {
  return {
    regionCode: 'US',
    authorizedToWork: 'YES',
    requiresSponsorship: 'NO',
    revision: '2',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    factAuthorityByField: {
      regionCode: authority(),
      authorizedToWork: authority(),
      requiresSponsorship: authority(),
      ...fields,
    },
    ...over,
  };
}

function snapshot(records: unknown[]): CandidateProfileSnapshotV2 {
  return { schemaVersion: 2, revision: '3', deletionEpoch: '4', hasStoredProfile: true, updatedAt: null, profile: { workAuthorizations: records } } as unknown as CandidateProfileSnapshotV2;
}

describe('此刻有效、用户确认过的记录才算', () => {
  it('全过：三项原样带出', () => {
    expect(currentWorkAuthorizations(snapshot([record()]), NOW)).toEqual([
      { regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' },
    ]);
  });

  it('撤销、未生效、已过期、过期不晚于生效：都不算', () => {
    expect(currentWorkAuthorizations(snapshot([record({ revokedAt: '2026-09-01T00:00:00.000Z' })]), NOW)).toEqual([]);
    expect(currentWorkAuthorizations(snapshot([record({ effectiveAt: '2026-12-01T00:00:00.000Z' })]), NOW)).toEqual([]);
    expect(currentWorkAuthorizations(snapshot([record({ expiresAt: '2026-09-01T00:00:00.000Z' })]), NOW)).toEqual([]);
    expect(currentWorkAuthorizations(snapshot([record({ effectiveAt: '2026-02-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z' })]), NOW)).toEqual([]);
  });

  it('记录版本为 0（还没确认过）不算', () => {
    expect(currentWorkAuthorizations(snapshot([record({ revision: '0' })]), NOW)).toEqual([]);
  });

  it('国家码没有用户确认过的权威 → 整条不算；某个答案没确认 → 那一个写 UNSPECIFIED', () => {
    expect(currentWorkAuthorizations(snapshot([record({}, { regionCode: authority({ state: 'SUGGESTED' }) })]), NOW)).toEqual([]);
    expect(currentWorkAuthorizations(snapshot([record({}, { requiresSponsorship: authority({ state: 'SUGGESTED' }) })]), NOW)).toEqual([
      { regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'UNSPECIFIED' },
    ]);
    expect(currentWorkAuthorizations(snapshot([record({}, { authorizedToWork: authority({ state: 'SUGGESTED' }), requiresSponsorship: authority({ state: 'SUGGESTED' }) })]), NOW)).toEqual([]);
  });

  it('权威的删除纪元与快照不一致、事实版本非正、USER_CONFIRMED 缺确认时间：都不算确认', () => {
    for (const bad of [authority({ deletionEpoch: '3' }), authority({ factRevision: '0' }), authority({ userConfirmedAt: null })]) {
      expect(currentWorkAuthorizations(snapshot([record({}, { regionCode: bad })]), NOW)).toEqual([]);
    }
  });

  it('两个答案本来就 UNSPECIFIED → 整条不带；多条记录各自过闸', () => {
    expect(currentWorkAuthorizations(snapshot([record({ authorizedToWork: 'UNSPECIFIED', requiresSponsorship: 'UNSPECIFIED' })]), NOW)).toEqual([]);
    expect(currentWorkAuthorizations(snapshot([record(), record({ regionCode: 'CA', authorizedToWork: 'NO', requiresSponsorship: 'YES' }), record({ regionCode: 'GB', revokedAt: '2026-09-01T00:00:00.000Z' })]), NOW))
      .toEqual([
        { regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' },
        { regionCode: 'CA', authorizedToWork: 'NO', requiresSponsorship: 'YES' },
      ]);
  });
});
