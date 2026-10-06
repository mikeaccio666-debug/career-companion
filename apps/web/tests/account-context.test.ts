import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRequestContext } from '../src/account-context.ts';

const A = '10000000-0000-4000-8000-000000000001', B = '20000000-0000-4000-8000-000000000002';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test('account snapshots and captures are stable immutable intent, and same-account re-login invalidates the prior generation', () => {
  const context = new AccountRequestContext(); assert.equal(context.capture(), undefined);
  const initial = context.getSnapshot(); assert.equal(initial, context.getSnapshot()); assert.ok(Object.isFrozen(initial));
  context.changeSession(A); const capture = context.capture()!; assert.ok(Object.isFrozen(capture)); assert.equal(context.isCurrent(capture), true);
  const lease = context.lease(capture); context.changeSession(A);
  assert.equal(lease.signal.aborted, true); assert.equal(context.isCurrent(capture), false); assert.equal(context.getSnapshot().accountId, A);
  assert.throws(() => lease.assertCurrent(), { name: 'AbortError' }); lease.dispose();
});

test('invalidation clears account and aborts every lease synchronously before notifying subscribers', () => {
  const context = new AccountRequestContext(); context.changeSession(A);
  const one = context.lease(context.capture()!), two = context.lease(context.capture()!);
  const observations: string[] = [];
  const off = context.subscribe(() => { assert.equal(context.getSnapshot().accountId, null); assert.ok(one.signal.aborted && two.signal.aborted); observations.push('snapshot'); });
  const offReason = context.subscribeInvalidation((reason) => { assert.ok(one.signal.aborted && two.signal.aborted); observations.push(reason); });
  context.invalidate('external-auth-change'); assert.deepEqual(observations, ['snapshot', 'external-auth-change']);
  off(); offReason(); context.changeSession(B); assert.equal(observations.length, 2);
});

test('ignored transport cancellation cannot keep a leased operation alive or return old private results', async () => {
  const context = new AccountRequestContext(); context.changeSession(A); const lease = context.lease(context.capture()!);
  const work = deferred<string>(), pending = lease.wait(work.promise);
  context.changeSession(B); await assert.rejects(pending, { name: 'AbortError' });
  work.resolve('Fictional A-only body.'); await Promise.resolve(); assert.equal(context.getSnapshot().accountId, B); lease.dispose();
});

test('external abort propagates, pre-aborted work is rejected, disposal detaches only its own lease', async () => {
  const context = new AccountRequestContext(); context.changeSession(A); const capture = context.capture()!;
  const pre = new AbortController(); pre.abort(); assert.throws(() => context.lease(capture, pre.signal), { name: 'AbortError' });
  const external = new AbortController(), lease = context.lease(capture, external.signal), active = context.lease(capture);
  external.abort(new DOMException('Fictional cancellation.', 'AbortError')); assert.equal(lease.signal.aborted, true); assert.equal(active.signal.aborted, false);
  active.dispose(); context.changeSession(B); assert.equal(active.signal.aborted, false); assert.throws(() => active.assertCurrent(), { name: 'AbortError' }); lease.dispose();
});

test('invalid account input cannot replace a valid account and stale captures cannot start a lease', () => {
  const context = new AccountRequestContext(); context.changeSession(A); const capture = context.capture()!, before = context.getSnapshot();
  for (const value of ['fictional', '', '10000000-0000-4000-8000-000000000001\n']) assert.throws(() => context.changeSession(value), /账号上下文无效/);
  assert.equal(context.getSnapshot(), before); context.changeSession(B); assert.throws(() => context.lease(capture), { name: 'AbortError' });
});
