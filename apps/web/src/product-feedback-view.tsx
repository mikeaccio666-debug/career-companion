import {useEffect,useMemo,useRef,useState} from 'react';
import {FEEDBACK_CATEGORIES,type FeedbackCategory,type ProductFeedback} from '@companion/platform-contracts';
import {useRequiredPlatformAccountClient} from './account-client';
import {ProductFeedbackController,type FeedbackState} from './product-feedback-controller';
import {bindPrivatePageLifecycle} from './private-page-lifecycle';
import {feedbackCategories,feedbackStatuses,feedbackTriage,feedbackSurface} from './product-feedback-presentation';
import './career-design-tokens.css';
import './product-feedback-view.css';

type Review={category:FeedbackCategory;description:string;sharedExcerpt:string|null;recipientId:string;recipientName:string;surface:ReturnType<typeof feedbackSurface>};
const at=(value:string)=>new Date(value).toLocaleString('zh-CN',{dateStyle:'medium',timeStyle:'short'});
function FeedbackDetail({record}:{record:Readonly<ProductFeedback>}){
 return <article className="feedback-detail" aria-label="反馈详情">
  <div className="feedback-detail-heading"><h3>{feedbackCategories[record.category]}</h3><span className="feedback-status">{feedbackStatuses[record.status]}</span></div>
  <small>{at(record.createdAt)}</small><p className="feedback-verbatim">{record.description}</p>
  {record.sharedExcerpt!==null&&<details><summary>你主动附上的片段</summary><p className="feedback-verbatim">{record.sharedExcerpt}</p></details>}
  <h4>处理进展</h4>
  {record.updates.length===0?<p>已进入反馈收件箱，暂时还没有处理回复。</p>:<ol className="feedback-updates">{record.updates.map(u=><li key={u.revision}>
   <div><strong>{feedbackStatuses[u.status]}</strong><small>{at(u.at)}</small></div><small>{feedbackTriage[u.triage]}</small>
   <p className="feedback-verbatim">{u.reply||'运营已开始查看这条反馈。'}</p>
  </li>)}</ol>}
 </article>;
}
/** Authenticated support entry, independent of the first-letter/chat gate.
 * Closed/offline/hidden views suspend reads. Drafts and uncertain operations
 * stay only in this account's in-memory component until it is discarded. */
