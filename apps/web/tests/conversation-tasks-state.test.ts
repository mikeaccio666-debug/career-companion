import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationTask, ConversationTaskPage } from '@companion/platform-contracts';
import { ApiError } from '../src/api.ts';
import { ACCOUNT_POLL_INTERVAL_MS } from '../src/account-polling.ts';
import { createConversationTaskClient } from '../src/conversation-tasks-api.ts';
import { ConversationTaskController } from '../src/conversation-tasks-state.ts';

const id = '10000000-0000-4000-8000-000000000001', messageId = '10000000-0000-4000-8000-000000000002';
const task = (number: number): ConversationTask => ({ origin: { conversationId: id, messageId, tool: 'create_job', createdGeneration: 1, createdAt: '2026-10-06T00:00:00Z' }, generation: 1, job: { id: `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`, kind: 'image', provider: 'fictional', prompt: 'Fictional task.', status: 'queued', progress: 0, artifacts: [], createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z', attempt: 0 } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function clock() {
  let time = 0, next = 0; const timers = new Map<number, { at: number; run: () => void }>();
  return { now: () => time, count: () => timers.size,
    setTimer(run: () => void, delay: number) { const key = ++next; timers.set(key, { at: time + delay, run }); return key; }, clearTimer(key: unknown) { timers.delete(key as number); },
    async advance(delay: number) { const end = time + delay; while (true) { const candidate = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!candidate) break; time = candidate[1].at; timers.delete(candidate[0]); candidate[1].run(); await flush(); } time = end; await flush(); },
  };
}
function harness(work: (before: string | undefined, signal?: AbortSignal) => Promise<ConversationTaskPage>, conversationId = id) {
  const timer = clock(), state = { visible: true, online: true, current: true }, requests: (string | undefined)[] = [];
  const api = { list: async (_conversation: string, options: { before?: string; signal?: AbortSignal } = {}) => { requests.push(options.before); return work(options.before, options.signal); } } as ReturnType<typeof createConversationTaskClient>;
  const controller = new ConversationTaskController(api, conversationId, { ...timer, isVisible: () => state.visible, isOnline: () => state.online, isCurrent: () => state.current });
  return { controller, timer, state, requests };
}

test('a window rereads its bounded prefix and exposes every older task after the first one hundred', async () => {
  const all = Array.from({ length: 125 }, (_, index) => task(index + 1));
  const context = harness(async (before) => { const start = before ? all.findIndex((task) => task.job.id === before) + 1 : 0, tasks = all.slice(start, start + 20); return { tasks, nextBefore: start + tasks.length < all.length ? tasks.at(-1)!.job.id : null }; });
  context.controller.start(); await flush(); assert.equal(context.controller.getSnapshot().tasks.length, 20);
  for (let page = 2; page <= 5; page++) { context.controller.more(); context.controller.more(); await flush(); assert.equal(context.controller.getSnapshot().tasks.length, page * 20); }
  assert.equal(context.controller.getSnapshot().nextBefore, all[99].job.id); assert.ok(context.requests.every((value) => value === undefined || all.some((task) => task.job.id === value)));
  context.controller.more(); await flush(); assert.equal(context.controller.getSnapshot().olderWindow, true); assert.equal(context.controller.getSnapshot().tasks[0].job.id, all[100].job.id);
  const anchorRequests = context.requests.length; await context.controller.refresh(); assert.equal(context.requests[anchorRequests], all[99].job.id);
  context.controller.more(); await flush(); assert.equal(context.controller.getSnapshot().tasks.length, 25); assert.equal(context.controller.getSnapshot().nextBefore, null);
  context.controller.recent(); await flush(); assert.equal(context.controller.getSnapshot().olderWindow, false); assert.equal(context.controller.getSnapshot().tasks[0].job.id, all[0].job.id); context.controller.stop(); assert.equal(context.timer.count(), 0);
});

test('a stopped/changed conversation ignores late successes, failures and loading cleanup without blocking a StrictMode remount', async () => {
  for (const fail of [false, true]) {
    const first = deferred<ConversationTaskPage>(); let signal!: AbortSignal, calls = 0;
    const context = harness(async (_before, abort) => { calls++; if (calls === 1) { signal = abort!; return first.promise; } return { tasks: [task(2)], nextBefore: null }; });
    context.controller.start(); await flush(); context.controller.stop(); assert.equal(signal.aborted, true);
    context.controller.start(); await flush(); assert.equal(context.controller.getSnapshot().tasks[0].job.id, task(2).job.id);
    if (fail) first.reject(new Error('Fictional old failure.')); else first.resolve({ tasks: [task(1)], nextBefore: null }); await flush();
    assert.equal(context.controller.getSnapshot().tasks[0].job.id, task(2).job.id); assert.equal(context.controller.getSnapshot().error, ''); context.controller.stop();
  }
});

test('invalidated account hides private state synchronously before React can unmount and prevents late application', async () => {
  const late = deferred<ConversationTaskPage>(), context = harness(() => late.promise);
  context.controller.start(); await flush(); context.state.current = false; late.resolve({ tasks: [task(1)], nextBefore: null }); await flush();
  assert.deepEqual(context.controller.getSnapshot().tasks, []); assert.equal(context.controller.getSnapshot().loading, false); context.controller.stop(); assert.equal(context.timer.count(), 0);
});

test('hidden/offline polling sends no reads, resumes explicitly and never overlaps requests', async () => {
  const replies: ReturnType<typeof deferred<ConversationTaskPage>>[] = [], context = harness(() => { const reply = deferred<ConversationTaskPage>(); replies.push(reply); return reply.promise; });
  context.state.visible = false; context.controller.start(); await flush(); assert.equal(replies.length, 0); assert.equal(context.controller.getSnapshot().loading, false);
  context.state.visible = true; context.state.online = false; context.controller.resume(); await flush(); assert.equal(replies.length, 0);
  context.state.online = true; context.controller.resume(); await flush(); assert.equal(replies.length, 1); await context.timer.advance(120000); assert.equal(replies.length, 1);
  replies[0].resolve({ tasks: [task(1)], nextBefore: null }); await flush(); await context.timer.advance(ACCOUNT_POLL_INTERVAL_MS); assert.equal(replies.length, 2);
  context.state.visible = false; context.controller.resume(); replies[1].resolve({ tasks: [task(2)], nextBefore: null }); await flush(); await context.timer.advance(120000); assert.equal(replies.length, 2); context.controller.stop();
});

test('429 preserves known records with an honest stale warning and respects backoff even for manual refresh', async () => {
  let calls = 0; const context = harness(async () => { calls++; if (calls === 1) return { tasks: [task(1)], nextBefore: null }; throw new ApiError('Fictional throttled.', 429, 'REQUEST_LIMIT_REACHED', 150000); });
  context.controller.start(); await flush(); await context.controller.refresh(); assert.equal(calls, 2); assert.equal(context.controller.getSnapshot().tasks[0].job.id, task(1).job.id); assert.match(context.controller.getSnapshot().error, /不能当作最新/);
  const next = context.controller.refresh(); await context.timer.advance(149999); assert.equal(calls, 2); await context.timer.advance(1); await next; assert.equal(calls, 3); context.controller.stop();
});

test('cross-page overlap is deduplicated and a repeated older cursor preserves the last complete window', async () => {
  let broken = false;
  const context = harness(async (before) => !before ? { tasks: [task(1), task(2)], nextBefore: task(2).job.id } : broken ? { tasks: [task(2)], nextBefore: task(2).job.id } : { tasks: [task(1), task(3)], nextBefore: null });
  context.controller.start(); await flush(); context.controller.more(); await flush(); assert.deepEqual(context.controller.getSnapshot().tasks.map((item) => item.job.id), [task(1).job.id, task(2).job.id, task(3).job.id]);
  broken = true; await context.controller.refresh(); assert.equal(context.controller.getSnapshot().tasks.length, 3); assert.match(context.controller.getSnapshot().error, /分页.*未推进/); context.controller.stop();
});

test('refresh requested during an in-flight tool preparation read performs one subsequent fresh batch', async () => {
  const first = deferred<ConversationTaskPage>(); let calls = 0; const context = harness(async () => ++calls === 1 ? first.promise : { tasks: [task(2)], nextBefore: null });
  context.controller.start(); await flush(); const a = context.controller.refresh(), b = context.controller.refresh(); await flush(); assert.equal(calls, 1);
  first.resolve({ tasks: [task(1)], nextBefore: null }); await Promise.all([a, b]); assert.equal(calls, 2); assert.equal(context.controller.getSnapshot().tasks[0].job.id, task(2).job.id); context.controller.stop();
});
