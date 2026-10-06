import type { PoolClient } from 'pg';
import { JOB_KINDS, platformAccountId, type GoalPlanStepState } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import { authorizeAssistantTurn, inactiveAssistantTurn, parseAssistantTurnOrigin, type AssistantTurnOrigin } from './assistant-turn-origin.ts';
import { ApiError, invalid, notFound, object } from './errors.ts';
import { planChanged, planRevision, planStepIndex } from './goal-plan-core.ts';

export const GOAL_PLAN_READER_MAX_BYTES = 16 * 1024;
export const GOAL_PLAN_READER_LIST_LIMIT = 10;
const markers = { provenance: 'untrusted_goal_plan', readOnly: true, executionAuthorized: false, executionReadiness: 'not_checked' } as const;
const unavailable = () => new ApiError(409, 'GOAL_PLAN_READ_UNAVAILABLE', 'The saved plan metadata is unavailable. Review the plan in the workspace.');
const states = new Set<GoalPlanStepState>(['pending','needs_approval','queued','running','succeeded','failed','cancelled','uncertain','blocked']);
const statuses = new Set(['draft','active','paused','cancelled']);
const uuid = (value: unknown): string => { if (!platformAccountId(value)) throw unavailable(); return value.toLowerCase(); };
const positive = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 1) throw unavailable(); return Number(value); };
const date = (value: unknown): string => { if (typeof value !== 'string' && !(value instanceof Date)) throw unavailable(); const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) throw unavailable(); return parsed.toISOString(); };

export interface GoalPlanReadInput { planId: string; revision: number; stepIndex?: number }
export function parseGoalPlanReadInput(value: unknown): GoalPlanReadInput {
  const data = object(value);
  if (Object.keys(data).some(key => !['planId','revision','stepIndex'].includes(key)) || !platformAccountId(data.planId)) throw invalid('Use a plan ID and its explicit current revision.');
  return { planId: data.planId.toLowerCase(), revision: planRevision(data.revision), ...(data.stepIndex === undefined ? {} : { stepIndex: planStepIndex(data.stepIndex) }) };
}
export function parseGoalPlanListInput(value: unknown): void {
  if (Object.keys(object(value)).length) throw invalid('The plan list accepts no identity, cursor or execution fields.');
}
export interface GoalPlanReaderText { text: string; totalCharacters: number; truncated: boolean }
/** Budget includes JSON escaping and UTF-8; clipping never splits a Unicode code point. */
export function goalPlanReaderText(value: string, totalCharacters: number, maxBytes: number): GoalPlanReaderText {
  const characters = Array.from(value); let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(characters.slice(0,middle).join('')), 'utf8') <= maxBytes) low = middle; else high = middle - 1;
  }
  return { text: characters.slice(0,low).join(''), totalCharacters, truncated: low < totalCharacters };
}
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > GOAL_PLAN_READER_MAX_BYTES) throw unavailable();
  return value;
}
function header(row: any) {
  if (!statuses.has(row.status) || typeof row.title !== 'string' || row.title.length > 120 || !Number.isSafeInteger(row.step_count) || row.step_count < 1 || row.step_count > 8) throw unavailable();
  return { planId: uuid(row.id), conversationId: uuid(row.conversation_id), revision: positive(row.revision), title: row.title,
    status: row.status as 'draft'|'active'|'paused'|'cancelled', stepCount: row.step_count,
    createdAt: date(row.created_at), updatedAt: date(row.updated_at), ...(row.confirmed_at == null ? {} : { confirmedAt: date(row.confirmed_at) }) };
}

