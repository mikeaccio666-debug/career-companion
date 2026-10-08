import type { MentorIntent, MentorIntentCommand } from '@companion/platform-contracts';
import { ApiError } from './api-error.ts';
import { readMentorEntry, readMentorIntents, changeMentorIntent, observeMentorIntent, freezeMentorMutation, readMentorOrder,
  type MentorIntentClient, type MentorEntry, type MentorMutationIntent, type MentorIntentResult } from './mentor-intent-api.ts';

export interface MentorControllerClient extends MentorIntentClient {
  subscribe(listener: () => void): () => void;
}
export interface MentorSnapshot {
  readonly entry: Readonly<MentorEntry> | null; readonly records: readonly Readonly<MentorIntent>[];
  readonly nextCursor: string | null; readonly loaded: boolean; readonly busy: boolean; readonly suspended: boolean;
  readonly pending: Readonly<MentorMutationIntent> | null; readonly uncertain: boolean; readonly needsRefresh: boolean;
  readonly quote: Awaited<ReturnType<typeof readMentorOrder>> | null;
  readonly error: string; readonly lastResult: Readonly<MentorIntentResult> | null;
}
export const emptyMentorSnapshot = (): MentorSnapshot => ({
  entry: null, records: [], nextCursor: null, loaded: false, busy: false, suspended: false,
  pending: null, uncertain: false, needsRefresh: false, error: '', lastResult: null, quote: null,
});
/** Memory-only account-scoped state. A transport failure never becomes a failure receipt
 * or a new operation. No automatic write on resume, background send or local storage. */
export class MentorIntentController {
  private state: MentorSnapshot = emptyMentorSnapshot();
  private live = false;
  private orderVersions = new Map<string, number>();
  private generation = 0;
  private request: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly client: MentorControllerClient;
  private readonly changed: (s: MentorSnapshot) => void;
  private readonly timeouts: { read: number; write: number };

