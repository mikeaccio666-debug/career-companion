import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Approval, Conversation, ConversationTaskPage, GoalPlan, GoalPlanInputSnapshot,
  GoalPlanInputSource, Job, JobOutcomeReviewPage, WorkflowTemplate,
} from '@companion/platform-contracts';
import {
  projectPublicApproval, projectPublicConversation, projectPublicConversationTaskPage,
  projectPublicError, projectPublicGoalPlan, projectPublicGoalPlanContinueResult,
  projectPublicGoalPlanInputSnapshot, projectPublicGoalPlanList,
  projectPublicGoalPlanProposalList, projectPublicGoalPlanProposalResult,
  projectPublicJob, projectPublicJobOutcomeReviewPage, projectPublicJobOutcomeReviewSaved,
  projectPublicWorkflowTemplate,
} from '../src/student-projection.ts';

const createdAt = '2026-10-06T00:00:00.000Z';
const text = '课程原文比较 IBM、OpenAI、Claude 和 model/provider；这是用户业务内容。';
const hash = 'c'.repeat(64);
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); }
  return value;
}
function job(): Job & { generation: number } {
  return {
    id: 'synthetic-job', kind: 'workflow', provider: 'comfyui', model: 'private-model', prompt: text,
    options: { steps: [{ provider: 'private-provider', model: 'private-model', prompt: text }] },
    attachmentIds: ['synthetic-upload'], executionTemplate: { version: 1, hash }, providerTaskId: 'private-task-handle',
    status: 'uncertain', progress: 0, attempt: 3, generation: 4,
    artifacts: [{ id: 'synthetic-artifact', name: 'OpenAI-report.txt', mime: 'text/plain', url: '/private/synthetic-artifact', size: 0 }],
    error: { code: 'COMFYUI_SUBMISSION_UNCERTAIN', message: 'Synthetic COMFYUI_BASE_URL detail.' },
    workflowSteps: [{ index: 0, kind: 'chat', provider: 'private-provider', model: 'private-model', state: 'uncertain', errorCode: 'PROVIDER_INTERRUPTED' }],
    workflowResumeAvailable: false, createdAt, updatedAt: createdAt,
  };
}
function approval(): Approval & { generation: number } {
  return { id: 'synthetic-approval', jobId: 'synthetic-job', toolName: 'execute_workflow', args: { prompt: text, provider: 'private-provider', model: 'private-model', token: 'synthetic-secret' }, status: 'pending', generation: 4, createdAt };
}
function inputSources(): GoalPlanInputSource[] {
  return [
    { source: 'analysis_text', fromStep: 0, mode: 'append', messageId: 'synthetic-message', sha256: hash, byteSize: 0 },
    { source: 'artifact_text', fromStep: 1, mode: 'replace', artifactIndex: 0, jobId: 'synthetic-source-job', generation: 2, artifactId: 'synthetic-text', mime: 'text/plain', sha256: hash, byteSize: 8 },
    { source: 'reference_image', fromStep: 1, imageIndex: 0, jobId: 'synthetic-source-job', generation: 2, artifactId: 'synthetic-image', attachmentId: 'synthetic-image-upload', mime: 'image/png', sha256: hash, byteSize: 16 },
    { source: 'artifact_file', fromStep: 1, artifactIndex: 0, jobId: 'synthetic-source-job', generation: 2, artifactId: 'synthetic-file', attachmentId: 'synthetic-file-upload', name: 'OpenAI-report.txt', mime: 'text/plain', sha256: hash, byteSize: 8 },
  ];
}
function plan(): GoalPlan {
  return {
    id: 'synthetic-plan', conversationId: 'synthetic-conversation', revision: 9, status: 'active', definitionHash: hash,
    title: text, goal: text, createdAt, updatedAt: createdAt, confirmedAt: createdAt,
    steps: [
      { index: 0, input: { kind: 'agent_turn', title: text, instruction: text, provider: 'private-provider', model: 'private-model' }, state: 'succeeded', ready: false, artifacts: [], messageId: 'synthetic-message', receipt: { kind: 'agent_turn', messageId: 'synthetic-message', completedAt: createdAt } },
      { index: 1, input: { kind: 'task', title: text, task: { kind: 'image', prompt: text, provider: 'private-provider', model: 'private-model', options: { privateOption: true }, attachmentIds: ['synthetic-upload'], executionTemplate: { version: 1, hash } }, bindings: { prompt: { fromStep: 0, source: 'analysis_text', mode: 'append' }, referenceImages: [], artifactFiles: [{ fromStep: 0, artifactIndex: 0 }] } }, state: 'uncertain', ready: false, blockReason: 'Review the saved result before another attempt.', job: job(), generation: 4, approval: approval(), artifacts: job().artifacts, receipt: { kind: 'task', jobId: 'synthetic-job', generation: 3, artifactIds: ['synthetic-artifact'], completedAt: createdAt }, resolvedTask: { kind: 'image', prompt: text, provider: 'private-provider', options: { internalInput: true } }, inputSources: inputSources() },
    ],
  };
}

