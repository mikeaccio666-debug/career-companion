import { Worker } from 'bullmq';
import { DatabaseError } from 'pg';
import { companionNameNotification } from './companion-name-dispatch-protocol.ts';
import type { CompanionNamingEntry } from './companion-naming-entry.ts';
import { ApiError } from './errors.ts';
import { ProducerQueue, connectionFromUrl, QUEUE_DISPATCH_TIMEOUT_MS, QUEUE_RECONCILE_INTERVAL_MS } from './queue-connection.ts';

export const companionNameQueueName = (name: string) => `${name}-companion-name`;

/** Redis delivers immutable database references only. Scheduling and holds are
 * notification metadata; the accepted source/journal decides real execution. */
export class CompanionNameQueue {
  private producer?: ProducerQueue;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private closed = false;
  constructor(readonly entry: CompanionNamingEntry) {}
  get queue(): ProducerQueue {
    if (this.closed) throw new ApiError(503, 'QUEUE_CLOSED', 'Naming notifications have stopped.');
    return this.producer ??= new ProducerQueue(companionNameQueueName(this.entry.config.queueName), this.entry.config.redisUrl);
  }
  dispatch(): Promise<void> {
    if (this.closed) return Promise.reject(new ApiError(503, 'QUEUE_CLOSED', 'Naming notifications have stopped.'));
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
    const assertOpen = () => { if (expired || this.closed) throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'Naming notifications could not be confirmed.'); };
    try {
      await this.entry.db.withBoundedTransaction(async client => {
        await client.query("SET LOCAL statement_timeout='2000ms'");
        await client.query("SET LOCAL lock_timeout='250ms'");
        const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', [`companion-name-outbox:${this.entry.config.queueName}`]);
        if (!lock.rows[0].acquired) return;
        const rows = (await client.query<{ dispatch_id: string; user_id: string; task_id: string; submission_id: string }>(`SELECT o.dispatch_id,o.user_id,o.task_id,o.submission_id
          FROM platform_companion_name_dispatch_outbox o
          JOIN platform_companion_name_dispatches d ON d.id=o.dispatch_id AND d.user_id=o.user_id AND d.task_id=o.task_id AND d.submission_id=o.submission_id
          JOIN platform_companion_name_submissions s ON s.id=d.submission_id AND s.user_id=d.user_id AND s.task_id=d.task_id AND s.first_name_dispatch_id=d.id
          WHERE (o.held_reason IS NULL OR o.held_reason='configuration'
            OR (o.held_reason='requires_review' AND s.status='detected'))
          AND (o.dispatched_at IS NULL OR o.dispatched_at<clock_timestamp()-$1::integer*interval '1 millisecond')
          ORDER BY o.dispatched_at ASC NULLS FIRST,o.created_at,o.dispatch_id LIMIT 25
          FOR UPDATE OF o SKIP LOCKED`, [QUEUE_RECONCILE_INTERVAL_MS])).rows;
        for (const row of rows) {
          assertOpen();
          const notification = companionNameNotification({ dispatchId: row.dispatch_id, taskId: row.task_id, submissionId: row.submission_id });
          const existing = await queue.getJob(row.dispatch_id); assertOpen();
          let add = !existing;
          if (existing) {
            let actual;
            try { actual = companionNameNotification(existing.data); } catch { /* Isolate the untrusted notification below. */ }
            if (!actual || existing.id !== row.dispatch_id || existing.name !== 'companion-name'
              || actual.dispatchId !== row.dispatch_id || actual.taskId !== row.task_id || actual.submissionId !== row.submission_id) {
              await client.query(`UPDATE platform_companion_name_dispatch_outbox SET held_reason='storage',dispatched_at=clock_timestamp()
                WHERE dispatch_id=$1 AND user_id=$2 AND task_id=$3 AND submission_id=$4`, [row.dispatch_id,row.user_id,row.task_id,row.submission_id]);
              continue;
            }
            const state = await existing.getState(); assertOpen();
            if (['completed', 'failed', 'unknown'].includes(state)) { await existing.remove(); assertOpen(); add = true; }
            else if (!['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused'].includes(state)) {
              throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'Naming notification state could not be confirmed.');
            }
          }
          if (add) {
            await queue.add('companion-name', notification, { jobId: row.dispatch_id, attempts: 1,
              removeOnComplete: { age: 86400 }, removeOnFail: { age: 604800 } }); assertOpen();
          }
          await client.query(`UPDATE platform_companion_name_dispatch_outbox SET dispatched_at=clock_timestamp()
            WHERE dispatch_id=$1 AND user_id=$2 AND task_id=$3 AND submission_id=$4`, [row.dispatch_id,row.user_id,row.task_id,row.submission_id]);
        }
        assertOpen();
      });
    } catch (error) {
      stop(); await closing?.catch(() => {});
      if (this.producer === queue) this.producer = undefined;
      throw error instanceof ApiError ? error : new ApiError(503, 'QUEUE_UNAVAILABLE', 'Saved naming tasks will be checked when notifications recover.');
    } finally { clearTimeout(deadline); if (closing) await closing.catch(() => {}); }
  }
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.dispatch().catch(() => {}), 1000); this.timer.unref();
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    const producer=this.producer;
    const results=await Promise.allSettled([producer?.close(),this.inFlight?.catch(() => {})]);
    if(results.some(result=>result.status==='rejected'))throw new ApiError(503,'QUEUE_UNAVAILABLE','Naming notification shutdown could not be confirmed.');
  }
}

export function createCompanionNameWorker(entry: CompanionNamingEntry): Worker {
  const worker = new Worker(companionNameQueueName(entry.config.queueName), async job => {
    let notification;
    try { notification = companionNameNotification(job.data); }
    catch { throw new Error('Naming notification could not be verified.'); }
    if (job.id !== notification.dispatchId || job.name !== 'companion-name') throw new Error('Naming notification could not be verified.');
    try {
      // No HTTP lifetime or newer observing session enters this execution. The
      // facade authenticates the original accepted source and owns phase holds.
      await entry.executeNotification(notification);
    } catch (error) {
      if (error instanceof DatabaseError && ['55P03', '40001', '40P01'].includes(error.code ?? '')) {
        throw new Error('Naming notification is waiting for database contention to clear.');
      }
      // A failure to save the facade's own hold cannot authorize another call.
      // Do not overwrite a genuine phase/hold or leak raw errors into Redis.
      try {
        await entry.db.withBoundedTransaction(async client => {
          await client.query(`UPDATE platform_companion_name_dispatch_outbox o SET held_reason='storage'
            FROM platform_companion_name_dispatches d WHERE o.dispatch_id=d.id AND o.user_id=d.user_id
            AND o.task_id=d.task_id AND o.submission_id=d.submission_id AND d.id=$1 AND d.task_id=$2 AND d.submission_id=$3
            AND o.held_reason IS NULL`, [notification.dispatchId,notification.taskId,notification.submissionId]);
        });
      } catch { throw new Error('Naming notification could not be confirmed.'); }
    }
  }, { connection: connectionFromUrl(entry.config.redisUrl), concurrency: 2 });
  worker.on('error', () => { process.stderr.write('Naming worker connection interrupted; waiting for recovery.\n'); });
  return worker;
}
