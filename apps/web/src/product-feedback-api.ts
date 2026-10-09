import {careerRecordId,careerRecordObject,parseFeedbackSubmission,parseProductFeedback,type ProductFeedback} from '@companion/platform-contracts';
export interface FeedbackClient {readonly account:{readonly accountId:string};isCurrent():boolean;subscribe(fn:()=>void):()=>void;request<T>(path:string,init?:RequestInit):Promise<T>;}
export type FeedbackSubmission=ReturnType<typeof parseFeedbackSubmission>;
export interface FeedbackAvailability {readonly available:boolean;readonly recipient:Readonly<{id:string;name:string}>|null;}
export interface FeedbackPage {readonly records:readonly Readonly<ProductFeedback>[];readonly nextCursor:string|null;}
const root='/feedback',fail=():never=>{throw Error('反馈暂时无法确认，请重新读取。');};
function current(c:FeedbackClient,s?:AbortSignal){s?.throwIfAborted();if(!c.isCurrent())fail();}
function owned(c:FeedbackClient,v:unknown){const p=parseProductFeedback(v);if(p.ownerId!==c.account.accountId)fail();return p;}
export async function feedbackAvailability(c:FeedbackClient,signal?:AbortSignal):Promise<Readonly<FeedbackAvailability>>{
 current(c,signal);const raw=await c.request(root+'/availability',{signal,cache:'no-store'});current(c,signal);
 const v=careerRecordObject(raw,['available','recipient']);if(typeof v.available!=='boolean'||v.available===(v.recipient===null))fail();
 if(!v.available)return Object.freeze({available:false,recipient:null});
 const r=careerRecordObject(v.recipient,['id','name']);if(typeof r.name!=='string'||!r.name.trim()||r.name.length>200)fail();
 return Object.freeze({available:true,recipient:Object.freeze({id:careerRecordId(r.id),name:r.name as string})});
}
export async function readFeedbackPage(c:FeedbackClient,after:string|null=null,signal?:AbortSignal):Promise<Readonly<FeedbackPage>>{
 const cursor=after===null?null:careerRecordId(after);current(c,signal);
 const raw=await c.request(root+(cursor?'?after='+encodeURIComponent(cursor):''),{signal,cache:'no-store'});current(c,signal);
 const v=careerRecordObject(raw,['records','nextCursor']);if(!Array.isArray(v.records)||v.records.length>50)fail();
 const records=(v.records as unknown[]).map(x=>owned(c,x));let previous=cursor;
 for(const p of records){if(previous!==null&&p.id<=previous)fail();previous=p.id;}
 const next=v.nextCursor===null?null:careerRecordId(v.nextCursor);
 if(next!==null&&(records.length!==50||next!==records.at(-1)?.id))fail();
 return Object.freeze({records:Object.freeze(records),nextCursor:next});
}
export async function readFeedback(c:FeedbackClient,id:string,signal?:AbortSignal){
 const key=careerRecordId(id);current(c,signal);const raw=await c.request(root+'/'+key,{signal,cache:'no-store'});current(c,signal);
 const p=owned(c,raw);if(p.id!==key)fail();return p;
}
export async function submitFeedback(c:FeedbackClient,input:unknown,signal?:AbortSignal,observe=false){
 const body=parseFeedbackSubmission(input);current(c,signal);
 const raw=await c.request(root+(observe?'/operations/'+body.operationId:''),observe?{signal,cache:'no-store'}:{signal,cache:'no-store',method:'POST',body:JSON.stringify(body)});
 current(c,signal);
 const v=careerRecordObject(raw,['feedback','operation']),p=owned(c,v.feedback),op=careerRecordObject(v.operation,['id','appliedRevision','replayed']);
 if(careerRecordId(op.id)!==body.operationId||op.appliedRevision!==1||typeof op.replayed!=='boolean'||observe&&!op.replayed||!op.replayed&&p.revision!==1
  ||p.revision===1&&p.lastOperationId!==body.operationId||p.organizationId!==body.recipientId||p.category!==body.category||p.surface!==body.surface||p.description!==body.description||p.sharedExcerpt!==body.sharedExcerpt)fail();
 return Object.freeze({feedback:p,operation:Object.freeze({id:body.operationId,appliedRevision:1,replayed:op.replayed})});
}
