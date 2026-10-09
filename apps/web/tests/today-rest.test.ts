import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TodayRestController } from '../src/today-rest-controller.ts';
import { readTodayRest, changeTodayRest, type TodayRestClient } from '../src/today-rest-api.ts';
import { ApiError } from '../src/api-error.ts';
const choice = 'today' as const, other = '1_day' as const;
const owner=randomUUID(),companionId=randomUUID(),at='2026-10-08T00:00:00.000Z';
const initial={ownerId:owner,companionId,revision:0,updatedAt:null,lastOperationId:null,timeZone:null,optedOutDate:null,optedOutUntil:null,pauseUntil:null,reminders:'keep' as const};
const cmd=()=>({companionId,operationId:randomUUID(),expectedRevision:0,choice});
function saved(c:any,replayed=false){return{settings:{...initial,timeZone:'America/New_York',optedOutDate:'2026-10-07',optedOutUntil:'2026-10-08T04:00:00.000Z',revision:c.expectedRevision+1,updatedAt:at,lastOperationId:c.operationId},operation:{id:c.operationId,appliedRevision:c.expectedRevision+1,choice:c.choice,replayed}};}
function harness(run: (path: string, init: RequestInit) => unknown) { let active = true; const listeners = new Set<() => void>(); const client: TodayRestClient = { account: { accountId: owner, generation: 1 }, isCurrent: () => active, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, request: async (p, i = {}) => await run(p, i) as any }; return { client, controller: new TodayRestController(client, () => { }, 40), invalidate() { active = false; for (const f of [...listeners])
        f(); } }; }
async function until(check: () => boolean) { for (let i = 0; i < 150; i++) {
    if (check())
        return;
    await new Promise(r => setTimeout(r, 2));
} assert(check()); }
async function ready(h: ReturnType<typeof harness>) { h.controller.start(); await until(() => h.controller.snapshot().loaded && !h.controller.snapshot().busy); }
test('lost acknowledgement retains one frozen command; reads and missing observations cannot discard it, and retry has one effect', async () => {
    let receipt: any, effects = 0;
    const writes: any[] = [];
    const h = harness((path, init) => { if (path.includes('/operations/'))
        throw new ApiError('Not found', 404, 'NOT_FOUND'); if (!init.method)
        return { settings: receipt?.settings ?? initial }; const body = JSON.parse(String(init.body)); writes.push(body); if (receipt)
        return { ...receipt, operation: { ...receipt.operation, replayed: true } }; effects++; receipt = saved(body); throw Error('Fictional lost acknowledgement'); });
    await ready(h);
    h.controller.begin(choice);
    await until(() => h.controller.snapshot().uncertain);
    assert(Object.isFrozen(h.controller.snapshot().pending));
    await h.controller.observe();
    assert(h.controller.snapshot().pending);
    await h.controller.refresh();
    assert(h.controller.snapshot().pending);
    h.controller.begin(other);
    assert.equal(writes.length, 1);
    await h.controller.retry();
    assert.equal(effects, 1);
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(h.controller.snapshot().pending, null);
    assert.deepEqual(h.controller.snapshot().settings?.optedOutDate, '2026-10-07');
    h.controller.stop();
});
test('original observation may return a newer owner choice without claiming the earlier choice is still current', async () => {
    let command: any;
    const h = harness((path, init) => { if (path.includes('/operations/')) {
        const r = saved(command, true);
        return { ...r, settings: { ...r.settings, reminders: 'off', revision: 2, lastOperationId: randomUUID() } };
    } if (init.method) {
        command = JSON.parse(String(init.body));
        throw Error('Lost');
    } return { settings: initial }; });
    await ready(h);
    h.controller.begin(choice);
    await until(() => h.controller.snapshot().uncertain);
    await h.controller.observe();
    assert.equal(h.controller.snapshot().pending, null);
    assert.deepEqual(h.controller.snapshot().settings?.reminders, 'off');
    assert.match(h.controller.snapshot().notice, /之后保存/);
    h.controller.stop();
});
test('timeouts are bounded; offline/resume only read, preserve the original command, and reject a late response after account expiry', async () => {
    let resolve!: (v: unknown) => void, command: any, writes = 0;
    const h = harness((_path, init) => { if (init.method) {
        writes++;
        command = JSON.parse(String(init.body));
        return new Promise(r => resolve = r);
    } return { settings: initial }; });
    await ready(h);
    h.controller.begin(choice);
    await until(() => h.controller.snapshot().uncertain);
    const original = h.controller.snapshot().pending;
    h.controller.suspend();
    assert.equal(h.controller.snapshot().settings, null);
    assert.equal(h.controller.snapshot().pending, original);
    h.controller.resume();
    await until(() => h.controller.snapshot().loaded);
    assert.equal(writes, 1);
    assert.equal(h.controller.snapshot().pending, original);
    h.invalidate();
    resolve(saved(command));
    await new Promise(r => setTimeout(r, 4));
    assert.equal(h.controller.snapshot().pending, null);
    assert.equal(h.controller.snapshot().settings, null);
    assert.equal(h.controller.snapshot().loaded, false);
});
test('definitive version conflict requires a fresh read and new owner decision, while a failed read conceals stale choices', async () => {
    let fail = false, writes = 0;
    const h = harness((_p, init) => { if (init.method) {
        writes++;
        throw new ApiError('Changed', 409, 'TODAY_REST_REVISION_CHANGED');
    } if (fail)
        throw Error('Missing'); return { settings: initial }; });
    await ready(h);
    h.controller.begin(choice);
    await until(() => !h.controller.snapshot().busy);
    assert.equal(h.controller.snapshot().pending, null);
    assert.equal(h.controller.snapshot().settings, null);
    h.controller.begin(other);
    assert.equal(writes, 1);
    await h.controller.refresh();
    fail = true;
    await h.controller.refresh();
    assert.equal(h.controller.snapshot().settings, null);
    assert.equal(h.controller.snapshot().loaded, false);
    h.controller.stop();
});
test('transport rejects cross-owner, substituted modes, wrong companion, operation and revision; stale clients never send', async () => {
    const c = cmd(), receipt = saved(c);
    for (const value of [
        { ...receipt, settings: { ...receipt.settings, ownerId: randomUUID() } }, { ...receipt, settings: { ...receipt.settings, companionId: randomUUID() } },
        { ...receipt, settings: { ...receipt.settings, lastOperationId: randomUUID() } }, { ...receipt, operation: { ...receipt.operation, id: randomUUID() } },
        { ...receipt, operation: { ...receipt.operation, choice: other } }, { ...receipt, settings: { ...receipt.settings, revision: 2 } }
    ])
        await assert.rejects(changeTodayRest(harness(() => value).client, c));
    await assert.rejects(changeTodayRest(harness(() => receipt).client, c, true));
    let calls = 0;
    const h = harness(() => { calls++; return { settings: initial }; });
    h.invalidate();
    await assert.rejects(readTodayRest(h.client));
    await assert.rejects(changeTodayRest(h.client, c));
    assert.equal(calls, 0);
});
test('strict-mode stop/start does not replay a write or revive private state from an old read', async () => {
    let resolve!: (v: unknown) => void, reads = 0;
    const h = harness((_p, init) => { assert(!init.method); if (++reads === 1)
        return new Promise(r => resolve = r); return { settings: initial }; });
    h.controller.start();
    h.controller.stop();
    h.controller.start();
    await until(() => h.controller.snapshot().loaded);
    resolve({ settings: { ...initial, ownerId: randomUUID() } });
    await new Promise(r => setTimeout(r, 4));
    assert.equal(h.controller.snapshot().settings?.ownerId, owner);
    h.controller.stop();
});

