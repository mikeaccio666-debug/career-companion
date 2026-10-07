import { ModelConsent } from '../src/model-routing.ts';
import { seedFictionalConsent } from './fixtures/student-entry.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatInput, PlatformProviderRuntime } from '@companion/platform-contracts';
import { ConversationTurns, type ConversationTurnAccess } from '../src/conversation-turns.ts';
import { CollectingTurnSink } from '../src/turn-sinks.ts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { authorizeFixedSession, tokenHash } from '../src/auth.ts';
import { JobService } from '../src/jobs.ts';
import { createStorage } from '../src/storage.ts';
import { KnowledgeSources } from '../src/knowledge-sources.ts';
import { AudioTranscriptions } from '../src/audio-transcriptions.ts';
import { GoalPlans } from '../src/goal-plans.ts';
import { GoalPlanProposals } from '../src/goal-plan-proposals.ts';
import { GoalPlanReaders } from '../src/goal-plan-readers.ts';

const base = readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '0' ,PLATFORM_REQUIRE_INVITE:'1'}), schema = `direct_turns_${randomUUID().replaceAll('-', '')}`;
const admin = new Database(base.databaseUrl), url = new URL(base.databaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(url.toString());
let directory: string, turns: ConversationTurns, calls = 0, lastInput: ChatInput | undefined, schemaCreated = false;
let waiting: (() => void) | undefined;
let lastTools: string[] = [], lastToolResult: unknown;
const forbidden = async (): Promise<never> => { throw new Error('This direct-service fixture never calls external media or model providers.'); };
const runtime: PlatformProviderRuntime = {
  capabilities: () => [{ id: 'turn-fixture', name: 'Synthetic direct turn', enabled: true, keyConfigured: true, capabilities: ['chat', 'agent'], models: ['synthetic-turn'], envVariables: [] }],
  createVoiceSession: forbidden, executeJob: forbidden, transcribe: forbidden, speech: forbidden,
  async *streamChat(input, context) {
    calls++; lastInput = input; lastTools = context?.tools?.map(tool => tool.name) ?? []; lastToolResult = undefined;
    const callId = randomUUID();
    await context?.onModelCall?.({ type: 'started', callId, index: 1, provider: 'turn-fixture', model: 'synthetic-turn' });
    yield { type: 'delta', text: 'Synthetic ' };
    const prompt = input.messages.at(-1)?.content;
    if (prompt?.startsWith('Synthetic workbench tool ')) {
      assert(context?.executeTool);
      lastToolResult = await context.executeTool(prompt.slice('Synthetic workbench tool '.length), {});
    }
    if (prompt === 'Synthetic reader') {
      assert(context?.executeTool);
      lastToolResult = await context.executeTool('read_saved_memories', {});
    }
    if (prompt === 'Synthetic wait') {
      waiting?.();
      await new Promise<void>(resolve => { if (context?.signal?.aborted) resolve(); else context?.signal?.addEventListener('abort', () => resolve(), { once: true }); });
      await context?.onModelCall?.({ type: 'finished', callId, status: 'cancelled', usage: { status: 'missing' } });
      return;
    }
    if (prompt === 'Synthetic fail') {
      await context?.onModelCall?.({ type: 'finished', callId, status: 'failed', usage: { status: 'missing' } });
      throw new Error('Synthetic provider failure');
    }
    yield { type: 'delta', text: 'reply' };
    await context?.onModelCall?.({ type: 'finished', callId, status: 'complete', usage: { status: 'reported', inputTokens: 7, outputTokens: 2 } });
    yield { type: 'usage', inputTokens: 7, outputTokens: 2 };
  },
};
before(async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.databaseUrl).hostname), 'This write fixture requires a loopback database.');
  await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true; await db.migrate(); await seedFictionalActiveLegal(db);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-direct-turns-'));
  const config = { ...base, databaseUrl: url.toString(), storageDir: directory };
  const storage = createStorage(config), jobs = new JobService(db, config, runtime, storage,undefined,undefined,FICTIONAL_LEGAL);
  const goalPlans = new GoalPlans(db, jobs, runtime);
  turns = new ConversationTurns({ db, runtime, jobs, goalPlans, knowledge: new KnowledgeSources(db), audioTranscriptions: new AudioTranscriptions(db, storage, runtime), goalPlanProposals: new GoalPlanProposals(db, goalPlans), goalPlanReaders: new GoalPlanReaders(db) });
});
after(async () => {
  await db.close();
  try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
  finally { await admin.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); }
});
async function actor() {
  const userId = randomUUID(), conversationId = randomUUID(), token = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [userId, `${userId}@example.invalid`, 'Synthetic direct-service user', 'synthetic-unused-password-hash']); await seedFictionalConsent(db,userId);
  await db.query("INSERT INTO platform_sessions(token_hash,user_id,expires_at,auth_version) VALUES($1,$2,now()+interval '1 hour',0)", [tokenHash(token), userId]);
  await db.query("INSERT INTO platform_conversations(id,user_id,title,mode,persona) VALUES($1,$2,'Synthetic direct conversation','chat','Synthetic stored persona')", [conversationId, userId]);
  const access: ConversationTurnAccess = { requestAdmission:new ModelConsent(db,FICTIONAL_LEGAL).forSession({userId,tokenHash:tokenHash(token)}), assertAccount: signal => db.transaction(client => authorizeFixedSession(client, { userId, tokenHash: tokenHash(token) }, signal)) };
  return { userId, conversationId, access };
}
type Actor = Awaited<ReturnType<typeof actor>>;
function submit(item: Actor, sink: CollectingTurnSink, data: Record<string, unknown> = {}) {
  return turns.submit({ userId: item.userId, conversationId: item.conversationId, data: { content: 'Synthetic question', provider: 'turn-fixture', ...data } }, sink, item.access);
}
async function messages(item: Actor) { return (await db.query('SELECT role,content,status FROM platform_messages WHERE conversation_id=$1 ORDER BY ordinal', [item.conversationId])).rows; }
async function leases(item: Actor) { return (await db.query('SELECT count(*)::int AS n FROM platform_runtime_leases WHERE user_id=$1', [item.userId])).rows[0].n; }

