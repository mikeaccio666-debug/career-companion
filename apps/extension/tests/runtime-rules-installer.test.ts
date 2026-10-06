import { describe, expect, it, vi } from 'vitest';
import { createRuntimeRulesInstaller } from '../lib/runtimeRulesInstaller';

/**
 * 2026-09-18 事故的第二半：后端恢复了，插件没有自己好。
 *
 * worker 起来时取一次规则包，**算一次记一辈子**，包括记住失败。后端 503 的那
 * 几分钟里起来的 worker 装了空表，之后一直是空表——用户那边持续显示「认不出
 * 申请页」，直到 worker 恰好闲置回收。MV3 的 worker 在有活动时能活很久。
 */

function harness(input: Partial<Parameters<typeof createRuntimeRulesInstaller>[0]> & {
  outcomes?: readonly ({ ok: true; rules: unknown; freshUntilMs?: number } | { ok: false })[];
} = {}) {
  const queue = [...(input.outcomes ?? [])];
  const refresh = vi.fn(async () => queue.shift() ?? { ok: false as const });
  // 装载器读的是**装上了几家**：`installApplyAdaptersFromRules` 编译不过时装空表
  // 并返回 0，不抛错。空表与装上了必须分得开，否则前者会被当成功记下来。
  const install = vi.fn(async (rules: unknown) => (rules === null ? 0 : 7));
  let clock = 1_000;
  const installer = createRuntimeRulesInstaller({
    refresh, install, now: () => clock, retryAfterMs: 30_000, ...input,
  });
  return { installer, refresh, install, tick: (ms: number) => { clock += ms; } };
}

const RULES = { vendor: 'greenhouse' };

