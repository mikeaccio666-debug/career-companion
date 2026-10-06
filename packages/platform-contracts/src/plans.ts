import type { Approval, Artifact, CreateJobInput, Job } from './index.ts';

export const GOAL_PLAN_MAX_STEPS = 8;
export const GOAL_PLAN_MAX_BYTES = 192 * 1024;
export const GOAL_PLAN_MAX_CHECKPOINT_CHARACTERS = 20_000;
export const GOAL_PLAN_LIMIT = 50;
export const GOAL_PLAN_GOAL_CHARACTERS = 8_000;
export const GOAL_PLAN_INSTRUCTION_CHARACTERS = 6_000;
export const GOAL_PLAN_RESULT_INDEX_MAX = 63;
/** Indexes are zero-based; omitted artifact/image indexes select the first matching receipt result. */
export interface GoalPlanPromptBinding { fromStep: number; source: 'analysis_text' | 'artifact_text'; artifactIndex?: number; mode: 'append' | 'replace' }
export interface GoalPlanImageBinding { fromStep: number; imageIndex?: number }
export interface GoalPlanTaskBindings { prompt?: GoalPlanPromptBinding; referenceImages?: GoalPlanImageBinding[] }
export interface GoalPlanTaskInput { kind: 'task'; title: string; task: CreateJobInput; bindings?: GoalPlanTaskBindings }
/** Full content is frozen into resolvedTask; these are factual, server-resolved provenance records. */
export type GoalPlanInputSource =
  | { source: 'analysis_text'; fromStep: number; mode: 'append' | 'replace'; messageId: string; sha256: string; byteSize: number }
  | { source: 'artifact_text'; fromStep: number; mode: 'append' | 'replace'; artifactIndex: number; jobId: string; generation: number; artifactId: string; mime: string; sha256: string; byteSize: number }
  | { source: 'reference_image'; fromStep: number; imageIndex: number; jobId: string; generation: number; artifactId: string; attachmentId: string; mime: string; sha256: string; byteSize: number };
export interface GoalPlanInputSnapshot { planId: string; revision: number; stepIndex: number; templateHash: string; effectiveInputHash: string; inputSources: GoalPlanInputSource[] }
export interface GoalPlanAgentInput { kind: 'agent_turn'; title: string; instruction: string; provider: string; model?: string }
export type GoalPlanStepInput = GoalPlanTaskInput | GoalPlanAgentInput;
export interface GoalPlanInput { title: string; goal: string; steps: GoalPlanStepInput[] }
export type GoalPlanStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
export type GoalPlanStepState = 'pending' | 'needs_approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain' | 'blocked';
/** Only artifacts published by this exact successful job generation. */
export interface GoalPlanTaskReceipt { kind: 'task'; jobId: string; generation: number; artifactIds: string[]; completedAt: string }
/** The server-bound assistant message, not a user claim of completion. */
export interface GoalPlanAgentReceipt { kind: 'agent_turn'; messageId: string; completedAt: string }
export type GoalPlanReceipt = GoalPlanTaskReceipt | GoalPlanAgentReceipt;
export interface GoalPlanStep {
  index: number;
  input: GoalPlanStepInput;
  state: GoalPlanStepState;
  ready: boolean;
  blockReason?: string;
  job?: Job;
  generation?: number;
  approval?: Approval & { generation: number };
  /** Saved outputs are tied to receipt generation; never inferred from all job artifacts. */
  artifacts: Artifact[];
  messageId?: string;
  receipt?: GoalPlanReceipt;
  /** Present only after preparation; this exact input is covered by the individual job approval. */
  resolvedTask?: CreateJobInput;
  inputSources?: GoalPlanInputSource[];
}
export interface GoalPlan extends Omit<GoalPlanInput, 'steps'> {
  id: string;
  conversationId: string;
  revision: number;
  status: GoalPlanStatus;
  definitionHash: string;
  steps: GoalPlanStep[];
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}
export interface GoalPlanList { plans: GoalPlan[]; /** Most recent bounded list. */ limit: number }
/** Only an explicit POST to the existing conversation messages endpoint runs this analysis. */
export interface GoalPlanContinuation { planId: string; revision: number; stepIndex: number; conversationId: string }
export type GoalPlanContinueResult =
  | { kind: 'task'; plan: GoalPlan; stepIndex: number; job: Job; approval?: Approval & { generation: number } }
  | { kind: 'agent_turn'; plan: GoalPlan; stepIndex: number; continuation: GoalPlanContinuation }
  | { kind: 'existing'; plan: GoalPlan; stepIndex: number };

/** API: owned conversation GET/POST goal-plans; goal-plans/:id GET/PUT,
 * POST confirm {revision}, continue {revision,stepIndex}, state {revision,status}.
 * PUT edits only a draft and increments revision. Confirmation freezes its input.
 * Continue is idempotent for an existing step and never approves or calls a model.
 * Agent execution: POST conversations/:id/messages {goalPlanStep: continuation};
 * the server fixes provider/model/agent mode/content from the confirmed definition.
 */
