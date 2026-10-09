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
import {seedControlledLegacyIntake,assertLegacyIntakeRemainsUnadopted,legacyIntakeRawRows} from './fixtures/legacy-intake.ts';
const base=readConfig(),schema='onboarding_safety_'+randomUUID().replaceAll('-',''),url=new URL(base.databaseUrl);
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.notEqual(url.port,'5442');url.searchParams.set('options','-c search_path='+schema);
const admin=new Database(base.databaseUrl),db=new Database(url.toString()),crypto=readDataCrypto({PLATFORM_DATA_KEY:'79'.repeat(32)})!;
const config={dataCrypto:crypto,requireVerifiedEmail:true},store=new OnboardingDrafts(db,config,FICTIONAL_LEGAL),password='Fictional-onboarding-export-password';let encoded:string,created=false;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await db.migrate();await seedFictionalActiveLegal(db);encoded=await hashPassword(password);});
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
async function counts(who:FixedSessionContext){return (await db.query(`SELECT
 (SELECT count(*)::int FROM platform_onboarding_operations WHERE user_id=$1) AS operations,
 (SELECT count(*)::int FROM platform_onboarding_safety_submissions WHERE user_id=$1) AS submissions,
 (SELECT count(*)::int FROM platform_onboarding_safety_responses WHERE user_id=$1) AS responses,
 (SELECT count(*)::int FROM platform_memories WHERE user_id=$1) AS memories,
 (SELECT count(*)::int FROM platform_conversations WHERE user_id=$1) AS rooms`,[who.userId])).rows[0];}

test('original text, decoded answer and classified result retain their separate meanings and source links in a private owner export',async()=>{
 const p=await typed(),foreign=await typed('Synthetic other account private note.'),claim=await detect(p),current=await store.read(p.who),before=await counts(p.who),token=await proof(p.who);
 const result=await new AccountCoreExport(db,config).capture(p.who,token),draft=result.sections.onboardingDrafts[0] as any,operations=result.sections.onboardingOperations as any[],submissions=result.sections.onboardingSafetySubmissions as any[];
 const {createdAt,...saved}=draft;assert.deepEqual(saved,current);assert.equal(typeof createdAt,'string');assert.equal(draft.answersPartial.study.value.degreeField,'ds_statistics');assert.equal(draft.answersPartial.study.textId,p.input.operationId);
 assert.equal(operations.length,2);assert.deepEqual(operations.find(x=>x.command.operationId===p.input.operationId).command,p.input);assert.equal(submissions.length,1);assert.equal(submissions[0].operationId,p.input.operationId);assert.equal(submissions[0].result.textId,p.input.operationId);assert.equal(submissions[0].result.resolution.kind,'answer');assert.equal(submissions[0].status,'detected');
 assert.equal(result.includedTables.length,47);assert(result.remainingTables.includes('platform_onboarding_safety_responses'));assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);
 const text=JSON.stringify(result);for(const secret of [p.who.tokenHash,foreign.who.userId,foreign.raw,foreign.input.operationId,password,encoded,token,claim.leaseToken,'auth_version','lease_token','execution_token','request_ciphertext','result_ciphertext','payload_ciphertext'])assert(!text.includes(secret));
 assert(Object.isFrozen(draft.answersPartial.study));assert(Object.isFrozen(submissions[0].result));assert.deepEqual(await counts(p.who),before);
});

