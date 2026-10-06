import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { SEXUAL_ORIENTATION_ANSWERS } from '@edaix/apply-kernel/selfIdentificationAnswers';
import {
  createDockApplyMaterialsIntent,
  parseDockApplyMaterialsIntent,
  parseDockApplyMaterialsReply,
} from '../lib/applyMaterialsIntent';

/**
 * 面板问 worker 要简历清单的那条消息。
 *
 * 它存在的理由是一条边界：**内容脚本手上不该有 token**。所以这条消息不带任何
 * 凭据、不带任何值，只说事情发生在哪一页，worker 拿它和自己登记的 sender 比对。
 */

const PAGE = ['https://boards.greenhouse.io', '/example/jobs/1/application'] as const;

describe('这条消息只说「在哪一页」', () => {
  it('形状对就收', () => {
    const intent = createDockApplyMaterialsIntent(...PAGE);
    expect(intent).toMatchObject({ kind: 'dock/apply-materials-intent', origin: PAGE[0], pathname: PAGE[1] });
  });

  it('精确键集：多一个字段就拒', () => {
    // 多一个字段就是一种我们没约定过的形状，而这条消息会走到一次带凭据的读。
    const intent = createDockApplyMaterialsIntent(...PAGE);
    expect(parseDockApplyMaterialsIntent({ ...intent, extra: 1 })).toBeNull();
  });

  it('白标 B：可选的 vendorHint 只认厂商清单里的名字，多余的键照旧拒', () => {
    const hinted = createDockApplyMaterialsIntent(PAGE[0], PAGE[1], 'DISCOVERY_AUTHORITY', 'greenhouse');
    expect(hinted).toMatchObject({ want: 'DISCOVERY_AUTHORITY', vendorHint: 'greenhouse' });
    expect(parseDockApplyMaterialsIntent({ ...hinted, vendorHint: 'notavendor' })).toBeNull();
    expect(parseDockApplyMaterialsIntent({ ...hinted, vendorHint: 1 })).toBeNull();
    expect(parseDockApplyMaterialsIntent({ ...hinted, extra: 1 })).toBeNull();
    expect(createDockApplyMaterialsIntent(PAGE[0], PAGE[1], 'DISCOVERY_AUTHORITY')).not.toHaveProperty('vendorHint');
  });

  it('可以单独要「代不代签」（2026-10-03：填写开始那一刻现读）；不认识的 want 照旧拒', () => {
    const intent = createDockApplyMaterialsIntent(PAGE[0], PAGE[1], 'SIGN_ON_BEHALF');
    expect(intent).toMatchObject({ kind: 'dock/apply-materials-intent', want: 'SIGN_ON_BEHALF' });
    expect(parseDockApplyMaterialsIntent({ ...intent, want: 'SIGNING_CONSENT' })).toBeNull();
  });

  it('少一个字段也拒', () => {
    expect(parseDockApplyMaterialsIntent({
      kind: 'dock/apply-materials-intent', version: 1, origin: PAGE[0],
    })).toBeNull();
  });

  it('不是我们这条消息就拒——与 add-job 分开是有意的', () => {
    // 那一条是写（让岗位进目录），这一条只读。合成一条意味着一次检查决定两种
    // 互不相干的权限。
    const intent = createDockApplyMaterialsIntent(...PAGE);
    expect(parseDockApplyMaterialsIntent({ ...intent, kind: 'dock/add-job-intent' })).toBeNull();
  });

  it('页面身份判据沿用 page-ready 那一套，不另立一套', () => {
    expect(createDockApplyMaterialsIntent('not-a-url', '/x')).toBeNull();
    expect(createDockApplyMaterialsIntent(PAGE[0], 'no-leading-slash')).toBeNull();
  });
});

