import { careerRecordId,careerRecordObject,parseUploadRemovalCommand,parseUploadRemovalReceipt,type UploadRemovalReceipt } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
export interface UploadRemovalIntent {readonly uploadId:string;readonly operationId:string;}
function receipt(client:BoundPlatformClient,value:unknown,id?:string){const r=parseUploadRemovalReceipt(value);if(r.ownerId!==client.account.accountId||id!==undefined&&r.uploadId!==id)throw Error('文件清理记录不匹配，请重新查看。');return r;}
export async function removeUpload(client:BoundPlatformClient,intent:UploadRemovalIntent,signal?:AbortSignal){const id=careerRecordId(intent.uploadId),command=parseUploadRemovalCommand({operationId:intent.operationId});return receipt(client,await client.request('/uploads/'+id,{method:'DELETE',body:JSON.stringify(command),signal}),id);}
export async function readUploadRemoval(client:BoundPlatformClient,id:string,signal?:AbortSignal){return receipt(client,await client.request('/uploads/'+careerRecordId(id)+'/removal',{signal}),id);}
export async function readUploadRemovals(client:BoundPlatformClient,after:string|null=null,signal?:AbortSignal){
 const v=careerRecordObject(await client.request('/upload-removals'+(after?'?after='+careerRecordId(after):''),{signal}),['receipts','nextAfter']);if(!Array.isArray(v.receipts)||Object.getPrototypeOf(v.receipts)!==Array.prototype||v.receipts.length>50)throw Error('文件清理记录暂时无法确认。');const d=Object.getOwnPropertyDescriptors(v.receipts);if(Reflect.ownKeys(d).length!==v.receipts.length+1)throw Error('文件清理记录暂时无法确认。');const receipts:Readonly<UploadRemovalReceipt>[]=[];
 for(let i=0;i<v.receipts.length;i++){const row=d[i];if(!row||!('value' in row)||!row.enumerable)throw Error('文件清理记录暂时无法确认。');receipts.push(receipt(client,row.value));}
 if(new Set(receipts.map(r=>r.uploadId)).size!==receipts.length)throw Error('文件清理记录重复。');const nextAfter=v.nextAfter===null?null:careerRecordId(v.nextAfter);if(nextAfter!==null&&(receipts.length!==50||receipts.at(-1)!.uploadId!==nextAfter))throw Error('文件清理分页暂时无法确认。');return {receipts:Object.freeze(receipts),nextAfter};
}
