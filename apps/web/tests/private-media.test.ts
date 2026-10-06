import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRequestContext } from '../src/account-context.ts';
import { clearPrivateImage, clearPrivateMedia, holdPrivateResource } from '../src/private-media.ts';

const accountA = '799c7d39-2d4d-4c43-8004-71872d3a021a';
const accountB = '0c7a9552-29c6-4d6f-968d-4ca66ea00464';

test('account invalidation immediately detaches native media without waiting for React unmount', () => {
  const context = new AccountRequestContext(); context.changeSession(accountA);
  const capture = context.capture()!, events: string[] = [];
  const resource = { isCurrent: () => context.isCurrent(capture), subscribe: context.subscribe };
  const media = { pause() { events.push('pause'); }, removeAttribute(name: string) { events.push(`remove-${name}`); }, load() { events.push('load'); } };
  const stop = holdPrivateResource(resource, () => clearPrivateMedia(media));
  assert.deepEqual(events, []);
  context.changeSession(accountB);
  assert.deepEqual(events, ['pause', 'remove-src', 'load']);
  stop(); context.invalidate();
  assert.deepEqual(events, ['pause', 'remove-src', 'load']);
});

test('a new generation of the same account clears prior decoded image sources and cannot revive a held resource', () => {
  const context = new AccountRequestContext(); context.changeSession(accountA);
  const capture = context.capture()!, events: string[] = [];
  const stop = holdPrivateResource({ isCurrent: () => context.isCurrent(capture), subscribe: context.subscribe }, () => clearPrivateImage({ removeAttribute(name) { events.push(name); } }));
  context.changeSession(accountA);
  assert.deepEqual(events, ['src', 'srcset']);
  assert.equal(context.isCurrent(capture), false);
  stop(); assert.deepEqual(events, ['src', 'srcset']);
});

test('one failing browser cleanup still removes the media source and resets its decoder', () => {
  const events: string[] = [];
  clearPrivateMedia({ pause() { throw new Error('Fictional device detail'); }, removeAttribute(name) { events.push(name); }, load() { events.push('load'); } });
  assert.deepEqual(events, ['src', 'load']);
  clearPrivateImage({ removeAttribute(name) { events.push(name); if (name === 'src') throw new Error('Fictional image failure'); } });
  assert.deepEqual(events, ['src', 'load', 'src', 'srcset']);
});

test('stale or absent captures dispose immediately and synchronous invalidation does not leak a subscription', () => {
  let disposed = 0, subscribed = 0, unsubscribed = 0, current = true;
  const stale = holdPrivateResource({ isCurrent: () => false, subscribe() { subscribed++; return () => {}; } }, () => { disposed++; });
  stale(); assert.equal(disposed, 1); assert.equal(subscribed, 0);
  holdPrivateResource(null, () => { disposed++; }); assert.equal(disposed, 2);
  const stop = holdPrivateResource({ isCurrent: () => current, subscribe(listener) { subscribed++; current = false; listener(); return () => { unsubscribed++; }; } }, () => { disposed++; });
  stop(); assert.equal(disposed, 3); assert.equal(subscribed, 1); assert.equal(unsubscribed, 1);
});

test('a throwing resource disposer cannot prevent other account subscribers from clearing their own media', () => {
  const context = new AccountRequestContext(); context.changeSession(accountA); const capture = context.capture()!;
  const account = { isCurrent: () => context.isCurrent(capture), subscribe: context.subscribe };
  let cleared = false;
  holdPrivateResource(account, () => { throw new Error('Fictional browser failure'); });
  holdPrivateResource(account, () => { cleared = true; });
  context.invalidate(); assert.equal(cleared, true);
});
