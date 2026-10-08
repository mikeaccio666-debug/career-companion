import { createHash,randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordId,careerRecordObject,careerLibraryTime,parseUploadRemovalCommand,parseUploadRemovalReceipt,type UploadRemovalReceipt } from '@companion/platform-contracts';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import type { DataCrypto } from './data-crypto.ts';
import type { BlobStorage } from './storage.ts';
import { ApiError } from './errors.ts';
const unavailable=()=>new ApiError(503,'UPLOAD_REMOVAL_UNAVAILABLE','文件清理状态暂时无法确认，请重新查看。');
const missing=()=>new ApiError(404,'NOT_FOUND','这份文件或清理记录不存在。');
const canonical=(value:unknown)=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
interface Record extends UploadRemovalReceipt {schemaVersion:1;ownerId:string;acceptedAuthVersion:string;scope:string;storageKey:string;generation:number;lastEventId:string;leaseToken:string|null;leaseUntil:string|null;}
function fixed(value:FixedSessionContext){try{const v=careerRecordObject(value,['userId','tokenHash']);if(typeof v.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(v.tokenHash))throw Error();return {userId:careerRecordId(v.userId),tokenHash:v.tokenHash};}catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}}
/** Durable file revocation and cleanup only. No model work, external-user
 * capability, fake completion, or replacement of saved text copies. */
