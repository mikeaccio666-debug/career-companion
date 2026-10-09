import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {NAME_SOURCE_EXPORT_TABLES} from '../src/account-name-source-export.ts';
import {prebirthDetector} from './fixtures/companion-prebirth.ts';
import {fixture,ready,proof,capture,submit,classify,apply,instrument,unused,snapshot,named,reads,password,encoded,failure} from './fixtures/account-name-source-export.ts';

test('exact raw inputs and applied, rejected, superseded, running and failed outcomes remain distinct owner-private history',async()=>fixture(async(f,runtime,calls)=>{
 const p=await named(f,runtime),first=p.submission.submissionId;
 const rejected=await submit(p,'伙伴甲');await classify(f,p,runtime,rejected.submissionId);await apply(p,rejected.submissionId);
 const superseded=await submit(p,'墨'),next=await submit(p,'舟');await classify(f,p,runtime,superseded.submissionId);await apply(p,superseded.submissionId);await classify(f,p,runtime,next.submissionId);await apply(p,next.submissionId);
 const raw='\n<fictional>\u0000 raw input '+ '虚构'.repeat(50),pending=await submit(p,raw);
 const claim=await p.safety.claimSubmission(p.who,{taskId:p.prepared.taskId,submissionId:pending.submissionId,detectorRevision:prebirthDetector.revision});assert(claim);await p.safety.fail(claim,'timeout');
 const running=await submit(p,''),live=await p.safety.claimSubmission(p.who,{taskId:p.prepared.taskId,submissionId:running.submissionId,detectorRevision:prebirthDetector.revision});assert(live);
 const other=await named(f,runtime),before=await snapshot(f,p.who),n=calls.length,queries:string[]=[],token=await proof(f,p.who);
 const data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(p.who,token),rows=new Map((data.sections.companionNameSubmissions as any[]).map(r=>[r.id,r]));
 assert.equal(rows.size,6);assert.equal(rows.get(first).request.name,' Juno ');assert.equal(rows.get(first).identityCapture.name,'Juno');
 assert.equal(rows.get(rejected.submissionId).application.status,'name_rejected');assert.equal(rows.get(rejected.submissionId).application.rejectedCategory,'family_or_partner');
 assert.equal(rows.get(superseded.submissionId).application.status,'superseded');assert.equal(rows.get(next.submissionId).identityCapture.name,'舟');
 assert.equal(rows.get(pending.submissionId).request.name,raw);assert.equal(rows.get(pending.submissionId).failure,'timeout');assert.equal(rows.get(pending.submissionId).result,null);
 assert.equal(rows.get(running.submissionId).status,'running');assert.equal(rows.get(running.submissionId).application.status,'pending');
 assert.equal(data.sections.companionNameIdentityReceipts.length,2);assert.equal(data.sections.companionNameIdentityProvenance.length,2);
 assert.equal((data.sections.companionNameIdentityProvenance as any[]).filter(r=>r.currentForIdentity).length,1);
 assert.equal(data.includedTables.length,142);assert.equal(data.remainingTables.length,23);assert.equal(data.complete,false);
 const json=JSON.stringify(data);for(const secret of [other.who.userId,other.submission.submissionId,p.who.tokenHash,claim.leaseToken,live.leaseToken,token,password,encoded,'claim_ciphertext','leaseToken','executionToken','submittedSessionHash'])assert(!json.includes(secret),secret);
 assert(Object.isFrozen(rows.get(first).request));assert.equal(calls.length,n);assert.deepEqual(await snapshot(f,p.who),before);
 assert(!queries.filter(sql=>/FROM platform_companion_name_/.test(sql)).some(sql=>/FOR (UPDATE|SHARE|NO KEY UPDATE)/.test(sql)));
}));

test('empty or never-classified sources manufacture no completion, and private history survives current policy and consent changes',async()=>fixture(async(f,runtime,calls)=>{
 const p=await ready(f,runtime);let data=await capture(f,p.who);for(const key of ['companionNameEntries','companionNameSubmissions','companionNameIdentityReceipts','companionNameIdentityProvenance'] as const)assert.deepEqual(data.sections[key],[]);
 await submit(p,'');data=await capture(f,p.who);assert.equal((data.sections.companionNameSubmissions[0] as any).generation,0);assert.deepEqual(data.sections.companionNameIdentityReceipts,[]);
 const before=data.sections.companionNameSubmissions,n=calls.length;await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL,name=$2 WHERE id=$1',[p.who.userId,'Changed synthetic name']);await f.db.query('DELETE FROM platform_companion_identity_policy');await f.db.query('DELETE FROM platform_safety_detector_policy');
 assert.deepEqual((await capture(f,p.who)).sections.companionNameSubmissions,before);assert.equal(calls.length,n);
}));

