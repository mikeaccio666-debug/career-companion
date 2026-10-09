import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CareerProfileController} from '../src/career-profile-controller.ts';
import {readCareerProfile,changeCareerProfile,type CareerProfileClient} from '../src/career-profile-api.ts';
import {ApiError} from '../src/api-error.ts';
const owner=randomUUID(),at='2026-10-09T00:00:00.000Z';
const command=()=>({operationId:randomUUID(),expectedRevision:0,confirmed:true,facts:{degreeField:'cs',graduationMonth:'2028-05',graduated:false,targetTracks:['swe']}});
const blank=()=>({ownerId:owner,revision:0,profile:null});
function saved(body:any,replayed=false){const revision=body.expectedRevision+1;return {ownerId:owner,revision,profile:{...body.facts,id:owner,ownerId:owner,revision,source:'user_entered',createdAt:at,updatedAt:at,confirmedAt:at,lastOperationId:body.operationId},operation:{id:body.operationId,action:'save',appliedRevision:revision,replayed}};}
function harness(run:(path:string,init:RequestInit)=>unknown){let current=true;const listeners=new Set<()=>void>();const client:CareerProfileClient={account:{accountId:owner},isCurrent:()=>current,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},request:async(path,init={})=>await run(path,init) as any};return {client,controller:new CareerProfileController(client,()=>{},30),invalidate(){current=false;for(const fn of listeners)fn();}};}
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert(check());}
async function ready(h:ReturnType<typeof harness>){h.controller.start();await until(()=>!!h.controller.snapshot().data&&!h.controller.snapshot().busy);}
test('lost acknowledgement freezes one intent; missing read-only observation cannot discard it and retry never invents a new operation',async()=>{
 let receipt:any,writes=0;const bodies:any[]=[];const h=harness((p,i)=>{if(p.includes('/operations/'))throw new ApiError('missing',404,'NOT_FOUND');if(!i.method)return blank();writes++;bodies.push(JSON.parse(String(i.body)));if(receipt)return {...receipt,operation:{...receipt.operation,replayed:true}};receipt=saved(bodies[0]);throw Error('lost');});
 await ready(h);h.controller.begin('save',command());await until(()=>!h.controller.snapshot().busy&&!!h.controller.snapshot().pending);
 const original=h.controller.snapshot().pending;assert(Object.isFrozen(original?.body.facts));await h.controller.refresh();assert.equal(h.controller.snapshot().pending,original);assert.equal(writes,1);
 h.controller.begin('save',command());assert.equal(writes,1);await h.controller.retry();assert.deepEqual(bodies[0],bodies[1]);assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().data?.revision,1);h.controller.stop();
});
test('suspend hides data, aborts hung write, and resumes with only operation observation; late response cannot overwrite recovery',async()=>{
 let body:any,resolve!:(v:any)=>void,writes=0;const h=harness((p,i)=>{if(p.includes('/operations/'))return {...saved(body,true),revision:2,profile:null};if(!i.method)return blank();writes++;body=JSON.parse(String(i.body));return new Promise(r=>resolve=r);});
 await ready(h);h.controller.begin('save',command());await until(()=>!!body);h.controller.suspend();assert.equal(h.controller.snapshot().data,null);assert(h.controller.snapshot().pending);
 h.controller.resume();await until(()=>!h.controller.snapshot().busy&&!h.controller.snapshot().pending);assert.equal(writes,1);assert.equal(h.controller.snapshot().data?.revision,2);
 resolve(saved(body));await new Promise(r=>setTimeout(r,5));assert.equal(h.controller.snapshot().data?.profile,null);h.controller.stop();
});
test('timeout keeps original intent; account invalidation clears data, drafts and pending operations',async()=>{
 const h=harness((_p,i)=>i.method?new Promise(()=>{}):blank());await ready(h);h.controller.begin('save',command());await until(()=>!h.controller.snapshot().busy&&!!h.controller.snapshot().error);
 assert(h.controller.snapshot().pending);h.invalidate();assert.equal(h.controller.snapshot().data,null);assert.equal(h.controller.snapshot().pending,null);
});
test('stale revision is rejected locally; server conflict requires fresh read and owner action',async()=>{
 let writes=0;const h=harness((_p,i)=>{if(!i.method)return blank();writes++;throw new ApiError('conflict',409,'CAREER_PROFILE_REVISION_CHANGED');});
 await ready(h);h.controller.begin('save',{...command(),expectedRevision:1});assert.equal(writes,0);
 h.controller.begin('save',command());await until(()=>!h.controller.snapshot().busy);assert.equal(h.controller.snapshot().data,null);assert.equal(h.controller.snapshot().pending,null);
 h.controller.begin('save',command());assert.equal(writes,1);h.controller.stop();
});
test('transport rejects wrong owner, revision, command facts and stale/aborted clients before accepting responses',async()=>{
 const cmd=command(),correct=saved(cmd);
 for(const raw of [{...correct,ownerId:randomUUID()},{...correct,profile:{...correct.profile,graduationMonth:'2029-12'}},{...correct,revision:0},{...correct,operation:{...correct.operation,action:'delete'}},{...correct,operation:{...correct.operation,id:randomUUID()}}]){
  await assert.rejects(changeCareerProfile(harness(()=>raw).client,'save',cmd));
 }
 let calls=0;const stale=harness(()=>{calls++;return blank();});stale.invalidate();await assert.rejects(readCareerProfile(stale.client));await assert.rejects(changeCareerProfile(stale.client,'save',cmd));assert.equal(calls,0);
 const a=new AbortController();a.abort();await assert.rejects(readCareerProfile(harness(()=>{calls++;return blank();}).client,a.signal));assert.equal(calls,0);
 const late=harness(()=>{late.invalidate();return correct;});await assert.rejects(changeCareerProfile(late.client,'save',cmd));
 await assert.rejects(changeCareerProfile(harness(()=>correct).client,'save',cmd,undefined,true));
});
test('observing an old deletion may return a newer recreated profile, but cannot claim deletion while returning the same revision profile',async()=>{
 const cmd={operationId:randomUUID(),expectedRevision:1},old={id:cmd.operationId,action:'delete',appliedRevision:2,replayed:true};
 const newer=saved({...command(),expectedRevision:2});const h=harness((_p,i)=>{assert.equal(i.method,undefined);assert.equal(i.body,undefined);return {...newer,operation:old};});
 assert.equal((await changeCareerProfile(h.client,'delete',cmd,undefined,true)).revision,3);
 await assert.rejects(changeCareerProfile(harness(()=>({...newer,revision:2,profile:{...newer.profile,revision:2},operation:old})).client,'delete',cmd,undefined,true));
});
