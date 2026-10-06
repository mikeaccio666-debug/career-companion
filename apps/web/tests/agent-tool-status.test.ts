import assert from 'node:assert/strict';
import test from 'node:test';
import { agentToolStatusText, appendAgentApprovalStatus, finishAgentToolStatuses, upsertAgentToolStatus } from '../src/agent-tool-status.ts';

test('the same callId updates from pending to returned instead of creating duplicate processing rows', () => {
  let items = upsertAgentToolStatus([], { name: 'read_saved_memories', callId: 'fixture-call-one', input: {} });
  assert.equal(agentToolStatusText(items[0]), '读取已保存记忆 · 处理中');
  items = upsertAgentToolStatus(items, { name: 'read_saved_memories', callId: 'fixture-call-one', input: {}, result: { memories: [] } });
  assert.equal(items.length, 1); assert.equal(agentToolStatusText(items[0]), '读取已保存记忆 · 已返回');
  assert.equal(agentToolStatusText(items[0]).includes('完成'), false);
  items = upsertAgentToolStatus(items, { name: 'read_saved_memories', callId: 'fixture-call-one' });
  assert.equal(items[0].state, 'returned');
});

test('own result presence counts empty, null and undefined results as returned while absence stays pending', () => {
  for (const result of [null, undefined, {}, [], '', 0, false]) assert.equal(upsertAgentToolStatus([], { name: 'list_jobs', callId: 'fixture-call', result })[0].state, 'returned');
  assert.equal(upsertAgentToolStatus([], { name: 'list_jobs', callId: 'fixture-call' })[0].state, 'pending');
  const inherited = Object.assign(Object.create({ result: {} }), { name: 'list_jobs', callId: 'fixture-call' });
  assert.equal(upsertAgentToolStatus([], inherited)[0].state, 'pending');
});

test('tool errors produce a safe failure label without displaying raw tool results or error contents', () => {
  const items = upsertAgentToolStatus([], { name: 'read_artifact_text', callId: 'fixture-call', result: { error: { message: 'fictional private contents', code: 'FIXTURE_ERROR' } } });
  assert.equal(items[0].state, 'failed'); assert.equal(agentToolStatusText(items[0]), '读取成果文字 · 未成功返回');
  assert.equal(JSON.stringify(items).includes('fictional private'), false);
  for (const error of [null, undefined, false]) assert.equal(upsertAgentToolStatus([], { name: 'read_artifact_text', callId: 'fixture-call', result: { error } })[0].state, 'returned');
});

test('interrupted or ended streams mark only outstanding calls unconfirmed and preserve known responses and approvals', () => {
  let items = upsertAgentToolStatus([], { name: 'list_jobs', callId: 'pending-call' });
  items = upsertAgentToolStatus(items, { name: 'read_saved_memories', callId: 'returned-call', result: null });
  items = appendAgentApprovalStatus(items, { id: 'fixture-approval', toolName: 'prepare_browser_task' });
  const finished = finishAgentToolStatuses(items);
  assert.deepEqual(finished.map((item) => item.state), ['unconfirmed', 'returned', 'approval']);
  assert.equal(items[0].state, 'pending'); assert.match(agentToolStatusText(finished[0]), /结果未确认/);
  assert.match(agentToolStatusText(finished[2]), /已请求审批/);
});

test('calls remain distinct by identity, approvals upsert separately, and the visible timeline stays bounded', () => {
  let items = upsertAgentToolStatus([], { name: 'list_jobs', callId: 'one' });
  items = upsertAgentToolStatus(items, { name: 'list_jobs', callId: 'two' }); assert.equal(items.length, 2);
  items = appendAgentApprovalStatus(items, { id: 'same-approval', toolName: 'create_job' });
  items = appendAgentApprovalStatus(items, { id: 'same-approval', toolName: 'create_job' }); assert.equal(items.length, 3);
  for (let index = 0; index < 10; index++) items = upsertAgentToolStatus(items, { name: 'list_jobs', callId: `fixture-${index}`, result: {} });
  assert.equal(items.length, 6); assert.equal(new Set(items.map((item) => item.key)).size, 6);
  assert.deepEqual(upsertAgentToolStatus(items, null), items);
});
