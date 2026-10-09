import {decodeUploadRemovalRecord,type UploadRemovalRecord as Record} from './upload-journal-codec.ts';
import { createHash,randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId,careerRecordObject,careerLibraryTime,parseUploadRemovalCommand,parseUploadRemovalReceipt,type UploadRemovalReceipt } from '@companion/platform-contracts';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { DataCrypto } from './data-crypto.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError } from './errors.ts';
import { AccountReauthentication } from './account-reauthentication.ts';
const unavailable=()=>new ApiError(503,'UPLOAD_REMOVAL_UNAVAILABLE','文件清理状态暂时无法确认，请重新查看。');
const missing=()=>new ApiError(404,'NOT_FOUND','这份文件或清理记录不存在。');
const canonical=(value:unknown)=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');

function fixed(value:FixedSessionContext){try{const v=careerRecordObject(value,['userId','tokenHash']);if(typeof v.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(v.tokenHash))throw Error();return {userId:careerRecordId(v.userId),tokenHash:v.tokenHash};}catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}}
/** Durable file revocation and cleanup only. No model work, external-user
 * capability, fake completion, or replacement of saved text copies. */
export class UploadRemovals {
 constructor(private readonly db:Database,private readonly crypto:DataCrypto|undefined,private readonly storage:BlobStorage){}
 private configured(){if(!this.crypto||typeof this.storage.scope!=='string'||!/^blob_scope_[0-9a-f]{64}$/.test(this.storage.scope))throw unavailable();}
 private async decode(client:PoolClient,row:any):Promise<Record>{
  this.configured();try{const event=(await client.query('SELECT * FROM platform_upload_removal_events WHERE upload_id=$1 ORDER BY generation DESC LIMIT 1 FOR SHARE',[row.upload_id])).rows[0];
   return decodeUploadRemovalRecord(this.crypto,row,event);
  }catch{throw unavailable();}
 }
 private async save(client:PoolClient,r:Record,at:string){
  const cipher=this.crypto!.sealUtf8(canonical(r),{table:'platform_upload_removals',column:'record_ciphertext',rowId:r.uploadId,ownerId:r.ownerId,revision:r.generation});
  await client.query('INSERT INTO platform_upload_removals(upload_id,user_id,operation_id,status,generation,last_event_id,lease_until,record_ciphertext,requested_at,removed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(upload_id) DO UPDATE SET status=EXCLUDED.status,generation=EXCLUDED.generation,last_event_id=EXCLUDED.last_event_id,lease_until=EXCLUDED.lease_until,record_ciphertext=EXCLUDED.record_ciphertext,removed_at=EXCLUDED.removed_at',[r.uploadId,r.ownerId,r.operationId,r.status,r.generation,r.lastEventId,r.leaseUntil,cipher,r.requestedAt,r.removedAt]);
  const event=this.crypto!.sealUtf8(canonical({recordDigest:hash(r),at}),{table:'platform_upload_removal_events',column:'ciphertext',rowId:r.lastEventId,ownerId:r.ownerId,revision:r.generation});
  await client.query('INSERT INTO platform_upload_removal_events(upload_id,user_id,id,generation,ciphertext,created_at) VALUES($1,$2,$3,$4,$5,$6)',[r.uploadId,r.ownerId,r.lastEventId,r.generation,event,at]);
 }
 /** Only an authenticated, completed journal may lose its recovery coordinates.
  * The caller holds the journal row lock; the FK cascades its private events.
  * Live owners keep their receipts. No deletion identity is retained here. */
 private async purgeDeletedOwnerReceipt(client:PoolClient,r:Record){
  if(r.status!=='removed')return;
  await client.query(`DELETE FROM platform_upload_removals r WHERE r.upload_id=$1 AND r.user_id=$2
   AND r.generation=$3 AND r.status='removed'
   AND NOT EXISTS(SELECT 1 FROM platform_users u WHERE u.id=r.user_id)`,[r.uploadId,r.ownerId,r.generation]);
 }
 private public(r:Record){return parseUploadRemovalReceipt({ownerId:r.ownerId,name:r.name,uploadId:r.uploadId,operationId:r.operationId,status:r.status,requestedAt:r.requestedAt,removedAt:r.removedAt});}
 async get(value:FixedSessionContext,key:unknown,signal?:AbortSignal){const who=fixed(value),id=careerRecordId(key);return this.db.withBoundedTransaction(async client=>{await authorizeFixedSession(client,who,signal);const row=(await client.query('SELECT * FROM platform_upload_removals WHERE upload_id=$1 AND user_id=$2 FOR SHARE',[id,who.userId])).rows[0];if(!row)throw missing();const r=await this.decode(client,row);await authorizeFixedSession(client,who,signal);return this.public(r);});}
 async list(value:FixedSessionContext,input:unknown={},signal?:AbortSignal){
  const who=fixed(value);let after:string|null;try{const q=careerRecordObject(input,[],['after']);after=Object.hasOwn(q,'after')?careerRecordId(q.after):null;}catch{throw new ApiError(400,'UPLOAD_REMOVAL_INPUT_INVALID','请选择本人文件清理记录。');}
  return this.db.withBoundedTransaction(async client=>{await authorizeFixedSession(client,who,signal);if(after){const cursor=(await client.query('SELECT * FROM platform_upload_removals WHERE upload_id=$1 AND user_id=$2 FOR SHARE',[after,who.userId])).rows[0];if(!cursor)throw missing();await this.decode(client,cursor);}
   const rows=(await client.query('SELECT r.* FROM platform_upload_removals r WHERE r.user_id=$1 AND ($2::uuid IS NULL OR (r.requested_at,r.upload_id)<(SELECT c.requested_at,c.upload_id FROM platform_upload_removals c WHERE c.user_id=$1 AND c.upload_id=$2)) ORDER BY r.requested_at DESC,r.upload_id DESC LIMIT 51 FOR SHARE OF r',[who.userId,after])).rows,receipts=[];
   for(const row of rows.slice(0,50)){signal?.throwIfAborted();receipts.push(this.public(await this.decode(client,row)));}await authorizeFixedSession(client,who,signal);return {receipts:Object.freeze(receipts),nextAfter:rows.length>50?receipts.at(-1)!.uploadId:null};
  });
 }
 async request(value:FixedSessionContext,key:unknown,input:unknown,signal?:AbortSignal){
  const who=fixed(value);let id:string,operationId:string;try{id=careerRecordId(key);operationId=parseUploadRemovalCommand(input).operationId;}catch{throw new ApiError(400,'UPLOAD_REMOVAL_INPUT_INVALID','请选择本人文件并确认移除。');}this.configured();
  return this.db.withBoundedTransaction(async client=>{
   await authorizeFixedSession(client,who,signal);const user=(await client.query('SELECT auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[who.userId])).rows[0];if(!user)throw missing();
   const byOperation=(await client.query('SELECT upload_id FROM platform_upload_removals WHERE user_id=$1 AND operation_id=$2',[who.userId,operationId])).rows[0];if(byOperation&&byOperation.upload_id!==id)throw new ApiError(409,'UPLOAD_REMOVAL_OPERATION_CONFLICT','这个操作已用于另一份文件。');
   const prior=(await client.query('SELECT * FROM platform_upload_removals WHERE upload_id=$1 AND user_id=$2 FOR UPDATE',[id,who.userId])).rows[0];if(prior){const r=await this.decode(client,prior);await authorizeFixedSession(client,who,signal);return this.public(r);}
   const receipt=await this.enqueueFile(client,who.userId,id,operationId,String(user.auth_version));await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();return receipt;
  });
 }
 /** Internal part of the account-deletion transaction, not a public deletion
  * endpoint. The caller must complete every other deletion domain and remove
  * the account in this SAME transaction, rolling everything back on failure.
  * No storage I/O occurs here: committed journals survive the owner cascade.
  * A fresh password proof is consumed atomically with the file revocations. */
 async prepareAccountDeletion(client:PoolClient,value:FixedSessionContext,proof:string,signal?:AbortSignal):Promise<{queuedFiles:number}>{
  const who=fixed(value);this.configured();
  await new AccountReauthentication(this.db).consumeInTransaction(client,who,'account_delete',proof,signal);
  const user=(await client.query('SELECT auth_version FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[who.userId])).rows[0];if(!user)throw missing();
  // The owner lock is also taken by UploadWrites publication. A concurrent
  // publication either finishes before this inventory or fails after deletion.
  const files=(await client.query('SELECT id FROM platform_uploads WHERE user_id=$1 ORDER BY id FOR UPDATE',[who.userId])).rows;
  for(const file of files){
   signal?.throwIfAborted();
   // A live upload and an earlier revocation for the same id cannot coexist
   // legitimately. Never silently reuse a receipt for different stored bytes.
   if((await client.query('SELECT 1 FROM platform_upload_removals WHERE upload_id=$1',[file.id])).rowCount)throw unavailable();
   await this.enqueueFile(client,who.userId,file.id,randomUUID(),String(user.auth_version));
  }
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();return {queuedFiles:files.length};
 }
 private async enqueueFile(client:PoolClient,ownerId:string,id:string,operationId:string,authVersion:string){
  const file=(await client.query('SELECT storage_key,filename FROM platform_uploads WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,ownerId])).rows[0];if(!file)throw missing();if(typeof file.storage_key!=='string'||!(/^[A-Za-z0-9_-]{1,240}$/).test(file.storage_key))throw unavailable();
  const at=(await client.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();const r:Record={schemaVersion:1,ownerId,name:String(file.filename).replace(/[\x00-\x1f\x7f]/g,'').slice(0,200)||'文件',uploadId:id,operationId,status:'pending',requestedAt:at,removedAt:null,acceptedAuthVersion:authVersion,scope:this.storage.scope!,storageKey:file.storage_key,generation:1,lastEventId:randomUUID(),leaseToken:null,leaseUntil:null};
  await this.save(client,r,at);await client.query('UPDATE platform_artifacts SET upload_id=NULL WHERE upload_id=$1 AND user_id=$2',[id,ownerId]);await client.query('DELETE FROM platform_uploads WHERE id=$1 AND user_id=$2',[id,ownerId]);return this.public(r);
 }
 /** Internal recovery can finish a previously authorized privacy deletion even
  * after its session or account is gone. It cannot enqueue a new request. */
 async cleanup(key:string,signal?:AbortSignal):Promise<void>{
  this.configured();careerRecordId(key);signal?.throwIfAborted();
  const claimed=await this.db.withBoundedTransaction(async client=>{
   const row=(await client.query('SELECT * FROM platform_upload_removals WHERE upload_id=$1 FOR UPDATE',[key])).rows[0];if(!row)return null;const r=await this.decode(client,row);if(r.status==='removed'){await this.purgeDeletedOwnerReceipt(client,r);return null;}if(r.scope!==this.storage.scope)return null;
   const clock=(await client.query("SELECT clock_timestamp() at,clock_timestamp()+interval '30 seconds' until")).rows[0];if(r.leaseUntil&&r.leaseUntil>clock.at.toISOString())return null;
   if(r.generation>=2147483647)throw unavailable();const claimed:Record={...r,generation:r.generation+1,lastEventId:randomUUID(),leaseToken:randomUUID(),leaseUntil:clock.until.toISOString()};await this.save(client,claimed,clock.at.toISOString());return claimed;
  });if(!claimed)return;
  const timeout=AbortSignal.timeout(5000),ioSignal=signal?AbortSignal.any([signal,timeout]):timeout;let gone=false;
  try{await this.storage.delete(claimed.storageKey,ioSignal);try{await this.storage.stat(claimed.storageKey,ioSignal);}catch(e){if(e instanceof ApiError&&e.code==='STORAGE_NOT_FOUND'&&!ioSignal.aborted)gone=true;else throw e;}}catch{/* The committed revocation remains; actual retry is driven by the durable lease. */}
  if(!gone)return;
  await this.db.withBoundedTransaction(async client=>{
   const row=(await client.query('SELECT * FROM platform_upload_removals WHERE upload_id=$1 FOR UPDATE',[key])).rows[0];if(!row)return;const r=await this.decode(client,row),at=(await client.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
   if(r.status!=='pending'||r.leaseToken!==claimed.leaseToken||r.generation!==claimed.generation||r.leaseUntil===null||r.leaseUntil<=at)return;if(r.generation>=2147483647)throw unavailable();
   const removed:Record={...r,status:'removed',removedAt:at,generation:r.generation+1,lastEventId:randomUUID(),leaseToken:null,leaseUntil:null};
   await this.save(client,removed,at);await this.purgeDeletedOwnerReceipt(client,removed);
  });
 }
 async recover(signal?:AbortSignal){
  this.configured();
  // Separate bounded batches: pending records for an offline storage scope must
  // not occupy every slot and indefinitely retain completed orphan receipts.
  for(const status of ['removed','pending']){
   signal?.throwIfAborted();
   const rows=(await this.db.query(`SELECT r.upload_id FROM platform_upload_removals r WHERE r.status=$1
    AND (($1='pending' AND (r.lease_until IS NULL OR r.lease_until<=clock_timestamp()))
      OR ($1='removed' AND NOT EXISTS(SELECT 1 FROM platform_users u WHERE u.id=r.user_id)))
    ORDER BY r.requested_at,r.upload_id LIMIT 20`,[status])).rows;
   for(const row of rows){signal?.throwIfAborted();await this.cleanup(row.upload_id,signal);}
  }
 }
}
