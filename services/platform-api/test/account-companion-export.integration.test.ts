import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {CompanionPaidSettingsService} from '../src/companion-paid-settings.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {createPrebirthFixture,withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
let f:Awaited<ReturnType<typeof createPrebirthFixture>>,encoded:string,settings:CompanionPaidSettingsService;
const password='Fictional-companion-export-password';
before(async()=>{f=await createPrebirthFixture();encoded=await hashPassword(password);settings=new CompanionPaidSettingsService(f.db,f.config,FICTIONAL_LEGAL);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function born(){const who=await actor();let companionId='',birthReceiptId='';await withPrebirthLoopback(async runtime=>{const b=await readyBirth(f,runtime,{who}),receipt=(await b.service.birth(who,b.body,b.key)).receipt;companionId=receipt.identity.companionId;birthReceiptId=receipt.id;});return {who,companionId,birthReceiptId};}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
const change=(who:FixedSessionContext,companionId:string,expectedRevision:number)=>settings.change(who,{companionId,operationId:randomUUID(),expectedRevision,paidSuggestionsMode:expectedRevision%2?'when_relevant':'only_when_asked'});
function instrument(transform:(sql:string,rows:Record<string,any>[],client:PoolClient)=>void|Promise<void>):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}
const isCompanion=(sql:string)=>sql.startsWith('SELECT id,user_id,status,current_revision,draft_rerolls,fingerprint,created_at,updated_at,');
const isOperation=(sql:string)=>sql.startsWith('SELECT user_id,companion_id,operation_id,applied_revision,receipt_ciphertext,created_at');
function damage(bytes:Buffer){const copy=Buffer.from(bytes);copy[copy.length-1]^=1;return copy;}

test('owner export includes current companion data and every real paid preference without exposing internal authentication',async()=>{
 const p=await born(),other=await born(),first=await change(p.who,p.companionId,0),second=await change(p.who,p.companionId,1);
 await change(other.who,other.companionId,0);
 const token=await proof(p.who),result=await new AccountCoreExport(f.db,f.config).capture(p.who,token),profile=result.sections.companions[0] as any;
 assert.equal(result.sections.companions.length,1);assert.equal(profile.id,p.companionId);assert.equal(profile.birthReceiptId,p.birthReceiptId);
 assert.equal(profile.status,'active');assert.equal(profile.relationshipStage,'acquainting');assert.deepEqual(profile.paidSuggestions,second.settings);
 const operations=result.sections.companionPaidSettingOperations as any[];assert.equal(operations.length,2);
 assert.deepEqual(operations.map(x=>[x.operationId,x.expectedRevision,x.appliedRevision,x.paidSuggestionsMode]),[[first.operation.id,0,1,'only_when_asked'],[second.operation.id,1,2,'when_relevant']]);
 assert.equal(operations[1].createdAt,second.settings.updatedAt);assert.equal(profile.overlays,null);
 assert.equal(result.includedTables.length,121);for(const t of ['platform_companions','platform_companion_paid_setting_operations']){assert(result.includedTables.includes(t));assert(!result.remainingTables.includes(t));}
 assert(result.includedTables.includes('platform_companion_revisions'));assert(result.includedTables.includes('platform_companion_answers'));assert(result.includedTables.includes('platform_companion_source_prefixes'));assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);
 const json=JSON.stringify(result);for(const secret of [other.who.userId,other.companionId,p.who.tokenHash,encoded,password,token,'acceptedAuthVersion','receipt_ciphertext','paid_suggestions_ciphertext','commandDigest'])assert(!json.includes(secret));
 assert(Object.isFrozen(profile.paidSuggestions));assert(Object.isFrozen(operations[0]));
});

test('unborn and awaiting-name exports preserve actual lifecycle and defaults without creating a birth or a choice',async()=>{
 const who=await actor();assert.deepEqual((await capture(who)).sections.companions,[]);
 await withPrebirthLoopback(async runtime=>{await f.ready(runtime,{who});});
 const result=await capture(who),profile=result.sections.companions[0] as any;
 assert.equal(profile.status,'awaiting_name');assert.equal(profile.name,null);assert.equal(profile.bornAt,null);assert.equal(profile.birthReceiptId,null);
 assert.deepEqual(profile.paidSuggestions,{ownerId:who.userId,companionId:profile.id,paidSuggestionsMode:'when_relevant',revision:0,updatedAt:null,lastOperationId:null});
 assert.deepEqual(result.sections.companionPaidSettingOperations,[]);assert.deepEqual(result.sections.companionBirthReceipts,[]);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_companion_birth_receipts WHERE user_id=$1',[who.userId])).rows[0].n,0);
});

test('retired companions retain changed current identity, original birth and choices even after model consent and email verification are withdrawn',async()=>{
 const p=await born(),choice=await change(p.who,p.companionId,0);
 await f.db.query("UPDATE platform_companions SET name='虚构新名字',relationship_stage='familiar',stage_changed_at=clock_timestamp(),status='retired',retired_at=clock_timestamp() WHERE id=$1",[p.companionId]);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[p.who.userId]);
 const result=await capture(p.who),profile=result.sections.companions[0] as any,origin=result.sections.companionBirthReceipts[0] as any;
 assert.equal(profile.status,'retired');assert.equal(profile.name,'虚构新名字');assert.equal(profile.relationshipStage,'familiar');assert(profile.retiredAt);
 assert.equal(origin.receipt.identity.name,'Juno');assert.deepEqual(profile.paidSuggestions,choice.settings);assert.equal(result.sections.companionPaidSettingOperations.length,1);
});

