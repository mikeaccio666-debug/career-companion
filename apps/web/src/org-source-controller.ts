import { parseOrgKnowledgeReference, type OrgKnowledgeReference, type StudentOrgKnowledgePassage, type StudentOrgMethod } from '@companion/platform-contracts';
import { readOrgSource, readOrgMethod, type OrgSourceClient } from './org-source-api.ts';
export type OrgSourceState = 'idle' | 'loading' | 'ready' | 'stale' | 'denied' | 'missing' | 'unavailable' | 'account_inactive';
export type OrgMethodState = 'closed' | 'loading' | 'ready' | 'limited' | 'unavailable';
export interface OrgMethodSnapshot { readonly state: OrgMethodState; readonly method: StudentOrgMethod | null; }
const closedMethod = (): OrgMethodSnapshot => Object.freeze({ state: 'closed', method: null });
export interface OrgSourceSnapshot { readonly state: OrgSourceState; readonly passage: Readonly<StudentOrgKnowledgePassage> | null; readonly details: OrgMethodSnapshot; }
export const emptyOrgSource = (): OrgSourceSnapshot => Object.freeze({ state: 'idle', passage: null, details: closedMethod() });
function classified(error: unknown): OrgSourceState {
  if (!error || typeof error !== 'object') return 'unavailable';
  const d = Object.getOwnPropertyDescriptors(error), code = d.code && 'value' in d.code ? d.code.value : null,
    status = d.status && 'value' in d.status ? d.status.value : null;
  if (status === 409 && code === 'STALE_REVISION') return 'stale';
  if (status === 403 && code === 'NOT_ENTITLED') return 'denied';
  if (status === 404 && code === 'NOT_FOUND') return 'missing';
  if (status === 401 || status === 403 && ['TERMS_CONFIRMATION_REQUIRED', 'EMAIL_VERIFICATION_REQUIRED', 'STUDENT_ACCOUNT_REQUIRED'].includes(code)) return 'account_inactive';
  return 'unavailable';
}
/** Account-bound memory only. A fresh read clears previously loaded content;
 * interruption, ignored abort and stale generations cannot publish it again. */
export class OrgSourceController {
  private readonly client: OrgSourceClient;
  private readonly changed: (s: OrgSourceSnapshot) => void;
  private readonly reference: Readonly<OrgKnowledgeReference>;
  private readonly timeoutMs: number;
  private state = emptyOrgSource();
  private live = false;
  private generation = 0;
  private detailGeneration = 0;
  private detailAbort: AbortController | null = null;
  private abort: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  constructor(client: OrgSourceClient, reference: OrgKnowledgeReference, changed: (s: OrgSourceSnapshot) => void, timeoutMs = 12000) {
    this.client = client; this.reference = parseOrgKnowledgeReference(reference); this.changed = changed;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12000) throw Error('Invalid source read budget.');
    this.timeoutMs = timeoutMs;
  }
  snapshot() { return this.state; }
  private current(generation = this.generation) { return this.live && generation === this.generation && this.client.isCurrent(); }
  private publish(state: OrgSourceState, passage: Readonly<StudentOrgKnowledgePassage> | null = null) {
    if (!this.current()) return;
    this.state = Object.freeze({ state, passage, details: closedMethod() }); this.changed(this.state);
  }
  start() {
    if (this.live) return;
    this.live = true;
    this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent()) this.stop(); });
    void this.refresh();
  }
  stop() {
    this.clearDetails();
    this.generation++; this.live = false; this.abort?.abort(); this.abort = null;
    this.unsubscribe?.(); this.unsubscribe = null; this.state = emptyOrgSource(); this.changed(this.state);
  }
  suspend() {
    this.clearDetails();
    this.generation++; this.abort?.abort(); this.abort = null;
    this.publish('idle'); // Hidden/offline pages retain no old passage.
  }
  async refresh() {
    if (!this.live) return;
    if (!this.client.isCurrent()) { this.stop(); return; }
    this.clearDetails();
    this.abort?.abort(); const generation = ++this.generation, abort = new AbortController(); this.abort = abort;
    this.publish('loading');
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new DOMException('Source read interrupted', 'AbortError'));
      abort.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const passage = await Promise.race([readOrgSource(this.client, this.reference, abort.signal), cancelled]);
      if (this.current(generation) && !abort.signal.aborted) this.publish('ready', passage);
    } catch (error) {
      if (this.current(generation)) this.publish(classified(error));
    } finally {
      clearTimeout(timer); if (rejectAbort) abort.signal.removeEventListener('abort', rejectAbort);
      if (this.abort === abort) this.abort = null;
    }
  }

  private clearDetails() {
    this.detailGeneration++; this.detailAbort?.abort(); this.detailAbort = null;
  }
  closeMethod() {
    this.clearDetails();
    if (this.current() && this.state.state === 'ready') {
      this.state = Object.freeze({ ...this.state, details: closedMethod() }); this.changed(this.state);
    }
  }
  async expandMethod() {
    const passage = this.state.passage;
    if (!this.current() || this.state.state !== 'ready' || passage?.assetClass !== 'method_card' ||
        ['loading', 'ready'].includes(this.state.details.state)) return;
    this.clearDetails();
    const generation = this.generation, detailGeneration = this.detailGeneration, abort = new AbortController();
    this.detailAbort = abort;
    const valid = () => this.current(generation) && detailGeneration === this.detailGeneration && this.state.passage === passage;
    const publish = (state: OrgMethodState, method: StudentOrgMethod | null = null) => {
      if (!valid()) return;
      this.state = Object.freeze({ ...this.state, details: Object.freeze({ state, method }) }); this.changed(this.state);
    };
    publish('loading');
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new DOMException('Method read interrupted', 'AbortError'));
      abort.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const method = await Promise.race([readOrgMethod(this.client, this.reference, abort.signal), cancelled]);
      if (method.assetRevision !== passage.assetRevision || method.brand !== passage.brand) throw Error('Method version changed.');
      if (valid() && !abort.signal.aborted) publish('ready', method);
    } catch (error) {
      if (!valid()) return;
      const fields = error && typeof error === 'object' ? Object.getOwnPropertyDescriptors(error) : {};
      if (fields.status?.value === 403 && fields.code?.value === 'METHOD_FULL_NOT_ALLOWED') publish('limited');
      else {
        const state = classified(error);
        if (['denied', 'stale', 'missing', 'account_inactive'].includes(state)) {
          this.clearDetails(); this.publish(state);
        } else publish('unavailable');
      }
    } finally {
      clearTimeout(timer); if (rejectAbort) abort.signal.removeEventListener('abort', rejectAbort);
      if (this.detailAbort === abort) this.detailAbort = null;
    }
  }
}
