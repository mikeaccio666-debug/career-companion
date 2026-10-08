import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,chmod,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MENTOR_CONDUCT_VERSION,MENTOR_INTENT_PRIVACY_VERSION,PLATFORM_ACCOUNT_HEADER,parseMentorMatchCommand } from '@companion/platform-contracts';
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
 const config={...f.config,mentorOrganizationId:org},service=new MentorIntents(f.db,config,FICTIONAL_LEGAL,offers,undefined,capacity);
 const command={operationId:randomUUID(),offerId:source.offerId,offerRevision:1,contactName:'Fictional student',intentNote:'Discuss a fictional IBM class report.',privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,confirmVisibility:true};
 const intent=await service.create(owner,command),match={operationId:randomUUID(),sessionId:intent.session.id,expectedRevision:1,slotId:slot.recordId,slotRevision:1,priceCents:9500};
 return {org,operator,mentor,owner,ref,profile,slot,source,config,service,command,intent,match};
}
async function match(s:Awaited<ReturnType<typeof setup>>){return s.service.match(s.operator,s.org,s.match);}
async function zero(s:Awaited<ReturnType<typeof setup>>){
 for(const table of ['platform_mentor_orders','platform_mentor_order_proofs','platform_mentor_slot_reservations','platform_mentor_reservation_proofs'])
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table+' WHERE org_id=$1',[s.org])).rows[0].n,0);
 assert.equal((await s.service.get(s.owner,s.intent.session.id)).status,'requested');
}
test('actual match atomically binds verified mentor/window, frozen original terms, encrypted quote and full-window hold; no payment or booking is claimed',async()=>{
 const s=await setup(),r=await match(s);assert.equal(r.status,'matched');assert.equal(r.appliedRevision,2);assert.equal(r.replayed,false);
 const {session,order}=await s.service.getOrder(s.owner,s.intent.session.id);
 assert.equal(session.mentorId,s.mentor.userId);assert.equal(session.assignment?.mentorDisplayName,s.profile.displayName);
 assert.equal(session.assignment?.startsAt,s.slot.startsAt);assert.equal(session.assignment?.endsAt,'2027-01-01T10:45:00.000Z');
 assert.equal(order.status,'quoted');assert.equal(order.priceCents,9500);assert.equal(order.shownOffer.refundRules,s.source.terms.refundRules);assert.equal(order.paymentRef,null);
 assert.match(order.handoffCode!,/^[A-Za-z0-9_-]{43}$/);assert.equal(order.origin,'user_request');assert.equal(order.suggestionId,null);
 assert.equal((await capacity.list(s.operator,s.org,'slot')).records[0].eligible,false);
 const row=(await f.db.query('SELECT * FROM platform_mentor_orders WHERE session_id=$1',[session.id])).rows[0];
 assert(!row.payload_ciphertext.includes(Buffer.from(order.handoffCode!)));assert(!row.payload_ciphertext.includes(Buffer.from(s.command.intentNote)));
 assert(!JSON.stringify({session,order}).includes(s.ref));assert.equal((await f.db.query('SELECT ends_at FROM platform_mentor_slot_reservations WHERE session_id=$1',[session.id])).rows[0].ends_at.toISOString(),s.slot.endsAt);
 assert.equal((await s.service.create(s.owner,s.command)).session.status,'matched');
 const observed=await s.service.observe(s.owner,s.match.operationId);assert.equal(observed.operation.appliedRevision,2);assert.equal(observed.session.id,session.id);
});
test('same original concurrent match has one effect; cancellation releases slot and voids quote; all original replays return current state',async()=>{
 const s=await setup(),results=await Promise.all([match(s),match(s)]);assert.equal(results.filter(r=>r.replayed).length,1);
 const before=await s.service.getOrder(s.owner,s.intent.session.id),cmd={operationId:randomUUID(),expectedRevision:2};
 const r=await s.service.cancel(s.owner,s.intent.session.id,cmd);assert.equal(r.session.status,'cancelled');assert.equal(r.session.revision,3);
 const current=await s.service.getOrder(s.owner,s.intent.session.id);assert.equal(current.order.id,before.order.id);assert.equal(current.order.status,'void');assert.equal(current.order.handoffCode,null);
 assert.equal((await capacity.list(s.operator,s.org,'slot')).records[0].eligible,true);assert.equal((await match(s)).status,'cancelled');
 assert.equal((await s.service.create(s.owner,s.command)).session.status,'cancelled');assert.equal((await s.service.cancel(s.owner,s.intent.session.id,cmd)).operation.replayed,true);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_orders WHERE org_id=$1',[s.org])).rows[0].n,1);
 await assert.rejects(s.service.cancel(s.owner,s.intent.session.id,{...cmd,operationId:randomUUID()}),error('MENTOR_INTENT_REVISION_CHANGED'));
});
test('two actual owners competing for one real window cannot both be matched; loser retains unquoted intent',async()=>{
 const s=await setup(),other=await f.actor(),b=await s.service.create(other,{...s.command,operationId:randomUUID()});
 const second={...s.match,operationId:randomUUID(),sessionId:b.session.id},r=await Promise.allSettled([match(s),s.service.match(s.operator,s.org,second)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert(r.some(x=>x.status==='rejected'&&error('MENTOR_SLOT_RESERVED')(x.reason)));
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_mentor_slot_reservations WHERE org_id=$1 AND status='held'",[s.org])).rows[0].n,1);
});
test('quote is bounded by both originally shown and currently published price, while original disclosure/refund terms remain frozen',async()=>{
 const s=await setup();await offers.set(s.operator,s.org,{...s.source,operationId:randomUUID(),expectedRevision:1,terms:{...s.source.terms,priceCents:8000,refundRules:'Different current rule.'}});
 await assert.rejects(match(s),error('MENTOR_QUOTE_TOO_HIGH'));await zero(s);
 await s.service.match(s.operator,s.org,{...s.match,priceCents:8000});const pair=await s.service.getOrder(s.owner,s.intent.session.id);
 assert.equal(pair.order.priceCents,8000);assert.equal(pair.order.shownOffer.priceCents,9900);assert.equal(pair.order.shownOffer.refundRules,s.source.terms.refundRules);
 const a=await setup();await offers.set(a.operator,a.org,{...a.source,operationId:randomUUID(),expectedRevision:1,terms:{...a.source.terms,priceCents:11000}});
 await assert.rejects(a.service.match(a.operator,a.org,{...a.match,priceCents:10000}),error('MENTOR_QUOTE_TOO_HIGH'));await zero(a);
});
test('altered live source kind, duration, profile revision, mentor role or missing evidence cannot create a quote/hold',async()=>{
 for(const change of ['kind','duration','profile','role','evidence']){
  const s=await setup();
  if(change==='kind'||change==='duration')await offers.set(s.operator,s.org,{...s.source,operationId:randomUUID(),expectedRevision:1,terms:{...s.source.terms,...(change==='kind'?{kind:'mock_interview'}:{durationMin:60})}});
  if(change==='profile')await capacity.setProfile(s.operator,s.org,{...s.profile,operationId:randomUUID(),expectedRevision:1});
  if(change==='role')await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2 AND role='mentor'",[s.org,s.mentor.userId]);
  if(change==='evidence')await blobs.delete(s.ref);
  await assert.rejects(match(s));await zero(s);
 }
});
test('occupied historical windows survive actual profile edits, slot withdrawal and mentor deletion; owner can still cancel their own recorded quote',async()=>{
 const s=await setup();await match(s);await capacity.setProfile(s.operator,s.org,{...s.profile,operationId:randomUUID(),expectedRevision:1});
 await assert.rejects(capacity.setSlot(s.operator,s.org,{...s.slot,operationId:randomUUID(),recordId:randomUUID(),profileRevision:2}),error('MENTOR_SLOT_RESERVED'));
 await capacity.withdraw(s.operator,s.org,{operationId:randomUUID(),recordId:s.slot.recordId,expectedRevision:1,reason:'Fictional window withdrawal'});
 assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).order.status,'quoted');
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[s.mentor.userId]);assert.equal((await s.service.get(s.owner,s.intent.session.id)).mentorId,s.mentor.userId);
 assert.equal((await f.db.query('SELECT status FROM platform_mentor_slot_reservations WHERE session_id=$1',[s.intent.session.id])).rows[0].status,'held');
 await s.service.cancel(s.owner,s.intent.session.id,{operationId:randomUUID(),expectedRevision:2});assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).order.status,'void');
});
test('match has no caller-selected owner, mentor, payment, terms, permission or external handoff; getters never execute',async()=>{
 const s=await setup();for(const patch of [{ownerId:s.owner.userId},{mentorId:s.mentor.userId},{orderId:randomUUID()},{priceCents:0},{origin:'companion_suggestion'},
  {paymentRef:'fake'},{meetingUrl:'https://example.invalid'},{contactEmail:'other@example.invalid'},{handoffCode:'fake'},{role:'ops'},{expectedRevision:2}])
  assert.throws(()=>parseMentorMatchCommand({...s.match,...patch}));
 let getters=0;const bad={...s.match};Object.defineProperty(bad,'priceCents',{get(){getters++;return 1;},enumerable:true});assert.throws(()=>parseMentorMatchCommand(bad));assert.equal(getters,0);await zero(s);
});
test('actual operator authorization, organization and original match actor/nonce are checked; student and unrelated staff cannot match or view foreign quotes',async()=>{
 const s=await setup(),other=await f.actor(true),outsider=await f.actor();
 await assert.rejects(s.service.match(s.owner,s.org,s.match),error('STAFF_ROLE_REQUIRED'));await assert.rejects(s.service.match(other,s.org,s.match),error('STAFF_ROLE_REQUIRED'));
 await match(s);await assert.rejects(s.service.getOrder(outsider,s.intent.session.id),error('NOT_FOUND'));
 await assert.rejects(s.service.opsOrders(outsider,s.org),error('STAFF_ROLE_REQUIRED'));
 await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,'ops',$3)",[s.org,other.userId,s.operator.userId]);
 await assert.rejects(s.service.match(other,s.org,s.match),error('MENTOR_INTENT_OPERATION_CONFLICT'));
 await assert.rejects(s.service.match(s.operator,s.org,{...s.match,priceCents:9400}),error('MENTOR_INTENT_OPERATION_CONFLICT'));
 const list=await s.service.opsOrders(s.operator,s.org);assert.equal(list.orders.length,1);
 for(const key of ['contactEmail','intentNote','handoffCode','acceptedCapacity','profileEvidence'])assert(!JSON.stringify(list).includes(key));
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_staff_audit WHERE org_id=$1 AND action='mentor_orders_viewed' AND outcome='allow'",[s.org])).rows[0].n,1);
});
test('real owner verification/legal and operator session expiry are rechecked before acceptance with complete rollback',async()=>{
 for(const change of ['verify','legal']){const s=await setup();
  if(change==='verify')await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[s.owner.userId]);
  else await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[s.owner.userId]);
  await assert.rejects(match(s));
  for(const table of ['platform_mentor_orders','platform_mentor_slot_reservations'])assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table+' WHERE org_id=$1',[s.org])).rows[0].n,0);
 }
 const s=await setup();await f.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE token_hash=$1",[s.operator.tokenHash]);
 const slow=new MentorCapacity(f.db,f.config,FICTIONAL_LEGAL,{stat:async(key,signal)=>{const r=await blobs.stat(key,signal);await new Promise(r=>setTimeout(r,220));return r;}});
 const svc=new MentorIntents(f.db,s.config,FICTIONAL_LEGAL,offers,undefined,slow);await assert.rejects(svc.match(s.operator,s.org,s.match),error('AUTH_REQUIRED'));await zero(s);
});
test('abort after actual quote insertion rolls back intent, quote/proofs, hold/proofs and accepted audit',async()=>{
 const s=await setup(),abort=new AbortController(),real=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);
  intercept.query=async(...args:any[])=>{const r=await(query as any)(...args);if(typeof args[0]==='string'&&args[0].includes('INSERT INTO platform_mentor_orders('))abort.abort();return r;};return run(intercept);});
 try{await assert.rejects(s.service.match(s.operator,s.org,s.match,abort.signal));}finally{f.db.withBoundedTransaction=real;}
 await zero(s);assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_staff_audit WHERE org_id=$1 AND action='mentor_intent_matched' AND outcome='allow'",[s.org])).rows[0].n,0);
});
test('audit insertion failure cannot report or leave a matched intent, quote or occupied slot',async()=>{
 const s=await setup();await f.db.query("CREATE FUNCTION reject_quote_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='mentor_intent_matched' THEN RAISE EXCEPTION 'Fictional audit failure'; END IF; RETURN NEW; END $$");
 await f.db.query('CREATE TRIGGER reject_quote_audit BEFORE INSERT ON platform_staff_audit FOR EACH ROW EXECUTE FUNCTION reject_quote_audit()');
 try{await assert.rejects(match(s));await zero(s);}finally{await f.db.query('DROP TRIGGER reject_quote_audit ON platform_staff_audit');await f.db.query('DROP FUNCTION reject_quote_audit()');}
});
test('authentic ciphertext rollback and SQL price/time/status tampering fail closed, with immutable proofs preventing silent replacement',async()=>{
 const s=await setup();await match(s);const id=s.intent.session.id,old=(await f.db.query('SELECT * FROM platform_mentor_orders WHERE session_id=$1',[id])).rows[0];
 await f.db.query('UPDATE platform_mentor_orders SET price_cents=price_cents-1 WHERE id=$1',[old.id]);await assert.rejects(s.service.get(s.owner,id),error('MENTOR_INTENT_STORAGE_UNAVAILABLE'));
 await f.db.query('UPDATE platform_mentor_orders SET price_cents=$2 WHERE id=$1',[old.id,old.price_cents]);
 await f.db.query("UPDATE platform_mentor_slot_reservations SET starts_at='2028-01-01T10:00:00Z',ends_at='2028-01-01T11:00:00Z' WHERE session_id=$1",[id]);
 await assert.rejects(capacity.list(s.operator,s.org,'slot'),error('MENTOR_RESERVATION_STORAGE_UNAVAILABLE'));
 await f.db.query('UPDATE platform_mentor_slot_reservations SET starts_at=$2,ends_at=$3 WHERE session_id=$1',[id,s.slot.startsAt,s.slot.endsAt]);
 await assert.rejects(f.db.query('DELETE FROM platform_mentor_order_proofs WHERE order_id=$1',[old.id]));await assert.rejects(f.db.query('DELETE FROM platform_mentor_reservation_proofs WHERE session_id=$1',[id]));
 await s.service.cancel(s.owner,id,{operationId:randomUUID(),expectedRevision:2});
 await f.db.query("UPDATE platform_mentor_orders SET status='quoted',handoff_code_hash=$2,revision=1,last_operation_id=$3,updated_at=$4,payload_ciphertext=$5 WHERE id=$1",[old.id,old.handoff_code_hash,old.last_operation_id,old.updated_at,old.payload_ciphertext]);
 await assert.rejects(s.service.getOrder(s.owner,id),error('MENTOR_INTENT_STORAGE_UNAVAILABLE'));
});
test('owner/organization deletion clears quote ledgers and holds, and repeated migration creates no fake payment or mentor',async()=>{
 for(const target of ['owner','org']){const s=await setup();await match(s);
  await f.db.query(target==='owner'?'DELETE FROM platform_users WHERE id=$1':'DELETE FROM platform_orgs WHERE id=$1',[target==='owner'?s.owner.userId:s.org]);
  for(const table of ['platform_mentor_orders','platform_mentor_order_proofs','platform_mentor_slot_reservations','platform_mentor_reservation_proofs'])assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table+' WHERE org_id=$1',[s.org])).rows[0].n,0);
 }
 const before=(await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_orders')).rows[0].n;await f.db.migrate();assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_orders')).rows[0].n,before);
});
const origin='https://fictional-mentor-quotes.example.invalid';
async function login(app:Awaited<ReturnType<typeof buildApp>>['app'],who:Awaited<ReturnType<typeof f.actor>>){const password='Fictional-quote-password-123';
 await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
 const r=await app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});assert.equal(r.statusCode,200,r.body);
 const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];return {origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId};}
