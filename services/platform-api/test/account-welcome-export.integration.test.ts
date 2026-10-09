import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {CompanionWelcomeService} from '../src/companion-welcome.ts';
import {CompanionBirthOriginStore} from '../src/companion-birth-origin-store.ts';
import {createPrebirthFixture,withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {readyBirth} from './fixtures/companion-birth.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
let f:Awaited<ReturnType<typeof createPrebirthFixture>>,encoded:string;
const password='Fictional-welcome-export-password';
before(async()=>{f=await createPrebirthFixture();encoded=await hashPassword(password);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function prepare(choice?:'begin'|'direct_letter'){
 const who=await actor();let result:any;
 await withPrebirthLoopback(async(runtime,calls)=>{
  const ready=await readyBirth(f,runtime,{who});await ready.service.birth(who,ready.body,ready.key);
  const service=new CompanionWelcomeService(f.db,f.config,FICTIONAL_LEGAL,new CompanionBirthOriginStore(f.crypto),ready.prebirth);
  const opened=await service.open(who,{expectedCompanionId:ready.ready.prepared.companionId});
  const command={operationId:randomUUID(),welcomeId:opened.id,expectedRevision:1 as const,choice:choice??'begin' as const};
  const state=choice?(await service.choose(who,command)).state:opened;
  result={who,service,opened,state,command};assert.equal(calls.length,2);
 });return result as {who:FixedSessionContext;service:CompanionWelcomeService;opened:import('@companion/platform-contracts').CompanionWelcome;state:import('@companion/platform-contracts').CompanionWelcome;command:import('@companion/platform-contracts').CompanionWelcomeChoice};
}
async function proof(who:FixedSessionContext){return (await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;}
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export' ORDER BY verified_at DESC LIMIT 1",[who.userId])).rows[0].consumed_at;
function instrument(afterQuery:(sql:string,client:PoolClient)=>Promise<void>):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await afterQuery(sql,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}

test('actual C1, begin and direct-letter choices export the saved introduction and only the verified business receipt',async()=>{
 for(const choice of [undefined,'begin','direct_letter'] as const){
  const p=await prepare(choice),token=await proof(p.who),result=await new AccountCoreExport(f.db,f.config).capture(p.who,token);
  assert.equal(result.sections.companionWelcomes.length,1);const saved=result.sections.companionWelcomes[0] as any;
  const {birthReceiptId,...state}=saved;assert.deepEqual(state,p.state);assert.match(birthReceiptId,/^[a-f0-9-]{36}$/);
  assert.equal(result.sections.companionWelcomeOperations.length,choice?1:0);
  if(choice)assert.deepEqual(result.sections.companionWelcomeOperations[0],{id:p.command.operationId,welcomeId:p.state.id,companionId:p.state.companionId,expectedRevision:1,appliedRevision:2,choice,createdAt:p.state.updatedAt});
  assert.equal(result.includedTables.length,145);assert(!result.remainingTables.includes('platform_companion_welcome'));assert(!result.remainingTables.includes('platform_companion_welcome_operations'));
  assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);assert(Object.isFrozen(saved.intro.speaker));
  const text=JSON.stringify(result);for(const secret of [p.who.tokenHash,encoded,password,token,'acceptedAuthVersion','accepted_auth_version','request_ciphertext','intro_ciphertext'])assert(!text.includes(secret));
  assert.deepEqual(await p.service.read(p.who),p.state,'Export must not advance or reopen the welcome.');
 }
});

test('another owner is excluded and saved wording survives retirement, current identity changes and withdrawn model admission',async()=>{
 const p=await prepare('begin'),other=await prepare('direct_letter');
 await f.db.query("UPDATE platform_companions SET name='虚构新名字',status='retired',retired_at=clock_timestamp() WHERE id=$1",[p.state.companionId]);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[p.who.userId]);
 const result=await capture(p.who),text=JSON.stringify(result);assert.deepEqual((result.sections.companionWelcomes[0] as any).intro,p.opened.intro);
 for(const foreign of [other.who.userId,other.state.id,other.state.intro.id,other.command.operationId])assert(!text.includes(foreign));
 assert.equal((result.sections.companions[0] as any).name,'虚构新名字');
 assert(!JSON.stringify(result.sections.companionWelcomes).includes('虚构新名字'));
});

test('damaged or relocated encrypted snapshots and choice receipts fail without consuming the proof',async()=>{
 const p=await prepare('begin'),foreign=await prepare('begin'),token=await proof(p.who);
 const row=(await f.db.query('SELECT * FROM platform_companion_welcome WHERE id=$1',[p.state.id])).rows[0];
 const op=(await f.db.query('SELECT * FROM platform_companion_welcome_operations WHERE welcome_id=$1',[p.state.id])).rows[0];
 const foreignRow=(await f.db.query('SELECT * FROM platform_companion_welcome WHERE id=$1',[foreign.state.id])).rows[0];
 const foreignOp=(await f.db.query('SELECT * FROM platform_companion_welcome_operations WHERE welcome_id=$1',[foreign.state.id])).rows[0];
 const fail=async()=>{await assert.rejects(new AccountCoreExport(f.db,f.config).capture(p.who,token),{code:'COMPANION_WELCOME_UNAVAILABLE'});assert.equal(await consumed(p.who),null);};
 const broken=Buffer.from(row.intro_ciphertext);broken[broken.length-1]^=1;
 for(const ciphertext of [broken,foreignRow.intro_ciphertext]){await f.db.query('UPDATE platform_companion_welcome SET intro_ciphertext=$2 WHERE id=$1',[p.state.id,ciphertext]);await fail();}
 await f.db.query('UPDATE platform_companion_welcome SET intro_ciphertext=$2 WHERE id=$1',[p.state.id,row.intro_ciphertext]);
 for(const ciphertext of [Buffer.from('fictional-broken-cipher'),foreignOp.request_ciphertext]){await f.db.query('UPDATE platform_companion_welcome_operations SET request_ciphertext=$2 WHERE welcome_id=$1',[p.state.id,ciphertext]);await fail();}
 await f.db.query('UPDATE platform_companion_welcome_operations SET request_ciphertext=$2 WHERE welcome_id=$1',[p.state.id,op.request_ciphertext]);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionWelcomes.length,1);
});

test('downgraded welcome state cannot hide an existing choice; a changed choice cannot reuse the old authenticated receipt',async()=>{
 const p=await prepare('begin'),token=await proof(p.who);
 await f.db.query("UPDATE platform_companion_welcome SET revision=1,step='C1',choice=NULL,updated_at=opened_at WHERE id=$1",[p.state.id]);
 await assert.rejects(new AccountCoreExport(f.db,f.config).capture(p.who,token),{code:'COMPANION_WELCOME_UNAVAILABLE'});
 await assert.rejects(p.service.read(p.who),{code:'COMPANION_WELCOME_UNAVAILABLE'});
 await f.db.query("UPDATE platform_companion_welcome SET revision=2,step='C7',choice='direct_letter',updated_at=$2 WHERE id=$1",[p.state.id,p.state.updatedAt]);
 await assert.rejects(new AccountCoreExport(f.db,f.config).capture(p.who,token),{code:'COMPANION_WELCOME_UNAVAILABLE'});assert.equal(await consumed(p.who),null);
 await f.db.query("UPDATE platform_companion_welcome SET step='C2',choice='begin' WHERE id=$1",[p.state.id]);
 assert.deepEqual((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionWelcomeOperations[0],{id:p.command.operationId,welcomeId:p.state.id,companionId:p.state.companionId,expectedRevision:1,appliedRevision:2,choice:'begin',createdAt:p.state.updatedAt});
});

test('saved speaker and original timestamp inconsistencies are rejected even with an authenticated ciphertext',async()=>{
 const p=await prepare(),row=(await f.db.query('SELECT intro_ciphertext FROM platform_companion_welcome WHERE id=$1',[p.state.id])).rows[0],token=await proof(p.who);
 const binding={table:'platform_companion_welcome',column:'intro_ciphertext',rowId:p.state.id,ownerId:p.who.userId,revision:1};
 const value=JSON.parse(f.crypto.openUtf8(row.intro_ciphertext,binding));value.updatedAt=new Date(Date.parse(value.openedAt)+1).toISOString();
 await f.db.query('UPDATE platform_companion_welcome SET intro_ciphertext=$2 WHERE id=$1',[p.state.id,f.crypto.sealUtf8(JSON.stringify(value),binding)]);
 await assert.rejects(new AccountCoreExport(f.db,f.config).capture(p.who,token),{code:'COMPANION_WELCOME_UNAVAILABLE'});
 await f.db.query('UPDATE platform_companion_welcome SET intro_ciphertext=$2 WHERE id=$1',[p.state.id,row.intro_ciphertext]);
 const message=(await f.db.query('SELECT speaker_snapshot FROM platform_messages WHERE id=$1',[p.state.intro.id])).rows[0];
 await f.db.query('UPDATE platform_messages SET speaker_snapshot=$2 WHERE id=$1',[p.state.intro.id,JSON.stringify({...message.speaker_snapshot,displayName:'Fictional mismatched speaker'})]);
 await assert.rejects(new AccountCoreExport(f.db,f.config).capture(p.who,token),{code:'COMPANION_WELCOME_UNAVAILABLE'});assert.equal(await consumed(p.who),null);
});

test('cancellation during welcome decoding rolls back the entire capture and does not consume its proof',async()=>{
 const p=await prepare('direct_letter'),token=await proof(p.who),controller=new AbortController();let reached=false;
 const db=instrument(async sql=>{if(sql.startsWith('SELECT * FROM platform_companion_welcome WHERE user_id=')){reached=true;controller.abort();}});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(p.who,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert(reached);assert.equal(await consumed(p.who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(p.who,token)).sections.companionWelcomeOperations.length,1);
});
