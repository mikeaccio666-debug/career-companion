import type { CompanionSafetyBodyProjection, CompanionSafetyResourceIndex, CompanionSafetyResourceState,
  CompanionSafetyResourceAction, CompanionSafetySourceRef, CompanionSafetyTargetRequest } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
import { actSafetyResource, claimSafetyQuestion, presentSafetyQuestion, publishSafetyResource, readSafetyBody,
  readSafetyQuestion, readSafetyResources, reserveSafetyQuestion } from './safety-resource-api.ts';

export interface SafetyResourceCardView {
  readonly state: CompanionSafetyResourceState;
  readonly projection: CompanionSafetyBodyProjection | null;
  readonly busy: boolean;
  readonly canAcknowledge: boolean;
  readonly canContinue: boolean;
  readonly recoveryUncertain: boolean;
  readonly error: string;
  readonly questionNotice: string;
}
export interface SafetyResourceObservation {
  readonly cards: readonly SafetyResourceCardView[];
  readonly publicationRetries: readonly CompanionSafetySourceRef[];
  readonly pending: number;
  readonly unavailable: number;
  readonly checking: boolean;
  readonly error: string;
}
export interface SafetyResourceEnvironment {
  monotonicNow(): number;
  isVisible(): boolean;
  isOnline(): boolean;
  operationId(): string;
  setTimer(run: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
}
/** A capability to one actual connected DOM owner, never a React state/string cache. */
export interface SafetyResourceDomPort {
  bodyConnected(): boolean;
  questionConnected(): boolean;
  writeQuestion(text: string): void;
  clearQuestion(): void;
}
const defaults: SafetyResourceEnvironment = {
  monotonicNow: () => performance.now(), isVisible: () => typeof document !== 'undefined' && document.visibilityState !== 'hidden',
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false, operationId: () => crypto.randomUUID(),
  setTimer: (run, delay) => setTimeout(run, delay), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const empty = (): SafetyResourceObservation => ({ cards: [], publicationRetries: [], pending: 0, unavailable: 0, checking: false, error: '' });
const keyOf = (target: CompanionSafetyTargetRequest) => `${target.sourceKind}:${target.publicationId}`;
const targetOf = (state: CompanionSafetyResourceState): CompanionSafetyTargetRequest => ({ sourceKind: state.sourceKind, publicationId: state.publicationId });
const sourceKey = (ref: CompanionSafetySourceRef) => `${ref.kind}:${ref.submissionId}`;
type InternalCard = { state: CompanionSafetyResourceState; projection: CompanionSafetyBodyProjection | null;
  receipt: string | null; acknowledgedReceipt: string | null; busy: boolean; error: string; questionNotice: string };
const DISPLAY_MARGIN_MS = 250;

/** Resource/body journal, task release, and the shared question journal are separate paths.
 * Secrets stay in this origin's memory. Stop invalidates DOM ownership but retains consumed
 * grants/attempts, so React StrictMode cannot redisplay or re-POST an uncertain operation. */
export class SafetyResourceController {
  private live = false;
  private epoch = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly requests = new Set<AbortController>();
  private index: CompanionSafetyResourceIndex | null = null;
  private checking = false;
  private error = '';
  private readonly cards = new Map<string, InternalCard>();
  private readonly ports = new Map<string, SafetyResourceDomPort>();
  private readonly publicationAttempts = new Map<string, string>();
  private readonly recoveryAttempts = new Map<string, string>();
  private readonly projectionAttempts = new Set<string>();
  private readonly presentationAttempts = new Set<string>();
  private readonly questionAttempts = new Set<string>();
  private readonly consumedGrants = new Set<string>();
  private readonly renderOwnerId: string;
  private questionBusy = false;
  private questionEpoch = 0;
  private questionPort: SafetyResourceDomPort | null = null;
  private ticket: { key: string; port: SafetyResourceDomPort; deadline: number; timer: unknown } | null = null;
  private readonly client: BoundPlatformClient;
  private readonly changed: (view: SafetyResourceObservation) => void;
  private readonly sourcesChanged: () => void;
  private readonly environment: SafetyResourceEnvironment;
  private readonly blockersChanged: (blocked: boolean) => void;
  constructor(client: BoundPlatformClient, changed: (view: SafetyResourceObservation) => void,
    sourcesChanged: () => void, environment: SafetyResourceEnvironment = defaults,
    blockersChanged: (blocked: boolean) => void = () => {}) {
    this.client = client; this.changed = changed; this.sourcesChanged = sourcesChanged;
    this.environment = environment; this.blockersChanged = blockersChanged;
    this.renderOwnerId = environment.operationId();
  }
  private current(epoch: number, request?: AbortController): boolean {
    return this.live && this.epoch === epoch && this.client.isCurrent() && !request?.signal.aborted;
  }
  private active(): boolean { return this.live && this.client.isCurrent() && this.environment.isVisible() && this.environment.isOnline(); }
  private request(): AbortController { const r = new AbortController(); this.requests.add(r); return r; }
  private observeIndex(index: CompanionSafetyResourceIndex): void {
    this.index = index;
    // Only a genuine complete typed index observation may clear the UI hint; this grants no server permission.
    this.blockersChanged(index.sources.some(source => source.availability !== 'ready' || !source.publication?.handled));
  }
  private notify(): void {
    if (!this.client.isCurrent()) return;
    this.changed(Object.freeze({ cards: Object.freeze([...this.cards.values()].map(c => Object.freeze({ state: c.state, projection: c.projection,
      busy: c.busy, canAcknowledge: !!c.receipt && c.acknowledgedReceipt !== c.receipt && !c.state.handled,
      canContinue: !!c.receipt && c.acknowledgedReceipt === c.receipt && !c.state.handled,
      recoveryUncertain: this.recoveryAttempts.has(`${sourceKey({ kind: c.state.sourceKind, submissionId: c.state.submissionId })}:${c.state.edition}`),
      error: c.error, questionNotice: c.questionNotice }))),
    publicationRetries: Object.freeze(this.index?.sources.filter(s => s.availability === 'ready' && !s.publication
      && this.publicationAttempts.has(sourceKey(s.sourceRef))).map(s => s.sourceRef) ?? []),
    pending: this.index?.sources.filter(s => s.availability === 'pending').length ?? 0,
    unavailable: this.index?.sources.filter(s => s.availability === 'unavailable').length ?? 0,
    checking: this.checking, error: this.error }));
  }
  start(): void {
    if (this.live || !this.client.isCurrent()) return;
    this.live = true; this.epoch++;
    this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent()) this.stop(); });
    this.refresh();
  }
  stop(): void {
    this.live = false; this.epoch++; this.questionEpoch++;
    for (const request of this.requests) request.abort(); this.requests.clear();
    this.clearTicket(); for (const port of this.ports.values()) port.clearQuestion(); this.ports.clear();
    this.unsubscribe?.(); this.unsubscribe = null; this.index = null; this.cards.clear(); this.projectionAttempts.clear(); this.checking = false;
    this.questionBusy = false; this.questionPort = null; this.error = ''; this.changed(Object.freeze(empty()));
    this.blockersChanged(true);
    // No transport retry or task cancellation. Consumed grants and uncertain attempt IDs survive start/stop.
  }
  refresh(): void {
    if (!this.active() || this.checking) return;
    const epoch = this.epoch, request = this.request(); this.checking = true; this.error = ''; this.notify();
    void this.load(epoch, request);
  }
  resume(): void {
    if (!this.environment.isVisible() || !this.client.isCurrent()) { this.questionEpoch++; this.clearTicket(); return; }
    this.refresh(); this.recheckDom();
  }
  /** Scroll/resize only re-check existing DOM ownership; they never re-read or submit task inputs. */
  recheckDom(): void {
    if (this.questionPort && (!this.active() || !this.questionPort.questionConnected())) this.questionEpoch++;
    if (this.ticket && (!this.active() || !this.ticket.port.questionConnected())) this.clearTicket();
    if (!this.active()) return;
    for (const key of this.ports.keys()) this.presentBody(key);
    this.pumpQuestion();
  }
  private async load(epoch: number, request: AbortController): Promise<void> {
    try {
      const index = await readSafetyResources(this.client, request.signal); if (!this.current(epoch, request)) return;
      this.observeIndex(index);
      for (const source of index.sources) {
        if (!this.current(epoch, request)) return;
        if (source.availability !== 'ready') continue;
        let state = source.publication;
        if (!state) {
          const sourceId = sourceKey(source.sourceRef);
          if (this.publicationAttempts.has(sourceId) || !this.active()) continue;
          // Only a new authenticated deterministic resource publication. This never classifies/retries raw text.
          const operationId = this.environment.operationId(); this.publicationAttempts.set(sourceId, operationId);
          try {
            const published = await publishSafetyResource(this.client, { sourceRef: source.sourceRef,
              operationId, expectedEdition: 0 }, false, request.signal);
            if (!this.current(epoch, request)) return;
            if (!published) continue;
            const next = await readSafetyResources(this.client, request.signal); if (!this.current(epoch, request)) return;
            this.observeIndex(next); state = next.sources.find(s => sourceKey(s.sourceRef) === sourceId)?.publication ?? null;
          } catch { if (!this.current(epoch, request)) return; this.error = '这张支持资源暂时没有确认完成。可以重新读取，或手动重试这一次资源请求。'; }
        }
        if (!state) continue;
        const key = keyOf(state), existing = this.cards.get(key);
        // A complete current index proves the newer edition. Retire only this source's superseded DOM owner.
        for (const [oldKey, old] of this.cards) if (oldKey !== key && old.state.sourceKind === state.sourceKind && old.state.submissionId === state.submissionId) {
          this.ports.get(oldKey)?.clearQuestion(); this.ports.delete(oldKey); this.cards.delete(oldKey); this.questionEpoch++;
          if (this.ticket?.key === oldKey) this.clearTicket();
        }
        const card = existing ?? { state, projection: null, receipt: null, acknowledgedReceipt: null, busy: false, error: '', questionNotice: '' };
        card.state = state; this.cards.set(key, card);
        if (state.status === 'ready' && !card.projection && !this.projectionAttempts.has(key) && this.active()) {
          this.projectionAttempts.add(key);
          try {
            const projection = await readSafetyBody(this.client, targetOf(state), request.signal); if (!this.current(epoch, request)) return;
            if (projection.submissionId !== state.submissionId || projection.revision !== state.revision || projection.retentionUntil !== state.retentionUntil) throw new Error('Resource projection changed.');
            card.projection = projection; card.error = '';
          } catch { if (!this.current(epoch, request)) return; card.error = '这张支持资源暂时无法显示，可以显式重新展示。'; }
        }
      }
    } catch { if (this.current(epoch, request)) { this.error = '支持资源暂时无法读取，可以稍后重新读取。'; this.blockersChanged(true); } }
    finally {
      this.requests.delete(request);
      if (this.current(epoch, request)) { this.checking = false; this.notify(); this.pumpQuestion(); }
    }
  }
  /** Called only after a body and its empty question slot are attached to the actual DOM. */
  attach(target: CompanionSafetyTargetRequest, port: SafetyResourceDomPort): () => void {
    const key = keyOf(target), previous = this.ports.get(key); if (previous && previous !== port) { previous.clearQuestion(); this.questionEpoch++; }
    this.ports.set(key, port); this.presentBody(key); this.pumpQuestion();
    return () => { if (this.ports.get(key) === port) { port.clearQuestion(); this.ports.delete(key); this.questionEpoch++; if (this.ticket?.port === port) this.clearTicket(); } };
  }
  private presentBody(key: string): void {
    const card = this.cards.get(key), port = this.ports.get(key), projection = card?.projection;
    if (!this.active() || !card || !projection || !port?.bodyConnected() || card.busy || card.receipt
      || card.state.status !== 'ready' || this.presentationAttempts.has(projection.bodyProjectionId)) return;
    this.presentationAttempts.add(projection.bodyProjectionId);
    void this.action(key, { kind: 'present_body', bodyProjectionId: projection.bodyProjectionId }, port);
  }
  async redisplay(target: CompanionSafetyTargetRequest): Promise<void> {
    const key = keyOf(target), card = this.cards.get(key); if (!this.active() || !card || card.busy || card.state.status !== 'ready') return;
    const epoch = this.epoch, request = this.request(); card.busy = true; card.error = ''; this.notify();
    try {
      const projection = await readSafetyBody(this.client, target, request.signal); if (!this.current(epoch, request)) return;
      if (projection.submissionId !== card.state.submissionId || projection.retentionUntil !== card.state.retentionUntil) throw new Error('Resource changed.');
      card.projection = projection; card.receipt = null; card.acknowledgedReceipt = null;
    } catch { if (this.current(epoch, request)) card.error = '这次展示暂时没有确认完成，可以重新读取资源状态。'; }
    finally { this.requests.delete(request); if (this.current(epoch, request)) { card.busy = false; this.notify(); } }
  }
  /** Explicit retry keeps the exact accepted-or-unknown operation; ordinary refresh only observes it. */
  retryPublication(source: CompanionSafetySourceRef): Promise<void> {
    const operationId = this.publicationAttempts.get(sourceKey(source));
    if (!operationId) return Promise.resolve();
    return this.retryResource(source, operationId, 0, null);
  }
  recover(source: CompanionSafetySourceRef): Promise<void> {
    const card = [...this.cards.values()].find(c => c.state.sourceKind === source.kind && c.state.submissionId === source.submissionId);
    if (!this.active() || this.checking || !card || card.busy || card.state.status !== 'expired') return Promise.resolve();
    const key = `${sourceKey(source)}:${card.state.edition}`;
    let operationId = this.recoveryAttempts.get(key);
    if (!operationId) { operationId = this.environment.operationId(); this.recoveryAttempts.set(key, operationId); }
    return this.retryResource(source, operationId, card.state.edition, card);
  }
  private async retryResource(source: CompanionSafetySourceRef, operationId: string, expectedEdition: number, card: InternalCard | null): Promise<void> {
    if (!this.active() || this.checking || card?.busy) return;
    const epoch = this.epoch, request = this.request(); this.checking = true; this.error = ''; if (card) { card.busy = true; card.error = ''; } this.notify();
    try {
      // The real index is an observation, never a receipt or evidence that a lost request failed.
      const index = await readSafetyResources(this.client, request.signal); if (!this.current(epoch, request) || !this.active()) return;
      this.observeIndex(index);
      const observed = index.sources.find(s => sourceKey(s.sourceRef) === sourceKey(source));
      if (!observed || observed.availability !== 'ready') throw new Error('Resource source is not available.');
      if (expectedEdition === 0) {
        if (observed.publication) return; // A committed reply was lost; recover it through ordinary observation.
      } else {
        if (!observed.publication) throw new Error('Recovery edition is not observable.');
        if (observed.publication.edition !== expectedEdition || observed.publication.publicationId !== card?.state.publicationId
          || observed.publication.status !== 'expired') return;
      }
      await publishSafetyResource(this.client, { sourceRef: source, operationId, expectedEdition }, expectedEdition !== 0, request.signal);
    } catch {
      if (this.current(epoch, request)) {
        const message = '这次资源请求暂时没有确认完成。可以重新读取，或手动重试同一次资源请求。';
        if (card) card.error = message; else this.error = message;
      }
    } finally {
      this.requests.delete(request);
      if (this.current(epoch, request)) { this.checking = false; if (card) card.busy = false; this.notify(); this.refresh(); }
    }
  }
  acknowledge(target: CompanionSafetyTargetRequest): Promise<void> {
    const card = this.cards.get(keyOf(target)); if (!card?.receipt || card.acknowledgedReceipt === card.receipt || card.state.handled) return Promise.resolve();
    return this.action(keyOf(target), { kind: 'acknowledge', presentationReceipt: card.receipt });
  }
  continue(target: CompanionSafetyTargetRequest, clarify = false): Promise<void> {
    const card = this.cards.get(keyOf(target)); if (!card?.receipt || card.acknowledgedReceipt !== card.receipt || card.state.handled) return Promise.resolve();
    return this.action(keyOf(target), clarify ? { kind: 'clarify_exaggeration', presentationReceipt: card.receipt, safe: true, exaggeration: true }
      : { kind: target.sourceKind === 'onboarding' ? 'continue_intake' : 'continue_naming', presentationReceipt: card.receipt });
  }
  needSupport(target: CompanionSafetyTargetRequest): Promise<void> { return this.action(keyOf(target), { kind: 'need_support' }); }
  private async action(key: string, action: CompanionSafetyResourceAction, bodyPort?: SafetyResourceDomPort): Promise<void> {
    const card = this.cards.get(key); if (!this.active() || !card || card.busy) return;
    if (action.kind === 'present_body' && (!bodyPort?.bodyConnected() || this.ports.get(key) !== bodyPort)) return;
    const epoch = this.epoch, request = this.request(), receipt = card.receipt;
    card.busy = true; card.error = ''; this.notify();
    try {
      const result = await actSafetyResource(this.client, { sourceKind: card.state.sourceKind, publicationId: card.state.publicationId,
        operationId: this.environment.operationId(), expectedPublicationRevision: card.state.revision, action }, request.signal);
      if (!this.current(epoch, request) || this.cards.get(key) !== card) return;
      if (result.state.submissionId !== card.state.submissionId || result.state.edition !== card.state.edition) throw new Error('Resource source changed.');
      card.state = result.state;
      if (action.kind === 'present_body') {
        if (bodyPort?.bodyConnected() && this.ports.get(key) === bodyPort && result.presentationReceipt) {
          card.receipt = result.presentationReceipt; card.acknowledgedReceipt = null;
        }
      } else if (action.kind === 'acknowledge' && receipt === action.presentationReceipt && card.receipt === receipt && result.state.acknowledged) card.acknowledgedReceipt = receipt;
      if (['continue_naming', 'continue_intake', 'clarify_exaggeration'].includes(action.kind) && result.state.handled) this.sourcesChanged();
    } catch {
      if (this.current(epoch, request)) { card.error = '这一步暂时没有确认完成。可以重新读取；没有自动重发或继续任务。';
        // A lost mutation reply never grants an acknowledgment capability or a retry with a fresh operation.
        card.receipt = null; card.acknowledgedReceipt = null; }
    } finally { this.requests.delete(request); if (this.current(epoch, request)) { card.busy = false; this.notify(); this.pumpQuestion(); } }
  }
  private clearTicket(): void {
    if (this.ticket) { this.environment.clearTimer(this.ticket.timer); this.ticket.port.clearQuestion(); this.ticket = null; }
  }
  private questionCurrent(epoch: number, questionEpoch: number, request: AbortController, key: string, port: SafetyResourceDomPort): boolean {
    return this.current(epoch, request) && this.questionEpoch === questionEpoch && this.active() && this.ports.get(key) === port && port.questionConnected();
  }
  private pumpQuestion(): void {
    if (!this.active() || this.questionBusy || this.ticket) return;
    const match = [...this.cards.entries()].find(([key, c]) => c.state.status === 'ready' && c.state.level === 'L2'
      && c.projection && !this.questionAttempts.has(key) && this.ports.get(key)?.questionConnected());
    if (!match) return;
    const [key, card] = match, port = this.ports.get(key)!; this.questionAttempts.add(key); this.questionBusy = true; this.questionPort = port;
    void this.question(key, card, port, this.epoch, this.questionEpoch);
  }
  private async question(key: string, card: InternalCard, port: SafetyResourceDomPort, epoch: number, questionEpoch: number): Promise<void> {
    const request = this.request();
    try {
      const state = await readSafetyQuestion(this.client, targetOf(card.state), request.signal); if (!this.questionCurrent(epoch, questionEpoch, request, key, port)) return;
      // Global uncertainty/legacy flags never decide whether this genuine source is a new high-risk signal.
      // The server's locked reserve/claim gates decide that exception; an already claimed same source cannot re-display.
      if (state.sourcePhase === 'claimed') { card.questionNotice = '这句关心的话是否已展示还在核实，这里不会重复问。'; return; }
      if (state.sourcePhase === 'declared') return;
      const reservation = await reserveSafetyQuestion(this.client, { sourceKind: card.state.sourceKind, publicationId: card.state.publicationId,
        operationId: this.environment.operationId(), expectedQuestionScopeRevision: state.scopeRevision, renderOwnerId: this.renderOwnerId }, request.signal);
      if (!this.questionCurrent(epoch, questionEpoch, request, key, port)) return;
      if (!reservation.reservationToken) { card.questionNotice = '这句关心的话暂时无法确认，不会重复请求。'; return; }
      const startedAt = this.environment.monotonicNow();
      const claim = await claimSafetyQuestion(this.client, { operationId: this.environment.operationId(), occurrenceId: reservation.occurrenceId,
        reservationId: reservation.reservationId, reservationToken: reservation.reservationToken, generation: reservation.generation,
        renderOwnerId: this.renderOwnerId }, card.state, request.signal);
      if (!this.questionCurrent(epoch, questionEpoch, request, key, port)) return;
      if (claim.status !== 'display_granted') { card.questionNotice = claim.status === 'declared' ? '' : '这句关心的话是否已展示还在核实，这里不会重复问。'; return; }
      const deadline = startedAt + Math.min(claim.remainingDisplayMs, Date.parse(claim.displayUntil) - Date.parse(claim.serverNow)) - DISPLAY_MARGIN_MS;
      if (!Number.isFinite(deadline) || this.environment.monotonicNow() >= deadline || this.consumedGrants.has(claim.grantId)) return;
      // Consume before the one synchronous connected-DOM write. The question never enters React state or storage.
      this.consumedGrants.add(claim.grantId); port.writeQuestion(claim.question);
      if (!this.questionCurrent(epoch, questionEpoch, request, key, port) || this.environment.monotonicNow() >= deadline) { port.clearQuestion(); return; }
      const timer = this.environment.setTimer(() => this.clearTicket(), Math.max(0, deadline - this.environment.monotonicNow()));
      this.ticket = { key, port, deadline, timer };
      // This is an honest client display declaration, not human reading. A lost reply only permits GET observation.
      await presentSafetyQuestion(this.client, { operationId: this.environment.operationId(), occurrenceId: claim.occurrenceId,
        grantId: claim.grantId, grantPresentationToken: claim.grantPresentationToken, renderOwnerId: this.renderOwnerId }, request.signal);
      if (!this.current(epoch, request)) return; card.questionNotice = '';
    } catch { if (this.current(epoch, request)) card.questionNotice = '这句关心的话暂时无法确认。支持资源仍然可以使用，这里不会重新问一次。'; }
    finally { this.requests.delete(request); if (this.current(epoch, request)) { this.questionBusy = false; this.questionPort = null; this.notify(); } }
  }
}
