import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import { careerRecordObject,mentorServiceInteger,mentorServiceTime,externalPaymentRef,type MentorPaymentCommand,type MentorOrder } from '@companion/platform-contracts';
import { MentorLedgerCrypto,mentorLedgerDigest as digest } from './mentor-ledger-crypto.ts';
interface FinancialRow {id:string;revision:number;retention_until:Date;payload_ciphertext:Buffer;}
import { ApiError } from './errors.ts';
/** Purpose-limited retained record, with no person/org/file/actor IDs or intent/owner content. */
export class MentorFinancialLedger {
 private readonly crypto:MentorLedgerCrypto;
 constructor(config:Pick<PlatformConfig,'dataCrypto'>){this.crypto=new MentorLedgerCrypto(config);}
 private async decode(c:PoolClient,row:FinancialRow){
  try{
   const v=careerRecordObject(this.crypto.open('mentor_financial',row.id,row.id,row.revision,row.payload_ciphertext),
    ['revision','priceCents','refundedCents','currency','paymentRef','handoffCode','paidAt','updatedAt','status','retentionUntil']);
   const priceCents=mentorServiceInteger(v.priceCents,1),refundedCents=mentorServiceInteger(v.refundedCents,0,priceCents);
   if(v.revision!==row.revision||v.currency!=='USD'||v.retentionUntil!==row.retention_until.toISOString()||typeof v.handoffCode!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(v.handoffCode)||
    !['paid','refunded_partial','refunded_full'].includes(v.status as string)||v.status!==(refundedCents===0?'paid':refundedCents===priceCents?'refunded_full':'refunded_partial'))throw Error();
   externalPaymentRef(v.paymentRef);const paidAt=mentorServiceTime(v.paidAt),updatedAt=mentorServiceTime(v.updatedAt);if(paidAt>updatedAt||updatedAt>=mentorServiceTime(v.retentionUntil))throw Error();
   const latest=(await c.query('SELECT * FROM platform_mentor_financial_proofs WHERE record_id=$1 ORDER BY revision DESC LIMIT 1 FOR SHARE',[row.id])).rows[0];
   if(!latest||latest.record_id!==row.id||latest.revision!==row.revision)throw Error();
   const proof=careerRecordObject(this.crypto.open('mentor_financial_proof',row.id,row.id,row.revision,latest.proof_ciphertext),['digest','action','externalRefHash']);if(proof.digest!==digest(v)||proof.action!==latest.action||proof.externalRefHash!==latest.external_ref_hash)throw Error();return v;
  }catch{throw new ApiError(503,'MENTOR_FINANCE_STORAGE_UNAVAILABLE','暂时无法确认账务记录。');}
 }
 async recordInTransaction(c:PoolClient,order:MentorOrder,retentionDays:number,command:MentorPaymentCommand){
  if(!order.payment||!order.paymentRef||!order.handoffCode)throw Error('Actual settlement required');
  const row=(await c.query('SELECT * FROM platform_mentor_financial_records WHERE id=$1 FOR UPDATE',[order.id])).rows[0],old=row?await this.decode(c,row):null;
  if(old&&(old.paymentRef!==order.paymentRef||old.handoffCode!==order.handoffCode||old.priceCents!==order.priceCents||old.paidAt!==order.payment.paidAt||
   (old.refundedCents as number)>=order.payment.refundedCents))throw new ApiError(503,'MENTOR_FINANCE_STORAGE_UNAVAILABLE','暂时无法确认账务记录。');
  const expiry=new Date(Date.parse(order.updatedAt)+retentionDays*86400000).toISOString(),retentionUntil=old&&(old.retentionUntil as string)>expiry?old.retentionUntil as string:expiry;
  const revision=old?row.revision+1:1,value={revision,priceCents:order.priceCents,refundedCents:order.payment.refundedCents,currency:order.currency,
   paymentRef:order.paymentRef,handoffCode:order.handoffCode,paidAt:order.payment.paidAt,updatedAt:order.updatedAt,status:order.status,retentionUntil};
  const externalRefHash=createHash('sha256').update(command.externalRef).digest('hex');
  await c.query('INSERT INTO platform_mentor_financial_proofs(record_id,revision,action,external_ref_hash,proof_ciphertext) VALUES($1,$2,$3,$4,$5)',
   [order.id,revision,command.action,externalRefHash,this.crypto.seal('mentor_financial_proof',order.id,order.id,revision,{digest:digest(value),action:command.action,externalRefHash})]);
  await c.query(`INSERT INTO platform_mentor_financial_records(id,revision,retention_until,payload_ciphertext) VALUES($1,$2,$3,$4)
   ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,retention_until=EXCLUDED.retention_until,payload_ciphertext=EXCLUDED.payload_ciphertext`,
   [order.id,revision,retentionUntil,this.crypto.seal('mentor_financial',order.id,order.id,revision,value)]);
 }
 async verifyInTransaction(c:PoolClient,order:MentorOrder){
  const row=(await c.query('SELECT * FROM platform_mentor_financial_records WHERE id=$1 FOR SHARE',[order.id])).rows[0];
  if(!row)throw new ApiError(503,'MENTOR_FINANCE_STORAGE_UNAVAILABLE','暂时无法确认账务记录。');const v=await this.decode(c,row);
  if(v.priceCents!==order.priceCents||v.paymentRef!==order.paymentRef||v.handoffCode!==order.handoffCode||v.refundedCents!==order.payment?.refundedCents||v.status!==order.status||v.updatedAt!==order.updatedAt)throw new ApiError(503,'MENTOR_FINANCE_STORAGE_UNAVAILABLE','暂时无法确认账务记录。');
 }
 /** Only for an existing, already validated owner order. Detached retention rows
  * must never be recovered by payment reference or attribution code. */
 async historyInTransaction(c:PoolClient,order:MentorOrder,commands:readonly Readonly<MentorPaymentCommand>[]){
  try{
   if(!order.payment||commands.length!==order.revision-1)throw Error();
   await this.verifyInTransaction(c,order);
   const row=(await c.query('SELECT * FROM platform_mentor_financial_records WHERE id=$1 FOR SHARE',[order.id])).rows[0];
   if(!row||row.id!==order.id||row.revision!==commands.length)throw Error();
   const v=await this.decode(c,row),proofs=(await c.query('SELECT * FROM platform_mentor_financial_proofs WHERE record_id=$1 ORDER BY revision FOR SHARE',[order.id])).rows;
   if(proofs.length!==commands.length||v.paidAt!==order.payment.paidAt)throw Error();
   const operations=proofs.map((p,i)=>{
    const command=commands[i],revision=i+1;
    const value=careerRecordObject(this.crypto.open('mentor_financial_proof',order.id,order.id,revision,p.proof_ciphertext),['digest','action','externalRefHash']);
    if(p.record_id!==order.id||p.revision!==revision||p.action!==command.action||value.action!==p.action||value.externalRefHash!==p.external_ref_hash||
     p.external_ref_hash!==createHash('sha256').update(command.externalRef).digest('hex')||typeof value.digest!=='string'||!/^[0-9a-f]{64}$/.test(value.digest))throw Error();
    return {recordId:order.id,revision,action:command.action,orderOperationId:command.operationId};
   });
   return {record:{id:order.id,revision:row.revision,priceCents:v.priceCents,refundedCents:v.refundedCents,currency:v.currency,paymentRef:v.paymentRef,
    paidAt:v.paidAt,updatedAt:v.updatedAt,status:v.status,retentionUntil:v.retentionUntil},operations};
  }catch{throw new ApiError(503,'MENTOR_FINANCE_STORAGE_UNAVAILABLE','暂时无法确认账务记录。');}
 }
 async purgeExpired(db:Database,signal?:AbortSignal){
  return db.withBoundedTransaction(async c=>{
   const rows=(await c.query('SELECT * FROM platform_mentor_financial_records f WHERE retention_until<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM platform_mentor_orders o WHERE o.id=f.id) ORDER BY retention_until,id LIMIT 100 FOR UPDATE SKIP LOCKED')).rows;
   for(const row of rows){signal?.throwIfAborted();await this.decode(c,row);
    await c.query('DELETE FROM platform_mentor_financial_records WHERE id=$1',[row.id]);
   }signal?.throwIfAborted();return {examined:rows.length};
  });
 }
}
