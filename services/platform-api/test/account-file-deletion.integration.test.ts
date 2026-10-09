import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, authorizeFixedSession, type FixedSessionContext } from '../src/auth.ts';
import { AccountReauthentication } from '../src/account-reauthentication.ts';
import { UploadRemovals } from '../src/upload-removals.ts';
import { UploadWrites } from '../src/upload-writes.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { ApiError } from '../src/errors.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';

let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,directory:string,storage:LocalBlobStorage,removals:UploadRemovals,writes:UploadWrites,reauth:AccountReauthentication,encoded:string;
const password='Fictional-file-deletion-password';
const payload={filename:'Fictional private project.txt',mime:'text/plain',bytes:Buffer.from('Fictional owner-only content.')};
before(async()=>{f=await createCompanionNameSafetyFixture();directory=await mkdtemp(join(tmpdir(),'fictional-account-files-'));storage=new LocalBlobStorage(directory);removals=new UploadRemovals(f.db,f.crypto,storage);writes=new UploadWrites(f.db,f.crypto,storage);reauth=new AccountReauthentication(f.db);encoded=await hashPassword(password);});
after(async()=>{await f?.close();if(directory)await rm(directory,{recursive:true,force:true});});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
async function proof(who:FixedSessionContext,purpose:'account_delete'|'account_export'='account_delete'){return (await reauth.verify(who,{purpose,password})).token;}
async function file(who:FixedSessionContext){const saved=await writes.upload(who,payload);const row=(await f.db.query('SELECT storage_key FROM platform_uploads WHERE id=$1',[saved.id])).rows[0];return {id:saved.id,key:row.storage_key as string};}
async function removeFixtureOwner(who:FixedSessionContext,token:string){return f.db.withBoundedTransaction(async c=>{const prepared=await removals.prepareAccountDeletion(c,who,token);await c.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);return prepared;});}
const count=async(table:'platform_uploads'|'platform_upload_removals'|'platform_upload_removal_events'|'platform_upload_writes',who:FixedSessionContext)=>Number((await f.db.query(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`,[who.userId])).rows[0].n);
const code=(value:string)=>(e:unknown)=>e instanceof ApiError&&e.code===value;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

test('actual owner cascade preserves all published file coordinates and a fresh recovery service removes only that owner files',async()=>{
 const who=await actor(),other=await actor(),files=await Promise.all([file(who),file(who),file(who)]),foreign=await file(other);
 const already=await file(who);await removals.request(who,already.id,{operationId:randomUUID()});
 const completed=await file(who);await removals.request(who,completed.id,{operationId:randomUUID()});await removals.cleanup(completed.id);
 const token=await proof(who);await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);
 assert.deepEqual(await removeFixtureOwner(who,token),{queuedFiles:3});assert.equal(await count('platform_uploads',who),0);assert.equal(await count('platform_upload_removals',who),5);
 for(const u of [...files,already])await storage.stat(u.key);
 const journal=(await f.db.query('SELECT record_ciphertext FROM platform_upload_removals WHERE user_id=$1',[who.userId])).rows;
 assert(journal.every(r=>!r.record_ciphertext.includes(Buffer.from(payload.filename))));
 await new UploadRemovals(f.db,f.crypto,storage).recover();
 for(const u of [...files,already,completed])await assert.rejects(storage.stat(u.key),code('STORAGE_NOT_FOUND'));
 assert.equal(await count('platform_upload_removals',who),0);assert.equal(await count('platform_upload_removal_events',who),0);await storage.stat(foreign.key);assert.equal(await count('platform_uploads',other),1);
});

test('file preparation requires a real fresh deletion proof for the exact owner and session',async()=>{
 for(const mode of ['foreign','export','expired','logout','reset','malformed']){
  const who=await actor(),other=await actor(),u=await file(who);
  const token=mode==='malformed'?'not-a-proof':await proof(mode==='foreign'?other:who,mode==='export'?'account_export':'account_delete');
  if(mode==='expired')await f.db.query("UPDATE platform_account_reauthentications SET verified_at=statement_timestamp()-interval '6 minutes',expires_at=statement_timestamp()-interval '1 minute' WHERE user_id=$1",[who.userId]);
  if(mode==='logout')await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1',[who.userId]);
  if(mode==='reset')await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);
  await assert.rejects(removeFixtureOwner(who,token));assert.equal(await count('platform_uploads',who),1);assert.equal(await count('platform_upload_removals',who),0);await storage.stat(u.key);
 }
});

test('a failed downstream deletion rolls back proof consumption, file references and recovery journals together',async()=>{
 const who=await actor(),u=await file(who),token=await proof(who),job=randomUUID(),artifact=randomUUID();
 await f.db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,'image','fictional','Fictional artifact','succeeded')",[job,who.userId]);
 await f.db.query("INSERT INTO platform_artifacts(id,user_id,job_id,kind,upload_id) VALUES($1,$2,$3,'file',$4)",[artifact,who.userId,job,u.id]);
 await assert.rejects(f.db.withBoundedTransaction(async c=>{await removals.prepareAccountDeletion(c,who,token);throw Error('Fictional later privacy-domain failure');}));
 assert.equal(await count('platform_uploads',who),1);assert.equal(await count('platform_upload_removals',who),0);assert.equal((await f.db.query('SELECT upload_id FROM platform_artifacts WHERE id=$1',[artifact])).rows[0].upload_id,u.id);
 assert.equal((await f.db.query('SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1',[who.userId])).rows[0].consumed_at,null);
 await storage.stat(u.key);await removeFixtureOwner(who,token);await removals.recover();await assert.rejects(storage.stat(u.key),code('STORAGE_NOT_FOUND'));
});

test('invalid storage coordinates fail the entire inventory without consuming its proof or deleting earlier files',async()=>{
 const who=await actor(),a=await file(who),b=await file(who),token=await proof(who);
 const bad=[a,b].sort((x,y)=>x.id.localeCompare(y.id))[1];await f.db.query('UPDATE platform_uploads SET storage_key=$2 WHERE id=$1',[bad.id,'../fictional-outside']);
 await assert.rejects(removeFixtureOwner(who,token),code('UPLOAD_REMOVAL_UNAVAILABLE'));
 assert.equal(await count('platform_uploads',who),2);assert.equal(await count('platform_upload_removals',who),0);await storage.stat(a.key);await storage.stat(b.key);
 await f.db.query('UPDATE platform_uploads SET storage_key=$2 WHERE id=$1',[bad.id,bad.key]);await removeFixtureOwner(who,token);await removals.recover();
});

test('a database COMMIT failure never makes a cleanup worker delete still-owned files',async()=>{
 const who=await actor(),u=await file(who),token=await proof(who);
 await f.db.query(`CREATE FUNCTION fictional_file_delete_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional commit failure'; END $$`);
 await f.db.query(`CREATE CONSTRAINT TRIGGER fictional_file_delete_commit_failure AFTER DELETE ON platform_users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.id='${who.userId}') EXECUTE FUNCTION fictional_file_delete_commit_failure()`);
 try{await assert.rejects(removeFixtureOwner(who,token));}finally{await f.db.query('DROP FUNCTION fictional_file_delete_commit_failure() CASCADE');}
 await removals.recover();assert.equal(await count('platform_uploads',who),1);assert.equal(await count('platform_upload_removals',who),0);await storage.stat(u.key);
 await removeFixtureOwner(who,token);await removals.recover();
});

test('lost deletion COMMIT acknowledgement retains committed cleanup and later recovery physically removes files',async()=>{
 const who=await actor(),u=await file(who),token=await proof(who);
 await assert.rejects((async()=>{await removeFixtureOwner(who,token);throw Error('Fictional lost COMMIT acknowledgement');})());
 assert.equal((await f.db.query('SELECT 1 FROM platform_users WHERE id=$1',[who.userId])).rowCount,0);assert.equal(await count('platform_upload_removals',who),1);await storage.stat(u.key);
 await new UploadRemovals(f.db,f.crypto,storage).recover();await assert.rejects(storage.stat(u.key),code('STORAGE_NOT_FOUND'));assert.equal(await count('platform_upload_removals',who),0);
});

test('a concurrently staged upload cannot publish after the account deletion transaction takes its owner lock',async()=>{
 const who=await actor(),u=await file(who),token=await proof(who),staged=await writes.stage(who.userId,payload,c=>authorizeFixedSession(c,who));
 const prepared=deferred(),release=deferred();
 const deleting=f.db.withBoundedTransaction(async c=>{await removals.prepareAccountDeletion(c,who,token);prepared.resolve();await release.promise;await c.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);});
 try{
  await prepared.promise;const publish=f.db.withBoundedTransaction(c=>writes.publishInTransaction(c,staged));const rejected=assert.rejects(publish);release.resolve();await deleting;await rejected;
 }finally{release.resolve();await deleting;}
 await writes.abandon(staged);await removals.recover();assert.equal(await count('platform_uploads',who),0);assert.equal(await count('platform_upload_writes',who),0);assert.equal(await count('platform_upload_removals',who),0);await assert.rejects(storage.stat(u.key),code('STORAGE_NOT_FOUND'));
});

