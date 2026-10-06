import { useEffect, useRef, useState } from 'react';
import { ArrowRight, AudioLines, Check, Command, MessageCircle, Sparkles } from 'lucide-react';
import { Brand, Badge } from './ui';
import { entity, errorText, post } from './api';
import type { User } from './types';
export default function AuthView({ onUser, serverError }: { onUser: (user: User) => void; serverError?: string }) {
  const [register, setRegister] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true), busy = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy.current) return; busy.current = true; setPending(true); setError('');
    try { const data = await post(register ? '/auth/register' : '/auth/login', { email: email.trim(), password, ...(register ? { name: name.trim() || email.trim().split('@')[0] } : {}) }); if (!live.current) return; const user = entity<User>(data, 'user'); if (!user?.id) throw new Error('服务没有返回有效的用户。'); setPassword(''); onUser(user); }
    catch (err) { if (live.current) setError(errorText(err)); } finally { busy.current = false; if (live.current) setPending(false); }
  }
  return <div className="auth-page"><div className="auth-top"><Brand /><Badge>PRIVATE WORKSPACE</Badge></div><div className="auth-layout"><section className="auth-story"><div className="eyebrow"><span className="small-leaf" />A LITTLE SPACE FOR BIG IDEAS</div><h1>一个想法，<br />无限<span>可能。</span></h1><p className="auth-intro">想清楚、聊一聊、创造点什么。<br />把灵感变成作品，把计划变成行动。</p><div className="auth-orbit" aria-hidden="true"><div className="orbit-circle one" /><div className="orbit-circle two" /><div className="orbit-mark">o<span>f</span></div><div className="float-note note-chat"><MessageCircle size={19} /><div>从一句话开始<span>THINK TOGETHER</span></div></div><div className="float-note note-create"><Sparkles size={19} /><div>给灵感一种形状<span>MAKE SOMETHING</span></div></div><div className="float-note note-voice"><AudioLines size={19} /><div>说出来，也听进去<span>FIND YOUR FLOW</span></div></div></div><div className="auth-benefits"><span><Check size={14} />对话与陪伴</span><span><Check size={14} />图片与视频</span><span><Check size={14} />可审阅的 Agent</span></div></section><section className="auth-form-card"><div className="auth-form-icon"><Command size={24} /></div><h2>{register ? '欢迎来到你的工作台' : '欢迎回来'}</h2><p>{register ? '创建本地账号，保存会话、作品和记忆。' : '继续上次的思考和创作。'}</p><div className="segmented"><button className={register ? 'selected' : ''} onClick={() => { setRegister(true); setError(''); }}>注册</button><button className={!register ? 'selected' : ''} onClick={() => { setRegister(false); setError(''); }}>登录</button></div><form onSubmit={submit}>{register && <label>怎么称呼你<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="你的名字（可选）" maxLength={80} /></label>}<label>邮箱<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label><label>密码<input type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={10} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 10 个字符" /></label>{(error || serverError) && <div role="alert" className="form-error">{error || serverError}</div>}<button className="primary full" type="submit" disabled={pending}>{pending ? '正在连接…' : register ? '创建工作台' : '进入工作台'}<ArrowRight size={16} /></button></form><div className="auth-footnote">账号属于当前服务实例。模型服务待配置时，仍可管理会话与记忆。模型调用需要联网。</div></section></div><footer className="auth-footer"><span>OPENFIELD · WORK IN PROGRESS</span><span>一起想，一起做。</span></footer></div>;
}
