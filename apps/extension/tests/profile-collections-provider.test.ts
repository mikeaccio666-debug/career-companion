import { describe, expect, it, vi } from 'vitest';
import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { createProfileCollectionsProvider } from '../lib/profileCollectionsProvider';

/**
 * worker 侧：用户自己的 Profile V2 → 内核按行取值的集合（P1-8a）。
 *
 * 钉四件事：确认过的教育 / 经历投影成内核形状；没确认过的那一段不进表单；
 * 读不到（未登录 / 传输 / 形状）→ null 并只记稳定原因码；档案还没建 → 空集合而不是故障。
 */

const USER = '76000000-0000-4000-8000-000000000001';

function snapshotJson(mutate: (snapshot: Record<string, any>) => void = () => {}): string {
  const parsed = fictionalProfileSnapshot('Ke Chen');
  if (parsed === null) throw new Error('fixture does not parse');
  const clone = JSON.parse(JSON.stringify(parsed)) as Record<string, any>;
  mutate(clone);
  return JSON.stringify(clone);
}

function harness(over: { run?: () => Promise<unknown>; userId?: string | null } = {}) {
  const diagnostics: string[] = [];
  const run = vi.fn(over.run ?? (async () => ({ ok: true, text: snapshotJson() })));
  const provider = createProfileCollectionsProvider({
    directory: { run: run as never },
    getUserId: async () => (over.userId === undefined ? USER : over.userId),
    onDiagnostic: (code) => { diagnostics.push(code); },
  });
  return { provider, run, diagnostics };
}

