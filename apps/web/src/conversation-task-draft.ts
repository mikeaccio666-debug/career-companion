import type { Artifact, ConversationTask } from '@companion/platform-contracts';
import { AccountOperationScope, type AccountOperationToken } from './account-operations.ts';
import { artifactAgentDraft, mergeAgentDraft, ownedTextArtifactReference, type AgentDraftState, type MergedAgentDraft } from './agent-handoff.ts';
import { browserAgentDraft, hasBrowserObservation } from './browser-plan.ts';
import { mcpResultAgentDraft, parseMcpSummary } from './mcp-editor.ts';

export type ConversationTaskReference = { kind: 'mcp' } | { kind: 'browser' } | { kind: 'artifact'; artifact: Artifact };
export function conversationTaskDraft(task: ConversationTask, reference: ConversationTaskReference): string {
  let content: string;
  if (reference.kind === 'mcp') {
    if (task.job.kind !== 'mcp' || !parseMcpSummary(task.job.mcp)) throw new Error('请重新选择已保存的外部工具任务。');
    content = mcpResultAgentDraft(task.job.id);
  } else if (reference.kind === 'browser') {
    if (task.job.kind !== 'browser' || !hasBrowserObservation(task.job)) throw new Error('这份任务还没有已保存的网页观察记录。');
    content = browserAgentDraft(task.job);
  } else {
    if (['mcp', 'browser'].includes(task.job.kind)) throw new Error('这类结果需要专用读取工具。');
    const owned = ownedTextArtifactReference([task.job], task.job.id, reference.artifact.id);
    if (!owned) throw new Error('请从本任务已保存的文字成果选择引用。');
    content = artifactAgentDraft(owned);
  }
  return `继续这段对话原有的目标。初始任务版本为 ${task.origin.createdGeneration}，当前任务版本为 ${task.generation}，当前状态：${task.job.status}。已保存的成果可能来自较早尝试，不代表本次执行已经成功；请以读取工具实际返回的来源和状态为准。\n\n${content}`;
}

/** The caller changes no conversation ID: this only appends to its captured current draft. */
export function applyConversationTaskDraft<T>(scope: AccountOperationScope, session: AccountOperationToken, conversationId: string, activeConversationId: () => string | null, task: ConversationTask, reference: ConversationTaskReference, current: AgentDraftState<T>, apply: (plan: MergedAgentDraft<T>) => void): boolean {
  if (!scope.isCurrent(session) || !session.accountId || activeConversationId() !== conversationId || task.origin.conversationId !== conversationId) return false;
  const plan = mergeAgentDraft(current, conversationTaskDraft(task, reference));
  if (!scope.isCurrent(session) || activeConversationId() !== conversationId) return false;
  apply(plan); return true;
}
