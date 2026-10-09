import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {ModelCallEvent} from '@companion/platform-contracts';
import {Database} from '../src/database.ts';
import {hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {createSafetyModelUsage} from '../src/safety-model-usage.ts';
import {SharedMemories} from '../src/shared-memories.ts';
import {purgeExpiredMemoryDeletions} from '../src/memory-retention.ts';
import {configuredModelRelayPolicy,createJobModelRelay} from '../src/model-relay.ts';
import {ModelConsent} from '../src/model-routing.ts';
import {companionNameNotification} from '../src/companion-name-dispatch-protocol.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
import {createNamingDispatchFixture} from './fixtures/companion-name-dispatch.ts';
import {withPrebirthLoopback} from './fixtures/companion-prebirth.ts';
import {createMemorySafetyLoopback} from './fixtures/shared-memory-safety.ts';
import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string;
const password='Fictional-model-audit-export-password',route={purpose:'safety_classify' as const,provider:'openai',model:'fictional-audit-classifier'};
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);});after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
async function intake(who=undefined as FixedSessionContext|undefined){
 who??=await actor();let draft=await f.store.read(who);if(!draft)draft=(await f.store.save(who,{operationId:randomUUID(),expectedRevision:0,action:{kind:'start',mode:'standard'}})).draft;
 await f.store.save(who,{operationId:randomUUID(),expectedRevision:draft.revision,action:{kind:'text',questionId:draft.currentQuestion!,text:'Synthetic retained classification input'}});
 const claim=await f.store.claimSafety(who,{detectorRevision:7,leaseMs:60000});assert(claim);
 const callId=randomUUID(),usage=createSafetyModelUsage(f.db,claim,route,200),started:ModelCallEvent={type:'started',callId,index:1,...route};await usage.onModelCall(started);
 return {who,claim,callId,usage};
}
async function finish(saved:Awaited<ReturnType<typeof intake>>,status:'complete'|'failed'|'cancelled'|'interrupted'='complete',usage:any={status:'reported',inputTokens:12,outputTokens:4}){
 if(status==='complete')await f.db.withBoundedTransaction(c=>saved.usage.assertAdmitted(c));
 await saved.usage.onModelCall({type:'finished',callId:saved.callId,status,usage});
}
function instrument(change:(sql:string,rows:Record<string,any>[],client:PoolClient)=>void|Promise<void>):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await change(sql,result.rows,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const auditRead=(sql:string)=>sql.includes('FROM platform_safety_model_usage u');
const relayRead=(sql:string)=>sql.includes('FROM platform_model_relay_requests u');
const unused=async(who:FixedSessionContext)=>assert((await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows.every(r=>r.consumed_at===null));
async function savedRows(who:FixedSessionContext){return (await f.db.query('SELECT row_to_json(u)::text AS saved FROM platform_safety_model_usage u WHERE user_id=$1 ORDER BY call_id',[who.userId])).rows;}

test('actual prepared/admitted/terminal safety usage is preserved, including unknown and explicit cache counts',async()=>{
 for(const phase of ['prepared','admitted','complete','failed','cancelled','interrupted'] as const){
  const saved=await intake();if(phase==='admitted')await f.db.withBoundedTransaction(c=>saved.usage.assertAdmitted(c));
  else if(!['prepared','admitted'].includes(phase))await finish(saved,phase as any,phase==='complete'?{status:'reported',inputTokens:12,outputTokens:4,cachedInputTokens:3,cacheWriteInputTokens:2}:{status:phase==='failed'?'invalid':'missing'});
  const before=await savedRows(saved.who),data=await capture(saved.who),record=data.sections.safetyModelUsage[0] as any;
  assert.equal(record.status,phase);assert.equal(record.source.kind,'onboarding');assert.equal(record.source.submissionId,saved.claim.submissionId);assert.equal(record.source.operationId,saved.claim.operationId);
  assert.equal(record.generation,1);assert.equal(record.detectorRevision,7);
  assert.equal(record.inputTokens,phase==='complete'?12:null);assert.equal(record.cachedInputTokens,phase==='complete'?3:null);assert.equal(record.cacheWriteInputTokens,phase==='complete'?2:null);
  assert.equal(record.usageStatus,phase==='complete'?'reported':phase==='failed'?'invalid':phase==='prepared'||phase==='admitted'?'pending':'missing');assert(Object.isFrozen(record.source));assert.deepEqual(await savedRows(saved.who),before);
  for(const secret of [saved.who.tokenHash,saved.claim.leaseToken,'auth_version','authVersion','execution_token','leaseToken',encoded,password])assert(!JSON.stringify(data).includes(secret));
 }
 const zero=await intake();await finish(zero,'complete',{status:'reported',inputTokens:0,outputTokens:0});const record=(await capture(zero.who)).sections.safetyModelUsage[0] as any;
 assert.equal(record.inputTokens,0);assert.equal(record.cachedInputTokens,null);assert.equal(record.cacheWriteInputTokens,null);
});

test('full naming classifier usage is linked to the actual immutable naming submission without exporting execution credentials',async()=>{
 await withPrebirthLoopback(async runtime=>{const g=await createNamingDispatchFixture(runtime);try{
  const input=g.command('Juno'),accepted=await g.naming.accept(g.who,input);
  await g.naming.executeNotification(companionNameNotification({dispatchId:accepted.acceptance.dispatchId,taskId:accepted.acceptance.taskId,submissionId:accepted.acceptance.submissionId}));
  await g.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[g.who.userId,encoded]);
  const token=(await new AccountReauthentication(g.db).verify(g.who,{purpose:'account_export',password})).token;
  const data=await new AccountCoreExport(g.db,g.config).capture(g.who,token),record=data.sections.safetyModelUsage[0] as any;
  assert.equal(record.source.kind,'companion_name');assert.equal(record.source.submissionId,accepted.acceptance.submissionId);assert.equal(record.source.taskId,g.taskId);assert.equal(record.status,'complete');
  const original=(await g.db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1',[g.who.userId])).rows[0];assert(!JSON.stringify(data).includes(original.name_execution_token));assert(!JSON.stringify(data).includes(g.who.tokenHash));
 }finally{await g.close();}});
});

test('memory classifier spending survives real memory deletion without restoring its body or safety source',async()=>{
 const who=await actor(),memories=new SharedMemories(f.db,f.config,FICTIONAL_LEGAL),loop=await createMemorySafetyLoopback(f,memories);
 try{const saved=await memories.mutate(who,'create',null,{operationId:randomUUID(),content:'Synthetic audit-only memory',category:'goal_preference',sensitivity:'normal',usePolicy:'normal',speakerScope:null,validUntil:null});
  await loop.safety.runCurrent(who,saved.memory.id);await memories.mutate(who,'delete',saved.memory.id,{operationId:randomUUID(),expectedRevision:1});
  await new Promise(resolve=>setTimeout(resolve,10100));await purgeExpiredMemoryDeletions(f.db);const calls=loop.bodies.length,data=await capture(who),record=data.sections.safetyModelUsage[0] as any;
  assert.equal(record.source.kind,'shared_memory');assert.equal(record.source.memoryId,saved.memory.id);assert.equal(record.inputTokens,34);assert.deepEqual(data.sections.memories,[]);assert.deepEqual(data.sections.memorySafetySources,[]);assert.equal(loop.bodies.length,calls);
 }finally{await loop.close();}
});

const relayEnv={PLATFORM_CLI_MODEL_RELAY:'1',PLATFORM_ALLOW_PROVIDER_CALLS:'1',OPENAI_API_KEY:'fictional-never-network-key',PLATFORM_CLI_MODEL:'fictional-audit-relay',PLATFORM_CLI_RELAY_MAX_OUTPUT_TOKENS:'256'};
async function relayJob(who:FixedSessionContext){
 const jobId=randomUUID(),leaseToken=randomUUID(),policy=configuredModelRelayPolicy(relayEnv),args={kind:'cli',provider:'cli',prompt:'Synthetic internal task',model:policy.model,options:{},attachmentIds:[],modelProvider:policy.provider,modelRelayLimits:policy};
 await f.db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status,requires_approval,lease_token,lease_until,model,execution_policy) VALUES($1,$2,'cli','cli',$3,'running',true,$4,now()+interval '60 seconds',$5,$6)",[jobId,who.userId,args.prompt,leaseToken,policy.model,JSON.stringify({modelRelay:policy})]);
 await f.db.query("INSERT INTO platform_approvals(id,user_id,job_id,tool_name,generation,status,args) VALUES($1,$2,$3,'cli',1,'approved',$4)",[randomUUID(),who.userId,jobId,JSON.stringify(args)]);
 const bound={jobId,userId:who.userId,generation:1,leaseToken,signal:new AbortController().signal};return {...bound,requestAdmission:new ModelConsent(f.db,FICTIONAL_LEGAL).forJob({...bound,authVersion:'0'})};
}
const success=()=>Response.json({status:'completed',output:[],usage:{input_tokens:16,output_tokens:4}});
const request=()=>({requestId:randomUUID(),body:{input:'Synthetic relay input'},signal:new AbortController().signal});

test('relay successes, rejections and uncertain failures retain separate meanings and original reservations without new execution',async()=>{
 const who=await actor(),binding=await relayJob(who);let calls=0;
 for(const status of ['succeeded','failed','uncertain'] as const){const relay=createJobModelRelay(f.db,binding,{env:relayEnv,fetch:async()=>{calls++;return status==='succeeded'?success():new Response('',{status:status==='failed'?400:503});}});
  if(status==='succeeded')await relay(request());else await assert.rejects(relay(request()));
 }
 // A durable reserved row is visible while the genuine upstream request is pending.
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});
 const live=createJobModelRelay(f.db,binding,{env:relayEnv,fetch:async()=>{calls++;entered();await hold;return success();}})(request());
 try{await waiting;const before=(await f.db.query('SELECT row_to_json(r)::text AS saved FROM platform_model_relay_requests r WHERE user_id=$1 ORDER BY id',[who.userId])).rows;
  const data=await capture(who),records=data.sections.modelRelayRequests as any[];assert.deepEqual(records.map(r=>r.status).sort(),['failed','reserved','succeeded','uncertain']);assert.equal(calls,4);
  for(const record of records){assert.equal(record.jobId,binding.jobId);assert(record.reservedTokens>20);assert.equal(record.inputTokens,record.status==='succeeded'?16:null);assert.equal(record.usageStatus,record.status==='succeeded'?'reported':'not_reported');}
  assert(!JSON.stringify(data).includes(binding.leaseToken));assert(!JSON.stringify(data).includes(relayEnv.OPENAI_API_KEY));assert(!JSON.stringify(data.sections.modelRelayRequests).includes('Synthetic relay input'));
  assert.deepEqual((await f.db.query('SELECT row_to_json(r)::text AS saved FROM platform_model_relay_requests r WHERE user_id=$1 ORDER BY id',[who.userId])).rows,before);
 }finally{release();await live;}
});