  constructor(client: MentorControllerClient, changed: (s: MentorSnapshot) => void, timeouts = { read: 12000, write: 8000 }) {
    this.client = client; this.changed = changed; this.timeouts = timeouts;
  }
  snapshot() { return this.state; }
  private current(generation = this.generation) {
    return generation === this.generation && this.live && this.client.isCurrent();
  }
  private publish(patch: Partial<MentorSnapshot>) {
    if (!this.current()) return;
    this.state = Object.freeze({ ...this.state, ...patch }); this.changed(this.state);
  }
  start() {
    if (this.live) return;
    this.live = true;
    this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent()) this.stop(); });
    void this.refresh();
  }
  stop() {
    this.generation++; this.live = false; this.request?.abort(); this.request = null;
    this.unsubscribe?.(); this.unsubscribe = null; this.orderVersions.clear(); this.state = emptyMentorSnapshot(); this.changed(this.state);
  }
  suspend() {
    if (!this.current()) return;
    this.generation++; this.request?.abort(); this.request = null; this.orderVersions.clear();
    this.publish({ entry: null, records: [], nextCursor: null, loaded: false, busy: false, suspended: true,
      uncertain: !!this.state.pending, needsRefresh: true, lastResult: null, error: '', quote: null });
  }
  resume() {
    if (!this.current()) return;
    this.publish({ suspended: false }); void this.refresh();
  }
  private async timed<T>(run: (signal: AbortSignal) => Promise<T>, milliseconds: number) {
    const abort = new AbortController(); this.request = abort;
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new DOMException('Request interrupted', 'AbortError'));
      abort.signal.addEventListener('abort', cancel, { once: true });
    });
    const timer = setTimeout(() => abort.abort(), milliseconds);
    try { return await Promise.race([run(abort.signal), cancelled]); }
    finally {
      clearTimeout(timer); if (cancel) abort.signal.removeEventListener('abort', cancel);
      if (this.request === abort) this.request = null;
    }
  }
  async refresh() {
    if (!this.current() || this.state.suspended || this.request) return;
    const generation = this.generation;
    this.publish({ busy: true, quote: null, error: this.state.pending ? this.state.error : '' });
    try {
      const result = await this.timed(async signal => {
        const entry = await readMentorEntry(this.client, signal);
        const page = await readMentorIntents(this.client, null, signal);
        return { entry, records: page.sessions, nextCursor: page.nextCursor };
      }, this.timeouts.read);
      if (this.current(generation)) this.publish({ ...result, loaded: true, busy: false, needsRefresh: false });
    } catch {
      if (this.current(generation)) this.publish({ entry: null, records: [], nextCursor: null, loaded: false, busy: false, needsRefresh: true,
        error: '真人服务和请求暂时没有读到，可以重新读取。' });
    }
  }
  async loadMore() {
    const after = this.state.nextCursor;
    if (!this.current() || this.state.suspended || this.request || this.state.pending || !after || this.state.needsRefresh) return;
    const generation = this.generation; this.publish({ busy: true, error: '' });
    try {
      const page = await this.timed(signal => readMentorIntents(this.client, after, signal), this.timeouts.read);
      if (!this.current(generation)) return;
      if (page.sessions.some(r => this.state.records.some(old => old.id === r.id))) throw Error('Duplicate page');
      this.publish({ records: Object.freeze([...this.state.records, ...page.sessions]), nextCursor: page.nextCursor, busy: false });
    } catch {
      if (this.current(generation)) this.publish({ busy: false, error: '后面的请求暂时没有读到，可以再试一次。' });
    }
  }
  async loadOrder(sessionId: string) {
    if (!this.current() || this.state.suspended || this.request || this.state.pending || !this.state.loaded || this.state.needsRefresh) return;
    const known = this.state.records.find(r => r.id === sessionId);
    if (!known?.assignment || !known.orderId) return;
    const generation = this.generation; this.publish({ busy: true, error: '', quote: null });
    try {
      const quote = await this.timed(signal => readMentorOrder(this.client, sessionId, signal), this.timeouts.read);
      if (!this.current(generation)) return;
      if (quote.session.revision < known.revision || quote.order.revision < (this.orderVersions.get(quote.order.id) ?? 0)) throw Error('Older quote');
      this.orderVersions.set(quote.order.id, quote.order.revision);
      if (this.orderVersions.size > 100) this.orderVersions.delete(this.orderVersions.keys().next().value!);
      this.publish({ quote, records: Object.freeze(this.state.records.map(r => r.id === sessionId ? quote.session : r)), busy: false });
    } catch {
      if (this.current(generation)) this.publish({ busy: false, quote: null, error: '报价暂时没有读到，可以重新查看。' });
    }
  }
  begin(value: MentorMutationIntent) {
    if (!this.current() || this.state.suspended || this.state.busy || this.state.pending || !this.state.loaded || this.state.needsRefresh) return;
    const pending = freezeMentorMutation(value);
    if (pending.action === 'create') {
      const command = pending.body as MentorIntentCommand;
      const offer = this.state.entry?.offers.find(o => o.id === command.offerId);
      if (!this.state.entry?.configured || !offer || offer.revision !== command.offerRevision || offer.availability !== 'available') {
        this.publish({ needsRefresh: true, error: '这项服务已有变化，请重新阅读并确认。' }); return;
      }
    } else {
      const record = this.state.records.find(r => r.id === pending.sessionId);
      if (!record || !['requested','matched'].includes(record.status) || record.revision !== (pending.body as {expectedRevision:number}).expectedRevision) {
        this.publish({ needsRefresh: true, error: '请求已有变化，请先重新读取。' }); return;
      }
    }
    this.publish({ pending, uncertain: false, error: '', lastResult: null, quote: null }); void this.execute(false);
  }
  async retry() { await this.execute(false); }
  async observe() { await this.execute(true); }
  private async execute(observe: boolean) {
    const pending = this.state.pending;
    if (!this.current() || this.state.suspended || !pending || this.request || this.state.busy) return;
    const generation = this.generation; this.publish({ busy: true, error: '' });
    try {
      const result = await this.timed(signal => observe ? observeMentorIntent(this.client, pending, signal)
        : changeMentorIntent(this.client, pending, signal), observe ? this.timeouts.read : this.timeouts.write);
      if (!this.current(generation)) return;
      const known = this.state.records.find(r => r.id === result.session.id);
      if (known && result.session.revision < known.revision) throw Error('Older current record');
      const records = this.state.records.map(r => r.id === result.session.id ? result.session : r);
      if (pending.action === 'create' && !records.some(r => r.id === result.session.id)) records.unshift(result.session);
      this.publish({ records: Object.freeze(records), busy: false, pending: null, uncertain: false, error: '', lastResult: result });
    } catch (e) {
      if (!this.current(generation)) return;
      // An observer 404 can precede a real commit; no reply or server 5xx may do so too.
      if (!observe && e instanceof ApiError && [400, 401, 403, 404, 409, 413, 422, 429].includes(e.status) && typeof e.code === 'string') {
        const refresh = e.status === 404 || e.status === 409;
        this.publish({ busy: false, pending: null, uncertain: false, needsRefresh: refresh,
          error: refresh ? '服务或请求已有变化，请重新阅读并确认。' : '这次没有保存，请核对填写内容或登录状态。' });
      } else {
        this.publish({ busy: false, uncertain: true, error: '提交结果还没确认。可以核对这次操作，或用原操作重试。' });
      }
    }
  }
}
