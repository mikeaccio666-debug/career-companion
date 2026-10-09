import {careerRecordId,careerRecordObject,CareerRecordInputError} from './career-record-values.ts';
export const FIRST_LETTER_PROGRESS_STATES=Object.freeze(['not_started','prepared','queued','service_unavailable','authorization_required','settings_changed','writing','draft_saved','checking','interrupted','reviewed'] as const);
export interface FirstLetterProgress {
 readonly ownerId:string;readonly companionId:string;readonly welcomeId:string;
 readonly state:typeof FIRST_LETTER_PROGRESS_STATES[number];readonly capturedAt:string;
 /** Internal generation progress never establishes delivery or C7 completion. */
 readonly delivered:false;
}
export function parseFirstLetterProgress(value:unknown):Readonly<FirstLetterProgress>{
 const v=careerRecordObject(value,['ownerId','companionId','welcomeId','state','capturedAt','delivered']);
 if(typeof v.state!=='string'||!FIRST_LETTER_PROGRESS_STATES.includes(v.state as FirstLetterProgress['state'])
  ||v.delivered!==false||typeof v.capturedAt!=='string'||!Number.isFinite(Date.parse(v.capturedAt))
  ||new Date(v.capturedAt).toISOString()!==v.capturedAt)throw new CareerRecordInputError();
 return Object.freeze({ownerId:careerRecordId(v.ownerId),companionId:careerRecordId(v.companionId),welcomeId:careerRecordId(v.welcomeId),
  state:v.state as FirstLetterProgress['state'],capturedAt:v.capturedAt,delivered:false});
}
