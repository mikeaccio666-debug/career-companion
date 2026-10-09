import { useEffect,useMemo,useRef,useState } from 'react';
import { SHARED_MEMORY_CATEGORIES,type SharedMemoryRecord,type SharedMemoryCategory,type SharedMemorySensitivity,type AgentSpeakerKey,type SharedMemoryCommandKind } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { SharedMemoryController,emptySharedMemories } from './shared-memory-controller';
import { bindPrivatePageLifecycle } from './private-page-lifecycle';
import './career-design-tokens.css';
import './shared-memory-view.css';
const categoryLabels:Record<SharedMemoryCategory,string>={agreement:'约定',communication:'沟通偏好',goal_preference:'目标与偏好',experience:'经历与证据',identity_timeline:'时间线',emotion_rhythm:'情绪与节奏'};
const sourceLabels={user_saved:'你保存的',user_stated:'你纠正过',companion_proposed:'主理人提议',expert_proposed:'队员提议',imported:'导入内容'};
const sensitivityLabels:Record<SharedMemorySensitivity,string>={normal:'普通',sensitive:'敏感',restricted:'受限'};
const speakerLabels:Record<AgentSpeakerKey,string>={companion:'主理人',planner:'规划师',guide:'前辈',coach:'技能教练',interviewer:'面试官',networker:'人脉官',applier:'投递官'};
function eligible(m:SharedMemoryRecord){
 if(m.kind==='needs_review')return '尚未确认，不供主理人或队伍使用';
 if(m.status!=='confirmed'||m.confidence==='low')return '暂不使用，等待确认';
 if(m.validUntil!==null&&m.validUntil<=new Date().toISOString())return '有效期已过，暂不使用';
 if(m.sensitivity==='restricted')return '仅主理人：你主动提起或自设提醒时，只出现在网页正文';
 if(m.sensitivity==='sensitive')return '原文仅供主理人在网页使用，不送队员、语音或 Discord';
 if(m.speakerScope)return speakerLabels[m.speakerScope]+'（这条沟通偏好仅对它生效）';
 return m.category==='emotion_rhythm'?'主理人':'主理人、前辈、投递官、面试官（各按类别和用途使用）';
}
interface EditDraft { memory:SharedMemoryRecord|null;content:string;category:SharedMemoryCategory|'';sensitivity:SharedMemorySensitivity|'';usePolicy:'normal'|'only_if_user_raises';speakerScope:AgentSpeakerKey|null;validUntil:string; }
const draft=(m:SharedMemoryRecord|null):EditDraft=>({memory:m,content:m?.content??'',category:m?.category??'',sensitivity:m?.sensitivity??'',usePolicy:m?.usePolicy??'normal',speakerScope:m?.speakerScope??null,
 validUntil:m?.validUntil?new Date(Date.parse(m.validUntil)-new Date(m.validUntil).getTimezoneOffset()*60000).toISOString().slice(0,16):''});
