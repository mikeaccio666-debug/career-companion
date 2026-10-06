/**
 * 等一样东西，最多等多久（2026-10-04）。
 *
 * 到点了交回 `DEADLINE_PASSED`，与「答了 null」「答了别的」分得开——调用方据此说「没有响应」或「太慢」，不把它混进别的失败。
 * 那件事本身照旧跑完（这里不取消它）；它的结局到点之后没人要。答了就清掉计时器，不留一个空转的定时器。
 */
export const DEADLINE_PASSED: unique symbol = Symbol('DEADLINE_PASSED');

export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof DEADLINE_PASSED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<typeof DEADLINE_PASSED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_PASSED), ms);
  });
  return Promise.race([promise, passed]).finally(() => clearTimeout(timer));
}

/**
 * worker 答一次档案最多用多久（四个接口并行，每个请求 8 秒、先可能换一次 token，见 profileClient 的 PROFILE_REQUEST_TIMEOUT_MS）：
 * 到点就照实答「太慢」（REFUSED TIMEOUT）。
 */
export const PROFILE_REPLY_BUDGET_MS = 15_000;
/**
 * 内容脚本问 worker 一件事最多等多久：比 worker 自己的时限长，只在 worker 根本没答（被停掉、消息丢了）时才用上，
 * 那时浮层说「插件没有响应」（WORKER_UNREACHABLE），不一直停在「正在对照你的资料」。
 */
export const ASK_WORKER_DEADLINE_MS = 20_000;
