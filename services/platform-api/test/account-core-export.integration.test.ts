import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from '../src/database.ts';
import { AccountCoreExport } from '../src/account-core-export.ts';
import { AccountReauthentication } from '../src/account-reauthentication.ts';
import { SharedMemories } from '../src/shared-memories.ts';
import { hashPassword,tokenHash,type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';

let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,encoded:string;
const password='Fictional-export-password-2026';
before(async()=>{f=await createCompanionNameSafetyFixture();encoded=await hashPassword(password);});
after(async()=>{await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function proof(who:FixedSessionContext,purpose:'account_export'|'account_delete'='account_export'){
  return (await new AccountReauthentication(f.db).verify(who,{purpose,password})).token;
}
const capture=(who:FixedSessionContext,token:string)=>new AccountCoreExport(f.db,f.config).capture(who,token);
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
const code=(expected:string)=>(e:unknown)=>e instanceof ApiError&&e.code===expected;
async function legacy(who:FixedSessionContext,content='Fictional legacy private note',id=randomUUID()){
  await f.db.query('INSERT INTO platform_memories(id,user_id,content) VALUES($1,$2,$3)',[id,who.userId,content]);return id;
}
function instrument(afterQuery:(sql:string,client:PoolClient)=>Promise<void>):Database{
  return {withBoundedTransaction:<T>(run:(client:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>
    f.db.withBoundedTransaction(client=>run(new Proxy(client,{get(target,key){
      if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await afterQuery(sql,target);return result;};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }})),options)} as Database;
}

test('fresh owner proof returns decoded current/retained memory and metadata without credentials or another owner',async()=>{
  const a=await actor(),b=await actor(),memories=new SharedMemories(f.db,f.config,FICTIONAL_LEGAL);
  const old=await legacy(a),foreign=await legacy(b,'Fictional other-account-only content');
  const saved=await memories.mutate(a,'create',null,{operationId:randomUUID(),content:'Fictional restricted personal note',category:'goal_preference',sensitivity:'restricted',usePolicy:'only_if_user_raises',speakerScope:null,validUntil:null});
  await memories.mutate(a,'delete',saved.memory.id,{operationId:randomUUID(),expectedRevision:1});
  const token=await proof(a),result=await capture(a,token),records=result.sections.memories as any[];
  assert.equal(result.complete,false);assert.equal(result.filesIncluded,false);assert.equal(result.ownerId,a.userId);
  assert.equal(result.sections.account.email,a.userId+'@example.invalid');assert.equal(result.sections.sessions.length,1);
  assert.equal((result.sections.sessions[0] as any).current,true);assert.equal(result.sections.termsConsents.length,1);
  assert.equal(records.length,2);assert.equal(records.find(x=>x.state.id===old).state.kind,'needs_review');
  const deleted=records.find(x=>x.state.id===saved.memory.id);assert(deleted.state.deletedAt);
  assert.equal(deleted.retainedUndo.content,'Fictional restricted personal note');assert.equal(deleted.retainedUndo.sensitivity,'restricted');
  assert.equal(result.sections.memoryOperations.length,2);assert.equal(result.sections.memoryEvents.length,2);
  const text=JSON.stringify(result);
  for(const secret of [password,encoded,token,a.tokenHash,b.userId,foreign,'Fictional other-account-only content','acceptedAuthVersion','commandDigest','receipt_ciphertext','record_ciphertext'])assert(!text.includes(secret),secret);
  assert(await consumed(a));assert(Object.isFrozen(result));assert(Object.isFrozen(result.sections.memories));
  assert(result.includedTables.includes('platform_conversations'));assert(!result.remainingTables.includes('platform_conversations'));
  assert(result.remainingTables.includes('platform_memory_safety_sources'));
  await assert.rejects(capture(a,token),code('ACCOUNT_REAUTH_REQUIRED'));
  assert.equal((await memories.list(a)).memories.length,1,'Export must not restore the deleted memory.');
});

test('export neither needs active model consent nor verified email and includes expired session metadata without hashes',async()=>{
  const a=await actor(),expired=tokenHash(randomUUID());
  await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[a.userId]);
  await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[a.userId]);
  await f.db.query("INSERT INTO platform_sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()-interval '1 hour')",[expired,a.userId]);
  const result=await capture(a,await proof(a));assert.equal(result.sections.termsConsents.length,0);
  assert.equal(result.sections.account.emailVerifiedAt,null);assert.equal(result.sections.sessions.length,2);
  assert(!JSON.stringify(result).includes(expired));
});

test('another account, wrong purpose and revoked session cannot export or consume the owner proof',async()=>{
  const a=await actor(),b=await actor(),token=await proof(a),deletion=await proof(a,'account_delete');
  await assert.rejects(capture(b,token));await assert.rejects(capture(a,deletion),code('ACCOUNT_REAUTH_REQUIRED'));
  assert.equal(await consumed(a),null);
  await f.db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[a.tokenHash]);await assert.rejects(capture(a,token));
});

test('all memory pages use one real MVCC snapshot and caller identity is captured before awaiting',async()=>{
  const a=await actor(),b=await actor(),ids=Array.from({length:125},()=>randomUUID());
  await f.db.query("INSERT INTO platform_memories(id,user_id,content) SELECT x,$1,'Fictional paged note' FROM unnest($2::uuid[]) x",[a.userId,ids]);
  const token=await proof(a),mutable={...a};let inserted=false,late='';
  const db=instrument(async sql=>{
    if(!inserted&&sql.startsWith('SELECT * FROM platform_memories')){
      inserted=true;late=await legacy(a,'Fictional concurrent later insertion');Object.assign(mutable,b);
    }
  });
  const result=await new AccountCoreExport(db,f.config).capture(mutable,token);
  assert.equal(result.ownerId,a.userId);assert.equal(result.sections.memories.length,125);
  assert.deepEqual((result.sections.memories as any[]).map(x=>x.state.id).sort(),ids.sort());
  assert(!JSON.stringify(result).includes(late));
  assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_memories WHERE user_id=$1',[a.userId])).rows[0].n,126);
});

test('ciphertext damage returns no snapshot and rolls proof consumption back for a repaired retry',async()=>{
  const a=await actor(),memories=new SharedMemories(f.db,f.config,FICTIONAL_LEGAL);
  const saved=await memories.mutate(a,'create',null,{operationId:randomUUID(),content:'Fictional authenticated memory',category:'communication',sensitivity:'normal',usePolicy:'normal',speakerScope:null,validUntil:null});
  const row=(await f.db.query('SELECT record_ciphertext FROM platform_memories WHERE id=$1',[saved.memory.id])).rows[0];
  const broken=Buffer.from(row.record_ciphertext);broken[broken.length-1]^=1;
  await f.db.query('UPDATE platform_memories SET record_ciphertext=$2 WHERE id=$1',[saved.memory.id,broken]);
  const token=await proof(a);await assert.rejects(capture(a,token),code('MEMORY_STORAGE_UNAVAILABLE'));assert.equal(await consumed(a),null);
  await f.db.query('UPDATE platform_memories SET record_ciphertext=$2 WHERE id=$1',[saved.memory.id,row.record_ciphertext]);
  assert.equal((await capture(a,token)).sections.memories.length,1);
});

test('unknown schema, size limit and cancellation return no partial snapshot and leave proof retryable',async()=>{
  const a=await actor();await legacy(a,'Fictional bounded memory '.repeat(20));const token=await proof(a);
  await f.db.query('ALTER TABLE platform_worker_heartbeats ADD COLUMN fictional_new_column text');
  try{await assert.rejects(capture(a,token),code('ACCOUNT_EXPORT_SCHEMA_UNREVIEWED'));assert.equal(await consumed(a),null);}
  finally{await f.db.query('ALTER TABLE platform_worker_heartbeats DROP COLUMN fictional_new_column');}
  await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:1024}).capture(a,token),code('ACCOUNT_EXPORT_TOO_LARGE'));
  assert.equal(await consumed(a),null);
  const controller=new AbortController();controller.abort(new Error('fictional-private-abort-reason'));
  await assert.rejects(new AccountCoreExport(f.db,f.config).capture(a,token,controller.signal),code('ACCOUNT_EXPORT_CANCELLED'));
  assert.equal(await consumed(a),null);assert.equal((await capture(a,token)).sections.memories.length,1);
});

