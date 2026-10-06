import { describe, expect, it } from 'vitest';

import { fictionalProfileSnapshot } from '../assistant/testing/profile-snapshot';
import { mergeDrafts } from '../lib/dock/profileMerge';
import { draftFromSnapshot, type EduDraft, type ExpDraft, type ProfileDraft } from '../lib/dock/profileModel';

/**
 * 资料编辑器保存时撞上「别处刚存过」（412，2026-10-03 前端体检 3.4）：从前整份重读、丢掉他手上的修改。现在三方合并——
 * 读到的那一份（base）、他手上的（mine）、此刻服务器上的（theirs）——逐项合：只有同一项两边都改了、改得不一样，才请他选。
 */
const base = (): ProfileDraft => draftFromSnapshot(fictionalProfileSnapshot('Example Person')!);
const exp = (patch: Partial<ExpDraft> = {}): ExpDraft => ({
  id: '50000000-0000-4000-8000-000000000001', title: 'Product designer', company: 'Example Company', loc: '',
  current: true, from: '2022-06', to: '', desc: '虚构经历 · Fictional experience', ...patch,
});
const edu = (patch: Partial<EduDraft> = {}): EduDraft => ({
  id: '60000000-0000-4000-8000-000000000001', school: 'Example University', degree: '学士', major: 'Design', gpa: '',
  current: false, from: '2018-09', to: '2022-05', ...patch,
});

