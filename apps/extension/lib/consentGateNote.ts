/**
 * 替他过了数据同意页、网站整页跳到申请表之后，新一页的浮层照实说一句（2026-10-04，负责人 D7）。
 *
 * 与「刚按了提交」同一个做法（lib/dockSubmitPressed.ts）：内容脚本选上居住地的那一刻报一声，worker 只记这个标签页、
 * 那一份文档与时间；90 秒内这个标签页里**另一份**文档的顶层报到带上 `consentGatePassed`。消息不带任何页面内容，只决定
 * 新一页的浮层说不说那一句，不授权任何动作。
 */
export const DOCK_CONSENT_GATE_CHOSEN = Object.freeze({ kind: 'dock/consent-gate-chosen' as const });
/**
 * 选上之后网站没有自己跳走（把条款摆了出来、要他本人点同意，或一直没动静）：再报一声，worker 把那一条删掉——之后他自己点
 * 同意跳过去的新一页，不该说「已替你过了数据同意页」。
 */
export const DOCK_CONSENT_GATE_SETTLED = Object.freeze({ kind: 'dock/consent-gate-settled' as const });

function isBare(message: unknown, kind: string): boolean {
  return message !== null && typeof message === 'object' && !Array.isArray(message)
    && Object.keys(message).length === 1 && (message as { kind?: unknown }).kind === kind;
}

export function isDockConsentGateChosen(message: unknown): boolean {
  return isBare(message, DOCK_CONSENT_GATE_CHOSEN.kind);
}

export function isDockConsentGateSettled(message: unknown): boolean {
  return isBare(message, DOCK_CONSENT_GATE_SETTLED.kind);
}
