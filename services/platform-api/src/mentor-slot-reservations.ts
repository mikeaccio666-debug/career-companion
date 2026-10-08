import type { PoolClient } from 'pg';
import { careerRecordId,careerRecordObject,mentorServiceInteger,mentorServiceTime,type MentorIntent } from '@companion/platform-contracts';
import type { PlatformConfig } from './config.ts';
import type { FixedSessionContext } from './auth.ts';
import { authorizeMentorStaffSource } from './mentor-staff-source.ts';
import { MentorLedgerCrypto,mentorLedgerDigest as digest } from './mentor-ledger-crypto.ts';
import { ApiError } from './errors.ts';
interface Reservation {sessionId:string;ownerId:string;orgId:string;mentorId:string;slotId:string;slotRevision:number;startsAt:string;endsAt:string;
 status:'held'|'released';revision:number;lastOperationId:string;updatedAt:string;}
interface Row {session_id:string;user_id:string;org_id:string;mentor_id:string;slot_id:string;slot_revision:number;starts_at:Date;ends_at:Date;
 status:string;revision:number;last_operation_id:string;updated_at:Date;payload_ciphertext:Buffer;}
const unavailable=()=>new ApiError(503,'MENTOR_RESERVATION_STORAGE_UNAVAILABLE','暂时无法确认真人预约时段。');
/** Internal transaction ledger. Holds survive profile edits; they are not inferred from a current source directory. */
export class MentorSlotReservations {
 private readonly crypto:MentorLedgerCrypto;
 constructor(config:Pick<PlatformConfig,'dataCrypto'>){this.crypto=new MentorLedgerCrypto(config);}
 private parse(input:unknown):Reservation{
  const v=careerRecordObject(input,['sessionId','ownerId','orgId','mentorId','slotId','slotRevision','startsAt','endsAt','status','revision','lastOperationId','updatedAt']);
  const revision=mentorServiceInteger(v.revision,1,2),startsAt=mentorServiceTime(v.startsAt),endsAt=mentorServiceTime(v.endsAt);
  if(startsAt>=endsAt||!['held','released'].includes(v.status as string)||v.status==='held'&&revision!==1||v.status==='released'&&revision!==2)throw unavailable();
  return {sessionId:careerRecordId(v.sessionId),ownerId:careerRecordId(v.ownerId),orgId:careerRecordId(v.orgId),mentorId:careerRecordId(v.mentorId),
   slotId:careerRecordId(v.slotId),slotRevision:mentorServiceInteger(v.slotRevision,1),startsAt,endsAt,status:v.status as Reservation['status'],revision,
   lastOperationId:careerRecordId(v.lastOperationId),updatedAt:mentorServiceTime(v.updatedAt)};
 }
 private async decode(c:PoolClient,row:Row):Promise<Readonly<Reservation>>{
  try{
   const r=this.parse(this.crypto.open('mentor_reservation',row.session_id,row.user_id,row.revision,row.payload_ciphertext));
   if(r.sessionId!==row.session_id||r.ownerId!==row.user_id||r.orgId!==row.org_id||r.mentorId!==row.mentor_id||r.slotId!==row.slot_id||r.slotRevision!==row.slot_revision||
    r.startsAt!==row.starts_at.toISOString()||r.endsAt!==row.ends_at.toISOString()||r.status!==row.status||r.revision!==row.revision||
    r.lastOperationId!==row.last_operation_id||r.updatedAt!==row.updated_at.toISOString())throw Error();
   const latest=(await c.query('SELECT * FROM platform_mentor_reservation_proofs WHERE session_id=$1 ORDER BY revision DESC LIMIT 1 FOR SHARE',[r.sessionId])).rows[0];
   if(!latest||latest.revision!==r.revision||latest.user_id!==r.ownerId||latest.org_id!==r.orgId||latest.operation_id!==r.lastOperationId||latest.created_at.toISOString()!==r.updatedAt)throw Error();
   const p=careerRecordObject(this.crypto.open('mentor_reservation_proof',r.sessionId,r.ownerId,r.revision,latest.proof_ciphertext),
    ['sessionId','ownerId','orgId','revision','operationId','createdAt','digest']);
   if(p.sessionId!==r.sessionId||p.ownerId!==r.ownerId||p.orgId!==r.orgId||p.revision!==r.revision||p.operationId!==r.lastOperationId||p.createdAt!==r.updatedAt||p.digest!==digest(r))throw Error();
   return Object.freeze(r);
  }catch{throw unavailable();}
 }
 async overlapInTransaction(c:PoolClient,mentorId:string,startsAt:string,endsAt:string,signal?:AbortSignal){
  const rows=(await c.query<Row>('SELECT * FROM platform_mentor_slot_reservations WHERE mentor_id=$1 ORDER BY session_id',[mentorId])).rows;
  let overlap=false;for(const row of rows){signal?.throwIfAborted();const r=await this.decode(c,row);if(r.status==='held'&&r.startsAt<endsAt&&r.endsAt>startsAt)overlap=true;}return overlap;
 }
 async holdInTransaction(c:PoolClient,actor:FixedSessionContext,record:MentorIntent,source:{slotId:string;slotRevision:number;startsAt:string;endsAt:string},signal?:AbortSignal){
  await authorizeMentorStaffSource(c,actor,record.organizationId,signal);
  if(record.status!=='matched'||!record.mentorId||!record.assignment||source.slotId!==record.assignment.slotId||source.slotRevision!==record.assignment.slotRevision||
   source.startsAt!==record.assignment.startsAt||source.endsAt<record.assignment.endsAt)throw unavailable();
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mentor_capacity:'+record.mentorId]);
  if(await this.overlapInTransaction(c,record.mentorId,source.startsAt,source.endsAt,signal))throw new ApiError(409,'MENTOR_SLOT_RESERVED','这个时段已有预约，请重新核对。');
  const r:Reservation={sessionId:record.id,ownerId:record.ownerId,orgId:record.organizationId,mentorId:record.mentorId,...source,status:'held',revision:1,
   lastOperationId:record.lastOperationId,updatedAt:record.updatedAt};
  await this.write(c,r,false);signal?.throwIfAborted();return Object.freeze(r);
 }
 async releaseInTransaction(c:PoolClient,record:MentorIntent,signal?:AbortSignal){
  if(record.status!=='cancelled'||!record.assignment||!record.mentorId)throw unavailable();
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mentor_capacity:'+record.mentorId]);
  const current=await this.readInTransaction(c,record.ownerId,record.id);
  if(current.status!=='held'||current.mentorId!==record.mentorId||current.slotId!==record.assignment.slotId||current.slotRevision!==record.assignment.slotRevision)throw unavailable();
  const r:Reservation={...current,status:'released',revision:2,lastOperationId:record.lastOperationId,updatedAt:record.updatedAt};
  await this.write(c,r,true);signal?.throwIfAborted();return Object.freeze(r);
 }
 async readInTransaction(c:PoolClient,owner:string,id:string){
  const row=(await c.query<Row>('SELECT * FROM platform_mentor_slot_reservations WHERE user_id=$1 AND session_id=$2',[owner,id])).rows[0];
  if(!row)throw unavailable();return this.decode(c,row);
 }
 private async write(c:PoolClient,r:Reservation,update:boolean){
  const proof={sessionId:r.sessionId,ownerId:r.ownerId,orgId:r.orgId,revision:r.revision,operationId:r.lastOperationId,createdAt:r.updatedAt,digest:digest(r)};
  await c.query('INSERT INTO platform_mentor_reservation_proofs(session_id,user_id,org_id,revision,operation_id,created_at,proof_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)',
   [r.sessionId,r.ownerId,r.orgId,r.revision,r.lastOperationId,r.updatedAt,this.crypto.seal('mentor_reservation_proof',r.sessionId,r.ownerId,r.revision,proof)]);
  const cipher=this.crypto.seal('mentor_reservation',r.sessionId,r.ownerId,r.revision,r);
  if(update){const result=await c.query("UPDATE platform_mentor_slot_reservations SET status='released',revision=2,last_operation_id=$3,updated_at=$4,payload_ciphertext=$5 WHERE session_id=$1 AND user_id=$2 AND revision=1 AND status='held'",[r.sessionId,r.ownerId,r.lastOperationId,r.updatedAt,cipher]);if(result.rowCount!==1)throw unavailable();}
  else await c.query(`INSERT INTO platform_mentor_slot_reservations(session_id,user_id,org_id,mentor_id,slot_id,slot_revision,starts_at,ends_at,status,revision,last_operation_id,updated_at,payload_ciphertext)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[r.sessionId,r.ownerId,r.orgId,r.mentorId,r.slotId,r.slotRevision,r.startsAt,r.endsAt,r.status,r.revision,r.lastOperationId,r.updatedAt,cipher]);
 }
}
