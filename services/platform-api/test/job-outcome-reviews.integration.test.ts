import { FICTIONAL_LEGAL, fictionalRegistration, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CreateJobInput, JobOutcomeReviewInput, JobOutcomeReviewPage, PlatformProviderRuntime } from '@companion/platform-contracts';
import { JOB_OUTCOME_REVIEW_MAX_RESPONSE_BYTES, PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { browserDefinitionHash, ProviderError, validateComfyUITemplateSnapshot, workflowHash } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';
import { processJob } from '../src/jobs.ts';
import { mcpSchemaHash } from '../src/mcp-config.ts';
import type { McpTransport } from '../src/mcp-transport-port.ts';

const base = readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1' ,PLATFORM_REQUIRE_INVITE:'1'}), prefix = '/api/platform', origin = 'http://localhost:4321';
const schema = `outcome_review_${randomUUID().replaceAll('-', '')}`, admin = new Database(base.databaseUrl), databaseUrl = new URL(base.databaseUrl);
databaseUrl.searchParams.set('options', `-c search_path=${schema}`); databaseUrl.searchParams.set('application_name', schema); const db = new Database(databaseUrl.toString());
let system: Awaited<ReturnType<typeof buildApp>>, directory: string, executions = 0, mcpCalls = 0, registrations = 0;
interface Actor { id: string; cookie: string }
const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
const templateBody = { version: 1 as const, outputKind: 'image' as const, baseUrl: 'http://127.0.0.1:8188', promptNode: '1', promptField: 'text', graph: { '1': { class_type: 'FictionalTextInput', inputs: { text: 'Fictional private template' } } } };
const template = { ...templateBody, hash: workflowHash(templateBody) };
const forbidden = async (): Promise<never> => { throw new Error('No model, mail, real browser, CLI container or external provider may be called by this fixture.'); };
const runtime: PlatformProviderRuntime = {
  capabilities: () => [
    { id: 'synthetic', name: 'Fictional outcome fixture', enabled: true, keyConfigured: true, capabilities: ['chat', 'agent', 'image', 'video', 'speech', 'cli'], models: ['fictional-model'], modelsByCapability: { agent: ['fictional-model'], image: ['fictional-model'], speech: ['fictional-model'] }, envVariables: [] },
    { id: 'browser', name: 'Fictional browser fixture', enabled: true, keyConfigured: true, capabilities: ['browser'], models: [], browserActionsEnabled: true, envVariables: [] },
    { id: 'workflow', name: 'Fictional workflow fixture', enabled: true, keyConfigured: true, capabilities: ['workflow'], models: [], envVariables: [] },
    { id: 'comfyui', name: 'Fictional reviewed ComfyUI fixture', enabled: true, keyConfigured: true, capabilities: ['image'], models: [], executionTemplate: { version: 1, hash: template.hash }, envVariables: [] },
  ],
  captureComfyUITemplate: () => structuredClone(template),
  validateComfyUITemplate: (snapshot, binding) => { validateComfyUITemplateSnapshot(snapshot, binding); },
  async *streamChat() { throw new Error('Manual outcome review must never invoke a model.'); },
  async executeJob(input, context) {
    ++executions;
    if (input.kind === 'browser') await context.onBrowserCheckpoint!({ type: 'started', index: 0, expectedRevision: 0, definitionHash: browserDefinitionHash(input) });
    if (input.kind === 'workflow') await context.onWorkflowCheckpoint!({ type: 'started', index: 0, expectedRevision: 0, inputHash: workflowHash({ fixture: 'fictional-started-step' }) });
    if (input.kind === 'cli') throw new ApiError(503, 'CLI_CLEANUP_UNCONFIRMED', 'Fictional container cleanup is unconfirmed.');
    throw new ProviderError('COMFYUI_SUBMISSION_UNCERTAIN', 'Fictional request outcome is unknown.');
  }, createVoiceSession: forbidden, transcribe: forbidden, speech: forbidden,
};
const transport: McpTransport = {
  discover: async () => [{ name: 'fictional_lookup', inputSchema }],
  async call(_entry, _input, context) { await context.beforeCall(); ++mcpCalls; throw new ApiError(502, 'MCP_CALL_UNCERTAIN', 'Fictional transport disconnected after the durable started boundary.'); },
};
async function start() {
  system = await buildApp({legalBundle:FICTIONAL_LEGAL, db, runtime, mcp: transport, enableQueue: false,
    config: { ...base, databaseUrl: databaseUrl.toString(), storageDir: directory, requireVerifiedEmail: false, accountEmail: undefined, maxActiveJobs: 100,
      mcp: { entries: [{ id: 'fictional-outcome', name: 'Fictional reviewed reference', url: 'https://mcp.example.invalid/not-fetched', tools: [{ name: 'fictional_lookup', schemaHash: mcpSchemaHash(inputSchema) }] }], fixtureOrigins: [] } },
    requestLimits: { policies: { api: { max: 2000, windowSeconds: 60 }, control: { max: 2000, windowSeconds: 60 }, 'auth-register': { max: 1000, windowSeconds: 60 } } } });
}
before(async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.databaseUrl).hostname), 'An explicitly supplied loopback QA database is required.');
  await admin.query(`CREATE SCHEMA ${schema}`); await db.migrate(); await seedFictionalActiveLegal(db); directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-outcome-review-')); await start();
});
after(async () => { await system?.app.close(); await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
async function exchange(actor: Actor | undefined, method: 'GET' | 'POST', route: string, payload?: any, override: Record<string, string | undefined> = {}) {
  const headers: Record<string, string> = { origin, ...(actor ? { cookie: actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id } : {}) };
  for (const [key, value] of Object.entries(override)) { if (value === undefined) delete headers[key]; else headers[key] = value; }
  return system.app.inject({ method, url: prefix + route, remoteAddress: `127.0.4.${Math.min(++registrations, 250)}`, headers, payload });
}
async function actor(): Promise<Actor> {
  const response = await exchange(undefined, 'POST', '/auth/register', await fictionalRegistration(db,{ name: 'Fictional manual reviewer', email: `${randomUUID()}@example.invalid`, password: 'Fictional-password-123' }));
  assert.equal(response.statusCode, 201, response.body); return { id: response.json().user.id, cookie: (response.headers['set-cookie'] as string).split(';')[0] };
}
async function create(owner: Actor, kind: CreateJobInput['kind'] = 'image', provider?: string) {
  let created: any;
  if (kind === 'mcp') {
    const linked = await exchange(owner, 'POST', '/mcp/connections', { catalogId: 'fictional-outcome' }); assert.equal(linked.statusCode, 201, linked.body); const connection = linked.json().connection;
    const prepared = await exchange(owner, 'POST', '/mcp/tasks', { connectionId: connection.connectionId, grantVersion: connection.grantVersion, toolName: 'fictional_lookup', schemaHash: mcpSchemaHash(inputSchema), arguments: {}, goal: 'Fictional observation only' });
    assert.equal(prepared.statusCode, 201, prepared.body); created = prepared.json();
  } else {
    const input: CreateJobInput = { kind, provider: provider ?? (kind === 'browser' || kind === 'workflow' ? kind : 'synthetic'), prompt: 'Fictional unknown task',
      ...(kind === 'browser' ? { options: { url: 'https://example.invalid/not-fetched', actions: [{ type: 'scroll', direction: 'down', pixels: 100 }] } } : {}),
      ...(kind === 'workflow' ? { options: { steps: [{ kind: 'speech', provider: 'synthetic', prompt: 'Fictional workflow step' }] } } : {}) };
    const response = await exchange(owner, 'POST', '/jobs', input); assert.equal(response.statusCode, 201, response.body); created = response.json();
  }
  if (created.approval) { const approval = await exchange(owner, 'POST', `/approvals/${created.approval.id}/decision`, { decision: 'approved' }); assert.equal(approval.statusCode, 200, approval.body); }
  return created.job.id as string;
}
async function unknown(owner: Actor, kind: CreateJobInput['kind'] = 'image', provider?: string) { const jobId = await create(owner, kind, provider); await processJob(system.jobs, jobId, 1); assert.equal((await system.jobs.get(owner.id, jobId)).status, 'uncertain'); return jobId; }
async function read(owner: Actor, jobId: string, generation?: number): Promise<JobOutcomeReviewPage> {
  const response = await exchange(owner, 'GET', `/jobs/${jobId}/outcome-review${generation === undefined ? '' : `?generation=${generation}`}`);
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['cache-control'], 'private, no-store'); return response.json();
}
function input(page: JobOutcomeReviewPage, changes: Partial<JobOutcomeReviewInput> = {}): JobOutcomeReviewInput { return { generation: page.requestedGeneration, evidenceVersion: page.evidence!.version, expectedRevision: page.latestRevision, requestId: randomUUID(), outcome: 'still_unknown', ...changes }; }
const save = (owner: Actor, jobId: string, value: JobOutcomeReviewInput | Record<string, unknown>) => exchange(owner, 'POST', `/jobs/${jobId}/outcome-reviews`, value);
const errorCode = (response: any) => response.json().error.code;
async function executionSnapshot(owner: Actor) {
  const tables = ['platform_jobs', 'platform_job_attempts', 'platform_approvals', 'platform_job_outbox', 'platform_browser_checkpoints', 'platform_browser_action_ledger', 'platform_workflow_checkpoints', 'platform_workflow_step_ledger', 'platform_mcp_receipts', 'platform_model_relay_requests', 'platform_artifacts', 'platform_uploads', 'platform_goal_plans', 'platform_goal_plan_steps'];
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    const own = ['platform_jobs', 'platform_approvals', 'platform_mcp_receipts', 'platform_artifacts', 'platform_uploads', 'platform_goal_plans'].includes(table) ? 'user_id=$1' : table === 'platform_goal_plan_steps' ? 'plan_id IN (SELECT id FROM platform_goal_plans WHERE user_id=$1)' : 'job_id IN (SELECT id FROM platform_jobs WHERE user_id=$1)';
    result[table] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${table} t WHERE ${own}`, [owner.id])).rows[0].rows;
  }
  return result;
}
async function reviewCount(owner: Actor) { return (await db.query('SELECT count(*)::int AS count FROM platform_job_outcome_reviews WHERE user_id=$1', [owner.id])).rows[0].count; }
async function waitForLock() {
  const deadline = Date.now() + 3000;
  while (!(await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%platform_jobs%FOR UPDATE%') AS waiting", [schema])).rows[0].waiting) {
    if (Date.now() > deadline) throw new Error('The isolated review did not reach the job lock.'); await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('owned account and origin guards precede reads and human declarations cannot set execution facts', async () => {
  const owner = await actor(), other = await actor(), jobId = await unknown(owner), page = await read(owner, jobId), body = input(page);
  assert.equal((await exchange(undefined, 'GET', `/jobs/${jobId}/outcome-review`)).statusCode, 401);
  assert.equal((await exchange(other, 'GET', `/jobs/${jobId}/outcome-review`)).statusCode, 404); assert.equal((await save(other, jobId, body)).statusCode, 404);
  assert.equal(errorCode(await exchange(owner, 'GET', `/jobs/${jobId}/outcome-review`, undefined, { [PLATFORM_ACCOUNT_HEADER]: other.id })), 'ACCOUNT_CONTEXT_CHANGED');
  assert.equal(errorCode(await exchange(owner, 'GET', `/jobs/${jobId}/outcome-review`, undefined, { [PLATFORM_ACCOUNT_HEADER]: undefined })), 'ACCOUNT_CONTEXT_REQUIRED');
  assert.equal((await exchange(owner, 'POST', `/jobs/${jobId}/outcome-reviews`, body, { origin: 'https://other.example.invalid' })).statusCode, 403);
  for (const extra of [{ status: 'succeeded' }, { verified: true }, { providerTaskId: 'fictional-handle' }, { userId: owner.id }, { outcome: ['observed_effect'] }, { note: 'x'.repeat(2001) }]) assert.equal((await save(owner, jobId, { ...body, ...extra })).statusCode, 400);
  assert.equal((await exchange(owner, 'GET', `/jobs/${jobId}/outcome-review?generation=1&userId=${owner.id}`)).statusCode, 400); assert.equal(await reviewCount(owner), 0);
});
test('three human observations are append-only, do not alter execution tables and leave every unsafe retry blocked', async () => {
  for (const [kind, retryCode] of [['browser', 'BROWSER_REVIEW_REQUIRED'], ['workflow', 'WORKFLOW_REVIEW_REQUIRED'], ['mcp', 'MCP_REVIEW_REQUIRED'], ['cli', 'OPERATOR_REVIEW_REQUIRED']] as const) {
    const owner = await actor(), jobId = await unknown(owner, kind), before = await executionSnapshot(owner), calls = [executions, mcpCalls];
    for (const outcome of ['observed_effect', 'no_effect_observed', 'still_unknown'] as const) {
      const page = await read(owner, jobId), response = await save(owner, jobId, input(page, { outcome, note: '  Fictional external observation  ' })); assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().record.verified, false); assert.equal(response.json().record.provenance, 'user_reported'); assert.equal(response.json().record.note, 'Fictional external observation');
      assert.equal(errorCode(await exchange(owner, 'POST', `/jobs/${jobId}/retry`, {})), retryCode);
      assert.deepEqual(await executionSnapshot(owner), before); assert.deepEqual([executions, mcpCalls], calls);
    }
    const page = await read(owner, jobId); assert.equal(page.latestRevision, 3); assert.deepEqual(page.records.map(record => record.outcome), ['still_unknown', 'no_effect_observed', 'observed_effect']);
  }
});
test('cleanup tokens, even expired or incomplete lease pairs, prevent saving and known outcomes are not manual-unknown tasks', async () => {
  const owner = await actor(), jobId = await unknown(owner);
  for (const lease of [{ token: randomUUID(), until: null }, { token: null, until: new Date(Date.now() - 60000) }, { token: randomUUID(), until: new Date(Date.now() - 60000) }]) {
    await db.query("UPDATE platform_jobs SET status='cancelled',lease_token=$2,lease_until=$3 WHERE id=$1", [jobId, lease.token, lease.until]); const page = await read(owner, jobId);
    assert.equal(page.evidence?.cleanupPending, true); assert.deepEqual(page.writeEligibility, { allowed: false, reason: 'cleanup_pending' }); assert.equal(errorCode(await save(owner, jobId, input(page))), 'JOB_OUTCOME_CLEANUP_PENDING');
  }
  for (const status of ['queued', 'running', 'succeeded', 'failed']) {
    await db.query('UPDATE platform_jobs SET status=$2,error_code=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1', [jobId, status]); const page = await read(owner, jobId); assert.equal(page.writeEligibility.allowed, false); assert.equal(errorCode(await save(owner, jobId, input(page))), 'JOB_OUTCOME_NOT_REVIEWABLE');
  }
  assert.equal(await reviewCount(owner), 0);
});
test('a reviewed synthetic ComfyUI template with an unknown submission and no handle remains unreplayable after every observation', async () => {
  const owner = await actor(), jobId = await unknown(owner, 'image', 'comfyui'), before = await executionSnapshot(owner), calls = [executions, mcpCalls];
  const job = await system.jobs.get(owner.id, jobId); assert.equal(job.providerTaskId, undefined); assert.equal(job.executionTemplate?.hash, template.hash);
  for (const outcome of ['observed_effect', 'no_effect_observed', 'still_unknown'] as const) {
    const page = await read(owner, jobId); assert(page.evidence!.reasons.includes('comfyui_submission_unknown'));
    const response = await save(owner, jobId, input(page, { outcome })); assert.equal(response.statusCode, 200, response.body);
    assert.equal(errorCode(await exchange(owner, 'POST', `/jobs/${jobId}/retry`, {})), 'COMFYUI_REVIEW_REQUIRED'); assert.deepEqual(await executionSnapshot(owner), before); assert.deepEqual([executions, mcpCalls], calls);
  }
});
test('concurrent CAS saves one revision; duplicate request IDs return one canonical record and never mutate it', async () => {
  const owner = await actor(), jobId = await unknown(owner), page = await read(owner, jobId), first = input(page, { note: '  Fictional same observation  ' }), second = input(page);
  const responses = await Promise.all([save(owner, jobId, first), save(owner, jobId, second)]); assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]); assert.equal(errorCode(responses.find(response => response.statusCode === 409)), 'JOB_OUTCOME_REVISION_CONFLICT'); assert.equal(await reviewCount(owner), 1);
  const winning = responses[0].statusCode === 200 ? first : second, saved = responses.find(response => response.statusCode === 200)!.json().record;
  const repeated = await Promise.all([save(owner, jobId, winning), save(owner, jobId, { ...winning, ...(winning.note ? { note: winning.note.trim(), requestId: winning.requestId.toUpperCase() } : {}) })]);
  for (const response of repeated) { assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json().record, saved); }
  assert.equal(await reviewCount(owner), 1); assert.equal(errorCode(await save(owner, jobId, { ...winning, outcome: 'observed_effect' })), 'JOB_OUTCOME_REQUEST_CONFLICT');
  const otherJob = await unknown(owner); assert.equal(errorCode(await save(owner, otherJob, winning)), 'JOB_OUTCOME_REQUEST_CONFLICT'); assert.equal(await reviewCount(owner), 1);
});
test('a lost-response replay survives changed evidence, a newer review and a later generation; historical reads never adopt current facts', async () => {
  const owner = await actor(), jobId = await unknown(owner), page = await read(owner, jobId), body = input(page), saved = await save(owner, jobId, body); assert.equal(saved.statusCode, 200, saved.body);
  await save(owner, jobId, input(await read(owner, jobId), { outcome: 'observed_effect' }));
  await db.query("UPDATE platform_jobs SET generation=2,status='running',provider_task_id='fictional-new-handle',lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1", [jobId, randomUUID()]);
  const replay = await save(owner, jobId, body); assert.equal(replay.statusCode, 200, replay.body); assert.deepEqual(replay.json().record, saved.json().record); assert.equal(await reviewCount(owner), 2);
  const history = await read(owner, jobId, 1); assert.equal(history.requestedGeneration, 1); assert.equal(history.currentGeneration, 2); assert.equal(history.evidence, null); assert.deepEqual(history.writeEligibility, { allowed: false, reason: 'historical_generation' }); assert.equal(history.records.length, 2);
  assert.equal(errorCode(await save(owner, jobId, { ...body, requestId: randomUUID() })), 'JOB_OUTCOME_GENERATION_CHANGED');
  const current = await read(owner, jobId); assert.equal(current.requestedGeneration, 2); assert.equal(current.records.length, 0); assert.equal(current.latestRevision, 0);
  assert.equal(errorCode(await exchange(owner, 'GET', `/jobs/${jobId}/outcome-review?generation=3`)), 'JOB_OUTCOME_GENERATION_CHANGED');
});
test('evidence version detects changes that retain the same visible boolean or status', async () => {
  const owner = await actor(), jobId = await unknown(owner); await db.query("UPDATE platform_jobs SET provider_task_id='fictional-first' WHERE id=$1", [jobId]);
  const page = await read(owner, jobId); await db.query("UPDATE platform_jobs SET provider_task_id='fictional-second' WHERE id=$1", [jobId]);
  const response = await save(owner, jobId, input(page)); assert.equal(errorCode(response), 'JOB_OUTCOME_EVIDENCE_CHANGED'); assert.equal(await reviewCount(owner), 0);
  const next = await read(owner, jobId); assert.equal(next.evidence!.hasProviderTask, page.evidence!.hasProviderTask); assert.notEqual(next.evidence!.version, page.evidence!.version);
});
test('job-lock races recheck evidence and AbortSignal after acquisition rather than saving a stale declaration', { timeout: 10000 }, async () => {
  const owner = await actor(), jobId = await unknown(owner), page = await read(owner, jobId), locker = await db.pool.connect(); let locked = false;
  try {
    await locker.query('BEGIN'); locked = true; await locker.query('SELECT id FROM platform_jobs WHERE id=$1 FOR UPDATE', [jobId]);
    const pending = save(owner, jobId, input(page)); await waitForLock(); await locker.query("UPDATE platform_jobs SET provider_task_id='fictional-late-published-handle' WHERE id=$1", [jobId]); await locker.query('COMMIT'); locked = false;
    assert.equal(errorCode(await pending), 'JOB_OUTCOME_EVIDENCE_CHANGED'); assert.equal(await reviewCount(owner), 0);
    await locker.query('BEGIN'); locked = true; await locker.query('SELECT id FROM platform_jobs WHERE id=$1 FOR UPDATE', [jobId]);
    const abort = new AbortController(), latestBody = input({ ...page, evidence: { ...page.evidence!, version: 'b'.repeat(64) } });
    const rejection = assert.rejects(system.jobOutcomeReviews.save(owner.id, jobId, latestBody, abort.signal), { name: 'AbortError' }); await waitForLock(); abort.abort(); await locker.query('COMMIT'); locked = false; await rejection; assert.equal(await reviewCount(owner), 0);
  } finally { if (locked) await locker.query('ROLLBACK'); locker.release(); }
});
test('GET holds a coherent job/checkpoint snapshot while a worker-side mutation waits', { timeout: 10000 }, async () => {
  const owner = await actor(), jobId = await unknown(owner, 'browser'), original = db.transaction.bind(db); let reached!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); let intercepted = false;
  db.transaction = run => original(client => { const query = client.query.bind(client); const wrapped = Object.create(client); wrapped.query = async (sql: string, values?: unknown[]) => { const result = await query(sql, values); if (!intercepted && sql.includes('platform_jobs') && sql.includes('FOR SHARE')) { intercepted = true; reached(); await gate; } return result; }; return run(wrapped); });
  const mutation = await db.pool.connect(); let locked = false;
  try {
    const reading = read(owner, jobId); await ready;
    await mutation.query('BEGIN'); locked = true; const changing = mutation.query('SELECT id FROM platform_jobs WHERE id=$1 FOR UPDATE', [jobId]); await waitForLock(); release();
    const before = await reading; await changing; await mutation.query('UPDATE platform_browser_checkpoints SET revision=revision+1 WHERE job_id=$1', [jobId]); await mutation.query('COMMIT'); locked = false;
    const after = await read(owner, jobId); assert.equal(after.evidence!.browser!.revision, before.evidence!.browser!.revision + 1); assert.notEqual(before.evidence!.version, after.evidence!.version);
  } finally { release(); db.transaction = original; if (locked) await mutation.query('ROLLBACK'); mutation.release(); }
});
test('bounded newest history and saved request identity survive API restart without external calls or unsafe strings', async () => {
  const owner = await actor(), jobId = await unknown(owner), calls = [executions, mcpCalls];
  await db.query("UPDATE platform_jobs SET error_message='fictional-private-prompt-url-and-error',provider_task_id='fictional-private-handle' WHERE id=$1", [jobId]);
  for (let revision = 0; revision < 21; ++revision) { const response = await save(owner, jobId, input(await read(owner, jobId), { note: `Fictional note ${revision}` })); assert.equal(response.statusCode, 200, response.body); }
  const page = await read(owner, jobId); assert.equal(page.latestRevision, 21); assert.equal(page.records.length, 20); assert.equal(page.hasMore, true); assert.deepEqual(page.records.map(record => record.revision), Array.from({ length: 20 }, (_, i) => 21 - i));
  assert(Buffer.byteLength(JSON.stringify(page), 'utf8') <= JOB_OUTCOME_REVIEW_MAX_RESPONSE_BYTES); assert.doesNotMatch(JSON.stringify(page), /fictional-private/);
  await system.app.close(); await start(); assert.deepEqual(await read(owner, jobId), page); assert.deepEqual([executions, mcpCalls], calls);
});
test('a user-reported effect cannot satisfy goal-plan dependencies or create a successful execution receipt', async () => {
  const owner = await actor(), conv = await exchange(owner, 'POST', '/conversations', { title: 'Fictional review plan', mode: 'agent' }); assert.equal(conv.statusCode, 201, conv.body);
  const draft = await system.goalPlans.create(owner.id, conv.json().conversation.id, { title: 'Fictional blocked plan', goal: 'Inspect fictional outputs', steps: [
    { kind: 'task', title: 'Fictional image', task: { kind: 'image', provider: 'synthetic', prompt: 'Fictional image' } },
    { kind: 'agent_turn', title: 'Fictional analysis', provider: 'synthetic', instruction: 'Analyze only exact prior receipts' },
  ] });
  const confirmed = await system.goalPlans.confirm(owner.id, draft.id, { revision: draft.revision }), continued = await system.goalPlans.continue(owner.id, confirmed.id, { revision: confirmed.revision, stepIndex: 0 });
  const jobId = continued.plan.steps[0].job!.id, approval = continued.plan.steps[0].approval!; await system.jobs.decide(owner.id, approval.id, 'approved'); await processJob(system.jobs, jobId, 1);
  const before = await executionSnapshot(owner), response = await save(owner, jobId, input(await read(owner, jobId), { outcome: 'observed_effect' })); assert.equal(response.statusCode, 200, response.body);
  const plan = await system.goalPlans.get(owner.id, confirmed.id); assert.equal(plan.steps[0].state, 'uncertain'); assert.equal(plan.steps[0].receipt, undefined); assert.equal(plan.steps[1].ready, false); assert.deepEqual(await executionSnapshot(owner), before);
});
