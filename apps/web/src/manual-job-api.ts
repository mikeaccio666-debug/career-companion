import { careerRecordId,careerRecordObject,parseManualJob,parseManualJobSummary,parseManualJobCommand,manualJobsDuplicate,type ManualJob,type ManualJobAction,type ManualJobSummary } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api';
function fail():never{throw Error('岗位内容暂时无法确认，请重新读取。');}
function owned<T extends {ownerId:string}>(client:BoundPlatformClient,value:T):T{if(value.ownerId!==client.account.accountId)return fail();return value;}
export async function readManualJobs(client:BoundPlatformClient,after:string|null=null,signal?:AbortSignal){
 const v=careerRecordObject(await client.request('/career/job-observations'+(after?'?after='+careerRecordId(after):''),{signal}),['jobs','nextAfter']);
 if(!Array.isArray(v.jobs)||Object.getPrototypeOf(v.jobs)!==Array.prototype||v.jobs.length>50)return fail();const d=Object.getOwnPropertyDescriptors(v.jobs),jobs:Readonly<ManualJobSummary>[]=[];
 if(Reflect.ownKeys(d).length!==v.jobs.length+1)return fail();for(let i=0;i<v.jobs.length;i++){if(!d[i]||!('value' in d[i]))return fail();jobs.push(owned(client,parseManualJobSummary(d[i].value)));}
 if(new Set(jobs.map(j=>j.id)).size!==jobs.length)return fail();const nextAfter=v.nextAfter===null?null:careerRecordId(v.nextAfter);if(nextAfter!==null&&(jobs.length!==50||jobs.at(-1)!.id!==nextAfter))return fail();return Object.freeze({jobs:Object.freeze(jobs),nextAfter});
}
export async function readManualJob(client:BoundPlatformClient,id:string,signal?:AbortSignal){const v=careerRecordObject(await client.request('/career/job-observations/'+careerRecordId(id),{signal}),['job']),job=owned(client,parseManualJob(v.job));if(job.id!==id)return fail();return job;}
export async function changeManualJob(client:BoundPlatformClient,action:ManualJobAction,id:string|null,input:unknown,signal?:AbortSignal){
 const command=parseManualJobCommand(action,input),key=action==='create'?null:careerRecordId(id),v=careerRecordObject(await client.request('/career/job-observations'+(key?'/'+key:''),{method:action==='create'?'POST':'DELETE',body:JSON.stringify(command),signal}),['job','operation']);
 const op=careerRecordObject(v.operation,['id','observationId','appliedRevision','replayed']);careerRecordId(op.id);careerRecordId(op.observationId);
 if(op.id!==command.operationId||op.appliedRevision!==command.expectedRevision+1||typeof op.replayed!=='boolean'||key!==null&&op.observationId!==key)return fail();
 const job=v.job===null?null:owned(client,parseManualJob(v.job));if(job&&(job.id!==op.observationId||job.revision<(op.appliedRevision as number)))return fail();
 if(!op.replayed&&(action==='delete'?job!==null:job===null||job.revision!==1||job.lastOperationId!==command.operationId))return fail();
 if(job&&action==='create')for(const key of ['employer','title','canonicalUrl','roleFamily','location','deadlineAt','deadlineTimeZone','privateNote','jobText'] as const)if(job[key]!==command[key])return fail();
 return Object.freeze({job,operation:Object.freeze({id:op.id as string,observationId:op.observationId as string,appliedRevision:op.appliedRevision as number,replayed:op.replayed as boolean})});
}

export async function readManualJobDuplicates(client:BoundPlatformClient,input:unknown,signal?:AbortSignal){const command=parseManualJobCommand('create',input),v=careerRecordObject(await client.request('/career/job-observations/duplicates',{method:'POST',body:JSON.stringify(command),signal}),['jobs']);
 if(!Array.isArray(v.jobs)||Object.getPrototypeOf(v.jobs)!==Array.prototype||v.jobs.length>500)return fail();const d=Object.getOwnPropertyDescriptors(v.jobs),jobs:Readonly<ManualJobSummary>[]=[];if(Reflect.ownKeys(d).length!==v.jobs.length+1)return fail();for(let i=0;i<v.jobs.length;i++){if(!d[i]||!('value' in d[i]))return fail();jobs.push(owned(client,parseManualJobSummary(d[i].value)));}if(new Set(jobs.map(j=>j.id)).size!==jobs.length||jobs.some(j=>!manualJobsDuplicate(j,command as Pick<ManualJob,'canonicalUrl'|'employer'|'title'>)))return fail();return Object.freeze(jobs);
}
