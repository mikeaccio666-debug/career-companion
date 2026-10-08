import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MENTOR_INTENT_PRIVACY, parseMentorServiceOffer, PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { MentorServiceOffers } from '../src/mentor-service-offers.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword, tokenHash } from '../src/auth.ts';
let f: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>, blobs: LocalBlobStorage, service: MentorServiceOffers,
  system: Awaited<ReturnType<typeof buildApp>>, dir: string, calls=0;
const origin='https://fictional-services.example.invalid', root='/api/platform/career/mentor-services/';
const error=(code:string)=>(e:unknown)=>!!e&&typeof e==='object'&&(e as {code?:string}).code===code;
before(async()=>{
  f=await createCompanionNameSafetyFixture();dir=await mkdtemp(join(tmpdir(),'fictional-services-'));await chmod(dir,0o700);blobs=new LocalBlobStorage(dir);
  service=new MentorServiceOffers(f.db,f.config,FICTIONAL_LEGAL,blobs);
  system=await buildApp({db:f.db,storage:blobs,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),dataCrypto:f.crypto,requireVerifiedEmail:true,
    allowedOrigins:new Set([origin]),workbenchEnabled:false},enableQueue:false,
    runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No provider calls');}})});
});
after(async()=>{await system?.app.close();assert.equal(calls,0);await f?.close();if(dir)await rm(dir,{recursive:true,force:true});});
async function setup(){
  const operator=await f.actor(true),owner=await f.actor(),org=randomUUID(),evidence=randomUUID();
  await f.db.query("INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,'Fictional service organization')",[org,'service_'+org.replaceAll('-','')]);
  await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,'ops',$2)",[org,operator.userId]);
  const bytes=Buffer.from('Fictional service review only. This fixture is not production legal approval.');await blobs.put(evidence,bytes);
  await f.db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'fictional-review.txt','text/plain',$3,$4)",[evidence,operator.userId,bytes.length,evidence]);
  const command={operationId:randomUUID(),offerId:randomUUID(),expectedRevision:0,reviewedAt:'2026-01-01T00:00:00.000Z',reviewEvidenceRef:evidence,
    terms:{kind:'mock_interview',title:'Fictional interview practice',durationMin:60,priceCents:12900,currency:'USD',collector:'Fictional collector',
      description:'One fictional interview practice session.',exclusions:'No interview, offer or referral is promised.',
      refundVersion:'fictional-refund-v1',refundRules:'Fictional reviewed terms, not a real refund policy.',
      appealInstructions:'Fictional private appeal channel.',disclosureVersion:'fictional-disclosure-v1',
      disclosure:'Fictional commercial relationship, not a production declaration.',
      validFrom:'2025-01-01T00:00:00.000Z',validUntil:'2028-01-01T00:00:00.000Z',earliestSlotAt:'2027-01-01T00:00:00.000Z'}};
  return {operator,owner,org,evidence,command};
}
test('migration is repeatable and seeds no real prices, slots, free diagnoses or orders',async()=>{
  await f.db.migrate();assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_service_offers')).rows[0].n,0);
  assert.equal((await f.db.query("SELECT to_regclass('platform_mentor_orders') AS orders,to_regclass('platform_mentor_sessions') AS sessions")).rows[0].orders,null);
  const s=await setup();assert.deepEqual(await service.list(s.owner,s.org),[]);
});
test('actual operator configuration, revision changes and replay produce uniform student information without internal review coordinates',async()=>{
  const s=await setup(),receipt=await service.set(s.operator,s.org,s.command);
  assert.deepEqual(receipt,{offerId:s.command.offerId,revision:1,status:'active'});
  assert.deepEqual(await service.set(s.operator,s.org,s.command),receipt);
  const offers=await service.list(s.owner,s.org);assert.equal(offers.length,1);
  const offer=parseMentorServiceOffer(offers[0]);assert.equal(offer.priceCents,12900);assert.equal(offer.availability,'available');
  assert.equal(offer.intentPrivacy,MENTOR_INTENT_PRIVACY);
  assert(!JSON.stringify(offer).includes(s.evidence));assert(!JSON.stringify(offer).includes(s.operator.userId));
  assert.deepEqual(await service.list(await f.actor(),s.org),offers);
  const update={...s.command,operationId:randomUUID(),expectedRevision:1,terms:{...s.command.terms,earliestSlotAt:null}};
  assert.equal((await service.set(s.operator,s.org,update)).revision,2);
  assert.equal((await service.list(s.owner,s.org))[0].availability,'unavailable');
  assert.equal((await service.set(s.operator,s.org,s.command)).revision,1,'replay acknowledges original operation, never publishes its stale version');
  assert.equal((await service.list(s.owner,s.org))[0].revision,2);
  await assert.rejects(service.set(s.operator,s.org,{...s.command,operationId:randomUUID()}),error('SERVICE_OFFER_REVISION_CHANGED'));
  await assert.rejects(service.set(s.operator,s.org,{...s.command,terms:{...s.command.terms,priceCents:14000}}),error('SERVICE_OFFER_OPERATION_CONFLICT'));
  const audits=(await f.db.query('SELECT action,record_count FROM platform_staff_audit WHERE user_id=$1',[s.operator.userId])).rows;
  assert.equal(audits.length,4);assert(audits.every(r=>r.action==='service_offer_set'&&r.record_count===1));
});
test('actual student, mentor/content-only staff, foreign and revoked organization membership cannot configure or inspect operator catalog',async()=>{
  const s=await setup();
  for(const [actor,role] of [[s.owner,'ops'],[await f.actor(true),'mentor'],[await f.actor(true),'content_reviewer']] as const){
    await f.db.query('INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)',[s.org,actor.userId,role,s.operator.userId]);
    await assert.rejects(service.set(actor,s.org,s.command),error('STAFF_ROLE_REQUIRED'));
    await assert.rejects(service.staffList(actor,s.org),error('STAFF_ROLE_REQUIRED'));
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_staff_audit WHERE user_id=$1 AND outcome='deny'",[actor.userId])).rows[0].n,2);
  }
  await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE user_id=$1",[s.operator.userId]);
  await assert.rejects(service.set(s.operator,s.org,s.command),error('STAFF_ROLE_REQUIRED'));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_service_offers WHERE org_id=$1',[s.org])).rows[0].n,0);
});
test('complete terms and real owned review file are required; referral/free/zero-price shortcuts and undeclared fields are rejected',async()=>{
  const s=await setup();
  for(const terms of [{...s.command.terms,kind:'referral_assessment'},{...s.command.terms,kind:'free_diagnosis'},{...s.command.terms,priceCents:0},
      {...s.command.terms,refundRules:''},{...s.command.terms,earliestSlotAt:'2024-01-01T00:00:00.000Z'},{...s.command.terms,validUntil:'2028-02-30T00:00:00.000Z'},
      {...s.command.terms,mentorId:randomUUID()}]){
    await assert.rejects(service.set(s.operator,s.org,{...s.command,terms}),error('SERVICE_OFFER_INPUT_INVALID'));
  }
  await assert.rejects(service.set(s.operator,s.org,{...s.command,reviewedAt:'2099-01-01T00:00:00.000Z'}),error('SERVICE_OFFER_INPUT_INVALID'));
  await assert.rejects(service.set(s.operator,s.org,{...s.command,reviewConfirmed:true}),error('SERVICE_OFFER_INPUT_INVALID'));
  await assert.rejects(service.set(s.operator,s.org,{...s.command,reviewEvidenceRef:randomUUID()}),error('NOT_FOUND'));
  await f.db.query('UPDATE platform_uploads SET user_id=$2 WHERE id=$1',[s.evidence,s.owner.userId]);
  await assert.rejects(service.set(s.operator,s.org,s.command),error('NOT_FOUND'));
  await f.db.query('UPDATE platform_uploads SET user_id=$2 WHERE id=$1',[s.evidence,s.operator.userId]);
  await blobs.delete(s.evidence);await assert.rejects(service.set(s.operator,s.org,s.command),error('SERVICE_OFFER_STORAGE_UNAVAILABLE'));
});
test('withdrawal is authenticated, audited, idempotent and never resurrected by an old set replay',async()=>{
  const s=await setup();await service.set(s.operator,s.org,s.command);
  const command={operationId:randomUUID(),offerId:s.command.offerId,expectedRevision:1,reason:'Fictional cancellation of availability.'};
  const receipt=await service.withdraw(s.operator,s.org,command);assert.equal(receipt.status,'withdrawn');
  assert.deepEqual(await service.withdraw(s.operator,s.org,command),receipt);assert.deepEqual(await service.list(s.owner,s.org),[]);
  await service.set(s.operator,s.org,s.command);assert.deepEqual(await service.list(s.owner,s.org),[]);
  assert.deepEqual(await service.staffList(s.operator,s.org),[receipt]);
  await assert.rejects(service.withdraw(s.operator,s.org,{...command,operationId:randomUUID()}),error('SERVICE_OFFER_REVISION_CHANGED'));
});
test('true database time removes expired offers and downgrades elapsed slots; no client-supplied clock is accepted',async()=>{
  const s=await setup(),now=Date.now(),slot=new Date(now+500).toISOString(),end=new Date(now+1800).toISOString();
  const command={...s.command,terms:{...s.command.terms,earliestSlotAt:slot,validUntil:end}};
  await service.set(s.operator,s.org,command);
  await new Promise(r=>setTimeout(r,550));assert.equal((await service.list(s.owner,s.org))[0].availability,'unavailable');
  await new Promise(r=>setTimeout(r,1300));assert.deepEqual(await service.list(s.owner,s.org),[]);
});
test('damaged columns, ciphertext and sealed state rollback cannot silently change price or availability',async()=>{
  const s=await setup();await service.set(s.operator,s.org,s.command);
  const old=(await f.db.query('SELECT * FROM platform_service_offers WHERE id=$1',[s.command.offerId])).rows[0];
  await f.db.query('UPDATE platform_service_offers SET price_cents=price_cents+1 WHERE id=$1',[s.command.offerId]);
  await assert.rejects(service.list(s.owner,s.org),error('SERVICE_OFFER_STORAGE_UNAVAILABLE'));
  await f.db.query('UPDATE platform_service_offers SET price_cents=$2 WHERE id=$1',[s.command.offerId,old.price_cents]);
  await service.set(s.operator,s.org,{...s.command,operationId:randomUUID(),expectedRevision:1,terms:{...s.command.terms,priceCents:14900}});
  await f.db.query('UPDATE platform_service_offers SET revision=1,payload_ciphertext=$2,price_cents=$3,updated_at=$4 WHERE id=$1',[s.command.offerId,old.payload_ciphertext,old.price_cents,old.updated_at]);
  await assert.rejects(service.list(s.owner,s.org),error('SERVICE_OFFER_STORAGE_UNAVAILABLE'));
  await assert.rejects(f.db.query('DELETE FROM platform_service_offer_proofs WHERE offer_id=$1',[s.command.offerId]));
});
test('cross-organization ID collisions and competing revision writes cannot acknowledge a fabricated successful update',async()=>{
  const a=await setup(),b=await setup();await service.set(a.operator,a.org,a.command);
  await assert.rejects(service.set(b.operator,b.org,{...b.command,offerId:a.command.offerId}),error('SERVICE_OFFER_REVISION_CHANGED'));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_service_offer_proofs WHERE org_id=$1',[b.org])).rows[0].n,0);
  const outcomes=await Promise.allSettled([1,2].map(n=>service.set(a.operator,a.org,{...a.command,operationId:randomUUID(),expectedRevision:1,terms:{...a.command.terms,priceCents:12900+n}})));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  const refused=outcomes.find(x=>x.status==='rejected');assert(refused?.status==='rejected'&&error('SERVICE_OFFER_REVISION_CHANGED')(refused.reason));
  await assert.rejects(service.set(a.operator,a.org,{...a.command,operationId:randomUUID(),offerId:randomUUID()}),error('SERVICE_OFFER_KIND_CONFLICT'));
});
test('aborted real blob validation rolls back offer/proof/receipt/audit; real session revocation denies reads and writes',async()=>{
  const s=await setup(),abort=new AbortController();
  const abandoned=new MentorServiceOffers(f.db,f.config,FICTIONAL_LEGAL,{stat:async key=>{const actual=await blobs.stat(key);abort.abort();return actual;}});
  await assert.rejects(abandoned.set(s.operator,s.org,s.command,abort.signal));
  for(const table of ['platform_service_offers','platform_service_offer_proofs','platform_service_offer_operations'])
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table+' WHERE org_id=$1',[s.org])).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_staff_audit WHERE user_id=$1',[s.operator.userId])).rows[0].n,0);
  await service.set(s.operator,s.org,s.command);
  await f.db.query('DELETE FROM platform_sessions WHERE user_id=ANY($1::uuid[])',[[s.owner.userId,s.operator.userId]]);
  await assert.rejects(service.list(s.owner,s.org),error('AUTH_REQUIRED'));await assert.rejects(service.withdraw(s.operator,s.org,{operationId:randomUUID(),offerId:s.command.offerId,expectedRevision:1,reason:'Fictional reason.'}),error('AUTH_REQUIRED'));
});
test('operator review and reason remain encrypted; deleted evidence and inactive organization fail closed',async()=>{
  const s=await setup();await service.set(s.operator,s.org,s.command);
  const row=(await f.db.query('SELECT payload_ciphertext FROM platform_service_offers WHERE id=$1',[s.command.offerId])).rows[0];
  assert(!row.payload_ciphertext.includes(Buffer.from(s.evidence)));assert(!row.payload_ciphertext.includes(Buffer.from(s.command.terms.refundRules)));
  await blobs.delete(s.evidence);await assert.rejects(service.list(s.owner,s.org),error('SERVICE_OFFER_STORAGE_UNAVAILABLE'));
  await f.db.query('DELETE FROM platform_uploads WHERE id=$1',[s.evidence]);assert.deepEqual(await service.list(s.owner,s.org),[]);
  await f.db.query("UPDATE platform_orgs SET status='disabled' WHERE id=$1",[s.org]);
  await assert.rejects(service.list(s.owner,s.org),error('NOT_FOUND'));
});
async function login(who:Awaited<ReturnType<typeof f.actor>>){
  const password='Fictional-service-password-123';await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
  const r=await system.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});
  assert.equal(r.statusCode,200,r.body);const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];
  return {origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId};
}
test('actual password-login catalog HTTP is account bound, student-only, no-store and read-only with closed queries',async()=>{
  const s=await setup();await service.set(s.operator,s.org,s.command);const headers=await login(s.owner);
  const r=await system.app.inject({url:root+s.org,headers});assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'private, no-store');
  assert.equal(parseMentorServiceOffer(r.json().offers[0]).id,s.command.offerId);
  for(const suffix of ['?now=2020','?kind=mock_interview','?ownerId='+s.owner.userId,'?kind=a&kind=b'])
    assert.equal((await system.app.inject({url:root+s.org+suffix,headers})).statusCode,400);
  assert.equal((await system.app.inject({url:root+s.org})).statusCode,401);
  assert.equal((await system.app.inject({url:root+s.org,headers:{...headers,[PLATFORM_ACCOUNT_HEADER]:s.operator.userId}})).statusCode,409);
  assert.equal((await system.app.inject({url:root+s.org,headers:await login(s.operator)})).statusCode,403);
  assert.equal((await system.app.inject({method:'POST',url:root+s.org,headers,payload:s.command})).statusCode,404);
  assert.equal(calls,0);
});

