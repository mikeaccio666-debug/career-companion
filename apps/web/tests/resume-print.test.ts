import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {BoundPlatformClient} from '../src/api.ts';
import type {ResumeReviewItem} from '@companion/platform-contracts';
import {resumePayloadDigest} from '../src/resume-review-api.ts';
import {readPrintableResume} from '../src/resume-print-api.ts';
import {ResumePrintController} from '../src/resume-print-controller.ts';
const owner=randomUUID(),id=randomUUID(),at='2026-10-09T00:00:00.000Z';
async function fixture(){
 const payload={text:'Fictional Lin\n业务分析 · IBM course report\n<script>fictional()</script>\nLast line.',claims:[],source_refs:[{kind:'owner_resume_input',id,revision:1}]} as any;
 const digest=await resumePayloadDigest(payload);
 const item:ResumeReviewItem={id,ownerId:owner,resumeVersionId:randomUUID(),kind:'resume_version',finalAction:'none',draftedBy:null,title:'简历版本',label:'Fictional original',track:'da',sequence:1,source:'paste',uploadId:null,derivedFrom:null,status:'approved',resumeStatus:'active',revision:1,generation:2,payloadDigest:digest,sensitivity:'sensitive',approvedRevision:1,approvedDigest:digest,approvedAt:at,approvedChannel:'web',approvalOperationId:randomUUID(),supersededBy:null,expiresAt:'2026-10-16T00:00:00.000Z',createdAt:at,updatedAt:at,lastOperationId:randomUUID()};
 return {item,payload};
}
function harness(run:(path:string,init:RequestInit)=>unknown){
 let current=true;const listeners=new Set<()=>void>(),calls:RequestInit[]=[];
 const client={account:{accountId:owner,generation:1},isCurrent:()=>current,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},request:async(path:string,init:RequestInit={})=>{calls.push(init);assert.equal(path,'/pending-items/'+id);assert.equal(init.cache,'no-store');assert.equal(init.method,undefined);return await run(path,init);}} as BoundPlatformClient;
 return {client,calls,invalidate(){current=false;for(const fn of listeners)fn();},listenerCount:()=>listeners.size};
}
test('print reads exact confirmed text including literal markup, and permits confirmed archived history',async()=>{
 const v=await fixture(),h=harness(()=>v);
 assert.equal(await readPrintableResume(h.client,v.item,new AbortController().signal),v.payload.text);
 const archived={...v,item:{...v.item,resumeStatus:'archived' as const,generation:3}};
 assert.equal(await readPrintableResume(harness(()=>archived).client,archived.item,new AbortController().signal),v.payload.text);
});
test('print rejects changed versions, foreign ownership, unconfirmed data, modified payload and deleted records',async()=>{
 const v=await fixture();
 for(const response of [
 {...v,item:{...v.item,generation:3}},
 {...v,item:{...v.item,ownerId:randomUUID()}},
 {...v,item:{...v.item,resumeVersionId:randomUUID()}},
 {...v,payload:{...v.payload,text:'Fictional substituted text'}},
 {...v,item:{...v.item,resumeStatus:'archived',generation:3}},
 ]){
  await assert.rejects(readPrintableResume(harness(()=>response).client,v.item,new AbortController().signal));
 }
 await assert.rejects(readPrintableResume(harness(()=>{throw Error('404');}).client,v.item,new AbortController().signal));
 const h=harness(()=>v);
 await assert.rejects(readPrintableResume(h.client,{...v.item,status:'pending',resumeStatus:'draft',approvedRevision:null,approvedDigest:null,approvedAt:null,approvedChannel:null,approvalOperationId:null} as any,new AbortController().signal));
 assert.equal(h.calls.length,0);
});
test('account change or cancellation while reading cannot return private text',async()=>{
 const v=await fixture();let finish!:(value:unknown)=>void;
 const h=harness(()=>new Promise(resolve=>{finish=resolve;}));
 const p=readPrintableResume(h.client,v.item,new AbortController().signal);h.invalidate();finish(v);await assert.rejects(p);
 const h2=harness(()=>new Promise(resolve=>{finish=resolve;})),c=new AbortController(),p2=readPrintableResume(h2.client,v.item,c.signal);c.abort();finish(v);await assert.rejects(p2);
});
test('preview and every explicit print separately revalidate, duplicate clicks cannot print twice, no success claim',async()=>{
 const v=await fixture(),h=harness(()=>v),c=new ResumePrintController(h.client,v.item);c.start();
 await c.prepare();assert.equal(c.getSnapshot().text,v.payload.text);assert.equal(h.calls.length,1);
 let printed=0,release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
 const printing=c.print(async()=>{printed++;assert.equal(c.getSnapshot().phase,'printing');entered();await new Promise<void>(resolve=>{release=resolve;});});
 await ready;
 await c.print(async()=>{printed++;});assert.equal(printed,1);assert.equal(h.calls.length,2);
 release();await printing;assert.equal(c.getSnapshot().phase,'preview');
 await c.print(async()=>{printed++;});assert.equal(printed,2);assert.equal(h.calls.length,3);c.stop();assert.equal(h.listenerCount(),0);
});
test('stale print recheck clears preview and never invokes browser print',async()=>{
 const v=await fixture();let response=v,printed=false;
 const h=harness(()=>response),c=new ResumePrintController(h.client,v.item);c.start();await c.prepare();
 response={...v,item:{...v.item,generation:3}};await c.print(async()=>{printed=true;});
 assert.equal(printed,false);assert.equal(c.getSnapshot().text,'');assert.equal(c.getSnapshot().phase,'error');c.stop();
});
test('timeout aborts even a transport ignoring cancellation; a late response cannot resurrect a closed preview',async()=>{
 const v=await fixture();let finish!:(value:unknown)=>void;
 const h=harness(()=>new Promise(resolve=>{finish=resolve;})),c=new ResumePrintController(h.client,v.item,15);c.start();
 await c.prepare();assert.equal(c.getSnapshot().phase,'error');assert.equal(h.calls[0].signal!.aborted,true);
 c.close();finish(v);await new Promise(resolve=>setImmediate(resolve));assert.equal(c.getSnapshot().phase,'closed');assert.equal(c.getSnapshot().text,'');c.stop();
});
test('close, account invalidation and remount clear memory and listeners; late printer cannot restore text',async()=>{
 const v=await fixture(),h=harness(()=>v),c=new ResumePrintController(h.client,v.item);c.start();c.stop();c.start();assert.equal(h.listenerCount(),1);
 await c.prepare();c.close();assert.equal(c.getSnapshot().text,'');
 await c.prepare();let finish!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});const p=c.print(()=>new Promise<void>(resolve=>{finish=resolve;entered();}));await ready;
 h.invalidate();await p;finish();assert.equal(c.getSnapshot().phase,'closed');assert.equal(c.getSnapshot().text,'');c.stop();assert.equal(h.listenerCount(),0);
});

test('a printer failure clears the body and does not claim an exported file',async()=>{
 const v=await fixture(),h=harness(()=>v),c=new ResumePrintController(h.client,v.item);c.start();await c.prepare();
 await c.print(async()=>{throw Error('Fictional printer unavailable');});
 assert.equal(c.getSnapshot().phase,'error');assert.equal(c.getSnapshot().text,'');c.stop();
});
