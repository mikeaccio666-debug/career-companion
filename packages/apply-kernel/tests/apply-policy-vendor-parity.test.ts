import { describe, expect, it } from 'vitest';

import { APPLY_VENDORS } from '../src/contracts';
import { createBundledApplyPolicy } from '../src/policy';
import { ADAPTERS } from '../src/bundledAdapters';

/**
 * 接入一个 ATS 要动**三个 total record**：`VENDOR_CATALOG`（候选人侧主机）、
 * `ADAPTERS`（解析器）、以及内置 policy 的 `vendors`（运行时开关）。
 * 前两个漏改会编译报错，第三个不会——它只是一个布尔值。
 *
 * 2026-08-01 接入 Lever 时实际漏掉了第三个，症状**完全静默**：
 *   content script 正常注入 ✓   MAIN bridge 正常安装 ✓   form 锚点也在 ✓
 *   → 但 `resolveApplyGate()` fail-closed 返回 null，浮层永远不出现，零报错。
 *   （resolveApplyGate 已随旧架构 applySurface 删除；门控判定本体 =
 *    policy.ts 的 isApplyPolicyEnabled/loadApplyPolicy，本测试仍直接覆盖。）
 * 而当时新写的 10 条 Lever 适配器测试**全绿**，因为它们只测适配器本身、
 * 不碰门控链。这条测试补的就是那个缺口。
 *
 * 在远程 policy 后端存在之前，内置 policy 里写 false 不是"等待远程打开"，
 * 而是"永久关闭"。所以有适配器 ⇔ 内置 policy 开启，是一个真正的双向不变量。
 */
describe('内置 policy 与适配器注册表必须一致', () => {
  const bundled = createBundledApplyPolicy();

  it('policy 覆盖全部厂商，没有漏项', () => {
    expect(Object.keys(bundled.vendors).sort()).toEqual([...APPLY_VENDORS].sort());
  });

  it.each(APPLY_VENDORS.map((v) => [v] as const))(
    '%s：有适配器 ⇔ 内置 policy 开启',
    (vendor) => {
      const wired = ADAPTERS[vendor] !== null;
      expect(
        bundled.vendors[vendor],
        wired
          ? `${vendor} 已接入适配器，但内置 policy 关着 —— 浮层会静默不出现`
          : `${vendor} 没有适配器，内置 policy 却开着 —— 会在一个读不到表单的页面上试图挂载`,
      ).toBe(wired);
    },
  );

  it('至少有一个厂商是开的（否则上面的断言全是空转）', () => {
    expect(Object.values(bundled.vendors).some(Boolean)).toBe(true);
  });

  /**
   * 原先这里有一条"至少有一个厂商是关的"的空转探针，用来证明上面的逐厂商断言
   * 不是恒真。2026-08-01 接入 Ashby 后四家全开，它按当初写下的约定退役——
   * 不改成宽松写法，而是换成一条不依赖"恰好有厂商没接入"的等价探针。
   */
  it('内置 policy 不是无条件全开 —— 未登记的厂商不会凭空为 true', () => {
    const bundledVendors = bundled.vendors as Readonly<Record<string, boolean>>;
    expect(bundledVendors['not-a-vendor']).toBeUndefined();
    // 且开关确实来自逐厂商登记，而不是某个默认真值。
    expect(Object.values(bundled.vendors).every((v) => typeof v === 'boolean')).toBe(true);
  });
});
