import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import type {FixedSessionContext} from '../src/auth.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import { MentorRatings } from '../src/mentor-ratings.ts';
import { MentorPayments } from '../src/mentor-payments.ts';
import { readMentorOrder } from '../../../apps/web/src/mentor-intent-api.ts';
import { readMentorRating,changeMentorRating } from '../../../apps/web/src/mentor-rating-api.ts';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,chmod,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MENTOR_CONDUCT_VERSION,MENTOR_INTENT_PRIVACY_VERSION,PLATFORM_ACCOUNT_HEADER,parseMentorMatchCommand,parseMentorSchedulingCommand,parseMentorRatingCommand } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { MentorCapacity } from '../src/mentor-capacity.ts';
import { MentorIntents } from '../src/mentor-intents.ts';
import { MentorServiceOffers } from '../src/mentor-service-offers.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword,tokenHash } from '../src/auth.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,dir:string,blobs:LocalBlobStorage,capacity:MentorCapacity,offers:MentorServiceOffers,calls=0;
const error=(code:string)=>(e:unknown)=>!!e&&typeof e==='object'&&(e as {code?:string}).code===code;
before(async()=>{f=await createCompanionNameSafetyFixture();dir=await mkdtemp(join(tmpdir(),'fictional-mentor-quotes-'));await chmod(dir,0o700);
 blobs=new LocalBlobStorage(dir);capacity=new MentorCapacity(f.db,f.config,FICTIONAL_LEGAL,blobs);offers=new MentorServiceOffers(f.db,f.config,FICTIONAL_LEGAL,blobs);});
