import {useEffect,useMemo,useState,useCallback} from 'react';
import type {DailyPlanView} from '@companion/platform-contracts';
import {useRequiredPlatformAccountClient} from './account-client';
import {DailyPlanController,emptyDailyPlan,type DailyPlanIntent} from './daily-plans-controller';
import {BRAND} from './brand';
import {TodayAgendaPanel} from './today-agenda-view';
import {TodayRestPanel} from './today-rest-view';
import './career-design-tokens.css';import './companion-paid-settings-view.css';import './today-view.css';
const labels={proposed:'待你接受',accepted:'今天做',done:'本人标记完成',moved:'挪到明天了',dropped:'不做了'};
export function DailyPlanContent({view,disabled,onChoose}:{view:Readonly<DailyPlanView>;disabled:boolean;onChoose:(intent:DailyPlanIntent)=>void}){
 const [title,setTitle]=useState(''),[minutes,setMinutes]=useState('15');
 if(view.paused)return <p className="today-resting" role="status">好，今天不提了。休息期间，任务先收起来。</p>;
 const items=view.plan?.items??[],total=items.filter(i=>!['moved','dropped'].includes(i.state)).reduce((n,i)=>n+i.minutes,0);
 return <><p className="today-date"><time dateTime={view.localDate}>{view.localDate}</time> · {view.timeZone}</p><p>你安排了 {total} 分钟，每日预算 {view.dailyMinutes} 分钟。</p>
 {!items.length&&<p>今天没有安排。可以加一件自己的事；休息一天也行。</p>}
 <ol className="today-items">{items.map(i=><li key={i.id} className={'today-item today-item-'+i.state}><div><h3>{i.title}</h3><span className="today-state">{labels[i.state]} · {i.minutes} 分钟</span></div>{i.movedTo&&<p>已放到 {i.movedTo.localDate}，明天再接受。</p>}{i.state==='accepted'&&<div className="companion-settings-actions"><button type="button" disabled={disabled} onClick={()=>onChoose({action:'done',itemId:i.id})}>我做完了</button><button type="button" disabled={disabled} onClick={()=>onChoose({action:'move',itemId:i.id})}>挪到明天</button><button type="button" disabled={disabled} onClick={()=>onChoose({action:'drop',itemId:i.id})}>不做了</button></div>}</li>)}</ol>
 {items.some(i=>i.state==='proposed')&&<button type="button" disabled={disabled} onClick={()=>onChoose({action:'accept'})}>接受这些安排</button>}
 <form className="today-add" onSubmit={e=>{e.preventDefault();onChoose({action:'add',title:title.trim(),minutes:Number(minutes)});}}><h3>加一件我自己的</h3><label>要做什么<input required maxLength={160} value={title} disabled={disabled} onChange={e=>setTitle(e.target.value)}/></label><label>预计几分钟<input required type="number" min="1" max="1440" step="1" value={minutes} disabled={disabled} onChange={e=>setMinutes(e.target.value)}/></label><button type="submit" disabled={disabled}>加入安排</button></form>
 </>;
}
export function TodayPage({onLogout}:{onLogout:()=>void}){
 const client=useRequiredPlatformAccountClient(),[observed,setObserved]=useState(()=>({client,state:emptyDailyPlan()}));
 const controller=useMemo(()=>new DailyPlanController(client,state=>setObserved({client,state})),[client]);const state=observed.client===client&&client.isCurrent()?observed.state:emptyDailyPlan();
 const [agendaRevision,setAgendaRevision]=useState(0);
 const restSaved=useCallback(()=>{setAgendaRevision(n=>n+1);controller.suspend();if(navigator.onLine)controller.resume();},[controller]);
 useEffect(()=>{controller.start(!navigator.onLine);const off=()=>controller.suspend(),on=()=>controller.resume();window.addEventListener('offline',off);window.addEventListener('online',on);return()=>{window.removeEventListener('offline',off);window.removeEventListener('online',on);controller.stop();};},[controller]);
 useEffect(()=>{if(!state.pending||!client.isCurrent())return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[state.pending,client]);
 return <main className="companion-settings-page career-surface today-page"><nav aria-label="求职导航"><a href="/today" aria-current="page">今天</a><a href="/">对话</a><a href="/pending">待确认</a><a href="/journey">旅程</a><a href="/me">我</a><span>{BRAND.name} · AI</span><button type="button" onClick={onLogout}>退出登录</button></nav><section aria-labelledby="today-heading"><h1 id="today-heading">今天</h1>{state.view&&!state.view.paused&&<p>晨报和自动三件事尚未开放。先把你想做的事放在这里。</p>}
 {state.error&&<p role="alert">{state.error}</p>}{state.notice&&<p role="status">{state.notice}</p>}{state.busy&&<p role="status">正在确认今天的安排…</p>}{state.suspended&&<p role="status">当前离线，恢复连接后重新读取。</p>}
 {state.loaded&&state.view&&<DailyPlanContent key={state.view.localDate+':'+(state.view.plan?.revision??0)} view={state.view} disabled={state.busy||state.suspended||!!state.pending} onChoose={intent=>controller.begin(intent)}/>}
 <div className="companion-settings-actions"><button type="button" disabled={state.busy||state.suspended} onClick={()=>void controller.refresh()}>重新读取安排</button>{state.pending&&<><button type="button" disabled={state.busy||state.suspended} onClick={()=>void controller.observe()}>核对这次操作</button><button type="button" disabled={state.busy||state.suspended} onClick={()=>void controller.retry()}>用原操作重试</button></>}<a href="/me/companion">时区与每日预算</a></div>
 </section><TodayAgendaPanel key={agendaRevision} suspended={state.suspended} hidePending={state.view?.paused??false}/><TodayRestPanel onSaved={restSaved}/></main>;
}
