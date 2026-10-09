import { authorizeFixedSession } from '../src/auth.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,rm,readdir } from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import { UploadWrites } from '../src/upload-writes.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { ApiError } from '../src/errors.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
const file=()=>({filename:'Fictional.txt',mime:'text/plain',bytes:Buffer.from('Fictional course project.')});
async function fixture(){
 const f=await createCompanionNameSafetyFixture(),dir=await mkdtemp(path.join(os.tmpdir(),'fictional-upload-write-'));
 const storage=new LocalBlobStorage(dir),writes=new UploadWrites(f.db,f.crypto,storage),who=await f.actor();
 const rows=async()=> (await f.db.query('SELECT * FROM platform_upload_writes')).rows;
 const empty=async()=>{assert.equal((await rows()).length,0);assert.equal((await f.db.query('SELECT 1 FROM platform_upload_write_events')).rowCount,0);assert.deepEqual(await readdir(dir),[]);};
 async function future(run:()=>Promise<void>){
  const query=f.db.query.bind(f.db),bounded=f.db.withBoundedTransaction.bind(f.db);
  const sql=(q:string)=>q.replaceAll('clock_timestamp()',"(clock_timestamp()+interval '3 minutes')");
  f.db.query=(q,v)=>query(sql(q),v);f.db.withBoundedTransaction=(run,opts)=>bounded(c=>{const q=c.query.bind(c);return run(new Proxy(c,{get(t,k){return k==='query'?(text:string,v:unknown[])=>q(sql(text),v):Reflect.get(t,k);}}));},opts);
  try{await run();}finally{f.db.query=query;f.db.withBoundedTransaction=bounded;}
 }
 return {...f,dir,storage,writes,who,rows,empty,future,async close(){try{await f.close();}finally{await rm(dir,{recursive:true,force:true});}}};
}

test('intent commits before actual bytes, then publication and journal erasure commit together',async()=>{
 const f=await fixture();try{
  const put=f.storage.put.bind(f.storage);let called=0;
  f.storage.put=async(...args)=>{called++;const rows=await f.rows();assert.equal(rows.length,1);assert.equal(rows[0].status,'writing');assert.equal((await f.db.query('SELECT 1 FROM platform_uploads')).rowCount,0);assert(!rows[0].record_ciphertext.includes(Buffer.from(file().filename)));await put(...args);};
  const saved=await f.writes.upload(f.who,file());assert.equal(called,1);assert.equal(saved.size,file().bytes.length);
  const row=(await f.db.query('SELECT * FROM platform_uploads WHERE id=$1',[saved.id])).rows[0];assert.equal(row.user_id,f.who.userId);
  assert.deepEqual(await f.storage.get(row.storage_key),new Uint8Array(file().bytes));assert.equal((await f.rows()).length,0);
  assert.equal((await f.db.query('SELECT 1 FROM platform_upload_write_events')).rowCount,0);await f.writes.recover();await f.storage.stat(row.storage_key);
 }finally{await f.close();}
});

test('real account deletion during write cannot publish a late upload and actual acknowledged bytes are cleaned',async()=>{
 const f=await fixture();try{
  const put=f.storage.put.bind(f.storage);f.storage.put=async(...args)=>{
   await f.db.query('DELETE FROM platform_users WHERE id=$1',[f.who.userId]);await put(...args);
  };
  await assert.rejects(f.writes.upload(f.who,file()));await f.empty();
  assert.equal((await f.db.query('SELECT 1 FROM platform_uploads')).rowCount,0);
 }finally{await f.close();}
});

test('logout during I/O fences publication but does not prevent orphan cleanup',async()=>{
 const f=await fixture();try{
  const put=f.storage.put.bind(f.storage);f.storage.put=async(...args)=>{await put(...args);await f.db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[f.who.tokenHash]);};
  await assert.rejects(f.writes.upload(f.who,file()),(e:unknown)=>e instanceof ApiError&&e.code==='AUTH_REQUIRED');await f.empty();
 }finally{await f.close();}
});

test('lost publication COMMIT acknowledgement never deletes the actual published private file',async()=>{
 const f=await fixture();try{
  const bounded=f.db.withBoundedTransaction.bind(f.db);let calls=0;
  f.db.withBoundedTransaction=async(run,opts)=>{const n=++calls,result=await bounded(run,opts);if(n===3)throw Error('Fictional lost publication acknowledgement');return result;};
  try{await assert.rejects(f.writes.upload(f.who,file()));}finally{f.db.withBoundedTransaction=bounded;}
  const row=(await f.db.query('SELECT * FROM platform_uploads WHERE user_id=$1',[f.who.userId])).rows[0];assert(row);await f.storage.stat(row.storage_key);
  assert.equal((await f.rows()).length,0);await f.writes.recover();await f.storage.stat(row.storage_key);
 }finally{await f.close();}
});

test('failed cleanup survives a fresh service and finishes only after real physical disappearance',async()=>{
 const f=await fixture();try{
  const put=f.storage.put.bind(f.storage),del=f.storage.delete.bind(f.storage);
  f.storage.put=async(...args)=>{await put(...args);await f.db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[f.who.tokenHash]);};
  f.storage.delete=async()=>{};await assert.rejects(f.writes.upload(f.who,file()));
  assert.equal((await f.rows()).length,1);assert.equal((await readdir(f.dir)).length,1);f.storage.delete=del;
  await f.future(()=>new UploadWrites(f.db,f.crypto,f.storage).recover());await f.empty();
 }finally{await f.close();}
});

