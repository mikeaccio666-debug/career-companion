import {useEffect,useMemo,useRef,useState} from 'react';
import {FEEDBACK_STATUSES,FEEDBACK_TRIAGE,type FeedbackStatus,type FeedbackTriage} from '@companion/platform-contracts';
import {useRequiredPlatformAccountClient} from './account-client';
import {StaffFeedbackController,type StaffFeedbackState} from './staff-feedback-controller';
import {type StaffFeedbackCommand} from './staff-feedback-api';
import {bindPrivatePageLifecycle} from './private-page-lifecycle';
import {feedbackCategories,feedbackStatuses,feedbackTriage} from './product-feedback-presentation';
import {FeedbackDetail} from './product-feedback-view';
import './staff-feedback-view.css';
export function StaffFeedback({onLogout,blocked=false}:{onLogout:()=>void;blocked?:boolean}){
 const client=useRequiredPlatformAccountClient(),[observed,setObserved]=useState<{client:typeof client;state:StaffFeedbackState}|null>(null);
 const controller=useMemo(()=>new StaffFeedbackController(client,state=>setObserved({client,state})),[client]);
 const blockedRef=useRef(blocked);blockedRef.current=blocked;const draftRecord=useRef<string|null>(null);const lifecycle=useRef<ReturnType<typeof bindPrivatePageLifecycle>|null>(null);
 const [status,setStatus]=useState<StaffFeedbackCommand['status']>('in_review'),[triage,setTriage]=useState<FeedbackTriage>('quality'),[reply,setReply]=useState(''),[review,setReview]=useState<StaffFeedbackCommand|null>(null),[inputError,setInputError]=useState('');
 const state=observed?.client===client?observed.state:null,record=state?.selected,locked=!!state?.busy||!!state?.suspended||!!state?.pending;
 useEffect(()=>{const bound=bindPrivatePageLifecycle(controller,window,document,()=>navigator.onLine&&!blockedRef.current);lifecycle.current=bound;return()=>{lifecycle.current=null;bound.dispose();};},[controller]);
 useEffect(()=>{lifecycle.current?.refresh();},[blocked]);
 useEffect(()=>{setReview(null);setInputError('');},[record?.id,record?.revision]);
 useEffect(()=>{if(record&&draftRecord.current!==record.id){draftRecord.current=record.id;setReply('');setStatus('in_review');setTriage('quality');}},[record?.id]);
 useEffect(()=>{if(state?.settled){setReply('');setReview(null);}},[state?.settled]);
 useEffect(()=>{
  const guard=(e:BeforeUnloadEvent)=>{if(client.isCurrent()&&(reply.trim()||state?.pending)){e.preventDefault();e.returnValue='';}};
  window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);
 },[client,reply,state?.pending]);
 if(!client.isCurrent()||blocked)return null;
 const preview=()=>{
  if(locked||!record)return;
  if(reply.length>4000||status!=='in_review'&&!reply.trim()){setInputError('解决或关闭反馈时，请写明给学生的处理结果。');return;}
  setReview({operationId:crypto.randomUUID(),expectedRevision:record.revision,status,triage,reply});setInputError('');
 };
 return <main className="career-surface staff-feedback">
  <header className="staff-feedback-header"><div><small>CAREER COMPANION · 产品运营</small><h1>反馈收件箱</h1><p>查看学生主动分享的问题，把处理结果回给本人。</p></div><button type="button" onClick={onLogout}>退出登录</button></header>
  {state?.suspended?<p role="status">页面暂不可用。回到页面并连接网络后，会重新核对。</p>:<>
   <div className="staff-feedback-toolbar">{state?.organizationId&&!state.suspended?<a href={"/staff/orgs/"+state.organizationId+"/content-withdrawals"}>下架记录</a>:null}<label>处理状态<select aria-label="筛选处理状态" value={state?.status??'all'} disabled={locked} onChange={e=>void controller.filter(e.target.value==='all'?null:e.target.value as FeedbackStatus)}>
    <option value="all">全部状态</option>{FEEDBACK_STATUSES.map(k=><option key={k} value={k}>{feedbackStatuses[k]}</option>)}</select></label>
    <button type="button" disabled={locked} onClick={()=>void controller.refresh()}>重新读取</button></div>
   {state?.busy&&<p role="status">正在核对反馈…</p>}
   {(state?.error||inputError)&&<p role="alert">{inputError||state?.error}</p>}
   {state?.notice&&<p role="status">{state.notice}</p>}
   {state?.pending&&<section className="staff-feedback-pending"><h2>这次回复还在核对</h2><p>原内容已锁定。恢复连接只查询结果，不会自动再次提交。</p><div className="feedback-actions">
    <button type="button" disabled={!!state.busy} onClick={()=>void controller.observe()}>核对本次结果</button><button type="button" disabled={!!state.busy} onClick={()=>void controller.retry()}>用原内容重试</button></div></section>}
   <div className="staff-feedback-columns"><section aria-label="反馈列表">
    {state?.records?.length===0&&<div className="staff-feedback-empty"><h2>这一栏暂时没有反馈</h2><p>可以切换状态，查看已经处理的问题。</p></div>}
    {!!state?.records?.length&&<ul className="feedback-list">{state.records.map(r=><li key={r.id}><button type="button" disabled={locked} aria-pressed={record?.id===r.id} onClick={()=>void controller.select(r.id)}>
     <span><strong>{feedbackCategories[r.category]}</strong><small>{new Date(r.createdAt).toLocaleString('zh-CN')}</small></span><span>{feedbackStatuses[r.status]}</span><p>{r.description}</p></button></li>)}</ul>}
    {state?.nextCursor&&<button type="button" disabled={locked} onClick={()=>void controller.more()}>查看更多反馈</button>}
   </section><section aria-label="反馈处理" className="staff-feedback-editor">
    {record?<><FeedbackDetail record={record}/><p className="feedback-caption">这里只展示学生主动提交的内容。你的分类、状态和回复都会对反馈人可见。</p>
     {review?<section className="feedback-review" aria-label="学生将看到的处理结果"><h2>学生将看到的处理结果</h2><p>{feedbackStatuses[review.status]} · {feedbackTriage[review.triage]}</p><p className="feedback-verbatim">{review.reply||'运营已开始查看这条反馈。'}</p><div className="feedback-actions">
      <button type="button" className="feedback-primary" disabled={locked} onClick={()=>{try{controller.begin(review);}catch{setInputError('请检查回复内容后重试。');}}}>确认保存并告知学生</button>
      <button type="button" disabled={locked} onClick={()=>setReview(null)}>返回修改</button></div></section>:<form className="feedback-form" onSubmit={e=>{e.preventDefault();preview();}}>
      <h2>处理这条反馈</h2><label>分拣类别<select value={triage} disabled={locked} onChange={e=>setTriage(e.target.value as FeedbackTriage)}>{FEEDBACK_TRIAGE.map(k=><option key={k} value={k}>{feedbackTriage[k]}</option>)}</select></label>
      <label>更新状态<select value={status} disabled={locked} onChange={e=>setStatus(e.target.value as StaffFeedbackCommand['status'])}>{(['in_review','resolved','closed'] as const).map(k=><option key={k} value={k}>{feedbackStatuses[k]}</option>)}</select></label>
      <label>回复学生<textarea rows={6} maxLength={4000} value={reply} disabled={locked} onChange={e=>setReply(e.target.value)} placeholder="说明核对结果、已做的调整，或还需要的信息。"/></label>
      <p className="feedback-caption">草稿仅保留在本页；离开、刷新或切换反馈前，请先保存。</p><button className="feedback-primary" type="submit" disabled={locked}>预览处理结果</button>
     </form>}
    </>:!state?.pending&&<div className="staff-feedback-empty"><h2>选择一条反馈</h2><p>先阅读问题和已有进展，再确认要回给学生的结果。</p></div>}
   </section></div>
  </>}
 </main>;
}
