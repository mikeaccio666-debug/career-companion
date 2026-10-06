import { describe, expect, it } from 'vitest';
import { parseCandidateProfileSnapshotV2 } from '../src/profileSnapshotValidation';
import { emptySnapshot } from './profile-snapshot-fixture';
describe('Profile V2 owner snapshot boundary', () => {
  it('accepts the server empty snapshot and rejects missing and malformed known fields', () => {
    expect(parseCandidateProfileSnapshotV2(emptySnapshot())).not.toBeNull();
    // 可空字段省略 = null（见 profileSnapshotValidation 里 `nullable` 的头注：
    // 服务端只要有一处写了 `x?.toISOString()`，发出来就是「这个键不存在」）。
    {
      const s = emptySnapshot() as any;
      delete s.profile.identity.firstName;
      expect(parseCandidateProfileSnapshotV2(s)).not.toBeNull();
    }
    for (const change of [ (s: any) => { delete s.profile.identity; },
      (s: any) => { s.profile.address.countryCode = 'ZZ'; },
      (s: any) => { s.profile.availability.noticePeriodDays = 366; },
      (s: any) => { s.profile.links = Array(1); },
      (s: any) => { s.profile.links.extra = 'hidden'; },
      (s: any) => { s.profile.links = Array(1000).fill(null); },
      (s: any) => { s.profile.primaryCurrentExperienceId = '10000000-0000-4000-8000-000000000001'; },
      (s: any) => { s.profile.scalarAuthorityByPath['summary'] = { source: 'USER' }; },
      (s: any) => { s.revision = '-1'; },
    ]) { const snapshot = emptySnapshot(); change(snapshot); expect(parseCandidateProfileSnapshotV2(snapshot)).toBeNull(); }
  });
  // 2026-10-04（argoland #738）「出差最多能接受多少？」：五档照收；旧服务端不发这一项读成 null（没答）；
  // 不在五档里的值与别的已知字段一样整份拒收（服务端的 PATCH 校验只收这五档）。
  it('reads the travel limit, treats a server without it as not answered, and refuses a value outside the five steps', () => {
    const withTravel = (value: unknown) => {
      const s = emptySnapshot() as any;
      s.profile.preferences.travelPercentMax = value;
      return parseCandidateProfileSnapshotV2(s);
    };
    for (const value of [0, 25, 50, 75, 100, null]) expect(withTravel(value)?.profile.preferences.travelPercentMax).toBe(value);
    expect(parseCandidateProfileSnapshotV2(emptySnapshot())?.profile.preferences.travelPercentMax).toBeNull();
    const oldServer = emptySnapshot() as any;
    oldServer.profile.preferences = null;
    expect(parseCandidateProfileSnapshotV2(oldServer)?.profile.preferences.travelPercentMax).toBeNull();
    for (const value of [30, '25', true, -25]) expect(withTravel(value)).toBeNull();
  });
  it('does not execute accessor payloads', () => {
    const s = emptySnapshot(); let reads = 0;
    Object.defineProperty(s.profile.identity, 'firstName', { get() { reads++; return 'fictional'; } });
    expect(parseCandidateProfileSnapshotV2(s)).toBeNull(); expect(reads).toBe(0);
  });
});

it('projects known read fields while tolerating additive API fields at every object level', () => {
  const expected = emptySnapshot(), s: any = structuredClone(expected);
  s.futureField = { private: 'discard' };
  s.profile.futureCollection = ['discard'];
  s.profile.contact.accessToken = 'discard';
  s.profile.identity.futureField = 'discard';
  s.profile.scalarAuthorityByPath.futureFact = { private: 'discard' };
  let reads = 0;
  Object.defineProperty(s.profile.identity, 'futureAccessor', { get() { reads++; throw new Error('DO_NOT_READ'); } });
  expect(parseCandidateProfileSnapshotV2(s)).toEqual(expected);
  expect(reads).toBe(0);
});

it('drops links of a kind this version does not know instead of rejecting the snapshot', () => {
  // 后端加一种链接会同时到达所有旧版插件；旧版把它整份拒收就是资料面板空白。
  // （TWITTER 自 argoland #535 起已认得，这里用一个还不认得的种类。）
  const known = {
    id: '20000000-0000-4000-8000-000000000001', kind: 'LINKEDIN', label: null, url: 'https://www.linkedin.com/in/x',
    factAuthorityByField: { kind: authority(), label: authority(), url: authority() },
  };
  const foreign = { ...known, id: '20000000-0000-4000-8000-000000000002', kind: 'MASTODON', url: 'https://mastodon.example/@x' };
  const s: any = emptySnapshot();
  s.profile.links = [known, foreign];
  s.profile.primaryLinkIdByKind.MASTODON = foreign.id;
  const parsed = parseCandidateProfileSnapshotV2(s);
  expect(parsed).not.toBeNull();
  expect(parsed!.profile.links.map((link) => link.kind)).toEqual(['LINKEDIN']);
  expect('MASTODON' in parsed!.profile.primaryLinkIdByKind).toBe(false);
  // 种类名不像枚举（小写、带空格）仍然整份拒收——那不是「未来的种类」，是坏数据。
  for (const kind of ['twitter', 'X Profile', '']) {
    const bad: any = emptySnapshot();
    bad.profile.links = [{ ...foreign, kind }];
    expect(parseCandidateProfileSnapshotV2(bad)).toBeNull();
  }
});

function authority() {
  return {
    factId: '30000000-0000-4000-8000-000000000001', factRevision: '1', deletionEpoch: '0',
    meta: { source: 'USER', authorityState: 'USER_CONFIRMED', confidence: null, userConfirmedAt: null, sourceRef: null },
  };
}

