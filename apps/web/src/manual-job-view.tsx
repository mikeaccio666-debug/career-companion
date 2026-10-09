import { emptyJobDeadline, jobDeadlineFields, resolveJobDeadline } from './manual-job-deadline';
import { JobDeadlineInput } from './manual-job-deadline-view';
import { displayZonedTime } from './zoned-date-time';
import { useEffect,useMemo,useState } from 'react';
import { CAREER_ROLE_FAMILIES,type ManualJobSummary,type CareerTargetRoleFamily,type ManualJobAction } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { ManualJobController,emptyManualJobs,type ManualJobSnapshot } from './manual-job-controller';
import './career-target-view.css';
import './manual-job-view.css';
const labels:Record<CareerTargetRoleFamily,string>={swe:'Software Engineering',mle:'Machine Learning Engineering',ds:'Data Science',da:'Data Analytics',de:'Data Engineering',hw:'硬件 / 本专业',other:'其他方向'};
const blank={employer:'',title:'',canonicalUrl:'',roleFamily:'' as CareerTargetRoleFamily|'',location:'',deadline:emptyJobDeadline(),privateNote:'',jobText:''};
export function ManualJobPage({onLogout}:{onLogout:()=>void}){
 const client=useRequiredPlatformAccountClient();
 const [observed,setObserved]=useState<{controller:ManualJobController;state:ManualJobSnapshot}|null>(null);
 const controller=useMemo(()=>{const next=new ManualJobController(client,state=>setObserved({controller:next,state}));return next;},[client]);
 const [form,setForm]=useState<typeof blank|null>(null),[remove,setRemove]=useState<Readonly<ManualJobSummary>|null>(null),[inputError,setInputError]=useState('');
 const state=observed?.controller===controller?observed.state:emptyManualJobs();
 const {jobs,next,detail,loaded,busy,suspended,uncertain,duplicate,matches}=state;
 const locked=busy||uncertain||!loaded||suspended,error=state.error||inputError;
 useEffect(()=>{
  setForm(null);setRemove(null);setInputError('');controller.start(!navigator.onLine);
  const offline=()=>{controller.suspend();setRemove(null);setInputError('');},online=()=>controller.resume();
  window.addEventListener('offline',offline);window.addEventListener('online',online);
  const unsubscribe=client.subscribe(()=>{if(!client.isCurrent()){setForm(null);setRemove(null);setInputError('');}});
  return()=>{window.removeEventListener('offline',offline);window.removeEventListener('online',online);unsubscribe();controller.stop();};
 },[controller,client]);
 useEffect(()=>{if(state.settledOperationId){setForm(null);setRemove(null);setInputError('');}},[state.settledOperationId]);
 useEffect(()=>{if(!state.pending)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[state.pending]);
 function start(action:ManualJobAction,id:string|null,body:Record<string,unknown>){
  try{setInputError('');controller.begin(action,id,{...body,operationId:crypto.randomUUID()});}
  catch{setInputError('请核对要保存的岗位和当前版本。');}
 }
 function save(allowDuplicate=false){if(!form||!form.roleFamily)return;try{
  const {deadline,...values}=form;start('create',null,{...values,expectedRevision:0,...jobDeadlineFields(deadline),allowDuplicate});
 }catch{setInputError('请核对日期、时区及重复时刻的选择。');}}
 if(!client.isCurrent())return null;
 return <main className="career-target-page manual-job-page"><nav><a href="/">回到对话</a><a href="/journey/targets">目标方向</a><a href="/journey/applications">投递旅程</a><button type="button" onClick={onLogout}>退出登录</button></nav><section className="career-target-panel"><header><h1>你收藏的岗位</h1><p>把想投的 JD 留下来，再逐条核对资料和准备材料。</p></header>
  <div className="career-target-actions"><button type="button" disabled={locked} onClick={()=>{setForm({...blank});controller.dismissDuplicate();setInputError('');}}>收藏一个岗位</button><button type="button" disabled={busy||suspended} onClick={()=>void controller.refresh()}>重新读取</button></div>
  {busy&&<p role="status">正在读取或保存…</p>}{!suspended&&error&&<p role="alert" className="career-target-notice">{error}</p>}{suspended&&<p role="status">没网了，私人内容已隐藏。联网后会重新读取，不会自动重发保存。</p>}
  {!suspended&&state.notice&&<p role="status">{state.notice}</p>}
  {!suspended&&uncertain&&<div className="career-target-actions"><button type="button" disabled={busy} onClick={()=>void controller.observe()}>核对这次保存</button><button type="button" disabled={busy} onClick={()=>void controller.retry()}>用原操作重试</button><p>核对完成前，先别关闭这个页面。</p></div>}
  {loaded&&!jobs.length&&!form&&<p className="career-target-empty">还没有收藏的岗位。贴一段 JD 就能开始。</p>}
  {loaded&&form&&<form className="career-target-editor" onSubmit={e=>{e.preventDefault();save();}}><h2>核对后收藏</h2><p>这些信息由你填写；链接只保存，不会自动打开或抓取。</p>{(['employer','title','canonicalUrl','location'] as const).map((key,i)=><label key={key}>{['公司','岗位名称','岗位链接（可留空）','地点（可留空）'][i]}<input value={form[key]} required={i<2} disabled={locked||duplicate} onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}
   <label>岗位家族<select required value={form.roleFamily} disabled={locked||duplicate} onChange={e=>setForm({...form,roleFamily:e.target.value as typeof form.roleFamily})}><option value="">请选择</option>{CAREER_ROLE_FAMILIES.map(k=><option key={k} value={k}>{labels[k]}</option>)}</select></label>
   <JobDeadlineInput value={form.deadline} disabled={locked||duplicate} onChange={deadline=>setForm({...form,deadline})}/>
   <label>JD 原文<textarea required value={form.jobText} disabled={locked||duplicate} onChange={e=>setForm({...form,jobText:e.target.value})}/></label><label>私人备注（可留空）<textarea value={form.privateNote} disabled={locked||duplicate} onChange={e=>setForm({...form,privateNote:e.target.value})}/></label>
   {duplicate&&<section aria-label="重复收藏确认"><p>这个岗位之前收藏过。要打开原来的那条，还是新建一份？</p>{matches.map(j=><button type="button" disabled={locked} key={j.id} onClick={()=>void controller.open(j.id)}>打开 {j.title} · {new Date(j.observedAt).toLocaleDateString()}</button>)}<button type="button" disabled={locked||!resolveJobDeadline(form.deadline).savable} onClick={()=>save(true)}>还是新建</button><button type="button" disabled={locked} onClick={()=>controller.dismissDuplicate()}>回去修改</button></section>}
   <div className="career-target-actions"><button type="submit" disabled={locked||duplicate||!resolveJobDeadline(form.deadline).savable}>确认收藏</button><button type="button" disabled={locked} onClick={()=>{setForm(null);controller.dismissDuplicate();}}>先不保存</button></div></form>}
  {loaded&&remove&&<section className="career-target-confirmation"><p>移除「{remove.title}」？保存的 JD 和私人备注会删除。</p><div className="career-target-actions"><button type="button" disabled={locked} onClick={()=>start('delete',remove.id,{expectedRevision:remove.revision})}>确认移除</button><button type="button" disabled={locked} onClick={()=>setRemove(null)}>保留</button></div></section>}
  {loaded&&detail&&<section className="career-target-editor" aria-label="岗位原文"><div className="career-target-actions"><h2>{detail.employer} · {detail.title}</h2><button type="button" onClick={()=>controller.closeDetail()}>收起原文</button></div><p>你贴的 JD · 没核实是否还开放</p><p>原句检查于 {new Date(detail.checkedAt).toLocaleString()}（检查的是你粘贴的文字）</p><h3>身份与工作授权相关原句</h3>{detail.sponsorshipEvidence.length?<div>{detail.sponsorshipEvidence.map(e=><blockquote key={e.start}>{e.text}</blockquote>)}{detail.evidenceOverflow&&<p>相关原句较多，这里显示前 50 条，请同时核对完整原文。</p>}</div>:<p>没找到相关原句（{new Date(detail.checkedAt).toLocaleDateString()} 查看），提交前请自己扫一眼。</p>}<details><summary>完整 JD 原文</summary><pre>{detail.jobText}</pre></details>{detail.privateNote&&<details><summary>私人备注</summary><pre>{detail.privateNote}</pre></details>}<p>需要更正时，可以移除后重新收藏一份。</p></section>}
  {loaded&&<><ul className="career-target-list">{jobs.map(j=><li key={j.id}><h2>{j.title}</h2><p>{j.employer} · {labels[j.roleFamily]}{j.location?' · '+j.location:''}</p><p>你贴的 JD · 没核实是否还开放</p><p>收藏于 {new Date(j.observedAt).toLocaleString()}</p>{j.deadlineAt&&<p>你填写的截止时间：{displayZonedTime(j.deadlineAt,j.deadlineTimeZone!)}</p>}<div className="career-target-actions"><button type="button" disabled={busy} onClick={()=>void controller.open(j.id)}>核对原句</button>{j.canonicalUrl&&<a href={j.canonicalUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开保存的链接</a>}<button type="button" disabled={locked} onClick={()=>setRemove(j)}>移除</button></div></li>)}</ul>{next&&<button type="button" disabled={busy} onClick={()=>void controller.refresh(next)}>继续看已收藏的岗位</button>}
 </>}</section></main>;
}
