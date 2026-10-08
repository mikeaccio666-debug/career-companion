import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResourceSession, parseResourceSession } from '../src/resource-session-api.ts';

const user = { id: '11111111-1111-4111-8111-111111111111', email: 'student@example.invalid', name: '林舟', emailVerified: false };
const response = () => ({ scope: 'support_resources', user: { ...user } });
test('resource bootstrap reads only the real cookie identity endpoint and receives no admission or execution claims', async () => {
  const signal = new AbortController().signal, calls: string[] = [];
  const session = await readResourceSession(signal, async (path, options) => { calls.push(path); assert.equal(options.signal.aborted, false); return response(); });
  assert.deepEqual(calls, ['/auth/resource-session']); assert.deepEqual(session, response());
  assert.ok(Object.isFrozen(session)); assert.ok(Object.isFrozen(session.user));
});
test('resource bootstrap rejects invented authority, inherited fields and accessors without reading them', () => {
  for (const value of [{ ...response(), consented: true }, { ...response(), scope: 'workspace' }, { ...response(), user: { ...user, token: 'fictional' } },
    { ...response(), user: { ...user, id: 'not-an-account' } }, { ...response(), user: { ...user, emailVerified: 'true' } },
    Object.create(response()), { ...response(), user: Object.create(user) }, null, []]) assert.throws(() => parseResourceSession(value));
  let accessed = false;
  const value = { scope: 'support_resources', get user() { accessed = true; return user; } };
  assert.throws(() => parseResourceSession(value)); assert.equal(accessed, false);
  assert.throws(() => parseResourceSession({ ...response(), [Symbol('authority')]: true }));
});
test('cancelled or revoked resource bootstrap does not adopt a later response', async () => {
  const controller = new AbortController(); controller.abort(); let read = false;
  await assert.rejects(readResourceSession(controller.signal, async () => { read = true; return response(); }), { name: 'AbortError' }); assert.equal(read, false);
  const late = new AbortController();
  await assert.rejects(readResourceSession(late.signal, async () => { late.abort(); return response(); }), { name: 'AbortError' });
  const refusal = new Error('Fictional login has ended.');
  await assert.rejects(readResourceSession(new AbortController().signal, async () => { throw refusal; }), error => error === refusal);
});
test('resource bootstrap is bounded even when transport ignores its cancellation', async () => {
  let fire: (() => void) | null = null, delay = 0, cleared = false, finish: (value: unknown) => void = () => {};
  const pending = new Promise<unknown>(resolve => { finish = resolve; }); let readSignal: AbortSignal | undefined;
  const result = readResourceSession(new AbortController().signal, async (_path, options) => { readSignal = options.signal; return pending; },
    { setTimer: (run, ms) => { fire = run; delay = ms; return 1; }, clearTimer: () => { cleared = true; } });
  assert.equal(delay, 12_000); (fire as unknown as () => void)();
  await assert.rejects(result, { name: 'AbortError' }); assert.equal(readSignal?.aborted, true); assert.equal(cleared, true);
  finish(response()); await Promise.resolve();
});
