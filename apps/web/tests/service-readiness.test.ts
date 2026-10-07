import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceReadinessChecks, serviceReadinessState } from '../src/service-readiness.ts';

const current = { ok: true, checkedAt: '2026-10-06T20:00:00.000Z', database: 'ready', execution: 'ready' };
test('data and execution readiness are separate, and an older configured-only health is not readiness', () => {
  for (const execution of ['ready', 'degraded', 'disabled', 'unknown']) {
    assert.deepEqual(serviceReadinessState({ status: 'fulfilled', value: { ...current, execution } }), { status: 'connected', execution, checkedAt: current.checkedAt });
  }
  for (const value of [null, [], {}, { ok: true, database: 'connected', queue: 'configured' }, { ...current, ok: false }, { ...current, database: 'unavailable' }, { ...current, execution: 'configured' }, { ...current, checkedAt: 'not-a-time' }]) {
    assert.deepEqual(serviceReadinessState({ status: 'fulfilled', value }), { status: 'unavailable', execution: 'unknown' });
  }
  assert.deepEqual(serviceReadinessState({ status: 'rejected', reason: new Error('Synthetic unavailable data service') }), { status: 'unavailable', execution: 'unknown' });
});

test('an older ready response cannot overwrite a newer degraded check or a new bootstrap', async () => {
  const checks = new ServiceReadinessChecks();
  const applied: unknown[] = [];
  let release!: (value: unknown) => void;
  const old = checks.refresh(() => new Promise(resolve => { release = resolve; }), value => applied.push(value));
  assert.equal(await checks.refresh(async () => ({ ...current, execution: 'degraded' }), value => applied.push(value)), 'applied');
  release(current); assert.equal(await old, 'discarded');
  assert.deepEqual(applied, [{ ...current, execution: 'degraded' }]);
  const pending = checks.refresh(() => new Promise(resolve => { release = resolve; }), value => applied.push(value));
  const bootstrap = checks.begin(); release(current); assert.equal(await pending, 'discarded');
  assert.equal(bootstrap.isCurrent(), true); checks.invalidate(); assert.equal(bootstrap.isCurrent(), false);
  assert.equal(applied.length, 1);
});
