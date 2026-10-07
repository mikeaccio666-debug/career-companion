import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createPlatformClient, retryAfterMilliseconds } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { AccountOperationScope, refreshAccountData } from '../src/account-operations.ts';
import { ACCOUNT_POLL_INTERVAL_MS, ACCOUNT_POLL_MAX_BACKOFF_MS, ACCOUNT_POLL_MAX_TIMER_DELAY_MS, AccountPollingController } from '../src/account-polling.ts';

const paths = ['/conversations', '/jobs', '/memories', '/approvals'];
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fakeClock() {
  let time = 0, next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => time, size: () => timers.size,
    setTimer(run: () => void, delay: number) { const id = ++next; timers.set(id, { at: time + delay, run }); return id; },
    clearTimer(id: unknown) { timers.delete(id as number); },
    nextAt: () => Math.min(...[...timers.values()].map((timer) => timer.at)),
    async advance(duration: number) {
      const end = time + duration;
      while (true) {
        const entry = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        time = entry[1].at; timers.delete(entry[0]); entry[1].run(); await flush();
      }
      time = end; await flush();
    },
  };
}
function harness(options: { visible?: boolean; online?: boolean; scope?: AccountOperationScope } = {}) {
  const scope = options.scope ?? new AccountOperationScope(); if (!scope.account) scope.changeSession('fictional-a');
  const token = scope.snapshot(), clock = fakeClock(), state = { visible: options.visible ?? true, online: options.online ?? true, collections: [] as string[], failures: [] as unknown[] };
  const batches: ReturnType<typeof deferred<unknown>>[][] = [], requested: string[] = [], signals: number[] = [];
  const controller = new AccountPollingController(() => {
    const batch = paths.map(() => deferred<unknown>()); batches.push(batch);
    return refreshAccountData(scope, (path) => { requested.push(path); signals.push(clock.now()); return batch[paths.indexOf(path)].promise; }, {
      conversations: (items) => { state.collections = items.map((item) => item.id); }, jobs() {}, memories() {}, approvals() {}, onError(error) { state.failures.push(error); },
    }, { workbench: true });
  }, { ...clock, isVisible: () => state.visible, isOnline: () => state.online, isCurrent: () => scope.isCurrent(token) });
  const settle = (index: number, error?: unknown) => { batches[index].forEach((reply, position) => position === 1 && error ? reply.reject(error) : reply.resolve({ [paths[position].slice(1)]: [{ id: `fictional-batch-${index}` }] })); };
  return { controller, scope, clock, state, batches, requested, signals, settle };
}

test('background reads are single flight and use twelve seconds after a completed batch rather than four', async () => {
  const context = harness(); context.controller.start(); await flush();
  assert.deepEqual(context.requested, paths); await context.clock.advance(60_000); assert.equal(context.batches.length, 1);
  context.settle(0); await flush();
  await context.clock.advance(ACCOUNT_POLL_INTERVAL_MS - 1); assert.equal(context.batches.length, 1);
  await context.clock.advance(1); assert.equal(context.batches.length, 2); context.settle(1); await flush(); context.controller.stop();
});

test('a hidden initial page and an offline initial page send no batch and becoming available supplements the skipped read', async () => {
  for (const unavailable of ['visible', 'online'] as const) {
    const context = harness({ [unavailable]: false }); context.controller.start(); await flush(); await context.clock.advance(120_000);
    assert.equal(context.requested.length, 0); assert.equal(context.clock.size(), 0);
    context.state[unavailable] = true; context.controller.resume(); await flush(); assert.deepEqual(context.requested, paths);
    context.settle(0); await flush(); context.controller.stop();
  }
});

test('hiding cancels future background reads and becoming visible reloads without waiting for the former periodic timer', async () => {
  const context = harness(); context.controller.start(); await flush(); context.settle(0); await flush();
  context.state.visible = false; context.controller.resume(); await context.clock.advance(90_000); assert.equal(context.batches.length, 1);
  context.state.visible = true; context.controller.resume(); await flush(); assert.equal(context.batches.length, 2);
  context.settle(1); await flush(); context.controller.stop();
});

