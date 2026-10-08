import { createHash } from 'node:crypto';
import { mentorLedgerDigest } from '../src/mentor-ledger-crypto.ts';
import { readMentorOrder } from '../../../apps/web/src/mentor-intent-api.ts';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,chmod,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseMentorPaymentCommand,MENTOR_CONDUCT_VERSION,MENTOR_INTENT_PRIVACY_VERSION,PLATFORM_ACCOUNT_HEADER,parseMentorMatchCommand } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { MentorPayments } from '../src/mentor-payments.ts';
import { MentorFinancialLedger } from '../src/mentor-financial-ledger.ts';
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

async function ready(){const s=await setup();await match(s);
 const config={...s.config,mentorRetentionDays:365,mentorRetentionEvidenceRef:s.ref},payments=new MentorPayments(f.db,config,s.service,offers,capacity,blobs);
 const cmd={action:'pay',operationId:randomUUID(),sessionId:s.intent.session.id,expectedRevision:1,amountCents:9500,
  externalRef:'Fictional_pay_'+randomUUID(),occurredAt:new Date().toISOString(),evidenceRef:s.ref,confirmRecorded:true};
 return {...s,config,payments,cmd};
}
test('real manual payment captures receipt/policy evidence and audited immutable provenance, without modifying fulfillment or executing a payment',async()=>{
 const s=await ready(),r=await s.payments.record(s.operator,s.org,s.cmd);assert.equal(r.status,'paid');assert.equal(r.revision,2);assert.equal(r.replayed,false);
 const pair=await s.service.getOrder(s.owner,s.intent.session.id);assert.equal(pair.session.status,'matched');assert.equal(pair.session.revision,2);
 assert.equal(pair.order.status,'paid');assert.equal(pair.order.paymentRef,s.cmd.externalRef);assert.equal(pair.order.payment?.paidAt,s.cmd.occurredAt);assert.equal(pair.order.payment?.refundedCents,0);
 const row=(await f.db.query('SELECT * FROM platform_mentor_financial_records WHERE id=$1',[pair.order.id])).rows[0];assert.equal(row.revision,1);
 const retained=JSON.parse(f.crypto.openUtf8(row.payload_ciphertext,{table:'mentor_financial',column:'payload',rowId:row.id,ownerId:row.id,revision:row.revision}));
 for(const key of ['ownerId','orgId','actorId','evidenceRef','intentNote','contactEmail','sessionId'])assert(!(key in retained));
 assert.equal(retained.paymentRef,s.cmd.externalRef);assert.equal(retained.priceCents,9500);assert.equal((await s.service.opsOrders(s.operator,s.org)).orders[0].status,'paid');
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_staff_audit WHERE org_id=$1 AND action='mentor_payment_recorded' AND outcome='allow'",[s.org])).rows[0].n,1);
});
test('concurrent original payment retry has one effect and genuine replay returns current refunded state without another charge/refund',async()=>{
 const s=await ready(),r=await Promise.all([s.payments.record(s.operator,s.org,s.cmd),s.payments.record(s.operator,s.org,s.cmd)]);assert.equal(r.filter(x=>x.replayed).length,1);
 const refund={...s.cmd,action:'refund',operationId:randomUUID(),expectedRevision:2,amountCents:4000,externalRef:'Fictional_refund_'+randomUUID(),occurredAt:new Date().toISOString()};
 const a=await s.payments.record(s.operator,s.org,refund);assert.equal(a.status,'refunded_partial');
 const old=await s.payments.record(s.operator,s.org,s.cmd);assert.equal(old.status,'refunded_partial');assert.equal(old.appliedRevision,2);assert.equal(old.revision,3);assert(old.replayed);
 const again=await s.payments.record(s.operator,s.org,refund);assert.equal(again.replayed,true);
 await s.payments.record(s.operator,s.org,{...refund,operationId:randomUUID(),expectedRevision:3,amountCents:5500,externalRef:'Fictional_refund_'+randomUUID(),occurredAt:new Date().toISOString()});
 const pair=await s.service.getOrder(s.owner,s.intent.session.id);assert.equal(pair.order.status,'refunded_full');assert.equal(pair.order.payment?.refundedCents,9500);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_order_proofs WHERE order_id=$1',[pair.order.id])).rows[0].n,4);
});
test('cancelled paid intent releases its occupied window but preserves actual settlement/refund history; refund may still be recorded afterward',async()=>{
 const s=await ready();await s.payments.record(s.operator,s.org,s.cmd);const before=await s.service.getOrder(s.owner,s.intent.session.id);
 await s.service.cancel(s.owner,s.intent.session.id,{operationId:randomUUID(),expectedRevision:2});
 const pair=await s.service.getOrder(s.owner,s.intent.session.id);assert.equal(pair.session.status,'cancelled');assert.equal(pair.order.status,'paid');assert.equal(pair.order.id,before.order.id);
 assert.equal((await capacity.list(s.operator,s.org,'slot')).records[0].eligible,true);
 await s.payments.record(s.operator,s.org,{...s.cmd,action:'refund',operationId:randomUUID(),expectedRevision:2,amountCents:9500,externalRef:'Fictional_refund_'+randomUUID(),occurredAt:new Date().toISOString()});
 assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).order.status,'refunded_full');
 assert.equal((await s.payments.record(s.operator,s.org,s.cmd)).status,'refunded_full');
});
test('missing retention configuration, wrong amount, future receipt date or foreign/missing evidence cannot mark a quote paid',async()=>{
 const s=await ready();for(const config of [{...s.config,mentorRetentionDays:undefined},{...s.config,mentorRetentionEvidenceRef:undefined}])
 await assert.rejects(new MentorPayments(f.db,config,s.service,offers,capacity,blobs).record(s.operator,s.org,s.cmd),error('MENTOR_RETENTION_POLICY_UNAVAILABLE'));
 for(const patch of [{amountCents:9400},{occurredAt:'2030-01-01T00:00:00.000Z'},{evidenceRef:randomUUID()}])await assert.rejects(s.payments.record(s.operator,s.org,{...s.cmd,...patch}));
 assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).order.status,'quoted');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_financial_records WHERE id=(SELECT order_id FROM platform_mentor_sessions WHERE id=$1)',[s.intent.session.id])).rows[0].n,0);
});
test('payment rechecks current source/profile/role/public price; recording refunds uses original settlement even if the mentor source is later withdrawn',async()=>{
 const s=await ready();await capacity.setProfile(s.operator,s.org,{...s.profile,operationId:randomUUID(),expectedRevision:1});
 await assert.rejects(s.payments.record(s.operator,s.org,s.cmd));assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).order.status,'quoted');
 const b=await ready();await offers.set(b.operator,b.org,{...b.source,operationId:randomUUID(),expectedRevision:1,terms:{...b.source.terms,priceCents:9000}});
 await assert.rejects(b.payments.record(b.operator,b.org,b.cmd),error('MENTOR_PAYMENT_SOURCE_CHANGED'));
 const a=await ready();await a.payments.record(a.operator,a.org,a.cmd);await capacity.withdraw(a.operator,a.org,{operationId:randomUUID(),recordId:a.profile.recordId,expectedRevision:1,reason:'Fictional withdrawn after payment'});
 await a.payments.record(a.operator,a.org,{...a.cmd,action:'refund',operationId:randomUUID(),expectedRevision:2,amountCents:9500,externalRef:'Fictional_refund_'+randomUUID(),occurredAt:new Date().toISOString()});
 assert.equal((await a.service.getOrder(a.owner,a.intent.session.id)).order.status,'refunded_full');
});
test('over-refund, stale version, reused external receipt and original nonce with different command are rejected without financial duplication',async()=>{
 const s=await ready();await s.payments.record(s.operator,s.org,s.cmd);
 await assert.rejects(s.payments.record(s.operator,s.org,{...s.cmd,amountCents:1}),error('MENTOR_PAYMENT_OPERATION_CONFLICT'));
 await assert.rejects(s.payments.record(s.operator,s.org,{...s.cmd,action:'refund',operationId:randomUUID(),expectedRevision:2,amountCents:9501,externalRef:'Fictional_refund_'+randomUUID(),occurredAt:new Date().toISOString()}),error('MENTOR_REFUND_AMOUNT_INVALID'));
 await assert.rejects(s.payments.record(s.operator,s.org,{...s.cmd,operationId:randomUUID()}),error('MENTOR_ORDER_REVISION_CHANGED'));
 const next={...s.slot,operationId:randomUUID(),recordId:randomUUID(),startsAt:'2027-01-02T10:00:00.000Z',endsAt:'2027-01-02T11:00:00.000Z'};await capacity.setSlot(s.operator,s.org,next);
 const i=await s.service.create(s.owner,{...s.command,operationId:randomUUID()});await s.service.match(s.operator,s.org,{...s.match,operationId:randomUUID(),sessionId:i.session.id,slotId:next.recordId});
 await assert.rejects(s.payments.record(s.operator,s.org,{...s.cmd,operationId:randomUUID(),sessionId:i.session.id,occurredAt:new Date().toISOString()}));assert.equal((await s.service.getOrder(s.owner,i.session.id)).order.status,'quoted');
});
test('actual staff authorization governs recording; actor-changing replay cannot impersonate the accepted operator',async()=>{
 const s=await ready(),other=await f.actor(true);await assert.rejects(s.payments.record(s.owner,s.org,s.cmd),error('STAFF_ROLE_REQUIRED'));
 await assert.rejects(s.payments.record(other,s.org,s.cmd),error('STAFF_ROLE_REQUIRED'));await s.payments.record(s.operator,s.org,s.cmd);
 await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,'ops',$3)",[s.org,other.userId,s.operator.userId]);
 await assert.rejects(s.payments.record(other,s.org,s.cmd),error('MENTOR_PAYMENT_OPERATION_CONFLICT'));
 await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[s.operator.userId]);await assert.rejects(s.payments.record(s.operator,s.org,s.cmd),error('AUTH_REQUIRED'));
});
test('real audit failure rolls back settlement proof, state and minimal financial record together',async()=>{
 const s=await ready();await f.db.query("CREATE FUNCTION reject_payment_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='mentor_payment_recorded' THEN RAISE EXCEPTION 'Fictional audit failure'; END IF; RETURN NEW; END $$");
 await f.db.query('CREATE TRIGGER reject_payment_audit BEFORE INSERT ON platform_staff_audit FOR EACH ROW EXECUTE FUNCTION reject_payment_audit()');
 try{await assert.rejects(s.payments.record(s.operator,s.org,s.cmd));assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).order.status,'quoted');
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_financial_records WHERE id=(SELECT order_id FROM platform_mentor_sessions WHERE id=$1)',[s.intent.session.id])).rows[0].n,0);
 }finally{await f.db.query('DROP TRIGGER reject_payment_audit ON platform_staff_audit');await f.db.query('DROP FUNCTION reject_payment_audit()');}
});
test('abort after actual financial insertion rolls back quote settlement and audit, rather than acknowledging a payment',async()=>{
 const s=await ready(),abort=new AbortController(),real=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);intercept.query=async(...args:any[])=>{
  const r=await(query as any)(...args);if(typeof args[0]==='string'&&args[0].includes('INSERT INTO platform_mentor_financial_records('))abort.abort();return r;};return run(intercept);});
 try{await assert.rejects(s.payments.record(s.operator,s.org,s.cmd,abort.signal));}finally{f.db.withBoundedTransaction=real;}
 assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).order.status,'quoted');
});
test('owner deletion clears private intents/receipts and leaves only minimal encrypted settlement data, without a retained owner/org/file link',async()=>{
 const s=await ready();await s.payments.record(s.operator,s.org,s.cmd);const id=(await s.service.getOrder(s.owner,s.intent.session.id)).order.id;
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[s.owner.userId]);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_orders WHERE id=$1',[id])).rows[0].n,0);
 const row=(await f.db.query('SELECT * FROM platform_mentor_financial_records WHERE id=$1',[id])).rows[0];assert(row);
 const value=f.crypto.openUtf8(row.payload_ciphertext,{table:'mentor_financial',column:'payload',rowId:id,ownerId:id,revision:1});
 for(const v of [s.owner.userId,s.org,s.operator.userId,s.ref,s.command.intentNote,s.command.contactName])assert(!value.includes(v));assert(value.includes(s.cmd.externalRef));
 await assert.rejects(f.db.query('DELETE FROM platform_mentor_financial_proofs WHERE record_id=$1',[id]));
});
test('settlement/financial projection corruption and authentic older ciphertext cannot roll back immutable accepted payment/refund receipts',async()=>{
 const s=await ready();await s.payments.record(s.operator,s.org,s.cmd);const id=(await s.service.getOrder(s.owner,s.intent.session.id)).order.id,old=(await f.db.query('SELECT * FROM platform_mentor_orders WHERE id=$1',[id])).rows[0];
 await f.db.query('UPDATE platform_mentor_orders SET payment_ref=$2 WHERE id=$1',[id,'Fictional_changed']);await assert.rejects(s.service.getOrder(s.owner,s.intent.session.id),error('MENTOR_INTENT_STORAGE_UNAVAILABLE'));
 await f.db.query('UPDATE platform_mentor_orders SET payment_ref=$2 WHERE id=$1',[id,old.payment_ref]);
 await s.payments.record(s.operator,s.org,{...s.cmd,action:'refund',operationId:randomUUID(),expectedRevision:2,amountCents:1000,externalRef:'Fictional_refund_'+randomUUID(),occurredAt:new Date().toISOString()});
 await f.db.query("UPDATE platform_mentor_orders SET status='paid',revision=2,last_operation_id=$2,updated_at=$3,payload_ciphertext=$4 WHERE id=$1",[id,old.last_operation_id,old.updated_at,old.payload_ciphertext]);
 await assert.rejects(s.service.getOrder(s.owner,s.intent.session.id),error('MENTOR_INTENT_STORAGE_UNAVAILABLE'));await assert.rejects(f.db.query('DELETE FROM platform_mentor_order_proofs WHERE order_id=$1',[id]));
});

