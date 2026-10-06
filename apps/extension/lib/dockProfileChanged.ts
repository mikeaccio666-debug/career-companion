/**
 * worker → 各标签页：用户的资料或代填授权刚在插件里改过（2026-10-03 前端体检 P0-1）。
 *
 * 每个申请页的内容脚本都预取一份档案、留一分钟（apply.content.ts 的 `profileWarm`），从前只有同一页里的保存才作废它：
 * 在别的标签页的资料编辑器里改了电话、撤回了代填授权，这一页一分钟之内按「自动填写」用的还是旧的那一份。worker 经手
 * 每一次资料目录的写入（profile-directory/run），写完就广播这一声，每一页把手里的预取作废、下一轮重新取。
 *
 * 不带任何值，收到只做这一件事。代不代签另有一道更硬的闸：填写开始那一刻现读（`SIGN_ON_BEHALF`），门户上撤回的也算——
 * 这一声只是让资料的其余部分也别旧着用。
 */
export const DOCK_PROFILE_CHANGED = Object.freeze({ kind: 'dock/profile-changed' as const });

export function isDockProfileChanged(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as { kind?: unknown }).kind === 'dock/profile-changed';
}
