import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { CostGuard, tokenCostMicros } from '../src/cost-guard.ts';
import { ApiError } from '../src/errors.ts';
import type { Database } from '../src/database.ts';

const denied = (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === 'COST_RECORD_UNCONFIRMED';
test('decimal micros use exact BigInt arithmetic and round the entire call upward once', () => {
  assert.equal(tokenCostMicros(1, 1, '0.4', '0.4'), '1');
  assert.equal(tokenCostMicros(1, 0, '0.000001', '10'), '1');
  assert.equal(tokenCostMicros(4, 2, '2.5', '10'), '30');
  assert.equal(tokenCostMicros(1, 1, '9007199254740.123456', '0.876544'), '9007199254741');
  assert.equal(tokenCostMicros(0, 0, '2.5', '10'), '0');
  assert.equal(tokenCostMicros(2_147_483_647, 2_147_483_647, '0.25', '1'), '2684354559');
});
test('invalid, ambiguous, unsupported precision and overflowing money never become a zero estimate', () => {
  for (const value of [-1, -0, 0.5, Infinity, NaN, 2_147_483_648, '2']) {
    assert.throws(() => tokenCostMicros(value as number, 1, '1', '1'), denied);
  }
  for (const value of ['0', '-1', ' 1', '1 ', '1e-6', '+1', '01', '1.', '.5', '0.0000001', '100000000000000', '', undefined, 1]) {
    assert.throws(() => tokenCostMicros(1, 1, value as string, '1'), denied);
  }
  assert.throws(() => tokenCostMicros(2_147_483_647, 2_147_483_647, '99999999999999.999999', '99999999999999.999999'), denied);
});
test('reserve rejects accessors, inherited fields, extra authority fields and nonprimitive route values before SQL', async () => {
  let touched = 0;
  const client = { query() { touched++; throw new Error('SQL must not run.'); } } as unknown as PoolClient;
  const guard = new CostGuard({} as Database), valid = { userId: randomUUID(), sourceKind: 'job', sourceId: randomUUID(),
    capability: 'background', purpose: 'companion_generation', provider: 'fictional-provider', model: 'fictional-model', maxInputTokens: 1, maxOutputTokens: 1 };
  const accessor = Object.defineProperty({ ...valid }, 'model', { enumerable: true, get() { touched++; return 'fictional-model'; } });
  const inherited = Object.assign(Object.create(valid), { model: 'fictional-model' });
  const trap = { toString() { touched++; return 'background'; } };
  for (const value of [accessor, inherited, { ...valid, necessary: true }, { ...valid, capability: trap },
    { ...valid, sourceKind: 'chat_call' }, { ...valid, ttlSeconds: 0 }, { ...valid, ttlSeconds: 3601 },
    { ...valid, maxInputTokens: 0, maxOutputTokens: 0 }, { ...valid, reservationId: 'not-a-uuid' }]) {
    await assert.rejects(guard.reserveInTransaction(client, value as never), denied);
  }
  assert.equal(touched, 0);
});
test('admit, commit and release all require the closed actual reservation binding before SQL', async () => {
  let queried = 0;
  const client = { query() { queried++; throw new Error('SQL must not run.'); } } as unknown as PoolClient;
  const guard = new CostGuard({} as Database);
  const binding = { id: randomUUID(), userId: randomUUID(), sourceKind: 'job', sourceId: randomUUID(), capability: 'background',
    purpose: 'companion_generation', provider: 'fictional-provider', model: 'fictional-model' };
  await assert.rejects(guard.admitInTransaction(client, { ...binding, override: true } as never), denied);
  await assert.rejects(guard.releaseInTransaction(client, { ...binding, model: '' } as never), denied);
  for (const usage of [{ status: 'reported', inputTokens: -1, outputTokens: 0 }, { status: 'missing', inputTokens: 0 },
    { status: 'reported', inputTokens: 1 }, { status: 'reported', inputTokens: 1, outputTokens: 0, apiKey: 'fictional-unused' }]) {
    await assert.rejects(guard.commitInTransaction(client, binding as never, usage as never), denied);
  }
  assert.equal(queried, 0);
});
