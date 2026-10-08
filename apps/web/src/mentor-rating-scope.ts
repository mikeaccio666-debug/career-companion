import { careerRecordId } from '@companion/platform-contracts';
import { MentorRatingController, type MentorRatingSnapshot } from './mentor-rating-controller.ts';
import type { MentorControllerClient } from './mentor-intent-controller.ts';

interface Entry { controller: MentorRatingController; listeners: Set<(s: MentorRatingSnapshot) => void>; }
export interface PendingMentorFeedback { readonly sessionId: string; readonly state: MentorRatingSnapshot; }
const empty: readonly PendingMentorFeedback[] = Object.freeze([]);
/** Page/account lifetime, independent of a temporarily missing history card.
 * Only unfinished submissions survive card removal. Nothing is persisted in
 * browser storage and resuming never repeats a write. */
export class MentorRatingScope {
  private readonly client: MentorControllerClient;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;
  private live = false;
  private suspended = false;
  private unsubscribe: (() => void) | null = null;
  private pending: readonly PendingMentorFeedback[] = empty;
  constructor(client: MentorControllerClient, timeoutMs = 8000) { this.client = client; this.timeoutMs = timeoutMs; }
  snapshot = () => this.pending;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() {
    this.pending = Object.freeze([...this.entries].flatMap(([sessionId, entry]) => entry.controller.snapshot().pending
      ? [Object.freeze({ sessionId, state: entry.controller.snapshot() })] : []));
    for (const listener of [...this.listeners]) listener();
  }
  private discard(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry) return;
    this.entries.delete(id); entry.controller.stop(); this.publish();
  }
  attach(id: string, changed: (state: MentorRatingSnapshot) => void): () => void {
    id = careerRecordId(id);
    if (!this.client.isCurrent()) return () => {};
    let entry = this.entries.get(id);
    if (!entry) {
      const listeners = new Set<(s: MentorRatingSnapshot) => void>();
      const created: Entry = { listeners, controller: new MentorRatingController(this.client, id, state => {
        if (this.entries.get(id) !== created) return;
        for (const listener of [...listeners]) listener(state);
        if (!listeners.size && !state.pending) this.discard(id, created); else this.publish();
      }, this.timeoutMs) };
      this.entries.set(id, created); entry = created;
    }
    entry.listeners.add(changed); changed(entry.controller.snapshot());
    if (this.live) { entry.controller.start(this.suspended); }
    const captured = entry;
    return () => { captured.listeners.delete(changed); if (!captured.listeners.size && !captured.controller.snapshot().pending) this.discard(id, captured); };
  }
  controller(id: string) { return this.entries.get(id)?.controller ?? null; }
  start(suspended = false) {
    if (this.live || !this.client.isCurrent()) return;
    this.live = true; this.suspended = suspended;
    this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent()) this.stop(); });
    for (const entry of this.entries.values()) entry.controller.start(this.suspended);
  }
  suspend() {
    if (!this.live || !this.client.isCurrent()) return;
    this.suspended = true;
    for (const entry of [...this.entries.values()]) entry.controller.suspend();
  }
  resume() {
    if (!this.live || !this.client.isCurrent()) return;
    this.suspended = false;
    for (const entry of [...this.entries.values()]) entry.controller.resume();
  }
  stop() {
    this.live = false; this.suspended = false; this.unsubscribe?.(); this.unsubscribe = null;
    const entries = [...this.entries.values()]; this.entries.clear();
    for (const entry of entries) { entry.controller.stop(); for (const listener of [...entry.listeners]) listener(entry.controller.snapshot()); }
    this.publish();
  }
}
