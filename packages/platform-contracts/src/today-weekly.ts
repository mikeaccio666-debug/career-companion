import { careerRecordId, careerRecordObject, CareerRecordInputError } from './career-record-values.ts';
import { agendaLocalDate } from './today-agenda.ts';
export interface TodayWeekWindow { readonly capturedAt: string; readonly timeZone: string; readonly weekStart: string; readonly localDate: string; }
export interface TodayWeeklyActivity extends TodayWeekWindow {
 readonly ownerId: string; readonly companionId: string;
 readonly storiesEdited: number; readonly resumesConfirmed: number; readonly practiceQuestions: null;
 readonly coverage: readonly ['retained_story_edits', 'retained_resume_approvals'];
}
const fail=():never=>{throw new CareerRecordInputError();};
/** Monday through the current local date; no fixed 168-hour assumption. */
export function todayWeekWindow(capturedAt:string,timeZone:string):Readonly<TodayWeekWindow>{
 if(typeof capturedAt!=='string'||!Number.isFinite(Date.parse(capturedAt))||new Date(capturedAt).toISOString()!==capturedAt
  ||typeof timeZone!=='string'||!timeZone||timeZone.length>100||/^[+-]/.test(timeZone))return fail();
 let localDate:string;try{localDate=agendaLocalDate(capturedAt,timeZone);}catch{return fail();}
 const date=new Date(localDate+'T12:00:00.000Z'),days=(date.getUTCDay()+6)%7;
 date.setUTCDate(date.getUTCDate()-days);
 return Object.freeze({capturedAt,timeZone,localDate,weekStart:date.toISOString().slice(0,10)});
}
export function parseTodayWeeklyActivity(value:unknown):Readonly<TodayWeeklyActivity>{
 const v=careerRecordObject(value,['ownerId','companionId','capturedAt','timeZone','weekStart','localDate','storiesEdited','resumesConfirmed','practiceQuestions','coverage']);
 const window=todayWeekWindow(v.capturedAt as string,v.timeZone as string);
 if(window.weekStart!==v.weekStart||window.localDate!==v.localDate||v.practiceQuestions!==null)return fail();
 for(const count of [v.storiesEdited,v.resumesConfirmed])
  if(!Number.isSafeInteger(count)||(count as number)<0||(count as number)>500||Object.is(count,-0))return fail();
 if(!Array.isArray(v.coverage)||Object.getPrototypeOf(v.coverage)!==Array.prototype||Reflect.ownKeys(v.coverage).length!==3)return fail();
 const descriptors=Object.getOwnPropertyDescriptors(v.coverage);
 if(!descriptors[0]||!descriptors[1]||!('value' in descriptors[0])||!('value' in descriptors[1])
  ||descriptors[0].value!=='retained_story_edits'||descriptors[1].value!=='retained_resume_approvals')return fail();
 return Object.freeze({...window,ownerId:careerRecordId(v.ownerId),companionId:careerRecordId(v.companionId),
  storiesEdited:v.storiesEdited as number,resumesConfirmed:v.resumesConfirmed as number,practiceQuestions:null,
  coverage:Object.freeze(['retained_story_edits','retained_resume_approvals'] as const)});
}
