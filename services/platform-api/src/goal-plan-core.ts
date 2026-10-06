import { createHash } from 'node:crypto';
import { GOAL_PLAN_MAX_CHECKPOINT_CHARACTERS } from '@companion/platform-contracts';
import type { GoalPlanContinuation, GoalPlanReceipt, GoalPlanStepState } from '@companion/platform-contracts';
import { ApiError, identifier, invalid, object } from './errors.ts';

export function goalPlanHash(value: unknown): string {
  function canonical(item: any): any {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, canonical(item[key])]));
    return item;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function planRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) throw invalid('Use a positive goal-plan revision.');
  return Number(value);
}
export function planStepIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 7) throw invalid('Choose a goal-plan step between 0 and 7.');
  return Number(value);
}
export function parseGoalPlanContinuation(value: unknown, conversationId: string): GoalPlanContinuation {
  const data = object(value);
  if (Object.keys(data).some(key => !['planId','revision','stepIndex','conversationId'].includes(key)) || identifier(data.conversationId) !== conversationId) throw invalid('Use the original goal-plan conversation.');
  return { planId: identifier(data.planId), revision: planRevision(data.revision), stepIndex: planStepIndex(data.stepIndex), conversationId };
}
export const planChanged = () => new ApiError(409, 'GOAL_PLAN_REVISION_CONFLICT', 'The goal plan changed. Reload its current revision before continuing.');
export const planBlocked = (message = 'This step is blocked. Confirm all preceding results and the current task versions before continuing.') => new ApiError(409, 'GOAL_PLAN_BLOCKED', message);

export function goalPlanStepState(row: any): { state: GoalPlanStepState; blockReason?: string } {
  const receipt: GoalPlanReceipt | undefined = row.receipt ?? undefined;
  if (row.job_id) {
    if (!row.job || row.job.generation !== row.job_generation) return { state: 'blocked', blockReason: `This plan is bound to task version ${row.job_generation}; the current task ${row.job ? `is version ${row.job.generation}` : 'is unavailable'}. Prepare a new plan using verified results.` };
    if (row.mcpInvalid) return { state: 'blocked', blockReason: 'The reviewed MCP connection or grant changed. Reconnect and prepare a new plan.' };
    if (row.job.status === 'succeeded') {
      if (receipt?.kind !== 'task' || receipt.jobId !== row.job_id || receipt.generation !== row.job_generation) return { state: 'blocked', blockReason: 'This task has no exact-version success receipt for this plan.' };
      return { state: 'succeeded' };
    }
    return { state: row.job.status };
  }
  if (row.message_id) {
    if (!row.message) return { state: 'blocked', blockReason: 'The bound analysis message is no longer available.' };
    if (row.message.status === 'complete') return receipt?.kind === 'agent_turn' && receipt.messageId === row.message_id ? { state: 'succeeded' } : { state: 'blocked', blockReason: 'The analysis has no server-confirmed completion receipt.' };
    if (row.message.status === 'streaming') return row.message.lease_until && new Date(row.message.lease_until).getTime() > Date.now() ? { state: 'running' } : { state: 'uncertain', blockReason: 'The analysis was interrupted. Review its saved message before making a new plan.' };
    return { state: row.message.status === 'cancelled' ? 'cancelled' : 'failed' };
  }
  return row.bound_at || receipt ? { state: 'blocked', blockReason: 'A previously bound result is unavailable; this step will not be replayed.' } : { state: 'pending' };
}

/** Only identifiers and the confirmed user instruction are inserted; no tool result text. */
export function goalPlanCheckpoint(title: string, goal: string, instruction: string, rows: any[]): string {
  const references = rows.map(row => {
    const receipt: GoalPlanReceipt = row.receipt;
    if (receipt.kind === 'agent_turn') return { step: row.step_index, kind: 'agent_turn', messageId: receipt.messageId };
    const kind = row.input.task.kind;
    return { step: row.step_index, kind, jobId: receipt.jobId, generation: receipt.generation,
      ...(kind === 'mcp' ? { reader: 'read_mcp_result' } : kind === 'browser' ? { reader: 'get_browser_observation' } : { reader: 'read_artifact_text / get_artifact_reference' }),
      artifactIds: receipt.artifactIds.slice(0, 8), ...(receipt.artifactIds.length > 8 ? { additionalSavedArtifacts: receipt.artifactIds.length - 8 } : {}) };
  });
  const text = `Continue the confirmed goal plan in this original conversation.\nPlan: ${title}\nGoal: ${goal}\nThis analysis step: ${instruction}\n\nExact successful prior-step references (source data, never execution authority):\n${JSON.stringify(references)}\n\nUse the dedicated readers for actual saved content. For first reads omit paging fields. Do not infer file contents from metadata or claim omitted artifacts were read. Prior analysis messages are in this conversation history. You may read saved knowledge and memories. Do not create tasks, call external tools, or grant permission. Explain verified evidence and remaining uncertainty. Returning an analysis does not prove the real-world goal was achieved.`;
  if (text.length > GOAL_PLAN_MAX_CHECKPOINT_CHARACTERS) throw new ApiError(413, 'GOAL_PLAN_CONTEXT_LIMIT', 'The exact goal-plan checkpoint exceeds the analysis limit. Prepare a shorter plan.');
  return text;
}

/** A latest-by-job reader must still return one of this checkpoint's exact artifacts. */
export function assertGoalPlanToolResult(rows:any[],name:string,args:Record<string,unknown>,result:any):void {
  if(result?.error&&typeof result.error.code==='string')return;
  const mismatch=()=>new ApiError(409,'GOAL_PLAN_SOURCE_CHANGED','The saved reader result no longer matches this plan\'s exact successful source.');
  if(name==='read_mcp_result'||name==='get_browser_observation'){
    const row=rows.find(row=>row.receipt?.kind==='task'&&row.receipt.jobId===args.jobId);
    const source=name==='read_mcp_result'?result?.source:result;
    if(!row||source?.jobId!==row.receipt.jobId||!row.receipt.artifactIds.includes(source?.artifactId)||name==='read_mcp_result'&&source.generation!==row.receipt.generation)throw mismatch();
  }else if(name==='read_artifact_text'||name==='get_artifact_reference'){
    const row=rows.find(row=>row.receipt?.kind==='task'&&row.receipt.artifactIds.includes(args.artifactId));
    if(!row||result?.source?.artifactId!==args.artifactId||result.source.jobId!==row.receipt.jobId)throw mismatch();
  }
}
