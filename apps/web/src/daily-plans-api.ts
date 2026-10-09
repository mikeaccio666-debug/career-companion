import {careerRecordObject as object,careerRecordId as id,parseDailyPlanView,parseDailyPlanCommand,type DailyPlanResult} from '@companion/platform-contracts';
import type {BoundPlatformClient} from './api.ts';
export type DailyPlanClient=Pick<BoundPlatformClient,'account'|'request'|'isCurrent'|'subscribe'>;
const fail=():never=>{throw Error('今天的安排尚未确认，请重新读取。');};
function owned(client:DailyPlanClient,value:unknown){const view=parseDailyPlanView(value);if(!client.isCurrent()||view.ownerId!==client.account.accountId)fail();return view;}
export async function readDailyPlanView(client:DailyPlanClient,signal?:AbortSignal){if(!client.isCurrent())fail();return owned(client,await client.request('/today',{signal,cache:'no-store'}));}
export async function changeDailyPlan(client:DailyPlanClient,input:unknown,observe=false,signal?:AbortSignal):Promise<Readonly<DailyPlanResult>>{
 if(!client.isCurrent())fail();const c=parseDailyPlanCommand(input);const path=observe?'/today/plan/operations/'+c.operationId:c.action==='add'?'/today/plan/items':c.action==='accept'?'/today/plan/accept':'/today/plan/items/'+c.itemId;
 const v=object(await client.request(path,observe?{signal,cache:'no-store'}:{signal,cache:'no-store',method:['add','accept'].includes(c.action)?'POST':'PATCH',body:JSON.stringify(c)}),['view','operation']);const view=owned(client,v.view),op=object(v.operation,['id','action','localDate','planId','appliedRevision','replayed']);
 if(view.companionId!==c.companionId||op.id!==c.operationId||op.action!==c.action||op.localDate!==c.localDate||op.appliedRevision!==c.expectedRevision+1||typeof op.replayed!=='boolean'||observe&&!op.replayed||c.planId!==null&&op.planId!==c.planId)fail();const planId=id(op.planId);
 if(view.localDate===c.localDate&&!view.paused&&(!view.plan||view.plan.id!==planId||view.plan.revision<(op.appliedRevision as number)||!op.replayed&&view.plan.revision!==op.appliedRevision||view.plan.revision===op.appliedRevision&&view.plan.lastOperationId!==op.id))fail();
 return Object.freeze({view,operation:Object.freeze({id:c.operationId,action:c.action,localDate:c.localDate,planId,appliedRevision:op.appliedRevision as number,replayed:op.replayed as boolean})});
}
