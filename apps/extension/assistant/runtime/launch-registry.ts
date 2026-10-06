import { parseUuid } from '@edaix/contracts';
import type { AssistantLaunch } from './frame-admission';

interface SessionStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Browser-session routing only: no credentials, owner state, or profile cache.
 * storage.session stays private to trusted extension contexts (its default).
 * A restored entry still needs live browser frame checks and fresh Auth attestation.
 */
interface AssistantLayoutLaunch extends AssistantLaunch { readonly layoutNonce: string }

export function createAssistantLaunchRegistry(store: SessionStore, frameBase: string) {
  const memory = new Map<number, AssistantLayoutLaunch>(), revisions = new Map<number, number>();
  const pending = new Map<number, Promise<void>>();
  const key = (tabId: number) => `assistantLaunchV1:${tabId}`;
  const revision = (tabId: number) => revisions.get(tabId) ?? 0;
  const invalidate = (tabId: number) => { memory.delete(tabId); revisions.set(tabId, revision(tabId) + 1); };
  function enqueue(tabId: number, operation: () => Promise<void>) {
    // A failed earlier operation must not prevent a later explicit removal.
    const task = (pending.get(tabId) ?? Promise.resolve()).then(operation, operation);
    pending.set(tabId, task);
    return task;
  }
  function parse(value: unknown, tabId: number): AssistantLayoutLaunch | undefined {
    if (!Number.isSafeInteger(tabId) || tabId < 0 || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const v = value as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'frameUrl,layoutNonce,tabId,topDocumentId,topUrl' || v.tabId !== tabId || !parseUuid(v.layoutNonce) ||
      typeof v.topDocumentId !== 'string' || !v.topDocumentId || v.topDocumentId.length > 128 ||
      typeof v.topUrl !== 'string' || v.topUrl.length > 8192 || typeof v.frameUrl !== 'string' ||
      !v.frameUrl.startsWith(frameBase + '?launch=') ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.frameUrl.slice(frameBase.length + 8))) return;
    try {
      const url = new URL(v.topUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    } catch { return; }
    return v as unknown as AssistantLayoutLaunch;
  }
  return {
    peek: (tabId: number) => memory.get(tabId),
    async get(tabId: number): Promise<AssistantLayoutLaunch | undefined> {
      const cached = memory.get(tabId); if (cached) return cached;
      const epoch = revision(tabId);
      await pending.get(tabId);
      const value = parse((await store.get(key(tabId)))[key(tabId)], tabId);
      if (revision(tabId) !== epoch) return;
      // Concurrent ports must share the same current registration object.
      const current = memory.get(tabId); if (current) return current;
      if (value) memory.set(tabId, value);
      return value;
    },
    async set(launch: AssistantLayoutLaunch): Promise<boolean> {
      if (!parse(launch, launch.tabId)) return false;
      invalidate(launch.tabId); const epoch = revision(launch.tabId);
      await enqueue(launch.tabId, () => store.set({ [key(launch.tabId)]: launch }));
      if (revision(launch.tabId) !== epoch) return false;
      memory.set(launch.tabId, launch); return true;
    },
    async delete(tabId: number): Promise<void> {
      invalidate(tabId); await enqueue(tabId, () => store.remove(key(tabId)));
    },
  };
}
