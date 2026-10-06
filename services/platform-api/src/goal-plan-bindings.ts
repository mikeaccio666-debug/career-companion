import type { PoolClient } from 'pg';
import type { CreateJobInput, GoalPlanContinuation, GoalPlanInputSource, GoalPlanReceipt } from '@companion/platform-contracts';
import { ApiError, notFound } from './errors.ts';
import { goalPlanHash, goalPlanStepState, planBlocked, planChanged } from './goal-plan-core.ts';

export type GoalPlanTaskOrigin = Pick<GoalPlanContinuation, 'planId' | 'revision' | 'stepIndex'>;
export const GOAL_PLAN_ROWS_SQL = `SELECT p.*,r.title,r.goal,r.definition_hash,r.confirmed_at,
  s.step_index,s.input,s.input_hash,s.job_id,s.job_generation,s.message_id,s.bound_at,s.receipt,s.resolved_task,s.input_sources,
  row_to_json(j) AS job,row_to_json(m) AS message,
  w.steps AS workflow_step_states,w.definition_hash AS workflow_definition_hash,w.revision AS workflow_checkpoint_revision,
  b.state AS browser_checkpoint_state,b.revision AS browser_checkpoint_revision,b.next_index AS browser_next_index,
  (SELECT row_to_json(a) FROM platform_approvals a WHERE a.job_id=j.id AND a.user_id=p.user_id
    AND j.status='needs_approval' AND a.generation=j.generation AND a.status='pending' ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS approval,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',coalesce(a.filename,'artifact'),
    'mime',coalesce(a.mime,'application/octet-stream'),'url','/api/platform/artifacts/'||a.id,'size',u.byte_size) ORDER BY array_position(ARRAY(SELECT jsonb_array_elements_text(s.receipt->'artifactIds')),a.id::text))
    FROM platform_artifacts a LEFT JOIN platform_uploads u ON u.id=a.upload_id AND u.user_id=p.user_id
    WHERE a.job_id=s.job_id AND a.user_id=p.user_id AND s.receipt->>'kind'='task'
      AND a.id IN (SELECT jsonb_array_elements_text(s.receipt->'artifactIds')::uuid)), '[]'::jsonb) AS artifacts
  FROM platform_goal_plans p JOIN platform_goal_plan_revisions r ON r.plan_id=p.id AND r.revision=p.revision
    JOIN platform_goal_plan_steps s ON s.plan_id=r.plan_id AND s.revision=r.revision
    LEFT JOIN platform_jobs j ON j.id=s.job_id AND j.user_id=p.user_id
    LEFT JOIN platform_messages m ON m.id=s.message_id AND m.conversation_id=p.conversation_id
    LEFT JOIN platform_workflow_checkpoints w ON w.job_id=j.id
    LEFT JOIN platform_browser_checkpoints b ON b.job_id=j.id
  WHERE p.id=$1 AND p.user_id=$2 ORDER BY s.step_index`;

export async function lockGoalPlan(client: PoolClient, userId: string, origin: GoalPlanTaskOrigin): Promise<{plan:any;rows:any[];step:any}> {
  const row = (await client.query('SELECT * FROM platform_goal_plans WHERE id=$1 AND user_id=$2 FOR UPDATE', [origin.planId,userId])).rows[0];
  if (!row) throw notFound();
  if (row.revision !== origin.revision) throw planChanged();
  if (row.status !== 'active') throw planBlocked('Confirm or resume this plan before continuing a step.');
  const rows = (await client.query(GOAL_PLAN_ROWS_SQL, [origin.planId,userId])).rows;
  if (!rows[0]?.confirmed_at || !rows[origin.stepIndex] || rows[origin.stepIndex].step_index !== origin.stepIndex) throw planBlocked();
  return { plan: row, rows, step: rows[origin.stepIndex] };
}

