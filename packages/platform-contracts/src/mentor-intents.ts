import { parseMentorScheduled,type MentorScheduled } from './mentor-scheduling.ts';
import { mentorTimeZone } from './mentor-capacity.ts';
import { careerRecordObject, careerRecordId, CareerRecordInputError } from './career-record-values.ts';
import { MENTOR_SERVICE_KINDS, mentorServiceText, mentorServiceInteger, mentorServiceTime, type MentorServiceKind } from './mentor-service-offers.ts';
export const MENTOR_INTENT_PRIVACY_VERSION = 'mentor-intent-privacy-v1';
export interface MentorAssignment {
 readonly mentorDisplayName:string;readonly slotId:string;readonly slotRevision:number;readonly profileId:string;readonly profileRevision:number;
 readonly startsAt:string;readonly endsAt:string;readonly timeZone:string;readonly matchedAt:string;
}
export function parseMentorAssignment(input:unknown):Readonly<MentorAssignment>{
 const v=careerRecordObject(input,['mentorDisplayName','slotId','slotRevision','profileId','profileRevision','startsAt','endsAt','timeZone','matchedAt']);
 const startsAt=mentorServiceTime(v.startsAt),endsAt=mentorServiceTime(v.endsAt),matchedAt=mentorServiceTime(v.matchedAt);
 if(startsAt>=endsAt||matchedAt>=startsAt)throw new CareerRecordInputError();
 return Object.freeze({mentorDisplayName:mentorServiceText(v.mentorDisplayName,100),slotId:careerRecordId(v.slotId),slotRevision:mentorServiceInteger(v.slotRevision,1),
  profileId:careerRecordId(v.profileId),profileRevision:mentorServiceInteger(v.profileRevision,1),startsAt,endsAt,timeZone:mentorTimeZone(v.timeZone),matchedAt});
}
export interface MentorIntent {
  readonly id:string; readonly ownerId:string; readonly organizationId:string; readonly offerId:string; readonly offerRevision:number;
  readonly kind:MentorServiceKind; readonly durationMin:number; readonly contactName:string; readonly contactEmail:string; readonly intentNote:string;
  readonly status:'requested'|'matched'|'scheduled'|'cancelled'; readonly orderId:string|null; readonly mentorId:string|null; readonly assignment?:Readonly<MentorAssignment>; readonly scheduled?:Readonly<MentorScheduled>;
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
    'status','orderId','mentorId','privacyVersion','visibilityConfirmedAt','revision','createdAt','updatedAt','lastOperationId'],['assignment','scheduled']);
  if (!MENTOR_SERVICE_KINDS.includes(v.kind as MentorServiceKind) || !['requested','matched','scheduled','cancelled'].includes(v.status as string) || v.privacyVersion!==MENTOR_INTENT_PRIVACY_VERSION) return fail();
  const createdAt=mentorServiceTime(v.createdAt),updatedAt=mentorServiceTime(v.updatedAt),visibilityConfirmedAt=mentorServiceTime(v.visibilityConfirmedAt);
  if (createdAt>updatedAt || visibilityConfirmedAt!==createdAt) return fail();
  const revision=mentorServiceInteger(v.revision,1);
  const assigned=v.assignment===undefined?null:parseMentorAssignment(v.assignment);
  const scheduled=v.scheduled===undefined?null:parseMentorScheduled(v.scheduled);
  if(scheduled&&(!assigned||scheduled.confirmedAt<assigned.matchedAt||scheduled.confirmedAt>updatedAt||scheduled.confirmedAt>=assigned.startsAt))return fail();
  if(v.status==='requested'&&(revision!==1||assigned||scheduled)||v.status==='matched'&&(revision!==2||!assigned||scheduled)||
    v.status==='scheduled'&&(revision!==3||!assigned||!scheduled)||
    v.status==='cancelled'&&revision!==(scheduled?4:assigned?3:2)||!assigned&&(v.orderId!==null||v.mentorId!==null)||
    assigned&&(assigned.matchedAt<createdAt||assigned.matchedAt>updatedAt||Date.parse(assigned.endsAt)-Date.parse(assigned.startsAt)!==mentorServiceInteger(v.durationMin,1,240)*60000))return fail();
  return Object.freeze({id:careerRecordId(v.id),ownerId:careerRecordId(v.ownerId),organizationId:careerRecordId(v.organizationId),
    offerId:careerRecordId(v.offerId),offerRevision:mentorServiceInteger(v.offerRevision,1),kind:v.kind as MentorServiceKind,
    durationMin:mentorServiceInteger(v.durationMin,1,240),contactName:mentorServiceText(v.contactName,100),contactEmail:mentorIntentEmail(v.contactEmail),
    intentNote:mentorIntentNote(v.intentNote),status:v.status as MentorIntent['status'],orderId:assigned?careerRecordId(v.orderId):null,mentorId:assigned?careerRecordId(v.mentorId):null,
    ...(assigned?{assignment:assigned}:{}),...(scheduled?{scheduled}:{}),
    privacyVersion:MENTOR_INTENT_PRIVACY_VERSION,visibilityConfirmedAt,revision,createdAt,updatedAt,lastOperationId:careerRecordId(v.lastOperationId)});
}
