import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import { UploadRemovals } from '../src/upload-removals.ts';
import { ResumeOriginalReview } from '../src/resume-original-review.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { ApiError } from '../src/errors.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,directory:string,storage:LocalBlobStorage,removals:UploadRemovals;
before(async()=>{f=await createCompanionNameSafetyFixture();directory=await mkdtemp(path.join(os.tmpdir(),'fictional-upload-removal-'));storage=new LocalBlobStorage(directory);removals=new UploadRemovals(f.db,f.crypto,storage);});
after(async()=>{await f?.close();await rm(directory,{recursive:true,force:true});});
const denied=(status:number)=>(e:unknown)=>e instanceof ApiError&&e.status===status;
async function file(who:{userId:string}){const id=randomUUID(),key=randomUUID();await storage.put(key,Buffer.from('Fictional course project.'));await f.db.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,$3,$4,$5,$6)',[id,who.userId,'Fictional.txt','text/plain',25,key]);return {id,key,command:{operationId:randomUUID()}};}
async function artifact(who:{userId:string},uploadId:string){const job=randomUUID(),id=randomUUID();await f.db.query("INSERT INTO platform_jobs(id,user_id,kind,provider,prompt,status) VALUES($1,$2,'image','fictional','Fictional artifact fixture','succeeded')",[job,who.userId]);await f.db.query("INSERT INTO platform_artifacts(id,user_id,job_id,kind,upload_id) VALUES($1,$2,$3,'file',$4)",[id,who.userId,job,uploadId]);return id;}
test('real upload revocation, physical local cleanup and authenticated receipt preserve an independent owner-confirmed resume',async()=>{
 const who=await f.actor(),u=await file(who),resumes=new ResumeOriginalReview(f.db,f.config,FICTIONAL_LEGAL,storage),v=(await resumes.createFromUpload(who,{operationId:randomUUID(),expectedRevision:0,track:'da',label:'Fictional copy',uploadId:u.id})).view!;
 await resumes.mutate(who,'approve',v.item.id,{operationId:randomUUID(),expectedRevision:1,payloadDigest:v.item.payloadDigest},'web');
 const artifactId=await artifact(who,u.id);const pending=await removals.request(who,u.id,u.command);assert.equal((await f.db.query('SELECT upload_id FROM platform_artifacts WHERE id=$1',[artifactId])).rows[0].upload_id,null);assert.equal(pending.status,'pending');assert.equal(pending.removedAt,null);assert.equal((await f.db.query('SELECT 1 FROM platform_uploads WHERE id=$1',[u.id])).rowCount,0);await storage.stat(u.key);
 await removals.cleanup(u.id);const removed=await removals.get(who,u.id);assert.equal(removed.status,'removed');assert(removed.removedAt);await assert.rejects(storage.stat(u.key),denied(404));assert.equal((await resumes.get(who,v.item.id)).item.status,'approved');
 assert.deepEqual(await removals.request(who,u.id,u.command),removed);assert.deepEqual(await removals.request(who,u.id,{operationId:randomUUID()}),removed);assert.equal((await f.db.query('SELECT count(*)::int count FROM platform_upload_removal_events WHERE upload_id=$1',[u.id])).rows[0].count,3);
 await f.db.query(await readFile(new URL('../migrations/061_upload_removals.sql',import.meta.url),'utf8'));await assert.rejects(f.db.query('UPDATE platform_upload_removal_events SET ciphertext=ciphertext WHERE upload_id=$1',[u.id]));assert(!JSON.stringify(removed).includes(u.key));
});
test('ownership, closed commands, fixed session and operation collisions govern revocation; withdrawn legal admission still allows privacy deletion',async()=>{
 const who=await f.actor(),other=await f.actor(),u=await file(who),second=await file(who);
 await assert.rejects(removals.request(other,u.id,u.command),denied(404));await assert.rejects(removals.get(other,u.id),denied(404));
 for(const patch of [{ownerId:other.userId},{storageKey:u.key},{status:'removed'},{leaseToken:randomUUID()}])await assert.rejects(removals.request(who,u.id,{...u.command,...patch}),denied(400));
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await removals.request(who,u.id,u.command);await assert.rejects(removals.request(who,second.id,u.command),denied(409));await assert.rejects(removals.get(other,u.id),denied(404));
 await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);await assert.rejects(removals.request(who,second.id,{operationId:randomUUID()}),denied(401));assert.equal((await f.db.query('SELECT 1 FROM platform_uploads WHERE id=$1',[second.id])).rowCount,1);await removals.cleanup(u.id);
});
test('a genuine session invalidation before commit rolls back revocation, artifact references and cleanup journal together',async()=>{
 const who=await f.actor(),u=await file(who),artifactId=await artifact(who,u.id),original=f.db.withBoundedTransaction.bind(f.db);f.db.withBoundedTransaction=(run,options)=>original(async client=>{const query=client.query.bind(client),guarded=new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{const result=await (query as any)(...args);if(typeof args[0]==='string'&&args[0].startsWith('DELETE FROM platform_uploads'))await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);return result;};return Reflect.get(target,key);}});return run(guarded);},options);
 try{await assert.rejects(removals.request(who,u.id,u.command),denied(401));}finally{f.db.withBoundedTransaction=original;}
 assert.equal((await f.db.query('SELECT 1 FROM platform_uploads WHERE id=$1',[u.id])).rowCount,1);assert.equal((await f.db.query('SELECT 1 FROM platform_upload_removals WHERE upload_id=$1',[u.id])).rowCount,0);assert.equal((await f.db.query('SELECT upload_id FROM platform_artifacts WHERE id=$1',[artifactId])).rows[0].upload_id,u.id);await storage.stat(u.key);
});
test('storage failure cannot claim removed; a real persisted lease prevents duplicates and recovery uses a controlled future database clock',async()=>{
 const who=await f.actor(),u=await file(who);await removals.request(who,u.id,u.command);const original=storage.delete.bind(storage);let attempts=0;storage.delete=async()=>{attempts++;throw Error('Fictional storage failure: private details must never escape.');};
 try{await removals.cleanup(u.id);await removals.cleanup(u.id);assert.equal(attempts,1);assert.equal((await removals.get(who,u.id)).status,'pending');await storage.stat(u.key);}finally{storage.delete=original;}
 const bounded=f.db.withBoundedTransaction.bind(f.db),query=f.db.query.bind(f.db);const clock=(text:string)=>text.replaceAll('clock_timestamp()',"(clock_timestamp()+interval '31 seconds')");
 f.db.query=(text,values)=>query(clock(text),values);f.db.withBoundedTransaction=(run,options)=>bounded(client=>{const q=client.query.bind(client);return run(new Proxy(client,{get(target,key){if(key==='query')return (text:string,values:unknown[])=>q(clock(text),values);return Reflect.get(target,key);}}));},options);
 try{await removals.recover();}finally{f.db.query=query;f.db.withBoundedTransaction=bounded;}
 assert.equal((await removals.get(who,u.id)).status,'removed');await assert.rejects(storage.stat(u.key),denied(404));
});
test('concurrent genuine cleanup claims perform one physical deletion',async()=>{
 const who=await f.actor(),u=await file(who);await removals.request(who,u.id,u.command);const original=storage.delete.bind(storage);let release!:()=>void,entered!:()=>void,calls=0;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});storage.delete=async(...args)=>{calls++;entered();await gate;await original(...args);};const first=removals.cleanup(u.id);
 try{await ready;await removals.cleanup(u.id);assert.equal(calls,1);release();await first;assert.equal((await removals.get(who,u.id)).status,'removed');}finally{release();await first;storage.delete=original;}
});
test('actual latest immutable event rejects projection forgery and valid earlier encrypted snapshot restoration',async()=>{
 const who=await f.actor(),u=await file(who);await removals.request(who,u.id,u.command);const old=(await f.db.query('SELECT * FROM platform_upload_removals WHERE upload_id=$1',[u.id])).rows[0];await removals.cleanup(u.id);
 await f.db.query('UPDATE platform_upload_removals SET status=$2,generation=$3,last_event_id=$4,lease_until=$5,record_ciphertext=$6,removed_at=$7 WHERE upload_id=$1',[u.id,old.status,old.generation,old.last_event_id,old.lease_until,old.record_ciphertext,old.removed_at]);await assert.rejects(removals.get(who,u.id),denied(503));await assert.rejects(removals.cleanup(u.id),denied(503));
});
test('a changed actual storage scope never deletes another backend, while committed cleanup survives a real account deletion',async()=>{
 const who=await f.actor(),u=await file(who);await removals.request(who,u.id,u.command);const another=new LocalBlobStorage(path.join(directory,'another-backend')),wrong=new UploadRemovals(f.db,f.crypto,another);await wrong.cleanup(u.id);await storage.stat(u.key);assert.equal((await removals.get(who,u.id)).status,'pending');
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);await assert.rejects(removals.get(who,u.id),denied(401));await removals.cleanup(u.id);await assert.rejects(storage.stat(u.key),denied(404));assert.equal((await f.db.query('SELECT status FROM platform_upload_removals WHERE upload_id=$1',[u.id])).rows[0].status,'removed');
});