test('ambiguous failed remote writes retain their tombstone even after 404 and erase a later appearing object',async()=>{
 const f=await fixture();try{
  const put=f.storage.put.bind(f.storage);let key='';
  f.storage.put=async(k)=>{key=k;throw Error('Fictional uncertain storage result');};
  await assert.rejects(f.writes.upload(f.who,file()));assert.equal((await f.rows()).length,1);assert.deepEqual(await readdir(f.dir),[]);
  await put(key,file().bytes);await f.future(()=>f.writes.recover());assert.deepEqual(await readdir(f.dir),[]);assert.equal((await f.rows()).length,1);
  const row=(await f.rows())[0];const payload=JSON.parse(f.crypto.openUtf8(row.record_ciphertext,{table:'platform_upload_writes',column:'record_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.revision}));assert.equal(payload.writerFinished,false);
 }finally{await f.close();}
});

test('recovery racing a late acknowledged writer cannot erase its tombstone before the writer finishes',async()=>{
 const f=await fixture();try{
  const put=f.storage.put.bind(f.storage);let release!:()=>void,enter!:()=>void;
  const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
  f.storage.put=async(...args)=>{enter();await gate;await put(...args);};
  const running=f.writes.upload(f.who,file());const failed=assert.rejects(running);
  await entered;await f.db.query('DELETE FROM platform_users WHERE id=$1',[f.who.userId]);await f.writes.recover();
  assert.equal((await f.rows()).length,1);release();await failed;
  await f.future(()=>f.writes.recover());await f.empty();
 }finally{await f.close();}
});

test('unconfigured writes and revoked sessions cannot perform storage I/O or leave intents',async()=>{
 const f=await fixture();try{
  let calls=0;f.storage.put=async()=>{calls++;};
  await assert.rejects(new UploadWrites(f.db,undefined,f.storage).upload(f.who,file()));
  await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[f.who.userId]);
  await assert.rejects(f.writes.upload(f.who,file()));assert.equal(calls,0);await f.empty();
 }finally{await f.close();}
});

test('cleanup verifies scope, encrypted state and latest event before touching any object',async()=>{
 const f=await fixture();try{
  const put=f.storage.put.bind(f.storage),del=f.storage.delete.bind(f.storage);let key='';let old:any;
  f.storage.put=async(k,...args)=>{key=k;old=(await f.rows())[0];await put(k,...args);await f.db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[f.who.tokenHash]);};
  f.storage.delete=async()=>{throw Error('Fictional storage outage');};await assert.rejects(f.writes.upload(f.who,file()));f.storage.delete=del;
  const row=(await f.rows())[0];const wrong=new LocalBlobStorage(path.join(f.dir,'different'));
  await f.future(()=>new UploadWrites(f.db,f.crypto,wrong).recover());await f.storage.stat(key);
  await f.db.query('UPDATE platform_upload_writes SET record_ciphertext=$2 WHERE id=$1',[row.id,Buffer.alloc(row.record_ciphertext.length)]);
  await assert.rejects(f.future(()=>f.writes.recover()));await f.storage.stat(key);
  await f.db.query('UPDATE platform_upload_writes SET status=$2,revision=$3,last_event_id=$4,lease_until=$5,record_ciphertext=$6 WHERE id=$1',[row.id,old.status,old.revision,old.last_event_id,old.lease_until,old.record_ciphertext]);
  await assert.rejects(f.future(()=>f.writes.recover()));await f.storage.stat(key);
  await f.db.query('UPDATE platform_upload_writes SET status=$2,revision=$3,last_event_id=$4,lease_until=$5,record_ciphertext=$6 WHERE id=$1',[row.id,row.status,row.revision,row.last_event_id,row.lease_until,row.record_ciphertext]);
  await f.future(()=>f.writes.recover());await f.empty();
 }finally{await f.close();}
});

test('staged handles cannot be forged or transferred and recheck the original live authority at publication',async()=>{
 const f=await fixture();try{
  const stage=await f.writes.stage(f.who.userId,file(),c=>authorizeFixedSession(c,f.who));
  await assert.rejects(f.db.withBoundedTransaction(c=>f.writes.publishInTransaction(c,{...stage})));
  await assert.rejects(f.db.withBoundedTransaction(c=>new UploadWrites(f.db,f.crypto,f.storage).publishInTransaction(c,stage)));
  await f.db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[f.who.tokenHash]);
  await assert.rejects(f.db.withBoundedTransaction(c=>f.writes.publishInTransaction(c,stage)));
  await f.writes.abandon(stage);await f.empty();assert.equal((await f.db.query('SELECT 1 FROM platform_uploads')).rowCount,0);
 }finally{await f.close();}
});

test('artifact transaction rollback preserves recoverable staging and a retry cannot duplicate publication',async()=>{
 const f=await fixture();try{
  const stage=await f.writes.stage(f.who.userId,file(),c=>authorizeFixedSession(c,f.who));
  await assert.rejects(f.db.withBoundedTransaction(async c=>{await f.writes.publishInTransaction(c,stage);throw Error('Fictional downstream artifact failure');}));
  assert.equal((await f.rows()).length,1);assert.equal((await f.db.query('SELECT 1 FROM platform_uploads')).rowCount,0);
  await f.db.withBoundedTransaction(c=>f.writes.publishInTransaction(c,stage));
  await assert.rejects(f.db.withBoundedTransaction(c=>f.writes.publishInTransaction(c,stage)));
  await f.writes.abandon(stage);const row=(await f.db.query('SELECT storage_key FROM platform_uploads WHERE id=$1',[stage.id])).rows[0];await f.storage.stat(row.storage_key);
  assert.equal((await f.rows()).length,0);
 }finally{await f.close();}
});
