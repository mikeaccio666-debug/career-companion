import {useEffect,useId,useMemo,useRef,useSyncExternalStore} from 'react';
import {createPortal,flushSync} from 'react-dom';
import type {ResumeReviewItem} from '@companion/platform-contracts';
import {useRequiredPlatformAccountClient} from './account-client';
import {ResumePrintController} from './resume-print-controller';
import './resume-print-view.css';

function browserPrint(signal:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  const clean=()=>{window.removeEventListener('afterprint',done);signal.removeEventListener('abort',cancel);};
  const done=()=>{clean();resolve();},cancel=()=>{clean();reject(new DOMException('Interrupted','AbortError'));};
  window.addEventListener('afterprint',done,{once:true});signal.addEventListener('abort',cancel,{once:true});
  try{signal.throwIfAborted();if(!navigator.onLine||document.hidden)throw Error('Preview unavailable');window.print();}catch(e){clean();reject(e);}
 });
}

export function ResumePrintButton({item,disabled}:{item:Readonly<ResumeReviewItem>;disabled:boolean}){
 const client=useRequiredPlatformAccountClient();
 // The parent keys this component by account and item coordinates.
 const controller=useMemo(()=>new ResumePrintController(client,item),[client,item.id,item.revision,item.generation,item.payloadDigest]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),titleId=useId();
 const opened=state.phase!=='closed'&&client.isCurrent()&&!disabled;
 useEffect(()=>{
  controller.start();
  const clear=()=>controller.close(),hidden=()=>{if(document.hidden)clear();};
  window.addEventListener('offline',clear);document.addEventListener('visibilitychange',hidden);
  return ()=>{window.removeEventListener('offline',clear);document.removeEventListener('visibilitychange',hidden);controller.stop();};
 },[controller]);
 useEffect(()=>{if(disabled)controller.close();},[disabled,controller]);
 useEffect(()=>{
  if(!opened)return;
  const element=dialog.current;
  element?.showModal();
  return ()=>{element?.close();if(trigger.current?.isConnected)trigger.current.focus();};
 },[opened]);
 async function print(){
  await controller.print(async signal=>{
   // Commit the freshly verified text before the browser captures the document.
   flushSync(()=>{});
   await browserPrint(signal);
  });
 }
 return <><button ref={trigger} type="button" disabled={disabled||!client.isCurrent()} onClick={()=>{if(navigator.onLine&&!document.hidden)void controller.prepare();}}>打印 / 另存为 PDF</button>
 {opened&&createPortal(<div className="resume-print-host" data-print-ready={state.phase==='printing'?'true':'false'}>
  <dialog ref={dialog} className="resume-print-dialog career-surface" aria-labelledby={titleId} onCancel={e=>{e.preventDefault();controller.close();}}>
   <header className="resume-print-chrome"><h2 id={titleId}>简历打印预览</h2><p>{item.label} · v{item.sequence} · r{item.revision}{item.resumeStatus==='archived'?' · 已归档':''}</p>
    <p>按原文排版，不还原上传文件的样式。在系统打印窗口中选择打印机或「另存为 PDF」；建议关闭页眉和页脚。</p>
    <div className="resume-print-actions"><button type="button" disabled={state.phase!=='preview'} onClick={()=>void print()}>打印 / 保存 PDF</button><button type="button" onClick={()=>controller.close()}>关闭预览</button></div>
    {(state.phase==='loading'||state.phase==='checking')&&<p role="status">正在核对已确认版本…</p>}
    {state.phase==='printing'&&<p role="status">请在系统打印窗口操作。返回后可以关闭预览；这里无法判断是否保存成功。</p>}
    {state.error&&<p role="alert">{state.error}</p>}
   </header>
   <p className="resume-print-instruction">请使用预览中的打印按钮重新核对版本。</p>
   {(state.phase==='preview'||state.phase==='printing')&&<pre className="resume-print-document">{state.text}</pre>}
  </dialog>
 </div>,document.body)}</>;
}