test('actual deferred COMMIT failure prevents returning private data and restores the consumed proof',async()=>{
  const a=await actor(),token=await proof(a);await legacy(a);
  await f.db.query(`CREATE FUNCTION fictional_export_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional private commit error'; END $$`);
  await f.db.query('CREATE CONSTRAINT TRIGGER fictional_export_commit_failure AFTER UPDATE ON platform_account_reauthentications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_export_commit_failure()');
  try{await assert.rejects(capture(a,token),code('ACCOUNT_EXPORT_UNAVAILABLE'));assert.equal(await consumed(a),null);}
  finally{await f.db.query('DROP FUNCTION fictional_export_commit_failure() CASCADE');}
  assert.equal((await capture(a,token)).sections.memories.length,1);
});

test('session expiration during reading and accessor-bearing identity inputs cannot return data',async()=>{
  const a=await actor(),token=await proof(a);await legacy(a);
  let reached=false;
  const db=instrument(async(sql,client)=>{
    if(sql.startsWith('SELECT * FROM platform_memories')){
      reached=true;
      await client.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '0.04 seconds' WHERE token_hash=$1",[a.tokenHash]);
      await client.query('SELECT pg_sleep(0.05)');
    }
  });
  await assert.rejects(new AccountCoreExport(db,f.config).capture(a,token));assert(reached);assert.equal(await consumed(a),null);
  let read=false;const trapped={userId:a.userId,get tokenHash(){read=true;return a.tokenHash;}};
  await assert.rejects(capture(trapped,token),code('AUTH_REQUIRED'));assert.equal(read,false);
});

