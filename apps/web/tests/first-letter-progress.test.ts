import test from 'node:test';
import assert from 'node:assert/strict';
import {readFirstLetterProgress} from '../src/first-letter-progress-api.ts';
import {JourneySectionController} from '../src/journey-section-controller.ts';
import type {BoundPlatformClient} from '../src/api.ts';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const value=()=>({ownerId:id,companionId:id,welcomeId:id,state:'prepared',capturedAt:'2026-10-09T20:00:00.000Z',delivered:false});
function fixture(){
 let current=true,reply:()=>Promise<unknown>=async()=>value();const listeners=new Set<()=>void>();
 const calls:{path:string;init:RequestInit}[]=[];
 const client:Pick<BoundPlatformClient,'account'|'isCurrent'|'request'|'subscribe'>={account:{accountId:id,generation:1},isCurrent:()=>current,
  request:async(path,init={})=>{calls.push({path,init});return await reply() as any;},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
 return {client,calls,set(fn:()=>Promise<unknown>){reply=fn;},expire(){current=false;listeners.forEach(fn=>fn());}};
}
test('progress reads only the current owner, companion and welcome without sending an execution request',async()=>{
 const f=fixture();assert.equal((await readFirstLetterProgress(f.client,id,id)).state,'prepared');
 assert.deepEqual(f.calls.map(x=>[x.path,x.init.method,x.init.body]),[['/companion/first-letter/progress',undefined,undefined]]);
 for(const key of ['ownerId','companionId','welcomeId']){f.set(async()=>({...value(),[key]:other}));await assert.rejects(readFirstLetterProgress(f.client,id,id));}
 f.set(async()=>({...value(),delivered:true}));await assert.rejects(readFirstLetterProgress(f.client,id,id));
 const before=f.calls.length;await assert.rejects(readFirstLetterProgress(f.client,id,id,AbortSignal.abort()));
 assert.equal(f.calls.length,before);
});
test('account change, timeout and failed reads clear the old progress rather than inventing not-started state',async()=>{
 const f=fixture(),c=new JourneySectionController(f.client,s=>readFirstLetterProgress(f.client,id,id,s),()=>{},10);
 c.start();await new Promise<void>(r=>setImmediate(r));assert.equal(c.snapshot().value?.state,'prepared');
 f.set(()=>new Promise(()=>{}));await c.refresh();assert.equal(c.snapshot().value,null);assert(c.snapshot().failed);
 f.set(async()=>value());await c.refresh();f.expire();assert.equal(c.snapshot().value,null);c.stop();
});
test('late progress after leaving the page cannot restore an old account view',async()=>{
 const f=fixture();let resolve!:(value:unknown)=>void;f.set(()=>new Promise(r=>resolve=r));
 const c=new JourneySectionController(f.client,s=>readFirstLetterProgress(f.client,id,id,s),()=>{});c.start();c.stop();
 resolve(value());await new Promise<void>(r=>setImmediate(r));assert.equal(c.snapshot().value,null);
});