export async function assertGoalPlanDependencies(client: PoolClient, rows: any[], stepIndex: number, validateMcp: (row: any) => Promise<unknown>): Promise<void> {
  // Lock jobs before changing a plan step. Publication owns job -> step, never plan.
  // Re-read under SHARE so a generation change cannot slip past preparation.
  const jobs = rows.slice(0,stepIndex).filter(row => row.job_id).sort((a,b) => a.job_id.localeCompare(b.job_id));
  for (const row of jobs) {
    row.job = (await client.query('SELECT * FROM platform_jobs WHERE id=$1 AND user_id=$2 FOR SHARE', [row.job_id,row.user_id])).rows[0];
    if (row.job?.kind === 'mcp') await validateMcp(row.job);
  }
  for (const row of rows.slice(0,stepIndex)) {
    if (row.message_id) row.message = (await client.query('SELECT * FROM platform_messages WHERE id=$1 AND conversation_id=$2 FOR SHARE', [row.message_id,row.conversation_id])).rows[0];
    if (goalPlanStepState(row).state !== 'succeeded') throw planBlocked();
    if (row.receipt.kind === 'task' && row.receipt.artifactIds.length) {
      const existing = await client.query('SELECT id FROM platform_artifacts WHERE user_id=$1 AND job_id=$2 AND id=ANY($3::uuid[])', [row.user_id,row.job_id,row.receipt.artifactIds]);
      if (existing.rows.length !== row.receipt.artifactIds.length) throw planBlocked('A preceding exact-version artifact is unavailable. Review the original result before making a new plan.');
    }
  }
}

/** Server-authenticated plan authority is independent of a live chat turn. */
export async function authorizeGoalPlanTask(client: PoolClient, userId: string, origin: GoalPlanTaskOrigin, input: unknown, validateMcp: (row: any) => Promise<unknown>): Promise<{ existingJobId?: string; rows?:any[]; step?:any }> {
  const { rows, step } = await lockGoalPlan(client,userId,origin);
  if (step.input.kind !== 'task') throw planBlocked('This plan step is an analysis, not a task.');
  if (step.job_id) return { existingJobId: step.job_id };
  if (step.bound_at) throw planBlocked('This previously bound step cannot be replayed.');
  if (goalPlanHash(step.input.task) !== goalPlanHash(input) || goalPlanHash(step.input)!==step.input_hash) throw new ApiError(409,'GOAL_PLAN_DEFINITION_CHANGED','The task template no longer matches this confirmed plan.');
  await assertGoalPlanDependencies(client,rows,origin.stepIndex,validateMcp);
  return {rows,step};
}
export async function bindGoalPlanTask(client: PoolClient, userId: string, origin: GoalPlanTaskOrigin, jobId: string, generation: number, input:CreateJobInput, inputSources:GoalPlanInputSource[]): Promise<void> {
  const bound = await client.query(`UPDATE platform_goal_plan_steps s SET job_id=$4,job_generation=$5,bound_at=now(),resolved_task=$7,input_sources=$8
    FROM platform_goal_plans p WHERE s.plan_id=p.id AND p.user_id=$6 AND p.status='active' AND p.revision=s.revision
      AND s.plan_id=$1 AND s.revision=$2 AND s.step_index=$3 AND s.bound_at IS NULL RETURNING s.plan_id`, [origin.planId,origin.revision,origin.stepIndex,jobId,generation,userId,JSON.stringify(input),JSON.stringify(inputSources)]);
  if (!bound.rowCount) throw planBlocked();
}

/** Called in the worker's existing final publication transaction, after its lease checks. */
export async function recordGoalPlanTaskReceipt(client: PoolClient, userId: string, jobId: string, generation: number, artifactIds: string[]): Promise<void> {
  const step = (await client.query('SELECT plan_id FROM platform_goal_plan_steps WHERE job_id=$1 AND job_generation=$2', [jobId,generation])).rows[0];
  if (!step) return;
  if (artifactIds.length > 64 || new Set(artifactIds).size !== artifactIds.length) throw new ApiError(413,'GOAL_PLAN_RESULT_LIMIT','This plan task exceeds its bounded exact result receipt.');
  if (artifactIds.length) {
    const files = await client.query('SELECT id FROM platform_artifacts WHERE user_id=$1 AND job_id=$2 AND id=ANY($3::uuid[])', [userId,jobId,artifactIds]);
    if (files.rowCount !== artifactIds.length) throw planBlocked('The task publication did not preserve every exact plan artifact.');
  }
  const receipt: GoalPlanReceipt = { kind:'task',jobId,generation,artifactIds,completedAt:new Date().toISOString() };
  await client.query('UPDATE platform_goal_plan_steps SET receipt=$3 WHERE job_id=$1 AND job_generation=$2 AND receipt IS NULL', [jobId,generation,JSON.stringify(receipt)]);
}
