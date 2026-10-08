/** Owner-entered career directions. These records do not grant model or tool execution. */
import { CAREER_ROLE_FAMILIES,careerRecordObject as careerTargetObject,careerRecordId as careerTargetId,CareerRecordInputError as CareerTargetInputError,type CareerRoleFamily } from './career-record-values.ts';
export { CAREER_ROLE_FAMILIES,careerTargetObject,careerTargetId,CareerTargetInputError };
export type CareerTargetRoleFamily=CareerRoleFamily;
export const CAREER_TARGET_STATUSES = Object.freeze(['exploring', 'active', 'paused', 'dropped'] as const);
export type CareerTargetStatus = typeof CAREER_TARGET_STATUSES[number];
export type CareerTargetAction = 'create' | 'edit' | 'status' | 'delete';
export interface CareerTarget {
 readonly id:string; readonly ownerId:string; readonly roleFamily:CareerTargetRoleFamily; readonly title:string;
 readonly locations:readonly string[]; readonly priority:number; readonly status:CareerTargetStatus;
 readonly source:'user_entered'; readonly proposedBy:null; readonly revision:number;
 readonly createdAt:string; readonly updatedAt:string; readonly lastOperationId:string;
}
export interface CareerTargetCommand {
 readonly operationId:string; readonly expectedRevision:number; readonly roleFamily?:CareerTargetRoleFamily;
 readonly title?:string; readonly locations?:readonly string[]; readonly priority?:number; readonly status?:CareerTargetStatus;
}
const fail=():never=>{throw new CareerTargetInputError();};
function integer(value:unknown,min:number,max=2147483647):number{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||Object.is(value,-0)||value<min||value>max)return fail();return value;
}
function text(value:unknown,max:number):string{
 if(typeof value!=='string'||!value||value.trim()!==value||Array.from(value).length>max||/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value))return fail();return value;
}
function choice<T extends string>(value:unknown,values:readonly T[]):T{if(typeof value!=='string'||!values.includes(value as T))return fail();return value as T;}
function locations(value:unknown):readonly string[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>10)return fail();const d=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(d).length!==value.length+1)return fail();const result:string[]=[];
 for(let i=0;i<value.length;i++){if(!d[i]||!('value' in d[i])||!d[i].enumerable)return fail();result.push(text(d[i].value,80));}
 if(new Set(result).size!==result.length)return fail();return Object.freeze(result);
}
function timestamp(value:unknown):string{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)return fail();return value;}
export function parseCareerTarget(value:unknown):Readonly<CareerTarget>{
 const v=careerTargetObject(value,['id','ownerId','roleFamily','title','locations','priority','status','source','proposedBy','revision','createdAt','updatedAt','lastOperationId']);
 if(v.source!=='user_entered'||v.proposedBy!==null)return fail();
 const result={id:careerTargetId(v.id),ownerId:careerTargetId(v.ownerId),roleFamily:choice(v.roleFamily,CAREER_ROLE_FAMILIES),title:text(v.title,120),locations:locations(v.locations),priority:integer(v.priority,1,100),
 status:choice(v.status,CAREER_TARGET_STATUSES),source:'user_entered' as const,proposedBy:null,revision:integer(v.revision,1),createdAt:timestamp(v.createdAt),updatedAt:timestamp(v.updatedAt),lastOperationId:careerTargetId(v.lastOperationId)};
 if(result.createdAt>result.updatedAt)return fail();return Object.freeze(result);
}
export function parseCareerTargetCommand(action:CareerTargetAction,value:unknown):Readonly<CareerTargetCommand>{
 if(!['create','edit','status','delete'].includes(action))return fail();
 const fields=['roleFamily','title','locations','priority'],v=careerTargetObject(value,['operationId','expectedRevision',...(action==='create'?fields:action==='status'?['status']:[])],action==='edit'?fields:[]);
 const result:Record<string,unknown>={operationId:careerTargetId(v.operationId),expectedRevision:integer(v.expectedRevision,action==='create'?0:1)};
 if(action==='create'&&result.expectedRevision!==0||action==='edit'&&!fields.some(k=>Object.hasOwn(v,k)))return fail();
 if(Object.hasOwn(v,'roleFamily'))result.roleFamily=choice(v.roleFamily,CAREER_ROLE_FAMILIES);
 if(Object.hasOwn(v,'title'))result.title=text(v.title,120);
 if(Object.hasOwn(v,'locations'))result.locations=locations(v.locations);
 if(Object.hasOwn(v,'priority'))result.priority=integer(v.priority,1,100);
 if(Object.hasOwn(v,'status'))result.status=choice(v.status,CAREER_TARGET_STATUSES);
 return Object.freeze(result) as unknown as Readonly<CareerTargetCommand>;
}