test('conversation projection omits internal mode/persona and preserves the original user title', () => {
  const source = freezeDeep<Conversation>({ id: 'synthetic-conversation', title: text, mode: 'agent', persona: 'private-persona', createdAt, updatedAt: createdAt });
  assert.deepEqual(projectPublicConversation(source), { id: source.id, title: text, createdAt, updatedAt: createdAt });
  assert.equal(source.persona, 'private-persona');
});

test('jobs retain unknown state, actual versions and checkpoint facts while removing configuration, handles and execution input', () => {
  const source = freezeDeep(job()), before = structuredClone(source), projected = projectPublicJob(source);
  assert.deepEqual(Object.keys(projected).sort(), ['artifacts', 'attempt', 'createdAt', 'error', 'generation', 'id', 'kind', 'progress', 'status', 'updatedAt', 'workflowResumeAvailable', 'workflowSteps']);
  assert.equal(projected.status, 'uncertain'); assert.equal(projected.generation, 4); assert.equal(projected.attempt, 3); assert.equal(projected.progress, 0);
  assert.deepEqual(projected.workflowSteps, [{ index: 0, kind: 'chat', state: 'uncertain', errorCode: 'RESPONSE_INTERRUPTED' }]);
  assert.equal(projected.error?.code, 'RESULT_UNCONFIRMED');
  assert.equal(projected.workflowResumeAvailable, false);
  assert.equal(projected.artifacts[0].name, 'OpenAI-report.txt'); assert.equal(projected.artifacts[0].size, 0);
  projected.artifacts[0].name = 'changed'; projected.workflowSteps![0].state = 'completed';
  assert.deepEqual(source, before);
  const { generation, workflowSteps, workflowResumeAvailable, error, ...minimal } = job();
  const empty = projectPublicJob({ ...minimal, artifacts: [] });
  for (const field of ['generation', 'workflowSteps', 'workflowResumeAvailable', 'error']) assert.equal(Object.hasOwn(empty, field), false);
  assert.deepEqual(empty.artifacts, []);
});

test('MCP summary names and browser recovery facts are copied without filtering business names or exposing task arguments', () => {
  const source = freezeDeep({ ...job(), kind: 'mcp' as const, mcp: { connectionId: 'synthetic-connection', connectionName: 'OpenAI course resources', catalogId: 'synthetic-catalog', grantVersion: 5, toolName: 'lookup_model_roles', schemaHash: hash } });
  const projected = projectPublicJob(source);
  assert.deepEqual(projected.mcp, source.mcp);
  projected.mcp!.connectionName = 'changed'; assert.equal(source.mcp.connectionName, 'OpenAI course resources');
  const browser = freezeDeep({ ...job(), kind: 'browser' as const, browserExecution: { completedActions: 1, totalActions: 3, state: 'uncertain' as const, reviewRequired: true } });
  const view = projectPublicJob(browser); assert.deepEqual(view.browserExecution, browser.browserExecution);
  view.browserExecution!.completedActions = 3; assert.equal(browser.browserExecution.completedActions, 1);
});

test('approval summaries retain real status/version and do not expose reviewed arguments or imply a grant', () => {
  const source = freezeDeep(approval()), projected = projectPublicApproval(source);
  assert.deepEqual(projected, { id: source.id, jobId: source.jobId, toolName: source.toolName, status: 'pending', generation: 4, createdAt });
  assert.equal(source.args.token, 'synthetic-secret');
  const { generation, ...legacy } = approval(); assert.equal(Object.hasOwn(projectPublicApproval(legacy), 'generation'), false);
});