test('active refreshes coalesce into one subsequent batch while preserving mutation freshness and account lanes', async () => {
  const context = harness(); context.controller.start(); await flush();
  context.scope.invalidate('private-refresh'); context.state.collections = ['fictional-new-mutation'];
  const first = context.controller.refreshNow(), second = context.controller.refreshNow();
  await flush(); assert.equal(context.batches.length, 1);
  context.settle(0); await flush(); assert.deepEqual(context.state.collections, ['fictional-new-mutation']); assert.equal(context.batches.length, 2);
  context.settle(1); await Promise.all([first, second]); assert.deepEqual(context.state.collections, ['fictional-batch-1']);
  assert.equal(context.batches.length, 2); context.controller.stop();
});

test('429 without an accessible retry header pauses for at least sixty seconds, including visibility and active refresh attempts', async () => {
  const context = harness(); context.controller.start(); await flush(); context.settle(0, new ApiError('Fictional throttled.', 429)); await flush();
  assert.equal(context.clock.nextAt(), 60_000);
  const active = context.controller.refreshNow(); context.state.visible = false; context.controller.resume(); await context.clock.advance(30_000);
  context.state.visible = true; context.controller.resume(); await context.clock.advance(29_999); assert.equal(context.batches.length, 1);
  await context.clock.advance(1); assert.equal(context.batches.length, 2); context.settle(1); await active;
  await context.clock.advance(ACCOUNT_POLL_INTERVAL_MS); assert.equal(context.batches.length, 3); context.settle(2); await flush(); context.controller.stop();
});

test('legal longer Retry-After instructions are respected and malformed or short metadata cannot cause an immediate loop', async () => {
  for (const retryAfterMs of [150_000, 0, -100, Infinity, NaN, undefined]) {
    const context = harness(); context.controller.start(); await flush(); context.settle(0, new ApiError('Fictional throttled.', 429, undefined, retryAfterMs)); await flush();
    const delay = retryAfterMs === 150_000 ? 150_000 : 60_000;
    await context.clock.advance(delay - 1); assert.equal(context.batches.length, 1);
    await context.clock.advance(1); assert.equal(context.batches.length, 2); context.settle(1); await flush(); context.controller.stop();
  }
});

test('repeated 429 uses bounded exponential fallback and a fully successful batch resets it', async () => {
  const context = harness(); context.controller.start(); await flush();
  for (const [index, delay] of [60_000, 120_000, 240_000, ACCOUNT_POLL_MAX_BACKOFF_MS, ACCOUNT_POLL_MAX_BACKOFF_MS].entries()) {
    context.settle(index, new ApiError('Fictional throttled.', 429)); await flush();
    const now = context.clock.now(); assert.equal(context.clock.nextAt(), now + delay);
    await context.clock.advance(delay); assert.equal(context.batches.length, index + 2);
  }
  context.settle(5); await flush(); await context.clock.advance(ACCOUNT_POLL_INTERVAL_MS);
  context.settle(6, new ApiError('Fictional fresh throttling.', 429)); await flush(); assert.equal(context.clock.nextAt() - context.clock.now(), 60_000);
  context.controller.stop();
});

test('an old account response cannot update private state or install retry delay in a new account, including the same-account next login', async () => {
  for (const nextAccount of ['fictional-b', 'fictional-a']) {
    const old = harness(); old.controller.start(); await flush(); const queued = old.controller.refreshNow();
    old.scope.changeSession(null); old.controller.stop(); old.scope.changeSession(nextAccount);
    const current = harness({ scope: old.scope }); current.controller.start(); await flush(); current.settle(0); await flush();
    old.settle(0, new ApiError('Fictional stale throttling.', 429, undefined, 600_000)); await queued; await flush();
    assert.deepEqual(current.state.collections, ['fictional-batch-0']); assert.equal(old.state.collections.length, 0); assert.equal(old.state.failures.length, 0);
    assert.equal(old.clock.size(), 0); assert.equal(current.clock.nextAt(), ACCOUNT_POLL_INTERVAL_MS);
    await current.clock.advance(ACCOUNT_POLL_INTERVAL_MS); assert.equal(current.batches.length, 2); current.settle(1); await flush(); current.controller.stop();
  }
});

