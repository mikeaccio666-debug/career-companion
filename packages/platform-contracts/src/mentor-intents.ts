import { careerRecordObject, careerRecordId, CareerRecordInputError } from './career-record-values.ts';
import { MENTOR_SERVICE_KINDS, mentorServiceText, mentorServiceInteger, mentorServiceTime, type MentorServiceKind } from './mentor-service-offers.ts';
export const MENTOR_INTENT_PRIVACY_VERSION = 'mentor-intent-privacy-v1';
export interface MentorIntent {
  readonly id:string; readonly ownerId:string; readonly organizationId:string; readonly offerId:string; readonly offerRevision:number;
  readonly kind:MentorServiceKind; readonly durationMin:number; readonly contactName:string; readonly contactEmail:string; readonly intentNote:string;
  readonly status:'requested'|'cancelled'; readonly orderId:null; readonly mentorId:null;
  readonly privacyVersion:typeof MENTOR_INTENT_PRIVACY_VERSION; readonly visibilityConfirmedAt:string;
  readonly revision:number; readonly createdAt:string; readonly updatedAt:string; readonly lastOperationId:string;
}
export interface MentorIntentCommand {
  readonly operationId:string; readonly offerId:string; readonly offerRevision:number; readonly contactName:string; readonly intentNote:string;
  readonly privacyVersion:typeof MENTOR_INTENT_PRIVACY_VERSION; readonly confirmVisibility:true;
}
const fail=():never=>{throw new CareerRecordInputError();};
export function mentorIntentNote(v:unknown):string {
  if (typeof v!=='string' || !v || v.trim()!==v || Array.from(v).length>4000 ||
      /[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(v))return fail();
  return v;
}
export function mentorIntentEmail(v:unknown):string {
  const email=mentorServiceText(v,320);if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return fail();return email;
}
export function parseMentorIntentCommand(input:unknown):Readonly<MentorIntentCommand> {
  const v=careerRecordObject(input,['operationId','offerId','offerRevision','contactName','intentNote','privacyVersion','confirmVisibility']);
  if (v.privacyVersion!==MENTOR_INTENT_PRIVACY_VERSION || v.confirmVisibility!==true) return fail();
  return Object.freeze({operationId:careerRecordId(v.operationId),offerId:careerRecordId(v.offerId),offerRevision:mentorServiceInteger(v.offerRevision,1),
    contactName:mentorServiceText(v.contactName,100),intentNote:mentorIntentNote(v.intentNote),
    privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,confirmVisibility:true});
}
export function parseMentorIntent(input:unknown):Readonly<MentorIntent> {
  const v=careerRecordObject(input,['id','ownerId','organizationId','offerId','offerRevision','kind','durationMin','contactName','contactEmail','intentNote',
    'status','orderId','mentorId','privacyVersion','visibilityConfirmedAt','revision','createdAt','updatedAt','lastOperationId']);
  if (!MENTOR_SERVICE_KINDS.includes(v.kind as MentorServiceKind) || !['requested','cancelled'].includes(v.status as string) ||
      v.orderId!==null || v.mentorId!==null || v.privacyVersion!==MENTOR_INTENT_PRIVACY_VERSION) return fail();
  const createdAt=mentorServiceTime(v.createdAt),updatedAt=mentorServiceTime(v.updatedAt),visibilityConfirmedAt=mentorServiceTime(v.visibilityConfirmedAt);
  if (createdAt>updatedAt || visibilityConfirmedAt!==createdAt) return fail();
  const revision=mentorServiceInteger(v.revision,1);
  if (v.status==='requested' && revision!==1 || v.status==='cancelled' && revision!==2) return fail();
  return Object.freeze({id:careerRecordId(v.id),ownerId:careerRecordId(v.ownerId),organizationId:careerRecordId(v.organizationId),
    offerId:careerRecordId(v.offerId),offerRevision:mentorServiceInteger(v.offerRevision,1),kind:v.kind as MentorServiceKind,
    durationMin:mentorServiceInteger(v.durationMin,1,240),contactName:mentorServiceText(v.contactName,100),contactEmail:mentorIntentEmail(v.contactEmail),
    intentNote:mentorIntentNote(v.intentNote),status:v.status as MentorIntent['status'],orderId:null,mentorId:null,
    privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,visibilityConfirmedAt,revision,createdAt,updatedAt,lastOperationId:careerRecordId(v.lastOperationId)});
}