test('105 real counted classifier calls and 105 retained relay records cross pages; a different owner stays excluded',async()=>{
 const who=await actor(),foreign=await intake();await finish(foreign);
 for(let n=0;n<105;n++){const saved=await intake(who);await finish(saved);}
 const binding=await relayJob(who);
 // Historical retained-state fixtures; pagination must not submit/retry any of them.
 for(let n=0;n<105;n++)await f.db.query("INSERT INTO platform_model_relay_requests(id,user_id,job_id,generation,request_id,provider,model,reserved_tokens,status) VALUES($1,$2,$3,1,$4,'openai','fictional-audit-relay',100,'reserved')",[randomUUID(),who.userId,binding.jobId,randomUUID()]);
 const sqls:string[]=[],data=await new AccountCoreExport(instrument(sql=>{sqls.push(sql);}),f.config).capture(who,await proof(who));
 assert.equal(data.sections.safetyModelUsage.length,105);assert.equal(data.sections.modelRelayRequests.length,105);assert.equal(sqls.filter(auditRead).length,2);assert.equal(sqls.filter(relayRead).length,2);
 assert(!JSON.stringify(data).includes(foreign.who.userId));assert.equal(data.includedTables.length,143);assert.equal(data.remainingTables.length,23);assert.equal(data.complete,false);
 assert(!sqls.filter(sql=>auditRead(sql)||relayRead(sql)).some(sql=>/FOR (SHARE|UPDATE)/.test(sql)));
});