/** Only safe saved state and exact receipt identifiers; never arbitrary execution policy or artifact metadata. */
export function projectGoalPlanReaderStep(row: any) {
  const index = planStepIndex(row.step_index), kind = row.kind;
  if (kind !== 'task' && kind !== 'agent_turn') throw unavailable();
  if (kind === 'task' && !JOB_KINDS.includes(row.task_kind)) throw unavailable();
  let state: GoalPlanStepState = 'pending', blockReason: string | undefined;
  let receipt: Record<string, unknown> | undefined;
  const generation = row.job_generation == null ? undefined : positive(row.job_generation);
  const currentGeneration = row.current_generation == null ? undefined : positive(row.current_generation);
  if (row.receipt_kind === 'task') {
    const ids = row.receipt_artifact_ids;
    if (!Array.isArray(ids) || ids.length > 8 || !Number.isInteger(row.receipt_artifact_count) || row.receipt_artifact_count < ids.length || row.receipt_artifact_count > 64) throw unavailable();
    receipt = { kind: 'task', jobId: uuid(row.receipt_job_id), generation: positive(Number(row.receipt_generation)),
      artifactIds: ids.map(uuid), artifactCount: row.receipt_artifact_count, artifactsTruncated: row.receipt_artifact_count > ids.length, completedAt: date(row.receipt_completed_at) };
  } else if (row.receipt_kind === 'agent_turn') {
    receipt = { kind: 'agent_turn', messageId: uuid(row.receipt_message_id), completedAt: date(row.receipt_completed_at) };
  } else if (row.receipt_present) throw unavailable();
  if (row.job_id) {
    uuid(row.job_id);
    if (kind !== 'task' || !generation || !currentGeneration || currentGeneration !== generation) { state = 'blocked'; blockReason = 'TASK_VERSION_UNAVAILABLE'; }
    else if (!states.has(row.job_status) || row.job_status === 'pending' || row.job_status === 'blocked') throw unavailable();
    else if (row.job_status === 'succeeded') {
      if (receipt?.kind !== 'task' || receipt.jobId !== row.job_id || receipt.generation !== generation || row.available_artifact_count !== row.receipt_artifact_count) { state = 'blocked'; blockReason = 'EXACT_RECEIPT_UNAVAILABLE'; }
      else state = 'succeeded';
    } else state = row.job_status;
  } else if (row.message_id) {
    uuid(row.message_id);
    if (kind !== 'agent_turn' || row.message_status == null) { state = 'blocked'; blockReason = 'ANALYSIS_UNAVAILABLE'; }
    else if (row.message_status === 'complete') {
      if (receipt?.kind === 'agent_turn' && receipt.messageId === row.message_id) state = 'succeeded';
      else { state = 'blocked'; blockReason = 'EXACT_RECEIPT_UNAVAILABLE'; }
    } else if (row.message_status === 'streaming') state = row.message_lease_active === true ? 'running' : 'uncertain';
    else if (row.message_status === 'failed' || row.message_status === 'cancelled') state = row.message_status;
    else throw unavailable();
  } else if (row.bound_at || row.receipt_present) { state = 'blocked'; blockReason = 'BOUND_RESULT_UNAVAILABLE'; }
  return { index, kind, ...(kind === 'task' ? { taskKind: row.task_kind } : {}), state,
    ...(blockReason ? { blockReason } : {}), ...(generation === undefined ? {} : { generation }), ...(currentGeneration === undefined ? {} : { currentGeneration }),
    ...(row.job_id ? { jobId: row.job_id } : {}), ...(row.message_id ? { messageId: row.message_id } : {}), ...(receipt ? { receipt } : {}) };
}

const headerSQL = `SELECT p.id,p.conversation_id,p.revision,p.status,p.created_at,p.updated_at,r.title,r.confirmed_at,
  (SELECT count(*)::int FROM platform_goal_plan_steps s WHERE s.plan_id=p.id AND s.revision=p.revision) AS step_count
  FROM platform_goal_plans p JOIN platform_goal_plan_revisions r ON r.plan_id=p.id AND r.revision=p.revision`;
