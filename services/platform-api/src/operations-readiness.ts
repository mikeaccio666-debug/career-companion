import fs from 'node:fs/promises';
import { RedisConnection } from 'bullmq';
import type { PlatformConfig } from './config.ts';
import type { Database } from './database.ts';
import { connectionFromUrl } from './queue-connection.ts';

export type PublicReadiness = {ok: boolean; checkedAt: string; database: 'ready' | 'unavailable'; execution: 'ready' | 'degraded' | 'disabled' | 'unknown'};
export type RedisProbe = {ok: boolean; globalPaused?: boolean; counts?: {waiting: number; active: number; delayed: number; prioritized: number; paused: number}};
type DataProbe = {ready: boolean; reason: 'ready' | 'unavailable' | 'migrations_missing' | 'schema_missing'; workerFresh: boolean};
type ReadinessSample = {public: PublicReadiness; data: DataProbe; redis: RedisProbe};
export type OperationsDiagnostics = PublicReadiness & {dataReason: DataProbe['reason']; freshMatchingWorkerReport: boolean;
  poolScope: 'diagnostic_process'; pool: {total: number; idle: number; waiting: number; max: number; idleErrors: number}; outbox: unknown;
  redis: {available: boolean; globalPaused: boolean | null; counts: RedisProbe['counts'] | null}; scope: 'read_only_no_dispatch_no_recovery_no_migration'; reportIsNotExecutionProof: true};
type ProbeConfig = Pick<PlatformConfig, 'redisUrl' | 'queueName' | 'codeVersion'>;
export const OPERATIONS_CACHE_MS = 1000;
export const WORKER_FRESHNESS_MS = 30_000;

// Lightweight schema presence checks complement the ledger; they do not certify constraints, data or provider quality.
const requiredColumns: Record<string, string[]> = {
  platform_users: ['id', 'auth_version', 'email_verified_at'], platform_sessions: ['user_id', 'auth_version', 'expires_at'],
  platform_messages: ['id', 'conversation_id', 'status', 'lease_until'], platform_jobs: ['id', 'status', 'generation', 'lease_token', 'lease_until', 'execution_policy'],
  platform_job_outbox: ['job_id', 'generation', 'created_at', 'dispatched_at', 'definition_hash'], platform_approvals: ['generation', 'args', 'status'],
  platform_goal_plan_steps: ['plan_id', 'job_generation', 'resolved_task', 'input_sources'],
  platform_worker_heartbeats: ['instance_id', 'queue_name', 'code_version', 'started_at', 'reported_at', 'process_state', 'redis_ready', 'worker_running', 'worker_paused', 'pool_total', 'pool_idle', 'pool_waiting', 'pool_max'],
};
export async function requiredOperationsSchema() {
  const names = (await fs.readdir(new URL('../migrations/', import.meta.url))).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  const relations = new Set(['platform_migrations']);
  for (const name of names) {
    const sql = await fs.readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)\s*\(/g)) relations.add(match[1]);
  }
  return {migrations: names, relations: [...relations], columns: requiredColumns};
}
type Schema = Awaited<ReturnType<typeof requiredOperationsSchema>>;

/** Owns one non-shared socket. No Queue constructor, Lua, metadata write or producer connection is used. */
class ReadOnlyRedisConnection extends RedisConnection {
  private readonly ended: Promise<void>;
  private readonly quietError = () => {};
  constructor(url: string, timeoutMs: number) {
    super({...connectionFromUrl(url, 'producer'), retryStrategy: () => null, maxRetriesPerRequest: 0,
      connectTimeout: timeoutMs, commandTimeout: timeoutMs, disconnectTimeout: 100}, {shared: false, blocking: false, skipVersionCheck: true});
    this.on('error', () => {});
    const raw = this._client;
    raw.on('error', this.quietError);
    this.ended = raw.status === 'end' ? Promise.resolve() : new Promise(resolve => raw.once('end', resolve));
  }
  async dispose() { try { await this.close(true); } finally { await this.ended; this._client.removeListener('error', this.quietError); } }
}

