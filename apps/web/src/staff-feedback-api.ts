import {careerRecordId,careerRecordObject,parseFeedbackUpdate,parseProductFeedback,FEEDBACK_STATUSES,type FeedbackStatus} from '@companion/platform-contracts';
import type {FeedbackClient} from './product-feedback-api.ts';
export const isStaffFeedbackPath=(path:string)=>path==='/staff/feedback';
export type StaffFeedbackCommand=ReturnType<typeof parseFeedbackUpdate>;
const root='/staff/feedback',fail=():never=>{throw Error('无法确认反馈收件箱，请重新读取。');};
function current(c:FeedbackClient,s?:AbortSignal){s?.throwIfAborted();if(!c.isCurrent())fail();}
function envelope(c:FeedbackClient,raw:unknown,fields:string[]){
 const v=careerRecordObject(raw,['actorId','organizationId',...fields]);
 if(careerRecordId(v.actorId)!==c.account.accountId)fail();
 return {v,org:careerRecordId(v.organizationId)};
}
function record(raw:unknown,org:string,id?:string){const p=parseProductFeedback(raw);if(p.organizationId!==org||id&&p.id!==id)fail();return p;}
export async function readStaffFeedbackPage(c:FeedbackClient,status:FeedbackStatus|null,after:string|null=null,signal?:AbortSignal){
 if(status!==null&&!FEEDBACK_STATUSES.includes(status))fail();
 const cursor=after===null?null:careerRecordId(after),query=new URLSearchParams();
 if(status)query.set('status',status);if(cursor)query.set('after',cursor);
 current(c,signal);const raw=await c.request(root+(query.size?'?'+query:''),{signal,cache:'no-store'});current(c,signal);
 const {v,org}=envelope(c,raw,['records','nextCursor']);if(!Array.isArray(v.records)||v.records.length>50)fail();
 const records=(v.records as unknown[]).map(x=>record(x,org));let previous=cursor;
 for(const p of records){if(previous!==null&&p.id<=previous||status&&p.status!==status)fail();previous=p.id;}
 const next=v.nextCursor===null?null:careerRecordId(v.nextCursor);
 if(next!==null&&(records.length!==50||next!==records.at(-1)?.id))fail();
 return Object.freeze({organizationId:org,records:Object.freeze(records),nextCursor:next});
}
export async function readStaffFeedback(c:FeedbackClient,id:string,signal?:AbortSignal){
 const key=careerRecordId(id);current(c,signal);const raw=await c.request(root+'/'+key,{signal,cache:'no-store'});current(c,signal);
 const {v,org}=envelope(c,raw,['feedback']);return record(v.feedback,org,key);
}
export async function updateStaffFeedback(c:FeedbackClient,id:string,organizationId:string,input:unknown,signal?:AbortSignal,observe=false){
 const key=careerRecordId(id),expectedOrg=careerRecordId(organizationId),body=parseFeedbackUpdate(input);current(c,signal);
 const raw=await c.request(root+'/'+key+(observe?'/operations/'+body.operationId:''),observe?{signal,cache:'no-store'}:{signal,cache:'no-store',method:'PATCH',body:JSON.stringify(body)});current(c,signal);
 const {v,org}=envelope(c,raw,['feedback','operation']);if(org!==expectedOrg)fail();
 const p=record(v.feedback,org,key),op=careerRecordObject(v.operation,['id','appliedRevision','replayed']);
 const entry=p.updates.find(u=>u.revision===body.expectedRevision+1);
 if(careerRecordId(op.id)!==body.operationId||op.appliedRevision!==body.expectedRevision+1||typeof op.replayed!=='boolean'||observe&&!op.replayed
  ||!entry||entry.status!==body.status||entry.triage!==body.triage||entry.reply!==body.reply
  ||!op.replayed&&p.revision!==op.appliedRevision||p.revision===op.appliedRevision&&p.lastOperationId!==body.operationId)fail();
 return p;
}
