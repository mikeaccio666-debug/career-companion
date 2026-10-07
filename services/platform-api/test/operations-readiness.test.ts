import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import type { Database } from '../src/database.ts';
import { OperationsReadiness, probeRedisReadOnly, requiredOperationsSchema } from '../src/operations-readiness.ts';

const config = {queueName: 'fictional-queue', codeVersion: 'fictional-build', redisUrl: 'redis://127.0.0.1:1/0'};
const schema = {migrations: ['001_fictional.sql'], relations: ['platform_migrations', 'platform_worker_heartbeats'], columns: {platform_worker_heartbeats: ['reported_at']}};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return {promise, resolve}; }
function fixture(options: {missingSchema?: boolean; missingMigration?: boolean; missingColumn?: boolean; worker?: boolean; gate?: Promise<void>; unavailable?: boolean} = {}) {
  let acquisitions = 0; const queries: string[] = [];
  const db = {pool: {totalCount: 1, idleCount: 1, waitingCount: 0, options: {max: 3}}, idleErrorCount: 0,
    async withBoundedTransaction(run: any, limits: any) {
      ++acquisitions; assert.equal(limits.readOnly, true); await options.gate;
      if (options.unavailable) throw new Error('Fictional private connection failure.');
      return run({async query(sql: string, args?: unknown[]) {
        queries.push(sql);
        if (sql.includes('c.relname FROM pg_class')) return {rowCount: options.missingSchema ? 1 : 2, rows: []};
        if (sql.includes('SELECT name FROM platform_migrations')) return {rowCount: options.missingMigration ? 0 : 1, rows: []};
        if (sql.includes('pg_attribute')) return {rows: options.missingColumn ? [] : [{relname: 'platform_worker_heartbeats', attname: 'reported_at'}]};
        if (sql.includes('SELECT EXISTS')) { assert.deepEqual(args, [config.queueName, config.codeVersion]); assert(sql.includes('reported_at<=clock_timestamp()')); assert(sql.includes('NOT worker_paused')); return {rows: [{ready: options.worker === true}]}; }
        if (sql.includes('FROM platform_job_outbox')) { assert(sql.includes("j.status='queued' AND j.generation=o.generation")); return {rows: [{undelivered: 1, dispatched_still_queued: 0, oldest_undelivered_seconds: 2, oldest_dispatched_queued_seconds: 0}]}; }
        assert.fail('Unexpected query.');
      }});
    }} as unknown as Database;
  return {db, queries, acquisitions: () => acquisitions};
}
test('data readiness remains available when execution is degraded; public result has no operator or tenant details', async () => {
  const f = fixture({worker: true}), readiness = new OperationsReadiness(f.db, config, true, {schema: async () => schema, redis: async () => ({ok: false})});
  const ready = await readiness.readiness(); assert.equal(ready.ok, true); assert.equal(ready.execution, 'degraded');
  assert.deepEqual(Object.keys(ready).sort(), ['checkedAt', 'database', 'execution', 'ok']); assert.equal((await readiness.executionReadiness()).ok, false);
  assert.deepEqual(await readiness.health(), {ok: true, database: 'connected', queue: 'configured'}); await readiness.close();
});
test('missing ledger, relation, column or database fail data readiness closed; disabled queue never probes Redis', async () => {
  for (const options of [{missingSchema: true}, {missingMigration: true}, {missingColumn: true}, {unavailable: true}]) {
    const f = fixture(options), readiness = new OperationsReadiness(f.db, config, false, {schema: async () => schema, redis: async () => assert.fail('Disabled queue must not open Redis.')});
    const result = await readiness.readiness(); assert.equal(result.ok, false); assert.equal(result.database, 'unavailable'); assert.equal(result.execution, 'disabled'); await readiness.close();
  }
});
test('only matching fresh running/unpaused worker plus independent Redis yields execution ready', async () => {
  for (const worker of [true, false]) {
    const f = fixture({worker}), readiness = new OperationsReadiness(f.db, config, true, {schema: async () => schema, redis: async () => ({ok: true, globalPaused: false})});
    assert.equal((await readiness.executionReadiness()).ok, worker); assert.equal((await readiness.readiness()).ok, true); await readiness.close();
  }
});
test('sampling is single-flight, cached briefly, and close waits for its owned cleanup rather than starting another probe', async () => {
  const gate = deferred<void>(), f = fixture({gate: gate.promise, worker: true}); let redisCalls = 0, now = 1000, closed = false;
  const readiness = new OperationsReadiness(f.db, config, true, {schema: async () => schema, now: () => now, monotonicNow: () => now, redis: async () => { ++redisCalls; await gate.promise; return {ok: true, globalPaused: false}; }});
  const requests = Array.from({length: 30}, () => readiness.readiness()); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.acquisitions(), 1); assert.equal(redisCalls, 1);
  gate.resolve(); const values = await Promise.all(requests); assert(values.every(value => value.execution === 'ready'));
  await readiness.readiness(); assert.equal(f.acquisitions(), 1); now += 1001; await readiness.readiness(); assert.equal(f.acquisitions(), 2);
  await readiness.close(); closed = true; assert(closed); assert.equal((await readiness.readiness()).ok, false); assert.equal(f.acquisitions(), 2);
  const closingGate = deferred<void>(), pending = fixture({gate: closingGate.promise}), closing = new OperationsReadiness(pending.db, config, false, {schema: async () => schema});
  void closing.readiness(); let stopped = false; const stop = closing.close().then(() => { stopped = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  closingGate.resolve(); await stop; assert.equal(stopped, true);
});
test('wall-clock rollback cannot prolong a cached readiness observation', async () => {
  const f = fixture({worker: true}); let wall = 1_000_000, monotonic = 0;
  const readiness = new OperationsReadiness(f.db, config, false, {schema: async () => schema, now: () => wall, monotonicNow: () => monotonic});
  const before = await readiness.readiness(); wall -= 600_000; monotonic = 999; await readiness.readiness(); assert.equal(f.acquisitions(), 1);
  monotonic = 1001; const after = await readiness.readiness(); assert.equal(f.acquisitions(), 2); assert.notEqual(after.checkedAt, before.checkedAt); await readiness.close();
});
test('operator diagnostics retain bounded counts only and execute read-only current-generation outbox queries', async () => {
  const f = fixture({worker: true}), readiness = new OperationsReadiness(f.db, config, true, {schema: async () => schema, redis: async () => ({ok: true, globalPaused: false, counts: {waiting: 1, active: 0, delayed: 0, prioritized: 0, paused: 0}})});
  const result = await readiness.diagnostics(); assert.equal(result.scope, 'read_only_no_dispatch_no_recovery_no_migration'); assert.equal(result.reportIsNotExecutionProof, true);
  assert.deepEqual(result.outbox, {undelivered: 1, dispatched_still_queued: 0, oldest_undelivered_seconds: 2, oldest_dispatched_queued_seconds: 0});
  assert.equal(f.queries.some(sql => /INSERT|UPDATE|DELETE|dispatch|recover/i.test(sql.replaceAll('dispatched', 'sent').replaceAll('undelivered', 'waiting').replaceAll('oldest_dispatched', 'oldest_sent')) && !sql.includes('SELECT')), false);
  await readiness.close();
});
test('global queue pause is execution degradation even for an empty queue and fresh local worker', async () => {
  const f = fixture({worker: true}), readiness = new OperationsReadiness(f.db, config, true, {schema: async () => schema, redis: async () => ({ok: true, globalPaused: true, counts: {waiting: 0, active: 0, delayed: 0, prioritized: 0, paused: 0}})});
  assert.equal((await readiness.readiness()).ok, true); assert.equal((await readiness.executionReadiness()).ok, false); assert.equal((await readiness.diagnostics()).redis.globalPaused, true); await readiness.close();
});
test('required schema comes from all shipped migration files and includes worker heartbeat and binding columns', async () => {
  const required = await requiredOperationsSchema(); assert(required.migrations.some(name => name.startsWith('020'))); assert(required.relations.includes('platform_goal_plan_proposals'));
  assert.deepEqual(required.columns.platform_goal_plan_steps, ['plan_id', 'job_generation', 'resolved_task', 'input_sources']);
});
test('blackholed Redis protocol is bounded and its actual probe socket ends, with no queue metadata writes', async () => {
  const sockets = new Set<Socket>(); let accepted = 0, closed = 0; const bytes: Buffer[] = [];
  const server = createServer(socket => { ++accepted; sockets.add(socket); socket.on('data', chunk => bytes.push(chunk)); socket.on('close', () => { sockets.delete(socket); ++closed; }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object');
  try {
    const started = Date.now(); const result = await probeRedisReadOnly({...config, redisUrl: `redis://127.0.0.1:${address.port}/0`}, {timeoutMs: 80});
    assert.equal(result.ok, false); assert(Date.now() - started < 1500); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(accepted, 1); assert.equal(closed, 1); assert.equal(sockets.size, 0);
    assert.equal(/HSET|EVAL|LPUSH|ZADD|SET\r\n/i.test(Buffer.concat(bytes).toString('utf8')), false);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
