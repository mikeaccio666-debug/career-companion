import { seedFictionalConsent } from './fixtures/student-entry.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RedisConnection } from 'bullmq';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { buildApp } from '../src/app.ts';
import type { TaskQueue } from '../src/jobs.ts';
import { OperationsReadiness, probeRedisReadOnly } from '../src/operations-readiness.ts';
import { connectionFromUrl } from '../src/queue-connection.ts';

const config = readConfig({...process.env,PLATFORM_REQUIRE_INVITE:'1'}), schema = `ops_ready_${randomUUID().replaceAll('-', '')}`, admin = new Database(config.databaseUrl);
const url = new URL(config.databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`); url.searchParams.set('application_name', schema);
const db = new Database(url.toString(), {max: 2, connectionTimeoutMillis: 100});
const queueName = `ops-${randomUUID()}`, build = `build-${randomUUID()}`, instance = randomUUID();
const probeConfig = {...config, queueName, codeVersion: build, databaseUrl: url.toString()};
const forbidden = async (): Promise<never> => { throw new Error('The operations fixture may not invoke a model or execute a task.'); };
const runtime: PlatformProviderRuntime = {capabilities: () => [], async *streamChat() { throw new Error('No model.'); }, executeJob: forbidden, createVoiceSession: forbidden, transcribe: forbidden, speech: forbidden};
const fakeQueue = {start() {}, async close() {}} as unknown as TaskQueue;
before(async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.databaseUrl).hostname));
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.redisUrl).hostname));
  await admin.query(`CREATE SCHEMA ${schema}`);
});
after(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); });
async function fixtureApp(queueEnabled = false) { return buildApp({legalBundle:FICTIONAL_LEGAL,db, config: probeConfig, runtime, enableQueue: false, ...(queueEnabled ? {queue: fakeQueue} : {})}); }
async function heartbeat(patch: {queue?: string; code?: string; age?: string; state?: string; redis?: boolean; running?: boolean; paused?: boolean} = {}) {
  await db.query(`INSERT INTO platform_worker_heartbeats(instance_id,queue_name,code_version,started_at,reported_at,process_state,redis_ready,worker_running,worker_paused,pool_total,pool_idle,pool_waiting,pool_max)
    VALUES($1,$2,$3,clock_timestamp(),clock_timestamp()+$4::interval,$5,$6,$7,$8,1,0,0,2)
    ON CONFLICT(instance_id) DO UPDATE SET queue_name=excluded.queue_name,code_version=excluded.code_version,reported_at=excluded.reported_at,process_state=excluded.process_state,redis_ready=excluded.redis_ready,worker_running=excluded.worker_running,worker_paused=excluded.worker_paused`,
    [instance, patch.queue ?? queueName, patch.code ?? build, patch.age ?? '0 seconds', patch.state ?? 'running', patch.redis ?? true, patch.running ?? true, patch.paused ?? false]);
}
async function redisSetup<T>(run: (client: Awaited<RedisConnection['client']>) => Promise<T>) {
  const connection = new RedisConnection({...connectionFromUrl(config.redisUrl, 'producer'), retryStrategy: () => null}, {skipVersionCheck: true, blocking: false}); connection.on('error', () => {});
  let client: Awaited<RedisConnection['client']> | undefined;
  try { client = await connection.client; return await run(client); }
  finally {
    const ended = client && client.status !== 'end' ? new Promise<void>(resolve => client!.once('end', resolve)) : Promise.resolve();
    await connection.close(true); await ended;
  }
}
async function queryActive(sql: string, expected: boolean) {
  const deadline = Date.now() + 1000;
  do {
    const found = await admin.withBoundedTransaction(async client => (await client.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND query=$2 AND state='active') AS active", [schema, sql])).rows[0].active, {readOnly: true, timeoutMs: 300});
    if (found === expected) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.fail(expected ? 'The isolated probe did not reach its server query.' : 'The isolated probe server query did not terminate.');
}
test('public process liveness survives empty or migration-incomplete data; probes never migrate, and ledger/schema are independently required', async () => {
  let system = await fixtureApp();
  try {
    const live = await system.app.inject('/api/platform/live'); assert.equal(live.statusCode, 200); assert.deepEqual(live.json(), {ok: true});
    const ready = await system.app.inject('/api/platform/ready'); assert.equal(ready.statusCode, 503); assert.equal(ready.json().database, 'unavailable'); assert.equal(ready.headers['cache-control'], 'no-store');
    assert.equal((await system.app.inject('/api/platform/health')).statusCode, 503);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM pg_tables WHERE schemaname=$1', [schema])).rows[0].count, 0);
  } finally { await system.app.close(); }
  await db.migrate(); await seedFictionalActiveLegal(db);
  system = await fixtureApp(); try {
    const ready = await system.app.inject('/api/platform/ready'); assert.equal(ready.statusCode, 200, ready.body); assert.equal(ready.json().execution, 'disabled');
    assert.equal((await system.app.inject('/api/platform/execution-ready')).statusCode, 503);
  } finally { await system.app.close(); }
  const migration = (await db.query('SELECT name FROM platform_migrations WHERE name LIKE $1', ['021%'])).rows[0].name;
  await db.query('DELETE FROM platform_migrations WHERE name=$1', [migration]);
  const missing = new OperationsReadiness(db, probeConfig, false);
  try { assert.equal((await missing.readiness()).ok, false); assert.equal((await missing.diagnostics()).dataReason, 'migrations_missing'); }
  finally { await missing.close(); await db.query('INSERT INTO platform_migrations(name) VALUES($1)', [migration]); }
  await db.query('ALTER TABLE platform_goal_plan_steps RENAME COLUMN input_sources TO fictional_missing_column');
  const badSchema = new OperationsReadiness(db, probeConfig, false);
  try { assert.equal((await badSchema.readiness()).ok, false); assert.equal((await badSchema.diagnostics()).dataReason, 'schema_missing'); }
  finally { await badSchema.close(); await db.query('ALTER TABLE platform_goal_plan_steps RENAME COLUMN fictional_missing_column TO input_sources'); }
});
test('fresh worker reports require exact queue/build, valid DB-clock age, Redis, running and unpaused state', async () => {
  for (const patch of [{queue: 'other-fictional-queue'}, {code: 'other-build'}, {age: '-31 seconds'}, {age: '5 seconds'}, {state: 'starting'}, {state: 'stopping'}, {redis: false}, {running: false}, {paused: true}]) {
    await heartbeat(patch); const readiness = new OperationsReadiness(db, probeConfig, true);
    try { assert.equal((await readiness.readiness()).ok, true); assert.equal((await readiness.executionReadiness()).ok, false); }
    finally { await readiness.close(); }
  }
  await heartbeat(); const system = await fixtureApp(true);
  try {
    const response = await system.app.inject('/api/platform/execution-ready'); assert.equal(response.statusCode, 200, response.body);
    const value = response.json(); assert.deepEqual(Object.keys(value).sort(), ['checkedAt', 'database', 'execution', 'ok']);
    assert.equal(JSON.stringify(value).includes(queueName), false); assert.equal(JSON.stringify(value).includes(instance), false); assert.equal(JSON.stringify(value).includes(build), false);
  } finally { await system.app.close(); }
});
test('an empty globally-paused Redis queue degrades execution, and probing never creates BullMQ meta or job keys', async () => {
  await heartbeat(); const key = `bull:${queueName}:meta`;
  await redisSetup(async client => { assert.equal(await client.hget(key, 'paused'), null); });
  const initial = await probeRedisReadOnly(probeConfig, {counts: true}); assert.equal(initial.ok, true); assert.equal(initial.globalPaused, false); assert.equal(initial.counts!.paused, 0);
  await redisSetup(async client => { assert.deepEqual(await client.hgetall(key), {}); await client.hset(key, {paused: '1'}); });
  try {
    const paused = await probeRedisReadOnly(probeConfig, {counts: true}); assert.equal(paused.globalPaused, true); assert.equal(paused.counts!.paused, 0);
    const readiness = new OperationsReadiness(db, probeConfig, true);
    try { assert.equal((await readiness.readiness()).ok, true); assert.equal((await readiness.executionReadiness()).ok, false); } finally { await readiness.close(); }
    await redisSetup(async client => { assert.deepEqual(await client.hgetall(key), {paused: '1'}); await client.hdel(key, 'paused'); });
    const unpaused = await probeRedisReadOnly(probeConfig); assert.equal(unpaused.globalPaused, false);
  } finally { await redisSetup(client => client.del(key)); }
});
test('native saturated-pool acquisition removes its waiter without destroying a client held by another operation', async () => {
  const pool = new Database(url.toString(), {max: 1, connectionTimeoutMillis: 100}), held = await pool.pool.connect();
  try {
    await assert.rejects(pool.withBoundedTransaction(async () => assert.fail('The saturated pool must not acquire.')));
    assert.equal(pool.pool.waitingCount, 0); assert.equal(pool.pool.totalCount, 1); assert.equal((await held.query('SELECT 7 AS alive')).rows[0].alive, 7);
  } finally { held.release(); await pool.close(); }
});
test('query/lock deadlines free the actual owned backend and no late callback can enqueue another query', async () => {
  const pool = new Database(url.toString(), {max: 1, connectionTimeoutMillis: 100}); let captured: any, proceed!: () => void;
  const gate = new Promise<void>(resolve => { proceed = resolve; });
  try {
    await assert.rejects(pool.withBoundedTransaction(async client => { captured = client; await gate; await client.query('SELECT pg_sleep(10)'); }, {readOnly: true, timeoutMs: 30}));
    assert.equal(pool.pool.totalCount, 0); assert.equal(pool.pool.waitingCount, 0); proceed(); await new Promise(resolve => setImmediate(resolve)); await assert.rejects(captured.query('SELECT 1'));
    const sleeping = pool.withBoundedTransaction(client => client.query('SELECT pg_sleep(10)'), {readOnly: true, timeoutMs: 250}); void sleeping.catch(() => {});
    await queryActive('SELECT pg_sleep(10)', true); await assert.rejects(sleeping); await queryActive('SELECT pg_sleep(10)', false);
    assert.equal(pool.pool.waitingCount, 0); assert.equal((await pool.query('SELECT 8 AS recovered')).rows[0].recovered, 8);
    const blocker = await admin.pool.connect(); await blocker.query('BEGIN'); await blocker.query(`LOCK TABLE ${schema}.platform_migrations IN ACCESS EXCLUSIVE MODE`);
    try {
      const locked = pool.withBoundedTransaction(client => client.query('SELECT name FROM platform_migrations'), {readOnly: true, timeoutMs: 250}); void locked.catch(() => {});
      await queryActive('SELECT name FROM platform_migrations', true); await assert.rejects(locked); await queryActive('SELECT name FROM platform_migrations', false); assert.equal(pool.pool.waitingCount, 0);
    }
    finally { await blocker.query('ROLLBACK'); blocker.release(); }
    assert.equal((await pool.query('SELECT 9 AS recovered')).rows[0].recovered, 9);
  } finally { proceed(); await pool.close(); }
});
test('operator counts include only queued current-generation outbox rows and never dispatch or alter execution state', async () => {
  const owner = randomUUID(), ids = [randomUUID(), randomUUID(), randomUUID()];
  await db.query("INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,'Fictional operations fixture','not-a-login-hash')", [owner, `${owner}@example.invalid`]); await seedFictionalConsent(db,owner);
  for (let index = 0; index < ids.length; ++index) {
    await db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status,generation) VALUES($1,$2,'image','fictional','Never executed',$3,$4)", [ids[index], owner, index === 2 ? 'cancelled' : 'queued', index === 0 ? 2 : 1]);
    await db.query("INSERT INTO platform_job_outbox(job_id,generation,created_at,dispatched_at) VALUES($1,$2,clock_timestamp()-interval '5 seconds',$3)", [ids[index], index === 0 ? 2 : 1, index === 1 ? new Date() : null]);
  }
  await db.query('INSERT INTO platform_job_outbox(job_id,generation) VALUES($1,1)', [ids[0]]);
  async function snapshot() { return (await db.query("SELECT (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM platform_jobs j WHERE user_id=$1) AS jobs,(SELECT jsonb_agg(to_jsonb(o) ORDER BY job_id,generation) FROM platform_job_outbox o WHERE job_id=ANY($2::uuid[])) AS outbox,(SELECT count(*)::int FROM platform_job_attempts WHERE job_id=ANY($2::uuid[])) AS attempts", [owner, ids])).rows[0]; }
  const before = await snapshot(), readiness = new OperationsReadiness(db, probeConfig, true);
  try {
    const result = await readiness.diagnostics(), counts = result.outbox as {undelivered: number; dispatched_still_queued: number; oldest_undelivered_seconds: number};
    assert.equal(counts.undelivered, 1); assert.equal(counts.dispatched_still_queued, 1); assert(counts.oldest_undelivered_seconds >= 5);
    assert.equal(result.reportIsNotExecutionProof, true); assert.deepEqual(await snapshot(), before); assert.equal(before.attempts, 0);
  } finally { await readiness.close(); }
});
