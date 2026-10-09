import { ModelConsent } from '../src/model-routing.ts';
import { seedFictionalConsent } from './fixtures/student-entry.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InjectOptions } from 'fastify';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import type { CreateJobInput, JobExecutionContext, PlatformProviderRuntime } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { authorizeFixedSession, tokenHash } from '../src/auth.ts';
import { CollectingTurnSink } from '../src/turn-sinks.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { GoalPlans } from '../src/goal-plans.ts';
import { JobService, processJob, recoverInterrupted } from '../src/jobs.ts';
import { mcpSchemaHash } from '../src/mcp-config.ts';
import type { McpTransport } from '../src/mcp-transport-port.ts';
import { createStorage } from '../src/storage.ts';

const base = readConfig({ ...process.env, PLATFORM_DATA_KEY:'d8'.repeat(32), PLATFORM_ENABLE_WORKBENCH: '0', PLATFORM_CHAT_PROVIDER: 'policy-fixture', PLATFORM_AGENT_PROVIDER: 'policy-fixture' ,PLATFORM_REQUIRE_INVITE:'1'}), schema = `workbench_policy_${randomUUID().replaceAll('-', '')}`;
const admin = new Database(base.databaseUrl), url = new URL(base.databaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(url.toString());
const origin = 'http://localhost:4321';
const kinds = ['browser', 'cli', 'workflow', 'image', 'video', 'mcp'] as const;
const inputSchema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
const schemaHash = mcpSchemaHash(inputSchema);
let directory: string, schemaCreated = false;
let on: JobService, off: JobService, onPlans: GoalPlans, offPlans: GoalPlans, system: Awaited<ReturnType<typeof buildApp>>;
let capabilityReads = 0, executionCalls = 0, discoveries = 0, lastContext: JobExecutionContext | undefined;
let toolRequest: { name: string; args: Record<string, unknown> } | undefined;
let entered: (() => void) | undefined, release: (() => void) | undefined, hold: Promise<void> | undefined;
const forbidden = async (): Promise<never> => { throw new Error('This fixture never calls a real model, browser, voice provider or remote tool.'); };
const runtime: PlatformProviderRuntime = {
  capabilities() {
    capabilityReads++;
    return [
      { id: 'policy-fixture', name: 'Synthetic admission fixture', enabled: true, keyConfigured: true,
        capabilities: ['chat', 'agent', 'image', 'video', 'speech', 'cli'], models: ['synthetic-model'],
        modelsByCapability: { chat: ['synthetic-model'], agent: ['synthetic-model'], image: ['synthetic-model'], video: ['synthetic-model'], speech: ['synthetic-model'] }, envVariables: [] },
      { id: 'browser', name: 'Synthetic browser preparation', enabled: true, keyConfigured: true, capabilities: ['browser'], models: [], envVariables: [] },
      { id: 'workflow', name: 'Synthetic workflow preparation', enabled: true, keyConfigured: true, capabilities: ['workflow'], models: [], envVariables: [] },
    ];
  },
  async *streamChat(_input, context) {
    if (toolRequest) await context?.executeTool?.(toolRequest.name, toolRequest.args);
    yield { type: 'delta', text: 'Synthetic fixture response.' };
  },
  async executeJob(input, context) {
    executionCalls++; lastContext = context;
    if (input.prompt === 'Synthetic held execution') { entered?.(); await hold; }
    context.signal?.throwIfAborted();
    return { artifacts: [{ name: 'synthetic-result.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Synthetic stored result') }] };
  },
  createVoiceSession: forbidden, transcribe: forbidden, speech: forbidden,
};
const transport: McpTransport = {
  async discover() { discoveries++; return [{ name: 'synthetic_lookup', inputSchema }]; },
  call: forbidden,
};

