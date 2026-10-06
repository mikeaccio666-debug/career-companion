import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { startWorkerHeartbeat, type HeartbeatWorker } from '../src/worker-heartbeat.ts';

// Only an isolated PostgreSQL schema is used. Redis, tasks, models and email are never invoked.
const config = readConfig(), schema = `worker_heartbeat_${randomUUID().replaceAll('-', '')}`;
const admin = new Database(config.databaseUrl, { max: 1, connectionTimeoutMillis: 1000 });
const connection = new URL(config.databaseUrl); connection.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(connection.toString(), { max: 2, connectionTimeoutMillis: 1000 });
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await db.migrate(); });
after(async () => { await db.close(); try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.close(); } });
async function flush() { for (let n = 0; n < 20; ++n) await Promise.resolve(); }
function fixture(instanceId: string = randomUUID(), queueName = 'fictional-worker-queue') {
  const primary = { status: 'ready' }, blocking = { status: 'ready' }, state = { running: true, paused: false }, timers = new Map<number, () => void>(), operations: Promise<unknown>[] = []; let serial = 0, warnings = 0;
  const worker: HeartbeatWorker = { client: Promise.resolve(primary), waitUntilReady: () => Promise.resolve(blocking), isRunning: () => state.running, isPaused: () => state.paused };
  const observed = { pool: db.pool, withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options?: { readOnly?: boolean; timeoutMs?: number }): Promise<T> { const operation = db.withBoundedTransaction(run, options); operations.push(operation); return operation; } };
  const handle = startWorkerHeartbeat({ db: observed, worker, queueName, codeVersion: 'fictional-build.1', instanceId }, { setTimer(run) { const id = ++serial; timers.set(id, run); return id; }, clearTimer(id) { timers.delete(id as number); }, warn() { ++warnings; } });
  return { handle, state, primary, blocking, warnings: () => warnings, timers,
    // The product catches rejected writes and reports them as unavailable; observing the raw
    // transaction must wait for settlement without bypassing that lifecycle/error handling.
    async settle() { await Promise.allSettled([operations.at(-1)]); await flush(); },
    async tick() { const first = [...timers][0]; assert.ok(first); timers.delete(first[0]); first[1](); await Promise.allSettled([operations.at(-1)]); await flush(); },
    async read() { return (await db.query('SELECT *,clock_timestamp() AS inspected_at FROM platform_worker_heartbeats WHERE instance_id=$1', [instanceId])).rows[0]; },
  };
}

test('real heartbeat upserts use database time, preserve the first report, and retain only their own instance metadata', async () => {
  const earliest = (await db.query('SELECT clock_timestamp() AS value')).rows[0].value as Date, context = fixture();
  try {
    await context.settle(); const first = await context.read();
    assert.equal(first.process_state, 'starting'); assert.equal(first.queue_name, 'fictional-worker-queue'); assert.equal(first.code_version, 'fictional-build.1'); assert.equal(first.redis_ready, true); assert.equal(first.worker_running, true); assert.equal(first.worker_paused, false);
    assert.ok(first.started_at.getTime() >= earliest.getTime()); assert.ok(first.reported_at.getTime() <= first.inspected_at.getTime()); assert.equal(first.pool_max, 2); assert.ok(first.pool_total >= 1); assert.ok(first.pool_idle <= first.pool_total);
    context.state.paused = true; context.blocking.status = 'reconnecting'; await context.tick(); const second = await context.read();
    assert.equal(second.process_state, 'running'); assert.equal(second.redis_ready, false); assert.equal(second.worker_paused, true); assert.equal(second.started_at.getTime(), first.started_at.getTime()); assert.ok(second.reported_at.getTime() >= first.reported_at.getTime());
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM platform_worker_heartbeats WHERE instance_id=$1', [context.handle.instanceId])).rows[0].count, 1);
  } finally { await context.handle.stop(); }
  const stopped = await context.read(); assert.equal(stopped.process_state, 'stopping'); assert.equal(context.timers.size, 0); assert.equal(context.warnings(), 0);
});

test('a reserved instance cannot overwrite another queue or code version, while a failed write remains unconfirmed', async () => {
  const owner = fixture(); await owner.settle(); await owner.handle.stop(); const original = await owner.read();
  const other = fixture(owner.handle.instanceId, 'fictional-other-queue');
  try { await other.settle(); assert.equal(other.warnings(), 1); } finally { await other.handle.stop(); }
  const current = await owner.read(); assert.equal(other.warnings(), 1);
  assert.deepEqual({ ...current, inspected_at: null }, { ...original, inspected_at: null });
});

test('the migration rejects oversized metadata, impossible pool counters and unsupported process state', async () => {
  const values: unknown[] = [randomUUID(), 'fictional-queue', 'fictional-build', 'running', false, false, true, 1, 0, 0, 2];
  const insert = 'INSERT INTO platform_worker_heartbeats(instance_id,queue_name,code_version,process_state,redis_ready,worker_running,worker_paused,pool_total,pool_idle,pool_waiting,pool_max) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)';
  for (const [index, invalid] of [[1, 'fictional queue'], [1, '.fictional'], [1, 'fictional\n'], [2, '_fictional'], [2, '-fictional'], [2, 'b'.repeat(129)], [3, 'succeeded'], [7, -1], [8, 2], [9, -1], [10, 0]] as const) {
    const changed = [...values]; changed[index] = invalid; await assert.rejects(db.query(insert, changed), (error: any) => error.code === '23514');
  }
  const invalidBudget = [...values]; invalidBudget[7] = 3; await assert.rejects(db.query(insert, invalidBudget), (error: any) => error.code === '23514');
});
