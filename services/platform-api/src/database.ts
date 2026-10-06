import { Pool, type PoolClient } from 'pg';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export class Database {
  readonly pool: Pool;
  private idleErrors = 0;
  get idleErrorCount() { return this.idleErrors; }
  constructor(url: string, options: {max?: number; connectionTimeoutMillis?: number} = {}) {
    const max = options.max ?? 12, connectionTimeoutMillis = options.connectionTimeoutMillis ?? 5000;
    if (!Number.isInteger(max) || max < 1 || max > 100 || !Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 100 || connectionTimeoutMillis > 5000) throw new Error('Invalid database pool limits.');
    this.pool = new Pool({ connectionString: url, max, connectionTimeoutMillis });
    // pg already removes the failed idle connection; do not leak its SQL, URL or error into public logs.
    this.pool.on('error', () => { this.idleErrors = Math.min(Number.MAX_SAFE_INTEGER, this.idleErrors + 1); });
  }
  async query(text: string, values: unknown[] = []) { return this.pool.query(text, values); }
  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  /** The pool's native acquisition timeout removes its waiter. The operation deadline starts only after acquisition. */
  async withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options: {readOnly?: boolean; timeoutMs?: number} = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 2000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid database operation deadline.');
    const client = await this.pool.connect();
    let usable = true, released = false, destroyed: Promise<void> | undefined;
    const deadlineError = new DatabaseOperationTimeout();
    const onError = () => {}; // This borrowed connection may emit an error while being destroyed.
    client.on('error', onError);
    const release = (discard = false) => { if (!released) { released = true; client.release(discard); } };
    const destroy = () => {
      if (destroyed) return destroyed;
      usable = false;
      const stream = client.connection.stream;
      destroyed = stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream.once('close', resolve));
      // query_timeout alone does not cancel an active non-pipeline pg query. Destroy only our socket.
      stream.destroy(); release(true);
      return destroyed;
    };
    const guarded = new Proxy(client, { get(target, key) {
      if (key === 'query') return (...args: unknown[]) => {
        if (!usable) return Promise.reject(deadlineError);
        return Reflect.apply(target.query, target, args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { void destroy(); reject(deadlineError); }, timeoutMs); });
    try {
      const operation = (async () => {
        await guarded.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
        await guarded.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
        await guarded.query(`SET LOCAL lock_timeout = '${Math.min(timeoutMs, 500)}ms'`);
        const result = await run(guarded);
        await guarded.query('COMMIT');
        return result;
      })();
      return await Promise.race([operation, expired]);
    } catch (error) {
      if (usable) {
        try { await Promise.race([guarded.query('ROLLBACK'), expired]); }
        catch { await destroy(); }
      }
      throw error;
    } finally {
      clearTimeout(timer!);
      usable = false;
      if (destroyed) await destroyed; else release();
      client.removeListener('error', onError);
    }
  }
  async migrate() {
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const names = (await fs.readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    await this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('companion-platform-migrations'))");
      await client.query('CREATE TABLE IF NOT EXISTS platform_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of names) {
        const existing = await client.query('SELECT name FROM platform_migrations WHERE name=$1', [name]);
        if (!existing.rowCount) {
          await client.query(await fs.readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
          await client.query('INSERT INTO platform_migrations(name) VALUES($1)', [name]);
        }
      }
    });
  }
  async close() { await this.pool.end(); }
}

export class DatabaseOperationTimeout extends Error {
  readonly code = 'DATABASE_OPERATION_TIMEOUT';
  constructor() { super('The database operation exceeded its deadline.'); this.name = 'DatabaseOperationTimeout'; }
}
