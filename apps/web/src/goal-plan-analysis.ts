import type { GoalPlanContinuation } from '@companion/platform-contracts';
import type { BoundPlatformClient, StreamEvent } from './api.ts';
import { StaleAccountOperation } from './account-operations.ts';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** The reviewed server definition owns content, mode and provider; composer state never enters this request. */
export function goalPlanAnalysisBody(continuation: GoalPlanContinuation, conversationId: string) {
  if (!continuation || continuation.conversationId !== conversationId || !uuid.test(conversationId) || !uuid.test(continuation.planId) || !Number.isSafeInteger(continuation.revision) || continuation.revision < 1 || continuation.revision > 1_000_000 || !Number.isSafeInteger(continuation.stepIndex) || continuation.stepIndex < 0 || continuation.stepIndex > 7) throw new Error('请重新读取这段会话中已确认的计划步骤。');
  return { goalPlanStep: { planId: continuation.planId, revision: continuation.revision, stepIndex: continuation.stepIndex, conversationId } };
}
export async function streamGoalPlanAnalysis(client: Pick<BoundPlatformClient, 'isCurrent' | 'streamMessage'>, continuation: GoalPlanContinuation, conversationId: string, signal: AbortSignal, isCurrent: () => boolean, onEvent: (event: StreamEvent) => void): Promise<'complete' | 'discarded'> {
  const current = () => client.isCurrent() && isCurrent() && !signal.aborted;
  if (!current()) throw new StaleAccountOperation();
  const body = goalPlanAnalysisBody(continuation, conversationId);
  let messageId: string | undefined, completed = false;
  await client.streamMessage(conversationId, body, signal, (event) => {
    if (!current()) return;
    if (event.event === 'start' && typeof event.data.messageId === 'string' && uuid.test(event.data.messageId)) messageId = event.data.messageId;
    if (event.event === 'done') {
      if (!messageId || event.data.message?.id !== messageId || event.data.message?.role !== 'assistant' || event.data.message?.status !== 'complete') throw new Error('分析返回记录不完整，请核对原会话和计划状态。');
      completed = true;
    }
    onEvent(event);
  });
  if (!current()) return 'discarded';
  if (!completed) throw new Error('尚未确认分析已保存。请读取原会话和计划，不要自动重试。');
  return 'complete';
}
