import {dailyEditBasis,dailyEditMatches,editableDailyItem,type DailyItemEditor} from './daily-plan-editor';
import {StudentPageNavigation} from './app/StudentPageNavigation';
import {bindPrivatePageLifecycle} from './private-page-lifecycle';
import {useEffect,useMemo,useState,useCallback,useRef} from 'react';
import type {DailyPlanView} from '@companion/platform-contracts';
import {useRequiredPlatformAccountClient} from './account-client';
import {DailyPlanController,emptyDailyPlan,type DailyPlanIntent} from './daily-plans-controller';
import {BRAND} from './brand';
import {TodayWeeklyPanel} from './today-weekly-view';
import {TodayAgendaPanel} from './today-agenda-view';
import {TodayRestPanel} from './today-rest-view';
import './career-design-tokens.css';import './companion-paid-settings-view.css';import './today-view.css';
const labels={proposed:'待你接受',accepted:'今天做',done:'本人标记完成',moved:'挪到明天了',dropped:'不做了'};
type PlanEditor={title:string;minutes:string};
const emptyEditor:PlanEditor={title:'',minutes:'15'};
function DailyItemEditForm({view,value,disabled,onEdit,onChoose}:{view:Readonly<DailyPlanView>;value:DailyItemEditor;disabled:boolean;onEdit:(v:DailyItemEditor|null)=>void;onChoose:(i:DailyPlanIntent)=>void}){
 const saved=editableDailyItem(view,value.itemId),samePlan=value.basis.localDate===view.localDate&&value.basis.planId===view.plan?.id;
 const current=samePlan&&dailyEditMatches(view,value.itemId,value.basis);
 return <form className="today-add today-edit" aria-label="修改事项" onSubmit={e=>{e.preventDefault();if(current&&!disabled)onChoose({action:'edit',itemId:value.itemId,title:value.title.trim(),minutes:Number(value.minutes),basis:value.basis});}}>
  <h3>修改这件事</h3><p>保存后会重新变成「待你接受」，再确认一次今天的安排。</p>
  {!current&&<div role="status"><p>{samePlan&&saved?'安排已有更新。先对照当前内容，再决定是否保存这份修改。':'这条事项已结束，或已不属于今天。草稿仍在这里，不会自动改到另一件事上。'}</p>
   {samePlan&&saved&&<><p>当前保存：{saved.title} · {saved.minutes} 分钟</p><button type="button" disabled={disabled} onClick={()=>{const basis=dailyEditBasis(view,value.itemId);if(basis)onEdit({...value,basis});}}>已核对当前安排，保留这份修改</button></>}
  </div>}
  <label>修改后的事项<input required maxLength={160} value={value.title} disabled={disabled} onChange={e=>onEdit({...value,title:e.target.value})}/></label>
  <label>修改后预计几分钟<input required type="number" min="1" max="1440" step="1" value={value.minutes} disabled={disabled} onChange={e=>onEdit({...value,minutes:e.target.value})}/></label>
  <div className="companion-settings-actions"><button type="submit" disabled={disabled||!current}>保存修改</button><button type="button" disabled={disabled} onClick={()=>onEdit(null)}>放弃这份修改</button></div>
 </form>;
}
export function DailyPlanContent({view,disabled,onChoose,editor,onEdit,itemEditor=null,onItemEdit}:{view:Readonly<DailyPlanView>;disabled:boolean;onChoose:(intent:DailyPlanIntent)=>void;editor:PlanEditor;onEdit:(value:PlanEditor)=>void;itemEditor?:DailyItemEditor|null;onItemEdit?:(value:DailyItemEditor|null)=>void}){
 const {title,minutes}=editor;
 if(view.paused)return <p className="today-resting" role="status">好，今天不提了。休息期间，任务先收起来。</p>;
 const items=view.plan?.items??[],total=items.filter(i=>!['moved','dropped'].includes(i.state)).reduce((n,i)=>n+i.minutes,0);
 return <><p className="today-date"><time dateTime={view.localDate}>{view.localDate}</time> · {view.timeZone}</p><p>你安排了 {total} 分钟，每日预算 {view.dailyMinutes} 分钟。</p>
 {!items.length&&<p>今天没有安排。可以加一件自己的事；休息一天也行。</p>}
 <ol className="today-items">{items.map(i=><li key={i.id} className={'today-item today-item-'+i.state}><div><h3>{i.title}</h3><span className="today-state">{labels[i.state]} · {i.minutes} 分钟</span></div>{i.movedTo&&<p>已放到 {i.movedTo.localDate}，明天再接受。</p>}{i.state==='accepted'&&<div className="companion-settings-actions"><button type="button" disabled={disabled||!!itemEditor} onClick={()=>onChoose({action:'done',itemId:i.id})}>我做完了</button><button type="button" disabled={disabled||!!itemEditor} onClick={()=>onChoose({action:'move',itemId:i.id})}>挪到明天</button><button type="button" disabled={disabled||!!itemEditor} onClick={()=>onChoose({action:'drop',itemId:i.id})}>不做了</button></div>}{onItemEdit&&(i.state==='proposed'||i.state==='accepted')&&<button type="button" disabled={disabled||!!itemEditor} aria-label={'修改事项：'+i.title} onClick={()=>{const basis=dailyEditBasis(view,i.id);if(basis)onItemEdit({itemId:i.id,title:i.title,minutes:String(i.minutes),basis});}}>修改事项</button>}</li>)}</ol>
 {items.some(i=>i.state==='proposed')&&<button type="button" disabled={disabled||!!itemEditor} onClick={()=>onChoose({action:'accept'})}>接受这些安排</button>}
 {itemEditor&&onItemEdit&&<DailyItemEditForm view={view} value={itemEditor} disabled={disabled} onEdit={onItemEdit} onChoose={onChoose}/>}
 {!itemEditor&&<form className="today-add" onSubmit={e=>{e.preventDefault();onChoose({action:'add',title:title.trim(),minutes:Number(minutes)});}}><h3>加一件我自己的</h3><label>要做什么<input required maxLength={160} value={title} disabled={disabled} onChange={e=>onEdit({...editor,title:e.target.value})}/></label><label>预计几分钟<input required type="number" min="1" max="1440" step="1" value={minutes} disabled={disabled} onChange={e=>onEdit({...editor,minutes:e.target.value})}/></label><button type="submit" disabled={disabled}>加入安排</button></form>}
 </>;
}
export function TodayPage({onLogout}:{onLogout:()=>void}){
 const client=useRequiredPlatformAccountClient(),[observed,setObserved]=useState(()=>({client,state:emptyDailyPlan()}));
 const controller=useMemo(()=>new DailyPlanController(client,state=>setObserved({client,state})),[client]);const state=observed.client===client&&client.isCurrent()?observed.state:emptyDailyPlan();
 const [agendaRevision,setAgendaRevision]=useState(0);
 const [draft,setDraft]=useState<{client:typeof client;value:PlanEditor}|null>(null);
 const editor=draft?.client===client&&client.isCurrent()?draft.value:emptyEditor;
 const [itemDraft,setItemDraft]=useState<{client:typeof client;value:DailyItemEditor}|null>(null);
 const itemEditor=itemDraft?.client===client&&client.isCurrent()?itemDraft.value:null;
 const submittedItemDraft=useRef<{client:typeof client;value:DailyItemEditor}|null>(null);
 const submittedDraft=useRef<{client:typeof client;value:PlanEditor}|null>(null);
 useEffect(()=>{setDraft(null);setItemDraft(null);submittedItemDraft.current=null;submittedDraft.current=null;return client.subscribe(()=>{if(!client.isCurrent()){submittedDraft.current=null;submittedItemDraft.current=null;setDraft(null);setItemDraft(null);}});},[client]);
 useEffect(()=>{if(state.pending)return;const submitted=submittedDraft.current;submittedDraft.current=null;if(state.notice&&submitted)setDraft(current=>current?.client===submitted.client&&current.value===submitted.value?null:current);},[state.notice,state.pending]);
 useEffect(()=>{if(state.pending)return;const submitted=submittedItemDraft.current;submittedItemDraft.current=null;if(state.notice&&submitted)setItemDraft(current=>current?.client===submitted.client&&current.value===submitted.value?null:current);},[state.notice,state.pending]);
 const lifecycle=useRef<ReturnType<typeof bindPrivatePageLifecycle>|null>(null);
 const restSaved=useCallback(()=>{setAgendaRevision(n=>n+1);lifecycle.current?.refresh();},[controller]);
 useEffect(()=>{const binding=bindPrivatePageLifecycle(controller,window,document,()=>navigator.onLine);lifecycle.current=binding;return()=>{binding.dispose();if(lifecycle.current===binding)lifecycle.current=null;};},[controller]);
 useEffect(()=>{if((!state.pending&&!editor.title.trim()&&!itemEditor)||!client.isCurrent())return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[state.pending,client,editor.title,itemEditor]);
 return <main className="companion-settings-page career-surface today-page"><StudentPageNavigation aria-label="求职导航"><a href="/today" aria-current="page">今天</a><a href="/">对话</a><a href="/pending">待确认</a><a href="/journey">旅程</a><a href="/me">我</a><span>{BRAND.name} · AI</span><button type="button" onClick={onLogout}>退出登录</button></StudentPageNavigation><section aria-labelledby="today-heading"><h1 id="today-heading">今天</h1>{state.view&&!state.view.paused&&<p>晨报和自动三件事尚未开放。先把你想做的事放在这里。</p>}
 {state.error&&<p role="alert">{state.error}</p>}{state.notice&&<p role="status">{state.notice}</p>}{state.busy&&<p role="status">正在确认今天的安排…</p>}{state.suspended&&<p role="status">回到页面并恢复连接后，再读取今天的安排。</p>}
 {state.loaded&&state.view&&<DailyPlanContent key={state.view.localDate+':'+(state.view.plan?.revision??0)} view={state.view} itemEditor={itemEditor} onItemEdit={value=>{if(client.isCurrent())setItemDraft(value?{client,value}:null);}} editor={editor} onEdit={value=>{if(client.isCurrent())setDraft({client,value});}} disabled={state.busy||state.suspended||!!state.pending} onChoose={intent=>{controller.begin(intent);if(intent.action==='add'&&controller.snapshot().pending?.action==='add')submittedDraft.current={client,value:editor};if(intent.action==='edit'&&itemEditor&&controller.snapshot().pending?.action==='edit')submittedItemDraft.current={client,value:itemEditor};}}/>}
 <div className="companion-settings-actions"><button type="button" disabled={state.busy||state.suspended} onClick={()=>void controller.refresh()}>重新读取安排</button>{state.pending&&<><button type="button" disabled={state.busy||state.suspended} onClick={()=>void controller.observe()}>核对这次操作</button><button type="button" disabled={state.busy||state.suspended} onClick={()=>void controller.retry()}>用原操作重试</button></>}<a href="/me/companion">时区与每日预算</a></div>
 </section><TodayAgendaPanel key={agendaRevision} suspended={state.suspended} hidePending={state.view?.paused??false}/><TodayWeeklyPanel suspended={state.suspended}/><TodayRestPanel onSaved={restSaved}/></main>;
}
