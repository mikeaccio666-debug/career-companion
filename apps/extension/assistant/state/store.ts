export interface RequestScope {
  readonly epoch: number;
  readonly signal: AbortSignal;
}

/** Each owner/reset lifetime cancels its work before publishing the next state. */
export function createAssistantStore<T>(initial: T) {
  let snapshot = initial;
  let epoch = 0;
  let disposed = false;
  let abort = new AbortController();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    scope: (): RequestScope => ({ epoch, signal: abort.signal }),
    commit(scope: RequestScope, reduce: (previous: T) => T): boolean {
      if (disposed || scope.epoch !== epoch || scope.signal.aborted) return false;
      const next = reduce(snapshot);
      if (next !== snapshot) { snapshot = next; notify(); }
      return true;
    },
    reset(next: T) {
      if (disposed) return;
      abort.abort();
      abort = new AbortController();
      epoch += 1;
      snapshot = next;
      notify();
    },
    dispose() { disposed = true; abort.abort(); listeners.clear(); },
  };
}
