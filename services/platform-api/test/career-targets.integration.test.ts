import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CareerTargets } from '../src/career-targets.ts';
import { ApiError } from '../src/errors.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,targets:CareerTargets;
before(async()=>{f=await createCompanionNameSafetyFixture();targets=new CareerTargets(f.db,f.config,FICTIONAL_LEGAL);});
after(async()=>{await f?.close();});
const create=(patch:Record<string,unknown>={})=>({operationId:randomUUID(),expectedRevision:0,roleFamily:'da',title:'Fictional Analytics Direction',locations:['Fictional City'],priority:1,...patch});
const error=(status:number)=>(e:unknown)=>e instanceof ApiError&&e.status===status;

test('real owner directions start exploring, change only through versioned owner actions, and physical forgetting prevents late create resurrection',async()=>{
 const who=await f.actor(),command=create(),first=await targets.mutate(who,'create',null,command);assert(first.target);const id=first.target.id;
 assert.equal(first.target.status,'exploring');assert.equal(first.target.revision,1);assert.equal(first.target.source,'user_entered');
 for(const [status,revision] of [['active',1],['paused',2],['dropped',3]] as const){const changed=await targets.mutate(who,'status',id,{operationId:randomUUID(),expectedRevision:revision,status});assert.equal(changed.target?.status,status);}
 const edited=await targets.mutate(who,'edit',id,{operationId:randomUUID(),expectedRevision:4,title:'Fictional Revised Direction',locations:[]});assert.equal(edited.target?.revision,5);
 const replay=await targets.mutate(who,'create',null,command);assert.equal(replay.operation.replayed,true);assert.equal(replay.operation.appliedRevision,1);assert.equal(replay.target?.revision,5);
 const raw=(await f.db.query('SELECT * FROM platform_career_targets WHERE id=$1',[id])).rows[0];assert(!raw.record_ciphertext.includes(Buffer.from('Fictional Revised Direction')));
 const deletion={operationId:randomUUID(),expectedRevision:5};assert.equal((await targets.mutate(who,'delete',id,deletion)).target,null);assert.equal((await targets.list(who)).targets.length,0);
 assert.equal((await targets.mutate(who,'delete',id,deletion)).operation.replayed,true);assert.equal((await targets.mutate(who,'create',null,command)).target,null);
 await assert.rejects(targets.get(who,id),error(404));assert.equal((await f.db.query('SELECT id FROM platform_career_targets WHERE user_id=$1',[who.userId])).rowCount,0);
 const receipts=(await f.db.query('SELECT * FROM platform_career_target_operations WHERE user_id=$1',[who.userId])).rows;assert.equal(receipts.length,6);
 for(const r of receipts){const text=f.crypto.openUtf8(r.receipt_ciphertext,{table:'platform_career_target_operations',column:'receipt_ciphertext',rowId:r.operation_id,ownerId:who.userId,revision:r.applied_revision});assert(!text.includes('Fictional'));}
});

test('foreign, revoked and staff sessions cannot read or mutate another real direction',async()=>{
 const who=await f.actor(),other=await f.actor(),staff=await f.actor(true),first=await targets.mutate(who,'create',null,create()),id=first.target!.id;
 await assert.rejects(targets.get(other,id),error(404));for(const action of ['edit','status','delete'] as const)await assert.rejects(targets.mutate(other,action,id,{operationId:randomUUID(),expectedRevision:1,...(action==='edit'?{title:'Fictional foreign'}:action==='status'?{status:'active'}:{})}),error(404));
 assert.equal((await targets.list(other)).targets.length,0);await assert.rejects(targets.get(staff,id),error(403));
 await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);await assert.rejects(targets.get(who,id),error(401));
});

test('concurrent actual edits accept only one revision; operation IDs cannot adopt another command',async()=>{
 const who=await f.actor(),saved=await targets.mutate(who,'create',null,create());const id=saved.target!.id;
 const results=await Promise.allSettled(['Fictional A','Fictional B'].map(title=>targets.mutate(who,'edit',id,{operationId:randomUUID(),expectedRevision:1,title})));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await targets.get(who,id)).revision,2);
 const command=create();await targets.mutate(who,'create',null,command);await assert.rejects(targets.mutate(who,'create',null,{...command,title:'Fictional conflicting reuse'}),error(409));
});

