import { describe, expect, it } from 'vitest';

import { DOCK_PORTAL_PATHS, createDockPortalIntent, parseDockPortalIntent } from '../lib/dockPortalIntent';

describe('the dock\'s door to the portal', () => {
  it('names a page by a closed word and never carries a URL', () => {
    expect(createDockPortalIntent('CONNECT')).toEqual({ kind: 'dock/open-portal', page: 'CONNECT' });
    expect(Object.keys(createDockPortalIntent('PROFILE') ?? {}).sort()).toEqual(['kind', 'page']);
  });
  it.each([
    ['a page it does not know', { kind: 'dock/open-portal', page: 'ADMIN' }],
    ['a url smuggled in', { kind: 'dock/open-portal', page: 'PROFILE', url: 'https://evil.example' }],
    ['another kind', { kind: 'dock/add-job-intent', page: 'PROFILE' }],
    ['nothing', null],
  ])('refuses %s', (_label, value) => {
    expect(parseDockPortalIntent(value)).toBeNull();
  });
  it('resolves the plain pages to the portal paths the web app serves', () => {
    // PRICING（2026-09-24）：AI 次数用完那张卡片上的「升级会员」，落到门户的套餐页（来源记成 paywall）。
    // SIGNING_SCOPE（2026-09-28）：代填授权那一句里的「隐私政策」，落到隐私政策里写明代填范围的那一节（英文页、中文页）。
    expect(DOCK_PORTAL_PATHS).toEqual({
      PROFILE: '/career/profile',
      APPLICATIONS: '/career/applications',
      PRICING: '/plan?source=paywall',
      SIGNING_SCOPE: '/privacy#application-signing',
      SIGNING_SCOPE_ZH: '/zh/privacy#application-signing',
    });
    expect(createDockPortalIntent('PRICING')).toEqual({ kind: 'dock/open-portal', page: 'PRICING' });
  });
});
