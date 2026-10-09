import {parseFeedbackSubmission,type ProductFeedback} from '@companion/platform-contracts';
import {feedbackAvailability,readFeedback,readFeedbackPage,submitFeedback,type FeedbackClient,type FeedbackSubmission,type FeedbackAvailability} from './product-feedback-api.ts';
import {ApiError} from './api-error.ts';
export interface FeedbackState {
 records:readonly Readonly<ProductFeedback>[]|null;nextCursor:string|null;selected:Readonly<ProductFeedback>|null;
 availability:Readonly<FeedbackAvailability>|null;busy:boolean;suspended:boolean;pending:Readonly<FeedbackSubmission>|null;
 error:string;notice:string;settled:string|null;
}
const empty=():FeedbackState=>({records:null,nextCursor:null,selected:null,availability:null,busy:false,suspended:false,pending:null,error:'',notice:'',settled:null});
export class ProductFeedbackController {
 private state=empty();private live=false;private generation=0;private request:AbortController|null=null;private unsubscribe:(()=>void)|null=null;
 private selectedId:string|null=null;
 private readonly client:FeedbackClient;private readonly changed:(s:FeedbackState)=>void;private readonly timeout:number;
 constructor(client:FeedbackClient,changed:(s:FeedbackState)=>void,timeout=10000){this.client=client;this.changed=changed;this.timeout=timeout;}
 snapshot(){return this.state;}
 private current(g=this.generation){return this.live&&this.client.isCurrent()&&g===this.generation;}
 private publish(p:Partial<FeedbackState>){if(this.current()){this.state=Object.freeze({...this.state,...p});this.changed(this.state);}}
 start(suspended=false){if(this.live)return;this.live=true;this.unsubscribe=this.client.subscribe(()=>{if(!this.client.isCurrent())this.stop();});if(suspended)this.publish({suspended:true});else void this.refresh();}
 stop(){this.generation++;this.live=false;this.request?.abort();this.request=null;this.unsubscribe?.();this.unsubscribe=null;this.selectedId=null;this.state=empty();this.changed(this.state);}
 suspend(){if(!this.current())return;this.generation++;this.request?.abort();this.request=null;this.publish({records:null,nextCursor:null,selected:null,availability:null,busy:false,suspended:true,error:'',notice:''});}
 resume(){if(!this.current())return;this.publish({suspended:false});if(this.state.pending)void this.observe();else void this.refresh();}
 private async timed<T>(run:(signal:AbortSignal)=>Promise<T>){
  const a=new AbortController();this.request=a;let cancel=()=>{};
  const interrupted=new Promise<never>((_,reject)=>{cancel=()=>reject(new DOMException('Interrupted','AbortError'));a.signal.addEventListener('abort',cancel,{once:true});});
  const timer=setTimeout(()=>a.abort(),this.timeout);
  try{return await Promise.race([run(a.signal),interrupted]);}finally{clearTimeout(timer);a.signal.removeEventListener('abort',cancel);if(this.request===a)this.request=null;}
 }
 async refresh(){
  if(!this.current()||this.request||this.state.suspended)return;if(this.state.pending){await this.observe();return;}
  const g=this.generation,id=this.selectedId;this.publish({records:null,nextCursor:null,selected:null,availability:null,busy:true,error:''});
  try{const [availability,page,selected]=await this.timed(s=>Promise.all([feedbackAvailability(this.client,s),readFeedbackPage(this.client,null,s),id?readFeedback(this.client,id,s):Promise.resolve(null)]));
   if(this.current(g))this.publish({availability,...page,selected,busy:false});
  }catch{if(this.current(g))this.publish({busy:false,error:'反馈暂时没有读到，请稍后重新读取。'});}
 }
 async more(){
  if(!this.current()||this.request||this.state.suspended||this.state.pending||!this.state.records||!this.state.nextCursor)return;
  const g=this.generation,previous=this.state.records,cursor=this.state.nextCursor;this.publish({busy:true,error:''});
  try{const page=await this.timed(s=>readFeedbackPage(this.client,cursor,s));if(this.current(g))this.publish({records:Object.freeze([...previous,...page.records]),nextCursor:page.nextCursor,busy:false});}
  catch{if(this.current(g))this.publish({busy:false,error:'下一页没有读到，可以重试。'});}
 }
 async select(id:string){
  if(!this.current()||this.request||this.state.suspended||this.state.pending)return;
  const g=this.generation;this.selectedId=id;this.publish({selected:null,busy:true,error:''});
  try{const selected=await this.timed(s=>readFeedback(this.client,id,s));if(this.current(g))this.publish({selected,busy:false});}
  catch{if(this.current(g))this.publish({busy:false,error:'这条反馈暂时没有读到，请重新读取。'});}
 }
 begin(input:unknown){
  if(!this.current()||this.request||this.state.suspended||this.state.pending||!this.state.availability?.available)return false;
  const body=parseFeedbackSubmission(input);if(body.recipientId!==this.state.availability.recipient?.id){this.publish({error:'接收方已有变化，请重新读取并确认。'});return false;}
  this.publish({pending:body,error:'',notice:'',selected:null});void this.execute(false);return true;
 }
 retry(){return this.execute(false);}
 observe(){return this.execute(true);}
 private async execute(observe:boolean){
  const body=this.state.pending;if(!this.current()||this.request||this.state.suspended||!body)return;
  const g=this.generation;this.publish({busy:true,error:''});
  try{const r=await this.timed(s=>submitFeedback(this.client,body,s,observe));if(!this.current(g))return;this.selectedId=r.feedback.id;
   this.publish({records:null,nextCursor:null,selected:r.feedback,pending:null,busy:false,settled:body.operationId,notice:'反馈已保存。你可以在这里查看后续处理进展。'});
  }catch(e){
   if(!this.current(g))return;
   if(!observe&&e instanceof ApiError&&[400,401,403,404,409,413,422,429].includes(e.status)&&typeof e.code==='string'){
    this.publish({pending:null,busy:false,availability:null,error:e.code==='FEEDBACK_RECIPIENT_CHANGED'?'接收方已有变化，请重新读取并确认。':'这次反馈未提交成功，请重新读取后核对。'});
   }else this.publish({busy:false,error:observe&&e instanceof ApiError&&e.status===404?'暂时还没有查到这次提交。可以稍后核对，或用原内容重试。':'还不能确认是否已保存。请先核对这次提交，或用原内容重试。'});
  }
 }
}
