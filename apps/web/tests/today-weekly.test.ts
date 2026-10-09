import test from 'node:test';
import assert from 'node:assert/strict';
import { readTodayWeekly, type TodayWeeklyClient } from '../src/today-weekly-api.ts';
import { JourneySectionController } from '../src/journey-section-controller.ts';
const owner = '11111111-1111-4111-8111-111111111111';
const value = () => ({ownerId:owner,companionId:owner,capturedAt:'2026-11-01T16:00:00.000Z',localDate:'2026-11-01',weekStart:'2026-10-26',timeZone:'America/New_York',storiesEdited:2,resumesConfirmed:1,practiceQuestions:null,coverage:['retained_story_edits','retained_resume_approvals']});
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred() { let resolve!: (v: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r; }); return { resolve, promise }; }
function fixture() {
  let current = true, run: () => Promise<unknown> = async () => value(); const listeners = new Set<() => void>(), calls: { path: string; init: RequestInit }[] = [];
  const client: TodayWeeklyClient = { account: { accountId: owner, generation: 1 }, isCurrent: () => current,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, async request(path, init = {}) { calls.push({ path, init }); return await run() as any; } };
  return { client, calls, set(fn: () => Promise<unknown>) { run = fn; }, expire() { current = false; for (const fn of [...listeners]) fn(); } };
}
test('one private GET validates ownership, cancellation and current account without writes', async () => {
  const f = fixture(); assert.equal((await readTodayWeekly(f.client)).storiesEdited, 2);
  assert.equal(f.calls[0].path, '/today/weekly'); assert.equal(f.calls[0].init.method, undefined); assert.equal(f.calls[0].init.body, undefined);
  f.set(async () => ({ ...value(), ownerId: '22222222-2222-4222-8222-222222222222' })); await assert.rejects(readTodayWeekly(f.client));
  const controller = new AbortController(); f.set(async () => { controller.abort(); return value(); }); await assert.rejects(readTodayWeekly(f.client, controller.signal));
  const count = f.calls.length; await assert.rejects(readTodayWeekly(f.client, AbortSignal.abort())); f.expire(); await assert.rejects(readTodayWeekly(f.client)); assert.equal(f.calls.length, count);
});
test('stopping a read and changing accounts erase private counts and discard stale responses',async()=>{
 const f=fixture(),c=new JourneySectionController(f.client,signal=>readTodayWeekly(f.client,signal),()=>{});
 c.start();await tick();assert.equal(c.snapshot().value?.storiesEdited,2);
 const old=deferred();f.set(()=>old.promise);const reading=c.refresh();c.stop();assert.equal(c.snapshot().value,null);
 f.set(async()=>({...value(),storiesEdited:0}));c.start();await tick();old.resolve(value());await reading;assert.equal(c.snapshot().value?.storiesEdited,0);
 f.expire();assert.equal(c.snapshot().value,null);c.stop();
});
test('an unreadable week stays unavailable, never a manufactured zero',async()=>{
 const f=fixture(),c=new JourneySectionController(f.client,signal=>readTodayWeekly(f.client,signal),()=>{});
 c.start();await tick();f.set(async()=>{throw Error('Fictional failure');});await c.refresh();assert.equal(c.snapshot().value,null);assert(c.snapshot().failed);c.stop();
 f.set(async()=>({...value(),practiceQuestions:0}));await assert.rejects(readTodayWeekly(f.client));
});