// Projection is intentionally independent of GoalPlans.get: no full inputs, messages, policies or artifact rows.
const stepSQL = `SELECT s.step_index,s.input->>'kind' AS kind,s.input->'task'->>'kind' AS task_kind,
  s.job_id,s.job_generation,s.message_id,s.bound_at,s.receipt IS NOT NULL AS receipt_present,
  s.receipt->>'kind' AS receipt_kind,s.receipt->>'jobId' AS receipt_job_id,s.receipt->>'generation' AS receipt_generation,
  s.receipt->>'messageId' AS receipt_message_id,s.receipt->>'completedAt' AS receipt_completed_at,
  CASE WHEN jsonb_typeof(s.receipt->'artifactIds')='array' THEN jsonb_array_length(s.receipt->'artifactIds') ELSE 0 END AS receipt_artifact_count,
  CASE WHEN jsonb_typeof(s.receipt->'artifactIds')='array' THEN ARRAY(SELECT jsonb_array_elements_text(s.receipt->'artifactIds') LIMIT 8) ELSE ARRAY[]::text[] END AS receipt_artifact_ids,
  (SELECT count(*)::int FROM platform_artifacts a WHERE a.user_id=$3 AND a.job_id=s.job_id AND
    CASE WHEN jsonb_typeof(s.receipt->'artifactIds')='array' THEN s.receipt->'artifactIds' ? a.id::text ELSE false END) AS available_artifact_count,
  j.generation AS current_generation,j.status AS job_status,m.status AS message_status,m.lease_until>clock_timestamp() AS message_lease_active,
  CASE WHEN s.step_index=$4 THEN s.input->>'title' END AS title,
  CASE WHEN s.step_index=$4 THEN CASE WHEN s.input->>'kind'='task' THEN s.input->'task'->>'provider' ELSE s.input->>'provider' END END AS provider,
  CASE WHEN s.step_index=$4 THEN CASE WHEN s.input->>'kind'='task' THEN s.input->'task'->>'model' ELSE s.input->>'model' END END AS model,
  CASE WHEN s.step_index=$4 THEN left(CASE WHEN s.input->>'kind'='task' THEN s.input->'task'->>'prompt' ELSE s.input->>'instruction' END,6144) END AS selected_text,
  CASE WHEN s.step_index=$4 THEN char_length(CASE WHEN s.input->>'kind'='task' THEN s.input->'task'->>'prompt' ELSE s.input->>'instruction' END) END AS selected_text_characters,
  CASE WHEN s.step_index=$4 AND jsonb_typeof(s.input->'task'->'attachmentIds')='array' THEN jsonb_array_length(s.input->'task'->'attachmentIds') ELSE 0 END AS static_attachment_count,
  CASE WHEN s.step_index=$4 AND s.input->'bindings'->'prompt' IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN s.step_index=$4 AND jsonb_typeof(s.input->'bindings'->'referenceImages')='array' THEN jsonb_array_length(s.input->'bindings'->'referenceImages') ELSE 0 END AS binding_count
  FROM platform_goal_plan_steps s JOIN platform_goal_plans p ON p.id=s.plan_id
  LEFT JOIN platform_jobs j ON j.id=s.job_id AND j.user_id=p.user_id
  LEFT JOIN platform_messages m ON m.id=s.message_id AND m.conversation_id=p.conversation_id AND m.role='assistant'
  WHERE s.plan_id=$1 AND s.revision=$2 AND p.user_id=$3 ORDER BY s.step_index`;

