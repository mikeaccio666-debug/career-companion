import type { GoalPlanProposalSummary } from '@companion/platform-contracts';
import { AccountPollingController, type AccountPollingEnvironment, type AccountRefreshResult } from './account-polling.ts';
import { errorText } from './api.ts';
import type { createConversationGoalPlanClient } from './conversation-goal-plans-api.ts';

export const GOAL_PROPOSAL_WINDOW_PAGES = 5;
export interface ConversationGoalPlanSnapshot {
  proposals: GoalPlanProposalSummary[]; nextBefore: string | null; loaded: boolean; loading: boolean;
  error: string; pageCount: number; olderWindow: boolean;
}
const empty: ConversationGoalPlanSnapshot = { proposals: [], nextBefore: null, loaded: false, loading: false, error: '', pageCount: 0, olderWindow: false };
/** A fixed account/conversation, bounded windows and server cursors. No model/approval/write port exists. */
export class ConversationGoalPlanController {
  private state = empty; private listeners = new Set<() => void>(); private mounted = false;
  private lifetime = 0; private sequence = 0; private abort: AbortController | null = null;
  private pages = 1; private anchor: string | undefined; private polling: AccountPollingController | null = null;
  private api: ReturnType<typeof createConversationGoalPlanClient>; readonly conversationId: string; private environment: AccountPollingEnvironment;
  constructor(api: ReturnType<typeof createConversationGoalPlanClient>, conversationId: string, environment: AccountPollingEnvironment) { this.api = api; this.conversationId = conversationId; this.environment = environment; }
  private current = () => this.mounted && this.environment.isCurrent();
  getSnapshot = () => this.current() ? this.state : empty;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: ConversationGoalPlanSnapshot) { if (!this.current()) return; this.state = state; for (const listener of this.listeners) listener(); }
  start() { this.stop(); this.mounted = true; const lifetime = ++this.lifetime; this.pages = 1; this.anchor = undefined; this.publish(empty); this.polling = new AccountPollingController(() => this.read(), { ...this.environment, isCurrent: () => this.current() && this.lifetime === lifetime }); this.polling.start(); }
  stop() { this.mounted = false; ++this.lifetime; this.cancelRead(); this.polling?.stop(); this.polling = null; this.state = empty; }
  refresh = () => this.polling?.refreshNow() ?? Promise.resolve();
  resume = () => this.polling?.resume();
  private cancelRead() { ++this.sequence; this.abort?.abort(); this.abort = null; }
  more = () => {
    if (!this.current() || this.state.loading || !this.state.nextBefore) return;
    if (!this.environment.isOnline()) { this.publish({ ...this.state, error: '当前离线，已有计划记录保留。联网后可以明确刷新或读取更早记录。' }); return; }
    if (this.pages >= GOAL_PROPOSAL_WINDOW_PAGES) { this.anchor = this.state.nextBefore; this.pages = 1; this.cancelRead(); this.publish({ ...empty, olderWindow: true, loading: true }); }
    else { ++this.pages; this.publish({ ...this.state, loading: true }); }
    void this.refresh();
  };
  recent = () => { if (!this.current() || this.state.loading || !this.anchor) return; if (!this.environment.isOnline()) { this.publish({ ...this.state, error: '当前离线，已有较早记录保留。联网后可以回到最近计划。' }); return; } this.anchor = undefined; this.pages = 1; this.cancelRead(); this.publish({ ...empty, loading: true }); void this.refresh(); };
  private async read(): Promise<AccountRefreshResult> {
    if (!this.current()) return { status: 'discarded' };
    const sequence = ++this.sequence, lifetime = this.lifetime, controller = new AbortController(), count = this.pages, anchor = this.anchor;
    this.abort?.abort(); this.abort = controller;
    const active = () => this.current() && this.lifetime === lifetime && this.sequence === sequence && !controller.signal.aborted;
    this.publish({ ...this.state, loading: true });
    try {
      const proposals: GoalPlanProposalSummary[] = [], seen = new Set<string>(), cursors = new Set<string>();
      let before = anchor, nextBefore: string | null = null, pageCount = 0;
      for (let page = 0; page < count; page++) {
        const result = await this.api.list(this.conversationId, { before, limit: 20, signal: controller.signal });
        if (!active()) return { status: 'discarded' };
        for (const item of result.proposals) { if (seen.has(item.planId)) throw new Error('计划分页出现重复记录，请重新读取。'); seen.add(item.planId); proposals.push(item); }
        ++pageCount; nextBefore = result.nextBefore;
        if (!nextBefore) break;
        if (cursors.has(nextBefore)) throw new Error('计划分页没有推进，请重新读取。'); cursors.add(nextBefore); before = nextBefore;
      }
      this.publish({ proposals, nextBefore, loaded: true, loading: false, error: '', pageCount, olderWindow: !!anchor });
      return { status: 'applied', value: [{ status: 'fulfilled', value: proposals }] };
    } catch (error) { if (!active()) return { status: 'discarded' }; this.publish({ ...this.state, loading: false, error: `${errorText(error)}${this.state.loaded ? ' 已保留上次记录，不能当作最新状态。' : ''}` }); return { status: 'failed', error }; }
    finally { if (this.abort === controller) this.abort = null; }
  }
}
