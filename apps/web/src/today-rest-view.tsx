import {bindPrivatePageLifecycle} from './private-page-lifecycle';
import { useEffect, useMemo, useState } from 'react';
import type { TodayRestSettings, TodayRestChoice } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { TodayRestController, emptyTodayRest } from './today-rest-controller';
import './companion-daily-settings-view.css';
const choices:ReadonlyArray<readonly [TodayRestChoice,string]>=[['today','今天不想'],['1_day','歇 1 天'],['3_days','歇 3 天'],['7_days','歇 7 天']];
export function TodayRestChoices({settings,disabled,onChoose}:{settings:Readonly<TodayRestSettings>;disabled:boolean;onChoose:(v:TodayRestChoice)=>void}) {
 const until=[settings.optedOutUntil,settings.pauseUntil].filter((v):v is string=>!!v).sort().at(-1);
 const formatted=until&&settings.timeZone?new Intl.DateTimeFormat('zh-CN',{timeZone:settings.timeZone,year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(until)):null;
 return <><p>「今天不想」持续到已保存时区的当天结束；歇几天从保存时起，到相应日期的同一当地时间，期间其他主动消息停发。</p>
 {formatted?<p>上次保存的休息截止时间：<time dateTime={until}>{formatted}</time>（{settings.timeZone}）。到时恢复原来的安排。</p>:<p>还没有保存休息安排。</p>}
 <div className="companion-settings-actions">{choices.map(([choice,label])=><button type="button" key={choice} disabled={disabled} onClick={()=>onChoose(choice)}>{label}</button>)}</div>
 {until&&<><p>{settings.reminders==='keep'?'这段休息期间保留：面试提醒、截止提醒。':'这段休息期间，面试和截止提醒也关闭。'}</p><button type="button" disabled={disabled||settings.reminders==='off'} onClick={()=>onChoose('reminders_off')}>都关掉</button></>}
 </>;
}
export function TodayRestPanel({onSaved}:{onSaved?:()=>void}={}) {
 const client=useRequiredPlatformAccountClient();
 const [view,setView]=useState(()=>({client,state:emptyTodayRest()}));
 const controller=useMemo(()=>new TodayRestController(client,state=>setView({client,state})),[client]);
 const state=view.client===client&&client.isCurrent()?view.state:emptyTodayRest();
 useEffect(()=>{const binding=bindPrivatePageLifecycle(controller,window,document,()=>navigator.onLine);return()=>binding.dispose();},[controller]);
 useEffect(()=>{if(!state.pending||!client.isCurrent())return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[state.pending,client]);
 useEffect(()=>{if(state.notice&&state.settings)onSaved?.();},[state.notice,state.settings?.revision,onSaved]);
 const disabled=state.busy||state.suspended||!!state.pending;
 return <section className="daily-settings-panel" aria-labelledby="today-rest-title"><h2 id="today-rest-title">先歇一会儿</h2><p>晨报和提醒尚未开放。你可以先保存休息安排；功能开放后，会遵守仍在有效期内的选择。</p>
 {state.suspended&&<p role="status">回到页面并恢复连接后，再读取休息安排。</p>}{state.busy&&<p role="status">正在确认休息安排…</p>}{state.error&&<p role="alert">{state.error}</p>}{state.notice&&<p role="status">{state.notice}</p>}
 {state.loaded&&state.settings&&<TodayRestChoices settings={state.settings} disabled={disabled} onChoose={v=>controller.begin(v)}/>}
 <div className="companion-settings-actions"><button type="button" disabled={state.busy||state.suspended||!client.isCurrent()} onClick={()=>void controller.refresh()}>重新读取休息安排</button>{state.pending&&<><button type="button" disabled={state.busy||state.suspended} onClick={()=>void controller.observe()}>核对这次保存</button><button type="button" disabled={state.busy||state.suspended} onClick={()=>void controller.retry()}>用原操作重试</button></>}</div>
 </section>;
}