after(async()=>{assert.equal(calls,0);await f?.close();if(dir)await rm(dir,{recursive:true,force:true});});
let fixtureStarts:string,fixtureEnds:string;
async function setup(){
 const org=randomUUID(),operator=await f.actor(true),mentor=await f.actor(true),owner=await f.actor(),ref=randomUUID();
 await f.db.query("INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,'Fictional quote organization')",[org,'quote_'+org.replaceAll('-','')]);
 for(const [who,role] of [[operator,'ops'],[mentor,'mentor']] as const)await f.db.query('INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)',[org,who.userId,role,operator.userId]);
 const bytes=Buffer.from('Fictional signed and reviewed evidence; no production approval.');await blobs.put(ref,bytes);
 await f.db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'fictional.txt','text/plain',$3,$4)",[ref,operator.userId,bytes.length,ref]);
 const profile={operationId:randomUUID(),recordId:randomUUID(),expectedRevision:0,mentorId:mentor.userId,displayName:'Fictional mentor',timeZone:'America/New_York',
  languages:['en','zh'],services:['resume_direction','mock_interview'],signedAt:'2026-01-01T00:00:00.000Z',conductVersion:MENTOR_CONDUCT_VERSION,
  agreementEvidenceRef:ref,confirmSignedConduct:true,confirmConfidentiality:true,confirmEmployerPolicy:true};
 const slot={operationId:randomUUID(),recordId:randomUUID(),expectedRevision:0,profileId:profile.recordId,profileRevision:1,service:'resume_direction',
  startsAt:fixtureStarts,endsAt:fixtureEnds,timeZone:'America/New_York',confirmedAt:'2026-01-01T00:00:00.000Z',confirmationEvidenceRef:ref,confirmWithMentor:true};
 const source={operationId:randomUUID(),offerId:randomUUID(),expectedRevision:0,reviewedAt:'2026-01-01T00:00:00.000Z',reviewEvidenceRef:ref,
  terms:{kind:'resume_direction',title:'Fictional resume discussion',durationMin:45,priceCents:9900,currency:'USD',collector:'Fictional collector',
   description:'Fictional resume evidence discussion.',exclusions:'No outcomes or referral promised.',refundVersion:'fictional-1',refundRules:'Original fictional refund rule.',
   appealInstructions:'Original fictional appeal channel.',disclosureVersion:'fictional-1',disclosure:'Original fictional relationship.',
   validFrom:'2025-01-01T00:00:00.000Z',validUntil:'2028-01-01T00:00:00.000Z',earliestSlotAt:new Date(Date.parse(fixtureStarts)-60000).toISOString()}};
 await capacity.setProfile(operator,org,profile);await capacity.setSlot(operator,org,slot);await offers.set(operator,org,source);
 const config={...f.config,mentorOrganizationId:org},service=new MentorIntents(f.db,config,FICTIONAL_LEGAL,offers,undefined,capacity,blobs);
 const command={operationId:randomUUID(),offerId:source.offerId,offerRevision:1,contactName:'Fictional student',intentNote:'Discuss a fictional IBM class report.',privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,confirmVisibility:true};
 const intent=await service.create(owner,command),match={operationId:randomUUID(),sessionId:intent.session.id,expectedRevision:1,slotId:slot.recordId,slotRevision:1,priceCents:9500};
 return {org,operator,mentor,owner,ref,profile,slot,source,config,service,command,intent,match};
}
async function match(s:Awaited<ReturnType<typeof setup>>){return s.service.match(s.operator,s.org,s.match);}
async function historical(){
 const now=(await f.db.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
 const past=new Date(now.getTime()-3*3600000);fixtureStarts=new Date(now.getTime()-2*3600000).toISOString();fixtureEnds=new Date(now.getTime()-75*60000).toISOString();
 const real=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);intercept.query=async(...args:any[])=>{
  const x=await(query as any)(...args);if(args[0]==='SELECT clock_timestamp() AS at')x.rows[0].at=past;return x;};return run(intercept);});
 let s!:Awaited<ReturnType<typeof setup>>;
 try{s=await setup();await match(s);await s.service.recordSchedule(s.operator,s.org,{action:'schedule',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:2,
  confirmedAt:past.toISOString(),meetingUrl:'https://meet.google.com/fictional-completed',userConfirmationRef:s.ref,mentorConfirmationRef:s.ref,confirmWithUser:true,confirmWithMentor:true});}
 finally{f.db.withBoundedTransaction=real;}
 const complete={action:'complete',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:3,completedAt:s.slot.endsAt,evidenceRef:s.ref,confirmRecorded:true};
 return {...s,complete,ratings:new MentorRatings(f.db,s.config,FICTIONAL_LEGAL,s.service)};
}
async function completed(){const s=await historical();await s.service.recordSchedule(s.operator,s.org,s.complete);return s;}
const rating=()=>({operationId:randomUUID(),action:'rate' as const,score:4,comment:'Fictional private feedback.'});
test('actual elapsed completion is evidence-backed, audited, encrypted and independent from payment; original schedule/match replays return current completion',async()=>{
 const s=await historical(),x=await s.service.recordSchedule(s.operator,s.org,s.complete);assert.equal(x.status,'completed');assert.equal(x.revision,4);
 const pair=await s.service.getOrder(s.owner,s.intent.session.id);assert.equal(pair.session.completedAt,s.slot.endsAt);assert.equal(pair.order.status,'quoted');assert.equal(pair.order.revision,1);
 assert.equal((await s.service.match(s.operator,s.org,s.match)).status,'completed');assert.equal((await s.service.create(s.owner,s.command)).session.status,'completed');
 const rs=await Promise.all([s.service.recordSchedule(s.operator,s.org,s.complete),s.service.recordSchedule(s.operator,s.org,s.complete)]);assert(rs.every(r=>r.replayed));
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_mentor_intent_operations WHERE session_id=$1 AND action='complete'",[pair.session.id])).rows[0].n,1);
 assert(!JSON.stringify(pair).includes('confirmationEvidence'));assert(!JSON.stringify(x).includes(s.ref));
 const client={account:{accountId:s.owner.userId},isCurrent:()=>true,async request<T>():Promise<T>{return pair as T;}};assert.equal((await readMentorOrder(client,pair.session.id)).session.status,'completed');
});
test('future or early completion, absent/foreign evidence, wrong phase, owner or operator identity cannot create completed state',async()=>{
 const s=await historical();for(const patch of [{completedAt:s.slot.startsAt},{completedAt:'2030-01-01T00:00:00.000Z'},{evidenceRef:randomUUID()},{expectedRevision:2}])
  await assert.rejects(s.service.recordSchedule(s.operator,s.org,{...s.complete,...patch}));
 await assert.rejects(s.service.recordSchedule(s.owner,s.org,s.complete),error('STAFF_ROLE_REQUIRED'));
 const outsider=await f.actor(true);await assert.rejects(s.service.recordSchedule(outsider,s.org,s.complete),error('STAFF_ROLE_REQUIRED'));
 assert.equal((await s.service.get(s.owner,s.intent.session.id)).status,'scheduled');
 for(const patch of [{ownerId:s.owner.userId},{score:5},{paymentRef:'fake'},{confirmRecorded:false}])assert.throws(()=>parseMentorSchedulingCommand({...s.complete,...patch}));
});
test('completion audit failure and abort after actual state update roll back the completed receipt and keep scheduled state',async()=>{
 const s=await historical();await f.db.query("CREATE FUNCTION reject_completion_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='mentor_schedule_recorded' THEN RAISE EXCEPTION 'Fictional audit failure'; END IF; RETURN NEW; END $$");
 await f.db.query('CREATE TRIGGER reject_completion_audit BEFORE INSERT ON platform_staff_audit FOR EACH ROW EXECUTE FUNCTION reject_completion_audit()');
 try{await assert.rejects(s.service.recordSchedule(s.operator,s.org,s.complete));}finally{await f.db.query('DROP TRIGGER reject_completion_audit ON platform_staff_audit');await f.db.query('DROP FUNCTION reject_completion_audit()');}
 const controller=new AbortController(),real=f.db.withBoundedTransaction.bind(f.db);let entered=false;
 f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);intercept.query=async(...args:any[])=>{const x=await(query as any)(...args);
  if(typeof args[0]==='string'&&args[0].startsWith('UPDATE platform_mentor_sessions SET status=$3,scheduled_at=')){entered=true;controller.abort();}return x;};return run(intercept);});
 try{await assert.rejects(s.service.recordSchedule(s.operator,s.org,s.complete,controller.signal));assert(entered);}finally{f.db.withBoundedTransaction=real;}
 assert.equal((await s.service.get(s.owner,s.intent.session.id)).status,'scheduled');assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_mentor_intent_operations WHERE session_id=$1 AND action='complete'",[s.intent.session.id])).rows[0].n,0);
});
test('historical mentor withdrawal does not erase completed fulfillment or block the real late receipt/refund against its accepted quote',async()=>{
 const s=await completed();await capacity.withdraw(s.operator,s.org,{operationId:randomUUID(),recordId:s.profile.recordId,expectedRevision:1,reason:'Fictional post-session withdrawal'});
 const p=new MentorPayments(f.db,{...s.config,mentorRetentionDays:365,mentorRetentionEvidenceRef:s.ref},s.service,offers,capacity,blobs);
 const pay={action:'pay',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:1,amountCents:9500,externalRef:'Fictional_late_'+randomUUID(),occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true};
 await p.record(s.operator,s.org,pay);const pair=await s.service.getOrder(s.owner,s.intent.session.id);assert.equal(pair.session.status,'completed');assert.equal(pair.order.status,'paid');
 await p.record(s.operator,s.org,{...pay,action:'refund',operationId:randomUUID(),expectedRevision:2,externalRef:'Fictional_refund_'+randomUUID(),occurredAt:new Date().toISOString()});
 assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).order.status,'refunded_full');
 await assert.rejects(s.service.recordSchedule(s.operator,s.org,{action:'cancel_scheduled',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:3,occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true}),error('MENTOR_INTENT_REVISION_CHANGED'));
});
test('rating can only follow actual completed service; no staff, foreign owner or lifecycle bypass can rate it',async()=>{
 const s=await historical();await assert.rejects(s.ratings.get(s.owner,s.intent.session.id),error('MENTOR_RATING_UNAVAILABLE'));
 await assert.rejects(s.ratings.decide(s.owner,s.intent.session.id,rating()),error('MENTOR_RATING_UNAVAILABLE'));await s.service.recordSchedule(s.operator,s.org,s.complete);
 const other=await f.actor();await assert.rejects(s.ratings.get(other,s.intent.session.id),error('NOT_FOUND'));
 await assert.rejects(s.ratings.decide(s.operator,s.intent.session.id,rating()),error('STUDENT_ACCOUNT_REQUIRED'));assert.equal((await s.ratings.get(s.owner,s.intent.session.id)).rating,null);
});
test('single encrypted score/comment decision has one concurrent effect, original replay and observation; different input cannot edit or replace it',async()=>{
 const s=await completed(),cmd=rating(),rs=await Promise.all([s.ratings.decide(s.owner,s.intent.session.id,cmd),s.ratings.decide(s.owner,s.intent.session.id,cmd)]);assert.equal(rs.filter(r=>r.operation.replayed).length,1);
 const saved=await s.ratings.get(s.owner,s.intent.session.id);assert.equal(saved.rating?.score,4);assert.equal(saved.rating?.comment,cmd.comment);
 const row=(await f.db.query('SELECT * FROM platform_mentor_ratings WHERE session_id=$1',[s.intent.session.id])).rows[0];assert(!row.payload_ciphertext.includes(Buffer.from(cmd.comment)));assert(!('score' in row));assert(!('comment' in row));
 await assert.rejects(s.ratings.decide(s.owner,s.intent.session.id,{...cmd,score:5}),error('MENTOR_RATING_ALREADY_RECORDED'));
 await assert.rejects(s.ratings.decide(s.owner,s.intent.session.id,{operationId:randomUUID(),action:'skip'}),error('MENTOR_RATING_ALREADY_RECORDED'));
 assert.equal((await s.ratings.observe(s.owner,s.intent.session.id,cmd.operationId)).operation.replayed,true);await assert.rejects(s.ratings.observe(s.owner,s.intent.session.id,randomUUID()),error('NOT_FOUND'));
 assert.equal((await s.service.get(s.owner,s.intent.session.id)).revision,4);
});
test('skipping is a persisted single owner choice across reloads, not an inferred zero score; closed fields and getters reject hidden data',async()=>{
 const s=await completed(),cmd={operationId:randomUUID(),action:'skip'};const x=await s.ratings.decide(s.owner,s.intent.session.id,cmd);
 assert.equal(x.rating.score,null);assert.equal(x.rating.comment,null);assert.equal((await s.ratings.get(s.owner,s.intent.session.id)).rating?.action,'skip');
 for(const input of [{...rating(),score:0},{...rating(),score:6},{...rating(),comment:'Two\nlines'},{...rating(),comment:'x'.repeat(501)},
  {...cmd,score:1},{...cmd,comment:'fake'},{...rating(),ownerId:s.owner.userId},{...rating(),visibility:'public'}])assert.throws(()=>parseMentorRatingCommand(input));
 let getters=0;const bad={...rating()};Object.defineProperty(bad,'score',{get(){getters++;return 5;},enumerable:true});assert.throws(()=>parseMentorRatingCommand(bad));assert.equal(getters,0);
});
test('rating insert abort or database failure does not consume the one-time decision; final real session/legal revalidation denies writes',async()=>{
 const s=await completed(),controller=new AbortController(),real=f.db.withBoundedTransaction.bind(f.db);let entered=false;
 f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);intercept.query=async(...args:any[])=>{const x=await(query as any)(...args);
  if(typeof args[0]==='string'&&args[0].startsWith('INSERT INTO platform_mentor_ratings(')){entered=true;controller.abort();}return x;};return run(intercept);});
 try{await assert.rejects(s.ratings.decide(s.owner,s.intent.session.id,rating(),controller.signal));assert(entered);}finally{f.db.withBoundedTransaction=real;}
 assert.equal((await s.ratings.get(s.owner,s.intent.session.id)).rating,null);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[s.owner.userId]);await assert.rejects(s.ratings.decide(s.owner,s.intent.session.id,rating()),error('TERMS_CONFIRMATION_REQUIRED'));
});
test('immutable rating refuses physical change/deletion; account deletion clears private feedback',async()=>{
 const s=await completed();await s.ratings.decide(s.owner,s.intent.session.id,rating());
 await assert.rejects(f.db.query('UPDATE platform_mentor_ratings SET operation_id=$2 WHERE session_id=$1',[s.intent.session.id,randomUUID()]));
 await assert.rejects(f.db.query('DELETE FROM platform_mentor_ratings WHERE session_id=$1',[s.intent.session.id]));
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[s.owner.userId]);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_ratings WHERE session_id=$1',[s.intent.session.id])).rows[0].n,0);
});
test('actual password-cookie HTTP and Web feedback client keep owner binding, original receipt recovery and private caching; no public ratings or completion issuer',async()=>{
 const s=await completed(),origin='https://fictional-completion.example.invalid',password='Fictional-completion-password-123';
 const system=await buildApp({db:f.db,storage:blobs,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),...s.config,allowedOrigins:new Set([origin]),workbenchEnabled:false},enableQueue:false,
  runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No external model');}})});
 try{await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[s.owner.userId,await hashPassword(password)]);
  const login=await system.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:s.owner.userId+'@example.invalid',password}});assert.equal(login.statusCode,200,login.body);
  const cookies=login.headers['set-cookie'],cookie=(Array.isArray(cookies)?cookies[0]:cookies)!.split(';')[0],headers={origin,cookie,[PLATFORM_ACCOUNT_HEADER]:s.owner.userId};
  const client={account:{accountId:s.owner.userId},isCurrent:()=>true,request:async(path:string,init?:RequestInit)=>{const x=await system.app.inject({method:(init?.method??'GET') as any,url:'/api/platform'+path,headers,payload:init?.body?JSON.parse(init.body as string):undefined});assert.equal(x.statusCode,200,x.body);assert.equal(x.headers['cache-control'],'private, no-store');return x.json();}};
  assert.equal((await readMentorRating(client,s.intent.session.id)).rating,null);const cmd=rating();assert.equal((await changeMentorRating(client,s.intent.session.id,cmd)).rating?.score,4);
  assert.equal((await changeMentorRating(client,s.intent.session.id,cmd,true)).operation?.replayed,true);
  const again=await system.app.inject({method:'POST',url:'/api/platform/career/mentor-intents/'+s.intent.session.id+'/rating',headers,payload:rating()});assert.equal(again.statusCode,409);assert.equal(again.json().error.code,'MENTOR_RATING_ALREADY_RECORDED');
  assert.equal((await system.app.inject({url:'/api/platform/career/mentor-intents/'+s.intent.session.id+'/rating?visibility=public',headers})).statusCode,400);
  assert.equal((await system.app.inject({method:'POST',url:'/api/platform/career/mentor-intents/'+s.intent.session.id+'/complete',headers,payload:s.complete})).statusCode,404);
  const ops=await s.service.opsList(s.operator,s.org);assert(!JSON.stringify(ops).includes(cmd.comment));assert(!JSON.stringify(ops).includes('score'));
 }finally{await system.app.close();}
});
test('completion and feedback migration rerun preserves actual completed records and one-time private decision',async()=>{
 const s=await completed();await s.ratings.decide(s.owner,s.intent.session.id,{operationId:randomUUID(),action:'skip'});
 const {readFile}=await import('node:fs/promises');await f.db.query(await readFile(new URL('../migrations/073_mentor_completion_ratings.sql',import.meta.url),'utf8'));
 assert.equal((await s.service.get(s.owner,s.intent.session.id)).status,'completed');assert.equal((await s.ratings.get(s.owner,s.intent.session.id)).rating?.action,'skip');
});