test('the latest immutable operation rejects an authentic older encrypted snapshot, and raw SQL metadata cannot invent an active target',async()=>{
 const who=await f.actor(),saved=await targets.mutate(who,'create',null,create()),id=saved.target!.id,old=(await f.db.query('SELECT * FROM platform_career_targets WHERE id=$1',[id])).rows[0];
 await targets.mutate(who,'status',id,{operationId:randomUUID(),expectedRevision:1,status:'active'});
 await f.db.query('UPDATE platform_career_targets SET revision=$2,status=$3,last_operation_id=$4,record_ciphertext=$5,updated_at=$6 WHERE id=$1',[id,old.revision,old.status,old.last_operation_id,old.record_ciphertext,old.updated_at]);await assert.rejects(targets.get(who,id),error(503));
 const other=await f.actor(),b=await targets.mutate(other,'create',null,create());await f.db.query("UPDATE platform_career_targets SET status='active' WHERE id=$1",[b.target!.id]);await assert.rejects(targets.list(other),error(503));
 await assert.rejects(f.db.query('DELETE FROM platform_career_target_operations WHERE user_id=$1',[who.userId]));
});

test('withdrawn legal/email admission preserves owner reads and forgetting, and cannot confirm a new active direction',async()=>{
 const who=await f.actor(),saved=await targets.mutate(who,'create',null,create()),id=saved.target!.id;
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 assert.equal((await targets.get(who,id)).id,id);await assert.rejects(targets.mutate(who,'status',id,{operationId:randomUUID(),expectedRevision:1,status:'active'}),error(403));
 await assert.rejects(targets.mutate(who,'create',null,create()),error(403));assert.equal((await targets.mutate(who,'delete',id,{operationId:randomUUID(),expectedRevision:1})).target,null);
});

test('a real late session reset rolls back target content and its new operation together',async()=>{
 const who=await f.actor(),command=create(),original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(run,options)=>original(async client=>{
  const query=client.query.bind(client);let reset=false;const guarded=new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{const result=await (query as any)(...args);if(!reset&&typeof args[0]==='string'&&args[0].startsWith('INSERT INTO platform_career_targets')){reset=true;await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);}return result;};return Reflect.get(target,key);}});return run(guarded);
 },options);
 try{await assert.rejects(targets.mutate(who,'create',null,command),error(401));}finally{f.db.withBoundedTransaction=original;}
 assert.equal((await f.db.query('SELECT id FROM platform_career_targets WHERE user_id=$1',[who.userId])).rowCount,0);assert.equal((await f.db.query('SELECT operation_id FROM platform_career_target_operations WHERE user_id=$1',[who.userId])).rowCount,0);
});

test('actual account deletion cascades encrypted direction data and immutable receipts',async()=>{
 const who=await f.actor();await targets.mutate(who,'create',null,create());await f.db.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);
 for(const table of ['platform_career_targets','platform_career_target_operations'])assert.equal((await f.db.query('SELECT user_id FROM '+table+' WHERE user_id=$1',[who.userId])).rowCount,0);
 await f.db.migrate();
});

test('the actual preparation index includes only owned current structured choices, excludes private text and withdrawn admission, and invents no profile or execution',async()=>{
 const who=await f.actor(),other=await f.actor(),saved=await targets.mutate(who,'create',null,create({title:'Fictional private freeform title',locations:['Fictional private place']})),id=saved.target!.id;
 const read=()=>f.db.withBoundedTransaction(c=>targets.readForPreparationInTransaction(c,who));
 const first=await read();assert.equal(first.length,1);assert.equal(first[0].id,id);assert.equal(first[0].revision,1);assert.equal(first[0].status,'exploring');assert(!JSON.stringify(first).includes('Fictional private'));assert(Object.isFrozen(first));
 assert.equal((await f.db.withBoundedTransaction(c=>targets.readForPreparationInTransaction(c,other))).length,0);
 await targets.mutate(who,'status',id,{operationId:randomUUID(),expectedRevision:1,status:'active'});assert.equal((await read())[0].revision,2);
 await targets.mutate(who,'status',id,{operationId:randomUUID(),expectedRevision:2,status:'paused'});assert.equal((await read()).length,0);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await assert.rejects(read(),error(403));assert.equal((await targets.get(who,id)).revision,3);
});


