import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { RequestLimits } from '../src/request-limits.ts';
import { AccountActions } from '../src/account-actions.ts';
import { invitationEmailDigest,inviteCodeHash } from '../src/student-entry.ts';
import { ApiError } from '../src/errors.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';

let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,limits:RequestLimits,actions:AccountActions;
const mail={apiKey:'re_fictional_cleanup_key',from:'Fictional <no-reply@example.invalid>',webOrigin:'https://privacy.example.invalid',encryptionKey:Buffer.alloc(32,0x53)};
const target=(email:string)=>createHash('sha256').update('career-companion:account-email-target:v1\0').update(email).digest('hex');
before(async()=>{f=await createCompanionNameSafetyFixture();limits=new RequestLimits(f.db);actions=new AccountActions(f.db,mail);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();return {...who,email:who.userId+'@example.invalid'};}
async function invite(email:string,recipient:string|null=null,issuer:string|null=null){
 const hash=inviteCodeHash(randomUUID());await f.db.query(`INSERT INTO platform_invites(code_hash,email_digest,batch,invited_by,expires_at,redeemed_at,redeemed_user_id)
 VALUES($1,$2,'B0',$3,clock_timestamp()+interval '1 day',CASE WHEN $4::uuid IS NULL THEN NULL ELSE clock_timestamp() END,$4)`,[hash,invitationEmailDigest(email),issuer,recipient]);return hash;
}
const count=async(table:'platform_request_limits'|'platform_account_action_limits'|'platform_account_actions'|'platform_account_email_outbox',column:'owner_id'|'user_id',id:string)=>Number((await f.db.query(`SELECT count(*)::int n FROM ${table} WHERE ${column}=$1`,[id])).rows[0].n);
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

test('actual account deletion cascades all owner counters while preserving another owner and the shared socket window',async()=>{
 const a=await actor(),b=await actor();
 await limits.consumeUser(a.userId,'api');await limits.consumeUser(a.userId,'account-reauth');await limits.consumeUser(b.userId,'api');await limits.consumeAnonymous('127.0.0.1','auth-login');
 const shared=(await f.db.query("SELECT subject_key,request_count FROM platform_request_limits WHERE subject_type='ip' AND scope='auth-login'")).rows;
 await actions.requestPasswordReset(a.email);await actions.requestEmailVerification(a.userId);await actions.requestPasswordReset(b.email);
 assert.equal(await count('platform_account_action_limits','user_id',a.userId),2);
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[a.userId]);
 assert.equal(await count('platform_request_limits','owner_id',a.userId),0);
 for(const table of ['platform_account_action_limits','platform_account_actions','platform_account_email_outbox'] as const)assert.equal(await count(table,'user_id',a.userId),0);
 assert.equal(await count('platform_request_limits','owner_id',b.userId),1);assert.equal(await count('platform_account_action_limits','user_id',b.userId),1);
 assert.deepEqual((await f.db.query("SELECT subject_key,request_count FROM platform_request_limits WHERE subject_type='ip' AND scope='auth-login'")).rows,shared);
 await assert.rejects(limits.consumeUser(a.userId,'api'),(e:unknown)=>e instanceof ApiError&&e.code==='REQUEST_LIMIT_UNAVAILABLE');
 await actions.requestPasswordReset(a.email);await actions.requestEmailVerification(a.userId);
 assert.equal((await f.db.query('SELECT 1 FROM platform_account_action_limits WHERE target_hash=$1',[target(a.email)])).rowCount,0);
});

test('unknown recipients keep the accepted reset behavior without storing an email digest or enqueueing any message',async()=>{
 const email=randomUUID()+'@example.invalid';for(let i=0;i<4;i++)assert.equal(await actions.requestPasswordReset(email),undefined);
 assert.equal((await f.db.query('SELECT 1 FROM platform_account_action_limits WHERE target_hash=$1',[target(email)])).rowCount,0);
});