test('malformed or substituted encrypted feedback cannot turn into a confirmed score or eligible empty prompt',async()=>{
 const s=await completed();await f.db.query('INSERT INTO platform_mentor_ratings(session_id,user_id,org_id,operation_id,created_at,payload_ciphertext) VALUES($1,$2,$3,$4,clock_timestamp(),$5)',
  [s.intent.session.id,s.owner.userId,s.org,randomUUID(),Buffer.from('Fictional invalid authenticated ciphertext')]);
 await assert.rejects(s.ratings.get(s.owner,s.intent.session.id),error('MENTOR_RATING_STORAGE_UNAVAILABLE'));
 await assert.rejects(s.ratings.decide(s.owner,s.intent.session.id,rating()),error('MENTOR_RATING_STORAGE_UNAVAILABLE'));
});

test('actual completion CLI requires private operator files/session and historical fulfillment evidence; prints no meeting, token or evidence',async()=>{
 const s=await historical(),token=randomUUID()+randomUUID(),url=new URL(readConfig().databaseUrl);url.searchParams.set('options','-c search_path='+f.schema);
 await f.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[s.operator.userId,tokenHash(token)]);
 const legal=join(dir,randomUUID()+'.json'),input=join(dir,randomUUID()+'.json'),credentials=join(dir,randomUUID()+'.json');
 await writeFile(legal,JSON.stringify(FICTIONAL_LEGAL),{mode:0o600});await writeFile(credentials,JSON.stringify({userId:s.operator.userId,token}),{mode:0o600});await writeFile(input,JSON.stringify(s.complete),{mode:0o600});
 const env={...process.env,PLATFORM_DATABASE_URL:url.toString(),PLATFORM_STORAGE_DIR:dir,PLATFORM_DATA_KEY:'e5'.repeat(32),PLATFORM_MENTOR_ORG_ID:s.org,PLATFORM_LEGAL_BUNDLE_FILE:legal,PLATFORM_ALLOW_PROVIDER_CALLS:'0'};
 const run=()=>promisify(execFile)(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/mentor-scheduling-main.ts',import.meta.url)),'record','--org',s.org,'--session-file',credentials,'--input-file',input],{env,timeout:10000,maxBuffer:4096});
 const x=await run();assert.equal(JSON.parse(x.stdout).status,'completed');assert.equal(x.stderr,'');for(const v of [token,s.ref,s.command.intentNote,'meetingUrl','confirmationEvidence'])assert(!x.stdout.includes(v));
 assert.equal(JSON.parse((await run()).stdout).replayed,true);await chmod(input,0o644);await assert.rejects(run());
});
test('real student session expiry after feedback INSERT rolls back the decision instead of leaving an unconfirmed accepted score',async()=>{
 const s=await completed(),real=f.db.withBoundedTransaction.bind(f.db);let entered=false;
 f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);intercept.query=async(...args:any[])=>{const x=await(query as any)(...args);
  if(typeof args[0]==='string'&&args[0].startsWith('INSERT INTO platform_mentor_ratings(')){entered=true;await query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[s.owner.tokenHash]);}return x;};return run(intercept);});
 try{await assert.rejects(s.ratings.decide(s.owner,s.intent.session.id,rating()),error('AUTH_REQUIRED'));assert(entered);}finally{f.db.withBoundedTransaction=real;}
 assert.equal((await s.ratings.get(s.owner,s.intent.session.id)).rating,null);
});

