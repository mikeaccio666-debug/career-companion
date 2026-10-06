import { Database } from './database.ts';
import { readConfig } from './config.ts';
const db = new Database(readConfig().databaseUrl);
try { await db.migrate(); process.stdout.write('Platform database migrations applied.\n'); }
finally { await db.close(); }
