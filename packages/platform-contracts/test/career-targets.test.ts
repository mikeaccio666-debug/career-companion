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