test('real password-cookie owned HTTP and Web client read actual paid/refunded states; no public settlement issuer or private receipt leakage exists',async()=>{
 const s=await ready();await s.payments.record(s.operator,s.org,s.cmd);
 const origin='https://fictional-payment.example.invalid',password='Fictional-payment-password-123';
 const system=await buildApp({db:f.db,storage:blobs,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),...s.config,allowedOrigins:new Set([origin]),workbenchEnabled:false},enableQueue:false,
  runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No external model');}})});
 try{await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[s.owner.userId,await hashPassword(password)]);
  const login=await system.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:s.owner.userId+'@example.invalid',password}});assert.equal(login.statusCode,200,login.body);
  const cookies=login.headers['set-cookie'],cookie=(Array.isArray(cookies)?cookies[0]:cookies)!.split(';')[0],headers={origin,cookie,[PLATFORM_ACCOUNT_HEADER]:s.owner.userId};
  const client={account:{accountId:s.owner.userId},isCurrent:()=>true,request:async(path:string,init?:RequestInit)=>{
   const r=await system.app.inject({url:'/api/platform'+path,headers});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'private, no-store');return r.json();}};
  const pair=await readMentorOrder(client,s.intent.session.id);assert.equal(pair.order.status,'paid');for(const key of ['policyEvidence','evidenceRef','actorAuthVersion','retentionDays'])assert(!JSON.stringify(pair).includes(key));
  await s.service.cancel(s.owner,s.intent.session.id,{operationId:randomUUID(),expectedRevision:2});assert.equal((await readMentorOrder(client,s.intent.session.id)).order.status,'paid');
  assert.equal((await system.app.inject({method:'POST',url:'/api/platform/career/mentor-intents/'+s.intent.session.id+'/pay',headers,payload:s.cmd})).statusCode,404);
 }finally{await system.app.close();}
});
test('actual CLI requires configured retention, owned 600-mode receipt input and real staff session, and prints no receipt or identity fields',async()=>{
 const s=await ready(),token=randomUUID()+randomUUID(),url=new URL(readConfig().databaseUrl);url.searchParams.set('options','-c search_path='+f.schema);
 await f.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[s.operator.userId,tokenHash(token)]);
 const credentials=join(dir,'fictional-payment-session.json'),input=join(dir,'fictional-payment-input.json'),legal=join(dir,'fictional-payment-legal.json');
 await writeFile(credentials,JSON.stringify({userId:s.operator.userId,token}),{mode:0o600});await writeFile(input,JSON.stringify(s.cmd),{mode:0o600});await writeFile(legal,JSON.stringify(FICTIONAL_LEGAL),{mode:0o600});
 const execute=promisify(execFile),env={...process.env,PLATFORM_DATABASE_URL:url.toString(),PLATFORM_STORAGE_DIR:dir,PLATFORM_DATA_KEY:'e5'.repeat(32),
  PLATFORM_MENTOR_ORG_ID:s.org,PLATFORM_MENTOR_RETENTION_DAYS:'365',PLATFORM_MENTOR_RETENTION_EVIDENCE_REF:s.ref,PLATFORM_LEGAL_BUNDLE_FILE:legal,PLATFORM_ALLOW_PROVIDER_CALLS:'0'};
 const run=()=>execute(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/mentor-payment-main.ts',import.meta.url)),'record','--org',s.org,'--session-file',credentials,'--input-file',input],{env,timeout:10000,maxBuffer:4096});
 const r=await run();assert.equal(JSON.parse(r.stdout).status,'paid');assert.equal(r.stderr,'');for(const v of [token,s.cmd.externalRef,s.ref,s.command.intentNote,'policyEvidence'])assert(!r.stdout.includes(v));
 assert.equal(JSON.parse((await run()).stdout).replayed,true);await chmod(input,0o644);await assert.rejects(run(),(e:any)=>{assert.equal(e.stdout,'');assert(!e.stderr.includes(token));return true;});
});
test('payment/refund inputs are closed explicit real receipt declarations, not caller-selected owner, order, price, refund status or free entitlement',async()=>{
 const s=await ready();for(const patch of [{ownerId:s.owner.userId},{orderId:randomUUID()},{priceCents:1},{status:'paid'},{action:'charge'},{amountCents:0},{confirmRecorded:false},
  {retentionDays:1},{externalRef:'fictional@example.invalid'},{meetingUrl:'https://example.invalid'}])assert.throws(()=>parseMentorPaymentCommand({...s.cmd,...patch}));
 let invoked=0;const bad={...s.cmd};Object.defineProperty(bad,'externalRef',{enumerable:true,get(){invoked++;return 'Fictional';}});assert.throws(()=>parseMentorPaymentCommand(bad));assert.equal(invoked,0);
});
test('retained source receipt hash prevents re-crediting an actual payment after the original private owner/order have been deleted',async()=>{
 const s=await ready();await s.payments.record(s.operator,s.org,s.cmd);await f.db.query('DELETE FROM platform_users WHERE id=$1',[s.owner.userId]);
 const other=await f.actor(),slot={...s.slot,operationId:randomUUID(),recordId:randomUUID(),startsAt:'2027-01-03T10:00:00.000Z',endsAt:'2027-01-03T11:00:00.000Z'};
 await capacity.setSlot(s.operator,s.org,slot);const i=await s.service.create(other,{...s.command,operationId:randomUUID()});await s.service.match(s.operator,s.org,{...s.match,sessionId:i.session.id,operationId:randomUUID(),slotId:slot.recordId});
 await assert.rejects(s.payments.record(s.operator,s.org,{...s.cmd,sessionId:i.session.id,operationId:randomUUID(),occurredAt:new Date().toISOString()}));
 assert.equal((await s.service.getOrder(other,i.session.id)).order.status,'quoted');
});

