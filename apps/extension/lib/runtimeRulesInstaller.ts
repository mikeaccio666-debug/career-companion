/**
 * 规则包装载：装上了才算成功，而且只算到这一份自己声明的新鲜期为止。
 *
 * MV3 的 worker 起来时取一次规则包并装成适配器表。原来那一行是
 * `let applyAdaptersInstalled = refresh().then(...)`——**算一次，记一辈子**，
 * 包括记住失败。
 *
 * 2026-09-18 生产事故把这件事的代价摆了出来：后端 503 了几分钟，插件装了空表；
 * 后端恢复之后，**已经起来的那些 worker 仍然是空表**，用户那边一直显示认不出
 * 申请页，直到 worker 恰好闲置回收再起来。MV3 的 worker 在有活动时能活很久。
 * 那一次把「失败」改成了可重试。
 *
 * 2026-09-22 用生产包实测到剩下的那一半，两处都在「成功」这一侧：
 *
 *  · **装出空表也算成功。** `install`（`installApplyAdaptersFromRules`）编译不过
 *    时装空表并返回 0，**不抛错**——后端放行了这个版本不认识的厂商就是这个形状，
 *    整份 release 验不过。于是 `rules()` 从此返回非 null，浮层据此判「规则拿到
 *    了，是这一页认不出」，说出「这一页没有认出申请表」；而识别读的那张表是空的，
 *    每一页都认不出。那句话把一次运维故障伪装成覆盖面问题，正是 2026-09-18
 *    事故栽的同一句。现在按**装上了几家**判：0 家就是没装上，照失败走——浮层
 *    说「暂时取不到填写规则」，30 秒后自己再试。
 *
 *  · **成功记一辈子。** 后端连发三版（apply-rules-2026-09-22.2 → .3 → .4），
 *    正在运行的 worker 一直没换上新包，直到在 chrome://extensions 里手动重载
 *    扩展。用户不该为了一次后端发版去重载扩展。现在这条记录带到期时间：
 *    到点了下一次报到就重新去问，装上新的就换上。
 *
 * ## 到期时间取两者中先到的那个
 *
 *  · **这一份自己声明的 `freshUntil`**：过了它，`executionRuntimeBundleClient`
 *    的 `classifyUsable` 本来就会拒（`RUNTIME_BUNDLE_STALE`）。装载器不得比它
 *    更宽，否则 worker 内存里这条记录等于给一份已经过期的包续命。
 *  · **一个我们自己的复查上限**（默认 5 分钟）：`freshUntil` 说的是「这份能用
 *    多久」，不是「多久发一次版」。2026-09-22 线上那一份实测是
 *    `issuedAt` 2026-09-01 → `freshUntil` 2027-03-01，**181 天**——只认它的话，
 *    一个活着的 worker 可以半年不换包。传不下去的发版等于没发。复查是**按需**
 *    的——只在有页面报到时才发生，而且走的是带 `if-none-match` 的条件请求，
 *    没换版就是一个 304。
 *
 * ## 重试不是「沿用缓存」
 *
 * 这两件事看着像，差别是决定性的。沿用缓存 = 拿旧授权当现在的授权，
 * RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED 明确禁止（而且 503 与运营方的 kill switch
 * 长得一模一样，沿用缓存等于让停止键失效）。**重试是重新去问后端**：它关着就
 * 照旧关着，它开着我们才恢复。闸一点没动。
 *
 * 复查失败时同样不保留手上这一份：装空表、答 null。代价是后端抖一下，活着的
 * worker 也会跟着说一句「暂时取不到填写规则」——那正是冷启动的 worker 一直以来
 * 的表现（它们 30 秒闲置就回收，本来就占绝大多数），而且它是一句会自己好的话。
 *
 * ## 为什么要节流
 *
 * 没有节流的话，一个持续 503 的后端会被每一次页面报到各打一枪。节流不是为了
 * 省流量，是为了不在后端已经出事的时候再加一份负载。
 */

