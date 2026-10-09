import { parseSharedMemoryRecord,parseSharedMemoryCommand,sharedMemoryId,type SharedMemoryRecord,type SharedMemoryCommandKind } from '@companion/platform-contracts';
import type { BoundPlatformClient } from './api.ts';
export type SharedMemoryClient=Pick<BoundPlatformClient,'account'|'isCurrent'|'subscribe'|'request'>;
function current(client:SharedMemoryClient){if(!client.isCurrent())fail();}
function fail():never{throw Error('记忆状态暂时无法确认，请重新读取。');}
function record(v:unknown,keys:readonly string[]):Record<string,any>{
 if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail();const d=Object.getOwnPropertyDescriptors(v);
 if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k])||Reflect.ownKeys(d).some(k=>typeof k!=='string'||!keys.includes(k))||Object.values(d).some(x=>!('value' in x)||!x.enumerable))fail();
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function owned(client:SharedMemoryClient,value:unknown):Readonly<SharedMemoryRecord>{const m=parseSharedMemoryRecord(value);if(m.ownerId!==client.account.accountId)fail();return m;}
export async function readSharedMemoryPage(client:SharedMemoryClient,cursor:string|null=null,signal?:AbortSignal){
 current(client);const r=record(await client.request('/memories'+(cursor?'?cursor='+encodeURIComponent(cursor):''),{signal}),['memories','hasMore','nextCursor']);
 current(client);if(!Array.isArray(r.memories)||Object.getPrototypeOf(r.memories)!==Array.prototype||r.memories.length>100||typeof r.hasMore!=='boolean'||(r.nextCursor!==null&&(typeof r.nextCursor!=='string'||!r.nextCursor||r.nextCursor.length>240))||r.hasMore!==(r.nextCursor!==null))fail();
 const d=Object.getOwnPropertyDescriptors(r.memories);if(Reflect.ownKeys(d).length!==r.memories.length+1)fail();const memories=[];
 for(let i=0;i<r.memories.length;i++){if(!d[i]||!('value' in d[i]))fail();const m=owned(client,d[i].value);if(m.deletedAt!==null)fail();memories.push(m);}
 if(new Set(memories.map(m=>m.id)).size!==memories.length)fail();return Object.freeze({memories:Object.freeze(memories),nextCursor:r.nextCursor as string|null});
}
export async function changeSharedMemory(client:SharedMemoryClient,kind:SharedMemoryCommandKind,id:string|null,value:unknown,signal?:AbortSignal){
 current(client);const command=parseSharedMemoryCommand(kind,value),target=kind==='create'?null:sharedMemoryId(id),suffix=kind==='confirm'?'/confirm':kind==='undo'?'/undo':'';
 const path=target===null?'/memories':'/memories/'+target+suffix;
 const r=record(await client.request(path,{method:kind==='edit'?'PATCH':kind==='delete'?'DELETE':'POST',body:JSON.stringify(command),signal}),['memory','operation']);
 current(client);const m=owned(client,r.memory),o=record(r.operation,['id','appliedRevision','replayed']);
 if(o.id!==command.operationId||!Number.isSafeInteger(o.appliedRevision)||o.appliedRevision!==command.expectedRevision+1||o.appliedRevision>m.revision||typeof o.replayed!=='boolean'||target!==null&&m.id!==target)fail();
 return Object.freeze({memory:m,operation:Object.freeze({id:sharedMemoryId(o.id),appliedRevision:o.appliedRevision as number,replayed:o.replayed as boolean})});
}

export async function readSharedMemoryUses(client:SharedMemoryClient,id:string,signal?:AbortSignal){
 current(client);const target=sharedMemoryId(id),r=record(await client.request('/memories/'+target+'/uses',{signal}),['memoryId','uses']);
 current(client);if(r.memoryId!==target||!Array.isArray(r.uses)||r.uses.length>100||Object.getPrototypeOf(r.uses)!==Array.prototype)fail();
 const d=Object.getOwnPropertyDescriptors(r.uses);if(Reflect.ownKeys(d).length!==r.uses.length+1)fail();const uses=[];
 for(let i=0;i<r.uses.length;i++){if(!d[i]||!('value' in d[i]))fail();const v=record(d[i].value,['id','memoryRevision','conversationId','messageId','speaker','channel','purpose','createdAt']);
  if(!Number.isSafeInteger(v.memoryRevision)||v.memoryRevision<1||v.memoryRevision>2147483647||!['companion','planner','guide','coach','interviewer','networker','applier'].includes(v.speaker)
    ||!['web','discord','voice'].includes(v.channel)||!['chat','morning_brief','self_set_reminder','external_draft','handoff_note'].includes(v.purpose)||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||new Date(v.createdAt).toISOString()!==v.createdAt)fail();
  uses.push(Object.freeze({id:sharedMemoryId(v.id),memoryRevision:v.memoryRevision as number,conversationId:sharedMemoryId(v.conversationId),messageId:sharedMemoryId(v.messageId),speaker:v.speaker as string,channel:v.channel as string,purpose:v.purpose as string,createdAt:v.createdAt as string}));
 }return Object.freeze(uses);
}