export class UploadRemovals {
 constructor(private readonly db:Database,private readonly crypto:DataCrypto|undefined,private readonly storage:BlobStorage){}
 private configured(){if(!this.crypto||typeof this.storage.scope!=='string'||!/^blob_scope_[0-9a-f]{64}$/.test(this.storage.scope))throw unavailable();}
 private async decode(client:PoolClient,row:any):Promise<Record>{
  this.configured();try{
   const raw=this.crypto!.openUtf8(row.record_ciphertext,{table:'platform_upload_removals',column:'record_ciphertext',rowId:row.upload_id,ownerId:row.user_id,revision:row.generation});
   const v=careerRecordObject(JSON.parse(raw),['schemaVersion','ownerId','name','uploadId','operationId','status','requestedAt','removedAt','acceptedAuthVersion','scope','storageKey','generation','lastEventId','leaseToken','leaseUntil']),receipt=parseUploadRemovalReceipt(Object.fromEntries(['ownerId','name','uploadId','operationId','status','requestedAt','removedAt'].map(k=>[k,v[k]])));
   if(canonical(v)!==raw||v.schemaVersion!==1||v.ownerId!==row.user_id||receipt.uploadId!==row.upload_id||receipt.operationId!==row.operation_id||receipt.status!==row.status||v.generation!==row.generation||v.lastEventId!==row.last_event_id||receipt.requestedAt!==row.requested_at.toISOString()||receipt.removedAt!==(row.removed_at?.toISOString()??null)||v.leaseUntil!==(row.lease_until?.toISOString()??null)||typeof v.acceptedAuthVersion!=='string'||!/^(0|[1-9][0-9]*)$/.test(v.acceptedAuthVersion)||typeof v.scope!=='string'||!/^blob_scope_[0-9a-f]{64}$/.test(v.scope)||typeof v.storageKey!=='string'||!(/^[A-Za-z0-9_-]{1,240}$/).test(v.storageKey)||!Number.isSafeInteger(v.generation)||Number(v.generation)<1)throw unavailable();
   careerRecordId(v.ownerId);careerRecordId(v.lastEventId);if(v.leaseToken!==null)careerRecordId(v.leaseToken);if(v.leaseUntil!==null)careerLibraryTime(v.leaseUntil);if((v.leaseToken===null)!==(v.leaseUntil===null)||v.status==='removed'&&v.leaseToken!==null)throw unavailable();
   const event=(await client.query('SELECT * FROM platform_upload_removal_events WHERE upload_id=$1 ORDER BY generation DESC LIMIT 1 FOR SHARE',[row.upload_id])).rows[0];if(!event||event.user_id!==row.user_id||event.id!==v.lastEventId||event.generation!==v.generation)throw unavailable();
   const text=this.crypto!.openUtf8(event.ciphertext,{table:'platform_upload_removal_events',column:'ciphertext',rowId:event.id,ownerId:row.user_id,revision:row.generation}),e=careerRecordObject(JSON.parse(text),['recordDigest','at']);if(canonical(e)!==text||e.recordDigest!==hash(v)||e.at!==event.created_at.toISOString())throw unavailable();
   return v as unknown as Record;
  }catch{throw unavailable();}
 }
 private async save(client:PoolClient,r:Record,at:string){
  const cipher=this.crypto!.sealUtf8(canonical(r),{table:'platform_upload_removals',column:'record_ciphertext',rowId:r.uploadId,ownerId:r.ownerId,revision:r.generation});
  await client.query('INSERT INTO platform_upload_removals(upload_id,user_id,operation_id,status,generation,last_event_id,lease_until,record_ciphertext,requested_at,removed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(upload_id) DO UPDATE SET status=EXCLUDED.status,generation=EXCLUDED.generation,last_event_id=EXCLUDED.last_event_id,lease_until=EXCLUDED.lease_until,record_ciphertext=EXCLUDED.record_ciphertext,removed_at=EXCLUDED.removed_at',[r.uploadId,r.ownerId,r.operationId,r.status,r.generation,r.lastEventId,r.leaseUntil,cipher,r.requestedAt,r.removedAt]);
  const event=this.crypto!.sealUtf8(canonical({recordDigest:hash(r),at}),{table:'platform_upload_removal_events',column:'ciphertext',rowId:r.lastEventId,ownerId:r.ownerId,revision:r.generation});
  await client.query('INSERT INTO platform_upload_removal_events(upload_id,user_id,id,generation,ciphertext,created_at) VALUES($1,$2,$3,$4,$5,$6)',[r.uploadId,r.ownerId,r.lastEventId,r.generation,event,at]);
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
   const file=(await client.query('SELECT storage_key,filename FROM platform_uploads WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,who.userId])).rows[0];if(!file)throw missing();if(typeof file.storage_key!=='string'||!(/^[A-Za-z0-9_-]{1,240}$/).test(file.storage_key))throw unavailable();
   const at=(await client.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();const r:Record={schemaVersion:1,ownerId:who.userId,name:String(file.filename).replace(/[\x00-\x1f\x7f]/g,'').slice(0,200)||'文件',uploadId:id,operationId,status:'pending',requestedAt:at,removedAt:null,acceptedAuthVersion:String(user.auth_version),scope:this.storage.scope!,storageKey:file.storage_key,generation:1,lastEventId:randomUUID(),leaseToken:null,leaseUntil:null};
   await this.save(client,r,at);await client.query('UPDATE platform_artifacts SET upload_id=NULL WHERE upload_id=$1 AND user_id=$2',[id,who.userId]);await client.query('DELETE FROM platform_uploads WHERE id=$1 AND user_id=$2',[id,who.userId]);await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();return this.public(r);
  });
 }
 /** Internal recovery can finish a previously authorized privacy deletion even
  * after its session or account is gone. It cannot enqueue a new request. */
 async cleanup(key:string,signal?:AbortSignal):Promise<void>{
  this.configured();careerRecordId(key);signal?.throwIfAborted();
  const claimed=await this.db.withBoundedTransaction(async client=>{
   const row=(await client.query('SELECT * FROM platform_upload_removals WHERE upload_id=$1 FOR UPDATE',[key])).rows[0];if(!row)return null;const r=await this.decode(client,row);if(r.status==='removed'||r.scope!==this.storage.scope)return null;
   const clock=(await client.query("SELECT clock_timestamp() at,clock_timestamp()+interval '30 seconds' until")).rows[0];if(r.leaseUntil&&r.leaseUntil>clock.at.toISOString())return null;
   if(r.generation>=2147483647)throw unavailable();const claimed:Record={...r,generation:r.generation+1,lastEventId:randomUUID(),leaseToken:randomUUID(),leaseUntil:clock.until.toISOString()};await this.save(client,claimed,clock.at.toISOString());return claimed;
  });if(!claimed)return;
  const timeout=AbortSignal.timeout(5000),ioSignal=signal?AbortSignal.any([signal,timeout]):timeout;let gone=false;
  try{await this.storage.delete(claimed.storageKey,ioSignal);try{await this.storage.stat(claimed.storageKey,ioSignal);}catch(e){if(e instanceof ApiError&&e.code==='STORAGE_NOT_FOUND'&&!ioSignal.aborted)gone=true;else throw e;}}catch{/* The committed revocation remains; actual retry is driven by the durable lease. */}
  if(!gone)return;
  await this.db.withBoundedTransaction(async client=>{
   const row=(await client.query('SELECT * FROM platform_upload_removals WHERE upload_id=$1 FOR UPDATE',[key])).rows[0];if(!row)return;const r=await this.decode(client,row),at=(await client.query('SELECT clock_timestamp() at')).rows[0].at.toISOString();
   if(r.status!=='pending'||r.leaseToken!==claimed.leaseToken||r.generation!==claimed.generation||r.leaseUntil===null||r.leaseUntil<=at)return;if(r.generation>=2147483647)throw unavailable();
   await this.save(client,{...r,status:'removed',removedAt:at,generation:r.generation+1,lastEventId:randomUUID(),leaseToken:null,leaseUntil:null},at);
  });
 }
 async recover(signal?:AbortSignal){this.configured();const rows=(await this.db.query("SELECT upload_id FROM platform_upload_removals WHERE status='pending' AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY requested_at LIMIT 20")).rows;for(const row of rows){signal?.throwIfAborted();await this.cleanup(row.upload_id,signal);}}
}
