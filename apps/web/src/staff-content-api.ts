import {careerRecordId,parseStaffContentWithdrawalPage} from '@companion/platform-contracts';
export interface StaffContentClient {
 readonly account:{readonly accountId:string};isCurrent():boolean;
 subscribe(fn:()=>void):()=>void;request<T>(path:string,init?:RequestInit):Promise<T>;
}
export function staffContentOrganization(path:string):string|null {
 const match=/^\/staff\/orgs\/([^/]+)\/content-withdrawals$/.exec(path);
 if(!match)return null;try{return careerRecordId(match[1]);}catch{return null;}
}
export async function readStaffContentWithdrawals(c:StaffContentClient,organizationId:string,after:string|null=null,signal?:AbortSignal){
 const org=careerRecordId(organizationId),cursor=after===null?null:careerRecordId(after),actor=careerRecordId(c.account.accountId);
 const current=()=>{signal?.throwIfAborted();if(!c.isCurrent()||c.account.accountId!==actor)throw Error('Account changed');};
 current();
 const raw=await c.request('/staff/orgs/'+org+'/content-withdrawals'+(cursor?'?after='+cursor:''),{signal,cache:'no-store'});
 current();const page=parseStaffContentWithdrawalPage(raw);
 if(page.actorId!==actor||page.organizationId!==org||cursor&&page.records.some(r=>r.sourceId<=cursor))throw Error('Invalid withdrawal binding');
 return page;
}
