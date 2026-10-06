import type { Job } from '@companion/platform-contracts';
import { BROWSER_ACTION_LIMIT, parseBrowserAction } from './browser-plan.ts';

function browserRequiresReview(job: Job): boolean {
  if (['BROWSER_REVIEW_REQUIRED', 'BROWSER_EXECUTION_UNCERTAIN', 'BROWSER_CHECKPOINT_UNCERTAIN'].includes(job.error?.code || '')) return true;
  const actions = job.options?.actions;
  if (actions !== undefined) {
    if (!Array.isArray(actions) || actions.length > BROWSER_ACTION_LIMIT) return true;
    try { actions.forEach(parseBrowserAction); } catch { return true; }
  }
  const execution = job.browserExecution;
  if (execution !== undefined) {
    const validCounts = Number.isSafeInteger(execution?.completedActions) && Number.isSafeInteger(execution?.totalActions) && execution.completedActions === 0 && execution.totalActions >= 0 && execution.totalActions <= BROWSER_ACTION_LIMIT;
    return !validCounts || execution?.reviewRequired !== false || execution?.state !== 'ready';
  }
  if (Array.isArray(actions) && actions.length) return true;
  const rawUrl = job.options?.url;
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > 4096) return true;
  try { const url = new URL(rawUrl); return !['http:', 'https:'].includes(url.protocol) || !!url.username || !!url.password; }
  catch { return true; }
}

export function jobRetryPresentation(job: Job): { canRetry: boolean; label: string; note: string } {
  const terminalState = ['failed', 'cancelled', 'uncertain'].includes(job.status);
  const terminalProvider = ['VIDEO_GENERATION_FAILED', 'MEDIA_GENERATION_FAILED', 'COMFYUI_FAILED', 'COMFYUI_NO_OUTPUT', 'COMFYUI_REJECTED'].includes(job.error?.code || '');
  const cancellationPending = job.error?.code === 'CANCELLATION_PENDING';
  const comfySubmissionUnknown = job.provider === 'comfyui' && job.status === 'uncertain' && !job.providerTaskId;
  const workflowResume = job.kind === 'workflow' && terminalState && job.workflowResumeAvailable === true;
  const workflowUnknown = job.kind === 'workflow' && terminalState && !workflowResume && (job.workflowResumeAvailable === false || job.status === 'uncertain' || job.workflowSteps?.some((step) => ['started', 'uncertain'].includes(step.state)) || ['WORKFLOW_REVIEW_REQUIRED', 'WORKFLOW_STEP_UNCERTAIN', 'WORKFLOW_CHECKPOINT_UNCERTAIN'].includes(job.error?.code || ''));
  const workflowPolling = job.kind === 'workflow' && terminalState && (workflowResume || job.workflowSteps?.some((step) => step.state === 'provider_task'));
  const continuePolling = !!job.providerTaskId && !terminalProvider && job.status !== 'uncertain';
  const browserReview = job.kind === 'browser' && terminalState && browserRequiresReview(job);
  const canRetry = terminalState && !cancellationPending && !comfySubmissionUnknown && job.error?.code !== 'CLI_CLEANUP_UNCONFIRMED' && !workflowUnknown && !browserReview;
  const label = workflowPolling ? '审阅后继续' : terminalProvider ? '重新生成' : job.status === 'uncertain' ? '审阅后重试' : continuePolling ? '继续查询' : '重试';
  const note = cancellationPending ? '取消请求已提交，正在等待执行停止确认，暂时不能重试。'
    : browserReview ? '这份网页计划已有执行记录或结果尚未确认。请检查部分结果，再创建新的完整计划，当前任务不会自动重新执行。'
    : workflowUnknown ? '这一步的外部执行结果尚未确认。请核对供应商结果和已有产物，当前任务不会自动重新执行。'
    : job.error?.code === 'CLI_CLEANUP_UNCONFIRMED' ? '运行环境停止状态需要管理员确认后才能重试。'
    : comfySubmissionUnknown ? '上次生成请求的结果尚未确认。请核对已有结果，当前任务不能重新提交。'
    : workflowPolling ? '已完成步骤与产物会保留；如已有供应商任务，会继续查询该任务。尚未完成的步骤可能发起新请求并产生费用。'
    : terminalProvider ? '重新生成会请求新的审批，并可能产生额外费用。'
    : job.status === 'uncertain' ? '上次执行结果尚未确认。请先核对结果，再决定是否批准重试。'
    : continuePolling ? '继续查询同一个生成任务，不会创建新的生成请求。' : '';
  return { canRetry: Boolean(canRetry), label, note };
}
