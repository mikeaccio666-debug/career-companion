import {parseManualJobCommand,manualJobSummary,manualJobsDuplicate,careerRecordId,type ManualJob,type ManualJobSummary,type ManualJobAction} from '@companion/platform-contracts';
import {ApiError} from './api-error.ts';
import {readManualJobs,readManualJob,readManualJobDuplicates,changeManualJob,type ManualJobClient} from './manual-job-api.ts';
export interface PendingManualJob {readonly action:ManualJobAction;readonly id:string|null;readonly body:ReturnType<typeof parseManualJobCommand>;}
export interface ManualJobSnapshot {
 readonly jobs:readonly Readonly<ManualJobSummary>[];readonly next:string|null;readonly detail:Readonly<ManualJob>|null;
 readonly loaded:boolean;readonly busy:boolean;readonly suspended:boolean;readonly pending:Readonly<PendingManualJob>|null;
 readonly uncertain:boolean;readonly error:string;readonly notice:string;readonly duplicate:boolean;
 readonly matches:readonly Readonly<ManualJobSummary>[];readonly settledOperationId:string|null;
}
export const emptyManualJobs=():ManualJobSnapshot=>Object.freeze({jobs:[],next:null,detail:null,loaded:false,busy:false,suspended:false,pending:null,
 uncertain:false,error:'',notice:'',duplicate:false,matches:[],settledOperationId:null});
