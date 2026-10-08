import { CAREER_ROLE_FAMILIES,careerRecordObject,careerRecordId,type CareerRoleFamily } from './career-record-values.ts';
export type ManualJobAction='create'|'delete';
export type SponsorshipEvidenceStatus='explicit_yes'|'explicit_no'|'unknown';
export interface ManualJobEvidence { readonly text:string;readonly start:number;readonly end:number;readonly status:SponsorshipEvidenceStatus; }
export interface ManualJob {
 readonly id:string;readonly ownerId:string;readonly sourceId:string;readonly source:'manual';readonly state:'unknown';
 readonly employer:string;readonly title:string;readonly canonicalUrl:string;readonly roleFamily:CareerRoleFamily;
 readonly location:string;readonly deadlineAt:string|null;readonly deadlineTimeZone:string|null;readonly privateNote:string;
 readonly jobText:string;readonly sponsorship:SponsorshipEvidenceStatus;readonly sponsorshipEvidence:readonly ManualJobEvidence[];
 readonly evidenceOverflow:boolean;readonly ruleRevision:number;readonly observedAt:string;readonly checkedAt:string;
 readonly revision:number;readonly lastOperationId:string;
}
export type ManualJobSummary=Omit<ManualJob,'jobText'|'privateNote'|'sponsorshipEvidence'>;
export interface ManualJobCommand {readonly operationId:string;readonly expectedRevision:number;readonly employer?:string;readonly title?:string;readonly canonicalUrl?:string;readonly roleFamily?:CareerRoleFamily;readonly location?:string;readonly deadlineAt?:string|null;readonly deadlineTimeZone?:string|null;readonly privateNote?:string;readonly jobText?:string;readonly allowDuplicate?:boolean;}
function fail():never{throw new Error('The pasted job could not be confirmed.');}
export function manualJobText(v:unknown,max:number,multiline=false,empty=false):string {
 if(typeof v!=='string'||!empty&&!v.trim()||Array.from(v).length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(v)||!multiline&&/[\r\n\t]/.test(v))return fail();return v;
}
function integer(v:unknown,min:number,max=2147483647):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||Object.is(v,-0)||v<min||v>max)return fail();return v;}
function status(v:unknown):SponsorshipEvidenceStatus{if(v!=='explicit_yes'&&v!=='explicit_no'&&v!=='unknown')return fail();return v;}
export function manualJobTime(v:unknown):string{if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)return fail();return v;}
export function canonicalManualJobUrl(v:unknown):string {
 const s=manualJobText(v,4096,false,true);if(!s)return '';let url:URL;try{url=new URL(s);}catch{return fail();}
 if(url.protocol!=='https:'||url.username||url.password)return fail();url.hash='';for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key)||['gclid','fbclid'].includes(key.toLowerCase()))url.searchParams.delete(key);url.searchParams.sort();return url.href;
}
const fields=['employer','title','canonicalUrl','roleFamily','location','deadlineAt','deadlineTimeZone','privateNote','jobText'] as const;
function commonValues(v:Record<string,unknown>){
 if(typeof v.roleFamily!=='string'||!CAREER_ROLE_FAMILIES.includes(v.roleFamily as CareerRoleFamily))return fail();
 const deadlineAt=v.deadlineAt===null?null:manualJobTime(v.deadlineAt);let zone:string|null=null;
 if(deadlineAt!==null){zone=manualJobText(v.deadlineTimeZone,80);try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{return fail();}}
 else if(v.deadlineTimeZone!==null)return fail();
 return {employer:manualJobText(v.employer,200),title:manualJobText(v.title,200),canonicalUrl:canonicalManualJobUrl(v.canonicalUrl),roleFamily:v.roleFamily as CareerRoleFamily,location:manualJobText(v.location,200,false,true),deadlineAt ,deadlineTimeZone:zone};
}
function values(v:Record<string,unknown>){return {...commonValues(v),privateNote:manualJobText(v.privateNote,2000,true,true),jobText:manualJobText(v.jobText,50000,true)};}
export function parseManualJobCommand(action:ManualJobAction,value:unknown):Readonly<ManualJobCommand>{
 if(action!=='create'&&action!=='delete')return fail();const v=careerRecordObject(value,['operationId','expectedRevision',...(action==='create'?fields:[])],action==='create'?['allowDuplicate']:[]);
 const operationId=careerRecordId(v.operationId),expectedRevision=integer(v.expectedRevision,action==='create'?0:1);
 if(action==='create'&&expectedRevision!==0)return fail();if(action==='delete')return Object.freeze({operationId,expectedRevision});
 if(Object.hasOwn(v,'allowDuplicate')&&typeof v.allowDuplicate!=='boolean')return fail();return Object.freeze({operationId,expectedRevision,...values(v),allowDuplicate:v.allowDuplicate===true});
}
function dense(value:unknown,max:number):unknown[]{if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max)return fail();const d=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(d).length!==value.length+1)return fail();return Array.from({length:value.length},(_,i)=>{if(!d[i]||!('value' in d[i])||!d[i].enumerable)return fail();return d[i].value;});}
export function parseManualJob(value:unknown):Readonly<ManualJob>{
 const v=careerRecordObject(value,['id','ownerId','sourceId','source','state',...fields,'sponsorship','sponsorshipEvidence','evidenceOverflow','ruleRevision','observedAt','checkedAt','revision','lastOperationId']);
 const id=careerRecordId(v.id),ownerId=careerRecordId(v.ownerId),info=values(v);
 if(v.source!=='manual'||v.state!=='unknown'||v.sourceId!==id||info.canonicalUrl!==v.canonicalUrl||typeof v.evidenceOverflow!=='boolean')return fail();
 let previous=0;const evidence=dense(v.sponsorshipEvidence,50).map(item=>{const e=careerRecordObject(item,['text','start','end','status']),start=integer(e.start,0,info.jobText.length),end=integer(e.end,1,info.jobText.length),text=manualJobText(e.text,50000,true);
  if(start<previous||end<=start||info.jobText.slice(start,end)!==text)return fail();previous=end;return Object.freeze({text,start,end,status:status(e.status)});});
 const observedAt=manualJobTime(v.observedAt),checkedAt=manualJobTime(v.checkedAt);if(observedAt!==checkedAt)return fail();
 return Object.freeze({id,ownerId,sourceId:id,source:'manual',state:'unknown',...info,sponsorship:status(v.sponsorship),sponsorshipEvidence:Object.freeze(evidence),evidenceOverflow:v.evidenceOverflow,ruleRevision:integer(v.ruleRevision,1),observedAt,checkedAt,revision:integer(v.revision,1),lastOperationId:careerRecordId(v.lastOperationId)});
}
export function manualJobSummary(job:Readonly<ManualJob>):Readonly<ManualJobSummary>{const {jobText,privateNote,sponsorshipEvidence,...summary}=job;return Object.freeze(summary);}
export function parseManualJobSummary(value:unknown):Readonly<ManualJobSummary>{
 const v=careerRecordObject(value,['id','ownerId','sourceId','source','state','employer','title','canonicalUrl','roleFamily','location','deadlineAt','deadlineTimeZone','sponsorship','evidenceOverflow','ruleRevision','observedAt','checkedAt','revision','lastOperationId']);
 const info=commonValues(v),id=careerRecordId(v.id),ownerId=careerRecordId(v.ownerId),observedAt=manualJobTime(v.observedAt),checkedAt=manualJobTime(v.checkedAt);
 if(v.source!=='manual'||v.state!=='unknown'||v.sourceId!==id||info.canonicalUrl!==v.canonicalUrl||typeof v.evidenceOverflow!=='boolean'||observedAt!==checkedAt)return fail();
 return Object.freeze({id,ownerId,sourceId:id,source:'manual',state:'unknown',...info,sponsorship:status(v.sponsorship),evidenceOverflow:v.evidenceOverflow,ruleRevision:integer(v.ruleRevision,1),observedAt,checkedAt,revision:integer(v.revision,1),lastOperationId:careerRecordId(v.lastOperationId)});
}
export function manualJobsDuplicate(a:Pick<ManualJob,'canonicalUrl'|'employer'|'title'>,b:Pick<ManualJob,'canonicalUrl'|'employer'|'title'>):boolean {
 const normal=(s:string)=>s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
 return Boolean(a.canonicalUrl&&a.canonicalUrl===b.canonicalUrl)||normal(a.employer)===normal(b.employer)&&normal(a.title)===normal(b.title);
}