test('goal plan projection preserves semantic definitions, original hash/revision and exact source/receipt generations with isolated children', () => {
  const source = freezeDeep(plan()), before = structuredClone(source), projected = projectPublicGoalPlan(source);
  assert.equal(projected.definitionHash, hash); assert.equal(projected.revision, 9);
  assert.equal(projected.title, text); assert.equal(projected.goal, text);
  assert.deepEqual(projected.steps[0].input, { kind: 'agent_turn', title: text, instruction: text });
  assert.deepEqual(projected.steps[1].input, { kind: 'task', title: text, task: { kind: 'image', prompt: text }, bindings: source.steps[1].input.kind === 'task' ? source.steps[1].input.bindings : undefined });
  assert.deepEqual(projected.steps[1].resolvedTask, { kind: 'image', prompt: text });
  assert.equal(projected.steps[1].generation, 4);
  assert.deepEqual(projected.steps[1].receipt, { kind: 'task', jobId: 'synthetic-job', generation: 3, artifactIds: ['synthetic-artifact'], completedAt: createdAt });
  assert.deepEqual(projected.steps[1].inputSources, inputSources());
  projected.steps[1].inputSources![0].sha256 = 'changed'; projected.steps[1].artifacts[0].name = 'changed';
  const receipt = projected.steps[1].receipt!; if (receipt.kind === 'task') receipt.artifactIds.push('changed');
  const input = projected.steps[1].input; if (input.kind === 'task') input.bindings!.artifactFiles![0].fromStep = 8;
  projected.steps[1].job!.artifacts[0].name = 'changed';
  assert.deepEqual(source, before);
  const snapshot = freezeDeep<GoalPlanInputSnapshot>({ planId: source.id, revision: 9, stepIndex: 1, templateHash: hash, effectiveInputHash: 'd'.repeat(64), inputSources: inputSources() });
  const copy = projectPublicGoalPlanInputSnapshot(snapshot); assert.deepEqual(copy, snapshot);
  copy.inputSources[0].byteSize = 100; assert.equal(snapshot.inputSources[0].byteSize, 0);
});

test('all continuation/list/proposal variants retain actual IDs, bounded cursors and optional fields without reconstructed execution input', () => {
  const source = freezeDeep(plan());
  const continuation = { planId: source.id, revision: 9, stepIndex: 0, conversationId: source.conversationId };
  const agent = projectPublicGoalPlanContinueResult(freezeDeep({ kind: 'agent_turn', plan: source, stepIndex: 0, continuation }));
  assert.equal(agent.kind, 'agent_turn'); if (agent.kind === 'agent_turn') { assert.deepEqual(agent.continuation, continuation); agent.continuation.revision = 2; }
  assert.equal(continuation.revision, 9);
  const task = projectPublicGoalPlanContinueResult(freezeDeep({ kind: 'task', plan: source, stepIndex: 1, job: job(), approval: approval() }));
  assert.equal(task.kind, 'task'); if (task.kind === 'task') { assert.equal(task.job.status, 'uncertain'); assert.equal(task.approval?.generation, 4); }
  const existing = projectPublicGoalPlanContinueResult({ kind: 'existing', plan: source, stepIndex: 1 }); assert.equal(existing.kind, 'existing');
  const noApproval = projectPublicGoalPlanContinueResult({ kind: 'task', plan: source, stepIndex: 1, job: job() }); assert.equal(Object.hasOwn(noApproval, 'approval'), false);
  assert.deepEqual(projectPublicGoalPlanList({ plans: [], limit: 0 }), { plans: [], limit: 0 });
  const list = projectPublicGoalPlanList({ plans: [source], limit: 50 }); assert.equal(list.plans[0].definitionHash, hash);
  const proposal = freezeDeep({ planId: source.id, conversationId: source.conversationId, title: text, revision: 9, status: 'active' as const, stepCount: 2, messageId: null, createdAt });
  assert.deepEqual(projectPublicGoalPlanProposalResult({ proposal }), { proposal });
  const proposals = projectPublicGoalPlanProposalList({ proposals: [proposal], nextBefore: 'synthetic-cursor', limit: 1 });
  assert.equal(proposals.nextBefore, 'synthetic-cursor'); assert.equal(proposals.proposals[0].messageId, null);
  proposals.proposals[0].title = 'changed'; assert.equal(proposal.title, text);
  assert.deepEqual(projectPublicGoalPlanProposalList({ proposals: [], nextBefore: null, limit: 0 }), { proposals: [], nextBefore: null, limit: 0 });
});

