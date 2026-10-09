import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SharedMemoryController} from '../src/shared-memory-controller.ts';
import {readSharedMemoryPage,readSharedMemoryUses,changeSharedMemory,type SharedMemoryClient} from '../src/shared-memory-api.ts';
import {ApiError} from '../src/api-error.ts';
const owner=randomUUID(),id=randomUUID(),at='2026-10-09T00:00:00.000Z';
const command=()=>({operationId:randomUUID(),content:'Fictional preference',category:'communication',sensitivity:'normal',usePolicy:'normal',speakerScope:null,validUntil:null});
const memory=(patch:Record<string,unknown>={})=>({id,ownerId:owner,revision:1,kind:'memory',content:'Fictional preference',category:'communication',sensitivity:'normal',source:'user_saved',status:'confirmed',confidence:'high',usePolicy:'normal',speakerScope:null,quote:null,originConversationId:null,originMessageId:null,confirmedAt:at,validUntil:null,reviewDueAt:null,createdAt:at,updatedAt:at,deletedAt:null,undoUntil:null,deletionOperationId:null,lastOperationId:randomUUID(),...patch});
const page=(memories:unknown[]=[],nextCursor:string|null=null)=>({memories,hasMore:nextCursor!==null,nextCursor});
function receipt(body:any,patch:Record<string,unknown>={},replayed=false){return {memory:memory({revision:(body.expectedRevision??0)+1,lastOperationId:body.operationId,...patch}),operation:{id:body.operationId,appliedRevision:(body.expectedRevision??0)+1,replayed}};}
function harness(run:(path:string,init:RequestInit)=>unknown){
 let active=true;const subscribers=new Set<()=>void>();
 const client:SharedMemoryClient={account:{accountId:owner,generation:1},isCurrent:()=>active,subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn);},request:async(path,init={})=>await run(path,init) as any};
 return {client,controller:new SharedMemoryController(client,()=>{},40),invalidate(){active=false;for(const fn of [...subscribers])fn();}};
}
async function until(check:()=>boolean){for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert(check());}
async function ready(h:ReturnType<typeof harness>){h.controller.start();await until(()=>h.controller.snapshot().loaded&&!h.controller.snapshot().busy);}
test('lost acknowledgement survives rereads; only explicit retry reuses the original immutable command',async()=>{
 let saved:any,effects=0;const writes:any[]=[];
 const h=harness((_path,init)=>{if(!init.method)return page(saved?[saved.memory]:[]);const body=JSON.parse(String(init.body));writes.push(body);if(saved)return {...saved,operation:{...saved.operation,replayed:true}};effects++;saved=receipt(body);throw Error('Lost acknowledgement');});
 await ready(h);const input=command();assert(h.controller.begin('create',null,input));await until(()=>!h.controller.snapshot().busy);
 const pending=h.controller.snapshot().pending;assert(pending);assert(Object.isFrozen(pending.body));input.content='Changed later';
 await h.controller.refresh();assert.equal(h.controller.snapshot().pending,pending);assert.equal(h.controller.snapshot().settledOperationId,null);
 assert.equal(h.controller.begin('create',null,command()),false);assert.equal(writes.length,1);
 await h.controller.retry();assert.equal(effects,1);assert.deepEqual(writes[0],writes[1]);assert.equal(h.controller.snapshot().pending,null);h.controller.stop();
});
test('offline and hidden suspension remove private observations, resume only GETs, and late writes cannot change the new view',async()=>{
 let resolve!:(value:unknown)=>void,body:any,writes=0,latest=memory();
 const h=harness((_path,init)=>{if(!init.method)return page([latest]);writes++;body=JSON.parse(String(init.body));return new Promise(r=>resolve=r);});
 await ready(h);h.controller.begin('edit',id,{operationId:randomUUID(),expectedRevision:1,content:'Fictional edit'});
 const pending=h.controller.snapshot().pending;h.controller.suspend();assert.equal(h.controller.snapshot().loaded,false);assert.deepEqual(h.controller.snapshot().memories,[]);assert.deepEqual(h.controller.snapshot().uses,{});assert.equal(h.controller.snapshot().pending,pending);
 await h.controller.retry();await h.controller.refresh();assert.equal(writes,1);
 latest=memory({revision:3});h.controller.resume();await until(()=>h.controller.snapshot().loaded);
 resolve(receipt(body));await new Promise(r=>setTimeout(r,10));
 assert.equal(writes,1);assert.equal(h.controller.snapshot().memories[0].revision,3);assert.equal(h.controller.snapshot().pending,pending);h.controller.stop();
});
test('a non-cooperating write times out without discarding intent and a failed refresh cannot restore stale content',async()=>{
 let fail=false;const h=harness((_path,init)=>{if(init.method)return new Promise(()=>{});if(fail)throw Error('Offline');return page([memory()]);});
 await ready(h);h.controller.begin('edit',id,{operationId:randomUUID(),expectedRevision:1,content:'Fictional edit'});await until(()=>!h.controller.snapshot().busy);
 assert(h.controller.snapshot().pending);fail=true;await h.controller.refresh();assert.equal(h.controller.snapshot().loaded,false);assert.deepEqual(h.controller.snapshot().memories,[]);assert(h.controller.snapshot().pending);h.controller.stop();
});
test('initial suspension makes no request and account invalidation clears all state and ignores old responses',async()=>{
 let reads=0,resolve!:(value:unknown)=>void;
 const h=harness(()=>{reads++;return new Promise(r=>resolve=r);});h.controller.start(true);await h.controller.refresh();assert.equal(reads,0);
 h.controller.resume();h.invalidate();resolve(page([memory()]));await new Promise(r=>setTimeout(r,5));
 assert.equal(h.controller.snapshot().loaded,false);assert.deepEqual(h.controller.snapshot().memories,[]);assert.equal(h.controller.snapshot().pending,null);assert.equal(h.controller.snapshot().undo,null);
});
test('pagination merges current versions, and a failed next page clears stale observations and cursor',async()=>{
 let fail=false;
 const h=harness(path=>{if(path.includes('?cursor=')){if(fail)throw Error('Read failed');return page([memory({revision:2}),memory({id:randomUUID()})],'page-three');}return page([memory()],'page-two');});
 await ready(h);await h.controller.refresh(true);assert.equal(h.controller.snapshot().memories.length,2);assert.equal(h.controller.snapshot().memories[0].revision,2);
 fail=true;await h.controller.refresh(true);assert.deepEqual(h.controller.snapshot().memories,[]);assert.equal(h.controller.snapshot().nextCursor,null);assert.equal(h.controller.snapshot().loaded,false);h.controller.stop();
});
test('stale edits and conflicts require rereading, and actual deletion retains only bounded undo coordinates',async()=>{
 let writes=0,conflict=true;
 const h=harness((_path,init)=>{
  if(!init.method)return page([memory()]);
  writes++;if(conflict)throw new ApiError('Changed',409,'MEMORY_REVISION_CHANGED');
  const body=JSON.parse(String(init.body)),deletedAt=new Date().toISOString();
  return receipt(body,{deletedAt,undoUntil:new Date(Date.parse(deletedAt)+10000).toISOString(),deletionOperationId:body.operationId});
 });
 await ready(h);assert.equal(h.controller.begin('edit',id,{operationId:randomUUID(),expectedRevision:2,content:'Fictional edit'}),false);assert.equal(writes,0);
 h.controller.begin('edit',id,{operationId:randomUUID(),expectedRevision:1,content:'Fictional edit'});await until(()=>!h.controller.snapshot().busy);
 assert.equal(h.controller.snapshot().loaded,false);assert.equal(h.controller.snapshot().pending,null);
 conflict=false;await h.controller.refresh();h.controller.begin('delete',id,{operationId:randomUUID(),expectedRevision:1});await until(()=>!h.controller.snapshot().busy);
 assert.deepEqual(Object.keys(h.controller.snapshot().undo!).sort(),['deletionOperationId','id','revision','undoUntil']);
 assert.equal(h.controller.snapshot().memories.length,0);h.controller.suspend();assert(h.controller.snapshot().undo);h.controller.expireUndo();assert.equal(h.controller.snapshot().undo,null);h.controller.stop();
});
test('use observations cannot reappear after lifecycle suspension',async()=>{
 let resolve!:(value:unknown)=>void;
 const h=harness(path=>path.endsWith('/uses')?new Promise(r=>resolve=r):page([memory()]));
 await ready(h);const observing=h.controller.showUses(id);h.controller.suspend();resolve({memoryId:id,uses:[]});await observing;
 assert.deepEqual(h.controller.snapshot().uses,{});h.controller.resume();await until(()=>h.controller.snapshot().loaded);h.controller.stop();
});
test('all memory transports reject invalid accounts before sending and after empty or valid responses',async()=>{
 let calls=0;const h=harness(()=>{calls++;return page();});h.invalidate();
 await assert.rejects(readSharedMemoryPage(h.client));await assert.rejects(readSharedMemoryUses(h.client,id));await assert.rejects(changeSharedMemory(h.client,'create',null,command()));assert.equal(calls,0);
 for(const action of ['list','uses','change']){
  const body=command(),late=harness(()=>{late.invalidate();return action==='list'?page():action==='uses'?{memoryId:id,uses:[]}:receipt(body);});
  if(action==='list')await assert.rejects(readSharedMemoryPage(late.client));
  else if(action==='uses')await assert.rejects(readSharedMemoryUses(late.client,id));
  else await assert.rejects(changeSharedMemory(late.client,'create',null,body));
 }
});
