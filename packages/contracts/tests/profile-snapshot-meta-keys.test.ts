import { describe, expect, it } from 'vitest';
import { parseCandidateProfileSnapshotV2 } from '../src/profileSnapshotValidation.ts';
import { emptySnapshot } from './profile-snapshot-fixture.ts';

/**
 * 事实权威那一段的 `meta`，每一个键都必须**在场**——可空不等于可以不发。
 *
 * 2026-09-18 线上撞到的形状：argoland 的存储投影写
 * `fact.userConfirmedAt?.toISOString() as IsoDateTime | null`。`?.` 在没有值时
 * 求出的是 `undefined` 而不是 `null`，`JSON.stringify` 于是把这个键整个丢掉；
 * 那个 `as` 断言又正好把这件事对 tsc 遮住。
 *
 * 契约写的是 `userConfirmedAt: IsoDateTime | null`——必填可空。所以答复少了一个
 * 必填键，插件整份拒收，「我的资料」面板对**每一个有未确认事实的用户**都是一片空白。
 * 而未确认事实是常态：简历解析出来的每一条一开始都是 SUGGESTED。
 *
 * 这两条钉的是两个方向：null 要收得下，缺键要拒得掉。第二条是承重的那一条——
 * 它才是让下一次同样的 `?.` 在解码这一侧立刻现形的东西。
 */
describe('权威 meta 的键必须在场', () => {
  const withAuthority = () => {
    const snapshot = JSON.parse(JSON.stringify(emptySnapshot())) as {
      profile: { scalarAuthorityByPath: Record<string, unknown> };
    };
    snapshot.profile.scalarAuthorityByPath = {
      'identity.firstName': {
        factId: '11111111-1111-4111-8111-111111111111',
        factRevision: '1',
        deletionEpoch: '0',
        meta: {
          source: 'RESUME',
          authorityState: 'SUGGESTED',
          confidence: null,
          userConfirmedAt: null,
          sourceRef: {
            kind: 'RESUME_FACT',
            resumeVersionId: '22222222-2222-4222-8222-222222222222',
            parserVersion: 'resume-profile-suggestions@v1',
            factId: '33333333-3333-4333-8333-333333333333',
          },
        },
      },
    };
    return snapshot;
  };

  it('userConfirmedAt 为 null 时收得下', () => {
    expect(parseCandidateProfileSnapshotV2(withAuthority())).not.toBeNull();
  });

  it('userConfirmedAt 整个缺席时读成 null——可空等于可省', () => {
    const snapshot = withAuthority();
    const meta = (snapshot.profile.scalarAuthorityByPath['identity.firstName'] as {
      meta: Record<string, unknown>;
    }).meta;
    delete meta.userConfirmedAt;

    const parsed = parseCandidateProfileSnapshotV2(snapshot);
    expect(parsed).not.toBeNull();
    expect(parsed?.profile.scalarAuthorityByPath['identity.firstName']?.meta.userConfirmedAt).toBeNull();
  });

  it('不可空的键缺席照旧拒收——放宽的只有可空那一类', () => {
    const snapshot = withAuthority();
    const entry = snapshot.profile.scalarAuthorityByPath['identity.firstName'] as Record<string, unknown>;
    delete entry.factId;

    expect(parseCandidateProfileSnapshotV2(snapshot)).toBeNull();
  });
});