describe('三方合并：只有同一项两边改得不一样才算冲突', () => {
  it('他改了名、别处改了电话：两样都留下，没有冲突', () => {
    const b = base();
    const { merged, conflicts } = mergeDrafts(b, { ...b, first: 'Sam' }, { ...b, phone: '415 555 0199' });
    expect(conflicts).toEqual([]);
    expect(merged.first).toBe('Sam');
    expect(merged.phone).toBe('415 555 0199');
  });

  it('同一项两边改成一样的：不是冲突', () => {
    const b = base();
    const { conflicts, merged } = mergeDrafts(b, { ...b, city: 'Oakland' }, { ...b, city: 'Oakland' });
    expect(conflicts).toEqual([]);
    expect(merged.city).toBe('Oakland');
  });

  it('同一项两边改得不一样：一个冲突；合出来的先留他的，选「别处的」就换成别处的', () => {
    const b = base();
    const { merged, conflicts } = mergeDrafts(b, { ...b, city: 'Oakland', first: 'Sam' }, { ...b, city: 'Berkeley' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ key: 'city', mine: 'Oakland', theirs: 'Berkeley' });
    expect(merged.city).toBe('Oakland');
    expect(merged.first, '不冲突的照样合进来').toBe('Sam');
    expect(conflicts[0]!.useTheirs(merged).city).toBe('Berkeley');
  });

  it('电话的区号与号码是一项：他改号码、别处改区号也算同一项', () => {
    const b = base();
    const { conflicts } = mergeDrafts(b, { ...b, phone: '415 555 0100' }, { ...b, phoneCc: '+86', phone: '138 0000 0000' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.key).toBe('phone');
    expect(conflicts[0]!.useTheirs({ ...b, phone: '415 555 0100' })).toMatchObject({ phoneCc: '+86', phone: '138 0000 0000' });
  });

  it('技能、城市这类集合按条合：他加的、别处加的都留下，他删的就删掉', () => {
    const b = { ...base(), skills: ['Figma', 'Sketch'] };
    const { merged, conflicts } = mergeDrafts(b, { ...b, skills: ['Figma', 'Prototyping'] }, { ...b, skills: ['Figma', 'Sketch', 'User research'] });
    expect(conflicts).toEqual([]);
    expect(merged.skills).toEqual(['Figma', 'User research', 'Prototyping']);
  });

  it('语言按语种合：同一种语言两边改了不同的熟练程度才冲突', () => {
    const b = { ...base(), langs: ['English · 流利', '日本語 · 基础'] };
    const { merged, conflicts } = mergeDrafts(
      b,
      { ...b, langs: ['English · 母语', '日本語 · 基础', 'Español · 基础'] },
      { ...b, langs: ['English · 日常交流', '日本語 · 流利'] },
    );
    expect(merged.langs).toEqual(['English · 母语', '日本語 · 流利', 'Español · 基础']);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ key: 'langs', lang: 'English', mine: 'English · 母语', theirs: 'English · 日常交流' });
    expect(conflicts[0]!.useTheirs(merged).langs).toEqual(['English · 日常交流', '日本語 · 流利', 'Español · 基础']);
  });

  it('经历按 id 逐栏合：他改职位、别处改公司，两样都留下；他新加的那一段接在后面', () => {
    const b = { ...base(), exp: [exp()] };
    const added = exp({ id: null, title: 'Intern', company: 'Startup', current: false, from: '2021-06', to: '2021-09', desc: '' });
    const { merged, conflicts } = mergeDrafts(
      b,
      { ...b, exp: [exp({ title: 'Staff designer' }), added] },
      { ...b, exp: [exp({ company: 'Example Company Inc.' })] },
    );
    expect(conflicts).toEqual([]);
    expect(merged.exp).toEqual([exp({ title: 'Staff designer', company: 'Example Company Inc.' }), added]);
  });

  it('同一段经历的同一栏两边改得不一样：冲突带着是哪一段、哪一栏', () => {
    const b = { ...base(), exp: [exp()] };
    const { merged, conflicts } = mergeDrafts(b, { ...b, exp: [exp({ title: 'Staff designer' })] }, { ...b, exp: [exp({ title: 'Lead designer' })] });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ key: 'exp', field: 'title', mine: 'Staff designer', theirs: 'Lead designer' });
    expect(conflicts[0]!.entry?.id).toBe('50000000-0000-4000-8000-000000000001');
    expect(merged.exp[0]!.title).toBe('Staff designer');
    expect(conflicts[0]!.useTheirs(merged).exp[0]!.title).toBe('Lead designer');
  });

  it('他删了一段、别处改过那一段：冲突（默认照他删；选「别处的」就留下别处改过的）', () => {
    const b = { ...base(), edu: [edu()] };
    const { merged, conflicts } = mergeDrafts(b, { ...b, edu: [] }, { ...b, edu: [edu({ major: 'HCI' })] });
    expect(merged.edu).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ key: 'edu', mine: null });
    expect(conflicts[0]!.field, '整段的冲突，不是某一栏').toBeUndefined();
    expect(conflicts[0]!.useTheirs(merged).edu).toEqual([edu({ major: 'HCI' })]);
  });

  it('他删了一段、别处没动它：照删，没有冲突；别处删了、他没动：也删', () => {
    const b = { ...base(), edu: [edu()], exp: [exp()] };
    const { merged, conflicts } = mergeDrafts(b, { ...b, edu: [] }, { ...b, exp: [] });
    expect(conflicts).toEqual([]);
    expect(merged.edu).toEqual([]);
    expect(merged.exp).toEqual([]);
  });

  it('别处删了一段、他改过那一段：冲突（默认留下他的；选「别处的」就删掉）', () => {
    const b = { ...base(), exp: [exp()] };
    const { merged, conflicts } = mergeDrafts(b, { ...b, exp: [exp({ title: 'Staff designer' })] }, { ...b, exp: [] });
    expect(merged.exp).toEqual([exp({ title: 'Staff designer' })]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.theirs).toBeNull();
    expect(conflicts[0]!.useTheirs(merged).exp).toEqual([]);
  });

  it('他什么都没改：合出来的就是别处那一份', () => {
    const b = base();
    const theirs = { ...b, first: 'Alex', skills: ['Go'], exp: [] };
    expect(mergeDrafts(b, b, theirs)).toEqual({ merged: theirs, conflicts: [] });
  });

  it('不在资料里的那几样（自我认同、代填授权、默认简历）也逐项合', () => {
    const b = { ...base(), gender: '', consent: false, resume: 'track-a', race: ['Asian'] };
    const { merged, conflicts } = mergeDrafts(
      b,
      { ...b, gender: 'Woman', race: ['Asian', 'White'] },
      { ...b, consent: true, resume: 'track-b' },
    );
    expect(conflicts).toEqual([]);
    expect(merged).toMatchObject({ gender: 'Woman', consent: true, resume: 'track-b', race: ['Asian', 'White'] });
  });
});
