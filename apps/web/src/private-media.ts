export interface PrivateResourceAccount {
  isCurrent(): boolean;
  subscribe(listener: () => void): () => void;
}

const release = (work: () => void) => { try { work(); } catch { /* One browser resource must not prevent another from being detached. */ } };

/** A rendered resource belongs to this capture, even if the window later learns about another account. */
export function holdPrivateResource(account: PrivateResourceAccount | null, dispose: () => void): () => void {
  let stopped = false, unsubscribe = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    release(unsubscribe);
    release(dispose);
  };
  if (!account?.isCurrent()) { stop(); return stop; }
  const disconnect = account.subscribe(() => { if (!account.isCurrent()) stop(); });
  // A subscription may synchronously report invalidation before returning its disposer.
  if (stopped) release(disconnect); else unsubscribe = disconnect;
  if (!account.isCurrent()) stop();
  return stop;
}

export function clearPrivateMedia(element: { pause(): void; removeAttribute(name: string): void; load(): void }): void {
  release(() => element.pause());
  release(() => element.removeAttribute('src'));
  release(() => element.load());
}

export function clearPrivateImage(element: { removeAttribute(name: string): void }): void {
  release(() => element.removeAttribute('src'));
  release(() => element.removeAttribute('srcset'));
}

/** Each effect setup restores its captured source after installing the invalidation guard.
 * Cleanup may run before another setup on the same DOM node in React StrictMode. */
export function holdPrivateImage(account: PrivateResourceAccount | null, element: {
  src: string; crossOrigin: string | null; removeAttribute(name: string): void;
}, source: string | undefined): () => void {
  let active = true;
  const stop = holdPrivateResource(account, () => { active = false; clearPrivateImage(element); });
  if (!source) { stop(); return stop; }
  if (active && source && account?.isCurrent()) {
    try {
      element.crossOrigin = 'use-credentials';
      if (active && account.isCurrent()) element.src = source;
      // Recheck after browser property setters; a synchronously invalidated capture stays detached.
      if (!account.isCurrent()) stop();
    } catch { stop(); }
  }
  return stop;
}