export class GoalPlanReaders {
  constructor(readonly db: Pick<Database, 'transaction'>) {}
  private async freshOrigin(client: PoolClient, userId: string, origin: AssistantTurnOrigin, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const active = await client.query(`SELECT m.id FROM platform_conversations c JOIN platform_messages m ON m.conversation_id=c.id
      JOIN platform_runtime_leases l ON l.id=m.id AND l.user_id=c.user_id AND l.kind='chat'
      WHERE c.id=$1 AND c.user_id=$2 AND m.id=$3 AND m.role='assistant' AND m.status='streaming'
        AND m.lease_until>clock_timestamp() AND l.expires_at>clock_timestamp()`, [origin.conversationId,userId,origin.messageId]);
    signal?.throwIfAborted(); if (!active.rowCount) throw inactiveAssistantTurn();
  }
  private async begin(client: PoolClient, userId: string, origin: AssistantTurnOrigin, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!(await client.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [userId])).rowCount) throw inactiveAssistantTurn();
    signal?.throwIfAborted();
    // Conversation deletion cascades to plans. Never hold a plan while waiting for its conversation.
    if (!(await client.query('SELECT id FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR KEY SHARE', [origin.conversationId,userId])).rowCount) throw inactiveAssistantTurn();
    await this.freshOrigin(client,userId,origin,signal);
  }
  async list(userId: string, originValue: AssistantTurnOrigin, value: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted(); const origin = parseAssistantTurnOrigin(originValue); parseGoalPlanListInput(value);
    return this.db.transaction(async client => {
      await this.begin(client,userId,origin,signal);
      const found = (await client.query(headerSQL + ` WHERE p.user_id=$1 AND p.conversation_id=$2
        ORDER BY p.created_at DESC,p.id DESC LIMIT 11 FOR SHARE OF p`, [userId,origin.conversationId])).rows;
      await authorizeAssistantTurn(client,userId,origin,signal);
      const result = bounded({ ...markers, limit: GOAL_PLAN_READER_LIST_LIMIT, hasMore: found.length > GOAL_PLAN_READER_LIST_LIMIT,
        plans: found.slice(0,GOAL_PLAN_READER_LIST_LIMIT).map(header) });
      await this.freshOrigin(client,userId,origin,signal); signal?.throwIfAborted(); return result;
    });
  }
  async read(userId: string, originValue: AssistantTurnOrigin, value: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted(); const origin = parseAssistantTurnOrigin(originValue), input = parseGoalPlanReadInput(value);
    return this.db.transaction(async client => {
      await this.begin(client,userId,origin,signal);
      const row = (await client.query(headerSQL + ' WHERE p.id=$1 AND p.user_id=$2 AND p.conversation_id=$3 FOR SHARE OF p', [input.planId,userId,origin.conversationId])).rows[0];
      await this.freshOrigin(client,userId,origin,signal); if (!row) throw notFound();
      if (row.revision !== input.revision) throw planChanged();
      // A receipt writer holds job -> step. Lock the referenced jobs before reading/locking steps.
      await client.query(`SELECT j.id FROM platform_jobs j JOIN platform_goal_plan_steps s ON s.job_id=j.id
        WHERE s.plan_id=$1 AND s.revision=$2 AND j.user_id=$3 ORDER BY j.id FOR SHARE OF j`, [input.planId,input.revision,userId]);
      signal?.throwIfAborted();
      await client.query(`SELECT m.id FROM platform_messages m JOIN platform_goal_plan_steps s ON s.message_id=m.id
        WHERE s.plan_id=$1 AND s.revision=$2 AND m.conversation_id=$3 ORDER BY m.id FOR SHARE OF m`, [input.planId,input.revision,origin.conversationId]);
      signal?.throwIfAborted();
      await client.query('SELECT step_index FROM platform_goal_plan_steps WHERE plan_id=$1 AND revision=$2 ORDER BY step_index FOR SHARE', [input.planId,input.revision]);
      await authorizeAssistantTurn(client,userId,origin,signal);
      const textRow = (await client.query(`SELECT left(goal,1536) AS goal_text,char_length(goal) AS goal_characters
        FROM platform_goal_plan_revisions WHERE plan_id=$1 AND revision=$2`, [input.planId,input.revision])).rows[0];
      const rows = (await client.query(stepSQL, [input.planId,input.revision,userId,input.stepIndex ?? null])).rows;
      signal?.throwIfAborted();
      if (!textRow || rows.length !== row.step_count || rows.some((step,index) => step.step_index !== index)) throw unavailable();
      const steps = rows.map(projectGoalPlanReaderStep);
      for (const [index,step] of steps.entries()) if ((step.state === 'pending' || step.state === 'needs_approval') && steps.slice(0,index).some(previous => previous.state !== 'succeeded')) {
        step.state = 'blocked'; step.blockReason = 'PREVIOUS_RESULT_NOT_SUCCEEDED';
      }
      const result = { ...markers, stateMeaning: 'saved_record_only' as const, plan: header(row),
        goal: goalPlanReaderText(textRow.goal_text,textRow.goal_characters,1536), steps,
        allStepsHaveSuccessReceipts: steps.every(step => step.state === 'succeeded'),
        ...(input.stepIndex === undefined ? {} : { selectedStep: this.selectedStep(rows[input.stepIndex]) }) };
      if (result.selectedStep) {
        // Keep complete metadata; only this explicitly marked user-authored text is clipped to the remaining budget.
        const original = result.selectedStep.inputText;
        result.selectedStep.inputText = { text: '', totalCharacters: original.totalCharacters, truncated: original.totalCharacters > 0 };
        const remaining = GOAL_PLAN_READER_MAX_BYTES - Buffer.byteLength(JSON.stringify(result),'utf8') - 64;
        if (remaining < 2) throw unavailable();
        result.selectedStep.inputText = goalPlanReaderText(original.text,original.totalCharacters,Math.min(6144,remaining));
      }
      bounded(result); await this.freshOrigin(client,userId,origin,signal); signal?.throwIfAborted(); return result;
    });
  }
  private selectedStep(row: any) {
    if (!row) throw invalid('Choose an existing step in this plan revision.');
    if (typeof row.title !== 'string' || row.title.length > 120 || typeof row.selected_text !== 'string' ||
      !Number.isInteger(row.selected_text_characters) || row.selected_text_characters < 1 ||
      !Number.isInteger(row.static_attachment_count) || row.static_attachment_count < 0 || row.static_attachment_count > 10 ||
      !Number.isInteger(row.binding_count) || row.binding_count < 0 || row.binding_count > 5) throw unavailable();
    const provider = typeof row.provider === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(row.provider) ? row.provider : undefined;
    const model = typeof row.model === 'string' && row.model.length <= 150 && !row.model.includes('://') && !/[\u0000-\u001f\u007f]/.test(row.model) ? row.model : undefined;
    return { index: row.step_index, title: row.title, kind: row.kind, ...(row.kind === 'task' ? { taskKind: row.task_kind } : {}),
      ...(provider ? { provider } : {}), ...(model ? { model } : {}), configurationMetadataOmitted: provider === undefined || row.model != null && model === undefined,
      inputTextMeaning: row.kind === 'task' ? 'plan_template_not_resolved_execution_input' as const : 'analysis_instruction' as const,
      inputText: goalPlanReaderText(row.selected_text,row.selected_text_characters,6144), staticAttachmentCount: row.static_attachment_count, bindingCount: row.binding_count,
      executionOptionsIncluded: false, effectiveInputIncluded: false };
  }
}