test('real password-cookie HTTP returns account-bound no-store quote pairs and audited minimal staff orders without public match/payment mutation',async()=>{
 const s=await setup();await match(s);const system=await buildApp({db:f.db,storage:blobs,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),...s.config,allowedOrigins:new Set([origin]),workbenchEnabled:false},enableQueue:false,
  runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No provider calls');}})});
 try{const owner=await login(system.app,s.owner),operator=await login(system.app,s.operator),other=await login(system.app,await f.actor()),path='/api/platform/career/mentor-intents/'+s.intent.session.id+'/order';
  const r=await system.app.inject({url:path,headers:owner});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'private, no-store');assert.equal(r.json().order.priceCents,9500);
  assert.equal((await system.app.inject({url:path,headers:other})).statusCode,404);assert.equal((await system.app.inject({url:path})).statusCode,401);
  assert.equal((await system.app.inject({url:path,headers:{...owner,[PLATFORM_ACCOUNT_HEADER]:s.mentor.userId}})).statusCode,409);
  const list=await system.app.inject({url:'/api/platform/staff/orgs/'+s.org+'/mentor-orders',headers:operator});assert.equal(list.statusCode,200,list.body);assert(!list.body.includes('handoffCode'));assert.equal(list.headers['cache-control'],'private, no-store');
  assert.equal((await system.app.inject({url:path+'?private=true',headers:owner})).statusCode,400);
  assert.equal((await system.app.inject({method:'POST',url:'/api/platform/staff/orgs/'+s.org+'/mentor-match',headers:operator,payload:s.match})).statusCode,404);
  const c=await system.app.inject({method:'POST',url:path.replace('/order','/cancel'),headers:owner,payload:{operationId:randomUUID(),expectedRevision:2}});assert.equal(c.statusCode,200,c.body);
  assert.equal((await system.app.inject({url:path,headers:owner})).json().order.status,'void');assert.equal(calls,0);
 }finally{await system.app.close();}
});
test('actual ops CLI reads owned private session/input files, matches once, and prints coordinates without demand, evidence, tokens or handoff code',async()=>{
 const s=await setup(),token=randomUUID()+randomUUID(),url=new URL(readConfig().databaseUrl);url.searchParams.set('options','-c search_path='+f.schema);
 await f.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[s.operator.userId,tokenHash(token)]);
 const legalFile=join(dir,'fictional-quote-legal.json');const {reviewDigest,...legalContent}=FICTIONAL_LEGAL;await writeFile(legalFile,JSON.stringify(legalContent),{mode:0o600});
 const credentials=join(dir,'fictional-quote-session.json'),input=join(dir,'fictional-quote-input.json');await writeFile(credentials,JSON.stringify({userId:s.operator.userId,token}),{mode:0o600});await writeFile(input,JSON.stringify(s.match),{mode:0o600});
 const execute=promisify(execFile),env={...process.env,PLATFORM_DATABASE_URL:url.toString(),PLATFORM_STORAGE_DIR:dir,PLATFORM_DATA_KEY:'e5'.repeat(32),PLATFORM_MENTOR_ORG_ID:s.org,PLATFORM_LEGAL_BUNDLE_FILE:legalFile,PLATFORM_ALLOW_PROVIDER_CALLS:'0'};
 const run=()=>execute(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/mentor-match-main.ts',import.meta.url)),'match','--org',s.org,'--session-file',credentials,'--input-file',input],{env,timeout:10000,maxBuffer:4096});
 const saved=await run();assert.equal(JSON.parse(saved.stdout).status,'matched');assert.equal(saved.stderr,'');for(const v of [token,s.ref,s.command.intentNote,'handoffCode','acceptedCapacity'])assert(!saved.stdout.includes(v));
 assert.equal(JSON.parse((await run()).stdout).replayed,true);await chmod(credentials,0o644);await assert.rejects(run(),(e:any)=>{assert.equal(e.stdout,'');assert(!e.stderr.includes(token));return true;});
});

