import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {AccountActions} from '../src/account-actions.ts';
import {RequestLimits} from '../src/request-limits.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {invitationEmailDigest,inviteCodeHash} from '../src/student-entry.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string,actions:AccountActions,limits:RequestLimits;
const password='Fictional-security-export-password',mail={apiKey:'re_fictional_export_key',from:'Fictional <no-reply@example.invalid>',webOrigin:'https://privacy.example.invalid',encryptionKey:Buffer.alloc(32,0x53)};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);actions=new AccountActions(f.db,mail);limits=new RequestLimits(f.db,{cleanupEveryRequests:10000});});
after(async()=>{await f?.close();});
const fixed=(who:FixedSessionContext)=>({userId:who.userId,tokenHash:who.tokenHash});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2,email_verified_at=NULL WHERE id=$1',[who.userId,encoded]);return {...who,email:who.userId+'@example.invalid'};}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(fixed(who),{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(fixed(who),await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
async function invite(email:string,recipient:string|null=null,issuer:string|null=null){const hash=inviteCodeHash(randomUUID());await f.db.query(`INSERT INTO platform_invites(code_hash,email_digest,batch,invited_by,expires_at,redeemed_at,redeemed_user_id)
 VALUES($1,$2,'B0',$3,clock_timestamp()+interval '1 day',CASE WHEN $4::uuid IS NULL THEN NULL ELSE clock_timestamp() END,$4)`,[hash,invitationEmailDigest(email),issuer,recipient]);return hash;}
async function lease(who:FixedSessionContext,kind='chat'){const key=randomUUID();await f.db.query("INSERT INTO platform_runtime_leases(id,user_id,kind,created_at,expires_at) VALUES($1,$2,$3,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')",[key,who.userId,kind]);return key;}
function instrument(transform:(sql:string,rows:Record<string,any>[])=>void):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const reads=(sql:string,table:string)=>sql.startsWith('SELECT ')&&sql.includes(` FROM platform_${table} WHERE `);

async function snapshot(who:FixedSessionContext){const result:Record<string,unknown>={};for(const table of ['account_actions','account_email_outbox','account_action_limits','runtime_leases'])result[table]=(await f.db.query(`SELECT row_to_json(t)::text AS value FROM platform_${table} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`,[who.userId])).rows;return result;}

test('actual verification and reset requests export owner metadata without credentials, mail payloads or shared IP counters',async()=>{
 const who=await actor(),other=await actor();await actions.requestPasswordReset(who.email);await actions.requestEmailVerification(who.userId);await actions.requestPasswordReset(other.email);
 await limits.consumeUser(who.userId,'api');await limits.consumeUser(who.userId,'api');await limits.consumeUser(other.userId,'api');await limits.consumeAnonymous('127.0.0.1','auth-login');
 const leaseId=await lease(who),code=await invite(who.email,null,other.userId),deleteProof=await new AccountReauthentication(f.db).verify(fixed(who),{purpose:'account_delete',password});
 const raw=(await f.db.query('SELECT token_hash FROM platform_account_actions WHERE user_id=$1',[who.userId])).rows;
 const token=await proof(who),before=await snapshot(who),queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>queries.push(sql)),f.config).capture(fixed(who),token),s=result.sections;
 assert.equal(s.accountActions.length,2);assert.deepEqual((s.accountActions as any[]).map(r=>r.purpose).sort(),['password-reset','verify-email']);
 assert.equal(s.accountEmailDeliveries.length,2);assert((s.accountEmailDeliveries as any[]).every(r=>r.status==='pending'&&r.attempts===0));assert.equal(s.accountActionLimits.length,2);
 assert.deepEqual((s.requestLimits as any[]).map(r=>[r.scope,r.requestCount]),[['api',2]]);assert.equal(s.runtimeLeases.length,1);assert.equal(s.invitations.length,1);
 const reauth=s.accountReauthentications as any[];assert.equal(reauth.length,2);assert(reauth.every(r=>r.currentSession));assert.equal(reauth.find(r=>r.purpose==='account_delete').consumedAt,null);assert.equal(typeof reauth.find(r=>r.purpose==='account_export').consumedAt,'string');
 const json=JSON.stringify(result);for(const secret of [other.userId,leaseId,code,who.tokenHash,token,deleteProof.token,password,encoded,...raw.map(r=>r.token_hash)])assert(!json.includes(secret));
 for(const key of ['ciphertext','proof_hash','token_hash','session_hash','lease_token','target_hash','email_digest','invited_by','auth_version','provider_message_id'])assert(!json.includes('"'+key+'"'));
 const securityQueries=queries.filter(sql=>['account_actions','account_email_outbox','account_action_limits','account_reauthentications','request_limits','runtime_leases','invites'].some(t=>reads(sql,t)));
 assert(securityQueries.every(sql=>!/(ciphertext|proof_hash|token_hash|lease_token|provider_message_id)/.test(sql)));
 assert.deepEqual(await snapshot(who),before);assert.equal(result.includedTables.length,98);assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);assert(Object.isFrozen(s.accountEmailDeliveries[0]));
});

