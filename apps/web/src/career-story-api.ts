import { careerRecordId,careerRecordObject,parseCareerLibraryCommand,parseCareerProject,parseCareerStory,parseCareerLibrarySummary,type CareerLibraryKind,type CareerLibraryAction,type CareerLibraryRecord,type CareerProjectSummary,type CareerStorySummary,type CareerStoryEvidenceAvailability } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api';
export type LibrarySummary=CareerProjectSummary|CareerStorySummary;
export interface LibraryView<T>{readonly record:Readonly<T>;readonly evidenceAvailability:CareerStoryEvidenceAvailability|null;}
const path=(kind:CareerLibraryKind)=>'/career/'+(kind==='project'?'projects':'stories');
function fail():never{throw Error('经历状态暂时无法确认，请重新读取。');}
function owned<T extends {ownerId:string}>(client:BoundPlatformClient,r:T):T{if(!client.isCurrent()||r.ownerId!==client.account.accountId)return fail();return r;}
function availability(kind:CareerLibraryKind,v:unknown,removed=false):CareerStoryEvidenceAvailability|null{if(kind==='project'||removed){if(v!==null)return fail();return null;}if(!['current','unconfirmed','stale','withdrawn','missing'].includes(v as string))return fail();return v as CareerStoryEvidenceAvailability;}
const full=(kind:CareerLibraryKind,value:unknown)=>kind==='project'?parseCareerProject(value):parseCareerStory(value);
export async function readCareerLibrary(client:BoundPlatformClient,kind:CareerLibraryKind,after:string|null=null,signal?:AbortSignal){
 if(!client.isCurrent())return fail();
 const v=careerRecordObject(await client.request(path(kind)+(after?'?after='+careerRecordId(after):''),{signal,cache:'no-store'}),['records','nextAfter']);if(!client.isCurrent())return fail();
 if(!Array.isArray(v.records)||Object.getPrototypeOf(v.records)!==Array.prototype||v.records.length>50)return fail();const d=Object.getOwnPropertyDescriptors(v.records),records:Readonly<LibraryView<LibrarySummary>>[]=[];if(Reflect.ownKeys(d).length!==v.records.length+1)return fail();
 for(let i=0;i<v.records.length;i++){if(!d[i]||!('value' in d[i]))return fail();const item=careerRecordObject(d[i].value,['record','evidenceAvailability']);records.push(Object.freeze({record:owned(client,parseCareerLibrarySummary(kind,item.record)),evidenceAvailability:availability(kind,item.evidenceAvailability)}));}
 if(new Set(records.map(v=>v.record.id)).size!==records.length)return fail();const nextAfter=v.nextAfter===null?null:careerRecordId(v.nextAfter);if(nextAfter!==null&&(records.length!==50||records.at(-1)!.record.id!==nextAfter))return fail();return Object.freeze({records:Object.freeze(records),nextAfter});
}
export async function readCareerLibraryRecord(client:BoundPlatformClient,kind:CareerLibraryKind,id:string,signal?:AbortSignal):Promise<Readonly<LibraryView<CareerLibraryRecord>>>{if(!client.isCurrent())return fail();const v=careerRecordObject(await client.request(path(kind)+'/'+careerRecordId(id),{signal,cache:'no-store'}),['record','evidenceAvailability']),record=owned(client,full(kind,v.record));if(record.id!==id)return fail();return Object.freeze({record,evidenceAvailability:availability(kind,v.evidenceAvailability)});}
export async function readCareerProjectChoices(client:BoundPlatformClient,signal?:AbortSignal){const result:Readonly<CareerProjectSummary>[]=[],cursors=new Set<string>();let after:string|null=null;
 do{const page=await readCareerLibrary(client,'project',after,signal);for(const item of page.records){if(result.some(p=>p.id===item.record.id))return fail();result.push(item.record as CareerProjectSummary);}if(result.length>500)return fail();after=page.nextAfter;if(after){if(cursors.has(after))return fail();cursors.add(after);}}while(after);return Object.freeze(result);
}
export async function changeCareerLibrary(client:BoundPlatformClient,kind:CareerLibraryKind,action:CareerLibraryAction,id:string|null,input:unknown,signal?:AbortSignal,observe=false){
 if(!client.isCurrent())return fail();
 const command=parseCareerLibraryCommand(kind,action,input),key=action==='create'?null:careerRecordId(id);
 const route=observe?path(kind)+'/operations/'+command.operationId:path(kind)+(key?'/'+key:'')+(action==='confirm'||action==='withdraw'?'/'+action:'');
 const v=careerRecordObject(await client.request(route,observe?{signal,cache:'no-store'}:{method:action==='delete'?'DELETE':action==='edit'?'PATCH':'POST',body:JSON.stringify(command),signal}),['record','evidenceAvailability','operation']);
 if(!client.isCurrent())return fail();
 const op=careerRecordObject(v.operation,['id','recordId','recordKind','appliedRevision','replayed']);careerRecordId(op.id);careerRecordId(op.recordId);if(op.id!==command.operationId||op.recordKind!==kind||op.appliedRevision!==command.expectedRevision+1||typeof op.replayed!=='boolean'||observe&&op.replayed!==true||key!==null&&op.recordId!==key)return fail();
 const record=v.record===null?null:owned(client,full(kind,v.record));if(record&&(record.id!==op.recordId||record.revision<(op.appliedRevision as number)||record.revision===op.appliedRevision&&record.lastOperationId!==op.id))return fail();
 if(!op.replayed){if(action==='delete'?record!==null:record===null||record.revision!==op.appliedRevision||record.lastOperationId!==op.id)return fail();if(record){if(action==='create'||action==='edit'){if(record.confirmedAt!==null||kind==='story'&&(record as any).status!=='draft'||kind==='project'&&(record as any).verification!=='self_reported')return fail();for(const field of ['title','experienceKind','sensitivity','occurredAt','context','contribution','outcome','english','chinese','tags','projects'] as const)if(Object.hasOwn(command,field)&&JSON.stringify((record as any)[field])!==JSON.stringify(command[field]))return fail();}
 if(action==='confirm'&&(record.confirmedRevision!==record.revision||record.confirmedAt!==record.updatedAt||kind==='project'&&((record as any).verification!=='user_confirmed'||(record as any).state!=='active')||kind==='story'&&(record as any).status!=='confirmed'))return fail();if(action==='withdraw'&&(record as any).state!=='withdrawn')return fail();}}
 return Object.freeze({record,evidenceAvailability:availability(kind,v.evidenceAvailability,record===null),operation:Object.freeze({id:op.id as string,recordId:op.recordId as string,recordKind:kind,appliedRevision:op.appliedRevision as number,replayed:op.replayed as boolean})});
}
