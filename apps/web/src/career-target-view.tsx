import {StudentPageNavigation} from './app/StudentPageNavigation';
import { useEffect,useMemo,useState } from 'react';
import { CAREER_ROLE_FAMILIES,parseCareerTargetCommand,type CareerTarget,type CareerTargetAction,type CareerTargetRoleFamily,type CareerTargetStatus } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { CareerTargetController,emptyCareerTargets } from './career-target-controller';
import './career-target-view.css';
const roleLabels:Record<CareerTargetRoleFamily,string>={swe:'Software Engineering',mle:'Machine Learning Engineering',ds:'Data Science',da:'Data Analytics',de:'Data Engineering',hw:'硬件 / 本专业',other:'其他方向'};
const statuses:Record<CareerTargetStatus,string>={exploring:'还在比较',active:'暂定主攻',paused:'先暂停',dropped:'已放下'};
interface Editor {record:Readonly<CareerTarget>|null;roleFamily:CareerTargetRoleFamily|'';title:string;locations:string;priority:string;reviewOn:string;}
const draft=(r:Readonly<CareerTarget>|null):Editor=>({record:r,roleFamily:r?.roleFamily??'',title:r?.title??'',locations:r?.locations.join('，')??'',priority:String(r?.priority??1),reviewOn:r?.reviewOn??''});
export default function CareerTargetPanel(){
 const client=useRequiredPlatformAccountClient();
 const [view,setView]=useState(()=>({client,state:emptyCareerTargets()}));
 const [editing,setEditing]=useState<{client:typeof client;editor:Editor|null;confirmation:{target:Readonly<CareerTarget>;status:CareerTargetStatus|null}|null}>({client,editor:null,confirmation:null});
 const [localError,setLocalError]=useState<{client:typeof client;text:string}>({client,text:''});
 const controller=useMemo(()=>new CareerTargetController(client,state=>setView({client,state})),[client]);
 const state=view.client===client&&client.isCurrent()?view.state:emptyCareerTargets();
 const {targets,loaded}=state,busy=state.busy||state.suspended,uncertain=!!state.pending;
 const editor=editing.client===client&&client.isCurrent()?editing.editor:null,confirmation=editing.client===client&&client.isCurrent()?editing.confirmation:null;
 const error=(localError.client===client&&client.isCurrent()?localError.text:'')||state.error;
 const setEditor=(editor:Editor|null)=>{setEditing({client,editor,confirmation:null});setLocalError({client,text:''});};
 const setConfirmation=(confirmation:typeof editing.confirmation)=>{setEditing({client,editor:null,confirmation});setLocalError({client,text:''});};
 const setError=(text:string)=>setLocalError({client,text});
 useEffect(()=>{controller.start(!navigator.onLine);const offline=()=>controller.suspend(),online=()=>controller.resume();const unsubscribe=client.subscribe(()=>{if(!client.isCurrent()){setEditing({client,editor:null,confirmation:null});setLocalError({client,text:''});}});window.addEventListener('offline',offline);window.addEventListener('online',online);return()=>{unsubscribe();window.removeEventListener('offline',offline);window.removeEventListener('online',online);controller.stop();};},[controller,client]);
 useEffect(()=>{if(state.settledOperationId){setEditing({client,editor:null,confirmation:null});setLocalError({client,text:''});}},[state.settledOperationId,client]);
 useEffect(()=>{if(!state.pending||!client.isCurrent())return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[state.pending,client]);
 function begin(action:CareerTargetAction,id:string|null,body:Record<string,unknown>){if(busy||uncertain||!loaded||!client.isCurrent())return;controller.begin(action,id,parseCareerTargetCommand(action,{...body,operationId:crypto.randomUUID()}));}
 function save(){if(!editor||busy||uncertain||!editor.roleFamily)return;const r=editor.record;if(r&&targets.find(t=>t.id===r.id)?.revision!==r.revision){setError('你正在编辑旧版，先核对最新方向再保存。');return;}
  const locations=editor.locations.trim()?editor.locations.split(/[,，]/).map(x=>x.trim()).filter(Boolean):[];const body={roleFamily:editor.roleFamily,title:editor.title.trim(),locations,priority:Number(editor.priority),reviewOn:editor.reviewOn||null,expectedRevision:r?.revision??0};
  try{begin(r?'edit':'create',r?.id??null,body);}catch{setError('请选择岗位家族；方向名称最多 120 字，地点最多 10 个，排序为 1–100，复看日期需为有效日期。');}
 }
 function applyConfirmation(){if(!confirmation||busy||uncertain)return;const r=confirmation.target;if(targets.find(t=>t.id===r.id)?.revision!==r.revision){setError('方向已经变化，请重新读取再决定。');return;}begin(confirmation.status===null?'delete':'status',r.id,{expectedRevision:r.revision,...(confirmation.status===null?{}:{status:confirmation.status})});}
 return <section className="career-target-panel" aria-labelledby="career-target-title"><header><h1 id="career-target-title">你想尝试的方向</h1><p>先记录，再用一个小行动验证。方向是暂定的，可以随时调整。</p></header>
  <div className="career-target-actions"><button type="button" disabled={busy||uncertain||!loaded} onClick={()=>setEditor(draft(null))}>记录一个方向</button><button type="button" disabled={busy} onClick={()=>{setError('');void controller.refresh();}}>重新读取</button></div>
  {state.suspended&&<p role="status">当前离线。连接恢复后会重新读取方向。</p>}{state.busy&&<p role="status">正在读取或保存…</p>}{state.notice&&<p role="status">{state.notice}</p>}{error&&<p role="alert" className="career-target-notice">{error}</p>}{uncertain&&<div className="career-target-actions"><button type="button" disabled={busy} onClick={()=>void controller.observe()}>核对这次保存</button><button type="button" disabled={busy} onClick={()=>void controller.retry()}>用原操作重试</button></div>}
  {loaded&&!targets.length&&!editor&&<p className="career-target-empty">还没记录方向。可以先记下一个想体验的岗位家族。</p>}
  {editor&&<form className="career-target-editor" onSubmit={e=>{e.preventDefault();save();}}><h2>{editor.record?'修改这个方向':'记录一个想探索的方向'}</h2>
   <label>岗位家族<select value={editor.roleFamily} disabled={busy||uncertain} onChange={e=>setEditor({...editor,roleFamily:e.target.value as Editor['roleFamily']})}><option value="">请选择</option>{CAREER_ROLE_FAMILIES.map(k=><option key={k} value={k}>{roleLabels[k]}</option>)}</select></label>
   <label>方向名称<input value={editor.title} maxLength={240} required disabled={busy||uncertain} onChange={e=>setEditor({...editor,title:e.target.value})} placeholder="例如 Backend SWE"/></label>
   <label>想去的地点（可留空）<input value={editor.locations} disabled={busy||uncertain} onChange={e=>setEditor({...editor,locations:e.target.value})} placeholder="用逗号分开"/></label>
   <label>排序（数字越小越靠前）<input type="number" min={1} max={100} step={1} value={editor.priority} disabled={busy||uncertain} onChange={e=>setEditor({...editor,priority:e.target.value})}/></label>
   <label>复看日期（可留空）<input type="date" min="0001-01-01" max="9999-12-31" value={editor.reviewOn} disabled={busy||uncertain} onChange={e=>setEditor({...editor,reviewOn:e.target.value})} aria-describedby="target-review-help"/></label>
   <p id="target-review-help">选一天回来看看：这个方向还想继续吗？日期可以修改或清空；这里只记录，不发送提醒。</p>
   <div className="career-target-actions"><button type="submit" disabled={busy||uncertain||!loaded||!editor.roleFamily||!editor.title.trim()}>保存方向</button><button type="button" disabled={busy||uncertain} onClick={()=>setEditor(null)}>先不改了</button></div></form>}
  {confirmation&&<section className="career-target-confirmation" role="region" aria-label="确认方向变更"><p>{confirmation.status===null?`移除「${confirmation.target.title}」？保存的方向内容会删除。`:`把「${confirmation.target.title}」改为「${statuses[confirmation.status]}」？`}</p><div className="career-target-actions"><button type="button" disabled={busy||uncertain} onClick={applyConfirmation}>确认这个选择</button><button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation(null)}>再想想</button></div></section>}
  <ul className="career-target-list">{targets.map(t=><li key={t.id}><div className="career-target-meta"><span className={'career-target-status status-'+t.status}>{statuses[t.status]}</span><span>{roleLabels[t.roleFamily]}</span></div><h2>{t.title}</h2><p>{t.locations.length?t.locations.join(' · '):'地点暂未填写'}</p><p className="career-target-review">{t.reviewOn?<>复看日期：<time dateTime={t.reviewOn}>{t.reviewOn}</time></>:'复看日期尚未设置'}</p><div className="career-target-actions"><button type="button" disabled={busy||uncertain} onClick={()=>setEditor(draft(t))}>修改</button>{t.status!=='active'&&<button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation({target:t,status:'active'})}>作为暂定主攻</button>}{t.status!=='paused'&&<button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation({target:t,status:'paused'})}>先暂停</button>}{t.status!=='exploring'&&<button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation({target:t,status:'exploring'})}>继续探索</button>}{t.status!=='dropped'&&<button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation({target:t,status:'dropped'})}>先放下</button>}<button type="button" disabled={busy||uncertain} onClick={()=>setConfirmation({target:t,status:null})}>移除</button></div></li>)}</ul>
 </section>;
}
export function CareerTargetPage({onLogout}:{onLogout:()=>void}){return <main className="career-target-page"><StudentPageNavigation><a href="/">回到对话</a><a href="/me/memory">它记得的你</a><button type="button" onClick={onLogout}>退出登录</button></StudentPageNavigation><CareerTargetPanel/></main>;}
