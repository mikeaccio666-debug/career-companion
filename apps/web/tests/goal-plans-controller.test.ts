import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalPlan, GoalPlanContinueResult } from '@companion/platform-contracts';
import { ApiError } from '../src/api.ts';
import { GoalPlanController } from '../src/goal-plans-controller.ts';
import type { createGoalPlanClient } from '../src/goal-plans-api.ts';
import { goalInputToDraft } from '../src/goal-plans-editor.ts';
import { activePlan, conversationId, deferred, flush, input, plan, planId, taskPlan } from './goal-plans-fixture.ts';
import { GoalPlanWorkspaceStore } from '../src/goal-plan-workspace.ts';

function clock() { let now = 0, next = 0; const timers = new Map<number, { at: number; run: () => void }>(); return { now: () => now, count: () => timers.size, setTimer(run: () => void, delay: number) { const id = ++next; timers.set(id, { at: now + delay, run }); return id; }, clearTimer(id: unknown) { timers.delete(id as number); }, async advance(delay: number) { const end = now + delay; while (true) { const entry = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!entry) break; now = entry[1].at; timers.delete(entry[0]); entry[1].run(); await flush(); } now = end; await flush(); } }; }
function harness(overrides: Partial<ReturnType<typeof createGoalPlanClient>> = {}) {
  const timer = clock(), state = { current: true, online: true, visible: true };
  const api: ReturnType<typeof createGoalPlanClient> = { list: async () => ({ plans: [plan()], limit: 50 }), read: async () => plan(), create: async () => plan(), save: async () => plan({ revision: 2 }), confirm: async () => activePlan(), state: async () => activePlan(), continue: async () => ({ kind: 'agent_turn', plan: activePlan(), stepIndex: 0, continuation: { planId, conversationId, revision: 1, stepIndex: 0 } }), ...overrides };
  const controller = new GoalPlanController(api, { ...timer, isCurrent: () => state.current, isOnline: () => state.online, isVisible: () => state.visible });
  return { controller, state, timer, api };
}

test('polling and CAS conflicts keep exact unsaved editor contents, with explicit copy/reload recovery', async () => {
  let currentPlan = plan(), copyInput: unknown;
  const context = harness({ list: async () => ({ plans: [currentPlan], limit: 50 }), save: async () => { currentPlan = plan({ revision: 2, title: 'Fictional other-window edit' }); throw new ApiError('Changed', 409, 'GOAL_PLAN_REVISION_CONFLICT'); }, create: async (input) => { copyInput = input; return plan({ id: '71000000-0000-4000-8000-000000000010', title: input.title, goal: input.goal, steps: input.steps.map((input, index) => ({ index, input, state: 'pending', ready: false, artifacts: [] })) }); } });
  context.controller.start(); await flush(); context.controller.select(planId);
  const editor = { ...context.controller.getSnapshot().editor, goal: 'Fictional exact unsaved local edit.' }; context.controller.edit(editor);
  await context.controller.refresh(); assert.equal(context.controller.getSnapshot().editor, editor);
  await context.controller.save(); await flush(); assert.equal(context.controller.getSnapshot().conflict, true); assert.equal(context.controller.getSnapshot().editor, editor);
  assert.equal(await context.controller.save(), undefined); await context.controller.save(true); assert.equal((copyInput as { goal: string }).goal, editor.goal); assert.equal(context.controller.getSnapshot().conflict, false); assert.equal(context.controller.getSnapshot().dirty, false); context.controller.stop();
});

test('a refreshed server revision never silently rebases an old editor or lets it confirm', async () => {
  let latest = plan(), confirmations = 0; const context = harness({ list: async () => ({ plans: [latest], limit: 50 }), confirm: async () => { confirmations++; return activePlan(); } });
  context.controller.start(); await flush(); context.controller.select(planId); const editor = context.controller.getSnapshot().editor;
  latest = plan({ revision: 2, goal: 'Fictional newer server goal.' }); await context.controller.refresh();
  assert.equal(context.controller.getSnapshot().editor, editor); assert.equal(context.controller.getSnapshot().editorRevision, 1); assert.equal(context.controller.getSnapshot().conflict, true);
  await context.controller.confirm(); assert.equal(confirmations, 0); context.controller.select(planId); assert.equal(context.controller.getSnapshot().editor.goal, latest.goal); assert.equal(context.controller.getSnapshot().editorRevision, 2); context.controller.stop();
});