test('more than one page of genuine saved preferences is exported exactly once and in revision order',async()=>{
 const p=await born();let last;for(let i=0;i<105;i++)last=await change(p.who,p.companionId,i);
 const queries:string[]=[],db=instrument(sql=>{queries.push(sql);}),result=await new AccountCoreExport(db,f.config).capture(p.who,await proof(p.who));
 const ops=result.sections.companionPaidSettingOperations as any[];assert.equal(ops.length,105);assert.equal(new Set(ops.map(x=>x.operationId)).size,105);
 assert.deepEqual(ops.map(x=>x.appliedRevision),Array.from({length:105},(_,i)=>i+1));assert.deepEqual((result.sections.companions[0] as any).paidSuggestions,last!.settings);
 assert.equal(queries.filter(isOperation).length,2);assert(!queries.filter(sql=>isOperation(sql)||isCompanion(sql)).some(sql=>/FOR (SHARE|UPDATE)/.test(sql)));
});

test('current-state or historical receipt corruption, foreign ciphertext and missing history discard the entire export and preserve its proof',async()=>{
 const p=await born(),foreign=await born();await change(p.who,p.companionId,0);await change(p.who,p.companionId,1);await change(foreign.who,foreign.companionId,0);
 const foreignRow=(await f.db.query('SELECT * FROM platform_companion_paid_setting_operations WHERE user_id=$1',[foreign.who.userId])).rows[0],token=await proof(p.who);
 const faults:[string,(rows:Record<string,any>[])=>void][]=[
  ['profile',rows=>{rows[0].paid_suggestions_ciphertext=damage(rows[0].paid_suggestions_ciphertext);} ],
  ['profile',rows=>{rows[0].paid_suggestions_mode='only_when_asked';}],
  ['operations',rows=>{rows[0].receipt_ciphertext=damage(rows[0].receipt_ciphertext);} ],
  ['operations',rows=>{rows[0].receipt_ciphertext=foreignRow.receipt_ciphertext;} ],
  ['operations',rows=>{rows.shift();}],
  ['operations',rows=>{rows[0].created_at=new Date(0);}],
 ];
 for(const [kind,fault] of faults){let reached=false;const db=instrument((sql,rows)=>{if((kind==='profile'?isCompanion(sql):isOperation(sql))&&rows.length){reached=true;fault(rows);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),(e:any)=>['PAID_SETTINGS_UNAVAILABLE','ACCOUNT_COMPANION_EXPORT_UNAVAILABLE'].includes(e.code));assert(reached);assert.equal(await consumed(p.who),null);
 }
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionPaidSettingOperations.length,2);
});

test('an authentic old preference state and a cleared default cannot hide later saved choices',async()=>{
 const p=await born();await change(p.who,p.companionId,0);const old=(await f.db.query('SELECT * FROM platform_companions WHERE id=$1',[p.companionId])).rows[0];await change(p.who,p.companionId,1);
 const token=await proof(p.who);
 for(const reset of [false,true]){const db=instrument((sql,rows)=>{if(isCompanion(sql)&&rows.length){for(const key of Object.keys(old).filter(x=>x.startsWith('paid_suggestions_')))rows[0][key]=old[key];if(reset)Object.assign(rows[0],{paid_suggestions_mode:'when_relevant',paid_suggestions_revision:0,paid_suggestions_ciphertext:null,paid_suggestions_updated_at:null,paid_suggestions_operation_id:null});}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token),{code:'ACCOUNT_COMPANION_EXPORT_UNAVAILABLE'});assert.equal(await consumed(p.who),null);
 }
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionPaidSettingOperations.length,2);
});

test('concurrent committed profile changes cannot mix into the captured snapshot',async()=>{
 const p=await born(),token=await proof(p.who);let changed=false;
 const db=instrument(async(sql)=>{if(isCompanion(sql)&&!changed){changed=true;await f.db.query("UPDATE platform_companions SET name='虚构并发新名字' WHERE id=$1",[p.companionId]);}});
 const result=await new AccountCoreExport(db,f.config).capture(p.who,token);assert(changed);assert.equal((result.sections.companions[0] as any).name,'Juno');
 assert.equal((await f.db.query('SELECT name FROM platform_companions WHERE id=$1',[p.companionId])).rows[0].name,'虚构并发新名字');
 assert.equal(((await capture(p.who)).sections.companions[0] as any).name,'虚构并发新名字');
});

test('cancellation after preference history has been read rolls back the proof and returns no partial capture',async()=>{
 const p=await born();await change(p.who,p.companionId,0);const token=await proof(p.who),controller=new AbortController();let reached=false;
 const db=instrument(sql=>{if(isOperation(sql)){reached=true;controller.abort();}});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert(reached);assert.equal(await consumed(p.who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companions.length,1);
});