/** Account-bound memory only. Reconnection reads; only explicit retry may write. */
export class ManualJobController {
 private state=emptyManualJobs();private live=false;private generation=0;private request:AbortController|null=null;private unsubscribe:(()=>void)|null=null;
 private readonly client:ManualJobClient;private readonly changed:(state:ManualJobSnapshot)=>void;private readonly timeoutMs:number;
 constructor(client:ManualJobClient,changed:(state:ManualJobSnapshot)=>void,timeoutMs=8000){this.client=client;this.changed=changed;this.timeoutMs=timeoutMs;}
 snapshot(){return this.state;}
 private current(g=this.generation){return this.live&&this.client.isCurrent()&&g===this.generation;}
 private publish(patch:Partial<ManualJobSnapshot>){if(this.current()){this.state=Object.freeze({...this.state,...patch});this.changed(this.state);}}
 start(suspended=false){if(this.live)return;this.live=true;this.unsubscribe=this.client.subscribe(()=>{if(!this.client.isCurrent())this.stop();});if(suspended)this.publish({suspended:true});else void this.refresh();}
 stop(){this.generation++;this.live=false;this.request?.abort();this.request=null;this.unsubscribe?.();this.unsubscribe=null;this.state=emptyManualJobs();this.changed(this.state);}
 suspend(){if(!this.current())return;this.generation++;this.request?.abort();this.request=null;this.publish({jobs:[],next:null,detail:null,matches:[],duplicate:false,loaded:false,busy:false,suspended:true,uncertain:!!this.state.pending,error:'',notice:''});}
 resume(){if(!this.current()||!this.state.suspended)return;this.publish({suspended:false});void this.refresh();}
 private async timed<T>(run:(signal:AbortSignal)=>Promise<T>){
  const abort=new AbortController();this.request=abort;let cancel:(()=>void)|undefined;
  const interrupted=new Promise<never>((_,reject)=>{cancel=()=>reject(new DOMException('Interrupted','AbortError'));abort.signal.addEventListener('abort',cancel,{once:true});});
  const timer=setTimeout(()=>abort.abort(),this.timeoutMs);
  try{return await Promise.race([run(abort.signal),interrupted]);}
  finally{clearTimeout(timer);if(cancel)abort.signal.removeEventListener('abort',cancel);if(this.request===abort)this.request=null;}
 }
 async refresh(after:string|null=null){
  if(!this.current()||this.request||this.state.suspended||after&&(!this.state.loaded||after!==this.state.next))return;
  const g=this.generation,prior=this.state.jobs;this.publish({busy:true,error:'',detail:null,matches:[],duplicate:false,
   ...(after?{}:{loaded:false,jobs:[],next:null})});
  try{
   const page=await this.timed(signal=>readManualJobs(this.client,after,signal));if(!this.current(g))return;
   if(after&&page.jobs.some(job=>prior.some(old=>old.id===job.id)))throw Error('Overlapping saved-job pages');
   this.publish({jobs:Object.freeze(after?[...prior,...page.jobs]:page.jobs),next:page.nextAfter,loaded:true,busy:false});
  }catch{if(this.current(g))this.publish({jobs:[],next:null,detail:null,loaded:false,busy:false,error:this.state.pending?'岗位暂时没读到，请重新读取。未确认的保存仍可核对或重试。':'岗位暂时没读到，请重新读取。'});}
 }
 async open(id:string){
  if(!this.current()||this.request||this.state.suspended||!this.state.loaded)return;
  const key=careerRecordId(id),g=this.generation;this.publish({busy:true,error:'',detail:null});
  try{const job=await this.timed(signal=>readManualJob(this.client,key,signal));if(this.current(g))this.publish({detail:job,busy:false});}
  catch{if(this.current(g))this.publish({detail:null,busy:false,error:'这条岗位暂时没读到，请重新读取再核对。'});}
 }
 closeDetail(){this.publish({detail:null});}
 dismissDuplicate(){this.publish({duplicate:false,matches:[],error:''});}
 begin(action:ManualJobAction,id:string|null,input:unknown){
  if(!this.current()||this.request||this.state.pending||this.state.suspended||!this.state.loaded)return;
  const body=parseManualJobCommand(action,input),key=action==='create'?null:careerRecordId(id);
  if(action==='delete'){
   const row=this.state.jobs.find(job=>job.id===key)??(this.state.detail?.id===key?this.state.detail:null);
   if(!row||row.revision!==body.expectedRevision){this.publish({error:'移除前请重新读取，核对当前岗位。'});return;}
  }else if(!body.allowDuplicate){
   const matches=this.state.jobs.filter(job=>manualJobsDuplicate(job,body as Pick<ManualJob,'canonicalUrl'|'employer'|'title'>));
   if(matches.length){this.publish({duplicate:true,matches:Object.freeze(matches),error:'这个岗位之前收藏过。可以打开原记录，或明确新建一份。'});return;}
  }
  this.publish({pending:Object.freeze({action,id:key,body}),uncertain:false,error:'',notice:'',duplicate:false,matches:[]});void this.execute(false);
 }
 retry(){return this.execute(false);}
 observe(){return this.execute(true);}
 private async execute(observe:boolean){
  const pending=this.state.pending;if(!this.current()||this.request||!pending||this.state.suspended)return;
  const g=this.generation;this.publish({busy:true,error:'',notice:''});
  try{
   const result=await this.timed(signal=>changeManualJob(this.client,pending.action,pending.id,pending.body,signal,observe));
   if(!this.current(g))return;const loaded=this.state.loaded;
   this.publish({busy:false,pending:null,uncertain:false,duplicate:false,matches:[],settledOperationId:pending.body.operationId,
    jobs:loaded?Object.freeze([...(result.job?[manualJobSummary(result.job)]:[]),...this.state.jobs.filter(j=>j.id!==result.operation.observationId)]):[],
    detail:loaded?result.job:null,notice:result.job?'已核对，岗位已收藏。':'已核对，这条岗位已经移除。'});
   if(!loaded)await this.refresh();
  }catch(error){
   if(!this.current(g))return;
   const definitive=!observe&&error instanceof ApiError&&[400,401,403,404,409,413,422,429].includes(error.status)&&typeof error.code==='string';
   if(!definitive){this.publish({busy:false,uncertain:true,error:'还不能确认这次保存是否完成。请核对这次保存，或用原操作重试。'});return;}
   this.publish({pending:null,uncertain:false});
   if(error instanceof ApiError&&error.code==='MANUAL_JOB_DUPLICATE'&&pending.action==='create'){
    try{const matches=await this.timed(signal=>readManualJobDuplicates(this.client,pending.body,signal));if(this.current(g))this.publish({busy:false,duplicate:true,matches,error:'这个岗位之前收藏过。可以打开原记录，或明确新建一份。'});}
    catch{if(this.current(g))this.publish({busy:false,loaded:false,jobs:[],next:null,detail:null,matches:[],duplicate:false,error:'发现重复收藏，但旧记录暂时没读到。请重新读取后再保存。'});}
   }else this.publish({busy:false,loaded:false,jobs:[],next:null,detail:null,error:'这次保存未确认，请重新读取岗位，再核对你的修改。'});
  }
 }
}
