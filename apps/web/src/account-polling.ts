import { ApiError } from './api.ts';
import type { AccountOperationResult } from './account-operations.ts';

export const ACCOUNT_POLL_INTERVAL_MS = 12_000;
export const ACCOUNT_POLL_MIN_BACKOFF_MS = 60_000;
export const ACCOUNT_POLL_MAX_BACKOFF_MS = 5 * 60_000;
// Longer server deadlines are revisited in bounded timer segments, never shortened.
export const ACCOUNT_POLL_MAX_TIMER_DELAY_MS = 24 * 60 * 60_000;
export type AccountRefreshResult = AccountOperationResult<PromiseSettledResult<unknown>[]>;
export interface AccountPollingEnvironment {
  now: () => number;
  isVisible: () => boolean;
  isOnline: () => boolean;
  isCurrent: () => boolean;
  setTimer: (run: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

function throttledErrors(result: AccountRefreshResult): ApiError[] {
  const errors = result.status === 'failed' ? [result.error] : result.status === 'applied' ? result.value.filter((row): row is PromiseRejectedResult => row.status === 'rejected').map((row) => row.reason) : [];
  return errors.filter((error): error is ApiError => error instanceof ApiError && error.status === 429);
}

/** One account-session loop. The existing account scope still owns every state application. */
export class AccountPollingController {
  private work: () => Promise<AccountRefreshResult>;
  private environment: AccountPollingEnvironment;
  private live = false;
  private flight: Promise<void> | null = null;
  private timer: unknown = null;
  private manualPending = false;
  private waiters: Array<() => void> = [];
  private throttleCount = 0;
  private nextAllowedAt = 0;
  constructor(work: () => Promise<AccountRefreshResult>, environment: AccountPollingEnvironment) { this.work = work; this.environment = environment; }
  private current() { return this.live && this.environment.isCurrent(); }
  start() { this.live = true; this.resume(); }
  stop() { this.live = false; this.cancelTimer(); this.manualPending = false; for (const done of this.waiters.splice(0)) done(); }
  private cancelTimer() { if (this.timer !== null) this.environment.clearTimer(this.timer); this.timer = null; }
  private schedule(delay: number) {
    this.cancelTimer();
    if (!this.current() || !this.environment.isOnline() || !this.environment.isVisible() && !this.manualPending) return;
    this.timer = this.environment.setTimer(() => { this.timer = null; this.wake(); }, Math.min(ACCOUNT_POLL_MAX_TIMER_DELAY_MS, Math.max(0, delay)));
  }
  /** Called on visibility and network changes; becoming visible supplements the skipped hidden refresh. */
  resume() { this.cancelTimer(); this.wake(); }
  /** Active operations coalesce behind an in-flight read and still receive a subsequent fresh batch. */
  refreshNow(): Promise<void> {
    if (!this.current()) return Promise.resolve();
    this.manualPending = true;
    const finished = new Promise<void>((resolve) => this.waiters.push(resolve));
    this.wake();
    return finished;
  }
  private wake() {
    if (!this.current()) { this.stop(); return; }
    if (this.flight || !this.environment.isOnline() || !this.environment.isVisible() && !this.manualPending) return;
    const remaining = this.nextAllowedAt - this.environment.now();
    if (remaining > 0) { this.schedule(remaining); return; }
    this.cancelTimer();
    this.manualPending = false;
    const waiters = this.waiters.splice(0);
    // Assign the flight before work starts, so synchronous callbacks cannot start a duplicate batch.
    this.flight = Promise.resolve().then(() => this.current() ? this.work() : { status: 'discarded' } as AccountRefreshResult)
      .catch((error): AccountRefreshResult => ({ status: 'failed', error }))
      .then((result) => {
        if (!this.current() || result.status === 'discarded') return;
        const throttled = throttledErrors(result);
        if (throttled.length) {
          this.throttleCount = Math.min(this.throttleCount + 1, 4);
          const fallback = Math.min(ACCOUNT_POLL_MAX_BACKOFF_MS, ACCOUNT_POLL_MIN_BACKOFF_MS * 2 ** (this.throttleCount - 1));
          const reported = Math.max(0, ...throttled.map((error) => Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs! >= 0 ? Math.min(Number.MAX_SAFE_INTEGER - this.environment.now(), error.retryAfterMs!) : 0));
          this.nextAllowedAt = this.environment.now() + Math.max(fallback, reported);
        } else if (result.status === 'applied' && result.value.every((row) => row.status === 'fulfilled')) {
          this.throttleCount = 0; this.nextAllowedAt = 0;
        }
      }).finally(() => {
        this.flight = null;
        for (const done of waiters) done();
        if (!this.current()) { this.stop(); return; }
        if (this.manualPending) this.wake();
        else this.schedule(Math.max(ACCOUNT_POLL_INTERVAL_MS, this.nextAllowedAt - this.environment.now()));
      });
  }
}
