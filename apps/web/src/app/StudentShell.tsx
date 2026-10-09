import {useEffect,useState,useSyncExternalStore,type ReactNode} from 'react';
import {CalendarDays,MessagesSquare,ClipboardCheck,Route,UserRound} from 'lucide-react';
import {useRequiredPlatformAccountClient} from '../account-client';
import type {User} from '../types';
import type {StudentRoute} from './student-route';
import {STUDENT_NAVIGATION,studentSection,studentPageTitle} from './student-navigation';
import {StudentShellContext} from './StudentPageNavigation';
import '../career-design-tokens.css';
import './student-shell.css';

function subscribeAvailability(change:()=>void){
 window.addEventListener('online',change);window.addEventListener('offline',change);document.addEventListener('visibilitychange',change);
 return()=>{window.removeEventListener('online',change);window.removeEventListener('offline',change);document.removeEventListener('visibilitychange',change);};
}
const available=()=>navigator.onLine&&document.visibilityState!=='hidden';
const icons={today:CalendarDays,chats:MessagesSquare,pending:ClipboardCheck,journey:Route,me:UserRound};
function useEditing(){
 const [editing,setEditing]=useState(false);
 useEffect(()=>{
  const update=()=>{const target=document.activeElement;setEditing(!!target?.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"], [role="textbox"]'));};
  const out=()=>queueMicrotask(update);
  document.addEventListener('focusin',update);document.addEventListener('focusout',out);update();
  return()=>{document.removeEventListener('focusin',update);document.removeEventListener('focusout',out);};
 },[]);
 return editing;
}
/** Existing authenticated student pages only. App still owns all admission gates.
 * Native links preserve beforeunload draft guards and browser history semantics. */
export function StudentShell({route,user,onLogout,children}:{
 route:StudentRoute;user:User;onLogout:()=>void;children:ReactNode;
}){
 const client=useRequiredPlatformAccountClient(),online=useSyncExternalStore(subscribeAvailability,available,()=>false),editing=useEditing();
 if(!client.isCurrent()||client.account.accountId!==user.id)return null;
 const active=studentSection(route),title=studentPageTitle(route);
 return <StudentShellContext.Provider value={true}><div className="student-shell career-surface" data-editing={editing||undefined}>
  <a className="student-shell-skip" href="#student-page-content">跳到页面内容</a>
  <header className="student-shell-header">
   <div className="student-shell-heading"><span className="student-shell-brand">求职小组</span><div><strong>{title}</strong><small>主理人与队员都是 AI</small></div></div>
   <nav className="student-shell-navigation" aria-label="主要导航">{STUDENT_NAVIGATION.map(item=>{
    const Icon=icons[item.key];
    // Room/list services are not connected yet. Never send students into the
    // legacy workbench or claim an empty chat list proves there are no messages.
    return item.key==='chats'?<span key={item.key} className="student-shell-nav-item" role="link" tabIndex={0} aria-disabled="true" aria-label="对话，暂不可用" title="对话暂不可用"><Icon aria-hidden="true"/><span>{item.label}</span><span className="student-shell-sr">，暂不可用</span></span>:
     <a key={item.key} className="student-shell-nav-item" href={item.href} aria-current={active===item.key?'page':undefined}><Icon aria-hidden="true"/><span>{item.label}</span></a>;
   })}</nav>
   <div className="student-shell-account">{online&&<a href="/me" className="student-shell-avatar" aria-label="查看我的账号"><span aria-hidden="true">{Array.from(user.name||user.email)[0]}</span></a>}<button type="button" onClick={()=>{if(client.isCurrent()&&client.account.accountId===user.id)onLogout();}}>退出登录</button></div>
  </header>
  {!online&&<p className="student-shell-unavailable" role="status">{typeof navigator!=='undefined'&&!navigator.onLine?'没网了。连上之后这里会自动更新。':'页面已切到后台。回来后会重新读取。'}</p>}
  <div id="student-page-content" className="student-shell-content" tabIndex={-1} hidden={!online} inert={!online}>{children}</div>
 </div></StudentShellContext.Provider>;
}
