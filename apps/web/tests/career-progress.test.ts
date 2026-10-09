import test from 'node:test';
import assert from 'node:assert/strict';
import { readCareerProgress, type CareerProgressClient } from '../src/career-progress-api.ts';
import { CareerProgressController } from '../src/career-progress-controller.ts';
const owner='11111111-1111-4111-8111-111111111111';
const counts=()=>({project:0,resume_review:0,practice_review:0,outreach:0,application:0,interview:0});
const data=(applications=53)=>({ownerId:owner,coverage:['project','application','interview'],progress:{policyRevision:1,counts:{...counts(),project:1},provisionalCounts:{...counts(),application:applications,interview:23},milestones:['first_project_evidence']}});
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{resolve,promise};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){let active=true,run:()=>Promise<unknown>=async()=>data();const listeners=new Set<()=>void>(),calls:{path:string;init:RequestInit}[]=[];const client:CareerProgressClient={account:{accountId:owner,generation:1},isCurrent:()=>active,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async request(path,init={}){calls.push({path,init});return await run() as any;}};return{client,calls,set(fn:()=>Promise<unknown>){run=fn;},expire(){active=false;for(const f of [...listeners])f();},listeners};}
test('owned progress is one GET, complete counts are not limited to the visible list page, foreign and aborted responses fail',async()=>{
 const f=fixture();assert.equal((await readCareerProgress(f.client)).progress.provisionalCounts.application,53);assert.equal((await readCareerProgress(f.client)).progress.provisionalCounts.interview,23);assert.equal(f.calls[0].path,'/career/progress');assert.equal(f.calls[0].init.method,undefined);assert.equal(f.calls[0].init.body,undefined);
 f.set(async()=>({...data(),ownerId:'22222222-2222-4222-8222-222222222222'}));await assert.rejects(readCareerProgress(f.client));
 const c=new AbortController();f.set(async()=>{c.abort();return data();});await assert.rejects(readCareerProgress(f.client,c.signal));
 const before=f.calls.length;await assert.rejects(readCareerProgress(f.client,AbortSignal.abort()));assert.equal(f.calls.length,before);
 f.expire();await assert.rejects(readCareerProgress(f.client));assert.equal(f.calls.length,before);
});
test('refresh clears old counts while loading and on failure rather than returning stale or zero activity',async()=>{
 const f=fixture(),c=new CareerProgressController(f.client,()=>{});c.start();await tick();assert.equal(c.snapshot().value?.progress.counts.project,1);
 const next=deferred<unknown>();f.set(()=>next.promise);const request=c.refresh();assert.equal(c.snapshot().value,null);assert(c.snapshot().busy);next.resolve(data(54));await request;assert.equal(c.snapshot().value?.progress.provisionalCounts.application,54);
 f.set(async()=>{throw Error('Fictional service failure');});await c.refresh();assert.equal(c.snapshot().value,null);assert(!c.snapshot().busy);assert(c.snapshot().error);c.stop();assert.equal(f.listeners.size,0);
});
test('stop aborts non-cooperative transport and stale completions cannot replace a restarted source snapshot',async()=>{
 const f=fixture(),old=deferred<unknown>();f.set(()=>old.promise);const c=new CareerProgressController(f.client,()=>{});c.start();const signal=f.calls[0].init.signal!;c.stop();assert(signal.aborted);assert.equal(c.snapshot().value,null);
 f.set(async()=>data(2));c.start();await tick();old.resolve(data(100));await tick();assert.equal(c.snapshot().value?.progress.provisionalCounts.application,2);assert.equal(f.listeners.size,1);c.stop();
});
test('a real account invalidation clears loaded values and any later response',async()=>{
 const f=fixture(),c=new CareerProgressController(f.client,()=>{});c.start();await tick();const late=deferred<unknown>();f.set(()=>late.promise);const request=c.refresh();f.expire();late.resolve(data());await request;assert.equal(c.snapshot().value,null);assert.equal(f.listeners.size,0);const n=f.calls.length;await c.refresh();assert.equal(f.calls.length,n);
});
test('a bounded non-cooperative read times out, clears private values and allows one fresh retry without writes',async()=>{
 const f=fixture();f.set(()=>new Promise(()=>{}));const c=new CareerProgressController(f.client,()=>{},10);c.start();await new Promise(r=>setTimeout(r,30));assert(!c.snapshot().busy);assert.equal(c.snapshot().value,null);assert(c.snapshot().error);assert(f.calls[0].init.signal?.aborted);
 f.set(async()=>data());await c.refresh();assert.equal(c.snapshot().value?.progress.provisionalCounts.application,53);assert(f.calls.every(x=>!x.init.method&&!x.init.body));c.stop();
});
