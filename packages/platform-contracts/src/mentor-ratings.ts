import { careerRecordObject,careerRecordId,CareerRecordInputError } from './career-record-values.ts';
import { mentorServiceInteger,mentorServiceTime } from './mentor-service-offers.ts';
export type MentorRatingCommand=Readonly<{operationId:string;action:'rate';score:number;comment:string|null}>|Readonly<{operationId:string;action:'skip'}>;
export interface MentorRating {readonly sessionId:string;readonly ownerId:string;readonly operationId:string;readonly action:'rate'|'skip';readonly score:number|null;readonly comment:string|null;readonly createdAt:string;}
function comment(v:unknown):string|null{
 if(v===null)return null;
 if(typeof v!=='string'||!v||v.trim()!==v||Array.from(v).length>500||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(v))throw new CareerRecordInputError();return v;
}
export function parseMentorRatingCommand(input:unknown):MentorRatingCommand{
 const raw=careerRecordObject(input,[],['operationId','action','score','comment']);
 if(raw.action==='skip'){const v=careerRecordObject(input,['operationId','action']);return Object.freeze({operationId:careerRecordId(v.operationId),action:'skip'});}
 const v=careerRecordObject(input,['operationId','action','score','comment']);if(v.action!=='rate')throw new CareerRecordInputError();
 return Object.freeze({operationId:careerRecordId(v.operationId),action:'rate',score:mentorServiceInteger(v.score,1,5),comment:comment(v.comment)});
}
export function parseMentorRating(input:unknown):Readonly<MentorRating>{
 const v=careerRecordObject(input,['sessionId','ownerId','operationId','action','score','comment','createdAt']);
 const command=v.action==='skip'?parseMentorRatingCommand({operationId:v.operationId,action:v.action}):parseMentorRatingCommand({operationId:v.operationId,action:v.action,score:v.score,comment:v.comment});
 if(command.action==='skip'&&(v.score!==null||v.comment!==null))throw new CareerRecordInputError();
 return Object.freeze({sessionId:careerRecordId(v.sessionId),ownerId:careerRecordId(v.ownerId),operationId:command.operationId,action:command.action,
  score:command.action==='rate'?command.score:null,comment:command.action==='rate'?command.comment:null,createdAt:mentorServiceTime(v.createdAt)});
}
