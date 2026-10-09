import { useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight } from 'lucide-react';
import { useRequiredPlatformAccountClient } from './account-client';
import { BRAND } from './brand';
import { AppearanceSettings } from './AppearanceSettings';
import type { User } from './types';
import './career-design-tokens.css';
import './student-me-view.css';

const sections = [
  { title: '你的资料', description: '从哪里来，做过什么，哪些事可以让伙伴记住。', links: [
    { href: '/me/profile', label: '个人资料与身份日期', detail: '查看自己录入和确认的信息' },
    { href: '/me/memory', label: '它记得的你', detail: '检查内容、敏感度和谁可以使用' },
    { href: '/journey/stories', label: '项目与故事', detail: '整理经历，保留事实与出处' },
  ] },
  { title: '你的求职记录', description: '回到已保存的方向、岗位和材料，接着做下一步。', links: [
    { href: '/today', label: '今天的安排', detail: '安排自己的事项，也可以先休息' },
    { href: '/journey', label: '旅程总览', detail: '一起查看方向、投递和准备材料' },
    { href: '/journey/targets', label: '目标方向', detail: '查看与调整正在探索的方向' },
    { href: '/journey/jobs', label: '收藏的岗位', detail: '回看职位资料与来源' },
    { href: '/journey/applications', label: '投递旅程', detail: '查看自己记录的投递进展' },
    { href: '/journey/interviews', label: '面试安排', detail: '查看与核对面试时间' },
    { href: '/pending', label: '简历与待确认', detail: '阅读原稿、修改和确认材料' },
  ] },
  { title: '陪伴与真人帮助', description: 'AI 伙伴和真人服务分开，由你选择。', links: [
    { href: '/me/companion', label: '主理人设置', detail: '决定什么时候听到付费服务建议' },
    { href: '/me/mentors', label: '蔓藤导师 · 真人', detail: '查看服务内容与价格；看不到你的对话' },
  ] },
] as const;
function subscribeAvailability(change: () => void) {
  window.addEventListener('online', change); window.addEventListener('offline', change); document.addEventListener('visibilitychange', change);
  return () => { window.removeEventListener('online', change); window.removeEventListener('offline', change); document.removeEventListener('visibilitychange', change); };
}
const available = () => navigator.onLine && document.visibilityState !== 'hidden';

/** Account data comes from the authenticated app, never from URL or local storage. */
export function StudentMePage({ user, onLogout }: { user: User; onLogout: () => void }) {
  const client = useRequiredPlatformAccountClient();
  const online = useSyncExternalStore(subscribeAvailability, available, () => false);
  const current = client.isCurrent() && client.account.accountId === user.id;
  return <main className="career-surface student-me-page" aria-labelledby="student-me-title">
    <header className="student-me-top"><a href="/"><ArrowLeft size={18} aria-hidden="true" />回到首页</a><span>{BRAND.name}</span></header>
    <div className="student-me-content">
      <header className="student-me-heading"><h1 id="student-me-title">我</h1><p>你的资料与偏好，由你决定。</p><small>主理人与队员都是 AI</small></header>
      {current && <AppearanceSettings/>}
      {!current ? <section className="student-me-notice" role="status"><p>账号状态已变化，请重新确认账号。</p><a href="/">重新确认账号</a></section> : !online ? <section className="student-me-notice" role="status"><p>没网了，或页面已切到后台。回来并连上之后，这里会自动更新。</p></section> : <>
        <section className="student-me-account" aria-label="当前账号"><span className="student-me-avatar" aria-hidden="true">{Array.from(user.name || user.email)[0]}</span><div><h2>{user.name || '我的账号'}</h2><p>{user.email}</p><small>{user.emailVerified ? '邮箱已验证' : '邮箱未验证'}</small></div></section>
        <div className="student-me-sections">{sections.map(section => <section key={section.title} aria-label={section.title} className="student-me-section"><header><h2>{section.title}</h2><p>{section.description}</p></header><ul>{section.links.map(link => <li key={link.href}><a href={link.href}><span><strong>{link.label}</strong><small>{link.detail}</small></span><ChevronRight size={18} aria-hidden="true" /></a></li>)}</ul></section>)}</div>
        <section className="student-me-section student-me-legal" aria-labelledby="student-me-legal-title"><header><h2 id="student-me-legal-title">协议与账号</h2><p>了解资料的使用方式，随时查看当前公开说明。</p></header><ul><li><a href="/privacy"><span>隐私政策</span><ArrowUpRight size={18} aria-hidden="true" /></a></li><li><a href="/terms"><span>用户协议</span><ArrowUpRight size={18} aria-hidden="true" /></a></li></ul><button type="button" onClick={() => { if (client.isCurrent() && client.account.accountId === user.id) onLogout(); }}>退出登录</button></section>
      </>}
    </div>
  </main>;
}
