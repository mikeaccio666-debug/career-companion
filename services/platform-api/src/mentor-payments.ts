import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { FixedSessionContext } from './auth.ts';
import type { MentorCapacity } from './mentor-capacity.ts';
import type { MentorServiceOffers } from './mentor-service-offers.ts';
import type { BlobStorage } from './storage.ts';
import type { MentorIntents } from './mentor-intents.ts';
import { MentorOrders } from './mentor-orders.ts';
import { captureMentorReceiptEvidence } from './mentor-receipt-evidence.ts';
import { StaffAccess } from './staff-access.ts';
import { careerRecordId,careerRecordObject,mentorServiceInteger,parseMentorPaymentCommand } from '@companion/platform-contracts';
import { ApiError } from './errors.ts';
/** Manual record of an already completed external payment/refund. It never charges or refunds money. */
export class MentorPayments {
 private readonly orders:MentorOrders;private readonly staff:StaffAccess;private readonly days:number|undefined;private readonly policyRef:string|undefined;
 constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'mentorRetentionDays'|'mentorRetentionEvidenceRef'>,
  private readonly intents:Pick<MentorIntents,'financeInTransaction'|'revalidateFinanceOwner'>,
  private readonly offers:Pick<MentorServiceOffers,'currentForStaffInTransaction'>,private readonly capacity:Pick<MentorCapacity,'confirmedInTransaction'>,
  private readonly blobs:Pick<BlobStorage,'stat'>){
  this.orders=new MentorOrders(config);this.staff=new StaffAccess(db);this.days=config.mentorRetentionDays===undefined?undefined:mentorServiceInteger(config.mentorRetentionDays,1,36500);
  this.policyRef=config.mentorRetentionEvidenceRef===undefined?undefined:careerRecordId(config.mentorRetentionEvidenceRef);
 }
 async record(session:FixedSessionContext,organizationId:string,input:unknown,signal?:AbortSignal){
  const raw=careerRecordObject(session,['userId','tokenHash']);if(typeof raw.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(raw.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','请重新登录。');
  const context=Object.freeze({userId:careerRecordId(raw.userId),tokenHash:raw.tokenHash}),org=careerRecordId(organizationId);
  let cmd;try{cmd=parseMentorPaymentCommand(input);}catch{throw new ApiError(400,'MENTOR_PAYMENT_INPUT_INVALID','请明确记录实际收款或退款凭据。');}
  return this.staff.readWithAccess<Readonly<{orderId:string;sessionId:string;status:string;revision:number;appliedRevision:number;replayed:boolean}>>(context,org,
   {roles:['ops','org_admin'],action:'mentor_payment_recorded',targetId:cmd.sessionId},async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mentor_payment:'+org+':'+cmd.operationId]);
    const original=await this.orders.originalPaymentInTransaction(c,org,cmd,context.userId);
    const accepted=await this.intents.financeInTransaction(c,context,org,cmd.sessionId,signal),r=accepted.record;
    const current=await this.orders.readInTransaction(c,r.ownerId,r.orderId!,accepted.quoteOperationId);
    if(original){if(original.orderId!==current.id||original.ownerId!==r.ownerId)throw new ApiError(409,'MENTOR_PAYMENT_OPERATION_CONFLICT','操作编号已用于其他账务记录。');
     await this.intents.revalidateFinanceOwner(c,r.ownerId,accepted.authVersion,signal);
     return {value:Object.freeze({orderId:current.id,sessionId:r.id,status:current.status,revision:current.revision,appliedRevision:original.appliedRevision,replayed:true}),recordCount:1};}
    if(this.days===undefined||!this.policyRef)throw new ApiError(503,'MENTOR_RETENTION_POLICY_UNAVAILABLE','账务保留政策尚未配置，暂时不能录入。');
    if(current.revision!==cmd.expectedRevision)throw new ApiError(409,'MENTOR_ORDER_REVISION_CHANGED','请先查看最新订单。');
    const policyEvidence=await captureMentorReceiptEvidence(c,this.blobs,context.userId,this.policyRef,signal);
    const evidence=await captureMentorReceiptEvidence(c,this.blobs,context.userId,cmd.evidenceRef,signal);
    let offer:Awaited<ReturnType<MentorServiceOffers['currentForStaffInTransaction']>>|null=null;
    if(cmd.action==='pay'){
     if(!['matched','scheduled','completed'].includes(r.status)||current.status!=='quoted')throw new ApiError(409,'MENTOR_PAYMENT_UNAVAILABLE','当前预约不可录入收款。');
     if(r.status!=='completed'){
     offer=await this.offers.currentForStaffInTransaction(c,context,org,r.offerId,signal);
     await this.capacity.confirmedInTransaction(c,context,org,r.assignment!.slotId,r.assignment!.slotRevision,signal);
     if(offer.kind!==r.kind||offer.durationMin!==r.durationMin||current.priceCents>offer.priceCents||r.assignment!.startsAt<offer.earliestSlotAt!)
      throw new ApiError(409,'MENTOR_PAYMENT_SOURCE_CHANGED','服务、导师或价格已有变化，请先重新确认。');
     }
    }
    const order=await this.orders.settleInTransaction(c,context,current,cmd,evidence,policyEvidence,this.days,signal);
    await this.intents.revalidateFinanceOwner(c,r.ownerId,accepted.authVersion,signal);
    const at=(await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
    if(offer&&(r.assignment!.startsAt<=at||offer.validUntil<=at||current.shownOffer.validUntil<=at||offer.earliestSlotAt!<=at))throw new ApiError(409,'MENTOR_PAYMENT_SOURCE_CHANGED','服务或时段已有变化，请先重新确认。');
    signal?.throwIfAborted();return {value:Object.freeze({orderId:order.id,sessionId:r.id,status:order.status,revision:order.revision,appliedRevision:order.revision,replayed:false}),recordCount:1};
   },signal);
 }
}
