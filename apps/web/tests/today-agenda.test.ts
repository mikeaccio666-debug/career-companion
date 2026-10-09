import test from 'node:test';
import assert from 'node:assert/strict';
import { readTodayAgenda, type TodayAgendaClient } from '../src/today-agenda-api.ts';
import { JourneySectionController } from '../src/journey-section-controller.ts';
import { displayInterviewTime } from '../src/career-interview-time.ts';
const owner = '11111111-1111-4111-8111-111111111111';
const value = () => ({ ownerId: owner, companionId: owner, capturedAt: '2026-11-01T16:00:00.000Z', localDate: '2026-11-01', timeZone: 'America/New_York', resting: false, events: [], pending: { scope: 'resume_reviews', count: 2, earliestExpiresAt: '2026-11-02T16:00:00.000Z' } });
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred() { let resolve!: (v: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r; }); return { resolve, promise }; }
function fixture() {
  let current = true, run: () => Promise<unknown> = async () => value(); const listeners = new Set<() => void>(), calls: { path: string; init: RequestInit }[] = [];
  const client: TodayAgendaClient = { account: { accountId: owner, generation: 1 }, isCurrent: () => current,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, async request(path, init = {}) { calls.push({ path, init }); return await run() as any; } };
  return { client, calls, set(fn: () => Promise<unknown>) { run = fn; }, expire() { current = false; for (const fn of [...listeners]) fn(); } };
}
test('one private GET validates ownership, cancellation and current account without writes', async () => {
  const f = fixture(); assert.equal((await readTodayAgenda(f.client)).pending?.count, 2);
  assert.equal(f.calls[0].path, '/today/agenda'); assert.equal(f.calls[0].init.method, undefined); assert.equal(f.calls[0].init.body, undefined);
  f.set(async () => ({ ...value(), ownerId: '22222222-2222-4222-8222-222222222222' })); await assert.rejects(readTodayAgenda(f.client));
  const controller = new AbortController(); f.set(async () => { controller.abort(); return value(); }); await assert.rejects(readTodayAgenda(f.client, controller.signal));
  const count = f.calls.length; await assert.rejects(readTodayAgenda(f.client, AbortSignal.abort())); f.expire(); await assert.rejects(readTodayAgenda(f.client)); assert.equal(f.calls.length, count);
});
test('rest refresh, hidden/offline stop and account changes discard late responses instead of redisplaying old prompts', async () => {
  const f = fixture(), c = new JourneySectionController(f.client, signal => readTodayAgenda(f.client, signal), () => {});
  c.start(); await tick(); assert.equal(c.snapshot().value?.pending?.count, 2);
  const old = deferred(); f.set(() => old.promise); const pending = c.refresh(); c.stop(); assert.equal(c.snapshot().value, null); assert(f.calls.at(-1)!.init.signal?.aborted);
  f.set(async () => ({ ...value(), resting: true, pending: null })); c.start(); await tick(); old.resolve(value()); await pending;
  assert.equal(c.snapshot().value?.resting, true); assert.equal(c.snapshot().value?.pending, null);
  f.expire(); assert.equal(c.snapshot().value, null); c.stop();
});
test('failed reads stay unavailable and repeated DST wall times keep distinct offsets in each timezone', async () => {
  const f = fixture(), c = new JourneySectionController(f.client, signal => readTodayAgenda(f.client, signal), () => {});
  c.start(); await tick(); f.set(async () => { throw Error('Fictional offline'); }); await c.refresh(); assert.equal(c.snapshot().value, null); assert(c.snapshot().failed); c.stop();
  const first = displayInterviewTime('2026-11-01T05:30:00.000Z', 'America/New_York'), second = displayInterviewTime('2026-11-01T06:30:00.000Z', 'America/New_York');
  assert(first.includes('01:30') && first.includes('UTC-04:00')); assert(second.includes('01:30') && second.includes('UTC-05:00'));
  assert(displayInterviewTime('2026-11-01T05:30:00.000Z', 'America/Los_Angeles').includes('2026-10-31 22:30'));
});
