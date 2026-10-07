import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Command } from 'lucide-react';
import { Brand } from './ui';
import { BRAND } from './brand';
import { entity, errorText, request } from './api';
import { PasswordResetRequest } from './AccountActionView';
import type { AuthOptions } from './account-actions';
import type { User } from './types';
export default function AuthView({ onUser, serverError, options, initialLogin = false, notice, onCancelAction }: { onUser: (user: User) => void; serverError?: string; options: AuthOptions | null; initialLogin?: boolean; notice?: string; onCancelAction?: () => void }) {
  const [register, setRegister] = useState(!initialLogin);
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true), busy = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy.current || !options) return; busy.current = true; setPending(true); setError(''); const current = new AbortController(); controller.current = current;
    try { const data = await request(register ? '/auth/register' : '/auth/login', { method: 'POST', body: JSON.stringify({ email: email.trim(), password, ...(register ? { name: name.trim() || email.trim().split('@')[0] } : {}) }), signal: current.signal }); if (!live.current || current.signal.aborted) return; const user = entity<User>(data, 'user'); if (!user?.id) throw new Error('服务没有返回有效的用户。'); setPassword(''); onUser(user); }
    catch (err) { if (live.current && !current.signal.aborted) setError(errorText(err)); } finally { busy.current = false; if (controller.current === current) controller.current = null; if (live.current && !current.signal.aborted) setPending(false); }
  }
  return <div className="auth-page"><div className="auth-top"><Brand /></div><div className="auth-layout"><section className="auth-story"><h1>从现在的经历，<br />找到<span>下一步。</span></h1><p className="auth-intro">整理经历，练习表达，讨论求职方向。<br />用一件小事，验证下一步。</p><div className="auth-benefits"><span><Check size={14} />梳理经历</span><span><Check size={14} />讨论方向</span><span><Check size={14} />练习表达</span></div></section><section className="auth-form-card"><div className="auth-form-icon"><Command size={24} /></div><h2>{forgot ? '找回你的账号' : register ? '欢迎来到你的工作台' : '欢迎回来'}</h2><p>{forgot ? '通过账号邮箱设置新密码。' : register ? '创建账号，保存会话、作品和记忆。' : '继续上次的思考和创作。'}</p>{notice && <p className="account-notice" role="status">{notice}</p>}{forgot ? <PasswordResetRequest options={options} initialEmail={email} onBack={() => { setForgot(false); setRegister(false); setError(''); }} /> : <><div className="segmented"><button className={register ? 'selected' : ''} disabled={pending} onClick={() => { setRegister(true); setError(''); }}>注册</button><button className={!register ? 'selected' : ''} disabled={pending} onClick={() => { setRegister(false); setError(''); }}>登录</button></div><form onSubmit={submit}>{register && <label>怎么称呼你<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="你的名字（可选）" maxLength={80} /></label>}<label>邮箱<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label><label>密码<input type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={10} maxLength={256} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 10 个字符" /></label>{(error || serverError) && <div role="alert" className="form-error">{error || serverError}</div>}<button className="primary full" type="submit" disabled={pending || !options}>{pending ? '正在连接…' : register ? '创建工作台' : '进入工作台'}<ArrowRight size={16} /></button></form>{!register && <button className="text-button account-back" type="button" disabled={pending} onClick={() => { setForgot(true); setPassword(''); setError(''); }}>忘记密码？</button>}</>}{onCancelAction && <button className="text-button account-back" type="button" disabled={pending} onClick={onCancelAction}>取消邮箱验证</button>}<div className="auth-footnote">账号属于当前服务实例。模型服务待配置时，仍可管理会话与记忆。模型调用需要联网。</div></section></div><footer className="auth-footer"><span>{BRAND.name}</span><span>一起想，一起做。</span></footer></div>;
}
