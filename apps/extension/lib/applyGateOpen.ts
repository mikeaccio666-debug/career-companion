/**
 * 申请表还没打开：先替他点开（2026-10-04，负责人 D8）。
 *
 * BambooHR 的岗位页（`/careers/<id>`）上没有表单，只有一颗「Apply for This Job」，点完申请表才出现、网址不变。从前浮层
 * 停在「申请表还没打开：先点页面上的申请按钮」（bench-1003：没点开就按，8/8 页停在这里；点开之后必填 77%）。负责人决定：
 * 「自动填写」可以先替他点开——那一下只把表单展开，不提交任何东西。
 *
 * 规矩：
 *  · 按不按看翻页那一位（`advance-step`，远程可关，取不到即关）——与替他按「下一步」同一个开关；
 *  · 按的只能是规则声明的那一颗（内核的 `applyGateControl`：申请表此刻确实没打开、那一颗唯一、可用、不是任何一张表的
 *    提交控件），而且看得见；
 *  · 他按了「停止」就不按；等表单的时候按的，不接着填；
 *  · 读按钮、判可见出了错，一律当没有：不点。
 */
export interface OpenApplyFormInput<T> {
  /** 翻页那一位此刻开着（按之前读）。 */
  readonly allowed: () => boolean;
  /** 规则声明的那一颗「打开申请表」；没有就是 null。 */
  readonly control: () => HTMLElement | null;
  /** 生产的可见性（`isRenderedControl`）。 */
  readonly isVisible: (element: Element) => boolean;
  /** 点完之后等表单出来（与连填翻页同一个等法），交回那一次扫描。 */
  readonly waitForForm: () => Promise<T>;
  readonly signal: AbortSignal;
}

/** 点开了就交回点开之后那一次扫描；没点（不该点、点不了、他按了停止）就是 null。 */
export async function openApplyFormFirst<T>(input: OpenApplyFormInput<T>): Promise<T | null> {
  if (input.signal.aborted) return null;
  let control: HTMLElement | null;
  try {
    if (!input.allowed()) return null;
    control = input.control();
    if (control === null || !input.isVisible(control)) return null;
  } catch {
    return null;
  }
  control.click();
  const outcome = await input.waitForForm();
  return input.signal.aborted ? null : outcome;
}
