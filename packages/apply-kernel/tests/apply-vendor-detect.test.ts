import { describe, expect, it } from 'vitest';

import {
  APPLY_VENDORS,
  applyHostMatchPatterns,
  candidateHostMatchPatterns,
  detectApplyVendor,
  VENDOR_CATALOG,
} from '../src/vendors';
import { ADAPTERS, activeApplyVendors } from '../src/bundledAdapters';
import { sharedHostGuardedSuffixes } from '../src/gate/hostVeto';

function hostOfPattern(pattern: string): string {
  return pattern.replace('https://', '').split('/')[0]!;
}

/**
 * Autofill vendor detection (owner-approved v1 set, 2026-07-28). This is the
 * gate that decides whether the autofill content script boots at all, so the
 * negative cases matter more than the positive ones: a lookalike host must
 * never be treated as an ATS.
 */
describe('detectApplyVendor', () => {
  it('recognises the four v1 vendors on their real hosts', () => {
    expect(detectApplyVendor('job-boards.greenhouse.io')).toBe('greenhouse');
    expect(detectApplyVendor('boards.greenhouse.io')).toBe('greenhouse');
    expect(detectApplyVendor('boards.eu.greenhouse.io')).toBe('greenhouse');
    expect(detectApplyVendor('jobs.lever.co')).toBe('lever');
    expect(detectApplyVendor('jobs.ashbyhq.com')).toBe('ashby');
    expect(detectApplyVendor('apply.workable.com')).toBe('workable');
  });

  it('is case-insensitive and tolerates a trailing dot', () => {
    expect(detectApplyVendor('JOBS.LEVER.CO')).toBe('lever');
    expect(detectApplyVendor('jobs.lever.co.')).toBe('lever');
  });

  it('拒绝雇主侧后台，只认候选人侧主机', () => {
    for (const host of [
      'app.greenhouse.io',
      'my.greenhouse.io',
      'canary.greenhouse.io',
      'hire.lever.co',
      'app.ashbyhq.com',
      'www.workable.com',
      'greenhouse.io',
      'lever.co',
    ]) {
      expect(detectApplyVendor(host), `${host} 不该被当成申请页`).toBeNull();
    }
  });

  it('rejects lookalike hosts that merely CONTAIN a vendor name', () => {
    expect(detectApplyVendor('greenhouse.io.evil.test')).toBeNull();
    expect(detectApplyVendor('notgreenhouse.io.attacker.com')).toBeNull();
    expect(detectApplyVendor('lever.co.phish.example')).toBeNull();
    expect(detectApplyVendor('jobs.lever.co.evil.test')).toBeNull();
  });

  it('returns null for everything else, including our own surfaces', () => {
    for (const host of ['www.linkedin.com', 'edaix.io', 'myworkdayjobs.com', 'example.com']) {
      expect(detectApplyVendor(host)).toBeNull();
    }
  });
});

