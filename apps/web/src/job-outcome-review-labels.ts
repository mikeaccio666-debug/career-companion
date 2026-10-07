import type { Job } from '@companion/platform-contracts';

/** This only exposes a read/review entry. The owned API decides write eligibility. */
export function hasJobOutcomeReviewEntry(job: Job): boolean {
  if (job.status === 'uncertain') return true;
  if (!['failed', 'cancelled'].includes(job.status)) return false;
  if (['CLI_CLEANUP_UNCONFIRMED', 'MODEL_RELAY_UNCERTAIN', 'EXECUTION_UNCERTAIN', 'EXECUTION_INTERRUPTED', 'OPERATOR_REVIEW_REQUIRED', 'QUEUE_REVIEW_REQUIRED', 'COMFYUI_SUBMISSION_UNCERTAIN', 'COMFYUI_REVIEW_REQUIRED', 'BROWSER_REVIEW_REQUIRED', 'BROWSER_EXECUTION_UNCERTAIN', 'BROWSER_CHECKPOINT_UNCERTAIN', 'WORKFLOW_REVIEW_REQUIRED', 'WORKFLOW_STEP_UNCERTAIN', 'WORKFLOW_CHECKPOINT_UNCERTAIN', 'MCP_REVIEW_REQUIRED', 'MCP_EXECUTION_UNCERTAIN', 'MCP_CALL_UNCERTAIN'].includes(job.error?.code || '')) return true;
  if (job.kind === 'browser' && (job.browserExecution?.reviewRequired || ['started', 'uncertain'].includes(job.browserExecution?.state || ''))) return true;
  if (job.kind === 'browser' && !job.browserExecution && Array.isArray(job.options?.actions) && job.options.actions.length > 0) return true;
  if (job.kind === 'workflow' && !job.workflowSteps) return true;
  if (job.kind === 'workflow' && job.workflowSteps?.some((step) => ['started', 'uncertain'].includes(step.state))) return true;
  return job.kind === 'mcp' && Number.isSafeInteger(job.attempt) && job.attempt > 0;
}

export const jobOutcomeLabels = {
  observed_effect: '在外部系统看到了结果',
  no_effect_observed: '核对后未找到结果',
  still_unknown: '仍无法判断执行结果',
} as const;
export const JOB_OUTCOME_REVIEW_BOUNDARY = '这是用户核对记录，不是服务器成功回执。保存不会重试、清除执行记录、批准新任务或推进计划。';
export const JOB_OUTCOME_NOT_FOUND_BOUNDARY = '未找到结果不表示执行没有发生，也不表示可以安全重试。';
