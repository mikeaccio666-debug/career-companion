import { Queue, RedisConnection, type RedisOptions } from 'bullmq';

export const QUEUE_DISPATCH_TIMEOUT_MS = 5_000;
export const QUEUE_RECONCILE_INTERVAL_MS = 15_000;

/** Producers fail within a deadline; blocking workers keep their independent reconnect policy. */
export function connectionFromUrl(value: string, role: 'producer' | 'worker' = 'worker'): RedisOptions {
  const url = new URL(value);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Invalid Redis URL');
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.slice(1) || 0),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    ...(role === 'worker' ? { maxRetriesPerRequest: null } : {
      maxRetriesPerRequest: 1, enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
      connectTimeout: 1_500, commandTimeout: 1_500,
      retryStrategy: (attempt: number) => attempt <= 2 ? attempt * 100 : null,
    }),
  };
}

/** BullMQ exposes a Connection extension point. Force-close never queues QUIT behind a hung command. */
class ProducerConnection extends RedisConnection {
  override close(): Promise<void> { return super.close(true); }
}
export class ProducerQueue extends Queue {
  constructor(name: string, url: string) {
    super(name, { connection: connectionFromUrl(url, 'producer') }, ProducerConnection);
    // Connection errors are surfaced through dispatch's safe error, without raw Redis credentials in logs.
    this.on('error', () => {});
  }
}