const exportPassword='Fictional-mentor-export-password';
async function exportProof(who:FixedSessionContext){
 await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(exportPassword)]);
 return (await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password:exportPassword})).token;
}
const archive=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await exportProof(who));
const exportConsumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
function exportDb(transform:(sql:string,rows:Record<string,any>[])=>void|Promise<void>):Database{return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const exportSessions=(sql:string)=>sql.startsWith('SELECT id,user_id,org_id,offer_id,offer_revision,kind,duration_min,status');
const exportOperations=(sql:string)=>sql.startsWith('SELECT user_id,org_id,operation_id,session_id,action,applied_revision,created_at,receipt_ciphertext');
const exportRatings=(sql:string)=>sql.startsWith('SELECT session_id,user_id,org_id,operation_id,created_at,payload_ciphertext');
async function mentorSnapshot(who:FixedSessionContext){
 const rows:Record<string,unknown>={};for(const name of ['sessions','intent_operations','ratings','orders','order_proofs','slot_reservations','reservation_proofs'])
  rows[name]=(await f.db.query(`SELECT row_to_json(t)::text AS value FROM platform_mentor_${name} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`,[who.userId])).rows;
 return rows;
}
async function futureIntent(){const now=Date.now();fixtureStarts=new Date(now+3*3600000).toISOString();fixtureEnds=new Date(now+4*3600000).toISOString();return setup();}

test('account archive preserves actual completed service, original offer and private rating without staff identity or evidence',async context=>{
 const s=await completed(),rated=await s.ratings.decide(s.owner,s.intent.session.id,rating()),pair=await s.service.getOrder(s.owner,s.intent.session.id),other=await completed();
 context.mock.method(globalThis,'fetch',async()=>{throw Error('No external requests');});
 const before=await mentorSnapshot(s.owner),queries:string[]=[],result=await new AccountCoreExport(exportDb(sql=>{queries.push(sql);}),f.config).capture(s.owner,await exportProof(s.owner));
 const session=result.sections.mentorSessions[0] as any,ops=result.sections.mentorIntentOperations as any[];
 assert.equal(result.sections.mentorSessions.length,1);assert.equal(session.intentNote,s.command.intentNote);assert.equal(session.contactName,s.command.contactName);assert.equal(session.contactEmail,s.owner.userId+'@example.invalid');
 assert.equal(session.status,'completed');assert.equal(session.completedAt,s.slot.endsAt);assert.equal(session.assignment.mentorDisplayName,'Fictional mentor');assert.equal(session.scheduled.meetingUrl,'https://meet.google.com/fictional-completed');
 assert.deepEqual(ops.map(x=>x.action).sort(),['complete','create','match','schedule']);assert.equal(ops.find(x=>x.action==='create').acceptedOffer.refundRules,s.source.terms.refundRules);assert.equal(ops.find(x=>x.action==='match').command.priceCents,9500);
 assert.deepEqual(result.sections.mentorRatings,[rated.rating]);assert.deepEqual(await mentorSnapshot(s.owner),before);
 for(const secret of [s.operator.userId,s.mentor.userId,s.ref,s.profile.recordId,s.slot.recordId,other.owner.userId,other.intent.session.id,pair.order.handoffCode!,s.owner.tokenHash,exportPassword])assert(!JSON.stringify(result).includes(secret));
 assert(!queries.some(sql=>/\b(?:FROM|JOIN)\s+platform_mentor_capacity_(?:records|proofs)\b/i.test(sql)));
 assert(!queries.some(sql=>/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+platform_mentor_/i.test(sql)));
 assert(Object.isFrozen(session.assignment));assert.equal(result.includedTables.length,100);assert.equal(result.remainingTables.length,64);assert(result.includedTables.includes('platform_mentor_orders'));assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);
});

