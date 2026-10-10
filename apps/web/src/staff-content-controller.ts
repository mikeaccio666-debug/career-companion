import type {StaffContentWithdrawal} from '@companion/platform-contracts';
import {careerRecordId} from '@companion/platform-contracts';
import {ApiError} from './api-error.ts';
import {readStaffContentWithdrawals,type StaffContentClient} from './staff-content-api.ts';
export interface StaffContentState {readonly records:readonly Readonly<StaffContentWithdrawal>[]|null;readonly nextCursor:string|null;readonly busy:boolean;readonly suspended:boolean;readonly error:string;}
const empty=():StaffContentState=>({records:null,nextCursor:null,busy:false,suspended:false,error:''});
export class StaffContentController {
 private state=empty();private live=false;private generation=0;private request:AbortController|null=null;private unsubscribe:(()=>void)|null=null;
 private readonly organizationId:string;private readonly client:StaffContentClient;private readonly changed:(s:StaffContentState)=>void;private readonly timeout:number;
 constructor(client:StaffContentClient,organizationId:string,changed:(s:StaffContentState)=>void,timeout=10000){this.client=client;this.changed=changed;this.timeout=timeout;this.organizationId=careerRecordId(organizationId);}
 snapshot(){return this.state;}
 private current(g=this.generation){return this.live&&this.client.isCurrent()&&g===this.generation;}
 private publish(p:Partial<StaffContentState>){if(this.current()){this.state=Object.freeze({...this.state,...p});this.changed(this.state);}}
 start(suspended=false){if(this.live)return;this.live=true;this.unsubscribe=this.client.subscribe(()=>{if(!this.client.isCurrent())this.stop();});if(suspended)this.publish({suspended:true});else void this.refresh();}
 stop(){this.live=false;this.generation++;this.request?.abort();this.request=null;this.unsubscribe?.();this.unsubscribe=null;this.state=empty();this.changed(this.state);}
 suspend(){if(!this.current())return;this.generation++;this.request?.abort();this.request=null;this.publish({...empty(),suspended:true});}
 resume(){if(!this.current())return;this.publish({suspended:false});void this.refresh();}
 refresh(){return this.read(false);}
 more(){return this.read(true);}
 private async read(more:boolean){
  if(!this.current()||this.request||this.state.suspended||more&&(!this.state.records||!this.state.nextCursor))return;
  const generation=this.generation,previous=more?this.state.records!:[],cursor=more?this.state.nextCursor:null;
  const request=new AbortController();this.request=request;
  this.publish({records:more?previous:null,nextCursor:more?cursor:null,busy:true,error:''});
  let cancel=()=>{};
  const aborted=new Promise<never>((_,reject)=>{cancel=()=>reject(new DOMException('Interrupted','AbortError'));request.signal.addEventListener('abort',cancel,{once:true});});
  const timer=setTimeout(()=>request.abort(),this.timeout);
  try{
   const page=await Promise.race([readStaffContentWithdrawals(this.client,this.organizationId,cursor,request.signal),aborted]);
   if(this.current(generation))this.publish({records:Object.freeze([...previous,...page.records]),nextCursor:page.nextCursor,busy:false});
  }catch(e){
   if(this.current(generation))this.publish({records:null,nextCursor:null,busy:false,error:e instanceof ApiError&&e.status===403?'当前账号没有查看权限，请使用获授权的运营账号。':'下架记录暂时没有读到，请重新读取。'});
  }finally{clearTimeout(timer);request.signal.removeEventListener('abort',cancel);if(this.request===request)this.request=null;}
 }
}
