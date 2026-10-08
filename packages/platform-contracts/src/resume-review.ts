import { CAREER_ROLE_FAMILIES,careerRecordObject,careerRecordId,type CareerRoleFamily } from './career-record-values.ts';
import { careerLibraryText,careerLibraryTime } from './career-stories.ts';
export const RESUME_REVIEW_STATES=Object.freeze(['pending','approved','declined','expired','superseded'] as const);
export type ResumeReviewStatus=typeof RESUME_REVIEW_STATES[number];
export type ResumeReviewAction='create'|'edit'|'approve'|'decline'|'reopen'|'archive'|'delete';
export interface ResumeSourceRef {readonly kind:'owner_resume_input';readonly id:string;readonly revision:1;}
export interface ResumeDependency {readonly id:string;readonly pendingItemId:string;readonly revision:number;readonly approvedDigest:string;}
export interface ResumeReviewPayload {readonly text:string;readonly claims:readonly never[];readonly source_refs:readonly Readonly<ResumeSourceRef>[];}
export interface ResumeReviewItem {
 readonly id:string;readonly ownerId:string;readonly resumeVersionId:string;readonly kind:'resume_version';readonly finalAction:'none';readonly draftedBy:null;
 readonly title:'简历版本';readonly label:string;readonly track:CareerRoleFamily;readonly sequence:number;readonly source:'paste'|'derived';readonly uploadId:null;readonly derivedFrom:Readonly<ResumeDependency>|null;
 readonly status:ResumeReviewStatus;readonly resumeStatus:'draft'|'active'|'archived';readonly revision:number;readonly generation:number;readonly payloadDigest:string;readonly sensitivity:'sensitive';
 readonly approvedRevision:number|null;readonly approvedDigest:string|null;readonly approvedAt:string|null;readonly approvedChannel:'web'|null;readonly approvalOperationId:string|null;
 readonly supersededBy:string|null;readonly expiresAt:string;readonly createdAt:string;readonly updatedAt:string;readonly lastOperationId:string;
}
export interface ResumeReviewView {readonly item:Readonly<ResumeReviewItem>;readonly payload:Readonly<ResumeReviewPayload>;}
export interface ResumeReviewCommand {readonly operationId:string;readonly expectedRevision:number;readonly payloadDigest?:string;readonly track?:CareerRoleFamily;readonly label?:string;readonly text?:string;readonly derivedFromId?:string;}
export function resumeReviewInteger(v:unknown,min=1):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||Object.is(v,-0)||v<min||v>2147483647)throw Error('Invalid resume version.');return v;}
export function resumeReviewDigest(v:unknown):string{if(typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v))throw Error('Invalid resume digest.');return v;}
function track(v:unknown):CareerRoleFamily{if(!CAREER_ROLE_FAMILIES.includes(v as CareerRoleFamily))throw Error('Choose a role family.');return v as CareerRoleFamily;}
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
 if(!Array.isArray(v.source_refs)||Object.getPrototypeOf(v.source_refs)!==Array.prototype||v.source_refs.length!==1||Reflect.ownKeys(v.source_refs).length!==2)throw Error('Use one actual owner input.');
 const descriptors=Object.getOwnPropertyDescriptors(v.source_refs);if(!descriptors[0]||!('value' in descriptors[0])||!descriptors[0].enumerable)throw Error('Use an actual owner input.');
 const ref=careerRecordObject(descriptors[0].value,['kind','id','revision']);if(ref.kind!=='owner_resume_input'||ref.revision!==1)throw Error('Use the original input revision.');
 return Object.freeze({text:careerLibraryText(v.text,50000,true),claims:Object.freeze([]) as readonly never[],source_refs:Object.freeze([Object.freeze({kind:'owner_resume_input' as const,id:careerRecordId(ref.id),revision:1 as const})])});
}
const itemFields=['id','ownerId','resumeVersionId','kind','finalAction','draftedBy','title','label','track','sequence','source','uploadId','derivedFrom','status','resumeStatus','revision','generation','payloadDigest','sensitivity','approvedRevision','approvedDigest','approvedAt','approvedChannel','approvalOperationId','supersededBy','expiresAt','createdAt','updatedAt','lastOperationId'] as const;
export function parseResumeReviewItem(value:unknown):Readonly<ResumeReviewItem>{
 const v=careerRecordObject(value,itemFields);
 if(v.kind!=='resume_version'||v.finalAction!=='none'||v.draftedBy!==null||v.title!=='简历版本'||v.uploadId!==null||v.sensitivity!=='sensitive'||!['paste','derived'].includes(v.source as string)||!RESUME_REVIEW_STATES.includes(v.status as ResumeReviewStatus)||!['draft','active','archived'].includes(v.resumeStatus as string))throw Error('Invalid resume review state.');
 const id=careerRecordId(v.id),ownerId=careerRecordId(v.ownerId),resumeVersionId=careerRecordId(v.resumeVersionId),revision=resumeReviewInteger(v.revision),generation=resumeReviewInteger(v.generation),sequence=resumeReviewInteger(v.sequence),derivedFrom=dep(v.derivedFrom);
 if(generation<revision||(v.source==='derived')!==(derivedFrom!==null))throw Error('Invalid resume lineage.');
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
 return Object.freeze({id,ownerId,resumeVersionId,kind:'resume_version',finalAction:'none',draftedBy:null,title:'简历版本',label:careerLibraryText(v.label,120),track:track(v.track),sequence,source:v.source as ResumeReviewItem['source'],uploadId:null,derivedFrom,status:v.status as ResumeReviewStatus,resumeStatus:v.resumeStatus as ResumeReviewItem['resumeStatus'],revision,generation,payloadDigest,sensitivity:'sensitive',approvedRevision,approvedDigest,approvedAt,approvedChannel,approvalOperationId,supersededBy,expiresAt,createdAt,updatedAt,lastOperationId:careerRecordId(v.lastOperationId)});
}
export function parseResumeReviewView(value:unknown):Readonly<ResumeReviewView>{const v=careerRecordObject(value,['item','payload']),item=parseResumeReviewItem(v.item),payload=parseResumeReviewPayload(v.payload);if(payload.source_refs[0].id!==item.id)throw Error('Invalid input source.');return Object.freeze({item,payload});}
