import {StudentPageNavigation} from './app/StudentPageNavigation';
import { MentorHumanEntry } from './mentor-human-entry';
import {useEffect,useMemo,useState} from 'react';
import {CAREER_IDENTITY_FIELDS,type CareerIdentityField,type CareerIdentityRecord} from '@companion/platform-contracts';
import {useRequiredPlatformAccountClient} from './account-client';
import {CareerIdentityController,type IdentitySnapshot} from './career-identity-controller';
import {IDENTITY_FOOTER,identityLabels,identityValueText,identityEditorValue} from './career-identity-presentation';
import './career-identity-view.css';
interface Editor {record:Readonly<CareerIdentityRecord>|null;field:CareerIdentityField|'';text:string;booleanChoice:string;year:string;outcome:string;label:string;}
function draft(r:Readonly<CareerIdentityRecord>|null):Editor{
 const v=r?.value;return {record:r,field:r?.field??'',text:typeof v==='string'?v:r?.field==='unemployment_days_reported'?String((v as {days:number}).days):'',booleanChoice:typeof v==='boolean'?String(v):'',year:r?.field==='h1b_registration'?String((v as {year:number}).year):'',outcome:r?.field==='h1b_registration'?(v as {outcome:string}).outcome:'',label:r?.label??''};
}
export function CareerIdentityPanel(){
 const client=useRequiredPlatformAccountClient(),[observed,setObserved]=useState<{client:typeof client;state:IdentitySnapshot}|null>(null);
 const controller=useMemo(()=>new CareerIdentityController(client,state=>setObserved({client,state})),[client]);
 const [editor,setEditor]=useState<Editor|null>(null),[deleting,setDeleting]=useState<Readonly<CareerIdentityRecord>|null>(null),[inputError,setInputError]=useState('');
 useEffect(()=>{setObserved(null);setEditor(null);setDeleting(null);setInputError('');controller.start();return()=>controller.stop();},[controller]);
 useEffect(()=>client.subscribe(()=>{if(!client.isCurrent()){setEditor(null);setDeleting(null);setInputError('');}}),[client]);
 const state=observed?.client===client?observed.state:null;
 useEffect(()=>{if(state?.lastResult){setEditor(null);setDeleting(null);setInputError('');}},[state?.lastResult]);
 if(!client.isCurrent())return null;
 return <CareerIdentityScene state={state} editor={editor} setEditor={setEditor} deleting={deleting} setDeleting={setDeleting} inputError={inputError} setInputError={setInputError} controller={controller}/>;
}
interface IdentitySceneProps {state:IdentitySnapshot|null;editor:Editor|null;setEditor:(v:Editor|null)=>void;deleting:Readonly<CareerIdentityRecord>|null;setDeleting:(v:Readonly<CareerIdentityRecord>|null)=>void;inputError:string;setInputError:(v:string)=>void;controller:Pick<CareerIdentityController,'refresh'|'observe'|'retry'|'begin'>;}
/** Presentation only; account, source and response verification stay in the
 * container/client/controller. No model, browser execution or OAuth here. */
