import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { PLATFORM_ACCOUNT_HEADER, type ConversationTask, type ConversationTaskPage } from '@companion/platform-contracts';
import { createConversationTaskClient, parseConversationTaskPage } from '../src/conversation-tasks-api.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';

const id = '10000000-0000-4000-8000-000000000001', jobId = '10000000-0000-4000-8000-000000000002', messageId = '10000000-0000-4000-8000-000000000003', accountA = '10000000-0000-4000-8000-000000000004';
const createdAt = '2026-10-06T00:00:00Z';
const task: ConversationTask = { origin: { conversationId: id, messageId, tool: 'create_job', createdGeneration: 1, createdAt }, generation: 3, job: { id: jobId, kind: 'cli', provider: 'cli', prompt: 'Read fictional output.', status: 'needs_approval', progress: 0, artifacts: [], attempt: 1, createdAt, updatedAt: createdAt }, approval: { id: messageId, jobId, generation: 3, toolName: 'cli', status: 'pending', args: { kind: 'cli', provider: 'cli', prompt: 'Read fictional output.' }, createdAt } };

test('conversation pages use real account-bound HTTP with an owned cursor and no execution or approval request', async () => {
  const calls: { url: string; account: unknown; method: string }[] = [];
  const server = createServer((request, response) => { calls.push({ url: request.url!, account: request.headers[PLATFORM_ACCOUNT_HEADER], method: request.method! }); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ tasks: request.url!.includes('before=') ? [] : [task], nextBefore: request.url!.includes('before=') ? null : jobId })); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const context = new AccountRequestContext(); context.changeSession(accountA);
  const bound = createPlatformClient(createPlatformEndpoints(`http://127.0.0.1:${address.port}`), undefined, context).capture(), api = createConversationTaskClient(bound.request);
  try {
    assert.equal((await api.list(id)).tasks[0].generation, 3); await api.list(id, { before: jobId });
    assert.deepEqual(calls.map((call) => call.url), [`/api/platform/conversations/${id}/tasks?limit=20`, `/api/platform/conversations/${id}/tasks?limit=20&before=${jobId}`]);
    assert.ok(calls.every((call) => call.account === accountA && call.method === 'GET'));
    context.changeSession(messageId); await assert.rejects(api.list(id)); assert.equal(calls.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('only the exact conversation origin and current-generation pending approval are accepted', () => {
  const page: ConversationTaskPage = { tasks: [task], nextBefore: null }; assert.equal(parseConversationTaskPage(page, id).tasks[0], task);
  for (const approval of [{ ...task.approval!, generation: undefined }, { ...task.approval!, generation: 2 }, { ...task.approval!, status: 'approved' }, { ...task.approval!, jobId: id }, { ...task.approval!, toolName: 'mcp' }, { ...task.approval!, args: { ...task.approval!.args, prompt: 'Different goal.' } }]) assert.throws(() => parseConversationTaskPage({ ...page, tasks: [{ ...task, approval }] }, id), /待审批/);
  for (const origin of [{ ...task.origin, conversationId: jobId }, { ...task.origin, messageId: 'invalid' }, { ...task.origin, createdGeneration: 4 }, { ...task.origin, tool: 'tools/call' }]) assert.throws(() => parseConversationTaskPage({ ...page, tasks: [{ ...task, origin }] }, id), /来源/);
  assert.throws(() => parseConversationTaskPage({ ...page, tasks: [{ ...task, origin: { ...task.origin, tool: 'prepare_mcp_task' } }] }, id), /准备记录/);
});

test('duplicate tasks, oversized pages and nonadvancing/unowned cursors cannot silently truncate or replace a page', () => {
  for (const page of [{ tasks: [task, task], nextBefore: null }, { tasks: Array(21).fill(task), nextBefore: null }, { tasks: [task], nextBefore: id }, { tasks: [], nextBefore: jobId }]) assert.throws(() => parseConversationTaskPage(page, id));
  assert.throws(() => parseConversationTaskPage({ tasks: [task], nextBefore: jobId }, id, 20, jobId));
  assert.throws(() => parseConversationTaskPage({ tasks: [{ ...task, job: { ...task.job, status: 'invented_success' } }], nextBefore: null }, id));
});

test('aborted page responses are discarded even if the injected transport ignores cancellation', async () => {
  let calls = 0, resolve!: (value: unknown) => void;
  const api = createConversationTaskClient(<T>() => { calls++; return new Promise<T>((done) => { resolve = done as any; }); });
  const before = new AbortController(); before.abort(); await assert.rejects(api.list(id, { signal: before.signal }), { name: 'AbortError' }); assert.equal(calls, 0);
  const abort = new AbortController(), pending = api.list(id, { signal: abort.signal }); abort.abort(); resolve({ tasks: [task], nextBefore: null }); await assert.rejects(pending, { name: 'AbortError' });
});

test('invalid local paging arguments never reach the private API', async () => {
  let calls = 0; const api = createConversationTaskClient(async <T>() => { calls++; return {} as T; });
  await assert.rejects(api.list('invalid')); await assert.rejects(api.list(id, { before: 'invalid' })); await assert.rejects(api.list(id, { limit: 21 })); await assert.rejects(api.list(id, { limit: 0 })); assert.equal(calls, 0);
});
