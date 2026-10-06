import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRequestContext } from '../src/account-context.ts';
import { createAuthCoordination, startBrowserAuthCoordination, type AuthCoordinationPorts } from '../src/auth-coordination.ts';
const A = '10000000-0000-4000-8000-000000000001';
function fixture() {
  let channel!: (value: unknown) => void, storage!: (value: string | null) => void, offChannel = 0, offStorage = 0, closed = 0;
  const sent: unknown[] = [], stored: string[] = [];
  const ports: AuthCoordinationPorts = { subscribeChannel(receive) { channel = receive; return () => { offChannel++; }; }, postChannel(value) { sent.push(value); }, subscribeStorage(receive) { storage = receive; return () => { offStorage++; }; }, notifyStorage(value) { stored.push(value); }, close() { closed++; } };
  return { ports, sent, stored, receiveChannel: (value: unknown) => channel(value), receiveStorage: (value: string | null) => storage(value), counts: () => [offChannel, offStorage, closed] };
}
test('local auth-change sends notification only and preserves this window fresh authenticated context', () => {
  const context = new AccountRequestContext(); context.changeSession(A); const before = context.getSnapshot(), f = fixture();
  const coordination = createAuthCoordination(context, f.ports); coordination.notifyLocalAuthChanged();
  assert.deepEqual(f.sent, [{ type: 'authChanged' }]); assert.deepEqual(f.stored, []); assert.equal(context.getSnapshot(), before); coordination.dispose();
});
test('remote exact notification synchronously aborts and clears account before the owner rechecks auth', () => {
  const context = new AccountRequestContext(); context.changeSession(A); const lease = context.lease(context.capture()!), f = fixture();
  let notifications = 0; context.subscribeInvalidation((reason) => { assert.equal(reason, 'external-auth-change'); assert.equal(context.getSnapshot().accountId, null); assert.equal(lease.signal.aborted, true); notifications++; });
  const coordination = createAuthCoordination(context, f.ports); f.receiveChannel({ type: 'authChanged' });
  assert.equal(notifications, 1); assert.deepEqual(f.sent, []); coordination.dispose();
});
test('storage fallback repeats invalidation without carrying identity, tokens or accepting malformed payloads', () => {
  const context = new AccountRequestContext(); context.changeSession(A); const f = fixture();
  const coordination = createAuthCoordination(context, { ...f.ports, postChannel() { throw new Error('Fictional unavailable channel.'); } });
  coordination.notifyLocalAuthChanged(); coordination.notifyLocalAuthChanged(); assert.deepEqual(f.stored, ['{"type":"authChanged"}', '{"type":"authChanged"}']);
  const before = context.getSnapshot();
  for (const value of [null, 'bad-json', '[]', '{"type":"authChanged","accountId":"fictional-B"}', '{"type":"authChanged","token":"fictional-secret"}', '{"type":"other"}']) f.receiveStorage(value);
  assert.equal(context.getSnapshot(), before); f.receiveStorage('{"type":"authChanged"}'); assert.equal(context.getSnapshot().accountId, null); coordination.dispose();
});
test('dispose removes every owned port once and late callbacks cannot invalidate a later session', () => {
  const context = new AccountRequestContext(); context.changeSession(A); const f = fixture(), coordination = createAuthCoordination(context, f.ports);
  coordination.dispose(); coordination.dispose(); const before = context.getSnapshot();
  f.receiveChannel({ type: 'authChanged' }); f.receiveStorage('{"type":"authChanged"}'); coordination.notifyLocalAuthChanged();
  assert.equal(context.getSnapshot(), before); assert.deepEqual(f.counts(), [1, 1, 1]); assert.deepEqual(f.sent, []);
});
test('explicit browser setup is safe with no browser globals and never connects on module import', () => {
  assert.equal(typeof window, 'undefined'); const context = new AccountRequestContext(); context.changeSession(A);
  const before = context.getSnapshot(), coordination = startBrowserAuthCoordination(context); coordination.notifyLocalAuthChanged(); coordination.dispose(); assert.equal(context.getSnapshot(), before);
});
