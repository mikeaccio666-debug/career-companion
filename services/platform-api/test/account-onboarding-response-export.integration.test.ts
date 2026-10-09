import {OnboardingSafetyResponses} from '../src/onboarding-safety-responses.ts';
import {OnboardingSafetyFollowup} from '../src/onboarding-safety-followup.ts';
import {fictionalBundle} from './fixtures/onboarding-followup.ts';
import type {OnboardingFollowupAction} from '@companion/platform-contracts';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {OnboardingAction,ProviderRequestAdmission} from '@companion/platform-contracts';
import {Database} from '../src/database.ts';
import {readConfig} from '../src/config.ts';
import {readDataCrypto} from '../src/data-crypto.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {OnboardingDrafts} from '../src/onboarding-drafts.ts';
import {hashPassword,tokenHash,type FixedSessionContext} from '../src/auth.ts';
import {FICTIONAL_LEGAL,seedFictionalActiveLegal,seedFictionalConsent} from './fixtures/student-entry.ts';
const base=readConfig(),schema='onboarding_response_export_'+randomUUID().replaceAll('-',''),url=new URL(base.databaseUrl);
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.notEqual(url.port,'5442');url.searchParams.set('options','-c search_path='+schema);
const admin=new Database(base.databaseUrl),db=new Database(url.toString()),crypto=readDataCrypto({PLATFORM_DATA_KEY:'79'.repeat(32)})!;
const config={dataCrypto:crypto,requireVerifiedEmail:true},store=new OnboardingDrafts(db,config,FICTIONAL_LEGAL),password='Fictional-onboarding-export-password';let encoded:string,created=false;
const bundle=fictionalBundle(),responses=new OnboardingSafetyResponses(db,config,FICTIONAL_LEGAL,bundle),followup=new OnboardingSafetyFollowup(db,config,FICTIONAL_LEGAL);
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await db.migrate();await seedFictionalActiveLegal(db);encoded=await hashPassword(password);const reviewer=await actor();await db.query('INSERT INTO platform_safety_response_policy(singleton,revision,content_digest,review_digest,activated_at,activated_by) VALUES(true,$1,$2,$3,clock_timestamp(),$4)',[bundle.revision,bundle.contentDigest,bundle.reviewDigest,reviewer.userId]);});
after(async()=>{await db.close();try{if(created){await admin.query(`DROP SCHEMA ${schema} CASCADE`);assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0);}}finally{await admin.close();}});
async function actor(){const userId=randomUUID(),hash=tokenHash(randomUUID());await db.query("INSERT INTO platform_users(id,email,name,password_hash,account_kind,email_verified_at) VALUES($1,$2,'Fictional intake export owner',$3,'student',clock_timestamp())",[userId,userId+'@example.invalid',encoded]);await db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[userId,hash]);await seedFictionalConsent(db,userId);return {userId,tokenHash:hash};}
const command=(expectedRevision:number,action:OnboardingAction)=>({expectedRevision,operationId:randomUUID(),action});
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(db).verify(who,{purpose:'account_export',password})).token;
const capture=async(who:FixedSessionContext)=>new AccountCoreExport(db,config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
async function typed(raw='Synthetic original study note.'){const who=await actor(),start=command(0,{kind:'start',mode:'standard'});await store.save(who,start);const input=command(1,{kind:'text',questionId:'study',text:raw}),saved=await store.save(who,input);return {who,input,saved,start,raw};}
async function detect(p:Awaited<ReturnType<typeof typed>>,level:'L0'|'L1'|'L2'='L0',mode:'full'|'keyword_only'='full'){
 const claim=await store.claimSafety(p.who,{detectorRevision:7});assert(claim);
 const decision={level,mode,...(level==='L0'?{resolution:{kind:'answer',questionId:'study',value:{degreeField:'ds_statistics',programChoice:null}}}:{})};
 const result=await store.processSafety(claim,async(input,admission:ProviderRequestAdmission)=>admission(async signal=>{signal.throwIfAborted();assert.equal(input.text,p.raw);return decision;}));assert.equal(result.status,'detected');return claim;
}
function instrument(transform:(sql:string,rows:Record<string,any>[],client:PoolClient)=>void|Promise<void>):Database{
 return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows,target);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }})),options)} as Database;
}
const table=(sql:string,name:string)=>sql.startsWith(`SELECT * FROM platform_onboarding_${name} WHERE user_id=`);
function damage(bytes:Buffer){const copy=Buffer.from(bytes);copy[copy.length-1]^=1;return copy;}