export async function probeRedisReadOnly(config: ProbeConfig, options: {timeoutMs?: number; counts?: boolean} = {}): Promise<RedisProbe> {
  const timeoutMs = options.timeoutMs ?? 1500;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid Redis probe deadline.');
  const connection = new ReadOnlyRedisConnection(config.redisUrl, timeoutMs);
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Redis probe deadline exceeded.')), timeoutMs); });
  try {
    const result = await Promise.race([(async () => {
      const client = await connection.client, key = `bull:${config.queueName}:`;
      const waiting = await client.llen(`${key}wait`), pause = await client.hget(`${key}meta`, 'paused');
      // BullMQ's empty globally-paused queue has no entries in :paused, so its length is not a readiness test.
      const globalPaused = pause !== null;
      if (!options.counts) return {ok: true, globalPaused};
      const [active, delayed, prioritized, paused] = await Promise.all([client.llen(`${key}active`), client.zcard(`${key}delayed`), client.zcard(`${key}prioritized`), client.llen(`${key}paused`)]);
      return {ok: true, globalPaused, counts: {waiting, active, delayed, prioritized, paused}};
    })(), expired]);
    return result;
  } catch { return {ok: false}; }
  finally { clearTimeout(timer!); await connection.dispose(); }
}

export class OperationsReadiness {
  private schema?: Promise<Schema>;
  private inFlight?: Promise<ReadinessSample>;
  private cached?: {sample: ReadinessSample; expires: number};
  private closing = false;
  private diagnosticsInFlight?: Promise<OperationsDiagnostics>;
  constructor(private readonly db: Database, private readonly config: ProbeConfig, private readonly queueEnabled: boolean,
    private readonly ports: {redis?: (config: ProbeConfig, options?: {counts?: boolean}) => Promise<RedisProbe>; schema?: () => Promise<Schema>; now?: () => number; monotonicNow?: () => number} = {}) {}

