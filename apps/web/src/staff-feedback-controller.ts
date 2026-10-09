import {parseFeedbackUpdate,type ProductFeedback,type FeedbackStatus} from '@companion/platform-contracts';
import type {FeedbackClient} from './product-feedback-api.ts';
import {readStaffFeedbackPage,readStaffFeedback,updateStaffFeedback,type StaffFeedbackCommand} from './staff-feedback-api.ts';
import {ApiError} from './api-error.ts';
export interface StaffFeedbackState {
 records:readonly Readonly<ProductFeedback>[]|null;nextCursor:string|null;selected:Readonly<ProductFeedback>|null;
 organizationId:string|null;status:FeedbackStatus|null;busy:boolean;suspended:boolean;
 pending:Readonly<{id:string;organizationId:string;command:StaffFeedbackCommand}>|null;
 error:string;notice:string;settled:string|null;
}
const empty=():StaffFeedbackState=>({records:null,nextCursor:null,selected:null,organizationId:null,status:'submitted',busy:false,suspended:false,pending:null,error:'',notice:'',settled:null});
export class StaffFeedbackController {
 private state=empty();private live=false;private generation=0;private request:AbortController|null=null;private unsubscribe:(()=>void)|null=null;private selectedId:string|null=null;
 private readonly client:FeedbackClient;private readonly changed:(s:StaffFeedbackState)=>void;private readonly timeout:number;
 constructor(client:FeedbackClient,changed:(s:StaffFeedbackState)=>void,timeout=10000){this.client=client;this.changed=changed;this.timeout=timeout;}
 snapshot(){return this.state;}
 private current(g=this.generation){return this.live&&this.client.isCurrent()&&g===this.generation;}
 private publish(p:Partial<StaffFeedbackState>){if(this.current()){this.state=Object.freeze({...this.state,...p});this.changed(this.state);}}
 start(suspended=false){if(this.live)return;this.live=true;this.unsubscribe=this.client.subscribe(()=>{if(!this.client.isCurrent())this.stop();});if(suspended)this.publish({suspended:true});else void this.refresh();}
 stop(){this.generation++;this.live=false;this.request?.abort();this.request=null;this.unsubscribe?.();this.unsubscribe=null;this.selectedId=null;this.state=empty();this.changed(this.state);}
 suspend(){if(!this.current())return;this.generation++;this.request?.abort();this.request=null;this.publish({records:null,nextCursor:null,selected:null,organizationId:null,busy:false,suspended:true,error:'',notice:''});}
 resume(){if(!this.current())return;this.publish({suspended:false});if(this.state.pending)void this.observe();else void this.refresh();}
 private async timed<T>(run:(signal:AbortSignal)=>Promise<T>){
  const a=new AbortController();this.request=a;let cancel=()=>{};
  const interrupted=new Promise<never>((_,reject)=>{cancel=()=>reject(new DOMException('Interrupted','AbortError'));a.signal.addEventListener('abort',cancel,{once:true});});
  const timer=setTimeout(()=>a.abort(),this.timeout);
  try{return await Promise.race([run(a.signal),interrupted]);}finally{clearTimeout(timer);a.signal.removeEventListener('abort',cancel);if(this.request===a)this.request=null;}
 }
 private failure(e:unknown){return e instanceof ApiError&&e.status===403?'当前账号没有反馈处理权限。请使用获授权的运营账号。':'反馈暂时没有读到，请重新读取。';}
 async refresh(){
  if(!this.current()||this.request||this.state.suspended)return;if(this.state.pending){await this.observe();return;}
  const g=this.generation,id=this.selectedId,status=this.state.status;this.publish({records:null,nextCursor:null,selected:null,organizationId:null,busy:true,error:''});
  try{const page=await this.timed(s=>readStaffFeedbackPage(this.client,status,null,s));if(!this.current(g))return;
   const selected=id?await this.timed(s=>readStaffFeedback(this.client,id,s)):null;if(!this.current(g))return;
   if(selected&&selected.organizationId!==page.organizationId)throw Error('Organization changed');
   this.publish({...page,selected,busy:false});
  }catch(e){if(this.current(g))this.publish({busy:false,error:this.failure(e)});}
 }
 async filter(status:FeedbackStatus|null){if(!this.current()||this.request||this.state.pending||this.state.suspended)return;this.selectedId=null;this.publish({status,selected:null,notice:''});await this.refresh();}
 async more(){
  if(!this.current()||this.request||this.state.suspended||this.state.pending||!this.state.records||!this.state.nextCursor)return;
  const g=this.generation,previous=this.state.records,cursor=this.state.nextCursor,org=this.state.organizationId;this.publish({busy:true,error:''});
  try{const page=await this.timed(s=>readStaffFeedbackPage(this.client,this.state.status,cursor,s));if(page.organizationId!==org)throw Error('Organization changed');
   if(this.current(g))this.publish({records:Object.freeze([...previous,...page.records]),nextCursor:page.nextCursor,busy:false});
  }catch(e){if(this.current(g))this.publish({records:null,nextCursor:null,selected:null,organizationId:null,busy:false,error:this.failure(e)});}
 }
 async select(id:string){
  if(!this.current()||this.request||this.state.suspended||this.state.pending||!this.state.organizationId)return;
  const g=this.generation,org=this.state.organizationId;this.selectedId=id;this.publish({selected:null,busy:true,error:'',notice:''});
  try{const selected=await this.timed(s=>readStaffFeedback(this.client,id,s));if(selected.organizationId!==org)throw Error('Organization changed');
   if(this.current(g))this.publish({selected,busy:false});
  }catch(e){if(this.current(g))this.publish({records:null,nextCursor:null,organizationId:null,busy:false,error:this.failure(e)});}
 }
 begin(input:unknown){
  if(!this.current()||this.request||this.state.suspended||this.state.pending||!this.state.selected)return false;
  const command=parseFeedbackUpdate(input),p=this.state.selected;if(command.expectedRevision!==p.revision)return false;
  this.publish({pending:Object.freeze({id:p.id,organizationId:p.organizationId,command}),error:'',notice:''});void this.execute(false);return true;
 }
 retry(){return this.execute(false);}observe(){return this.execute(true);}
 private async execute(observe:boolean){
  const pending=this.state.pending;if(!this.current()||this.request||this.state.suspended||!pending)return;
  const g=this.generation;this.publish({busy:true,error:''});
  try{const selected=await this.timed(s=>updateStaffFeedback(this.client,pending.id,pending.organizationId,pending.command,s,observe));if(!this.current(g))return;
   this.selectedId=selected.id;this.publish({selected,organizationId:selected.organizationId,records:null,nextCursor:null,pending:null,busy:false,settled:pending.command.operationId,notice:'处理结果已保存，反馈人现在可以查看。'});
  }catch(e){
   if(!this.current(g))return;
   if(!observe&&e instanceof ApiError&&[400,401,403,404,409,413,422,429].includes(e.status)&&typeof e.code==='string'){
    this.publish({pending:null,selected:null,records:null,nextCursor:null,organizationId:null,busy:false,error:e.status===409?'反馈已有更新。请重新读取最新进展，再决定怎样回复。':'这次处理未保存。请重新读取并核对权限和内容。'});
   }else this.publish({busy:false,selected:null,records:null,nextCursor:null,organizationId:null,error:observe&&e instanceof ApiError&&e.status===403?'当前账号已无处理权限，无法核对。请联系管理员；不要另发一条回复。':'还不能确认是否已保存。请核对本次结果，或用原内容重试。'});
  }
 }
}