test('concurrent genuine student create and ops match keep compatible organization locks instead of deadlocking owner/catalog access',async()=>{
 const s=await setup();let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),resume=new Promise<void>(r=>{release=r;});
 const waitingOffers={listInTransaction:async(...args:Parameters<MentorServiceOffers['listInTransaction']>)=>{entered();await resume;return offers.listInTransaction(...args);}};
 const createService=new MentorIntents(f.db,s.config,FICTIONAL_LEGAL,waitingOffers);
 const creating=createService.create(s.owner,{...s.command,operationId:randomUUID()});await ready;
 const real=f.db.withBoundedTransaction.bind(f.db);let acquired=false;
 f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);
  intercept.query=async(...args:any[])=>{const r=await(query as any)(...args);
   if(typeof args[0]==='string'&&args[0].startsWith('SELECT id FROM platform_orgs WHERE id=$1')&&!acquired){acquired=true;release();}return r;};return run(intercept);});
 try{const [a,b]=await Promise.all([creating,match(s)]);assert(acquired);assert.equal(a.session.status,'requested');assert.equal(b.status,'matched');}
 finally{release();f.db.withBoundedTransaction=real;await Promise.allSettled([creating]);}
});

test('actual staff order pagination covers every one of 51 quotes, and foreign anchors or arbitrary query fields cannot expand its scope',async()=>{
 const s=await setup(),ids=new Set<string>();await match(s);ids.add(s.intent.session.id);
 for(let i=1;i<51;i++){
  const startsAt=new Date(Date.parse(s.slot.startsAt)+i*3600000).toISOString(),slot={...s.slot,operationId:randomUUID(),recordId:randomUUID(),startsAt,endsAt:new Date(Date.parse(startsAt)+3600000).toISOString()};
  await capacity.setSlot(s.operator,s.org,slot);const intent=await s.service.create(s.owner,{...s.command,operationId:randomUUID()});
  await s.service.match(s.operator,s.org,{...s.match,operationId:randomUUID(),sessionId:intent.session.id,slotId:slot.recordId});ids.add(intent.session.id);
 }
 const a=await s.service.opsOrders(s.operator,s.org);assert.equal(a.orders.length,50);assert(a.nextCursor);
 const b=await s.service.opsOrders(s.operator,s.org,{after:a.nextCursor});assert.equal(b.orders.length,1);assert.equal(b.nextCursor,null);
 assert.deepEqual(new Set([...a.orders,...b.orders].map(o=>o.sessionId)),ids);
 await assert.rejects(s.service.opsOrders(s.operator,s.org,{after:randomUUID()}),error('NOT_FOUND'));
 await assert.rejects(s.service.opsOrders(s.operator,s.org,{ownerId:s.owner.userId}),error('MENTOR_INTENT_INPUT_INVALID'));
});
test('operator session expiry after real quote insertion rolls back all writes before audit or response',async()=>{
 const s=await setup(),real=f.db.withBoundedTransaction.bind(f.db);let inserted=false;
 await f.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1",[s.operator.tokenHash]);
 f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);
  intercept.query=async(...args:any[])=>{const r=await(query as any)(...args);
   if(typeof args[0]==='string'&&args[0].includes('INSERT INTO platform_mentor_orders(')){inserted=true;await new Promise(r=>setTimeout(r,550));}return r;};return run(intercept);});
 try{await assert.rejects(match(s),error('AUTH_REQUIRED'));assert(inserted);}finally{f.db.withBoundedTransaction=real;}
 await zero(s);
});
