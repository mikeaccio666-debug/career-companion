import { parseCompanionBirthCommand, parseCompanionBirthIdempotencyKey,
  type CompanionBirthRequest, type CompanionBirthViewerState, type PublicCompanionBirthReceipt } from '@companion/platform-contracts';
import { ApiError, type BoundPlatformClient } from './api.ts';
import { readCompanionBirth, readCompanionBirthReceipt, saveCompanionBirth } from './companion-birth-api.ts';
import type { CompanionNamingEnvironment } from './companion-naming-controller.ts';

export interface CompanionBirthObservation {
  readonly viewer: CompanionBirthViewerState | null;
  readonly receipt: PublicCompanionBirthReceipt | null;
  readonly acceptance: 'idle' | 'sending' | 'saved' | 'unknown';
  readonly checking: boolean;
  readonly submitting: boolean;
  readonly error: string;
}
export interface CompanionBirthIntentStore {
  read(accountId: string): string | null;
  write(accountId: string, key: string): void;
  remove(accountId: string): void;
}
/** Only an opaque operation ID survives a page reload. No name, answer, receipt,
 * session secret or permission is stored. The server authenticates every read. */
export const sessionBirthIntents: CompanionBirthIntentStore = {
  read: account => sessionStorage.getItem('companion.birth.pending.v1:' + account),
  write: (account, key) => sessionStorage.setItem('companion.birth.pending.v1:' + account, key),
  remove: account => sessionStorage.removeItem('companion.birth.pending.v1:' + account),
};
const environment: CompanionNamingEnvironment = {
  now: () => Date.now(), isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false, operationId: () => crypto.randomUUID(),
  setTimer: (run, delay) => setTimeout(run, delay), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
export const emptyCompanionBirth = (): CompanionBirthObservation => ({ viewer: null, receipt: null,
  acceptance: 'idle', checking: false, submitting: false, error: '' });

/** Lifecycle, reconnect and receipt recovery are GET-only. An explicit retry
 * retains the original key; an absent receipt never proves that a POST failed. */
export class CompanionBirthController {
  private live = false;
  private epoch = 0;
  private request: AbortController | null = null;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private key: string | null = null;
  private nextAllowedAt = 0;
  private actionError = '';
  private snapshot = emptyCompanionBirth();
  private readonly client: BoundPlatformClient;
  private readonly changed: (value: CompanionBirthObservation) => void;
  private readonly timing: CompanionNamingEnvironment;
  private readonly intents: CompanionBirthIntentStore;
  constructor(client: BoundPlatformClient, changed: (value: CompanionBirthObservation) => void,
    timing: CompanionNamingEnvironment = environment, intents: CompanionBirthIntentStore = sessionBirthIntents) {
    this.client = client; this.changed = changed; this.timing = timing; this.intents = intents;
  }
  private current(epoch: number, request?: AbortController) {
    return this.live && epoch === this.epoch && this.client.isCurrent() && !request?.signal.aborted;
  }
  private publish(patch: Partial<CompanionBirthObservation>) { this.snapshot = Object.freeze({ ...this.snapshot, ...patch }); this.changed(this.snapshot); }
  private clearTimer() { if (this.timer !== null) this.timing.clearTimer(this.timer); this.timer = null; }
  private schedule() {
    this.clearTimer(); if (!this.live || !this.client.isCurrent() || !this.timing.isVisible() || !this.timing.isOnline()) return;
    const epoch = this.epoch;
    this.timer = this.timing.setTimer(() => { this.timer = null; if (this.current(epoch)) this.refresh(); },
      Math.max(3000, this.nextAllowedAt - this.timing.now()));
  }
  private quota(error: unknown) {
    if (!(error instanceof ApiError) || error.status !== 429) return false;
    this.nextAllowedAt = this.timing.now() + Math.max(60000, Math.min(86400000, error.retryAfterMs ?? 0));
    return true;
  }
  start() {
    if (this.live || !this.client.isCurrent()) return;
    this.live = true; this.epoch++;
    if (!this.key) { try { const saved = this.intents.read(this.client.account.accountId); if (saved) this.key = parseCompanionBirthIdempotencyKey(saved); } catch { /* Reads remain available if session storage is disabled or corrupt. */ } }
    this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent()) this.stop(); });
    this.refresh();
  }
  stop() {
    this.live = false; this.epoch++; this.request?.abort(); this.request = null; this.clearTimer();
    this.unsubscribe?.(); this.unsubscribe = null;
    if (!this.client.isCurrent()) this.key = null;
    this.actionError = ''; this.snapshot = Object.freeze(emptyCompanionBirth()); this.changed(this.snapshot);
  }
  resume() { this.clearTimer(); this.refresh(); }
  refresh() {
    if (!this.live || this.request || !this.client.isCurrent() || !this.timing.isVisible() || !this.timing.isOnline()) return;
    if (this.nextAllowedAt > this.timing.now()) { this.schedule(); return; }
    this.clearTimer(); const epoch = this.epoch, request = new AbortController(); this.request = request;
    this.publish({ checking: true, error: this.actionError }); void this.observe(epoch, request);
  }
  private async observe(epoch: number, request: AbortController) {
    let retry = false;
    try {
      if (this.key) {
        const saved = await readCompanionBirthReceipt(this.client, this.key, request.signal); if (!this.current(epoch, request)) return;
        this.publish({ receipt: saved.kind === 'found' ? saved.receipt : null, acceptance: saved.kind === 'found' ? 'saved' : 'unknown' });
        retry = saved.kind === 'not_found';
      }
      const viewer = await readCompanionBirth(this.client, request.signal); if (!this.current(epoch, request)) return;
      this.nextAllowedAt = 0; this.publish({ viewer });
      // A companion committed from another device is independently observable.
      // An old receipt never authorizes or substitutes for the current room.
      if (viewer.kind === 'active') retry = false;
      if (retry) this.publish({ error: '这次诞生的结果还没有确认。可以读取原记录，或用原来的确认重试。' });
    } catch (error) {
      if (!this.current(epoch, request)) return; retry = this.quota(error) || this.key !== null;
      this.publish({ error: '诞生进度暂时无法读取。已保存的名字和印章字还在，可以稍后继续。' });
    } finally {
      if (this.current(epoch, request) && this.request === request) { this.request = null; this.publish({ checking: false }); if (retry) this.schedule(); }
    }
  }
  submit(value: CompanionBirthRequest): boolean { return this.write(value, false); }
  retry(value: CompanionBirthRequest): boolean { return this.write(value, true); }
  private write(value: CompanionBirthRequest, retry: boolean): boolean {
    if (!this.live || !this.client.isCurrent() || this.snapshot.submitting || this.snapshot.viewer?.kind !== 'not_born'
      || !this.timing.isVisible() || !this.timing.isOnline() || this.nextAllowedAt > this.timing.now()) return false;
    if (retry ? !this.key || this.snapshot.acceptance !== 'unknown' : this.snapshot.acceptance === 'unknown') return false;
    const key = retry ? this.key! : this.timing.operationId(), command = parseCompanionBirthCommand(value, key);
    try { this.intents.write(this.client.account.accountId, key); }
    catch { this.publish({ error: '这次确认暂时无法准备，请稍后再试。' }); return false; }
    this.key = key; this.actionError = ''; this.clearTimer(); this.request?.abort(); const epoch = ++this.epoch, request = new AbortController(); this.request = request;
    this.publish({ acceptance: 'sending', receipt: null, submitting: true, checking: false, error: '' });
    void (async () => {
      try {
        const saved = await saveCompanionBirth(this.client, command, request.signal); if (!this.current(epoch, request)) return;
        this.publish({ receipt: saved.receipt, acceptance: 'saved' });
      } catch (error) {
        if (!this.current(epoch, request)) return;
        // These exact refusals precede the birth writer. Unknown failures and
        // ambiguous commit acknowledgements keep their original operation key.
        const refused = error instanceof ApiError && (error.status === 429 && error.code === 'REQUEST_LIMIT_REACHED'
          || error.status === 503 && error.code === 'COMPANION_SEAL_GLYPH_UNAVAILABLE');
        if (refused) { try { this.intents.remove(this.client.account.accountId); this.key = null; } catch { /* Retain key if removal fails. */ } }
        const limited = this.quota(error);
        this.actionError = limited ? '请稍后再确认诞生。'
          : refused ? '印章暂时无法准备。名字和印章字已经保存，可以稍后再试。' : '这次诞生还没有确认，请读取原记录后继续。';
        this.publish({ acceptance: this.key ? 'unknown' : 'idle', error: this.actionError });
      } finally {
        if (this.current(epoch, request) && this.request === request) { this.request = null; this.publish({ submitting: false });
          if (this.nextAllowedAt > this.timing.now()) this.schedule(); else this.refresh(); }
      }
    })(); return true;
  }
}
