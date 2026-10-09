import {createHash} from 'node:crypto';
import {careerRecordId,careerRecordObject,careerLibraryTime,parseUploadRemovalReceipt,type UploadRemovalReceipt} from '@companion/platform-contracts';
import type {DataCrypto} from './data-crypto.ts';
import {ApiError} from './errors.ts';
const writeUnavailable=()=>new ApiError(503,'UPLOAD_WRITE_UNAVAILABLE','文件保存状态暂时无法确认，请重新查看文件列表。');
const removalUnavailable=()=>new ApiError(503,'UPLOAD_REMOVAL_UNAVAILABLE','文件清理状态暂时无法确认，请重新查看。');
const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
/** Historical integrity only. These decoders neither authorize, access storage,
 * retry writes nor grant deletion; callers supply the owner transaction. */
export interface UploadWriteRecord {
 schemaVersion:1;id:string;ownerId:string;storageKey:string;scope:string;writerToken:string;
 status:'writing'|'ready'|'cleanup';writerFinished:boolean;revision:number;lastEventId:string;
 publishUntil:string;leaseToken:string|null;leaseUntil:string|null;
}
export interface UploadRemovalRecord extends UploadRemovalReceipt {schemaVersion:1;ownerId:string;acceptedAuthVersion:string;scope:string;storageKey:string;generation:number;lastEventId:string;leaseToken:string|null;leaseUntil:string|null;}
export function decodeUploadWriteRecord(crypto:DataCrypto|undefined,row:any,event:any,id:string):UploadWriteRecord{
  try{
   const raw=crypto!.openUtf8(row.record_ciphertext,{table:'platform_upload_writes',column:'record_ciphertext',rowId:id,ownerId:row.user_id,revision:row.revision});
   const r=careerRecordObject(JSON.parse(raw),['schemaVersion','id','ownerId','storageKey','scope','writerToken','status','writerFinished','revision','lastEventId','publishUntil','leaseToken','leaseUntil']) as unknown as UploadWriteRecord;
   if(canonical(r)!==raw||r.schemaVersion!==1||r.id!==id||r.ownerId!==row.user_id||r.status!==row.status||r.revision!==row.revision||r.lastEventId!==row.last_event_id
    ||r.publishUntil!==row.publish_until.toISOString()||r.leaseUntil!==(row.lease_until?.toISOString()??null)||!Number.isSafeInteger(r.revision)||r.revision<1
    ||!['writing','ready','cleanup'].includes(r.status)||typeof r.writerFinished!=='boolean'||r.status==='ready'&&!r.writerFinished
    ||!/^blob_scope_[0-9a-f]{64}$/.test(r.scope)||(r.leaseToken===null)!==(r.leaseUntil===null))throw writeUnavailable();
   for(const v of [r.id,r.ownerId,r.storageKey,r.writerToken,r.lastEventId])careerRecordId(v);if(r.leaseToken!==null)careerRecordId(r.leaseToken);
   if(!event||event.write_id!==r.id||event.id!==r.lastEventId||event.revision!==r.revision||decodeUploadWriteEvent(crypto,event,r.ownerId).recordDigest!==digest(r))throw writeUnavailable();
   return r;
  }catch{throw writeUnavailable();}

}
export function decodeUploadRemovalRecord(crypto:DataCrypto|undefined,row:any,event:any):UploadRemovalRecord{
  try{
   const raw=crypto!.openUtf8(row.record_ciphertext,{table:'platform_upload_removals',column:'record_ciphertext',rowId:row.upload_id,ownerId:row.user_id,revision:row.generation});
   const v=careerRecordObject(JSON.parse(raw),['schemaVersion','ownerId','name','uploadId','operationId','status','requestedAt','removedAt','acceptedAuthVersion','scope','storageKey','generation','lastEventId','leaseToken','leaseUntil']),receipt=parseUploadRemovalReceipt(Object.fromEntries(['ownerId','name','uploadId','operationId','status','requestedAt','removedAt'].map(k=>[k,v[k]])));
   if(canonical(v)!==raw||v.schemaVersion!==1||v.ownerId!==row.user_id||receipt.uploadId!==row.upload_id||receipt.operationId!==row.operation_id||receipt.status!==row.status||v.generation!==row.generation||v.lastEventId!==row.last_event_id||receipt.requestedAt!==row.requested_at.toISOString()||receipt.removedAt!==(row.removed_at?.toISOString()??null)||v.leaseUntil!==(row.lease_until?.toISOString()??null)||typeof v.acceptedAuthVersion!=='string'||!/^(0|[1-9][0-9]*)$/.test(v.acceptedAuthVersion)||typeof v.scope!=='string'||!/^blob_scope_[0-9a-f]{64}$/.test(v.scope)||typeof v.storageKey!=='string'||!(/^[A-Za-z0-9_-]{1,240}$/).test(v.storageKey)||!Number.isSafeInteger(v.generation)||Number(v.generation)<1)throw removalUnavailable();
   careerRecordId(v.ownerId);careerRecordId(v.lastEventId);if(v.leaseToken!==null)careerRecordId(v.leaseToken);if(v.leaseUntil!==null)careerLibraryTime(v.leaseUntil);if((v.leaseToken===null)!==(v.leaseUntil===null)||v.status==='removed'&&v.leaseToken!==null)throw removalUnavailable();
   if(!event||event.upload_id!==row.upload_id||event.user_id!==row.user_id||event.id!==v.lastEventId||event.generation!==v.generation)throw removalUnavailable();
   const e=decodeUploadRemovalEvent(crypto,event);if(e.recordDigest!==digest(v))throw removalUnavailable();
   return v as unknown as UploadRemovalRecord;
  }catch{throw removalUnavailable();}

}

export function decodeUploadWriteEvent(crypto:DataCrypto|undefined,row:any,ownerId:string){
 try{
  careerRecordId(ownerId);careerRecordId(row.write_id);careerRecordId(row.id);if(!Number.isSafeInteger(row.revision)||row.revision<1)throw Error();
  const recordDigest=crypto!.openUtf8(row.ciphertext,{table:'platform_upload_write_events',column:'ciphertext',rowId:row.id,ownerId,revision:row.revision});
  if(!/^[0-9a-f]{64}$/.test(recordDigest))throw Error();return {writeId:row.write_id as string,id:row.id as string,revision:row.revision as number,recordDigest};
 }catch{throw writeUnavailable();}
}
export function decodeUploadRemovalEvent(crypto:DataCrypto|undefined,row:any){
 try{
  careerRecordId(row.user_id);careerRecordId(row.upload_id);careerRecordId(row.id);if(!Number.isSafeInteger(row.generation)||row.generation<1)throw Error();
  const raw=crypto!.openUtf8(row.ciphertext,{table:'platform_upload_removal_events',column:'ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.generation}),v=careerRecordObject(JSON.parse(raw),['recordDigest','at']);
  if(canonical(v)!==raw||typeof v.recordDigest!=='string'||!/^[0-9a-f]{64}$/.test(v.recordDigest)||careerLibraryTime(v.at)!==row.created_at.toISOString())throw Error();
  return {uploadId:row.upload_id as string,ownerId:row.user_id as string,id:row.id as string,generation:row.generation as number,createdAt:v.at as string,recordDigest:v.recordDigest};
 }catch{throw removalUnavailable();}
}
