import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import type {PoolClient} from 'pg';
import type {Database} from '../src/database.ts';
import {AccountCoreExport} from '../src/account-core-export.ts';
import {AccountReauthentication} from '../src/account-reauthentication.ts';
import {authorizeFixedSession,hashPassword,type FixedSessionContext} from '../src/auth.ts';
import {LocalBlobStorage,type BlobStorage} from '../src/storage.ts';
import {UploadWrites} from '../src/upload-writes.ts';
import {UploadRemovals} from '../src/upload-removals.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,directory:string,blobs:LocalBlobStorage,encoded:string;
const password='Fictional-upload-journal-export-password';
before(async()=>{f=await createCompanionNameSafetyFixture();directory=await mkdtemp(path.join(os.tmpdir(),'fictional-journal-export-'));blobs=new LocalBlobStorage(directory);encoded=await hashPassword(password);});
after(async()=>{await f?.close();await rm(directory,{recursive:true,force:true});});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,encoded]);return who;}
const proof=async(who:FixedSessionContext)=>(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
const archive=async(who:FixedSessionContext)=>new AccountCoreExport(f.db,f.config).capture(who,await proof(who));
const consumed=async(who:FixedSessionContext)=>(await f.db.query("SELECT consumed_at FROM platform_account_reauthentications WHERE user_id=$1 AND purpose='account_export'",[who.userId])).rows[0].consumed_at;
const input={filename:'Fictional original.txt',mime:'text/plain',bytes:Buffer.from('Fictional IBM project evidence.')};
function storageWith(changes:Partial<BlobStorage>):BlobStorage{return {scope:blobs.scope,put:blobs.put.bind(blobs),get:blobs.get.bind(blobs),delete:blobs.delete.bind(blobs),stat:blobs.stat.bind(blobs),openRead:blobs.openRead.bind(blobs),...changes};}
async function stage(who:FixedSessionContext,storage:BlobStorage=blobs){const writes=new UploadWrites(f.db,f.crypto,storage);return {writes,staged:await writes.stage(who.userId,input,c=>authorizeFixedSession(c,who))};}
async function removal(who:FixedSessionContext,complete=false){const file=await new UploadWrites(f.db,f.crypto,blobs).upload(who,input),service=new UploadRemovals(f.db,f.crypto,blobs),command={operationId:randomUUID()};
 await service.request(who,file.id,command);if(complete)await service.cleanup(file.id);return {file,service,command};}
function instrument(transform:(sql:string,rows:Record<string,any>[])=>void|Promise<void>):Database{return {withBoundedTransaction:<T>(run:(c:PoolClient)=>Promise<T>,options?:{readOnly?:boolean;timeoutMs?:number})=>f.db.withBoundedTransaction(c=>run(new Proxy(c,{get(target,key){
 if(key==='query')return async(sql:string,values:unknown[])=>{const result=await target.query(sql,values);await transform(sql,result.rows);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}})),options)} as Database;}
const writeRows=(sql:string)=>sql.startsWith('SELECT id,user_id,status,revision,last_event_id,publish_until');
const writeEvents=(sql:string)=>sql.startsWith('SELECT e.write_id,e.id,e.revision,e.ciphertext,w.user_id');
const removalRows=(sql:string)=>sql.startsWith('SELECT upload_id,user_id,operation_id,status,generation,last_event_id');
const removalEvents=(sql:string)=>sql.startsWith('SELECT upload_id,user_id,id,generation,ciphertext,created_at');
async function rowsSnapshot(who:FixedSessionContext){const result:Record<string,unknown>={};for(const table of ['platform_upload_writes','platform_upload_removals','platform_upload_removal_events'])result[table]=(await f.db.query(`SELECT row_to_json(t)::text AS row FROM ${table} t WHERE user_id=$1 ORDER BY row_to_json(t)::text`,[who.userId])).rows;
 result.writeEvents=(await f.db.query('SELECT row_to_json(e)::text AS row FROM platform_upload_write_events e JOIN platform_upload_writes w ON w.id=e.write_id WHERE w.user_id=$1 ORDER BY e.write_id,e.revision',[who.userId])).rows;return result;}

test('pending and completed actual removals retain names, dates and complete event coordinates without cleanup credentials',async context=>{
 const who=await actor(),pending=await removal(who),complete=await removal(who,true),other=await actor();await removal(other,true);
 const row=(await f.db.query('SELECT * FROM platform_upload_removals WHERE upload_id=$1',[pending.file.id])).rows[0],sealed=JSON.parse(f.crypto.openUtf8(row.record_ciphertext,{table:'platform_upload_removals',column:'record_ciphertext',rowId:row.upload_id,ownerId:who.userId,revision:row.generation}));
 context.mock.method(globalThis,'fetch',async()=>{throw Error('No external requests');});const before=await rowsSnapshot(who),queries:string[]=[],data=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(who,await proof(who));
 const records=data.sections.uploadRemovals as any[],a=records.find(r=>r.uploadId===pending.file.id),b=records.find(r=>r.uploadId===complete.file.id);
 assert.equal(a.name,input.filename);assert.equal(a.operationId,pending.command.operationId);assert.equal(a.status,'pending');assert.equal(a.removedAt,null);assert.equal(a.generation,1);assert.equal(b.status,'removed');assert(b.removedAt);assert.equal(b.generation,3);
 assert.equal(data.sections.uploadRemovalEvents.length,4);assert.equal((data.sections.uploadRemovalEvents as any[]).find(e=>e.uploadId===pending.file.id).createdAt,a.requestedAt);
 assert.equal(data.includedTables.length,98);assert.equal(data.remainingTables.length,66);assert.equal(data.complete,false);assert.equal(data.filesIncluded,false);
 for(const secret of [sealed.storageKey,sealed.scope,who.tokenHash,other.userId,'acceptedAuthVersion','recordDigest','leaseToken','record_ciphertext',password,encoded])assert(!JSON.stringify(data).includes(secret));
 assert.deepEqual(await rowsSnapshot(who),before);assert(!queries.some(sql=>/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+platform_upload_/i.test(sql)));assert(Object.isFrozen(a));
});

test('an actual writer acknowledgement during export cannot mix writing and ready revisions in the snapshot',async()=>{
 const who=await actor();let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
 const storage=storageWith({put:async(...args)=>{enter();await gate;await blobs.put(...args);}}),writes=new UploadWrites(f.db,f.crypto,storage),pending=writes.stage(who.userId,input,c=>authorizeFixedSession(c,who));await entered;
 let changed=false;
 try{
  const data=await new AccountCoreExport(instrument(async sql=>{if(!changed&&writeRows(sql)){changed=true;release();await pending;}}),f.config).capture(who,await proof(who));
  assert(changed);assert.equal((data.sections.uploadWrites[0] as any).status,'writing');assert.equal((data.sections.uploadWrites[0] as any).writerFinished,false);assert.equal(data.sections.uploadWriteEvents.length,1);
  const ready=await archive(who);assert.equal((ready.sections.uploadWrites[0] as any).status,'ready');assert.equal((ready.sections.uploadWrites[0] as any).writerFinished,true);assert.equal(ready.sections.uploadWriteEvents.length,2);
  const staged=await pending;await f.db.withBoundedTransaction(c=>writes.publishInTransaction(c,staged));const published=await archive(who);assert.deepEqual(published.sections.uploadWrites,[]);assert.deepEqual(published.sections.uploadWriteEvents,[]);
 }finally{release();await pending;}
});

test('unknown write outcome and failed cleanup stay distinct from publication or deletion; export performs no storage calls',async()=>{
 const who=await actor();let puts=0,deletes=0;
 const storage=storageWith({put:async(...args)=>{puts++;await blobs.put(...args);throw Error('Fictional lost write acknowledgement');},delete:async()=>{deletes++;throw Error('Fictional delete unavailable');}});
 await assert.rejects(new UploadWrites(f.db,f.crypto,storage).stage(who.userId,input,c=>authorizeFixedSession(c,who)));assert.equal(puts,1);assert.equal(deletes,1);
 const raw=(await f.db.query('SELECT * FROM platform_upload_writes WHERE user_id=$1',[who.userId])).rows[0],record=JSON.parse(f.crypto.openUtf8(raw.record_ciphertext,{table:'platform_upload_writes',column:'record_ciphertext',rowId:raw.id,ownerId:who.userId,revision:raw.revision}));
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);const before=await rowsSnapshot(who),data=await archive(who),saved=data.sections.uploadWrites[0] as any;
 assert.equal(saved.status,'cleanup');assert.equal(saved.writerFinished,false);assert.equal(saved.revision,3);assert.equal(data.sections.uploadWriteEvents.length,3);assert.equal(puts,1);assert.equal(deletes,1);
 for(const secret of [record.storageKey,record.scope,record.writerToken,record.leaseToken,'leaseUntil','recordDigest'])assert(!JSON.stringify(data).includes(secret));assert.deepEqual(await rowsSnapshot(who),before);
 for(const e of data.sections.uploadWriteEvents as any[]){assert.equal(e.writeId,saved.id);assert.equal(e.createdAt,undefined);assert.equal(e.status,undefined);}
});

test('authenticated journal corruption, wrong owners and orphan event rows discard the export with a reusable proof',async()=>{
 const who=await actor();await stage(who);await removal(who,true);const token=await proof(who);
 const cases:[(sql:string)=>boolean,(row:any)=>void][]=[
  [writeRows,r=>{r.user_id=randomUUID();}], [writeRows,r=>{r.status='cleanup';}], [removalRows,r=>{r.user_id=randomUUID();}],
  [writeEvents,r=>{r.write_id=randomUUID();}], [writeEvents,r=>{r.owner_id=randomUUID();}], [removalEvents,r=>{r.upload_id=randomUUID();}], [removalEvents,r=>{r.user_id=randomUUID();}],
  ...[writeRows,removalRows].map(matches=>[matches,(r:any)=>{r.record_ciphertext=Buffer.from(r.record_ciphertext);r.record_ciphertext[r.record_ciphertext.length-1]^=1;}] as [(sql:string)=>boolean,(row:any)=>void]),
  ...[writeEvents,removalEvents].map(matches=>[matches,(r:any)=>{r.ciphertext=Buffer.from(r.ciphertext);r.ciphertext[r.ciphertext.length-1]^=1;}] as [(sql:string)=>boolean,(row:any)=>void]),
 ];
 for(const [matches,change] of cases){let reached=false;await assert.rejects(new AccountCoreExport(instrument((sql,rows)=>{if(matches(sql)&&rows.length){reached=true;change(rows[0]);}}),f.config).capture(who,token),{code:'ACCOUNT_UPLOAD_JOURNAL_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(who),null);}
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.uploadWrites.length,1);
});

test('complete history refuses missing older events, duplicate revisions and authentic old projection rollback',async()=>{
 const who=await actor(),r=await removal(who),old=(await f.db.query('SELECT * FROM platform_upload_removals WHERE upload_id=$1',[r.file.id])).rows[0];await r.service.cleanup(r.file.id);await stage(who);const token=await proof(who);
 const cases=[(sql:string,rows:any[])=>{if(removalRows(sql)&&rows.length)rows[0]={...old};},
  (sql:string,rows:any[])=>{if(writeEvents(sql)&&rows.length)rows.shift();},(sql:string,rows:any[])=>{if(removalEvents(sql)&&rows.length)rows.shift();},
  (sql:string,rows:any[])=>{if(writeEvents(sql)&&rows.length)rows.push(rows[0]);},(sql:string,rows:any[])=>{if(removalEvents(sql)&&rows.length)rows.push(rows[0]);}];
 for(const transform of cases){await assert.rejects(new AccountCoreExport(instrument(transform),f.config).capture(who,token),{code:'ACCOUNT_UPLOAD_JOURNAL_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);}
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.uploadRemovalEvents.length,3);
});

test('authenticated unknown fields and non-digest event payloads fail closed instead of entering the account JSON',async()=>{
 const who=await actor();await stage(who);await removal(who);const token=await proof(who);
 for(const isWrite of [true,false]){let reached=false;const matches=isWrite?writeRows:removalRows;
  const db=instrument((sql,rows)=>{if(matches(sql)&&rows.length){reached=true;const r=rows[0],context={table:isWrite?'platform_upload_writes':'platform_upload_removals',column:'record_ciphertext',rowId:isWrite?r.id:r.upload_id,ownerId:who.userId,revision:isWrite?r.revision:r.generation};
   const value=JSON.parse(f.crypto.openUtf8(r.record_ciphertext,context));value.privateCredentials='Fictional unexpected field';r.record_ciphertext=f.crypto.sealUtf8(JSON.stringify(Object.fromEntries(Object.entries(value).sort())),context);}});
  await assert.rejects(new AccountCoreExport(db,f.config).capture(who,token),{code:'ACCOUNT_UPLOAD_JOURNAL_EXPORT_UNAVAILABLE'});assert(reached);assert.equal(await consumed(who),null);
 }
 const db=instrument((sql,rows)=>{if(writeEvents(sql)&&rows.length){const r=rows[0];r.ciphertext=f.crypto.sealUtf8('Fictional invalid digest',{table:'platform_upload_write_events',column:'ciphertext',rowId:r.id,ownerId:who.userId,revision:r.revision});}});
 await assert.rejects(new AccountCoreExport(db,f.config).capture(who,token),{code:'ACCOUNT_UPLOAD_JOURNAL_EXPORT_UNAVAILABLE'});assert.equal(await consumed(who),null);assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.uploadWrites.length,1);
});

test('105 real staged writes and completed removals cross all journal and event pages without normal list limits',async()=>{
 const who=await actor();for(let i=0;i<105;i++){await stage(who);await removal(who,true);}
 const queries:string[]=[],data=await new AccountCoreExport(instrument(sql=>{queries.push(sql);}),f.config).capture(who,await proof(who));
 assert.equal(data.sections.uploadWrites.length,105);assert.equal(data.sections.uploadWriteEvents.length,210);assert.equal(data.sections.uploadRemovals.length,105);assert.equal(data.sections.uploadRemovalEvents.length,315);
 assert.equal(queries.filter(writeRows).length,2);assert.equal(queries.filter(writeEvents).length,3);assert.equal(queries.filter(removalRows).length,2);assert.equal(queries.filter(removalEvents).length,4);
});

test('empty journals, abort and JSON capacity failure never synthesize records or consume the retry proof',async()=>{
 const empty=await archive(await actor());for(const key of ['uploadWrites','uploadWriteEvents','uploadRemovals','uploadRemovalEvents'] as const)assert.deepEqual(empty.sections[key],[]);
 const who=await actor();await stage(who);await removal(who);const token=await proof(who),abort=new AbortController();
 await assert.rejects(new AccountCoreExport(instrument(sql=>{if(removalEvents(sql))abort.abort();}),f.config).capture(who,token,abort.signal),{code:'ACCOUNT_EXPORT_CANCELLED'});assert.equal(await consumed(who),null);
 await assert.rejects(new AccountCoreExport(f.db,f.config,{maxBytes:1024}).capture(who,token),{code:'ACCOUNT_EXPORT_TOO_LARGE'});assert.equal(await consumed(who),null);
 assert.equal((await new AccountCoreExport(f.db,f.config).capture(who,token)).sections.uploadWrites.length,1);
});

test('actual concurrent cleanup commits while the archive retains the earlier pending snapshot and complete older event list',async()=>{
 const who=await actor(),r=await removal(who);let cleaned=false;
 const data=await new AccountCoreExport(instrument(async sql=>{if(!cleaned&&removalRows(sql)){cleaned=true;await r.service.cleanup(r.file.id);}}),f.config).capture(who,await proof(who));
 assert(cleaned);assert.equal((data.sections.uploadRemovals[0] as any).status,'pending');assert.equal(data.sections.uploadRemovalEvents.length,1);
 assert.equal((await r.service.get(who,r.file.id)).status,'removed');assert.equal((await archive(who)).sections.uploadRemovalEvents.length,3);
});

test('cleanup journals retained after a real account deletion never enter another living owner archive',async()=>{
 const who=await actor(),deleted=await actor(),mine=await removal(who),foreign=await removal(deleted),staged=await stage(deleted);
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[deleted.userId]);assert.equal((await f.db.query('SELECT 1 FROM platform_upload_removals WHERE upload_id=$1',[foreign.file.id])).rowCount,1);assert.equal((await f.db.query('SELECT 1 FROM platform_upload_writes WHERE id=$1',[staged.staged.id])).rowCount,1);
 const data=await archive(who);assert.equal(data.sections.uploadRemovals.length,1);assert.equal((data.sections.uploadRemovals[0] as any).uploadId,mine.file.id);assert.deepEqual(data.sections.uploadWrites,[]);
 for(const secret of [deleted.userId,foreign.file.id,staged.staged.id])assert(!JSON.stringify(data).includes(secret));
});
