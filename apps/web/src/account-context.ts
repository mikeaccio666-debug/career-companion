import { platformAccountId } from '@companion/platform-contracts';

export interface CapturedAccount { readonly accountId: string; readonly generation: number; }
export interface AccountRequestSnapshot { readonly accountId: string | null; readonly generation: number; }
export type AccountInvalidationReason = 'external-auth-change' | 'account-context-changed' | 'account-context-required' | 'authentication-required' | 'local-auth-change';
export interface AccountRequestLease {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  wait<T>(work: Promise<T>): Promise<T>;
  dispose(): void;
}
export class AccountRequestInvalidated extends Error {
  readonly code = 'ACCOUNT_CONTEXT_CHANGED';
  constructor() { super('登录状态已变化，请重新确认账号后继续。'); this.name = 'AbortError'; }
}

/** Window-local intent only. The cookie, never this value, authenticates a request. */
export class AccountRequestContext {
  private current: AccountRequestSnapshot = Object.freeze({ accountId: null, generation: 0 });
  private controllers = new Set<AbortController>();
  private listeners = new Set<() => void>();
  private invalidations = new Set<(reason: AccountInvalidationReason) => void>();
  getSnapshot = (): AccountRequestSnapshot => this.current;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  subscribeInvalidation = (listener: (reason: AccountInvalidationReason) => void): (() => void) => { this.invalidations.add(listener); return () => this.invalidations.delete(listener); };
  capture(): CapturedAccount | undefined {
    return this.current.accountId ? Object.freeze({ accountId: this.current.accountId, generation: this.current.generation }) : undefined;
  }
  isCurrent(account: CapturedAccount): boolean {
    return platformAccountId(account.accountId) && account.accountId === this.current.accountId && account.generation === this.current.generation;
  }
  changeSession(accountId: string | null): AccountRequestSnapshot {
    if (accountId !== null && !platformAccountId(accountId)) throw new Error('账号上下文无效。');
    return this.change(accountId);
  }
  invalidate(reason: AccountInvalidationReason = 'local-auth-change'): void {
    this.change(null);
    for (const listener of [...this.invalidations]) listener(reason);
  }
  private change(accountId: string | null): AccountRequestSnapshot {
    this.current = Object.freeze({ accountId, generation: this.current.generation + 1 });
    const controllers = [...this.controllers]; this.controllers.clear();
    for (const controller of controllers) controller.abort(new AccountRequestInvalidated());
    for (const listener of [...this.listeners]) listener();
    return this.current;
  }
  lease(account: CapturedAccount, external?: AbortSignal | null): AccountRequestLease {
    if (!this.isCurrent(account)) throw new AccountRequestInvalidated();
    external?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(external?.reason);
    external?.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    let disposed = false;
    const assertCurrent = () => { controller.signal.throwIfAborted(); if (disposed || !this.isCurrent(account)) throw new AccountRequestInvalidated(); };
    return {
      signal: controller.signal,
      assertCurrent,
      wait<T>(work: Promise<T>): Promise<T> {
        try { assertCurrent(); } catch (error) { void work.catch(() => {}); return Promise.reject(error); }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => { controller.signal.removeEventListener('abort', onAbort); reject(controller.signal.reason ?? new AccountRequestInvalidated()); };
          controller.signal.addEventListener('abort', onAbort, { once: true });
          work.then((value) => { try { assertCurrent(); resolve(value); } catch (error) { reject(error); } }, reject)
            .finally(() => controller.signal.removeEventListener('abort', onAbort));
        });
      },
      dispose: () => { if (disposed) return; disposed = true; external?.removeEventListener('abort', abort); this.controllers.delete(controller); },
    };
  }
}

export const platformAccountContext = new AccountRequestContext();
