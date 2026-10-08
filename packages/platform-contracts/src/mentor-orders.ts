import { careerRecordId,careerRecordObject,CareerRecordInputError } from './career-record-values.ts';
import { mentorServiceInteger,mentorServiceTime,mentorServiceText,parseMentorServiceOffer,type MentorServiceOffer } from './mentor-service-offers.ts';
export interface MentorMatchCommand {
 readonly operationId:string;readonly sessionId:string;readonly expectedRevision:1;readonly slotId:string;readonly slotRevision:number;readonly priceCents:number;
}
export function parseMentorMatchCommand(input:unknown):Readonly<MentorMatchCommand>{
 const v=careerRecordObject(input,['operationId','sessionId','expectedRevision','slotId','slotRevision','priceCents']);
 if(v.expectedRevision!==1)throw new CareerRecordInputError();
 return Object.freeze({operationId:careerRecordId(v.operationId),sessionId:careerRecordId(v.sessionId),expectedRevision:1,
  slotId:careerRecordId(v.slotId),slotRevision:mentorServiceInteger(v.slotRevision,1),priceCents:mentorServiceInteger(v.priceCents,1)});
}
export interface MentorOrder {
 readonly id:string;readonly sessionId:string;readonly ownerId:string;readonly organizationId:string;readonly offerId:string;readonly offerRevision:number;
 readonly priceCents:number;readonly currency:'USD';readonly status:'quoted'|'paid'|'refunded_partial'|'refunded_full'|'void';readonly paymentRef:string|null;readonly payment?:Readonly<{paidAt:string;refundedCents:number}>;readonly handoffCode:string|null;
 readonly origin:'user_request';readonly suggestionId:null;readonly shownOffer:Readonly<MentorServiceOffer>;
 readonly revision:number;readonly lastOperationId:string;readonly createdAt:string;readonly updatedAt:string;
}
export function parseMentorOrder(input:unknown):Readonly<MentorOrder>{
 const v=careerRecordObject(input,['id','sessionId','ownerId','organizationId','offerId','offerRevision','priceCents','currency','status','paymentRef','handoffCode',
  'origin','suggestionId','shownOffer','revision','lastOperationId','createdAt','updatedAt'],['payment']);
 if(v.currency!=='USD'||!['quoted','paid','refunded_partial','refunded_full','void'].includes(v.status as string)||v.origin!=='user_request'||v.suggestionId!==null)throw new CareerRecordInputError();
 const offer=parseMentorServiceOffer(v.shownOffer),priceCents=mentorServiceInteger(v.priceCents,1),revision=mentorServiceInteger(v.revision,1);
 const payment=v.payment===undefined?null:careerRecordObject(v.payment,['paidAt','refundedCents']);
 const settled=['paid','refunded_partial','refunded_full'].includes(v.status as string);
 const paidAt=payment?mentorServiceTime(payment.paidAt):null,refundedCents=payment?mentorServiceInteger(payment.refundedCents,0,priceCents):0;
 if(settled!==!!payment||(settled?(typeof v.paymentRef!=='string'||externalPaymentRef(v.paymentRef)!==v.paymentRef||revision<2||
  v.status==='paid'&&(revision!==2||refundedCents!==0)||v.status==='refunded_partial'&&(revision<3||refundedCents<=0||refundedCents>=priceCents)||
  v.status==='refunded_full'&&(revision<3||refundedCents!==priceCents)):v.paymentRef!==null))throw new CareerRecordInputError();
 const createdAt=mentorServiceTime(v.createdAt),updatedAt=mentorServiceTime(v.updatedAt);
 if(priceCents>offer.priceCents||offer.id!==v.offerId||offer.revision!==v.offerRevision||offer.organizationId!==v.organizationId||createdAt>updatedAt||
  v.status!=='void'&&(typeof v.handoffCode!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(v.handoffCode))||v.status==='quoted'&&revision!==1||
  paidAt!==null&&(paidAt<createdAt||paidAt>updatedAt)||
  v.status==='void'&&(revision!==2||v.handoffCode!==null))throw new CareerRecordInputError();
 return Object.freeze({id:careerRecordId(v.id),sessionId:careerRecordId(v.sessionId),ownerId:careerRecordId(v.ownerId),organizationId:careerRecordId(v.organizationId),
  offerId:careerRecordId(v.offerId),offerRevision:mentorServiceInteger(v.offerRevision,1),priceCents,currency:'USD',status:v.status as MentorOrder['status'],
  paymentRef:settled?v.paymentRef as string:null,...(payment?{payment:Object.freeze({paidAt:paidAt!,refundedCents})}:{}),handoffCode:v.handoffCode as string|null,origin:'user_request',suggestionId:null,shownOffer:offer,revision,lastOperationId:careerRecordId(v.lastOperationId),createdAt,updatedAt});
}

export function externalPaymentRef(input:unknown):string{
 const value=mentorServiceText(input,120);if(!/^[A-Za-z0-9][A-Za-z0-9_:-]{2,119}$/.test(value))throw new CareerRecordInputError();return value;
}
export interface MentorPaymentCommand {
 readonly action:'pay'|'refund';readonly operationId:string;readonly sessionId:string;readonly expectedRevision:number;
 readonly amountCents:number;readonly externalRef:string;readonly occurredAt:string;readonly evidenceRef:string;readonly confirmRecorded:true;
}
export function parseMentorPaymentCommand(input:unknown):Readonly<MentorPaymentCommand>{
 const v=careerRecordObject(input,['action','operationId','sessionId','expectedRevision','amountCents','externalRef','occurredAt','evidenceRef','confirmRecorded']);
 if(!['pay','refund'].includes(v.action as string)||v.confirmRecorded!==true)throw new CareerRecordInputError();
 return Object.freeze({action:v.action as MentorPaymentCommand['action'],operationId:careerRecordId(v.operationId),sessionId:careerRecordId(v.sessionId),
  expectedRevision:mentorServiceInteger(v.expectedRevision,1,2147483646),amountCents:mentorServiceInteger(v.amountCents,1),externalRef:externalPaymentRef(v.externalRef),
  occurredAt:mentorServiceTime(v.occurredAt),evidenceRef:careerRecordId(v.evidenceRef),confirmRecorded:true});
}
