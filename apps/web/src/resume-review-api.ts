import { careerRecordId,careerRecordObject,parseResumeReviewCommand,parseResumeReviewItem,parseResumeReviewView,type ResumeReviewAction,type ResumeReviewItem,type ResumeReviewView,type ResumeReviewCommand } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api';
function fail():never{throw Error('简历版本暂时无法确认，请重新读取。');}
const canonical=(value:unknown)=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export async function resumePayloadDigest(value:ResumeReviewView['payload']):Promise<string>{const bytes=new TextEncoder().encode(canonical(value)),digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');}
async function view(client:BoundPlatformClient,value:unknown){const v=parseResumeReviewView(value);if(v.item.ownerId!==client.account.accountId||await resumePayloadDigest(v.payload)!==v.item.payloadDigest)return fail();return v;}
export async function readResumeReviews(client:BoundPlatformClient,after:string|null=null,signal?:AbortSignal){
 const v=careerRecordObject(await client.request('/pending-items'+(after?'?after='+careerRecordId(after):''),{signal}),['items','nextAfter']);
 if(!Array.isArray(v.items)||Object.getPrototypeOf(v.items)!==Array.prototype||v.items.length>50)return fail();const d=Object.getOwnPropertyDescriptors(v.items);if(Reflect.ownKeys(d).length!==v.items.length+1)return fail();const items:Readonly<ResumeReviewItem>[]=[];
 for(let i=0;i<v.items.length;i++){if(!d[i]||!('value' in d[i]))return fail();const item=parseResumeReviewItem(d[i].value);if(item.ownerId!==client.account.accountId)return fail();items.push(item);}
 if(new Set(items.map(v=>v.id)).size!==items.length)return fail();const nextAfter=v.nextAfter===null?null:careerRecordId(v.nextAfter);if(nextAfter!==null&&(items.length!==50||items.at(-1)!.id!==nextAfter))return fail();return Object.freeze({items:Object.freeze(items),nextAfter});
}
export async function readResumeReview(client:BoundPlatformClient,id:string,signal?:AbortSignal){const result=await view(client,await client.request('/pending-items/'+careerRecordId(id),{signal}));if(result.item.id!==id)return fail();return result;}
export interface PendingResumeIntent {readonly action:ResumeReviewAction;readonly itemId:string|null;readonly body:Readonly<ResumeReviewCommand>;}
async function result(client:BoundPlatformClient,input:unknown,intent:PendingResumeIntent,observer=false){
 const v=careerRecordObject(input,['view','operation']),op=careerRecordObject(v.operation,['id','itemId','replayed'],observer?['action']:[]);
 if(op.id!==intent.body.operationId||typeof op.replayed!=='boolean'||intent.itemId!==null&&op.itemId!==intent.itemId||observer&&op.action!==intent.action)return fail();careerRecordId(op.itemId);
 const record=v.view===null?null:await view(client,v.view);if(record&&record.item.id!==op.itemId)return fail();if(!op.replayed){
  if(intent.action==='delete'?record!==null:record===null)return fail();
  if(record){const expected=intent.body.expectedRevision+(intent.action==='create'||intent.action==='edit'||intent.action==='reopen'?1:0);if(record.item.revision!==expected||record.item.lastOperationId!==op.id)return fail();
   if(intent.action==='create'||intent.action==='edit'){if(record.item.status!=='pending'||record.item.label!==intent.body.label||record.payload.text!==intent.body.text||intent.action==='create'&&record.item.track!==intent.body.track)return fail();}
   if(intent.action==='approve'&&(record.item.status!=='approved'||record.item.approvedRevision!==intent.body.expectedRevision||record.item.approvedDigest!==intent.body.payloadDigest))return fail();
   if(intent.action==='decline'&&record.item.status!=='declined'||intent.action==='archive'&&record.item.resumeStatus!=='archived'||intent.action==='reopen'&&record.item.status!=='pending')return fail();
  }
 }
 return Object.freeze({view:record,operation:Object.freeze({id:op.id as string,itemId:op.itemId as string,replayed:op.replayed as boolean})});
}
export async function changeResumeReview(client:BoundPlatformClient,intent:PendingResumeIntent,signal?:AbortSignal){
 const command=parseResumeReviewCommand(intent.action,intent.body),id=intent.action==='create'?null:careerRecordId(intent.itemId);
 let path='/career/resume-versions',method='POST',body:unknown=command;
 if(id){path='/pending-items/'+id;if(intent.action==='edit')path+='/revisions';else if(intent.action==='approve'||intent.action==='decline'){path+='/decision';body={operationId:command.operationId,revision:command.expectedRevision,payloadDigest:command.payloadDigest,decision:intent.action};}else if(intent.action==='delete')method='DELETE';else path+='/'+intent.action;}
 return result(client,await client.request(path,{method,body:JSON.stringify(body),signal}),intent);
}
export async function observeResumeIntent(client:BoundPlatformClient,intent:PendingResumeIntent,signal?:AbortSignal){return result(client,await client.request('/pending-items/operations/'+careerRecordId(intent.body.operationId),{signal}),intent,true);}