test('relay references cannot claim a future task generation; original generations remain valid after task advancement',async()=>{
 const who=await actor(),binding=await relayJob(who),key=randomUUID(),token=await proof(who);
 await f.db.query("INSERT INTO platform_model_relay_requests(id,user_id,job_id,generation,request_id,model,reserved_tokens,status) VALUES($1,$2,$3,2,$4,'fictional-audit-relay',100,'reserved')",[key,who.userId,binding.jobId,randomUUID()]);
 await assert.rejects(new AccountCoreExport(f.db,f.config).capture(who,token),{code:'ACCOUNT_MODEL_AUDIT_EXPORT_UNAVAILABLE'});await unused(who);
 await f.db.query('UPDATE platform_jobs SET generation=3 WHERE id=$1',[binding.jobId]);
 const data=await new AccountCoreExport(f.db,f.config).capture(who,token);assert.equal((data.sections.modelRelayRequests[0] as any).generation,2);
});

test('withdrawing current consent and verification does not erase historical usage or reinterpret unknown cache counts',async()=>{
 const saved=await intake();await finish(saved);await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[saved.who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[saved.who.userId]);
 const before=await savedRows(saved.who),data=await capture(saved.who);assert.equal((data.sections.safetyModelUsage[0] as any).cachedInputTokens,null);assert.deepEqual(await savedRows(saved.who),before);
});

