import { FICTIONAL_LEGAL, fictionalRegistration, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import type { ChatContext, PlatformProviderRuntime } from '@companion/platform-contracts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.ts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';
import { processJob } from '../src/jobs.ts';
import { recoverStaleStreams } from '../src/runtime-leases.ts';
import { mcpSchemaHash } from '../src/mcp-config.ts';
import type { McpTransport } from '../src/mcp-transport-port.ts';

const prefix = '/api/platform', origin = 'http://localhost:4321', base = readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1', PLATFORM_CHAT_PROVIDER: 'synthetic', PLATFORM_AGENT_PROVIDER: 'synthetic' ,PLATFORM_REQUIRE_INVITE:'1'});
const schema = `conversation_tasks_test_${randomUUID().replaceAll('-', '')}`, admin = new Database(base.databaseUrl), databaseUrl = new URL(base.databaseUrl);
databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(databaseUrl.toString());
interface Actor { id: string; cookie: string; }
interface ToolRequest { name: string; args: Record<string, unknown>; }
interface Plan { requests?: ToolRequest[]; fail?: boolean; hold?: boolean; context?: ChatContext; results?: any[]; }
const plans = new Map<string, Plan>();
const inputSchema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
let system: Awaited<ReturnType<typeof buildApp>>, directory: string, httpOrigin: string, remoteCalls = 0, executedJobs = 0;
const forbidden = async (): Promise<never> => { throw new Error('No model, mail, commercial service or external call is permitted.'); };
const runtime: PlatformProviderRuntime = {
  capabilities: () => [
    { id: 'synthetic', name: 'Synthetic conversation-task fixture', keyConfigured: true, enabled: true, capabilities: ['chat', 'agent', 'speech'], models: ['fictional-model'], envVariables: [] },
    { id: 'browser', name: 'Synthetic browser preparation fixture', keyConfigured: true, enabled: true, capabilities: ['browser'], models: [], envVariables: [] },
  ],
  async *streamChat(input, context) {
    const plan = plans.get(input.messages.at(-1)!.content); assert(plan, 'The fixture requires an explicit synthetic plan.'); plan.context = context;
    for (const request of plan.requests ?? []) {
      assert(context?.tools?.some(tool => tool.name === request.name));
      const result = await context?.executeTool?.(request.name, request.args); (plan.results ??= []).push(result);
      yield { type: 'tool', callId: randomUUID(), name: request.name, input: request.args, result };
    }
    if (plan.fail) throw new Error('Synthetic response failed after preparing its task.');
    yield { type: 'delta', text: 'Synthetic fixture prepared references only.' };
    if (plan.hold) {
      await new Promise<void>(resolve => { if (context?.signal?.aborted) resolve(); else context?.signal?.addEventListener('abort', () => resolve(), { once: true }); });
      context?.signal?.throwIfAborted();
    }
  },
  async executeJob() { ++executedJobs; return { text: 'Synthetic saved task result', artifacts: [{ name: 'fictional-result.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Synthetic saved task result') }] }; },
  createVoiceSession: forbidden, transcribe: forbidden, speech: forbidden,
};
const transport: McpTransport = {
  async discover() { return [{ name: 'fictional_search', inputSchema }]; },
  async call() { ++remoteCalls; throw new Error('Preparation must not execute MCP tools.'); },
};
async function startSystem() {
  system = await buildApp({legalBundle:FICTIONAL_LEGAL, db, runtime, mcp: transport, enableQueue: false,
    config: { ...base, databaseUrl: databaseUrl.toString(), storageDir: directory, accountEmail: undefined, requireVerifiedEmail: false, maxActiveJobs: 100,
      mcp: { entries: [{ id: 'fictional-catalog', name: 'Fictional reviewed connection', url: 'https://mcp-fixture.example.invalid/mcp', tools: [{ name: 'fictional_search', schemaHash: mcpSchemaHash(inputSchema) }] }], fixtureOrigins: [] } },
    requestLimits: { policies: { api: { max: 2000, windowSeconds: 60 }, chat: { max: 2000, windowSeconds: 60 }, control: { max: 2000, windowSeconds: 60 }, 'auth-register': { max: 1000, windowSeconds: 60 } } },
  });
  httpOrigin = await system.app.listen({ host: '127.0.0.1', port: 0 });
}
before(async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.databaseUrl).hostname), 'Only a loopback test database is allowed.');
  await admin.query(`CREATE SCHEMA ${schema}`); await db.migrate(); await seedFictionalActiveLegal(db); directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-conversation-tasks-')); await startSystem();
});
after(async () => { await system?.app.close(); await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

function headers(actor?: Actor): Record<string, string> { return { origin, ...(actor ? { cookie: actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id } : {}) }; }
async function request(actor: Actor | undefined, method: 'GET' | 'POST' | 'DELETE', route: string, payload?: Record<string, unknown>, overrides: Record<string, string | undefined> = {}) {
  const values = headers(actor); for (const [key, value] of Object.entries(overrides)) { if (value === undefined) delete values[key]; else values[key] = value; }
  return system.app.inject({ method, url: prefix + route, headers: values, payload });
}
async function actor(): Promise<Actor> {
  const response = await request(undefined, 'POST', '/auth/register', await fictionalRegistration(db,{ name: 'Fictional conversation tester', email: `${randomUUID()}@example.invalid`, password: 'Fictional-password-123' }));
  assert.equal(response.statusCode, 201, response.body); return { id: response.json().user.id, cookie: (response.headers['set-cookie'] as string).split(';')[0] };
}
async function conversation(user: Actor) {
  const response = await request(user, 'POST', '/conversations', { title: 'Fictional Agent task history', mode: 'agent' }); assert.equal(response.statusCode, 201); return response.json().conversation;
}
function speech(): ToolRequest { return { name: 'create_job', args: { kind: 'speech', provider: 'synthetic', prompt: 'Fictional prepared speech' } }; }
function browser(): ToolRequest { return { name: 'prepare_browser_task', args: { goal: 'Read a fictional public page', url: 'https://public-fixture.example.invalid/page' } }; }
async function mcp(user: Actor): Promise<ToolRequest> {
  const response = await request(user, 'POST', '/mcp/connections', { catalogId: 'fictional-catalog' }); assert.equal(response.statusCode, 201, response.body);
  const connection = response.json().connection;
  return { name: 'prepare_mcp_task', args: { connectionId: connection.connectionId, grantVersion: connection.grantVersion, toolName: 'fictional_search', schemaHash: mcpSchemaHash(inputSchema), arguments: { query: 'Fictional question' }, goal: 'Read the reviewed fictional reference' } };
}
function registerPlan(plan: Plan) { const key = `fictional-plan-${randomUUID()}`; plans.set(key, plan); return key; }
async function respond(user: Actor, conversationId: string, plan: Plan) {
  const response = await fetch(httpOrigin + prefix + `/conversations/${conversationId}/messages`, { method: 'POST', headers: { ...headers(user), 'content-type': 'application/json' }, body: JSON.stringify({ content: registerPlan(plan), mode: 'agent' }) });
  assert.equal(response.status, 200); return response.text();
}
function event(body: string, name: string) { const match = body.match(new RegExp(`event: ${name}\\ndata: ([^\\n]+)`)); assert(match, `Missing synthetic ${name} event.`); return JSON.parse(match[1]); }
async function page(user: Actor, id: string, query = '') { const response = await request(user, 'GET', `/conversations/${id}/tasks${query}`); assert.equal(response.statusCode, 200, response.body); return response.json(); }
async function counts(user: Actor) {
  const result = await db.query(`SELECT (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs,
    (SELECT count(*)::int FROM platform_approvals WHERE user_id=$1) AS approvals,
    (SELECT count(*)::int FROM platform_job_outbox o JOIN platform_jobs j ON j.id=o.job_id WHERE j.user_id=$1) AS outbox,
    (SELECT count(*)::int FROM platform_conversation_tasks WHERE user_id=$1) AS origins`, [user.id]); return result.rows[0];
}
async function waitUntil(check: () => Promise<boolean>, label: string) { const end = Date.now() + 5000; while (!await check()) { if (Date.now() > end) throw new Error(`Synthetic fixture timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Synthetic transaction gate timed out.')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function interceptTransactions(intercept: (text: string, values: any, run: () => Promise<any>) => Promise<any>) {
  const transaction = db.transaction.bind(db);
  db.transaction = async run => transaction(async client => {
    const query = client.query.bind(client);
    client.query = (async (text: any, values?: any) => typeof text === 'string' ? intercept(text, values, () => query(text, values)) : query(text, values)) as typeof client.query;
    try { return await run(client); } finally { client.query = query; }
  });
  return () => { db.transaction = transaction; };
}
async function liveTurn(user: Actor, conversationId: string, requests: ToolRequest[] = []) {
  const controller = new AbortController(), plan: Plan = { requests, hold: true };
  const response = await fetch(httpOrigin + prefix + `/conversations/${conversationId}/messages`, { method: 'POST', headers: { ...headers(user), 'content-type': 'application/json' }, body: JSON.stringify({ content: registerPlan(plan), mode: 'agent' }), signal: controller.signal });
  assert.equal(response.status, 200); const reader = response.body!.getReader(); let body = '';
  while (!body.includes('event: delta')) { const chunk = await reader.read(); assert.equal(chunk.done, false); body += new TextDecoder().decode(chunk.value); }
  const messageId = event(body, 'start').messageId;
  return { messageId, plan, controller, reader, async close() { controller.abort(); await reader.cancel().catch(() => {}); await waitUntil(async () => !(await db.query('SELECT id FROM platform_runtime_leases WHERE id=$1', [messageId])).rowCount, 'chat lease cleanup'); } };
}

test('all three Agent preparation branches persist only the fixed owner/conversation/assistant origin', async () => {
  const user = await actor(), conv = await conversation(user), remoteBefore = remoteCalls, executionsBefore = executedJobs;
  const expected = new Map<string, string>();
  for (const tool of [speech(), browser(), await mcp(user)]) {
    const plan: Plan = { requests: [tool] }, body = await respond(user, conv.id, plan);
    assert.match(body, /event: done/); expected.set(plan.results![0].job.id, event(body, 'start').messageId);
  }
  const result = await page(user, conv.id); assert.equal(result.tasks.length, 3); assert.equal(result.nextBefore, null);
  assert.deepEqual(new Set(result.tasks.map((task: any) => task.origin.tool)), new Set(['create_job', 'prepare_browser_task', 'prepare_mcp_task']));
  for (const task of result.tasks) {
    assert.equal(task.origin.conversationId, conv.id); assert.equal(task.origin.messageId, expected.get(task.job.id)); assert.equal(task.origin.createdGeneration, 1); assert.equal(task.generation, 1);
    const message = (await db.query('SELECT conversation_id,role,status FROM platform_messages WHERE id=$1', [task.origin.messageId])).rows[0]; assert.equal(message.role, 'assistant'); assert.equal(message.status, 'complete');
    const record = (await db.query('SELECT * FROM platform_conversation_tasks WHERE job_id=$1', [task.job.id])).rows[0]; assert.deepEqual(Object.keys(record).sort(), ['conversation_id', 'created_at', 'created_generation', 'job_id', 'message_id', 'tool', 'user_id']);
    if (task.job.kind === 'speech') assert.equal(task.approval, undefined); else { assert.equal(task.approval.status, 'pending'); assert.equal(task.approval.generation, task.generation); }
  }
  assert.equal(remoteCalls, remoteBefore); assert.equal(executedJobs, executionsBefore);
  await system.app.close(); await startSystem(); assert.deepEqual((await page(user, conv.id)).tasks, result.tasks);
});

test('current job state, saved artifacts and only the exact generation pending approval survive retry', async () => {
  const user = await actor(), conv = await conversation(user), plan: Plan = { requests: [browser(), speech()] }; await respond(user, conv.id, plan);
  const browserJob = plan.results![0].job, speechJob = plan.results![1].job;
  await processJob(system.jobs, speechJob.id, 1);
  let history = await page(user, conv.id); const completed = history.tasks.find((item: any) => item.job.id === speechJob.id); assert.equal(completed.job.status, 'succeeded'); assert.equal(completed.job.artifacts.length, 1);
  const originalApproval = history.tasks.find((item: any) => item.job.id === browserJob.id).approval;
  assert.equal((await request(user, 'POST', `/approvals/${originalApproval.id}/decision`, { decision: 'approved' })).statusCode, 200);
  history = await page(user, conv.id); assert.equal(history.tasks.find((item: any) => item.job.id === browserJob.id).approval, undefined);
  assert.equal((await request(user, 'POST', `/jobs/${browserJob.id}/cancel`, {})).statusCode, 200);
  assert.equal((await request(user, 'POST', `/jobs/${browserJob.id}/retry`, {})).statusCode, 200);
  history = await page(user, conv.id); const retried = history.tasks.find((item: any) => item.job.id === browserJob.id);
  assert.equal(retried.generation, 2); assert.equal(retried.origin.createdGeneration, 1); assert.notEqual(retried.approval.id, originalApproval.id); assert.equal(retried.approval.status, 'pending'); assert.equal(retried.approval.generation, 2);
  const row = (await db.query('SELECT generation FROM platform_approvals WHERE id=$1', [retried.approval.id])).rows[0]; assert.equal(row.generation, 2);
  // A stray pending row is not actionable when the job itself does not await review.
  await db.query("UPDATE platform_jobs SET status='queued' WHERE id=$1", [browserJob.id]);
  assert.equal((await page(user, conv.id)).tasks.find((item: any) => item.job.id === browserJob.id).approval, undefined);
  await db.query("UPDATE platform_jobs SET status='needs_approval' WHERE id=$1", [browserJob.id]);
  assert.equal((await request(user, 'POST', `/approvals/${originalApproval.id}/decision`, { decision: 'approved' })).statusCode, 409);
  await request(user, 'POST', `/approvals/${retried.approval.id}/decision`, { decision: 'approved' }); assert.equal((await page(user, conv.id)).tasks.find((item: any) => item.job.id === browserJob.id).approval, undefined);
  assert.equal((await counts(user)).origins, 2);
});

test('failed and disconnected assistant replies retain committed tasks without replaying or accepting late tools', async () => {
  const user = await actor(), conv = await conversation(user), failed: Plan = { requests: [browser()], fail: true };
  const body = await respond(user, conv.id, failed); assert.match(body, /event: error/); assert.doesNotMatch(body, /event: done/);
  const turn = await liveTurn(user, conv.id, [browser()]); const before = await counts(user); assert.equal(before.jobs, 2); await turn.close();
  await assert.rejects(() => turn.plan.context!.executeTool!('create_job', speech().args));
  await recoverStaleStreams(db); assert.deepEqual(await counts(user), before);
  const history = await page(user, conv.id); assert.equal(history.tasks.length, 2); assert(history.tasks.every((item: any) => item.job.status === 'needs_approval'));
  const statuses = (await db.query('SELECT status FROM platform_messages WHERE id=ANY($1::uuid[])', [history.tasks.map((item: any) => item.origin.messageId)])).rows.map(row => row.status); assert.deepEqual(new Set(statuses), new Set(['failed', 'cancelled']));
});

test('private history enforces real owner, expected account and conversation-specific cursor', async () => {
  const user = await actor(), other = await actor(), conv = await conversation(user), otherConv = await conversation(user), otherUserConv = await conversation(other);
  const plan: Plan = { requests: [speech()] }; await respond(user, conv.id, plan); const jobId = plan.results![0].job.id;
  const route = `/conversations/${conv.id}/tasks`;
  assert.equal((await request(undefined, 'GET', route)).statusCode, 401);
  assert.equal((await request(other, 'GET', route)).statusCode, 404);
  assert.equal((await request(user, 'GET', route, undefined, { [PLATFORM_ACCOUNT_HEADER]: undefined })).json().error.code, 'ACCOUNT_CONTEXT_REQUIRED');
  assert.equal((await request(other, 'GET', route, undefined, { [PLATFORM_ACCOUNT_HEADER]: user.id })).json().error.code, 'ACCOUNT_CONTEXT_CHANGED');
  for (const id of [otherConv.id, otherUserConv.id]) assert.equal((await request(id === otherConv.id ? user : other, 'GET', `/conversations/${id}/tasks?before=${jobId}`)).statusCode, 404);
  for (const query of ['?limit=0', '?limit=51', '?limit=1&limit=2', '?before=bad', `?before=${jobId}&before=${jobId}`, '?owner=anyone']) assert.equal((await request(user, 'GET', route + query)).statusCode, 400);
  const response = await request(user, 'GET', route); assert.match(String(response.headers['cache-control']), /private.*no-store/);
  assert.deepEqual((await page(user, otherConv.id)).tasks, []);
});

test('stable pagination retains microseconds and UUID tie order without duplicates or skipped rows', async () => {
  const user = await actor(), conv = await conversation(user), turn = await liveTurn(user, conv.id);
  try {
    const ids: string[] = [];
    for (let index = 0; index < 6; index++) ids.push((await system.jobs.create(user.id, speech().args as any, { conversationId: conv.id, messageId: turn.messageId, tool: 'create_job' })).job.id);
    for (const [index, id] of ids.entries()) await db.query('UPDATE platform_conversation_tasks SET created_at=$2::timestamptz WHERE job_id=$1', [id, `2030-01-01 00:00:00.00100${index === 3 ? 2 : index}+00`]);
    const expected = (await db.query('SELECT job_id FROM platform_conversation_tasks WHERE conversation_id=$1 ORDER BY created_at DESC,job_id DESC', [conv.id])).rows.map(row => row.job_id);
    const seen: string[] = []; let before: string | null = null;
    do { const result = await page(user, conv.id, `?limit=2${before ? `&before=${before}` : ''}`); assert.equal(result.tasks.length, 2); seen.push(...result.tasks.map((item: any) => item.job.id)); before = result.nextBefore; } while (before);
    assert.deepEqual(seen, expected); assert.equal(new Set(seen).size, 6);
  } finally { await turn.close(); }
});

test('deleting a conversation removes links while its jobs and approvals remain independent', async () => {
  const user = await actor(), conv = await conversation(user), plan: Plan = { requests: [browser(), speech()] }; await respond(user, conv.id, plan);
  const before = await counts(user); assert.equal((await request(user, 'DELETE', `/conversations/${conv.id}`)).statusCode, 200);
  const after = await counts(user); assert.deepEqual(after, { ...before, origins: 0 }); assert.equal((await request(user, 'GET', `/conversations/${conv.id}/tasks`)).statusCode, 404);
  for (const created of plan.results!) { const response = await request(user, 'GET', `/jobs/${created.job.id}`); assert.equal(response.statusCode, 200); assert.equal(response.json().job.status, created.job.status); }
});

test('inactive, wrong-owner, wrong-message and expired origins cannot leave jobs, approvals or outbox records', async () => {
  const user = await actor(), other = await actor(), conv = await conversation(user), unrelated = await conversation(user), turn = await liveTurn(user, conv.id);
  try {
    const before = await counts(user), input = speech().args as any, originValue = { conversationId: conv.id, messageId: turn.messageId, tool: 'create_job' as const };
    for (const [owner, invalidOrigin] of [[other.id, originValue], [user.id, { ...originValue, conversationId: unrelated.id }], [user.id, { ...originValue, messageId: randomUUID() }]] as const) await assert.rejects(() => system.jobs.create(owner, input, invalidOrigin), (error: unknown) => error instanceof ApiError && error.code === 'CONVERSATION_TASK_ORIGIN_INACTIVE');
    for (const tool of ['prepare_browser_task', 'prepare_mcp_task'] as const) await assert.rejects(() => system.jobs.create(user.id, input, { ...originValue, tool }), (error: unknown) => error instanceof ApiError && error.status === 400);
    await db.query("UPDATE platform_messages SET lease_until=now()-interval '1 second' WHERE id=$1", [turn.messageId]);
    await assert.rejects(() => system.jobs.create(user.id, input, originValue)); await db.query("UPDATE platform_messages SET lease_until=now()+interval '120 seconds' WHERE id=$1", [turn.messageId]);
    await db.query("UPDATE platform_runtime_leases SET expires_at=now()-interval '1 second' WHERE id=$1", [turn.messageId]);
    await assert.rejects(() => system.jobs.create(user.id, input, originValue)); await recoverStaleStreams(db);
    await assert.rejects(() => system.jobs.create(user.id, input, originValue)); assert.deepEqual(await counts(user), before); assert.equal((await counts(other)).jobs, 0);
  } finally { await turn.close(); }
});

test('origin expiry at the final write atomically rolls back the new job, approval and outbox', async () => {
  const user = await actor(), conv = await conversation(user), turn = await liveTurn(user, conv.id), before = await counts(user), transaction = db.transaction.bind(db);
  db.transaction = async run => transaction(async client => {
    const query = client.query.bind(client);
    client.query = (async (text: any, values?: any) => {
      if (typeof text === 'string' && text.startsWith('INSERT INTO platform_conversation_tasks')) await query("UPDATE platform_messages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [turn.messageId]);
      return query(text, values);
    }) as typeof client.query;
    try { return await run(client); } finally { client.query = query; }
  });
  try {
    for (const tool of [speech(), browser()]) await assert.rejects(() => system.jobs.create(user.id, tool.name === 'create_job' ? tool.args as any : { kind: 'browser', provider: 'browser', prompt: tool.args.goal as string, options: { url: tool.args.url } }, { conversationId: conv.id, messageId: turn.messageId, tool: tool.name as 'create_job' | 'prepare_browser_task' }), (error: unknown) => error instanceof ApiError && error.code === 'CONVERSATION_TASK_ORIGIN_INACTIVE');
  } finally { db.transaction = transaction; await turn.close(); }
  assert.deepEqual(await counts(user), before);
});

test('waiting task creation rejects an aborted turn after acquiring its user lock', async () => {
  const user = await actor(), conv = await conversation(user), turn = await liveTurn(user, conv.id), before = await counts(user);
  const lock = await db.pool.connect(); await lock.query('BEGIN'); await lock.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', [user.id]);
  const controller = new AbortController(), waiting = deferred();
  const restore = interceptTransactions(async (text, _values, run) => { if (text === 'SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE') waiting.resolve(); return run(); });
  const pending = system.jobs.create(user.id, speech().args as any, { conversationId: conv.id, messageId: turn.messageId, tool: 'create_job' }, controller.signal);
  const rejected = assert.rejects(pending);
  try { await bounded(waiting.promise); controller.abort(); await lock.query('COMMIT'); await bounded(rejected); }
  finally { controller.abort(); await lock.query('ROLLBACK').catch(() => {}); lock.release(); restore(); await pending.catch(() => {}); await turn.close(); }
  assert.deepEqual(await counts(user), before);
});

test('chat conversation lock remains compatible with a task creator holding the user serialization lock', async () => {
  const user = await actor(), conv = await conversation(user), turn = await liveTurn(user, conv.id);
  const userHeld = deferred(), conversationHeld = deferred(), releaseOrigin = deferred(), releaseChat = deferred();
  const restore = interceptTransactions(async (text, _values, run) => {
    const result = await run();
    if (text === 'SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE') { userHeld.resolve(); await releaseOrigin.promise; }
    if (text === 'SELECT * FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR NO KEY UPDATE') { conversationHeld.resolve(); await releaseChat.promise; }
    return result;
  });
  const creating = system.jobs.create(user.id, speech().args as any, { conversationId: conv.id, messageId: turn.messageId, tool: 'create_job' }); creating.catch(() => {});
  let chatting: ReturnType<typeof request> | undefined;
  try {
    await bounded(userHeld.promise);
    chatting = request(user, 'POST', `/conversations/${conv.id}/messages`, { content: registerPlan({}), mode: 'agent' });
    await bounded(conversationHeld.promise); releaseOrigin.resolve();
    const created = await bounded(creating); assert.equal(created.job.status, 'queued');
    releaseChat.resolve(); assert.equal((await bounded(chatting)).statusCode, 409);
    assert.equal((await page(user, conv.id)).tasks.length, 1);
  } finally { releaseOrigin.resolve(); releaseChat.resolve(); restore(); await creating.catch(() => {}); await chatting?.catch(() => {}); await turn.close(); }
});

test('conversation DELETE waits for the origin commit and then removes only references', async () => {
  const user = await actor(), conv = await conversation(user), turn = await liveTurn(user, conv.id), originLocked = deferred(), releaseOrigin = deferred();
  const deletionLockQuery = 'SELECT id,kind FROM platform_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE';
  const restore = interceptTransactions(async (text, _values, run) => {
    const result = await run(); if (text.includes('FROM platform_runtime_leases') && text.includes('FOR KEY SHARE')) { originLocked.resolve(); await releaseOrigin.promise; } return result;
  });
  const creating = system.jobs.create(user.id, { kind: 'browser', provider: 'browser', prompt: 'Fictional delete race', options: { url: 'https://public-fixture.example.invalid/page' } }, { conversationId: conv.id, messageId: turn.messageId, tool: 'prepare_browser_task' }); creating.catch(() => {});
  let deleting: ReturnType<typeof request> | undefined;
  try {
    await bounded(originLocked.promise); deleting = request(user, 'DELETE', `/conversations/${conv.id}`);
    await waitUntil(async () => Boolean((await db.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query=$1 AND wait_event_type='Lock'", [deletionLockQuery],
    )).rowCount), 'conversation deletion waits for the origin transaction lock');
    releaseOrigin.resolve();
    const created = await bounded(creating); assert.equal((await bounded(deleting)).statusCode, 200);
    assert.equal((await counts(user)).origins, 0); assert.equal((await system.jobs.get(user.id, created.job.id)).status, 'needs_approval');
    assert.equal((await counts(user)).approvals, 1);
  } finally { releaseOrigin.resolve(); restore(); await creating.catch(() => {}); await deleting?.catch(() => {}); await turn.close(); }
});

test('stale-stream recovery and final origin expiry serialize without orphaned jobs or deadlock', async () => {
  const user = await actor(), conv = await conversation(user), turn = await liveTurn(user, conv.id), before = await counts(user);
  await db.query("UPDATE platform_messages SET lease_until=clock_timestamp()+interval '2 seconds' WHERE id=$1", [turn.messageId]);
  await db.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1", [turn.messageId]);
  const originLocked = deferred(), recoveryStarted = deferred(), releaseOrigin = deferred();
  const restore = interceptTransactions(async (text, _values, run) => {
    if (text.startsWith("UPDATE platform_messages SET status='failed'")) recoveryStarted.resolve();
    const result = await run(); if (text.includes('FROM platform_runtime_leases') && text.includes('FOR KEY SHARE')) { originLocked.resolve(); await releaseOrigin.promise; } return result;
  });
  const creating = system.jobs.create(user.id, speech().args as any, { conversationId: conv.id, messageId: turn.messageId, tool: 'create_job' }); creating.catch(() => {});
  let recovery: Promise<void> | undefined;
  try {
    await bounded(originLocked.promise);
    await waitUntil(async () => (await db.query('SELECT m.lease_until<=clock_timestamp() AND l.expires_at<=clock_timestamp() AS expired FROM platform_messages m JOIN platform_runtime_leases l ON l.id=m.id WHERE m.id=$1', [turn.messageId])).rows[0].expired, 'message and runtime lease expiry');
    recovery = recoverStaleStreams(db); await bounded(recoveryStarted.promise); releaseOrigin.resolve();
    await assert.rejects(bounded(creating), (error: unknown) => error instanceof ApiError && error.code === 'CONVERSATION_TASK_ORIGIN_INACTIVE'); await bounded(recovery);
    assert.deepEqual(await counts(user), before); assert.equal((await db.query('SELECT status FROM platform_messages WHERE id=$1', [turn.messageId])).rows[0].status, 'failed');
    assert.equal((await db.query('SELECT id FROM platform_runtime_leases WHERE id=$1', [turn.messageId])).rowCount, 0);
  } finally { releaseOrigin.resolve(); restore(); await creating.catch(() => {}); await recovery?.catch(() => {}); await turn.close(); }
});

test('HTTP bodies and model arguments cannot claim arbitrary task origins', async () => {
  const user = await actor(), conv = await conversation(user), before = await counts(user), fakeOrigin = { conversationId: conv.id, messageId: randomUUID(), tool: 'create_job' };
  for (const extra of [{ origin: fakeOrigin }, { conversationId: conv.id }, { messageId: fakeOrigin.messageId }]) {
    assert.equal((await request(user, 'POST', '/jobs', { ...speech().args, ...extra })).statusCode, 400);
    const body = await respond(user, conv.id, { requests: [{ name: 'create_job', args: { ...speech().args, ...extra } }] }); assert.match(body, /event: error/);
  }
  const browserBody = await respond(user, conv.id, { requests: [{ ...browser(), args: { ...browser().args, origin: fakeOrigin } }] }); assert.match(browserBody, /event: error/);
  const mcpTool = await mcp(user), mcpBody = await respond(user, conv.id, { requests: [{ ...mcpTool, args: { ...mcpTool.args, origin: fakeOrigin } }] }); assert.match(mcpBody, /INVALID_INPUT/);
  assert.deepEqual(await counts(user), before);
  const ordinary = await request(user, 'POST', '/jobs', speech().args); assert.equal(ordinary.statusCode, 201); assert.equal((await page(user, conv.id)).tasks.length, 0);
});
