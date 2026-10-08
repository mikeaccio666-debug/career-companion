import type { CompanionSealSelectionSaved, CompanionStudentJourneyState } from '@companion/platform-contracts';
import { ApiError, type BoundPlatformClient } from './api.ts';
import { parseCompanionSealSelectionInput, readCompanionJourney, readCompanionSealOperation,
  resumeCompanionNamePreparation, saveCompanionSealSelection, type CompanionSealSelectionInput } from './companion-journey-api.ts';
import { readCompanionNamingOperation } from './companion-naming-api.ts';
import type { CompanionNamingEnvironment } from './companion-naming-controller.ts';

export interface CompanionJourneyObservation {
  readonly journey: CompanionStudentJourneyState | null;
  readonly selection: CompanionSealSelectionSaved | null;
  readonly acceptance: 'idle' | 'sending' | 'saved' | 'unknown';
  readonly checking: boolean;
  readonly submitting: boolean;
  readonly error: string;
}
const environment: CompanionNamingEnvironment = {
  now: () => Date.now(), isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  operationId: () => crypto.randomUUID(), setTimer: (run, delay) => setTimeout(run, delay),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const empty = (): CompanionJourneyObservation => ({ journey: null, selection: null, acceptance: 'idle', checking: false, submitting: false, error: '' });
type SelectionIntent = Readonly<{ taskId: string; operationId: string; appliedRevision: number }>;

/** All automatic activity is observation of persisted facts. A lost response
 * retains its original own operation and cannot cause another write. */
export class CompanionJourneyController {
  private readonly client: BoundPlatformClient;
  private readonly changed: (state: CompanionJourneyObservation) => void;
  private readonly timing: CompanionNamingEnvironment;
  private live = false;
  private epoch = 0;
  private request: AbortController | null = null;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private intent: SelectionIntent | null = null;
  private preparation: string | null = null;
  private unresolved = false;
  private nextAllowedAt = 0;
  private snapshot = empty();
  constructor(client: BoundPlatformClient, changed: (state: CompanionJourneyObservation) => void,
    timing: CompanionNamingEnvironment = environment) { this.client = client; this.changed = changed; this.timing = timing; }
  private current(epoch: number, request?: AbortController) {
    return this.live && this.epoch === epoch && this.client.isCurrent() && !request?.signal.aborted;
  }
  private publish(patch: Partial<CompanionJourneyObservation>) {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch }); this.changed(this.snapshot);
  }
  private clearTimer() { if (this.timer !== null) this.timing.clearTimer(this.timer); this.timer = null; }
  private schedule(delay = 3_000) {
    this.clearTimer(); if (!this.live || !this.client.isCurrent() || !this.timing.isVisible() || !this.timing.isOnline()) return;
    const epoch = this.epoch;
    this.timer = this.timing.setTimer(() => { this.timer = null; if (this.current(epoch)) this.refresh(); },
      Math.min(24 * 60 * 60_000, Math.max(3_000, delay)));
  }
  private throttled(error: unknown): boolean {
    if (!(error instanceof ApiError) || error.status !== 429) return false;
    const delay = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs! >= 0 ? error.retryAfterMs! : 0;
    this.nextAllowedAt = this.timing.now() + Math.max(60_000, Math.min(24 * 60 * 60_000, delay));
    this.publish({ error: '暂时读取得太频繁了。稍后会重新确认进度。' }); return true;
  }
  start() {
    if (this.live || !this.client.isCurrent()) return; this.live = true; this.epoch++;
    this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent()) this.stop(); }); this.refresh();
  }
  stop() {
    this.live = false; this.epoch++; this.request?.abort(); this.request = null;
    this.clearTimer(); this.unsubscribe?.(); this.unsubscribe = null;
    if (!this.client.isCurrent()) { this.intent = null; this.preparation = null; this.unresolved = false; }
    this.snapshot = Object.freeze(empty()); this.changed(this.snapshot);
  }
  resume() { this.clearTimer(); this.refresh(); }
  refresh() {
    if (!this.live || this.request || !this.client.isCurrent() || !this.timing.isVisible() || !this.timing.isOnline()) return;
    const delay = this.nextAllowedAt - this.timing.now(); if (delay > 0) { this.schedule(delay); return; }
    this.clearTimer(); const epoch = this.epoch, request = new AbortController(); this.request = request;
    this.publish({ checking: true, error: '' }); void this.observe(epoch, request);
  }
  private match(saved: CompanionSealSelectionSaved, intent: SelectionIntent) {
    if (saved.operation.id !== intent.operationId || saved.operation.appliedRevision !== intent.appliedRevision
      || saved.selection.taskId !== intent.taskId) throw new Error('印章的提交记录暂时无法确认。');
  }
  private async observe(epoch: number, request: AbortController) {
    let retry = false;
    try {
      if (this.intent) {
        const saved = await readCompanionSealOperation(this.client, this.intent.taskId, this.intent.operationId, request.signal);
        if (!this.current(epoch, request)) return; if (saved) this.match(saved, this.intent);
        this.unresolved = saved === null;
        this.publish({ selection: saved, acceptance: saved ? 'saved' : 'unknown',
          error: saved ? '' : '这次选择还没有确认完成。可以重新读取提交记录。' });
      }
      if (this.preparation) {
        const accepted = await readCompanionNamingOperation(this.client, this.preparation, request.signal);
        if (!this.current(epoch, request)) return;
        const resolved = accepted && accepted.progress.application.status !== 'pending';
        this.unresolved = !resolved;
        if (resolved) this.preparation = null;
        this.publish({ acceptance: resolved ? 'saved' : 'unknown',
          error: resolved ? '' : '保存的名字还在确认，请重新读取进度。' });
      }
      const journey = await readCompanionJourney(this.client, request.signal);
      if (!this.current(epoch, request)) return; this.nextAllowedAt = 0; this.publish({ journey });
      const latest = journey.kind === 'journey' && journey.naming.kind === 'naming' ? journey.naming.latest : null;
      retry = this.unresolved || !!latest && latest.hold === null && ['queued', 'checking'].includes(latest.phase);
    } catch (error) {
      if (!this.current(epoch, request)) return; retry = this.throttled(error) || this.unresolved
        || error instanceof ApiError && error.status === 409 && error.code === 'COMPANION_JOURNEY_CHANGED';
      if (!this.nextAllowedAt) this.publish({ error: '主理人的准备进度暂时无法读取，可以重新读取。' });
    } finally {
      if (this.current(epoch, request) && this.request === request) {
        this.request = null; this.publish({ checking: false }); if (retry) this.schedule(this.nextAllowedAt - this.timing.now());
      }
    }
  }
  private canWrite(): boolean {
    if (!this.live || !this.client.isCurrent() || this.snapshot.submitting) return false;
    if (this.unresolved) { this.publish({ error: '上一次提交还没有确认，请先重新读取提交记录。' }); return false; }
    if (!this.timing.isVisible() || !this.timing.isOnline() || this.nextAllowedAt > this.timing.now()) {
      this.publish({ error: '暂时无法确认。你的选择还在页面里，可以稍后再试。' }); return false;
    }
    return true;
  }
  select(value: CompanionSealSelectionInput): boolean {
    if (!this.canWrite()) return false;
    const input = parseCompanionSealSelectionInput(value), command = Object.freeze({ ...input, operationId: this.timing.operationId() });
    const intent = Object.freeze({ taskId: input.taskId, operationId: command.operationId, appliedRevision: input.expectedRevision + 1 });
    this.intent = intent; this.preparation = null; this.unresolved = true;
    this.beginWrite(async signal => { const saved = await saveCompanionSealSelection(this.client, command, signal); this.match(saved, intent); return saved; });
    return true;
  }
  resumePreparation(operationId: string): boolean {
    if (!this.canWrite() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)) return false;
    this.preparation = operationId; this.intent = null; this.unresolved = true;
    this.beginWrite(async signal => { await resumeCompanionNamePreparation(this.client, operationId, signal); return null; }); return true;
  }
  private beginWrite(run: (signal: AbortSignal) => Promise<CompanionSealSelectionSaved | null>) {
    this.clearTimer(); this.request?.abort(); this.epoch++;
    const epoch = this.epoch, request = new AbortController(); this.request = request;
    this.publish({ selection: null, acceptance: 'sending', submitting: true, checking: false, error: '' });
    void (async () => {
      let limited = false;
      try {
        const saved = await run(request.signal); if (!this.current(epoch, request)) return;
        // A validated POST receipt confirms this request even when the saved
        // name still awaits preparation. A pending application is not a lost
        // transport response and must allow another explicit original-op retry.
        this.unresolved = false; this.preparation = null;
        this.publish({ acceptance: 'saved', ...(saved ? { selection: saved } : {}) });
      } catch (error) {
        if (!this.current(epoch, request)) return;
        // Only the control limiter is known to run before the actual writer.
        // An opaque 409/503 or a missing observer result cannot prove rollback.
        const knownRefusal = error instanceof ApiError && (error.status === 429 && error.code === 'REQUEST_LIMIT_REACHED'
          || this.intent !== null && error.status === 409 && ['COMPANION_IDENTITY_REVISION_CHANGED',
            'COMPANION_SEAL_SELECTION_REVISION_CHANGED'].includes(error.code ?? ''));
        if (knownRefusal) {
          this.unresolved = false; this.intent = null; this.preparation = null;
        }
        limited = this.throttled(error);
        this.publish({ acceptance: this.unresolved ? 'unknown' : 'idle',
          ...(limited ? {} : { error: '这次提交暂时没有确认完成，请重新读取提交记录。' }) });
      } finally {
        if (this.current(epoch, request) && this.request === request) {
          this.request = null; this.publish({ submitting: false });
          if (limited) this.schedule(this.nextAllowedAt - this.timing.now()); else this.refresh();
        }
      }
    })();
  }
}
