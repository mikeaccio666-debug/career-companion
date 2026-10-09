export interface JourneyAccount {
  isCurrent(): boolean;
  subscribe(change: () => void): () => void;
}
export interface JourneySectionState<T> {
  readonly value: T | null;
  readonly busy: boolean;
  readonly failed: boolean;
}
export type JourneyRead<T> = (signal: AbortSignal) => Promise<T>;
const empty = <T>(): JourneySectionState<T> => Object.freeze({ value: null, busy: false, failed: false });

/** A section owns one bounded read. Failure never invents an empty collection,
 * and an old account, page or timeout cannot publish a late result. */
export class JourneySectionController<T> {
  private state = empty<T>();
  private live = false;
  private generation = 0;
  private active: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly account: JourneyAccount;
  private readonly read: JourneyRead<T>;
  private readonly change: (state: JourneySectionState<T>) => void;
  private readonly timeoutMs: number;
  constructor(
    account: JourneyAccount,
    read: JourneyRead<T>,
    change: (state: JourneySectionState<T>) => void,
    timeoutMs = 10000,
  ) { this.account = account; this.read = read; this.change = change; this.timeoutMs = timeoutMs; }
  snapshot() { return this.state; }
  private current(generation = this.generation) { return this.live && this.account.isCurrent() && generation === this.generation; }
  private publish(value: JourneySectionState<T>) { this.state = Object.freeze(value); this.change(this.state); }
  start() {
    if (this.live || !this.account.isCurrent()) return;
    this.live = true;
    this.unsubscribe = this.account.subscribe(() => { if (!this.account.isCurrent()) this.stop(); });
    void this.refresh();
  }
  stop() {
    this.live = false; this.generation++;
    this.active?.abort(); this.active = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.publish(empty<T>());
  }
  async refresh() {
    if (!this.current() || this.active) return;
    const generation = ++this.generation, controller = new AbortController();
    this.active = controller;
    this.publish({ value: null, busy: true, failed: false });
    let rejectAbort: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new DOMException('Interrupted', 'AbortError')); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const value = await Promise.race([this.read(controller.signal), interrupted]);
      if (this.current(generation) && !controller.signal.aborted) this.publish({ value, busy: false, failed: false });
    } catch {
      if (this.current(generation)) this.publish({ value: null, busy: false, failed: true });
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort);
      if (this.active === controller) this.active = null;
    }
  }
}