test('in-flight physical upload and already-published files use their separate journals across account deletion',async()=>{
 const who=await actor(),u=await file(who),token=await proof(who),entered=deferred(),release=deferred(),put=storage.put.bind(storage);let lateKey='';
 storage.put=async(key,...args)=>{lateKey=key;entered.resolve();await release.promise;await put(key,...args);};
 const writing=writes.upload(who,payload),rejected=assert.rejects(writing);
 try{await entered.promise;assert.deepEqual(await removeFixtureOwner(who,token),{queuedFiles:1});}finally{release.resolve();await rejected;storage.put=put;}
 await removals.recover();assert.equal(await count('platform_upload_removals',who),0);assert.equal(await count('platform_upload_writes',who),0);for(const key of [u.key,lateKey])await assert.rejects(storage.stat(key),code('STORAGE_NOT_FOUND'));
});

test('an empty file inventory still consumes the deletion proof in the actual owner-deletion transaction',async()=>{
 const who=await actor();assert.deepEqual(await removeFixtureOwner(who,await proof(who)),{queuedFiles:0});assert.equal((await f.db.query('SELECT 1 FROM platform_users WHERE id=$1',[who.userId])).rowCount,0);assert.equal(await count('platform_upload_removals',who),0);
});

test('the deletion inventory includes files beyond one recovery batch and subsequent recovery finishes the remainder',async()=>{
 const who=await actor(),files=[];for(let i=0;i<23;i++)files.push(await file(who));
 assert.deepEqual(await removeFixtureOwner(who,await proof(who)),{queuedFiles:23});assert.equal(await count('platform_upload_removals',who),23);
 await removals.recover();assert.equal(await count('platform_upload_removals',who),3);
 await new UploadRemovals(f.db,f.crypto,storage).recover();assert.equal(await count('platform_upload_removals',who),0);assert.equal(await count('platform_upload_removal_events',who),0);
 for(const u of files)await assert.rejects(storage.stat(u.key),code('STORAGE_NOT_FOUND'));
});

