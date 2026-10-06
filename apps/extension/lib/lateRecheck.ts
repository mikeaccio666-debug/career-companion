import type { AuditView } from '@edaix/apply-kernel/audit';

/**
 * 整轮结束之后的复核排程。
 *
 * 内核在整轮写完后扫一次（CAP-AF-055），窗口 250 毫秒——那是照着受控框架重渲染
 * 量的。挡不住的是另一种宿主回写：**简历解析**。那是一次服务端往返，2026-09-22
 * 在 Lever 上实测结算后约十二秒才把我们填好的地点清空。窗口一关，那一行就永远
 * 停在「已填」上：不是没填上，是我们说了谎。
 *
 * ## 为什么是「问几次」而不是「等久一点」
 *
 * 把内核那个窗口调到十二秒，用户就要对着中段屏干等十二秒，而且仍然是猜——下一家
 * 可能十五秒。所以中段屏照旧在 250 毫秒后交出结论，**面板此后自己再问几次**。
 *
 * ## 为什么有个尽头
 *
 * 不设尽头就成了常驻轮询：页面开着一整天，我们就读一整天。真实的解析回写集中在
 * 结算后的头二十秒内，之后再变多半是用户自己在改——那不该由我们改判成
 * `LATE_REVERTED`。所以排程走完就停，停了之后面板上的数字属于用户自己。
 */
/** 两次之间的**间隔**，不是绝对时刻：累计 2 / 5 / 10 / 20 秒，最后一次晚于 Lever 实测的十二秒。 */
export const LATE_RECHECK_SCHEDULE_MS: readonly number[] = Object.freeze([2_000, 3_000, 5_000, 10_000]);

export interface LateRecheckInput {
  /**
   * 面板**此刻正显示**的那一份视图。基线，不是初值：我们只推「相对屏幕上那一屏
   * 变了的结论」。没有它，第一次复核哪怕一个字没变也会把面板重绘一遍。
   */
  readonly current: AuditView;
  /** 再问一次，返回修订过的视图（`KernelFillAudit.recheck`）。只读。 */
  readonly recheck: () => AuditView;
  /** 把修订过的视图交给面板。只在结论真的变了时调用。 */
  readonly apply: (view: AuditView) => void;
  /** 面板已拆、这一轮已被顶掉、页面正在卸载——返回 true 就不再问。 */
  readonly stopped: () => boolean;
  /** 两次之间的间隔（毫秒）。注入是为了测试不真等。 */
  readonly schedule?: readonly number[];
  readonly wait?: (milliseconds: number) => Promise<void>;
}

/**
 * 按排程反复复核，直到走完或被叫停。返回的函数立即叫停。
 *
 * 结论没变就不交给面板：复核每轮都要跑，但重绘是有代价的，而且把用户正在看的
 * 那一屏无端换掉本身就是打扰。
 */
export function startLateRecheck(input: LateRecheckInput): () => void {
  const schedule = input.schedule ?? LATE_RECHECK_SCHEDULE_MS;
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let cancelled = false;

  void (async () => {
    let applied = verdictSignature(input.current);
    for (const gap of schedule) {
      try {
        await wait(gap);
      } catch {
        // 等待器坏掉不是「值没了」：停下，不改判。
        return;
      }
      if (cancelled || input.stopped()) return;
      let view: AuditView;
      try {
        view = input.recheck();
      } catch {
        // 复核是只读的显示路，它的故障停在这里；这一轮的结论完全不受影响。
        return;
      }
      const next = verdictSignature(view);
      if (next === applied) continue;
      applied = next;
      try {
        input.apply(view);
      } catch {
        return;
      }
    }
  })();

  return () => { cancelled = true; };
}

/**
 * 「这一屏的结论」——只取用户看得见的判定，不取标签文案。
 *
 * 用它比对而不是整份视图：复核每次都重建视图对象，深比对既贵又会被无关字段
 * （元素引用、顺序号）搅乱。Data-L1：签名里不含任何宿主标签或我们写入的值。
 */
function verdictSignature(view: AuditView): string {
  return [
    view.filled,
    view.requiredHandled,
    view.requiredTotal,
    ...view.rows.map((row) => `${row.order}:${row.status}:${row.reason ?? ''}`),
  ].join('|');
}
