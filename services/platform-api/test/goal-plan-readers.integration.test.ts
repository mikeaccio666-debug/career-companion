import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { GoalPlanStepInput } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { GoalPlanReaders, GOAL_PLAN_READER_MAX_BYTES } from '../src/goal-plan-readers.ts';
import { goalPlanHash } from '../src/goal-plan-core.ts';
import type { AssistantTurnOrigin } from '../src/assistant-turn-origin.ts';

// Seeded storage fixtures only: no HTTP/model/job executor, queue, browser, mail or provider network.
const base = readConfig(), schema = `goal_readers_${randomUUID().replaceAll('-','')}`, admin = new Database(base.databaseUrl);
const databaseUrl = new URL(base.databaseUrl); databaseUrl.searchParams.set('options',`-c search_path=${schema}`); databaseUrl.searchParams.set('application_name',schema);
const db = new Database(databaseUrl.toString()), readers = new GoalPlanReaders(db);
before(async () => { assert(['localhost','127.0.0.1','[::1]'].includes(new URL(base.databaseUrl).hostname),'Only a loopback isolated QA database is permitted.'); await admin.query(`CREATE SCHEMA ${schema}`); await db.migrate(); });
after(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); });
async function actor() {
  const userId = randomUUID(), conversationId = randomUUID();
  await db.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,`${randomUUID()}@example.invalid`,'Fictional reader actor','fictional-unusable-password-hash']);
  await db.query("INSERT INTO platform_conversations(id,user_id,title,mode) VALUES($1,$2,'Fictional reader conversation','agent')",[conversationId,userId]);
  return { userId, conversationId };
}
async function live(userId: string, conversationId: string): Promise<AssistantTurnOrigin> {
  const messageId = randomUUID();
  await db.query("INSERT INTO platform_messages(id,conversation_id,role,status,lease_until) VALUES($1,$2,'assistant','streaming',clock_timestamp()+interval '120 seconds')",[messageId,conversationId]);
  await db.query("INSERT INTO platform_runtime_leases(id,user_id,kind,expires_at) VALUES($1,$2,'chat',clock_timestamp()+interval '120 seconds')",[messageId,userId]);
  return { messageId, conversationId };
}
const task = (kind: any = 'image'): GoalPlanStepInput => ({ kind:'task',title:'Fictional task',task:{kind,provider:'unconfigured',prompt:'Fictional bounded task goal',options:{privateMarker:'Synthetic never-projected option',url:'https://private.example.invalid'}} });
async function plan(userId: string, conversationId: string, steps: GoalPlanStepInput[] = [task()], goal = 'Fictional saved goal') {
  const planId = randomUUID(), title = 'Fictional saved plan';
  await db.transaction(async client => {
    await client.query('INSERT INTO platform_goal_plans(id,user_id,conversation_id) VALUES($1,$2,$3)',[planId,userId,conversationId]);
    await client.query('INSERT INTO platform_goal_plan_revisions(plan_id,revision,title,goal,definition_hash) VALUES($1,1,$2,$3,$4)',[planId,title,goal,goalPlanHash({title,goal,steps})]);
    for (const [index,input] of steps.entries()) await client.query('INSERT INTO platform_goal_plan_steps(plan_id,revision,step_index,input,input_hash) VALUES($1,1,$2,$3,$4)',[planId,index,JSON.stringify(input),goalPlanHash(input)]);
  });
  return planId;
}
async function job(userId: string, planId: string, index: number, kind = 'image', status = 'succeeded', artifactCount = 1) {
  const id = randomUUID(), artifactIds = Array.from({length:artifactCount},() => randomUUID());
  await db.query('INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,$3,$4,$5,$6)',[id,userId,kind,'unconfigured','Fictional private task prompt',status]);
  for (const artifactId of artifactIds) await db.query('INSERT INTO platform_artifacts(id,user_id,job_id,kind,mime,external_url,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',[artifactId,userId,id,kind,'application/json','https://private.example.invalid',{raw:'Synthetic raw output must not be projected'}]);
  await db.query('UPDATE platform_goal_plan_steps SET job_id=$1,job_generation=1,bound_at=now(),receipt=$2 WHERE plan_id=$3 AND revision=1 AND step_index=$4',[id,status==='succeeded'?JSON.stringify({kind:'task',jobId:id,generation:1,artifactIds,completedAt:new Date().toISOString()}):null,planId,index]);
  return { id, artifactIds };
}
async function unchangedSnapshot() {
  const names = ['platform_goal_plans','platform_goal_plan_revisions','platform_goal_plan_steps','platform_jobs','platform_job_attempts','platform_artifacts','platform_approvals','platform_job_outbox','platform_messages','platform_runtime_leases'];
  const result: Record<string,unknown> = {};
  for (const name of names) result[name] = (await db.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS digest FROM ${name} t`)).rows[0];
  return result;
}
async function lock(sql: string, values: unknown[]): Promise<PoolClient> {
  const client = await db.pool.connect(); await client.query('BEGIN'); await client.query(sql,values); return client;
}
async function waitForLock(sqlFragment: string) {
  for (let i = 0; i < 100; i++) {
    const row = (await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2) AS waiting",[schema,`%${sqlFragment}%`])).rows[0];
    if (row.waiting) return;
    await new Promise<void>(resolve => setTimeout(resolve,10));
  }
  assert.fail('The isolated reader did not reach its expected lock gate.');
}

test('plan list is conversation-owned recent-ten metadata and readonly even when more plans exist', async () => {
  const a = await actor(), b = await actor(), origin = await live(a.userId,a.conversationId), otherConversation = randomUUID();
  await db.query("INSERT INTO platform_conversations(id,user_id,title,mode) VALUES($1,$2,'Fictional same-owner other conversation','agent')",[otherConversation,a.userId]);
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = await plan(a.userId,a.conversationId); ids.push(id);
    await db.query("UPDATE platform_goal_plans SET created_at='2026-01-01 00:00:00+00'::timestamptz+($2::int*interval '1 microsecond') WHERE id=$1",[id,i]);
  }
  await plan(b.userId,b.conversationId); await plan(a.userId,otherConversation);
  const before = await unchangedSnapshot(), result = await readers.list(a.userId,origin,{});
  assert.equal(result.limit,10); assert(result.hasMore); assert.deepEqual(result.plans.map(item => item.planId),ids.toReversed().slice(0,10));
  assert(result.plans.every(item => item.conversationId === origin.conversationId)); assert.equal(result.executionAuthorized,false); assert.equal(result.executionReadiness,'not_checked');
  assert.equal(Object.hasOwn(result.plans[0],'steps'),false); assert.equal(Object.hasOwn(result.plans[0],'goal'),false); assert.deepEqual(await unchangedSnapshot(),before);
});
test('read explicit revision bounds complete large definitions and only selected template text, never options or raw artifacts', async () => {
  const a = await actor(), b = await actor(), origin = await live(a.userId,a.conversationId);
  const steps = Array.from({length:8},() => ({...task(),task:{...(task() as any).task,prompt:'😀中\\"\n'.repeat(2000)}} as GoalPlanStepInput));
  const id = await plan(a.userId,a.conversationId,steps,'😀中'.repeat(3000)), before = await unchangedSnapshot();
  const snapshot = await readers.read(a.userId,origin,{planId:id,revision:1,stepIndex:7}), encoded = JSON.stringify(snapshot);
  assert(Buffer.byteLength(encoded,'utf8') <= GOAL_PLAN_READER_MAX_BYTES); assert.equal(snapshot.steps.length,8); assert(snapshot.goal.truncated); assert(snapshot.selectedStep!.inputText.truncated);
  assert.equal(snapshot.selectedStep!.inputText.totalCharacters,Array.from((steps[7] as any).task.prompt).length);
  for (const denied of ['private.example.invalid','never-projected option','raw output','options','approval']) assert(!encoded.includes(denied),denied);
  assert.deepEqual(await unchangedSnapshot(),before);
  await assert.rejects(readers.read(a.userId,origin,{planId:id,revision:2}),{code:'GOAL_PLAN_REVISION_CONFLICT'});
  const other = await plan(b.userId,b.conversationId); await assert.rejects(readers.read(a.userId,origin,{planId:other,revision:1}),{code:'NOT_FOUND'});
  const another = randomUUID(); await db.query("INSERT INTO platform_conversations(id,user_id,title,mode) VALUES($1,$2,'Fictional other conversation','agent')",[another,a.userId]);
  const elsewhere = await plan(a.userId,another); await assert.rejects(readers.read(a.userId,origin,{planId:elsewhere,revision:1}),{code:'NOT_FOUND'});
  await assert.rejects(readers.read(a.userId,origin,{planId:id,revision:1,stepIndex:0,messageId:origin.messageId}),{code:'INVALID_INPUT'});
  const single = await plan(a.userId,a.conversationId); await assert.rejects(readers.read(a.userId,origin,{planId:single,revision:1,stepIndex:7}),{code:'INVALID_INPUT'});
  // Only fixture additions changed storage; successful reads themselves were covered by the initial snapshot.
  assert.deepEqual(await readers.read(a.userId,origin,{planId:id,revision:1,stepIndex:7}),snapshot);
  assert.equal(before.platform_job_outbox && (before.platform_job_outbox as any).count,0);
});
test('both message and runtime DB-clock leases plus exact assistant owner/conversation are required', async () => {
  for (const mutation of ['message_expired','runtime_expired','complete','cancelled','runtime_deleted']) {
    const a = await actor(), origin = await live(a.userId,a.conversationId), id = await plan(a.userId,a.conversationId);
    if (mutation === 'message_expired') await db.query("UPDATE platform_messages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[origin.messageId]);
    if (mutation === 'runtime_expired') await db.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[origin.messageId]);
    if (mutation === 'complete' || mutation === 'cancelled') await db.query('UPDATE platform_messages SET status=$2 WHERE id=$1',[origin.messageId,mutation]);
    if (mutation === 'runtime_deleted') await db.query('DELETE FROM platform_runtime_leases WHERE id=$1',[origin.messageId]);
    await assert.rejects(readers.list(a.userId,origin,{}),{code:'ASSISTANT_TURN_INACTIVE'});
    await assert.rejects(readers.read(a.userId,origin,{planId:id,revision:1}),{code:'ASSISTANT_TURN_INACTIVE'});
  }
  const a = await actor(), b = await actor(), origin = await live(a.userId,a.conversationId);
  await assert.rejects(readers.list(b.userId,origin,{}),{code:'ASSISTANT_TURN_INACTIVE'});
  await assert.rejects(readers.list(a.userId,{...origin,conversationId:b.conversationId},{}),{code:'ASSISTANT_TURN_INACTIVE'});
});
test('waiting for a plan lock rechecks both clocks before returning metadata or a revision error',{timeout:15_000},async () => {
  for (const table of ['platform_messages','platform_runtime_leases']) {
    const a = await actor(), origin = await live(a.userId,a.conversationId), id = await plan(a.userId,a.conversationId);
    const blocker = await lock('SELECT id FROM platform_goal_plans WHERE id=$1 FOR UPDATE',[id]);
    let pending: Promise<unknown> | undefined;
    try {
      pending = readers.read(a.userId,origin,{planId:id,revision:2}); const rejection = assert.rejects(pending,{code:'ASSISTANT_TURN_INACTIVE'});
      await waitForLock('FOR SHARE OF p');
      await db.query(table === 'platform_messages' ? "UPDATE platform_messages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1" : "UPDATE platform_runtime_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[origin.messageId]);
      await blocker.query('COMMIT'); await rejection;
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending?.catch(() => undefined); }
  }
});
test('cancellation while waiting for a source-job lock publishes nothing and leaves all execution state unchanged',{timeout:10_000},async () => {
  const a = await actor(), origin = await live(a.userId,a.conversationId), id = await plan(a.userId,a.conversationId), bound = await job(a.userId,id,0,'image','uncertain');
  const before = await unchangedSnapshot(), blocker = await lock('SELECT id FROM platform_jobs WHERE id=$1 FOR UPDATE',[bound.id]), abort = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    pending = readers.read(a.userId,origin,{planId:id,revision:1},abort.signal); const rejection = assert.rejects(pending,{name:'AbortError'});
    await waitForLock('FOR SHARE OF j'); abort.abort(); await blocker.query('COMMIT'); await rejection;
    assert.deepEqual(await unchangedSnapshot(),before);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending?.catch(() => undefined); }
});
test('reader holds conversation before plan so concurrent conversation deletion cannot form an inverse lock cycle',{timeout:10_000},async () => {
  const a = await actor(), origin = await live(a.userId,a.conversationId), id = await plan(a.userId,a.conversationId), bound = await job(a.userId,id,0,'image','uncertain');
  const blocker = await lock('SELECT id FROM platform_jobs WHERE id=$1 FOR UPDATE',[bound.id]);
  let reading: Promise<unknown> | undefined, deleting: Promise<unknown> | undefined;
  try {
    reading = readers.read(a.userId,origin,{planId:id,revision:1});
    // The old plan -> conversation order would let DELETE hold conversation and wait for this plan.
    await waitForLock('FOR SHARE OF j');
    deleting = db.query('DELETE FROM platform_conversations WHERE id=$1 AND user_id=$2',[a.conversationId,a.userId]);
    await waitForLock('DELETE FROM platform_conversations');
    await blocker.query('COMMIT');
    const [snapshot] = await Promise.all([reading,deleting]); assert.equal((snapshot as any).steps[0].state,'uncertain');
    assert.equal((await db.query('SELECT id FROM platform_goal_plans WHERE id=$1',[id])).rowCount,0);
    await assert.rejects(readers.list(a.userId,origin,{}),{code:'ASSISTANT_TURN_INACTIVE'});
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await reading?.catch(() => undefined); await deleting?.catch(() => undefined); }
});
test('saved exact receipt order/count never treats newer attempts, omitted files or deleted bindings as current success', async () => {
  const a = await actor(), origin = await live(a.userId,a.conversationId), id = await plan(a.userId,a.conversationId,[task('mcp'),task('browser')]);
  const first = await job(a.userId,id,0,'mcp','succeeded',12), second = await job(a.userId,id,1,'browser','uncertain');
  const before = await unchangedSnapshot(), saved = await readers.read(a.userId,origin,{planId:id,revision:1});
  assert.equal(saved.steps[0].state,'succeeded'); assert.equal(saved.steps[1].state,'uncertain'); assert.equal(saved.allStepsHaveSuccessReceipts,false);
  assert.deepEqual(saved.steps[0].receipt!.artifactIds,first.artifactIds.slice(0,8)); assert.equal(saved.steps[0].receipt!.artifactCount,12); assert.equal(saved.steps[0].receipt!.artifactsTruncated,true);
  assert.deepEqual(await unchangedSnapshot(),before);
  await db.query('UPDATE platform_jobs SET generation=2 WHERE id=$1',[first.id]);
  const changed = await readers.read(a.userId,origin,{planId:id,revision:1}); assert.equal(changed.steps[0].state,'blocked'); assert.equal(changed.steps[0].generation,1); assert.equal(changed.steps[0].currentGeneration,2);
  await db.query('DELETE FROM platform_jobs WHERE id=$1',[second.id]);
  const missing = await readers.read(a.userId,origin,{planId:id,revision:1}); assert.equal(missing.steps[1].state,'blocked'); assert.equal(missing.steps[1].generation,1); assert.equal(missing.steps[1].jobId,undefined);
  assert(!JSON.stringify(saved).includes('private.example.invalid')); assert(!JSON.stringify(saved).includes('raw output'));
});