it('tolerates a snapshot without referrals (older backend) and reads them when present', () => {
  // 推荐人集合是 P1-9 加的：argoland 加上它之前的服务端不发这一组，旧形状不该把整份快照判 malformed。
  const without: any = emptySnapshot();
  delete without.profile.referrals;
  const parsed = parseCandidateProfileSnapshotV2(without);
  expect(parsed).not.toBeNull();
  expect(parsed!.profile.referrals).toEqual([]);

  const withOne: any = emptySnapshot();
  withOne.profile.referrals = [{
    id: '40000000-0000-4000-8000-000000000001', name: 'Dana Li', company: 'Acme', relationship: 'former manager',
    factAuthorityByField: { name: authority(), company: authority(), relationship: authority() },
  }];
  expect(parseCandidateProfileSnapshotV2(withOne)!.profile.referrals).toEqual([expect.objectContaining({ name: 'Dana Li', company: 'Acme' })]);

  for (const change of [
    (s: any) => { s.profile.referrals = [{ ...withOne.profile.referrals[0], name: '' }]; },
    (s: any) => { s.profile.referrals = [{ ...withOne.profile.referrals[0], factAuthorityByField: { name: authority() } }]; },
    (s: any) => { s.profile.referrals = 'Dana'; },
  ]) { const bad: any = emptySnapshot(); change(bad); expect(parseCandidateProfileSnapshotV2(bad)).toBeNull(); }
});

it('reads skill names up to the contract bound (120), not the old 80', () => {
  // argoland 5afed00f（2026-09-18）把技能名上限从 80 提到 120（简历导入写得出更长的技能行），契约常量随后同步到这边，
  // 这份校验却一直写死 80：档案里有一条 81–120 字的技能，整份快照判 malformed——「我的资料」只显示「暂时读不到你的资料」，
  // 填写时经历与教育也一起读不出来（负责人 2026-09-27 在商店包上遇到）。上限跟着契约常量走。
  const skill = (name: string) => ({
    id: '50000000-0000-4000-8000-000000000001', name, categories: [],
    factAuthorityByField: { name: authority(), categories: authority() },
  });
  const at = (length: number): any => {
    const s: any = emptySnapshot();
    s.profile.skills = [skill('x'.repeat(length))];
    return s;
  };
  expect(parseCandidateProfileSnapshotV2(at(81))).not.toBeNull();
  expect(parseCandidateProfileSnapshotV2(at(120))!.profile.skills[0]!.name).toHaveLength(120);
  expect(parseCandidateProfileSnapshotV2(at(121))).toBeNull();
});

/**
 * 事实权威的元数据用了这一版不认识的值（2026-09-28）。
 *
 * `meta.source` / `meta.authorityState` / `sourceRef.kind` 挂在**每一条**事实上：后端加一种来源
 * （比如一条新的导入渠道）或一种确认状态，旧包对任何一条带它的事实都整份判 malformed——
 * 「我的资料」空白，填写时经历、教育、技能、工作授权、推荐人一起读不出来。
 *
 * 读法：原值留着（`sourceRef` 只留 `kind`），不解释。消费端只拿已知值逐一比对（内核投影与工作
 * 授权都只认确认闭集），陌生值对不上任何一种，于是这条事实**不算已确认**：页面上照常显示，
 * 但不会被当成用户确认过的事实替他填进申请表。元数据不随保存发回去（保存只带 confirmFields），
 * 所以原值不会被改写。
 */
it('reads authority metadata of a kind this version does not know as opaque values instead of rejecting the snapshot', () => {
  const future = {
    factId: '30000000-0000-4000-8000-000000000002', factRevision: '3', deletionEpoch: '0',
    meta: {
      source: 'LINKEDIN_IMPORT', authorityState: 'IMPORT_CONFIRMED', confidence: 0.9, userConfirmedAt: null,
      sourceRef: { kind: 'LINKEDIN_PROFILE', importId: 'imp_123', fetchedAt: '2026-09-27T10:00:00.000Z' },
    },
  };
  const s: any = emptySnapshot();
  s.profile.referrals = [{
    id: '40000000-0000-4000-8000-000000000001', name: 'Dana Li', company: 'Acme', relationship: null,
    factAuthorityByField: { name: future, company: authority(), relationship: authority() },
  }];
  const parsed = parseCandidateProfileSnapshotV2(s);
  expect(parsed).not.toBeNull();
  const meta = parsed!.profile.referrals[0]!.factAuthorityByField.name.meta;
  expect(meta.source).toBe('LINKEDIN_IMPORT');
  expect(meta.authorityState).toBe('IMPORT_CONFIRMED');
  // 陌生来源种类只留 kind：别的成员这一版不认识，不读、不转发。
  expect(meta.sourceRef).toEqual({ kind: 'LINKEDIN_PROFILE' });

  // 不像枚举的值不是「未来的种类」，是坏数据：照旧整份拒收。
  for (const change of [
    (m: any) => { m.source = 'linkedin'; },
    (m: any) => { m.authorityState = ''; },
    (m: any) => { m.sourceRef = { kind: 'bad kind' }; },
    (m: any) => { m.sourceRef = { importId: 'imp_123' }; },
    // 认得的来源种类照旧逐字段校验，不因为「有陌生种类的退路」就放宽。
    (m: any) => { m.sourceRef = { kind: 'RESUME_FACT', resumeVersionId: 'not-a-uuid', parserVersion: 'p1', factId: 'x' }; },
  ]) {
    const bad: any = structuredClone(s);
    change(bad.profile.referrals[0].factAuthorityByField.name.meta);
    expect(parseCandidateProfileSnapshotV2(bad)).toBeNull();
  }
});
