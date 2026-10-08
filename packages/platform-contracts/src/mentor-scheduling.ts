import { careerRecordId,careerRecordObject,CareerRecordInputError } from './career-record-values.ts';
import { mentorServiceInteger,mentorServiceText,mentorServiceTime } from './mentor-service-offers.ts';
/** External meeting navigation only: this URL is never fetched or logged by the server. */
export function mentorMeetingUrl(input:unknown):string {
 const text=mentorServiceText(input,2048);let url:URL;try{url=new URL(text);}catch{throw new CareerRecordInputError();}
 const host=url.hostname;
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.href!==text||
  !/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)||
  /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)||/^\d+(?:\.\d+){3}$/.test(host))throw new CareerRecordInputError();
 return text;
}
export interface MentorScheduled {readonly confirmedAt:string;readonly meetingUrl:string;}
export function parseMentorScheduled(input:unknown):Readonly<MentorScheduled>{
 const v=careerRecordObject(input,['confirmedAt','meetingUrl']);return Object.freeze({confirmedAt:mentorServiceTime(v.confirmedAt),meetingUrl:mentorMeetingUrl(v.meetingUrl)});
}
export type MentorSchedulingCommand = Readonly<{
 action:'schedule';operationId:string;sessionId:string;expectedRevision:2;confirmedAt:string;meetingUrl:string;
 userConfirmationRef:string;mentorConfirmationRef:string;confirmWithUser:true;confirmWithMentor:true;
}> | Readonly<{
 action:'cancel_scheduled';operationId:string;sessionId:string;expectedRevision:3;occurredAt:string;evidenceRef:string;confirmRecorded:true;
}>;
export function parseMentorSchedulingCommand(input:unknown):MentorSchedulingCommand{
 const action=careerRecordObject(input,[],['action','operationId','sessionId','expectedRevision','confirmedAt','meetingUrl','userConfirmationRef','mentorConfirmationRef','confirmWithUser','confirmWithMentor','occurredAt','evidenceRef','confirmRecorded']).action;
 if(action==='schedule'){
  const v=careerRecordObject(input,['action','operationId','sessionId','expectedRevision','confirmedAt','meetingUrl','userConfirmationRef','mentorConfirmationRef','confirmWithUser','confirmWithMentor']);
  if(v.expectedRevision!==2||v.confirmWithUser!==true||v.confirmWithMentor!==true)throw new CareerRecordInputError();
  return Object.freeze({action,operationId:careerRecordId(v.operationId),sessionId:careerRecordId(v.sessionId),expectedRevision:2,
   confirmedAt:mentorServiceTime(v.confirmedAt),meetingUrl:mentorMeetingUrl(v.meetingUrl),userConfirmationRef:careerRecordId(v.userConfirmationRef),
   mentorConfirmationRef:careerRecordId(v.mentorConfirmationRef),confirmWithUser:true,confirmWithMentor:true});
 }
 const v=careerRecordObject(input,['action','operationId','sessionId','expectedRevision','occurredAt','evidenceRef','confirmRecorded']);
 if(action!=='cancel_scheduled'||mentorServiceInteger(v.expectedRevision,3,3)!==3||v.confirmRecorded!==true)throw new CareerRecordInputError();
 return Object.freeze({action,operationId:careerRecordId(v.operationId),sessionId:careerRecordId(v.sessionId),expectedRevision:3,
  occurredAt:mentorServiceTime(v.occurredAt),evidenceRef:careerRecordId(v.evidenceRef),confirmRecorded:true});
}
