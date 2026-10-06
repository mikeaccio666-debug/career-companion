import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job } from '@companion/platform-contracts';
import { jobRetryPresentation } from '../src/job-retry.ts';

const workflow = (change: Partial<Job> = {}): Job => ({ id: 'fictional-job', kind: 'workflow', provider: 'workflow', prompt: 'Fictional workflow goal.', status: 'failed', progress: 25, artifacts: [], createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', attempt: 1, workflowSteps: [{ index: 0, kind: 'image', provider: 'fal', state: 'completed' }, { index: 1, kind: 'video', provider: 'ark', state: 'provider_task' }], ...change });

test('workflow provider-task recovery is labelled by step checkpoints without a top-level handle', () => {
  const presentation = jobRetryPresentation(workflow());
  assert.equal(presentation.canRetry, true);
  assert.equal(presentation.label, '审阅后继续');
  assert.match(presentation.note, /已完成步骤.*保留/);
  assert.match(presentation.note, /已有供应商任务.*查询该任务/);
  assert.match(presentation.note, /未完成.*费用/);
  assert.equal(jobRetryPresentation(workflow({ status: 'uncertain', workflowResumeAvailable: true })).label, '审阅后继续');
});

test('unknown started and uncertain workflow steps have no ordinary retry action', () => {
  for (const state of ['started', 'uncertain'] as const) {
    const presentation = jobRetryPresentation(workflow({ workflowSteps: [{ index: 0, kind: 'image', provider: 'openai', state }] }));
    assert.equal(presentation.canRetry, false);
    assert.match(presentation.note, /核对供应商结果/);
  }
  for (const code of ['WORKFLOW_REVIEW_REQUIRED', 'WORKFLOW_STEP_UNCERTAIN', 'WORKFLOW_CHECKPOINT_UNCERTAIN']) assert.equal(jobRetryPresentation(workflow({ error: { code, message: 'Fictional public failure.' } })).canRetry, false);
});

test('only an explicit API recovery flag releases uncertain workflow results', () => {
  for (const state of ['started', 'uncertain'] as const) {
    const steps: Job['workflowSteps'] = [{ index: 0, kind: 'video', provider: 'ark', state }];
    const allowed = jobRetryPresentation(workflow({ status: 'uncertain', workflowSteps: steps, workflowResumeAvailable: true }));
    assert.equal(allowed.canRetry, true);
    assert.equal(allowed.label, '审阅后继续');
    assert.match(allowed.note, /已完成步骤.*保留/);
    assert.match(allowed.note, /费用/);
    assert.equal(jobRetryPresentation(workflow({ status: 'uncertain', workflowSteps: steps })).canRetry, false);
    assert.equal(jobRetryPresentation(workflow({ status: 'uncertain', workflowSteps: steps, workflowResumeAvailable: false })).canRetry, false);
  }
  assert.equal(jobRetryPresentation(workflow({ status: 'uncertain', workflowSteps: undefined, providerTaskId: 'not-a-workflow-recovery-proof' })).canRetry, false);
  assert.equal(jobRetryPresentation(workflow({ workflowResumeAvailable: false })).canRetry, false);
});

test('active workflows are not presented as recovery actions and explicit failures remain retryable', () => {
  assert.deepEqual(jobRetryPresentation(workflow({ status: 'running' })), { canRetry: false, label: '重试', note: '' });
  const failure = workflow({ workflowSteps: [{ index: 0, kind: 'image', provider: 'openai', state: 'failed' }] });
  assert.equal(jobRetryPresentation(failure).canRetry, true);
  assert.equal(jobRetryPresentation(failure).label, '重试');
});

test('ordinary media polling and unconfirmed CLI shutdown retain their execution boundaries', () => {
  assert.equal(jobRetryPresentation(workflow({ kind: 'video', provider: 'ark', providerTaskId: 'fictional-handle' })).label, '继续查询');
  assert.match(jobRetryPresentation(workflow({ kind: 'video', provider: 'ark', providerTaskId: 'fictional-handle' })).note, /同一个生成任务/);
  const cleanup = jobRetryPresentation(workflow({ kind: 'cli', provider: 'cli', error: { code: 'CLI_CLEANUP_UNCONFIRMED', message: 'Fictional cleanup message.' } }));
  assert.equal(cleanup.canRetry, false);
  assert.match(cleanup.note, /停止状态/);
});

test('cancellation awaiting shutdown hides retry even when provider polling or workflow recovery is available', () => {
  const pending = { code: 'CANCELLATION_PENDING', message: 'Fictional shutdown pending.' };
  for (const job of [
    workflow({ status: 'cancelled', workflowResumeAvailable: true, error: pending }),
    workflow({ kind: 'video', provider: 'ark', status: 'cancelled', providerTaskId: 'fictional-handle', error: pending }),
  ]) {
    const presentation = jobRetryPresentation(job);
    assert.equal(presentation.canRetry, false);
    assert.match(presentation.note, /等待执行停止确认/);
    assert.doesNotMatch(presentation.note, /不会创建新的生成请求|已完成步骤/);
  }
  assert.equal(jobRetryPresentation(workflow({ kind: 'video', provider: 'ark', status: 'cancelled', workflowSteps: undefined })).canRetry, true);
});

test('unknown ComfyUI submission cannot be resubmitted without a provider handle', () => {
  const job = workflow({ kind: 'image', provider: 'comfyui', status: 'uncertain', workflowSteps: undefined, error: { code: 'COMFYUI_SUBMISSION_UNCERTAIN', message: 'Fictional unknown submission.' } });
  const presentation = jobRetryPresentation(job);
  assert.equal(presentation.canRetry, false);
  assert.match(presentation.note, /核对已有结果/);
  assert.match(presentation.note, /不能重新提交/);
  assert.equal(jobRetryPresentation({ ...job, providerTaskId: 'fictional-handle' }).canRetry, true);
  assert.equal(jobRetryPresentation({ ...job, status: 'failed' }).canRetry, true);
  assert.equal(jobRetryPresentation({ ...job, provider: 'fal' }).canRetry, true);
});

test('confirmed terminal provider failures explain fresh generation approval and possible additional cost', () => {
  for (const code of ['VIDEO_GENERATION_FAILED', 'MEDIA_GENERATION_FAILED', 'COMFYUI_FAILED', 'COMFYUI_NO_OUTPUT', 'COMFYUI_REJECTED']) {
    const presentation = jobRetryPresentation(workflow({ kind: 'image', provider: 'comfyui', workflowSteps: undefined, providerTaskId: 'fictional-handle', error: { code, message: 'Fictional confirmed failure.' } }));
    assert.equal(presentation.canRetry, true);
    assert.equal(presentation.label, '重新生成');
    assert.match(presentation.note, /新的审批/);
    assert.match(presentation.note, /额外费用/);
    assert.doesNotMatch(presentation.note, /同一个生成任务/);
  }
});

test('browser tasks requiring review cannot be retried and partial outcomes remain reviewable', () => {
  const job = workflow({ kind: 'browser', provider: 'browser', options: { url: 'https://example.com/', actions: [{ type: 'scroll', direction: 'down', pixels: 500 }] }, browserExecution: { completedActions: 1, totalActions: 3, state: 'uncertain', reviewRequired: true } });
  const presentation = jobRetryPresentation(job);
  assert.equal(presentation.canRetry, false);
  assert.match(presentation.note, /部分结果|已有执行记录/);
  assert.match(presentation.note, /新的完整计划/);
  assert.equal(jobRetryPresentation({ ...job, browserExecution: undefined }).canRetry, false);
  assert.equal(jobRetryPresentation({ ...job, browserExecution: { completedActions: 0, totalActions: 3, state: 'ready', reviewRequired: false } }).canRetry, true);
  assert.equal(jobRetryPresentation({ ...job, browserExecution: { completedActions: 0, totalActions: 3, state: 'unexpected', reviewRequired: false } as any }).canRetry, false);
});

test('known read-only browser failures retain ordinary retry without an action checkpoint', () => {
  const readonly = workflow({ kind: 'browser', provider: 'browser', options: { url: 'https://example.com/' } });
  assert.equal(jobRetryPresentation(readonly).canRetry, true);
  assert.equal(jobRetryPresentation({ ...readonly, options: { ...readonly.options, actions: [] } }).canRetry, true);
  assert.equal(jobRetryPresentation({ ...readonly, options: { url: 'http://127.0.0.1:4671/fixture' } }).canRetry, true);
  assert.equal(jobRetryPresentation({ ...readonly, options: { url: 'not-a-url' } }).canRetry, false);
  for (const actions of [null, 'invalid', [{ type: 'scroll', direction: 'down', pixels: 500 }]]) assert.equal(jobRetryPresentation({ ...readonly, options: { url: 'https://example.com/', actions } }).canRetry, false);
});

test('existing or malformed browser action records cannot be bypassed by deleting action metadata', () => {
  const readonlyOptions = { url: 'https://example.com/', actions: [] };
  const browser = workflow({ kind: 'browser', provider: 'browser', options: readonlyOptions });
  assert.equal(jobRetryPresentation({ ...browser, browserExecution: { completedActions: 0, totalActions: 1, state: 'started', reviewRequired: false } }).canRetry, false);
  assert.equal(jobRetryPresentation({ ...browser, browserExecution: { completedActions: 1, totalActions: 1, state: 'completed', reviewRequired: false } }).canRetry, false);
  assert.equal(jobRetryPresentation({ ...browser, browserExecution: { state: 'ready', reviewRequired: false } as any }).canRetry, false);
  assert.equal(jobRetryPresentation({ ...browser, browserExecution: { completedActions: 0, totalActions: 1, state: 'unknown', reviewRequired: false } as any }).canRetry, false);
});

test('browser review error codes override a stale permissive progress summary without changing other task kinds', () => {
  const browser = workflow({ kind: 'browser', provider: 'browser', browserExecution: { completedActions: 0, totalActions: 1, state: 'ready', reviewRequired: false }, error: { code: 'BROWSER_REVIEW_REQUIRED', message: 'Fictional review required.' } });
  assert.equal(jobRetryPresentation(browser).canRetry, false);
  assert.equal(jobRetryPresentation({ ...browser, kind: 'image', provider: 'openai' }).canRetry, true);
});

test('MCP started or uncertain calls cannot use ordinary retry while clearly unstarted tasks retain review', () => {
  for (const change of [{ attempt: 1 }, { attempt: 0, status: 'uncertain' as const }, { attempt: 0, error: { code: 'MCP_REVIEW_REQUIRED', message: 'Fictional prior call.' } }, { attempt: undefined as any }]) {
    const result = jobRetryPresentation(workflow({ kind: 'mcp', provider: 'mcp', ...change }));
    assert.equal(result.canRetry, false); assert.match(result.note, /重新准备.*单独批准/);
  }
  assert.equal(jobRetryPresentation(workflow({ kind: 'mcp', provider: 'mcp', attempt: 0, status: 'cancelled' })).canRetry, true);
  assert.equal(jobRetryPresentation(workflow({ kind: 'mcp', provider: 'mcp', attempt: 1, status: 'running' })).canRetry, false);
  assert.equal(jobRetryPresentation(workflow({ kind: 'mcp', provider: 'mcp', attempt: 1, status: 'cancelled', error: { code: 'CANCELLATION_PENDING', message: 'Fictional shutdown pending.' } })).note.includes('等待执行停止确认'), true);
});