const operation=(revision:number,publicationId:string,action:OnboardingFollowupAction)=>({expectedDraftRevision:revision,publicationId,operationId:randomUUID(),action});
async function published(){const p=await typed(),claim=await detect(p,'L2');await responses.prepareSubmission(claim.submissionId);const state=await followup.read(p.who);assert(state.draft);return {...p,claim,state,publicationId:state.publications[0].publicationId};}
async function completed(clarify=false){
 const p=await published(),revision=p.state.draft!.revision;
 const show=operation(revision,p.publicationId,{kind:'present'}),shown=await followup.act(p.who,show);assert(shown.presentationReceipt);
 const ack=operation(revision,p.publicationId,{kind:'acknowledge',presentationReceipt:shown.presentationReceipt});await followup.act(p.who,ack);
 const finish=operation(revision,p.publicationId,clarify?{kind:'clarify_exaggeration',presentationReceipt:shown.presentationReceipt,safe:true,exaggeration:true}:{kind:'continue_intake',presentationReceipt:shown.presentationReceipt});
 const result=await followup.act(p.who,finish);return {...p,show,shown,ack,finish,result};
}
async function snapshot(who:FixedSessionContext){return db.withBoundedTransaction(async client=>{
 const result:Record<string,unknown>={};for(const name of ['responses','publications','followups'])result[name]=(await client.query(`SELECT * FROM platform_onboarding_safety_${name} WHERE user_id=$1 ORDER BY 1`,[who.userId])).rows;return result;
 });}
const code={code:'ACCOUNT_ONBOARDING_RESPONSE_EXPORT_UNAVAILABLE'};

test('pending, ready and published resources retain their distinct states without creating a read acknowledgment',async()=>{
 const empty=await capture(await actor());assert.deepEqual(empty.sections.onboardingSafetyResponses,[]);assert.deepEqual(empty.sections.onboardingSafetyPublications,[]);assert.deepEqual(empty.sections.onboardingSafetyFollowups,[]);
 for(const [level,mode] of [['L1','keyword_only'],['L2','full']] as const){
  const p=await typed(),claim=await detect(p,level,mode),pending=await capture(p.who);const record=pending.sections.onboardingSafetyResponses[0] as any;
  assert.equal(record.status,'pending');assert.equal(record.response,null);assert.equal(record.preparedEvent,null);assert.deepEqual(pending.sections.onboardingSafetyPublications,[]);
  await responses.prepareSubmission(claim.submissionId);const before=await snapshot(p.who),ready=await capture(p.who),r=ready.sections.onboardingSafetyResponses[0] as any;
  assert.equal(r.status,'ready');assert.equal(r.level,level);assert.equal(r.detectorMode,mode);assert.equal(r.response.resourceCard.contacts.length,level==='L2'?3:1);assert.equal(r.preparedEvent.kind,'response_prepared');
  assert.deepEqual(ready.sections.onboardingSafetyPublications,[]);assert.deepEqual(ready.sections.onboardingSafetyFollowups,[]);assert.deepEqual(await snapshot(p.who),before);
  const state=await followup.read(p.who),exported=await capture(p.who);assert.equal(exported.sections.onboardingSafetyPublications.length,1);assert.deepEqual((exported.sections.onboardingSafetyPublications[0] as any).response,state.publications[0].response);assert.deepEqual(exported.sections.onboardingSafetyFollowups,[]);
 }
});

test('actual presentation, acknowledgment and explicit continuation/clarification history is complete, private and read only',async()=>{
 const foreign=await completed();
 for(const clarify of [false,true]){const p=await completed(clarify),before=await snapshot(p.who),queries:string[]=[],token=await proof(p.who);
  const archive=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),config).capture(p.who,token),records=archive.sections.onboardingSafetyFollowups as any[];
  assert.equal(records.length,3);const last=records.find(x=>x.operationId===p.finish.operationId);assert.equal(last.kind,clarify?'clarify_exaggeration':'continue_intake');assert.equal(last.handled,true);assert.equal(last.resumeStatus,p.result.resumeStatus);
  assert.equal(last.presentationOperationId,p.show.operationId);assert.equal(last.acknowledgmentOperationId,p.ack.operationId);assert.equal(last.safe,clarify?true:undefined);
  assert.equal((archive.sections.onboardingSafetySubmissions[0] as any).level,'L2');assert.equal(archive.sections.memories.length,0);assert.equal(archive.complete,false);assert.equal(archive.includedTables.length,147);
  assert(archive.includedTables.includes('platform_safety_events'));assert(!archive.remainingTables.includes('platform_safety_events'));assert(archive.includedTables.includes('platform_onboarding_safety_v2_publications'));
  const serialized=JSON.stringify(archive);for(const secret of [p.who.tokenHash,foreign.who.userId,foreign.publicationId,p.shown.presentationReceipt!,p.claim.leaseToken,token,password,encoded,'sessionHash','presentationDigest','payload_ciphertext','reviewRef','fictional-contact-integrity-reference'])assert(!serialized.includes(secret),secret);
  assert(Object.isFrozen(last));assert(Object.isFrozen((archive.sections.onboardingSafetyResponses[0] as any).response));assert.deepEqual(await snapshot(p.who),before);
  assert(!queries.some(sql=>/FROM platform_onboarding_safety_(responses|publications|followups)/.test(sql)&&/FOR (UPDATE|SHARE)/.test(sql)));
 }
});