test('recipient invitations disappear while invitations issued to other users retain their usable identity',async()=>{
 const a=await actor(),b=await actor(),used=await invite(a.email,a.userId,b.userId),pending=await invite(a.email,null,b.userId),historical=await invite('fictional-old-address@example.invalid',a.userId,b.userId);
 const other=await invite(b.email,b.userId,a.userId),otherPending=await invite(randomUUID()+'@example.invalid',null,a.userId);
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[a.userId]);
 assert.equal((await f.db.query('SELECT 1 FROM platform_invites WHERE code_hash=ANY($1::text[])',[[used,pending,historical]])).rowCount,0);
 const kept=(await f.db.query('SELECT code_hash,invited_by,redeemed_user_id FROM platform_invites WHERE code_hash=ANY($1::text[]) ORDER BY code_hash',[[other,otherPending]])).rows;
 assert.equal(kept.length,2);assert(kept.every(r=>r.invited_by===null));assert.equal(kept.find(r=>r.code_hash===other).redeemed_user_id,b.userId);
});

test('an actual deferred COMMIT failure restores account counters, messages and recipient invitations',async()=>{
 const a=await actor();await limits.consumeUser(a.userId,'chat');await actions.requestPasswordReset(a.email);const code=await invite(a.email,a.userId);
 await f.db.query(`CREATE FUNCTION fictional_identity_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional privacy rollback'; END $$`);
 await f.db.query(`CREATE CONSTRAINT TRIGGER fictional_identity_commit_failure AFTER DELETE ON platform_users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(OLD.id='${a.userId}') EXECUTE FUNCTION fictional_identity_commit_failure()`);
 try{await assert.rejects(f.db.transaction(c=>c.query('DELETE FROM platform_users WHERE id=$1',[a.userId])));}finally{await f.db.query('DROP FUNCTION fictional_identity_commit_failure() CASCADE');}
 assert.equal(await count('platform_request_limits','owner_id',a.userId),1);assert.equal(await count('platform_account_action_limits','user_id',a.userId),1);assert.equal(await count('platform_account_email_outbox','user_id',a.userId),1);assert.equal((await f.db.query('SELECT 1 FROM platform_invites WHERE code_hash=$1',[code])).rowCount,1);
});

test('request counters derive their owner from the verified subject and cannot be inserted for nonexistent accounts',async()=>{
 const a=await actor(),missing=randomUUID();
 await assert.rejects(f.db.query("INSERT INTO platform_request_limits(subject_type,subject_key,scope,request_count,expires_at) VALUES('user',$1,'api',1,clock_timestamp()+interval '1 minute')",[missing]));
 await limits.consumeUser(a.userId,'api');await assert.rejects(f.db.query("UPDATE platform_request_limits SET owner_id=$2 WHERE subject_key=$1",[a.userId,missing]));
 await assert.rejects(f.db.query("INSERT INTO platform_account_action_limits(target_hash,purpose,user_id,request_count,expires_at) VALUES($1,'password-reset',$2,1,clock_timestamp()+interval '1 hour')",[target('fictional-absent@example.invalid'),missing]));
});

