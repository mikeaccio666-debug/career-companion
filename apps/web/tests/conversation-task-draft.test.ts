import assert from 'node:assert/strict';
import test from 'node:test';
import type { Artifact, ConversationTask } from '@companion/platform-contracts';
import { AccountOperationScope } from '../src/account-operations.ts';
import { applyConversationTaskDraft, conversationTaskDraft } from '../src/conversation-task-draft.ts';

const conversationId = '10000000-0000-4000-8000-000000000001', jobId = '10000000-0000-4000-8000-000000000002', artifactId = '10000000-0000-4000-8000-000000000003';
const createdAt = '2026-10-06T00:00:00Z';
const artifact: Artifact = { id: artifactId, name: 'fictional.txt', mime: 'text/plain', size: 12, url: `/api/platform/artifacts/${artifactId}` };
const task: ConversationTask = { origin: { conversationId, messageId: artifactId, tool: 'create_job', createdGeneration: 1, createdAt }, generation: 2, job: { id: jobId, kind: 'cli', provider: 'cli', prompt: 'Fictional goal.', status: 'failed', progress: 0, artifacts: [artifact], createdAt, updatedAt: createdAt, attempt: 2 } };

test('a current-conversation result appends a reference while preserving its identity, existing text and private attachment selections', () => {
  const scope = new AccountOperationScope(); scope.changeSession('fictional-account'); const token = scope.snapshot(), uploads = [{ id: 'fictional-upload' }]; let active: string | null = conversationId, applied = 0;
  let state = { draft: 'My existing fictional goal.', uploads };
  assert.equal(applyConversationTaskDraft(scope, token, conversationId, () => active, task, { kind: 'artifact', artifact }, state, (plan) => { applied++; state = plan; assert.equal(plan.uploads, uploads); }), true);
  assert.equal(active, conversationId); assert.equal(scope.isCurrent(token), true); assert.match(state.draft, /^My existing fictional goal/); assert.match(state.draft, /read_artifact_text/); assert.match(state.draft, /可能来自较早尝试/); assert.match(state.draft, /当前状态：failed/);
  const first = state.draft; assert.equal(applyConversationTaskDraft(scope, token, conversationId, () => active, task, { kind: 'artifact', artifact }, state, (plan) => { state = plan; assert.equal(plan.duplicate, true); }), true); assert.equal(state.draft, first); assert.equal(applied, 1);
});

test('conversation switch, account switch and same-account new session cannot append a late result', () => {
  for (const next of ['different-conversation', 'different-account', 'same-account-new-session']) {
    const scope = new AccountOperationScope(); scope.changeSession('fictional-account'); const old = scope.snapshot(); let active: string | null = conversationId;
    if (next === 'different-conversation') active = artifactId; else scope.changeSession(next === 'different-account' ? 'fictional-other-account' : 'fictional-account');
    assert.equal(applyConversationTaskDraft(scope, old, conversationId, () => active, task, { kind: 'artifact', artifact }, { draft: 'Keep this.', uploads: [] }, () => assert.fail('late private draft applied')), false);
  }
  const scope = new AccountOperationScope(); scope.changeSession('fictional-account'); assert.equal(applyConversationTaskDraft(scope, scope.snapshot(), conversationId, () => conversationId, { ...task, origin: { ...task.origin, conversationId: artifactId } }, { kind: 'artifact', artifact }, { draft: '', uploads: [] }, () => assert.fail('foreign conversation source applied')), false);
});

test('MCP and browser references use dedicated readers and cannot enter the generic artifact path', () => {
  const mcp: ConversationTask = { ...task, job: { ...task.job, kind: 'mcp', provider: 'mcp', status: 'uncertain', mcp: { connectionId: artifactId, connectionName: 'Fictional connection', catalogId: 'fictional', grantVersion: 2, toolName: 'fictional_lookup', schemaHash: 'a'.repeat(64) } } };
  const draft = conversationTaskDraft(mcp, { kind: 'mcp' }); assert.match(draft, /read_mcp_result/); assert.match(draft, /uncertain/); assert.doesNotMatch(draft, /read_artifact_text|fictional_lookup/);
  assert.throws(() => conversationTaskDraft(mcp, { kind: 'artifact', artifact }), /专用/);
  const browser = { ...task, job: { ...task.job, kind: 'browser' as const, artifacts: [{ ...artifact, name: 'browser-observation.json', mime: 'application/json' }] } };
  assert.match(conversationTaskDraft(browser, { kind: 'browser' }), /get_browser_observation/); assert.throws(() => conversationTaskDraft(browser, { kind: 'artifact', artifact }), /专用/);
  assert.throws(() => conversationTaskDraft(task, { kind: 'artifact', artifact: { ...artifact, id: conversationId } }), /本任务/);
});

test('oversized drafts remain intact and flagged rather than truncating the original goal or result reference', () => {
  const scope = new AccountOperationScope(); scope.changeSession('fictional-account'); const original = 'a'.repeat(20000);
  assert.equal(applyConversationTaskDraft(scope, scope.snapshot(), conversationId, () => conversationId, task, { kind: 'artifact', artifact }, { draft: original, uploads: [] }, (plan) => { assert.equal(plan.exceedsLimit, true); assert.ok(plan.draft.startsWith(original)); assert.match(plan.draft, /成果 ID/); }), true);
});