// Orphan fixtures model a previously retained anonymous ledger; they grant no payment or staff authority.
async function retainedOrphan(retentionUntil='2020-01-01T00:00:00.000Z'){
 const id=randomUUID(),externalRef='Fictional_retained_'+id,externalRefHash=createHash('sha256').update(externalRef).digest('hex');
 const value={revision:1,priceCents:5000,refundedCents:0,currency:'USD',paymentRef:externalRef,handoffCode:'a'.repeat(43),
  paidAt:'2019-01-01T00:00:00.000Z',updatedAt:'2019-01-01T00:00:00.000Z',status:'paid',retentionUntil};
 await f.db.withBoundedTransaction(async c=>{
  await c.query('INSERT INTO platform_mentor_financial_records(id,revision,retention_until,payload_ciphertext) VALUES($1,1,$2,$3)',[id,retentionUntil,
   f.crypto.sealUtf8(JSON.stringify(value),{table:'mentor_financial',column:'payload',rowId:id,ownerId:id,revision:1})]);
  await c.query("INSERT INTO platform_mentor_financial_proofs(record_id,revision,action,external_ref_hash,proof_ciphertext) VALUES($1,1,'pay',$2,$3)",[id,externalRefHash,
   f.crypto.sealUtf8(JSON.stringify({digest:mentorLedgerDigest(value),action:'pay',externalRefHash}),{table:'mentor_financial_proof',column:'payload',rowId:id,ownerId:id,revision:1})]);
 });return id;
}
test('bounded actual retention maintenance authenticates expired orphan records, clears proofs, preserves unexpired data and rejects a corrupted expiry',async()=>{
 const ledger=new MentorFinancialLedger(f.config),old=await retainedOrphan(),future=await retainedOrphan('2030-01-01T00:00:00.000Z');
 assert.equal((await ledger.purgeExpired(f.db)).examined,1);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_financial_records WHERE id=$1',[old])).rows[0].n,0);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_financial_proofs WHERE record_id=$1',[old])).rows[0].n,0);
 await f.db.query("UPDATE platform_mentor_financial_records SET retention_until='2020-01-01T00:00:00Z' WHERE id=$1",[future]);
 await assert.rejects(ledger.purgeExpired(f.db),error('MENTOR_FINANCE_STORAGE_UNAVAILABLE'));
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_financial_records WHERE id=$1',[future])).rows[0].n,1);
 await f.db.query('DELETE FROM platform_mentor_financial_records WHERE id=$1',[future]);
 const ids=[];for(let i=0;i<101;i++)ids.push(await retainedOrphan());
 assert.equal((await ledger.purgeExpired(f.db)).examined,100);assert.equal((await ledger.purgeExpired(f.db)).examined,1);
});
test('actual operator expiry after retained financial insertion rolls back private and retained payment state before the receipt is acknowledged',async()=>{
 const s=await ready(),real=f.db.withBoundedTransaction.bind(f.db);let inserted=false;
 await f.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1",[s.operator.tokenHash]);
 f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);intercept.query=async(...args:any[])=>{
  const r=await(query as any)(...args);if(typeof args[0]==='string'&&args[0].includes('INSERT INTO platform_mentor_financial_records(')){inserted=true;await new Promise(r=>setTimeout(r,550));}return r;};return run(intercept);});
 try{await assert.rejects(s.payments.record(s.operator,s.org,s.cmd),error('AUTH_REQUIRED'));assert(inserted);}finally{f.db.withBoundedTransaction=real;}
 assert.equal((await s.service.getOrder(s.owner,s.intent.session.id)).order.status,'quoted');
});
test('retention settings reject ambiguous/zero/unbounded values and migration can be applied again without rewriting old quote or payment proofs',async()=>{
 for(const value of ['0','-1','36501','1.5',' 365','365 ','1e3'])assert.throws(()=>readConfig({...process.env,PLATFORM_MENTOR_RETENTION_DAYS:value}));
 const s=await ready();await s.payments.record(s.operator,s.org,s.cmd);const pair=await s.service.getOrder(s.owner,s.intent.session.id);
 const sql=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../migrations/071_mentor_payments.sql',import.meta.url),'utf8'));
 await f.db.withBoundedTransaction(c=>c.query(sql));assert.deepEqual((await s.service.getOrder(s.owner,s.intent.session.id)).order,pair.order);
});

test('current owner verification and legal consent are genuine prerequisites even when the original matched intent and quote were valid',async()=>{
 for(const kind of ['verification','legal']){const s=await ready();
  if(kind==='verification')await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[s.owner.userId]);
  else await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[s.owner.userId]);
  await assert.rejects(s.payments.record(s.operator,s.org,s.cmd),error(kind==='verification'?'EMAIL_VERIFICATION_REQUIRED':'TERMS_CONFIRMATION_REQUIRED'));
  assert.equal((await f.db.query('SELECT status FROM platform_mentor_orders WHERE session_id=$1',[s.intent.session.id])).rows[0].status,'quoted');
 }
});
