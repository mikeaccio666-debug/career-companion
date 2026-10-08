import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,chmod,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MENTOR_CONDUCT_VERSION,parseMentorProfileCommand,parseMentorSlotCommand,PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { MentorCapacity } from '../src/mentor-capacity.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { ApiError } from '../src/errors.ts';
import { parseMentorCapacityArguments } from '../src/mentor-capacity-files.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword,tokenHash } from '../src/auth.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,dir:string,blobs:LocalBlobStorage,service:MentorCapacity,calls=0;
const error=(code:string)=>(e:unknown)=>e instanceof ApiError&&e.code===code;
before(async()=>{f=await createCompanionNameSafetyFixture();dir=await mkdtemp(join(tmpdir(),'fictional-mentor-capacity-'));await chmod(dir,0o700);
  blobs=new LocalBlobStorage(dir);service=new MentorCapacity(f.db,f.config,FICTIONAL_LEGAL,blobs);});
after(async()=>{assert.equal(calls,0);await f?.close();if(dir)await rm(dir,{recursive:true,force:true});});
async function evidence(owner:string){const id=randomUUID(),bytes=Buffer.from('Fictional signed and reviewed capacity evidence; no production approval.');
  await blobs.put(id,bytes);await f.db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'fictional.txt','text/plain',$3,$4)",[id,owner,bytes.length,id]);return id;}
