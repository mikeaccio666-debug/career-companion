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
