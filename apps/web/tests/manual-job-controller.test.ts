import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {manualJobSummary} from '@companion/platform-contracts';
import {ManualJobController} from '../src/manual-job-controller.ts';
import {changeManualJob,type ManualJobClient} from '../src/manual-job-api.ts';
import {ApiError} from '../src/api-error.ts';
const owner=randomUUID(),id=randomUUID(),at='2026-10-09T00:00:00.000Z';
const command=()=>({operationId:randomUUID(),expectedRevision:0,employer:'Fictional Company',title:'Fictional Analyst',canonicalUrl:'https://example.invalid/job',roleFamily:'da',location:'',
 deadlineAt:'2026-11-01T06:30:00.000Z',deadlineTimeZone:'America/New_York',jobText:'Fictional role.',privateNote:'Fictional private note'});
function saved(body:any,replayed=false){const {operationId,expectedRevision,allowDuplicate,...values}=body;
 return {job:{...values,id,ownerId:owner,sourceId:id,source:'manual',state:'unknown',revision:1,lastOperationId:operationId,observedAt:at,checkedAt:at,
 sponsorship:'unknown',sponsorshipEvidence:[],evidenceOverflow:false,ruleRevision:1},operation:{id:operationId,observationId:id,appliedRevision:1,replayed}};}