test('all saved intent phases and both cancellation routes retain their own original operation histories',async()=>{
 for(const state of ['requested','matched','cancelled_requested','cancelled_matched','scheduled','cancelled_scheduled']){
  const s=state==='scheduled'||state==='cancelled_scheduled'?await historical():await futureIntent();
  if(state==='matched'||state==='cancelled_matched')await match(s);
  if(state==='cancelled_requested'||state==='cancelled_matched')await s.service.cancel(s.owner,s.intent.session.id,{operationId:randomUUID(),expectedRevision:state==='cancelled_requested'?1:2});
  if(state==='cancelled_scheduled')await s.service.recordSchedule(s.operator,s.org,{action:'cancel_scheduled',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:3,occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true});
  const before=await mentorSnapshot(s.owner),data=await archive(s.owner),session=data.sections.mentorSessions[0] as any;
  assert.equal(session.status,state.startsWith('cancelled')?'cancelled':state);assert.equal(data.sections.mentorIntentOperations.length,session.revision);assert.deepEqual(data.sections.mentorRatings,[]);assert.deepEqual(await mentorSnapshot(s.owner),before);
  assert(!JSON.stringify(data).includes(s.ref));assert(!JSON.stringify(data).includes(s.operator.userId));
 }
});

test('catalog withdrawal, revoked staff membership, changed email and withdrawn model terms do not erase owner history or skipped ratings',async()=>{
 const s=await completed(),skip=await s.ratings.decide(s.owner,s.intent.session.id,{operationId:randomUUID(),action:'skip'});
 await capacity.withdraw(s.operator,s.org,{operationId:randomUUID(),recordId:s.profile.recordId,expectedRevision:1,reason:'Fictional historical withdrawal'});
 await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=now() WHERE org_id=$1",[s.org]);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[s.owner.userId]);await f.db.query("UPDATE platform_users SET email=$2,email_verified_at=NULL WHERE id=$1",[s.owner.userId,randomUUID()+'@example.invalid']);
 const before=await mentorSnapshot(s.owner),data=await archive(s.owner);assert.deepEqual(data.sections.mentorRatings,[skip.rating]);assert.equal((data.sections.mentorRatings[0] as any).score,null);
 assert.equal((data.sections.mentorSessions[0] as any).contactEmail,s.owner.userId+'@example.invalid');assert.deepEqual(await mentorSnapshot(s.owner),before);
});

test('105 actual owner intents cross both session and operation pages without normal list limits',async()=>{
 const s=await futureIntent(),ids=[s.intent.session.id];for(let i=1;i<105;i++)ids.push((await s.service.create(s.owner,{...s.command,operationId:randomUUID(),intentNote:'Fictional intent '+i})).session.id);
 const queries:string[]=[],result=await new AccountCoreExport(exportDb(sql=>{queries.push(sql);}),f.config).capture(s.owner,await exportProof(s.owner));
 assert.deepEqual((result.sections.mentorSessions as any[]).map(r=>r.id),ids.sort());assert.equal(result.sections.mentorIntentOperations.length,105);assert.equal(queries.filter(exportSessions).length,2);assert.equal(queries.filter(exportOperations).length,2);
});

test('real rollback to an older authentic intent cannot hide the immutable cancellation receipt',async()=>{
 const s=await futureIntent(),old=(await f.db.query('SELECT * FROM platform_mentor_sessions WHERE id=$1',[s.intent.session.id])).rows[0];
 await s.service.cancel(s.owner,s.intent.session.id,{operationId:randomUUID(),expectedRevision:1});const current=(await f.db.query('SELECT * FROM platform_mentor_sessions WHERE id=$1',[s.intent.session.id])).rows[0],token=await exportProof(s.owner);
 const restore=async(row:any)=>f.db.query('UPDATE platform_mentor_sessions SET status=$2,revision=$3,last_operation_id=$4,updated_at=$5,payload_ciphertext=$6 WHERE id=$1',[row.id,row.status,row.revision,row.last_operation_id,row.updated_at,row.payload_ciphertext]);
 await restore(old);try{await assert.rejects(new AccountCoreExport(f.db,f.config).capture(s.owner,token),{code:'ACCOUNT_MENTOR_EXPORT_UNAVAILABLE'});assert.equal(await exportConsumed(s.owner),null);}finally{await restore(current);}
 assert.equal(((await new AccountCoreExport(f.db,f.config).capture(s.owner,token)).sections.mentorSessions[0] as any).status,'cancelled');
});

test('ciphertext corruption, wrong owner and orphan operations or ratings reject the whole archive and preserve reauthentication',async()=>{
 const s=await completed();await s.ratings.decide(s.owner,s.intent.session.id,rating());const token=await exportProof(s.owner);
 const cases:[(sql:string)=>boolean,(row:any)=>void][]=[
  [exportSessions,r=>{r.payload_ciphertext=Buffer.from(r.payload_ciphertext);r.payload_ciphertext[r.payload_ciphertext.length-1]^=1;}],
  [exportSessions,r=>{r.user_id=randomUUID();}], [exportSessions,r=>{r.status='requested';}],
  [exportOperations,r=>{r.session_id=randomUUID();}], [exportOperations,r=>{r.org_id=randomUUID();}],
  [exportRatings,r=>{r.user_id=randomUUID();}], [exportRatings,r=>{r.session_id=randomUUID();}],
  [exportRatings,r=>{r.payload_ciphertext=Buffer.from(r.payload_ciphertext);r.payload_ciphertext[r.payload_ciphertext.length-1]^=1;}],
 ];
 for(const [matches,mutate] of cases){let reached=false;await assert.rejects(new AccountCoreExport(exportDb((sql,rows)=>{if(matches(sql)&&rows.length){reached=true;mutate(rows[0]);}}),f.config).capture(s.owner,token),{code:'ACCOUNT_MENTOR_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await exportConsumed(s.owner),null);}
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(s.owner,token)).sections.mentorRatings.length,1);
});

test('authenticated unknown rating fields fail closed; rated and skipped records are never converted into absence',async()=>{
 const s=await completed();await s.ratings.decide(s.owner,s.intent.session.id,rating());const token=await exportProof(s.owner);
 let reached=false;const db=exportDb((sql,rows)=>{if(exportRatings(sql)&&rows.length){reached=true;const row=rows[0],context={table:'mentor_rating',column:'payload',rowId:row.session_id,ownerId:row.user_id,revision:1};
  const payload=JSON.parse(f.crypto.openUtf8(row.payload_ciphertext,context));payload.rating.privateStaffField='Fictional unexpected field';row.payload_ciphertext=f.crypto.sealUtf8(JSON.stringify(payload),context);}});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(s.owner,token),{code:'ACCOUNT_MENTOR_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await exportConsumed(s.owner),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(s.owner,token)).sections.mentorRatings.length,1);
});

test('empty service history, cancellation and capacity errors do not consume the owner proof or return partial records',async()=>{
 const nobody=await f.actor(),empty=await archive(nobody);assert.deepEqual(empty.sections.mentorSessions,[]);assert.deepEqual(empty.sections.mentorIntentOperations,[]);assert.deepEqual(empty.sections.mentorRatings,[]);
 const s=await completed();await s.ratings.decide(s.owner,s.intent.session.id,rating());const token=await exportProof(s.owner),abort=new AbortController();
 await assert.rejects(new AccountCoreExport(exportDb(sql=>{if(exportRatings(sql))abort.abort();}),f.config).capture(s.owner,token,abort.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await exportConsumed(s.owner),null);
 await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:3000}).capture(s.owner,token),{code:'ACCOUNT_EXPORT_TOO_LARGE'});assert.equal(await exportConsumed(s.owner),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(s.owner,token)).sections.mentorRatings.length,1);
});

