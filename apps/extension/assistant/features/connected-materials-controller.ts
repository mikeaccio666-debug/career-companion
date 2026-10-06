import { parseUuid, type ApplicationMaterialPlan, type ApplicationPreparationView, type AssistantCommerceCommand,
  type AssistantCommerceResult, type AssistantCoverDraftRequest, type AssistantCoverDraftResponse, type StartApplicationPreparationsRequest } from '@edaix/contracts';
import { isCurrent, type ControllerContext } from '../app/controller-context';
import { abortableDelay } from '../ports/assistant-ports';
export interface ConnectedMaterialsState {
 roleId:string|null; loading:boolean; busy:boolean; choice:string|null;
 choices:readonly {id:string;label:string;plan:ApplicationMaterialPlan}[];
 preparations:Record<string,ApplicationPreparationView>; covers:Record<string,AssistantCoverDraftResponse>;
}
export const emptyMaterials=():ConnectedMaterialsState=>({roleId:null,loading:false,busy:false,choice:null,choices:[],preparations:{},covers:{}});
export function createConnectedMaterialsController(ctx:ControllerContext){
 const state=()=>ctx.state.materials??emptyMaterials();
 const set=(p:Partial<ConnectedMaterialsState>)=>ctx.patch({materials:{...state(),...p}});
 const requests=new Map<string,AssistantCommerceCommand>();
 let polling=false;
 const current=(scope:ReturnType<typeof ctx.store.scope>,role:string|null)=>isCurrent(ctx,scope)&&ctx.state.currentTargetId===role;
 async function execute(command:AssistantCommerceCommand,signal:AbortSignal):Promise<AssistantCommerceResult>{
  try{return await ctx.ports.commerce!.execute(command,signal);}catch{return {operation:command.operation,ok:false,code:['PREPARATION_START','PREPARATION_RETRY','COVER_WRITE'].includes(command.operation)?'SAVE_UNCERTAIN':'UNAVAILABLE'};}
 }
 function failure(r:AssistantCommerceResult){if(r.ok)return;ctx.toast(ctx.t(r.code==='REVISION_CONFLICT'?'内容已变化，请刷新后重试。':
  r.code==='RATE_LIMITED'?'今天的服务调用次数已达安全上限，请明天再试；已保存资料仍可编辑。':r.code==='SAVE_UNCERTAIN'?'结果尚未确认，请刷新查看；重复请求不会重复扣量。':'材料服务暂不可用，请稍后重试。'));}
 function project(batchId:string,items:readonly ApplicationPreparationView[]){
  const entries=Object.values(ctx.state.commerce?.entries??{}).filter(e=>e.batchId===batchId);
  const preparations={...state().preparations};
  for(const item of items){const entry=entries.find(e=>e.itemId===item.itemId);if(entry)preparations[entry.id]=item;}
  set({preparations});
  ctx.patch(s=>({...s,prep:Object.fromEntries(Object.entries(preparations).map(([id,p])=>[id,p.status==='READY'?'ready':p.status==='FAILED'?'failed':'preparing'])),
   preparedResume:Object.fromEntries(Object.entries(preparations).filter(([,p])=>p.resumeVersionId).map(([id,p])=>[id,p.resumeVersionId!]))}));
 }
 async function recoverPreparations(scope:ReturnType<typeof ctx.store.scope>,role:string|null){
  if(state().busy||!current(scope,role))return;
  const pending=[...requests].filter(([,c])=>c.operation==='PREPARATION_START'||c.operation==='PREPARATION_RETRY');
  if(!pending.length)return;
  set({busy:true});
  try{for(const [key,command] of pending){
   if(!current(scope,role))return;
   if(command.operation!=='PREPARATION_START'&&command.operation!=='PREPARATION_RETRY')continue;
   // A READY list row cannot identify which request committed. Replay the exact
   // idempotent command to confirm its receipt before releasing the plan lock.
   const r=await execute(command,scope.signal);if(!current(scope,role))return;
   if(r.ok&&(r.operation==='PREPARATION_START'||r.operation==='PREPARATION_RETRY')&&r.operation===command.operation&&
    r.value.batchId===command.batchId&&r.value.conversationId===role){
    project(command.batchId,r.value.items);requests.delete(key);
   }else{failure(r);if(!r.ok&&r.code!=='SAVE_UNCERTAIN')requests.delete(key);}
  }}finally{if(current(scope,role))set({busy:false});}
 }
 async function refresh(options=true,recover=true){
  const role=ctx.state.currentTargetId,scope=ctx.store.scope();if(!role)return;
  if(state().roleId!==role){requests.clear();ctx.patch({materials:{...emptyMaterials(),roleId:role}});}
  set({loading:true});
  try{
   if(options){
    const selection=await execute({operation:'RESUME_SELECTION'},scope.signal);
    if(!current(scope,role))return;
    const library=await execute({operation:'RESUME_LIBRARY'},scope.signal);
    if(!current(scope,role))return;
    const choices:ConnectedMaterialsState['choices'][number][]=[];
    if(selection.ok&&selection.operation==='RESUME_SELECTION')for(const v of selection.value.items)choices.push({id:`existing:${v.resumeVersionId}`,
      label:v.label||`${v.trackName} · v${v.versionNumber}`,plan:{mode:'USE_EXISTING',trackId:v.trackId,resumeVersionId:v.resumeVersionId,expectedLibraryRevision:selection.value.libraryRevision}});
    if(library.ok&&library.operation==='RESUME_LIBRARY')for(const t of library.value.tracks.filter(t=>t.archivedAt===null))choices.push({id:`generate:${t.trackId}`,
      label:t.name,plan:{mode:'GENERATE_FOR_JOB',trackId:t.trackId,expectedLibraryRevision:library.value.libraryRevision}});
    set({choices,choice:choices.some(c=>c.id===state().choice)?state().choice:null});
    if(!selection.ok&&!library.ok)failure(selection);
   }
   const batches=[...new Set(ctx.state.deck.selected.map(id=>ctx.state.commerce?.entries[id]?.batchId).filter((id):id is string=>!!id))];
   for(const batchId of batches){
    const r=await execute({operation:'PREPARATION_LIST',batchId},scope.signal);
    if(!current(scope,role))return;
    if(r.ok&&r.operation==='PREPARATION_LIST'&&r.value.conversationId===role)project(batchId,r.value.items);else failure(r);
   }
   if(recover)await recoverPreparations(scope,role);
  }finally{if(current(scope,role))set({loading:false});}
 }
 async function poll(){if(polling)return;polling=true;const scope=ctx.store.scope(),role=ctx.state.currentTargetId;
  try{for(let i=0;i<30&&current(scope,role);i++){
   if(!Object.values(state().preparations).some(p=>['QUEUED','GENERATING_RESUME','BINDING_MISSION'].includes(p.status)))return;
   if(!await abortableDelay(2000,scope.signal))return;await refresh(false,false);
  }}finally{polling=false;}
 }
 async function prepare(){
  if(state().busy)return;
  const choice=state().choices.find(c=>c.id===state().choice);
  if(!choice){ctx.toast(ctx.t('请明确选择一份简历或生成方式。'));return;}
  const role=ctx.state.currentTargetId,scope=ctx.store.scope();set({busy:true});
  try{for(const id of ctx.state.deck.selected){
   if(!current(scope,role))return;
   const previous=state().preparations[id];
   if(previous && !(previous.status==='FAILED'&&previous.failureCode==='SOURCE_CHANGED'))continue;
   const entry=ctx.state.commerce?.entries[id];if(!entry)continue;
   let command=requests.get(`prepare:${id}`);
   if(!command){
    const batch=await execute({operation:'PREPARATION_BATCH',batchId:entry.batchId},scope.signal);
    if(!current(scope,role))return;
    if(!batch.ok||batch.operation!=='PREPARATION_BATCH'){failure(batch);continue;}
    if(batch.value.batch.conversationId!==role)continue;
    const item=batch.value.batch.items.find(i=>i.id===entry.itemId);
    if(!item||item.status!=='PENDING'){ctx.toast(ctx.t('该岗位状态已变化，请刷新清单。'));continue;}
    const request:StartApplicationPreparationsRequest={clientRequestId:parseUuid(crypto.randomUUID())!,expectedRevision:batch.value.batch.revision,
      decisions:[{itemId:item.id,itemRevision:item.revision,decision:'APPLY'}],materialPlan:choice.plan};
    command={operation:'PREPARATION_START',batchId:entry.batchId,request};requests.set(`prepare:${id}`,command);
   }
   const r=await execute(command,scope.signal);if(!current(scope,role))return;
   if(r.ok&&r.operation==='PREPARATION_START'){project(entry.batchId,r.value.items);requests.delete(`prepare:${id}`);}
   else{failure(r);if(!r.ok&&r.code!=='SAVE_UNCERTAIN')requests.delete(`prepare:${id}`);}
  }}finally{if(current(scope,role))set({busy:false});}
  await refresh(false);void poll();
 }
 async function retry(id:string){
  const p=state().preparations[id],entry=ctx.state.commerce?.entries[id];if(!entry||!p?.retryable||state().busy)return;
  const role=ctx.state.currentTargetId,scope=ctx.store.scope();set({busy:true});
  const command=requests.get(`retry:${id}`)??{operation:'PREPARATION_RETRY',batchId:entry.batchId,preparationId:p.preparationId,
   request:{clientRequestId:parseUuid(crypto.randomUUID())!,expectedRevision:p.revision}};
  requests.set(`retry:${id}`,command);
  const r=await execute(command,scope.signal);if(!current(scope,role))return;
  set({busy:false});if(r.ok&&r.operation==='PREPARATION_RETRY'){project(entry.batchId,r.value.items);requests.delete(`retry:${id}`);}else{failure(r);if(!r.ok&&r.code!=='SAVE_UNCERTAIN')requests.delete(`retry:${id}`);}
  void poll();
 }
 function coverResult(id:string,r:AssistantCoverDraftResponse){
  set({covers:{...state().covers,[id]:r}});
  ctx.patch(s=>({...s,letters:{...s.letters,[id]:r.draft?{status:'kept',text:r.draft.body}:{status:'draft',text:''}}}));
 }
 async function openCover(id:string){if(!ctx.state.commerce?.entries[id])return;ctx.patch({coverId:id,sheet:null});await ctx.go('cover');
  const scope=ctx.store.scope(),role=ctx.state.currentTargetId,r=await execute({operation:'COVER_READ',entryId:id},scope.signal);
  if(!current(scope,role)||ctx.state.coverId!==id)return;
  if(r.ok&&r.operation==='COVER_READ')coverResult(id,r.value);else failure(r);
 }
 async function coverWrite(operation:'SAVE'|'GENERATE'|'DELETE'){
  const id=ctx.state.coverId,head=state().covers[id];if(!head||state().busy)return;
  const text=ctx.state.letters[id]?.text??'';if(operation==='SAVE'&&!text.trim())return;
  const key=`cover:${id}:${operation}`;
  let command=requests.get(key);
  if(!command){const request:AssistantCoverDraftRequest={clientRequestId:crypto.randomUUID(),expectedRevision:head.revision,
    ...(operation==='SAVE'?{operation,body:text}:operation==='GENERATE'?{operation,unknownRequirementChoice:'GENERATE'}:{operation})};
   command={operation:'COVER_WRITE',entryId:id,request};requests.set(key,command);}
  const scope=ctx.store.scope(),role=ctx.state.currentTargetId;set({busy:true});
  const r=await execute(command,scope.signal);if(!current(scope,role))return;set({busy:false});
  if(r.ok&&r.operation==='COVER_WRITE'){
   const edited=ctx.state.letters[id];
   coverResult(id,r.value);
   const unsaved=command.operation==='COVER_WRITE'&&command.request.operation==='SAVE'&&edited&&edited.text!==command.request.body;
   if(unsaved)ctx.patch(s=>({...s,letters:{...s.letters,[id]:edited}}));
   requests.delete(key);ctx.toast(ctx.t(unsaved?'先前版本已保存；当前修改尚未保存。':operation==='DELETE'?'草稿已删除。':'草稿已保存。'));}
  else{failure(r);if(!r.ok&&r.code!=='SAVE_UNCERTAIN')requests.delete(key);}
 }
 return {refresh,prepare,retry,openCover,coverWrite,
  select(id:string){if(state().busy||requests.size)return;
   if(state().choices.some(c=>c.id===id))set({choice:id});},
  edit(text:string){if(state().busy)return;const id=ctx.state.coverId;ctx.patch(s=>({...s,letters:{...s.letters,[id]:{status:'draft',text,edited:true}}}));},
  async open(){await refresh();void poll();}
 };
}
