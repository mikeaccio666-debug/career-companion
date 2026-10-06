import { Database } from './database.ts';
import { readConfig } from './config.ts';
import { OperationsReadiness } from './operations-readiness.ts';

// Operator-only local CLI. It never constructs TaskQueue, migrates or recovers jobs.
const config = readConfig();
const db = new Database(config.databaseUrl, {max: 1, connectionTimeoutMillis: config.databaseConnectTimeoutMs});
const readiness = new OperationsReadiness(db, config, true);
try {
  const result = await readiness.diagnostics();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok || result.execution !== 'ready') process.exitCode = 1;
} catch { process.stderr.write('The read-only operations check could not complete.\n'); process.exitCode = 1; }
finally { await readiness.close(); await db.close(); }