function harness(run:(path:string,init:RequestInit)=>unknown){
 let active=true;const listeners=new Set<()=>void>();
 const client:ManualJobClient={account:{accountId:owner,generation:1},isCurrent:()=>active,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},request:async(path,init={})=>await run(path,init) as any};
 return {client,controller:new ManualJobController(client,()=>{},60),invalidate(){active=false;for(const fn of [...listeners])fn();}};
}
async function until(check:()=>boolean){for(let i=0;i<300;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert(check());}
async function ready(h:ReturnType<typeof harness>){h.controller.start();await until(()=>h.controller.snapshot().loaded&&!h.controller.snapshot().busy);}
test('lost save is reconciled by GET, retaining source timezone and the frozen command across read failures',async()=>{
 let receipt:any,failRead=false,writes=0,reads=0;
 const h=harness((path,init)=>{if(path.includes('/operations/')){reads++;assert.equal(init.method,undefined);assert.equal(init.body,undefined);return {...receipt,operation:{...receipt.operation,replayed:true}};}
  if(!init.method){if(failRead)throw Error('Read unavailable');return {jobs:receipt?[manualJobSummary(receipt.job)]:[],nextAfter:null};}
  writes++;receipt=saved(JSON.parse(String(init.body)));throw Error('Lost acknowledgement');});
 await ready(h);h.controller.begin('create',null,command());await until(()=>h.controller.snapshot().uncertain);
 const pending=h.controller.snapshot().pending!;assert(Object.isFrozen(pending));assert(Object.isFrozen(pending.body));
 assert.equal(pending.body.deadlineTimeZone,'America/New_York');
 failRead=true;await h.controller.refresh();assert.equal(h.controller.snapshot().loaded,false);assert.deepEqual(h.controller.snapshot().jobs,[]);
 assert.equal(h.controller.snapshot().pending,pending);await h.controller.observe();
 assert.equal(writes,1);assert.equal(reads,1);assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().loaded,false);
 failRead=false;await h.controller.refresh();assert.equal(h.controller.snapshot().jobs.length,1);h.controller.stop();
});
test('missing observation remains uncertain; explicit retry keeps the exact original operation',async()=>{
 let receipt:any;const writes:any[]=[];
 const h=harness((path,init)=>{if(path.includes('/operations/'))throw new ApiError('Missing',404,'NOT_FOUND');
  if(!init.method)return {jobs:[],nextAfter:null};const body=JSON.parse(String(init.body));writes.push(body);
  if(receipt)return {...receipt,operation:{...receipt.operation,replayed:true}};receipt=saved(body);throw Error('Lost');});
 await ready(h);h.controller.begin('create',null,command());await until(()=>h.controller.snapshot().uncertain);
 const pending=h.controller.snapshot().pending;await h.controller.observe();assert.equal(h.controller.snapshot().pending,pending);
 h.controller.begin('create',null,command());assert.equal(writes.length,1);
 await h.controller.retry();assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.equal(h.controller.snapshot().pending,null);h.controller.stop();
});
test('offline hides rows and detail, retains unknown intent, and online performs reads only',async()=>{
 let receipt=saved(command()),writes=0,resolve!:(value:unknown)=>void;
 const h=harness((path,init)=>{if(init.method){writes++;return new Promise(r=>resolve=r);}if(path.endsWith('/'+id))return {job:receipt.job};return {jobs:[manualJobSummary(receipt.job)],nextAfter:null};});
 await ready(h);await h.controller.open(id);assert(h.controller.snapshot().detail);
 h.controller.begin('delete',id,{operationId:randomUUID(),expectedRevision:1});h.controller.suspend();
 assert.equal(h.controller.snapshot().jobs.length,0);assert.equal(h.controller.snapshot().detail,null);assert(h.controller.snapshot().pending);assert.equal(h.controller.snapshot().busy,false);
 h.controller.resume();await until(()=>h.controller.snapshot().loaded);assert.equal(writes,1);
 resolve({job:null,operation:{id:h.controller.snapshot().pending!.body.operationId,observationId:id,appliedRevision:2,replayed:false}});
 await new Promise(r=>setTimeout(r,5));assert(h.controller.snapshot().pending);assert.equal(h.controller.snapshot().jobs.length,1);h.controller.stop();
});
test('noncooperating requests time out and a late response cannot overwrite a reconciled deletion',async()=>{
 let body:any,finish!:(value:unknown)=>void;
 const h=harness((path,init)=>{if(path.includes('/operations/'))return {...saved(body,true),job:null};
  if(!init.method)return {jobs:[],nextAfter:null};body=JSON.parse(String(init.body));return new Promise(r=>finish=r);});
 await ready(h);h.controller.begin('create',null,command());await until(()=>h.controller.snapshot().uncertain);
 await h.controller.observe();assert.equal(h.controller.snapshot().pending,null);assert.match(h.controller.snapshot().notice,/移除/);
 finish(saved(body));await new Promise(r=>setTimeout(r,5));assert.equal(h.controller.snapshot().jobs.length,0);h.controller.stop();
});
test('local and server duplicates require explicit new intent and reject a broken duplicate lookup',async()=>{
 const row=saved(command()).job;let writes=0,failLookup=false;
 const h=harness((path,init)=>{if(path.endsWith('/duplicates')){if(failLookup)throw Error('Lookup failed');return {jobs:[manualJobSummary(row)]};}
  if(!init.method)return {jobs:[],nextAfter:null};writes++;throw new ApiError('Duplicate',409,'MANUAL_JOB_DUPLICATE');});
 await ready(h);h.controller.begin('create',null,command());await until(()=>h.controller.snapshot().duplicate);
 assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().matches.length,1);assert.equal(writes,1);
 h.controller.dismissDuplicate();failLookup=true;h.controller.begin('create',null,command());await until(()=>!h.controller.snapshot().busy);
 assert.equal(h.controller.snapshot().loaded,false);assert.equal(h.controller.snapshot().matches.length,0);h.controller.stop();
 const local=harness(()=>({jobs:[manualJobSummary(row)],nextAfter:null}));await ready(local);local.controller.begin('create',null,command());
 assert(local.controller.snapshot().duplicate);assert.equal(local.controller.snapshot().pending,null);local.controller.stop();
});
test('account invalidation and stop/start discard private state and ignore previous reads',async()=>{
 let reads=0,finish!:(value:unknown)=>void;
 const h=harness(()=>{if(++reads===1)return new Promise(r=>finish=r);return {jobs:[],nextAfter:null};});
 h.controller.start();h.controller.stop();h.controller.start();await until(()=>h.controller.snapshot().loaded);
 finish({jobs:[manualJobSummary(saved(command()).job)],nextAfter:null});await new Promise(r=>setTimeout(r,5));assert.equal(h.controller.snapshot().jobs.length,0);
 h.invalidate();assert.equal(h.controller.snapshot().loaded,false);assert.equal(h.controller.snapshot().pending,null);
});
test('observation parser rejects forged receipts, changed deadlines and resurrected delete results',async()=>{
 const input=command(),receipt=saved(input,true);
 for(const response of [{...receipt,operation:{...receipt.operation,replayed:false}},
  {...receipt,operation:{...receipt.operation,id:randomUUID()}},{...receipt,job:{...receipt.job,deadlineAt:'2026-11-01T05:30:00.000Z'}},
  {...receipt,job:{...receipt.job,deadlineTimeZone:'UTC'}}]){
  const h=harness(()=>response);await assert.rejects(changeManualJob(h.client,'create',null,input,undefined,true));
 }
 const deletion={operationId:randomUUID(),expectedRevision:1},h=harness(()=>({...receipt,operation:{id:deletion.operationId,observationId:id,appliedRevision:2,replayed:true}}));
 await assert.rejects(changeManualJob(h.client,'delete',id,deletion,undefined,true));
});
