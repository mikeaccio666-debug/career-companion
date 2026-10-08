import { readMentorOrder,observeMentorIntent } from '../../../apps/web/src/mentor-intent-api.ts';
import { MentorPayments } from '../src/mentor-payments.ts';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,chmod,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MENTOR_CONDUCT_VERSION,MENTOR_INTENT_PRIVACY_VERSION,PLATFORM_ACCOUNT_HEADER,parseMentorMatchCommand,parseMentorSchedulingCommand,parseMentorIntentCommand } from '@companion/platform-contracts';
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
  startsAt:'2027-01-01T10:00:00.000Z',endsAt:'2027-01-01T11:00:00.000Z',timeZone:'America/New_York',confirmedAt:'2026-01-01T00:00:00.000Z',confirmationEvidenceRef:ref,confirmWithMentor:true};
 const source={operationId:randomUUID(),offerId:randomUUID(),expectedRevision:0,reviewedAt:'2026-01-01T00:00:00.000Z',reviewEvidenceRef:ref,
  terms:{kind:'resume_direction',title:'Fictional resume discussion',durationMin:45,priceCents:9900,currency:'USD',collector:'Fictional collector',
   description:'Fictional resume evidence discussion.',exclusions:'No outcomes or referral promised.',refundVersion:'fictional-1',refundRules:'Original fictional refund rule.',
   appealInstructions:'Original fictional appeal channel.',disclosureVersion:'fictional-1',disclosure:'Original fictional relationship.',
   validFrom:'2025-01-01T00:00:00.000Z',validUntil:'2028-01-01T00:00:00.000Z',earliestSlotAt:'2027-01-01T00:00:00.000Z'}};
 await capacity.setProfile(operator,org,profile);await capacity.setSlot(operator,org,slot);await offers.set(operator,org,source);
 const config={...f.config,mentorOrganizationId:org},service=new MentorIntents(f.db,config,FICTIONAL_LEGAL,offers,undefined,capacity,blobs);
 const command={operationId:randomUUID(),offerId:source.offerId,offerRevision:1,contactName:'Fictional student',intentNote:'Discuss a fictional IBM class report.',privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,confirmVisibility:true};
 const intent=await service.create(owner,command),match={operationId:randomUUID(),sessionId:intent.session.id,expectedRevision:1,slotId:slot.recordId,slotRevision:1,priceCents:9500};
 return {org,operator,mentor,owner,ref,profile,slot,source,config,service,command,intent,match};
}
async function match(s:Awaited<ReturnType<typeof setup>>){return s.service.match(s.operator,s.org,s.match);}
async function ready(){const s=await setup();await match(s);
 const cmd={action:'schedule',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:2,confirmedAt:new Date().toISOString(),
  meetingUrl:'https://meet.google.com/fictional-meeting',userConfirmationRef:s.ref,mentorConfirmationRef:s.ref,confirmWithUser:true,confirmWithMentor:true};
 return {...s,cmd};
}
async function schedule(s:Awaited<ReturnType<typeof ready>>){return s.service.recordSchedule(s.operator,s.org,s.cmd);}
async function cancel(s:Awaited<ReturnType<typeof ready>>){return {action:'cancel_scheduled',operationId:randomUUID(),sessionId:s.intent.session.id,
 expectedRevision:3,occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true};}
