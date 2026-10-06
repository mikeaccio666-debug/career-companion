import { platformAccountContext, type AccountRequestContext } from './account-context.ts';

const message = Object.freeze({ type: 'authChanged' as const });
export const AUTH_COORDINATION_CHANNEL = 'companion-auth-change-v1';
export const AUTH_COORDINATION_STORAGE_KEY = 'companion-auth-change-v1';
export interface AuthCoordinationPorts {
  subscribeChannel?(receive: (value: unknown) => void): () => void;
  postChannel?(value: { readonly type: 'authChanged' }): void;
  subscribeStorage(receive: (value: string | null) => void): () => void;
  notifyStorage(value: string): void;
  close?(): void;
}
function authChanged(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && (value as { type?: unknown }).type === 'authChanged';
}

/** Broadcast carries invalidation only; it cannot select an account or authorize a request. */
export function createAuthCoordination(context: AccountRequestContext, ports: AuthCoordinationPorts) {
  let live = true;
  const receive = (value: unknown) => { if (live && authChanged(value)) context.invalidate('external-auth-change'); };
  const offChannel = ports.subscribeChannel?.(receive);
  const offStorage = ports.subscribeStorage((value) => { if (!value) return; try { receive(JSON.parse(value)); } catch { /* Malformed notifications never change identity. */ } });
  return {
    notifyLocalAuthChanged(): void {
      if (!live) return;
      // Sending never clears the fresh user established by this window's actual auth response.
      if (ports.postChannel) { try { ports.postChannel(message); return; } catch { /* Storage is a notification-only fallback. */ } }
      try { ports.notifyStorage(JSON.stringify(message)); } catch { /* Unavailable storage does not fabricate another session. */ }
    },
    dispose(): void { if (!live) return; live = false; offChannel?.(); offStorage(); ports.close?.(); },
  };
}

/** Browser ports are created explicitly, never while importing the module or running SSR tests. */
export function startBrowserAuthCoordination(context: AccountRequestContext = platformAccountContext) {
  if (typeof window === 'undefined') return createAuthCoordination(context, { subscribeStorage: () => () => {}, notifyStorage: () => {} });
  let channel: BroadcastChannel | undefined;
  try { if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(AUTH_COORDINATION_CHANNEL); } catch { /* Use the storage notification fallback. */ }
  return createAuthCoordination(context, {
    ...(channel ? {
      subscribeChannel(receive: (value: unknown) => void) { const listener = (event: MessageEvent) => receive(event.data); channel!.addEventListener('message', listener); return () => channel!.removeEventListener('message', listener); },
      postChannel(value: { readonly type: 'authChanged' }) { channel!.postMessage(value); },
    } : {}),
    subscribeStorage(receive) {
      const listener = (event: StorageEvent) => {
        if (event.key !== AUTH_COORDINATION_STORAGE_KEY) return;
        try { if (event.storageArea !== window.localStorage) return; } catch { return; }
        receive(event.newValue);
      };
      window.addEventListener('storage', listener); return () => window.removeEventListener('storage', listener);
    },
    notifyStorage(value) { window.localStorage.setItem(AUTH_COORDINATION_STORAGE_KEY, value); window.localStorage.removeItem(AUTH_COORDINATION_STORAGE_KEY); },
    close() { channel?.close(); },
  });
}
