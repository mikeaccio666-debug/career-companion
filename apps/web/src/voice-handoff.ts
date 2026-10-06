import { AccountOperationScope, type AccountOperationToken } from './account-operations.ts';
import { applyAgentDraftHandoff, type AgentDraftState, type MergedAgentDraft } from './agent-handoff.ts';

/** A voice excerpt belongs to the conversation whose UI offered the action. */
export function applyVoiceDraftHandoff<T>(
  scope: AccountOperationScope,
  session: AccountOperationToken,
  sourceConversationId: string | null,
  currentConversationId: () => string | null,
  current: AgentDraftState<T>,
  incoming: string,
  apply: (plan: MergedAgentDraft<T>) => void,
) {
  if (!session.accountId || !scope.isCurrent(session) || sourceConversationId !== currentConversationId()) return;
  if (!incoming.trim()) throw new Error('需要带回的语音摘录为空。');
  return applyAgentDraftHandoff(scope, { accountId: session.accountId, generation: session.generation }, current, incoming, apply);
}

/** Delayed focus must yield to navigation, including leaving and returning to the same thread. */
export function canFocusVoiceHandoff(
  scope: AccountOperationScope,
  selection: AccountOperationToken,
  sourceConversationId: string | null,
  currentConversationId: string | null,
) {
  return sourceConversationId === currentConversationId && scope.isCurrent(selection);
}
