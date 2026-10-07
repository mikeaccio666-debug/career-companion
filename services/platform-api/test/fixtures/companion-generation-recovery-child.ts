// Owned test process only. SIGKILL is intentional: the parent verifies durable
// receipts after actual socket loss, not a mocked in-process cleanup exception.
import type { PoolClient } from 'pg';
import { createProviderRuntime } from '@companion/ai-core';
import { BackgroundGeneration } from '../../src/background-generation.ts';
import { Database } from '../../src/database.ts';
import { readDataCrypto } from '../../src/data-crypto.ts';
import { requireModelConsent } from '../../src/model-consent.ts';
import { FICTIONAL_LEGAL } from './student-entry.ts';

const url = process.env.COMPANION_RECOVERY_TEST_DATABASE_URL!;
const local = process.env.COMPANION_RECOVERY_TEST_MODEL_URL!;
if (!url || !local || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
  || new URL(local).hostname !== '127.0.0.1') throw new Error('Use owned loopback test services.');
const phase = process.env.COMPANION_RECOVERY_TEST_CRASH_PHASE;
class CrashDatabase extends Database {
  override async withBoundedTransaction<T>(run: (client: PoolClient) => Promise<T>, options = {}): Promise<T> {
    let admitted = false;
    const result = await super.withBoundedTransaction(client => run(new Proxy(client, { get(target, key) {
      if (key === 'query') return async (sql: string, values?: unknown[]) => {
        const paused = phase === 'no_calls' && sql.includes('INSERT INTO platform_companion_generation_calls')
          || phase === 'checkpoint' && sql.includes('INSERT INTO platform_companion_revisions')
          || phase === 'invalid_output' && sql.includes('INSERT INTO platform_companion_generation_calls') && values?.[5] === 2
          || phase === 'unvalidated_output' && sql.includes('UPDATE platform_companion_generation_calls SET validation_status=')
          || phase === 'dispatch_risk' && sql.includes("UPDATE platform_cost_reservations SET status='admitted'");
        if (paused) {
          process.send?.({ type: 'paused', phase });
          await new Promise<never>(() => {});
        }
        const result = await target.query(sql, values);
        if (sql.includes("UPDATE platform_companion_generation_calls c SET status='admitted'")) admitted = true;
        return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } })), options);
    if (phase === 'launched' && admitted) {
      // The real admission transaction has COMMITted. Await the actual HTTP
      // response headers, which the owned server sends only after reading its
      // complete request body; no model terminal content has been emitted.
      await (result as any).pending;
      process.send?.({ type: 'paused', phase });
      await new Promise<never>(() => {});
    }
    return result;
  }
}
const db = new CrashDatabase(url), config = { dataCrypto: readDataCrypto({ PLATFORM_DATA_KEY: 'c3'.repeat(32) })!,
  requireVerifiedEmail: true, modelRoutes: { chat: { provider: 'openai' }, companion_generation: { provider: 'openai' } } };
const runtime = requireModelConsent(createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1',
  OPENAI_API_KEY: 'fictional-loopback-only', OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model' },
fetch: (target, init) => {
  const remote = new URL(String(target));
  if (remote.origin !== 'https://api.openai.com' || remote.pathname !== '/v1/responses') throw new Error('Unexpected test route.');
  return fetch(local + remote.pathname, init);
} }));
process.once('message', async (value: any) => {
  try {
    await new BackgroundGeneration(db, config, FICTIONAL_LEGAL, runtime).generate(value.context, { taskId: value.taskId });
    process.send?.({ type: 'unexpected_completion' });
  } catch { process.send?.({ type: 'unexpected_failure' }); }
  finally { await db.close(); process.disconnect?.(); }
});
process.send?.({ type: 'ready' });
