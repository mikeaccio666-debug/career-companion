/**
 * 用户在浮层里点了「退出登录」。
 *
 * 内容脚本只交一个闭集的意图，凭据与作废动作都在 worker（`authClient.logout()`：
 * 尽力作废远端 token、清本机会话、递增会话纪元让在途刷新落不了盘）。页面就算接管了
 * 内容脚本，能做的也只是让用户退出——退出永远是安全方向。
 */
export interface DockSignOutIntent {
  readonly kind: 'dock/sign-out';
}

const KEYS = ['kind'] as const;

export function parseDockSignOutIntent(value: unknown): DockSignOutIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  // 精确键：多一个字段就是没约定过的形状。
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  if ((value as Record<string, unknown>).kind !== 'dock/sign-out') return null;
  return Object.freeze({ kind: 'dock/sign-out' });
}

export function createDockSignOutIntent(): DockSignOutIntent {
  return Object.freeze({ kind: 'dock/sign-out' });
}
