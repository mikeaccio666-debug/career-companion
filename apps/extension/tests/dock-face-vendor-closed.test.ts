// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { APPLY_RULES_RUNTIME_RELEASE_V1 } from '../../../packages/apply-rules/runtime-release';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { installApplyAdapters } from '@edaix/apply-kernel/registry';
import { applyAdaptersFromRuntimeRegistry, createRuntimeApplyRegistry } from '@edaix/apply-kernel/runtimeRegistry';
import type { ExecutionRuntimeBundleV1 } from '@edaix/contracts';

import { parseDockApplyMaterialsReply } from '../lib/applyMaterialsIntent';
import { mountAutofillDock, parseAutofillDockInstruction } from '../lib/autofillDock';
import { dockFaceForPage, frameFormFace } from '../lib/autofillDockDecision';
import { createDockAutoOpen, isFillableFace } from '../lib/dockAutoOpen';
import { bundleOpenVendors } from '../lib/executionRuntimeAuthority';

/**
 * 这一家还没放行时，不亮一颗按下去才说「暂时连不上 ArgoLand」的按钮（2026-10-04，bench-1003 第七节第 1 条）。
 *
 * 那一天的样子：商店 1.1.0 在公司自建表单上自动打开、亮着「自动填写」，而生产的运行时包还没放行通用路（generic 位关着）；
 * 一按，worker 拿不到只读授权（`DISCOVERY_AUTHORITY_RUNTIME_AUTHORITY_POLICY_DISABLED`），浮层说「暂时连不上 ArgoLand」——
 * 9/9 页自建表单、2/2 页 Greenhouse 自做前端都是这句错话。现在：
 *  · 脸：包里这一家没放行 → 「这类网站还没开放自动填写」，不摆按钮、不自动打开；
 *  · 按下去那一刻才发现（脸是几分钟前那一份包算的）：worker 单独说 `VENDOR_CLOSED`，浮层照实说同一句，不说「连不上」。
 */

const withRulesInstalled = async (): Promise<void> => {
  const registry = await createRuntimeApplyRegistry(APPLY_RULES_RUNTIME_RELEASE_V1);
  if (!registry.ok) throw new Error(registry.code);
  installApplyAdapters(applyAdaptersFromRuntimeRegistry(registry.value));
};

afterEach(() => {
  installBundledApplyAdapters();
  document.body.innerHTML = '';
});

const COMPANY_FORM = { canonicalOrigin: 'https://www.acme.example', pathname: '/careers/engineer', genericForm: true, genericJobForm: true };
/** 生产 rev 17 的样子：厂商都开着，generic、icims 关着。 */
const PROD_REV17 = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'workday', 'smartrecruiters', 'bamboohr', 'dover', 'jobvite', 'rippling']);

const face = (over: Partial<Parameters<typeof dockFaceForPage>[0]> = {}) => dockFaceForPage({
  ...COMPANY_FORM,
  connected: true,
  missionBound: false,
  reachableOnJobPages: true,
  rulesAvailable: true,
  ...over,
});