test('failed post-deletion cleanup retains encrypted coordinates until the real lease permits another attempt',async()=>{
 const who=await actor(),u=await file(who);await removeFixtureOwner(who,await proof(who));
 const del=storage.delete.bind(storage);let attempts=0;
 storage.delete=async()=>{attempts++;throw Error('Fictional unavailable private storage');};
 try{await removals.recover();await removals.recover();assert.equal(attempts,1);}finally{storage.delete=del;}
 assert.equal(await count('platform_upload_removals',who),1);await storage.stat(u.key);
 const bounded=f.db.withBoundedTransaction.bind(f.db),query=f.db.query.bind(f.db),clock=(sql:string)=>sql.replaceAll('clock_timestamp()',"(clock_timestamp()+interval '31 seconds')");
 f.db.query=(sql,values)=>query(clock(sql),values);
 f.db.withBoundedTransaction=(run,options)=>bounded(c=>{const q=c.query.bind(c);return run(new Proxy(c,{get(t,k){return k==='query'?(sql:string,values:unknown[])=>q(clock(sql),values):Reflect.get(t,k);}}));},options);
 try{await new UploadRemovals(f.db,f.crypto,storage).recover();}finally{f.db.query=query;f.db.withBoundedTransaction=bounded;}
 await assert.rejects(storage.stat(u.key),code('STORAGE_NOT_FOUND'));assert.equal(await count('platform_upload_removals',who),0);assert.equal(await count('platform_upload_removal_events',who),0);
});
