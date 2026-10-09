import {parseSharedMemoryCommand,type SharedMemoryRecord,type SharedMemoryCommandKind} from '@companion/platform-contracts';
import {readSharedMemoryPage,changeSharedMemory,readSharedMemoryUses,type SharedMemoryClient} from './shared-memory-api.ts';
import {ApiError} from './api-error.ts';
type Pending=Readonly<{kind:SharedMemoryCommandKind;id:string|null;body:ReturnType<typeof parseSharedMemoryCommand>}>;
type Undo=Pick<SharedMemoryRecord,'id'|'revision'|'deletionOperationId'|'undoUntil'>;
export interface SharedMemorySnapshot {
 readonly memories:readonly Readonly<SharedMemoryRecord>[];readonly nextCursor:string|null;
 readonly uses:Readonly<Record<string,Awaited<ReturnType<typeof readSharedMemoryUses>>>>;
 readonly loaded:boolean;readonly busy:boolean;readonly suspended:boolean;readonly pending:Pending|null;
 readonly error:string;readonly notice:string;readonly settledOperationId:string|null;readonly undo:Readonly<Undo>|null;
}
export const emptySharedMemories=():SharedMemorySnapshot=>Object.freeze({memories:Object.freeze([]),nextCursor:null,uses:Object.freeze({}),
 loaded:false,busy:false,suspended:false,pending:null,error:'',notice:'',settledOperationId:null,undo:null});