test('conversation task origins and approvals keep server-bound generation separate from attempt count', () => {
  const source = freezeDeep<ConversationTaskPage>({ tasks: [{ origin: { conversationId: 'synthetic-conversation', messageId: 'synthetic-message', tool: 'prepare_mcp_task', createdGeneration: 1, createdAt }, job: job(), generation: 4, approval: approval() }], nextBefore: null });
  const projected = projectPublicConversationTaskPage(source);
  assert.deepEqual(projected.tasks[0].origin, source.tasks[0].origin); assert.equal(projected.tasks[0].origin.createdGeneration, 1);
  assert.equal(projected.tasks[0].generation, 4); assert.equal(projected.tasks[0].job.attempt, 3);
  projected.tasks[0].origin.messageId = 'changed'; projected.tasks[0].approval!.status = 'approved';
  assert.equal(source.tasks[0].origin.messageId, 'synthetic-message'); assert.equal(source.tasks[0].approval!.status, 'pending');
  assert.deepEqual(projectPublicConversationTaskPage({ tasks: [], nextBefore: null }), { tasks: [], nextBefore: null });
});

test('workflow templates retain semantic content and revision while omitting model/options/template configuration', () => {
  const source = freezeDeep<WorkflowTemplate>({ id: 'synthetic-workflow', name: text, description: '', revision: 3, createdAt, updatedAt: createdAt, steps: [{ kind: 'image', prompt: text, provider: 'private-provider', model: 'private-model', options: { token: 'synthetic-secret' }, executionTemplate: { version: 1, hash }, referenceImages: [{ fromStep: 0, imageIndex: 0 }] }] });
  const projected = projectPublicWorkflowTemplate(source);
  assert.deepEqual(projected, { id: source.id, name: text, description: '', revision: 3, createdAt, updatedAt: createdAt, steps: [{ kind: 'image', prompt: text, referenceImages: [{ fromStep: 0, imageIndex: 0 }] }] });
  projected.steps[0].referenceImages![0].fromStep = 9; assert.equal(source.steps[0].referenceImages![0].fromStep, 0);
  const { description, ...absent } = source; assert.equal(Object.hasOwn(projectPublicWorkflowTemplate({ ...absent, steps: [] }), 'description'), false);
});

test('outcome projection keeps unconfirmed evidence/version, historical null and user observations without disclosing provider handles or renormalizing hashes', () => {
  const source = freezeDeep<JobOutcomeReviewPage>({
    jobId: 'synthetic-job', requestedGeneration: 4, currentGeneration: 4,
    evidence: { version: hash, generation: 4, kind: 'workflow', status: 'uncertain', totalAttempts: 3, hasProviderTask: true, cleanupPending: true, reasons: ['job_uncertain', 'workflow_result_unknown', 'model_relay_uncertain', 'comfyui_submission_unknown'], attempts: [{ attempt: 3, status: 'uncertain', hasProviderTask: true }], attemptsHasMore: false, workflow: { scope: 'task_checkpoint', revision: 2, steps: [{ index: 0, state: 'provider_task', hasProviderTask: true }] } },
    writeEligibility: { allowed: false, reason: 'cleanup_pending' }, latestRevision: 1,
    records: [{ id: 'synthetic-review', jobId: 'synthetic-job', generation: 4, revision: 1, requestId: 'synthetic-request', evidenceVersion: hash, outcome: 'still_unknown', note: text, provenance: 'user_reported', verified: false, createdAt }], hasMore: false,
  });
  const projected = projectPublicJobOutcomeReviewPage(source);
  assert.equal(projected.evidence?.version, hash); assert.equal(projected.evidence?.status, 'uncertain'); assert.equal(projected.evidence?.hasExternalTask, true);
  assert.equal(Object.hasOwn(projected.evidence!, 'hasProviderTask'), false);
  assert.deepEqual(projected.evidence?.reasons, ['job_uncertain', 'workflow_result_unknown', 'analysis_result_unknown', 'external_submission_unknown']);
  assert.deepEqual(projected.evidence?.attempts, [{ attempt: 3, status: 'uncertain', hasExternalTask: true }]);
  assert.equal(projected.records[0].note, text); assert.equal(projected.records[0].verified, false); assert.deepEqual(projected.writeEligibility, source.writeEligibility);
  projected.evidence!.workflow!.steps[0].state = 'completed'; projected.records[0].note = 'changed'; projected.writeEligibility.allowed = true;
  assert.equal(source.evidence?.workflow?.steps[0].state, 'provider_task'); assert.equal(source.records[0].note, text); assert.equal(source.writeEligibility.allowed, false);
  const historical = projectPublicJobOutcomeReviewPage({ ...source, requestedGeneration: 1, evidence: null, records: [], writeEligibility: { allowed: false, reason: 'historical_generation' } }); assert.equal(historical.evidence, null);
  assert.deepEqual(projectPublicJobOutcomeReviewSaved({ record: source.records[0] }).record, source.records[0]);
  const noNote = { ...source.records[0] }; delete noNote.note; assert.equal(Object.hasOwn(projectPublicJobOutcomeReviewSaved({ record: noNote }).record, 'note'), false);
});

