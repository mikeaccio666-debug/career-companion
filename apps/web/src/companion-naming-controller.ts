import type { CompanionNamingAccepted, CompanionNamingState } from '@companion/platform-contracts';
import { ApiError, type BoundPlatformClient } from './api.ts';
import { acceptCompanionNaming, parseCompanionNamingInput, parseCompanionNamingRequest, readCompanionNaming, readCompanionNamingOperation,
  type CompanionNamingInput } from './companion-naming-api.ts';

export interface CompanionNamingObservation {
  readonly state: CompanionNamingState | null;
  /** This explicit submission may differ from another device's current head. */
  readonly accepted: CompanionNamingAccepted | null;
  readonly acceptance: 'idle' | 'sending' | 'saved' | 'unknown';
  readonly checking: boolean;
  readonly submitting: boolean;
  readonly error: string;
}
export interface CompanionNamingEnvironment {
  now(): number;
  isVisible(): boolean;
  isOnline(): boolean;
  operationId(): string;
  setTimer(run: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
}
const defaultEnvironment: CompanionNamingEnvironment = {
  now: () => Date.now(), isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  operationId: () => crypto.randomUUID(), setTimer: (run, delay) => setTimeout(run, delay),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const empty = (): CompanionNamingObservation => ({ state: null, accepted: null, acceptance: 'idle', checking: false, submitting: false, error: '' });
type Intent = Readonly<{ operationId: string; taskId: string; appliedRevision: number }>;

/** Only submit creates an intent. Mounting, polling and resuming are reads;
 * transport cancellation never revokes or reauthorizes accepted server work. */
export class CompanionNamingController {
  private live = false;
  private epoch = 0;
  private request: AbortController | null = null;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private intent: Intent | null = null;
  private unresolved = false;
  private nextAllowedAt = 0;
  private snapshot = empty();
  private readonly client: BoundPlatformClient;
  private readonly changed: (state: CompanionNamingObservation) => void;
  private readonly environment: CompanionNamingEnvironment;
  constructor(client: BoundPlatformClient, changed: (state: CompanionNamingObservation) => void,
    environment: CompanionNamingEnvironment = defaultEnvironment) {
    this.client = client; this.changed = changed; this.environment = environment;
  }
  private current(epoch: number, request?: AbortController): boolean {
    return this.live && this.epoch === epoch && this.client.isCurrent() && !request?.signal.aborted;
  }
  private publish(patch: Partial<CompanionNamingObservation>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch }); this.changed(this.snapshot);
  }
  private clearTimer(): void {
    if (this.timer !== null) this.environment.clearTimer(this.timer); this.timer = null;
  }
  private schedule(delay: number): void {
    this.clearTimer();
    if (!this.live || !this.client.isCurrent() || !this.environment.isVisible() || !this.environment.isOnline()) return;
    const epoch = this.epoch;
    this.timer = this.environment.setTimer(() => {
      this.timer = null; if (this.current(epoch)) this.refresh();
    }, Math.min(24 * 60 * 60_000, Math.max(0, delay)));
  }
  private active(): boolean {
    const own = this.snapshot.accepted?.progress;
    const latest = this.snapshot.state?.kind === 'naming' ? this.snapshot.state.latest : null;
    return this.unresolved || [own, latest].some(value => value && value.hold === null
      && (value.phase === 'queued' || value.phase === 'checking'
        || value.detection.status === 'detected' && (value.resource === 'pending'
          || value.detection.level === 'L0' && value.application.status === 'pending')));
  }
  private rateLimited(error: unknown): boolean {
    if (!(error instanceof ApiError) || error.status !== 429) return false;
    const delay = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs! >= 0 ? error.retryAfterMs! : 0;
    this.nextAllowedAt = this.environment.now() + Math.max(60_000,
      Math.min(Number.MAX_SAFE_INTEGER - this.environment.now(), delay));
    this.publish({ error: '暂时读取得太频繁了。稍后会重新确认进度。' }); return true;
  }
  start(): void {
    if (this.live || !this.client.isCurrent()) return;
    this.live = true; this.epoch++;
    this.unsubscribe = this.client.subscribe(() => {
      if (!this.client.isCurrent()) { this.intent = null; this.unresolved = false; this.stop(); }
    });
    this.refresh();
  }
  stop(): void {
    this.live = false; this.epoch++; this.request?.abort(); this.request = null;
    this.clearTimer(); this.unsubscribe?.(); this.unsubscribe = null;
    if (!this.client.isCurrent()) { this.intent = null; this.unresolved = false; }
    // No raw name is kept in observer state, storage, URL, logs or timers.
    this.snapshot = Object.freeze(empty()); this.changed(this.snapshot);
  }
  resume(): void { this.clearTimer(); this.refresh(); }
  refresh(): void {
    if (!this.live || this.request || !this.client.isCurrent() || !this.environment.isOnline() || !this.environment.isVisible()) return;
    const delay = this.nextAllowedAt - this.environment.now();
    if (delay > 0) { this.schedule(delay); return; }
    this.clearTimer();
    const epoch = this.epoch, request = new AbortController(), intent = this.intent;
    this.request = request; this.publish({ checking: true, error: '' });
    void this.observe(epoch, request, intent);
  }
  private match(accepted: CompanionNamingAccepted, intent: Intent): void {
    if (accepted.acceptance.taskId !== intent.taskId || accepted.acceptance.operation.id !== intent.operationId
      || accepted.acceptance.operation.appliedRevision !== intent.appliedRevision)
      throw new Error('起名的提交记录暂时无法确认，请重新读取。');
  }
  private async observe(epoch: number, request: AbortController, intent: Intent | null): Promise<void> {
    let throttled = false;
    try {
      if (intent) {
        const accepted = await readCompanionNamingOperation(this.client, intent.operationId, request.signal);
        if (!this.current(epoch, request)) return;
        if (accepted) this.match(accepted, intent);
        // One absent observation cannot prove an earlier accept transaction rolled back.
        this.unresolved = accepted === null;
        this.publish({ accepted, acceptance: accepted ? 'saved' : 'unknown',
          error: accepted ? '' : '这次提交暂时没有确认完成。可以重新读取提交记录。' });
      }
      const state = await readCompanionNaming(this.client, request.signal);
      if (!this.current(epoch, request)) return;
      this.nextAllowedAt = 0; this.publish({ state });
    } catch (error) {
      if (!this.current(epoch, request)) return;
      throttled = this.rateLimited(error);
      if (!throttled) this.publish({ error: '起名的进度暂时无法读取，请稍后重新读取。' });
    } finally {
      if (this.current(epoch, request) && this.request === request) {
        this.request = null; this.publish({ checking: false });
        if (throttled || this.active()) this.schedule(Math.max(3_000, this.nextAllowedAt - this.environment.now()));
      }
    }
  }
  /** Capture exactly one explicit raw request before any await. */
  submit(value: CompanionNamingInput): boolean {
    if (!this.live || !this.client.isCurrent() || this.snapshot.submitting) return false;
    if (this.unresolved) { this.publish({ error: '上一次提交还没有确认，请先重新读取提交记录。' }); return false; }
    if (!this.environment.isOnline() || !this.environment.isVisible() || this.nextAllowedAt > this.environment.now()) {
      this.publish({ error: '暂时无法提交。你的输入还在页面里，请稍后再试。' }); return false;
    }
    const input = parseCompanionNamingInput(value);
    const command = parseCompanionNamingRequest({ ...input, operationId: this.environment.operationId() });
    this.clearTimer(); this.request?.abort(); this.epoch++;
    const epoch = this.epoch, request = new AbortController();
    const intent = Object.freeze({ operationId: command.operationId, taskId: command.taskId, appliedRevision: command.expectedEntryRevision + 1 });
    this.intent = intent; this.unresolved = true; this.request = request;
    this.publish({ accepted: null, acceptance: 'sending', submitting: true, checking: false, error: '' });
    void this.send(epoch, request, intent, command); return true;
  }
  private async send(epoch: number, request: AbortController, intent: Intent,
    command: Readonly<CompanionNamingInput & { operationId: string }>): Promise<void> {
    let refresh = false, throttled = false;
    try {
      const accepted = await acceptCompanionNaming(this.client, command, request.signal);
      if (!this.current(epoch, request)) return;
      this.match(accepted, intent); this.unresolved = false;
      this.publish({ accepted, acceptance: 'saved' }); refresh = true;
    } catch (error) {
      if (!this.current(epoch, request)) return;
      // These exact platform outcomes prove no acceptance: the quota handler
      // runs before the writer; the writer checks an existing operation before
      // rejecting its entry CAS, rolling back that transaction. A conflicting
      // operation can already exist and must still be observed by its own ID.
      const refusedBeforeAcceptance = error instanceof ApiError
        && (error.status === 429 && error.code === 'REQUEST_LIMIT_REACHED'
          || error.status === 409 && error.code === 'COMPANION_NAME_ENTRY_REVISION_CHANGED');
      if (refusedBeforeAcceptance) { this.intent = null; this.unresolved = false; }
      this.publish({ acceptance: refusedBeforeAcceptance ? 'idle' : 'unknown' }); throttled = this.rateLimited(error);
      if (!throttled && !refusedBeforeAcceptance) {
        try {
          const accepted = await readCompanionNamingOperation(this.client, intent.operationId, request.signal);
          if (!this.current(epoch, request)) return;
          if (accepted) { this.match(accepted, intent); this.unresolved = false; this.publish({ accepted, acceptance: 'saved', error: '' }); }
          else this.publish({ error: '这次提交暂时没有确认完成。可以重新读取提交记录。' });
        } catch (readError) {
          if (!this.current(epoch, request)) return;
          throttled = this.rateLimited(readError);
          if (!throttled) this.publish({ error: '提交记录暂时无法读取，请稍后重新读取。' });
        }
      }
      refresh = !throttled;
    } finally {
      if (this.current(epoch, request) && this.request === request) {
        this.request = null; this.publish({ submitting: false });
        if (refresh) this.refresh();
        else if (throttled || this.active()) this.schedule(Math.max(3_000, this.nextAllowedAt - this.environment.now()));
      }
    }
  }
}
