import { CAREER_ROLE_FAMILIES,careerRecordObject,careerRecordId,type CareerRoleFamily } from './career-record-values.ts';
import { careerLibraryText,careerLibraryTime } from './career-stories.ts';
export const RESUME_REVIEW_STATES=Object.freeze(['pending','approved','declined','expired','superseded'] as const);
export type ResumeReviewStatus=typeof RESUME_REVIEW_STATES[number];
export type ResumeReviewAction='create'|'edit'|'approve'|'decline'|'reopen'|'archive'|'delete';
export interface ResumeSourceRef {readonly kind:'owner_resume_input';readonly id:string;readonly revision:1;}
export interface ResumeUploadSourceRef {readonly kind:'resume_upload';readonly id:string;readonly sha256:string;readonly storageVersion:string;}
export interface ResumeUploadSnapshot {readonly uploadId:string;readonly storageVersion:string;readonly byteSize:number;readonly sha256:string;readonly textSha256:string;readonly parser:'utf8'|'pdftotext';readonly engineVersion:string;}
export interface ResumeUploadCommand {readonly operationId:string;readonly expectedRevision:0;readonly track:CareerRoleFamily;readonly label:string;readonly uploadId:string;readonly sha256?:string;}
export interface ResumeDependency {readonly id:string;readonly pendingItemId:string;readonly revision:number;readonly approvedDigest:string;}
export interface ResumeReviewPayload {readonly text:string;readonly claims:readonly never[];readonly source_refs:readonly [Readonly<ResumeSourceRef>,Readonly<ResumeUploadSourceRef>?];}
export interface ResumeReviewItem {
 readonly id:string;readonly ownerId:string;readonly resumeVersionId:string;readonly kind:'resume_version';readonly finalAction:'none';readonly draftedBy:null;
 readonly title:'简历版本';readonly label:string;readonly track:CareerRoleFamily;readonly sequence:number;readonly source:'paste'|'derived'|'upload';readonly uploadId:string|null;readonly uploadSource?:Readonly<ResumeUploadSnapshot>;readonly derivedFrom:Readonly<ResumeDependency>|null;
 readonly status:ResumeReviewStatus;readonly resumeStatus:'draft'|'active'|'archived';readonly revision:number;readonly generation:number;readonly payloadDigest:string;readonly sensitivity:'sensitive';
 readonly approvedRevision:number|null;readonly approvedDigest:string|null;readonly approvedAt:string|null;readonly approvedChannel:'web'|null;readonly approvalOperationId:string|null;
 readonly supersededBy:string|null;readonly expiresAt:string;readonly createdAt:string;readonly updatedAt:string;readonly lastOperationId:string;
}
export interface ResumeReviewView {readonly item:Readonly<ResumeReviewItem>;readonly payload:Readonly<ResumeReviewPayload>;}
export interface ResumeReviewCommand {readonly operationId:string;readonly expectedRevision:number;readonly payloadDigest?:string;readonly track?:CareerRoleFamily;readonly label?:string;readonly text?:string;readonly derivedFromId?:string;}
export function resumeReviewInteger(v:unknown,min=1):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||Object.is(v,-0)||v<min||v>2147483647)throw Error('Invalid resume version.');return v;}
export function resumeReviewDigest(v:unknown):string{if(typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v))throw Error('Invalid resume digest.');return v;}
function track(v:unknown):CareerRoleFamily{if(!CAREER_ROLE_FAMILIES.includes(v as CareerRoleFamily))throw Error('Choose a role family.');return v as CareerRoleFamily;}
export function parseResumeUploadSnapshot(value:unknown):Readonly<ResumeUploadSnapshot>{
 const v=careerRecordObject(value,['uploadId','storageVersion','byteSize','sha256','textSha256','parser','engineVersion']);
 if(typeof v.storageVersion!=='string'||!/^"[\x21\x23-\x7e]{0,200}"$/.test(v.storageVersion)||typeof v.byteSize!=='number'||!Number.isSafeInteger(v.byteSize)||v.byteSize<1||v.byteSize>20*1024*1024||!['utf8','pdftotext'].includes(v.parser as string)||typeof v.engineVersion!=='string'||!/^\d+\.\d+\.\d+(?:[a-z0-9.-]{0,20})$/.test(v.engineVersion))throw Error('Invalid uploaded original snapshot.');
 return Object.freeze({uploadId:careerRecordId(v.uploadId),storageVersion:v.storageVersion,byteSize:v.byteSize,sha256:resumeReviewDigest(v.sha256),textSha256:resumeReviewDigest(v.textSha256),parser:v.parser as ResumeUploadSnapshot['parser'],engineVersion:v.engineVersion});
}
export function parseResumeUploadCommand(value:unknown):Readonly<ResumeUploadCommand>{
 const v=careerRecordObject(value,['operationId','expectedRevision','track','label','uploadId'],['sha256']);if(v.expectedRevision!==0||Object.is(v.expectedRevision,-0))throw Error('Use an initial uploaded original.');
 return Object.freeze({operationId:careerRecordId(v.operationId),expectedRevision:0,track:track(v.track),label:careerLibraryText(v.label,120),uploadId:careerRecordId(v.uploadId),...(Object.hasOwn(v,'sha256')?{sha256:resumeReviewDigest(v.sha256)}:{})});
}
function dep(v:unknown):Readonly<ResumeDependency>|null{if(v===null)return null;const d=careerRecordObject(v,['id','pendingItemId','revision','approvedDigest']);return Object.freeze({id:careerRecordId(d.id),pendingItemId:careerRecordId(d.pendingItemId),revision:resumeReviewInteger(d.revision),approvedDigest:resumeReviewDigest(d.approvedDigest)});}
export function parseResumeReviewCommand(action:ResumeReviewAction,value:unknown):Readonly<ResumeReviewCommand>{
 if(!['create','edit','approve','decline','reopen','archive','delete'].includes(action))throw Error('Unsupported resume action.');
 const fields=action==='create'?['track','label','text']:action==='edit'?['label','text','payloadDigest']:['payloadDigest'];
 const v=careerRecordObject(value,['operationId','expectedRevision',...fields],action==='create'?['derivedFromId']:[]);
 const r:ResumeReviewCommand={operationId:careerRecordId(v.operationId),expectedRevision:resumeReviewInteger(v.expectedRevision,action==='create'?0:1)};
 if(action==='create'&&r.expectedRevision!==0)throw Error('Use an initial draft version.');
 return Object.freeze({...r,...(action==='create'?{track:track(v.track),label:careerLibraryText(v.label,120),text:careerLibraryText(v.text,50000,true),...(Object.hasOwn(v,'derivedFromId')?{derivedFromId:careerRecordId(v.derivedFromId)}:{})}:action==='edit'?{label:careerLibraryText(v.label,120),text:careerLibraryText(v.text,50000,true),payloadDigest:resumeReviewDigest(v.payloadDigest)}:{payloadDigest:resumeReviewDigest(v.payloadDigest)})});
}
export function parseResumeReviewPayload(value:unknown):Readonly<ResumeReviewPayload>{
 const v=careerRecordObject(value,['text','claims','source_refs']);
 if(!Array.isArray(v.claims)||Object.getPrototypeOf(v.claims)!==Array.prototype||v.claims.length!==0||Reflect.ownKeys(v.claims).length!==1)throw Error('Owner originals cannot include model claims.');
 if(!Array.isArray(v.source_refs)||Object.getPrototypeOf(v.source_refs)!==Array.prototype||![1,2].includes(v.source_refs.length)||Reflect.ownKeys(v.source_refs).length!==v.source_refs.length+1)throw Error('Use an actual owner input and optional upload snapshot.');
 const descriptors=Object.getOwnPropertyDescriptors(v.source_refs);if(!descriptors[0]||!('value' in descriptors[0])||!descriptors[0].enumerable)throw Error('Use an actual owner input.');
 const ref=careerRecordObject(descriptors[0].value,['kind','id','revision']);if(ref.kind!=='owner_resume_input'||ref.revision!==1)throw Error('Use the original input revision.');
 const first=Object.freeze({kind:'owner_resume_input' as const,id:careerRecordId(ref.id),revision:1 as const});
 let second:Readonly<ResumeUploadSourceRef>|undefined;
 if(v.source_refs.length===2){const d=descriptors[1];if(!d||!('value' in d)||!d.enumerable)throw Error('Use a captured upload reference.');const r=careerRecordObject(d.value,['kind','id','sha256','storageVersion']);if(r.kind!=='resume_upload'||typeof r.storageVersion!=='string'||!/^"[\x21\x23-\x7e]{0,200}"$/.test(r.storageVersion))throw Error('Invalid upload reference.');second=Object.freeze({kind:'resume_upload',id:careerRecordId(r.id),sha256:resumeReviewDigest(r.sha256),storageVersion:r.storageVersion});}
 const refs:readonly [Readonly<ResumeSourceRef>,Readonly<ResumeUploadSourceRef>?]=second?Object.freeze([first,second]):Object.freeze([first]);
 return Object.freeze({text:careerLibraryText(v.text,50000,true),claims:Object.freeze([]) as readonly never[],source_refs:refs});
}
const itemFields=['id','ownerId','resumeVersionId','kind','finalAction','draftedBy','title','label','track','sequence','source','uploadId','derivedFrom','status','resumeStatus','revision','generation','payloadDigest','sensitivity','approvedRevision','approvedDigest','approvedAt','approvedChannel','approvalOperationId','supersededBy','expiresAt','createdAt','updatedAt','lastOperationId'] as const;
export function parseResumeReviewItem(value:unknown):Readonly<ResumeReviewItem>{
 const v=careerRecordObject(value,itemFields,['uploadSource']);
 if(v.kind!=='resume_version'||v.finalAction!=='none'||v.draftedBy!==null||v.title!=='简历版本'||v.sensitivity!=='sensitive'||!['paste','derived','upload'].includes(v.source as string)||!RESUME_REVIEW_STATES.includes(v.status as ResumeReviewStatus)||!['draft','active','archived'].includes(v.resumeStatus as string))throw Error('Invalid resume review state.');
 const id=careerRecordId(v.id),ownerId=careerRecordId(v.ownerId),resumeVersionId=careerRecordId(v.resumeVersionId),revision=resumeReviewInteger(v.revision),generation=resumeReviewInteger(v.generation),sequence=resumeReviewInteger(v.sequence),derivedFrom=dep(v.derivedFrom);
 if(generation<revision||(v.source==='derived')!==(derivedFrom!==null))throw Error('Invalid resume lineage.');
 const uploadId=v.uploadId===null?null:careerRecordId(v.uploadId),uploadSource=Object.hasOwn(v,'uploadSource')?parseResumeUploadSnapshot(v.uploadSource):undefined;
 if(v.source==='upload'?uploadId===null||uploadSource?.uploadId!==uploadId:uploadId!==null||uploadSource!==undefined)throw Error('Invalid original upload source.');
 const payloadDigest=resumeReviewDigest(v.payloadDigest),createdAt=careerLibraryTime(v.createdAt),updatedAt=careerLibraryTime(v.updatedAt),expiresAt=careerLibraryTime(v.expiresAt);
 if(updatedAt<createdAt||expiresAt<createdAt)throw Error('Invalid review times.');
 let approvedRevision:number|null=null,approvedDigest:string|null=null,approvedAt:string|null=null,approvedChannel:'web'|null=null,approvalOperationId:string|null=null;
 if(v.status==='approved'){
  approvedRevision=resumeReviewInteger(v.approvedRevision);approvedDigest=resumeReviewDigest(v.approvedDigest);approvedAt=careerLibraryTime(v.approvedAt);approvalOperationId=careerRecordId(v.approvalOperationId);approvedChannel='web';
  if(approvedRevision!==revision||approvedDigest!==payloadDigest||v.approvedChannel!=='web'||approvedAt<createdAt||approvedAt>updatedAt||!['active','archived'].includes(v.resumeStatus as string))throw Error('Invalid approval binding.');
 }else{
  if([v.approvedRevision,v.approvedDigest,v.approvedAt,v.approvedChannel,v.approvalOperationId].some(x=>x!==null)||v.resumeStatus!==(v.status==='pending'?'draft':'archived'))throw Error('Unapproved resume state.');
 }
 const supersededBy=v.supersededBy===null?null:careerRecordId(v.supersededBy);
 if((v.status==='superseded')!==(supersededBy!==null))throw Error('Invalid replacement source.');
 return Object.freeze({id,ownerId,resumeVersionId,kind:'resume_version',finalAction:'none',draftedBy:null,title:'简历版本',label:careerLibraryText(v.label,120),track:track(v.track),sequence,source:v.source as ResumeReviewItem['source'],uploadId,...(uploadSource?{uploadSource}:{}),derivedFrom,status:v.status as ResumeReviewStatus,resumeStatus:v.resumeStatus as ResumeReviewItem['resumeStatus'],revision,generation,payloadDigest,sensitivity:'sensitive',approvedRevision,approvedDigest,approvedAt,approvedChannel,approvalOperationId,supersededBy,expiresAt,createdAt,updatedAt,lastOperationId:careerRecordId(v.lastOperationId)});
}
export function parseResumeReviewView(value:unknown):Readonly<ResumeReviewView>{const v=careerRecordObject(value,['item','payload']),item=parseResumeReviewItem(v.item),payload=parseResumeReviewPayload(v.payload);if(payload.source_refs[0].id!==item.id)throw Error('Invalid input source.');const upload=payload.source_refs[1];if(item.uploadSource?upload?.id!==item.uploadId||upload?.sha256!==item.uploadSource.sha256||upload?.storageVersion!==item.uploadSource.storageVersion:upload!==undefined)throw Error('Invalid original upload binding.');return Object.freeze({item,payload});}
