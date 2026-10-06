import { GOAL_PLAN_LIMIT, GOAL_PLAN_MAX_BYTES, GOAL_PLAN_MAX_STEPS, type GoalPlan, type GoalPlanContinuation, type GoalPlanContinueResult, type GoalPlanInput, type GoalPlanList, type GoalPlanTaskReceipt, type Job, type McpResult } from '@companion/platform-contracts';
import { goalInputToDraft, parseGoalDraft } from './goal-plans-editor.ts';
import { parseMcpSummary } from './mcp-editor.ts';
import { assertGoalPlanInputSources } from './goal-plan-inputs.ts';

export type GoalPlanTransport = <T>(path: string, init?: RequestInit) => Promise<T>;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1_000_000;
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const states = ['pending', 'needs_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain', 'blocked'];
const statuses = ['draft', 'active', 'paused', 'completed', 'cancelled'];
const jobStatuses = ['needs_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain'];
/** A GET contains the definition plus resolved tasks, jobs and approval inputs.
 * JSON strings may require six bytes per UTF-16 code unit after escaping.
 * Reserve bounded per-step space for receipt/source/artifact metadata as well. */
export const GOAL_PLAN_RESPONSE_MAX_BYTES = GOAL_PLAN_MAX_BYTES * 4 + GOAL_PLAN_MAX_STEPS * (20_000 * 6 * 3 + 128 * 1024);
const invalid = () => new Error('计划的版本、步骤或已保存成果不完整，请重新读取。');
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function assertGoalMcpResult(result: McpResult, job: Job, receipt: GoalPlanTaskReceipt): void {
  const summary = parseMcpSummary(job.mcp);
  if (job.kind !== 'mcp' || receipt.jobId !== job.id || !summary || result.source.jobId !== receipt.jobId || result.source.generation !== receipt.generation || !receipt.artifactIds.includes(result.source.artifactId) || Object.entries(summary).some(([key, value]) => result.source[key as keyof typeof summary] !== value)) throw new Error('结果不属于本计划绑定的成功版本，请重新核对计划和任务记录。');
}
function artifact(value: unknown): boolean { return isObject(value) && typeof value.id === 'string' && uuid.test(value.id) && typeof value.name === 'string' && typeof value.mime === 'string' && typeof value.url === 'string' && (value.size === undefined || Number.isSafeInteger(value.size) && Number(value.size) >= 0); }
function fingerprint(value: unknown): string { return JSON.stringify(value, (_key, item) => isObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
/** Reject the complete response when one record is malformed; a bad response is never an empty plan list. */
export function parseGoalPlan(value: unknown, conversationId: string, planId?: string): GoalPlan {
  if (!isObject(value)) throw invalid();
  const plan = value as unknown as GoalPlan;
  if (!uuid.test(plan.id) || planId !== undefined && plan.id !== planId || plan.conversationId !== conversationId || !uuid.test(conversationId) || !positive(plan.revision) || !statuses.includes(plan.status) || !/^[0-9a-f]{64}$/i.test(plan.definitionHash) || !date(plan.createdAt) || !date(plan.updatedAt) || plan.confirmedAt !== undefined && !date(plan.confirmedAt) || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > GOAL_PLAN_MAX_STEPS) throw invalid();
  try { parseGoalDraft(goalInputToDraft({ title: plan.title, goal: plan.goal, steps: plan.steps.map((step) => step.input) })); } catch { throw invalid(); }
  for (const [index, step] of plan.steps.entries()) {
    if (!step || step.index !== index || !states.includes(step.state) || typeof step.ready !== 'boolean' || step.blockReason !== undefined && typeof step.blockReason !== 'string' || !Array.isArray(step.artifacts) || step.artifacts.some((item) => !artifact(item)) || new Set(step.artifacts.map((item) => item.id)).size !== step.artifacts.length || step.generation !== undefined && !positive(step.generation) || step.messageId !== undefined && !uuid.test(step.messageId)) throw invalid();
    const job = step.job;
    if (job && (!uuid.test(job.id) || !jobStatuses.includes(job.status) || typeof job.provider !== 'string' || typeof job.prompt !== 'string' || !Array.isArray(job.artifacts) || job.artifacts.some((item) => !artifact(item)) || step.input.kind !== 'task' || job.kind !== step.input.task.kind || !positive(step.generation))) throw invalid();
    if (step.approval) {
      const approval = step.approval;
      if (!job || !uuid.test(approval.id) || approval.jobId !== job.id || job.status !== 'needs_approval' || step.state !== 'needs_approval' || approval.status !== 'pending' || approval.generation !== step.generation || !positive(approval.generation) || !isObject(approval.args) || approval.toolName !== job.kind || approval.args.kind !== job.kind || approval.args.provider !== job.provider || approval.args.prompt !== job.prompt) throw invalid();
      for (const field of ['model', 'options', 'attachmentIds', 'executionTemplate'] as const) { const fallback = field === 'options' ? {} : field === 'attachmentIds' ? [] : null; if (fingerprint(approval.args[field] ?? fallback) !== fingerprint(job[field] ?? fallback)) throw invalid(); }
    }
    const receipt = step.receipt;
    if (receipt) {
      if (!date(receipt.completedAt) || receipt.kind !== step.input.kind) throw invalid();
      if (receipt.kind === 'task') {
        if (!uuid.test(receipt.jobId) || !positive(receipt.generation) || receipt.generation !== step.generation || job && receipt.jobId !== job.id || !Array.isArray(receipt.artifactIds) || receipt.artifactIds.some((id) => !uuid.test(id)) || new Set(receipt.artifactIds).size !== receipt.artifactIds.length || step.artifacts.some((item) => !receipt.artifactIds.includes(item.id))) throw invalid();
      } else if (!uuid.test(receipt.messageId) || receipt.messageId !== step.messageId && !(step.state === 'blocked' && step.messageId === undefined)) throw invalid();
    } else if (step.artifacts.length || step.state === 'succeeded') throw invalid();
    if (step.state === 'succeeded' && !receipt) throw invalid();
    if (step.ready && (plan.status !== 'active' || step.state !== 'pending' || plan.steps.slice(0, index).some((prior) => prior.state !== 'succeeded'))) throw invalid();
  }
  for (const step of plan.steps) assertGoalPlanInputSources(plan, step);
  if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > GOAL_PLAN_RESPONSE_MAX_BYTES) throw invalid();
  return plan;
}
export function parseGoalPlanList(value: unknown, conversationId: string): GoalPlanList {
  if (!isObject(value) || value.limit !== GOAL_PLAN_LIMIT || !Array.isArray(value.plans) || value.plans.length > GOAL_PLAN_LIMIT) throw invalid();
  const plans = value.plans.map((plan) => parseGoalPlan(plan, conversationId));
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length) throw invalid();
  return { plans, limit: GOAL_PLAN_LIMIT };
}
export function parseGoalPlanContinue(value: unknown, conversationId: string, planId: string, stepIndex: number): GoalPlanContinueResult {
  if (!isObject(value) || !['task', 'agent_turn', 'existing'].includes(String(value.kind)) || value.stepIndex !== stepIndex) throw invalid();
  const plan = parseGoalPlan(value.plan, conversationId, planId), step = plan.steps[stepIndex]; if (!step) throw invalid();
  if (value.kind === 'agent_turn') {
    const continuation = value.continuation as GoalPlanContinuation | undefined;
    if (step.input.kind !== 'agent_turn' || !continuation || continuation.planId !== planId || continuation.conversationId !== conversationId || continuation.revision !== plan.revision || continuation.stepIndex !== stepIndex) throw invalid();
    return { kind: 'agent_turn', plan, stepIndex, continuation };
  }
  if (value.kind === 'task') {
    const job = value.job;
    if (!step.job || !isObject(job) || job.id !== step.job.id || JSON.stringify(value.approval) !== JSON.stringify(step.approval)) throw invalid();
    return { kind: 'task', plan, stepIndex, job: step.job, ...(step.approval ? { approval: step.approval } : {}) };
  }
  return { kind: 'existing', plan, stepIndex };
}
export function createGoalPlanClient(transport: GoalPlanTransport, conversationId: string) {
  if (!uuid.test(conversationId)) throw new Error('请先建立原会话，再保存计划。');
  const base = `/conversations/${encodeURIComponent(conversationId)}/goal-plans`;
  const path = (id: string) => { if (!uuid.test(id)) throw invalid(); return `/goal-plans/${encodeURIComponent(id)}`; };
  async function planRequest(url: string, init?: RequestInit, id?: string) { const result = await transport<unknown>(url, init); if (!isObject(result)) throw invalid(); return parseGoalPlan(result.plan, conversationId, id); }
  const body = (value: unknown, signal?: AbortSignal, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(value), signal });
  return {
    list: async (signal?: AbortSignal) => parseGoalPlanList(await transport(base, { signal }), conversationId),
    read: (id: string, signal?: AbortSignal) => planRequest(path(id), { signal }, id),
    create: (input: GoalPlanInput, signal?: AbortSignal) => planRequest(base, body(input, signal)),
    save: (id: string, revision: number, input: GoalPlanInput, signal?: AbortSignal) => planRequest(path(id), body({ ...input, revision }, signal, 'PUT'), id),
    confirm: (id: string, revision: number, signal?: AbortSignal) => planRequest(`${path(id)}/confirm`, body({ revision }, signal), id),
    state: (id: string, revision: number, status: 'paused' | 'active' | 'cancelled', signal?: AbortSignal) => planRequest(`${path(id)}/state`, body({ revision, status }, signal), id),
    continue: async (id: string, revision: number, stepIndex: number, signal?: AbortSignal) => parseGoalPlanContinue(await transport(`${path(id)}/continue`, body({ revision, stepIndex }, signal)), conversationId, id, stepIndex),
  };
}
