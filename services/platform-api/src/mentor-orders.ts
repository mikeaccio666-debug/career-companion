import { parseMentorReceiptEvidence,type MentorReceiptEvidence } from './mentor-receipt-evidence.ts';
import { MentorFinancialLedger } from './mentor-financial-ledger.ts';
import { randomBytes,createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordObject,parseMentorOrder,parseMentorPaymentCommand,mentorServiceInteger,type MentorPaymentCommand,type MentorOrder,type MentorIntent,type MentorServiceOffer } from '@companion/platform-contracts';
import type { PlatformConfig } from './config.ts';
import type { FixedSessionContext } from './auth.ts';
import { authorizeMentorStaffSource } from './mentor-staff-source.ts';
import { MentorLedgerCrypto,mentorLedgerDigest as digest } from './mentor-ledger-crypto.ts';
import { ApiError } from './errors.ts';
const unavailable=()=>new ApiError(503,'MENTOR_ORDER_STORAGE_UNAVAILABLE','暂时无法确认真人预约订单。');
const handoffHash=(v:string|null)=>v===null?null:createHash('sha256').update(v).digest('hex');
/** Internal quote ledger; the owned intent/receipt reader authorizes public access.
 * No payment confirmation, link, CRM export or handoff lookup is exposed here. */
