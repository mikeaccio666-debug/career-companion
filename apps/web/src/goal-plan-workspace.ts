import type { CapturedAccount } from './account-context.ts';
import type { GoalPlanDraft } from './goal-plans-editor.ts';

/** Session-local editor and selection only: no server results, continuation, authorization or browser resource. */
export interface GoalPlanWorkspace {
  selectedId: string | null; editor: GoalPlanDraft; editing: boolean; dirty: boolean;
  editorPlanId: string | null; editorRevision: number | null; conflict: boolean;
}
export interface GoalPlanWorkspacePort { load(): GoalPlanWorkspace | undefined; save(value: GoalPlanWorkspace): void }
export interface GoalPlanReviewRequest { planId: string; serial: number }
const same = (a: CapturedAccount | null, b: CapturedAccount | null) => a?.accountId === b?.accountId && a?.generation === b?.generation;
export class GoalPlanWorkspaceStore {
  private account: CapturedAccount | null = null;
  private entries = new Map<string, GoalPlanWorkspace>();
  changeSession(account: CapturedAccount | null) { if (!same(this.account, account)) { this.entries.clear(); this.account = account ? { ...account } : null; } }
  forget(account: CapturedAccount, conversationId: string) { if (same(this.account, account)) this.entries.delete(conversationId); }
  clear() { this.entries.clear(); this.account = null; }
  read(account: CapturedAccount, conversationId: string): GoalPlanWorkspace | undefined { const value = same(this.account, account) ? this.entries.get(conversationId) : undefined; return value ? structuredClone(value) : undefined; }
  save(account: CapturedAccount, conversationId: string, value: GoalPlanWorkspace) { if (same(this.account, account)) this.entries.set(conversationId, structuredClone(value)); }
}
