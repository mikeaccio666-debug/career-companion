import { randomUUID } from 'node:crypto';
import type { Database } from './database.ts';

export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_HEARTBEAT_FRESH_MS = 30_000;
const WRITE_TIMEOUT_MS = 2_000;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const boundedIdentifier = (value: unknown): value is string => typeof value === 'string' && identifier.exec(value)?.[0] === value;
interface RedisState { readonly status: string }
/** Both are existing BullMQ connections. No Redis command or additional connection is opened here. */
export interface HeartbeatWorker {
  readonly client: Promise<RedisState>;
  waitUntilReady(): Promise<RedisState>;
  isRunning(): boolean;
  isPaused(): boolean;
}
type HeartbeatDatabase = Pick<Database, 'pool' | 'withBoundedTransaction'>;
interface HeartbeatOptions { db: HeartbeatDatabase; worker: HeartbeatWorker; queueName: string; codeVersion: string; instanceId?: string }
/** Timer injection keeps lifecycle tests deterministic; the public worker handle cannot trigger samples. */
export interface HeartbeatTimerPort {
  setTimer(run: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
  warn(): void;
}
const timers: HeartbeatTimerPort = {
  setTimer(run, delay) { const timer = setTimeout(run, delay); timer.unref(); return timer; },
  clearTimer(timer) { clearTimeout(timer as NodeJS.Timeout); },
  warn() { process.stderr.write('Worker heartbeat unavailable; recent process reports cannot be confirmed.\n'); },
};
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647;

/** Fresh rows only prove that this process recently reported these facts, not that a task succeeded. */
export function startWorkerHeartbeat({ db, worker, queueName, codeVersion, instanceId = randomUUID() }: HeartbeatOptions, timerPort: HeartbeatTimerPort = timers): { instanceId: string; stop(): Promise<void> } {
  if (!boundedIdentifier(queueName) || !boundedIdentifier(codeVersion) || typeof instanceId !== 'string' || uuid.exec(instanceId)?.[0] !== instanceId) throw new Error('Worker heartbeat identifiers must be valid bounded deployment metadata.');
  let live = true, epoch = 0, phase: 'starting' | 'running' = 'starting';
  let primary: RedisState | undefined, blocking: RedisState | undefined;
  let timer: unknown = null, flight: Promise<void> | undefined, stopping: Promise<void> | undefined, warned = false;
  // These two promises are observed once. Waiting for Redis never blocks a database heartbeat.
  try { void worker.client.then((client) => { if (live) primary = client; }, () => {}).catch(() => {}); } catch { /* Unknown connection facts remain unready. */ }
  try { void worker.waitUntilReady().then((client) => { if (live) blocking = client; }, () => {}).catch(() => {}); } catch { /* Unknown connection facts remain unready. */ }
  const warn = () => { if (warned) return; warned = true; try { timerPort.warn(); } catch { /* A diagnostic failure cannot change readiness facts. */ } };
  function values(processState: 'starting' | 'running' | 'stopping') {
    const total = db.pool.totalCount, idle = db.pool.idleCount, waiting = db.pool.waitingCount, maximum = db.pool.options.max;
    if (!integer(total) || !integer(idle) || !integer(waiting) || !integer(maximum, 1) || idle > total || total > maximum) throw new Error('Worker pool facts cannot be safely reported.');
    let ready = false, running = false, paused = true;
    try {
      const actualRunning = worker.isRunning(), actualPaused = worker.isPaused();
      if (typeof actualRunning !== 'boolean' || typeof actualPaused !== 'boolean') throw new Error();
      running = actualRunning; paused = actualPaused;
      ready = primary?.status === 'ready' && blocking?.status === 'ready';
    } catch { ready = false; running = false; paused = true; }
    return [instanceId, queueName, codeVersion, processState, ready, running, paused, total, idle, waiting, maximum];
  }
  async function write(processState: 'starting' | 'running' | 'stopping', ticket: number, final = false) {
    try {
      await db.withBoundedTransaction(async (client) => {
        if (ticket !== epoch || !final && !live) return;
        // Sample after the bounded pool acquisition, immediately before submitting the write.
        const saved = await client.query(`INSERT INTO platform_worker_heartbeats
          (instance_id,queue_name,code_version,process_state,redis_ready,worker_running,worker_paused,pool_total,pool_idle,pool_waiting,pool_max)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT(instance_id) DO UPDATE SET
            reported_at=clock_timestamp(),process_state=EXCLUDED.process_state,
            redis_ready=EXCLUDED.redis_ready,worker_running=EXCLUDED.worker_running,worker_paused=EXCLUDED.worker_paused,
            pool_total=EXCLUDED.pool_total,pool_idle=EXCLUDED.pool_idle,pool_waiting=EXCLUDED.pool_waiting,pool_max=EXCLUDED.pool_max
          WHERE platform_worker_heartbeats.queue_name=EXCLUDED.queue_name AND platform_worker_heartbeats.code_version=EXCLUDED.code_version`, values(processState));
        if (saved.rowCount !== 1) throw new Error('Worker heartbeat instance metadata changed.');
      }, { timeoutMs: WRITE_TIMEOUT_MS });
      warned = false;
    } catch { warn(); }
  }
  function sample(): Promise<void> {
    if (!live) return Promise.resolve();
    if (flight) return flight;
    const ticket = epoch;
    const work = write(phase, ticket).finally(() => { if (flight === work) flight = undefined; if (live && ticket === epoch) phase = 'running'; });
    flight = work; return work;
  }
  function schedule() {
    if (!live || timer !== null) return;
    timer = timerPort.setTimer(() => { timer = null; void sample().then(schedule); }, WORKER_HEARTBEAT_INTERVAL_MS);
  }
  void sample().then(schedule);
  return {
    instanceId,
    stop() {
      if (stopping) return stopping;
      live = false; ++epoch;
      if (timer !== null) timerPort.clearTimer(timer); timer = null;
      stopping = (async () => {
        // Bounded transactions remove acquisition waiters and destroy their own timed-out connection.
        // A write already sent may finish, but it settles before the final stopping report.
        await flight;
        await write('stopping', epoch, true);
        primary = undefined; blocking = undefined;
      })();
      return stopping;
    },
  };
}
