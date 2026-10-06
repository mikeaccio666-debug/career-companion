/**
 * worker 收到 dock 那几条「在这一页上发生了什么」的消息时，对发信人的核对。
 *
 * 四个条件，一个都不放松：
 *
 * 1. `sender.id` 是我们自己的扩展——不是别的扩展转发来的；
 * 2. 顶层帧（`frameId === 0`）——iframe 里的内容脚本不在这条路上；
 * 3. 有标签页 id——dock 只活在标签页里；
 * 4. 发信人所在页面的 **origin 与 pathname** 与消息里报的逐字相等。
 *
 * ## 为什么比的是 origin + pathname，而不是整条 URL
 *
 * 原先四处各写一遍 `sender.url !== \`${origin}${pathname}\``。`sender.url` 是
 * 那个帧的完整 URL，带查询串与片段——而申请页常常就是带着 `?gh_src=…`、
 * `?source=LinkedIn` 打开的（用户从职位站点点过来）。整条比对在这类页面上必然
 * 不等，于是 PROFILE / DISCOVERY_AUTHORITY 都被静默拒掉，浮层报「档案暂时读不到」，
 * 而真正的原因是链接尾巴上多了一个追踪参数。
 *
 * 查询串与片段不改变「这是哪一页、哪个站」；发信人是不是我们的内容脚本、在不在
 * 那个 origin 上，仍由前三条和 origin 比对保证。只忽略这两段，不忽略别的。
 *
 * ## 单页应用改过地址：比「文档加载时的路径」
 *
 * `sender.url` 停在这份文档**加载时**的地址上——单页应用之后用 pushState 改的，Chrome
 * 不跟；内容脚本读到的 `location.pathname` 却是改过的。2026-09-22 nvidia.wd5 实测：草稿
 * 建立之后申请页一加载就从 …/apply/applyManually 改成 …/apply，此后每一条消息都在这里
 * 被默默丢掉，浮层只说「没能取得填写授权」。Ashby / Workable 从岗位页切到申请页也是
 * 同一个形状。
 *
 * 所以消息在地址被改过时多带一项 `documentPathname`：**它**与 `sender.url` 的路径逐字比，
 * 这一条一点不放松；`pathname`（当前路径）交给后面去判这是不是申请页。当前路径只可能在
 * 同一个 origin 里——跨 origin 的导航会换一份文档、换一个内容脚本，origin 比对照旧。
 */
import { frameFormForSender, isChildFrameId, type FrameFormRegistry } from './frameFormRegistry';

export interface SenderPageLike {
  readonly id?: string;
  readonly frameId?: number;
  readonly url?: string;
  readonly tab?: { readonly id?: number };
}

/**
 * 子帧持表时的放宽（P2-10）：发信人也可以是**登记过的那一帧**——frameId 与登记一致、
 * 它此刻的 origin + pathname 与登记逐字相等、且与消息里报的页面相等。其余条件一条不放松：
 * 仍然必须是我们自己的扩展、必须有标签页 id。顶层帧照旧走上面那四条。
 */
export function senderTabForPageOrFrame(
  sender: SenderPageLike,
  extensionId: string,
  page: SenderPageClaim,
  frameForms: FrameFormRegistry,
): number | null {
  const top = senderTabForPage(sender, extensionId, page);
  if (top !== null) return top;
  if (sender.id !== extensionId || !isChildFrameId(sender.frameId)) return null;
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) return null;
  if (typeof sender.url !== 'string') return null;
  const entry = frameFormForSender(frameForms, tabId, sender.frameId, sender.url);
  if (entry === null) return null;
  return entry.canonicalOrigin === page.origin && entry.pathname === page.pathname ? tabId : null;
}

/** 消息里报的页面：当前路径，以及（地址被单页应用改过时）文档加载时的路径。 */
export type SenderPageClaim = Readonly<{ origin: string; pathname: string; documentPathname?: string }>;

export function senderTabForPage(
  sender: SenderPageLike,
  extensionId: string,
  page: SenderPageClaim,
): number | null {
  if (sender.id !== extensionId || sender.frameId !== 0) return null;
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) return null;
  if (typeof sender.url !== 'string') return null;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return null;
  }
  if (url.origin !== page.origin) return null;
  if (url.pathname !== page.pathname && url.pathname !== page.documentPathname) return null;
  return tabId;
}
