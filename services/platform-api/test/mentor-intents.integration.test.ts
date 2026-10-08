import { readMentorEntry,readMentorIntents,changeMentorIntent,observeMentorIntent,freezeMentorMutation,type MentorIntentClient } from '../../../apps/web/src/mentor-intent-api.ts';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,chmod,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM_ACCOUNT_HEADER,MENTOR_INTENT_PRIVACY,MENTOR_INTENT_PRIVACY_VERSION,parseMentorIntent,parseMentorIntentCommand } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { MentorServiceOffers } from '../src/mentor-service-offers.ts';
import { MentorIntents } from '../src/mentor-intents.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword } from '../src/auth.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,offers:MentorServiceOffers,blobs:LocalBlobStorage,dir:string,calls=0;
const origin='https://fictional-mentor-intents.example.invalid',root='/api/platform/career/mentor-intents';
const error=(code:string)=>(e:unknown)=>!!e&&typeof e==='object'&&(e as {code?:string}).code===code;
before(async()=>{f=await createCompanionNameSafetyFixture();dir=await mkdtemp(join(tmpdir(),'fictional-mentor-intents-'));await chmod(dir,0o700);blobs=new LocalBlobStorage(dir);offers=new MentorServiceOffers(f.db,f.config,FICTIONAL_LEGAL,blobs);});
after(async()=>{assert.equal(calls,0);await f?.close();if(dir)await rm(dir,{recursive:true,force:true});});
async function setup(){
  const org=randomUUID(),operator=await f.actor(true),owner=await f.actor(),evidence=randomUUID();
  await f.db.query("INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,'Fictional intent organization')",[org,'intent_'+org.replaceAll('-','')]);
  await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,'ops',$2)",[org,operator.userId]);
  const bytes=Buffer.from('Fictional reviewed terms; not production approval.');await blobs.put(evidence,bytes);
  await f.db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'fictional.txt','text/plain',$3,$4)",[evidence,operator.userId,bytes.length,evidence]);
  const source={operationId:randomUUID(),offerId:randomUUID(),expectedRevision:0,reviewedAt:'2026-01-01T00:00:00.000Z',reviewEvidenceRef:evidence,
    terms:{kind:'resume_direction',title:'Fictional resume discussion',durationMin:45,priceCents:9900,currency:'USD',collector:'Fictional collector',
      description:'Discuss fictional resume evidence.',exclusions:'No outcomes or referral promised.',refundVersion:'fictional-1',refundRules:'Fictional refund rule.',
      appealInstructions:'Fictional appeal channel.',disclosureVersion:'fictional-1',disclosure:'Fictional relationship.',
      validFrom:'2025-01-01T00:00:00.000Z',validUntil:'2028-01-01T00:00:00.000Z',earliestSlotAt:'2027-01-01T00:00:00.000Z'}};
  await offers.set(operator,org,source);
  const config={...f.config,mentorOrganizationId:org},service=new MentorIntents(f.db,config,FICTIONAL_LEGAL,offers);
  const command={operationId:randomUUID(),offerId:source.offerId,offerRevision:1,contactName:'Fictional student',intentNote:'Discuss my fictional IBM class report.\nI want to practice explaining one finding.',
    privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,confirmVisibility:true};
  return {org,operator,owner,evidence,source,config,service,command};
}
test('real authenticated intent freezes current service provenance, records only own typed demand/contact and creates no match or quote',async()=>{
  const s=await setup(),entry=await s.service.entry(s.owner);
  assert.equal(entry.configured,true);assert.equal(entry.intentPrivacy,MENTOR_INTENT_PRIVACY);assert.equal(entry.contactEmail,s.owner.userId+'@example.invalid');
  const result=await s.service.create(s.owner,s.command),session=parseMentorIntent(result.session);
  assert.equal(session.status,'requested');assert.equal(session.ownerId,s.owner.userId);assert.equal(session.contactEmail,entry.contactEmail);
  assert.equal(session.contactName,s.command.contactName);assert.equal(session.intentNote,s.command.intentNote);assert.equal(session.orderId,null);assert.equal(session.mentorId,null);
  assert(!JSON.stringify(result).includes('priceCents'));assert(!JSON.stringify(result).includes('reviewEvidenceRef'));
  const row=(await f.db.query('SELECT payload_ciphertext FROM platform_mentor_sessions WHERE id=$1',[session.id])).rows[0];
  assert(!row.payload_ciphertext.includes(Buffer.from(s.command.intentNote)));assert(!row.payload_ciphertext.includes(Buffer.from(entry.contactEmail)));
  assert.deepEqual((await s.service.list(s.owner)).sessions,[session]);
  const operations=(await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_intent_operations WHERE session_id=$1',[session.id])).rows[0].n;assert.equal(operations,1);
});
test('repeated and simultaneous real submissions have one effect; cancellation and create replay return current state without resurrection',async()=>{
  const s=await setup(),[a,b]=await Promise.all([s.service.create(s.owner,s.command),s.service.create(s.owner,s.command)]);
  assert.equal(a.session.id,b.session.id);assert.equal(Number(a.operation.replayed)+Number(b.operation.replayed),1);
  const cancel={operationId:randomUUID(),expectedRevision:1};
  const cancelled=await s.service.cancel(s.owner,a.session.id,cancel);assert.equal(cancelled.session.status,'cancelled');
  assert.equal((await s.service.cancel(s.owner,a.session.id,cancel)).operation.replayed,true);
  const replay=await s.service.create(s.owner,s.command);assert.equal(replay.session.status,'cancelled');assert.equal(replay.operation.appliedRevision,1);
  const observed=await s.service.observe(s.owner,s.command.operationId);assert.equal(observed.session.status,'cancelled');assert.equal(observed.operation.appliedRevision,1);
  await assert.rejects(s.service.cancel(s.owner,a.session.id,{...cancel,operationId:randomUUID()}),error('MENTOR_INTENT_REVISION_CHANGED'));
  await assert.rejects(s.service.create(s.owner,{...s.command,intentNote:'A different fictional need.'}),error('MENTOR_INTENT_OPERATION_CONFLICT'));
});
test('owner and original operation isolation prevent foreign read/cancel; same nonce for different authenticated owners creates separate intents',async()=>{
  const s=await setup(),other=await f.actor(),created=await s.service.create(s.owner,s.command);
  await assert.rejects(s.service.get(other,created.session.id),error('NOT_FOUND'));
  await assert.rejects(s.service.observe(other,s.command.operationId),error('NOT_FOUND'));
  await assert.rejects(s.service.cancel(other,created.session.id,{operationId:randomUUID(),expectedRevision:1}),error('NOT_FOUND'));
  await assert.rejects(s.service.list(other,{after:created.session.id}),error('NOT_FOUND'));
  assert.deepEqual((await s.service.list(other)).sessions,[]);
  const own=await s.service.create(other,s.command);assert.notEqual(own.session.id,created.session.id);assert.equal(own.session.contactEmail,other.userId+'@example.invalid');
});
test('visibility confirmation is explicit/versioned; contact email, sensitive attachments, org choice, status, free/referral or legacy commerce cannot be supplied',async()=>{
  const s=await setup();
  for(const patch of [{confirmVisibility:false},{confirmVisibility:'true'},{privacyVersion:'old'}, {contactEmail:'other@example.invalid'},
    {organizationId:randomUUID()},{memoryIds:[randomUUID()]},{identityDates:['2028-01-01']},{status:'matched'},{priceCents:0},
    {kind:'free_diagnosis'},{referral:true},{mentorId:s.operator.userId},{intentNote:'\nBad whitespace'},{contactName:'Bad\u202ename'}])
    await assert.rejects(s.service.create(s.owner,{...s.command,...patch}),error('MENTOR_INTENT_INPUT_INVALID'));
  let getters=0;const bad={...s.command};Object.defineProperty(bad,'intentNote',{get(){getters++;return 'Bad';},enumerable:true});
  assert.throws(()=>parseMentorIntentCommand(bad));assert.equal(getters,0);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_sessions WHERE org_id=$1',[s.org])).rows[0].n,0);
});
test('actual catalog version, withdrawal, real file and availability are rechecked; unchanged nonce cannot convert earlier consent to newer terms',async()=>{
  const s=await setup();
  await offers.set(s.operator,s.org,{...s.source,operationId:randomUUID(),expectedRevision:1,terms:{...s.source.terms,priceCents:14900}});
  await assert.rejects(s.service.create(s.owner,s.command),error('MENTOR_SERVICE_OFFER_CHANGED'));
  const current={...s.command,offerRevision:2};const saved=await s.service.create(s.owner,current);assert.equal(saved.session.offerRevision,2);
  await offers.set(s.operator,s.org,{...s.source,operationId:randomUUID(),expectedRevision:2,terms:{...s.source.terms,earliestSlotAt:null}});
  await assert.rejects(s.service.create(s.owner,{...s.command,operationId:randomUUID(),offerRevision:3}),error('MENTOR_SERVICE_UNAVAILABLE'));
  await offers.withdraw(s.operator,s.org,{operationId:randomUUID(),offerId:s.source.offerId,expectedRevision:3,reason:'Fictional unavailable service.'});
  await assert.rejects(s.service.create(s.owner,{...s.command,operationId:randomUUID(),offerRevision:4}),error('MENTOR_SERVICE_UNAVAILABLE'));
  assert.equal((await s.service.create(s.owner,current)).session.id,saved.session.id,'genuine original intent remains history, not a new quote or availability grant');
  assert.equal((await s.service.get(s.owner,saved.session.id)).status,'requested');
});
test('missing partner configuration is truthful and cannot accept a request through arbitrary offer IDs',async()=>{
  const s=await setup(),service=new MentorIntents(f.db,f.config,FICTIONAL_LEGAL,offers);
  const entry=await service.entry(s.owner);assert.equal(entry.configured,false);assert.deepEqual(entry.offers,[]);
  await assert.rejects(service.create(s.owner,s.command),error('MENTOR_SERVICE_UNAVAILABLE'));
  assert.deepEqual((await service.list(s.owner)).sessions,[]);
});
test('operator reads only confirmed intent fields, with current org roles and committed audit; tutor and student roles do not confer access',async()=>{
  const s=await setup();await s.service.create(s.owner,s.command);
  const data=await s.service.opsList(s.operator,s.org);assert.equal(data.intents.length,1);
  const note=data.intents[0];assert.deepEqual(Object.keys(note).sort(),['contactEmail','contactName','createdAt','durationMin','id','intentNote','kind','status'].sort());
  assert.equal(note.contactEmail,s.owner.userId+'@example.invalid');assert.equal(note.intentNote,s.command.intentNote);
  assert(!JSON.stringify(note).includes('privacyVersion'));assert(!JSON.stringify(note).includes('identity'));assert(!JSON.stringify(note).includes('acceptedOffer'));
  const audit=(await f.db.query("SELECT action,outcome,record_count FROM platform_staff_audit WHERE user_id=$1 AND action='mentor_intents_viewed'",[s.operator.userId])).rows;
  assert.deepEqual(audit,[{action:'mentor_intents_viewed',outcome:'allow',record_count:1}]);
  for(const [who,role] of [[s.owner,'ops'],[await f.actor(true),'mentor']] as const){
    await f.db.query('INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)',[s.org,who.userId,role,s.operator.userId]);
    await assert.rejects(s.service.opsList(who,s.org),error('STAFF_ROLE_REQUIRED'));
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_staff_audit WHERE user_id=$1 AND action='mentor_intents_viewed' AND outcome='deny'",[who.userId])).rows[0].n,1);
  }
  await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE user_id=$1",[s.operator.userId]);
  await assert.rejects(s.service.opsList(s.operator,s.org),error('STAFF_ROLE_REQUIRED'));
});
test('real owner pagination and operator pagination retain every request while foreign org anchors cannot move the read scope',async()=>{
  const s=await setup();const ids=new Set<string>();
  for(let i=0;i<51;i++)ids.add((await s.service.create(s.owner,{...s.command,operationId:randomUUID(),intentNote:'Fictional need '+i})).session.id);
  const a=await s.service.list(s.owner);assert.equal(a.sessions.length,50);assert(a.nextCursor);
  const b=await s.service.list(s.owner,{after:a.nextCursor});assert.equal(b.sessions.length,1);assert.equal(b.nextCursor,null);
  assert.deepEqual(new Set([...a.sessions,...b.sessions].map(x=>x.id)),ids);
  const x=await s.service.opsList(s.operator,s.org),y=await s.service.opsList(s.operator,s.org,{after:x.nextCursor!});
  assert.equal(x.intents.length+y.intents.length,51);
  const foreign=await setup(),other=await foreign.service.create(foreign.owner,foreign.command);
  await assert.rejects(s.service.opsList(s.operator,s.org,{after:other.session.id}),error('NOT_FOUND'));
});
test('altered columns, ciphertext and rollback to genuine old requested state fail instead of exposing stale consent',async()=>{
  const s=await setup(),saved=await s.service.create(s.owner,s.command),id=saved.session.id;
  const old=(await f.db.query('SELECT * FROM platform_mentor_sessions WHERE id=$1',[id])).rows[0];
  await f.db.query("UPDATE platform_mentor_sessions SET status='matched' WHERE id=$1",[id]);await assert.rejects(s.service.get(s.owner,id),error('MENTOR_INTENT_STORAGE_UNAVAILABLE'));
  await f.db.query("UPDATE platform_mentor_sessions SET status='requested' WHERE id=$1",[id]);
  await s.service.cancel(s.owner,id,{operationId:randomUUID(),expectedRevision:1});
  await f.db.query("UPDATE platform_mentor_sessions SET status='requested',revision=1,last_operation_id=$2,updated_at=$3,payload_ciphertext=$4 WHERE id=$1",[id,old.last_operation_id,old.updated_at,old.payload_ciphertext]);
  await assert.rejects(s.service.get(s.owner,id),error('MENTOR_INTENT_STORAGE_UNAVAILABLE'));
  await assert.rejects(f.db.query('DELETE FROM platform_mentor_intent_operations WHERE session_id=$1',[id]));
  await assert.rejects(s.service.opsList(s.operator,s.org),error('MENTOR_INTENT_STORAGE_UNAVAILABLE'));
});
test('actual revoked session, changed terms and staff account cannot submit; abort during real service-file read creates no request',async()=>{
  const s=await setup(),abort=new AbortController();
  const cancellingOffers=new MentorServiceOffers(f.db,s.config,FICTIONAL_LEGAL,{stat:async key=>{const actual=await blobs.stat(key);abort.abort();return actual;}});
  const cancelled=new MentorIntents(f.db,s.config,FICTIONAL_LEGAL,cancellingOffers);
  await assert.rejects(cancelled.create(s.owner,s.command,abort.signal));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_sessions WHERE org_id=$1',[s.org])).rows[0].n,0);
  await assert.rejects(s.service.create(s.operator,s.command),error('STUDENT_ACCOUNT_REQUIRED'));
  await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[s.owner.userId]);
  await assert.rejects(s.service.create(s.owner,s.command),error('TERMS_CONFIRMATION_REQUIRED'));
  await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1',[s.owner.userId]);await assert.rejects(s.service.entry(s.owner),error('AUTH_REQUIRED'));
});
test('owner account deletion cascades confirmed contact, note and immutable receipts without publishing personal data',async()=>{
  const s=await setup(),saved=await s.service.create(s.owner,s.command);await f.db.query('DELETE FROM platform_users WHERE id=$1',[s.owner.userId]);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_sessions WHERE id=$1',[saved.session.id])).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_intent_operations WHERE user_id=$1',[s.owner.userId])).rows[0].n,0);
  assert.deepEqual((await s.service.opsList(s.operator,s.org)).intents,[]);
});
async function login(app:Awaited<ReturnType<typeof buildApp>>['app'],who:Awaited<ReturnType<typeof f.actor>>){
  const password='Fictional-mentor-password-123';await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
  const r=await app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});
  assert.equal(r.statusCode,200,r.body);const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];return {origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId};
}
test('actual password-cookie HTTP performs explicit intent/cancel/observe and enforces CSRF, owner window and staff read boundaries',async()=>{
  const s=await setup(),system=await buildApp({db:f.db,storage:blobs,legalBundle:FICTIONAL_LEGAL,
    config:{...readConfig(),...s.config,allowedOrigins:new Set([origin]),workbenchEnabled:false},enableQueue:false,
    runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No provider calls');}})});
  try{
    const headers=await login(system.app,s.owner),staff=await login(system.app,s.operator);
    const entry=await system.app.inject({url:root+'/entry',headers});assert.equal(entry.statusCode,200,entry.body);assert.equal(entry.headers['cache-control'],'private, no-store');
    const saved=await system.app.inject({method:'POST',url:root,headers,payload:s.command});assert.equal(saved.statusCode,201,saved.body);
    const id=parseMentorIntent(saved.json().session).id;assert.equal(saved.headers['cache-control'],'private, no-store');
    assert.equal((await system.app.inject({method:'POST',url:root,headers,payload:s.command})).statusCode,200);
    assert.equal((await system.app.inject({url:root+'?after='+id,headers})).statusCode,200);
    const viewed=await system.app.inject({url:'/api/platform/staff/orgs/'+s.org+'/mentor-intents',headers:staff});assert.equal(viewed.statusCode,200,viewed.body);assert.equal(viewed.json().intents.length,1);
    assert.equal((await system.app.inject({url:'/api/platform/staff/orgs/'+s.org+'/mentor-intents',headers})).statusCode,403);
    assert.equal((await system.app.inject({method:'POST',url:root,headers:{...headers,origin:'https://evil.invalid'},payload:{...s.command,operationId:randomUUID()}})).statusCode,403);
    assert.equal((await system.app.inject({url:root,headers:{...headers,[PLATFORM_ACCOUNT_HEADER]:s.operator.userId}})).statusCode,409);
    for(const path of [root+'?status=requested',root+'?after=a&after=b',root+'/entry?organizationId='+s.org,root+'/'+id+'?sensitive=true'])
      assert.equal((await system.app.inject({url:path,headers})).statusCode,400);
    assert.equal((await system.app.inject({method:'POST',url:root+'/'+id+'/cancel',headers,payload:{operationId:randomUUID(),expectedRevision:1}})).statusCode,200);
    assert.equal((await system.app.inject({url:root+'/operations/'+s.command.operationId,headers})).json().session.status,'cancelled');
    assert.equal((await system.app.inject({url:root})).statusCode,401);
    assert.equal((await system.app.inject({method:'POST',url:'/api/platform/staff/orgs/'+s.org+'/mentor-intents',headers:staff,payload:{status:'matched'}})).statusCode,404);
    assert.equal(calls,0);
  }finally{await system.app.close();}
});

test('actual portable Web client uses the authenticated HTTP entry/create/observe/cancel flow and rejects account invalidation',async()=>{
  const s=await setup(),system=await buildApp({db:f.db,storage:blobs,legalBundle:FICTIONAL_LEGAL,
    config:{...readConfig(),...s.config,allowedOrigins:new Set([origin]),workbenchEnabled:false},enableQueue:false,
    runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No provider calls');}})});
  try{
    const headers=await login(system.app,s.owner);let live=true;
    const client:MentorIntentClient={account:{accountId:s.owner.userId},isCurrent:()=>live,
      async request<T>(path:string,init?:RequestInit):Promise<T>{
        const reply=await system.app.inject({method:(init?.method??'GET') as any,url:'/api/platform'+path,headers,
          payload:init?.body===undefined?undefined:JSON.parse(String(init.body))});
        if(reply.statusCode>=400)throw Error('Fictional HTTP failure');return reply.json() as T;
      }};
    const entry=await readMentorEntry(client);assert.equal(entry.contactEmail,s.owner.userId+'@example.invalid');
    const intent=freezeMentorMutation({action:'create',sessionId:null,body:s.command});assert(Object.isFrozen(intent.body));
    const saved=await changeMentorIntent(client,intent);assert.equal(saved.session.intentNote,s.command.intentNote);
    assert.equal((await readMentorIntents(client)).sessions[0].id,saved.session.id);
    const observed=await observeMentorIntent(client,intent);assert.equal(observed.operation.id,s.command.operationId);
    const cancel=freezeMentorMutation({action:'cancel',sessionId:saved.session.id,body:{operationId:randomUUID(),expectedRevision:1}});
    assert.equal((await changeMentorIntent(client,cancel)).session.status,'cancelled');
    assert.equal((await observeMentorIntent(client,intent)).session.status,'cancelled');
    live=false;await assert.rejects(readMentorEntry(client));await assert.rejects(changeMentorIntent(client,intent));
  }finally{await system.app.close();}
});
test('operator audit failure exposes no confirmed demand or contact data',async()=>{
  const s=await setup();await s.service.create(s.owner,s.command);
  await f.db.query(`CREATE FUNCTION reject_mentor_intent_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='mentor_intents_viewed' THEN RAISE EXCEPTION 'Fictional audit failure'; END IF; RETURN NEW; END $$`);
  await f.db.query('CREATE TRIGGER reject_mentor_intent_audit BEFORE INSERT ON platform_staff_audit FOR EACH ROW EXECUTE FUNCTION reject_mentor_intent_audit()');
  try{await assert.rejects(s.service.opsList(s.operator,s.org));
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_staff_audit WHERE user_id=$1 AND action='mentor_intents_viewed'",[s.operator.userId])).rows[0].n,0);
  }finally{await f.db.query('DROP TRIGGER reject_mentor_intent_audit ON platform_staff_audit');await f.db.query('DROP FUNCTION reject_mentor_intent_audit()');}
});
test('organization removal and repeat migration leave no detached user contact or consent operations',async()=>{
  const s=await setup();await s.service.create(s.owner,s.command);await f.db.migrate();
  await f.db.query('DELETE FROM platform_orgs WHERE id=$1',[s.org]);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_sessions WHERE org_id=$1',[s.org])).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_intent_operations WHERE org_id=$1',[s.org])).rows[0].n,0);
});

test('abort after real session SQL insertion rolls back the owner record and its deferred immutable receipt',async()=>{
  const s=await setup(),abort=new AbortController(),real=f.db.withBoundedTransaction.bind(f.db);
  f.db.withBoundedTransaction=async run=>real(async c=>{
    const query=c.query.bind(c),intercept=Object.create(c);
    intercept.query=async(...args:any[])=>{const result=await (query as any)(...args);
      if(typeof args[0]==='string'&&args[0].includes('INSERT INTO platform_mentor_sessions'))abort.abort();
      return result;};
    return run(intercept);
  });
  try{await assert.rejects(s.service.create(s.owner,s.command,abort.signal));
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_sessions WHERE org_id=$1',[s.org])).rows[0].n,0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_intent_operations WHERE org_id=$1',[s.org])).rows[0].n,0);
  }finally{f.db.withBoundedTransaction=real;}
});
test('a real slot expires while private source validation awaits and cannot create a phantom available intent',async()=>{
  const s=await setup(),slot=new Date(Date.now()+500).toISOString();
  await offers.set(s.operator,s.org,{...s.source,operationId:randomUUID(),expectedRevision:1,terms:{...s.source.terms,earliestSlotAt:slot}});
  const slow=new MentorServiceOffers(f.db,s.config,FICTIONAL_LEGAL,{stat:async key=>{
    const actual=await blobs.stat(key);await new Promise(r=>setTimeout(r,550));return actual;
  }});
  const service=new MentorIntents(f.db,s.config,FICTIONAL_LEGAL,slow);
  await assert.rejects(service.create(s.owner,{...s.command,offerRevision:2}),error('MENTOR_SERVICE_UNAVAILABLE'));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_sessions WHERE org_id=$1',[s.org])).rows[0].n,0);
});

test('partner selection is a strict optional server configuration, never a client-supplied slug or URL',()=>{
  const id=randomUUID();assert.equal(readConfig({...process.env,PLATFORM_MENTOR_ORG_ID:id}).mentorOrganizationId,id);
  assert.equal(readConfig({...process.env,PLATFORM_MENTOR_ORG_ID:undefined}).mentorOrganizationId,undefined);
  for(const value of ['',id+' ','fictional-org','https://example.invalid/fictional-org'])
    assert.throws(()=>readConfig({...process.env,PLATFORM_MENTOR_ORG_ID:value}));
});
