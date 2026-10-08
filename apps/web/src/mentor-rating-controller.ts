import { careerRecordId,parseMentorRatingCommand,type MentorRating,type MentorRatingCommand } from '@companion/platform-contracts';
import type { MentorControllerClient } from './mentor-intent-controller';
import { readMentorRating,changeMentorRating } from './mentor-rating-api.ts';
import { ApiError } from './api-error.ts';
export interface MentorRatingSnapshot {readonly loaded:boolean;readonly busy:boolean;readonly suspended:boolean;readonly rating:Readonly<MentorRating>|null;
 readonly pending:MentorRatingCommand|null;readonly uncertain:boolean;readonly error:string;}
export const emptyMentorRatingSnapshot=():MentorRatingSnapshot=>Object.freeze({loaded:false,busy:false,suspended:false,rating:null,pending:null,uncertain:false,error:''});
/** One account/card, explicit writes and original-operation recovery, without browser persistence. */
export class MentorRatingController {
 private state=emptyMentorRatingSnapshot();private live=false;private generation=0;private request:AbortController|null=null;private unsubscribe:(()=>void)|null=null;
 private readonly id:string;private readonly client:MentorControllerClient;private readonly changed:(s:MentorRatingSnapshot)=>void;private readonly timeoutMs:number;
 constructor(client:MentorControllerClient,id:string,changed:(s:MentorRatingSnapshot)=>void,timeoutMs=8000){this.id=careerRecordId(id);this.client=client;this.changed=changed;this.timeoutMs=timeoutMs;}
 snapshot(){return this.state;}
 private current(g=this.generation){return this.live&&g===this.generation&&this.client.isCurrent();}
 private publish(patch:Partial<MentorRatingSnapshot>){if(!this.current())return;this.state=Object.freeze({...this.state,...patch});this.changed(this.state);}
 start(suspended=false){if(this.live)return;this.live=true;this.unsubscribe=this.client.subscribe(()=>{if(!this.client.isCurrent())this.stop();});if(suspended)this.publish({suspended:true});else void this.refresh();}
 stop(){this.generation++;this.live=false;this.request?.abort();this.request=null;this.unsubscribe?.();this.unsubscribe=null;this.state=emptyMentorRatingSnapshot();this.changed(this.state);}
 suspend(){if(!this.current())return;this.generation++;this.request?.abort();this.request=null;this.publish({loaded:false,busy:false,suspended:true,rating:null,uncertain:!!this.state.pending,error:''});}
 resume(){if(!this.current())return;this.publish({suspended:false});void this.refresh();}
 private async timed<T>(run:(signal:AbortSignal)=>Promise<T>){
  const abort=new AbortController();this.request=abort;let cancel:(()=>void)|undefined;
  const cancelled=new Promise<never>((_,reject)=>{cancel=()=>reject(new DOMException('Interrupted','AbortError'));abort.signal.addEventListener('abort',cancel,{once:true});});
  const timer=setTimeout(()=>abort.abort(),this.timeoutMs);
  try{return await Promise.race([run(abort.signal),cancelled]);}finally{clearTimeout(timer);if(cancel)abort.signal.removeEventListener('abort',cancel);if(this.request===abort)this.request=null;}
 }
 async refresh(){if(!this.current()||this.request||this.state.suspended)return;const g=this.generation;this.publish({busy:true,error:'',loaded:false,rating:null});
  try{const result=await this.timed(s=>readMentorRating(this.client,this.id,s));if(this.current(g))this.publish({loaded:true,busy:false,rating:result.rating});}
  catch{if(this.current(g))this.publish({loaded:false,busy:false,rating:null,error:'会后反馈暂时没有读到，可以重新读取。'});}
 }
 begin(input:MentorRatingCommand){if(!this.current()||this.request||this.state.suspended||this.state.pending||!this.state.loaded||this.state.rating)return;
  const pending=parseMentorRatingCommand(input);this.publish({pending,uncertain:false,error:''});void this.execute(false);}
 retry(){return this.execute(false);}
 observe(){return this.execute(true);}
 private async execute(observe:boolean){const pending=this.state.pending;if(!this.current()||!pending||this.request||this.state.suspended)return;const g=this.generation;this.publish({busy:true,error:''});
  try{const result=await this.timed(s=>changeMentorRating(this.client,this.id,pending,observe,s));if(this.current(g)){this.publish({loaded:true,busy:false,rating:result.rating,pending:null,uncertain:false,error:''});return result;}}
  catch(e){if(!this.current(g))return;
   if(!observe&&e instanceof ApiError&&[400,401,403,404,409,413,422,429].includes(e.status)&&typeof e.code==='string')this.publish({busy:false,pending:null,uncertain:false,loaded:false,rating:null,error:'这次没有保存，或已有反馈。请重新读取。'});
   else this.publish({busy:false,uncertain:true,error:'反馈结果还没确认。可以核对这次操作，或用原操作重试。'});
  }
 }
}