test('recipient matching includes redeemed historical addresses and pending current email, but excludes other recipients and invitations merely issued by owner',async()=>{
 const who=await actor(),other=await actor();await invite(who.email,who.userId,other.userId);await invite(who.email,null,other.userId);await invite('fictional-former@example.invalid',who.userId,other.userId);
 await invite(other.email,other.userId,who.userId);await invite(other.email,null,who.userId);await invite(who.email,other.userId,who.userId);
 const result=await capture(who),rows=result.sections.invitations as any[];assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.recipientMatch==='redeemed_account').length,2);assert.equal(rows.filter(r=>r.recipientMatch==='current_email').length,1);assert(!JSON.stringify(rows).includes(other.userId));
});

test('retained delivery states and consumed requests are preserved without claiming success or reprocessing mail',async()=>{
 const who=await actor();
 // Synthetic historical rows exercise all retained delivery states; no mail is sent.
 for(const [i,status] of ['pending','sending','sent','expired','revoked','failed'].entries()){
  const key=randomUUID();await f.db.query(`INSERT INTO platform_account_actions(id,token_hash,user_id,purpose,auth_version,created_at,expires_at,consumed_at)
   VALUES($1,$2,$3,'verify-email',0,now()-interval '2 hours',now()-interval '110 minutes',CASE WHEN $4 THEN now()-interval '1 hour' ELSE NULL END)`,[key,digest(key),who.userId,status==='revoked']);
  await f.db.query(`INSERT INTO platform_account_email_outbox(id,action_id,user_id,status,attempts,ciphertext,created_at,expires_at,next_attempt_at,lease_token,lease_until,error_code,finished_at,provider_message_id)
   VALUES($1,$1,$2,$3,$4,$5,now()-interval '2 hours',now()-interval '110 minutes',now()-interval '2 hours',$6,$7,$8,$9,'fictional-private-provider-id')`,
   [key,who.userId,status,i,['pending','sending'].includes(status)?Buffer.from('fictional encrypted bytes'):null,status==='sending'?randomUUID():null,status==='sending'?new Date(Date.now()-3600000):null,status==='failed'?'ACCOUNT_EMAIL_SEND_FAILED':null,['pending','sending'].includes(status)?null:new Date()]);
 }
 const before=await snapshot(who),result=await capture(who),rows=result.sections.accountEmailDeliveries as any[];
 assert.deepEqual(rows.map(r=>r.status).sort(),['expired','failed','pending','revoked','sending','sent']);assert.equal(rows.find(r=>r.status==='failed').errorCode,'ACCOUNT_EMAIL_SEND_FAILED');
 assert.equal((result.sections.accountActions as any[]).filter(r=>r.consumedAt!==null).length,1);assert((result.sections.accountActions as any[]).every(r=>!('success' in r)));assert(!JSON.stringify(rows).includes('fictional-private-provider-id'));assert.deepEqual(await snapshot(who),before);
});

test('empty account metadata stays empty except for the real proof consumed by this export',async()=>{
 const who=await actor(),result=await capture(who);for(const key of ['accountActions','accountEmailDeliveries','accountActionLimits','requestLimits','runtimeLeases','invitations'] as const)assert.deepEqual(result.sections[key],[]);
 assert.equal(result.sections.accountReauthentications.length,1);
});