before(async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.databaseUrl).hostname), 'This write fixture requires a loopback database.');
  await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true; await db.migrate(); await seedFictionalActiveLegal(db);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-workbench-policy-'));
  const config = { ...base, databaseUrl: url.toString(), storageDir: directory, maxActiveJobs: 100, requireVerifiedEmail: false,
    accountEmail: undefined, s3: undefined, webStaticDir: undefined, allowedOrigins: new Set([origin]), workbenchEnabled: true,
    mcp: { entries: [{ id: 'policy-catalog', name: 'Synthetic reviewed catalog', url: 'https://policy-fixture.example.invalid/mcp',
      tools: [{ name: 'synthetic_lookup', schemaHash }] }], fixtureOrigins: [] } };
  const storage = createStorage(config);
  on = new JobService(db, config, runtime, storage, undefined, transport,FICTIONAL_LEGAL);
  system = await buildApp({legalBundle:FICTIONAL_LEGAL, db, config: { ...config, workbenchEnabled: false }, storage, runtime, mcp: transport, enableQueue: false,
    requestLimits: { policies: { api: { max: 2000, windowSeconds: 60 }, chat: { max: 2000, windowSeconds: 60 }, control: { max: 2000, windowSeconds: 60 } } } });
  off = system.jobs; onPlans = new GoalPlans(db, on, runtime); offPlans = new GoalPlans(db, off, runtime);
});
after(async () => {
  release?.(); await system?.app.close(); await db.close();
  try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
  finally { await admin.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); }
});

async function actor() {
  const userId = randomUUID(), conversationId = randomUUID(), token = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
    [userId, `${userId}@example.invalid`, 'Synthetic admission user', 'synthetic-unused-password-hash']); await seedFictionalConsent(db,userId);
  await db.query("INSERT INTO platform_sessions(token_hash,user_id,expires_at,auth_version) VALUES($1,$2,now()+interval '1 hour',0)", [tokenHash(token), userId]);
  await db.query("INSERT INTO platform_conversations(id,user_id,title,mode) VALUES($1,$2,'Synthetic admission conversation','agent')", [conversationId, userId]);
  return { userId, conversationId, cookie: `companion_session=${token}` };
}
type Actor = Awaited<ReturnType<typeof actor>>;
function request(owner: Actor, method: 'GET' | 'POST', route: string, payload?: InjectOptions['payload']) {
  return system.app.inject({ method, url: `/api/platform${route}`, payload,
    headers: { origin, cookie: owner.cookie, [PLATFORM_ACCOUNT_HEADER]: owner.userId,
      'x-workbench-enabled': '1', 'x-platform-admin': '1' } });
}
async function input(owner: Actor, kind: CreateJobInput['kind']): Promise<CreateJobInput> {
  if (kind === 'mcp') {
    // Real connection/schema persistence through a synthetic discovery port, never an external RPC.
    const connection = await on.mcp.connect(owner.userId, { catalogId: 'policy-catalog' });
    return { kind, provider: 'mcp', prompt: 'Synthetic reviewed lookup', options: { connectionId: connection.connectionId,
      grantVersion: connection.grantVersion, toolName: 'synthetic_lookup', schemaHash, arguments: { query: 'Synthetic research' } } };
  }
  if (kind === 'browser') return { kind, provider: 'browser', prompt: 'Synthetic reviewed page', options: { url: 'https://page-fixture.example.invalid/' } };
  if (kind === 'workflow') return { kind, provider: 'workflow', prompt: 'Synthetic reviewed workflow', options: { steps: [
    { kind: 'image', provider: 'policy-fixture', model: 'synthetic-model', prompt: 'Synthetic workflow image' },
  ] } };
  return { kind, provider: 'policy-fixture', prompt: 'Synthetic task' };
}
function disabled(error: unknown): boolean { return error instanceof ApiError && error.status === 403 && error.code === 'WORKBENCH_DISABLED'; }
function notOwned(error: unknown): boolean { return error instanceof ApiError && error.status === 404 && error.code === 'NOT_FOUND'; }
async function state(userId: string) {
  const result = await db.query(`SELECT
    (SELECT count(*)::int FROM platform_jobs WHERE user_id=$1) AS jobs,
    (SELECT count(*)::int FROM platform_approvals WHERE user_id=$1) AS approvals,
    (SELECT count(*)::int FROM platform_job_outbox o JOIN platform_jobs j ON j.id=o.job_id WHERE j.user_id=$1) AS outbox,
    (SELECT count(*)::int FROM platform_job_attempts a JOIN platform_jobs j ON j.id=a.job_id WHERE j.user_id=$1) AS attempts,
    (SELECT count(*)::int FROM platform_conversation_tasks WHERE user_id=$1) AS origins`, [userId]);
  return result.rows[0];
}
async function row(id: string) { return (await db.query('SELECT * FROM platform_jobs WHERE id=$1', [id])).rows[0]; }
async function approval(id: string) { return (await db.query('SELECT * FROM platform_approvals WHERE id=$1', [id])).rows[0]; }
async function confirmed(owner: Actor, kind: CreateJobInput['kind']) {
  const plan = await onPlans.create(owner.userId, owner.conversationId, { title: 'Synthetic admission plan', goal: 'Synthetic stored goal',
    steps: [{ kind: 'task', title: 'Synthetic single step', task: await input(owner, kind) }] });
  return onPlans.confirm(owner.userId, plan.id, { revision: plan.revision });
}

