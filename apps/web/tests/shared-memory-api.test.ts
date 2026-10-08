import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { BoundPlatformClient } from '../src/api.ts';
import { readSharedMemoryPage,changeSharedMemory } from '../src/shared-memory-api.ts';
const owner=randomUUID(),id=randomUUID(),at='2026-10-08T00:00:00.000Z';
function state(patch:Record<string,unknown>={}){return {id,ownerId:owner,revision:1,kind:'memory',content:'Fictional transport-only preference',category:'goal_preference',sensitivity:'normal',source:'user_saved',status:'confirmed',confidence:'high',usePolicy:'normal',speakerScope:null,quote:null,originConversationId:null,originMessageId:null,confirmedAt:at,validUntil:null,reviewDueAt:null,createdAt:at,updatedAt:at,deletedAt:null,undoUntil:null,deletionOperationId:null,lastOperationId:randomUUID(),...patch};}
function client(run:(path:string,init:RequestInit)=>unknown):BoundPlatformClient{return {account:{accountId:owner,generation:1},isCurrent:()=>true,subscribe:()=>()=>{},request:async(path,init={})=>await run(path,init)} as BoundPlatformClient;}
const create=(op:string)=>({operationId:op,content:'Fictional transport-only preference',category:'goal_preference',sensitivity:'normal',usePolicy:'normal',speakerScope:null,validUntil:null});
test('owned transport validates actual paging shape and freezes copied records; foreign and deleted records fail',async()=>{
 const value=state();const page=await readSharedMemoryPage(client(()=>({memories:[value],hasMore:false,nextCursor:null})));
 assert.equal(page.memories[0].id,id);assert(Object.isFrozen(page.memories[0]));value.content='changed outside';assert.notEqual(page.memories[0].content,value.content);
 for(const result of [{memories:[state({ownerId:randomUUID()})],hasMore:false,nextCursor:null},{memories:[state(),state()],hasMore:false,nextCursor:null},{memories:[],hasMore:true,nextCursor:null}])await assert.rejects(readSharedMemoryPage(client(()=>result)));
});
test('create sends explicit metadata with stable operation; a foreign or wrong operation acknowledgement cannot be adopted',async()=>{
 const op=randomUUID(),body=create(op);let calls=0;
 const c=client((path,init)=>{calls++;assert.equal(path,'/memories');assert.equal(init.method,'POST');assert.equal(JSON.parse(String(init.body)).operationId,op);
 return {memory:state({lastOperationId:op}),operation:{id:op,appliedRevision:1,replayed:false}};});
 assert.equal((await changeSharedMemory(c,'create',null,body)).memory.id,id);assert.equal(calls,1);
 for(const result of [{memory:state({ownerId:randomUUID()}),operation:{id:op,appliedRevision:1,replayed:false}},{memory:state(),operation:{id:randomUUID(),appliedRevision:1,replayed:false}}])await assert.rejects(changeSharedMemory(client(()=>result),'create',null,body));
});
test('new HTTP confirmation uses editedContent and real expected revision; caller source fields never reach transport',async()=>{
 const op=randomUUID();const c=client((path,init)=>{assert.equal(path,'/memories/'+id+'/confirm');const body=JSON.parse(String(init.body));assert.equal(body.expectedRevision,0);assert.equal(body.editedContent,'Fictional corrected fact');assert(!Object.hasOwn(body,'content'));
 return {memory:state({lastOperationId:op}),operation:{id:op,appliedRevision:1,replayed:false}};});
 await changeSharedMemory(c,'confirm',id,{operationId:op,expectedRevision:0,category:'goal_preference',sensitivity:'normal',editedContent:'Fictional corrected fact'});
 let accessed=false;await assert.rejects(changeSharedMemory(client(()=>{accessed=true;return {};}),'create',null,{...create(randomUUID()),ownerId:owner}));assert.equal(accessed,false);
});
test('older successful replay can return genuinely newer state without pretending its earlier revision is current',async()=>{
 const op=randomUUID();const result=await changeSharedMemory(client(()=>({memory:state({revision:3}),operation:{id:op,appliedRevision:2,replayed:true}})),'edit',id,{operationId:op,expectedRevision:1,usePolicy:'only_if_user_raises'});
 assert.equal(result.memory.revision,3);assert.equal(result.operation.appliedRevision,2);
 await assert.rejects(changeSharedMemory(client(()=>({memory:state(),operation:{id:op,appliedRevision:2,replayed:true}})),'edit',id,{operationId:op,expectedRevision:1,usePolicy:'only_if_user_raises'}));
});
