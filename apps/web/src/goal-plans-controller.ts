import type { GoalPlan, GoalPlanContinuation, GoalPlanContinueResult } from '@companion/platform-contracts';
import { AccountPollingController, type AccountPollingEnvironment, type AccountRefreshResult } from './account-polling.ts';
import { ApiError, errorText } from './api.ts';
import type { createGoalPlanClient } from './goal-plans-api.ts';
import { goalInputToDraft, newGoalDraft, parseGoalDraft, type GoalPlanDraft } from './goal-plans-editor.ts';
import type { GoalPlanWorkspacePort } from './goal-plan-workspace.ts';

export interface GoalPlanSnapshot {
  plans: GoalPlan[]; selectedId: string | null; loaded: boolean; loading: boolean; busy: boolean;
  error: string; operationError: string; notice: string; editor: GoalPlanDraft; editing: boolean; dirty: boolean;
  editorPlanId: string | null; editorRevision: number | null; conflict: boolean;
  continuation: GoalPlanContinuation | null;
  pendingReviewId: string | null;
}
const empty = (): GoalPlanSnapshot => ({ plans: [], selectedId: null, loaded: false, loading: false, busy: false, error: '', operationError: '', notice: '', editor: newGoalDraft(), editing: true, dirty: false, editorPlanId: null, editorRevision: null, conflict: false, continuation: null, pendingReviewId: null });
const hidden = empty();
/** One immutable account/conversation. Polling replaces server records, never unsaved editor contents. */
export class GoalPlanController {
  private state = empty(); private mounted = false; private lifetime = 0; private readSequence = 0;
  private readAbort: AbortController | null = null; private writeAbort: AbortController | null = null;
  private polling: AccountPollingController | null = null; private listeners = new Set<() => void>();
  private api: ReturnType<typeof createGoalPlanClient>; private environment: AccountPollingEnvironment;
  private workspace?: GoalPlanWorkspacePort;
  constructor(api: ReturnType<typeof createGoalPlanClient>, environment: AccountPollingEnvironment, workspace?: GoalPlanWorkspacePort) { this.api = api; this.environment = environment; this.workspace = workspace; }
  private current = () => this.mounted && this.environment.isCurrent();
  getSnapshot = (): GoalPlanSnapshot => this.current() ? this.state : hidden;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: GoalPlanSnapshot) { if (!this.current()) return; this.state = next; this.rememberWorkspace(); for (const listener of this.listeners) listener(); }
  private rememberWorkspace() { if (!this.current()) return; const { selectedId, editor, editing, dirty, editorPlanId, editorRevision, conflict } = this.state; this.workspace?.save({ selectedId, editor, editing, dirty, editorPlanId, editorRevision, conflict }); }
  start() { this.stop(); this.mounted = true; const lifetime = ++this.lifetime; this.publish({ ...empty(), ...this.workspace?.load() }); this.polling = new AccountPollingController(() => this.read(), { ...this.environment, isCurrent: () => this.current() && lifetime === this.lifetime }); this.polling.start(); }
  stop() { this.mounted = false; ++this.lifetime; ++this.readSequence; this.readAbort?.abort(); this.writeAbort?.abort(); this.readAbort = null; this.writeAbort = null; this.polling?.stop(); this.polling = null; this.state = empty(); }
  resume = () => this.polling?.resume();
  refresh = () => this.polling?.refreshNow() ?? Promise.resolve();
  edit = (editor: GoalPlanDraft) => { if (this.current() && !this.state.busy && this.state.editing) this.publish({ ...this.state, editor, dirty: true, error: '', operationError: '', notice: '' }); };
  select = (id: string, discardEditor = false) => { const plan = this.state.plans.find((item) => item.id === id); if (!this.current() || this.state.busy || !plan) return; if (this.state.dirty && !discardEditor) { this.publish({ ...this.state, pendingReviewId: id, notice: '未保存的编辑已保留，请先保存或明确放弃后再切换计划。' }); return; } this.cancelRead(); this.publish({ ...this.state, selectedId: id, editor: goalInputToDraft({ ...plan, steps: plan.steps.map((step) => step.input) }), editing: plan.status === 'draft', dirty: false, editorPlanId: plan.status === 'draft' ? id : null, editorRevision: plan.status === 'draft' ? plan.revision : null, conflict: false, continuation: null, notice: '', error: '', operationError: '', loading: false, pendingReviewId: null }); };
  newDraft = (discardEditor = false) => { if (!this.current() || this.state.busy) return; if (this.state.dirty && !discardEditor) { this.report(new Error('未保存的计划编辑已保留。请先保存或明确放弃未保存编辑，再建立新计划。')); return; } this.cancelRead(); this.publish({ ...this.state, selectedId: null, editor: newGoalDraft(), editing: true, dirty: false, editorPlanId: null, editorRevision: null, conflict: false, continuation: null, notice: '', error: '', operationError: '', loading: false, pendingReviewId: null }); };
  copy = () => { if (!this.current() || this.state.busy || !this.state.selectedId) return; if (this.state.dirty) { this.report(new Error('已有未保存的计划编辑，请先保存或明确放弃，再开始新副本。')); return; } const plan = this.state.plans.find((item) => item.id === this.state.selectedId); if (!plan) return; this.publish({ ...this.state, editor: goalInputToDraft({ ...plan, steps: plan.steps.map((step) => step.input) }), editing: true, dirty: true, editorPlanId: null, editorRevision: null, conflict: false, continuation: null, notice: '正在编辑新副本。原计划与已有执行记录保留。', error: '', operationError: '' }); };
  clearContinuation = () => { if (this.current()) this.publish({ ...this.state, continuation: null }); };
  report = (error: unknown) => { if (this.current()) { const message = errorText(error); this.publish({ ...this.state, error: message, operationError: message }); } };
  cancelReview = () => { if (this.current() && !this.state.busy) this.publish({ ...this.state, pendingReviewId: null, notice: '' }); };
  /** Explicit owned read, including plans outside the recent list. Never replaces an unsaved editor silently. */
  open = async (id: string, discardEditor = false): Promise<boolean> => {
    if (!this.current() || this.state.busy) return false;
    if (this.state.dirty && !discardEditor) { this.publish({ ...this.state, pendingReviewId: id, notice: '未保存的计划编辑已保留。请先保存，或明确放弃这些编辑后再打开指定计划。' }); return false; }
    if (!this.environment.isOnline()) { const message = '当前离线，未读取指定计划。原有编辑与选择保留。'; this.publish({ ...this.state, pendingReviewId: id, error: message, operationError: message }); return false; }
    this.cancelRead(); const controller = new AbortController(), lifetime = this.lifetime;
    this.writeAbort = controller; this.publish({ ...this.state, busy: true, loading: false, error: '', operationError: '' });
    const active = () => this.current() && lifetime === this.lifetime && this.writeAbort === controller && !controller.signal.aborted;
    try {
      const plan = await this.api.read(id, controller.signal); if (!active()) return false;
      this.publish({ ...this.state, plans: this.remember(plan), selectedId: plan.id, loaded: true, busy: false, editor: goalInputToDraft({ ...plan, steps: plan.steps.map((step) => step.input) }), editing: plan.status === 'draft', dirty: false, editorPlanId: plan.status === 'draft' ? plan.id : null, editorRevision: plan.status === 'draft' ? plan.revision : null, conflict: false, continuation: null, pendingReviewId: null, notice: '已读取指定计划。请编辑并审阅；打开计划没有确认或执行任何步骤。' }); return true;
    } catch (error) { if (!active()) return false; this.publish({ ...this.state, busy: false, pendingReviewId: id, error: errorText(error), operationError: errorText(error) }); return false; }
    finally { if (this.writeAbort === controller) this.writeAbort = null; }
  };
  private cancelRead() { ++this.readSequence; this.readAbort?.abort(); this.readAbort = null; }
  private remember(plan: GoalPlan) { return [plan, ...this.state.plans.filter((item) => item.id !== plan.id)].slice(0, 51); }
  private async read(): Promise<AccountRefreshResult> {
    if (!this.current() || this.state.busy) return { status: 'discarded' };
    const controller = new AbortController(), sequence = ++this.readSequence, lifetime = this.lifetime;
    this.readAbort?.abort(); this.readAbort = controller;
    const active = () => this.current() && lifetime === this.lifetime && sequence === this.readSequence && !controller.signal.aborted;
    this.publish({ ...this.state, loading: true });
    try {
      let { plans } = await this.api.list(controller.signal);
      if (!active()) return { status: 'discarded' };
      if (this.state.selectedId && !plans.some((plan) => plan.id === this.state.selectedId)) plans = [await this.api.read(this.state.selectedId, controller.signal), ...plans];
      if (!active()) return { status: 'discarded' };
      const selected = plans.find((plan) => plan.id === this.state.selectedId), continuation = this.state.continuation;
      this.publish({ ...this.state, plans, loaded: true, loading: false, error: this.state.operationError, conflict: this.state.conflict || !!(selected && this.state.editorPlanId === selected.id && this.state.editorRevision !== selected.revision), continuation: continuation && selected?.revision === continuation.revision && selected.steps[continuation.stepIndex]?.state === 'pending' ? continuation : null });
      return { status: 'applied', value: [{ status: 'fulfilled', value: plans }] };
    } catch (error) {
      if (!active()) return { status: 'discarded' };
      this.publish({ ...this.state, loading: false, error: `${this.state.operationError ? `${this.state.operationError}\n` : ''}${errorText(error)}${this.state.loaded ? ' 已保留上次记录，不能当作最新状态。' : ''}` }); return { status: 'failed', error };
    } finally { if (this.readAbort === controller) this.readAbort = null; }
  }
  private async mutate<T extends GoalPlan | GoalPlanContinueResult>(work: (signal: AbortSignal) => Promise<T>, apply: (value: T) => Partial<GoalPlanSnapshot>): Promise<T | undefined> {
    if (!this.current() || this.state.busy) return;
    if (!this.environment.isOnline()) { this.report(new Error('当前离线，未发送保存或执行请求。编辑内容保留。')); return; }
    this.cancelRead(); const controller = new AbortController(), lifetime = this.lifetime;
    this.writeAbort = controller; this.publish({ ...this.state, busy: true, loading: false, error: '', operationError: '', notice: '' });
    const active = () => this.current() && lifetime === this.lifetime && this.writeAbort === controller && !controller.signal.aborted;
    try { const result = await work(controller.signal); if (!active()) return; const plan = Object.hasOwn(result, 'plan') ? (result as GoalPlanContinueResult).plan : result as GoalPlan; this.publish({ ...this.state, plans: this.remember(plan), ...apply(result), busy: false, error: '', operationError: '' }); return result; }
    catch (error) {
      if (!active()) return;
      const conflict = error instanceof ApiError && error.code === 'GOAL_PLAN_REVISION_CONFLICT';
      const message = conflict ? '计划版本已变化。你的编辑仍保留，请读取最新记录对照，或将编辑另存为新计划。' : errorText(error);
      this.publish({ ...this.state, busy: false, conflict: this.state.conflict || conflict, error: message, operationError: message });
      void this.refresh();
    } finally { if (this.writeAbort === controller) this.writeAbort = null; }
  }
  save = async (asCopy = false): Promise<GoalPlan | undefined> => {
    if (!this.current() || !this.state.editing || this.state.conflict && !asCopy) return;
    let input; try { input = parseGoalDraft(this.state.editor); } catch (error) { this.report(error); return; }
    const id = asCopy ? null : this.state.editorPlanId, revision = this.state.editorRevision;
    return this.mutate((signal) => id && revision ? this.api.save(id, revision, input, signal) : this.api.create(input, signal), (plan) => ({ selectedId: plan.id, editor: goalInputToDraft({ ...plan, steps: plan.steps.map((step) => step.input) }), editing: true, dirty: false, editorPlanId: plan.id, editorRevision: plan.revision, conflict: false, continuation: null, notice: '草稿已保存。审阅全部步骤后再确认；保存没有执行任务。' }));
  };
  confirm = async () => { const plan = this.selected(); if (!plan || plan.status !== 'draft' || this.state.dirty || this.state.conflict) return; return this.mutate((signal) => this.api.confirm(plan.id, plan.revision, signal), () => ({ editing: false, dirty: false, editorPlanId: null, editorRevision: null, continuation: null, notice: '计划已确认。请明确继续当前步骤；确认计划没有批准任何外部任务。' })); };
  changeState = async (status: 'paused' | 'active' | 'cancelled') => { const plan = this.selected(); if (!plan || this.state.dirty) return; return this.mutate((signal) => this.api.state(plan.id, plan.revision, status, signal), () => ({ continuation: null, notice: status === 'paused' ? '计划已暂停。已提交的任务仍须在各自任务记录中核对。' : status === 'cancelled' ? '计划已取消。取消计划不会撤销已经执行的外部操作。' : '计划已恢复。下一步仍需明确继续。' })); };
  continue = async (index: number) => { const plan = this.selected(); if (!plan || this.state.dirty || this.state.conflict || plan.status !== 'active' || !plan.steps[index]?.ready) return; return this.mutate((signal) => this.api.continue(plan.id, plan.revision, index, signal), (result) => ({ continuation: result.kind === 'agent_turn' ? result.continuation : null, notice: result.kind === 'task' ? '本步任务已准备。请审阅下方独立审批与任务记录。' : result.kind === 'agent_turn' ? '分析已准备。点击“执行本步分析”才调用模型；原会话草稿与附件保留。' : '本步已有固定记录。没有再次执行，请查看当前状态。' })); };
  selected = () => this.state.plans.find((plan) => plan.id === this.state.selectedId);
}
