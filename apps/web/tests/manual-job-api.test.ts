import { test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';import { manualJobSummary } from '@companion/platform-contracts';
import type { BoundPlatformClient } from '../src/api.ts';import { readManualJobs,readManualJob,readManualJobDuplicates,changeManualJob } from '../src/manual-job-api.ts';
const owner=randomUUID(),id=randomUUID(),at='2026-10-08T00:00:00.000Z';
const body=(op=randomUUID())=>({operationId:op,expectedRevision:0,employer:'Fictional Company',title:'Fictional Analyst',canonicalUrl:'https://example.invalid/jobs/1',roleFamily:'da',location:'',deadlineAt:null,deadlineTimeZone:null,privateNote:'Fictional private note',jobText:'Fictional role. We sponsor candidates.'});
const state=(patch:Record<string,unknown>={})=>{const {operationId,expectedRevision,...fields}=body();return {...fields,id,ownerId:owner,sourceId:id,source:'manual' as const,state:'unknown' as const,observedAt:at,checkedAt:at,revision:1,lastOperationId:operationId,sponsorship:'explicit_yes' as const,sponsorshipEvidence:[{text:'We sponsor candidates.',start:16,end:38,status:'explicit_yes' as const}],evidenceOverflow:false,ruleRevision:1,...patch} as any;};
function client(run:(path:string,init:RequestInit)=>unknown):BoundPlatformClient{return {account:{accountId:owner,generation:1},isCurrent:()=>true,subscribe:()=>()=>{},request:async(path,init={})=>await run(path,init)} as BoundPlatformClient;}
test('private transport copies owner summaries, rejects duplicates/foreign owner/false paging and keeps raw text out of lists',async()=>{
 const summary=manualJobSummary(state());const r=await readManualJobs(client(()=>({jobs:[summary],nextAfter:null})));assert.equal(r.jobs.length,1);assert(!('jobText' in r.jobs[0]));assert(Object.isFrozen(r.jobs));
 for(const response of [{jobs:[manualJobSummary(state({ownerId:randomUUID()}))],nextAfter:null},{jobs:[summary,summary],nextAfter:null},{jobs:[summary],nextAfter:id}])await assert.rejects(readManualJobs(client(()=>response)));
});
test('a source view rejects foreign identity, false observation state and forged evidence substring',async()=>{
 assert.equal((await readManualJob(client(()=>({job:state()})),id)).source,'manual');for(const patch of [{ownerId:randomUUID()},{state:'observed_open'},{id:randomUUID()},{sponsorshipEvidence:[{text:'Fake policy guarantee',start:16,end:38,status:'explicit_yes'}]}])await assert.rejects(readManualJob(client(()=>({job:state(patch)})),id));
});
test('stable create operation acknowledgement must preserve original JD and all user-entered fields',async()=>{
 const input=body(),op={id:input.operationId,observationId:id,appliedRevision:1,replayed:false},job=state({lastOperationId:input.operationId});const c=client((path,init)=>{assert.equal(path,'/career/job-observations');assert.equal(init.method,'POST');assert.equal(JSON.parse(String(init.body)).operationId,input.operationId);return {job,operation:op};});assert.equal((await changeManualJob(c,'create',null,input)).job!.id,id);
 for(const patch of [{ownerId:randomUUID()},{jobText:'Fictional changed'},{privateNote:'Fictional unrequested replacement'},{title:'Fictional unrequested role'},{lastOperationId:randomUUID()}])await assert.rejects(changeManualJob(client(()=>({job:state(patch),operation:op})),'create',null,input));
 let reached=false;await assert.rejects(changeManualJob(client(()=>{reached=true;return {};}),'create',null,{...input,state:'observed_open'}));assert.equal(reached,false);
});
test('a removed observation can replay as absent, and duplicate lookup never accepts foreign or duplicate summaries',async()=>{
 const input=body(),operation={id:input.operationId,observationId:id,appliedRevision:1,replayed:true};assert.equal((await changeManualJob(client(()=>({job:null,operation})),'create',null,input)).job,null);
 const summary=manualJobSummary(state());assert.equal((await readManualJobDuplicates(client(()=>({jobs:[summary]})),input))[0].id,id);for(const jobs of [[manualJobSummary(state({ownerId:randomUUID()}))],[summary,summary]])await assert.rejects(readManualJobDuplicates(client(()=>({jobs})),input));
});
