import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalPlanReviewCoordinator } from '../src/goal-plan-review-request.ts';
import { GoalPlanController } from '../src/goal-plans-controller.ts';
import type { createGoalPlanClient } from '../src/goal-plans-api.ts';
import { deferred, flush, plan, planId } from './goal-plans-fixture.ts';

function harness(read: ReturnType<typeof createGoalPlanClient>['read']) {
  const handled: number[] = [], state = { current: true, online: true }, timers = new Set<unknown>();
  const forbidden = async (): Promise<never> => { throw new Error('A review may not write, approve or execute'); };
  const api: ReturnType<typeof createGoalPlanClient> = { list: async () => ({ plans: [], limit: 50 }), read, create: forbidden, save: forbidden, confirm: forbidden, state: forbidden, continue: forbidden };
  const controller = new GoalPlanController(api, { now: Date.now, isCurrent: () => state.current, isVisible: () => true, isOnline: () => state.online, setTimer: (run) => { timers.add(run); return run; }, clearTimer: (timer) => { timers.delete(timer); } });
  const coordinator = new GoalPlanReviewCoordinator({ isCurrent: () => state.current, open: controller.open, pendingReviewId: () => controller.getSnapshot().pendingReviewId, handled: (serial) => handled.push(serial) });
  const start = () => { controller.start(); coordinator.start(); }, stop = () => { coordinator.stop(); controller.stop(); };
  return { controller, coordinator, handled, state, timers, start, stop };
}

test('StrictMode setup-cleanup-setup retries the specified owned plan and ignores the old completion', async () => {
  for (const rejectOld of [false, true]) {
    const old = deferred<ReturnType<typeof plan>>(), fresh = deferred<ReturnType<typeof plan>>(), signals: AbortSignal[] = []; let reads = 0;
    const context = harness(async (_id, signal) => { signals.push(signal!); return ++reads === 1 ? old.promise : fresh.promise; });
    const request = { planId, serial: 1 };
    context.start(); await flush(); context.coordinator.drive(request, false); assert.equal(reads, 1);
    context.stop(); assert.equal(signals[0].aborted, true); context.start(); await flush(); context.coordinator.drive(request, false); assert.equal(reads, 2);
    if (rejectOld) old.reject(new Error('Fictional late old-mount failure')); else old.resolve(plan({ title: 'Fictional abandoned mount' })); await flush();
    assert.deepEqual(context.handled, []); assert.equal(context.controller.getSnapshot().selectedId, null);
    fresh.resolve(plan()); await flush(); assert.deepEqual(context.handled, [1]); assert.equal(context.controller.getSnapshot().selectedId, planId);
    context.coordinator.drive(request, false); assert.equal(reads, 2); context.stop(); assert.equal(context.timers.size, 0);
  }
});

test('busy renders do not cancel the live ticket, while a subsequent explicit review stays distinct', async () => {
  const first = deferred<ReturnType<typeof plan>>(); let reads = 0;
  const context = harness(async (id) => { ++reads; return reads === 1 ? first.promise : plan({ id }); });
  const secondId = '77000000-0000-4000-8000-000000000001';
  context.start(); await flush(); context.coordinator.drive({ planId, serial: 1 }, false);
  assert.equal(context.controller.getSnapshot().busy, true); context.coordinator.drive({ planId, serial: 1 }, true); context.coordinator.drive({ planId: secondId, serial: 2 }, true); assert.equal(reads, 1);
  first.resolve(plan()); await flush(); assert.deepEqual(context.handled, [1]);
  context.coordinator.drive({ planId: secondId, serial: 2 }, false); await flush(); assert.equal(reads, 2); assert.deepEqual(context.handled, [1, 2]); assert.equal(context.controller.getSnapshot().selectedId, secondId); context.stop();
});

test('dirty and offline reviews defer to explicit panel choices without consuming the editor or executing', async () => {
  let reads = 0; const context = harness(async (id) => { ++reads; return plan({ id }); }); context.start(); await flush();
  context.controller.edit({ ...context.controller.getSnapshot().editor, title: 'Fictional exact unsaved title' }); const editor = context.controller.getSnapshot().editor;
  context.coordinator.drive({ planId, serial: 1 }, false); await flush(); assert.equal(reads, 0); assert.deepEqual(context.handled, [1]); assert.equal(context.controller.getSnapshot().editor, editor); assert.equal(context.controller.getSnapshot().pendingReviewId, planId);
  context.controller.cancelReview(); context.controller.newDraft(true); context.state.online = false;
  context.coordinator.drive({ planId, serial: 2 }, false); await flush(); assert.equal(reads, 0); assert.deepEqual(context.handled, [1, 2]); assert.equal(context.controller.getSnapshot().pendingReviewId, planId); assert.match(context.controller.getSnapshot().error, /离线/);
  context.state.online = true; assert.equal(await context.controller.open(planId), true); assert.equal(reads, 1); context.stop();
});

test('account invalidation prevents even a resolved review from clearing the new account request', async () => {
  const pending = deferred<ReturnType<typeof plan>>(), context = harness(async () => pending.promise);
  context.start(); await flush(); context.coordinator.drive({ planId, serial: 1 }, false); context.state.current = false; pending.resolve(plan()); await flush(); assert.deepEqual(context.handled, []); assert.equal(context.controller.getSnapshot().selectedId, null); context.stop();
});
