import { Worker } from 'bullmq';
import { DatabaseError } from 'pg';
import { CompanionEntry, companionNotification } from './companion-entry.ts';
import { CostGuard } from './cost-guard.ts';
import { ApiError } from './errors.ts';
import { ProducerQueue, connectionFromUrl, QUEUE_DISPATCH_TIMEOUT_MS, QUEUE_RECONCILE_INTERVAL_MS } from './queue-connection.ts';

export const companionQueueName = (name: string) => `${name}-companion`;

/** Durable DB outbox -> reference-only notifications. Redis never stores intake,
 * model content, authorization material or an invented execution claim.
 */
export class CompanionGenerationQueue {
  private producer?: ProducerQueue;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private closed = false;
  constructor(readonly entry: CompanionEntry) {}
  get queue(): ProducerQueue {
    if (this.closed) throw new ApiError(503, 'QUEUE_CLOSED', 'Companion notifications have stopped.');
    return this.producer ??= new ProducerQueue(companionQueueName(this.entry.config.queueName), this.entry.config.redisUrl);
  }
  dispatch(): Promise<void> {
    if (this.closed) return Promise.reject(new ApiError(503, 'QUEUE_CLOSED', 'Companion notifications have stopped.'));
    if (this.inFlight) return this.inFlight;
    const running = this.runDispatch(); this.inFlight = running;
    void running.then(() => { if (this.inFlight === running) this.inFlight = undefined; }, () => { if (this.inFlight === running) this.inFlight = undefined; });
    return running;
  }
  private async runDispatch(): Promise<void> {
    const queue = this.queue;
    let expired = false, closing: Promise<void> | undefined;
    const stop = () => { expired = true; closing ??= queue.close(); void closing.catch(() => {}); };
    const deadline = setTimeout(stop, QUEUE_DISPATCH_TIMEOUT_MS); deadline.unref();
    const assertOpen = () => { if (expired || this.closed) throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'Companion notifications could not be confirmed.'); };
    try {
      await this.entry.db.withBoundedTransaction(async client => {
        await client.query("SET LOCAL statement_timeout='2000ms'");
        await client.query("SET LOCAL lock_timeout='250ms'");
        const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', [`companion-outbox:${this.entry.config.queueName}`]);
        if (!lock.rows[0].acquired) return;
        const rows = (await client.query<{ request_id: string; task_id: string }>(`SELECT o.request_id,o.task_id
          FROM platform_companion_generation_outbox o
          JOIN platform_companion_generation_requests r ON r.id=o.request_id AND r.user_id=o.user_id AND r.task_id=o.task_id
          JOIN platform_companion_generation_tasks t ON t.id=r.task_id AND t.user_id=r.user_id AND t.companion_id=r.companion_id
          LEFT JOIN platform_runtime_leases l ON l.id=t.runtime_lease_id AND l.user_id=t.user_id AND l.kind='background'
          WHERE (t.status IN ('pending','failed','interrupted') OR t.status='running'
            AND (t.lease_until<=clock_timestamp() OR l.id IS NULL OR l.expires_at<=clock_timestamp()))
          AND (o.held_reason IS NULL OR o.held_reason='configuration')
          AND (o.dispatched_at IS NULL OR o.dispatched_at<clock_timestamp()-$1::integer*interval '1 millisecond')
          ORDER BY o.dispatched_at ASC NULLS FIRST,o.created_at,o.request_id LIMIT 25
          FOR UPDATE OF o SKIP LOCKED`, [QUEUE_RECONCILE_INTERVAL_MS])).rows;
        for (const row of rows) {
          assertOpen();
          const notification = companionNotification({ requestId: row.request_id, taskId: row.task_id });
          const existing = await queue.getJob(row.request_id); assertOpen();
          let add = !existing;
          if (existing) {
            let actual;
            try { actual = companionNotification(existing.data); } catch { /* Isolate the untrusted notification below. */ }
            if (!actual || actual.taskId !== row.task_id || actual.requestId !== row.request_id || existing.name !== 'companion-preview') {
              await client.query(`UPDATE platform_companion_generation_outbox SET held_reason='storage',dispatched_at=clock_timestamp()
                WHERE request_id=$1 AND task_id=$2`, [row.request_id, row.task_id]);
              continue;
            }
            const state = await existing.getState(); assertOpen();
            if (['completed', 'failed', 'unknown'].includes(state)) { await existing.remove(); assertOpen(); add = true; }
            else if (!['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused'].includes(state)) {
              throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'Companion notification state could not be confirmed.');
            }
          }
          if (add) {
            await queue.add('companion-preview', notification, { jobId: row.request_id, attempts: 1,
              removeOnComplete: { age: 86400 }, removeOnFail: { age: 604800 } }); assertOpen();
          }
          await client.query('UPDATE platform_companion_generation_outbox SET dispatched_at=clock_timestamp() WHERE request_id=$1 AND task_id=$2', [row.request_id, row.task_id]);
        }
        assertOpen();
      });
    } catch (error) {
      stop(); await closing;
      if (this.producer === queue) this.producer = undefined;
      throw error instanceof ApiError ? error : new ApiError(503, 'QUEUE_UNAVAILABLE', 'Saved companion tasks will be checked when notifications recover.');
    } finally { clearTimeout(deadline); if (closing) await closing; }
  }
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.dispatch().catch(() => {}), 1000); this.timer.unref();
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    await this.producer?.close(); await this.inFlight?.catch(() => {}); await this.producer?.close();
  }
}

