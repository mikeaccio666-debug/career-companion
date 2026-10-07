import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type { PoolClient } from 'pg';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { createWorker, JobService, TaskQueue } from '../src/jobs.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { ProducerQueue } from '../src/queue-connection.ts';
import { OperationsReadiness, OPERATIONS_CACHE_MS } from '../src/operations-readiness.ts';
import { startWorkerHeartbeat } from '../src/worker-heartbeat.ts';

// Real isolated PostgreSQL, Redis and BullMQ connections; only the task runtime is synthetic.
// Injected clocks accelerate report scheduling/cache expiration, never fake connection facts or DB time.
const base = readConfig({ ...process.env, PLATFORM_ENABLE_WORKBENCH: '1' }), schema = `ops_lifecycle_${randomUUID().replaceAll('-', '')}`;
const admin = new Database(base.databaseUrl, { max: 1, connectionTimeoutMillis: 1000 });
const databaseUrl = new URL(base.databaseUrl); databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(databaseUrl.toString(), { max: 4, connectionTimeoutMillis: 1000 });
let directory: string, schemaCreated = false;
before(async () => {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.databaseUrl).hostname), 'Only a local fixture database is allowed.');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.redisUrl).hostname), 'Only local fixture Redis is allowed.');
  assert.equal(new URL(base.redisUrl).protocol, 'redis:', 'This fixture uses a loopback plain TCP Redis proxy.');
  await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true; await db.migrate(); directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operations-lifecycle-fixture-'));
});
after(async () => {
  try { await db.close(); } finally {
    try { if (schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); }
  }
});
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function flush() { for (let n = 0; n < 20; ++n) await Promise.resolve(); }
async function eventually(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (!await check()) { if (Date.now() >= until) assert.fail(message); await delay(20); }
}
const executionTables = ['platform_jobs', 'platform_job_attempts', 'platform_job_outbox', 'platform_approvals', 'platform_artifacts', 'platform_workflow_checkpoints', 'platform_browser_checkpoints', 'platform_mcp_receipts', 'platform_model_relay_requests'];
async function executionSnapshot() {
  return db.withBoundedTransaction(async (client) => {
    const result: Record<string, unknown> = {};
    for (const table of executionTables) result[table] = (await client.query(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) AS rows FROM ${table} r`)).rows[0].rows;
    return result;
  }, { readOnly: true });
}

/** Only worker connections use this endpoint. The producer and read-only probe always use base Redis. */
async function workerProxy() {
  const target = new URL(base.redisUrl), sockets = new Set<net.Socket>(); let enabled = true, connections = 0;
  const server = net.createServer((client) => {
    ++connections; sockets.add(client); client.on('error', () => {});
    client.on('close', () => sockets.delete(client));
    if (!enabled) { client.destroy(); return; }
    const upstream = net.connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 6379) }); sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('data', (bytes) => { if (enabled && !upstream.destroyed) upstream.write(bytes); });
    upstream.on('data', (bytes) => { if (enabled && !client.destroyed) client.write(bytes); });
    client.on('close', () => upstream.destroy()); upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = new URL(base.redisUrl); endpoint.hostname = '127.0.0.1'; endpoint.port = String(address.port);
  return { url: endpoint.toString(), sockets, connections: () => connections,
    disconnect() { enabled = false; for (const socket of sockets) socket.destroy(); },
    restore() { enabled = true; },
    async close() { enabled = false; for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

function fixture(workerRedisUrl = base.redisUrl) {
  const queueName = `operations-lifecycle-${randomUUID()}`, codeVersion = `fixture-build-${randomUUID()}`;
  let calls = 0, monotonic = 0, timerSerial = 0, warnings = 0;
  const timers = new Map<number, () => void>(), heartbeatOperations: Promise<unknown>[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('The lifecycle fixture must never invoke a model, mail, voice or actual CLI/container.'); };
  const runtime: PlatformProviderRuntime = {
    capabilities: () => [{ id: 'fixture', name: 'Synthetic lifecycle runtime; no CLI process', keyConfigured: true, enabled: true, capabilities: ['cli'], models: [], envVariables: [] }],
    async *streamChat() { throw new Error('No model is used by this lifecycle fixture.'); },
    async executeJob(input) { assert.equal(input.kind, 'cli'); assert.equal(input.provider, 'fixture'); ++calls; return { text: 'Synthetic lifecycle result. No CLI process, container or commercial model ran.', artifacts: [] }; },
    createVoiceSession: forbidden, transcribe: forbidden, speech: forbidden,
  };
  const config = { ...base, databaseUrl: databaseUrl.toString(), redisUrl: base.redisUrl, queueName, codeVersion, storageDir: directory, accountEmail: undefined, requireVerifiedEmail: false };
  const storage = new LocalBlobStorage(directory), producerJobs = new JobService(db, config, runtime, storage);
  const workerJobs = new JobService(db, { ...config, redisUrl: workerRedisUrl }, runtime, storage);
  const queue = new TaskQueue(producerJobs), control = new ProducerQueue(queueName, base.redisUrl), worker = createWorker(workerJobs);
  worker.on('error', () => {});
  const observedDb = { pool: db.pool, withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options?: { readOnly?: boolean; timeoutMs?: number }): Promise<T> { const operation = db.withBoundedTransaction(run, options); heartbeatOperations.push(operation); return operation; } };
  const heartbeat = startWorkerHeartbeat({ db: observedDb, worker, queueName, codeVersion }, { setTimer(run) { const id = ++timerSerial; timers.set(id, run); return id; }, clearTimer(id) { timers.delete(id as number); }, warn() { ++warnings; } });
  const probe = new OperationsReadiness(db, config, true, { monotonicNow: () => monotonic });
  return { queue, control, worker, heartbeat, producerJobs, calls: () => calls, timerCount: () => timers.size, warnings: () => warnings,
    async settleReport() { await heartbeatOperations.at(-1); await flush(); },
    async pulse() { const entry = [...timers][0]; assert.ok(entry, 'A live heartbeat must have one scheduled pulse.'); timers.delete(entry[0]); entry[1](); await heartbeatOperations.at(-1); await flush(); },
    async report() { return (await db.query('SELECT process_state,redis_ready,worker_running,worker_paused,reported_at::text AS reported_at FROM platform_worker_heartbeats WHERE instance_id=$1', [heartbeat.instanceId])).rows[0]; },
    async inspect() { monotonic += OPERATIONS_CACHE_MS + 1; return probe.diagnostics(); },
    async createApproved() {
      const owner = randomUUID(); await db.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [owner, `${owner}@example.invalid`, 'Fictional lifecycle owner', 'not-a-real-password-hash']);
      const prepared = await producerJobs.create(owner, { kind: 'cli', provider: 'fixture', prompt: 'Fictional lifecycle task. Run no actual CLI or model.' });
      assert.equal(prepared.job.status, 'needs_approval'); assert.ok(prepared.approval);
      await producerJobs.decide(owner, prepared.approval.id, 'approved'); return { owner, jobId: prepared.job.id };
    },
    async close() {
      try { await heartbeat.stop(); } finally {
        try { await worker.close(true); } finally {
          try { await probe.close(); } finally {
            try { await queue.close(); } finally { try { await control.obliterate({ force: true }); } finally { await control.close(); } }
          }
        }
      }
    },
  };
}

test('a real BullMQ worker reports local pause and resume, and stopping reports cannot pass readiness or mutate execution tables', { timeout: 30_000 }, async () => {
  const context = fixture();
  try {
    const primary = await context.worker.client, blocking = await context.worker.waitUntilReady(); await context.settleReport(); await context.pulse();
    assert.equal((await context.report()).redis_ready, true); assert.equal((await context.report()).worker_running, true);
    const initial = await executionSnapshot(), ready = await context.inspect(); assert.equal(ready.execution, 'ready'); assert.equal(ready.reportIsNotExecutionProof, true); assert.deepEqual(await executionSnapshot(), initial); assert.equal(context.calls(), 0);
    await context.worker.pause(); await context.pulse(); const paused = await context.report(); assert.equal(paused.worker_paused, true);
    const localPaused = await context.inspect(); assert.equal(localPaused.execution, 'degraded'); assert.equal(localPaused.redis.available, true); assert.equal(localPaused.redis.globalPaused, false); assert.deepEqual(await executionSnapshot(), initial);
    context.worker.resume(); await eventually(() => primary.status === 'ready' && blocking.status === 'ready' && !context.worker.isPaused(), 'The own worker did not resume both actual Redis connections.');
    await context.pulse(); assert.equal((await context.inspect()).execution, 'ready'); assert.equal((await context.report()).worker_paused, false);
    await context.heartbeat.stop(); const stopping = await context.report(); assert.equal(stopping.process_state, 'stopping'); assert.equal(context.timerCount(), 0); assert.equal((await context.inspect()).execution, 'degraded');
    await context.worker.close(true); await delay(20); assert.equal((await context.report()).reported_at, stopping.reported_at); assert.deepEqual(await executionSnapshot(), initial); assert.equal(context.calls(), 0); assert.equal(context.warnings(), 0);
  } finally { await context.close(); }
});

test('only the own worker Redis sockets fail; probes remain read-only and approved queued work executes once after real reconnection', { timeout: 30_000 }, async () => {
  const proxy = await workerProxy(); let context: ReturnType<typeof fixture> | undefined;
  try {
    context = fixture(proxy.url); const running = context;
    const primary = await running.worker.client, blocking = await running.worker.waitUntilReady(); await running.settleReport(); await running.pulse();
    assert.ok(proxy.connections() >= 2); assert.equal(primary.status, 'ready'); assert.equal(blocking.status, 'ready'); assert.equal((await running.inspect()).execution, 'ready');
    proxy.disconnect(); await eventually(() => primary.status !== 'ready' && blocking.status !== 'ready', 'The proxy did not disconnect both own worker connections.');
    await running.pulse(); assert.equal((await running.report()).redis_ready, false);
    const disconnected = await running.inspect(); assert.equal(disconnected.execution, 'degraded'); assert.equal(disconnected.redis.available, true); assert.equal(disconnected.redis.globalPaused, false);
    const item = await running.createApproved(); await running.queue.dispatch();
    const queued = (await db.query('SELECT status,generation,attempt_count FROM platform_jobs WHERE id=$1', [item.jobId])).rows[0]; assert.deepEqual(queued, { status: 'queued', generation: 1, attempt_count: 0 });
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM platform_job_attempts WHERE job_id=$1', [item.jobId])).rows[0].count, 0); assert.equal(running.calls(), 0);
    assert.ok((await db.query('SELECT dispatched_at FROM platform_job_outbox WHERE job_id=$1 AND generation=1', [item.jobId])).rows[0].dispatched_at); assert.equal(await running.control.getWaitingCount(), 1);
    const beforeProbes = await executionSnapshot();
    for (let n = 0; n < 3; ++n) { const sample = await running.inspect(); assert.equal(sample.execution, 'degraded'); assert.equal(sample.redis.available, true); assert.equal(sample.scope, 'read_only_no_dispatch_no_recovery_no_migration'); }
    assert.deepEqual(await executionSnapshot(), beforeProbes); assert.equal(running.calls(), 0);
    proxy.restore(); await eventually(() => primary.status === 'ready' && blocking.status === 'ready', 'The own worker did not reconnect through its restored proxy.');
    await eventually(async () => (await db.query('SELECT status FROM platform_jobs WHERE id=$1', [item.jobId])).rows[0].status === 'succeeded', 'The approved synthetic task did not finish after reconnection.');
    await eventually(async () => (await running.control.getJob(`${item.jobId}-1`))?.getState().then((state) => state === 'completed') ?? false, 'The recovered notification did not complete.');
    await running.pulse(); const recovered = await running.inspect(); assert.equal(recovered.execution, 'ready'); assert.equal((await running.report()).redis_ready, true);
    await Promise.all([running.queue.dispatch(), running.queue.dispatch()]);
    const attempts = (await db.query('SELECT generation,attempt,status FROM platform_job_attempts WHERE job_id=$1 ORDER BY attempt', [item.jobId])).rows;
    assert.deepEqual(attempts, [{ generation: 1, attempt: 1, status: 'succeeded' }]); assert.equal(running.calls(), 1);
    assert.equal((await db.query('SELECT count(*)::integer AS count FROM platform_approvals WHERE job_id=$1 AND generation=1 AND status=\'approved\'', [item.jobId])).rows[0].count, 1); assert.equal(running.warnings(), 0);
  } finally {
    try { await context?.close(); } finally { await proxy.close(); }
    await eventually(() => proxy.sockets.size === 0, 'The own proxy sockets were not closed.');
  }
});
