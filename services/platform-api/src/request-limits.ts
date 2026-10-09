import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Database } from './database.ts';
import { ApiError } from './errors.ts';

export type UserRequestLimitScope = 'api' | 'chat' | 'speech' | 'transcription' | 'realtime' | 'control' | 'org-knowledge' | 'account-reauth';
export type AnonymousRequestLimitScope = 'auth-login' | 'auth-register' | 'auth-email-request' | 'auth-email-consume' | 'public';
export type RequestLimitScope = UserRequestLimitScope | AnonymousRequestLimitScope;
export interface RequestLimitPolicy { max: number; windowSeconds: number; }
export interface RequestLimitDecision { allowed: boolean; remaining: number; retryAfterSeconds: number; }
export interface RequestLimitsOptions {
  /** Trusted server configuration only; request input must never select or modify a policy. */
  policies?: Partial<Record<RequestLimitScope, RequestLimitPolicy>>;
  counterTimeoutMs?: number;
  cleanupEveryRequests?: number;
  cleanupBatchSize?: number;
  cleanupTimeoutMs?: number;
}

export const DEFAULT_REQUEST_LIMIT_POLICIES: Readonly<Record<RequestLimitScope, Readonly<RequestLimitPolicy>>> = Object.freeze({
  api: Object.freeze({ max: 120, windowSeconds: 60 }),
  chat: Object.freeze({ max: 20, windowSeconds: 60 }),
  speech: Object.freeze({ max: 20, windowSeconds: 60 }),
  transcription: Object.freeze({ max: 20, windowSeconds: 60 }),
  realtime: Object.freeze({ max: 4, windowSeconds: 3600 }),
  control: Object.freeze({ max: 120, windowSeconds: 60 }),
  'account-reauth': Object.freeze({ max: 5, windowSeconds: 900 }),
  'org-knowledge': Object.freeze({ max: 60, windowSeconds: 60 }),
  'auth-login': Object.freeze({ max: 20, windowSeconds: 60 }),
  'auth-register': Object.freeze({ max: 10, windowSeconds: 60 }),
  'auth-email-request': Object.freeze({ max: 10, windowSeconds: 3600 }),
  'auth-email-consume': Object.freeze({ max: 20, windowSeconds: 60 }),
  public: Object.freeze({ max: 120, windowSeconds: 60 }),
});