test('retained rows across every multi-page security table survive keyset pagination including composite keys',async()=>{
 const who=await actor();
 for(let i=0;i<105;i++){
  const key=randomUUID(),session=digest('session:'+key);
  await f.db.query(`INSERT INTO platform_account_actions(id,token_hash,user_id,purpose,auth_version,expires_at) VALUES($1,$2,$3,'password-reset',0,now()+interval '10 minutes')`,[key,digest(key),who.userId]);
  await f.db.query(`INSERT INTO platform_account_email_outbox(id,action_id,user_id,status,ciphertext,expires_at) VALUES($1,$1,$2,'failed',NULL,now()+interval '10 minutes')`,[key,who.userId]);
  for(const purpose of ['password-reset','verify-email'])await f.db.query(`INSERT INTO platform_account_action_limits(target_hash,user_id,purpose,request_count,expires_at) VALUES($1,$2,$3,1,now()+interval '1 hour')`,[digest(key),who.userId,purpose]);
  await f.db.query(`INSERT INTO platform_sessions(token_hash,user_id,expires_at,auth_version) VALUES($1,$2,now()+interval '1 day',0)`,[session,who.userId]);
  for(const purpose of ['account_export','account_delete'])await f.db.query(`INSERT INTO platform_account_reauthentications(user_id,session_hash,purpose,proof_hash,auth_version,verified_at,expires_at) VALUES($1,$2,$3,$4,0,now(),now()+interval '5 minutes')`,[who.userId,session,purpose,digest(key+purpose)]);
  await lease(who,['chat','voice','background'][i%3]);await invite(who.email);
 }
 const queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>queries.push(sql)),f.config).capture(fixed(who),await proof(who));
 for(const key of ['accountActions','accountEmailDeliveries','runtimeLeases','invitations'] as const)assert.equal(result.sections[key].length,105);
 assert.equal(new Set((result.sections.accountActions as any[]).map(r=>r.id)).size,105);assert.equal(result.sections.accountActionLimits.length,210);assert.equal(result.sections.accountReauthentications.length,211);
 for(const table of ['account_actions','account_email_outbox','runtime_leases','invites'])assert.equal(queries.filter(sql=>reads(sql,table)).length,2);
 for(const table of ['account_action_limits','account_reauthentications'])assert.equal(queries.filter(sql=>reads(sql,table)).length,3);
});

test('real cross-owner action links reject the whole archive and roll back its password proof',async()=>{
 const who=await actor(),other=await actor();await actions.requestPasswordReset(who.email);await actions.requestPasswordReset(other.email);
 const own=(await f.db.query('SELECT id FROM platform_account_actions WHERE user_id=$1',[who.userId])).rows[0].id,foreign=(await f.db.query('SELECT id FROM platform_account_actions WHERE user_id=$1',[other.userId])).rows[0].id;
 await f.db.query('DELETE FROM platform_account_email_outbox WHERE user_id=$1',[other.userId]);await f.db.query('UPDATE platform_account_email_outbox SET action_id=$2 WHERE user_id=$1',[who.userId,foreign]);
 const token=await proof(who);await assert.rejects(new AccountCoreExport(f.db,f.config).capture(fixed(who),token),{code:'ACCOUNT_SECURITY_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);
 await f.db.query('UPDATE platform_account_email_outbox SET action_id=$2 WHERE user_id=$1',[who.userId,own]);assert.equal((await new AccountCoreExport(f.db,f.config).capture(fixed(who),token)).sections.accountEmailDeliveries.length,1);
});

test('invalid owner, states and recipient binding fail closed; projection ignores unrequested secret fields',async()=>{
 const who=await actor(),other=await actor();await actions.requestPasswordReset(who.email);await limits.consumeUser(who.userId,'chat');await lease(who);await invite(who.email);
 const token=await proof(who),cases:[string,(row:any)=>void][]=[['account_actions',r=>{r.user_id=other.userId;}],['account_email_outbox',r=>{r.status='unknown';}],['account_action_limits',r=>{r.request_count=4;}],['account_reauthentications',r=>{r.purpose='login';}],['request_limits',r=>{r.subject_type='ip';}],['runtime_leases',r=>{r.kind='unknown';}],['invites',r=>{r.redeemed_user_id=other.userId;}]];
 for(const [table,change] of cases){let reached=false;await assert.rejects(new AccountCoreExport(instrument((sql,rows)=>{if(reads(sql,table)&&rows.length){reached=true;change(rows[0]);}}),f.config).capture(fixed(who),token),{code:'ACCOUNT_SECURITY_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(who),null);}
 const result=await new AccountCoreExport(instrument((sql,rows)=>{if(reads(sql,'account_actions'))for(const row of rows)row.privatePayload='fictional-must-not-export';}),f.config).capture(fixed(who),token);assert(!JSON.stringify(result).includes('fictional-must-not-export'));
});

test('cancellation and archive size rejection leave the proof reusable without returning partial metadata',async()=>{
 const who=await actor();await actions.requestPasswordReset(who.email);const token=await proof(who),controller=new AbortController();
 await assert.rejects(new AccountCoreExport(instrument(sql=>{if(reads(sql,'account_email_outbox'))controller.abort();}),f.config).capture(fixed(who),token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(who),null);
 await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:1024}).capture(fixed(who),token),{code:'ACCOUNT_EXPORT_TOO_LARGE'});assert.equal(await consumed(who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(fixed(who),token)).sections.accountActions.length,1);
});
