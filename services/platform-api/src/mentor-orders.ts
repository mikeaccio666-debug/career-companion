import { randomBytes,createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { careerRecordObject,parseMentorOrder,type MentorOrder,type MentorIntent,type MentorServiceOffer } from '@companion/platform-contracts';
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
 private readonly crypto:MentorLedgerCrypto;
 constructor(config:Pick<PlatformConfig,'dataCrypto'>){this.crypto=new MentorLedgerCrypto(config);}
 async readInTransaction(c:PoolClient,owner:string,id:string):Promise<Readonly<MentorOrder>>{
  try{
   const row=(await c.query('SELECT * FROM platform_mentor_orders WHERE id=$1 AND user_id=$2 FOR SHARE',[id,owner])).rows[0];if(!row)throw Error();
   const r=parseMentorOrder(this.crypto.open('mentor_order',row.id,row.user_id,row.revision,row.payload_ciphertext));
   if(r.id!==row.id||r.ownerId!==row.user_id||r.sessionId!==row.session_id||r.organizationId!==row.org_id||r.offerId!==row.offer_id||r.offerRevision!==row.offer_revision||
    r.priceCents!==row.price_cents||r.currency!==row.currency||r.status!==row.status||r.origin!==row.origin||r.suggestionId!==row.suggestion_id||r.paymentRef!==row.payment_ref||
    r.revision!==row.revision||r.lastOperationId!==row.last_operation_id||r.createdAt!==row.created_at.toISOString()||r.updatedAt!==row.updated_at.toISOString()||handoffHash(r.handoffCode)!==row.handoff_code_hash)throw Error();
   const rows=(await c.query('SELECT * FROM platform_mentor_order_proofs WHERE order_id=$1 ORDER BY revision FOR SHARE',[r.id])).rows;
   if(rows.length!==r.revision)throw Error();
   for(let i=0;i<rows.length;i++){
    const proof=rows[i];if(proof.revision!==i+1||proof.user_id!==r.ownerId||proof.org_id!==r.organizationId)throw Error();
    const v=careerRecordObject(this.crypto.open('mentor_order_proof',r.id,r.ownerId,proof.revision,proof.proof_ciphertext),
     ['orderId','sessionId','ownerId','orgId','revision','operationId','createdAt','digest']);
    if(v.orderId!==r.id||v.sessionId!==r.sessionId||v.ownerId!==r.ownerId||v.orgId!==r.organizationId||v.revision!==proof.revision||
     v.operationId!==proof.operation_id||v.createdAt!==proof.created_at.toISOString()||typeof v.digest!=='string'||!/^[0-9a-f]{64}$/.test(v.digest))throw Error();
    if(i===0&&v.createdAt!==r.createdAt||i===rows.length-1&&(v.digest!==digest(r)||v.operationId!==r.lastOperationId||v.createdAt!==r.updatedAt))throw Error();
   }
   return r;
  }catch{throw unavailable();}
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
  if(current.status!=='quoted'||current.sessionId!==record.id||current.organizationId!==record.organizationId)throw unavailable();
  const order=parseMentorOrder({...current,status:'void',handoffCode:null,revision:2,lastOperationId:record.lastOperationId,updatedAt:record.updatedAt});
  await this.write(c,order,true);signal?.throwIfAborted();return order;
 }
 private async write(c:PoolClient,r:MentorOrder,update:boolean){
  const proof={orderId:r.id,sessionId:r.sessionId,ownerId:r.ownerId,orgId:r.organizationId,revision:r.revision,operationId:r.lastOperationId,createdAt:r.updatedAt,digest:digest(r)};
  await c.query('INSERT INTO platform_mentor_order_proofs(order_id,user_id,org_id,revision,operation_id,created_at,proof_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)',
   [r.id,r.ownerId,r.organizationId,r.revision,r.lastOperationId,r.updatedAt,this.crypto.seal('mentor_order_proof',r.id,r.ownerId,r.revision,proof)]);
  const cipher=this.crypto.seal('mentor_order',r.id,r.ownerId,r.revision,r);
  if(update){const result=await c.query("UPDATE platform_mentor_orders SET status='void',handoff_code_hash=NULL,revision=2,last_operation_id=$3,updated_at=$4,payload_ciphertext=$5 WHERE id=$1 AND user_id=$2 AND status='quoted' AND revision=1",[r.id,r.ownerId,r.lastOperationId,r.updatedAt,cipher]);if(result.rowCount!==1)throw unavailable();}
  else await c.query(`INSERT INTO platform_mentor_orders(id,session_id,user_id,org_id,offer_id,offer_revision,price_cents,currency,status,origin,suggestion_id,payment_ref,handoff_code_hash,revision,last_operation_id,created_at,updated_at,payload_ciphertext)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11,$12,$13,$14,$15,$16)`,[r.id,r.sessionId,r.ownerId,r.organizationId,r.offerId,r.offerRevision,r.priceCents,r.currency,r.status,r.origin,handoffHash(r.handoffCode),r.revision,r.lastOperationId,r.createdAt,r.updatedAt,cipher]);
 }
}