export class MentorOrders {
 private readonly crypto:MentorLedgerCrypto;private readonly financial:MentorFinancialLedger;
 constructor(config:Pick<PlatformConfig,'dataCrypto'>){this.crypto=new MentorLedgerCrypto(config);this.financial=new MentorFinancialLedger(config);}
 async readInTransaction(c:PoolClient,owner:string,id:string,quoteOperationId?:string):Promise<Readonly<MentorOrder>>{
  try{
   const row=(await c.query('SELECT * FROM platform_mentor_orders WHERE id=$1 AND user_id=$2 FOR SHARE',[id,owner])).rows[0];if(!row)throw Error();
   const r=parseMentorOrder(this.crypto.open('mentor_order',row.id,row.user_id,row.revision,row.payload_ciphertext));
   if(r.id!==row.id||r.ownerId!==row.user_id||r.sessionId!==row.session_id||r.organizationId!==row.org_id||r.offerId!==row.offer_id||r.offerRevision!==row.offer_revision||
    r.priceCents!==row.price_cents||r.currency!==row.currency||r.status!==row.status||r.origin!==row.origin||r.suggestionId!==row.suggestion_id||r.paymentRef!==row.payment_ref||
    r.revision!==row.revision||r.lastOperationId!==row.last_operation_id||r.createdAt!==row.created_at.toISOString()||r.updatedAt!==row.updated_at.toISOString()||handoffHash(r.handoffCode)!==row.handoff_code_hash||handoffHash(r.paymentRef)!==(row.payment_ref_hash??null))throw Error();
   const rows=(await c.query('SELECT * FROM platform_mentor_order_proofs WHERE order_id=$1 ORDER BY revision FOR SHARE',[r.id])).rows;
   if(rows.length!==r.revision)throw Error();
   const accepted:MentorPaymentCommand[]=[];
   for(let i=0;i<rows.length;i++){
    const proof=rows[i];if(proof.revision!==i+1||proof.user_id!==r.ownerId||proof.org_id!==r.organizationId)throw Error();
    const v=careerRecordObject(this.crypto.open('mentor_order_proof',r.id,r.ownerId,proof.revision,proof.proof_ciphertext),
     ['orderId','sessionId','ownerId','orgId','revision','operationId','createdAt','digest'],['finance']);
    if(v.orderId!==r.id||v.sessionId!==r.sessionId||v.ownerId!==r.ownerId||v.orgId!==r.organizationId||v.revision!==proof.revision||
     v.operationId!==proof.operation_id||v.createdAt!==proof.created_at.toISOString()||typeof v.digest!=='string'||!/^[0-9a-f]{64}$/.test(v.digest))throw Error();
    if(i===0&&(v.createdAt!==r.createdAt||quoteOperationId!==undefined&&v.operationId!==quoteOperationId)||i===rows.length-1&&(v.digest!==digest(r)||v.operationId!==r.lastOperationId||v.createdAt!==r.updatedAt))throw Error();
    if(proof.action!==null&&proof.action!==undefined){
     const cmd=this.financeProof(proof,v);accepted.push(cmd);
     if(i===0||cmd.expectedRevision!==i||cmd.sessionId!==r.sessionId||cmd.occurredAt>(v.createdAt as string)||cmd.occurredAt<r.createdAt||
      cmd.action==='pay'&&(i!==1||cmd.amountCents!==r.priceCents)||cmd.action==='refund'&&(i<2||cmd.occurredAt<accepted[0].occurredAt))throw Error();
    }else if(v.finance!==undefined||i>1||i===1&&r.status!=='void')throw Error();
   }
   if(r.payment){
    const paid=accepted[0],total=accepted.slice(1).reduce((n,x)=>n+x.amountCents,0);
    if(!paid||paid.action!=='pay'||accepted.slice(1).some(x=>x.action!=='refund')||r.revision!==accepted.length+1||r.paymentRef!==paid.externalRef||
     r.payment.paidAt!==paid.occurredAt||r.payment.refundedCents!==total)throw Error();
    await this.financial.verifyInTransaction(c,r);
   }else if(accepted.length)throw Error();
   return r;
  }catch{throw unavailable();}
 }
 private financeProof(row:any,proof:Record<string,unknown>):Readonly<MentorPaymentCommand>{
  const v=careerRecordObject(proof.finance,['command','commandDigest','actorId','actorAuthVersion','evidence','policyEvidence','retentionDays']);
  const cmd=parseMentorPaymentCommand(v.command),evidence=parseMentorReceiptEvidence(v.evidence),policy=parseMentorReceiptEvidence(v.policyEvidence);
  if(v.commandDigest!==digest(cmd)||cmd.operationId!==row.operation_id||cmd.action!==row.action||v.actorId!==row.operator_id||evidence.ref!==cmd.evidenceRef||
   evidence.ownerId!==v.actorId||policy.ownerId!==v.actorId||handoffHash(cmd.externalRef)!==row.external_ref_hash||typeof v.actorAuthVersion!=='string'||!/^\d+$/.test(v.actorAuthVersion))throw Error();
  mentorServiceInteger(v.retentionDays,1,36500);return cmd;
 }
 async originalPaymentInTransaction(c:PoolClient,org:string,command:MentorPaymentCommand,actor:string){
  const row=(await c.query('SELECT * FROM platform_mentor_order_proofs WHERE org_id=$1 AND operation_id=$2 AND action IS NOT NULL FOR SHARE',[org,command.operationId])).rows[0];
  if(!row)return null;
  try{const proof=careerRecordObject(this.crypto.open('mentor_order_proof',row.order_id,row.user_id,row.revision,row.proof_ciphertext),
   ['orderId','sessionId','ownerId','orgId','revision','operationId','createdAt','digest','finance']);
   const old=this.financeProof(row,proof);if(proof.orderId!==row.order_id||proof.ownerId!==row.user_id||proof.orgId!==row.org_id||proof.revision!==row.revision||
    proof.operationId!==row.operation_id||proof.createdAt!==row.created_at.toISOString())throw Error();
   if(row.operator_id!==actor||digest(old)!==digest(command))throw new ApiError(409,'MENTOR_PAYMENT_OPERATION_CONFLICT','操作编号已用于其他账务记录。');
   return Object.freeze({orderId:row.order_id as string,ownerId:row.user_id as string,appliedRevision:row.revision as number});
  }catch(e){if(e instanceof ApiError&&e.code==='MENTOR_PAYMENT_OPERATION_CONFLICT')throw e;throw unavailable();}
 }
 async settleInTransaction(c:PoolClient,actor:FixedSessionContext,current:MentorOrder,command:MentorPaymentCommand,
  evidence:MentorReceiptEvidence,policyEvidence:MentorReceiptEvidence,retentionDays:number,signal?:AbortSignal){
  await authorizeMentorStaffSource(c,actor,current.organizationId,signal);
  if(current.revision!==command.expectedRevision||current.sessionId!==command.sessionId)throw new ApiError(409,'MENTOR_ORDER_REVISION_CHANGED','请先查看最新订单。');
  const at=(await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
  if(command.occurredAt>at||command.occurredAt<current.createdAt)throw new ApiError(409,'MENTOR_PAYMENT_DATE_INVALID','请核对真实收款或退款时间。');
  let paymentRef:string,payment:{paidAt:string;refundedCents:number};
  if(command.action==='pay'){
   if(current.status!=='quoted'||command.amountCents!==current.priceCents)throw new ApiError(409,'MENTOR_PAYMENT_AMOUNT_INVALID','请核对当前报价和实际收款金额。');
   paymentRef=command.externalRef;payment={paidAt:command.occurredAt,refundedCents:0};
  }else{
   if(!current.payment||!current.paymentRef||!['paid','refunded_partial'].includes(current.status)||command.occurredAt<current.payment.paidAt||current.payment.refundedCents+command.amountCents>current.priceCents)
    throw new ApiError(409,'MENTOR_REFUND_AMOUNT_INVALID','请核对实际退款与剩余金额。');
   paymentRef=current.paymentRef;payment={...current.payment,refundedCents:current.payment.refundedCents+command.amountCents};
  }
  const status=payment.refundedCents===0?'paid':payment.refundedCents===current.priceCents?'refunded_full':'refunded_partial';
  const order=parseMentorOrder({...current,status,paymentRef,payment,revision:current.revision+1,lastOperationId:command.operationId,updatedAt:at});
  const actorAuthVersion=String((await c.query('SELECT auth_version FROM platform_users WHERE id=$1',[actor.userId])).rows[0].auth_version);
  const finance={command,commandDigest:digest(command),actorId:actor.userId,actorAuthVersion,evidence,policyEvidence,retentionDays};
  await this.write(c,order,true,finance);await this.financial.recordInTransaction(c,order,retentionDays,command);signal?.throwIfAborted();return order;
 }
 async quoteInTransaction(c:PoolClient,actor:FixedSessionContext,record:MentorIntent,shownOffer:MentorServiceOffer,priceCents:number,signal?:AbortSignal){
  await authorizeMentorStaffSource(c,actor,record.organizationId,signal);
  if(record.status!=='matched'||!record.orderId||!record.assignment||!record.mentorId||shownOffer.id!==record.offerId||shownOffer.revision!==record.offerRevision||
   shownOffer.organizationId!==record.organizationId||shownOffer.kind!==record.kind||shownOffer.durationMin!==record.durationMin)throw unavailable();
  const order=parseMentorOrder({id:record.orderId,sessionId:record.id,ownerId:record.ownerId,organizationId:record.organizationId,offerId:record.offerId,offerRevision:record.offerRevision,
   priceCents,currency:'USD',status:'quoted',paymentRef:null,handoffCode:randomBytes(32).toString('base64url'),origin:'user_request',suggestionId:null,shownOffer,
   revision:1,lastOperationId:record.lastOperationId,createdAt:record.updatedAt,updatedAt:record.updatedAt});
  await this.write(c,order,false);signal?.throwIfAborted();return order;
 }
 async voidInTransaction(c:PoolClient,record:MentorIntent,signal?:AbortSignal){
  if(record.status!=='cancelled'||!record.orderId||!record.assignment)throw unavailable();
  const current=await this.readInTransaction(c,record.ownerId,record.orderId);
  if(current.sessionId!==record.id||current.organizationId!==record.organizationId)throw unavailable();
  if(current.payment)return current;
  if(current.status!=='quoted')throw unavailable();
  const order=parseMentorOrder({...current,status:'void',handoffCode:null,revision:2,lastOperationId:record.lastOperationId,updatedAt:record.updatedAt});
  await this.write(c,order,true);signal?.throwIfAborted();return order;
 }
 private async write(c:PoolClient,r:MentorOrder,update:boolean,finance?:{command:MentorPaymentCommand;commandDigest:string;actorId:string;actorAuthVersion:string;evidence:MentorReceiptEvidence;policyEvidence:MentorReceiptEvidence;retentionDays:number}){
  const proof={orderId:r.id,sessionId:r.sessionId,ownerId:r.ownerId,orgId:r.organizationId,revision:r.revision,operationId:r.lastOperationId,createdAt:r.updatedAt,digest:digest(r),...(finance?{finance}:{})};
  await c.query('INSERT INTO platform_mentor_order_proofs(order_id,user_id,org_id,revision,operation_id,created_at,proof_ciphertext,action,operator_id,external_ref_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   [r.id,r.ownerId,r.organizationId,r.revision,r.lastOperationId,r.updatedAt,this.crypto.seal('mentor_order_proof',r.id,r.ownerId,r.revision,proof),finance?.command.action??null,finance?.actorId??null,finance?handoffHash(finance.command.externalRef):null]);
  const cipher=this.crypto.seal('mentor_order',r.id,r.ownerId,r.revision,r);
  if(update){const result=await c.query(`UPDATE platform_mentor_orders SET status=$3,handoff_code_hash=$4,revision=$5,last_operation_id=$6,updated_at=$7,payload_ciphertext=$8,payment_ref=$9,payment_ref_hash=$10
   WHERE id=$1 AND user_id=$2 AND revision=$11`,[r.id,r.ownerId,r.status,handoffHash(r.handoffCode),r.revision,r.lastOperationId,r.updatedAt,cipher,r.paymentRef,handoffHash(r.paymentRef),r.revision-1]);if(result.rowCount!==1)throw unavailable();}
  else await c.query(`INSERT INTO platform_mentor_orders(id,session_id,user_id,org_id,offer_id,offer_revision,price_cents,currency,status,origin,suggestion_id,payment_ref,handoff_code_hash,revision,last_operation_id,created_at,updated_at,payload_ciphertext)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11,$12,$13,$14,$15,$16)`,[r.id,r.sessionId,r.ownerId,r.organizationId,r.offerId,r.offerRevision,r.priceCents,r.currency,r.status,r.origin,handoffHash(r.handoffCode),r.revision,r.lastOperationId,r.createdAt,r.updatedAt,cipher]);
 }
}
