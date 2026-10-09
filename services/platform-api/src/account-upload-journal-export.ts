import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {decodeUploadWriteRecord,decodeUploadWriteEvent,decodeUploadRemovalRecord,decodeUploadRemovalEvent,type UploadWriteRecord,type UploadRemovalRecord} from './upload-journal-codec.ts';
import {ApiError} from './errors.ts';
export const UPLOAD_JOURNAL_EXPORT_TABLES=Object.freeze(['platform_upload_writes','platform_upload_write_events','platform_upload_removals','platform_upload_removal_events'] as const);
export type UploadJournalExportSection='uploadWrites'|'uploadWriteEvents'|'uploadRemovals'|'uploadRemovalEvents';
const unavailable=()=>new ApiError(503,'ACCOUNT_UPLOAD_JOURNAL_EXPORT_UNAVAILABLE','The saved file history could not be confirmed.');
/** Saved journal history only: no storage adapter, publication or cleanup. Old
 * events contain state digests, not recoverable past status/name snapshots. */
export class AccountUploadJournalExport {
 constructor(private readonly config:Pick<PlatformConfig,'dataCrypto'>){}
 async *exportInTransaction(c:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:UploadJournalExportSection;record:unknown}>{
  const v=object(value,['userId','tokenHash']);if(typeof v.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(v.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  const who=Object.freeze({userId:id(v.userId),tokenHash:v.tokenHash});await authorizeFixedSession(c,who,signal);
  try{
   const writes=new Map<string,{record:UploadWriteRecord;seen:number}>(),removals=new Map<string,{record:UploadRemovalRecord;seen:number}>();let after:string|null=null;
   for(;;){
    signal?.throwIfAborted();const rows:Record<string,any>[]=(await c.query(`SELECT id,user_id,status,revision,last_event_id,publish_until,lease_until,record_ciphertext FROM platform_upload_writes
     WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[who.userId,after])).rows;
    for(const row of rows){signal?.throwIfAborted();if(row.user_id!==who.userId||writes.has(row.id))throw unavailable();
     const latest=(await c.query('SELECT * FROM platform_upload_write_events WHERE write_id=$1 ORDER BY revision DESC LIMIT 1',[id(row.id)])).rows[0];
     const r=decodeUploadWriteRecord(this.config.dataCrypto,row,latest,row.id);writes.set(r.id,{record:r,seen:0});
     yield {section:'uploadWrites',record:{id:r.id,ownerId:r.ownerId,status:r.status,writerFinished:r.writerFinished,revision:r.revision,lastEventId:r.lastEventId,publishUntil:r.publishUntil}};
    }
    if(rows.length<100)break;after=id(rows.at(-1)!.id);
   }
   let cursor:readonly[string,number]|null=null;
   for(;;){
    signal?.throwIfAborted();const rows:Record<string,any>[]=(await c.query(`SELECT e.write_id,e.id,e.revision,e.ciphertext,w.user_id AS owner_id FROM platform_upload_write_events e
     JOIN platform_upload_writes w ON w.id=e.write_id WHERE w.user_id=$1 AND ($2::uuid IS NULL OR (e.write_id,e.revision)>($2::uuid,$3::integer))
     ORDER BY e.write_id,e.revision LIMIT 100`,[who.userId,cursor?.[0]??null,cursor?.[1]??null])).rows;
    for(const row of rows){signal?.throwIfAborted();const parent=writes.get(row.write_id);
     if(!parent||row.owner_id!==who.userId)throw unavailable();const e=decodeUploadWriteEvent(this.config.dataCrypto,row,who.userId);
     if(e.revision!==parent.seen+1||e.revision>parent.record.revision||e.revision===parent.record.revision&&e.id!==parent.record.lastEventId)throw unavailable();parent.seen++;
     yield {section:'uploadWriteEvents',record:{writeId:e.writeId,ownerId:who.userId,id:e.id,revision:e.revision}};
    }
    if(rows.length<100)break;cursor=[id(rows.at(-1)!.write_id),rows.at(-1)!.revision];
   }
   if([...writes.values()].some(p=>p.seen!==p.record.revision))throw unavailable();
   after=null;
   for(;;){
    signal?.throwIfAborted();const rows:Record<string,any>[]=(await c.query(`SELECT upload_id,user_id,operation_id,status,generation,last_event_id,lease_until,record_ciphertext,requested_at,removed_at FROM platform_upload_removals
     WHERE user_id=$1 AND ($2::uuid IS NULL OR upload_id>$2) ORDER BY upload_id LIMIT 100`,[who.userId,after])).rows;
    for(const row of rows){signal?.throwIfAborted();if(row.user_id!==who.userId||removals.has(row.upload_id))throw unavailable();
     const latest=(await c.query('SELECT * FROM platform_upload_removal_events WHERE upload_id=$1 ORDER BY generation DESC LIMIT 1',[id(row.upload_id)])).rows[0];
     const r=decodeUploadRemovalRecord(this.config.dataCrypto,row,latest);removals.set(r.uploadId,{record:r,seen:0});
     yield {section:'uploadRemovals',record:{ownerId:r.ownerId,name:r.name,uploadId:r.uploadId,operationId:r.operationId,status:r.status,requestedAt:r.requestedAt,removedAt:r.removedAt,generation:r.generation,lastEventId:r.lastEventId}};
    }
    if(rows.length<100)break;after=id(rows.at(-1)!.upload_id);
   }
   cursor=null;
   for(;;){
    signal?.throwIfAborted();const rows:Record<string,any>[]=(await c.query(`SELECT upload_id,user_id,id,generation,ciphertext,created_at FROM platform_upload_removal_events
     WHERE user_id=$1 AND ($2::uuid IS NULL OR (upload_id,generation)>($2::uuid,$3::integer)) ORDER BY upload_id,generation LIMIT 100`,[who.userId,cursor?.[0]??null,cursor?.[1]??null])).rows;
    for(const row of rows){signal?.throwIfAborted();const parent=removals.get(row.upload_id);if(!parent||row.user_id!==who.userId)throw unavailable();
     const e=decodeUploadRemovalEvent(this.config.dataCrypto,row);
     if(e.generation!==parent.seen+1||e.generation>parent.record.generation||e.generation===1&&e.createdAt!==parent.record.requestedAt||
      e.generation===parent.record.generation&&e.id!==parent.record.lastEventId)throw unavailable();parent.seen++;
     yield {section:'uploadRemovalEvents',record:{uploadId:e.uploadId,ownerId:e.ownerId,id:e.id,generation:e.generation,createdAt:e.createdAt}};
    }
    if(rows.length<100)break;cursor=[id(rows.at(-1)!.upload_id),rows.at(-1)!.generation];
   }
   if([...removals.values()].some(p=>p.seen!==p.record.generation))throw unavailable();
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
 }
}
