import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '../src/database.ts';
import { startWorkerHeartbeat, WORKER_HEARTBEAT_INTERVAL_MS, type HeartbeatWorker } from '../src/worker-heartbeat.ts';

const instanceId = '41000000-0000-4000-8000-000000000001';
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let n = 0; n < 30; ++n) await Promise.resolve(); }
function clock() {
  let time = 0, next = 0; const timers = new Map<number, { time: number; run: () => void }>();
  return { setTimer(run: () => void, delay: number) { const key = ++next; timers.set(key, { time: time + delay, run }); return key; }, clearTimer(key: unknown) { timers.delete(key as number); }, count: () => timers.size,
    async advance(delay: number) { const end = time + delay; while (true) { const first = [...timers].filter(([, item]) => item.time <= end).sort((a, b) => a[1].time - b[1].time)[0]; if (!first) break; time = first[1].time; timers.delete(first[0]); first[1].run(); await flush(); } time = end; await flush(); } };
}
function harness(options: { acquire?: (attempt: number) => Promise<void>; query?: (attempt: number) => Promise<void>; worker?: HeartbeatWorker; rowCount?: number } = {}) {
  const timer = clock(), primary = { status: 'ready' }, blocking = { status: 'ready' }, state = { running: true, paused: false }, reports: unknown[][] = [], deadlines: number[] = []; let attempts = 0, warnings = 0, primaryReads = 0, blockingReads = 0;
  const pool = { totalCount: 1, idleCount: 0, waitingCount: 0, options: { max: 2 } };
  const worker: HeartbeatWorker = options.worker ?? { get client() { ++primaryReads; return Promise.resolve(primary); }, waitUntilReady() { ++blockingReads; return Promise.resolve(blocking); }, isRunning: () => state.running, isPaused: () => state.paused };
  const db = { pool, async withBoundedTransaction<T>(run: (client: any) => Promise<T>, operation: { timeoutMs: number }) {
    const attempt = ++attempts; deadlines.push(operation.timeoutMs); await options.acquire?.(attempt);
    return run({ async query(text: string, values: unknown[]) { assert.match(text, /INSERT INTO platform_worker_heartbeats/); assert.doesNotMatch(text, /platform_jobs|platform_job_attempts|platform_job_outbox|platform_artifacts/); reports.push(values); await options.query?.(attempt); return { rowCount: options.rowCount ?? 1 }; } });
  } } as unknown as Pick<Database, 'pool' | 'withBoundedTransaction'>;
  const start = (overrides: Partial<Parameters<typeof startWorkerHeartbeat>[0]> = {}) => startWorkerHeartbeat({ db, worker, queueName: 'fictional-queue', codeVersion: 'fictional-build.1', instanceId, ...overrides }, { ...timer, warn() { ++warnings; } });
  return { start, timer, primary, blocking, state, pool, reports, deadlines, attempts: () => attempts, warnings: () => warnings, primaryReads: () => primaryReads, blockingReads: () => blockingReads };
}

test('heartbeat reports both existing connections and local loop/pause independently without treating a report as execution', async () => {
  const context = harness(), handle = context.start(); await flush(); assert.equal(context.reports[0][3], 'starting');
  await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); const ready = context.reports.at(-1)!;
  assert.deepEqual(ready.slice(0, 7), [instanceId, 'fictional-queue', 'fictional-build.1', 'running', true, true, false]);
  context.state.paused = true; await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.deepEqual(context.reports.at(-1)!.slice(4, 7), [true, true, true]);
  context.state.running = false; await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.deepEqual(context.reports.at(-1)!.slice(4, 7), [true, false, true]);
  assert.equal(context.primaryReads(), 1); assert.equal(context.blockingReads(), 1); assert.ok(context.deadlines.every((value) => value === 2000)); await handle.stop();
});

test('a ready primary alone never reports Redis ready; reconnect and disconnection are sampled from both client states', async () => {
  const context = harness(); context.blocking.status = 'connecting'; const handle = context.start(); await flush(); assert.equal(context.reports.at(-1)![4], false);
  await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.reports.at(-1)![4], false);
  context.blocking.status = 'ready'; await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.reports.at(-1)![4], true);
  context.primary.status = 'reconnecting'; await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.reports.at(-1)![4], false);
  context.primary.status = 'ready'; context.blocking.status = 'end'; await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.reports.at(-1)![4], false);
  await handle.stop();
});

test('unresolved initialization and failed state getters degrade without delaying heartbeat or fabricating ready', async () => {
  const primary = deferred<{ status: string }>(), blocking = deferred<{ status: string }>(); let broken = false;
  const context = harness({ worker: { client: primary.promise, waitUntilReady: () => blocking.promise, isRunning() { if (broken) throw new Error('Fictional private detail'); return true; }, isPaused: () => false } });
  const handle = context.start(); await flush(); assert.equal(context.reports.length, 1); assert.equal(context.reports[0][4], false); primary.resolve({ status: 'ready' }); await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.reports.at(-1)![4], false);
  blocking.resolve({ status: 'ready' }); await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.reports.at(-1)![4], true); broken = true;
  await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.deepEqual(context.reports.at(-1)!.slice(4, 7), [false, false, true]); await handle.stop();
});