describe('确认过的分段内容投影成内核的集合', () => {
  it('教育与经历各一段，形状是内核的 ApplyProfileCollections', async () => {
    const { provider, run, diagnostics } = harness();
    const facts = await provider.read();
    expect(run).toHaveBeenCalledWith('PROFILE_V2_READ');
    expect(facts?.workAuthorizations).toEqual([]);
    expect(facts?.referrals).toEqual([]);
    expect(facts?.collections).toMatchObject({
      experiences: [{ company: 'Example Company', title: 'Product designer', isCurrent: true, startDate: { year: 2022, month: 6 }, endDate: null }],
      educations: [{ school: 'Example University', degreeLevel: 'BACHELOR', fieldOfStudy: 'Design', startDate: { year: 2018, month: 9 }, endDate: { year: 2022, month: 5 }, isCurrent: false }],
    });
    expect(diagnostics).toEqual([]);
  });

  it('确认过的语言随同一次读带出（2026-10-04：内核拿它答语言题）；水平没确认的那一条不带', async () => {
    const languageAuthority = (state: 'USER_CONFIRMED' | 'SUGGESTED', index: number) => ({
      factId: `71000000-0000-4000-8000-${String(index).padStart(12, '0')}`, factRevision: '1', deletionEpoch: '0',
      meta: state === 'USER_CONFIRMED'
        ? { source: 'USER', authorityState: 'USER_CONFIRMED', confidence: null, userConfirmedAt: '2026-09-13T00:00:00.000Z', sourceRef: null }
        : { source: 'USER', authorityState: 'SUGGESTED', confidence: null, userConfirmedAt: null, sourceRef: null },
    });
    const { provider } = harness({
      run: async () => ({
        ok: true,
        text: snapshotJson((s) => {
          s.profile.languages = [
            { id: '52000000-0000-4000-8000-000000000001', language: 'English', proficiency: 'PROFESSIONAL',
              factAuthorityByField: { language: languageAuthority('USER_CONFIRMED', 1), proficiency: languageAuthority('USER_CONFIRMED', 2) } },
            { id: '52000000-0000-4000-8000-000000000002', language: 'Spanish', proficiency: 'CONVERSATIONAL',
              factAuthorityByField: { language: languageAuthority('USER_CONFIRMED', 3), proficiency: languageAuthority('SUGGESTED', 4) } },
          ];
        }),
      }),
    });
    const facts = await provider.read();
    expect(facts?.collections.languages).toEqual([{ language: 'English', proficiency: 'PROFESSIONAL' }]);
  });

  it('确认过的出差上限随同一次读带出（argoland #738）；没答、没确认 → null', async () => {
    const authority = (state: 'USER_CONFIRMED' | 'SUGGESTED') => ({
      factId: '72000000-0000-4000-8000-000000000001', factRevision: '1', deletionEpoch: '0',
      meta: state === 'USER_CONFIRMED'
        ? { source: 'USER', authorityState: 'USER_CONFIRMED', confidence: null, userConfirmedAt: '2026-10-04T00:00:00.000Z', sourceRef: null }
        : { source: 'USER', authorityState: 'SUGGESTED', confidence: null, userConfirmedAt: null, sourceRef: null },
    });
    const read = async (value: number | null, state: 'USER_CONFIRMED' | 'SUGGESTED') => {
      const { provider } = harness({
        run: async () => ({
          ok: true,
          text: snapshotJson((s) => {
            s.profile.preferences = { workModes: null, openToRelocation: null, openToRelocationCities: null, contactCurrentEmployer: null, travelPercentMax: value };
            if (value !== null) s.profile.scalarAuthorityByPath['preferences.travelPercentMax'] = authority(state);
          }),
        }),
      });
      return (await provider.read())?.travelPercentMax;
    };
    expect(await read(25, 'USER_CONFIRMED')).toBe(25);
    expect(await read(25, 'SUGGESTED')).toBeNull();
    expect(await read(null, 'USER_CONFIRMED')).toBeNull();
  });

  it('没确认过的那一段不投影：进表单的必须是他自己点过头的', async () => {
    const { provider } = harness({
      run: async () => ({
        ok: true,
        text: snapshotJson((s) => {
          const company = s.profile.experiences[0].factAuthorityByField.company;
          company.meta.authorityState = 'SUGGESTED';
          company.meta.userConfirmedAt = null;
        }),
      }),
    });
    const facts = await provider.read();
    expect(facts?.collections.experiences ?? []).toEqual([]);
    expect(facts?.collections.educations).toHaveLength(1);
  });

  it('档案还没建 → 空集合，不是故障、不记诊断', async () => {
    const { provider, diagnostics } = harness({
      run: async () => ({
        ok: true,
        text: snapshotJson((s) => { s.hasStoredProfile = false; s.revision = '0'; s.profile.experiences = []; s.profile.educations = []; }),
      }),
    });
    expect(await provider.read()).toEqual({ collections: {}, workAuthorizations: [], referrals: [], employerContact: null, travelPercentMax: null });
    expect(diagnostics).toEqual([]);
  });

  it('此刻有效、确认过的工作授权记录随同一次读带出；撤销的不带', async () => {
    const authority = { factId: '70000000-0000-4000-8000-000000000009', factRevision: '1', deletionEpoch: '0',
      meta: { source: 'USER', authorityState: 'USER_CONFIRMED', confidence: null, userConfirmedAt: '2026-09-13T00:00:00.000Z', sourceRef: null } };
    const record = (regionCode: string, revokedAt: string | null) => ({
      regionCode, authorizedToWork: 'YES', requiresSponsorship: 'NO', revision: '1',
      effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: null, revokedAt,
      factAuthorityByField: { regionCode: authority, authorizedToWork: authority, requiresSponsorship: authority },
    });
    const { provider } = harness({
      run: async () => ({ ok: true, text: snapshotJson((s) => { s.profile.workAuthorizations = [record('US', null), record('CA', '2026-09-01T00:00:00.000Z')]; }) }),
    });
    expect((await provider.read())?.workAuthorizations).toEqual([{ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }]);
  });

  it('用户亲手存、确认过的推荐人随同一次读带出；没确认的不带（P1-9）', async () => {
    const authority = (state = 'USER_CONFIRMED') => ({ factId: '70000000-0000-4000-8000-000000000008', factRevision: '1', deletionEpoch: '0',
      meta: { source: 'USER', authorityState: state, confidence: null, userConfirmedAt: state === 'USER_CONFIRMED' ? '2026-09-13T00:00:00.000Z' : null, sourceRef: null } });
    const { provider } = harness({
      run: async () => ({ ok: true, text: snapshotJson((s) => {
        s.profile.referrals = [
          { id: '80000000-0000-4000-8000-000000000001', name: 'Dana Li', company: 'Acme', relationship: null, factAuthorityByField: { name: authority(), company: authority(), relationship: authority() } },
          { id: '80000000-0000-4000-8000-000000000002', name: 'Sam Wu', company: 'Globex', relationship: null, factAuthorityByField: { name: authority('SUGGESTED'), company: authority(), relationship: authority() } },
        ];
      }) }),
    });
    expect((await provider.read())?.referrals).toEqual([{ name: 'Dana Li', company: 'Acme' }]);
  });
});