test('wrong-owner references and malformed counters/statuses reject the whole capture and retain the reauthentication proof',async()=>{
 const saved=await intake();await finish(saved);const binding=await relayJob(saved.who);await createJobModelRelay(f.db,binding,{env:relayEnv,fetch:async()=>success()})(request());const token=await proof(saved.who);
 const changes:[(sql:string)=>boolean,(row:Record<string,any>)=>void][]=[
  [auditRead,r=>{r.source_owned=false;}],[auditRead,r=>{r.user_id=randomUUID();}],[auditRead,r=>{r.cached_input_tokens=13;}],[auditRead,r=>{r.usage_status='missing';}],
  [auditRead,r=>{r.finished_at=null;}],[auditRead,r=>{r.source_kind='unreviewed';}],
  [relayRead,r=>{r.source_owned=false;}],[relayRead,r=>{r.status='reserved';}],[relayRead,r=>{r.input_tokens=r.reserved_tokens+1;}],[relayRead,r=>{r.request_id='invalid request with space';}],
 ];
 for(const [read,change] of changes){let reached=false;const db=instrument((sql,found)=>{if(read(sql)&&found.length){reached=true;change(found[0]);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(saved.who,token),{code:'ACCOUNT_MODEL_AUDIT_EXPORT_UNAVAILABLE'});assert(reached);await unused(saved.who);
 }
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(saved.who,token)).sections.modelRelayRequests.length,1);
});

test('real cross-owner relay job relation, cancellation, late auth reset and size limits cannot release a partial archive',async()=>{
 const saved=await intake();await finish(saved);const foreign=await actor(),binding=await relayJob(foreign),key=randomUUID(),token=await proof(saved.who);
 // The older relay FK checks job existence, not owner. The archive must check both.
 await f.db.query("INSERT INTO platform_model_relay_requests(id,user_id,job_id,generation,request_id,model,reserved_tokens,status) VALUES($1,$2,$3,1,$4,'fictional-audit-relay',100,'reserved')",[key,saved.who.userId,binding.jobId,randomUUID()]);
 await assert.rejects(new AccountCoreExport(f.db,f.config).capture(saved.who,token),{code:'ACCOUNT_MODEL_AUDIT_EXPORT_UNAVAILABLE'});await unused(saved.who);await f.db.query('DELETE FROM platform_model_relay_requests WHERE id=$1',[key]);
 const abort=new AbortController();await assert.rejects(new AccountCoreExport(instrument(sql=>{if(auditRead(sql))abort.abort(new Error('Synthetic cancellation'));}),f.config).capture(saved.who,token,abort.signal));await unused(saved.who);
 const revoked=instrument(async(sql,_rows,c)=>{if(auditRead(sql))await c.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[saved.who.userId]);});await assert.rejects(new AccountCoreExport(revoked,f.config).capture(saved.who,token));await unused(saved.who);
 await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:1024}).capture(saved.who,token),{code:'ACCOUNT_EXPORT_TOO_LARGE'});await unused(saved.who);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(saved.who,token)).sections.safetyModelUsage.length,1);
});
