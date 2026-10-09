import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResumeReviewView } from '@companion/platform-contracts';
import { AccountCoreExport } from '../src/account-core-export.ts';
import { AccountReauthentication } from '../src/account-reauthentication.ts';
import { ResumeOriginalReview,RESUME_EXPORT_TABLES } from '../src/resume-original-review.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { hashPassword,type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';

let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string,review:ResumeOriginalReview,directory:string,storage:LocalBlobStorage;
const password='Fictional-resume-export-password';
before(async()=>{
 f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);
 directory=await mkdtemp(path.join(os.tmpdir(),'fictional-resume-export-'));storage=new LocalBlobStorage(directory);
 review=new ResumeOriginalReview(f.db,f.config,FICTIONAL_LEGAL,storage);
});
after(async()=>{await f?.close();if(directory)await rm(directory,{recursive:true,force:true});});
async function actor(){const a=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[a.userId,encoded]);return a;}
const body=(patch:Record<string,unknown>={})=>({operationId:randomUUID(),expectedRevision:0,track:'da',label:'Fictional private resume label',text:'虚构课程项目。Fictional original contribution. 🚀',...patch});
const command=(v:ResumeReviewView,patch:Record<string,unknown>={})=>({operationId:randomUUID(),expectedRevision:v.item.revision,payloadDigest:v.item.payloadDigest,...patch});
const create=async(a:FixedSessionContext,patch:Record<string,unknown>={})=>(await review.mutate(a,'create',null,body(patch),'web')).view!;
const change=async(a:FixedSessionContext,v:ResumeReviewView,action:'edit'|'approve'|'decline'|'reopen'|'archive',patch:Record<string,unknown>={})=>(await review.mutate(a,action,v.item.id,command(v,patch),'web')).view!;
const proof=async(a:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(a,{purpose:'account_export',password})).token;
const capture=async(a:FixedSessionContext,token?:string)=>new AccountCoreExport(f.db,f.config).capture(a,token??await proof(a));
const notConsumed=async(a:FixedSessionContext)=>assert.equal((await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export' LIMIT 1",[a.userId])).rows[0].consumed_at,null);
const storageError=(e:unknown)=>e instanceof ApiError&&e.code==='RESUME_REVIEW_UNAVAILABLE';

test('owner export preserves every original revision, decline, approval, archival and derived lineage with no foreign data or receipt secrets',async()=>{
 const a=await actor(),b=await actor(),foreign=await create(b,{text:'Fictional foreign private original'}),original=await create(a);
 let v=await change(a,original,'edit',{label:'Fictional edit',text:'Fictional corrected contribution. 核对来源。'});
 v=await change(a,v,'approve');v=await change(a,v,'archive');
 await change(a,await create(a,{text:'Fictional declined content.'}),'decline');
 const derived=await create(a,{derivedFromId:v.item.resumeVersionId,text:'Fictional derived content.'});
 const token=await proof(a),result=await capture(a,token),s=result.sections;
 assert.deepEqual((s.pendingItems as any[]).find(x=>x.id===v.item.id),v.item);
 assert.deepEqual((s.pendingItems as any[]).find(x=>x.id===derived.item.id),derived.item);
 const revisions=(s.pendingItemRevisions as any[]).filter(x=>x.itemId===v.item.id);
 assert.deepEqual(revisions.map(x=>x.revision),[1,2]);assert.equal(revisions[0].payload.text,original.payload.text);
 assert.equal(revisions[1].payload.text,v.payload.text);
 const decisions=(s.pendingItemDecisions as any[]).filter(x=>x.itemId===v.item.id);
 assert.deepEqual(decisions.map(x=>[x.revision,x.decision]),[[2,'approved']]);
 assert.equal(decisions[0].payloadDigest,v.item.approvedDigest);assert.equal(decisions[0].operationId,v.item.approvalOperationId);
 assert.equal(s.careerResumes.length,3);assert.equal(s.pendingItemOperations.length,7);assert.deepEqual(s.careerResumeCounters,[{track:'da',sequence:3}]);
 assert.equal((s.careerResumes as any[]).find(x=>x.id===v.item.resumeVersionId).status,'archived');
 assert.equal(result.includedTables.length,69);for(const table of Object.keys(RESUME_EXPORT_TABLES)){assert(result.includedTables.includes(table));assert(!result.remainingTables.includes(table));}
 assert(result.remainingTables.includes('platform_uploads'));assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);
 assert(Object.isFrozen(revisions[0].payload));const serialized=JSON.stringify(result);
 for(const secret of [b.userId,foreign.item.id,'Fictional foreign private original',a.tokenHash,token,password,encoded,'acceptedAuthVersion','requestDigest','recordDigest','record_ciphertext','receipt_ciphertext'])assert(!serialized.includes(secret));
});

test('uploaded originals preserve their real file and text fingerprints after edits without exposing storage keys or claiming to export file bytes',async()=>{
 const a=await actor(),bytes=Buffer.from('虚构原始文件。Fictional original file. 🚀'),id=randomUUID(),key=randomUUID();await storage.put(key,bytes);
 await f.db.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,$3,$4,$5,$6)',[id,a.userId,'Fictional original.txt','text/plain',bytes.length,key]);
 const original=(await review.createFromUpload(a,{operationId:randomUUID(),expectedRevision:0,track:'da',label:'Fictional uploaded original',uploadId:id})).view!;
 const edited=await change(a,original,'edit',{label:'Fictional edited upload',text:'Fictional corrected uploaded content.'});
 const result=await capture(a),s=result.sections,first=(s.pendingItemRevisions as any[])[0];
 assert.equal(first.payload.text,bytes.toString());assert.equal((s.pendingItemRevisions as any[])[1].payload.text,edited.payload.text);
 assert.deepEqual((s.pendingItems as any[])[0].uploadSource,original.item.uploadSource);
 assert.equal(first.payload.source_refs[1].sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal((s.careerResumes as any[])[0].uploadId,id);assert(!JSON.stringify(result).includes(key));assert.equal(result.filesIncluded,false);
});

test('physical forgetting removes every original body and decision but retains only operation metadata and monotonic counters',async()=>{
 const a=await actor(),v=await change(a,await create(a),'approve');await review.mutate(a,'delete',v.item.id,command(v),'web');
 const {sections:s}=await capture(a);
 for(const section of ['pendingItems','pendingItemRevisions','pendingItemDecisions','careerResumes'] as const)assert.deepEqual(s[section],[]);
 assert.equal(s.pendingItemOperations.length,3);assert((s.pendingItemOperations as any[]).some(x=>x.action==='delete'));
 assert.deepEqual(s.careerResumeCounters,[{track:'da',sequence:1}]);assert(!JSON.stringify(s).includes(v.payload.text));assert(!JSON.stringify(s).includes(v.item.label));
});

test('all item, revision, decision and operation pages are included beyond their first 100 rows',async()=>{
 const a=await actor();let v=await create(a),decisions=0;
 for(let i=0;i<101;i++)v=await change(a,v,'edit',{label:'Fictional history '+i,text:'Fictional edited original '+i});
 v=await change(a,v,'approve');decisions++;
 const ids=[v.item.id];for(let i=0;i<101;i++){const next=await create(a,{text:'Fictional page original '+i});ids.push(next.item.id);await change(a,next,'approve');decisions++;}
 const result=await capture(a),s=result.sections;
 assert.equal(s.pendingItems.length,102);assert.equal(s.careerResumes.length,102);
 assert.deepEqual((s.pendingItems as any[]).map(x=>x.id).sort(),ids.sort());
 assert.equal(s.pendingItemRevisions.length,203);assert.equal(s.pendingItemDecisions.length,decisions);
 assert.deepEqual((s.pendingItemRevisions as any[]).filter(x=>x.itemId===v.item.id).map(x=>x.revision),Array.from({length:102},(_,i)=>i+1));
 assert.equal(s.pendingItemOperations.length,305);assert.deepEqual(s.careerResumeCounters,[{track:'da',sequence:102}]);
});

async function replaceImmutable(table:string,trigger:string,sql:string,args:unknown[]){
 await f.db.withBoundedTransaction(async client=>{
  // Isolated fixture corruption only, restored before export. No production trigger changes.
  await client.query('ALTER TABLE '+table+' DISABLE TRIGGER '+trigger);await client.query(sql,args);
  await client.query('ALTER TABLE '+table+' ENABLE TRIGGER '+trigger);
 });
}
test('a damaged intermediate original cannot be skipped just because the current and first revisions still authenticate',async()=>{
 const a=await actor();let v=await create(a);
 v=await change(a,v,'edit',{label:'Fictional middle',text:'Fictional middle history'});
 v=await change(a,v,'edit',{label:'Fictional current',text:'Fictional current history'});
 const cipher=(await f.db.query('SELECT ciphertext FROM platform_pending_item_revisions WHERE item_id=$1 AND revision=2',[v.item.id])).rows[0].ciphertext,broken=Buffer.from(cipher);broken[broken.length-1]^=1;
 const token=await proof(a),sql='UPDATE platform_pending_item_revisions SET ciphertext=$2 WHERE item_id=$1 AND revision=2';
 await replaceImmutable('platform_pending_item_revisions','pending_revision_immutable',sql,[v.item.id,broken]);
 try{await assert.rejects(capture(a,token),storageError);await notConsumed(a);}
 finally{await replaceImmutable('platform_pending_item_revisions','pending_revision_immutable',sql,[v.item.id,cipher]);}
 assert.equal((await capture(a,token)).sections.pendingItemRevisions.length,3);
});

test('historical decisions must bind the exact revision even when two revisions have identical content digests',async()=>{
 const a=await actor();let v=await create(a);v=await change(a,v,'edit',{label:'Fictional relabel',text:v.payload.text});v=await change(a,v,'decline');
 assert.equal(v.item.revision,2);const token=await proof(a),sql='UPDATE platform_pending_item_decisions SET revision=$2 WHERE user_id=$1 AND decision=\'declined\'';
 await replaceImmutable('platform_pending_item_decisions','pending_decision_immutable',sql,[a.userId,1]);
 try{await assert.rejects(capture(a,token),storageError);await notConsumed(a);}
 finally{await replaceImmutable('platform_pending_item_decisions','pending_decision_immutable',sql,[a.userId,2]);}
 assert.equal((await capture(a,token)).sections.pendingItemDecisions.length,1);
});

test('private reads survive admission withdrawal and do not expire an overdue pending draft or create operations',async()=>{
 const a=await actor(),original=f.db.withBoundedTransaction.bind(f.db);let v:ResumeReviewView;
 f.db.withBoundedTransaction=async(run,options)=>original(async client=>{
  const query=client.query.bind(client),guarded=new Proxy(client,{get(target,key){if(key==='query')return (...args:any[])=>{
   if(args[0]==='SELECT clock_timestamp() at')args[0]="SELECT (clock_timestamp()-interval '8 days') AS at";
   return (query as any)(...args);
  };return Reflect.get(target,key);}});return run(guarded);
 },options);
 try{v=await create(a);}finally{f.db.withBoundedTransaction=original;}
 assert(v!.item.expiresAt<new Date().toISOString());
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[a.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[a.userId]);
 const result=await capture(a);assert.deepEqual(result.sections.pendingItems,[v!.item]);assert.equal(result.sections.pendingItemOperations.length,1);
 const saved=(await f.db.query('SELECT status,generation FROM platform_pending_items WHERE id=$1',[v!.item.id])).rows[0];assert.deepEqual(saved,{status:'pending',generation:1});
});

test('relocated historical operation ciphertext and regressed sequence counters abort the whole capture',async()=>{
 const a=await actor(),v=await create(a),token=await proof(a);
 await f.db.query('UPDATE platform_career_resume_counters SET sequence=2 WHERE user_id=$1',[a.userId]);
 const next=await create(a);assert.equal(next.item.sequence,3);
 await f.db.query('UPDATE platform_career_resume_counters SET sequence=1 WHERE user_id=$1',[a.userId]);
 await assert.rejects(capture(a,token),storageError);await notConsumed(a);
 await f.db.query('UPDATE platform_career_resume_counters SET sequence=3 WHERE user_id=$1',[a.userId]);
 const row=(await f.db.query('SELECT * FROM platform_pending_item_operations WHERE user_id=$1 AND operation_id=$2',[a.userId,v.item.lastOperationId])).rows[0];
 await f.db.query("INSERT INTO platform_pending_item_operations(user_id,operation_id,item_id,action,generation,created_at,receipt_ciphertext) VALUES($1,$2,$3,'delete',1,$4,$5)",[a.userId,randomUUID(),randomUUID(),row.created_at,row.receipt_ciphertext]);
 await assert.rejects(capture(a,token),storageError);await notConsumed(a);
});