describe('资料里对「可以联系你现在的雇主吗」的回答（2026-09-28）', () => {
  const authority = (state = 'USER_CONFIRMED') => ({ factId: '70000000-0000-4000-8000-000000000007', factRevision: '1', deletionEpoch: '0',
    meta: { source: 'USER', authorityState: state, confidence: null, userConfirmedAt: state === 'USER_CONFIRMED' ? '2026-09-28T00:00:00.000Z' : null, sourceRef: null } });
  const withAnswer = (value: boolean | null, state = 'USER_CONFIRMED') => harness({
    run: async () => ({ ok: true, text: snapshotJson((s) => {
      s.profile.preferences = { ...(s.profile.preferences ?? {}), contactCurrentEmployer: value };
      s.profile.scalarAuthorityByPath = { ...s.profile.scalarAuthorityByPath, 'preferences.contactCurrentEmployer': authority(state) };
    }) }),
  });

  it('确认过的「不可以」随同一次读带出', async () => {
    expect((await withAnswer(false).provider.read())?.employerContact).toBe('NO');
    expect((await withAnswer(true).provider.read())?.employerContact).toBe('YES');
  });

  it('没答、没确认 → null（交还本人）', async () => {
    expect((await withAnswer(null).provider.read())?.employerContact).toBeNull();
    expect((await withAnswer(true, 'SUGGESTED').provider.read())?.employerContact).toBeNull();
  });

  it('老服务端不发这一项 → null，快照照样解得开', async () => {
    const facts = await harness({ run: async () => ({ ok: true, text: snapshotJson((s) => { delete s.profile.preferences?.contactCurrentEmployer; }) }) }).provider.read();
    expect(facts?.employerContact).toBeNull();
    expect(facts?.collections.experiences).toHaveLength(1);
  });
});

/**
 * 后端先发的加法（2026-09-28）：事实权威元数据里这一版不认识的来源或确认状态。从前整份快照判坏、
 * 所有集合一起读不出；现在整份照读，带陌生元数据的那一段**不算确认过**、不进表单，记一个码（只有码）。
 */
describe('事实权威元数据里的陌生值', () => {
  it('那一段不投影、别的照常，记 PROFILE_V2_UNRECOGNIZED_AUTHORITY_IGNORED', async () => {
    const { provider, diagnostics } = harness({
      run: async () => ({
        ok: true,
        text: snapshotJson((s) => {
          const company = s.profile.experiences[0].factAuthorityByField.company;
          company.meta.source = 'LINKEDIN_IMPORT';
        }),
      }),
    });
    const facts = await provider.read();
    expect(facts).not.toBeNull();
    expect(facts?.collections.experiences ?? []).toEqual([]);
    expect(facts?.collections.educations).toHaveLength(1);
    expect(diagnostics).toEqual(['PROFILE_V2_UNRECOGNIZED_AUTHORITY_IGNORED']);
  });
});

describe('读不到 → null，只记稳定原因码', () => {
  it('未登录：不发请求', async () => {
    const { provider, run, diagnostics } = harness({ userId: null });
    expect(await provider.read()).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(['PROFILE_COLLECTIONS_AUTH_UNAVAILABLE']);
  });

  it('传输层拒绝：登录态过期记 AUTH，其余记 FETCH_FAILED', async () => {
    const expired = harness({ run: async () => ({ ok: false, code: 'LOGIN_REQUIRED' }) });
    expect(await expired.provider.read()).toBeNull();
    expect(expired.diagnostics).toEqual(['PROFILE_COLLECTIONS_AUTH_UNAVAILABLE']);
    const down = harness({ run: async () => ({ ok: false, code: 'UNAVAILABLE' }) });
    expect(await down.provider.read()).toBeNull();
    expect(down.diagnostics).toEqual(['PROFILE_COLLECTIONS_FETCH_FAILED']);
    const threw = harness({ run: async () => { throw new Error('boom'); } });
    expect(await threw.provider.read()).toBeNull();
    expect(threw.diagnostics).toEqual(['PROFILE_COLLECTIONS_FETCH_FAILED']);
  });

  it('答复不是合法快照：整份丢弃', async () => {
    for (const text of ['not json', '{"schemaVersion":1}', JSON.stringify({ schemaVersion: 2, revision: '1' })]) {
      const { provider, diagnostics } = harness({ run: async () => ({ ok: true, text }) });
      expect(await provider.read()).toBeNull();
      expect(diagnostics).toEqual(['PROFILE_COLLECTIONS_RESPONSE_MALFORMED']);
    }
  });

  it('user id 不是 UUID：当未登录处理', async () => {
    const { provider, run } = harness({ userId: 'not-a-uuid' });
    expect(await provider.read()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