test('recorded payment and refund validate historical service without exporting financial evidence or handoff credentials',async()=>{
 const s=await completed(),payments=new MentorPayments(f.db,{...s.config,mentorRetentionDays:365,mentorRetentionEvidenceRef:s.ref},s.service,offers,capacity,blobs);
 const paid={action:'pay',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:1,amountCents:9500,externalRef:'Fictional_export_payment_'+randomUUID(),occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true};
 await payments.record(s.operator,s.org,paid);
 const refund={action:'refund',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:2,amountCents:2500,externalRef:'Fictional_export_refund_'+randomUUID(),occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true};
 await payments.record(s.operator,s.org,refund);const pair=await s.service.getOrder(s.owner,s.intent.session.id),before=await mentorSnapshot(s.owner),data=await archive(s.owner);
 assert.equal((data.sections.mentorOrders[0] as any).status,'refunded_partial');assert.equal((data.sections.mentorOrders[0] as any).payment.refundedCents,2500);
 const money=data.sections.mentorOrderOperations as any[];assert.equal(money.length,3);assert.equal(money.find(x=>x.action==='refund').command.externalRef,refund.externalRef);assert.equal(money.find(x=>x.action==='pay').command.occurredAt,paid.occurredAt);
 assert.equal(data.sections.mentorFinancialRecords.length,1);assert.equal(data.sections.mentorFinancialOperations.length,2);
 assert.equal(pair.order.status,'refunded_partial');assert.equal((data.sections.mentorSessions[0] as any).status,'completed');assert.deepEqual(await mentorSnapshot(s.owner),before);
 for(const value of [s.ref,s.operator.userId,pair.order.handoffCode!])assert(!JSON.stringify(data).includes(value));
 for(const table of ['platform_mentor_orders','platform_mentor_order_proofs','platform_mentor_financial_records','platform_mentor_financial_proofs'])assert(data.includedTables.includes(table));
});

test('actual concurrent owner cancellation waits for the export snapshot without mixing old and new intent receipts',async()=>{
 const s=await futureIntent();let changed=false,pending:Promise<void>|undefined,failure:unknown;
 const data=await new AccountCoreExport(exportDb(sql=>{if(!changed&&exportSessions(sql)){changed=true;
  pending=s.service.cancel(s.owner,s.intent.session.id,{operationId:randomUUID(),expectedRevision:1}).then(()=>{},error=>{failure=error;});}}),f.config).capture(s.owner,await exportProof(s.owner));
 await pending;assert.equal(failure,undefined);assert(changed);assert.equal((data.sections.mentorSessions[0] as any).status,'requested');assert.equal(data.sections.mentorIntentOperations.length,1);
 assert.equal((await s.service.get(s.owner,s.intent.session.id)).status,'cancelled');
});

const orderIndex=(sql:string)=>sql.startsWith('SELECT id,user_id,session_id,org_id,revision FROM platform_mentor_orders');
const orderProofIndex=(sql:string)=>sql.startsWith('SELECT order_id,user_id,org_id,revision,operation_id,created_at,action FROM platform_mentor_order_proofs');
const reservationIndex=(sql:string)=>sql.startsWith('SELECT session_id,user_id,org_id,revision FROM platform_mentor_slot_reservations');
const reservationProofIndex=(sql:string)=>sql.startsWith('SELECT session_id,user_id,org_id,revision,operation_id,created_at FROM platform_mentor_reservation_proofs');
const financialIndex=(sql:string)=>sql.startsWith('SELECT f.id,f.revision FROM platform_mentor_financial_records');
const financialProofIndex=(sql:string)=>sql.startsWith('SELECT f.record_id,f.revision,f.action FROM platform_mentor_financial_proofs');
async function paidHistory(){
 const s=await completed(),payments=new MentorPayments(f.db,{...s.config,mentorRetentionDays:365,mentorRetentionEvidenceRef:s.ref},s.service,offers,capacity,blobs);
 const payment={action:'pay' as const,operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:1,amountCents:9500,externalRef:'Fictional_archived_pay_'+randomUUID(),occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true as const};
 await payments.record(s.operator,s.org,payment);return {...s,payments,payment};
}
async function refundHistory(s:Awaited<ReturnType<typeof paidHistory>>,expectedRevision:number,amountCents:number){
 const command={action:'refund' as const,operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision,amountCents,externalRef:'Fictional_archived_refund_'+randomUUID(),occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true as const};
 await s.payments.record(s.operator,s.org,command);return command;
}
async function financialSnapshot(){return {
 records:(await f.db.query('SELECT row_to_json(t)::text AS value FROM platform_mentor_financial_records t ORDER BY id')).rows,
 proofs:(await f.db.query('SELECT row_to_json(t)::text AS value FROM platform_mentor_financial_proofs t ORDER BY record_id,revision')).rows,
};}

test('archive preserves the shown price, actual quote and full held window; cancellation exports a void and released history without inferring a refund',async()=>{
 const s=await futureIntent();await match(s);let data=await archive(s.owner);
 const order=data.sections.mentorOrders[0] as any,reservation=data.sections.mentorSlotReservations[0] as any;
 assert.equal(order.priceCents,9500);assert.equal(order.shownOffer.priceCents,9900);assert.equal(order.shownOffer.refundRules,s.source.terms.refundRules);
 assert.equal(order.status,'quoted');assert.equal(order.payment,null);assert.equal(order.paymentRef,null);
 assert.equal(reservation.endsAt,s.slot.endsAt);assert.notEqual(reservation.endsAt,(data.sections.mentorSessions[0] as any).assignment.endsAt);
 assert.deepEqual((data.sections.mentorOrderOperations as any[]).map(o=>o.action),['quote']);assert.equal(data.sections.mentorFinancialRecords.length,0);
 const cancelled=await s.service.cancel(s.owner,s.intent.session.id,{operationId:randomUUID(),expectedRevision:2});data=await archive(s.owner);
 assert.equal((data.sections.mentorOrders[0] as any).status,'void');assert.deepEqual((data.sections.mentorOrderOperations as any[]).map(o=>o.action),['quote','void']);
 assert.deepEqual((data.sections.mentorReservationOperations as any[]).map(o=>o.status),['held','released']);
 assert.equal((data.sections.mentorReservationOperations[1] as any).operationId,cancelled.session.lastOperationId);
 assert.deepEqual(data.sections.mentorFinancialRecords,[]);assert.deepEqual(data.sections.mentorFinancialOperations,[]);
 assert(Object.isFrozen((data.sections.mentorOrders[0] as any).shownOffer));
});