async function setup(mentor?:Awaited<ReturnType<typeof f.actor>>){
  const org=randomUUID(),operator=await f.actor(true);mentor??=await f.actor(true);
  await f.db.query("INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,'Fictional capacity organization')",[org,'cap_'+org.replaceAll('-','')]);
  for(const [who,role] of [[operator,'ops'],[mentor,'mentor']] as const)
    await f.db.query('INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)',[org,who.userId,role,operator.userId]);
  const ref=await evidence(operator.userId);
  const profile={operationId:randomUUID(),recordId:randomUUID(),expectedRevision:0,mentorId:mentor.userId,displayName:'Fictional teacher',
    timeZone:'America/New_York',languages:['en','zh'],services:['resume_direction','mock_interview'],signedAt:'2026-01-01T00:00:00.000Z',
    conductVersion:MENTOR_CONDUCT_VERSION,agreementEvidenceRef:ref,confirmSignedConduct:true,confirmConfidentiality:true,confirmEmployerPolicy:true};
  const slot={operationId:randomUUID(),recordId:randomUUID(),expectedRevision:0,profileId:profile.recordId,profileRevision:1,service:'resume_direction',
    startsAt:'2027-01-01T10:00:00.000Z',endsAt:'2027-01-01T10:45:00.000Z',timeZone:'America/New_York',confirmedAt:'2026-01-01T00:00:00.000Z',
    confirmationEvidenceRef:ref,confirmWithMentor:true};
  return {org,operator,mentor,ref,profile,slot};
}
test('actual mentor role, signed evidence and confirmed window persist encrypted sources without booking or student data',async()=>{
  const s=await setup();const a=await service.setProfile(s.operator,s.org,s.profile),b=await service.setSlot(s.operator,s.org,s.slot);
  assert.equal(a.kind,'profile');assert.equal(b.kind,'slot');assert.equal(b.revision,1);
  const profile=(await service.list(s.operator,s.org,'profile')).records[0],slot=(await service.list(s.operator,s.org,'slot')).records[0];
  assert.equal(profile.eligible,true);assert.equal((profile as any).displayName,'Fictional teacher');assert.equal(slot.eligible,true);
  assert.equal((slot as any).startsAt,s.slot.startsAt);
  const serialized=JSON.stringify({profile,slot});for(const forbidden of ['agreementEvidenceRef','confirmationEvidenceRef','@example.invalid','payment','intentNote','token','stateDigest'])assert(!serialized.includes(forbidden));
  const row=(await f.db.query('SELECT payload_ciphertext FROM platform_mentor_capacity_records WHERE id=$1',[s.profile.recordId])).rows[0];
  assert(!row.payload_ciphertext.includes(Buffer.from('Fictional teacher')));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_sessions')).rows[0].n,0);
});
test('inputs require all explicit signed-policy choices and a bounded real UTC window with a named time zone; getters are never invoked',()=>{
  const id=randomUUID(),base={operationId:id,recordId:id,expectedRevision:0,mentorId:id,displayName:'Fictional',timeZone:'UTC',languages:['en'],services:['resume_direction'],
    signedAt:'2026-01-01T00:00:00.000Z',conductVersion:MENTOR_CONDUCT_VERSION,agreementEvidenceRef:id,confirmSignedConduct:true,confirmConfidentiality:true,confirmEmployerPolicy:true};
  for(const patch of [{confirmSignedConduct:false},{confirmConfidentiality:false},{confirmEmployerPolicy:false},{conductVersion:'old'},{services:['free_diagnosis']},
    {services:['referral_assessment']},{services:['resume_direction','resume_direction']},{languages:['jp']},{timeZone:'PST'},{timeZone:'America/Fictional'},
    {contactEmail:'fictional@example.invalid'},{displayName:'Bad\u202ename'}])assert.throws(()=>parseMentorProfileCommand({...base,...patch}));
  let calls=0;const array:unknown[]=[];Object.defineProperty(array,'0',{get(){calls++;return 'en';},enumerable:true});array.length=1;
  assert.throws(()=>parseMentorProfileCommand({...base,languages:array}));assert.equal(calls,0);
  const slot={operationId:id,recordId:id,expectedRevision:0,profileId:id,profileRevision:1,service:'resume_direction',startsAt:'2027-01-01T10:00:00.000Z',
    endsAt:'2027-01-01T10:45:00.000Z',timeZone:'America/New_York',confirmedAt:'2026-01-01T00:00:00.000Z',confirmationEvidenceRef:id,confirmWithMentor:true};
  for(const patch of [{confirmWithMentor:false},{startsAt:'2027-01-01T10:00:00'},{endsAt:'2027-01-01T10:00:00.000Z'},
    {endsAt:'2027-01-01T10:00:30.000Z'},{endsAt:'2027-01-01T15:00:00.000Z'},{startsAt:'2027-01-01T10:00:00.001Z'},{meetingUrl:'https://example.invalid'}])
    assert.throws(()=>parseMentorSlotCommand({...slot,...patch}));
});
test('mentor must be an actually verified staff member with the current mentor role in this organization',async()=>{
  const s=await setup(),student=await f.actor(),outsider=await f.actor(true);
  await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,'mentor',$3)",[s.org,student.userId,s.operator.userId]);
  for(const mentorId of [student.userId,outsider.userId,s.operator.userId])
    await assert.rejects(service.setProfile(s.operator,s.org,{...s.profile,mentorId}),error('MENTOR_CAPACITY_MENTOR_UNAVAILABLE'));
  await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[s.mentor.userId]);
  await assert.rejects(service.setProfile(s.operator,s.org,s.profile),error('MENTOR_CAPACITY_MENTOR_UNAVAILABLE'));
});
test('source files must actually exist, belong to the operator and match their immutable storage version',async()=>{
  const s=await setup(),other=await f.actor(true),foreign=await evidence(other.userId);
  await assert.rejects(service.setProfile(s.operator,s.org,{...s.profile,agreementEvidenceRef:foreign}),error('NOT_FOUND'));
  await assert.rejects(service.setProfile(s.operator,s.org,{...s.profile,signedAt:'2099-01-01T00:00:00.000Z'}),error('MENTOR_CAPACITY_INPUT_INVALID'));
  await service.setProfile(s.operator,s.org,s.profile);
  await writeFile(join(dir,s.ref),'Fictional altered source');
  await assert.rejects(service.list(s.operator,s.org,'profile'),error('MENTOR_CAPACITY_STORAGE_UNAVAILABLE'));
});
test('missing evidence and revoked mentor role make confirmed sources ineligible without creating a fake replacement',async()=>{
  for(const reason of ['file','role']){
    const s=await setup();await service.setProfile(s.operator,s.org,s.profile);await service.setSlot(s.operator,s.org,s.slot);
    if(reason==='file')await blobs.delete(s.ref);else await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2 AND role='mentor'",[s.org,s.mentor.userId]);
    assert.equal((await service.list(s.operator,s.org,'profile')).records[0].eligible,false);
    assert.equal((await service.list(s.operator,s.org,'slot')).records[0].eligible,false);
    await assert.rejects(service.setSlot(s.operator,s.org,{...s.slot,operationId:randomUUID(),recordId:randomUUID()}),error('MENTOR_CAPACITY_PROFILE_UNAVAILABLE'));
  }
});
test('profile revisions invalidate their old slots; reconfirmation must cite the actual latest version and a supported service',async()=>{
  const s=await setup();await service.setProfile(s.operator,s.org,s.profile);await service.setSlot(s.operator,s.org,s.slot);
  await service.setProfile(s.operator,s.org,{...s.profile,operationId:randomUUID(),expectedRevision:1,displayName:'Fictional revised teacher'});
  assert.equal((await service.list(s.operator,s.org,'slot')).records[0].eligible,false);
  await assert.rejects(service.setSlot(s.operator,s.org,{...s.slot,operationId:randomUUID(),expectedRevision:1}),error('MENTOR_CAPACITY_PROFILE_UNAVAILABLE'));
  await assert.rejects(service.setSlot(s.operator,s.org,{...s.slot,operationId:randomUUID(),expectedRevision:1,profileRevision:2,service:'offer_negotiation'}),error('MENTOR_CAPACITY_PROFILE_UNAVAILABLE'));
  await service.setSlot(s.operator,s.org,{...s.slot,operationId:randomUUID(),expectedRevision:1,profileRevision:2});
  assert.equal((await service.list(s.operator,s.org,'slot')).records[0].eligible,true);
});
test('withdrawal, observation and original nonce replay return the actual current state without restoring source availability',async()=>{
  const s=await setup();await service.setProfile(s.operator,s.org,s.profile);await service.setSlot(s.operator,s.org,s.slot);
  const input={operationId:randomUUID(),recordId:s.slot.recordId,expectedRevision:1,reason:'Fictional no longer available'};
  await service.withdraw(s.operator,s.org,input);const replay=await service.setSlot(s.operator,s.org,s.slot);
  assert.equal(replay.status,'withdrawn');assert.equal(replay.revision,2);assert.equal(replay.appliedRevision,1);assert.equal(replay.replayed,true);
  assert.equal((await service.observe(s.operator,s.org,s.slot.operationId)).status,'withdrawn');
  assert.equal((await service.list(s.operator,s.org,'slot')).records[0].eligible,false);
  await assert.rejects(service.setSlot(s.operator,s.org,{...s.slot,endsAt:'2027-01-01T11:00:00.000Z'}),error('MENTOR_CAPACITY_OPERATION_CONFLICT'));
  assert.equal((await service.withdraw(s.operator,s.org,input)).replayed,true);
});
test('simultaneous overlapping source windows have one accepted effect, adjacent windows are allowed and no profile identity can be swapped',async()=>{
  const s=await setup();await service.setProfile(s.operator,s.org,s.profile);
  const results=await Promise.allSettled([service.setSlot(s.operator,s.org,s.slot),service.setSlot(s.operator,s.org,{...s.slot,recordId:randomUUID(),operationId:randomUUID()})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert(results.some(r=>r.status==='rejected'&&error('MENTOR_CAPACITY_SLOT_CONFLICT')(r.reason)));
  await service.setSlot(s.operator,s.org,{...s.slot,recordId:randomUUID(),operationId:randomUUID(),startsAt:'2027-01-01T10:45:00.000Z',endsAt:'2027-01-01T11:30:00.000Z'});
  await assert.rejects(service.setProfile(s.operator,s.org,{...s.profile,mentorId:(await f.actor(true)).userId,operationId:randomUUID(),expectedRevision:1}),error('MENTOR_CAPACITY_REVISION_CHANGED'));
});
test('overlap protection applies to the same mentor across organizations without returning the foreign schedule',async()=>{
  const a=await setup(),b=await setup(a.mentor);await service.setProfile(a.operator,a.org,a.profile);await service.setProfile(b.operator,b.org,b.profile);
  await service.setSlot(a.operator,a.org,a.slot);
  await assert.rejects(service.setSlot(b.operator,b.org,b.slot),(e:any)=>{assert(error('MENTOR_CAPACITY_SLOT_CONFLICT')(e));assert(!e.message.includes(a.org));assert(!e.message.includes(a.profile.recordId));return true;});
  assert.deepEqual((await service.list(b.operator,b.org,'slot')).records,[]);
});
test('foreign record IDs cannot overwrite another organization through an upsert or move a pagination scope',async()=>{
  const a=await setup(),b=await setup();await service.setProfile(a.operator,a.org,a.profile);
  await assert.rejects(service.setProfile(b.operator,b.org,{...b.profile,recordId:a.profile.recordId}),error('MENTOR_CAPACITY_REVISION_CHANGED'));
  assert.equal((await service.list(a.operator,a.org,'profile')).records[0].mentorId,a.mentor.userId);
  await assert.rejects(service.list(b.operator,b.org,'profile',{after:a.profile.recordId}),error('NOT_FOUND'));
  await assert.rejects(service.observe(b.operator,b.org,a.profile.operationId),error('NOT_FOUND'));
});
test('a source window expiring during real evidence validation is not accepted or returned as eligible',async()=>{
  const s=await setup();await service.setProfile(s.operator,s.org,s.profile);
  const slow=new MentorCapacity(f.db,f.config,FICTIONAL_LEGAL,{stat:async(key,signal)=>{const actual=await blobs.stat(key,signal);await new Promise(r=>setTimeout(r,450));return actual;}});
  const startsAt=new Date(Date.now()+350).toISOString(),endsAt=new Date(Date.parse(startsAt)+45*60000).toISOString();
  await assert.rejects(slow.setSlot(s.operator,s.org,{...s.slot,startsAt,endsAt}),error('MENTOR_CAPACITY_SLOT_EXPIRED'));
  assert.deepEqual((await service.list(s.operator,s.org,'slot')).records,[]);
  const future=new Date(Date.now()+350).toISOString();await service.setSlot(s.operator,s.org,{...s.slot,startsAt:future,endsAt:new Date(Date.parse(future)+45*60000).toISOString()});
  assert.equal((await slow.list(s.operator,s.org,'slot')).records[0].eligible,false);
});
test('metadata/ciphertext tampering and rollback to a genuine older source fail instead of showing eligible capacity',async()=>{
  const s=await setup();await service.setProfile(s.operator,s.org,s.profile);
  const old=(await f.db.query('SELECT * FROM platform_mentor_capacity_records WHERE id=$1',[s.profile.recordId])).rows[0];
  await f.db.query("UPDATE platform_mentor_capacity_records SET status='withdrawn' WHERE id=$1",[s.profile.recordId]);
  await assert.rejects(service.list(s.operator,s.org,'profile'),error('MENTOR_CAPACITY_STORAGE_UNAVAILABLE'));
  await f.db.query("UPDATE platform_mentor_capacity_records SET status='active' WHERE id=$1",[s.profile.recordId]);
  await service.withdraw(s.operator,s.org,{operationId:randomUUID(),recordId:s.profile.recordId,expectedRevision:1,reason:'Fictional withdrawal'});
  await f.db.query("UPDATE platform_mentor_capacity_records SET status='active',revision=1,last_operation_id=$2,updated_at=$3,payload_ciphertext=$4 WHERE id=$1",[old.id,old.last_operation_id,old.updated_at,old.payload_ciphertext]);
  await assert.rejects(service.list(s.operator,s.org,'profile'),error('MENTOR_CAPACITY_STORAGE_UNAVAILABLE'));
  await assert.rejects(f.db.query('DELETE FROM platform_mentor_capacity_proofs WHERE record_id=$1',[s.profile.recordId]));
});
test('mentor or organization deletion cascades source windows and immutable proofs; repeated migration creates no seeded mentor',async()=>{
  for(const target of ['mentor','org']){const s=await setup();await service.setProfile(s.operator,s.org,s.profile);await service.setSlot(s.operator,s.org,s.slot);
    await f.db.query(target==='mentor'?'DELETE FROM platform_users WHERE id=$1':'DELETE FROM platform_orgs WHERE id=$1',[target==='mentor'?s.mentor.userId:s.org]);
    for(const table of ['platform_mentor_capacity_records','platform_mentor_capacity_proofs'])assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table+' WHERE org_id=$1',[s.org])).rows[0].n,0);
  }
  const before=(await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_capacity_records')).rows[0].n;await f.db.migrate();
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_capacity_records')).rows[0].n,before);
});
test('actual audit failure rolls back mutations and prevents private read results',async()=>{
  const s=await setup();await f.db.query(`CREATE FUNCTION reject_capacity_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action IN ('mentor_capacity_set','mentor_capacity_viewed') THEN RAISE EXCEPTION 'Fictional audit failure'; END IF; RETURN NEW; END $$`);
  await f.db.query('CREATE TRIGGER reject_capacity_audit BEFORE INSERT ON platform_staff_audit FOR EACH ROW EXECUTE FUNCTION reject_capacity_audit()');
  try{await assert.rejects(service.setProfile(s.operator,s.org,s.profile));
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_capacity_records WHERE org_id=$1',[s.org])).rows[0].n,0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_mentor_capacity_proofs WHERE org_id=$1',[s.org])).rows[0].n,0);
    await assert.rejects(service.list(s.operator,s.org,'profile'));
  }finally{await f.db.query('DROP TRIGGER reject_capacity_audit ON platform_staff_audit');await f.db.query('DROP FUNCTION reject_capacity_audit()');}
});
test('abort after real source insertion rolls back both source and deferred proof rather than reporting saved',async()=>{
  const s=await setup(),abort=new AbortController(),real=f.db.withBoundedTransaction.bind(f.db);
  f.db.withBoundedTransaction=async run=>real(async c=>{const query=c.query.bind(c),intercept=Object.create(c);
    intercept.query=async(...args:any[])=>{const result=await(query as any)(...args);if(typeof args[0]==='string'&&args[0].includes('INSERT INTO platform_mentor_capacity_records'))abort.abort();return result;};return run(intercept);});
  try{await assert.rejects(service.setProfile(s.operator,s.org,s.profile,abort.signal));
    for(const table of ['platform_mentor_capacity_records','platform_mentor_capacity_proofs'])assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table+' WHERE org_id=$1',[s.org])).rows[0].n,0);
  }finally{f.db.withBoundedTransaction=real;}
});
test('actual slot pagination retains all 51 sources and rejects profile anchors or unknown query fields',async()=>{
  const s=await setup();await service.setProfile(s.operator,s.org,s.profile);const ids=new Set<string>();
  for(let i=0;i<51;i++){const recordId=randomUUID(),startsAt=new Date(Date.parse('2027-02-01T00:00:00.000Z')+i*3600000).toISOString();
    await service.setSlot(s.operator,s.org,{...s.slot,recordId,operationId:randomUUID(),startsAt,endsAt:new Date(Date.parse(startsAt)+45*60000).toISOString()});ids.add(recordId);}
  const a=await service.list(s.operator,s.org,'slot');assert.equal(a.records.length,50);assert(a.nextCursor);
  const b=await service.list(s.operator,s.org,'slot',{after:a.nextCursor});assert.equal(b.records.length,1);assert.equal(b.nextCursor,null);
  assert.deepEqual(new Set([...a.records,...b.records].map(r=>r.recordId)),ids);
  await assert.rejects(service.list(s.operator,s.org,'slot',{after:s.profile.recordId}),error('NOT_FOUND'));
  await assert.rejects(service.list(s.operator,s.org,'slot',{status:'active'}),error('MENTOR_CAPACITY_INPUT_INVALID'));
});
const origin='https://fictional-capacity.example.invalid';
async function login(app:Awaited<ReturnType<typeof buildApp>>['app'],who:Awaited<ReturnType<typeof f.actor>>){const password='Fictional-capacity-password-123';
  await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
  const r=await app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});assert.equal(r.statusCode,200,r.body);
  const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];return {origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId};}