test('one explicit continue prepares one task; it never invokes approval, model, or a second concurrent mutation', async () => {
  const pending = deferred<GoalPlanContinueResult>(); let calls = 0; const ready = activePlan(); ready.steps[0].input = taskPlan().steps[0].input;
  const context = harness({ list: async () => ({ plans: [ready], limit: 50 }), continue: async () => { calls++; return pending.promise; } });
  context.controller.start(); await flush(); context.controller.select(planId);
  const first = context.controller.continue(0); await context.controller.continue(0); assert.equal(calls, 1);
  const task = taskPlan(); pending.resolve({ kind: 'task', plan: task, stepIndex: 0, job: task.steps[0].job!, approval: task.steps[0].approval }); await first;
  assert.equal(context.controller.getSnapshot().plans[0].steps[0].state, 'needs_approval'); assert.equal(context.controller.getSnapshot().continuation, null); assert.equal(calls, 1); context.controller.stop();
});

test('analysis preparation only stores the fixed continuation, and polling discards it when the server step changes', async () => {
  let latest = activePlan(); const context = harness({ list: async () => ({ plans: [latest], limit: 50 }) });
  context.controller.start(); await flush(); context.controller.select(planId); await context.controller.continue(0);
  assert.deepEqual(context.controller.getSnapshot().continuation, { planId, conversationId, revision: 1, stepIndex: 0 });
  latest = { ...activePlan(), revision: 2 }; await context.controller.refresh(); assert.equal(context.controller.getSnapshot().continuation, null); context.controller.stop();
});

test('late reads and writes cannot repaint a changed account or a StrictMode remount', async () => {
  for (const fail of [false, true]) {
    const pending = deferred<GoalPlan>(), signals: AbortSignal[] = [];
    const context = harness({ create: async (_input, signal) => { signals.push(signal!); return pending.promise; } });
    context.controller.start(); await flush(); context.controller.edit(goalInputToDraft(input())); const write = context.controller.save(); context.controller.stop(); assert.equal(signals[0].aborted, true);
    context.controller.start(); await flush(); const clean = context.controller.getSnapshot();
    if (fail) pending.reject(new Error('Fictional late private failure')); else pending.resolve(plan()); await write;
    assert.equal(context.controller.getSnapshot(), clean); context.state.current = false; assert.equal(context.controller.getSnapshot().plans.length, 0); assert.equal(context.controller.getSnapshot().editor.goal, ''); context.controller.stop(); assert.equal(context.timer.count(), 0);
  }
});

test('mutation cancels an older poll so a late read cannot replace its newer saved version', async () => {
  const pending = deferred<{ plans: GoalPlan[]; limit: number }>(); let reads = 0, readSignal!: AbortSignal;
  const context = harness({ list: async (signal) => { if (++reads === 1) return { plans: [plan()], limit: 50 }; readSignal = signal!; return pending.promise; } });
  context.controller.start(); await flush(); context.controller.select(planId); context.controller.edit({ ...context.controller.getSnapshot().editor, title: 'Fictional edit' });
  const read = context.controller.refresh(); await flush(); await context.controller.save(); assert.equal(readSignal.aborted, true); assert.equal(context.controller.getSnapshot().plans[0].revision, 2);
  pending.resolve({ plans: [plan()], limit: 50 }); await read; assert.equal(context.controller.getSnapshot().plans[0].revision, 2); context.controller.stop();
});

test('offline writes send nothing and 429 polling keeps saved records with the server backoff', async () => {
  let reads = 0, writes = 0; const context = harness({ list: async () => { if (++reads === 1) return { plans: [plan()], limit: 50 }; throw new ApiError('Fictional throttle', 429, 'REQUEST_LIMIT_REACHED', 150000); }, create: async () => { writes++; return plan(); } });
  context.controller.start(); await flush(); context.controller.edit(goalInputToDraft(input())); context.state.online = false; await context.controller.save(); assert.equal(writes, 0); assert.equal(context.controller.getSnapshot().editor.goal, input().goal);
  context.state.online = true; await context.controller.refresh(); assert.equal(reads, 2); assert.equal(context.controller.getSnapshot().plans.length, 1); assert.match(context.controller.getSnapshot().error, /不能当作最新/);
  const pending = context.controller.refresh(); await context.timer.advance(149999); assert.equal(reads, 2); await context.timer.advance(1); await pending; assert.equal(reads, 3); context.controller.stop();
});

