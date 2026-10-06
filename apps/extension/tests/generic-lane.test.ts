import { afterEach, describe, expect, it } from 'vitest';

import { APPLY_RULES_RUNTIME_RELEASE_V1 } from '../../../packages/apply-rules/runtime-release';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';
import { installApplyAdapters } from '@edaix/apply-kernel/registry';
import { applyAdaptersFromRuntimeRegistry, createRuntimeApplyRegistry } from '@edaix/apply-kernel/runtimeRegistry';
import { dockFaceForPage, pageVendor } from '../lib/autofillDockDecision';

/**
 * 通用路的第三层（2026-09-22）。
 *
 * `pageVendor` 今天只有两层：主机表先行，答不出就看内容脚本的指纹提示走白标。
 * 两样都答不出时它返回 null——于是公司自建域名上那张我们其实读得懂的申请表，
 * 连「去问一句」都不会发生。`generic.json` 已经随发布下发（#56），缺的就是这一句。
 *
 * ## 次序是纪律，不是实现细节
 *
 * 主机表 → 白标 → 通用，**一层都不许往前插**。认得出是哪一家时，那一家的锚点与
 * id 钩子比「数字段」准得多；通用路是最后的退路，不是并列的候选。
 *
 * ## 准入清单落在哪
 *
 * 不在这里。这一层只负责「去问一句」，真正的闸有三道，都在后端那一侧：
 *  · 运行时包里必须有 GENERIC 的精确映射，否则 `authorizeDiscoveryForVendor`
 *    直接 `RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE`；
 *  · 包里的 policy 厂商位必须开，否则 `RUNTIME_AUTHORITY_POLICY_DISABLED`；
 *  · 装得上适配器之后，`resolveRoot` 还要在 DOM 里数够 `minKeyedFields` 个字段。
 * 本测试用「适配器装没装上」代表前两道——它正是那两道的下游结果。
 */

/**
 * 后端包里带了 GENERIC 映射、策略位也开着时，内容脚本装进来的就是这一份。
 *
 * 走 `createRuntimeApplyRegistry` 而不是私接解释器：生产就是这么装的，
 * 适配器必须是从**已验证的发布**编出来的，不是从一份 JSON 直接捏的。
 */
const withGenericInstalled = async (): Promise<void> => {
  const registry = await createRuntimeApplyRegistry(APPLY_RULES_RUNTIME_RELEASE_V1);
  if (!registry.ok) throw new Error(registry.code);
  installApplyAdapters(applyAdaptersFromRuntimeRegistry(registry.value));
};

afterEach(() => { installBundledApplyAdapters(); });

describe('认不出厂商时，第三层去问一句', () => {
  it('主机表与指纹都答不出 → 走通用路', () => {
    expect(
      pageVendor('careers.acme-corp.example', null),
      '自建域上我们其实读得懂那张表，却连「去问一句」都不会发生',
    ).toEqual({ vendor: 'generic', whitelabel: false, generic: true });
  });

  it('次序：主机表先行，一个字不让', () => {
    expect(pageVendor('boards.greenhouse.io', null))
      .toEqual({ vendor: 'greenhouse', whitelabel: false, generic: false });
    // 主机表答得出时，指纹提示与通用路都插不进来。
    expect(pageVendor('boards.greenhouse.io', 'lever'))
      .toEqual({ vendor: 'greenhouse', whitelabel: false, generic: false });
  });

  it('次序：主机表答不出、指纹答得出 → 白标，通用路仍插不进来', () => {
    expect(pageVendor('careers.acme-corp.example', 'greenhouse'))
      .toEqual({ vendor: 'greenhouse', whitelabel: true, generic: false });
  });

  it('装上通用适配器、内容脚本看见了那张表之后，自建域上的浮层给得出 Autofill', async () => {
    await withGenericInstalled();
    expect(dockFaceForPage({
      canonicalOrigin: 'https://careers.acme-corp.example',
      pathname: '/jobs/senior-engineer',
      connected: true,
      missionBound: true,
      genericForm: true,
    })).toEqual({ kind: 'READY' });
  });

  /**
   * 2026-09-24（商店包开全网）：通用路上 URL 什么都不说明——通用规则的 `isApplyPath` 对任何路径都答是。
   * 只凭 URL 给脸，每一个 https 页面都成了「能填」，测试台上维基百科、纽约时报都自动弹出了浮层。
   */
  it('反向探针：内容脚本没看见表时，装着通用适配器也不给 Autofill', async () => {
    await withGenericInstalled();
    expect(dockFaceForPage({
      canonicalOrigin: 'https://careers.acme-corp.example',
      pathname: '/jobs/senior-engineer',
      connected: true,
      missionBound: true,
    })).toEqual({ kind: 'HIDDEN' });
  });

  /**
   * 后端包里没有 GENERIC 映射（今天的生产就是这样），适配器就装不上——
   * 这一层照样去问，问到的是「没有」，于是一切与接这条路之前逐字相同。
   */
  it('反向探针：通用适配器没装上时，自建域上的脸与今天一模一样', () => {
    const before = dockFaceForPage({
      canonicalOrigin: 'https://careers.acme-corp.example',
      pathname: '/jobs/senior-engineer',
      connected: true,
      missionBound: true,
    });
    expect(before).not.toEqual({ kind: 'READY' });
  });

  it('反向探针：没连上账号时，通用路也不会把脸变成 READY', async () => {
    await withGenericInstalled();
    expect(dockFaceForPage({
      canonicalOrigin: 'https://careers.acme-corp.example',
      pathname: '/jobs/senior-engineer',
      connected: false,
      missionBound: true,
    })).not.toEqual({ kind: 'READY' });
  });

  it('反向探针：这一次没拿到规则包时，通用路也不放行', async () => {
    await withGenericInstalled();
    expect(dockFaceForPage({
      canonicalOrigin: 'https://careers.acme-corp.example',
      pathname: '/jobs/senior-engineer',
      connected: true,
      missionBound: true,
      rulesAvailable: false,
    })).not.toEqual({ kind: 'READY' });
  });

  it('反向探针：读不出的 origin 照旧藏起来，通用路不是万能钥匙', async () => {
    await withGenericInstalled();
    expect(dockFaceForPage({
      canonicalOrigin: 'not-a-url',
      pathname: '/jobs/senior-engineer',
      connected: true,
      missionBound: true,
    })).toEqual({ kind: 'HIDDEN' });
  });
});