export function StudentFeedback({blocked=false}:{blocked?:boolean}){
 const client=useRequiredPlatformAccountClient(),[open,setOpen]=useState(false),openRef=useRef(false),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const [observed,setObserved]=useState<{client:typeof client;state:FeedbackState}|null>(null);
 const [tab,setTab]=useState<'new'|'history'>('new'),[category,setCategory]=useState<FeedbackCategory>('other'),[description,setDescription]=useState(''),[attach,setAttach]=useState(false),[excerpt,setExcerpt]=useState('');
 const [review,setReview]=useState<Review|null>(null),[confirmed,setConfirmed]=useState(false),[inputError,setInputError]=useState('');
 const controller=useMemo(()=>new ProductFeedbackController(client,state=>setObserved({client,state})),[client]);
 const lifecycle=useRef<ReturnType<typeof bindPrivatePageLifecycle>|null>(null);
 openRef.current=open&&!blocked;
 useEffect(()=>{
  setDescription('');setExcerpt('');setAttach(false);setReview(null);setConfirmed(false);setOpen(false);setInputError('');
  const bound=bindPrivatePageLifecycle(controller,window,document,()=>navigator.onLine&&openRef.current);
  lifecycle.current=bound;return()=>{lifecycle.current=null;bound.dispose();};
 },[controller]);
 useEffect(()=>{lifecycle.current?.refresh();},[open,blocked]);
 useEffect(()=>{if(blocked)setOpen(false);},[blocked]);
 const state=observed?.client===client?observed.state:null,current=client.isCurrent(),visible=open&&!blocked&&current;
 const recipient=state?.availability?.recipient??null,processing=!!state?.busy||!!state?.suspended,locked=processing||!!state?.pending;
 useEffect(()=>{setReview(null);setConfirmed(false);},[recipient?.id,recipient?.name]);
 useEffect(()=>{
  if(!state?.settled)return;setDescription('');setExcerpt('');setAttach(false);setReview(null);setConfirmed(false);setTab('history');
 },[state?.settled]);
 useEffect(()=>{
  const guard=(e:BeforeUnloadEvent)=>{if(client.isCurrent()&&(description.trim()||excerpt.trim()||state?.pending)){e.preventDefault();e.returnValue='';}};
  window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);
 },[client,description,excerpt,state?.pending]);
 useEffect(()=>{
  const element=dialog.current;if(!element)return;
  if(visible&&!element.open){element.showModal();element.querySelector<HTMLButtonElement>('button')?.focus();}
  else if(!visible&&element.open){element.close();if(current&&!blocked)trigger.current?.focus();}
 },[visible,current,blocked]);
 if(!current)return null;
 const close=()=>{setOpen(false);};
 function preview(){
  if(locked||!recipient||!state?.availability?.available)return;
  if(!description.trim()||description.length>4000||attach&&(!excerpt.trim()||excerpt.length>12000)){setInputError('请填写问题描述；选择附上片段时，也请填写要分享的内容。');return;}
  setReview({category,description,sharedExcerpt:attach?excerpt:null,recipientId:recipient.id,recipientName:recipient.name,surface:feedbackSurface(window.location.pathname)});
  setConfirmed(false);setInputError('');
 }
 function send(){
  if(locked||!confirmed||!review||review.recipientId!==recipient?.id||review.recipientName!==recipient?.name)return;
  try{controller.begin({operationId:crypto.randomUUID(),recipientId:review.recipientId,category:review.category,surface:review.surface,description:review.description,sharedExcerpt:review.sharedExcerpt,shareWithSupport:true});setInputError('');}
  catch{setInputError('请重新核对要分享的内容。');}
 }
 return <div className="career-surface feedback-root">
  {!blocked&&<button ref={trigger} type="button" className="feedback-launcher" onClick={()=>setOpen(true)} aria-haspopup="dialog">反馈</button>}
  <dialog ref={dialog} className="feedback-dialog" aria-labelledby="feedback-title" onCancel={e=>{e.preventDefault();close();}} onClose={()=>setOpen(false)}>
   <header className="feedback-header"><div><span className="feedback-eyebrow">一起把这里变好</span><h2 id="feedback-title">反馈与进展</h2></div><button type="button" onClick={close} aria-label="关闭反馈">关闭</button></header>
   {visible&&<>
    {state?.suspended?<p role="status" className="feedback-message">页面暂不可用。回到页面并连接网络后，会重新核对。</p>:<>
    <nav className="feedback-tabs" aria-label="反馈内容"><button type="button" aria-pressed={tab==='new'} onClick={()=>setTab('new')}>写反馈</button><button type="button" aria-pressed={tab==='history'} onClick={()=>{setTab('history');if(!state?.records&&!state?.pending)void controller.refresh();}}>我的反馈</button></nav>
    {state?.busy&&<p role="status" className="feedback-message">{state.pending?'正在确认这次提交…':'正在读取反馈…'}</p>}
    {(state?.error||inputError)&&<p role="alert" className="feedback-message">{inputError||state?.error}</p>}
    {state?.notice&&<p role="status" className="feedback-message">{state.notice}</p>}
    {state?.pending&&<section className="feedback-pending" aria-label="待核对的提交"><h3>这次提交还在核对</h3><p>内容已锁定，重试会沿用同一次提交。</p><div className="feedback-actions">
     <button type="button" aria-disabled={processing} onClick={()=>{if(!processing)void controller.observe();}}>核对提交结果</button>
     <button type="button" aria-disabled={processing} onClick={()=>{if(!processing)void controller.retry();}}>用原内容重试</button>
    </div></section>}
    {tab==='new'&&!state?.pending&&<section>
     {state?.availability?.available===false&&<p className="feedback-message" role="status">反馈接收暂不可用。草稿会留在本页，可以稍后重新读取。</p>}
     {review?<section className="feedback-review" aria-label="确认分享内容"><h3>这次会分享什么</h3><p>接收方：<strong>{review.recipientName}的产品运营</strong></p>
      <p><strong>{feedbackCategories[review.category]}</strong></p><p className="feedback-verbatim">{review.description}</p>
      {review.sharedExcerpt!==null?<><h4>你选择附上的片段</h4><p className="feedback-verbatim">{review.sharedExcerpt}</p></>:<p>不附上对话片段。</p>}
      <p>只分享这里列出的文字和当前页面类别，不会自动附上其他对话或资料。</p>
      <label className="feedback-check"><input type="checkbox" checked={confirmed} disabled={locked} onChange={e=>setConfirmed(e.target.checked)}/>我同意将以上内容分享给显示的接收方，用于处理反馈。</label>
      <div className="feedback-actions"><button type="button" className="feedback-primary" aria-disabled={locked||!confirmed||review.recipientId!==recipient?.id} onClick={send}>确认并提交</button>
       <button type="button" aria-disabled={locked} onClick={()=>{if(!locked){setReview(null);setConfirmed(false);}}}>返回修改</button></div>
     </section>:<form onSubmit={e=>{e.preventDefault();preview();}} className="feedback-form">
      <p>哪里不对，或哪里可以更好？你的反馈会交给产品运营处理。</p>
      <label>问题类型<select value={category} disabled={locked} onChange={e=>setCategory(e.target.value as FeedbackCategory)}>{FEEDBACK_CATEGORIES.map(k=><option key={k} value={k}>{feedbackCategories[k]}</option>)}</select></label>
      <label>问题描述<textarea value={description} rows={4} maxLength={4000} disabled={locked} onChange={e=>setDescription(e.target.value)} placeholder="发生了什么？你期待它怎样做？"/></label>
      <label className="feedback-check"><input type="checkbox" checked={attach} disabled={locked} onChange={e=>{setAttach(e.target.checked);if(!e.target.checked)setExcerpt('');}}/>我想主动附上一段对话</label>
      {attach&&<label>只粘贴你愿意分享的片段<textarea value={excerpt} rows={5} maxLength={12000} disabled={locked} onChange={e=>setExcerpt(e.target.value)}/><small>可以先删去不想分享的内容。我们不会自动读取聊天记录。</small></label>}
      <p className="feedback-caption">草稿只保留在本页；刷新或退出账号后会清除。</p>
      <button type="submit" className="feedback-primary" aria-disabled={locked||!recipient||!description.trim()||attach&&!excerpt.trim()}>核对要分享的内容</button>
     </form>}
    </section>}
    {tab==='history'&&<section className="feedback-history">
     <div className="feedback-actions"><h3>我的反馈</h3><button type="button" aria-disabled={locked} onClick={()=>{if(!locked)void controller.refresh();}}>重新读取</button></div>
     {state?.selected&&<FeedbackDetail record={state.selected}/>}
     {state?.records?.length===0&&<p>你还没有提交过反馈。</p>}
     {state?.records&&state.records.length>0&&<ul className="feedback-list">{state.records.map(r=><li key={r.id}><button type="button" aria-disabled={locked} onClick={()=>{if(!locked)void controller.select(r.id);}}>
      <span><strong>{feedbackCategories[r.category]}</strong><small>{at(r.createdAt)}</small></span><span>{feedbackStatuses[r.status]}</span><p>{r.description}</p>
     </button></li>)}</ul>}
     {state?.nextCursor&&<button type="button" aria-disabled={locked} onClick={()=>{if(!locked)void controller.more();}}>查看更多反馈</button>}
    </section>}
    {tab==='new'&&!review&&!state?.pending&&<button type="button" className="feedback-refresh" aria-disabled={locked} onClick={()=>{if(!locked)void controller.refresh();}}>重新读取接收状态</button>}
    </>}
   </>}
  </dialog>
 </div>;
}
