/**
 * 门户连接 URL。
 *
 * 打的是门户现成、可用的握手完成页 `/extension-auth/complete`：未登录时它把三个参数
 * 原样带去 `/login` 再带回来，登录后调 `createExtensionHandoff` 并把 code 发给插件——
 * 就是 `bindExtensionAccount` 那三步。
 *
 * ## 为什么不再打 /career/settings（2026-09-20 改）
 *
 * 设置页的连接卡 09-16 被有意删除（argoland `635ef2f8`，「绑定移到 Start applying」）；
 * `app-shell.tsx` 的自动绑定 effect 在 main 上但线上不触发，且按设计失败静默；
 * 未登录时 `(career)/layout.tsx` 跳 `/login` **不带参数**，身份在那一跳原样丢掉。
 * 三件事叠起来的结果：除了手工握手，新用户没有任何办法把插件连上。
 *
 * ## state
 *
 * 完成页多要一个 `state`（`STATE_RE = /^[A-Za-z0-9._~-]{16,256}$/`），它用这个 state 去
 * 建 handoff，插件兑换时用的是自己 pending 的 state——两者必须是同一个，所以由 worker
 * 在开门前预铸（`authHandoff` 的 `beginPending()`，64 位十六进制，TTL 600s）。
 * 它是一次性 nonce：进了浏览器历史与 referrer 也换不来任何东西，兑换还要门户签发的
 * code。以前不带 state 的顾虑（「像凭据却不是凭据」）就是这个意思，如今照实写在这里。
 *
 * `source=extension` + `extensionId` 是门户既有约定（argoland `lib/auth/extension-auth.ts`
 * 的 `readExtensionAuthRequest`）。门户在构建期不钉任何 extension id，身份只能由扩展
 * 在打开门户时自报。直接打终点路径，不经过会丢参数的重定向。
 */
export const PORTAL_CONNECT_PATH = '/extension-auth/complete';

/** 与门户 `readExtensionAuthRequest` 的 STATE_RE 一字不差。 */
const STATE_RE = /^[A-Za-z0-9._~-]{16,256}$/;

export function portalConnectUrl(portalOrigin: string, extensionId: string, state: string): string {
  // 门户对不合格的 state 会渲染「Invalid request」，用户只看到一句无法解释的话。
  // 在这里就拒，让错误发生在有稳定原因码的一侧。
  if (!STATE_RE.test(state)) throw new Error('PORTAL_CONNECT_STATE_INVALID');
  const url = new URL(PORTAL_CONNECT_PATH, portalOrigin);
  url.searchParams.set('source', 'extension');
  url.searchParams.set('extensionId', extensionId);
  url.searchParams.set('state', state);
  return url.href;
}