for (const kind of kinds) test(`disabled ${kind} creation rejects before provider preparation, source reads or database admission`, async () => {
  const owner = await actor(), before = await state(owner.userId), reads = capabilityReads, calls = executionCalls, discovered = discoveries;
  const value: CreateJobInput = { kind, provider: 'unconfigured-fixture', prompt: 'Synthetic forbidden request', attachmentIds: [randomUUID()],
    options: { internal: true, admin: true, workbenchEnabled: true } };
  await assert.rejects(off.create(owner.userId, value), disabled);
  const response = await request(owner, 'POST', '/jobs', { kind, provider: 'unconfigured-fixture', prompt: 'Synthetic HTTP request',
    options: { internal: true, admin: true, workbenchEnabled: true } });
  assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error.code, 'WORKBENCH_DISABLED');
  assert.deepEqual(await state(owner.userId), before); assert.equal(capabilityReads, reads); assert.equal(executionCalls, calls); assert.equal(discoveries, discovered);
});

test('live Agent tools and the dedicated MCP task route cannot bypass shared admission', async () => {
  const owner = await actor(), mcp = await input(owner, 'mcp'), before = await state(owner.userId), calls = executionCalls;
  try {
    for (const kind of kinds) {
      const value = kind === 'mcp' ? mcp : await input(owner, kind);
      toolRequest = kind === 'mcp' ? { name: 'prepare_mcp_task', args: { ...value.options, goal: value.prompt } }
        : { name: 'create_job', args: { ...value } };
      const blocked = await request(owner, 'POST', `/conversations/${owner.conversationId}/messages`,
        { content: 'Synthetic Agent preparation', mode: 'agent' });
      assert.equal(blocked.statusCode, 400, blocked.body);
      const override = await request(owner, 'POST', `/conversations/${owner.conversationId}/messages`,
        { content: 'Synthetic Agent preparation', provider: 'policy-fixture' });
      assert.equal(override.statusCode, 400, override.body);
      const sink = new CollectingTurnSink(), session = Object.freeze({ userId: owner.userId, tokenHash: tokenHash(owner.cookie.split('=')[1]) });
      await system.conversationTurns.submit({ userId: owner.userId, conversationId: owner.conversationId,
        data: { content: 'Synthetic Agent preparation', provider: 'policy-fixture', mode: 'agent' } }, sink,
        { requestAdmission:new ModelConsent(db,FICTIONAL_LEGAL).forSession(session), assertAccount: signal => db.transaction(client => authorizeFixedSession(client, session, signal)) });
      assert(sink.opened); assert.match(JSON.stringify(sink.events), /WORKBENCH_DISABLED/);
      assert(!sink.events.some(item => item.event === 'approval'));
    }
  } finally { toolRequest = undefined; }
  const response = await request(owner, 'POST', '/mcp/tasks', { ...mcp.options, goal: mcp.prompt });
  assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error.code, 'WORKBENCH_DISABLED');
  assert.deepEqual(await state(owner.userId), before); assert.equal(executionCalls, calls);
  // Exercise the shared service with an actual live server origin as well as the tool adapter.
  const messageId = randomUUID();
  await db.query("INSERT INTO platform_messages(id,conversation_id,role,status,lease_until) VALUES($1,$2,'assistant','streaming',now()+interval '2 minutes')", [messageId, owner.conversationId]);
  await db.query("INSERT INTO platform_runtime_leases(id,user_id,kind,expires_at) VALUES($1,$2,'chat',now()+interval '2 minutes')", [messageId, owner.userId]);
  try {
    for (const kind of kinds) {
      await assert.rejects(off.create(owner.userId, kind === 'mcp' ? mcp : await input(owner, kind),
        { conversationId: owner.conversationId, messageId, tool: kind === 'mcp' ? 'prepare_mcp_task' : kind === 'browser' ? 'prepare_browser_task' : 'create_job' }), disabled);
    }
    assert.deepEqual(await state(owner.userId), before);
  } finally {
    await db.query("UPDATE platform_messages SET status='cancelled',lease_until=NULL WHERE id=$1", [messageId]);
    await db.query('DELETE FROM platform_runtime_leases WHERE id=$1', [messageId]);
  }
});

