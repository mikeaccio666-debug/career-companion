import {useEffect,useMemo,useRef,useState} from 'react';
import {useRequiredPlatformAccountClient} from './account-client';
import {StaffContentController,type StaffContentState} from './staff-content-controller';
import {bindPrivatePageLifecycle} from './private-page-lifecycle';
import './career-design-tokens.css';
import './staff-feedback-view.css';
import './staff-content-view.css';
export function StaffContentWithdrawals({organizationId,onLogout,blocked=false}:{organizationId:string;onLogout:()=>void;blocked?:boolean}){
 const client=useRequiredPlatformAccountClient(),[observed,setObserved]=useState<{client:typeof client;organizationId:string;state:StaffContentState}|null>(null);
 const controller=useMemo(()=>new StaffContentController(client,organizationId,state=>setObserved({client,organizationId,state})),[client,organizationId]);
 const blockedRef=useRef(blocked);blockedRef.current=blocked;const lifecycle=useRef<ReturnType<typeof bindPrivatePageLifecycle>|null>(null);
 const state=observed?.client===client&&observed.organizationId===organizationId?observed.state:null;
 useEffect(()=>{const bound=bindPrivatePageLifecycle(controller,window,document,()=>navigator.onLine&&!blockedRef.current);lifecycle.current=bound;return()=>{lifecycle.current=null;bound.dispose();};},[controller]);
 useEffect(()=>{lifecycle.current?.refresh();},[blocked]);
 if(!client.isCurrent()||blocked)return null;
 return <main className="career-surface staff-feedback staff-content">
  <header className="staff-feedback-header"><div><p>运营 · 内容记录</p><h1>已下架内容</h1><p>查看已下架来源的名称、版本和时间。每次读取都会记录访问审计。</p></div><button type="button" onClick={onLogout}>退出账号</button></header>
  <div className="staff-feedback-toolbar"><button type="button" disabled={state?.busy||state?.suspended} onClick={()=>void controller.refresh()}>重新读取</button><a href="/staff/feedback">反馈收件箱</a></div>
  {state?.error?<p role="alert">{state.error}</p>:null}
  {state?.suspended?<p role="status">页面恢复后重新读取。</p>:state?.busy?<p role="status">正在读取下架记录…</p>:null}
  {state?.records?.length===0?<p className="staff-feedback-empty">这个组织还没有已下架内容。</p>:null}
  {state?.records?.length?<ul className="staff-content-list">{state.records.map(record=><li key={record.sourceId}>
   <h2>{record.title}</h2><p>下架版本 v{record.revision} · <time dateTime={record.withdrawnAt}>{new Date(record.withdrawnAt).toLocaleString()}</time></p>
   <p className="staff-content-id">来源编号：{record.sourceId}</p>
  </li>)}</ul>:null}
  {state?.nextCursor?<button type="button" disabled={state.busy||state.suspended} onClick={()=>void controller.more()}>查看更多</button>:null}
 </main>;
}