test('non-L0 detected source exports real decision and usage without creating an adopted name',async()=>fixture(async(f,runtime)=>{
 const p=await ready(f,runtime),s=await submit(p,'Fictional prebirth high marker');await classify(f,p,runtime,s.submissionId);await apply(p,s.submissionId);
 const data=await capture(f,p.who),row=data.sections.companionNameSubmissions[0] as any;assert.equal(row.level,'L2');assert.equal(row.application.status,'not_eligible');assert.equal(row.identityCapture,null);assert.equal(row.detectorMode,'keyword_only');assert.equal(row.result.modelUsage,null);assert.deepEqual(data.sections.companionNameIdentityReceipts,[]);
},'L2'));


test('every sealed naming column rejects damaged and cross-owner bytes and preserves the retry proof',async()=>fixture(async(f,runtime)=>{
 const p=await named(f,runtime),other=await named(f,runtime),token=await proof(f,p.who);
 for(const [table,column] of [
  ['platform_companion_name_entries','payload_ciphertext'],
  ...['request_ciphertext','claim_ciphertext','result_ciphertext','application_ciphertext'].map(c=>['platform_companion_name_submissions',c]),
  ['platform_companion_name_identity_receipts','payload_ciphertext'],['platform_companion_name_identity_provenance','payload_ciphertext'],
 ]){
  const foreign=(await f.db.query(`SELECT ${column} FROM ${table} WHERE user_id=$1`,[other.who.userId])).rows[0][column];
  for(const swap of [false,true]){let reached=false;const db=instrument(f,(sql,rows)=>{if(reads(sql,table)&&rows.length){reached=true;const bytes=Buffer.from(rows[0][column]);bytes[bytes.length-1]^=1;rows[0][column]=swap?foreign:bytes;}});
   await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached);await unused(f,p.who);
  }
 }assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionNameSubmissions.length,1);
}));

test('missing relations, duplicate records and authenticated earlier entry cannot truncate original naming history',async()=>fixture(async(f,runtime)=>{
 const p=await named(f,runtime),old=(await f.db.query('SELECT * FROM platform_companion_name_entries WHERE user_id=$1',[p.who.userId])).rows[0],next=await submit(p,'舟');await classify(f,p,runtime,next.submissionId);await apply(p,next.submissionId);const token=await proof(f,p.who);
 for(const table of NAME_SOURCE_EXPORT_TABLES)for(const duplicate of [false,true]){let reached=false;
  const db=instrument(f,(sql,rows)=>{if(reads(sql,table)&&rows.length){reached=true;if(duplicate)rows.push({...rows[0]});else rows.splice(0,1);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached);await unused(f,p.who);
 }
 const db=instrument(f,(sql,rows)=>{if(reads(sql,'platform_companion_name_entries'))rows[0]={...old};});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);await unused(f,p.who);
}));

test('original preview, completed usage and applied identity remain required even when source ciphertext is authentic',async()=>fixture(async(f,runtime)=>{
 const p=await named(f,runtime),token=await proof(f,p.who);
 for(const fault of ['preview','usage','receipt_revision','identity_snapshot']){let reached=false;
  const db=instrument(f,(sql,rows)=>{
   if(fault==='usage'&&sql.includes("FROM platform_safety_model_usage WHERE source_kind='companion_name'")){reached=true;rows.splice(0);}
   if(fault==='receipt_revision'&&reads(sql,'platform_companion_name_identity_receipts')){reached=true;rows[0].identity_revision++;}
   if((fault==='preview'||fault==='identity_snapshot')&&reads(sql,'platform_companion_name_submissions')){
    reached=true;const row=rows[0],column=fault==='preview'?'request_ciphertext':'application_ciphertext',context={table:'platform_companion_name_submissions',column,rowId:row.id,ownerId:p.who.userId,revision:fault==='preview'?1:row.generation},value=JSON.parse(f.crypto.openUtf8(row[column],context));
    if(fault==='preview')value.previewCapture.preview.summary='Changed fictional original preview';else value.identityCapture.name='舟';
    row[column]=f.crypto.sealUtf8(JSON.stringify(value),context);
   }
  });
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),failure);assert(reached);await unused(f,p.who);
 }
}));


test('late session invalidation, cancellation and archive limits return no partial data or consumed proof',async()=>fixture(async(f,runtime)=>{
 const p=await named(f,runtime);
 for(const fault of ['auth','cancel','size']){const token=await proof(f,p.who),abort=new AbortController();let reached=false;
  const db=instrument(f,async(sql,rows,client)=>{if(reads(sql,'platform_companion_name_identity_provenance')&&rows.length&&!reached){reached=true;if(fault==='cancel')abort.abort();if(fault==='auth')await client.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[p.who.userId]);}});
  await assert.rejects(new AccountCoreExport(db,f.config,fault==='size'?{maxBytes:1024}:{}).capture(p.who,token,abort.signal),{code:fault==='auth'?'AUTH_REQUIRED':fault==='cancel'?'ACCOUNT_EXPORT_CANCELLED':'ACCOUNT_EXPORT_TOO_LARGE'});
  if(fault!=='size')assert(reached);await unused(f,p.who);
 }
 assert.equal((await capture(f,p.who)).sections.companionNameIdentityReceipts.length,1);
}));
