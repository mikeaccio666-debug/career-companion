/**
 * worker → 各标签页：登录态变了（握手完成 / 退出登录），浮层该重新报到换脸。
 *
 * 从前连接完成后只靠「用户切回申请页时的 focus 重新报到」——门户把自己的标签页关掉、
 * 焦点回来那一下确实会触发，但门户开在别的窗口、或用户先看了别的标签页时就不会，
 * 浮层停在「未连接」，看起来像没连上（2026-09-21 测试台实测）。这条消息不带任何值，
 * 收到只做一件事：再问一次 worker 这一页该长什么脸。
 */
export const DOCK_SESSION_CHANGED = Object.freeze({ kind: 'dock/session-changed' as const });

export function isDockSessionChanged(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as { kind?: unknown }).kind === 'dock/session-changed';
}