test('all six confirmed goal-plan new bindings reject atomically while disabled', async () => {
  const owner = await actor();
  for (const kind of kinds) {
    const plan = await confirmed(owner, kind), before = await state(owner.userId);
    await assert.rejects(offPlans.continue(owner.userId, plan.id, { revision: plan.revision, stepIndex: 0 }), disabled);
    assert.deepEqual(await state(owner.userId), before);
    const current = await offPlans.get(owner.userId, plan.id);
    assert.equal(current.status, 'active'); assert.equal(current.steps[0].state, 'pending'); assert.equal(current.steps[0].ready, true);
    assert.equal(current.steps[0].job, undefined); assert.equal(current.steps[0].approval, undefined);
    const binding = (await db.query('SELECT job_id,bound_at,resolved_task,input_sources FROM platform_goal_plan_steps WHERE plan_id=$1', [plan.id])).rows[0];
    assert.equal(binding.job_id, null); assert.equal(binding.bound_at, null); assert.equal(binding.resolved_task, null);
  }
});

test('disabled owner retries preserve failed, cancelled and uncertain generations for every workbench kind', async () => {
  const owner = await actor();
  for (const [index, kind] of kinds.entries()) {
    const created = await on.create(owner.userId, await input(owner, kind));
    await db.query('UPDATE platform_jobs SET status=$2 WHERE id=$1', [created.job.id, ['failed', 'cancelled', 'uncertain'][index % 3]]);
    const before = await state(owner.userId), original = await row(created.job.id);
    await assert.rejects(off.retry(owner.userId, created.job.id), disabled);
    const response = await request(owner, 'POST', `/jobs/${created.job.id}/retry`);
    assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error.code, 'WORKBENCH_DISABLED');
    assert.deepEqual(await row(created.job.id), original); assert.deepEqual(await state(owner.userId), before);
  }
});

test('disabled pending approvals never enqueue any workbench kind and remain available for rejection', async () => {
  const owner = await actor();
  for (const kind of kinds) {
    const plan = await confirmed(owner, kind), created = await onPlans.continue(owner.userId, plan.id, { revision: plan.revision, stepIndex: 0 });
    assert.equal(created.kind, 'task'); if (created.kind !== 'task') throw new Error('Expected a synthetic task.');
    assert(created.approval);
    const before = await state(owner.userId), originalJob = await row(created.job.id), originalApproval = await approval(created.approval.id);
    await assert.rejects(off.decide(owner.userId, created.approval.id, 'approved'), disabled);
    const response = await request(owner, 'POST', `/approvals/${created.approval.id}/decision`, { decision: 'approved' });
    assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error.code, 'WORKBENCH_DISABLED');
    assert.deepEqual(await row(created.job.id), originalJob); assert.deepEqual(await approval(created.approval.id), originalApproval);
    assert.deepEqual(await state(owner.userId), before);
    assert.equal((await off.decide(owner.userId, created.approval.id, 'rejected')).status, 'rejected');
    assert.equal((await off.get(owner.userId, created.job.id)).status, 'cancelled');
    assert.equal((await state(owner.userId)).outbox, before.outbox);
  }
});

test('foreign ownership still rejects retry, approve, reject, read, cancel and plan access before policy disclosure', async () => {
  const owner = await actor(), other = await actor(), created = await on.create(owner.userId, await input(owner, 'cli'));
  assert(created.approval); await on.cancel(owner.userId, created.job.id);
  const plan = await confirmed(owner, 'image'), before = await state(owner.userId);
  for (const action of [() => off.retry(other.userId, created.job.id), () => off.decide(other.userId, created.approval.id, 'approved'),
    () => off.decide(other.userId, created.approval.id, 'rejected'), () => off.get(other.userId, created.job.id),
    () => off.cancel(other.userId, created.job.id), () => offPlans.continue(other.userId, plan.id, { revision: plan.revision, stepIndex: 0 })]) {
    await assert.rejects(action(), notOwned);
  }
  assert.deepEqual(await state(owner.userId), before); assert.deepEqual(await off.list(other.userId), []);
});

