import type { AutofillAffordance } from '../product-panel/affordance';

/**
 * 能填的申请表上自动打开浮层（2026-09-24 负责人：Jobright 就是这样）。
 *
 * 规矩（尊重用户）：
 *  · 只在「能填」的那一面自动打开——READY 与 UNAVAILABLE:NO_MISSION，也就是摆着「自动填写」的那两张脸；
 *    没连接（先登录）、不是申请表、取不到规则、要先在网站上登录的几张脸都不打开；
 *  · 一次页面加载里只自动打开一次；这一页上用户收起过，就不再打开（同一个标签页里多页申请翻到下一页、换脸重挂，
 *    都还是这一次加载）；
 *  · 公司自己做的申请表（通用路：主机不在厂商表里、也没有厂商指纹）：表里有只有求职才问的栏（简历／CV 上传、LinkedIn、
 *    工作授权、学历）才像厂商申请页一样自动打开（负责人 2026-09-28，取代 2026-09-25「先严格」那一版的一律不开）；
 *    只靠页面声明的 JobPosting 或招聘页网址撑着的表照旧只挂收着的标签。厂商的申请页与白标照旧；
 *  · 用户在这个站点（origin）30 分钟之内收起过，就保持收起——多页申请整页跳到下一页，也不会又弹出来。
 *    记录只按 origin 记一个时间，存在插件自己的 `storage.local` 里（与收起按钮的位置同一处），不碰页面存储；
 *    过了 30 分钟的记录每次读写时顺手丢掉。用户后来自己点开了，就把这个站点的记录删掉——他最近一次的意思是「要」。
 *
 * 用的是平常那段打开动画（浮层挂上时先按「收着」画一帧，再打开）。
 */

/** 存在 `storage.local` 里的键：`{ [origin]: 收起那一刻的毫秒时间戳 }`。 */
export const DOCK_COLLAPSED_AT_KEY = 'argolandDockCollapsedAt';
/** 收起之后这么久之内，这个站点不再自动打开。 */
export const COLLAPSE_MEMORY_MS = 30 * 60 * 1000;
/** 记录最多留这么多个站点（防御：正常用不了几条）。 */
const MAX_ORIGINS = 50;

/** 摆着「自动填写」的那两张脸。 */
export function isFillableFace(face: AutofillAffordance): boolean {
  return face.kind === 'READY' || (face.kind === 'UNAVAILABLE' && face.reason === 'NO_MISSION');
}

/** 读回来的记录只认 `{ origin: 数字 }`，形状不对的条目当没有；顺手丢掉过期的与将来的。 */
export function freshCollapses(stored: unknown, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return out;
  const entries = Object.entries(stored as Record<string, unknown>)
    .filter((entry): entry is [string, number] => /^https?:\/\/[^/\s]+$/u.test(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .filter(([, at]) => at <= now && now - at < COLLAPSE_MEMORY_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ORIGINS);
  for (const [origin, at] of entries) out[origin] = at;
  return out;
}

/** 这个站点在 30 分钟之内收起过。 */
export function collapsedRecently(stored: unknown, origin: string, now: number): boolean {
  return Object.hasOwn(freshCollapses(stored, now), origin);
}

/** 记下这个站点此刻收起了。 */
export function withCollapse(stored: unknown, origin: string, now: number): Record<string, number> {
  return freshCollapses({ ...freshCollapses(stored, now), [origin]: now }, now);
}

/** 用户自己又点开了：删掉这个站点的记录。 */
export function withoutCollapse(stored: unknown, origin: string, now: number): Record<string, number> {
  const next = freshCollapses(stored, now);
  delete next[origin];
  return next;
}

/**
 * 这一页走的是哪一条路：厂商的申请页与白标（`vendor`），或公司自己做的表（`company`，通用路）——后者要看表里有没有
 * 只有求职才问的栏（`lib/pageEvidence.ts` 的 `hasJobOnlyFields`）。
 */
export type DockAutoOpenPage =
  | { readonly lane: 'vendor' }
  | { readonly lane: 'company'; readonly jobOnlyFields: boolean };

export interface DockAutoOpen {
  /**
   * 挂一张脸时问：这一次要不要自动打开。`recentlyCollapsed` 是这个站点 30 分钟之内收起过；`page` 说这一页走哪条路，
   * 公司自己做的表没有只有求职才问的栏时不自动打开。
   */
  readonly shouldOpen: (face: AutofillAffordance, recentlyCollapsed: boolean, page?: DockAutoOpenPage) => boolean;
  /** 自动打开了：这一次加载里不再自动打开。 */
  readonly opened: () => void;
  /** 用户收起了：这一次加载里不再自动打开。 */
  readonly collapsed: () => void;
}

/** 一次页面加载一份（内容脚本里建一次）。 */
export function createDockAutoOpen(): DockAutoOpen {
  let openedThisLoad = false;
  let collapsedThisLoad = false;
  return Object.freeze({
    shouldOpen: (face: AutofillAffordance, recentlyCollapsed: boolean, page: DockAutoOpenPage = { lane: 'vendor' }) =>
      isFillableFace(face) &&
      (page.lane === 'vendor' || page.jobOnlyFields) &&
      !openedThisLoad && !collapsedThisLoad && !recentlyCollapsed,
    opened: () => { openedThisLoad = true; },
    collapsed: () => { collapsedThisLoad = true; },
  });
}
