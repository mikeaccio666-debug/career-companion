import { createPilotUa5ConnectedPageReady } from './pilotUa5ConnectedProtocol';

/**
 * 单页应用改过地址时，dock 消息要多带的那一项：这份文档**加载时**的路径。
 *
 * `sender.url` 停在文档加载时的地址上——单页应用之后用 pushState 改的，Chrome 不跟；内容脚本读到的
 * `location.pathname` 却是改过的。worker 的发信人核对（senderPage.ts）拿两者逐字比，于是这类页面上
 * 每一条「这一页上发生了什么」的消息都被默默丢掉。2026-09-22 nvidia.wd5 实测：草稿建立后申请页一加载
 * 就从 …/apply/applyManually 改成 …/apply；用改过的路径要授权，worker 不答，用加载时的路径要，立刻给。
 *
 * 消息里 `pathname` 仍是当前路径（worker 用它判这是不是申请页）；`documentPathname` 只在两者不同时带，
 * worker 拿它与 `sender.url` 逐字比。
 */

const KEY = 'documentPathname';

/** 这份文档加载时的路径：导航条目上的地址（重定向之后的那一个）。读不到、或不在同一个 origin，就退回当前路径。 */
export function documentPathname(doc: Document = document): string {
  const current = doc.location.pathname;
  try {
    const entry = doc.defaultView?.performance?.getEntriesByType?.('navigation')?.[0];
    const name = entry?.name;
    if (typeof name !== 'string' || name === '') return current;
    const loaded = new URL(name);
    return loaded.origin === doc.location.origin ? loaded.pathname : current;
  } catch {
    // 读不到导航条目就当地址没被改过——与加这一项之前的行为逐字相同。
    return current;
  }
}

/** 给一条要发给 worker 的 dock 消息补上 `documentPathname`；地址没被改过就原样返回（消息逐字不变）。 */
export function withDocumentPath<T extends object>(message: T | null, doc: Document = document): T | null {
  if (message === null) return null;
  const loaded = documentPathname(doc);
  return loaded === doc.location.pathname ? message : Object.freeze({ ...message, [KEY]: loaded }) as T;
}

/** worker 这一侧的精确键集核对：先把这个可选键拿掉，其余照旧逐字比。 */
export function keysBesidesDocumentPath(value: object): string[] {
  return Object.keys(value).filter((key) => key !== KEY);
}

/**
 * worker 这一侧读这一项。`undefined`：没带；`null`：带了但不是合法的页面路径——整条消息作废，
 * 与 `pathname` 不合法同一个下场。合法的按与 `pathname` 同一套规则规范化。
 */
export function readDocumentPathname(candidate: Readonly<Record<string, unknown>>, origin: string): string | undefined | null {
  if (!Object.hasOwn(candidate, KEY)) return undefined;
  const value = candidate[KEY];
  if (typeof value !== 'string') return null;
  return createPilotUa5ConnectedPageReady(origin, value)?.pathname ?? null;
}

/** 解析结果里要不要带这一项：与当前路径相同就不带（worker 只看它在不同的时候）。 */
export function documentPathField(loaded: string | undefined, pathname: string): { readonly documentPathname?: string } {
  return loaded === undefined || loaded === pathname ? {} : { documentPathname: loaded };
}