export function CareerIdentityScene({state,editor,setEditor,deleting,setDeleting,inputError,setInputError,controller}:IdentitySceneProps){
 if(!state?.entry)return <section className="identity-loading"><p role="status">{state?.error||'正在读取你的个人资料…'}</p><button type="button" disabled={state?.busy} onClick={()=>void controller.refresh()}>重新读取</button></section>;
 // No title, form, footer, empty-state prompt or field values on declined/skipped
 // or unproven intake. A saved date alone never establishes a qualifying stage.
 if(state.entry.kind==='hidden')return <p className="identity-hidden">这里暂无可展示的资料。</p>;
 const locked=state.busy||!!state.pending;
 function save(){
  if(!editor||!editor.field||locked)return;
  try{const value=identityEditorValue(editor.field,editor.text,editor.booleanChoice,editor.year,editor.outcome);controller.begin({action:editor.record?'edit':'create',id:editor.record?.id??null,body:{operationId:crypto.randomUUID(),expectedRevision:editor.record?.revision??0,field:editor.field,value,label:editor.field==='custom_status_date'?editor.label:null}});setInputError('');}
  catch{setInputError('请核对这一项的值；日期按 YYYY-MM-DD 填写。不确定时可以先取消。');}
 }
 function remove(){if(!deleting||locked)return;controller.begin({action:'delete',id:deleting.id,body:{operationId:crypto.randomUUID(),expectedRevision:deleting.revision}});}
 return <section className="identity-panel" id="identity-clock" aria-labelledby="identity-title"><header><p className="identity-eyebrow">你的记录 · 只在网页显示</p><h1 id="identity-title">身份时钟</h1><p>一次记一项。按你填写的值保存，也可以随时修改或删除。</p></header>
  <div className="identity-actions"><button type="button" disabled={locked} onClick={()=>{setEditor(draft(null));setInputError('');}}>记录一项</button><button type="button" disabled={state.busy} onClick={()=>void controller.refresh()}>重新读取</button></div>
  {state.busy&&<p role="status">正在读取或确认…</p>}{(state.error||inputError)&&<p className="identity-notice" role="alert">{inputError||state.error}</p>}
  {state.uncertain&&<div className="identity-actions"><button type="button" disabled={state.busy} onClick={()=>void controller.observe()}>核对这次操作</button><button type="button" disabled={state.busy} onClick={()=>void controller.retry()}>用原操作重试</button></div>}
  {editor&&<form className="identity-editor" onSubmit={e=>{e.preventDefault();save();}}><h2>{editor.record?'修改这一项':'你想记下哪一项？'}</h2>
   <label>记录项目<select value={editor.field} disabled={locked||!!editor.record} onChange={e=>setEditor({...draft(null),field:e.target.value as Editor['field']})}><option value="">请选择</option>{CAREER_IDENTITY_FIELDS.map(k=><option key={k} value={k}>{identityLabels[k]}</option>)}</select></label>
   {(editor.field==='employment_reported'||editor.field==='stem_designated')?<label>你报告的答案<select value={editor.booleanChoice} disabled={locked} onChange={e=>setEditor({...editor,booleanChoice:e.target.value})}><option value="">请选择，或先取消</option><option value="true">{editor.field==='employment_reported'?'有工作':'是'}</option><option value="false">{editor.field==='employment_reported'?'没有工作':'否'}</option></select></label>
    :editor.field==='h1b_registration'?<><label>报告年份<input inputMode="numeric" value={editor.year} disabled={locked||!!editor.record} onChange={e=>setEditor({...editor,year:e.target.value})}/></label><label>你知道的结果<select value={editor.outcome} disabled={locked} onChange={e=>setEditor({...editor,outcome:e.target.value})}><option value="">请选择</option><option value="selected">已中签</option><option value="not_selected">未中签</option><option value="unknown">不确定</option></select></label></>
    :editor.field==='unemployment_days_reported'?<label>你自己记的天数<input inputMode="numeric" value={editor.text} disabled={locked} onChange={e=>setEditor({...editor,text:e.target.value})}/><small>不确定就先空着；没有回答不会记成 0。</small></label>
    :editor.field==='opt_status'?<label>你记录的状态<input value={editor.text} maxLength={160} disabled={locked} onChange={e=>setEditor({...editor,text:e.target.value})}/></label>
    :editor.field?<label>你录入的日期<input type="date" value={editor.text} disabled={locked} onChange={e=>setEditor({...editor,text:e.target.value})}/></label>:null}
   {editor.field==='custom_status_date'&&<label>给这个日期起个名称<input maxLength={120} value={editor.label} disabled={locked} onChange={e=>setEditor({...editor,label:e.target.value})}/></label>}
   {editor.record&&state.records.find(r=>r.id===editor.record!.id)?.revision!==editor.record.revision&&<button type="button" disabled={locked} onClick={()=>{const latest=state.records.find(r=>r.id===editor.record!.id);if(latest)setEditor(draft(latest));}}>放弃这次修改，用最新记录重新开始</button>}
   <div className="identity-actions"><button type="submit" disabled={locked||!editor.field}>确认并保存</button><button type="button" disabled={locked} onClick={()=>{setEditor(null);setInputError('');}}>先取消</button></div>
  </form>}
  {deleting&&<section className="identity-delete" aria-label="确认删除这项记录"><p>删除「{deleting.label||identityLabels[deleting.field]}」？这项保存的值会移除。</p><div className="identity-actions"><button type="button" disabled={locked} onClick={remove}>确认删除</button><button type="button" disabled={locked} onClick={()=>setDeleting(null)}>保留</button></div></section>}
  {!state.records.length&&!editor&&<p className="identity-empty">你还没有保存记录。</p>}
  <ul className="identity-records">{state.records.map(r=><li key={r.id}><h2>{r.label||identityLabels[r.field]}</h2>{r.field==='unemployment_days_reported'?<details><summary>查看你上次记下的数字</summary><p className="identity-value">{identityValueText(r)}</p></details>:<p className="identity-value">{identityValueText(r)}</p>}<small>你录入的 · 只在网页显示</small><p className="identity-record-footer">{IDENTITY_FOOTER}</p><div className="identity-actions"><button type="button" disabled={locked} onClick={()=>{setEditor(draft(r));setInputError('');}}>修改</button><button type="button" disabled={locked} onClick={()=>setDeleting(r)}>删除</button></div></li>)}</ul>
  <footer className="identity-footer">{IDENTITY_FOOTER}</footer>
 </section>;
}
export function CareerIdentityPage({onLogout}:{onLogout:()=>void}){return <main className="identity-page"><StudentPageNavigation><a href="/">回到对话</a><a href="/me/memory">它记得的你</a><button type="button" onClick={onLogout}>退出登录</button></StudentPageNavigation><p className="identity-ai">AI 主理人和队伍 · 个人资料</p><section className="mentor-human-group career-surface" aria-label="真人与社区"><h2>真人与社区</h2><MentorHumanEntry/></section><CareerIdentityPanel/></main>;}
