import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountPrebirthDispatchExport,PREBIRTH_DISPATCH_EXPORT_TABLES as tables} from '../src/account-prebirth-dispatch-export.ts';
import {readNameDispatchInTransaction,recordNameDispatchStage} from '../src/companion-name-dispatch-protocol.ts';
import {syncPrebirthInventoryInTransaction} from '../src/companion-prebirth-protocol.ts';
import {insertSession,tokenHash} from '../src/auth.ts';
import {withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {createNamingDispatchFixture,dispatchBytes,killedUnstartedClaim,waitTrueLeaseExpiry,type NamingDispatchFixture} from './fixtures/companion-name-dispatch.ts';
import {proof,capture,instrument,unused,password,encoded,fixture} from './fixtures/account-name-source-export.ts';
const failure={code:'ACCOUNT_PREBIRTH_DISPATCH_EXPORT_UNAVAILABLE'};
const sections=['nameDispatches','nameDispatchOperations','nameDispatchOutbox','prebirthHeads','prebirthInventory'] as const;
const reads=(sql:string,table:string)=>sql.startsWith('SELECT * FROM '+table+' WHERE ');
const notice=(a:{acceptance:{dispatchId:string;taskId:string;submissionId:string}})=>({dispatchId:a.acceptance.dispatchId,taskId:a.acceptance.taskId,submissionId:a.acceptance.submissionId});
async function withFixture(run:(f:NamingDispatchFixture,requests:Record<string,unknown>[])=>Promise<void>){
 await withPrebirthLoopback(async(runtime,requests)=>{const f=await createNamingDispatchFixture(runtime);
  try{await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[f.who.userId,encoded]);await run(f,requests);}finally{await f.close();}
 });
}
test('queued and genuinely completed name tasks export original inventory and journal without credentials, writes or row locks',async()=>withFixture(async(f,calls)=>{
 const a=await f.naming.accept(f.who,f.command('Juno')),queued=await capture(f,f.who);
 assert.equal(queued.sections.nameDispatches.length,1);assert.equal(queued.sections.nameDispatchOperations.length,0);
 assert.equal((queued.sections.nameDispatchOutbox[0] as any).kind,'notification_metadata');
 assert.equal((queued.sections.nameDispatchOutbox[0] as any).lastDispatchedAt,null);
 await f.naming.executeNotification(notice(a));
 const before=await dispatchBytes(f),n=calls.length,sqls:string[]=[],token=await proof(f,f.who);
 const data=await new AccountCoreExport(instrument(f,sql=>{sqls.push(sql);}),f.config).capture(f.who,token),s=data.sections;
 assert.deepEqual(s.nameDispatchOperations.map((r:any)=>r.kind),['claim','start','detected','application']);
 assert.equal((s.nameDispatchOperations.at(-1) as any).evidence.status,'applied');
 assert.equal((s.nameDispatches[0] as any).journalHold,null);assert.equal((s.nameDispatchOutbox[0] as any).heldReason,'terminal');
 assert.equal(s.prebirthHeads.length,1);assert.equal((s.prebirthHeads[0] as any).revision,s.prebirthInventory.length);
 assert(s.prebirthInventory.some((r:any)=>r.kind==='name_submission'&&r.sourceId===a.acceptance.submissionId));
 assert.equal(data.includedTables.length,147);assert.equal(data.remainingTables.length,23);assert.equal(data.complete,false);
 for(const table of tables){assert(data.includedTables.includes(table));assert(!data.remainingTables.includes(table));}
 const json=JSON.stringify(data);
 for(const secret of [token,f.who.tokenHash,password,encoded,'originalSessionHash','submittedAuthVersion','leaseToken','executionToken','claimCipherDigest','captureDigest','payload_ciphertext','chain_digest'])assert(!json.includes(secret),secret);
 assert(Object.isFrozen(s.nameDispatchOperations[0]));assert.deepEqual(await dispatchBytes(f),before);assert.equal(calls.length,n);
 assert(!sqls.filter(sql=>/FROM platform_(companion_name|companion_prebirth)/.test(sql)).some(sql=>/FOR (UPDATE|SHARE|NO KEY UPDATE)/.test(sql)));
}));
test('real L2 resource completion binds the original prepared response and never claims it was displayed',async()=>withFixture(async(f,calls)=>{
 const a=await f.naming.accept(f.who,f.command('Fictional prebirth high marker'));await f.naming.executeNotification(notice(a));
 const n=calls.length,data=await capture(f,f.who),op=data.sections.nameDispatchOperations.at(-1) as any;
 assert.equal(op.kind,'resource');assert.equal(op.evidence.responseId,(data.sections.nameSafetyResponses[0] as any).id);
 assert.deepEqual(data.sections.nameResourcePublications,[]);assert.equal(calls.length,n);
 const token=await proof(f,f.who);let reached=false;
 const db=instrument(f,(sql,rows)=>{if(sql.startsWith('SELECT id,user_id,submission_id,source_generation,payload_ciphertext FROM platform_companion_name_safety_responses')){reached=true;rows[0].payload_ciphertext=Buffer.from('fictional unrelated response');}});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(f.who,token),failure);assert(reached);await unused(f,f.who);
}));
test('configuration holds preserve pending state; historical archive survives later policy and original-session removal',async()=>withFixture(async(f,calls)=>{
 const a=await f.naming.accept(f.who,f.command());await f.namingWith(null,f.original).executeNotification(notice(a));
 const data=await capture(f,f.who);
 assert.equal((data.sections.nameDispatches[0] as any).journalHold,'configuration');
 assert.deepEqual(data.sections.nameDispatchOperations.map((r:any)=>r.kind),['hold']);
 const {token:rawToken}=await insertSession(f.db,f.config,f.who.userId);
 const who={userId:f.who.userId,tokenHash:tokenHash(rawToken)};
 await f.db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[f.who.tokenHash]);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);
 await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 const n=calls.length,after=await capture(f,who);
 for(const key of sections)assert.deepEqual(after.sections[key],data.sections[key]);assert.equal(calls.length,n);
}));
test('empty legacy owner is not adopted by export and needs no inventory crypto',async()=>fixture(async f=>{
 const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);
 const data=await capture(f,who);
 await f.db.withBoundedTransaction(async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  const rows=[];for await(const r of new AccountPrebirthDispatchExport({}).exportInTransaction(client,who,{nameSafetyResponses:[]}))rows.push(r);
  assert.deepEqual(rows,[]);
 });
 for(const key of sections)assert.deepEqual(data.sections[key],[]);
 assert.equal((await f.db.query('SELECT prebirth_inventory_owner_id FROM platform_users WHERE id=$1',[who.userId])).rows[0].prebirth_inventory_owner_id,null);
}));
test('missing roots, journal suffixes, queue rows or owner anchors reject whole export and preserve reauthentication',async()=>withFixture(async f=>{
 const a=await f.naming.accept(f.who,f.command());await f.naming.executeNotification(notice(a));
 const token=await proof(f,f.who);
 for(const fault of [...tables,'anchor']){
  let reached=false;const db=instrument(f,(sql,rows)=>{
   if(fault==='anchor'&&sql==='SELECT prebirth_inventory_owner_id FROM platform_users WHERE id=$1'){reached=true;rows[0].prebirth_inventory_owner_id=null;}
   if(fault!=='anchor'&&reads(sql,fault)&&rows.length){reached=true;rows.splice(0);}
  });await assert.rejects(new AccountCoreExport(db,f.config).capture(f.who,token),failure);assert(reached,fault);await unused(f,f.who);
 }
}));
test('damaged capsules, old authentic heads and cross-owner coordinates cannot pass archive verification',async()=>withFixture(async f=>{
 const old=(await f.db.query('SELECT * FROM platform_companion_prebirth_heads WHERE user_id=$1',[f.who.userId])).rows[0];
 const a=await f.naming.accept(f.who,f.command());await f.naming.executeNotification(notice(a));const token=await proof(f,f.who);
 for(const fault of ['dispatch','operation','head','inventory','old','owner','queue','date']){
  let reached=false;
  const db=instrument(f,(sql,rows)=>{
   if(!rows.length)return;
   const target=fault==='dispatch'?'platform_companion_name_dispatches':fault==='operation'?'platform_companion_name_dispatch_operations':fault==='head'||fault==='old'?'platform_companion_prebirth_heads':fault==='inventory'?'platform_companion_prebirth_inventory':fault==='owner'?'platform_companion_name_dispatch_operations':'platform_companion_name_dispatch_outbox';
   if(!reads(sql,target)||(fault==='dispatch'&&!sql.includes('WHERE id=')))return;reached=true;
   if(fault==='old')rows[0]={...old};
   else if(fault==='owner')rows[0].user_id=randomUUID();
   else if(fault==='queue')rows[0].task_id=randomUUID();
   else if(fault==='date')rows[0].created_at=new Date(0);
   else{const b=Buffer.from(rows[0].payload_ciphertext);b[b.length-1]^=1;rows[0].payload_ciphertext=b;}
  });
  await assert.rejects(new AccountCoreExport(db,f.config).capture(f.who,token),failure);assert(reached,fault);await unused(f,f.who);
 }
}));
test('cancel, late auth change and size failure produce no partial capture and roll back proof use',async()=>withFixture(async f=>{
 await f.naming.accept(f.who,f.command());
 for(const fault of ['cancel','auth','size']){
  const token=await proof(f,f.who),controller=new AbortController();let reached=false;
  const db=instrument(f,async(sql,rows,client)=>{if(!reached&&reads(sql,'platform_companion_name_dispatch_outbox')&&rows.length){reached=true;
   if(fault==='cancel')controller.abort();if(fault==='auth')await client.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[f.who.userId]);}});
  await assert.rejects(new AccountCoreExport(db,f.config,fault==='size'?{maxBytes:1024}:{}).capture(f.who,token,controller.signal),
   {code:fault==='cancel'?'ACCOUNT_EXPORT_CANCELLED':fault==='auth'?'AUTH_REQUIRED':'ACCOUNT_EXPORT_TOO_LARGE'});
  if(fault!=='size')assert(reached);await unused(f,f.who);
 }
}));
test('105 actual hold operations page without truncation or a manufactured execution',async()=>withFixture(async f=>{
 const a=await f.naming.accept(f.who,f.command()),n=notice(a);
 for(let i=0;i<105;i++)await f.db.withBoundedTransaction(async client=>{
  const d=await readNameDispatchInTransaction(client,f.crypto,n);
  await recordNameDispatchStage(client,f.crypto,d,'hold',{reason:i%2?'configuration':'storage'});
 });
 const queries:string[]=[],data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(f.who,await proof(f,f.who));
 assert.equal(data.sections.nameDispatchOperations.length,105);assert(data.sections.nameDispatchOperations.every((r:any)=>r.kind==='hold'));
 assert.equal(queries.filter(sql=>reads(sql,'platform_companion_name_dispatch_operations')&&sql.includes('LIMIT 100')).length,2);
}));
test('original intake inventory crosses 100 rows and is compared to every genuine source',async()=>fixture(async f=>{
 const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);
 let draft=(await f.store.save(who,{expectedRevision:0,operationId:randomUUID(),action:{kind:'start',mode:'fast_track'}})).draft;
 for(let i=0;i<105;i++){assert(draft.currentQuestion);draft=(await f.store.save(who,{expectedRevision:draft.revision,operationId:randomUUID(),action:{kind:'text',questionId:draft.currentQuestion,text:'Fictional original intake source '+i}})).draft;}
 await f.db.withBoundedTransaction(client=>syncPrebirthInventoryInTransaction(client,f.crypto,who.userId));
 const queries:string[]=[],data=await new AccountCoreExport(instrument(f,sql=>{queries.push(sql);}),f.config).capture(who,await proof(f,who));
 assert.equal(data.sections.prebirthInventory.length,106);assert.equal((data.sections.prebirthHeads[0] as any).revision,106);
 assert.equal(queries.filter(sql=>reads(sql,'platform_companion_prebirth_inventory')&&sql.includes('LIMIT 100')).length,2);
 let reached=false;const token=await proof(f,who),db=instrument(f,(sql,rows)=>{
  if(sql.startsWith('SELECT operation_id,draft_id,applied_revision,request_ciphertext FROM platform_onboarding_operations')&&sql.includes('OFFSET')&&rows.length){reached=true;rows.pop();}
 });
 await assert.rejects(new AccountCoreExport(db,f.config).capture(who,token),failure);assert(reached);await unused(f,who);
}));

test('an actual worker death exports an unstarted claim, then retains recovery separately from execution',async()=>withFixture(async(f,calls)=>{
 const a=await f.naming.accept(f.who,f.command()),n=notice(a),before=calls.length;
 const killed=await killedUnstartedClaim(f,n.submissionId);
 const pending=await capture(f,f.who);
 assert.deepEqual(pending.sections.nameDispatchOperations.map((r:any)=>r.kind),['claim']);assert.equal(calls.length,before);
 assert(!JSON.stringify(pending).includes(killed.claim.leaseToken));
 await waitTrueLeaseExpiry(f,n.submissionId);await f.naming.executeNotification(n);assert.equal(calls.length,before+1);
 const recovered=await capture(f,f.who);
 assert.deepEqual(recovered.sections.nameDispatchOperations.map((r:any)=>r.kind),['claim','recover','start','detected','application']);
 assert.equal((recovered.sections.nameDispatchOperations[1] as any).generation,killed.claim.generation);
 assert.equal((recovered.sections.nameDispatchOperations.at(-1) as any).evidence.status,'applied');
 assert.equal(calls.length,before+1);
}));
