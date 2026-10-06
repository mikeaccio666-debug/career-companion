import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalPlanProposalList, GoalPlanProposalSummary } from '@companion/platform-contracts';
import { ApiError } from '../src/api.ts';
import { ConversationGoalPlanController } from '../src/conversation-goal-plans-state.ts';
import { conversationId, deferred, flush, instant, messageId } from './goal-plans-fixture.ts';

const item = (n: number): GoalPlanProposalSummary => ({ planId: `73000000-0000-4000-8000-${String(n).padStart(12, '0')}`, conversationId, title: `Fictional plan ${n}`, revision: 1, status: 'draft', stepCount: 1, messageId, createdAt: instant });
function clock() { let now = 0, next = 0; const timers = new Map<number, { at: number; run: () => void }>(); return { now: () => now, count: () => timers.size, setTimer(run: () => void, delay: number) { const id = ++next; timers.set(id, { at: now + delay, run }); return id; }, clearTimer(id: unknown) { timers.delete(id as number); }, async advance(delay: number) { const end = now + delay; while (true) { const entry = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!entry) break; now = entry[1].at; timers.delete(entry[0]); entry[1].run(); await flush(); } now = end; await flush(); } }; }
function harness(read: (before?: string, signal?: AbortSignal) => Promise<GoalPlanProposalList>) { const timer = clock(), state = { current: true, online: true, visible: true }, requests: Array<string | undefined> = []; const controller = new ConversationGoalPlanController({ list: async (_id, options = {}) => { requests.push(options.before); return read(options.before, options.signal); } }, conversationId, { ...timer, isCurrent: () => state.current, isOnline: () => state.online, isVisible: () => state.visible }); return { controller, state, timer, requests }; }

test('one hundred bounded summaries lead to anchored older windows, including refresh and return to recent', async () => {
  const all = Array.from({ length: 125 }, (_, index) => item(index + 1));
  const context = harness(async (before) => { const start = before ? all.findIndex((x) => x.planId === before) + 1 : 0, proposals = all.slice(start, start + 20); return { proposals, nextBefore: start + proposals.length < all.length ? proposals.at(-1)!.planId : null, limit: 20 }; });
  context.controller.start(); await flush();
  for (let page = 2; page <= 5; page++) { context.controller.more(); context.controller.more(); await flush(); assert.equal(context.controller.getSnapshot().proposals.length, page * 20); }
  context.controller.more(); await flush(); assert.equal(context.controller.getSnapshot().proposals[0].planId, all[100].planId); assert.equal(context.controller.getSnapshot().olderWindow, true);
  const offset = context.requests.length; await context.controller.refresh(); assert.equal(context.requests[offset], all[99].planId);
  context.controller.more(); await flush(); assert.equal(context.controller.getSnapshot().proposals.length, 25); context.controller.recent(); await flush(); assert.equal(context.controller.getSnapshot().proposals[0].planId, all[0].planId); context.controller.stop(); assert.equal(context.timer.count(), 0);
});

test('old account/conversation success or failure cannot repaint a new lifetime', async () => {
  for (const fail of [false, true]) { let calls = 0, signal!: AbortSignal; const late = deferred<GoalPlanProposalList>(); const context = harness(async (_before, abort) => { if (++calls === 1) { signal = abort!; return late.promise; } return { proposals: [item(2)], nextBefore: null, limit: 20 }; });
    context.controller.start(); await flush(); context.controller.stop(); assert.equal(signal.aborted, true); context.controller.start(); await flush();
    if (fail) late.reject(new Error('Fictional late private failure')); else late.resolve({ proposals: [item(1)], nextBefore: null, limit: 20 }); await flush(); assert.equal(context.controller.getSnapshot().proposals[0].planId, item(2).planId); assert.equal(context.controller.getSnapshot().error, '');
    context.state.current = false; assert.equal(context.controller.getSnapshot().proposals.length, 0); context.controller.stop();
  }
});

test('offline/hidden reads do not imply empty records or start requests, and an old page survives throttling', async () => {
  let reads = 0; const context = harness(async () => { if (++reads > 1) throw new ApiError('Fictional throttle', 429, 'REQUEST_LIMIT_REACHED', 150000); return { proposals: [item(1)], nextBefore: null, limit: 20 }; });
  context.state.online = false; context.controller.start(); await flush(); assert.equal(reads, 0); assert.equal(context.controller.getSnapshot().loaded, false); assert.equal(context.controller.getSnapshot().loading, false);
  context.state.online = true; context.state.visible = false; context.controller.resume(); await flush(); assert.equal(reads, 0);
  context.state.visible = true; context.controller.resume(); await flush(); assert.equal(reads, 1); await context.controller.refresh(); assert.equal(context.controller.getSnapshot().proposals.length, 1); assert.match(context.controller.getSnapshot().error, /不能当作最新/);
  const read = context.controller.refresh(); await context.timer.advance(149999); assert.equal(reads, 2); await context.timer.advance(1); await read; assert.equal(reads, 3); context.controller.stop();
});

test('a duplicated item across pages rejects the new batch rather than quietly changing source records', async () => {
  const context = harness(async (before) => ({ proposals: [item(1)], nextBefore: before ? null : item(1).planId, limit: 20 }));
  context.controller.start(); await flush(); context.controller.more(); await flush(); assert.equal(context.controller.getSnapshot().proposals.length, 1); assert.match(context.controller.getSnapshot().error, /重复记录/); context.controller.stop();
});