export default function SharedMemoryPanel(){
 const client=useRequiredPlatformAccountClient();
 const [view,setView]=useState(()=>({client,state:emptySharedMemories()}));
 const controller=useMemo(()=>new SharedMemoryController(client,state=>setView({client,state})),[client]);
 const state=view.client===client&&client.isCurrent()?view.state:emptySharedMemories();
 const [editing,setEditing]=useState<{client:typeof client;editor:EditDraft|null;deleting:string|null;error:string}>({client,editor:null,deleting:null,error:''});
 const submitted=useRef<{client:typeof client;operationId:string;editor:EditDraft}|null>(null);
 const current=()=>client.isCurrent(),bound=editing.client===client&&current();
 const editor=bound?editing.editor:null,deleting=bound?editing.deleting:null;
 const setEditor=(editor:EditDraft|null)=>setEditing(previous=>({client,editor,deleting:previous.client===client?previous.deleting:null,error:''}));
 const setDeleting=(deleting:string|null)=>setEditing(previous=>({client,editor:previous.client===client?previous.editor:null,deleting,error:''}));
 const setError=(error:string)=>setEditing(previous=>({...previous,client,error}));
 const {memories,nextCursor,loaded,uses,undo}=state,writing=state.busy&&!!state.pending,loading=state.busy&&!state.pending,uncertain=!!state.pending;
 const error=(bound?editing.error:'')||state.error;
 const busy=state.busy||state.suspended||!loaded||uncertain;
 useEffect(()=>{
  const lifecycle=bindPrivatePageLifecycle(controller,window,document,()=>navigator.onLine);
  const unsubscribe=client.subscribe(()=>{if(!client.isCurrent()){setEditing({client,editor:null,deleting:null,error:''});submitted.current=null;}});
  return()=>{unsubscribe();lifecycle.dispose();submitted.current=null;};
 },[controller,client]);
 useEffect(()=>{
  if(!state.settledOperationId)return;
  const saved=submitted.current;
  setEditing(previous=>previous.client===client?{...previous,deleting:null,error:'',
   editor:saved?.client===client&&saved.operationId===state.settledOperationId&&previous.editor===saved.editor?null:previous.editor}:previous);
  if(saved?.client===client&&saved.operationId===state.settledOperationId)submitted.current=null;
 },[client,state.settledOperationId]);
 useEffect(()=>{
  if(!undo)return;const delay=Math.min(10000,Math.max(0,Date.parse(undo.undoUntil??'')-Date.now()));
  const timer=setTimeout(()=>controller.expireUndo(),Number.isFinite(delay)?delay:0);return()=>clearTimeout(timer);
 },[controller,undo]);
 const changed=!!editor&&JSON.stringify(editor)!==JSON.stringify(draft(editor.memory));
 useEffect(()=>{
  if(!current()||!state.pending&&!changed)return;
  const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
  window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);
 },[client,state.pending,changed]);
 function begin(kind:SharedMemoryCommandKind,id:string|null,body:Record<string,unknown>,submittedEditor?:EditDraft){
  if(busy||!current())return;
  const operationId=crypto.randomUUID();
  try{if(controller.begin(kind,id,{...body,operationId})&&submittedEditor)submitted.current={client,operationId,editor:submittedEditor};}
  catch{setError('请核对内容、类别、敏感度和有效期，再保存。');}
 }
 function save(){if(!editor||!editor.content.trim()||!editor.category||!editor.sensitivity||Array.from(editor.content).length>2000||busy)return;
  const {memory:m}=editor;if(m){const latest=memories.find(x=>x.id===m.id);if(latest&&latest.revision!==m.revision){setError('你正在编辑旧版。先核对最新内容，再决定如何修改。');return;}}
  const expiry=editor.validUntil?new Date(editor.validUntil):null;
  if(expiry&&!Number.isFinite(expiry.getTime())){setError('请填写有效的本地日期和时间，或清空有效期。');return;}
  const fields={category:editor.category,sensitivity:editor.sensitivity,usePolicy:editor.usePolicy,speakerScope:editor.category==='communication'?editor.speakerScope:null,validUntil:expiry?expiry.toISOString():null};
  if(!m)begin('create',null,{...fields,content:editor.content},editor);
  else if(m.kind==='needs_review'||m.status==='proposed')begin('confirm',m.id,{...fields,...(editor.content!==m.content?{editedContent:editor.content}:{}),expectedRevision:m.revision},editor);
  else begin('edit',m.id,{...fields,content:editor.content,expectedRevision:m.revision},editor);
 }
 if(!client.isCurrent())return null;
 return <section className="shared-memory-panel career-surface" aria-labelledby="shared-memory-title"><header><h2 id="shared-memory-title">它记得的你</h2><span className="shared-memory-ai">AI 主理人和队伍</span></header>
  <p>这里是你选择保存的长期信息。由你决定保存什么，以及谁可以使用。</p><p className="shared-memory-caption">旧记忆先由你逐条检查内容、类别和敏感度；确认前仅你可见。</p>
  <div className="shared-memory-actions"><button type="button" className="memory-primary" aria-disabled={busy} onClick={()=>!busy&&setEditor(draft(null))}>记一条</button><button type="button" aria-disabled={state.busy||state.suspended} onClick={()=>!state.busy&&!state.suspended&&void controller.refresh()}>重新读取</button></div>
  {state.suspended&&<p role="status">回到页面并恢复连接后，会重新读取你的记忆。</p>}{state.notice&&<p role="status">{state.notice}</p>}{loading&&<p role="status">正在读取你的记忆…</p>}{error&&<p role="alert" className="shared-memory-notice">{error}</p>}{uncertain&&<div role="status"><p>这次保存还待核对。重新读取列表不会证明原操作已完成，也不会自动再次提交。</p><button type="button" aria-disabled={state.busy||state.suspended} onClick={()=>!state.busy&&!state.suspended&&void controller.retry()}>用原操作重试</button></div>}
  {loaded&&undo&&<div className="shared-memory-undo" role="status">已删除，之后主理人和队伍不会再使用这条记忆。<button type="button" aria-disabled={busy} onClick={()=>!busy&&begin('undo',undo.id,{expectedRevision:undo.revision,deletionOperationId:undo.deletionOperationId})}>撤销</button></div>}
  {loaded&&editor&&<form className="shared-memory-editor" onSubmit={e=>{e.preventDefault();save();}}><h3>{editor.memory?.kind==='needs_review'?'复核旧记忆':editor.memory?'修改记忆':'记一条'}</h3>
   <label>内容<textarea value={editor.content} readOnly={busy} onChange={e=>!busy&&setEditor({...editor,content:e.target.value})} rows={4} /></label><p className="shared-memory-caption">最多 2,000 字。只保存你确认过的内容；旧内容过长时可由你改成简短事实。</p>
   <div className="shared-memory-fields"><label>类别<select aria-disabled={busy} value={editor.category} onChange={e=>!busy&&setEditor({...editor,category:e.target.value as SharedMemoryCategory})}><option value="">请选择类别</option>{SHARED_MEMORY_CATEGORIES.map(k=><option key={k} value={k}>{categoryLabels[k]}</option>)}</select></label>
    <label>敏感度<select aria-disabled={busy} value={editor.sensitivity} onChange={e=>!busy&&setEditor({...editor,sensitivity:e.target.value as SharedMemorySensitivity})}><option value="">请选择敏感度</option>{Object.entries(sensitivityLabels).map(([k,label])=><option key={k} value={k}>{label}</option>)}</select></label>
    <label>什么时候使用<select aria-disabled={busy} value={editor.usePolicy} onChange={e=>!busy&&setEditor({...editor,usePolicy:e.target.value as EditDraft['usePolicy']})}><option value="normal">按敏感度和用途使用</option><option value="only_if_user_raises">我主动提起时再用</option></select></label>
    {editor.category==='communication'&&<label>对谁生效<select aria-disabled={busy} value={editor.speakerScope??''} onChange={e=>!busy&&setEditor({...editor,speakerScope:e.target.value?e.target.value as AgentSpeakerKey:null})}><option value="">主理人和可用队员</option>{(['companion','guide','applier','interviewer'] as const).map(k=><option key={k} value={k}>{speakerLabels[k]}</option>)}</select></label>}
    <label>有效到（你的本地时间，可留空）<input type="datetime-local" readOnly={busy} value={editor.validUntil} onChange={e=>!busy&&setEditor({...editor,validUntil:e.target.value})}/></label></div>
   <p className="shared-memory-caption">敏感原文只供主理人在网页使用；身份、签证、心理或健康内容请选择受限，只在你主动提起或自设提醒时使用。</p>
   {editor.memory&&memories.some(m=>m.id===editor.memory!.id&&m.revision!==editor.memory!.revision)&&<button type="button" aria-disabled={busy} onClick={()=>{const latest=memories.find(m=>m.id===editor.memory!.id);if(!busy&&latest)setEditor(draft(latest));}}>放弃本次修改，改用最新内容</button>}
   <div className="shared-memory-actions"><button className="memory-primary" aria-disabled={busy||!editor.category||!editor.sensitivity||!editor.content.trim()||Array.from(editor.content).length>2000} type="submit">{writing?'正在保存…':'确认并保存'}</button><button type="button" aria-disabled={writing||uncertain} onClick={()=>!writing&&!uncertain&&setEditor(null)}>取消</button></div>
  </form>}
  {loaded&&!loading&&!error&&!memories.length&&<p className="shared-memory-empty">还没有长期记忆。你可以先保存一条重要的偏好或约定。</p>}
  {(['needs_review',...SHARED_MEMORY_CATEGORIES] as const).map(group=>{const items=memories.filter(m=>group==='needs_review'?m.kind==='needs_review':m.kind==='memory'&&m.category===group);if(!items.length)return null;
   return <section className="shared-memory-group" key={group}><h3>{group==='needs_review'?'旧记忆 · 待复核':categoryLabels[group]}</h3>{items.map(m=><article className="shared-memory-card" key={m.id}>{m.sensitivity==='restricted'?<details className="shared-memory-private"><summary>受限内容 · 点击查看</summary><p className="shared-memory-content">{m.content}</p></details>:<p className="shared-memory-content">{m.content}</p>}<div className="shared-memory-meta"><span>{m.kind==='needs_review'?'待复核':m.status==='archived'?'已归档':m.status==='proposed'?'待确认':'已确认'}</span>{m.sensitivity&&<span>{sensitivityLabels[m.sensitivity]}</span>}<span>{m.source?sourceLabels[m.source]:'旧记录，来源待复核'}</span><span>{m.kind==='needs_review'?'记录于':'更新于'}</span><time dateTime={m.updatedAt}>{new Date(m.updatedAt).toLocaleDateString('zh-CN')}</time></div>
    <p className="shared-memory-caption">{eligible(m)}{m.usePolicy==='only_if_user_raises'?'；不会主动提起':''}</p>
    <div className="shared-memory-actions"><button type="button" aria-disabled={busy} onClick={()=>!busy&&setEditor(draft(m))}>{m.kind==='needs_review'||m.status==='proposed'?'复核并确认':'修改'}</button>{m.kind==='memory'&&<button type="button" aria-disabled={busy} onClick={()=>!busy&&begin('edit',m.id,{expectedRevision:m.revision,status:m.status==='archived'?'confirmed':'archived'})}>{m.status==='archived'?'恢复':'归档'}</button>}<button type="button" aria-disabled={busy} onClick={()=>!busy&&setDeleting(m.id)}>删除</button><button type="button" aria-disabled={busy} onClick={()=>!busy&&void controller.showUses(m.id)}>最近被用到</button></div>
    {uses[m.id]&&<p className="shared-memory-caption">{uses[m.id].length?`最近一次：${speakerLabels[uses[m.id][0].speaker as AgentSpeakerKey]}，${new Date(uses[m.id][0].createdAt).toLocaleString('zh-CN')}`:'暂无使用记录。'}</p>}
    {deleting===m.id&&<div className="shared-memory-delete" role="group" aria-label="确认删除这条记忆"><p>删除后，主理人和队伍不会再使用它。已发出的信件和已确认材料需在对应位置单独修改。</p><button type="button" aria-disabled={busy} onClick={()=>!busy&&begin('delete',m.id,{expectedRevision:m.revision})}>确认删除</button><button type="button" aria-disabled={busy} onClick={()=>!busy&&setDeleting(null)}>取消</button></div>}
   </article>)}</section>;
  })}{nextCursor&&<button type="button" aria-disabled={busy} onClick={()=>!busy&&void controller.refresh(true)}>读取更多记忆</button>}
 </section>;
}
export function SharedMemoryPage({onLogout}:{onLogout:()=>void}){return <main className="shared-memory-page career-surface"><nav><a href="/">回到对话</a><button type="button" onClick={onLogout}>退出登录</button></nav><SharedMemoryPanel/></main>;}