describe('答复的解码', () => {
  const OPTION = { resumeVersionId: 'v1', trackId: 't1', label: 'General · v2', isDefault: true };

  it('读到清单', () => {
    const reply = parseDockApplyMaterialsReply({ kind: 'RESUMES', options: [OPTION] });
    expect(reply).toEqual({ kind: 'RESUMES', options: [OPTION] });
  });

  it('空清单是一个合法答复——他确实还没有', () => {
    expect(parseDockApplyMaterialsReply({ kind: 'RESUMES', options: [] }))
      .toEqual({ kind: 'RESUMES', options: [] });
  });

  it('一条坏项让整份作废，不是悄悄丢掉那一条', () => {
    // 悄悄丢掉等于给用户看一份少了一项的清单，而他不知道少了。
    expect(parseDockApplyMaterialsReply({
      kind: 'RESUMES', options: [OPTION, { ...OPTION, isDefault: 'yes' }],
    })).toBeNull();
  });

  it('几种拒绝各自保留——它们的下一步不一样（2026-10-04 加上太慢 TIMEOUT 与资料正在保存 BUSY）', () => {
    for (const code of ['AUTH_REQUIRED', 'PAYWALL_REQUIRED', 'UNAVAILABLE', 'TIMEOUT', 'BUSY'] as const) {
      expect(parseDockApplyMaterialsReply({ kind: 'REFUSED', code })).toEqual({ kind: 'REFUSED', code });
    }
  });

  it('档案与授权答复带着会话代号（2026-10-04）：认得的形状才带，没登录是 null，别的当没带', () => {
    const stamp = 'abcdefghijklmnopqrstuv';
    expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, session: stamp })).toEqual({ kind: 'PROFILE', profile: {}, session: stamp });
    expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, session: null })).toEqual({ kind: 'PROFILE', profile: {}, session: null });
    expect(parseDockApplyMaterialsReply({ kind: 'DISCOVERY_AUTHORITY', authorization: {}, session: stamp }))
      .toEqual({ kind: 'DISCOVERY_AUTHORITY', authorization: {}, session: stamp });
    for (const bad of ['short', 'has spaces in it here!!', 7, {}]) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, session: bad }), String(bad)).toEqual({ kind: 'PROFILE', profile: {} });
    }
  });

  it('不认识的拒绝码拒收，不当成 UNAVAILABLE', () => {
    expect(parseDockApplyMaterialsReply({ kind: 'REFUSED', code: 'WHATEVER' })).toBeNull();
  });

  it('过长的标签在解码这一层截断', () => {
    // 上游已经截过，这里是第二道，不是唯一一道：一个异常长的轨道名不该把
    // 那一幕撑破。
    const reply = parseDockApplyMaterialsReply({
      kind: 'RESUMES', options: [{ ...OPTION, label: 'x'.repeat(500) }],
    });
    expect(reply?.kind === 'RESUMES' && reply.options[0]?.label.length).toBe(120);
  });

  // 结构化档案（P1-8a）：档案答复可带集合。形状由内核自己的有界读判，一条坏记录只丢那一条。
  const EDUCATION = {
    school: 'Example University', degreeLevel: 'BACHELOR', fieldOfStudy: 'Design',
    startDate: { year: 2018, month: 9 }, endDate: { year: 2022, month: 5 },
    location: null, gpa: null, gpaScale: null, isCurrent: false,
  };

  it('档案答复带了集合：按内核的有界读收下', () => {
    const reply = parseDockApplyMaterialsReply({
      kind: 'PROFILE', profile: { firstName: 'Ke' }, collections: { educations: [EDUCATION] },
    });
    expect(reply).toEqual({ kind: 'PROFILE', profile: { firstName: 'Ke' }, collections: { educations: [EDUCATION] } });
  });

  it('没带集合 → 答复里就没有这一项，不补一个空的', () => {
    const reply = parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: { firstName: 'Ke' } });
    expect(reply).toEqual({ kind: 'PROFILE', profile: { firstName: 'Ke' } });
    expect(reply !== null && 'collections' in reply).toBe(false);
  });

  it('语言（2026-10-04）按同一套有界读收下：水平不在四档里的那一条丢掉', () => {
    const reply = parseDockApplyMaterialsReply({
      kind: 'PROFILE', profile: {},
      collections: { languages: [{ language: 'English', proficiency: 'PROFESSIONAL' }, { language: 'Spanish', proficiency: 'EXPERT' }, { language: 42 }] },
    });
    expect(reply).toEqual({ kind: 'PROFILE', profile: {}, collections: { languages: [{ language: 'English', proficiency: 'PROFESSIONAL' }] } });
  });

  it('出差上限（argoland #738）只收那五档，别的当没答', () => {
    expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, travelPercentMax: 50 })).toEqual({ kind: 'PROFILE', profile: {}, travelPercentMax: 50 });
    expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, travelPercentMax: 0 })).toEqual({ kind: 'PROFILE', profile: {}, travelPercentMax: 0 });
    for (const value of [30, '50', null, true]) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, travelPercentMax: value })).toEqual({ kind: 'PROFILE', profile: {} });
    }
  });

  it('集合里一条坏记录只丢那一条；集合不是对象就当没带', () => {
    const reply = parseDockApplyMaterialsReply({
      kind: 'PROFILE', profile: {}, collections: { educations: [EDUCATION, { school: 42 }], experiences: 'nope' },
    });
    expect(reply).toEqual({ kind: 'PROFILE', profile: {}, collections: { educations: [EDUCATION] } });
    expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, collections: 'nope' }))
      .toEqual({ kind: 'PROFILE', profile: {} });
  });

  it('档案答复可带工作授权记录：三项闭集，坏记录只丢那一条', () => {
    const us = { regionCode: 'US', authorizedToWork: 'YES', requiresSponsorship: 'NO' };
    const reply = parseDockApplyMaterialsReply({
      kind: 'PROFILE', profile: {}, workAuthorizations: [us, { regionCode: 'usa', authorizedToWork: 'YES', requiresSponsorship: 'NO' }, { regionCode: 'CA', authorizedToWork: 'MAYBE', requiresSponsorship: 'NO' }],
    });
    expect(reply).toEqual({ kind: 'PROFILE', profile: {}, workAuthorizations: [us] });
    expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {} })).toEqual({ kind: 'PROFILE', profile: {} });
  });

  it('档案答复可带推荐人：只有姓名与公司，坏记录只丢那一条（P1-9）', () => {
    const reply = parseDockApplyMaterialsReply({
      kind: 'PROFILE', profile: {}, referrals: [{ name: 'Dana Li', company: 'Acme' }, { name: '', company: 'Globex' }, { name: 'X' }],
    });
    expect(reply).toEqual({ kind: 'PROFILE', profile: {}, referrals: [{ name: 'Dana Li', company: 'Acme' }] });
  });

  /**
   * 2026-10-03 前端体检 P0-1：档案答复在内容脚本里预取、留一分钟，「代不代签」跟着它走，撤回之后一分钟之内还会代签。
   * 代不代签改成填写开始那一刻单独现读（下面 SIGN_ON_BEHALF），档案答复不再带它——带了也不认。
   */
  it('档案答复不再带「用户同意过代填」：带了也不认（代不代签在填写开始那一刻现读）', () => {
    for (const value of [true, 'true', 1, false, null, {}, '2026-09-28']) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, signOnBehalf: value }), String(value))
        .toEqual({ kind: 'PROFILE', profile: {} });
    }
  });

  it('填写开始那一刻现读的代填同意：只认字面的 true，别的一律当没同意', () => {
    expect(parseDockApplyMaterialsReply({ kind: 'SIGN_ON_BEHALF', granted: true }))
      .toEqual({ kind: 'SIGN_ON_BEHALF', granted: true });
    for (const value of [false, 'true', 1, null, undefined, {}]) {
      expect(parseDockApplyMaterialsReply({ kind: 'SIGN_ON_BEHALF', granted: value }), String(value))
        .toEqual({ kind: 'SIGN_ON_BEHALF', granted: false });
    }
  });

  it('档案答复可带「请他一键同意代填授权」：只认字面的 true', () => {
    expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, signingReconsent: true }))
      .toEqual({ kind: 'PROFILE', profile: {}, signingReconsent: true });
    for (const value of ['true', 1, false, null]) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, signingReconsent: value }), String(value))
        .toEqual({ kind: 'PROFILE', profile: {} });
    }
  });

  it('档案答复可带「可以联系你现在的雇主吗」的回答（2026-09-28）：只认 YES／NO', () => {
    for (const answer of ['YES', 'NO'] as const) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, employerContact: answer }))
        .toEqual({ kind: 'PROFILE', profile: {}, employerContact: answer });
    }
    for (const value of ['yes', true, 'DECLINE', null]) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, employerContact: value }), String(value))
        .toEqual({ kind: 'PROFILE', profile: {} });
    }
  });

  it('档案答复可带「是否拉美裔」那一问的回答：闭集三个词，别的一律当没答（2026-09-23）', () => {
    for (const answer of ['YES', 'NO', 'DECLINE'] as const) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, hispanicLatino: answer }))
        .toEqual({ kind: 'PROFILE', profile: {}, hispanicLatino: answer });
    }
    for (const value of ['No', 'yes', 'MAYBE', true, null, ['NO']]) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, hispanicLatino: value }), String(value))
        .toEqual({ kind: 'PROFILE', profile: {} });
    }
  });

  it('档案答复可带「是否跨性别」与性取向的回答：各自闭集，别的一律当没答（2026-09-23）', () => {
    for (const answer of ['YES', 'NO', 'DECLINE'] as const) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, transgenderStatus: answer }))
        .toEqual({ kind: 'PROFILE', profile: {}, transgenderStatus: answer });
    }
    for (const answer of SEXUAL_ORIENTATION_ANSWERS) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, sexualOrientation: answer }))
        .toEqual({ kind: 'PROFILE', profile: {}, sexualOrientation: answer });
    }
    for (const value of ['Yes', 'gay', 'Gay', 'BISEXUAL', 'Bisexual / Pansexual', '自行描述', true, null, ['GAY']]) {
      expect(parseDockApplyMaterialsReply({ kind: 'PROFILE', profile: {}, transgenderStatus: value, sexualOrientation: value }), String(value))
        .toEqual({ kind: 'PROFILE', profile: {} });
    }
  });

  it('background：「是否拉美裔」「是否跨性别」与性取向从 EEO 码里拆出来单独带，不混进扁平档案', () => {
    const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
    expect(background).toContain('const { hispanicLatino, transgenderStatus, sexualOrientation, ...eeoCodes } = eeo ?? {};');
    expect(background).toMatch(/profile: \{[\s\S]*?\.\.\.eeoCodes,\s*\}/);
    expect(background).toContain('...(hispanicLatino === undefined ? {} : { hispanicLatino })');
    expect(background).toContain('...(transgenderStatus === undefined ? {} : { transgenderStatus })');
    expect(background).toContain('...(sexualOrientation === undefined ? {} : { sexualOrientation })');
  });

  it('不是对象、或缺 kind，一律 null', () => {
    for (const value of [null, undefined, 'RESUMES', [], { options: [] }]) {
      expect(parseDockApplyMaterialsReply(value)).toBeNull();
    }
  });
});
