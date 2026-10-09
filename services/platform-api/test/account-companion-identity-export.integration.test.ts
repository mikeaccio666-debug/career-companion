import {CompanionIdentityDrafts} from '../src/companion-identity-drafts.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {PlatformProviderRuntime} from '@companion/platform-contracts';
import {Database} from '../src/database.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {createCompanionNameSafetyFixture,fictionalNameBundle} from './fixtures/companion-name-safety.ts';
import {withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string;
const password='Fictional-identity-export-password';
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);});after(async()=>{await f?.close();});
const command=(taskId:string,expectedRevision=0,name='Juno')=>({taskId,expectedRevision,operationId:randomUUID(),name});
const select=(taskId:string,sealChar:string,expectedIdentityRevision=1,expectedRevision=0)=>({taskId,expectedIdentityRevision,expectedRevision,operationId:randomUUID(),sealChar});
async function named(runtime:PlatformProviderRuntime){const p=await f.ready(runtime);await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[p.who.userId,encoded]);const saved=await p.names.save(p.who,command(p.prepared.taskId));return {...p,identity:saved.draft};}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const unused=async(who:FixedSessionContext)=>assert((await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows.every(r=>r.consumed_at===null));
function instrument(change:(sql:string,rows:Record<string,any>[],client:PoolClient)=>void|Promise<void>):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await change(sql,result.rows,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const read=(sql:string,kind='drafts')=>sql.startsWith(`SELECT * FROM platform_companion_identity_${kind} WHERE user_id=`);
async function snapshot(who:FixedSessionContext){const rows:unknown[]=[];for(const name of ['drafts','operations','selections','selection_operations'])rows.push((await f.db.query(`SELECT row_to_json(t)::text AS saved FROM platform_companion_identity_${name} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`,[who.userId])).rows);return rows;}

test('actual names and explicit seal choices retain their independent revisions, including a choice invalidated by later renaming',async()=>{
 await withPrebirthLoopback(async(runtime,calls)=>{const p=await named(runtime),taskId=p.prepared.taskId,char=p.identity.sealCandidates[0].char;
  await p.names.saveSelection(p.who,select(taskId,char));
  const second=await p.names.save(p.who,command(taskId,1,'舟'));await p.names.saveSelection(p.who,select(taskId,second.draft.sealCandidates[1].char,2,1));
  await p.names.save(p.who,command(taskId,2,'Juno'));
  const foreign=await named(runtime),before=await snapshot(p.who),requests=calls.length,sqls:string[]=[],data=await new AccountCoreExport(instrument(sql=>{sqls.push(sql);}),f.config).capture(p.who,await proof(p.who));
  const draft=data.sections.companionIdentityDrafts[0] as any,selection=data.sections.companionIdentitySelections[0] as any,history=data.sections.companionIdentitySelectionOperations as any[];
  assert.equal(draft.name,'Juno');assert.equal(draft.revision,3);assert.equal(selection.revision,2);assert.equal(selection.identityRevision,2);assert.equal(selection.currentForIdentity,false);assert.equal(selection.identitySnapshot.name,'舟');
  assert.equal(data.sections.companionIdentityOperations.length,3);assert.equal(history.length,2);assert.equal(history.find(x=>x.appliedRevision===1).identitySnapshot.name,'Juno');assert(Object.isFrozen(selection.identitySnapshot.sealCandidates));
  assert.equal(data.includedTables.length,129);assert.equal(data.remainingTables.length,35);assert(data.remainingTables.includes('platform_companion_identity_assets'));assert.equal(data.complete,false);
  const text=JSON.stringify(data);for(const secret of [foreign.who.userId,p.who.tokenHash,password,encoded,p.authority.reviewer.userId,p.authority.operator.userId,'bundle_json','review_json','request_ciphertext','payload_ciphertext','坏词甲'])assert(!text.includes(secret));
  assert(!sqls.filter(sql=>/FROM platform_companion_identity_/.test(sql)).some(sql=>/FOR (SHARE|UPDATE)/.test(sql)));
  assert.deepEqual(await snapshot(p.who),before);assert.equal(calls.length,requests);
 });
});

test('empty account and completed unnamed preview do not create a name, candidate choice or operation',async()=>{
 await withPrebirthLoopback(async runtime=>{const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);
  for(const data of [await capture(who),await (async()=>{await f.ready(runtime,{who});return capture(who);})()])for(const key of ['companionIdentityDrafts','companionIdentityOperations','companionIdentitySelections','companionIdentitySelectionOperations'] as const)assert.deepEqual(data.sections[key],[]);
  assert.deepEqual(await snapshot(who),[[],[],[],[]]);
 });
});

test('original reviewed assets and saved username remain usable after current policy, name, consent and email verification change',async()=>{
 await withPrebirthLoopback(async(runtime,calls)=>{const p=await named(runtime);await p.names.saveSelection(p.who,select(p.prepared.taskId,p.identity.sealCandidates[0].char));
  const oldName=(await f.db.query('SELECT name FROM platform_users WHERE id=$1',[p.who.userId])).rows[0].name;
  await f.identityAuthority(fictionalNameBundle(8));await f.db.query("UPDATE platform_users SET name='Juno',email_verified_at=NULL WHERE id=$1",[p.who.userId]);await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);
  const before=await snapshot(p.who),requests=calls.length,data=await capture(p.who),draft=data.sections.companionIdentityDrafts[0] as any;
  assert.equal(draft.bundleRevision,7);assert.equal(draft.userNameAtSave,oldName);assert.equal(draft.name,'Juno');assert.deepEqual(draft.sealCandidates,p.identity.sealCandidates);assert.equal((data.sections.companionIdentitySelections[0] as any).currentForIdentity,true);
  assert.deepEqual(await snapshot(p.who),before);assert.equal(calls.length,requests);
 });
});

