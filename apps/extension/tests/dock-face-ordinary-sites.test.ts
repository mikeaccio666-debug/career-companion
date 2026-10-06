import { afterEach, describe, expect, it } from 'vitest';

import { APPLY_RULES_RUNTIME_RELEASE_V1 } from '../../../packages/apply-rules/runtime-release';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { installApplyAdapters } from '@edaix/apply-kernel/registry';
import { applyAdaptersFromRuntimeRegistry, createRuntimeApplyRegistry } from '@edaix/apply-kernel/runtimeRegistry';
import { dockFaceForPage, jobLikeUrl } from '../lib/autofillDockDecision';
import { createDockAutoOpen, isFillableFace } from '../lib/dockAutoOpen';

/**
 * 普通网站上什么都不挂（2026-09-24，商店包开全网）。
 *
 * 通用路（2026-09-22）让「主机表与指纹都答不出」的页面也去问一句，而那一问只看 URL——通用规则的
 * `isApplyPath` 对任何路径都答是，真正的闸在填写时数字段。于是每一个 https 页面都拿到了「能填」的脸；
 * 再加上能填的脸自动打开（#99），测试台上维基百科、纽约时报、GitHub、谷歌搜索页全都弹出了浮层。
 *
 * 现在主机表答不出的页面只凭内容脚本看见的东西：一张带求职信号的通用申请表 → 能填（表里有只有求职才问的栏才
 * 自动打开，2026-09-28）；页面自己声明的 JobPosting → 一个标签（不自动打开）；什么都没有 → 什么都不挂，没登录、
 * 取不到规则时也一样。
 */

const withGenericInstalled = async (): Promise<void> => {
  const registry = await createRuntimeApplyRegistry(APPLY_RULES_RUNTIME_RELEASE_V1);
  if (!registry.ok) throw new Error(registry.code);
  installApplyAdapters(applyAdaptersFromRuntimeRegistry(registry.value));
};

afterEach(() => { installBundledApplyAdapters(); });

const WIKIPEDIA = { canonicalOrigin: 'https://en.wikipedia.org', pathname: '/wiki/Job_application' };
const face = (over: Partial<Parameters<typeof dockFaceForPage>[0]> = {}) => dockFaceForPage({
  ...WIKIPEDIA,
  connected: true,
  missionBound: false,
  reachableOnJobPages: true,
  ...over,
});

describe('没有任何证据的页面：什么都不挂', () => {
  it('通用规则装着、账号连着：不再因为 URL 就给「能填」的脸', async () => {
    await withGenericInstalled();
    expect(face()).toEqual({ kind: 'HIDDEN' });
    expect(face({ missionBound: true })).toEqual({ kind: 'HIDDEN' });
  });

  it('没登录、取不到规则时也不挂——不在百科页上说「先登录」', async () => {
    await withGenericInstalled();
    expect(face({ connected: false })).toEqual({ kind: 'HIDDEN' });
    expect(face({ rulesAvailable: false })).toEqual({ kind: 'HIDDEN' });
    expect(face({ connected: false, rulesAvailable: false })).toEqual({ kind: 'HIDDEN' });
  });

  it('自动打开因此不会发生', async () => {
    await withGenericInstalled();
    expect(createDockAutoOpen().shouldOpen(face(), false)).toBe(false);
  });
});