test('past policy, consent and email changes do not change the original captured resource',async()=>{
 const p=await completed(),before=await capture(p.who);await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await db.query('UPDATE platform_users SET email_verified_at=NULL,name=$2 WHERE id=$1',[p.who.userId,'Changed fictional name']);
 await db.query('UPDATE platform_safety_response_policy SET revision=revision+1 WHERE singleton=true');
 try{const result=await capture(p.who);for(const key of ['onboardingSafetyResponses','onboardingSafetyPublications','onboardingSafetyFollowups'] as const)assert.deepEqual(result.sections[key],before.sections[key]);}
 finally{await db.query('UPDATE platform_safety_response_policy SET revision=$1 WHERE singleton=true',[bundle.revision]);}
});

test('retained expired resources and followups remain in the archive without republication',async()=>{
 const p=await completed();const shift=(s:string)=>new Date(new Date(s).getTime()-30*86400000).toISOString();
 await db.withBoundedTransaction(async client=>{
  for(const name of ['responses','publications','followups'])for(const row of (await client.query(`SELECT * FROM platform_onboarding_safety_${name} WHERE user_id=$1`,[p.who.userId])).rows){
   const tableName='platform_onboarding_safety_'+name,key=name==='followups'?'operation_id':'id',context={table:tableName,column:'payload_ciphertext',rowId:row[key],ownerId:p.who.userId,revision:name==='followups'?row.applied_revision:1};
   const saved=JSON.parse(crypto.openUtf8(row.payload_ciphertext,context));for(const key of ['preparedAt','publishedAt','retentionUntil','at','clarifiedAt'])if(saved[key])saved[key]=shift(saved[key]);
   const columns=name==='responses'?['created_at','prepared_at','retention_until']:name==='publications'?['published_at','retention_until']:['created_at','clarified_at'];
   await client.query(`UPDATE ${tableName} SET payload_ciphertext=$2,${columns.map(c=>`${c}=${c}-interval '30 days'`).join(',')} WHERE ${key}=$1`,[row[key],crypto.sealUtf8(JSON.stringify(saved),context)]);
  }
  await client.query("UPDATE platform_safety_events SET created_at=created_at-interval '30 days',retention_until=retention_until-interval '30 days' WHERE user_id=$1",[p.who.userId]);
 });
 const before=await snapshot(p.who),result=await capture(p.who),record=result.sections.onboardingSafetyResponses[0] as any;assert(new Date(record.retentionUntil).getTime()<Date.now());assert.equal(record.status,'ready');assert(record.response);assert.equal(result.sections.onboardingSafetyFollowups.length,3);assert.deepEqual(await snapshot(p.who),before);
});

test('all real presentation operations cross the page boundary without truncation',async()=>{
 const p=await published(),ids:string[]=[];for(let n=0;n<105;n++){const op=operation(p.state.draft!.revision,p.publicationId,{kind:n%2?'need_support':'present'});await followup.act(p.who,op);ids.push(op.operationId);}
 const queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),config).capture(p.who,await proof(p.who));
 assert.deepEqual(result.sections.onboardingSafetyFollowups.map((x:any)=>x.operationId).sort(),ids.sort());assert.equal(queries.filter(sql=>table(sql,'safety_followups')).length,2);assert(result.sections.onboardingSafetyFollowups.every((x:any)=>x.handled===false));
});

test('105 genuine classified sources and prepared publications span all response pages',async()=>{
 const p=await typed();let draft=p.saved.draft;for(let n=1;n<105;n++)draft=(await store.save(p.who,command(draft.revision,{kind:'text',questionId:'study',text:'Synthetic retained signal '+n}))).draft;
 for(let n=0;n<105;n++){const claim=await store.claimSafety(p.who,{detectorRevision:7});assert(claim);await store.processSafety(claim,async(_input,admission)=>admission(async()=>({level:'L1',mode:'keyword_only'})));await responses.prepareSubmission(claim.submissionId);}
 await followup.read(p.who);const queries:string[]=[],result=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),config).capture(p.who,await proof(p.who));
 assert.equal(result.sections.onboardingSafetyResponses.length,105);assert.equal(result.sections.onboardingSafetyPublications.length,105);assert.deepEqual(result.sections.onboardingSafetyFollowups,[]);
 assert.equal(queries.filter(sql=>table(sql,'safety_responses')).length,2);assert.equal(queries.filter(sql=>table(sql,'safety_publications')).length,2);
});