export interface RuntimeRulesInstaller {
  /**
   * 这一次该用的规则；装不上时是 `null`。
   *
   * 同时到达的调用共享同一次在途请求——一个页面上多个帧同时报到是常态，
   * 不该变成多次取数。
   */
  rules(): Promise<unknown>;
}

/** 成功之后，最多隔这么久就再问一次后端——发版要能传到活着的 worker。 */
const DEFAULT_RECHECK_AFTER_MS = 300_000;
/** 上一次失败之后，至少隔这么久才再试。 */
const DEFAULT_RETRY_AFTER_MS = 30_000;

export function createRuntimeRulesInstaller(input: Readonly<{
  /**
   * 取规则包；返回体由调用方判定成功与否。
   *
   * `freshUntilMs` 是这一份包自己声明的新鲜期终点（`bundle.freshUntil`）。
   * 省略时只受复查上限约束。
   */
  refresh: () => Promise<Readonly<{ ok: true; rules: unknown; freshUntilMs?: number } | { ok: false }>>;
  /**
   * 把规则装成适配器表，返回**装上了几家**；`null` 表示装空表（识别 fail closed）。
   *
   * 0 不是成功：规则取到了、一家都没装上，识别与装不上规则时同样全数 fail closed，
   * 说法也必须一样。
   */
  install: (rules: unknown) => Promise<number>;
  now?: () => number;
  /** 上一次失败之后，至少隔这么久才再试。 */
  retryAfterMs?: number;
  /** 上一次成功之后，最多隔这么久就再问一次后端。 */
  recheckAfterMs?: number;
}>): RuntimeRulesInstaller {
  const now = input.now ?? Date.now;
  const retryAfterMs = positiveMsOr(input.retryAfterMs, DEFAULT_RETRY_AFTER_MS);
  const recheckAfterMs = positiveMsOr(input.recheckAfterMs, DEFAULT_RECHECK_AFTER_MS);

  /** 最近一次**真的装上了**的规则，带到期时间。 */
  let current: Readonly<{ rules: unknown; until: number }> | null = null;
  let inFlight: Promise<unknown> | null = null;
  let failedAt: number | null = null;

  /** 这一次没有可证实的授权：手上那一份也不再算数，留待重试。 */
  function giveUp(): null {
    current = null;
    failedAt = now();
    return null;
  }

  /** 到期点取「这一份自己说的」与「我们自己的复查上限」中先到的那个。 */
  function expiryFor(freshUntilMs: number | undefined): number {
    const ceiling = now() + recheckAfterMs;
    return typeof freshUntilMs === 'number' && Number.isFinite(freshUntilMs) && freshUntilMs < ceiling
      ? freshUntilMs
      : ceiling;
  }

  async function attempt(): Promise<unknown> {
    const resolved = await input.refresh();
    if (!resolved.ok) {
      // 装空表，不是「保持上一次的表」：这一次没有可证实的授权，
      // 那就什么都不认。
      await input.install(null);
      return giveUp();
    }
    // 装上了几家。0 家 = 空表：规则取到了，但一家都编译不出来（后端放行了这个
    // 版本不认识的厂商时，整份 release 验不过就是这个形状）。表既然是空的，
    // 就不能对外说成「规则拿到了」——那会让浮层把运维故障说成覆盖面问题。
    if ((await input.install(resolved.rules)) <= 0) return giveUp();
    current = Object.freeze({ rules: resolved.rules, until: expiryFor(resolved.freshUntilMs) });
    failedAt = null;
    return resolved.rules;
  }

  return Object.freeze({
    rules(): Promise<unknown> {
      if (inFlight !== null) return inFlight;
      // 手上这一份还在新鲜期里：直接用，不打扰后端。
      if (current !== null && now() < current.until) return Promise.resolve(current.rules);
      // 上一次失败之后还没到重试点：把那次的结果（空表）原样交回去，
      // 不再打扰一个已经出事的后端。
      if (failedAt !== null && now() - failedAt < retryAfterMs) return Promise.resolve(null);
      inFlight = attempt()
        .catch(async () => {
          await input.install(null).catch(() => undefined);
          return giveUp();
        })
        .finally(() => { inFlight = null; });
      return inFlight;
    },
  });
}

function positiveMsOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}