test('audit commit failure rolls back real configuration and its immutable evidence instead of returning success',async()=>{
  const s=await setup();
  await f.db.query(`CREATE FUNCTION reject_service_offer_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='service_offer_set' THEN RAISE EXCEPTION 'Fictional audit failure'; END IF; RETURN NEW; END $$`);
  await f.db.query('CREATE TRIGGER reject_service_offer_audit BEFORE INSERT ON platform_staff_audit FOR EACH ROW EXECUTE FUNCTION reject_service_offer_audit()');
  try {
    await assert.rejects(service.set(s.operator,s.org,s.command));
    for(const table of ['platform_service_offers','platform_service_offer_proofs','platform_service_offer_operations'])
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table+' WHERE org_id=$1',[s.org])).rows[0].n,0);
  } finally {await f.db.query('DROP TRIGGER reject_service_offer_audit ON platform_staff_audit');await f.db.query('DROP FUNCTION reject_service_offer_audit()');}
});
test('real verified-email/legal/crypto gates remain active; a caller cannot rebind captured catalog identity while blob reads await',async()=>{
  const s=await setup();await service.set(s.operator,s.org,s.command);
  await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[s.owner.userId]);
  await assert.rejects(service.list(s.owner,s.org),error('EMAIL_VERIFICATION_REQUIRED'));
  await f.db.query('UPDATE platform_users SET email_verified_at=clock_timestamp() WHERE id=$1',[s.owner.userId]);
  await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[s.owner.userId]);
  await assert.rejects(service.list(s.owner,s.org),error('TERMS_CONFIRMATION_REQUIRED'));
  await assert.rejects(new MentorServiceOffers(f.db,{requireVerifiedEmail:true},FICTIONAL_LEGAL,blobs).staffList(s.operator,s.org),error('SERVICE_OFFER_STORAGE_UNAVAILABLE'));
  const actual=await f.actor(),other=await f.actor(true),caller={...actual};
  const switched=new MentorServiceOffers(f.db,f.config,FICTIONAL_LEGAL,{stat:async key=>{
    caller.userId=other.userId;caller.tokenHash=other.tokenHash;return blobs.stat(key);
  }});
  assert.equal((await switched.list(caller,s.org)).length,1);
  assert.equal(caller.userId,other.userId,'fixture actually changed caller during the awaited read');
});
test('slot that expires while actual review-file validation awaits cannot be published as available',async()=>{
  const s=await setup(),slot=new Date(Date.now()+350).toISOString();
  const slow=new MentorServiceOffers(f.db,f.config,FICTIONAL_LEGAL,{stat:async key=>{
    const actual=await blobs.stat(key);await new Promise(r=>setTimeout(r,400));return actual;
  }});
  await assert.rejects(slow.set(s.operator,s.org,{...s.command,terms:{...s.command.terms,earliestSlotAt:slot}}),error('SERVICE_OFFER_INPUT_INVALID'));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_service_offers WHERE org_id=$1',[s.org])).rows[0].n,0);
});