test('receipt history is owner-scoped and survives refresh with exact database cursor precision',async()=>{
 const who=await f.actor(),other=await f.actor();for(let i=0;i<52;i++){const u=await file(who);await removals.request(who,u.id,u.command);await removals.cleanup(u.id);}const first=await removals.list(who);assert.equal(first.receipts.length,50);const second=await removals.list(who,{after:first.nextAfter});assert.equal(second.receipts.length,2);assert.equal(second.nextAfter,null);assert.equal(new Set([...first.receipts,...second.receipts].map(r=>r.uploadId)).size,52);assert.equal((await removals.list(other)).receipts.length,0);await assert.rejects(removals.list(other,{after:first.nextAfter}),denied(404));
});

test('a late physical deletion completion cannot overwrite a new authentic cleanup lease and its completed receipt',async()=>{
 const who=await f.actor(),u=await file(who);await removals.request(who,u.id,u.command);const remove=storage.delete.bind(storage);let release!:()=>void,entered!:()=>void,calls=0;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});storage.delete=async(...args)=>{if(++calls===1){entered();await gate;}await remove(...args);};const first=removals.cleanup(u.id);await ready;
 const bounded=f.db.withBoundedTransaction.bind(f.db);f.db.withBoundedTransaction=(run,options)=>bounded(client=>{const q=client.query.bind(client);return run(new Proxy(client,{get(target,key){if(key==='query')return (text:string,values:unknown[])=>q(text.replaceAll('clock_timestamp()',"(clock_timestamp()+interval '31 seconds')"),values);return Reflect.get(target,key);}}));},options);
 try{await removals.cleanup(u.id);}finally{f.db.withBoundedTransaction=bounded;release();await first;storage.delete=remove;}
 assert.equal(calls,2);assert.equal((await removals.get(who,u.id)).status,'removed');assert.equal((await f.db.query('SELECT generation FROM platform_upload_removals WHERE upload_id=$1',[u.id])).rows[0].generation,4);assert.equal((await f.db.query('SELECT count(*)::int count FROM platform_upload_removal_events WHERE upload_id=$1',[u.id])).rows[0].count,4);
});

test('a storage acknowledgement without actual disappearance cannot manufacture a completed receipt',async()=>{
 const who=await f.actor(),u=await file(who);await removals.request(who,u.id,u.command);const original=storage.delete.bind(storage);storage.delete=async()=>{};try{await removals.cleanup(u.id);await storage.stat(u.key);assert.equal((await removals.get(who,u.id)).status,'pending');}finally{storage.delete=original;}
});

test('legacy display filename defects cannot prevent an owner from deleting the actual stored file',async()=>{
 const who=await f.actor(),u=await file(who);await f.db.query('UPDATE platform_uploads SET filename=$2 WHERE id=$1',[u.id,'Fictional\t'+'.'.repeat(220)]);const receipt=await removals.request(who,u.id,u.command);assert.equal(receipt.name.length,200);assert(!receipt.name.includes('\t'));await removals.cleanup(u.id);assert.equal((await removals.get(who,u.id)).status,'removed');
});
