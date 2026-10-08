import { useCallback,useEffect,useRef,useState } from 'react';
import { CAREER_ROLE_FAMILIES,parseCareerTargetCommand,type CareerTarget,type CareerTargetAction,type CareerTargetRoleFamily,type CareerTargetStatus } from '@companion/platform-contracts';
import { ApiError } from './api';
import { useRequiredPlatformAccountClient } from './account-client';
import { readCareerTargets,changeCareerTarget } from './career-target-api';
import './career-target-view.css';
const roleLabels:Record<CareerTargetRoleFamily,string>={swe:'Software Engineering',mle:'Machine Learning Engineering',ds:'Data Science',da:'Data Analytics',de:'Data Engineering',hw:'硬件 / 本专业',other:'其他方向'};
const statuses:Record<CareerTargetStatus,string>={exploring:'还在探索',active:'暂定主攻',paused:'先暂停',dropped:'已放下'};
interface Editor {record:Readonly<CareerTarget>|null;roleFamily:CareerTargetRoleFamily|'';title:string;locations:string;priority:string;}
const draft=(r:Readonly<CareerTarget>|null):Editor=>({record:r,roleFamily:r?.roleFamily??'',title:r?.title??'',locations:r?.locations.join('，')??'',priority:String(r?.priority??1)});
export default function CareerTargetPanel(){
 const client=useRequiredPlatformAccountClient(),live=useRef(true),epoch=useRef(0),request=useRef<AbortController|null>(null),pending=useRef<{action:CareerTargetAction;id:string|null;body:Record<string,unknown>}|null>(null);
 const [targets,setTargets]=useState<readonly Readonly<CareerTarget>[]>([]),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false),[editor,setEditor]=useState<Editor|null>(null),[confirmation,setConfirmation]=useState<{target:Readonly<CareerTarget>;status:CareerTargetStatus|null}|null>(null);
 const current=()=>live.current&&client.isCurrent();
 const load=useCallback(async()=>{if(!live.current||!client.isCurrent()||request.current)return;const version=++epoch.current,abort=new AbortController();request.current=abort;setBusy(true);
  try{const result=await readCareerTargets(client,abort.signal);if(live.current&&client.isCurrent()&&version===epoch.current){setTargets(result);setLoaded(true);setError('');}}
  catch(e){if(live.current&&client.isCurrent()&&!abort.signal.aborted)setError(e instanceof ApiError?e.message:'方向暂时没读到，请稍后再试。');}
  finally{if(live.current&&client.isCurrent()&&version===epoch.current){request.current=null;setBusy(false);}}
 },[client]);
 useEffect(()=>{live.current=true;void load();const unsubscribe=client.subscribe(()=>{if(!client.isCurrent()){live.current=false;epoch.current++;request.current?.abort();pending.current=null;setTargets([]);setEditor(null);setConfirmation(null);setLoaded(false);setUncertain(false);}});
  return()=>{live.current=false;epoch.current++;request.current?.abort();request.current=null;pending.current=null;unsubscribe();};
 },[client,load]);
 async function execute(){const operation=pending.current;if(!operation||busy||!current()||request.current)return;const abort=new AbortController(),version=++epoch.current;request.current=abort;setBusy(true);setError('');
  try{const result=await changeCareerTarget(client,operation.action,operation.id,operation.body,abort.signal);if(!current()||version!==epoch.current)return;
   setTargets(previous=>[...previous.filter(t=>t.id!==result.operation.targetId),...(result.target?[result.target]:[])].sort((a,b)=>a.priority-b.priority||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)));pending.current=null;setUncertain(false);setEditor(null);setConfirmation(null);
  }catch(e){if(!current()||abort.signal.aborted)return;if(e instanceof ApiError&&e.status>=400&&e.status<500){pending.current=null;setUncertain(false);setError(e.status===409?'方向已经变化，请重新读取，再核对你的修改。':e.message);}else{setUncertain(true);setError('暂时不能确认这次保存是否完成。可以重新读取，或用原操作重试。');}}
  finally{if(current()&&version===epoch.current){request.current=null;setBusy(false);}}
 }
 function begin(action:CareerTargetAction,id:string|null,body:Record<string,unknown>){if(busy||uncertain||request.current||!current())return;const command=parseCareerTargetCommand(action,{...body,operationId:crypto.randomUUID()});pending.current={action,id,body:{...command}};void execute();}
 function save(){if(!editor||busy||uncertain||!editor.roleFamily)return;const r=editor.record;if(r&&targets.find(t=>t.id===r.id)?.revision!==r.revision){setError('你正在编辑旧版，先核对最新方向再保存。');return;}
  const locations=editor.locations.trim()?editor.locations.split(/[,，]/).map(x=>x.trim()).filter(Boolean):[];const body={roleFamily:editor.roleFamily,title:editor.title.trim(),locations,priority:Number(editor.priority),expectedRevision:r?.revision??0};
  try{begin(r?'edit':'create',r?.id??null,body);}catch{setError('请选择岗位家族；方向名称最多 120 字，地点最多 10 个，排序为 1–100。');}
 }
 function applyConfirmation(){if(!confirmation||busy||uncertain)return;const r=confirmation.target;if(targets.find(t=>t.id===r.id)?.revision!==r.revision){setError('方向已经变化，请重新读取再决定。');return;}begin(confirmation.status===null?'delete':'status',r.id,{expectedRevision:r.revision,...(confirmation.status===null?{}:{status:confirmation.status})});}
 return <section className="career-target-panel" aria-labelledby="career-target-title"><header><h1 id="career-target-title">你想尝试的方向</h1><p>先记录，再用一个小行动验证。方向是暂定的，可以随时调整。</p></header>
  <div className="career-target-actions"><button type="button" disabled={busy||uncertain} onClick={()=>setEditor(draft(null))}>记录一个方向</button><button type="button" disabled={busy} onClick={()=>void load()}>重新读取</button></div>
  {busy&&<p role="status">正在读取或保存…</p>}{error&&<p role="alert" className="career-target-notice">{error}</p>}{uncertain&&<button type="button" disabled={busy} onClick={()=>void execute()}>用原操作重试</button>}
  {loaded&&!targets.length&&!editor&&<p className="career-target-empty">还没记录方向。可以先记下一个想体验的岗位家族。</p>}
  {editor&&<form className="career-target-editor" onSubmit={e=>{e.preventDefault();save();}}><h2>{editor.record?'修改这个方向':'记录一个想探索的方向'}</h2>
   <label>岗位家族<select value={editor.roleFamily} disabled={busy||uncertain} onChange={e=>setEditor({...editor,roleFamily:e.target.value as Editor['roleFamily']})}><option value="">请选择</option>{CAREER_ROLE_FAMILIES.map(k=><option key={k} value={k}>{roleLabels[k]}</option>)}</select></label>
   <label>方向名称<input value={editor.title} maxLength={240} required disabled={busy||uncertain} onChange={e=>setEditor({...editor,title:e.target.value})} placeholder="例如 Backend SWE"/></label>
   <label>想去的地点（可留空）<input value={editor.locations} disabled={busy||uncertain} onChange={e=>setEditor({...editor,locations:e.target.value})} placeholder="用逗号分开"/></label>
   <label>排序（数字越小越靠前）<input type="number" min={1} max={100} step={1} value={editor.priority} disabled={busy||uncertain} onChange={e=>setEditor({...editor,priority:e.target.value})}/></label>
   <div className="career-target-actions"><button type="submit" disabled={busy||uncertain||!editor.roleFamily||!editor.title.trim()}>保存方向</button><button type="button" disabled={busy||uncertain} onClick={()=>setEditor(null)}>先不改了</button></div></form>}
  {confirmation&&<section className="career-target-confirmation" role="region" aria-label="确认方向变更"><p>{confirmation.status===null?`移除「${confirmation.target.title}」？保存的方向内容会删除。`:`把「${confirmation.target.title}」改为「${statuses[confirmation.status]}」？`}</p><div className="career-target-actions"><button type="button" disabled={busy||uncertain} onClick={applyConfirmation}>确认这个选择</button><button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation(null)}>再想想</button></div></section>}
  <ul className="career-target-list">{targets.map(t=><li key={t.id}><div className="career-target-meta"><span className={'career-target-status status-'+t.status}>{statuses[t.status]}</span><span>{roleLabels[t.roleFamily]}</span></div><h2>{t.title}</h2><p>{t.locations.length?t.locations.join(' · '):'地点暂未填写'}</p><div className="career-target-actions"><button type="button" disabled={busy||uncertain} onClick={()=>setEditor(draft(t))}>修改</button>{t.status!=='active'&&<button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation({target:t,status:'active'})}>作为暂定主攻</button>}{t.status!=='paused'&&<button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation({target:t,status:'paused'})}>先暂停</button>}{t.status!=='exploring'&&<button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation({target:t,status:'exploring'})}>继续探索</button>}{t.status!=='dropped'&&<button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation({target:t,status:'dropped'})}>先放下</button>}<button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation({target:t,status:null})}>移除</button></div></li>)}</ul>
 </section>;
}
export function CareerTargetPage({onLogout}:{onLogout:()=>void}){return <main className="career-target-page"><nav><a href="/">回到对话</a><a href="/me/memory">它记得的你</a><button type="button" onClick={onLogout}>退出登录</button></nav><CareerTargetPanel/></main>;}