export class SharedMemoryController {
 private state=emptySharedMemories();private live=false;private generation=0;private request:AbortController|null=null;
 private unsubscribe:(()=>void)|null=null;
 private readonly client:SharedMemoryClient;private readonly changed:(state:SharedMemorySnapshot)=>void;private readonly timeoutMs:number;
 constructor(client:SharedMemoryClient,changed:(state:SharedMemorySnapshot)=>void,timeoutMs=8000){this.client=client;this.changed=changed;this.timeoutMs=timeoutMs;}
 snapshot(){return this.state;}
 private current(g=this.generation){return this.live&&this.client.isCurrent()&&g===this.generation;}
 private publish(patch:Partial<SharedMemorySnapshot>){if(this.current()){this.state=Object.freeze({...this.state,...patch});this.changed(this.state);}}
 start(suspended=false){if(this.live)return;this.live=true;this.unsubscribe=this.client.subscribe(()=>{if(!this.client.isCurrent())this.stop();});if(suspended)this.publish({suspended:true});else void this.refresh();}
 stop(){this.generation++;this.live=false;this.request?.abort();this.request=null;this.unsubscribe?.();this.unsubscribe=null;this.state=emptySharedMemories();this.changed(this.state);}
 suspend(){if(!this.current())return;this.generation++;this.request?.abort();this.request=null;this.publish({memories:Object.freeze([]),uses:Object.freeze({}),nextCursor:null,loaded:false,busy:false,suspended:true,error:'',notice:''});}
 resume(){if(!this.current())return;this.publish({suspended:false});void this.refresh();}
 expireUndo(){this.publish({undo:null});}
 private async timed<T>(run:(signal:AbortSignal)=>Promise<T>){
  const abort=new AbortController();this.request=abort;let cancel!:()=>void;
  const interrupted=new Promise<never>((_,reject)=>{cancel=()=>reject(new DOMException('Interrupted','AbortError'));abort.signal.addEventListener('abort',cancel,{once:true});});
  const timer=setTimeout(()=>abort.abort(),this.timeoutMs);
  try{return await Promise.race([run(abort.signal),interrupted]);}
  finally{clearTimeout(timer);abort.signal.removeEventListener('abort',cancel);if(this.request===abort)this.request=null;}
 }
 async refresh(more=false){
  if(!this.current()||this.request||this.state.suspended||more&&(!this.state.loaded||!this.state.nextCursor))return;
  const g=this.generation,cursor=more?this.state.nextCursor:null;
  this.publish({busy:true,error:'',...(!more?{memories:Object.freeze([]),uses:Object.freeze({}),nextCursor:null,loaded:false}:{})});
  try{
   const page=await this.timed(s=>readSharedMemoryPage(this.client,cursor,s));if(!this.current(g))return;
   const rows=more?[...this.state.memories]:[];
   for(const memory of page.memories){const index=rows.findIndex(m=>m.id===memory.id);if(index<0)rows.push(memory);else if(rows[index].revision<memory.revision)rows[index]=memory;}
   this.publish({busy:false,loaded:true,memories:Object.freeze(rows),nextCursor:page.nextCursor});
  }catch{if(this.current(g))this.publish({busy:false,loaded:false,memories:Object.freeze([]),uses:Object.freeze({}),nextCursor:null,error:'记忆暂时没读到，请重新读取。未提交的编辑仍保留在当前页面。'});}
 }
 async showUses(id:string){
  if(!this.current()||this.request||this.state.suspended||!this.state.loaded||this.state.pending||!this.state.memories.some(m=>m.id===id))return;
  const g=this.generation;this.publish({busy:true,error:''});
  try{const uses=await this.timed(s=>readSharedMemoryUses(this.client,id,s));if(this.current(g))this.publish({busy:false,uses:Object.freeze({...this.state.uses,[id]:uses})});}
  catch{if(this.current(g))this.publish({busy:false,error:'使用记录暂时没读到，请再试一次。'});}
 }
 begin(kind:SharedMemoryCommandKind,id:string|null,value:unknown){
  if(!this.current()||this.request||this.state.suspended||!this.state.loaded||this.state.pending)return false;
  const body=parseSharedMemoryCommand(kind,value),target=kind==='undo'?this.state.undo:this.state.memories.find(m=>m.id===id);
  if(kind!=='create'&&(!target||target.id!==id||target.revision!==body.expectedRevision)){
   this.publish({error:'这条记忆不在当前读取的版本中。请重新读取并核对内容，再决定修改。'});return false;
  }
  this.publish({pending:Object.freeze({kind,id,body}),error:'',notice:''});void this.execute();return true;
 }
 retry(){return this.execute();}
 private async execute(){
  const operation=this.state.pending;if(!this.current()||this.request||this.state.suspended||!operation)return;
  const g=this.generation;this.publish({busy:true,error:'',notice:''});
  try{
   const result=await this.timed(s=>changeSharedMemory(this.client,operation.kind,operation.id,operation.body,s));if(!this.current(g))return;
   const loaded=this.state.loaded,m=result.memory;
   const undo=operation.kind==='delete'&&m.deletedAt!==null&&m.deletionOperationId===operation.body.operationId?
    Object.freeze({id:m.id,revision:m.revision,deletionOperationId:m.deletionOperationId,undoUntil:m.undoUntil}):operation.kind==='undo'?null:this.state.undo;
   this.publish({busy:false,pending:null,settledOperationId:operation.body.operationId,undo,uses:Object.freeze({}),
    memories:loaded?Object.freeze([...(!m.deletedAt?[m]:[]),...this.state.memories.filter(x=>x.id!==m.id)]):Object.freeze([]),
    notice:m.revision>result.operation.appliedRevision?'已核对原操作；现在显示之后保存的新版本。':m.deletedAt?'已删除这条记忆。':'记忆已保存。'});
   if(!loaded)await this.refresh();
  }catch(error){
   if(!this.current(g))return;
   if(error instanceof ApiError&&[400,401,403,404,409,413,422,429].includes(error.status)&&typeof error.code==='string'){
    this.publish({busy:false,pending:null,loaded:false,memories:Object.freeze([]),uses:Object.freeze({}),nextCursor:null,
     ...(error.code==='MEMORY_UNDO_EXPIRED'||error.code==='MEMORY_REMOVED'?{undo:null}:{}),
     error:'这次操作未确认。请重新读取最新记忆，再核对你的修改。'});
   }else this.publish({busy:false,error:'还不能确认这次操作是否完成。可以重新读取列表，或由你选择用原操作重试。'});
  }
 }
}
