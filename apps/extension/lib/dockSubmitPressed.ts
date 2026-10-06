/**
 * 「就要替用户按网站的提交了」与「这一页已经看到结论了」——内容脚本告诉 worker 的两声（2026-09-23）。
 *
 * 都不带任何页面内容：worker 只记这个标签页、按下时的那一份文档与时间，好让网站**整页跳到**确认页
 * 之后，新一页的浮层把「提交成功」那段播完。同一页自己等到了结论（单页应用原地换成确认页、网站没收、
 * 说不清）就再报一声，worker 把那一条删掉——否则用户切回这个标签页时会再播一遍。消息只影响浮层放不放
 * 那段动画，不授权任何动作。
 */
export const DOCK_SUBMIT_PRESSED = Object.freeze({ kind: 'dock/submit-pressed' as const });
export const DOCK_SUBMIT_SETTLED = Object.freeze({ kind: 'dock/submit-settled' as const });

function isBare(message: unknown, kind: string): boolean {
  return message !== null && typeof message === 'object' && !Array.isArray(message)
    && Object.keys(message).length === 1 && (message as { kind?: unknown }).kind === kind;
}

export function isDockSubmitPressed(message: unknown): boolean {
  return isBare(message, DOCK_SUBMIT_PRESSED.kind);
}

export function isDockSubmitSettled(message: unknown): boolean {
  return isBare(message, DOCK_SUBMIT_SETTLED.kind);
}

/** 刚按了提交的标签页：按下的时刻与按下时的那一份文档。 */
export interface SubmittedTabMark {
  readonly at: number;
  readonly documentId: string | null;
}

/** 这一次报到该不该带上 justSubmitted：90 秒内、而且是**另一份**文档（整页跳过去了）。 */
export const JUST_SUBMITTED_MS = 90_000;

export function arrivesAfterSubmit(mark: SubmittedTabMark | undefined, documentId: string | null, now: number): 'ARRIVED' | 'SAME_PAGE' | 'NONE' {
  if (mark === undefined || now - mark.at > JUST_SUBMITTED_MS) return 'NONE';
  // 同一份文档（还在按下的那一页上）：不算到达，也不消耗——结论由那一页自己等。
  if (mark.documentId !== null && documentId !== null && mark.documentId === documentId) return 'SAME_PAGE';
  // 读不到文档身份时不猜：没法区分「同一页又报到」与「跳过去了」，宁可不播。
  if (mark.documentId === null || documentId === null) return 'NONE';
  return 'ARRIVED';
}
