import type { AssistantCommerceCommand,AssistantCommerceResult,AssistantJobEntry,AssistantJobState,AtsReportResponse,CommercialUsageView } from '@edaix/contracts';
import { isCurrent,type ControllerContext } from '../../app/controller-context';
import { atsInputKey } from '../../app/view-context';
import { abortableDelay } from '../../ports/assistant-ports';
import type { AtsReport,Job,Entitlement } from '../../state/types';
export interface CommerceState { roleId:string|null;loading:boolean;entries:Record<string,AssistantJobEntry>;savedCursor:string|null;sourceAvailable:boolean }
export const emptyCommerce=():CommerceState=>({roleId:null,loading:false,entries:{},savedCursor:null,sourceAvailable:false});
export function createCommerceController(ctx:ControllerContext) {
  const requests=new Map<string,{clientRequestId:string;expectedRevision:number;state:AssistantJobState}>();
  const state=()=>ctx.state.commerce??emptyCommerce();
  const set=(patch:Partial<CommerceState>)=>ctx.patch({commerce:{...state(),...patch}});
  async function execute(command:AssistantCommerceCommand,signal:AbortSignal):Promise<AssistantCommerceResult>{
    try{return await ctx.ports.commerce!.execute(command,signal);}catch{return {operation:command.operation,ok:false,code:'UNAVAILABLE'};}
  }
  function failure(result:AssistantCommerceResult):void {
    if(result.ok)return;
    ctx.toast(ctx.t(result.code==='RATE_LIMITED'?'今天的服务调用次数已达安全上限，请明天再试；已保存资料仍可编辑。':result.code==='USAGE_EXHAUSTED'?'本周期额度已用完。':result.code==='SOURCE_CHANGED'?'简历或职位内容已更新，请重新打开后评估。'
      :result.code==='REVISION_CONFLICT'?'内容已变化，请刷新后重试。':result.code==='SAVE_UNCERTAIN'?'结果尚未确认，请刷新查看；重复请求不会重复扣量。':'暂时无法完成此操作，请重试。'));
  }
  function project(entries:readonly AssistantJobEntry[]):void {
    const all={...state().entries,...Object.fromEntries(entries.map(entry=>[entry.id,entry]))};
    set({entries:all});
    ctx.patch(s=>({...s,jobOptions:Object.values(all).map(entry=>({...toJob(entry),...s.jobOptions?.find(job=>job.id===entry.id)})),
      deck:{...s.deck,selected:Object.values(all).filter(entry=>entry.state==='SAVED').map(entry=>entry.id),skipped:Object.values(all).filter(entry=>entry.state==='SKIPPED').map(entry=>entry.id)}}));
  }
  async function usage():Promise<void>{
    const scope=ctx.store.scope();
    ctx.patch(s=>({...s,entitlements:{...s.entitlements,ats:{access:'unavailable'},jobs:{access:'unavailable'}}}));
    const result=await execute({operation:'USAGE'},scope.signal);
    if(!isCurrent(ctx,scope))return;
    if(result.ok&&result.operation==='USAGE'){
      const mapped:Partial<typeof ctx.state.entitlements>={};
      for(const value of result.value.usage){
        const kind=({'ats.report':'ats','jobs.delivered':'jobs','intake.reply':'chat','intake.audio':'voice'} as const)[value.feature];
        mapped[kind]=entitlement(value);
      }
      ctx.patch(s=>({...s,entitlements:{...s.entitlements,...mapped}}));
    }
  }
  function role():string|null {
    const id=ctx.state.currentTargetId;
    if(!id){ctx.toast(ctx.t('请先选择求职方向。'));return null;}
    if(state().roleId!==id){requests.clear();ctx.patch({autofill:undefined,materials:undefined,commerce:{...emptyCommerce(),roleId:id},jobOptions:[],atsResults:{},staleIds:{},prep:{},preparedResume:{},letters:{},
      deck:{...ctx.state.deck,items:[],index:0,cursor:0,selected:[],skipped:[],history:[],busy:false}});}
    return id;
  }
  async function load():Promise<boolean>{
    const id=role();if(!id)return false;
    const scope=ctx.store.scope();set({loading:true});
    const received=await execute({operation:'JOBS_LIST',query:{conversationId:id,state:'RECEIVED'}},scope.signal);
    if(!isCurrent(ctx,scope)||ctx.state.currentTargetId!==id)return false;
    if(!received.ok||received.operation!=='JOBS_LIST'){set({loading:false});failure(received);return false;}
    const saved=await execute({operation:'JOBS_LIST',query:{conversationId:id,state:'SAVED'}},scope.signal);
    if(!isCurrent(ctx,scope)||ctx.state.currentTargetId!==id)return false;
    set({loading:false});
    if(!saved.ok||saved.operation!=='JOBS_LIST'){failure(saved);return false;}
    set({entries:{},savedCursor:saved.value.nextCursor});
    project([...received.value.entries,...saved.value.entries]);
    ctx.patch(s=>({...s,deck:{...s.deck,items:received.value.entries.slice(0,10).map(entry=>entry.id),index:0,history:[],busy:false},
      entitlements:{...s.entitlements,jobs:entitlement(received.value.usage)}}));
    return true;
  }
  async function nextBatch():Promise<void>{
    if(state().loading||ctx.state.deck.busy)return;
    if(!await load())return;
    if(ctx.state.deck.items.length){await ctx.go('deck');void usage();return;}
    const id=role()!,scope=ctx.store.scope();set({loading:true});
    const available=await execute({operation:'JOBS_BATCHES',conversationId:id},scope.signal);
    if(!isCurrent(ctx,scope)||ctx.state.currentTargetId!==id)return;
    if(!available.ok||available.operation!=='JOBS_BATCHES'){set({loading:false});failure(available);return;}
    const batchId=available.value.batches[0]?.id;set({sourceAvailable:!!batchId});
    if(!batchId){set({loading:false});ctx.patch(s=>({...s,entitlements:{...s.entitlements,jobs:{...s.entitlements.jobs,sourceExhausted:true}}}));await ctx.go('batchend');return;}
    const result=await execute({operation:'JOBS_DELIVER',request:{conversationId:id,batchId}},scope.signal);
    if(!isCurrent(ctx,scope)||ctx.state.currentTargetId!==id)return;
    set({loading:false});
    if(!result.ok||result.operation!=='JOBS_DELIVER'){failure(result);await usage();return;}
    project(result.value.entries);
    const items=result.value.entries.filter(entry=>entry.state==='RECEIVED').slice(0,10).map(entry=>entry.id);
    ctx.patch(s=>({...s,deck:{...s.deck,items,index:0,batchNo:s.deck.batchNo+1,history:[],busy:false},
      entitlements:{...s.entitlements,jobs:entitlement(result.value.usage)}}));
    await ctx.go(items.length?'deck':'batchend');void usage();
  }
  async function save(id:string,value:AssistantJobState):Promise<boolean>{
    const entry=state().entries[id],scope=ctx.store.scope(),selectedRole=ctx.state.currentTargetId;if(!entry)return false;
    const prior=requests.get(id),request=prior?.state===value?prior:{clientRequestId:crypto.randomUUID(),expectedRevision:entry.revision,state:value};
    requests.set(id,request);
    const result=await execute({operation:'JOB_DECIDE',entryId:id,request},scope.signal);
    if(!isCurrent(ctx,scope)||ctx.state.currentTargetId!==selectedRole)return false;
    if(!result.ok||result.operation!=='JOB_DECIDE'){failure(result);if(!result.ok&&result.code!=='SAVE_UNCERTAIN')requests.delete(id);return false;}
    requests.delete(id);project([result.value.entry]);
    if(result.value.entry.state!==value){ctx.toast(ctx.t('内容已变化，请刷新后重试。'));return false;}
    return true;
  }
  async function decide(accept:boolean):Promise<void>{
    const deck=ctx.state.deck,id=deck.items[deck.index],scope=ctx.store.scope();if(deck.busy||!id)return;
    ctx.patch({deck:{...deck,busy:true}});
    if(!await save(id,accept?'SAVED':'SKIPPED')){if(isCurrent(ctx,scope))ctx.patch({deck:{...ctx.state.deck,busy:false}});return;}
    await ctx.motion?.chooseCard(accept);if(!isCurrent(ctx,scope))return;
    ctx.patch(s=>({...s,deck:{...s.deck,index:s.deck.index+1,busy:false,history:[...s.deck.history,{id,accept}]}}));
    if(ctx.state.deck.index>=ctx.state.deck.items.length)await ctx.go('batchend');
    else{await ctx.afterRender();ctx.motion?.enterCard();}
  }
  async function undo():Promise<void>{
    const last=ctx.state.deck.history.at(-1),scope=ctx.store.scope();if(!last||ctx.state.deck.busy)return;
    ctx.patch({deck:{...ctx.state.deck,busy:true}});
    if(!await save(last.id,'RECEIVED')){if(isCurrent(ctx,scope))ctx.patch({deck:{...ctx.state.deck,busy:false}});return;}
    ctx.patch(s=>({...s,deck:{...s.deck,busy:false,index:Math.max(0,s.deck.index-1),history:s.deck.history.slice(0,-1)}}));await ctx.go('deck');
  }
  async function detail(id:string,open=true):Promise<boolean>{
    const entry=state().entries[id],scope=ctx.store.scope(),selectedRole=ctx.state.currentTargetId;if(!entry)return false;
    const result=await execute({operation:'JOB_DETAIL',batchId:entry.batchId,itemId:entry.itemId},scope.signal);
    if(!isCurrent(ctx,scope)||ctx.state.currentTargetId!==selectedRole)return false;
    if(!result.ok||result.operation!=='JOB_DETAIL'){failure(result);return false;}
    if(result.value.item.canonicalJobId!==entry.canonicalJobId)return false;
    ctx.patch(s=>({...s,jobOptions:(s.jobOptions??[]).map(job=>job.id===id?{...job,title:result.value.item.job.title,company:result.value.item.job.company,
      description:result.value.item.description,jdDigest:result.value.item.descriptionDigest}:job),...(open?{sheet:{kind:'jd' as const,id}}:{})}));
    return true;
  }
  function publishAts(id:string,resumeId:string,result:AtsReportResponse):boolean {
    const entry=state().entries[id],job=ctx.data.jobs.find(job=>job.id===id);if(!job)return false;
    if(!entry||result.entryId!==id||entry.canonicalJobId!==result.source.canonicalJobId||result.resumeVersionId!==resumeId){
      ctx.patch(s=>({...s,atsResults:{...s.atsResults,[atsInputKey(job,resumeId)]:{status:'failed',resumeId,failureCode:'SOURCE_CHANGED'}}}));
      failure({operation:'ATS_GET',ok:false,code:'SOURCE_CHANGED'});return false;
    }
    const currentJob={...job,jdDigest:result.source.descriptionDigest},key=atsInputKey(currentJob,resumeId);
    ctx.patch(s=>({...s,jobOptions:(s.jobOptions??[]).map(job=>job.id===id?currentJob:job),atsResults:{...Object.fromEntries(Object.entries(s.atsResults).filter(([oldKey])=>oldKey!==atsInputKey(job,resumeId))),[key]:{
      status:result.status==='SUCCEEDED'?'ready':result.status==='FAILED'?'failed':'scoring',resumeId,reportId:result.id,
      ...(result.report?{report:toReport(result.report)}:{}),...(result.failureCode?{failureCode:result.failureCode}:{})}},staleIds:{...s.staleIds,[id]:s.resumeId!==resumeId}}));
    return true;
  }
  async function existingReport(id:string):Promise<void>{
    const resumeId=ctx.state.resumeId,scope=ctx.store.scope(),selectedRole=ctx.state.currentTargetId;
    if(!resumeId)return;
    const result=await execute({operation:'ATS_LOOKUP',request:{entryId:id,resumeVersionId:resumeId}},scope.signal);
    if(!isCurrent(ctx,scope)||ctx.state.currentTargetId!==selectedRole)return;
    if(result.ok&&result.operation==='ATS_LOOKUP'){
      if(result.value.report){if(!publishAts(id,resumeId,result.value.report))return;if(['QUEUED','PROCESSING'].includes(result.value.report.status)){
        const job=ctx.data.jobs.find(job=>job.id===id);if(job)ctx.patch(s=>({...s,atsResults:{...s.atsResults,[atsInputKey(job,resumeId)]:{...s.atsResults[atsInputKey(job,resumeId)]!,status:'pending'}}}));
      }}else ctx.toast(ctx.t('这版简历还没有此岗位的评估报告。'));
    }else failure(result);
  }
  async function score(id:string):Promise<void>{
    const resumeId=ctx.state.resumeId,entry=state().entries[id],scope=ctx.store.scope(),selectedRole=ctx.state.currentTargetId;
    if(!entry||!resumeId){ctx.toast(ctx.t('需要简历才能评估'));return;}
    const job=ctx.data.jobs.find(job=>job.id===id);if(!job)return;
    const key=atsInputKey(job,resumeId);if(ctx.state.atsResults[key]?.status==='scoring')return;
    ctx.patch(s=>({...s,atsResults:{...s.atsResults,[key]:{status:'scoring',resumeId}}}));
    let result=await execute({operation:'ATS_START',request:{entryId:id,resumeVersionId:resumeId}},scope.signal);
    for(let count=0;count<90;count++){
      if(!isCurrent(ctx,scope)||ctx.state.currentTargetId!==selectedRole)return;
      if(!result.ok||(result.operation!=='ATS_START'&&result.operation!=='ATS_GET')){
        ctx.patch(s=>({...s,atsResults:{...s.atsResults,[atsInputKey(ctx.data.jobs.find(job=>job.id===id)??job,resumeId)]:{...s.atsResults[atsInputKey(ctx.data.jobs.find(job=>job.id===id)??job,resumeId)],status:!result.ok&&result.code==='SAVE_UNCERTAIN'?'pending':'failed',resumeId}}}));failure(result);await usage();return;
      }
      if(!publishAts(id,resumeId,result.value)){await usage();return;}
      if(result.value.status==='FAILED'||result.value.status==='SUCCEEDED'){await usage();return;}
      if(!await abortableDelay(2000,scope.signal))return;
      result=await execute({operation:'ATS_GET',reportId:result.value.id,entryId:id},scope.signal);
    }
    const current=ctx.data.jobs.find(job=>job.id===id);if(current)ctx.patch(s=>({...s,atsResults:{...s.atsResults,[atsInputKey(current,resumeId)]:{...s.atsResults[atsInputKey(current,resumeId)]!,status:'pending'}}}));
  }
  async function shortlist():Promise<void>{if(await load())await ctx.go('shortlist');}
  async function moreSaved():Promise<void>{
    const id=role(),cursor=state().savedCursor,scope=ctx.store.scope();if(!id||!cursor||state().loading)return;set({loading:true});
    const result=await execute({operation:'JOBS_LIST',query:{conversationId:id,state:'SAVED',before:cursor}},scope.signal);
    if(!isCurrent(ctx,scope)||ctx.state.currentTargetId!==id)return;set({loading:false});
    if(result.ok&&result.operation==='JOBS_LIST'){project(result.value.entries);set({savedCursor:result.value.nextCursor});}else failure(result);
  }
  return {existingReport,discover:nextBatch,nextBatch,decide,undo,score,usage,detail,shortlist,moreSaved,remove:(id:string)=>save(id,'RECEIVED')};
}
function toJob(entry:AssistantJobEntry):Job {
  const job=entry.job;
  return {id:entry.id,company:job.company,title:job.title,location:job.location??'',mode:'',type:job.employmentType??'',salary:null,salaryUnit:null,
    summary:job.qualification.reasons.map(reason=>reason.defaultText).join(' · '),matches:[],gap:job.qualification.missingRequirements.map(item=>item.defaultText).join(' · '),
    source:job.sourcePlatform,posted:'',boardUrl:'',jdDigest:'',coverLetterRequirement:'UNKNOWN',responsibilities:[],requirements:[]};
}
function toReport(report:import('@edaix/contracts').AtsReport):AtsReport {
  return {total:report.total,max:report.max,dims:Object.fromEntries(Object.entries(report.dimensions).map(([key,value])=>[key,value?[value.score,[...value.problems]]:null])),
    definitions:Object.fromEntries(Object.entries(report.dimensions).map(([key,value])=>[key,{label:value?.label??key,max:value?.max??0,desc:''}])),
    problems:[...report.problems],suggestions:[...report.suggestions],missing:[...report.missingKeywords],rubricVersion:report.rubricVersion,measuredAt:report.measuredAt};
}
function entitlement(value:CommercialUsageView):Entitlement {
  return {access:value.state==='DENIED'?'locked':value.state==='SYNC_REQUIRED'?'sync':'granted',limit:value.limit,used:value.consumed,reserved:value.reserved,remaining:value.remaining,usage:value};
}