test('paid, partial and full refunds retain original transaction references and stored retention dates without staff evidence or writes',async context=>{
 const s=await paidHistory();context.mock.method(globalThis,'fetch',async()=>{throw Error('No external requests');});
 let data=await archive(s.owner);assert.equal((data.sections.mentorOrders[0] as any).status,'paid');
 assert.equal((data.sections.mentorFinancialRecords[0] as any).revision,1);assert.equal((data.sections.mentorFinancialRecords[0] as any).paidAt,s.payment.occurredAt);
 const partial=await refundHistory(s,2,2500);data=await archive(s.owner);assert.equal((data.sections.mentorOrders[0] as any).status,'refunded_partial');
 const full=await refundHistory(s,3,7000),pair=await s.service.getOrder(s.owner,s.intent.session.id),before=await mentorSnapshot(s.owner),financeBefore=await financialSnapshot();
 const queries:string[]=[];data=await new AccountCoreExport(exportDb(sql=>{queries.push(sql);}),f.config).capture(s.owner,await exportProof(s.owner));
 const order=data.sections.mentorOrders[0] as any,finance=data.sections.mentorFinancialRecords[0] as any;
 assert.equal(order.status,'refunded_full');assert.equal(order.paymentRef,s.payment.externalRef);assert.equal(order.payment.refundedCents,9500);
 assert.equal(finance.status,'refunded_full');assert.equal(finance.revision,3);assert.equal(finance.updatedAt,order.updatedAt);
 assert.equal(finance.retentionUntil,(await f.db.query('SELECT retention_until FROM platform_mentor_financial_records WHERE id=$1',[order.id])).rows[0].retention_until.toISOString());
 const commands=(data.sections.mentorOrderOperations as any[]).filter(o=>o.command).map(o=>o.command);
 for(const [i,cmd] of [s.payment,partial,full].entries())assert.deepEqual(commands[i],{action:cmd.action,operationId:cmd.operationId,sessionId:cmd.sessionId,expectedRevision:cmd.expectedRevision,amountCents:cmd.amountCents,externalRef:cmd.externalRef,occurredAt:cmd.occurredAt});
 assert.deepEqual((data.sections.mentorFinancialOperations as any[]).map(o=>o.orderOperationId),[s.payment.operationId,partial.operationId,full.operationId]);
 assert.deepEqual(await mentorSnapshot(s.owner),before);assert.deepEqual(await financialSnapshot(),financeBefore);
 for(const secret of [s.ref,s.operator.userId,s.mentor.userId,s.profile.recordId,s.slot.recordId,pair.order.handoffCode!,'commandDigest','externalRefHash','policyEvidence','evidenceRef','acceptedAuthVersion'])assert(!JSON.stringify(data).includes(secret));
 assert(!queries.some(sql=>/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+platform_mentor_/i.test(sql)));
});

test('other owners and actually detached financial retention records never enter the owner archive',async()=>{
 const mine=await paidHistory(),other=await paidHistory(),deleted=await paidHistory();
 const otherPair=await other.service.getOrder(other.owner,other.intent.session.id),deletedPair=await deleted.service.getOrder(deleted.owner,deleted.intent.session.id);
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[deleted.owner.userId]);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_financial_records WHERE id=$1',[deletedPair.order.id])).rows[0].n,1);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_orders WHERE id=$1',[deletedPair.order.id])).rows[0].n,0);
 const before=await financialSnapshot(),data=await archive(mine.owner);assert.equal(data.sections.mentorOrders.length,1);assert.equal(data.sections.mentorFinancialRecords.length,1);
 for(const secret of [otherPair.order.id,deletedPair.order.id,other.payment.externalRef,deleted.payment.externalRef,other.owner.userId,deleted.owner.userId])assert(!JSON.stringify(data).includes(secret));
 assert.deepEqual(await financialSnapshot(),before);
});

