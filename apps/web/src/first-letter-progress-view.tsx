import {useEffect,useRef,useState} from 'react';
import type {FirstLetterProgress} from '@companion/platform-contracts';
import type {BoundPlatformClient} from './api';
import {JourneySectionController,type JourneySectionState} from './journey-section-controller';
import {readFirstLetterProgress} from './first-letter-progress-api';
export const firstLetterProgressText:Record<FirstLetterProgress['state'],string>={
 not_started:'已记下：用已有信息写第一封信。写信前的准备还没有开始。',
 prepared:'写信前的准备已保存，尚未安排后台写信。',
 queued:'写信请求已保存，等待后台处理。',
 service_unavailable:'写信服务暂时不可用，你已填写的内容仍然保留。',
 authorization_required:'这次写信的登录或同意状态已变化，任务已暂停。重新登录不会自动继续这次请求。',
 settings_changed:'写信使用的资料或设置已变化，任务已暂停。已保存的内容仍然保留。',
 writing:'正在写第一封信。',
 draft_saved:'信稿已保存，等待继续核对。',
 checking:'正在核对和调整信稿。',
 interrupted:'写信暂时停住了，已有进度已保留。',
 reviewed:'信稿已完成核对，等待送达。',
};
export function FirstLetterProgressPanel({client,companionId,welcomeId,paused=false}:{
 client:BoundPlatformClient;companionId:string;welcomeId:string;paused?:boolean;
}){
 const [unavailable,setUnavailable]=useState(()=>!navigator.onLine||document.visibilityState==='hidden');
 const [observed,setObserved]=useState<{client:BoundPlatformClient;companionId:string;welcomeId:string;state:JourneySectionState<Readonly<FirstLetterProgress>>}|null>(null);
 const controller=useRef<JourneySectionController<Readonly<FirstLetterProgress>>|null>(null);
 useEffect(()=>{
  const clear=()=>{controller.current?.stop();setObserved(null);setUnavailable(true);};
  const resume=()=>setUnavailable(!navigator.onLine||document.visibilityState==='hidden');
  const visible=()=>document.visibilityState==='hidden'?clear():resume();
  window.addEventListener('offline',clear);window.addEventListener('online',resume);document.addEventListener('visibilitychange',visible);
  return()=>{window.removeEventListener('offline',clear);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',visible);};
 },[]);
 useEffect(()=>{
  setObserved(null);
  if(paused||unavailable||!client.isCurrent())return;
  const c=new JourneySectionController(client,signal=>readFirstLetterProgress(client,companionId,welcomeId,signal),
   state=>setObserved({client,companionId,welcomeId,state}));
  controller.current=c;c.start();
  return()=>{c.stop();if(controller.current===c)controller.current=null;};
 },[client,companionId,welcomeId,paused,unavailable]);
 const state=!paused&&!unavailable&&client.isCurrent()&&observed?.client===client&&observed.companionId===companionId
  &&observed.welcomeId===welcomeId?observed.state:null;
 return <div className="companion-welcome-progress" aria-label="第一封信进度">
  {paused?<p role="status">处理完上方事项后，再查看第一封信进度。</p>:unavailable?<p role="status">恢复连接并回到页面后，再读取第一封信进度。</p>:
   !client.isCurrent()?<p role="status">账号状态已变化，请重新确认账号。</p>:<>
    {(!state||state.busy)&&<p role="status">正在读取第一封信进度…</p>}
    {state?.failed&&<p role="alert">暂时没读到第一封信进度，请重新读取。</p>}
    {state?.value&&<><p role="status">{firstLetterProgressText[state.value.state]}</p><p>第一封信尚未送达。</p></>}
   </>}
  <button className="onboarding-link" type="button" disabled={paused||unavailable||!client.isCurrent()||!state||state.busy}
   onClick={()=>void controller.current?.refresh()}>查看最新进度</button>
 </div>;
}