test('no intake is initialized by export; pending, running and failed detection remain unchanged',async()=>{
 const who=await actor(),empty=await capture(who);assert.deepEqual(empty.sections.onboardingDrafts,[]);assert.deepEqual(empty.sections.onboardingOperations,[]);assert.deepEqual(empty.sections.onboardingSafetySubmissions,[]);
 const p=await typed();let result=await capture(p.who);assert.equal((result.sections.onboardingDrafts[0] as any).state,'safety_pending');assert.equal((result.sections.onboardingSafetySubmissions[0] as any).status,'pending');assert.equal((result.sections.onboardingSafetySubmissions[0] as any).result,null);
 const claim=await store.claimSafety(p.who,{detectorRevision:7});assert(claim);const before=(await db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE id=$1',[claim.submissionId])).rows[0];
 result=await capture(p.who);assert.equal((result.sections.onboardingSafetySubmissions[0] as any).status,'running');assert(!JSON.stringify(result).includes(claim.leaseToken));assert.deepEqual((await db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE id=$1',[claim.submissionId])).rows[0],before);
 await store.failSafety(claim,'timeout');result=await capture(p.who);assert.equal((result.sections.onboardingSafetySubmissions[0] as any).failure,'timeout');assert.equal((result.sections.onboardingSafetySubmissions[0] as any).result,null);
});

test('paused and keyword-only results are archived as recorded, without handling resources or promoting memories',async()=>{
 for(const [level,mode] of [['L1','keyword_only'],['L2','full']] as const){const p=await typed('Synthetic controlled classification fixture.'),claim=await detect(p,level,mode),before=await counts(p.who),result=await capture(p.who);
  assert.equal((result.sections.onboardingDrafts[0] as any).state,'safety_paused');const record=result.sections.onboardingSafetySubmissions[0] as any;assert.equal(record.id,claim.submissionId);assert.equal(record.result.level,level);assert.equal(record.result.mode,mode);assert.equal(record.result.resolution,undefined);assert.deepEqual(await counts(p.who),before);assert.equal(before.memories,0);assert.equal(before.rooms,0);
 }
});

test('replaced pending text is retained across operation and submission pages without truncation or automatic detection',async()=>{
 const p=await typed('Synthetic original pending text 0.'),inputs=[p.input];let draft=p.saved.draft;
 for(let n=1;n<105;n++){const input=command(draft.revision,{kind:'text',questionId:'study',text:`Synthetic replaced pending text ${n}.`});inputs.push(input);draft=(await store.save(p.who,input)).draft;}
 const before=await counts(p.who),queries:string[]=[],database=instrument(sql=>{queries.push(sql);}),result=await new AccountCoreExport(database,config).capture(p.who,await proof(p.who));
 const operations=result.sections.onboardingOperations as any[],submissions=result.sections.onboardingSafetySubmissions as any[];
 assert.equal(operations.length,106);assert.equal(submissions.length,105);assert.deepEqual(operations.filter(x=>x.command.action.kind==='text').map(x=>x.command.operationId).sort(),inputs.map(x=>x.operationId).sort());
 assert(submissions.every(x=>x.status==='pending'&&x.result===null));assert.equal((result.sections.onboardingDrafts[0] as any).pendingText.id,inputs.at(-1)!.operationId);assert.equal(queries.filter(x=>table(x,'operations')).length,2);assert.equal(queries.filter(x=>table(x,'safety_submissions')).length,2);assert.deepEqual(await counts(p.who),before);
});

test('controlled pre-inbox legacy raw input remains exportable without inbox adoption or fabricated safety rows',async()=>{
 const who=await actor(),legacy=await seedControlledLegacyIntake(db,crypto,who.userId,['Synthetic retained legacy A.','Synthetic retained legacy B.']),before=await legacyIntakeRawRows(db,who.userId);
 const result=await capture(who);assert.equal(result.sections.onboardingOperations.length,3);assert.deepEqual(result.sections.onboardingSafetySubmissions,[]);assert.equal((result.sections.onboardingDrafts[0] as any).pendingText.id,legacy.textCommands[1].operationId);
 assert.deepEqual(await legacyIntakeRawRows(db,who.userId),before);await assertLegacyIntakeRemainsUnadopted(db,who.userId);assert.equal((await counts(who)).submissions,0);
});

test('withdrawing model consent and email verification preserves private intake export',async()=>{
 const p=await typed(),before=p.saved.draft;await db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[p.who.userId]);await db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[p.who.userId]);
 const queries:string[]=[],database=instrument(sql=>{queries.push(sql);}),result=await new AccountCoreExport(database,config).capture(p.who,await proof(p.who)),{createdAt,...draft}=result.sections.onboardingDrafts[0] as any;
 assert.deepEqual(draft,before);assert.equal((result.sections.onboardingOperations as any[]).find(x=>x.command.operationId===p.input.operationId).command.action.text,p.raw);
 assert(!queries.filter(sql=>/FROM platform_onboarding_(drafts|operations|safety_submissions)/.test(sql)).some(sql=>/FOR (SHARE|UPDATE)/.test(sql)));
});

test('corrupted or foreign draft, operation and result ciphertext rejects the whole capture and keeps proof available',async()=>{
 const p=await typed(),other=await typed('Synthetic foreign archive input.');await detect(p);await detect(other);const token=await proof(p.who);
 for(const [name,column] of [['drafts','payload_ciphertext'],['operations','request_ciphertext'],['safety_submissions','result_ciphertext']]){
  const foreign=(await db.query(`SELECT * FROM platform_onboarding_${name} WHERE user_id=$1 ORDER BY 1`,[other.who.userId])).rows[0];
  for(const swapped of [false,true]){let reached=false;const database=instrument((sql,rows)=>{if(table(sql,name)&&rows.length){reached=true;rows[0][column]=swapped?foreign[column]:damage(rows[0][column]);}});
   await assert.rejects(new AccountCoreExport(database,config).capture(p.who,token),{code:'ACCOUNT_ONBOARDING_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(p.who),null);
  }
 }
 assert.equal((await new AccountCoreExport(db,config).capture(p.who,token)).sections.onboardingSafetySubmissions.length,1);
});

test('missing or wrongly bound original text and altered result metadata cannot silently detach a saved answer from its input',async()=>{
 const p=await typed();await detect(p);const token=await proof(p.who);
 for(const fault of ['missing','draft','question','level','time']){const database=instrument((sql,rows)=>{
  if(table(sql,'operations')&&rows.length){if(fault==='missing'){const index=rows.findIndex(x=>x.operation_id===p.input.operationId);if(index>=0)rows.splice(index,1);}if(fault==='draft')rows[0].draft_id=randomUUID();}
  if(table(sql,'safety_submissions')&&rows.length){if(fault==='question')rows[0].question_id='roles';if(fault==='level')rows[0].level='L2';}
  if(table(sql,'drafts')&&rows.length&&fault==='time')rows[0].updated_at=new Date(0);
 });await assert.rejects(new AccountCoreExport(database,config).capture(p.who,token),{code:'ACCOUNT_ONBOARDING_EXPORT_UNAVAILABLE'});assert.equal(await consumed(p.who),null);}
 assert.equal((await new AccountCoreExport(db,config).capture(p.who,token)).sections.onboardingOperations.length,2);
});

test('cancellation after original operations are read returns no partial data and does not consume the proof',async()=>{
 const p=await typed(),token=await proof(p.who),controller=new AbortController();let reached=false;const database=instrument(sql=>{if(table(sql,'operations')){reached=true;controller.abort();}});
 await assert.rejects(new AccountCoreExport(database,config).capture(p.who,token,controller.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert(reached);assert.equal(await consumed(p.who),null);
 assert.equal((await new AccountCoreExport(db,config).capture(p.who,token)).sections.onboardingOperations.length,2);
});
