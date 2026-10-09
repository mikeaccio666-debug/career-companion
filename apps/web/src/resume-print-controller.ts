import type {ResumeReviewItem} from '@companion/platform-contracts';
import type {BoundPlatformClient} from './api.ts';
import {readPrintableResume} from './resume-print-api.ts';

export interface ResumePrintState {readonly phase:'closed'|'loading'|'preview'|'checking'|'printing'|'error';readonly text:string;readonly error:string;}
const closed:ResumePrintState=Object.freeze({phase:'closed',text:'',error:''});
/** Read-only, account-bound and memory-only. Each print needs a new server read. */
export class ResumePrintController {
 private state=closed;
 private listeners=new Set<()=>void>();
 private request:AbortController|null=null;
 private epoch=0;
 private stopped=false;
 private client:BoundPlatformClient;
 private basis:Readonly<ResumeReviewItem>;
 private timeoutMs:number;
 private unsubscribe:(()=>void)|null=null;
 constructor(client:BoundPlatformClient,basis:Readonly<ResumeReviewItem>,timeoutMs=8000){
  this.client=client;this.basis=Object.freeze({...basis});this.timeoutMs=timeoutMs;

 }
 start=()=>{this.stopped=false;if(!this.unsubscribe)this.unsubscribe=this.client.subscribe(()=>{if(!this.client.isCurrent())this.close();});};
 getSnapshot=()=>this.state;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
 private set(state:ResumePrintState){this.state=Object.freeze(state);for(const fn of this.listeners)fn();}
 close=()=>{this.epoch++;this.request?.abort();this.request=null;this.set(closed);};
 stop=()=>{this.close();this.stopped=true;this.unsubscribe?.();this.unsubscribe=null;};
 prepare=()=>this.run();
 print=(printer:(signal:AbortSignal)=>Promise<void>)=>this.run(printer);
 private async run(printer?:(signal:AbortSignal)=>Promise<void>){
  if(this.stopped||!this.client.isCurrent()||this.request||printer&&this.state.phase!=='preview')return;
  const c=new AbortController(),epoch=++this.epoch;this.request=c;
  const current=()=>!this.stopped&&this.client.isCurrent()&&this.epoch===epoch;
  this.set({phase:printer?'checking':'loading',text:'',error:''});
  let abort:()=>void=()=>{};
  const interrupted=new Promise<never>((_,reject)=>{abort=()=>reject(new DOMException('Interrupted','AbortError'));c.signal.addEventListener('abort',abort,{once:true});});
  const timer=setTimeout(()=>c.abort(),this.timeoutMs);
  let printing=false;
  try{
   const text=await Promise.race([readPrintableResume(this.client,this.basis,c.signal),interrupted]);
   clearTimeout(timer);
   if(!current()||c.signal.aborted)return;
   this.set({phase:printer?'printing':'preview',text,error:''});
   if(printer&&current()&&!c.signal.aborted){
    printing=true;
    await Promise.race([printer(c.signal),interrupted]);
    if(current()&&!c.signal.aborted)this.set({phase:'preview',text,error:''});
   }
  }catch{
   if(current())this.set({phase:'error',text:'',error:printing?'打印窗口未能完成打开。请关闭预览后重试；也可以复制全文到文档中打印。':'暂时无法核对这一版，或内容和状态已变化。请关闭预览，重新读取简历后再试。'});
  }finally{
   clearTimeout(timer);c.signal.removeEventListener('abort',abort);
   if(this.request===c)this.request=null;
  }
 }
}
