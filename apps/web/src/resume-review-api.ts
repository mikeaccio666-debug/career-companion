import { careerRecordId,careerRecordObject,parseResumeReviewCommand,parseResumeUploadCommand,parseResumeReviewItem,parseResumeReviewView,type ResumeReviewAction,type ResumeReviewItem,type ResumeReviewView,type ResumeReviewCommand } from '@companion/platform-contracts';
import { ApiError,type BoundPlatformClient } from './api.ts';
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
export interface PendingResumeIntent {readonly action:ResumeReviewAction;readonly itemId:string|null;readonly body:Readonly<ResumeReviewCommand>;readonly source?:'upload';}
async function result(client:BoundPlatformClient,input:unknown,intent:PendingResumeIntent,observer=false){
 const v=careerRecordObject(input,['view','operation']),op=careerRecordObject(v.operation,['id','itemId','replayed'],observer?['action']:[]);
 if(op.id!==intent.body.operationId||typeof op.replayed!=='boolean'||intent.itemId!==null&&op.itemId!==intent.itemId||observer&&op.action!==intent.action)return fail();careerRecordId(op.itemId);
 const record=v.view===null?null:await view(client,v.view);if(record&&record.item.id!==op.itemId)return fail();if(!op.replayed){
  if(intent.action==='delete'?record!==null:record===null)return fail();
  if(record){const expected=intent.body.expectedRevision+(intent.action==='create'||intent.action==='edit'||intent.action==='reopen'?1:0);if(record.item.revision!==expected||record.item.lastOperationId!==op.id)return fail();
   if(intent.action==='create'||intent.action==='edit'){if(record.item.status!=='pending'||record.item.label!==intent.body.label||intent.action==='create'&&record.item.track!==intent.body.track)return fail();if(intent.source==='upload'){const command=parseResumeUploadCommand(intent.body);if(record.item.source!=='upload'||record.item.uploadId!==command.uploadId||command.sha256!==undefined&&record.item.uploadSource?.sha256!==command.sha256)return fail();}else if(record.payload.text!==intent.body.text)return fail();}
   if(intent.action==='approve'&&(record.item.status!=='approved'||record.item.approvedRevision!==intent.body.expectedRevision||record.item.approvedDigest!==intent.body.payloadDigest))return fail();
   if(intent.action==='decline'&&record.item.status!=='declined'||intent.action==='archive'&&record.item.resumeStatus!=='archived'||intent.action==='reopen'&&record.item.status!=='pending')return fail();
  }
 }
 return Object.freeze({view:record,operation:Object.freeze({id:op.id as string,itemId:op.itemId as string,replayed:op.replayed as boolean})});
}
export async function changeResumeReview(client:BoundPlatformClient,intent:PendingResumeIntent,signal?:AbortSignal){
 if(intent.source==='upload'&&(intent.action!=='create'||intent.itemId!==null))return fail();
 const command:Readonly<ResumeReviewCommand>=intent.source==='upload'?parseResumeUploadCommand(intent.body):parseResumeReviewCommand(intent.action,intent.body),id=intent.action==='create'?null:careerRecordId(intent.itemId);
 let path=intent.source==='upload'?'/career/resume-versions/from-upload':'/career/resume-versions',method='POST',body:unknown=command;
 if(id){path='/pending-items/'+id;if(intent.action==='edit')path+='/revisions';else if(intent.action==='approve'||intent.action==='decline'){path+='/decision';body={operationId:command.operationId,revision:command.expectedRevision,payloadDigest:command.payloadDigest,decision:intent.action};}else if(intent.action==='delete')method='DELETE';else path+='/'+intent.action;}
 return result(client,await client.request(path,{method,body:JSON.stringify(body),signal}),intent);
}
export async function observeResumeIntent(client:BoundPlatformClient,intent:PendingResumeIntent,signal?:AbortSignal){return result(client,await client.request('/pending-items/operations/'+careerRecordId(intent.body.operationId),{signal}),intent,true);}

export interface OwnedResumeUpload {readonly id:string;readonly name:string;readonly mime:string;readonly size:number;readonly createdAt:string;}
export async function readOwnedResumeUploads(client:BoundPlatformClient,after:string|null=null,signal?:AbortSignal){
 const r=careerRecordObject(await client.request('/career/resume-uploads'+(after?'?after='+careerRecordId(after):''),{signal}),['files','nextAfter']);if(!Array.isArray(r.files)||Object.getPrototypeOf(r.files)!==Array.prototype||r.files.length>50)return fail();const descriptors=Object.getOwnPropertyDescriptors(r.files);if(Reflect.ownKeys(descriptors).length!==r.files.length+1)return fail();const files:Readonly<OwnedResumeUpload>[]=[];for(let i=0;i<r.files.length;i++){const d=descriptors[i];if(!d||!('value' in d)||!d.enumerable)return fail();const value:unknown=d.value;const v=careerRecordObject(value,['id','name','mime','size','createdAt']);if(typeof v.name!=='string'||!v.name.length||v.name.length>200||/[\x00-\x1f\x7f]/.test(v.name)||!['application/pdf','text/plain','text/markdown'].includes(v.mime as string)||typeof v.size!=='number'||!Number.isSafeInteger(v.size)||v.size<1||v.size>20*1024*1024||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||new Date(v.createdAt).toISOString()!==v.createdAt)return fail();files.push(Object.freeze({id:careerRecordId(v.id),name:v.name,mime:v.mime as string,size:v.size,createdAt:v.createdAt}));}if(new Set(files.map(v=>v.id)).size!==files.length)return fail();const nextAfter=r.nextAfter===null?null:careerRecordId(r.nextAfter);if(nextAfter!==null&&(files.length!==50||files.at(-1)!.id!==nextAfter))return fail();return {files:Object.freeze(files),nextAfter};
}
export async function uploadOriginalResumeFile(client:BoundPlatformClient,file:File,signal?:AbortSignal){
 const extensions:Record<string,string>={pdf:'application/pdf',txt:'text/plain',md:'text/markdown'},mime=extensions[file.name.split('.').at(-1)?.toLowerCase()??''];if(!mime||!file.name.length||file.name.length>200||/[\x00-\x1f\x7f]/.test(file.name)||file.size<1||file.size>20*1024*1024)throw new ApiError('请选择 20 MB 以内的 PDF、TXT 或 Markdown。',400);
 let data:FormData,sha256:string;try{signal?.throwIfAborted();const bytes=await file.arrayBuffer();signal?.throwIfAborted();if(!client.isCurrent())throw Error('Stale selection.');const raw=await crypto.subtle.digest('SHA-256',bytes);sha256=[...new Uint8Array(raw)].map(v=>v.toString(16).padStart(2,'0')).join('');signal?.throwIfAborted();data=new FormData();data.append('file',new Blob([bytes],{type:mime}),file.name);}catch{throw new ApiError('上传尚未发送。文件未能在本机完成读取，请重新选择。',400);}
 const r=careerRecordObject(await client.request('/uploads',{method:'POST',body:data,signal}),['attachment']),v=careerRecordObject(r.attachment,['id','name','mime','size','url']);const id=careerRecordId(v.id);if(v.mime!==mime||v.size!==file.size||typeof v.name!=='string'||!v.name.length||v.name.length>200||v.url!=='/api/platform/uploads/'+id)return fail();return {id,sha256};
}
