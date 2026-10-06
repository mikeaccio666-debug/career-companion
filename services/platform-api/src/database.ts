import { Pool, type PoolClient } from 'pg';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export class Database {
  readonly pool: Pool;
  constructor(url: string) { this.pool = new Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 5000 }); }
  async query(text: string, values: unknown[] = []) { return this.pool.query(text, values); }
  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
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
