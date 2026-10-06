/**
 * 装完之后把人带到连接页（2026-09-22）。
 *
 * 在此之前 worker 里**一个 `onInstalled` 都没有**：用户装完插件，浏览器停在原地，
 * 没有任何一句话告诉他下一步是回官网登录。商店安装尤其如此——Chrome 装完只把
 * 图标塞进工具栏，而我们的入口是页面上的浮层，浮层又只在十四个主机上出现。
 * 于是新用户装完之后最可能的经历是：什么都没发生。
 *
 * 开的就是浮层「登录」按钮开的那一个页面（`portalConnectUrl` → 门户的
 * `/extension-auth/complete`），所以这条路和既有的连接握手逐字相同，不是第二条路。
 *
 * ## 只在「第一次装」时开
 *
 * `onInstalled` 在版本更新、Chrome 自身更新、共享模块更新时同样会响。那几种情况下
 * 用户正在做别的事，弹一个标签页是打扰而不是帮助——尤其商店版会**自动更新**，
 * 每次静默更新都抢一次焦点是不能接受的。
 *
 * ## 已经连上就不开
 *
 * 解压加载的包重新加载时也报 `install`。那时候会话可能还在，再把人推去登录一次
 * 既多余又像是掉线了。
 */

/** `chrome.runtime.OnInstalledReason`，这里只按字符串比，不依赖浏览器枚举。 */
export type ExtensionInstallReason = string;

export function shouldOpenConnectOnInstall(
  input: Readonly<{ reason: ExtensionInstallReason; connected: boolean }>,
): boolean {
  if (input.reason !== 'install') return false;
  return !input.connected;
}

/**
 * 装完开的那个连接页，连上之后去哪（2026-09-23）。
 *
 * 门户在握手落地后发 `VIBE_OPEN_OPTIONS`，请我们「打开设置页并关掉这个标签页」。dock 没有
 * 设置页，从前一律关掉——从申请页浮层点「登录」时这正对：关掉就回到申请页。可第一次安装时
 * 没有申请页可回：浏览器已登录 argoland.ai 的人看到的是一个标签页闪一下就没了，以为什么都
 * 没发生（负责人 2026-09-23 实测）。所以装完开的那一页改去门户资料页：补资料、在保存按钮旁
 * 勾代填同意，都在那里。浮层发起的连接照旧关掉。
 *
 * 那一页的 tabId 存 storage.session：注册、登录要好几分钟，SW 早换过实例。一小时后作废。
 */
export const FIRST_RUN_CONNECT_TAB_KEY = 'firstRunConnectTabV1';
const FIRST_RUN_CONNECT_TAB_TTL_MS = 60 * 60 * 1000;

export type FirstRunConnectTab = Readonly<{ tabId: number; expiresAt: number }>;

export function firstRunConnectTab(tabId: number, nowMs: number): FirstRunConnectTab {
  return { tabId, expiresAt: nowMs + FIRST_RUN_CONNECT_TAB_TTL_MS };
}

/** 从 storage.session 读回来的值：形状不对就当没有。 */
export function parseFirstRunConnectTab(value: unknown): FirstRunConnectTab | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { tabId, expiresAt } = value as Record<string, unknown>;
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return { tabId, expiresAt };
}

/** 连上之后这个标签页怎么办：装完开的那一页 → 资料页；别的（浮层发起的）→ 关掉。 */
export function landingAfterConnect(
  senderTabId: number,
  firstRun: FirstRunConnectTab | null,
  nowMs: number,
): 'PROFILE' | 'CLOSE' {
  return firstRun !== null && firstRun.tabId === senderTabId && nowMs < firstRun.expiresAt ? 'PROFILE' : 'CLOSE';
}
