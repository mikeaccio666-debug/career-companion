import type { Approval, Conversation, Job, Memory } from '@companion/platform-contracts';
import { ApiError, collection } from './api.ts';

export interface AccountOperationToken { accountId: string | null; generation: number; lane?: string; sequence?: number; }
export type AccountOperationResult<T> = { status: 'applied'; value: T } | { status: 'failed'; error: unknown } | { status: 'discarded' };
export class StaleAccountOperation extends Error { constructor() { super('登录或页面状态已变化，旧操作结果已丢弃。'); this.name = 'StaleAccountOperation'; } }

export class AccountOperationScope {
  private accountId: string | null = null;
  private generation = 0;
  private live = true;
  private lanes = new Map<string, number>();
  get revision() { return this.generation; }
  get account() { return this.accountId; }
  activate() { this.live = true; ++this.generation; this.lanes.clear(); }
  dispose() { this.live = false; ++this.generation; this.lanes.clear(); }
  changeSession(accountId: string | null) { this.accountId = accountId; ++this.generation; this.lanes.clear(); }
  snapshot(lane?: string): AccountOperationToken {
    return { accountId: this.accountId, generation: this.generation, ...(lane ? { lane, sequence: this.lanes.get(lane) } : {}) };
  }
  invalidate(lane: string) { this.lanes.set(lane, (this.lanes.get(lane) || 0) + 1); }
  begin(lane?: string, authenticated = true): AccountOperationToken | undefined {
    if (!this.live || authenticated && !this.accountId) return;
    if (lane) this.invalidate(lane);
    return { ...this.snapshot(), ...(lane ? { lane, sequence: this.lanes.get(lane) } : {}) };
  }
  isCurrent(token: AccountOperationToken) {
    return this.live && token.accountId === this.accountId && token.generation === this.generation &&
      (!token.lane || token.sequence === this.lanes.get(token.lane));
  }
}

// Invalidate synchronously before React schedules any authentication or data state updates.
export function transitionAccount<T extends { id: string }>(scope: AccountOperationScope, user: T | null, reset: () => void, applyUser: (user: T | null) => void): void {
  scope.changeSession(user?.id || null); reset(); applyUser(user);
}

export async function executeAccountOperation<T>(scope: AccountOperationScope, token: AccountOperationToken, work: () => Promise<T>, callbacks: {
  apply?: (value: T) => void; onError?: (error: unknown) => void; finally?: () => void;
} = {}): Promise<AccountOperationResult<T>> {
  if (!scope.isCurrent(token)) return { status: 'discarded' };
  try {
    const value = await work();
    if (!scope.isCurrent(token)) return { status: 'discarded' };
    callbacks.apply?.(value); return { status: 'applied', value };
  } catch (error) {
    if (!scope.isCurrent(token)) return { status: 'discarded' };
    callbacks.onError?.(error); return { status: 'failed', error };
  } finally { if (scope.isCurrent(token)) callbacks.finally?.(); }
}
export function requireAccountResult<T>(result: AccountOperationResult<T>): T {
  if (result.status === 'applied') return result.value;
  if (result.status === 'failed') throw result.error;
  throw new StaleAccountOperation();
}

// Keep owned creation results, but only the latest navigation intent may select them.
export function executeAccountSelection<T>(scope: AccountOperationScope, account: AccountOperationToken, selection: AccountOperationToken, work: () => Promise<T>, callbacks: {
  remember: (value: T) => void; select: (value: T) => void; onError?: (error: unknown) => void;
}): Promise<AccountOperationResult<T>> {
  return executeAccountOperation(scope, account, work, {
    apply(value) { callbacks.remember(value); if (scope.isCurrent(selection)) callbacks.select(value); },
    onError(error) { if (scope.isCurrent(selection)) callbacks.onError?.(error); },
  });
}
export interface AccountSelectionRequest<T> { operation: Promise<T>; selection: AccountOperationToken; }
export function currentAccountSelectionRequest<T>(scope: AccountOperationScope, pending: AccountSelectionRequest<T> | null): Promise<T> | undefined {
  return pending && scope.isCurrent(pending.selection) ? pending.operation : undefined;
}

export interface AccountDataCallbacks {
  conversations: (value: Conversation[]) => void; jobs: (value: Job[]) => void;
  memories: (value: Memory[]) => void; approvals: (value: Approval[]) => void;
  onError: (error: unknown, token: AccountOperationToken) => void;
}
export async function refreshAccountData(scope: AccountOperationScope, read: (path: string) => Promise<unknown>, callbacks: AccountDataCallbacks, options: { workbench: boolean } = { workbench: false }): Promise<AccountOperationResult<PromiseSettledResult<unknown>[]>> {
  const token = scope.begin('private-refresh'); if (!token) return { status: 'discarded' };
  const workbench = options.workbench === true;
  const paths = workbench ? ['/conversations', '/jobs', '/memories', '/approvals'] : ['/conversations', '/memories'];
  return executeAccountOperation(scope, token, () => Promise.allSettled(paths.map((path) => read(path))), {
    apply(responses) {
      const failures = responses.filter((response): response is PromiseRejectedResult => response.status === 'rejected');
      const unauthorized = failures.find((response) => response.reason instanceof ApiError && response.reason.status === 401);
      if (unauthorized) { callbacks.onError(unauthorized.reason, token); return; }
      if (responses[0].status === 'fulfilled') callbacks.conversations(collection<Conversation>(responses[0].value, 'conversations'));
      if (workbench && responses[1].status === 'fulfilled') callbacks.jobs(collection<Job>(responses[1].value, 'jobs'));
      const memories = responses[workbench ? 2 : 1];
      if (memories.status === 'fulfilled') callbacks.memories(collection<Memory>(memories.value, 'memories'));
      if (workbench && responses[3].status === 'fulfilled') callbacks.approvals(collection<Approval>(responses[3].value, 'approvals'));
      if (failures.length) callbacks.onError(failures[0].reason, token);
    },
    onError: (error) => callbacks.onError(error, token),
  });
}