test('controlled errors preserve actionable account/validation/lease/status codes and neutralize provider/configuration details without mutating input', () => {
  const cases = [
    ['AUTH_REQUIRED', 401, 'AUTH_REQUIRED'], ['ACCOUNT_CONTEXT_CHANGED', 409, 'ACCOUNT_CONTEXT_CHANGED'],
    ['INVALID_INPUT', 400, 'INVALID_INPUT'], ['JOB_LEASE_EXPIRED', 409, 'JOB_LEASE_EXPIRED'],
    ['CANCELLATION_PENDING', 409, 'CANCELLATION_PENDING'], ['JOB_NOT_RETRYABLE', 409, 'JOB_NOT_RETRYABLE'],
    ['PROVIDER_NOT_CONFIGURED', 503, 'CAPABILITY_UNAVAILABLE'], ['ELEVENLABS_SPEECH_FAILED', 502, 'RESPONSE_FAILED'],
    ['LOCAL_TRANSCRIPTION_UNAVAILABLE', 503, 'CAPABILITY_UNAVAILABLE'], ['COMFYUI_TEMPLATE_CHANGED', 409, 'TASK_DEFINITION_CHANGED'],
    ['MODEL_RELAY_UNCERTAIN', 502, 'RESULT_UNCONFIRMED'], ['PROVIDER_RATE_LIMIT', 429, 'RESPONSE_LIMIT_REACHED'],
    ['DATA_STORAGE_UNAVAILABLE', 503, 'DATA_STORAGE_UNAVAILABLE'], ['STUDENT_ACCOUNT_REQUIRED', 403, 'STUDENT_ACCOUNT_REQUIRED'],
    ['ONBOARDING_REVISION_CHANGED', 409, 'ONBOARDING_REVISION_CHANGED'], ['ONBOARDING_OPERATION_CONFLICT', 409, 'ONBOARDING_OPERATION_CONFLICT'],
    ['ONBOARDING_STATE_CHANGED', 409, 'ONBOARDING_STATE_CHANGED'],
    ['SYNTHETIC_PRIVATE_ENV', 502, 'REQUEST_FAILED'],
  ] as const;
  for (const [code, status, expected] of cases) {
    const source = freezeDeep({ code, status, message: 'Synthetic OPENAI_API_KEY / ELEVENLABS_TTS_VOICE_ID / private-model detail.' });
    const projected = projectPublicError(source);
    assert.equal(projected.code, expected); assert.equal(projected.status, status);
    assert.equal(projected.message.includes('OPENAI_API_KEY'), false); assert.equal(projected.message.includes('private-model'), false);
    assert.equal(source.message.includes('ELEVENLABS_TTS_VOICE_ID'), true);
  }
  const accountCases = [
    { code: 'ACCOUNT_ACTION_INVALID', status: 400, message: 'This account link is invalid or expired. Request a new email.' },
    { code: 'ACCOUNT_ACTION_UNAVAILABLE', status: 503, message: 'The account action could not be confirmed. Please try again.' },
    { code: 'ACCOUNT_EMAIL_UNAVAILABLE', status: 503, message: 'Account email is unavailable. No email has been sent.' },
    { code: 'SPEECH_NOT_AVAILABLE', status: 403, message: 'This action is unavailable in this application.' },
  ];
  for (const expected of accountCases) assert.deepEqual(projectPublicError({ ...expected, message: 'Synthetic server configuration detail.' }), expected);
  assert.equal(Object.hasOwn(projectPublicError({ code: 'AUTH_REQUIRED', message: '' }), 'status'), false);
});
