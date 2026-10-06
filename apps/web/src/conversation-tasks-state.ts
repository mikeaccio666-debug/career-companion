import type { ConversationTask } from '@companion/platform-contracts';
import { AccountPollingController, type AccountPollingEnvironment, type AccountRefreshResult } from './account-polling.ts';
import { errorText } from './api.ts';
import type { createConversationTaskClient } from './conversation-tasks-api.ts';

export const CONVERSATION_TASK_WINDOW_PAGES = 5;
export interface ConversationTaskSnapshot {
  tasks: ConversationTask[]; nextBefore: string | null; loading: boolean; loadingMore: boolean;
  error: string; pageCount: number; olderWindow: boolean; loaded: boolean;
}
const empty: ConversationTaskSnapshot = { tasks: [], nextBefore: null, loading: false, loadingMore: false, error: '', pageCount: 0, olderWindow: false, loaded: false };

/** One captured account and conversation, including StrictMode remount and ignored late transport completions. */
export class ConversationTaskController {
  private state = empty;
  private listeners = new Set<() => void>();
  private mounted = false;
  private sequence = 0;
  private abort: AbortController | null = null;
  private pages = 1;
  private before: string | undefined;
  private polling: AccountPollingController | null = null;
  private lifetime = 0;
  private api: ReturnType<typeof createConversationTaskClient>;
  readonly conversationId: string;
  private environment: AccountPollingEnvironment;
  constructor(api: ReturnType<typeof createConversationTaskClient>, conversationId: string, environment: AccountPollingEnvironment) { this.api = api; this.conversationId = conversationId; this.environment = environment; }
  private current = () => this.mounted && this.environment.isCurrent();
  getSnapshot = (): ConversationTaskSnapshot => this.current() ? this.state : empty;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: ConversationTaskSnapshot) { if (!this.current()) return; this.state = state; for (const listener of this.listeners) listener(); }
  start() {
    this.stop(); const lifetime = ++this.lifetime;
    this.mounted = true; this.pages = 1; this.before = undefined; this.publish(empty);
    this.polling = new AccountPollingController(() => this.read(), { ...this.environment, isCurrent: () => this.current() && this.lifetime === lifetime });
    this.polling.start();
  }
  stop() { this.mounted = false; ++this.lifetime; ++this.sequence; this.abort?.abort(); this.abort = null; this.polling?.stop(); this.polling = null; this.state = empty; }
  resume = () => this.polling?.resume();
  refresh = () => this.polling?.refreshNow() ?? Promise.resolve();
  more = () => {
    if (!this.current() || this.state.loading || !this.state.nextBefore) return;
    if (!this.environment.isOnline()) { this.publish({ ...this.state, error: '当前离线，暂时无法读取更早的任务。已有记录保留，联网后可明确刷新。' }); return; }
    if (this.pages >= CONVERSATION_TASK_WINDOW_PAGES) { this.before = this.state.nextBefore; this.pages = 1; this.cancelRead(); this.publish({ ...empty, olderWindow: true, loading: true }); }
    else { this.pages++; this.publish({ ...this.state, loading: true, loadingMore: true }); }
    void this.refresh();
  };
  recent = () => {
    if (!this.current() || !this.before || this.state.loading) return;
    this.before = undefined; this.pages = 1; this.cancelRead(); this.publish({ ...empty, loading: true }); void this.refresh();
  };
  private cancelRead() { ++this.sequence; this.abort?.abort(); this.abort = null; }
  private async read(): Promise<AccountRefreshResult> {
    if (!this.current()) return { status: 'discarded' };
    const sequence = ++this.sequence, controller = new AbortController(), count = this.pages, anchor = this.before;
    this.abort?.abort(); this.abort = controller;
    const active = () => this.current() && this.sequence === sequence && !controller.signal.aborted;
    this.publish({ ...this.state, loading: true });
    try {
      const tasks: ConversationTask[] = [], seen = new Set<string>(), cursors = new Set<string>();
      let before = anchor, nextBefore: string | null = null, pageCount = 0;
      for (let page = 0; page < count; page++) {
        const result = await this.api.list(this.conversationId, { before, limit: 20, signal: controller.signal });
        if (!active()) return { status: 'discarded' };
        for (const task of result.tasks) { if (!seen.has(task.job.id)) { seen.add(task.job.id); tasks.push(task); } }
        pageCount++; nextBefore = result.nextBefore;
        if (!nextBefore) break;
        if (cursors.has(nextBefore)) throw new Error('任务分页未推进，请重新读取最近记录。');
        cursors.add(nextBefore); before = nextBefore;
      }
      this.publish({ tasks, nextBefore, pageCount, loading: false, loadingMore: false, error: '', olderWindow: !!anchor, loaded: true });
      return { status: 'applied', value: [{ status: 'fulfilled', value: tasks }] };
    } catch (error) {
      if (!active()) return { status: 'discarded' };
      this.publish({ ...this.state, loading: false, loadingMore: false, error: `${errorText(error)}${this.state.loaded ? ' 这里保留上次读取的记录，不能当作最新状态。' : ''}` });
      return { status: 'failed', error };
    } finally { if (this.abort === controller) this.abort = null; }
  }
}