test('105 genuine naming and selection operations cross both pages without dropping old names or snapshots',async()=>{
 await withPrebirthLoopback(async(runtime,calls)=>{const p=await named(runtime);let identity=p.identity;
  for(let n=1;n<=105;n++){
   if(n>1)identity=(await p.names.save(p.who,command(p.prepared.taskId,n-1,n%2?'Juno':'舟'))).draft;
   await p.names.saveSelection(p.who,select(p.prepared.taskId,identity.sealCandidates[n%identity.sealCandidates.length].char,n,n-1));
  }
  const sqls:string[]=[],requests=calls.length,data=await new AccountCoreExport(instrument(sql=>{sqls.push(sql);}),f.config).capture(p.who,await proof(p.who));
  assert.equal(data.sections.companionIdentityOperations.length,105);assert.equal(data.sections.companionIdentitySelectionOperations.length,105);assert.equal(sqls.filter(sql=>read(sql,'operations')).length,2);assert.equal(sqls.filter(sql=>read(sql,'selection_operations')).length,2);
  assert.equal((data.sections.companionIdentitySelections[0] as any).revision,105);assert.equal((data.sections.companionIdentitySelections[0] as any).currentForIdentity,true);assert.equal(calls.length,requests);
 });
});

test('choices spanning more resource revisions than the bounded cache retain each actual historical candidate set',async()=>{
 await withPrebirthLoopback(async(runtime,calls)=>{const p=await named(runtime);
  await p.names.saveSelection(p.who,select(p.prepared.taskId,p.identity.sealCandidates[0].char));
  for(let n=1;n<=10;n++){
   const authority=await f.identityAuthority(fictionalNameBundle(7+n)),names=new CompanionIdentityDrafts(f.db,f.config,FICTIONAL_LEGAL,p.background,authority.asset,authority.review);
   const identity=(await names.save(p.who,command(p.prepared.taskId,n,n%2?'舟':'Juno'))).draft;
   await names.saveSelection(p.who,select(p.prepared.taskId,identity.sealCandidates[0].char,n+1,n));
  }
  const before=await snapshot(p.who),requests=calls.length,data=await capture(p.who),operations=data.sections.companionIdentitySelectionOperations as any[];
  assert.equal(operations.length,11);assert.deepEqual(operations.map(x=>x.bundleRevision).sort((a,b)=>a-b),Array.from({length:11},(_,n)=>7+n));
  assert(operations.every(x=>x.identitySnapshot.bundleRevision===x.bundleRevision&&x.identitySnapshot.sealCandidates.some((c:any)=>c.char===x.request.sealChar)));
  assert.equal((data.sections.companionIdentityDrafts[0] as any).bundleRevision,17);assert.deepEqual(await snapshot(p.who),before);assert.equal(calls.length,requests);
 });
});