describe('成功之后，复查点之前不再取', () => {
  it('第二次直接用第一次的结果', async () => {
    const h = harness({ outcomes: [{ ok: true, rules: RULES }] });
    expect(await h.installer.rules()).toBe(RULES);
    expect(await h.installer.rules()).toBe(RULES);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('同时到达的调用共享同一次在途请求', async () => {
    // 一个页面上多个帧同时报到是常态，不该变成多次取数。
    const h = harness({ outcomes: [{ ok: true, rules: RULES }] });
    const [a, b] = await Promise.all([h.installer.rules(), h.installer.rules()]);
    expect(a).toBe(RULES);
    expect(b).toBe(RULES);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('失败之后要能自己好', () => {
  it('过了重试点就重新去问后端，成功即恢复', async () => {
    const h = harness({ outcomes: [{ ok: false }, { ok: true, rules: RULES }] });
    expect(await h.installer.rules()).toBeNull();
    h.tick(30_000);
    expect(await h.installer.rules()).toBe(RULES);
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('失败时装的是空表——这一次没有可证实的授权，就什么都不认', async () => {
    const h = harness({ outcomes: [{ ok: false }] });
    await h.installer.rules();
    expect(h.install).toHaveBeenCalledWith(null);
  });

  it('refresh 抛错也照样装空表并留待重试', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true, rules: RULES });
    let clock = 0;
    const h = harness({ refresh, now: () => clock });
    expect(await h.installer.rules()).toBeNull();
    expect(h.install).toHaveBeenCalledWith(null);
    clock = 30_000;
    expect(await h.installer.rules()).toBe(RULES);
  });
});

describe('节流：不在后端已经出事的时候再加负载', () => {
  it('重试点之前不再打扰它', async () => {
    const h = harness({ outcomes: [{ ok: false }] });
    await h.installer.rules();
    h.tick(29_999);
    expect(await h.installer.rules()).toBeNull();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('连续失败各自重新计时，不会越退越久也不会不停打', async () => {
    const h = harness({ outcomes: [{ ok: false }, { ok: false }, { ok: true, rules: RULES }] });
    await h.installer.rules();
    h.tick(30_000);
    expect(await h.installer.rules()).toBeNull();
    h.tick(29_999);
    expect(h.refresh).toHaveBeenCalledTimes(2);
    h.tick(1);
    expect(await h.installer.rules()).toBe(RULES);
    expect(h.refresh).toHaveBeenCalledTimes(3);
  });
});

describe('重试不是「沿用缓存」', () => {
  it('每一次重试都真的去问后端——它关着就照旧关着', async () => {
    // 沿用缓存 = 拿旧授权当现在的授权，会让运营方的 kill switch 失效
    // （503 与 kill switch 长得一模一样）。重试是重新问，闸一点没动。
    const h = harness({ outcomes: [{ ok: false }, { ok: false }] });
    expect(await h.installer.rules()).toBeNull();
    h.tick(30_000);
    expect(await h.installer.rules()).toBeNull();
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.install).toHaveBeenNthCalledWith(1, null);
    expect(h.install).toHaveBeenNthCalledWith(2, null);
  });
});

/**
 * 2026-09-22 生产实测：后端连发三版（apply-rules-2026-09-22.2 → .3 → .4，
 * releaseRevision 7 → 8），**正在运行的 worker 一直没换上新包**，此后每一页浮层
 * 都说「这一页没有认出申请表」，直到在 chrome://extensions 里手动重载扩展才好。
 *
 * 两处一起造成的：
 *
 *  · `install` 编译不过时装的是空表却**不抛错**（`installApplyAdaptersFromRules`
 *    返回 0），于是 `attempt()` 当成功办：`rules()` 从此返回非 null，浮层据此
 *    判「规则拿到了，是这一页认不出」——把一次运维故障说成覆盖面问题，正是
 *    2026-09-18 事故那句话。而识别读的装入表是空的，所有页面一律认不出。
 *
 *  · 成功之后 `settled` 记一辈子：换了 release 不会重新装，过了这一份自己声明的
 *    `freshUntil` 也照旧供着——`classifyUsable` 本来会拒的包，被 worker 内存里
 *    这条记录续了命。
 */
describe('装出空表不算成功', () => {
  it('规则取到了但一个厂商都没装上：答 null，让浮层说「暂时取不到填写规则」', async () => {
    // 后端放行了这个版本不认识的厂商时就是这个形状：整份 release 验不过，
    // `createRuntimeApplyRegistry` 失败 → 装空表 → 返回 0。规则**取到了**，
    // 但识别一家都认不出。这两件事必须一起说出来，否则浮层会说错话。
    const h = harness({ outcomes: [{ ok: true, rules: RULES }], install: async () => 0 });
    expect(await h.installer.rules()).toBeNull();
  });

  it('空表不被记一辈子：过了重试点重新去问后端，装上了就恢复', async () => {
    const install = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(7);
    const h = harness({
      outcomes: [{ ok: true, rules: RULES }, { ok: true, rules: RULES }],
      install,
    });
    expect(await h.installer.rules()).toBeNull();
    h.tick(30_000);
    expect(await h.installer.rules()).toBe(RULES);
  });
});

describe('运行中的 worker 要换上新包', () => {
  const NEXT = { vendor: 'greenhouse', release: 8 };

  it('后端换了一版：不必重载扩展，下一次报到就重新去问并装上新包', async () => {
    const h = harness({
      outcomes: [{ ok: true, rules: RULES }, { ok: true, rules: NEXT }],
    });
    expect(await h.installer.rules()).toBe(RULES);
    h.tick(300_000);
    expect(await h.installer.rules()).toBe(NEXT);
    expect(h.install).toHaveBeenLastCalledWith(NEXT);
  });

  it('复查点之前照旧用手上这一份，不是每报到一次问一次', async () => {
    const h = harness({ outcomes: [{ ok: true, rules: RULES }] });
    expect(await h.installer.rules()).toBe(RULES);
    h.tick(299_999);
    expect(await h.installer.rules()).toBe(RULES);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('过了这一份自己声明的 freshUntil 就不再供它——哪怕复查点还没到', async () => {
    // `classifyUsable` 在客户端那侧本来就会拒一份过了 freshUntil 的包；
    // 装载器不得比它更宽，否则 worker 内存里这条记录等于给过期包续命。
    const h = harness({
      outcomes: [{ ok: true, rules: RULES, freshUntilMs: 60_000 }, { ok: false }],
    });
    expect(await h.installer.rules()).toBe(RULES);
    h.tick(59_000);
    expect(await h.installer.rules()).toBeNull();
    expect(h.install).toHaveBeenLastCalledWith(null);
  });
});