test('consents sharing a version, session metadata and retained memory receipts all continue beyond a page',async()=>{
  const a=await actor(),memories=new SharedMemories(f.db,f.config,FICTIONAL_LEGAL);
  const saved=await memories.mutate(a,'create',null,{operationId:randomUUID(),content:'Fictional receipt history',category:'communication',sensitivity:'normal',usePolicy:'normal',speakerScope:null,validUntil:null});
  let revision=1;
  for(let i=0;i<101;i++){
    const result=await memories.mutate(a,'edit',saved.memory.id,{operationId:randomUUID(),expectedRevision:revision,content:'Fictional edit '+i});revision=result.memory.revision;
  }
  const hashes=Array.from({length:101},(_,i)=>(i+1).toString(16).padStart(64,'0'));
  await f.db.query("INSERT INTO platform_terms_consents(user_id,terms_version,content_digest) SELECT $1,'fictional-same-version',x FROM unnest($2::text[]) x",[a.userId,hashes]);
  const sessionHashes=Array.from({length:101},()=>tokenHash(randomUUID()));
  await f.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) SELECT $1,x,0,clock_timestamp()+interval '1 hour' FROM unnest($2::text[]) x",[a.userId,sessionHashes]);
  const result=await capture(a,await proof(a));
  assert.equal(result.sections.termsConsents.length,102);assert.equal(result.sections.sessions.length,102);
  assert.equal(result.sections.memoryOperations.length,102);assert.equal(result.sections.memoryEvents.length,102);
  assert.equal((result.sections.memories[0] as any).state.revision,102);
  assert.deepEqual((result.sections.termsConsents as any[]).filter(x=>x.version==='fictional-same-version').map(x=>x.contentDigest).sort(),hashes.sort());
  for(const hash of sessionHashes)assert(!JSON.stringify(result.sections.sessions).includes(hash));
});

test('cancellation after reading starts discards captured sections and restores the proof',async()=>{
  const a=await actor(),token=await proof(a),controller=new AbortController();await legacy(a);
  let reached=false;const db=instrument(async sql=>{
    if(sql.startsWith('SELECT * FROM platform_memories')){reached=true;controller.abort();}
  });
  await assert.rejects(new AccountCoreExport(db,f.config).capture(a,token,controller.signal),code('ACCOUNT_EXPORT_CANCELLED'));
  assert(reached);assert.equal(await consumed(a),null);assert.equal((await capture(a,token)).sections.memories.length,1);
});
