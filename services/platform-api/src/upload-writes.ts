import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId, careerRecordObject } from '@companion/platform-contracts';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { DataCrypto } from './data-crypto.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError } from './errors.ts';

const unavailable=()=>new ApiError(503,'UPLOAD_WRITE_UNAVAILABLE','文件保存状态暂时无法确认，请重新查看文件列表。');
const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
interface WriteRecord {
 schemaVersion:1;id:string;ownerId:string;storageKey:string;scope:string;writerToken:string;
 status:'writing'|'ready'|'cleanup';writerFinished:boolean;revision:number;lastEventId:string;
 publishUntil:string;leaseToken:string|null;leaseUntil:string|null;
}
/** Persist before I/O; publish and retire the intent in one transaction. Unknown
 * remote outcomes keep a durable cleanup tombstone until positively reconciled. */
export class UploadWrites {
 constructor(private db:Database,private crypto:DataCrypto|undefined,private storage:BlobStorage){}
 assertConfigured(){if(!this.crypto||!/^blob_scope_[0-9a-f]{64}$/.test(this.storage.scope??''))throw unavailable();}
 private async save(c:PoolClient,r:WriteRecord){
  const ciphertext=this.crypto!.sealUtf8(canonical(r),{table:'platform_upload_writes',column:'record_ciphertext',rowId:r.id,ownerId:r.ownerId,revision:r.revision});
  await c.query(`INSERT INTO platform_upload_writes(id,user_id,status,revision,last_event_id,publish_until,lease_until,record_ciphertext)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,revision=EXCLUDED.revision,
   last_event_id=EXCLUDED.last_event_id,lease_until=EXCLUDED.lease_until,record_ciphertext=EXCLUDED.record_ciphertext`,
   [r.id,r.ownerId,r.status,r.revision,r.lastEventId,r.publishUntil,r.leaseUntil,ciphertext]);
  await c.query('INSERT INTO platform_upload_write_events(write_id,id,revision,ciphertext) VALUES($1,$2,$3,$4)',
   [r.id,r.lastEventId,r.revision,this.crypto!.sealUtf8(digest(r),{table:'platform_upload_write_events',column:'ciphertext',rowId:r.lastEventId,ownerId:r.ownerId,revision:r.revision})]);
 }
 private async read(c:PoolClient,id:string):Promise<WriteRecord|null>{
  const row=(await c.query('SELECT * FROM platform_upload_writes WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)return null;
  try{
   const raw=this.crypto!.openUtf8(row.record_ciphertext,{table:'platform_upload_writes',column:'record_ciphertext',rowId:id,ownerId:row.user_id,revision:row.revision});
   const r=careerRecordObject(JSON.parse(raw),['schemaVersion','id','ownerId','storageKey','scope','writerToken','status','writerFinished','revision','lastEventId','publishUntil','leaseToken','leaseUntil']) as unknown as WriteRecord;
   if(canonical(r)!==raw||r.schemaVersion!==1||r.id!==id||r.ownerId!==row.user_id||r.status!==row.status||r.revision!==row.revision||r.lastEventId!==row.last_event_id
    ||r.publishUntil!==row.publish_until.toISOString()||r.leaseUntil!==(row.lease_until?.toISOString()??null)||!Number.isSafeInteger(r.revision)||r.revision<1
    ||!['writing','ready','cleanup'].includes(r.status)||typeof r.writerFinished!=='boolean'||r.status==='ready'&&!r.writerFinished
    ||!/^blob_scope_[0-9a-f]{64}$/.test(r.scope)||(r.leaseToken===null)!==(r.leaseUntil===null))throw unavailable();
   for(const v of [r.id,r.ownerId,r.storageKey,r.writerToken,r.lastEventId])careerRecordId(v);if(r.leaseToken!==null)careerRecordId(r.leaseToken);
   const event=(await c.query('SELECT * FROM platform_upload_write_events WHERE write_id=$1 ORDER BY revision DESC LIMIT 1 FOR SHARE',[id])).rows[0];
   if(!event||event.id!==r.lastEventId||event.revision!==r.revision||this.crypto!.openUtf8(event.ciphertext,{table:'platform_upload_write_events',column:'ciphertext',rowId:event.id,ownerId:r.ownerId,revision:r.revision})!==digest(r))throw unavailable();
   return r;
  }catch{throw unavailable();}
 }
 private next(r:WriteRecord,changes:Partial<WriteRecord>):WriteRecord{if(r.revision>=2147483647)throw unavailable();return {...r,...changes,revision:r.revision+1,lastEventId:randomUUID()};}
 private async finish(id:string,token:string,completed:boolean,abandon:boolean){
  return this.db.withBoundedTransaction(async c=>{
   const r=await this.read(c,id);if(!r)return; if(r.writerToken!==token)throw unavailable();
   const active=(await c.query('SELECT 1 FROM platform_users WHERE id=$1 AND clock_timestamp()<$2',[r.ownerId,r.publishUntil])).rowCount===1;
   await this.save(c,this.next(r,{writerFinished:r.writerFinished||completed,status:abandon||r.status==='cleanup'||!active?'cleanup':'ready'}));
  });
 }
 async upload(value:FixedSessionContext,input:{filename:string;mime:string;bytes:Uint8Array},signal?:AbortSignal){
  this.assertConfigured();let who:FixedSessionContext;
  try{const v=careerRecordObject(value,['userId','tokenHash']);if(typeof v.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(v.tokenHash))throw unavailable();who=Object.freeze({userId:careerRecordId(v.userId),tokenHash:v.tokenHash});}
  catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}
  const filename=input.filename,mime=input.mime,bytes=Buffer.from(input.bytes);
  if(!filename||filename.length>200||/[\x00-\x1f\x7f]/.test(filename)||!mime||mime.length>150||bytes.length>200*1024*1024)throw unavailable();
  const id=randomUUID(),storageKey=randomUUID(),writerToken=randomUUID();let attempted=false,acknowledged=false;
  try{
   await this.db.withBoundedTransaction(async c=>{
    await authorizeFixedSession(c,who,signal);
    const until=(await c.query("SELECT clock_timestamp()+interval '2 minutes' until")).rows[0].until.toISOString();
    await this.save(c,{schemaVersion:1,id,ownerId:who.userId,storageKey,scope:this.storage.scope!,writerToken,status:'writing',writerFinished:false,
     revision:1,lastEventId:randomUUID(),publishUntil:until,leaseToken:null,leaseUntil:null});signal?.throwIfAborted();
   });
   signal?.throwIfAborted();attempted=true;
   const timeout=AbortSignal.timeout(30000),io=signal?AbortSignal.any([signal,timeout]):timeout;
   await this.storage.put(storageKey,bytes,mime,io);acknowledged=true;
   await this.finish(id,writerToken,true,false);
   signal?.throwIfAborted();const stat=await this.storage.stat(storageKey,io);if(stat.size!==bytes.length)throw unavailable();
   await this.db.withBoundedTransaction(async c=>{
    await authorizeFixedSession(c,who,signal);const r=await this.read(c,id);
    if(!r||r.writerToken!==writerToken||r.status!=='ready'||!r.writerFinished||r.scope!==this.storage.scope
     ||!(await c.query('SELECT 1 WHERE clock_timestamp()<$1',[r.publishUntil])).rowCount)throw unavailable();
    await c.query('INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,$3,$4,$5,$6)',[id,who.userId,filename,mime,bytes.length,storageKey]);
    await c.query('DELETE FROM platform_upload_writes WHERE id=$1',[id]);await authorizeFixedSession(c,who,signal);
   });
   return {id,name:filename,mime,size:bytes.length};
  }catch(error){
   // If publication committed but its acknowledgement was lost, the intent is
   // already absent. Never infer that the published object should be removed.
   await this.finish(id,writerToken,acknowledged||!attempted,true).catch(()=>{});
   await this.cleanup(id).catch(()=>{});
   if(error instanceof ApiError)throw error;throw unavailable();
  }
 }
 async cleanup(id:string,signal?:AbortSignal){
  this.assertConfigured();careerRecordId(id);signal?.throwIfAborted();
  const claim=await this.db.withBoundedTransaction(async c=>{
   const r=await this.read(c,id);if(!r||r.scope!==this.storage.scope)return null;
   // A published object is never garbage, including a lost COMMIT ack.
   if((await c.query('SELECT 1 FROM platform_uploads WHERE storage_key=$1',[r.storageKey])).rowCount)return null;
   const clock=(await c.query("SELECT clock_timestamp() at,clock_timestamp()+interval '30 seconds' until")).rows[0];
   if(r.leaseUntil&&r.leaseUntil>clock.at.toISOString())return null;
   if(r.status!=='cleanup'&&r.publishUntil>clock.at.toISOString()&&(await c.query('SELECT 1 FROM platform_users WHERE id=$1',[r.ownerId])).rowCount)return null;
   const claimed=this.next(r,{status:'cleanup',leaseToken:randomUUID(),leaseUntil:clock.until.toISOString()});await this.save(c,claimed);return claimed;
  });if(!claim)return;
  const timeout=AbortSignal.timeout(5000),io=signal?AbortSignal.any([signal,timeout]):timeout;let gone=false;
  try{await this.storage.delete(claim.storageKey,io);try{await this.storage.stat(claim.storageKey,io);}catch(e){gone=e instanceof ApiError&&e.code==='STORAGE_NOT_FOUND'&&!io.aborted;}}catch{/* Keep the durable coordinates on any failed delete. */}
  if(!gone)return;
  await this.db.withBoundedTransaction(async c=>{
   const r=await this.read(c,id);if(!r||r.revision!==claim.revision||r.leaseToken!==claim.leaseToken||!r.writerFinished)return;
   if(!(await c.query('SELECT 1 WHERE clock_timestamp()<$1',[r.leaseUntil])).rowCount)return;
   await c.query('DELETE FROM platform_upload_writes WHERE id=$1',[id]);
  });
 }
 async recover(signal?:AbortSignal){
  this.assertConfigured();const rows=(await this.db.query(`SELECT w.id FROM platform_upload_writes w
   WHERE (w.lease_until IS NULL OR w.lease_until<=clock_timestamp()) AND
    (w.status='cleanup' OR w.publish_until<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM platform_users u WHERE u.id=w.user_id))
   ORDER BY w.publish_until,w.id LIMIT 20`)).rows;
  for(const row of rows){signal?.throwIfAborted();await this.cleanup(row.id,signal);}
 }
}
