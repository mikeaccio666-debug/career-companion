import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { BoundPlatformClient } from '../src/api.ts';
import { readCareerTargets,changeCareerTarget } from '../src/career-target-api.ts';
const owner=randomUUID(),id=randomUUID(),at='2026-10-08T00:00:00.000Z';
const state=(patch:Record<string,unknown>={})=>({id,ownerId:owner,roleFamily:'da',title:'Fictional protocol-only direction',locations:[],priority:1,status:'exploring',source:'user_entered',proposedBy:null,revision:1,createdAt:at,updatedAt:at,lastOperationId:randomUUID(),...patch});
function client(run:(path:string,init:RequestInit)=>unknown):BoundPlatformClient{return {account:{accountId:owner,generation:1},isCurrent:()=>true,subscribe:()=>()=>{},request:async(path,init={})=>await run(path,init)} as BoundPlatformClient;}
const command=(op=randomUUID())=>({operationId:op,expectedRevision:0,roleFamily:'da',title:'Fictional protocol-only direction',locations:[],priority:1});
test('owned direction transport rejects cross-owner and duplicate data and freezes copied lists',async()=>{
 const value=state(),result=await readCareerTargets(client(()=>({targets:[value]})));assert(Object.isFrozen(result));assert(Object.isFrozen(result[0]));value.title='Fictional changed';assert.notEqual(result[0].title,value.title);
 for(const targets of [[state({ownerId:randomUUID()})],[state(),state()]])await assert.rejects(readCareerTargets(client(()=>({targets}))));
 let reached=false;await assert.rejects(changeCareerTarget(client(()=>{reached=true;return {};}),'create',null,{...command(),status:'active'}));assert.equal(reached,false);
});
test('stable operation and expected revision are sent, and acknowledgement cannot switch owner, ID or applied version',async()=>{
 const body=command();const c=client((path,init)=>{assert.equal(path,'/career/targets');assert.equal(init.method,'POST');assert.equal(JSON.parse(String(init.body)).operationId,body.operationId);return {target:state({lastOperationId:body.operationId}),operation:{id:body.operationId,targetId:id,appliedRevision:1,replayed:false}};});
 assert.equal((await changeCareerTarget(c,'create',null,body)).target?.id,id);
 for(const patch of [{ownerId:randomUUID()},{revision:2},{lastOperationId:randomUUID()},{status:'active'},{title:'Fictional changed without owner instruction'}])await assert.rejects(changeCareerTarget(client(()=>({target:state(patch),operation:{id:body.operationId,targetId:id,appliedRevision:1,replayed:false}})),'create',null,body));
});
test('a genuine replay may return newer current state or a physically removed target, without resurrecting the earlier snapshot',async()=>{
 const op=randomUUID(),body={operationId:op,expectedRevision:1,status:'active'},operation={id:op,targetId:id,appliedRevision:2,replayed:true};
 const result=await changeCareerTarget(client(()=>({target:state({revision:4}),operation})),'status',id,body);assert.equal(result.target?.revision,4);
 assert.equal((await changeCareerTarget(client(()=>({target:null,operation})),'status',id,body)).target,null);
 await assert.rejects(changeCareerTarget(client(()=>({target:state(),operation})),'status',id,body));
});


test('review-date acknowledgements must match the owner choice, including explicit clearing; creation cannot invent a date',async()=>{
 for(const reviewOn of ['2028-02-29',null]){
  const body={operationId:randomUUID(),expectedRevision:1,reviewOn},operation={id:body.operationId,targetId:id,appliedRevision:2,replayed:false};
  const good=state({revision:2,lastOperationId:body.operationId,reviewOn});
  assert.equal((await changeCareerTarget(client((path,init)=>{assert.equal(path,'/career/targets/'+id);assert.equal(init.method,'PATCH');assert.deepEqual(JSON.parse(String(init.body)),body);return {target:good,operation};}),'edit',id,body)).target?.reviewOn,reviewOn);
  for(const wrong of [undefined,reviewOn===null?'2028-02-29':null,'2028-03-01']){
   const target={...good,reviewOn:wrong};if(wrong===undefined)delete target.reviewOn;
   await assert.rejects(changeCareerTarget(client(()=>({target,operation})),'edit',id,body));
  }
 }
 const body=command(),operation={id:body.operationId,targetId:id,appliedRevision:1,replayed:false};
 await assert.rejects(changeCareerTarget(client(()=>({target:state({lastOperationId:body.operationId,reviewOn:'2028-02-29'}),operation})),'create',null,body));
 let called=false;await assert.rejects(changeCareerTarget(client(()=>{called=true;return {};}),'edit',id,{operationId:randomUUID(),expectedRevision:1,reviewOn:'2027-02-29'}));assert.equal(called,false);
});
test('review-date replays return the current newer state, including a later cleared date',async()=>{
 const body={operationId:randomUUID(),expectedRevision:1,reviewOn:'2028-02-29'},operation={id:body.operationId,targetId:id,appliedRevision:2,replayed:true};
 assert.equal((await changeCareerTarget(client(()=>({target:state({revision:3,reviewOn:null}),operation})),'edit',id,body)).target?.reviewOn,null);
});
