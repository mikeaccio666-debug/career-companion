import assert from 'node:assert/strict';
import test from 'node:test';
import { assertGoalMcpResult, createGoalPlanClient, parseGoalPlan, parseGoalPlanContinue, parseGoalPlanList } from '../src/goal-plans-api.ts';
import type { McpResult } from '@companion/platform-contracts';
import { activePlan, artifactId, conversationId, input, instant, jobId, plan, planId, taskPlan } from './goal-plans-fixture.ts';

test('the whole private list rejects one wrong conversation, duplicate, missing receipt, or wrong-generation approval', () => {
  assert.equal(parseGoalPlanList({ plans: [plan()], limit: 50 }, conversationId).plans.length, 1);
  const bad = [plan({ conversationId: jobId }), plan({ revision: 0 }), plan({ steps: [] }), plan({ steps: [{ ...plan().steps[0], state: 'succeeded' }] }), taskPlan()];
  bad[4].steps[0].approval!.generation = 2;
  for (const item of bad) assert.throws(() => parseGoalPlanList({ plans: [plan(), item], limit: 50 }, conversationId));
  assert.throws(() => parseGoalPlanList({ plans: [plan(), plan()], limit: 50 }, conversationId));
  assert.throws(() => parseGoalPlanList({ plans: [], limit: 100 }, conversationId));
});

test('saved artifacts belong to the fixed task receipt, while blocked current-version drift remains visible', () => {
  const item = taskPlan(), step = item.steps[0]; delete step.approval;
  step.state = 'blocked'; step.job!.status = 'queued'; step.blockReason = 'Bound generation 1, current generation 2.';
  step.receipt = { kind: 'task', jobId, generation: 1, artifactIds: [artifactId], completedAt: instant };
  step.artifacts = [{ id: artifactId, name: 'fictional.txt', mime: 'text/plain', url: `/api/platform/artifacts/${artifactId}/file` }];
  assert.equal(parseGoalPlan(item, conversationId).steps[0].generation, 1);
  assert.throws(() => parseGoalPlan({ ...item, steps: [{ ...step, generation: 2 }] }, conversationId));
  assert.throws(() => parseGoalPlan({ ...item, steps: [{ ...step, artifacts: [{ ...step.artifacts[0], id: planId }] }] }, conversationId));
  assert.throws(() => parseGoalPlan({ ...item, steps: [{ ...step, receipt: undefined }] }, conversationId));
});

test('deleted child/message histories stay readable as blocked exact receipts and never claim new success', () => {
  const task = taskPlan(), step = task.steps[0]; delete step.job; delete step.approval; step.state = 'blocked';
  step.receipt = { kind: 'task', jobId, generation: 1, artifactIds: [artifactId], completedAt: instant };
  assert.equal(parseGoalPlan(task, conversationId).steps[0].receipt?.kind, 'task');
  const analysis = plan(); analysis.steps[0].state = 'blocked'; analysis.steps[0].receipt = { kind: 'agent_turn', messageId: jobId, completedAt: instant };
  assert.equal(parseGoalPlan(analysis, conversationId).steps[0].state, 'blocked');
  analysis.steps[0].state = 'succeeded'; assert.throws(() => parseGoalPlan(analysis, conversationId));
});

test('only a ready pending next step can claim readiness; malformed approvals never reach the approval UI', () => {
  const item = activePlan(); item.steps.push({ ...item.steps[0], index: 1 });
  assert.throws(() => parseGoalPlan(item, conversationId));
  for (const field of ['toolName', 'kind', 'provider', 'prompt']) { const bad = taskPlan(); if (field === 'toolName') bad.steps[0].approval!.toolName = 'cli'; else bad.steps[0].approval!.args[field] = 'fictional-mismatch'; assert.throws(() => parseGoalPlan(bad, conversationId)); }
  for (const field of ['model', 'options', 'attachmentIds', 'executionTemplate']) { const bad = taskPlan(); bad.steps[0].approval!.args[field] = field === 'options' ? { fictional: true } : field === 'attachmentIds' ? [artifactId] : 'fictional-mismatch'; assert.throws(() => parseGoalPlan(bad, conversationId)); }
});

test('continue replies are bound to the exact plan, conversation, index, revision and current approval', () => {
  const value = activePlan(), continuation = { planId, conversationId, revision: value.revision, stepIndex: 0 };
  assert.equal(parseGoalPlanContinue({ kind: 'agent_turn', plan: value, stepIndex: 0, continuation }, conversationId, planId, 0).kind, 'agent_turn');
  for (const change of [{ conversationId: jobId }, { planId: jobId }, { stepIndex: 1 }, { revision: 2 }]) assert.throws(() => parseGoalPlanContinue({ kind: 'agent_turn', plan: value, stepIndex: 0, continuation: { ...continuation, ...change } }, conversationId, planId, 0));
  const task = taskPlan(); assert.equal(parseGoalPlanContinue({ kind: 'task', plan: task, stepIndex: 0, job: task.steps[0].job, approval: task.steps[0].approval }, conversationId, planId, 0).kind, 'task');
  assert.throws(() => parseGoalPlanContinue({ kind: 'task', plan: task, stepIndex: 0, job: task.steps[0].job, approval: { ...task.steps[0].approval, generation: 2 } }, conversationId, planId, 0));
});

test('the client writes one exact CAS definition and prepares analysis without calling any messages endpoint', async () => {
  const requests: { path: string; init?: RequestInit }[] = [];
  const api = createGoalPlanClient(async <T>(path: string, init?: RequestInit): Promise<T> => { requests.push({ path, init }); if (path.endsWith('/continue')) return { kind: 'agent_turn', plan: activePlan(), stepIndex: 0, continuation: { planId, conversationId, revision: 1, stepIndex: 0 } } as T; return { plan: plan() } as T; }, conversationId);
  await api.save(planId, 1, input()); await api.continue(planId, 1, 0);
  assert.equal(requests[0].init?.method, 'PUT'); assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { ...input(), revision: 1 });
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { revision: 1, stepIndex: 0 });
  assert.equal(requests.some((request) => request.path.includes('/messages') || request.path.includes('/decision')), false);
});

test('the dedicated MCP reader accepts only the exact successful receipt and rejects latest-attempt or connection drift', () => {
  const task = taskPlan().steps[0].job!; task.kind = 'mcp'; task.mcp = { connectionId: planId, connectionName: 'Fictional MCP', catalogId: 'fictional', grantVersion: 1, toolName: 'fictional_read', schemaHash: 'b'.repeat(64) };
  const receipt = { kind: 'task' as const, jobId, generation: 1, artifactIds: [artifactId], completedAt: instant };
  const result: McpResult = { provenance: 'untrusted_mcp', encoding: 'utf-8', source: { ...task.mcp, jobId, generation: 1, artifactId, size: 10 }, version: 'fictional-version', offset: 0, nextOffset: null, truncated: false, text: 'Fictional.' };
  assert.doesNotThrow(() => assertGoalMcpResult(result, task, receipt));
  for (const change of [{ generation: 2 }, { jobId: planId }, { artifactId: jobId }, { grantVersion: 2 }, { schemaHash: 'c'.repeat(64) }]) assert.throws(() => assertGoalMcpResult({ ...result, source: { ...result.source, ...change } }, task, receipt));
});