test('a failed explicit confirmation/analysis stays visible after successful polling until the next explicit edit or operation', async () => {
  const context = harness({ confirm: async () => { throw new ApiError('Fictional provider is unavailable.', 503, 'PROVIDER_UNAVAILABLE'); } });
  context.controller.start(); await flush(); context.controller.select(planId); await context.controller.confirm(); await flush();
  assert.match(context.controller.getSnapshot().error, /provider is unavailable/);
  await context.controller.refresh(); assert.match(context.controller.getSnapshot().error, /provider is unavailable/);
  context.controller.edit({ ...context.controller.getSnapshot().editor, title: 'Fictional explicit edit' }); assert.equal(context.controller.getSnapshot().error, '');
  context.controller.report(new Error('Fictional analysis is not saved.')); await context.controller.refresh(); assert.match(context.controller.getSnapshot().error, /analysis is not saved/); context.controller.stop();
});

test('opening an owned plan outside the recent fifty reads it without any write or implicit preparation', async () => {
  const olderId = '75000000-0000-4000-8000-000000000001', reads: string[] = [];
  const context = harness({ read: async (id) => { reads.push(id); return plan({ id }); }, create: async () => { throw new Error('Must not create'); }, confirm: async () => { throw new Error('Must not confirm'); }, continue: async () => { throw new Error('Must not continue'); } });
  context.controller.start(); await flush(); assert.equal(await context.controller.open(olderId), true); assert.deepEqual(reads, [olderId]); assert.equal(context.controller.getSnapshot().selectedId, olderId); assert.equal(context.controller.getSnapshot().continuation, null); await context.controller.refresh(); assert.equal(context.controller.getSnapshot().plans[0].id, olderId); context.controller.stop();
});

test('an incoming proposal and ordinary plan switch preserve dirty edits until an explicit discard succeeds', async () => {
  const olderId = '75000000-0000-4000-8000-000000000002'; let reads = 0;
  const context = harness({ read: async (id) => { ++reads; return plan({ id }); } }); context.controller.start(); await flush(); context.controller.select(planId); const editor = { ...context.controller.getSnapshot().editor, goal: 'Fictional exact local draft' }; context.controller.edit(editor);
  assert.equal(await context.controller.open(olderId), false); assert.equal(reads, 0); assert.equal(context.controller.getSnapshot().editor, editor); assert.equal(context.controller.getSnapshot().pendingReviewId, olderId); context.controller.cancelReview();
  context.controller.select(planId); assert.equal(context.controller.getSnapshot().editor, editor); context.controller.newDraft(); assert.equal(context.controller.getSnapshot().editor, editor);
  assert.equal(await context.controller.open(olderId, true), true); assert.equal(reads, 1); assert.equal(context.controller.getSnapshot().selectedId, olderId); assert.equal(context.controller.getSnapshot().dirty, false); context.controller.stop();
});

test('a failing or late explicit review keeps the editor and cannot change the selected account lifetime', async () => {
  const old = deferred<GoalPlan>(); let signal!: AbortSignal; const context = harness({ read: async (_id, value) => { signal = value!; return old.promise; } });
  context.controller.start(); await flush(); context.controller.edit(goalInputToDraft(input())); const pending = context.controller.open(planId, true); context.controller.stop(); assert.equal(signal.aborted, true); context.controller.start(); await flush(); const clean = context.controller.getSnapshot(); old.resolve(plan()); assert.equal(await pending, false); assert.equal(context.controller.getSnapshot(), clean); context.controller.stop();
  const failed = harness({ read: async () => { throw new Error('Fictional owned plan deleted'); } }); failed.controller.start(); await flush(); failed.controller.edit(goalInputToDraft(input())); const editor = failed.controller.getSnapshot().editor; await failed.controller.open(planId, true); assert.equal(failed.controller.getSnapshot().editor, editor); assert.equal(failed.controller.getSnapshot().dirty, true); failed.controller.stop();
});

test('leaving and remounting restores only the scoped selection/editor, re-reads server state and does not retain a continuation', async () => {
  const store = new GoalPlanWorkspaceStore(), account = { accountId: '75000000-0000-4000-8000-000000000003', generation: 1 }; store.changeSession(account); const context = harness();
  const controller = new GoalPlanController(context.api, { ...context.timer, isCurrent: () => context.state.current, isOnline: () => true, isVisible: () => true }, { load: () => store.read(account, conversationId), save: (value) => store.save(account, conversationId, value) });
  controller.start(); await flush(); controller.select(planId); controller.edit({ ...controller.getSnapshot().editor, title: 'Fictional retained editor' }); controller.stop(); controller.start(); await flush(); assert.equal(controller.getSnapshot().selectedId, planId); assert.equal(controller.getSnapshot().editor.title, 'Fictional retained editor'); assert.equal(controller.getSnapshot().dirty, true); assert.equal(controller.getSnapshot().continuation, null); assert.equal(controller.getSnapshot().loaded, true); controller.stop();
});