test('disabled read and cancellation retain real metadata, private artifacts and lease-aware cleanup semantics', async () => {
  const owner = await actor(), completed = await on.create(owner.userId, await input(owner, 'image'));
  await processJob(off, completed.job.id, 1);
  const read = await off.get(owner.userId, completed.job.id);
  assert.equal(read.status, 'succeeded'); assert.equal(read.provider, 'policy-fixture'); assert.equal(read.model, 'synthetic-model'); assert.equal(read.artifacts.length, 1);
  assert.equal((await off.list(owner.userId))[0].id, read.id);
  const pending = await on.create(owner.userId, await input(owner, 'cli'));
  assert.equal((await off.cancel(owner.userId, pending.job.id)).status, 'cancelled'); assert.equal((await approval(pending.approval.id)).status, 'rejected');
  const running = await on.create(owner.userId, await input(owner, 'image')), lease = randomUUID();
  await db.query("UPDATE platform_jobs SET status='running',lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1", [running.job.id, lease]);
  const cancelled = await off.cancel(owner.userId, running.job.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error?.code, 'CANCELLATION_PENDING'); assert.equal((await row(running.job.id)).lease_token, lease);
});

test('explicit internal enablement preserves all six real preparation and approval paths with original validation', async () => {
  const owner = await actor();
  for (const kind of kinds) {
    const value = await input(owner, kind), created = await on.create(owner.userId, value);
    assert.equal(created.job.kind, kind); assert.equal(created.job.provider, value.provider);
    const before = await state(owner.userId);
    if (['browser', 'cli', 'workflow', 'mcp'].includes(kind)) {
      assert.equal(created.job.status, 'needs_approval'); assert(created.approval);
      assert.equal((await on.decide(owner.userId, created.approval.id, 'approved')).status, 'approved');
      assert.equal((await state(owner.userId)).outbox, before.outbox + 1);
    } else { assert.equal(created.job.status, 'queued'); assert.equal(created.approval, undefined); }
    assert.equal((await on.get(owner.userId, created.job.id)).status, 'queued');
  }
  await assert.rejects(on.create(owner.userId, { kind: 'image', provider: 'missing-fixture', prompt: 'Synthetic unavailable provider' }),
    (error: unknown) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE');
  const retry = await on.create(owner.userId, await input(owner, 'image'));
  await db.query("UPDATE platform_jobs SET status='failed' WHERE id=$1", [retry.job.id]);
  assert.equal((await on.retry(owner.userId, retry.job.id)).status, 'queued'); assert.equal((await row(retry.job.id)).generation, 2);
});

test('already decided approvals stay idempotent while disabled without a new notification', async () => {
  const owner = await actor(), accepted = await on.create(owner.userId, await input(owner, 'cli'));
  await on.decide(owner.userId, accepted.approval.id, 'approved');
  const original = await row(accepted.job.id), before = await state(owner.userId);
  assert.equal((await off.decide(owner.userId, accepted.approval.id, 'approved')).status, 'approved');
  assert.deepEqual(await row(accepted.job.id), original); assert.deepEqual(await state(owner.userId), before);
  await assert.rejects(off.decide(owner.userId, accepted.approval.id, 'rejected'), (error: unknown) => error instanceof ApiError && error.code === 'APPROVAL_DECIDED');
  await assert.rejects(off.retry(owner.userId, accepted.job.id), (error: unknown) => error instanceof ApiError && error.code === 'JOB_NOT_RETRYABLE');
  await processJob(off, accepted.job.id, 1);
  assert.equal((await off.get(owner.userId, accepted.job.id)).status, 'succeeded');
  const completed = await row(accepted.job.id), afterCompletion = await state(owner.userId);
  assert.equal((await off.decide(owner.userId, accepted.approval.id, 'approved')).status, 'approved');
  assert.deepEqual(await row(accepted.job.id), completed); assert.deepEqual(await state(owner.userId), afterCompletion);
});

test('disabled continuation and authorized creation replay only read a bound pending or queued plan task', async () => {
  const owner = await actor(), plan = await confirmed(owner, 'cli');
  const created = await onPlans.continue(owner.userId, plan.id, { revision: plan.revision, stepIndex: 0 });
  assert.equal(created.kind, 'task'); if (created.kind !== 'task') throw new Error('Expected a synthetic task.');
  assert(created.approval);
  const frozen = (await onPlans.get(owner.userId, plan.id)).steps[0].input;
  assert.equal(frozen.kind, 'task'); if (frozen.kind !== 'task') throw new Error('Expected a synthetic template.');
  for (const status of ['needs_approval', 'queued'] as const) {
    if (status === 'queued') await on.decide(owner.userId, created.approval.id, 'approved');
    const before = await state(owner.userId), original = await row(created.job.id);
    assert.equal((await offPlans.continue(owner.userId, plan.id, { revision: plan.revision, stepIndex: 0 })).kind, 'existing');
    const replay = await off.create(owner.userId, frozen.task, undefined, undefined, { planId: plan.id, revision: plan.revision, stepIndex: 0 });
    assert.equal(replay.job.id, created.job.id); assert.equal(replay.job.status, status); assert.equal(Boolean(replay.approval), status === 'needs_approval');
    assert.deepEqual(await row(created.job.id), original); assert.deepEqual(await state(owner.userId), before);
  }
});

test('a task accepted before disablement still acquires its worker lease and publishes the genuine fixture result', async () => {
  const owner = await actor(), created = await on.create(owner.userId, await input(owner, 'image')), before = executionCalls;
  await processJob(off, created.job.id, 1);
  const current = await off.get(owner.userId, created.job.id);
  assert.equal(executionCalls, before + 1); assert.equal(current.status, 'succeeded'); assert.equal(current.artifacts.length, 1);
  assert.deepEqual((await db.query('SELECT generation,attempt,status FROM platform_job_attempts WHERE job_id=$1', [created.job.id])).rows,
    [{ generation: 1, attempt: 1, status: 'succeeded' }]);
  assert.equal((await row(created.job.id)).lease_token, null);
});

test('disablement leaves an already running accepted task and its lease intact until completion', { timeout: 10_000 }, async () => {
  const owner = await actor(), created = await on.create(owner.userId, { ...await input(owner, 'image'), prompt: 'Synthetic held execution' });
  let begun!: () => void; const started = new Promise<void>(resolve => { begun = resolve; }); entered = begun;
  hold = new Promise<void>(resolve => { release = resolve; });
  const changingConfig = { ...on.config }, changing = new JobService(db, changingConfig, runtime, on.storage, undefined, transport,FICTIONAL_LEGAL);
  const execution = processJob(changing, created.job.id, 1);
  try {
    await started; const running = await row(created.job.id), before = await state(owner.userId);
    assert.equal(running.status, 'running'); assert(running.lease_token); assert(lastContext?.signal?.aborted === false);
    changingConfig.workbenchEnabled = false;
    await assert.rejects(changing.create(owner.userId, await input(owner, 'image')), disabled);
    await assert.rejects(off.retry(owner.userId, created.job.id), (error: unknown) => error instanceof ApiError && error.code === 'JOB_NOT_RETRYABLE');
    assert.deepEqual(await row(created.job.id), running); assert.deepEqual(await state(owner.userId), before); assert(lastContext?.signal?.aborted === false);
    release?.(); await execution; assert.equal((await off.get(owner.userId, created.job.id)).status, 'succeeded');
  } finally { release?.(); await execution; entered = undefined; release = undefined; hold = undefined; }
});

test('known accepted provider-result recovery remains available while disabled even when it advances generation', async () => {
  const owner = await actor(), created = await on.create(owner.userId, await input(owner, 'video'));
  await db.query("UPDATE platform_jobs SET status='running',lease_token=$2,lease_until=now()-interval '1 second',provider_task_id='synthetic-existing-handle' WHERE id=$1", [created.job.id, randomUUID()]);
  const before = await state(owner.userId); await recoverInterrupted(off);
  const recovered = await row(created.job.id);
  assert.equal(recovered.status, 'queued'); assert.equal(recovered.generation, 2); assert.equal(recovered.provider_task_id, 'synthetic-existing-handle');
  assert.equal((await state(owner.userId)).outbox, before.outbox + 1);
  await processJob(off, created.job.id, 2);
  assert.equal(lastContext?.previousProviderTaskId, 'synthetic-existing-handle'); assert.equal((await off.get(owner.userId, created.job.id)).status, 'succeeded');
});

test('speech remains outside workbench admission and retains its existing create and retry path', async () => {
  const owner = await actor(), created = await off.create(owner.userId, await input(owner, 'speech'));
  assert.equal(created.job.status, 'queued');
  await db.query("UPDATE platform_jobs SET status='failed' WHERE id=$1", [created.job.id]);
  assert.equal((await off.retry(owner.userId, created.job.id)).status, 'queued'); assert.equal((await row(created.job.id)).generation, 2);
});
