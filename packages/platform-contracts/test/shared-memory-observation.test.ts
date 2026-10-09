import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseSharedMemoryObservation} from '../src/shared-memory.ts';
const ownerId=randomUUID(),id=randomUUID(),operationId=randomUUID(),deletedAt='2026-10-09T00:00:00.000Z';
const removal=()=>({id,revision:2,deletedAt,undoUntil:'2026-10-09T00:00:10.000Z',deletionOperationId:operationId,purged:true});
const observation=()=>({ownerId,memory:null,removal:removal(),operation:{id:operationId,memoryId:id,action:'delete',appliedRevision:2,replayed:true}});
test('removed observation is closed, frozen and binds the deletion receipt without retaining content',()=>{
 const value=parseSharedMemoryObservation(observation());assert(Object.isFrozen(value));assert(Object.isFrozen(value.removal));assert(Object.isFrozen(value.operation));
 for(const patch of [{content:'Fictional deleted secret'},{revision:1},{undoUntil:deletedAt},{deletionOperationId:randomUUID()},{purged:'true'}])
  assert.throws(()=>parseSharedMemoryObservation({...observation(),removal:{...removal(),...patch}}));
 for(const patch of [{action:'create'},{appliedRevision:3},{memoryId:randomUUID()},{replayed:false}])
  assert.throws(()=>parseSharedMemoryObservation({...observation(),operation:{...observation().operation,...patch}}));
 assert.throws(()=>parseSharedMemoryObservation({...observation(),removal:null}));
 assert.throws(()=>parseSharedMemoryObservation({...observation(),extra:true}));
 let invoked=false;const accessor=observation();Object.defineProperty(accessor,'removal',{enumerable:true,get(){invoked=true;throw Error();}});
 assert.throws(()=>parseSharedMemoryObservation(accessor));assert.equal(invoked,false);
});
test('an earlier receipt may observe a later deletion, but cannot claim the deletion was its own revision',()=>{
 const value=observation();value.operation.action='create';value.operation.appliedRevision=1;value.operation.id=randomUUID();
 assert.equal(parseSharedMemoryObservation(value).removal?.revision,2);
 value.operation.appliedRevision=2;assert.throws(()=>parseSharedMemoryObservation(value));
});
