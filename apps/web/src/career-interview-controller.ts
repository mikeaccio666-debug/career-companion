import { parseCareerInterviewCommand, type CareerInterview, type CareerApplicationSummary } from '@companion/platform-contracts';
import { ApiError, type BoundPlatformClient } from './api.ts';
import { readCareerApplications } from './career-application-api.ts';
import { readInterviewRecords, readInterviewRecord, changeInterviewRecord, observeInterviewRecord,
  freezeInterviewIntent, type InterviewIntent, type InterviewResult } from './career-interview-api.ts';

export interface InterviewSnapshot {
  readonly records: readonly Readonly<CareerInterview>[];
  readonly nextAfter: string | null;
  readonly detail: Readonly<CareerInterview> | null;
  readonly detailMissing: boolean;
  readonly applications: readonly Readonly<CareerApplicationSummary>[];
  readonly applicationNext: string | null;
  readonly applicationsReady: boolean;
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly pending: Readonly<InterviewIntent> | null;
  readonly needsRefresh: boolean;
  readonly error: string;
  readonly sourceError: string;
  readonly lastResult: InterviewResult | null;
}
const empty = (): InterviewSnapshot => ({
  records: [], nextAfter: null, detail: null, detailMissing: false,
  applications: [], applicationNext: null, applicationsReady: false,
  loaded: false, busy: false, uncertain: false, pending: null, needsRefresh: false,
  error: '', sourceError: '', lastResult: null,
});
/** Memory-only state; every reconciliation retains the original immutable nonce.
 * Account invalidation aborts requests and drops records, sources and intents. */
