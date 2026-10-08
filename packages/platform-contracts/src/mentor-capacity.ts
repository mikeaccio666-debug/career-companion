import { careerRecordId, careerRecordObject, CareerRecordInputError } from './career-record-values.ts';
import { MENTOR_SERVICE_KINDS, mentorServiceInteger, mentorServiceText, mentorServiceTime, type MentorServiceKind } from './mentor-service-offers.ts';
export const MENTOR_CONDUCT_VERSION = 'mentor-conduct-v1';
export type MentorCapacityKind = 'profile'|'slot';
const fail = (): never => { throw new CareerRecordInputError(); };
export function mentorTimeZone(v: unknown): string {
  const s = mentorServiceText(v, 80);
  if (!/^(?:UTC|[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(s)) return fail();
  try { new Intl.DateTimeFormat('en', { timeZone: s }).format(0); return s; } catch { return fail(); }
}
function selection<T extends string>(v: unknown, allowed: readonly T[]): readonly T[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length<1 || v.length>allowed.length) return fail();
  const d=Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(d).length!==v.length+1) return fail();
  const values: T[]=[];
  for (let i=0;i<v.length;i++) {
    if (!d[i] || !('value' in d[i]) || !d[i].enumerable || !allowed.includes(d[i].value) || values.includes(d[i].value)) return fail();
    values.push(d[i].value);
  }
  return Object.freeze(allowed.filter(x=>values.includes(x)));
}
export interface MentorProfileCommand {
  readonly operationId:string;readonly recordId:string;readonly expectedRevision:number;readonly mentorId:string;
  readonly displayName:string;readonly timeZone:string;readonly languages:readonly ('zh'|'en')[];readonly services:readonly MentorServiceKind[];
  readonly signedAt:string;readonly conductVersion:typeof MENTOR_CONDUCT_VERSION;readonly agreementEvidenceRef:string;
  readonly confirmSignedConduct:true;readonly confirmConfidentiality:true;readonly confirmEmployerPolicy:true;
}
export function parseMentorProfileCommand(input:unknown):Readonly<MentorProfileCommand> {
  const v=careerRecordObject(input,['operationId','recordId','expectedRevision','mentorId','displayName','timeZone','languages','services',
    'signedAt','conductVersion','agreementEvidenceRef','confirmSignedConduct','confirmConfidentiality','confirmEmployerPolicy']);
  if(v.conductVersion!==MENTOR_CONDUCT_VERSION || v.confirmSignedConduct!==true || v.confirmConfidentiality!==true || v.confirmEmployerPolicy!==true)return fail();
  return Object.freeze({operationId:careerRecordId(v.operationId),recordId:careerRecordId(v.recordId),expectedRevision:mentorServiceInteger(v.expectedRevision,0,2147483646),
    mentorId:careerRecordId(v.mentorId),displayName:mentorServiceText(v.displayName,100),timeZone:mentorTimeZone(v.timeZone),
    languages:selection(v.languages,['zh','en']),services:selection(v.services,MENTOR_SERVICE_KINDS),signedAt:mentorServiceTime(v.signedAt),
    conductVersion:MENTOR_CONDUCT_VERSION,agreementEvidenceRef:careerRecordId(v.agreementEvidenceRef),
    confirmSignedConduct:true,confirmConfidentiality:true,confirmEmployerPolicy:true});
}
export interface MentorSlotCommand {
  readonly operationId:string;readonly recordId:string;readonly expectedRevision:number;readonly profileId:string;readonly profileRevision:number;
  readonly service:MentorServiceKind;readonly startsAt:string;readonly endsAt:string;readonly timeZone:string;
  readonly confirmedAt:string;readonly confirmationEvidenceRef:string;readonly confirmWithMentor:true;
}
export function parseMentorSlotCommand(input:unknown):Readonly<MentorSlotCommand> {
  const v=careerRecordObject(input,['operationId','recordId','expectedRevision','profileId','profileRevision','service','startsAt','endsAt','timeZone',
    'confirmedAt','confirmationEvidenceRef','confirmWithMentor']);
  if(!MENTOR_SERVICE_KINDS.includes(v.service as MentorServiceKind)||v.confirmWithMentor!==true)return fail();
  const startsAt=mentorServiceTime(v.startsAt),endsAt=mentorServiceTime(v.endsAt),duration=Date.parse(endsAt)-Date.parse(startsAt);
  if(duration<60000||duration>240*60000||duration%60000!==0)return fail();
  return Object.freeze({operationId:careerRecordId(v.operationId),recordId:careerRecordId(v.recordId),expectedRevision:mentorServiceInteger(v.expectedRevision,0,2147483646),
    profileId:careerRecordId(v.profileId),profileRevision:mentorServiceInteger(v.profileRevision,1),service:v.service as MentorServiceKind,
    startsAt,endsAt,timeZone:mentorTimeZone(v.timeZone),confirmedAt:mentorServiceTime(v.confirmedAt),
    confirmationEvidenceRef:careerRecordId(v.confirmationEvidenceRef),confirmWithMentor:true});
}
export interface MentorCapacityWithdrawal {
  readonly operationId:string;readonly recordId:string;readonly expectedRevision:number;readonly reason:string;
}
export function parseMentorCapacityWithdrawal(input:unknown):Readonly<MentorCapacityWithdrawal> {
  const v=careerRecordObject(input,['operationId','recordId','expectedRevision','reason']);
  return Object.freeze({operationId:careerRecordId(v.operationId),recordId:careerRecordId(v.recordId),
    expectedRevision:mentorServiceInteger(v.expectedRevision,1,2147483646),reason:mentorServiceText(v.reason,500)});
}
