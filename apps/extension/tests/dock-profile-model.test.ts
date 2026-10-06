import { parseCandidateProfileV2Patch } from '@edaix/contracts';
import { describe, expect, it } from 'vitest';

import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { dirtyCount, draftFromSnapshot, patchFromDraft, validate, type ProfileDraft } from '../lib/dock/profileModel';

/**
 * 浮层里的「我的资料」存回门户（2026-09-23 负责人：资料要能直接在插件里改，改动要落到 profile 上）。
 *
 * 写法照门户（argoland `profile-v2-draft-save.ts`）：标量只发改过的路径；集合一改就整份重发——服务端
 * 按整份替换，没带上的行会被删掉，所以这里钉住「没改的行原样带上、编辑器看不到的字段从原行抄」。
 */
const snapshot = () => fictionalProfileSnapshot('Example Person')!;
const edit = (draft: ProfileDraft, patch: Partial<ProfileDraft>): ProfileDraft => ({ ...draft, ...patch });

describe('资料编辑器 → Profile V2 PATCH', () => {
  it('什么都没改：没有 PATCH，也没有未保存的项', () => {
    const base = draftFromSnapshot(snapshot());
    expect(patchFromDraft(base, base, snapshot())).toBeNull();
    expect(dirtyCount(base, base)).toBe(0);
  });

  it('只改名：只发 identity.firstName 这一条路径，带着读到的 revision 与 deletionEpoch', () => {
    const snap = snapshot();
    const base = draftFromSnapshot(snap);
    const draft = edit(base, { first: 'Sam' });
    const patch = patchFromDraft(draft, base, snap)!;
    expect(patch.fields).toEqual({ 'identity.firstName': 'Sam' });
    expect(patch.expectedRevision).toBe(snap.revision);
    expect(patch.expectedDeletionEpoch).toBe(snap.deletionEpoch);
    expect(patch.experiences, '没动经历就不重发经历').toBeUndefined();
    expect(parseCandidateProfileV2Patch(patch), '过得了契约自己的解析器').not.toBeNull();
    expect(dirtyCount(draft, base)).toBe(1);
  });

  it('电话：国际区号与号码拼成 E.164，号码里又带了一遍区号也不叠两次', () => {
    const snap = snapshot();
    const base = draftFromSnapshot(snap);
    const patch = patchFromDraft(edit(base, { phoneCc: '+1', phone: '+1 (415) 555-0100' }), base, snap)!;
    expect(patch.fields?.['contact.phone.e164']).toBe('+14155550100');
    expect(patch.fields?.['contact.phone.countryCode']).toBe('+1');
    expect(parseCandidateProfileV2Patch(patch)).not.toBeNull();
  });

  it('改一段经历：整份经历重发，已有的那行带着原来的 id，编辑器看不到的雇用类型从原行抄过去', () => {
    const snap = snapshot();
    const base = draftFromSnapshot(snap);
    const exp = base.exp.map((item) => ({ ...item, title: 'Staff designer' }));
    const patch = patchFromDraft(edit(base, { exp }), base, snap)!;
    expect(patch.experiences).toHaveLength(1);
    const row = patch.experiences![0]!;
    expect(row.id).toBe(snap.profile.experiences[0]!.id);
    expect(row.title).toBe('Staff designer');
    expect(row.employmentType).toBe('FULL_TIME');
    expect(row.isCurrent).toBe(true);
    expect(row.endDate).toBeNull();
    expect(patch.primaryCurrentExperienceId).toBe(row.id);
    expect(parseCandidateProfileV2Patch(patch)).not.toBeNull();
  });

  it('加一段教育：新行拿一个新的 id、确认全部字段；原来那段原样带上', () => {
    const snap = snapshot();
    const base = draftFromSnapshot(snap);
    const edu = [...base.edu, { id: null, school: 'Second University', degree: '硕士', major: 'HCI', gpa: '', current: false, from: '2023-09', to: '2025-06' }];
    const patch = patchFromDraft(edit(base, { edu }), base, snap)!;
    expect(patch.educations).toHaveLength(2);
    expect(patch.educations![0]!.id).toBe(snap.profile.educations[0]!.id);
    const added = patch.educations![1]!;
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(added.id).not.toBe(snap.profile.educations[0]!.id);
    expect(added.degreeLevel).toBe('MASTER');
    expect(added.confirmFields.length).toBeGreaterThan(8);
    expect(parseCandidateProfileV2Patch(patch)).not.toBeNull();
  });

  it('改一段已有的教育（例如简历导入、还没确认过的）：「在读」也一并确认——不确认，内核整条教育都不填（2026-10-03 后端体检第四节）', () => {
    const snap = snapshot();
    const base = draftFromSnapshot(snap);
    const edu = base.edu.map((item) => ({ ...item, major: 'Interaction Design' }));
    const patch = patchFromDraft(edit(base, { edu }), base, snap)!;
    const row = patch.educations![0]!;
    expect(row.id).toBe(snap.profile.educations[0]!.id);
    // 内核的投影（profileV2CollectionProjection.ts 的 projectEducation）要求 isCurrent 是确认过的当前事实，否则整条丢掉。
    expect(row.confirmFields).toContain('isCurrent');
    expect(row.confirmFields).toEqual(expect.arrayContaining(['school', 'endDate', 'expectedGraduationDate', 'startDate']));
    expect(parseCandidateProfileV2Patch(patch)).not.toBeNull();
  });

  it('教育的「在读」：草稿里读得出来；打开在读，毕业时间存进 expectedGraduationDate、endDate 为空（argoland 的保存规则，#139 内核读它）', () => {
    const snap = snapshot();
    const base = draftFromSnapshot(snap);
    expect(base.edu[0]!.current, '已毕业的那一段').toBe(false);
    expect(base.edu[0]!.to, '已毕业：结束时间就是实际毕业时间').toBe('2022-05');
    const edu = base.edu.map((item) => ({ ...item, current: true, to: '2027-05' }));
    const patch = patchFromDraft(edit(base, { edu }), base, snap)!;
    const row = patch.educations![0]!;
    expect(row.isCurrent).toBe(true);
    expect(row.endDate).toBeNull();
    expect(row.expectedGraduationDate).toEqual({ year: 2027, month: 5 });
    expect(row.confirmFields).toEqual(expect.arrayContaining(['isCurrent', 'endDate', 'expectedGraduationDate']));
    expect(dirtyCount(edit(base, { edu }), base), '在读与毕业时间各算一项').toBe(2);
    expect(parseCandidateProfileV2Patch(patch)).not.toBeNull();
  });

  it('教育的「在读」：本来在读的读回来是开着的，毕业时间取预计毕业；关掉在读，那一格存成实际毕业时间', () => {
    const raw = JSON.parse(JSON.stringify(snapshot())) as { profile: { educations: Record<string, unknown>[] } };
    Object.assign(raw.profile.educations[0]!, { isCurrent: true, endDate: null, expectedGraduationDate: { year: 2027, month: 5 } });
    const snap = raw as unknown as ReturnType<typeof snapshot>;
    const base = draftFromSnapshot(snap);
    expect(base.edu[0]!.current).toBe(true);
    expect(base.edu[0]!.to).toBe('2027-05');
    const edu = base.edu.map((item) => ({ ...item, current: false, to: '2026-12' }));
    const row = patchFromDraft(edit(base, { edu }), base, snap)!.educations![0]!;
    expect(row.isCurrent).toBe(false);
    expect(row.endDate).toEqual({ year: 2026, month: 12 });
    expect(row.expectedGraduationDate).toBeNull();
    expect(row.confirmFields).toContain('isCurrent');
  });

  it('删掉一段经历：整份重发时它就不在里面（服务端按整份替换）', () => {
    const snap = snapshot();
    const base = draftFromSnapshot(snap);
    const patch = patchFromDraft(edit(base, { exp: [] }), base, snap)!;
    expect(patch.experiences).toEqual([]);
    expect(patch.primaryCurrentExperienceId).toBeNull();
  });

  it('链接：补上协议；没管的那几种链接原样带上、不确认', () => {
    const snap = snapshot();
    const base = draftFromSnapshot(snap);
    const patch = patchFromDraft(edit(base, { linkedin: 'linkedin.com/in/example-person' }), base, snap)!;
    expect(patch.links).toHaveLength(1);
    expect(patch.links![0]!.url).toBe('https://linkedin.com/in/example-person');
    expect(patch.primaryLinkIdByKind?.LINKEDIN).toBe(patch.links![0]!.id);
    expect(parseCandidateProfileV2Patch(patch)).not.toBeNull();
  });

  it('工作许可只管美国那一条；是非题答成 YES / NO', () => {
    const snap = snapshot();
    const base = draftFromSnapshot(snap);
    const patch = patchFromDraft(edit(base, { workAuth: 'yes', sponsor: 'no' }), base, snap)!;
    expect(patch.workAuthorizations).toEqual([
      expect.objectContaining({ regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' }),
    ]);
    expect(parseCandidateProfileV2Patch(patch)).not.toBeNull();
  });

  it('校验：名、姓、邮箱、电话、薪资都说具体是哪一项', () => {
    const base = draftFromSnapshot(snapshot());
    const errors = validate(edit(base, { first: ' ', last: '', email: 'not-an-email', phone: '123', salary: '17万' }));
    expect(errors).toMatchObject({
      first: '请填写名。', last: '请填写姓。', email: '邮箱格式不对，请检查一下。',
      phone: '电话号码看起来不完整。', salary: '只填数字，例如 170000。',
    });
  });
});
