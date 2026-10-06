/**
 * Invalidates an authorized scan after host-form structure changes without
 * turning a wide, inert content script into a continuous DOM scanner.
 *
 * Installation is deliberately explicit: after backend runtime authority and
 * the synchronous descriptor seal, production arms this before the digest
 * await. The candidate scan is exposed only if digest + semantic parity still
 * match. The observer never reads field values, logs mutations, writes the
 * host page, or initiates a rescan; kernel-owned relevance may compare the
 * current descriptor to the already-sealed baseline. It merely turns the
 * first relevant mutation batch into a one-shot dirty latch.
 * MutationObserver already batches a synchronous DOM burst; delaying the
 * invalidation again would create a window in which a stale scan could write.
 */

import type { ScanRootMutationPolicy } from '@edaix/apply-kernel/scanRoot';

export interface ScanMutationObserverLike {
  readonly observe: (target: Node, options: MutationObserverInit) => void;
  readonly disconnect: () => void;
}

export type ScanMutationObserverCallback = (
  records: readonly MutationRecord[],
) => void;

export type ScanMutationObserverFactory = (
  callback: ScanMutationObserverCallback,
) => ScanMutationObserverLike;

export interface ScanMutationThrottleHandle {
  readonly dispose: () => void;
}

export interface InstallScanMutationThrottleInput {
  /** Kernel-proven targets and mutation relevance; no selectors live here. */
  readonly policy: ScanRootMutationPolicy;
  readonly onInvalidate: () => void;
  readonly observerFactory?: ScanMutationObserverFactory;
}

const createNativeObserver: ScanMutationObserverFactory = (callback) =>
  new MutationObserver((records) => callback(records));

export function installScanMutationThrottle(
  input: InstallScanMutationThrottleInput,
): ScanMutationThrottleHandle | null {
  const targets = [...new Set(input.policy.targets)];
  if (targets.length === 0) return null;

  let disposed = false;
  let observer: ScanMutationObserverLike | null = null;

  const callback: ScanMutationObserverCallback = (records) => {
    if (disposed) return;
    let isRelevant = true;
    try {
      isRelevant = input.policy.isRelevant(records);
    } catch {
      // A relevance verdict that cannot be proven is itself an invalidation.
      isRelevant = true;
    }
    if (!isRelevant) return;
    // Dirty is an authority fact, not delayed performance work. Invalidate
    // synchronously, then disconnect in finally so one scan can fire once.
    disposed = true;
    try {
      input.onInvalidate();
    } finally {
      observer?.disconnect();
      observer = null;
    }
  };

  try {
    observer = (input.observerFactory ?? createNativeObserver)(callback);
    for (const target of targets) {
      observer.observe(target, { ...input.policy.observerOptions });
    }
  } catch {
    if (observer !== null) {
      try {
        observer.disconnect();
      } catch {
        return null;
      }
    }
    return null;
  }

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      observer = null;
    },
  };
}