test('a direct Collecting sink completes the owned response, assembles history and memories, and settles one real call ledger', async () => {
  const item = await actor(), sink = new CollectingTurnSink();
  await db.query("INSERT INTO platform_messages(id,conversation_id,role,content) VALUES($1,$2,'user','Synthetic earlier question'),($3,$2,'assistant','Synthetic earlier reply')", [randomUUID(), item.conversationId, randomUUID()]);
  await db.query('INSERT INTO platform_memories(id,user_id,content) VALUES($1,$2,$3)', [randomUUID(), item.userId, 'Synthetic explicitly saved preference']);
  await submit(item, sink, { mode: 'companion' });
  assert.deepEqual(sink.events.map(event => event.event), ['start', 'delta', 'delta', 'usage', 'done']);
  assert.deepEqual(lastInput?.messages.map(message => message.content), ['Synthetic earlier question', 'Synthetic earlier reply', 'Synthetic question']);
  assert.deepEqual(lastInput?.memories, ['Synthetic explicitly saved preference']); assert.equal(lastInput?.persona, 'Synthetic stored persona');
  assert.deepEqual((await messages(item)).slice(-2), [{ role: 'user', content: 'Synthetic question', status: 'complete' }, { role: 'assistant', content: 'Synthetic reply', status: 'complete' }]);
  const ledger = await db.query('SELECT status,usage_status,input_tokens,output_tokens FROM platform_chat_calls WHERE user_id=$1', [item.userId]);
  assert.deepEqual(ledger.rows, [{ status: 'complete', usage_status: 'reported', input_tokens: 7, output_tokens: 2 }]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_usage WHERE user_id=$1', [item.userId])).rows[0].n, 0);
  assert.equal(await leases(item), 0); assert(sink.opened && sink.settled && sink.closed);
});

test('foreign ownership and an already streaming conversation reject before output or new rows', async () => {
  const owner = await actor(), other = await actor(), before = calls;
  const foreign = new CollectingTurnSink();
  await assert.rejects(turns.submit({ userId: other.userId, conversationId: owner.conversationId, data: { content: 'Synthetic foreign request', provider: 'turn-fixture' } }, foreign, other.access), (error: any) => error.status === 404);
  assert(!foreign.opened); assert.deepEqual(foreign.events, []);
  const occupied = randomUUID();
  await db.query("INSERT INTO platform_messages(id,conversation_id,role,status,lease_until) VALUES($1,$2,'assistant','streaming',now()+interval '2 minutes')", [occupied, owner.conversationId]);
  const busy = new CollectingTurnSink();
  await assert.rejects(submit(owner, busy), (error: any) => error.status === 409 && error.code === 'CONVERSATION_BUSY');
  assert(!busy.opened); assert.deepEqual(busy.events, []); assert.equal((await messages(owner)).length, 1); assert.equal(await leases(owner), 0); assert.equal(calls, before);
});

test('legacy persona validation remains after message persistence and start, before invoking the model', async () => {
  const item = await actor(), sink = new CollectingTurnSink(), before = calls;
  await submit(item, sink, { persona: { invalid: 'Synthetic malformed persona' } });
  assert.deepEqual(sink.events.map(event => event.event), ['start', 'error']); assert.equal(calls, before);
  assert.deepEqual(await messages(item), [{ role: 'user', content: 'Synthetic question', status: 'complete' }, { role: 'assistant', content: '', status: 'failed' }]);
  assert.equal(await leases(item), 0); assert(sink.settled && sink.closed);
});

test('provider failure keeps the actual partial response and failed accounting without a completed event', async () => {
  const item = await actor(), sink = new CollectingTurnSink(); await submit(item, sink, { content: 'Synthetic fail' });
  assert.deepEqual(sink.events.map(event => event.event), ['start', 'delta', 'error']);
  assert.deepEqual((await messages(item)).at(-1), { role: 'assistant', content: 'Synthetic ', status: 'failed' });
  assert.equal((await db.query('SELECT status FROM platform_chat_calls WHERE user_id=$1', [item.userId])).rows[0].status, 'failed');
  assert.equal(await leases(item), 0); assert(sink.settled && sink.closed);
});

test('disconnect after start still cancels the active response and settles its call and runtime lease', { timeout: 10_000 }, async () => {
  const item = await actor(), sink = new CollectingTurnSink();
  let resolve!: () => void; const started = new Promise<void>(yes => { resolve = yes; }); waiting = resolve;
  const pending = submit(item, sink, { content: 'Synthetic wait' });
  try {
    await started; assert.equal(await leases(item), 1); sink.disconnect(); await pending;
    assert.deepEqual((await messages(item)).at(-1), { role: 'assistant', content: 'Synthetic ', status: 'cancelled' });
    assert.equal((await db.query('SELECT status FROM platform_chat_calls WHERE user_id=$1', [item.userId])).rows[0].status, 'cancelled');
    assert(!sink.events.some(event => event.event === 'done')); assert.equal(await leases(item), 0); assert(sink.settled && sink.closed);
  } finally { sink.disconnect(); waiting = undefined; await pending; }
});

test('preparation cancellation rolls back message and lease creation before opening output', async () => {
  const item = await actor(), sink = new CollectingTurnSink(), before = calls; sink.disconnect();
  await assert.rejects(submit(item, sink));
  assert.deepEqual(await messages(item), []); assert.equal(await leases(item), 0); assert.equal(calls, before); assert(!sink.opened);
});


const hiddenWorkbenchTools = ['create_job', 'prepare_browser_task', 'prepare_mcp_task', 'get_execution_capabilities', 'propose_goal_plan'];

test('default-closed Agent advertises saved-source readers without unavailable workbench planning instructions', async () => {
  const item = await actor(), sink = new CollectingTurnSink();
  await db.query('INSERT INTO platform_memories(id,user_id,content) VALUES($1,$2,$3)', [randomUUID(), item.userId, 'Synthetic owned reader evidence']);
  await submit(item, sink, { mode: 'agent', content: 'Synthetic reader' });
  assert(hiddenWorkbenchTools.every(name => !lastTools.includes(name)));
  assert(lastTools.includes('read_saved_memories') && lastTools.includes('read_artifact_text') && lastTools.includes('read_mcp_result') && lastTools.includes('read_goal_plan'));
  assert(!lastInput?.persona?.includes('first read get_execution_capabilities'));
  assert.deepEqual((lastToolResult as { memories: { content: string }[] }).memories.map(memory => memory.content), ['Synthetic owned reader evidence']);
  assert(sink.events.some(event => event.event === 'done'));
  assert.equal(await leases(item), 0);
});

for (const name of hiddenWorkbenchTools) test(`injected runtime cannot call hidden ${name} through the owned conversation callback`, async () => {
  const item = await actor(), sink = new CollectingTurnSink();
  await submit(item, sink, { mode: 'agent', content: `Synthetic workbench tool ${name}` });
  assert(!lastTools.includes(name));
  assert(sink.events.some(event => event.event === 'error' && typeof event.payload === 'object' && event.payload !== null && 'code' in event.payload && event.payload.code === 'WORKBENCH_DISABLED'));
  assert(!sink.events.some(event => event.event === 'done'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_jobs WHERE user_id=$1', [item.userId])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_approvals WHERE user_id=$1', [item.userId])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_goal_plan_proposals WHERE user_id=$1', [item.userId])).rows[0].n, 0);
  assert.equal(await leases(item), 0);
});

test('explicit internal workbench retains actual tool discovery and planning instructions', async () => {
  const item = await actor(), sink = new CollectingTurnSink();
  const config = { ...base, workbenchEnabled: true, databaseUrl: url.toString(), storageDir: directory };
  const storage = createStorage(config), jobs = new JobService(db, config, runtime, storage,undefined,undefined,FICTIONAL_LEGAL), goalPlans = new GoalPlans(db, jobs, runtime);
  const internal = new ConversationTurns({ db, runtime, jobs, goalPlans, knowledge: new KnowledgeSources(db), audioTranscriptions: new AudioTranscriptions(db, storage, runtime), goalPlanProposals: new GoalPlanProposals(db, goalPlans), goalPlanReaders: new GoalPlanReaders(db) });
  await internal.submit({ userId: item.userId, conversationId: item.conversationId, data: { provider: 'turn-fixture', mode: 'agent', content: 'Synthetic workbench tool get_execution_capabilities' } }, sink, item.access);
  assert(hiddenWorkbenchTools.every(name => lastTools.includes(name)));
  assert(lastInput?.persona?.includes('first read get_execution_capabilities'));
  assert.equal((lastToolResult as { providers: { id: string }[] }).providers[0].id, 'turn-fixture');
  assert(sink.events.some(event => event.event === 'done'));
  assert.equal(await leases(item), 0);
});