test('synchronous session invalidation suppresses a former timer even before React effect cleanup', async () => {
  const context = harness(); context.controller.start(); await flush(); context.settle(0); await flush();
  context.scope.changeSession('fictional-b'); await context.clock.advance(ACCOUNT_POLL_INTERVAL_MS);
  assert.equal(context.batches.length, 1); assert.equal(context.clock.size(), 0);
});

test('stopping releases queued manual callers and a late 401 cannot restart a stopped loop', async () => {
  const context = harness(); context.controller.start(); await flush(); const pending = context.controller.refreshNow();
  context.scope.dispose(); context.controller.stop(); await pending; context.settle(0, new ApiError('Fictional expired.', 401)); await flush();
  await context.clock.advance(120_000); assert.equal(context.batches.length, 1); assert.equal(context.clock.size(), 0); assert.equal(context.state.failures.length, 0);
});

test('Retry-After seconds and HTTP dates are parsed without coercing malformed headers or very large numbers', async () => {
  const now = Date.parse('2026-10-06T00:00:00.000Z');
  assert.equal(retryAfterMilliseconds(' 90 ', now), 90_000); assert.equal(retryAfterMilliseconds('0', now), 0);
  assert.equal(retryAfterMilliseconds('Tue, 06 Oct 2026 00:02:30 GMT', now), 150_000);
  assert.equal(retryAfterMilliseconds('Mon, 05 Oct 2026 00:00:00 GMT', now), 0);
  assert.equal(retryAfterMilliseconds('Tuesday, 06-Oct-26 00:02:30 GMT', now), 150_000);
  assert.equal(retryAfterMilliseconds('Tue Oct  6 00:02:30 2026', now), 150_000);
  for (const value of [null, '', '-1', '1.5', '1e3', 'Infinity', 'tomorrow', '2026-10-06', '999999999999999999999']) assert.equal(retryAfterMilliseconds(value, now), undefined);
  const context = new AccountRequestContext(); context.changeSession('20000000-0000-4000-8000-000000000002');
  const client = createPlatformClient(createPlatformEndpoints(), async () => Response.json({ error: { code: 'INVALID_REQUEST', message: 'Fictional throttled.' } }, { status: 429, headers: { 'Retry-After': '90' } }), context);
  await assert.rejects(client.request('/jobs'), (error) => error instanceof ApiError && error.status === 429 && error.code === 'INVALID_REQUEST' && error.retryAfterMs === 90_000);
});

test('a longer legal retry deadline uses bounded timer segments without retrying before the server permits it', async () => {
  const context = harness(); context.controller.start(); await flush();
  const delay = ACCOUNT_POLL_MAX_TIMER_DELAY_MS * 2 + 5_000;
  context.settle(0, new ApiError('Fictional throttled.', 429, undefined, delay)); await flush();
  assert.equal(context.clock.nextAt(), ACCOUNT_POLL_MAX_TIMER_DELAY_MS);
  await context.clock.advance(ACCOUNT_POLL_MAX_TIMER_DELAY_MS); assert.equal(context.batches.length, 1);
  assert.equal(context.clock.nextAt(), ACCOUNT_POLL_MAX_TIMER_DELAY_MS * 2);
  await context.clock.advance(ACCOUNT_POLL_MAX_TIMER_DELAY_MS + 4_999); assert.equal(context.batches.length, 1);
  await context.clock.advance(1); assert.equal(context.batches.length, 2);
  context.settle(1); await flush(); context.controller.stop();
});