describe('脸：包里这一家没放行 → 「这类网站还没开放自动填写」，不亮按钮、不自动打开', () => {
  it('公司自建表单、generic 位关着：VENDOR_CLOSED（从前是能填的脸，按下去说「连不上」）', async () => {
    await withRulesInstalled();
    expect(face()).toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
    const closed = face({ openVendors: PROD_REV17 });
    expect(closed).toEqual({ kind: 'UNAVAILABLE', reason: 'VENDOR_CLOSED' });
    expect(isFillableFace(closed)).toBe(false);
    expect(createDockAutoOpen().shouldOpen(closed, false, { lane: 'company', jobOnlyFields: true })).toBe(false);
    // 没登录也一样：先登录也填不了，不劝他去登录。
    expect(face({ openVendors: PROD_REV17, connected: false })).toEqual({ kind: 'UNAVAILABLE', reason: 'VENDOR_CLOSED' });
  });

  it('放行了就照旧：generic 位开着（#661 之后）→ 能填', async () => {
    await withRulesInstalled();
    expect(face({ openVendors: new Set([...PROD_REV17, 'generic']) })).toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
  });

  it('厂商主机同理：这一家关着（例如 Lever 被远程关掉）→ VENDOR_CLOSED；Greenhouse 开着 → 照旧', async () => {
    await withRulesInstalled();
    const leverOff = new Set([...PROD_REV17].filter((vendor) => vendor !== 'lever'));
    const lever = { canonicalOrigin: 'https://jobs.lever.co', pathname: '/acme/0a1b2c3d-1111-2222-3333-444455556666/apply', genericForm: false, genericJobForm: false };
    expect(face({ ...lever, openVendors: PROD_REV17 })).toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
    expect(face({ ...lever, openVendors: leverOff })).toEqual({ kind: 'UNAVAILABLE', reason: 'VENDOR_CLOSED' });
    expect(face({ canonicalOrigin: 'https://boards.greenhouse.io', pathname: '/acme/jobs/123', genericForm: false, genericJobForm: false, openVendors: PROD_REV17, missionBound: true }))
      .toEqual({ kind: 'READY' });
  });

  it('不知道放没放行（没传、取不到包）→ 不替它下结论：照旧，取不到规则照旧说「暂时没法判断」', async () => {
    await withRulesInstalled();
    expect(face({ openVendors: null })).toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
    expect(face({ rulesAvailable: false, openVendors: PROD_REV17 })).toEqual({ kind: 'UNAVAILABLE', reason: 'RULES_UNAVAILABLE' });
  });

  it('不是申请表的页（职位详情、普通网页）不受影响', async () => {
    await withRulesInstalled();
    expect(face({ genericForm: false, genericJobForm: false, jobPosting: true, openVendors: PROD_REV17 })).toEqual({ kind: 'DORMANT' });
    expect(face({ canonicalOrigin: 'https://en.wikipedia.org', pathname: '/wiki/Main_Page', genericForm: false, genericJobForm: false, openVendors: PROD_REV17 }))
      .toEqual({ kind: 'HIDDEN' });
  });

  it('嵌入帧同理：这一帧那一家没放行 → VENDOR_CLOSED', async () => {
    await withRulesInstalled();
    const frame = { canonicalOrigin: 'https://job-boards.greenhouse.io', pathname: '/embed/job_app' };
    expect(frameFormFace({ frame, topPage: null, connected: true, missionBound: false, openVendors: new Set(['lever']) }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'VENDOR_CLOSED' });
    expect(frameFormFace({ frame, topPage: null, connected: true, missionBound: false, openVendors: PROD_REV17 }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' });
  });

  it('内容脚本认得这张脸（不然它一声不吭地不挂浮层）', () => {
    expect(parseAutofillDockInstruction({ dock: { kind: 'UNAVAILABLE', reason: 'VENDOR_CLOSED' } }))
      .toEqual({ kind: 'UNAVAILABLE', reason: 'VENDOR_CLOSED' });
  });
});

describe('bundleOpenVendors：包里放行了哪几家（只读识别也算）', () => {
  const bundle = (policy: Record<string, unknown>) => ({ policy }) as unknown as ExecutionRuntimeBundleV1;

  it('执行包：总开关开着、带 FILL，就是厂商位开着的那几家', () => {
    const open = bundleOpenVendors(bundle({
      enabled: true, allowedActions: ['FILL'], vendors: { greenhouse: true, generic: false, icims: false, lever: true },
      capabilities: {}, automationLevelCeiling: 'L1_FILL_REVIEW',
    }));
    expect([...open].sort()).toEqual(['greenhouse', 'lever']);
  });

  it('总开关关着（kill switch）→ 一家都没有', () => {
    expect(bundleOpenVendors(bundle({
      enabled: false, allowedActions: ['FILL'], vendors: { greenhouse: true }, capabilities: {}, automationLevelCeiling: 'L1_FILL_REVIEW',
    })).size).toBe(0);
  });
});

describe('按下去那一刻才发现没放行：worker 单独说 VENDOR_CLOSED，浮层照实说', () => {
  it('答复里认得 VENDOR_CLOSED（别的拒绝照旧）', () => {
    expect(parseDockApplyMaterialsReply({ kind: 'REFUSED', code: 'VENDOR_CLOSED' })).toEqual({ kind: 'REFUSED', code: 'VENDOR_CLOSED' });
    expect(parseDockApplyMaterialsReply({ kind: 'REFUSED', code: 'UNAVAILABLE' })).toEqual({ kind: 'REFUSED', code: 'UNAVAILABLE' });
    expect(parseDockApplyMaterialsReply({ kind: 'REFUSED', code: 'SOMETHING_ELSE' })).toBeNull();
  });

  it('worker：厂商位关着、通用路没放行 → VENDOR_CLOSED；内容脚本据此报 VENDOR_CLOSED，不报 AUTHORITY_UNAVAILABLE', () => {
    const background = readFileSync(resolve(__dirname, '..', 'entrypoints', 'background.ts'), 'utf8');
    expect(background).toContain("'DISCOVERY_GENERIC_UNAVAILABLE',");
    expect(background).toContain("'DISCOVERY_AUTHORITY_RUNTIME_AUTHORITY_POLICY_DISABLED',");
    expect(background).toContain("return { kind: 'REFUSED', code: VENDOR_CLOSED_CODES.has(code) ? 'VENDOR_CLOSED' : 'UNAVAILABLE' };");
    expect(background).toContain('openVendors: rulesAvailable ? runtimeOpenVendors : null,');
    const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');
    expect(content).toContain("dockHandle?.reportBlocked(authReply?.kind === 'REFUSED' && authReply.code === 'VENDOR_CLOSED' ? 'VENDOR_CLOSED' : 'AUTHORITY_UNAVAILABLE');");
  });
});

const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('浮层上的样子', () => {
  it('VENDOR_CLOSED 那张脸：照实说，没有「自动填写」按钮', () => {
    const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'VENDOR_CLOSED' }, { onAutofill: () => {}, onOpenEntry: () => {} }, document);
    handle.openPanel();
    expect(text(handle.sceneRoot())).toContain('这类网站还没开放自动填写');
    expect(handle.autofillButton()).toBeNull();
    expect(handle.autofillEnabled()).toBe(false);
  });

  it.each([
    ['VENDOR_CLOSED', '这类网站还没开放自动填写'],
    ['CONSENT_GATE', '先过网站的数据同意这一步'],
    ['APPLY_FORM_NOT_OPENED', '申请表还没打开'],
  ])('按下去才停（%s）：失败卡说「%s」，不说「暂时连不上 ArgoLand」、也不说「这一轮没有完成」', (code, title) => {
    const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {} }, document);
    handle.openPanel();
    handle.reportBlocked(code);
    const all = text(handle.sceneRoot());
    expect(text(handle.sceneRoot()?.querySelector('.face-title'))).toBe(title);
    expect(all).not.toContain('暂时连不上 ArgoLand');
    expect(all).not.toContain('这一轮没有完成');
  });
});