async function unchanged(s:Awaited<ReturnType<typeof ready>>){
 assert.equal((await f.db.query('SELECT status FROM platform_mentor_sessions WHERE id=$1',[s.intent.session.id])).rows[0].status,'matched');
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_mentor_intent_operations WHERE org_id=$1 AND action IN ('schedule','cancel_scheduled')",[s.org])).rows[0].n,0);
}
test('actual schedule records both confirmation versions and current mentor/window with encrypted owned meeting, distinct quoted order and original slot hold',async()=>{
 const s=await ready(),x=await schedule(s);assert.equal(x.status,'scheduled');assert.equal(x.revision,3);assert(!x.replayed);
 const {session,order}=await s.service.getOrder(s.owner,s.intent.session.id);assert.equal(session.scheduled?.meetingUrl,s.cmd.meetingUrl);
 assert.equal(session.scheduled?.confirmedAt,s.cmd.confirmedAt);assert.equal(order.status,'quoted');assert.equal(order.revision,1);
 const row=(await f.db.query('SELECT * FROM platform_mentor_sessions WHERE id=$1',[session.id])).rows[0];assert.equal(row.scheduled_at.toISOString(),s.slot.startsAt);
 assert(!row.payload_ciphertext.includes(Buffer.from(s.cmd.meetingUrl)));assert(!JSON.stringify(x).includes(s.cmd.meetingUrl));
 assert.equal((await f.db.query('SELECT status,revision FROM platform_mentor_slot_reservations WHERE session_id=$1',[session.id])).rows[0].status,'held');
 const op=(await f.db.query("SELECT * FROM platform_mentor_intent_operations WHERE session_id=$1 AND action='schedule'",[session.id])).rows[0];
 const proof=JSON.parse(f.crypto.openUtf8(op.receipt_ciphertext,{table:'mentor_intent_operation',column:'payload',rowId:op.operation_id,ownerId:op.user_id,revision:3}));
 assert.equal(proof.confirmationEvidence.length,2);assert.equal(proof.confirmationEvidence[0].ownerId,s.operator.userId);assert.equal(proof.acceptedCapacity.profile.mentorId,s.mentor.userId);
 const client={account:{accountId:s.owner.userId},isCurrent:()=>true,async request<T>():Promise<T>{return await s.service.getOrder(s.owner,session.id) as T;}};
 assert.equal((await readMentorOrder(client,session.id)).session.status,'scheduled');
 assert.equal((await s.service.observe(s.owner,s.match.operationId)).session.status,'scheduled');
 assert.equal((await s.service.match(s.operator,s.org,s.match)).status,'scheduled');
});
test('concurrent original schedule/cancellation retries have one effect; quoted cancellation voids payment instructions and releases held window',async()=>{
 const s=await ready(),rs=await Promise.all([schedule(s),schedule(s)]);assert.equal(rs.filter(r=>r.replayed).length,1);
 const cmd=await cancel(s);const cs=await Promise.all([s.service.recordSchedule(s.operator,s.org,cmd),s.service.recordSchedule(s.operator,s.org,cmd)]);assert.equal(cs.filter(r=>r.replayed).length,1);
 const {session,order}=await s.service.getOrder(s.owner,s.intent.session.id);assert.equal(session.status,'cancelled');assert.equal(session.revision,4);assert.equal(order.status,'void');
 assert.equal(order.handoffCode,null);assert.equal((await capacity.list(s.operator,s.org,'slot')).records[0].eligible,true);
 const replay=await schedule(s);assert(replay.replayed);assert.equal(replay.status,'cancelled');assert.equal(replay.appliedRevision,3);
 assert.equal((await s.service.create(s.owner,s.command)).session.status,'cancelled');
 assert.equal((await s.service.observe(s.owner,s.cmd.operationId)).operation.appliedRevision,3);
});
test('paid scheduling/cancellation preserves settlement; original payment and source-independent refund still work after cancellation',async()=>{
 const s=await ready(),payments=new MentorPayments(f.db,{...s.config,mentorRetentionDays:365,mentorRetentionEvidenceRef:s.ref},s.service,offers,capacity,blobs);
 const pay={action:'pay',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:1,amountCents:9500,externalRef:'Fictional_'+randomUUID(),occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true};
 await payments.record(s.operator,s.org,pay);await schedule(s);
 await s.service.recordSchedule(s.operator,s.org,await cancel(s));assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).order.status,'paid');
 await payments.record(s.operator,s.org,{...pay,action:'refund',operationId:randomUUID(),expectedRevision:2,externalRef:'Fictional_refund_'+randomUUID(),occurredAt:new Date().toISOString()});
 assert.equal((await payments.record(s.operator,s.org,pay)).status,'refunded_full');
 assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).session.status,'cancelled');
});
test('student cannot bypass operator confirmation after scheduling; another student cannot read private meeting or original operation',async()=>{
 const s=await ready();await schedule(s);const other=await f.actor();
 await assert.rejects(s.service.cancel(s.owner,s.intent.session.id,{operationId:randomUUID(),expectedRevision:3}),error('MENTOR_INTENT_REVISION_CHANGED'));
 await assert.rejects(s.service.recordSchedule(s.owner,s.org,await cancel(s)),error('STAFF_ROLE_REQUIRED'));
 await assert.rejects(s.service.get(other,s.intent.session.id),error('NOT_FOUND'));
 await assert.rejects(s.service.observe(other,s.cmd.operationId),error('NOT_FOUND'));
 assert.equal((await s.service.get(s.owner,s.intent.session.id)).status,'scheduled');
});
test('false confirmations, extra owner/payment/time/status fields and unsafe links are closed without invoking getters',async()=>{
 const s=await ready();for(const patch of [{confirmWithUser:false},{confirmWithMentor:false},{ownerId:s.owner.userId},{startsAt:s.slot.startsAt},{status:'scheduled'},
 {paymentRef:'fake'},{expectedRevision:3},{meetingUrl:'javascript:alert(1)'},{meetingUrl:'https://localhost/x'},{meetingUrl:'https://127.0.0.1/x'},
 {meetingUrl:'https://example.com:8443/x'},{meetingUrl:'https://user:pass@example.com/x'},{meetingUrl:'https://example.com/#fragment'}])assert.throws(()=>parseMentorSchedulingCommand({...s.cmd,...patch}));
 let getters=0;const bad={...s.cmd};Object.defineProperty(bad,'meetingUrl',{get(){getters++;return s.cmd.meetingUrl;},enumerable:true});assert.throws(()=>parseMentorSchedulingCommand(bad));assert.equal(getters,0);await unchanged(s);
});
test('missing or foreign confirmation uploads and modified stored bytes cannot schedule; provenance is not inferred from a boolean',async()=>{
 for(const change of ['missing','foreign','deleted','changed']){
  const s=await ready();let cmd={...s.cmd};
  if(change==='missing')cmd.userConfirmationRef=randomUUID();
  if(change==='foreign')await f.db.query('UPDATE platform_uploads SET user_id=$2 WHERE id=$1',[s.ref,s.owner.userId]);
  if(change==='deleted')await blobs.delete(s.ref);
  if(change==='changed')await writeFile(join(dir,s.ref),Buffer.from('Modified fictional confirmation evidence.'));
  await assert.rejects(s.service.recordSchedule(s.operator,s.org,cmd));await unchanged(s);
 }
});
test('current profile/window/mentor role and actual past/future confirmation dates are rechecked before scheduling',async()=>{
 for(const change of ['profile','slot','role','before_match','future']){
  const s=await ready();let cmd={...s.cmd};
  if(change==='profile')await capacity.setProfile(s.operator,s.org,{...s.profile,operationId:randomUUID(),expectedRevision:1});
  if(change==='slot')await capacity.withdraw(s.operator,s.org,{operationId:randomUUID(),recordId:s.slot.recordId,expectedRevision:1,reason:'Fictional unavailable window'});
  if(change==='role')await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2 AND role='mentor'",[s.org,s.mentor.userId]);
  if(change==='before_match')cmd.confirmedAt='2026-01-01T00:00:00.000Z';if(change==='future')cmd.confirmedAt='2030-01-01T00:00:00.000Z';
  await assert.rejects(s.service.recordSchedule(s.operator,s.org,cmd));await unchanged(s);
 }
});
test('actual actor, org, owner legal acceptance and replay body remain bound; different authorized operator cannot replay another operation',async()=>{
 const s=await ready(),other=await f.actor(true);await assert.rejects(s.service.recordSchedule(other,s.org,s.cmd),error('STAFF_ROLE_REQUIRED'));
 await schedule(s);await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,'ops',$3)",[s.org,other.userId,s.operator.userId]);
 await assert.rejects(s.service.recordSchedule(other,s.org,s.cmd),error('MENTOR_INTENT_OPERATION_CONFLICT'));
 await assert.rejects(s.service.recordSchedule(s.operator,s.org,{...s.cmd,meetingUrl:'https://meet.google.com/other'}),error('MENTOR_INTENT_OPERATION_CONFLICT'));
 await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[s.operator.userId]);await assert.rejects(schedule(s),error('AUTH_REQUIRED'));
 const a=await ready();await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[a.owner.userId]);await assert.rejects(schedule(a),error('TERMS_CONFIRMATION_REQUIRED'));await unchanged(a);
});
test('actual audit insert failure rolls back new scheduled state, immutable receipt and retains quoted hold',async()=>{
 const s=await ready();await f.db.query("CREATE FUNCTION reject_schedule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='mentor_schedule_recorded' THEN RAISE EXCEPTION 'Fictional audit failure'; END IF; RETURN NEW; END $$");
 await f.db.query('CREATE TRIGGER reject_schedule_audit BEFORE INSERT ON platform_staff_audit FOR EACH ROW EXECUTE FUNCTION reject_schedule_audit()');
 try{await assert.rejects(schedule(s));await unchanged(s);}finally{await f.db.query('DROP TRIGGER reject_schedule_audit ON platform_staff_audit');await f.db.query('DROP FUNCTION reject_schedule_audit()');}
});
test('scheduled projection rollback or changed start time fail closed; immutable history rejects physical deletion',async()=>{
 const s=await ready(),old=(await f.db.query('SELECT * FROM platform_mentor_sessions WHERE id=$1',[s.intent.session.id])).rows[0];await schedule(s);
 const current=(await f.db.query('SELECT * FROM platform_mentor_sessions WHERE id=$1',[s.intent.session.id])).rows[0];
 await f.db.query('UPDATE platform_mentor_sessions SET scheduled_at=$2 WHERE id=$1',[current.id,new Date(Date.parse(s.slot.startsAt)+60000)]);
 await assert.rejects(s.service.get(s.owner,current.id),error('MENTOR_INTENT_STORAGE_UNAVAILABLE'));
 await f.db.query('UPDATE platform_mentor_sessions SET scheduled_at=$2 WHERE id=$1',[current.id,current.scheduled_at]);
 await f.db.query("UPDATE platform_mentor_sessions SET status='matched',scheduled_at=NULL,revision=2,last_operation_id=$2,updated_at=$3,payload_ciphertext=$4 WHERE id=$1",[old.id,old.last_operation_id,old.updated_at,old.payload_ciphertext]);
 await assert.rejects(s.service.get(s.owner,current.id),error('MENTOR_INTENT_STORAGE_UNAVAILABLE'));
 await f.db.query("UPDATE platform_mentor_sessions SET status='scheduled',scheduled_at=$2,revision=3,last_operation_id=$3,updated_at=$4,payload_ciphertext=$5 WHERE id=$1",[current.id,current.scheduled_at,current.last_operation_id,current.updated_at,current.payload_ciphertext]);
 await assert.rejects(f.db.query("DELETE FROM platform_mentor_intent_operations WHERE session_id=$1 AND action='schedule'",[current.id]));assert.equal((await s.service.get(s.owner,current.id)).status,'scheduled');
});
test('account deletion clears scheduled intent, meeting ciphertext, private confirmation proofs and slot hold with private order',async()=>{
 const s=await ready();await schedule(s);await f.db.query('DELETE FROM platform_users WHERE id=$1',[s.owner.userId]);
 for(const table of ['platform_mentor_sessions','platform_mentor_intent_operations','platform_mentor_orders','platform_mentor_slot_reservations'])
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table+' WHERE user_id=$1',[s.owner.userId])).rows[0].n,0);
});
test('scheduling CLI takes only private owned files and actual live operator session; prints status only, supports exact retry and denies permissive input',async()=>{
 const s=await ready(),token='fictional_schedule_'+randomUUID();await f.db.query("INSERT INTO platform_sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[tokenHash(token),s.operator.userId]);
 const sess=join(dir,randomUUID()+'.json'),input=join(dir,randomUUID()+'.json');await writeFile(sess,JSON.stringify({userId:s.operator.userId,token}),{mode:0o600});await writeFile(input,JSON.stringify(s.cmd),{mode:0o600});
 const url=new URL(readConfig().databaseUrl);url.searchParams.set('options','-c search_path='+f.schema);
 const legal=join(dir,randomUUID()+'.json'),{reviewDigest,...legalContent}=FICTIONAL_LEGAL;await writeFile(legal,JSON.stringify(legalContent),{mode:0o600});
 const env={...process.env,PLATFORM_DATABASE_URL:url.toString(),PLATFORM_STORAGE_DIR:dir,PLATFORM_DATA_KEY:'e5'.repeat(32),
  PLATFORM_MENTOR_ORG_ID:s.org,PLATFORM_LEGAL_BUNDLE_FILE:legal,PLATFORM_ALLOW_PROVIDER_CALLS:'0'};
 const cli=fileURLToPath(new URL('../src/mentor-scheduling-main.ts',import.meta.url));
 const run=()=>promisify(execFile)(process.execPath,['--import','tsx',cli,'record','--org',s.org,'--session-file',sess,'--input-file',input],{env});
 const first=await run();const value=JSON.parse(first.stdout);assert.equal(value.status,'scheduled');assert(!first.stdout.includes(token));assert(!first.stdout.includes(s.cmd.meetingUrl));assert(!first.stdout.includes(s.ref));
 assert.equal(JSON.parse((await run()).stdout).replayed,true);await chmod(input,0o644);await assert.rejects(run());
});

test('a late actual offline receipt can be recorded after scheduling without treating either state as the other',async()=>{
 const s=await ready();await schedule(s);
 const payments=new MentorPayments(f.db,{...s.config,mentorRetentionDays:365,mentorRetentionEvidenceRef:s.ref},s.service,offers,capacity,blobs);
 await payments.record(s.operator,s.org,{action:'pay',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:1,amountCents:9500,
  externalRef:'Fictional_late_'+randomUUID(),occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true});
 const pair=await s.service.getOrder(s.owner,s.intent.session.id);assert.equal(pair.session.status,'scheduled');assert.equal(pair.order.status,'paid');
});
test('actual password-cookie HTTP returns only owned confirmed meeting without proof files; closed public API cannot impersonate an operator',async()=>{
 const s=await ready();await schedule(s);const origin='https://fictional-schedule.example.invalid',password='Fictional-schedule-password-123';
 const system=await buildApp({db:f.db,storage:blobs,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),...s.config,allowedOrigins:new Set([origin]),workbenchEnabled:false},enableQueue:false,
  runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No external model');}})});
 try{await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[s.owner.userId,await hashPassword(password)]);
  const login=await system.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:s.owner.userId+'@example.invalid',password}});assert.equal(login.statusCode,200,login.body);
  const cookies=login.headers['set-cookie'],cookie=(Array.isArray(cookies)?cookies[0]:cookies)!.split(';')[0],headers={origin,cookie,[PLATFORM_ACCOUNT_HEADER]:s.owner.userId};
  const client={account:{accountId:s.owner.userId},isCurrent:()=>true,request:async(path:string)=>{const x=await system.app.inject({url:'/api/platform'+path,headers});assert.equal(x.statusCode,200,x.body);assert.equal(x.headers['cache-control'],'private, no-store');return x.json();}};
  const pair=await readMentorOrder(client,s.intent.session.id);assert.equal(pair.session.scheduled?.meetingUrl,s.cmd.meetingUrl);
  for(const key of ['confirmationEvidence','userConfirmationRef','mentorConfirmationRef','acceptedCapacity','actorAuthVersion'])assert(!JSON.stringify(pair).includes(key));
  const observed=await observeMentorIntent(client,{action:'create',sessionId:null,body:parseMentorIntentCommand(s.command)});assert.equal(observed.session.status,'scheduled');
  assert.equal((await system.app.inject({method:'POST',url:'/api/platform/career/mentor-intents/'+s.intent.session.id+'/schedule',headers,payload:s.cmd})).statusCode,404);
  assert.equal((await system.app.inject({url:'/api/platform/career/mentor-intents/'+s.intent.session.id,headers:{...headers,[PLATFORM_ACCOUNT_HEADER]:randomUUID()}})).statusCode,409);
 }finally{await system.app.close();}
});
test('abort after actual SQL state update rolls back confirmation proof and state before audit',async()=>{
 const s=await ready(),controller=new AbortController(),real=f.db.withBoundedTransaction.bind(f.db);let entered=false;
 f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);intercept.query=async(...args:any[])=>{
  const x=await (query as any)(...args);if(typeof args[0]==='string'&&args[0].startsWith('UPDATE platform_mentor_sessions SET status=$3,scheduled_at=')){entered=true;controller.abort();}return x;};return run(intercept);});
 try{await assert.rejects(s.service.recordSchedule(s.operator,s.org,s.cmd,controller.signal));assert(entered);}
 finally{f.db.withBoundedTransaction=real;}
 await unchanged(s);
});
test('migration rerun preserves actual scheduled records and immutable confirmation history',async()=>{
 const s=await ready();await schedule(s);
 const {readFile}=await import('node:fs/promises');await f.db.query(await readFile(new URL('../migrations/072_mentor_scheduling.sql',import.meta.url),'utf8'));
 assert.equal((await s.service.get(s.owner,s.intent.session.id)).status,'scheduled');
});