test('a reset request already waiting on a deleted account cannot recreate its email counter after commit',async()=>{
 const a=await actor(),deleted=deferred(),release=deferred(),entered=deferred();let pid=0;
 const facade={transaction:<T>(run:(c:PoolClient)=>Promise<T>)=>f.db.transaction(async c=>{
  pid=Number((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  const query=c.query.bind(c);return run(new Proxy(c,{get(t,k){if(k==='query')return (sql:string,values:unknown[])=>{if(sql.startsWith('SELECT id,email,auth_version'))entered.resolve();return query(sql,values);};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}}));
 })} as Database;
 const deleting=f.db.transaction(async c=>{await c.query('DELETE FROM platform_users WHERE id=$1',[a.userId]);deleted.resolve();await release.promise;});
 await deleted.promise;const resetting=new AccountActions(facade,mail).requestPasswordReset(a.email);
 try{
  await entered.promise;let waiting=false;const end=Date.now()+1000;
  while(Date.now()<end){waiting=Boolean((await f.db.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) waiting',[pid])).rows[0].waiting);if(waiting)break;await new Promise(r=>setTimeout(r,5));}
  assert(waiting,'The real reset SELECT must be blocked by the account deletion transaction.');
 }finally{release.resolve();await deleting;await resetting;}
 assert.equal((await f.db.query('SELECT 1 FROM platform_account_action_limits WHERE target_hash=$1',[target(a.email)])).rowCount,0);assert.equal(await count('platform_account_email_outbox','user_id',a.userId),0);
});

test('migration upgrades actual legacy rows, removes proven orphans, preserves live limits and can be re-applied',async()=>{
 const base=readConfig(),url=new URL(base.databaseUrl),schema='identity_upgrade_'+randomUUID().replaceAll('-','');url.searchParams.set('options','-c search_path='+schema);const admin=new Database(base.databaseUrl),db=new Database(url.toString());
 await admin.query(`CREATE SCHEMA ${schema}`);
 try{
  await db.query('CREATE TABLE platform_users(id uuid PRIMARY KEY,email text NOT NULL UNIQUE)');
  await db.query(await readFile(new URL('../migrations/011_request_limits.sql',import.meta.url),'utf8'));
  await db.query(`CREATE TABLE platform_account_action_limits(target_hash text NOT NULL,purpose text NOT NULL,request_count integer NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(target_hash,purpose));
   CREATE TABLE platform_invites(code_hash text PRIMARY KEY,email_digest text NOT NULL,redeemed_at timestamptz,redeemed_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL)`);
  const live=randomUUID(),gone=randomUUID(),email='fictional-upgrade@example.invalid',ip='f'.repeat(64);
  await db.query('INSERT INTO platform_users VALUES($1,$2)',[live,email]);
  for(const id of [live,gone])await db.query("INSERT INTO platform_request_limits VALUES('user',$1,'api',2,clock_timestamp()+interval '1 minute')",[id]);
  await db.query("INSERT INTO platform_request_limits VALUES('ip',$1,'auth-login',3,clock_timestamp()+interval '1 minute')",[ip]);
  for(const recipient of [email,'fictional-deleted@example.invalid'])await db.query("INSERT INTO platform_account_action_limits VALUES($1,'password-reset',2,clock_timestamp()+interval '1 hour')",[target(recipient)]);
  await db.query("INSERT INTO platform_invites VALUES($1,$2,clock_timestamp(),NULL),($3,$4,NULL,NULL)",['a'.repeat(64),invitationEmailDigest('fictional-deleted@example.invalid'),'b'.repeat(64),invitationEmailDigest('fictional-new@example.invalid')]);
  const sql=await readFile(new URL('../migrations/080_account_identity_cleanup.sql',import.meta.url),'utf8');await db.transaction(c=>c.query(sql));await db.transaction(c=>c.query(sql));
  assert.deepEqual((await db.query("SELECT subject_key,owner_id,request_count FROM platform_request_limits WHERE subject_type='user'")).rows,[{subject_key:live,owner_id:live,request_count:2}]);
  assert.equal((await db.query("SELECT owner_id FROM platform_request_limits WHERE subject_type='ip'")).rows[0].owner_id,null);
  assert.deepEqual((await db.query('SELECT target_hash,user_id,request_count FROM platform_account_action_limits')).rows,[{target_hash:target(email),user_id:live,request_count:2}]);
  assert.deepEqual((await db.query('SELECT code_hash FROM platform_invites')).rows,[{code_hash:'b'.repeat(64)}]);
  await assert.rejects(db.query("INSERT INTO platform_account_action_limits(target_hash,purpose,request_count,expires_at) VALUES($1,'password-reset',1,clock_timestamp()+interval '1 hour')",[target('fictional-old-writer@example.invalid')]),(e:any)=>e.code==='23502'&&e.column==='user_id');
  await db.query('DELETE FROM platform_users WHERE id=$1',[live]);assert.equal((await db.query('SELECT 1 FROM platform_account_action_limits')).rowCount,0);assert.equal((await db.query("SELECT 1 FROM platform_request_limits WHERE subject_type='ip'")).rowCount,1);
 }finally{await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();}
});