describe('有证据的页面', () => {
  it('恰好一张带求职信号的通用表 → 能填的脸（会自动打开）', async () => {
    await withGenericInstalled();
    const fillable = face({ genericForm: true, genericJobForm: true });
    expect(fillable).toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
    expect(isFillableFace(fillable)).toBe(true);
    expect(face({ genericForm: true, genericJobForm: true, missionBound: true })).toEqual({ kind: 'READY' });
    expect(face({ genericForm: true, genericJobForm: true, connected: false })).toEqual({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' });
  });

  it('通用规则没装上时，表的证据也不算数（闸没放松）', () => {
    expect(face({ genericForm: true, genericJobForm: true })).toEqual({ kind: 'HIDDEN' });
  });

  it('只有 JobPosting → 一个标签，不自动打开', async () => {
    await withGenericInstalled();
    const tab = face({ jobPosting: true });
    expect(tab).toEqual({ kind: 'DORMANT' });
    expect(createDockAutoOpen().shouldOpen(tab, false)).toBe(false);
    // 招聘页上没登录：标签照旧在，打开后说先登录。
    expect(face({ jobPosting: true, connected: false, rulesAvailable: false }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' });
  });

  it('厂商主机不需要证据：申请页照旧能填，非申请页照旧一个标签', async () => {
    await withGenericInstalled();
    expect(face({ canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/acme/jobs/123', missionBound: true }))
      .toEqual({ kind: 'READY' });
    expect(face({ canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/acme' })).toEqual({ kind: 'DORMANT' });
  });
});

/**
 * 公司自己做的表什么时候自动打开（负责人 2026-09-28，取代 2026-09-25「先严格」那一版的「一律只挂收着的标签」）：
 * 表里有只有求职才问的栏——简历／CV 上传、LinkedIn、工作授权、学历——就像厂商的申请页一样自动打开。表里只有较弱的
 * 求职信号（GitHub、期望薪资……），或只靠页面声明的 JobPosting、招聘页的网址撑着的表，照旧只挂收着的标签；
 * 「联系销售」、只有姓名邮箱电话的表不挂、不开。
 */
describe('公司自己做的表：表里有只有求职才问的栏才自动打开', () => {
  const COMPANY_JOB_FORM = { lane: 'company', jobOnlyFields: true } as const;
  const COMPANY_FORM = { lane: 'company', jobOnlyFields: false } as const;
  const CAREERS = { canonicalOrigin: 'https://careers.acme.example', pathname: '/engineer/apply' };

  it('有简历、LinkedIn、工作授权或学历那几栏 → 能填的脸，自动打开', async () => {
    await withGenericInstalled();
    const fillable = face({ canonicalOrigin: 'https://www.acme.example', pathname: '/apply', genericForm: true, genericJobForm: true });
    expect(isFillableFace(fillable)).toBe(true);
    expect(createDockAutoOpen().shouldOpen(fillable, false, COMPANY_JOB_FORM)).toBe(true);
  });

  it('自动打开照旧尊重用户：这个站点 30 分钟内收起过、这一次加载已经开过或收起过，都不再开', async () => {
    await withGenericInstalled();
    const fillable = face({ ...CAREERS, genericForm: true, genericJobForm: true });
    expect(createDockAutoOpen().shouldOpen(fillable, true, COMPANY_JOB_FORM)).toBe(false);
    const once = createDockAutoOpen();
    once.opened();
    expect(once.shouldOpen(fillable, false, COMPANY_JOB_FORM)).toBe(false);
    const collapsed = createDockAutoOpen();
    collapsed.collapsed();
    expect(collapsed.shouldOpen(fillable, false, COMPANY_JOB_FORM)).toBe(false);
  });

  it('表里只有较弱的求职信号（GitHub、期望薪资）→ 能填，但只挂收着的标签', async () => {
    await withGenericInstalled();
    const fillable = face({ canonicalOrigin: 'https://www.acme.example', pathname: '/apply', genericForm: true, genericJobForm: true });
    expect(isFillableFace(fillable)).toBe(true);
    expect(createDockAutoOpen().shouldOpen(fillable, false, COMPANY_FORM)).toBe(false);
  });

  it('只靠招聘页网址撑着的表（姓名、邮箱、电话）→ 能填，但只挂收着的标签', async () => {
    await withGenericInstalled();
    const fillable = face({ ...CAREERS, genericForm: true });
    expect(isFillableFace(fillable)).toBe(true);
    expect(createDockAutoOpen().shouldOpen(fillable, false, COMPANY_FORM)).toBe(false);
  });

  it('只靠页面声明的 JobPosting 撑着的表 → 同样只挂收着的标签', async () => {
    await withGenericInstalled();
    const fillable = face({ canonicalOrigin: 'https://www.acme.example', pathname: '/posting', genericForm: true, jobPosting: true });
    expect(isFillableFace(fillable)).toBe(true);
    expect(createDockAutoOpen().shouldOpen(fillable, false, COMPANY_FORM)).toBe(false);
  });

  it('联系销售：不挂，也就不开', async () => {
    await withGenericInstalled();
    const hidden = face({ canonicalOrigin: 'https://www.zendesk.com', pathname: '/contact/', genericForm: true });
    expect(hidden).toEqual({ kind: 'HIDDEN' });
    expect(createDockAutoOpen().shouldOpen(hidden, false, COMPANY_FORM)).toBe(false);
  });

  it('没有表、只有 JobPosting：一个收着的标签，不开', async () => {
    await withGenericInstalled();
    const tab = face({ jobPosting: true });
    expect(createDockAutoOpen().shouldOpen(tab, false, COMPANY_FORM)).toBe(false);
  });

  it('厂商申请页与白标照旧自动打开（不看这一条）', async () => {
    await withGenericInstalled();
    const ready = face({ canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/acme/jobs/123', missionBound: true });
    expect(createDockAutoOpen().shouldOpen(ready, false)).toBe(true);
    expect(createDockAutoOpen().shouldOpen(ready, false, { lane: 'vendor' })).toBe(true);
  });
});

describe('我们自己的门户与后端', () => {
  it('门户资料页那张表认得的字段再多也不挂', async () => {
    await withGenericInstalled();
    const ownOrigins = ['https://argoland.ai', 'https://api.argoland.ai'];
    expect(face({ canonicalOrigin: 'https://argoland.ai', pathname: '/profile', genericForm: true, jobPosting: true, ownOrigins }))
      .toEqual({ kind: 'HIDDEN' });
    // 只按 origin 整串比：别的子域不受影响。
    expect(face({ canonicalOrigin: 'https://careers.argoland.ai', pathname: '/apply', genericForm: true, ownOrigins }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
  });
});

/**
 * 不是招聘的表（2026-09-25 测试台）：Zendesk、DocuSign、HubSpot 的「联系销售」页上浮层都自动弹出了——名、姓、工作邮箱、
 * 电话、公司、职位，通用规则认得够 4 栏。现在主机表答不出的页面上，一张表要带求职信号才算申请表：表里有求职信号的栏
 * （简历、学历那一节里的学校、LinkedIn、工作授权、GitHub……），或页面声明 JobPosting，或网址自己说它是招聘页。
 */
describe('不是招聘的表：什么都不挂', () => {
  const CONTACT = { canonicalOrigin: 'https://www.zendesk.com', pathname: '/contact/' };

  it('联系销售：认得够多栏，但没有求职信号 → 不挂', async () => {
    await withGenericInstalled();
    expect(face({ ...CONTACT, genericForm: true })).toEqual({ kind: 'HIDDEN' });
    expect(face({ ...CONTACT, genericForm: true, missionBound: true })).toEqual({ kind: 'HIDDEN' });
    expect(face({ ...CONTACT, genericForm: true, connected: false })).toEqual({ kind: 'HIDDEN' });
  });

  it('同一张表，页面声明了 JobPosting → 能填', async () => {
    await withGenericInstalled();
    expect(face({ ...CONTACT, genericForm: true, jobPosting: true })).toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
  });

  it('同一张表，网址是招聘页 → 能填；网址是招聘页但没有表 → 一个标签', async () => {
    await withGenericInstalled();
    expect(face({ canonicalOrigin: 'https://careers.acme.example', pathname: '/engineer', genericForm: true }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
    expect(face({ canonicalOrigin: 'https://www.acme.example', pathname: '/careers/apply', genericForm: true }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
    expect(face({ canonicalOrigin: 'https://www.acme.example', pathname: '/careers/engineer' })).toEqual({ kind: 'DORMANT' });
  });

  it('单独的 /apply 不算招聘页：信用卡、贷款、签证也叫 apply', async () => {
    await withGenericInstalled();
    expect(face({ canonicalOrigin: 'https://www.bank.example', pathname: '/credit-cards/apply', genericForm: true })).toEqual({ kind: 'HIDDEN' });
  });
});

describe('网址自己说它是招聘页（jobLikeUrl）', () => {
  it.each([
    ['careers.acme.com', '/'],
    ['jobs.acme.com', '/engineering'],
    ['www.acme.com', '/careers'],
    ['www.acme.com', '/careers/senior-engineer/apply'],
    ['www.acme.com', '/en/jobs/123'],
    ['www.acme.com', '/careers-at-acme'],
    ['www.acme.com', '/join-us'],
    ['www.acme.de', '/karriere/stellenangebote'],
  ])('%s%s → 是', (host, path) => {
    expect(jobLikeUrl(host, path)).toBe(true);
  });

  it.each([
    ['www.bank.com', '/credit-cards/apply'],
    ['www.zendesk.com', '/contact/'],
    ['www.acme.com', '/positions'],
    ['en.wikipedia.org', '/wiki/Job_application'],
    ['www.acme.com', '/jobsearch-tips-blog'],
    ['blog.acme.com', '/how-we-hire'],
  ])('%s%s → 不是', (host, path) => {
    expect(jobLikeUrl(host, path)).toBe(false);
  });
});
