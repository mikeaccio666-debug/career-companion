import { careerTargetId,careerTargetObject,parseCareerTarget,parseCareerTargetCommand,type CareerTargetAction,type CareerTarget } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api';
function fail():never{throw Error('方向状态暂时无法确认，请重新读取。');}
const owned=(client:BoundPlatformClient,value:unknown)=>{const target=parseCareerTarget(value);if(target.ownerId!==client.account.accountId)fail();return target;};
export async function readCareerTargets(client:BoundPlatformClient,signal?:AbortSignal){
 const v=careerTargetObject(await client.request('/career/targets',{signal}),['targets']);
 if(!Array.isArray(v.targets)||Object.getPrototypeOf(v.targets)!==Array.prototype||v.targets.length>100)fail();const d=Object.getOwnPropertyDescriptors(v.targets),targets:Readonly<CareerTarget>[]=[];
 if(Reflect.ownKeys(d).length!==v.targets.length+1)fail();for(let i=0;i<v.targets.length;i++){if(!d[i]||!('value' in d[i]))fail();targets.push(owned(client,d[i].value));}
 if(new Set(targets.map(x=>x.id)).size!==targets.length)fail();return Object.freeze(targets);
}
export async function changeCareerTarget(client:BoundPlatformClient,action:CareerTargetAction,id:string|null,input:unknown,signal?:AbortSignal){
 const command=parseCareerTargetCommand(action,input),key=action==='create'?null:careerTargetId(id),path='/career/targets'+(key?'/'+key:'')+(action==='status'?'/status':'');
 const v=careerTargetObject(await client.request(path,{method:action==='edit'?'PATCH':action==='delete'?'DELETE':'POST',body:JSON.stringify(command),signal}),['target','operation']);
 const op=careerTargetObject(v.operation,['id','targetId','appliedRevision','replayed']);careerTargetId(op.id);careerTargetId(op.targetId);
 if(op.id!==command.operationId||typeof op.replayed!=='boolean'||op.appliedRevision!==command.expectedRevision+1||key!==null&&op.targetId!==key)fail();
 const target=v.target===null?null:owned(client,v.target);
 if(target&&(target.id!==op.targetId||target.revision<(op.appliedRevision as number)))fail();if(!op.replayed&&(action==='delete'?target!==null:target===null||target.revision!==op.appliedRevision||target.lastOperationId!==op.id))fail();
 if(!op.replayed&&target){if(action==='create'&&(target.status!=='exploring'||!Object.hasOwn(command,'reviewOn')&&target.reviewOn!=null)||action==='status'&&target.status!==command.status)fail();for(const key of ['roleFamily','title','locations','priority','reviewOn'] as const)if(Object.hasOwn(command,key)&&JSON.stringify(target[key])!==JSON.stringify(command[key]))fail();}
 return Object.freeze({target,operation:Object.freeze({id:op.id as string,targetId:op.targetId as string,appliedRevision:op.appliedRevision as number,replayed:op.replayed as boolean})});
}