test('real password-cookie HTTP keeps capacity behind staff/org authorization, no-store and an account window; no public writes exist',async()=>{
  const s=await setup();await service.setProfile(s.operator,s.org,s.profile);await service.setSlot(s.operator,s.org,s.slot);
  const system=await buildApp({db:f.db,storage:blobs,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),...f.config,allowedOrigins:new Set([origin]),workbenchEnabled:false},enableQueue:false,
    runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No external model calls');}})});
  try{const root='/api/platform/staff/orgs/'+s.org+'/mentor-capacity',headers=await login(system.app,s.operator),student=await login(system.app,await f.actor());
    const profiles=await system.app.inject({url:root+'/profiles',headers});assert.equal(profiles.statusCode,200,profiles.body);assert.equal(profiles.headers['cache-control'],'private, no-store');
    assert.equal(profiles.json().records[0].eligible,true);assert.equal((await system.app.inject({url:root+'/slots',headers})).json().records[0].eligible,true);
    assert.equal((await system.app.inject({url:root+'/operations/'+s.slot.operationId,headers})).json().appliedRevision,1);
    const denied=await system.app.inject({url:root+'/profiles',headers:student});assert.equal(denied.statusCode,403);assert(!denied.body.includes('Fictional teacher'));
    assert.equal((await system.app.inject({url:root+'/profiles'})).statusCode,401);
    assert.equal((await system.app.inject({url:root+'/profiles',headers:{...headers,[PLATFORM_ACCOUNT_HEADER]:s.mentor.userId}})).statusCode,409);
    for(const path of ['/profiles?mentorId='+s.mentor.userId,'/slots?after=a&after=b','/operations/'+s.slot.operationId+'?sensitive=true'])
      assert.equal((await system.app.inject({url:root+path,headers})).statusCode,400);
    assert.equal((await system.app.inject({method:'POST',url:root+'/profiles',headers,payload:s.profile})).statusCode,404);
    assert.equal((await system.app.inject({url:root+'/operations/not-a-uuid',headers})).statusCode,404);
    assert.equal((await system.app.inject({url:root.replace(s.org,s.org.toUpperCase())+'/operations/'+s.slot.operationId.toUpperCase(),headers})).statusCode,200);
    await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2 AND role='ops'",[s.org,s.operator.userId]);
    assert.equal((await system.app.inject({url:root+'/profiles',headers})).statusCode,403);assert.equal(calls,0);
  }finally{await system.app.close();}
});
test('actual CLI uses owned 600-mode input files and a live operator session; it observes original receipts without printing evidence or credentials',async()=>{
  const s=await setup(),token=randomUUID()+randomUUID(),url=new URL(readConfig().databaseUrl);url.searchParams.set('options','-c search_path='+f.schema);
  await f.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[s.operator.userId,tokenHash(token)]);
  const credentials=join(dir,'fictional-capacity-session.json'),input=join(dir,'fictional-capacity-input.json');
  await writeFile(credentials,JSON.stringify({userId:s.operator.userId,token}),{mode:0o600});await writeFile(input,JSON.stringify(s.profile),{mode:0o600});
  const execute=promisify(execFile),env={...process.env,PLATFORM_DATABASE_URL:url.toString(),PLATFORM_STORAGE_DIR:dir,PLATFORM_DATA_KEY:'e5'.repeat(32),PLATFORM_ALLOW_PROVIDER_CALLS:'0'};
  const run=(action:string,extra:string[])=>execute(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/mentor-capacity-main.ts',import.meta.url)),action,'--org',s.org,'--session-file',credentials,...extra],{env,timeout:10000,maxBuffer:4096});
  const saved=await run('profile',['--input-file',input]);assert.equal(JSON.parse(saved.stdout).revision,1);assert.equal(saved.stderr,'');
  assert(!saved.stdout.includes(token));assert(!saved.stdout.includes(s.ref));assert(!saved.stdout.includes(s.profile.displayName));
  assert.equal(JSON.parse((await run('list',['--kind','profile'])).stdout).records[0].eligible,true);
  assert.equal(JSON.parse((await run('observe',['--operation-id',s.profile.operationId])).stdout).replayed,true);
  await writeFile(input,JSON.stringify({operationId:randomUUID(),recordId:s.profile.recordId,expectedRevision:1,reason:'Fictional CLI withdrawal'}));
  assert.equal(JSON.parse((await run('withdraw',['--input-file',input])).stdout).status,'withdrawn');
  await chmod(credentials,0o644);await assert.rejects(run('list',['--kind','profile']),(e:any)=>{assert.equal(e.stdout,'');assert(!e.stderr.includes(token));return true;});
  await chmod(credentials,0o600);await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[s.operator.userId]);
  await assert.rejects(run('list',['--kind','profile']),(e:any)=>{assert.equal(e.stdout,'');assert(!e.stderr.includes(token));return true;});
});
test('operator argv cannot carry a token, choose roles, omit source input or mix observation/list/write fields',()=>{
  for(const args of [['profile','--org','x','--session-file','x'],['list','--org','x','--session-file','x'],
    ['list','--org','x','--session-file','x','--kind','profile','--input-file','x'],['observe','--org','x','--session-file','x','--operation-id','x','--kind','profile'],
    ['profile','--org','x','--session-file','x','--input-file','x','--token','x']])assert.throws(()=>parseMentorCapacityArguments(args));
});

