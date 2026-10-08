import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCareerTargetCommand,parseCareerTarget } from '../src/career-targets.ts';
const body=()=>({operationId:randomUUID(),expectedRevision:0,roleFamily:'swe',title:'Fictional Backend Direction',locations:[],priority:1});
test('owner command cannot supply an active/proposed status, author, source or confirmation',()=>{
 for(const extra of [{status:'active'},{status:'proposed'},{proposedBy:'expert:guide'},{ownerId:randomUUID()},{source:'model'},{revision:1}])assert.throws(()=>parseCareerTargetCommand('create',{...body(),...extra}));
 for(const change of [{title:''},{locations:new Array(1)},{priority:0},{expectedRevision:1},{title:'x'.repeat(121)}])assert.throws(()=>parseCareerTargetCommand('create',{...body(),...change}));
 let read=false;assert.throws(()=>parseCareerTargetCommand('create',{...body(),get title(){read=true;return 'Fictional';}}));assert.equal(read,false);
});
test('actual DTO parser copies nested fields and cannot accept fake expert proposals or versions',()=>{
 const data={...body(),id:randomUUID(),ownerId:randomUUID(),status:'exploring',source:'user_entered',proposedBy:null,revision:1,createdAt:'2026-10-08T00:00:00.000Z',updatedAt:'2026-10-08T00:00:00.000Z',lastOperationId:randomUUID()} as Record<string,unknown>;delete data.operationId;delete data.expectedRevision;
 const parsed=parseCareerTarget(data);assert(Object.isFrozen(parsed));assert(Object.isFrozen(parsed.locations));assert.throws(()=>parseCareerTarget({...data,status:'proposed'}));assert.throws(()=>parseCareerTarget({...data,revision:0}));
});


test('review dates are exact calendar values, explicit clearing is distinct from legacy omission',()=>{
 const old=body();assert(!Object.hasOwn(parseCareerTargetCommand('create',old),'reviewOn'));
 for(const reviewOn of [null,'2028-02-29','2000-02-29','0001-01-01','9999-12-31']){
  assert.equal(parseCareerTargetCommand('create',{...old,reviewOn}).reviewOn,reviewOn);
  assert.equal(parseCareerTargetCommand('edit',{operationId:randomUUID(),expectedRevision:1,reviewOn}).reviewOn,reviewOn);
 }
 for(const reviewOn of [undefined,'','2027-02-29','1900-02-29','2100-02-29','2026-04-31','2026-13-01','2026-01-00','0000-01-01','2026-1-01',' 2026-01-01','2026-01-01T00:00:00.000Z',123,{}]){
  assert.throws(()=>parseCareerTargetCommand('create',{...old,reviewOn}));
  assert.throws(()=>parseCareerTargetCommand('edit',{operationId:randomUUID(),expectedRevision:1,reviewOn}));
 }
 for(const action of ['status','delete'] as const)assert.throws(()=>parseCareerTargetCommand(action,{operationId:randomUUID(),expectedRevision:1,reviewOn:null,...(action==='status'?{status:'active'}:{})}));
 const data={id:randomUUID(),ownerId:randomUUID(),roleFamily:'da',title:'Fictional',locations:[],priority:1,status:'exploring',source:'user_entered',proposedBy:null,revision:1,createdAt:'2026-10-08T00:00:00.000Z',updatedAt:'2026-10-08T00:00:00.000Z',lastOperationId:randomUUID()};
 assert(!Object.hasOwn(parseCareerTarget(data),'reviewOn'));
 assert.equal(parseCareerTarget({...data,reviewOn:null}).reviewOn,null);
 assert.equal(parseCareerTarget({...data,reviewOn:'2028-02-29'}).reviewOn,'2028-02-29');
 assert.throws(()=>parseCareerTarget({...data,reviewOn:'2027-02-29'}));
});
