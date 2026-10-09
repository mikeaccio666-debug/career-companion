import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelCallUsage } from '../src/model-call-usage.ts';
const usage = { status: 'reported', inputTokens: 100, outputTokens: 5 };
test('cache evidence preserves unknown, partial, zero and whole-call subsets without mutating inputs', () => {
  assert.deepEqual(parseModelCallUsage(usage), usage);
  const raw = { ...usage, cachedInputTokens: 40, cacheWriteInputTokens: 60 };
  const value = parseModelCallUsage(raw); raw.cachedInputTokens = 20;
  assert.equal(value.status === 'reported' && value.cachedInputTokens, 40); assert(Object.isFrozen(value));
  assert.deepEqual(parseModelCallUsage({ ...usage, cachedInputTokens: 0 }), { ...usage, cachedInputTokens: 0 });
  assert.deepEqual(parseModelCallUsage({ status: 'missing' }), { status: 'missing' });
});
test('invalid or executable usage never reaches accounting', () => {
  for (const patch of [{ cachedInputTokens: -1 }, { cachedInputTokens: -0 }, { cachedInputTokens: 101 },
    { cachedInputTokens: 40, cacheWriteInputTokens: 61 }, { cacheWriteInputTokens: 1.5 },
    { cachedInputTokens: null }, { cachedInputTokens: undefined }, { inputTokens: 2147483648 },
    { privatePrompt: 'synthetic' }, { cacheWriteInputTokens: NaN }]) assert.throws(() => parseModelCallUsage({ ...usage, ...patch }));
  for (const status of ['missing', 'invalid']) assert.throws(() => parseModelCallUsage({ status, cachedInputTokens: 0 }));
  let read = false; const getter = { ...usage }; Object.defineProperty(getter, 'cachedInputTokens', { enumerable: true, get() { read = true; return 0; } });
  assert.throws(() => parseModelCallUsage(getter)); assert.equal(read, false);
  assert.throws(() => parseModelCallUsage({ ...usage, [Symbol('secret')]: 1 }));
});
