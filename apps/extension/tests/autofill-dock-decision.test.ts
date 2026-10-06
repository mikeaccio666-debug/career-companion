import { describe, expect, it } from 'vitest';

import { dockFaceForPage, dockSurfacesOn, frameFormFace } from '../lib/autofillDockDecision';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();


const page = (over: Partial<Parameters<typeof dockFaceForPage>[0]> = {}) => dockFaceForPage({
  canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/acme/jobs/123',
  connected: true, missionBound: true, ...over,
});

describe('dockFaceForPage', () => {
  it('surfaces on exactly the vendors that have a real adapter', () => {
    // The registry is the single answer, so landing an adapter is what makes a
    // vendor supported -- no second list to keep in step.
    for (const vendor of ['greenhouse', 'lever', 'ashby', 'workable'] as const) {
      expect(dockSurfacesOn(vendor), vendor).toBe(true);
    }
    // Recognition assets exist for these; production mapping has not shipped, so
    // ADAPTERS holds null and the dock must not claim them.
    for (const vendor of ['workday', 'avature'] as const) {
      expect(dockSurfacesOn(vendor), vendor).toBe(false);
    }
    expect(dockSurfacesOn(null)).toBe(false);
  });
  it('offers Autofill on a Greenhouse application path', () => {
    expect(page()).toEqual({ kind: 'READY' });
  });
  it.each([
    ['an unrelated site', 'https://mail.example.com'],
    ['our own portal', 'https://staging.career-companion.invalid'],
  ])('shows nothing on %s', (_label, canonicalOrigin) => {
    expect(page({ canonicalOrigin })).toEqual({ kind: 'HIDDEN' });
  });
  it('offers Autofill on another adapter-backed vendor, with no edit here', () => {
    expect(page({ canonicalOrigin: 'https://jobs.lever.co', pathname: '/acme/abc/apply' }))
      .toEqual({ kind: 'READY' });
  });
  it('shows nothing on a Greenhouse path that is not an application form', () => {
    expect(page({ pathname: '/' })).toEqual({ kind: 'HIDDEN' });
  });
  it('withholds Autofill until the browser is connected', () => {
    expect(page({ connected: false })).toEqual({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' });
  });
  it('withholds Autofill on a form it cannot tie to a Mission', () => {
    expect(page({ missionBound: false })).toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
  });
  it('refuses an origin it cannot parse rather than guessing a vendor', () => {
    expect(page({ canonicalOrigin: 'not a url' })).toEqual({ kind: 'HIDDEN' });
  });
});

describe('reachable on job pages, proactive only where something is recognised', () => {
  const anywhere = (over: Partial<Parameters<typeof dockFaceForPage>[0]> = {}) => dockFaceForPage({
    canonicalOrigin: 'https://careers.some-employer.example', pathname: '/openings/42',
    connected: true, missionBound: true, reachableOnJobPages: true, jobPosting: true, ...over,
  });

  it('keeps a launcher on a job page it recognises no form on', () => {
    expect(anywhere()).toEqual({ kind: 'DORMANT' });
  });

  it('claims nothing there: a dormant face offers no Autofill', () => {
    expect(anywhere()).not.toEqual({ kind: 'READY' });
  });

  it('shows nothing on a page that is not a job page (2026-09-24: injection is network-wide)', () => {
    // 2026-09-25：careers.* 子域名本身就说它是招聘页（jobLikeUrl），这里换一个什么都不说明的地址。
    expect(anywhere({ canonicalOrigin: 'https://www.some-employer.example', pathname: '/about', jobPosting: false }))
      .toEqual({ kind: 'HIDDEN' });
  });

  it('is still proactive on a form it does recognise', () => {
    expect(anywhere({ canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/acme/jobs/123' }))
      .toEqual({ kind: 'READY' });
  });

  it('stays silent when the caller has not asked to be reachable everywhere', () => {
    expect(dockFaceForPage({
      canonicalOrigin: 'https://careers.some-employer.example', pathname: '/openings/42',
      connected: true, missionBound: true,
    })).toEqual({ kind: 'HIDDEN' });
  });
});

describe('子帧的脸（P2-10：公司站点上官方嵌入的 ATS iframe）', () => {
  const EMBED = { canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/embed/job_app' };
  const face = (over: Partial<Parameters<typeof frameFormFace>[0]> = {}) => frameFormFace({
    frame: EMBED, topPage: { canonicalOrigin: 'https://www.brex.com', pathname: '/careers/8686667002' },
    connected: true, missionBound: false, ...over,
  });

  it('顶层不认识 + 子帧是认得的厂商的嵌入申请页 → 子帧拿到与顶层同一套脸', () => {
    expect(face()).toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
    expect(face({ missionBound: true })).toEqual({ kind: 'READY' });
    expect(face({ connected: false })).toEqual({ kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' });
    expect(face({ rulesAvailable: false })).toEqual({ kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' });
  });

  it('顶层还没报到也一样：不等它，等出来的是空白', () => {
    expect(face({ topPage: null })).toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
  });

  it('顶层自己就是申请页 → 子帧照旧不挂', () => {
    expect(face({ topPage: { canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/acme/jobs/123' } }))
      .toEqual({ kind: 'HIDDEN' });
  });

  it('子帧不是申请页 → 不挂：嵌入路径以外的路径、认不出的主机、顶层帧上的嵌入路径', () => {
    expect(face({ frame: { ...EMBED, pathname: '/embed/job_board' } })).toEqual({ kind: 'HIDDEN' });
    expect(face({ frame: { canonicalOrigin: 'https://content.googleapis.com', pathname: '/static/proxy.html' } }))
      .toEqual({ kind: 'HIDDEN' });
    // 同一条嵌入路径在顶层帧上不是申请页：岗位身份在 query 里，pathname-only authority 不认它。
    expect(dockFaceForPage({ ...EMBED, connected: true, missionBound: true })).toEqual({ kind: 'HIDDEN' });
    expect(dockFaceForPage({ ...EMBED, connected: true, missionBound: true, embedded: true })).toEqual({ kind: 'READY' });
  });
});

describe('白标 B 的脸（P2-11：主机不在厂商表里，厂商来自指纹提示）', () => {
  const duolingo = { canonicalOrigin: 'https://careers.duolingo.com', pathname: '/jobs/8653419002', connected: true, missionBound: false };

  it('主机表答不出 + 提示 greenhouse（有 whitelabelRoot 退路）→ 与申请页同一套脸，且不看本家路径', () => {
    expect(dockFaceForPage({ ...duolingo, vendorHint: 'greenhouse' })).toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
    expect(dockFaceForPage({ ...duolingo, vendorHint: 'greenhouse', missionBound: true })).toEqual({ kind: 'READY' });
  });

  it('没有退路声明的厂商（lever）→ 提示不算数', () => {
    expect(dockFaceForPage({ ...duolingo, vendorHint: 'lever' })).toEqual({ kind: 'HIDDEN' });
  });

  it('没有提示 → 照旧；主机表认得时提示被忽略', () => {
    expect(dockFaceForPage(duolingo)).toEqual({ kind: 'HIDDEN' });
    expect(dockFaceForPage({ canonicalOrigin: 'https://jobs.lever.co', pathname: '/', connected: true, missionBound: true, vendorHint: 'greenhouse' }))
      .toEqual({ kind: 'HIDDEN' });
  });
});
