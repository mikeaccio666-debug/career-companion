import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/database.ts';
import { tokenHash } from '../src/auth.ts';
import { ModelConsent } from '../src/model-routing.ts';
import { ApiError } from '../src/errors.ts';
import { readConfig } from '../src/config.ts';
import { HttpClient } from '../../../packages/ai-core/src/http.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal, seedFictionalConsent } from './fixtures/student-entry.ts';

// Dedicated loopback PostgreSQL + random schema; no commercial adapter or real user data.
const base=readConfig(),schema='model_consent_'+randomUUID().replaceAll('-',''),url=new URL(base.databaseUrl);
assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Use only loopback fictional PostgreSQL.');url.searchParams.set('options','-c search_path='+schema);
const admin=new Database(base.databaseUrl),db=new Database(url.toString());let created=false;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await db.migrate();await seedFictionalActiveLegal(db);});
after(async()=>{await db.close();if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();});
const code=(expected:string)=>(error:unknown)=>error instanceof ApiError&&error.code===expected;
async function actor(consented=true){
  const userId=randomUUID(),token=randomUUID();await db.query("INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,'Fictional request owner','fictional-unused-hash')",[userId,userId+'@example.invalid']);
  await db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[userId,tokenHash(token)]);
  if(consented)await seedFictionalConsent(db,userId);return {userId,tokenHash:tokenHash(token)};
}
test('missing consent or missing legal bundle never reaches the transport',async()=>{
  const who=await actor(false);let requests=0;
  for(const bundle of [FICTIONAL_LEGAL,null]){
    const gate=new ModelConsent(db,bundle).forSession(who),client=new HttpClient(async()=>{requests++;return new Response('{}');}).withAdmission(gate);
    await assert.rejects(client.json('https://fictional-provider.invalid/inference'),code(bundle?'TERMS_CONFIRMATION_REQUIRED':'LEGAL_DOCUMENTS_UNAVAILABLE'));
  }assert.equal(requests,0);
});
test('accepted actual request rechecks exact fixed session before every later call',async()=>{
  const who=await actor(),gate=new ModelConsent(db,FICTIONAL_LEGAL).forSession(who);let requests=0;
  const client=new HttpClient(async()=>{requests++;return new Response('{}');}).withAdmission(gate);
  await client.json('https://fictional-provider.invalid/inference');await db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[who.tokenHash]);
  await assert.rejects(client.json('https://fictional-provider.invalid/retry'),code('AUTH_REQUIRED'));assert.equal(requests,1);
});
test('account version reset serialized ahead of launch refuses payload rather than rebinding identity',async()=>{
  const who=await actor(),lock=await db.pool.connect();let requests=0;
  await lock.query('BEGIN');await lock.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[who.userId]);
  try{
    const gate=new ModelConsent(db,FICTIONAL_LEGAL).forSession(who),request=gate(async()=>{requests++;return new Response('{}');});request.catch(()=>{});
    await lock.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);await lock.query('COMMIT');
    await assert.rejects(request,code('AUTH_REQUIRED'));assert.equal(requests,0);
  }finally{await lock.query('ROLLBACK');lock.release();}
});
test('legal change is serialized at launch but fetching headers holds no authorization transaction open',async()=>{
  const who=await actor(),gate=new ModelConsent(db,FICTIONAL_LEGAL).forSession(who);let started!:(value?:unknown)=>void,finish!:(value:Response)=>void;
  const start=new Promise(resolve=>{started=resolve;}),request=gate(()=>{started();return new Promise<Response>(resolve=>{finish=resolve;});});
  await start;
  // UPDATE waits for SHARE lock release. It must finish while the fake network is pending.
  await db.query('UPDATE platform_terms_policy SET content_digest=$1 WHERE singleton=true',['0'.repeat(64)]);
  finish(new Response('{}'));assert.equal((await request).status,200);
  let second=0;await assert.rejects(gate(async()=>{second++;return new Response('{}');}),code('LEGAL_DOCUMENTS_UNAVAILABLE'));assert.equal(second,0);await seedFictionalActiveLegal(db);
});
test('persistent worker uses original claim auth version and current job lease/approval',async()=>{
  const who=await actor(),jobId=randomUUID(),leaseToken=randomUUID();
  await db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status,requires_approval,lease_token,lease_until) VALUES($1,$2,'speech','fictional','Fictional job','running',false,$3,clock_timestamp()+interval '1 hour')",[jobId,who.userId,leaseToken]);
  const gate=new ModelConsent(db,FICTIONAL_LEGAL).forJob({userId:who.userId,jobId,generation:1,leaseToken,authVersion:'0'});let requests=0;
  await gate(async()=>++requests);await db.query('UPDATE platform_jobs SET generation=2 WHERE id=$1',[jobId]);await assert.rejects(gate(async()=>++requests),code('JOB_CANCELLED'));
  await db.query('UPDATE platform_jobs SET generation=1 WHERE id=$1',[jobId]);await db.query('UPDATE platform_users SET auth_version=1 WHERE id=$1',[who.userId]);await assert.rejects(gate(async()=>++requests),code('AUTH_REQUIRED'));assert.equal(requests,1);
});

test('worker lease expiring during a proven legal-policy lock wait stops the actual fetch',async()=>{
  const who=await actor(),jobId=randomUUID(),leaseToken=randomUUID(),lock=await db.pool.connect();let requests=0;
  await db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status,requires_approval,lease_token,lease_until) VALUES($1,$2,'speech','fictional','Fictional timed job','running',false,$3,clock_timestamp()+interval '300 milliseconds')",[jobId,who.userId,leaseToken]);
  await lock.query('BEGIN');const blocker=(await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await lock.query('SELECT singleton FROM platform_terms_policy WHERE singleton=true FOR UPDATE');
  const gate=new ModelConsent(db,FICTIONAL_LEGAL).forJob({userId:who.userId,jobId,generation:1,leaseToken,authVersion:'0'});
  const request=gate(async()=>{requests++;return new Response('{}');});request.catch(()=>{});
  try{
    let blocked=false;
    for(let attempt=0;attempt<200;attempt++){
      const waiting=await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%platform_terms_policy%' AND $1=ANY(pg_blocking_pids(pid))",[blocker]);
      if(waiting.rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(blocked,true,'The actual admission query must be waiting on our policy lock.');
    assert.equal((await db.query('SELECT lease_until>clock_timestamp() AS valid FROM platform_jobs WHERE id=$1',[jobId])).rows[0].valid,true);
    // Derive the wait from PostgreSQL's actual lease time, then independently prove expiry.
    await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(lease_until-clock_timestamp())))+0.01) FROM platform_jobs WHERE id=$1',[jobId]);
    assert.equal((await db.query('SELECT lease_until<=clock_timestamp() AS expired FROM platform_jobs WHERE id=$1',[jobId])).rows[0].expired,true);
    await lock.query('COMMIT');await assert.rejects(request,code('JOB_CANCELLED'));assert.equal(requests,0);
  }finally{await lock.query('ROLLBACK');lock.release();}
});
