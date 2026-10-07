import type { JobKind, JobStatus } from './index.ts';

export const JOB_OUTCOME_REVIEW_HISTORY_LIMIT = 20;
export const JOB_OUTCOME_REVIEW_NOTE_CHARACTERS = 2000;
export const JOB_OUTCOME_REVIEW_NOTE_BYTES = 8 * 1024;
export const JOB_OUTCOME_REVIEW_MAX_RESPONSE_BYTES = 192 * 1024;
export const JOB_OUTCOME_REVIEW_OUTCOMES = ['observed_effect', 'no_effect_observed', 'still_unknown'] as const;
export type JobOutcomeReviewOutcome = typeof JOB_OUTCOME_REVIEW_OUTCOMES[number];
export type JobOutcomeReviewReason = 'job_uncertain' | 'browser_execution_started' | 'browser_checkpoint_missing' |
  'workflow_result_unknown' | 'workflow_checkpoint_missing' | 'mcp_call_recorded' | 'cli_cleanup_unconfirmed' |
  'model_relay_uncertain' | 'comfyui_submission_unknown';
export interface JobOutcomeReviewInput {
  generation: number;
  evidenceVersion: string;
  expectedRevision: number;
  requestId: string;
  outcome: JobOutcomeReviewOutcome;
  note?: string;
}
/** A user's observation never changes execution state or grants replay permission. */
export interface JobOutcomeReviewRecord {
  id: string;
  jobId: string;
  generation: number;
  revision: number;
  requestId: string;
  evidenceVersion: string;
  outcome: JobOutcomeReviewOutcome;
  note?: string;
  provenance: 'user_reported';
  verified: false;
  createdAt: string;
}
/** Safe summaries only: no prompts, arguments, URLs, provider handles or raw errors. */
export interface JobOutcomeEvidence {
  version: string;
  generation: number;
  kind: JobKind;
  status: JobStatus;
  totalAttempts: number;
  hasProviderTask: boolean;
  cleanupPending: boolean;
  reasons: JobOutcomeReviewReason[];
  attempts: { attempt: number; status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain'; hasProviderTask: boolean }[];
  attemptsHasMore: boolean;
  /** A task-wide checkpoint can retain completed work from earlier attempts. */
  browser?: { scope: 'task_checkpoint'; revision: number; state: 'ready' | 'started' | 'completed' | 'uncertain'; completedActions: number; totalActions: number };
  workflow?: { scope: 'task_checkpoint'; revision: number; steps: { index: number; state: 'started' | 'provider_task' | 'completed' | 'failed' | 'uncertain'; hasProviderTask: boolean }[] };
  /** Receipt generation is explicit, including a receipt that predates the current job version. */
  mcp?: { generation: number; status: 'started' | 'completed' | 'tool_error' | 'uncertain'; hasSavedResult: boolean };
}
export interface JobOutcomeReviewPage {
  jobId: string;
  requestedGeneration: number;
  currentGeneration: number;
  /** Historical requests never receive current execution facts. */
  evidence: JobOutcomeEvidence | null;
  writeEligibility: { allowed: boolean; reason: null | 'historical_generation' | 'cleanup_pending' | 'not_reviewable' };
  latestRevision: number;
  /** Newest first, only for requestedGeneration. */
  records: JobOutcomeReviewRecord[];
  hasMore: boolean;
}
export interface JobOutcomeReviewSaved { record: JobOutcomeReviewRecord }