test('actual remote CLI configures, lists and withdraws through a real session; reset and shared files fail without leaking input',async()=>{
  const s=await setup(),token=randomUUID()+randomUUID(),url=new URL(readConfig().databaseUrl);url.searchParams.set('options','-c search_path='+f.schema);
  await f.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[s.operator.userId,tokenHash(token)]);
  const credential=join(dir,'fictional-service-session.json'),input=join(dir,'fictional-service-input.json');
  await writeFile(credential,JSON.stringify({userId:s.operator.userId,token}),{mode:0o600});
  await writeFile(input,JSON.stringify(s.command),{mode:0o600});
  const execute=promisify(execFile),env={...process.env,PLATFORM_DATABASE_URL:url.toString(),PLATFORM_STORAGE_DIR:dir,PLATFORM_DATA_KEY:'e5'.repeat(32),PLATFORM_ALLOW_PROVIDER_CALLS:'0'};
  const run=(action:string)=>execute(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/mentor-service-main.ts',import.meta.url)),
    action,'--org',s.org,'--session-file',credential,...(action==='list'?[]:['--input-file',input])],{env,timeout:10000,maxBuffer:4096});
  const published=await run('set');assert.equal(published.stderr,'');assert.deepEqual(JSON.parse(published.stdout),{offerId:s.command.offerId,revision:1,status:'active'});
  assert(!published.stdout.includes(token));assert(!published.stdout.includes(s.command.terms.refundRules));
  assert.equal(JSON.parse((await run('list')).stdout)[0].revision,1);
  await writeFile(input,JSON.stringify({operationId:randomUUID(),offerId:s.command.offerId,expectedRevision:1,reason:'Fictional CLI withdrawal.'}));
  assert.equal(JSON.parse((await run('withdraw')).stdout).status,'withdrawn');
  await chmod(credential,0o644);
  await assert.rejects(run('list'),(e:any)=>{assert.equal(e.code,1);assert.equal(e.stdout,'');assert(!e.stderr.includes(token));return true;});
  await chmod(credential,0o600);await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[s.operator.userId]);
  await assert.rejects(run('list'),(e:any)=>{assert.equal(e.code,1);assert.equal(e.stdout,'');assert(!e.stderr.includes(token));return true;});
});
test('organization removal cascades offers and immutable records without leaving detached operational evidence',async()=>{
  const s=await setup();await service.set(s.operator,s.org,s.command);
  await f.db.query('DELETE FROM platform_orgs WHERE id=$1',[s.org]);
  for(const table of ['platform_service_offers','platform_service_offer_proofs','platform_service_offer_operations'])
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table+' WHERE org_id=$1',[s.org])).rows[0].n,0);
});
