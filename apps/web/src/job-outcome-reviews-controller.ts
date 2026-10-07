import type { JobOutcomeReviewInput, JobOutcomeReviewOutcome, JobOutcomeReviewPage, JobOutcomeReviewRecord } from '@companion/platform-contracts';
import { ApiError, errorText } from './api.ts';
import { parseJobOutcomeReviewSaved, validJobOutcomeReviewNote, type createJobOutcomeReviewClient } from './job-outcome-reviews-api.ts';

export type JobOutcomeReviewPhase = 'editing' | 'saved' | 'save_unconfirmed' | 'conflict';
export interface JobOutcomeReviewSnapshot {
  opened: boolean; loading: boolean; saving: boolean; readCurrent: boolean; page: JobOutcomeReviewPage | null;
  generation: number | undefined; phase: JobOutcomeReviewPhase; outcome: JobOutcomeReviewOutcome | ''; note: string;
  dirty: boolean; error: string; notice: string; pending: JobOutcomeReviewInput | null; saved: JobOutcomeReviewRecord | null;
}
const empty = (): JobOutcomeReviewSnapshot => ({ opened: false, loading: false, saving: false, readCurrent: false, page: null, generation: undefined, phase: 'editing', outcome: '', note: '', dirty: false, error: '', notice: '', pending: null, saved: null });
const hidden = empty();
type Api = ReturnType<typeof createJobOutcomeReviewClient>;
interface Environment { isCurrent: () => boolean; isOnline: () => boolean; requestId: () => string }

