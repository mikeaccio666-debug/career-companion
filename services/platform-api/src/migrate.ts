import { Database } from './database.ts';
import { readConfig } from './config.ts';
const config = readConfig();
const db = new Database(config.databaseUrl, { max: config.databasePoolMax, connectionTimeoutMillis: config.databaseConnectTimeoutMs });
try { await db.migrate(); process.stdout.write('Platform database migrations applied.\n'); }
finally { await db.close(); }
