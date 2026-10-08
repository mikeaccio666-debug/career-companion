import { useEffect,useState } from 'react';
import type { MentorRatingCommand } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { emptyMentorRatingSnapshot,type MentorRatingSnapshot } from './mentor-rating-controller';
import { MentorRatingProvider,useMentorRatingScope } from './mentor-rating-scope-view';
export function MentorRatingScene({state,onSubmit,onRefresh,onObserve,onRetry}:{state:MentorRatingSnapshot;onSubmit:(v:MentorRatingCommand)=>void;onRefresh:()=>void;onObserve:()=>void;onRetry:()=>void}){
 const [score,setScore]=useState<number|null>(null),[comment,setComment]=useState('');
 useEffect(()=>{if(state.suspended||state.rating){setScore(null);setComment('');}},[state.suspended,state.rating]);
 if(state.suspended)return null;
 if(!state.loaded&&!state.pending)return <section aria-label="会后反馈"><p>{state.error||'正在读取会后反馈…'}</p>{!state.busy&&<button onClick={onRefresh}>重新读取会后反馈</button>}</section>;
 return <section className="mentor-feedback" aria-label="会后反馈">
  {state.pending&&state.uncertain&&<><p role="status">{state.error || '反馈结果还没确认，请先核对这次提交。'}</p><button disabled={state.busy} onClick={onObserve}>核对这次反馈</button><button disabled={state.busy} onClick={onRetry}>用原操作重试</button></>}
  {state.rating?<p role="status">{state.rating.action==='skip'?'已跳过这次会后评分。':'你的反馈已记录，仅内部可见。'}</p>:state.loaded&&!state.pending&&<form onSubmit={e=>{e.preventDefault();if(score!==null&&!state.busy&&!state.pending)onSubmit({operationId:crypto.randomUUID(),action:'rate',score,comment:comment.trim()||null});}}>
   <h4>这次和蔓藤导师聊得怎么样？</h4><p>1–5 分，评分和一句话反馈仅内部可见。</p>
   <fieldset disabled={state.busy||!!state.pending}><legend>你的评分</legend>{[1,2,3,4,5].map(value=><label key={value}><input type="radio" name="mentor-score" value={value} checked={score===value} onChange={()=>setScore(value)}/>{value} 分</label>)}</fieldset>
   <label>一句话反馈（可选）<input value={comment} maxLength={500} disabled={state.busy||!!state.pending} onChange={e=>setComment(e.target.value)}/></label>
   <div className="mentor-actions"><button type="submit" disabled={state.busy||!!state.pending||score===null}>提交反馈</button><button type="button" disabled={state.busy||!!state.pending} onClick={()=>onSubmit({operationId:crypto.randomUUID(),action:'skip'})}>跳过</button></div>
  </form>}
 </section>;
}
export function MentorRatingPanel({sessionId}:{sessionId:string}){
 const scope=useMentorRatingScope();
 return scope ? <ScopedMentorRating sessionId={sessionId}/> : <MentorRatingProvider visibleSessions={[sessionId]}><ScopedMentorRating sessionId={sessionId}/></MentorRatingProvider>;
}
function ScopedMentorRating({sessionId}:{sessionId:string}){
 const client=useRequiredPlatformAccountClient(),scope=useMentorRatingScope()!;
 const [observed,setObserved]=useState<{scope:typeof scope;sessionId:string;state:MentorRatingSnapshot}|null>(null);
 useEffect(()=>{setObserved(null);return scope.attach(sessionId,state=>setObserved({scope,sessionId,state}));},[scope,sessionId]);
 if(!client.isCurrent())return null;
 const state=observed?.scope===scope&&observed.sessionId===sessionId?observed.state:emptyMentorRatingSnapshot();
 return <MentorRatingScene key={`${client.account.accountId}:${client.account.generation}:${sessionId}`} state={state} onSubmit={v=>scope.controller(sessionId)?.begin(v)} onRefresh={()=>void scope.controller(sessionId)?.refresh()}
  onObserve={()=>void scope.controller(sessionId)?.observe()} onRetry={()=>void scope.controller(sessionId)?.retry()}/>;
}
