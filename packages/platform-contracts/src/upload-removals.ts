import { careerRecordId,careerRecordObject } from './career-record-values.ts';
import { careerLibraryTime } from './career-stories.ts';
export interface UploadRemovalReceipt {readonly ownerId:string;readonly name:string;readonly uploadId:string;readonly operationId:string;readonly status:'pending'|'removed';readonly requestedAt:string;readonly removedAt:string|null;}
export function parseUploadRemovalCommand(value:unknown){const v=careerRecordObject(value,['operationId']);return Object.freeze({operationId:careerRecordId(v.operationId)});}
export function parseUploadRemovalReceipt(value:unknown):Readonly<UploadRemovalReceipt>{
 const v=careerRecordObject(value,['ownerId','name','uploadId','operationId','status','requestedAt','removedAt']);
 if(typeof v.name!=='string'||!v.name.length||v.name.length>200||/[\x00-\x1f\x7f]/.test(v.name)||!['pending','removed'].includes(v.status as string))throw Error('Invalid file removal state.');
 const requestedAt=careerLibraryTime(v.requestedAt),removedAt=v.removedAt===null?null:careerLibraryTime(v.removedAt);
 if((v.status==='removed')!==(removedAt!==null)||removedAt!==null&&removedAt<requestedAt)throw Error('Invalid file removal receipt.');
 return Object.freeze({ownerId:careerRecordId(v.ownerId),name:v.name as string,uploadId:careerRecordId(v.uploadId),operationId:careerRecordId(v.operationId),status:v.status as UploadRemovalReceipt['status'],requestedAt,removedAt});
}