test('calendar review dates are encrypted, persisted across service reads, versioned and idempotent through clearing and removal',async()=>{
 const who=await f.actor(),command=create({reviewOn:'2028-02-29'}),created=await targets.mutate(who,'create',null,command),id=created.target!.id;
 assert.equal(created.target?.reviewOn,'2028-02-29');assert.equal((await new CareerTargets(f.db,f.config,FICTIONAL_LEGAL).get(who,id)).reviewOn,'2028-02-29');
 const raw=(await f.db.query('SELECT record_ciphertext FROM platform_career_targets WHERE id=$1',[id])).rows[0];assert(!raw.record_ciphertext.includes(Buffer.from('2028-02-29')));
 const before=await f.db.withBoundedTransaction(c=>targets.readForPreparationInTransaction(c,who));assert(!JSON.stringify(before).includes('2028-02-29'));
 await targets.mutate(who,'status',id,{operationId:randomUUID(),expectedRevision:1,status:'active'});assert.equal((await targets.get(who,id)).reviewOn,'2028-02-29');
 const edit={operationId:randomUUID(),expectedRevision:2,reviewOn:'2028-03-04'};
 const changed=await targets.mutate(who,'edit',id,edit);assert.equal(changed.target?.reviewOn,'2028-03-04');
 await assert.rejects(targets.mutate(who,'edit',id,{...edit,reviewOn:'2028-03-05'}),error(409));
 await assert.rejects(targets.mutate(who,'edit',id,{operationId:randomUUID(),expectedRevision:2,reviewOn:null}),error(409));
 await assert.rejects(targets.mutate(who,'edit',id,{operationId:randomUUID(),expectedRevision:3,reviewOn:'2027-02-29'}),error(400));
 const clear={operationId:randomUUID(),expectedRevision:3,reviewOn:null};await targets.mutate(who,'edit',id,clear);
 const replay=await targets.mutate(who,'edit',id,edit);assert.equal(replay.operation.replayed,true);assert.equal(replay.operation.appliedRevision,3);assert.equal(replay.target?.revision,4);assert.equal(replay.target?.reviewOn,null);
 assert.equal((await targets.list(who)).targets[0].reviewOn,null);
 await targets.mutate(who,'delete',id,{operationId:randomUUID(),expectedRevision:4});assert.equal((await targets.mutate(who,'create',null,command)).target,null);
 assert.equal((await targets.mutate(who,'edit',id,edit)).target,null);
 assert.equal((await f.db.query('SELECT count(*)::int count FROM platform_career_target_operations WHERE user_id=$1',[who.userId])).rows[0].count,5);
});

test('pre-field canonical ciphertext and original command receipts remain readable and replayable without inventing a review date',async()=>{
 const who=await f.actor(),command=create(),created=await targets.mutate(who,'create',null,command),id=created.target!.id;
 assert.equal(created.target?.reviewOn,null);
 // Recreate the exact pre-extension canonical encrypted payload. The existing create command/digest has no new field.
 const legacy={...created.target} as Record<string,unknown>;delete legacy.reviewOn;
 const canonical=JSON.stringify(legacy,(_key,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
 const seal=f.crypto.sealUtf8(canonical,{table:'platform_career_targets',column:'record_ciphertext',rowId:id,ownerId:who.userId,revision:1});
 await f.db.query('UPDATE platform_career_targets SET record_ciphertext=$2 WHERE id=$1',[id,seal]);
 assert(!Object.hasOwn(await targets.get(who,id),'reviewOn'));
 assert(!Object.hasOwn((await targets.list(who)).targets[0],'reviewOn'));
 const replay=await targets.mutate(who,'create',null,command);assert.equal(replay.operation.replayed,true);assert(!Object.hasOwn(replay.target!,'reviewOn'));
 // Omission and explicit clearing remain different commands, so old receipts cannot be silently reinterpreted.
 await assert.rejects(targets.mutate(who,'create',null,{...command,reviewOn:null}),error(409));
 const titleEdit=await targets.mutate(who,'edit',id,{operationId:randomUUID(),expectedRevision:1,title:'Fictional legacy edit'});assert(!Object.hasOwn(titleEdit.target!,'reviewOn'));
 const dated=await targets.mutate(who,'edit',id,{operationId:randomUUID(),expectedRevision:2,reviewOn:'2028-02-29'});assert.equal(dated.target?.reviewOn,'2028-02-29');
 assert.equal((await targets.mutate(who,'create',null,command)).target?.reviewOn,'2028-02-29');
});