test('invalid rest choice produces no write',async()=>{let writes=0;const h=harness((_p,i)=>{if(i.method)writes++;return{settings:initial};});await ready(h);h.controller.begin('30_days' as any);assert.equal(writes,0);assert.equal(h.controller.snapshot().pending,null);assert.match(h.controller.snapshot().error,/休息/);h.controller.stop();});

test('an acknowledgement at its applied revision must carry the effect of the requested rest action',async()=>{
 for(const choice of ['1_day','3_days','7_days','reminders_off'] as const){const c={...cmd(),choice};await assert.rejects(changeTodayRest(harness(()=>saved(c)).client,c));}
});

test('hidden-page rest recovery observes a newer choice and never revives a delayed earlier acknowledgement',async()=>{
 const {bindPrivatePageLifecycle}=await import('../src/private-page-lifecycle.ts');
 const events=new EventTarget(),page=Object.assign(new EventTarget(),{visibilityState:'hidden'});let reads=0,writes=0,c:any,resolve!:(v:unknown)=>void,newer:any;
 const h=harness((_p,i)=>{if(i.method){writes++;c=JSON.parse(String(i.body));return new Promise(r=>resolve=r);}reads++;return{settings:newer??initial};});
 const lifecycle=bindPrivatePageLifecycle(h.controller,events,page,()=>true);assert.equal(reads,0);
 page.visibilityState='visible';page.dispatchEvent(new Event('visibilitychange'));await until(()=>h.controller.snapshot().loaded);h.controller.begin(choice);const pending=h.controller.snapshot().pending;
 page.visibilityState='hidden';page.dispatchEvent(new Event('visibilitychange'));assert.equal(h.controller.snapshot().settings,null);
 newer={...saved(c).settings,revision:2,lastOperationId:randomUUID(),reminders:'off'};lifecycle.refresh();assert.equal(reads,1);
 page.visibilityState='visible';page.dispatchEvent(new Event('visibilitychange'));await until(()=>h.controller.snapshot().loaded);assert.equal(h.controller.snapshot().settings?.revision,2);
 resolve(saved(c));await new Promise(r=>setTimeout(r,5));assert.equal(h.controller.snapshot().settings?.revision,2);assert.equal(h.controller.snapshot().pending,pending);assert.equal(writes,1);
 lifecycle.dispose();events.dispatchEvent(new Event('online'));assert.equal(h.controller.snapshot().pending,null);assert.equal(reads,2);
});