function holdReason(error: unknown): 'authorization' | 'configuration' | 'source_changed' | 'storage' | 'terminal' {
  if (!(error instanceof ApiError)) return 'storage';
  if (['AUTH_REQUIRED', 'STUDENT_ACCOUNT_REQUIRED', 'EMAIL_VERIFICATION_REQUIRED', 'TERMS_CONFIRMATION_REQUIRED', 'LEGAL_DOCUMENTS_UNAVAILABLE'].includes(error.code)) return 'authorization';
  if (error.code === 'COMPANION_DRAFT_SOURCE_CHANGED') return 'source_changed';
  if (['MODEL_ROUTE_UNAVAILABLE', 'COMPANION_GENERATION_BUDGET_UNAVAILABLE'].includes(error.code)) return 'configuration';
  return 'storage';
}

export function createCompanionGenerationWorker(entry: CompanionEntry): Worker {
  const worker = new Worker(companionQueueName(entry.config.queueName), async job => {
    let notification;
    try { notification = companionNotification(job.data); }
    catch { throw new Error('Companion notification could not be verified.'); }
    if (job.id !== notification.requestId || job.name !== 'companion-preview') throw new Error('Companion notification could not be verified.');
    try {
      await entry.executeNotification(notification);
      await entry.db.withBoundedTransaction(async client => {
        await client.query(`UPDATE platform_companion_generation_outbox SET held_reason=NULL
          WHERE request_id=$1 AND task_id=$2`, [notification.requestId, notification.taskId]);
      });
    } catch (error) {
      // These PostgreSQL failures reject a transaction before it commits. Leave
      // the original outbox eligible, then let its next notification recheck the
      // real accepted source and durable core recovery state. A lost connection,
      // operation deadline or unknown model outcome is not this evidence.
      if (error instanceof DatabaseError && ['55P03', '40001', '40P01'].includes(error.code ?? '')) {
        throw new Error('Companion notification is waiting for database contention to clear.');
      }
      // Hold metadata cannot authorize execution or overwrite a model result.
      // Invalid/foreign notifications affect no row; raw errors never enter Redis.
      await entry.db.withBoundedTransaction(async client => {
        await client.query(`UPDATE platform_companion_generation_outbox o SET held_reason=$3
          FROM platform_companion_generation_requests r WHERE o.request_id=r.id AND o.task_id=r.task_id
          AND o.user_id=r.user_id AND r.id=$1 AND r.task_id=$2`, [notification.requestId, notification.taskId, holdReason(error)]);
      });
    }
  }, { connection: connectionFromUrl(entry.config.redisUrl), concurrency: 2 });
  worker.on('error', () => { process.stderr.write('Companion worker connection interrupted; waiting for recovery.\n'); });
  return worker;
}

/** Money is reconciled even when the accepted session was revoked. This does
 * not read a new user session or grant source/model/publication permission.
 */
export async function reconcileCompanionAccounting(entry: CompanionEntry): Promise<void> {
  const costs = new CostGuard(entry.db);
  await entry.db.withBoundedTransaction(client => costs.reconcileInTransaction(client));
}
