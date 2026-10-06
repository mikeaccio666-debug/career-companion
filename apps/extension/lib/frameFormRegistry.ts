import { parseCanonicalPathname, parseExactHttpsOrigin } from './tabRegistry';

/**
 * 子帧持表登记（P2-10，白标 A：官方嵌入 iframe）。
 *
 * 顶层帧的报到表（tabRegistry）说的是「这个标签页停在哪一页」；这张表说的是
 * 「这个标签页的申请表在哪一帧」。两张表分开：子帧永远不写报到表（2026-09-18 事故：
 * reCAPTCHA 的 iframe 把顶层那条盖掉），报到表也永远不由子帧覆盖。
 *
 * 一个标签页只记一帧，**先来的算数**：两个子帧都认出表单时只给第一个（页面里再嵌一层的
 * 情况，真持表的那一帧先报到）。记录随标签页关闭、顶层换页而清。只存 frameId + exact
 * origin + pathname，无字段值、无 DOM。
 */
export interface RegisteredFrameForm {
  readonly tabId: number;
  readonly frameId: number;
  readonly canonicalOrigin: string;
  readonly pathname: string;
  readonly at: number;
}

export type FrameFormRegistry = Readonly<Record<string, RegisteredFrameForm>>;

export interface BridgeFrameForm {
  readonly canonicalOrigin: string;
  readonly pathname: string;
}

/** 子帧报「我这一帧持有申请表」。与 `bridge/hello` 同一套 exact-key + https origin + canonical pathname 校验。 */
export function parseBridgeFrameForm(value: unknown): BridgeFrameForm | null {
  if (!isExactRecord(value, ['kind', 'origin', 'pathname']) || value.kind !== 'bridge/frame-form') {
    return null;
  }
  const canonicalOrigin = parseExactHttpsOrigin(value.origin);
  const pathname = parseCanonicalPathname(value.pathname, canonicalOrigin);
  if (canonicalOrigin === null || pathname === null) return null;
  return Object.freeze({ canonicalOrigin, pathname });
}

/** 后台让登记过的那一帧撤下浮层：顶层帧后来认出自己就是申请页，浮层归顶层。 */
export function parseDockFrameYield(value: unknown): boolean {
  return isExactRecord(value, ['kind']) && value.kind === 'dock/frame-yield';
}

/**
 * 后台叫顶层帧再看一眼让不让位（2026-10-04）：一个子帧刚登记了申请表、拿到一张要挂的脸。官网的嵌入 iframe 常常是页面脚本
 * 过几秒才插进来的（Datadog、Databricks、MongoDB），那时顶层的脸早挂好了。不带值：让不让位仍由顶层按门控那个判据
 * （`shouldYieldToEmbeddedFrame`，只读 iframe 的 src）自己判，这一声只是叫它现在判一次。
 */
export function parseDockTopYield(value: unknown): boolean {
  return isExactRecord(value, ['kind']) && value.kind === 'dock/top-yield';
}

/** 子帧的 frameId：正整数。0 是顶层帧，顶层帧走报到表那条路。 */
export function isChildFrameId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function parseFrameFormRegistry(value: unknown): FrameFormRegistry {
  if (!isRecord(value)) return Object.freeze({});
  const parsed: Record<string, RegisteredFrameForm> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isExactRecord(entry, ['tabId', 'frameId', 'canonicalOrigin', 'pathname', 'at'])) continue;
    const { tabId, frameId, canonicalOrigin, pathname, at } = entry;
    if (!isTabId(tabId) || String(tabId) !== key || !isChildFrameId(frameId)) continue;
    const origin = parseExactHttpsOrigin(canonicalOrigin);
    const path = parseCanonicalPathname(pathname, origin);
    if (origin === null || path === null) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue;
    parsed[key] = Object.freeze({ tabId, frameId, canonicalOrigin: origin, pathname: path, at });
  }
  return Object.freeze(parsed);
}

/**
 * 记一帧。同一标签页里先来的算数：已有别的帧 → 不收（`accepted: false`，表不变）；
 * 同一帧再报 → 只刷新时间。
 */
export function recordFrameForm(
  registry: FrameFormRegistry,
  entry: RegisteredFrameForm,
): Readonly<{ registry: FrameFormRegistry; accepted: boolean }> {
  if (!isTabId(entry.tabId) || !isChildFrameId(entry.frameId)) return { registry, accepted: false };
  const key = String(entry.tabId);
  const current = registry[key];
  if (current !== undefined && current.frameId !== entry.frameId) return { registry, accepted: false };
  return {
    registry: Object.freeze({ ...registry, [key]: Object.freeze({ ...entry }) }),
    accepted: true,
  };
}

export function removeFrameForm(registry: FrameFormRegistry, tabId: number): FrameFormRegistry {
  const key = String(tabId);
  if (!(key in registry)) return registry;
  const next: Record<string, RegisteredFrameForm> = { ...registry };
  delete next[key];
  return Object.freeze(next);
}

/**
 * 发信人是不是登记过的那一帧：tabId 与 frameId 都对得上，且它此刻的 origin + pathname 与
 * 登记逐字相等（查询串与片段不算，与 senderPage 同一口径）。「没登记」与「换页了」给同一个
 * 答案——null。
 */
export function frameFormForSender(
  registry: FrameFormRegistry,
  tabId: number,
  frameId: number,
  senderUrl: string,
): RegisteredFrameForm | null {
  if (!isTabId(tabId) || !isChildFrameId(frameId)) return null;
  const entry = registry[String(tabId)];
  if (entry === undefined || entry.frameId !== frameId) return null;
  let url: URL;
  try { url = new URL(senderUrl); } catch { return null; }
  return entry.canonicalOrigin === url.origin && entry.pathname === url.pathname ? entry : null;
}

function isTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