test('altered foreign window projections cannot hide an actual committed overlap',async()=>{
  const a=await setup(),b=await setup(a.mentor);await service.setProfile(a.operator,a.org,a.profile);await service.setProfile(b.operator,b.org,b.profile);
  await service.setSlot(a.operator,a.org,a.slot);
  await f.db.query("UPDATE platform_mentor_capacity_records SET starts_at='2028-01-01T10:00:00Z',ends_at='2028-01-01T10:45:00Z' WHERE id=$1",[a.slot.recordId]);
  await assert.rejects(service.setSlot(b.operator,b.org,b.slot),error('MENTOR_CAPACITY_STORAGE_UNAVAILABLE'));
  assert.deepEqual((await service.list(b.operator,b.org,'slot')).records,[]);
});
test('operator session expiry during actual evidence I/O rolls back source/proof before audit success',async()=>{
  const s=await setup();await f.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '120 milliseconds' WHERE token_hash=$1",[s.operator.tokenHash]);
  const slow=new MentorCapacity(f.db,f.config,FICTIONAL_LEGAL,{stat:async(key,signal)=>{const actual=await blobs.stat(key,signal);await new Promise(r=>setTimeout(r,200));return actual;}});
  await assert.rejects(slow.setProfile(s.operator,s.org,s.profile),error('AUTH_REQUIRED'));
  for(const table of ['platform_mentor_capacity_records','platform_mentor_capacity_proofs'])assert.equal((await f.db.query('SELECT count(*)::int AS n FROM '+table+' WHERE org_id=$1',[s.org])).rows[0].n,0);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_staff_audit WHERE org_id=$1 AND action='mentor_capacity_set'",[s.org])).rows[0].n,0);
});
test('profile withdrawal invalidates old slots; original replay cannot re-enable them and reactivation requires new source confirmation',async()=>{
  const s=await setup();await service.setProfile(s.operator,s.org,s.profile);await service.setSlot(s.operator,s.org,s.slot);
  await service.withdraw(s.operator,s.org,{operationId:randomUUID(),recordId:s.profile.recordId,expectedRevision:1,reason:'Fictional unavailable teacher'});
  assert.equal((await service.list(s.operator,s.org,'slot')).records[0].eligible,false);
  assert.equal((await service.setProfile(s.operator,s.org,s.profile)).status,'withdrawn');
  await service.setProfile(s.operator,s.org,{...s.profile,operationId:randomUUID(),expectedRevision:2});
  assert.equal((await service.list(s.operator,s.org,'profile')).records[0].eligible,true);
  assert.equal((await service.list(s.operator,s.org,'slot')).records[0].eligible,false);
  await service.setSlot(s.operator,s.org,{...s.slot,operationId:randomUUID(),expectedRevision:1,profileRevision:3});
  assert.equal((await service.list(s.operator,s.org,'slot')).records[0].eligible,true);
});
test('source capture freezes role/session and signed inputs before awaited storage reads; missing crypto or version metadata cannot accept a source',async()=>{
  const s=await setup(),other=await f.actor(true),context={...s.operator},input={...s.profile,languages:[...s.profile.languages]};
  const capture=new MentorCapacity(f.db,f.config,FICTIONAL_LEGAL,{stat:async(key,signal)=>{
    context.userId=other.userId;context.tokenHash=other.tokenHash;input.displayName='Fictional changed later';input.languages.length=0;return blobs.stat(key,signal);
  }});
  await capture.setProfile(context,s.org,input);
  assert.equal((await service.list(s.operator,s.org,'profile')).records[0].eligible,true);
  assert.equal(((await service.list(s.operator,s.org,'profile')).records[0] as any).displayName,s.profile.displayName);
  const fresh=await setup(),weak=new MentorCapacity(f.db,f.config,FICTIONAL_LEGAL,{stat:async(key,signal)=>({...await blobs.stat(key,signal),etag:undefined})});
  await assert.rejects(weak.setProfile(fresh.operator,fresh.org,fresh.profile),error('MENTOR_CAPACITY_STORAGE_UNAVAILABLE'));
  await assert.rejects(new MentorCapacity(f.db,{requireVerifiedEmail:true},FICTIONAL_LEGAL,blobs).setProfile(fresh.operator,fresh.org,fresh.profile),error('MENTOR_CAPACITY_STORAGE_UNAVAILABLE'));
});