test('all four damaged or cross-owner ciphertext types reject the entire archive without consuming the proof',async()=>{
 await withPrebirthLoopback(async runtime=>{const p=await named(runtime);await p.names.saveSelection(p.who,select(p.prepared.taskId,p.identity.sealCandidates[0].char));
  const foreign=await named(runtime);await foreign.names.saveSelection(foreign.who,select(foreign.prepared.taskId,foreign.identity.sealCandidates[0].char));const token=await proof(p.who);
  for(const [kind,column] of [['drafts','payload_ciphertext'],['operations','request_ciphertext'],['selections','payload_ciphertext'],['selection_operations','request_ciphertext']]){
   const other=(await f.db.query(`SELECT * FROM platform_companion_identity_${kind} WHERE user_id=$1`,[foreign.who.userId])).rows[0];
   for(const swap of [false,true]){let reached=false;const db=instrument((sql,rows)=>{if(read(sql,kind)&&rows.length){reached=true;const bytes=Buffer.from(rows[0][column]);bytes[bytes.length-1]^=1;rows[0][column]=swap?other[column]:bytes;}});
    await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_IDENTITY_EXPORT_UNAVAILABLE'});assert(reached);await unused(p.who);
   }
  }
  assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionIdentitySelections.length,1);
 });
});

test('missing or duplicate history and an authentic rollback to an older current name cannot hide later operations',async()=>{
 await withPrebirthLoopback(async runtime=>{const p=await named(runtime),old=(await f.db.query('SELECT * FROM platform_companion_identity_drafts WHERE user_id=$1',[p.who.userId])).rows[0];
  await p.names.saveSelection(p.who,select(p.prepared.taskId,p.identity.sealCandidates[0].char));const renamed=(await p.names.save(p.who,command(p.prepared.taskId,1,'舟'))).draft;
  await p.names.saveSelection(p.who,select(p.prepared.taskId,renamed.sealCandidates[0].char,2,1));const token=await proof(p.who);
  for(const kind of ['operations','selection_operations'])for(const duplicate of [false,true]){const db=instrument((sql,rows)=>{if(read(sql,kind)&&rows.length){if(duplicate)rows.push({...rows[0]});else rows.splice(0,1);}});
   await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_IDENTITY_EXPORT_UNAVAILABLE'});await unused(p.who);
  }
  const rollback=instrument((sql,rows)=>{if(read(sql)&&rows.length)rows[0]={...old};});await assert.rejects(new AccountCoreExport(rollback,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_IDENTITY_EXPORT_UNAVAILABLE'});await unused(p.who);
  assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionIdentityOperations.length,2);
 });
});

test('historical snapshots must still match their original name operation, source preview and saved asset bytes',async()=>{
 await withPrebirthLoopback(async runtime=>{const p=await named(runtime);await p.names.saveSelection(p.who,select(p.prepared.taskId,p.identity.sealCandidates[0].char));await p.names.save(p.who,command(p.prepared.taskId,1,'舟'));const token=await proof(p.who);
  const changed=instrument((sql,rows)=>{if(read(sql,'operations'))for(const row of rows)if(row.applied_revision===1){const context={table:'platform_companion_identity_operations',column:'request_ciphertext',rowId:row.operation_id,ownerId:p.who.userId,revision:1};
    const original=JSON.parse(f.crypto.openUtf8(row.request_ciphertext,context));row.request_ciphertext=f.crypto.sealUtf8(JSON.stringify({...original,name:'墨'}),context);
   }});
  await assert.rejects(new AccountCoreExport(changed,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_IDENTITY_EXPORT_UNAVAILABLE'});await unused(p.who);
  for(const damage of ['missing','changed']){const db=instrument((sql,rows)=>{if(sql.startsWith('SELECT revision,bundle_json,review_json FROM platform_companion_identity_assets')&&rows.length){if(damage==='missing')rows.splice(0);else rows[0].bundle_json=rows[0].bundle_json.replace('Juno','Changed');}});
   await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_IDENTITY_EXPORT_UNAVAILABLE'});await unused(p.who);
  }
  assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionIdentityDrafts.length,1);
 });
});

test('late auth reset, cancellation and capacity rollback discard captured identity data and keep the proof retryable',async()=>{
 await withPrebirthLoopback(async runtime=>{const p=await named(runtime),token=await proof(p.who);
  const changed=instrument(async(sql,_rows,c)=>{if(read(sql))await c.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[p.who.userId]);});await assert.rejects(new AccountCoreExport(changed,f.config).capture(p.who,token));await unused(p.who);
  const abort=new AbortController();await assert.rejects(new AccountCoreExport(instrument(sql=>{if(read(sql))abort.abort(new Error('Synthetic identity archive cancellation'));}),f.config).capture(p.who,token,abort.signal));await unused(p.who);
  await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:1024}).capture(p.who,token),{code:'ACCOUNT_EXPORT_TOO_LARGE'});await unused(p.who);
  assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionIdentityDrafts.length,1);
 });
});