test('own order and reservation indexes and proof indexes reject wrong owners, missing parents, wrong revisions and extra records atomically',async()=>{
 const s=await paidHistory(),token=await exportProof(s.owner);
 const cases:[(sql:string)=>boolean,(row:any)=>void][]=[
  [orderIndex,r=>{r.user_id=randomUUID();}], [orderIndex,r=>{r.session_id=randomUUID();}], [orderIndex,r=>{r.revision++;}],
  [orderProofIndex,r=>{r.order_id=randomUUID();}], [orderProofIndex,r=>{r.org_id=randomUUID();}],
  [reservationIndex,r=>{r.session_id=randomUUID();}], [reservationIndex,r=>{r.user_id=randomUUID();}],
  [reservationProofIndex,r=>{r.session_id=randomUUID();}], [reservationProofIndex,r=>{r.operation_id=randomUUID();}],
  [financialIndex,r=>{r.id=randomUUID();}], [financialIndex,r=>{r.revision++;}], [financialProofIndex,r=>{r.record_id=randomUUID();}], [financialProofIndex,r=>{r.action='refund';}],
 ];
 for(const [matches,mutate] of cases){let reached=false;await assert.rejects(new AccountCoreExport(exportDb((sql,rows)=>{if(matches(sql)&&rows.length){reached=true;mutate(rows[0]);}}),f.config).capture(s.owner,token),{code:'ACCOUNT_MENTOR_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await exportConsumed(s.owner),null);}
 for(const matches of [orderIndex,orderProofIndex,reservationIndex,reservationProofIndex,financialIndex,financialProofIndex]){
  let reached=false;await assert.rejects(new AccountCoreExport(exportDb((sql,rows)=>{if(matches(sql)&&rows.length){reached=true;rows.pop();}}),f.config).capture(s.owner,token),{code:'ACCOUNT_MENTOR_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await exportConsumed(s.owner),null);
 }
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(s.owner,token)).sections.mentorOrders.length,1);
});

test('corrupted encrypted orders, reservations and old financial proofs fail closed; authenticated unknown finance fields cannot leak',async()=>{
 const s=await paidHistory();await refundHistory(s,2,1500);const token=await exportProof(s.owner);
 const cases:[(sql:string)=>boolean,string][]=[
  [sql=>sql.startsWith('SELECT * FROM platform_mentor_orders WHERE'),'payload_ciphertext'],
  [sql=>sql.startsWith('SELECT * FROM platform_mentor_order_proofs WHERE order_id='),'proof_ciphertext'],
  [sql=>sql.startsWith('SELECT * FROM platform_mentor_slot_reservations WHERE'),'payload_ciphertext'],
  [sql=>sql.startsWith('SELECT * FROM platform_mentor_reservation_proofs WHERE'),'proof_ciphertext'],
  [sql=>sql.startsWith('SELECT * FROM platform_mentor_financial_records WHERE'),'payload_ciphertext'],
  [sql=>sql==='SELECT * FROM platform_mentor_financial_proofs WHERE record_id=$1 ORDER BY revision FOR SHARE','proof_ciphertext'],
 ];
 for(const [matches,column] of cases){let reached=false;await assert.rejects(new AccountCoreExport(exportDb((sql,rows)=>{if(matches(sql)&&rows.length){reached=true;rows[0][column]=Buffer.from(rows[0][column]);rows[0][column][rows[0][column].length-1]^=1;}}),f.config).capture(s.owner,token),{code:'ACCOUNT_MENTOR_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await exportConsumed(s.owner),null);}
 let reached=false;await assert.rejects(new AccountCoreExport(exportDb((sql,rows)=>{if(sql.startsWith('SELECT * FROM platform_mentor_financial_records WHERE')&&rows.length){reached=true;const r=rows[0],context={table:'mentor_financial',column:'payload',rowId:r.id,ownerId:r.id,revision:r.revision};
  const payload=JSON.parse(f.crypto.openUtf8(r.payload_ciphertext,context));payload.staffPrivateNote='Fictional unknown private note';r.payload_ciphertext=f.crypto.sealUtf8(JSON.stringify(payload),context);}}),f.config).capture(s.owner,token),{code:'ACCOUNT_MENTOR_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await exportConsumed(s.owner),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(s.owner,token)).sections.mentorFinancialOperations.length,2);
});

test('full reservation proof chain prevents an authentic old held state or a missing initial hold from replacing released history',async()=>{
 const s=await futureIntent();await match(s);const old=(await f.db.query('SELECT * FROM platform_mentor_slot_reservations WHERE session_id=$1',[s.intent.session.id])).rows[0];
 await s.service.cancel(s.owner,s.intent.session.id,{operationId:randomUUID(),expectedRevision:2});const token=await exportProof(s.owner);
 for(const rollback of [true,false]){let reached=false;
  await assert.rejects(new AccountCoreExport(exportDb((sql,rows)=>{
   if(rollback&&sql.startsWith('SELECT * FROM platform_mentor_slot_reservations WHERE')&&rows.length){reached=true;rows[0]={...old};}
   if(!rollback&&sql==='SELECT * FROM platform_mentor_reservation_proofs WHERE session_id=$1 ORDER BY revision FOR SHARE'&&rows.length){reached=true;rows.shift();}
  }),f.config).capture(s.owner,token),{code:'ACCOUNT_MENTOR_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await exportConsumed(s.owner),null);
 }
 assert.deepEqual(((await new AccountCoreExport(f.db,f.config).capture(s.owner,token)).sections.mentorReservationOperations as any[]).map(x=>x.status),['held','released']);
});

test('105 real matched and cancelled orders cross order, reservation and both proof pages without truncation',async()=>{
 const s=await futureIntent(),ids:string[]=[];
 for(let i=0;i<105;i++){
  const session=i===0?s.intent.session:(await s.service.create(s.owner,{...s.command,operationId:randomUUID()})).session;
  await s.service.match(s.operator,s.org,{...s.match,sessionId:session.id,operationId:randomUUID()});ids.push((await s.service.getOrder(s.owner,session.id)).order.id);
  await s.service.cancel(s.owner,session.id,{operationId:randomUUID(),expectedRevision:2});
 }
 const queries:string[]=[],data=await new AccountCoreExport(exportDb(sql=>{queries.push(sql);}),f.config).capture(s.owner,await exportProof(s.owner));
 assert.deepEqual((data.sections.mentorOrders as any[]).map(x=>x.id),ids.sort());assert.equal(data.sections.mentorSlotReservations.length,105);
 assert.equal(data.sections.mentorOrderOperations.length,210);assert.equal(data.sections.mentorReservationOperations.length,210);
 for(const match of [orderIndex,reservationIndex])assert.equal(queries.filter(match).length,2);
 for(const match of [orderProofIndex,reservationProofIndex])assert.equal(queries.filter(match).length,3);
});

test('103 original payment and refund operations cross proof pages preserving every amount and operation',async()=>{
 const s=await paidHistory(),operationIds=[s.payment.operationId];for(let i=0;i<102;i++)operationIds.push((await refundHistory(s,i+2,1)).operationId);
 const queries:string[]=[],data=await new AccountCoreExport(exportDb(sql=>{queries.push(sql);}),f.config).capture(s.owner,await exportProof(s.owner));
 assert.equal(data.sections.mentorOrderOperations.length,104);assert.equal(data.sections.mentorFinancialOperations.length,103);
 assert.deepEqual((data.sections.mentorFinancialOperations as any[]).map(x=>x.orderOperationId),operationIds);
 assert.equal((data.sections.mentorOrders[0] as any).payment.refundedCents,102);assert.equal((data.sections.mentorFinancialRecords[0] as any).refundedCents,102);
 assert.equal(queries.filter(orderProofIndex).length,2);assert.equal(queries.filter(financialProofIndex).length,2);
});

test('aborting after financial proof enumeration rolls back the entire archive and leaves the proof usable',async()=>{
 const s=await paidHistory(),token=await exportProof(s.owner),abort=new AbortController();let reached=false;
 await assert.rejects(new AccountCoreExport(exportDb(sql=>{if(financialProofIndex(sql)){reached=true;abort.abort();}}),f.config).capture(s.owner,token,abort.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});
 assert(reached);assert.equal(await exportConsumed(s.owner),null);assert.equal((await new AccountCoreExport(f.db,f.config).capture(s.owner,token)).sections.mentorFinancialRecords.length,1);
});


test('actual concurrent refund waits for the captured order and financial snapshot without mixing revisions',async()=>{
 const s=await paidHistory();let entered=false,pending:Promise<void>|undefined,failure:unknown;
 const data=await new AccountCoreExport(exportDb(sql=>{if(!entered&&financialIndex(sql)){entered=true;
  pending=refundHistory(s,2,2500).then(()=>{},error=>{failure=error;});}}),f.config).capture(s.owner,await exportProof(s.owner));
 await pending;assert(entered);assert.equal(failure,undefined);
 assert.equal((data.sections.mentorOrders[0] as any).status,'paid');assert.equal((data.sections.mentorFinancialRecords[0] as any).status,'paid');
 assert.equal(data.sections.mentorFinancialOperations.length,1);
 const after=await archive(s.owner);assert.equal((after.sections.mentorOrders[0] as any).status,'refunded_partial');
 assert.equal((after.sections.mentorFinancialRecords[0] as any).refundedCents,2500);assert.equal(after.sections.mentorFinancialOperations.length,2);
});
