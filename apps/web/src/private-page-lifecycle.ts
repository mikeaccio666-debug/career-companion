export interface PrivatePageController {
  start(suspended?: boolean): void;
  suspend(): void;
  resume(): void;
  stop(): void;
}
type EventSource = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** Browser lifecycle only. Controllers retain unknown commands in memory and
 * own account binding; resuming observation never retries a mutation. */
export function bindPrivatePageLifecycle(
  controller: PrivatePageController,
  windowEvents: EventSource,
  page: EventSource & { readonly visibilityState: string },
  online: () => boolean,
) {
  let live = true;
  const available = () => online() && page.visibilityState === 'visible';
  let active = available();
  const sync = () => {
    if (!live) return;
    const next = available();
    if (next === active) return;
    active = next;
    if (active) controller.resume(); else controller.suspend();
  };
  windowEvents.addEventListener('offline', sync);
  windowEvents.addEventListener('online', sync);
  page.addEventListener('visibilitychange', sync);
  controller.start(!active);
  return Object.freeze({
    /** A saved preference invalidates the current read even without a lifecycle
     * transition. Hidden/offline pages wait for their next visible online read. */
    refresh() {
      if (!live) return;
      const before = active;
      sync();
      if (active && before) { controller.suspend(); controller.resume(); }
    },
    dispose() {
      if (!live) return;
      live = false;
      windowEvents.removeEventListener('offline', sync);
      windowEvents.removeEventListener('online', sync);
      page.removeEventListener('visibilitychange', sync);
      controller.stop();
    },
  });
}
