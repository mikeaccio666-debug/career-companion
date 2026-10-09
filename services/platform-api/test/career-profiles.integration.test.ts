import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CareerProfiles} from '../src/career-profiles.ts';
import {CareerTargets} from '../src/career-targets.ts';
import {CareerStories} from '../src/career-stories.ts';
import {CareerPreparationSources} from '../src/career-preparation-sources.ts';
import {ApiError} from '../src/errors.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,profiles:CareerProfiles,sources:CareerPreparationSources;
before(async()=>{f=await createCompanionNameSafetyFixture();profiles=new CareerProfiles(f.db,f.config,FICTIONAL_LEGAL);sources=new CareerPreparationSources(f.db,new CareerTargets(f.db,f.config,FICTIONAL_LEGAL),new CareerStories(f.db,f.config,FICTIONAL_LEGAL),undefined,undefined,undefined,profiles);});
after(async()=>{await f?.close();});
const facts={degreeField:'ds_statistics',graduationMonth:'2028-05',graduated:false,targetTracks:['da','ds']};
const save=(expectedRevision=0,patch:Record<string,unknown>={})=>({operationId:randomUUID(),expectedRevision,confirmed:true,facts:{...facts,...patch}});
const del=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
const error=(status:number)=>(e:unknown)=>e instanceof ApiError&&e.status===status;
test('owner confirmation persists across service restarts; edits, deletion and recreation have monotonic revisions and old retries never resurrect',async()=>{
 const who=await f.actor(),command=save();assert.deepEqual(await profiles.get(who),{ownerId:who.userId,revision:0,profile:null});
 const first=await profiles.mutate(who,'save',command);assert.equal(first.profile?.revision,1);assert.equal(first.profile?.source,'user_entered');
 assert.deepEqual(await new CareerProfiles(f.db,f.config,FICTIONAL_LEGAL).get(who),{ownerId:who.userId,revision:1,profile:first.profile});
 const edit=save(1,{graduated:true});await profiles.mutate(who,'save',edit);const deletion=del(2);await profiles.mutate(who,'delete',deletion);
 assert.equal((await profiles.mutate(who,'save',command)).profile,null);assert.equal((await profiles.get(who)).revision,3);
 assert.equal((await f.db.query('SELECT * FROM platform_career_profiles WHERE user_id=$1',[who.userId])).rowCount,0);
 await assert.rejects(profiles.mutate(who,'save',save(0)),error(409));await profiles.mutate(who,'save',save(3));
 const oldDelete=await profiles.mutate(who,'delete',deletion);assert.equal(oldDelete.operation.appliedRevision,3);assert.equal(oldDelete.revision,4);assert(oldDelete.profile);
 const observed=await profiles.observe(who,command.operationId);assert.equal(observed.operation.appliedRevision,1);assert.equal(observed.revision,4);
 const raw=(await f.db.query('SELECT * FROM platform_career_profiles WHERE user_id=$1',[who.userId])).rows[0];assert(!raw.record_ciphertext.includes(Buffer.from(facts.graduationMonth)));
 for(const row of (await f.db.query('SELECT * FROM platform_career_profile_operations WHERE user_id=$1',[who.userId])).rows){
  const body=f.crypto.openUtf8(row.receipt_ciphertext,{table:'platform_career_profile_operations',column:'receipt_ciphertext',rowId:row.operation_id,ownerId:who.userId,revision:row.applied_revision});
  assert(!body.includes('degreeField'));assert(!body.includes('2028-05'));
 }
});
test('concurrent edits cannot overwrite each other; changed command under the same operation is rejected',async()=>{
 const who=await f.actor(),command=save();await profiles.mutate(who,'save',command);
 const results=await Promise.allSettled([save(1,{graduated:true}),save(1,{targetTracks:['swe']})].map(c=>profiles.mutate(who,'save',c)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await profiles.get(who)).revision,2);
 await assert.rejects(profiles.mutate(who,'save',{...command,facts:{...facts,graduated:true}}),error(409));
});
test('foreign and staff sessions, stale auth, withdrawn admission and cancellation preserve owner boundaries',async()=>{
 const who=await f.actor(),other=await f.actor(),staff=await f.actor(true),command=save();await profiles.mutate(who,'save',command);
 assert.equal((await profiles.get(other)).profile,null);await assert.rejects(profiles.observe(other,command.operationId),error(404));
 await assert.rejects(profiles.get(staff),error(403));
 const aborted=new AbortController();aborted.abort();await assert.rejects(profiles.mutate(other,'save',save(),aborted.signal));assert.equal((await profiles.get(other)).revision,0);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 assert.equal((await profiles.get(who)).revision,1);await assert.rejects(profiles.mutate(who,'save',save(1)),error(403));await assert.rejects(sources.read(who),error(403));
 assert.equal((await profiles.observe(who,command.operationId)).revision,1);await profiles.mutate(who,'delete',del(1));
 await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);await assert.rejects(profiles.get(who),error(401));
});
test('actual profile references require known facts; edits and deletion invalidate frozen expert source coordinates without granting tools',async()=>{
 const who=await f.actor();let index=await sources.read(who);assert.deepEqual(index.profileSource,{available:true,profile:null});
 const empty=save(0,{degreeField:null,graduationMonth:null,graduated:null,targetTracks:[]});await profiles.mutate(who,'save',empty);
 let prepared=await sources.prepare(who,{skillId:'resume-revision'});assert.equal(prepared.built.context.profileRevision,1);
 assert(!prepared.built.context.inputs.some(i=>i.input==='confirmed-profile'));assert.deepEqual(prepared.built.context.tools,{});
 await profiles.mutate(who,'save',save(1));prepared=await sources.prepare(who,{skillId:'resume-revision'});
 const ref=prepared.built.context.inputs.find(i=>i.input==='confirmed-profile');assert.equal(ref?.id,who.userId);assert.equal(ref?.revision,2);assert.deepEqual(prepared.built.context.tools,{});
 await assert.rejects(f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,who,{ownerId:who.userId,indexId:index.indexId})),error(409));
 index=await sources.read(who);await profiles.mutate(who,'delete',del(2));
 await assert.rejects(f.db.withBoundedTransaction(c=>sources.assertCurrentInTransaction(c,who,{ownerId:who.userId,indexId:index.indexId})),error(409));
 assert.equal((await sources.prepare(who,{skillId:'resume-revision'})).built.context.profileRevision,0);
});
test('rollback, unexplained disappearance and validly encrypted alteration cannot forge current confirmed facts',async()=>{
 for(const corrupt of ['rollback','disappear','alter']){
  const who=await f.actor(),command=save();await profiles.mutate(who,'save',command);
  const old=(await f.db.query('SELECT * FROM platform_career_profiles WHERE user_id=$1',[who.userId])).rows[0];const newer=await profiles.mutate(who,'save',save(1,{graduated:true}));
  if(corrupt==='rollback')await f.db.query('UPDATE platform_career_profiles SET revision=$2,last_operation_id=$3,record_ciphertext=$4,created_at=$5,updated_at=$6 WHERE user_id=$1',[who.userId,old.revision,old.last_operation_id,old.record_ciphertext,old.created_at,old.updated_at]);
  else if(corrupt==='disappear')await f.db.query('DELETE FROM platform_career_profiles WHERE user_id=$1',[who.userId]);
  else{
   const body=JSON.stringify({...newer.profile,graduationMonth:'2029-12'},(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
   const bytes=f.crypto.sealUtf8(body,{table:'platform_career_profiles',column:'record_ciphertext',rowId:who.userId,ownerId:who.userId,revision:2});
   await f.db.query('UPDATE platform_career_profiles SET record_ciphertext=$2 WHERE user_id=$1',[who.userId,bytes]);
  }
  await assert.rejects(profiles.get(who),error(503));await assert.rejects(profiles.observe(who,command.operationId),error(503));await assert.rejects(sources.read(who),error(503));
  await assert.rejects(f.db.query('DELETE FROM platform_career_profile_operations WHERE user_id=$1',[who.userId]));
 }
});
test('session reset at the write boundary rolls back both profile and receipt',async()=>{
 const who=await f.actor(),original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(run,options)=>original(async client=>{
  const query=client.query.bind(client);let reset=false;const guarded=new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{const result=await(query as any)(...args);if(!reset&&typeof args[0]==='string'&&args[0].startsWith('INSERT INTO platform_career_profiles')){reset=true;await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);}return result;};return Reflect.get(target,key);}});return run(guarded);
 },options);
 try{await assert.rejects(profiles.mutate(who,'save',save()),error(401));}finally{f.db.withBoundedTransaction=original;}
 for(const table of ['platform_career_profiles','platform_career_profile_operations'])assert.equal((await f.db.query('SELECT user_id FROM '+table+' WHERE user_id=$1',[who.userId])).rowCount,0);
});
test('export returns owned facts and sanitized receipts; deletion removes content, account removal cascades all rows, migrations repeat',async()=>{
 const who=await f.actor(),other=await f.actor();await profiles.mutate(who,'save',save());await profiles.mutate(other,'save',save());
 const exported=()=>f.db.withBoundedTransaction(async c=>{const rows=[];for await(const row of profiles.exportInTransaction(c,who))rows.push(row);return rows;});
 let rows=await exported();assert.equal(rows.length,2);assert.equal(rows[0].section,'careerProfile');assert(!JSON.stringify(rows).includes('acceptedAuthVersion'));assert(!JSON.stringify(rows).includes(other.userId));
 await profiles.mutate(who,'delete',del(1));rows=await exported();assert(rows.every(r=>r.section==='careerProfileOperations'));assert(!JSON.stringify(rows).includes('2028-05'));
 await profiles.mutate(who,'save',save(2));await f.db.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);
 for(const table of ['platform_career_profiles','platform_career_profile_operations'])assert.equal((await f.db.query('SELECT user_id FROM '+table+' WHERE user_id=$1',[who.userId])).rowCount,0);
 await f.db.migrate();
});