test('damaged or cross-account ciphertext in every new section rejects capture and preserves the password proof',async()=>{
 const p=await completed(),other=await completed(),token=await proof(p.who);
 for(const name of ['responses','publications','followups']){const foreign=(await db.query(`SELECT * FROM platform_onboarding_safety_${name} WHERE user_id=$1`,[other.who.userId])).rows[0];
  for(const swap of [false,true]){let reached=false;const database=instrument((sql,rows)=>{if(table(sql,'safety_'+name)&&rows.length){reached=true;rows[0].payload_ciphertext=swap?foreign.payload_ciphertext:damage(rows[0].payload_ciphertext);}});
   await assert.rejects(new AccountCoreExport(database,config).capture(p.who,token),code);assert(reached);assert.equal(await consumed(p.who),null);
  }
 }assert.equal((await new AccountCoreExport(db,config).capture(p.who,token)).sections.onboardingSafetyFollowups.length,3);
});

test('missing response, event, publication or presentation breaks the original chain instead of synthesizing history',async()=>{
 const p=await completed(),token=await proof(p.who);
 for(const fault of ['response','event','publication','presentation','event_owner','source_generation']){let reached=false;const database=instrument((sql,rows)=>{
  if((fault==='response'||fault==='source_generation')&&table(sql,'safety_responses')&&rows.length){reached=true;if(fault==='response')rows.splice(0);else rows[0].source_generation++;}
  if((fault==='event'||fault==='event_owner')&&sql.includes('FROM platform_safety_events WHERE response_id=')&&rows.length){reached=true;if(fault==='event')rows.splice(0);else rows[0].user_id=randomUUID();}
  if(fault==='publication'&&table(sql,'safety_publications')){reached=true;rows.splice(0);}
  if(fault==='presentation'&&table(sql,'safety_followups')){reached=true;const i=rows.findIndex(x=>x.action_kind==='present');if(i>=0)rows.splice(i,1);}
 });await assert.rejects(new AccountCoreExport(database,config).capture(p.who,token),code);assert(reached);assert.equal(await consumed(p.who),null);}
});

test('authentic but inconsistent publication content and cross-session followups cannot pass source validation',async()=>{
 const p=await completed(),token=await proof(p.who);
 for(const fault of ['projection','session']){let reached=false;const database=instrument((sql,rows)=>{
  const name=fault==='projection'?'publications':'followups';if(!table(sql,'safety_'+name)||!rows.length)return;
  const row=fault==='session'?rows.find(x=>x.action_kind==='continue_intake'):rows[0];if(!row)return;reached=true;
  const context={table:'platform_onboarding_safety_'+name,column:'payload_ciphertext',rowId:row[fault==='session'?'operation_id':'id'],ownerId:p.who.userId,revision:fault==='session'?row.applied_revision:1};
  const saved=JSON.parse(crypto.openUtf8(row.payload_ciphertext,context));if(fault==='session'){row.session_hash='ab'.repeat(32);saved.sessionHash=row.session_hash;}else{saved.response.text='Synthetic replacement of original response.';}
  row.payload_ciphertext=crypto.sealUtf8(JSON.stringify(saved),context);
 });await assert.rejects(new AccountCoreExport(database,config).capture(p.who,token),code);assert(reached);assert.equal(await consumed(p.who),null);}
});

test('late session revocation, cancellation and capacity overflow return no partial archive and roll back proof use',async()=>{
 for(const fault of ['auth','cancel','capacity']){const p=await completed(),token=await proof(p.who),controller=new AbortController();let reached=false;
  const database=instrument(async(sql,rows,client)=>{if(table(sql,'safety_followups')&&rows.length&&!reached){reached=true;if(fault==='auth')await client.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[p.who.userId]);if(fault==='cancel')controller.abort();}});
  await assert.rejects(new AccountCoreExport(database,config,fault==='capacity'?{maxBytes:1024}:{}).capture(p.who,token,controller.signal),{code:fault==='auth'?'AUTH_REQUIRED':fault==='cancel'?'ACCOUNT_EXPORT_CANCELLED':'ACCOUNT_EXPORT_TOO_LARGE'});
  if(fault!=='capacity')assert(reached);assert.equal(await consumed(p.who),null);assert.equal((await new AccountCoreExport(db,config).capture(p.who,token)).sections.onboardingSafetyFollowups.length,3);
 }
});