test('Redis initialization rejection or synchronous accessor errors are caught and never become ready facts', async () => {
  const context = harness({ worker: { get client(): Promise<{ status: string }> { throw new Error('Fictional accessor failure'); }, waitUntilReady: () => Promise.reject(new Error('Fictional connection failed')), isRunning: () => true, isPaused: () => false } });
  const handle = context.start(); await flush(); await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.ok(context.reports.every((values) => values[4] === false)); await handle.stop();
});

test('pool and Redis facts are captured after pool acquisition, including the heartbeat borrowed slot', async () => {
  const acquire = deferred<void>(), context = harness({ acquire: async (attempt) => { if (attempt === 1) await acquire.promise; } }), handle = context.start(); await flush(); assert.equal(context.reports.length, 0);
  context.primary.status = 'close'; context.pool.totalCount = 2; context.pool.idleCount = 1; context.pool.waitingCount = 3;
  acquire.resolve(); await flush(); assert.equal(context.reports[0][4], false); assert.deepEqual(context.reports[0].slice(7), [2, 1, 3, 2]); await handle.stop();
});

test('the scheduler is single-flight and queues no samples while a bounded write is in progress', async () => {
  const response = deferred<void>(), context = harness({ query: async (attempt) => { if (attempt === 1) await response.promise; } }), handle = context.start(); await flush();
  await context.timer.advance(10 * WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.attempts(), 1); assert.equal(context.timer.count(), 0);
  response.resolve(); await flush(); assert.equal(context.timer.count(), 1); await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.attempts(), 2); await handle.stop(); assert.equal(context.timer.count(), 0);
});

test('failed bounded database writes do not advance report state or leak errors, and diagnostics are rate limited until recovery', async () => {
  let failing = true; const context = harness({ acquire: async () => { if (failing) throw new Error('Fictional secret connection detail'); } }), handle = context.start(); await flush(); await context.timer.advance(3 * WORKER_HEARTBEAT_INTERVAL_MS);
  assert.equal(context.reports.length, 0); assert.equal(context.warnings(), 1); failing = false; await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.reports.length, 1);
  failing = true; await context.timer.advance(WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.warnings(), 2); await handle.stop(); assert.equal(context.timer.count(), 0);
});

test('stop invalidates a pending acquisition before it can write running and emits only a final stopping report', async () => {
  const acquire = deferred<void>(), context = harness({ acquire: async (attempt) => { if (attempt === 1) await acquire.promise; } }), handle = context.start(); await flush();
  const first = handle.stop(), second = handle.stop(); assert.equal(first, second); await flush(); assert.equal(context.reports.length, 0);
  acquire.resolve(); await first; assert.deepEqual(context.reports.map((values) => values[3]), ['stopping']); await context.timer.advance(5 * WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.reports.length, 1); assert.equal(context.timer.count(), 0);
});

test('an already submitted write settles before stopping; stop return guarantees no later writes or timer remains', async () => {
  const response = deferred<void>(), context = harness({ query: async (attempt) => { if (attempt === 1) await response.promise; } }), handle = context.start(); await flush();
  let stopped = false; const done = handle.stop().then(() => { stopped = true; }); await flush(); assert.equal(stopped, false); assert.equal(context.reports.length, 1);
  response.resolve(); await done; assert.deepEqual(context.reports.map((values) => values[3]), ['starting', 'stopping']);
  assert.equal(context.reports.at(-1)![5], true); // Reporting stopped has not closed the still-running worker.
  await context.timer.advance(10 * WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.reports.length, 2); assert.equal(context.timer.count(), 0);
});

test('late Redis initialization after stop cannot revive sampling or produce a new ready report', async () => {
  const primary = deferred<{ status: string }>(), blocking = deferred<{ status: string }>(), context = harness({ worker: { client: primary.promise, waitUntilReady: () => blocking.promise, isRunning: () => true, isPaused: () => false } });
  const handle = context.start(); await flush(); await handle.stop(); const count = context.reports.length;
  primary.resolve({ status: 'ready' }); blocking.resolve({ status: 'ready' }); await context.timer.advance(10 * WORKER_HEARTBEAT_INTERVAL_MS); assert.equal(context.reports.length, count); assert.equal(context.reports.at(-1)![4], false);
});

test('invalid metadata and impossible pool snapshots are rejected without storing fabricated fields', async () => {
  for (const changes of [{ queueName: 'fictional:invalid' }, { queueName: '.fictional' }, { queueName: '_fictional' }, { codeVersion: '-fictional' }, { queueName: 'q'.repeat(129) }, { codeVersion: 'fictional\nprivate' }, { codeVersion: 'fictional\n' }, { queueName: 'fictional\n' }, { instanceId: `${instanceId}\n` }, { instanceId: 'fictional-not-uuid' }]) { const context = harness(); assert.throws(() => context.start(changes)); assert.equal(context.attempts(), 0); assert.equal(context.primaryReads(), 0); }
  const context = harness(); context.pool.idleCount = 2; const handle = context.start(); await flush(); assert.equal(context.reports.length, 0); assert.equal(context.warnings(), 1); await handle.stop(); assert.equal(context.reports.length, 0);
  const mismatch = harness({ rowCount: 0 }), mismatched = mismatch.start(); await flush(); assert.equal(mismatch.warnings(), 1); await mismatched.stop(); assert.equal(mismatch.timer.count(), 0);
});