/** Local catalog is packaging metadata only; production execution uses runtime authority. */
describe('applyHostMatchPatterns', () => {
  it('retains exactly the ten existing adapters while Workday and Avature stay unavailable', () => {
    expect(activeApplyVendors()).toEqual([
      'greenhouse',
      'lever',
      'ashby',
      'workable',
      'smartrecruiters',
      'icims',
      'rippling',
      'dover',
      'bamboohr',
      'jobvite',
    ]);
    expect(ADAPTERS.workday).toBeNull();
    expect(ADAPTERS.avature).toBeNull();
  });

  it('每一条注入模式的主机都能被识别出厂商（按租户分子域的用一个样例子域验）', () => {
    const patterns = applyHostMatchPatterns(ADAPTERS);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      const host = hostOfPattern(pattern);
      // 通配只允许出现在最左一段（`*.<注册域>`），别处出现就是把主机写错了。
      expect(host.slice(1), `${pattern} 的通配不在最左一段`).not.toContain('*');
      const sample = host.startsWith('*.') ? `tenant${host.slice(1)}` : host;
      expect(detectApplyVendor(sample), `注入了 ${host} 却识别不出厂商`).not.toBeNull();
    }
  });

  it('主机通配只给目录里登记了注册域后缀的厂商，且注册域自身不在范围里（P4-16，2026-09-21）', () => {
    // 从前这里断言「不含任何通配子域」。Workday（`<tenant>.wdN.myworkdayjobs.com`）与 BambooHR
    // （`<tenant>.bamboohr.com`）按租户分子域，不写通配就永远注入不到；雇主后台那一面靠
    // hostVeto 的共域路径否决兜住（下面「every candidate suffix …」那条锁着）。
    const suffixes = new Set(
      Object.values(VENDOR_CATALOG).flatMap((entry) =>
        'candidateHostSuffixes' in entry ? [...(entry.candidateHostSuffixes as readonly string[])] : []),
    );
    for (const pattern of applyHostMatchPatterns(ADAPTERS)) {
      const host = hostOfPattern(pattern);
      if (!host.includes('*')) continue;
      expect(host.startsWith('*.'), `${pattern} 的通配不是 *.<注册域> 的形状`).toBe(true);
      expect(suffixes.has(host.slice(2)), `${pattern} 的注册域不在目录的后缀表里`).toBe(true);
      expect(pattern, '不得是全域通配').not.toMatch(/^https:\/\/\*\//u);
      // 注册域自身不匹配：`https://*.bamboohr.com/*` 不包含 `https://bamboohr.com/…`。
      expect(detectApplyVendor(host.slice(2))).toBeNull();
    }
  });

  it('只为已有 adapter 且显式登记候选主机的厂商派生注入主机', () => {
    const active = activeApplyVendors();
    expect(active.length, '一个适配器都没有，这条断言等于空转').toBeGreaterThan(0);
    const hosts = applyHostMatchPatterns(ADAPTERS);
    for (const pattern of hosts) {
      const vendor = detectApplyVendor(hostOfPattern(pattern));
      expect(vendor, `${pattern} 被注入却识别不出厂商`).not.toBeNull();
      expect(active, `${pattern} 属于没有适配器的厂商`).toContain(vendor);
    }
    const adapterHosts = activeApplyVendors().flatMap((vendor) =>
      candidateHostMatchPatterns(VENDOR_CATALOG[vendor]),
    );
    expect(hosts).toEqual(adapterHosts);

    const noneWired = Object.fromEntries(APPLY_VENDORS.map((vendor) => [vendor, null])) as unknown as typeof ADAPTERS;
    expect(applyHostMatchPatterns(noneWired)).toEqual([]);

    for (const vendor of APPLY_VENDORS) {
      const withoutOne = applyHostMatchPatterns({ ...ADAPTERS, [vendor]: null });
      // 本来就没有适配器的厂商（workday / avature）摘不摘都一样：它的主机从来不在这张表里。
      const ownHosts = ADAPTERS[vendor] === null ? [] : candidateHostMatchPatterns(VENDOR_CATALOG[vendor]);
      for (const host of ownHosts) {
        expect(withoutOne, `摘掉 ${vendor} 后它的主机仍在注入范围里`).not.toContain(host);
      }
      expect(withoutOne.length, `摘掉 ${vendor} 影响了别家的主机`).toBe(
        hosts.length - ownHosts.length,
      );
    }
  });

  /**
   * 2026-09-22：Dover / Jobvite / Rippling 的合同映射收口了（argoland #565 把它们放进
   * runtime bundle 的 mappings），主机因此从空表转正。空表的代价是实测出来的：放行当天
   * 这三家各跑 6 页真实在招岗位，**18 页全部**报「这一页没有认出申请表」——`pageVendor`
   * 主机表先行、答不出才退白标，而这三家没有 whitelabelRoot，链子从第一步就断。
   *
   * 转正的同时把「这台主机上有没有雇主面」逐个量了一遍（2026-07-29 事故的同一形状）：
   * jobs.jobvite.com 301 跳 www.jobvite.com、ats.rippling.com 308 跳
   * www.rippling.com/recruiting，两者都是纯候选人面的招聘板；app.dover.com 根路径 200、
   * 标题就是 Dover，**那台主机上有雇主面**，所以它的 `/apply/` 路径否决必须留着。
   */
  it('合同映射收口的三家主机转正，带雇主面的那台仍有路径否决', () => {
    expect(VENDOR_CATALOG.dover.candidateHosts).toEqual(['app.dover.com']);
    expect(VENDOR_CATALOG.dover.candidatePathPrefixes).toEqual(['/apply/']);
    expect(VENDOR_CATALOG.jobvite.candidateHosts).toEqual(['jobs.jobvite.com']);
    expect(VENDOR_CATALOG.rippling.candidateHosts).toEqual(['ats.rippling.com']);

    expect(detectApplyVendor('app.dover.com')).toBe('dover');
    expect(detectApplyVendor('jobs.jobvite.com')).toBe('jobvite');
    expect(detectApplyVendor('ats.rippling.com')).toBe('rippling');

    // 主机表只认逐字相等：这三家都不许把子域圈进来。
    for (const host of ['app.rippling.com', 'admin.jobvite.com', 'evil-app.dover.com.example.com']) {
      expect(detectApplyVendor(host), host).toBeNull();
    }

    // BambooHR 仍靠后缀，主机表照旧是空的。
    expect(VENDOR_CATALOG.bamboohr.candidateHosts).toEqual([]);
    expect(VENDOR_CATALOG.bamboohr.candidateHostSuffixes).toEqual(['bamboohr.com']);
  });

  it('shared-host candidate path metadata narrows manifest matches before activation', () => {
    expect(candidateHostMatchPatterns({
      candidateHosts: ['app.dover.com'],
      candidatePathPrefixes: ['/apply/'],
    })).toEqual(['https://app.dover.com/apply/*']);
    expect(() => candidateHostMatchPatterns({
      candidateHosts: ['app.dover.com'],
      candidatePathPrefixes: ['/apply/*'],
    })).toThrow('INVALID_CANDIDATE_PATH_PREFIX');
  });

  it('every candidate suffix with an employer surface is coupled to a shared-host path veto', () => {
    const noEmployerSurface = new Set(['myworkdayjobs.com']);
    const guarded = new Set(sharedHostGuardedSuffixes());
    for (const entry of Object.values(VENDOR_CATALOG)) {
      const suffixes = 'candidateHostSuffixes' in entry
        ? entry.candidateHostSuffixes as readonly string[]
        : [];
      for (const suffix of suffixes) {
        expect(noEmployerSurface.has(suffix) || guarded.has(suffix), suffix).toBe(true);
      }
    }
    expect(guarded.has('bamboohr.com')).toBe(true);
  });
});
