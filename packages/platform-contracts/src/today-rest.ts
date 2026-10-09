import { careerRecordObject as object, careerRecordId as id, CareerRecordInputError } from './career-record-values.ts';
export type TodayRestChoice = 'today' | '1_day' | '3_days' | '7_days' | 'reminders_off';
export interface TodayRestSettings {
 readonly ownerId:string; readonly companionId:string; readonly revision:number; readonly updatedAt:string|null; readonly lastOperationId:string|null;
 readonly timeZone:string|null; readonly optedOutDate:string|null; readonly optedOutUntil:string|null; readonly pauseUntil:string|null; readonly reminders:'keep'|'off';
}
export interface TodayRestCommand { readonly companionId:string; readonly operationId:string; readonly expectedRevision:number; readonly choice:TodayRestChoice; }
export interface TodayRestResult { readonly settings:Readonly<TodayRestSettings>; readonly operation:{ readonly id:string; readonly appliedRevision:number; readonly choice:TodayRestChoice; readonly replayed:boolean; }; }
const fail=():never=>{throw new CareerRecordInputError();};
function revision(v:unknown,max=2147483647):number {if(typeof v!=='number'||!Number.isSafeInteger(v)||Object.is(v,-0)||v<0||v>max)return fail();return v;}
function iso(v:unknown):string|null {if(v===null)return null;if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)return fail();return v;}
export function parseTodayRestChoice(v:unknown):TodayRestChoice {if(!['today','1_day','3_days','7_days','reminders_off'].includes(v as string))return fail();return v as TodayRestChoice;}
export function parseTodayRestSettings(value:unknown):Readonly<TodayRestSettings> {
 const v=object(value,['ownerId','companionId','revision','updatedAt','lastOperationId','timeZone','optedOutDate','optedOutUntil','pauseUntil','reminders']),rev=revision(v.revision);
 const updatedAt=iso(v.updatedAt),optedOutUntil=iso(v.optedOutUntil),pauseUntil=iso(v.pauseUntil);
 if(v.reminders!=='keep'&&v.reminders!=='off')return fail();
 if(rev===0){if(updatedAt!==null||v.lastOperationId!==null||v.timeZone!==null||v.optedOutDate!==null||optedOutUntil!==null||pauseUntil!==null||v.reminders!=='keep')return fail();}
 else {
  if(!updatedAt||typeof v.timeZone!=='string'||v.timeZone.length>100)return fail();
  try{new Intl.DateTimeFormat('en-US',{timeZone:v.timeZone}).format(0);}catch{return fail();}
  if(!optedOutUntil&&!pauseUntil)return fail();
 }
 if((v.optedOutDate===null)!==(optedOutUntil===null))return fail();
 if(v.optedOutDate!==null&&(typeof v.optedOutDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v.optedOutDate)||!Number.isFinite(Date.parse(v.optedOutDate+'T00:00:00.000Z'))||new Date(v.optedOutDate+'T00:00:00.000Z').toISOString().slice(0,10)!==v.optedOutDate))return fail();
 return Object.freeze({ownerId:id(v.ownerId),companionId:id(v.companionId),revision:rev,updatedAt,lastOperationId:rev?id(v.lastOperationId):null,timeZone:v.timeZone as string|null,optedOutDate:v.optedOutDate as string|null,optedOutUntil,pauseUntil,reminders:v.reminders});
}
export function parseTodayRestCommand(value:unknown):Readonly<TodayRestCommand> {
 const v=object(value,['companionId','operationId','expectedRevision','choice']);
 return Object.freeze({companionId:id(v.companionId),operationId:id(v.operationId),expectedRevision:revision(v.expectedRevision,2147483646),choice:parseTodayRestChoice(v.choice)});
}
