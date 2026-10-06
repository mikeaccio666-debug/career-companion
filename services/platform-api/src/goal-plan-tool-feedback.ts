import { ApiError } from './errors.ts';
import type { Database } from './database.ts';
import { authorizeAssistantTurn, type AssistantTurnOrigin } from './assistant-turn-origin.ts';
import { inactiveProposal } from './goal-plan-proposals.ts';
import { goalPlanInputDiagnostic, type GoalPlanInputDiagnostic } from './goal-plan-input-diagnostics.ts';

type GoalPlanToolName = 'get_execution_capabilities' | 'propose_goal_plan' | 'list_goal_plans' | 'read_goal_plan';
interface GoalPlanToolFeedback { error: { code: string; message: string; diagnostic?: GoalPlanInputDiagnostic } }
const recoverable: Record<GoalPlanToolName, Readonly<Record<string, number>>> = {
  get_execution_capabilities: { INVALID_INPUT: 400 },
  propose_goal_plan: { INVALID_INPUT: 400, GOAL_PLAN_PROPOSAL_EXISTS: 409 },
  list_goal_plans: { INVALID_INPUT: 400, NOT_FOUND: 404, GOAL_PLAN_REVISION_CONFLICT: 409 },
  read_goal_plan: { INVALID_INPUT: 400, NOT_FOUND: 404, GOAL_PLAN_REVISION_CONFLICT: 409 },
};

/** Only deterministic input feedback may continue a model turn. Identity, lease,
 * cancellation, size, capacity and infrastructure failures still abort it. */
export async function goalPlanToolResult<T>(name: GoalPlanToolName, signal: AbortSignal, execute: () => T | Promise<T>, authorizeFeedback: () => Promise<void>): Promise<T | GoalPlanToolFeedback> {
  signal.throwIfAborted();
  try {
    const result = await execute();
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted || !(error instanceof ApiError) || recoverable[name][error.code] !== error.status) throw error;
    // Input parsing can fail before the proposal transaction authenticates its
    // server-owned source. Never let that failure mask an inactive response.
    await authorizeFeedback();
    signal.throwIfAborted();
    const diagnostic=name==='propose_goal_plan'?goalPlanInputDiagnostic(error):undefined;
    return { error: { code: error.code, message: error.publicMessage, ...(diagnostic?{diagnostic}:{}) } };
  }
}

/** Reuse the ordinary source locks; this transaction never creates a plan or job. */
export async function authorizeGoalPlanToolFeedback(db: Database, userId: string, origin: AssistantTurnOrigin, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await db.transaction(async client => {
    signal.throwIfAborted();
    const user = await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [userId]);
    signal.throwIfAborted();
    if (!user.rowCount) throw inactiveProposal();
    await authorizeAssistantTurn(client, userId, origin, signal, inactiveProposal);
    // Both lease clocks must still be live after all waited locks were acquired.
    const active = await client.query(`SELECT m.id FROM platform_conversations c
      JOIN platform_messages m ON m.conversation_id=c.id
      JOIN platform_runtime_leases l ON l.id=m.id AND l.user_id=c.user_id AND l.kind='chat'
      WHERE c.id=$1 AND c.user_id=$2 AND m.id=$3 AND m.role='assistant' AND m.status='streaming'
        AND m.lease_until>clock_timestamp() AND l.expires_at>clock_timestamp()`, [origin.conversationId, userId, origin.messageId]);
    signal.throwIfAborted();
    if (!active.rowCount) throw inactiveProposal();
  });
  signal.throwIfAborted();
}