export class CareerInterviewController {
  private state: InterviewSnapshot = empty();
  private live = false;
  private generation = 0;
  private request: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly client: BoundPlatformClient;
  private readonly changed: (s: InterviewSnapshot) => void;
  private readonly detailId: string | null;
  private readonly timeouts: { read: number; write: number };
  constructor(client: BoundPlatformClient, changed: (s: InterviewSnapshot) => void, detailId: string | null = null, timeouts = { read: 12000, write: 8000 }) {
    this.client = client; this.changed = changed; this.detailId = detailId; this.timeouts = timeouts;
  }
  snapshot() { return this.state; }
  private current(generation = this.generation) { return generation === this.generation && this.live && this.client.isCurrent(); }
  private publish(patch: Partial<InterviewSnapshot>) {
    if (!this.current()) return;
    this.state = Object.freeze({ ...this.state, ...patch }); this.changed(this.state);
  }
  start() {
    if (this.live) return;
    this.live = true; this.unsubscribe = this.client.subscribe(() => { if (!this.client.isCurrent()) this.stop(); });
    void this.refresh();
  }
  stop() {
    this.generation++; this.live = false; this.request?.abort(); this.request = null;
    this.unsubscribe?.(); this.unsubscribe = null; this.state = empty(); this.changed(this.state);
  }
  private async timed<T>(run: (signal: AbortSignal) => Promise<T>, ms: number) {
    const abort = new AbortController(); this.request = abort;
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new DOMException('Request interrupted', 'AbortError'));
      abort.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = setTimeout(() => abort.abort(), ms);
    try { return await Promise.race([run(abort.signal), cancelled]); }
    finally {
      clearTimeout(timer); if (rejectAbort) abort.signal.removeEventListener('abort', rejectAbort);
      if (this.request === abort) this.request = null;
    }
  }
  async refresh() {
    if (!this.current() || this.request) return;
    const generation = this.generation;
    this.publish({ busy: true, error: this.state.pending ? this.state.error : '' });
    try {
      const result = await this.timed(async signal => {
        const list = await readInterviewRecords(this.client, null, null, signal);
        let detail: Readonly<CareerInterview> | null = null, detailMissing = false;
        if (this.detailId) {
          try { detail = await readInterviewRecord(this.client, this.detailId, signal); }
          catch (e) { if (e instanceof ApiError && e.status === 404) detailMissing = true; else throw e; }
        }
        return { records: list.interviews, nextAfter: list.nextAfter, detail, detailMissing };
      }, this.timeouts.read);
      if (this.current(generation)) this.publish({ ...result, loaded: true, busy: false, needsRefresh: false });
    } catch {
      if (this.current(generation)) this.publish({ busy: false, error: '面试记录暂时没有读到，可以重新读取。' });
    }
  }
  async loadMore() {
    const after = this.state.nextAfter;
    if (!this.current() || this.request || !after) return;
    const generation = this.generation; this.publish({ busy: true, error: '' });
    try {
      const page = await this.timed(signal => readInterviewRecords(this.client, after, null, signal), this.timeouts.read);
      if (!this.current(generation)) return;
      if (page.interviews.some(r => this.state.records.some(old => old.id === r.id))) throw Error('Duplicate page');
      this.publish({ records: Object.freeze([...this.state.records, ...page.interviews]), nextAfter: page.nextAfter, busy: false });
    } catch { if (this.current(generation)) this.publish({ busy: false, error: '后面的记录暂时没有读到，可以再试一次。' }); }
  }
  async loadApplications(more = false) {
    if (!this.current() || this.request || this.state.pending || more && !this.state.applicationNext) return;
    const generation = this.generation, after = more ? this.state.applicationNext : null;
    this.publish({ busy: true, sourceError: '' });
    try {
      const page = await this.timed(signal => readCareerApplications(this.client, after, null, signal), this.timeouts.read);
      if (!this.current(generation)) return;
      if (more && page.applications.some(r => this.state.applications.some(old => old.id === r.id))) throw Error('Duplicate page');
      this.publish({ applications: Object.freeze([...(more ? this.state.applications : []), ...page.applications]),
        applicationNext: page.nextAfter, applicationsReady: true, busy: false });
    } catch { if (this.current(generation)) this.publish({ busy: false, sourceError: '投递记录暂时没有读到，可以重新读取；不会用示例岗位替代。' }); }
  }
  begin(value: InterviewIntent) {
    if (!this.current() || this.state.busy || this.state.pending || !this.state.loaded || this.state.needsRefresh) return;
    const pending = freezeInterviewIntent(value), command = parseCareerInterviewCommand(pending.action, pending.body);
    if (command.action === 'create') {
      const source = this.state.applications.find(r => r.id === command.applicationId);
      if (!this.state.applicationsReady || !source || source.revision !== command.applicationRevision) {
        this.publish({ error: '先读取并核对你选的投递记录。' }); return;
      }
    } else {
      const row = this.state.detail?.id === pending.id ? this.state.detail : this.state.records.find(r => r.id === pending.id);
      if (!row || row.revision !== command.expectedRevision) {
        this.publish({ error: '记录已有变化，先重新读取并核对。', needsRefresh: true }); return;
      }
    }
    this.publish({ pending, uncertain: false, error: '', lastResult: null });
    void this.execute(false);
  }
  async retry() { await this.execute(false); }
  async observe() { await this.execute(true); }
  private async execute(observe: boolean) {
    const pending = this.state.pending;
    if (!this.current() || !pending || this.request || this.state.busy) return;
    const generation = this.generation; this.publish({ busy: true, error: '' });
    try {
      const result = await this.timed(signal => observe ? observeInterviewRecord(this.client, pending, signal) : changeInterviewRecord(this.client, pending, signal), observe ? this.timeouts.read : this.timeouts.write);
      if (!this.current(generation)) return;
      const known = this.state.detail?.id === result.operation.interviewId ? this.state.detail
        : this.state.records.find(r => r.id === result.operation.interviewId);
      if (result.interview && known && result.interview.revision < known.revision) throw Error('Older current record');
      const records = this.state.records.flatMap(r => r.id === result.operation.interviewId
        ? result.interview ? [result.interview] : [] : [r]);
      // A deep-linked detail outside this page does not pretend that intervening
      // pages were read. A newly created record goes before the original cursor.
      if (result.interview && pending.action === 'create' && !records.some(r => r.id === result.interview!.id)) records.unshift(result.interview);
      const deletedCursor = result.interview === null && this.state.nextAfter === result.operation.interviewId;
      const detailChanged = this.detailId === result.operation.interviewId;
      this.publish({ records: Object.freeze(records),
        ...(detailChanged ? { detail: result.interview, detailMissing: result.interview === null } : {}),
        busy: false, pending: null, uncertain: false, needsRefresh: deletedCursor,
        ...(deletedCursor ? { nextAfter: null } : {}),
        error: deletedCursor ? '分页位置已删除，请重新读取面试列表。' : '', lastResult: result });
    } catch (e) {
      if (!this.current(generation)) return;
      // Observer 404 may precede an original in-flight commit; it is not a failure receipt.
      if (!observe && e instanceof ApiError && [400, 401, 403, 404, 409, 413, 422, 429].includes(e.status) && typeof e.code === 'string')
        this.publish({ busy: false, pending: null, uncertain: false, needsRefresh: e.status === 409 || e.status === 404,
          error: e.status === 409 || e.status === 404 ? '记录已有变化或不存在，先重新读取并核对。' : '这次没有保存，请核对填写内容或登录状态。' });
      else this.publish({ busy: false, uncertain: true, error: '还在确认，先别关页面。可以核对这次操作，或用原操作重试。' });
    }
  }
}
