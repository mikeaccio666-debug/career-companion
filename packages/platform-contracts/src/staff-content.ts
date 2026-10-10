import {careerRecordId,careerRecordObject} from './career-record-values.ts';
import {careerLibraryTime} from './career-stories.ts';

/** Staff-only tombstone metadata. Never contains withdrawn content or license evidence. */
export interface StaffContentWithdrawal {
 readonly sourceId:string;readonly title:string;readonly revision:number;readonly withdrawnAt:string;
}
export interface StaffContentWithdrawalPage {
 readonly actorId:string;readonly organizationId:string;
 readonly records:readonly Readonly<StaffContentWithdrawal>[];readonly nextCursor:string|null;
}
export function parseStaffContentWithdrawalPage(raw:unknown):Readonly<StaffContentWithdrawalPage>{
 const v=careerRecordObject(raw,['actorId','organizationId','records','nextCursor']);
 if(!Array.isArray(v.records)||v.records.length>50)throw Error('Invalid withdrawal page');
 let previous='';
 const records=v.records.map(raw=>{
  const r=careerRecordObject(raw,['sourceId','title','revision','withdrawnAt']),sourceId=careerRecordId(r.sourceId);
  if(sourceId<=previous||typeof r.title!=='string'||!r.title.trim()||r.title.length>120||
   !Number.isSafeInteger(r.revision)||(r.revision as number)<2)throw Error('Invalid withdrawal record');
  previous=sourceId;
  return Object.freeze({sourceId,title:r.title,revision:r.revision as number,withdrawnAt:careerLibraryTime(r.withdrawnAt)});
 });
 const next=v.nextCursor===null?null:careerRecordId(v.nextCursor);
 if(next!==null&&(records.length!==50||next!==records.at(-1)?.sourceId))throw Error('Invalid withdrawal cursor');
 return Object.freeze({actorId:careerRecordId(v.actorId),organizationId:careerRecordId(v.organizationId),records:Object.freeze(records),nextCursor:next});
}