  private now() { return this.ports.now?.() ?? Date.now(); }
  private monotonicNow() { return this.ports.monotonicNow?.() ?? performance.now(); }
  private async data(): Promise<DataProbe> {
    try {
      this.schema ??= (this.ports.schema ?? requiredOperationsSchema)();
      const schema = await this.schema;
      return await this.db.withBoundedTransaction(async client => {
        const relations = await client.query('SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN (\'r\',\'p\') AND c.relname=ANY($1::text[])', [schema.relations]);
        if (relations.rowCount !== schema.relations.length) return {ready: false, reason: 'schema_missing', workerFresh: false};
        const ledger = await client.query('SELECT name FROM platform_migrations WHERE name=ANY($1::text[])', [schema.migrations]);
        if (ledger.rowCount !== schema.migrations.length) return {ready: false, reason: 'migrations_missing', workerFresh: false};
        const columns = await client.query('SELECT c.relname,a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND a.attnum>0 AND NOT a.attisdropped AND c.relname=ANY($1::text[])', [Object.keys(schema.columns)]);
        const found = new Set(columns.rows.map(row => `${row.relname}.${row.attname}`));
        if (Object.entries(schema.columns).some(([table, names]) => names.some(name => !found.has(`${table}.${name}`)))) return {ready: false, reason: 'schema_missing', workerFresh: false};
        const heartbeat = this.queueEnabled ? await client.query(`SELECT EXISTS(SELECT 1 FROM platform_worker_heartbeats
          WHERE queue_name=$1 AND code_version=$2 AND reported_at<=clock_timestamp() AND reported_at>=clock_timestamp()-interval '30 seconds'
          AND process_state='running' AND redis_ready AND worker_running AND NOT worker_paused) AS ready`, [this.config.queueName, this.config.codeVersion]) : undefined;
        return {ready: true, reason: 'ready', workerFresh: heartbeat?.rows[0]?.ready === true};
      }, {readOnly: true});
    } catch { return {ready: false, reason: 'unavailable', workerFresh: false}; }
  }
  private async sample(): Promise<ReadinessSample> {
    const redisProbe: Promise<RedisProbe> = this.queueEnabled ? Promise.resolve().then(() => (this.ports.redis ?? probeRedisReadOnly)(this.config, {counts: true})).catch(() => ({ok: false})) : Promise.resolve({ok: false});
    const [data, redis] = await Promise.all([this.data(), redisProbe]);
    const execution = !this.queueEnabled ? 'disabled' : !data.ready ? 'unknown' : redis.ok && redis.globalPaused === false && data.workerFresh ? 'ready' : 'degraded';
    return {public: {ok: data.ready, checkedAt: new Date(this.now()).toISOString(), database: data.ready ? 'ready' : 'unavailable', execution}, data, redis};
  }
  private read(): Promise<ReadinessSample> {
    if (this.closing) return Promise.resolve({public: {ok: false, checkedAt: new Date(this.now()).toISOString(), database: 'unavailable', execution: 'unknown'}, data: {ready: false, reason: 'unavailable', workerFresh: false}, redis: {ok: false}});
    if (this.inFlight) return this.inFlight;
    if (this.cached && this.cached.expires > this.monotonicNow()) return Promise.resolve(this.cached.sample);
    const pending = this.sample().then(sample => { this.cached = {sample, expires: this.monotonicNow() + OPERATIONS_CACHE_MS}; return sample; });
    this.inFlight = pending;
    void pending.finally(() => { if (this.inFlight === pending) this.inFlight = undefined; }).catch(() => {});
    return pending;
  }
  async readiness(): Promise<PublicReadiness> { return (await this.read()).public; }
  async executionReadiness(): Promise<PublicReadiness> { const result = await this.read(); return {...result.public, ok: result.public.execution === 'ready'}; }
  async health() { const result = await this.read(); return {ok: result.data.ready, database: result.data.ready ? 'connected' : 'unavailable', queue: this.queueEnabled ? 'configured' : 'disabled'}; }
  diagnostics() {
    if (this.diagnosticsInFlight) return this.diagnosticsInFlight;
    const pending = this.diagnostic(); this.diagnosticsInFlight = pending;
    void pending.finally(() => { if (this.diagnosticsInFlight === pending) this.diagnosticsInFlight = undefined; }).catch(() => {});
    return pending;
  }
  private async diagnostic(): Promise<OperationsDiagnostics> {
    const sample = await this.read();
    let outbox: unknown = null;
    if (sample.data.ready && !this.closing) {
      try { outbox = await this.db.withBoundedTransaction(async client => (await client.query(`SELECT
        count(*) FILTER (WHERE o.dispatched_at IS NULL)::int AS undelivered,
        count(*) FILTER (WHERE o.dispatched_at IS NOT NULL)::int AS dispatched_still_queued,
        coalesce(max(extract(epoch FROM clock_timestamp()-o.created_at)) FILTER (WHERE o.dispatched_at IS NULL),0)::float8 AS oldest_undelivered_seconds,
        coalesce(max(extract(epoch FROM clock_timestamp()-o.created_at)) FILTER (WHERE o.dispatched_at IS NOT NULL),0)::float8 AS oldest_dispatched_queued_seconds
        FROM platform_job_outbox o JOIN platform_jobs j ON j.id=o.job_id WHERE j.status='queued' AND j.generation=o.generation`)).rows[0], {readOnly: true}); } catch {}
    }
    const redis = sample.redis;
    return { ...sample.public, dataReason: sample.data.reason, freshMatchingWorkerReport: sample.data.workerFresh, poolScope: 'diagnostic_process',
      pool: {total: this.db.pool.totalCount, idle: this.db.pool.idleCount, waiting: this.db.pool.waitingCount, max: this.db.pool.options.max ?? 12, idleErrors: this.db.idleErrorCount},
      outbox, redis: {available: redis.ok, globalPaused: redis.globalPaused ?? null, counts: redis.counts ?? null}, scope: 'read_only_no_dispatch_no_recovery_no_migration', reportIsNotExecutionProof: true };
  }
  async close() { this.closing = true; await Promise.allSettled([this.inFlight, this.diagnosticsInFlight].filter(Boolean)); this.cached = undefined; }
}
