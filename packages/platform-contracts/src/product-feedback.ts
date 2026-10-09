import { careerRecordObject, careerRecordId } from './career-record-values.ts';
export const FEEDBACK_CATEGORIES=Object.freeze(['incorrect','out_of_character','too_long','sales_pressure','other'] as const);
export const FEEDBACK_TRIAGE=Object.freeze(['defect','quality','policy','content_gap','request'] as const);
export const FEEDBACK_STATUSES=Object.freeze(['submitted','in_review','resolved','closed'] as const);
export type FeedbackCategory=typeof FEEDBACK_CATEGORIES[number];
export type FeedbackTriage=typeof FEEDBACK_TRIAGE[number];
export type FeedbackStatus=typeof FEEDBACK_STATUSES[number];
export const FEEDBACK_SURFACES=Object.freeze(['conversation','today','journey','pending','me','onboarding','other'] as const);
const fail=():never=>{throw Error('The feedback could not be confirmed.');};
function choice<T extends string>(v:unknown,values:readonly T[]):T{if(typeof v!=='string'||!values.includes(v as T))return fail();return v as T;}
function text(v:unknown,max:number,required=false):string{if(typeof v!=='string'||v.length>max||required&&!v.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))return fail();return v;}
function revision(v:unknown):number{if(!Number.isSafeInteger(v)||(v as number)<1||(v as number)>2147483647)return fail();return v as number;}
function date(v:unknown):string{if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)return fail();return v;}
export function parseFeedbackSubmission(value:unknown){
 const v=careerRecordObject(value,['operationId','recipientId','category','surface','description','sharedExcerpt','shareWithSupport']);
 if(v.shareWithSupport!==true)return fail();
 return Object.freeze({operationId:careerRecordId(v.operationId),recipientId:careerRecordId(v.recipientId),category:choice(v.category,FEEDBACK_CATEGORIES),surface:choice(v.surface,FEEDBACK_SURFACES),
 description:text(v.description,4000,true),sharedExcerpt:v.sharedExcerpt===null?null:text(v.sharedExcerpt,12000,true),shareWithSupport:true as const});
}
export function parseFeedbackUpdate(value:unknown){
 const v=careerRecordObject(value,['operationId','expectedRevision','status','triage','reply']);
 const status=choice(v.status,['in_review','resolved','closed'] as const);
 return Object.freeze({operationId:careerRecordId(v.operationId),expectedRevision:revision(v.expectedRevision),status,
 triage:choice(v.triage,FEEDBACK_TRIAGE),reply:text(v.reply,4000,status!=='in_review')});
}
export interface FeedbackUpdate {readonly revision:number;readonly status:Exclude<FeedbackStatus,'submitted'>;readonly triage:FeedbackTriage;readonly reply:string;readonly at:string;}
export interface ProductFeedback {
 readonly id:string;readonly ownerId:string;readonly organizationId:string;readonly revision:number;readonly lastOperationId:string;
 readonly category:FeedbackCategory;readonly surface:typeof FEEDBACK_SURFACES[number];readonly description:string;readonly sharedExcerpt:string|null;
 readonly shareWithSupport:true;readonly status:FeedbackStatus;readonly triage:FeedbackTriage|null;readonly createdAt:string;readonly updatedAt:string;
 readonly updates:readonly Readonly<FeedbackUpdate>[];
}
export function parseProductFeedback(value:unknown):Readonly<ProductFeedback>{
 const v=careerRecordObject(value,['id','ownerId','organizationId','revision','lastOperationId','category','surface','description','sharedExcerpt','shareWithSupport','status','triage','createdAt','updatedAt','updates']);
 const s=parseFeedbackSubmission({operationId:v.lastOperationId,recipientId:v.organizationId,category:v.category,surface:v.surface,description:v.description,sharedExcerpt:v.sharedExcerpt,shareWithSupport:v.shareWithSupport});
 const rev=revision(v.revision),status=choice(v.status,FEEDBACK_STATUSES),triage=v.triage===null?null:choice(v.triage,FEEDBACK_TRIAGE),createdAt=date(v.createdAt),updatedAt=date(v.updatedAt);
 if(!Array.isArray(v.updates)||v.updates.length>100||v.updates.length!==rev-1||updatedAt<createdAt)return fail();
 let lastAt=createdAt;
 const updates=v.updates.map((item,i)=>{
  const u=careerRecordObject(item,['revision','status','triage','reply','at']);
  const parsed=parseFeedbackUpdate({operationId:s.operationId,expectedRevision:i+1,status:u.status,triage:u.triage,reply:u.reply});
  const at=date(u.at);if(revision(u.revision)!==i+2||at<lastAt)return fail();lastAt=at;
  return Object.freeze({revision:i+2,status:parsed.status,triage:parsed.triage,reply:parsed.reply,at});
 });
 const last=updates.at(-1);
 if(last?(last.status!==status||last.triage!==triage||last.at!==updatedAt):(status!=='submitted'||triage!==null||createdAt!==updatedAt))return fail();
 return Object.freeze({id:careerRecordId(v.id),ownerId:careerRecordId(v.ownerId),organizationId:careerRecordId(v.organizationId),revision:rev,lastOperationId:s.operationId,
 category:s.category,surface:s.surface,description:s.description,sharedExcerpt:s.sharedExcerpt,shareWithSupport:true,status,triage,createdAt,updatedAt,updates:Object.freeze(updates)});
}
