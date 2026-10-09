import test from 'node:test';
import assert from 'node:assert/strict';
import { JourneySectionController } from '../src/journey-section-controller.ts';
import { journeyReads } from '../src/journey-api.ts';
import type { BoundPlatformClient } from '../src/api.ts';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>() { let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}; }
function account() { let current=true;const listeners=new Set<()=>void>();return {isCurrent:()=>current,subscribe(fn:()=>void){listeners.add(fn);return()=>listeners.delete(fn);},expire(){current=false;for(const fn of [...listeners])fn();},listeners}; }
test('independent section failures neither erase successful sections nor become empty data',async()=>{
 const a=account();let fail=false;const one=new JourneySectionController(a,async()=>{if(fail)throw Error('Private raw error');return ['direction'];},()=>{});
 const two=new JourneySectionController(a,async()=>['interview'],()=>{});one.start();two.start();await tick();fail=true;await one.refresh();
 assert.deepEqual(two.snapshot().value,['interview']);assert.equal(one.snapshot().value,null);assert.equal(one.snapshot().failed,true);assert(!JSON.stringify(one.snapshot()).includes('Private raw error'));one.stop();two.stop();assert.equal(a.listeners.size,0);
});
test('duplicate refresh is single flight; loading removes previous data and successful empty is distinct from failure',async()=>{
 const a=account();let calls=0;let read=async()=>['old'];const c=new JourneySectionController(a,()=>{calls++;return read();},()=>{});c.start();await tick();
 const wait=deferred<string[]>();read=()=>wait.promise;const first=c.refresh();await c.refresh();assert.equal(calls,2);assert.equal(c.snapshot().value,null);assert(c.snapshot().busy);
 wait.resolve([]);await first;assert.deepEqual(c.snapshot().value,[]);assert(!c.snapshot().failed);c.stop();
});
test('stop and restart discard the previous transport even when it ignores abort',async()=>{
 const a=account(),old=deferred<string[]>();let signal:AbortSignal|undefined,read=()=>old.promise;
 const c=new JourneySectionController(a,s=>{signal=s;return read();},()=>{});c.start();const previous=signal!;c.stop();assert(previous.aborted);
 read=async()=>['fresh'];c.start();await tick();old.resolve(['stale']);await tick();assert.deepEqual(c.snapshot().value,['fresh']);assert.equal(a.listeners.size,1);c.stop();
});
test('revoking the account removes loaded data and forbids further reads',async()=>{
 const a=account();let calls=0;const c=new JourneySectionController(a,async()=>{calls++;return ['private'];},()=>{});c.start();await tick();a.expire();assert.equal(c.snapshot().value,null);await c.refresh();c.start();assert.equal(calls,1);assert.equal(a.listeners.size,0);
});
test('an uncooperative read times out and its later result cannot override a retry',async()=>{
 const a=account(),old=deferred<string[]>();let read=()=>old.promise;const c=new JourneySectionController(a,()=>read(),()=>{},10);c.start();await new Promise(r=>setTimeout(r,30));assert(c.snapshot().failed);assert(!c.snapshot().busy);
 read=async()=>['fresh'];await c.refresh();old.resolve(['stale']);await tick();assert.deepEqual(c.snapshot().value,['fresh']);c.stop();
});
test('journey adapters use only existing read routes and enforce cancellation and account freshness',async()=>{
 const a=account(),calls:{path:string;init:RequestInit}[]=[];
 const responses:Record<string,unknown>={'/career/targets':{targets:[]},'/career/applications':{applications:[],nextAfter:null},'/career/interviews':{interviews:[],nextAfter:null},'/career/stories':{records:[],nextAfter:null},'/pending-items':{items:[],nextAfter:null},'/career/mentor-intents':{sessions:[],nextCursor:null}};
 const client={...a,account:{accountId:'11111111-1111-4111-8111-111111111111',generation:1},async request(path:string,init:RequestInit={}){calls.push({path,init});return responses[path];}} as unknown as BoundPlatformClient;
 for(const read of Object.values(journeyReads))await read(client,new AbortController().signal);
 assert.equal(calls.length,6);assert(calls.every(c=>!c.init.method&&!c.init.body));
 for(const read of Object.values(journeyReads))await assert.rejects(read(client,AbortSignal.abort()));assert.equal(calls.length,6);
 const late=deferred<unknown>();client.request=async()=>await late.promise as never;
 const pending=journeyReads.targets(client,new AbortController().signal);a.expire();late.resolve({targets:[]});await assert.rejects(pending);
});
