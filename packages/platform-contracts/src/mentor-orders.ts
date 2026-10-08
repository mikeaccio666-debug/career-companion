import { careerRecordId,careerRecordObject,CareerRecordInputError } from './career-record-values.ts';
import { mentorServiceInteger,mentorServiceTime,parseMentorServiceOffer,type MentorServiceOffer } from './mentor-service-offers.ts';
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
 readonly priceCents:number;readonly currency:'USD';readonly status:'quoted'|'void';readonly paymentRef:null;readonly handoffCode:string|null;
 readonly origin:'user_request';readonly suggestionId:null;readonly shownOffer:Readonly<MentorServiceOffer>;
 readonly revision:number;readonly lastOperationId:string;readonly createdAt:string;readonly updatedAt:string;
}
export function parseMentorOrder(input:unknown):Readonly<MentorOrder>{
 const v=careerRecordObject(input,['id','sessionId','ownerId','organizationId','offerId','offerRevision','priceCents','currency','status','paymentRef','handoffCode',
  'origin','suggestionId','shownOffer','revision','lastOperationId','createdAt','updatedAt']);
 if(v.currency!=='USD'||!['quoted','void'].includes(v.status as string)||v.paymentRef!==null||v.origin!=='user_request'||v.suggestionId!==null)throw new CareerRecordInputError();
 const offer=parseMentorServiceOffer(v.shownOffer),priceCents=mentorServiceInteger(v.priceCents,1),revision=mentorServiceInteger(v.revision,1,2);
 const createdAt=mentorServiceTime(v.createdAt),updatedAt=mentorServiceTime(v.updatedAt);
 if(priceCents>offer.priceCents||offer.id!==v.offerId||offer.revision!==v.offerRevision||offer.organizationId!==v.organizationId||createdAt>updatedAt||
  v.status==='quoted'&&(revision!==1||typeof v.handoffCode!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(v.handoffCode))||
  v.status==='void'&&(revision!==2||v.handoffCode!==null))throw new CareerRecordInputError();
 return Object.freeze({id:careerRecordId(v.id),sessionId:careerRecordId(v.sessionId),ownerId:careerRecordId(v.ownerId),organizationId:careerRecordId(v.organizationId),
  offerId:careerRecordId(v.offerId),offerRevision:mentorServiceInteger(v.offerRevision,1),priceCents,currency:'USD',status:v.status as MentorOrder['status'],
  paymentRef:null,handoffCode:v.handoffCode as string|null,origin:'user_request',suggestionId:null,shownOffer:offer,revision,lastOperationId:careerRecordId(v.lastOperationId),createdAt,updatedAt});
}