const userScopes = new Set<UserRequestLimitScope>(['api', 'chat', 'speech', 'transcription', 'realtime', 'control', 'org-knowledge', 'account-reauth']);
const anonymousScopes = new Set<AnonymousRequestLimitScope>(['auth-login', 'auth-register', 'auth-email-request', 'auth-email-consume', 'public']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function unavailable() { return new ApiError(503, 'REQUEST_LIMIT_UNAVAILABLE', 'Request availability could not be confirmed. Please try again.'); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Only call with the connection's socket address, never request.ip or forwarded headers. */
function anonymousSubject(socketAddress: string) {
  if (typeof socketAddress !== 'string' || socketAddress.length > 128 || !isIP(socketAddress)) throw unavailable();
  let address = socketAddress;
  if (isIP(address) === 6) {
    // A scope id describes a local interface, not a distinct remote peer. URL normalizes IPv6 spelling.
    address = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(address);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
      address = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
  }
  return createHash('sha256').update('companion-platform-request-limits:socket-ip:v1\0').update(address).digest('hex');
}

/** Shared PostgreSQL fixed windows. The HTTP layer must authenticate before calling consumeUser. */
export class RequestLimits {
  private readonly policies: Readonly<Record<RequestLimitScope, Readonly<RequestLimitPolicy>>>;
  private readonly counterTimeoutMs: number;
  private readonly cleanupEveryRequests: number;
  private readonly cleanupBatchSize: number;
  private readonly cleanupTimeoutMs: number;
  private requestsSinceCleanup = 0;
  private cleanupPending?: Promise<void>;

  constructor(private readonly db: Pick<Database, 'transaction'>, options: RequestLimitsOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key =>
      !['policies', 'counterTimeoutMs', 'cleanupEveryRequests', 'cleanupBatchSize', 'cleanupTimeoutMs'].includes(key))) {
      throw new Error('Invalid request limit configuration.');
    }
    if (options.policies !== undefined && (!options.policies || typeof options.policies !== 'object' || Array.isArray(options.policies) ||
        Object.keys(options.policies).some(scope => !Object.hasOwn(DEFAULT_REQUEST_LIMIT_POLICIES, scope)))) {
      throw new Error('Invalid request limit policy scope.');
    }
    const policies = {} as Record<RequestLimitScope, Readonly<RequestLimitPolicy>>;
    for (const scope of Object.keys(DEFAULT_REQUEST_LIMIT_POLICIES) as RequestLimitScope[]) {
      const policy = options.policies?.[scope] === undefined ? DEFAULT_REQUEST_LIMIT_POLICIES[scope] : options.policies[scope];
      if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['max', 'windowSeconds'].includes(key)) ||
          !integer(policy.max, 1, 2_147_483_647) || !integer(policy.windowSeconds, 1, 86_400)) {
        throw new Error('Invalid request limit policy.');
      }
      policies[scope] = Object.freeze({ max: policy.max, windowSeconds: policy.windowSeconds });
    }
    this.policies = Object.freeze(policies);
    this.counterTimeoutMs = options.counterTimeoutMs === undefined ? 2000 : options.counterTimeoutMs;
    if (!integer(this.counterTimeoutMs, 50, 5000)) throw new Error('Invalid request limit counter timeout configuration.');
    this.cleanupEveryRequests = options.cleanupEveryRequests ?? 128;
    this.cleanupBatchSize = options.cleanupBatchSize ?? 256;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 1000;
    if (!integer(this.cleanupEveryRequests, 2, 10_000) || !integer(this.cleanupBatchSize, 1, 1000) || !integer(this.cleanupTimeoutMs, 1, 5000)) {
      throw new Error('Invalid request limit cleanup configuration.');
    }
  }

  async consumeUser(verifiedUserId: string, scope: UserRequestLimitScope): Promise<RequestLimitDecision> {
    if (typeof verifiedUserId !== 'string' || !uuid.test(verifiedUserId) || !userScopes.has(scope)) throw unavailable();
    return this.consume('user', verifiedUserId.toLowerCase(), scope);
  }

  async consumeAnonymous(socketAddress: string, scope: AnonymousRequestLimitScope): Promise<RequestLimitDecision> {
    if (!anonymousScopes.has(scope)) throw unavailable();
    try { return await this.consume('ip', anonymousSubject(socketAddress), scope); }
    catch { throw unavailable(); }
  }

  private async consume(subjectType: 'user' | 'ip', subjectKey: string, scope: RequestLimitScope): Promise<RequestLimitDecision> {
    try {
      await this.maybeCleanup();
      const policy = this.policies[scope];
      return await this.db.transaction(async client => {
        // PostgreSQL cancels the actual waiting statement; the transaction helper rolls it
        // back before releasing its connection, including when an external holder blocks it.
        await client.query("SELECT set_config('statement_timeout',$1,true)", [String(this.counterTimeoutMs)]);
        const accepted = await client.query(`INSERT INTO platform_request_limits AS current
            (subject_type,subject_key,scope,request_count,expires_at)
          VALUES($1,$2,$3,1,statement_timestamp()+$5*interval '1 second')
          ON CONFLICT(subject_type,subject_key,scope) DO UPDATE SET
            request_count=CASE WHEN current.expires_at <= statement_timestamp() THEN 1 ELSE current.request_count+1 END,
            expires_at=CASE WHEN current.expires_at <= statement_timestamp()
              THEN statement_timestamp()+$5*interval '1 second' ELSE current.expires_at END
          WHERE current.expires_at <= statement_timestamp() OR current.request_count < $4
          RETURNING request_count`, [subjectType, subjectKey, scope, policy.max, policy.windowSeconds]);
        if (accepted.rows.length === 1 && integer(accepted.rows[0].request_count, 1, policy.max)) {
          return { allowed: true, remaining: policy.max - accepted.rows[0].request_count, retryAfterSeconds: 0 };
        }
        if (accepted.rows.length !== 0) throw unavailable();
        // A rejected ON CONFLICT update still locks its row until COMMIT. Cleanup and other
        // requests cannot remove/change the window between this decision and its expiry read.
        const denied = await client.query(`SELECT request_count,
            GREATEST(1,CEIL(EXTRACT(EPOCH FROM expires_at-clock_timestamp())))::integer AS retry_after_seconds
          FROM platform_request_limits WHERE subject_type=$1 AND subject_key=$2 AND scope=$3`, [subjectType, subjectKey, scope]);
        const row = denied.rows[0];
        if (denied.rows.length !== 1 || !integer(row.request_count, policy.max, 2_147_483_647) ||
            !integer(row.retry_after_seconds, 1, 86_400)) throw unavailable();
        return { allowed: false, remaining: 0, retryAfterSeconds: row.retry_after_seconds };
      });
    } catch { throw unavailable(); }
  }

  private async maybeCleanup() {
    if (this.cleanupPending) return this.cleanupPending;
    if (++this.requestsSinceCleanup < this.cleanupEveryRequests) return;
    this.requestsSinceCleanup = 0;
    const pending = this.db.transaction(async client => {
      await client.query("SELECT set_config('statement_timeout',$1,true)", [String(this.cleanupTimeoutMs)]);
      await client.query(`WITH expired AS (
          SELECT subject_type,subject_key,scope FROM platform_request_limits
          WHERE expires_at <= statement_timestamp() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
        ) DELETE FROM platform_request_limits AS current USING expired
        WHERE current.subject_type=expired.subject_type AND current.subject_key=expired.subject_key AND current.scope=expired.scope`,
      [this.cleanupBatchSize]);
    }).catch(() => { /* Bounded housekeeping is best effort; counter failures still fail closed. */ });
    this.cleanupPending = pending;
    try { await pending; }
    finally { if (this.cleanupPending === pending) this.cleanupPending = undefined; }
  }
}