/** A captured account and one exact task version. No execution or retry port exists here. */
export class JobOutcomeReviewController {
  private state = empty();
  private listeners = new Set<() => void>();
  private mounted = false;
  private lifetime = 0;
  private sequence = 0;
  private abort: AbortController | null = null;
  private api: Api;
  private environment: Environment;
  readonly jobId: string;
  readonly expectedGeneration?: number;
  private draftVersion: { evidenceVersion: string; revision: number } | null = null;
  private readError = '';
  constructor(api: Api, jobId: string, expectedGeneration: number | undefined, environment: Environment) {
    this.api = api; this.jobId = jobId; this.expectedGeneration = expectedGeneration; this.environment = environment;
  }
  private current = () => this.mounted && this.environment.isCurrent();
  getSnapshot = (): JobOutcomeReviewSnapshot => this.current() ? this.state : hidden;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: JobOutcomeReviewSnapshot) { if (!this.current()) return; this.state = next; for (const listener of this.listeners) listener(); }
  start() { this.stop(); this.mounted = true; ++this.lifetime; this.state = { ...empty(), generation: this.expectedGeneration }; this.publish(this.state); }
  stop() { this.mounted = false; ++this.lifetime; ++this.sequence; this.abort?.abort(); this.abort = null; this.state = empty(); this.draftVersion = null; this.readError = ''; }
  close = () => {
    if (!this.current()) return;
    ++this.sequence; this.abort?.abort(); this.abort = null;
    this.publish({ ...this.state, opened: false, loading: false, saving: false, ...(this.state.pending ? { phase: 'save_unconfirmed' as const, error: '保存状态未确认。重新打开后，请先读取用户核对记录。' } : {}) });
  };
  open = async () => { if (!this.current()) return; this.publish({ ...this.state, opened: true }); await this.refresh(); };
  edit = (change: { outcome?: JobOutcomeReviewOutcome | ''; note?: string }) => {
    if (!this.current() || this.state.saving || this.state.pending || this.state.phase === 'saved') return;
    this.publish({ ...this.state, ...change, dirty: true, error: '' });
  };
  acknowledgeConflict = () => {
    const page = this.state.page;
    if (!this.current() || this.state.loading || !this.state.readCurrent || this.state.pending || this.state.phase !== 'conflict' || !page?.writeEligibility.allowed || !page.evidence || page.requestedGeneration !== this.state.generation) return;
    this.draftVersion = { evidenceVersion: page.evidence.version, revision: page.latestRevision };
    this.publish({ ...this.state, phase: 'editing', error: '', notice: '最新服务器事实与核对记录已读取。原稿保留；保存仍只增加用户核对记录。' });
  };
  newReport = () => {
    const page = this.state.page;
    if (!this.current() || this.state.loading || !this.state.readCurrent || this.state.saving || this.state.pending || this.state.phase !== 'saved' || !page?.writeEligibility.allowed || !page.evidence) return;
    this.draftVersion = { evidenceVersion: page.evidence.version, revision: page.latestRevision };
    this.publish({ ...this.state, phase: 'editing', outcome: '', note: '', dirty: false, saved: null, error: '', notice: '新增一条用户核对记录。已有记录保留，执行状态不变。' });
  };
  refresh = async () => {
    if (!this.current() || !this.state.opened || this.state.saving) return;
    if (!this.environment.isOnline()) { this.readError = this.state.pending ? '保存状态未确认。当前离线；联网后明确读取记录，不会重新发送保存请求。' : '当前离线，无法核对最新记录。原稿保留。'; this.publish({ ...this.state, readCurrent: false, error: this.readError }); return; }
    const lifetime = this.lifetime, sequence = ++this.sequence, abort = new AbortController();
    this.abort?.abort(); this.abort = abort;
    const active = () => this.current() && this.lifetime === lifetime && this.sequence === sequence && !abort.signal.aborted;
    this.publish({ ...this.state, loading: true, readCurrent: false });
    try {
      const page = await this.api.read(this.jobId, this.state.generation, abort.signal);
      if (!active()) return;
      // The first owned read fixes a standalone card's version. Later reads never adopt a new version.
      if (this.state.generation !== undefined && page.requestedGeneration !== this.state.generation) throw new Error('读取返回了不同任务版本。原核对稿已保留。');
      const generation = this.state.generation ?? page.requestedGeneration, pending = this.state.pending;
      const remainingError = this.state.error === this.readError ? '' : this.state.error;
      this.readError = '';
      if (pending) {
        const found = page.records.find((record) => record.requestId === pending.requestId);
        if (found) {
          const saved = parseJobOutcomeReviewSaved({ record: found }, this.jobId, pending);
          this.draftVersion = page.evidence ? { evidenceVersion: page.evidence.version, revision: page.latestRevision } : null;
          this.publish({ ...this.state, page, generation, loading: false, readCurrent: true, phase: 'saved', pending: null, saved, dirty: false, error: '', notice: '已从保存记录确认本次用户核对。任务执行状态没有改变。' });
        } else this.publish({ ...this.state, page, generation, loading: false, readCurrent: true, phase: 'save_unconfirmed', error: '保存状态未确认。在最近记录中未找到本次请求；这不证明没有保存。不会自动重发，也不会发起新的保存。' });
        return;
      }
      const changed = this.draftVersion && page.evidence && (this.draftVersion.evidenceVersion !== page.evidence.version || this.draftVersion.revision !== page.latestRevision);
      const conflict = this.state.phase === 'conflict' || this.state.dirty && Boolean(changed);
      if (!this.state.dirty && this.state.phase !== 'conflict') this.draftVersion = page.evidence ? { evidenceVersion: page.evidence.version, revision: page.latestRevision } : null;
      this.publish({ ...this.state, page, generation, loading: false, readCurrent: true, error: remainingError, ...(conflict ? { phase: 'conflict' as const, error: remainingError || '服务器事实或核对记录已变化。原稿保留，请先核对最新内容。' } : {}) });
    } catch (error) {
      if (active()) { this.readError = `${errorText(error)} 原稿和上次读取的记录保留，不能当作最新状态。`; this.publish({ ...this.state, loading: false, error: this.readError }); }
    } finally { if (this.abort === abort) this.abort = null; }
  };
  save = async () => {
    const page = this.state.page, base = this.draftVersion;
    if (!this.current() || this.state.loading || !this.state.readCurrent || this.state.saving || this.state.pending || this.state.phase !== 'editing' || !page?.writeEligibility.allowed || !page.evidence || !base || !this.state.outcome) return;
    if (!this.environment.isOnline()) { this.publish({ ...this.state, error: '当前离线，核对稿未发送。联网后请先读取最新记录。' }); return; }
    if (!validJobOutcomeReviewNote(this.state.note)) { this.publish({ ...this.state, error: '核对说明最多 2,000 字且不超过 8 KiB。' }); return; }
    if (page.requestedGeneration !== this.state.generation || base.evidenceVersion !== page.evidence.version || base.revision !== page.latestRevision) { this.publish({ ...this.state, phase: 'conflict', error: '服务器事实或核对记录已变化，原稿保留。请先读取并核对最新记录。' }); return; }
    let requestId: string;
    try { requestId = this.environment.requestId(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) throw new Error(); }
    catch { this.publish({ ...this.state, error: '无法生成本次保存标识。核对稿未发送，请稍后再试。' }); return; }
    const note = this.state.note.trim(), input: JobOutcomeReviewInput = { generation: page.requestedGeneration, evidenceVersion: base.evidenceVersion, expectedRevision: base.revision, requestId, outcome: this.state.outcome, ...(note ? { note } : {}) };
    const lifetime = this.lifetime, sequence = ++this.sequence, abort = new AbortController(); this.abort?.abort(); this.abort = abort;
    const active = () => this.current() && this.lifetime === lifetime && this.sequence === sequence && !abort.signal.aborted;
    this.publish({ ...this.state, saving: true, pending: input, error: '', notice: '' });
    try {
      const saved = await this.api.save(this.jobId, input, abort.signal);
      if (!active()) return;
      const record = parseJobOutcomeReviewSaved({ record: saved }, this.jobId, input);
      this.draftVersion = { evidenceVersion: page.evidence.version, revision: record.revision };
      this.publish({ ...this.state, saving: false, pending: null, saved: record, phase: 'saved', dirty: false, error: '', notice: '用户核对记录已保存。服务器结果仍需按原任务状态与回执判断。', page: { ...page, latestRevision: record.revision, records: [record, ...page.records].slice(0, 20), hasMore: page.hasMore || page.records.length >= 20 } });
    } catch (error) {
      if (!active()) return;
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500;
      this.publish({ ...this.state, saving: false, readCurrent: false, pending: rejected ? null : input, phase: rejected ? 'conflict' : 'save_unconfirmed', error: rejected ? `${errorText(error)} 原任务版本与核对稿保留，请先读取最新记录。` : '保存状态未确认。请求可能已经保存；请明确读取记录确认，不会自动重发。' });
    } finally { if (this.abort === abort) this.abort = null; }
  };
}
