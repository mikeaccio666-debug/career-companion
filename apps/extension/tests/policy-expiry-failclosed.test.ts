import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 包内策略「静默过期」的防回归门禁（2026-08-18 事故）。
 *
 * 事故本身：`apply-kernel/src/policy.ts` 的 `bundledBuildTime()` 只读
 * `import.meta.env.VITE_VIBE_APPLY_POLICY_BUILT_AT`，而**全仓没有任何地方设过它**
 * （只有一处读 + 一处类型声明）。于是永远落到写死的兜底 `2026-07-29`，
 * +30 天 ⇒ `notAfter` 恒为 **2026-08-28**。
 *
 * 实测后果（不注入 policy、走生产默认）：`08-27 可填`；`08-29 三个字段全部
 * POLICY_DISABLED、零写入、用户端零报错`。**重新构建也不延期**——新包出生即过期。
 *
 * 为什么既有测试全都看不见：`tests/kernel-filler.test.ts` 与 apply-kernel 的
 * helpers 一律注入 `createBundledApplyPolicy(Date.now())`，注释写着
 * 「不然这套测试会在某个日期后无声全红」——**测试被专门做成对这个 bug 免疫**。
 *
 * 所以本文件锁的是另一头：**真配置里必须注入构建时刻**。
 * 它直接 import 真 `wxt.config.ts`（与 build-override-failclosed 同一手法），
 * 不读源码文本——正则能被绕过，import 不能。
 */

const ENV_KEYS = [
  'VIBE_DIST',
  'VIBE_API_BASE',
  'VIBE_WEB_BASE',
  'VIBE_EXECUTION_RUNTIME_BUNDLE_ENABLED',
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

/**
 * 注入值形如 `vibe-policy-built-at:2026-08-19T…Z`。前缀是产物门禁的判据
 * （见 `scripts/check-policy-timestamp-baked.mjs`）——Vivian 二次 Blocking
 * 实测：门禁若只扫任意 ISO，在别处塞一个 2099 就能顶替。
 * 三处同源：wxt.config 注入、policy.ts 解析、门禁判据、以及这里。
 */
const BUILT_AT_MARKER = 'vibe-policy-built-at:';
function strip(value: string): string {
  expect(value.startsWith(BUILT_AT_MARKER), `注入值缺少 ${BUILT_AT_MARKER} 前缀——产物门禁会认不出它`).toBe(true);
  return value.slice(BUILT_AT_MARKER.length);
}

async function loadDefines(): Promise<Record<string, string>> {
  vi.resetModules();
  const config = (await import('../wxt.config')).default as {
    vite?: () => { define?: Record<string, string> };
  };
  const define = config.vite?.().define;
  expect(define, 'wxt.config 没有 vite().define——注入通道不存在').toBeTruthy();
  return define!;
}

describe('包内策略构建时刻必须被注入（否则包会静默过期）', () => {
  it('define 里有 __VIBE_APPLY_POLICY_BUILT_AT__', async () => {
    const define = await loadDefines();
    expect(
      define.__VIBE_APPLY_POLICY_BUILT_AT__,
      '构建期没有注入策略构建时刻——apply-kernel 会落到写死的兜底日期，' +
        '产出的包 30 天后静默停止填写，且重新构建也不延期（铁律 6 的 72 小时静默自杀）',
    ).toBeTruthy();
  });

  it('注入的是一个当下的时间戳，不是写死的日期', async () => {
    const define = await loadDefines();
    const injected = Date.parse(strip(JSON.parse(define.__VIBE_APPLY_POLICY_BUILT_AT__!)));
    expect(Number.isFinite(injected), '注入值不是合法时间戳').toBe(true);
    const ageMs = Date.now() - injected;
    expect(
      ageMs >= 0 && ageMs < 5 * 60_000,
      `注入的构建时刻距今 ${Math.round(ageMs / 86_400_000)} 天——` +
        '它应该是"本次构建的此刻"。写死的日期会让新构建出来就已经用掉了一部分寿命',
    ).toBe(true);
  });

  it('按注入值算出的策略寿命是完整的 30 天（新包不是出生即过期）', async () => {
    const define = await loadDefines();
    const builtAt = Date.parse(strip(JSON.parse(define.__VIBE_APPLY_POLICY_BUILT_AT__!)));
    const { createBundledApplyPolicy } = await import('@edaix/apply-kernel/policy');
    const notAfter = createBundledApplyPolicy(builtAt).notAfter;
    const days = Math.round((notAfter - Date.now()) / 86_400_000);
    expect(
      days >= 29,
      `本次构建产出的包只剩 ${days} 天寿命——低于 30 天说明 builtAt 不是构建时刻`,
    ).toBe(true);
  });
});

/**
 * ⚠️ 上面那一组不够——**它证明不了 policy.ts 真的读那个 define**。
 *
 * Vivian 审查（2026-08-18 Blocking）做了反向变异：把
 * `bundledBuildTime()` 里读 `__VIBE_APPLY_POLICY_BUILT_AT__` 那一段删掉、
 * 退回只读旧的 `VITE_*` env，重跑本文件 —— **3/3 仍然通过，退出码 0**。
 *
 * 原因：上面的用例只从 `wxt.config` 取出 define，再把 `builtAt`
 * **显式传给** `createBundledApplyPolicy`，完全绕过默认参数与真实 wiring。
 * 也就是说它锁的是「配置里有这个 define」，不是「策略会用它」——
 * 而本 PR 要防的回归恰恰是后者（consumer 没接上，或误写成 `globalThis.`）。
 *
 * 本组走**默认参数路径**：`createBundledApplyPolicy()` 不传参，
 * 逼它去调 `bundledBuildTime()`。
 */
describe('默认消费者必须真的读注入值（Vivian 的反向变异要能红）', () => {
  const INJECTED = '2026-09-05T00:00:00.000Z';
  const HARDCODED_FALLBACK = Date.UTC(2026, 6, 29);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function bundledNotAfter(): Promise<number> {
    vi.resetModules();
    const { createBundledApplyPolicy } = await import('@edaix/apply-kernel/policy');
    // 刻意**不传参**——这一句就是本组存在的全部理由。
    return createBundledApplyPolicy().notAfter;
  }

  it('注入了就用注入的，不用写死兜底', async () => {
    vi.stubGlobal('__VIBE_APPLY_POLICY_BUILT_AT__', INJECTED);
    const notAfter = await bundledNotAfter();

    expect(
      notAfter,
      '包内策略的有效期没跟着注入值走——说明 policy.ts 根本没读那个 define，' +
        '包会永远按写死的 2026-07-29 计算，出生即过期',
    ).toBeGreaterThan(Date.parse(INJECTED));

    // 兜底值是 07-29 + 30 天。注入 09-05 之后不该再落在那附近。
    expect(notAfter).toBeGreaterThan(HARDCODED_FALLBACK + 30 * 86_400_000);
  });

  it('没注入时才回落到写死兜底（fail-closed，不是随构建时间漂移）', async () => {
    // 兜底刻意不用 Date.now()：那会让每次重载都变成崭新的 30 天，
    // 「硬过期」这个性质就没了。
    const notAfter = await bundledNotAfter();
    expect(notAfter).toBe(HARDCODED_FALLBACK + 30 * 86_400_000);
  });

  it('注入值不合法时也回落兜底，不炸也不放行', async () => {
    vi.stubGlobal('__VIBE_APPLY_POLICY_BUILT_AT__', 'not-a-date');
    expect(await bundledNotAfter()).toBe(HARDCODED_FALLBACK + 30 * 86_400_000);
  });
});
