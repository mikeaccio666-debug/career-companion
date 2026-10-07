import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { PublicLegalDocuments } from '@companion/platform-contracts';
import { Brand } from './ui';
import { BRAND } from './brand';
import { entity, request } from './api';
import { PasswordResetRequest } from './AccountActionView';
import { ConsentCheckbox } from './AccountConsentView';
import { readPublicLegalDocuments } from './legal-api';
import { legalDocumentsMatch, studentEntryFailure, studentRegistrationInput } from './student-entry-state';
import type { AuthOptions } from './account-actions';
import type { User } from './types';

export default function AuthView({ onUser, serverError, options, initialLogin = false, notice, onCancelAction }: { onUser: (user: User, registered: boolean) => void; serverError?: string; options: AuthOptions | null; initialLogin?: boolean; notice?: string; onCancelAction?: () => void }) {
  const [register, setRegister] = useState(!initialLogin), [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState(''), [inviteCode, setInviteCode] = useState('');
  const [accepted, setAccepted] = useState(false), [documents, setDocuments] = useState<PublicLegalDocuments | null>(null), [legalError, setLegalError] = useState('');
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const live = useRef(true), busy = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    const current = new AbortController(); setAccepted(false); setDocuments(null); setLegalError('');
    if (register && !forgot) void readPublicLegalDocuments(current.signal).then((value) => { if (!current.signal.aborted) setDocuments(value); }).catch(() => { if (!current.signal.aborted) setLegalError('暂时无法读取完整协议，请稍后重试。'); });
    return () => current.abort();
  }, [options, register, forgot]);
  const available = legalDocumentsMatch(options, documents);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy.current || !options || register && (!available || !accepted)) return;
    busy.current = true; setPending(true); setError(''); const current = new AbortController(); controller.current = current;
    try {
      const body = register ? studentRegistrationInput(options, documents, accepted, { email, password, name, inviteCode }) : { email: email.trim(), password };
      const data = await request(register ? '/auth/register' : '/auth/login', { method: 'POST', body: JSON.stringify(body), signal: current.signal });
      if (!live.current || current.signal.aborted) return;
      const user = entity<User>(data, 'user'); if (!user?.id) throw new Error('服务没有返回有效的用户。');
      setPassword(''); setInviteCode(''); setAccepted(false); onUser(user, register);
    } catch (err) { if (live.current && !current.signal.aborted) { setAccepted(false); setError(studentEntryFailure(err)); } }
    finally { busy.current = false; if (controller.current === current) controller.current = null; if (live.current && !current.signal.aborted) setPending(false); }
  }
  function chooseMode(value: boolean) { setRegister(value); setAccepted(false); setPassword(''); setError(''); }
  return <div className="auth-page"><div className="auth-top"><Brand /></div><div className="auth-layout"><section className="auth-story"><h1>求职的每一步，<br /><span>有人陪你一起走。</span></h1><p className="auth-intro">专属主理人和按需入场的求职小组，<br />陪你整理经历、练习面试、找到下一步。</p><div className="auth-benefits"><span><Check size={14} />梳理经历</span><span><Check size={14} />讨论方向</span><span><Check size={14} />练习表达</span></div></section><section className="auth-form-card student-entry-card"><h2>{forgot ? '找回你的账号' : register ? '先建一个账号' : '欢迎回来'}</h2><p>{forgot ? '通过账号邮箱设置新密码。' : register ? '先建一个账号，你的求职小组马上就到。' : '登录后继续你的求职旅程。'}</p>{notice && <p className="account-notice" role="status">{notice}</p>}{forgot ? <PasswordResetRequest options={options} initialEmail={email} onBack={() => { setForgot(false); chooseMode(false); }} /> : <><div className="segmented"><button className={register ? 'selected' : ''} disabled={pending} onClick={() => chooseMode(true)}>注册</button><button className={!register ? 'selected' : ''} disabled={pending} onClick={() => chooseMode(false)}>登录</button></div><form onSubmit={submit}>{register && <label>怎么称呼你<input autoComplete="name" value={name} disabled={pending} onChange={(event) => setName(event.target.value)} placeholder="你的名字（可选）" maxLength={80} /></label>}<label>邮箱<input type="email" autoComplete="email" required maxLength={254} disabled={pending} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label><label>密码<input type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={10} maxLength={256} required disabled={pending} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 10 个字符" /></label>{register && <>{options?.requireInvite && <label>邀请码<input autoComplete="off" value={inviteCode} disabled={pending} onChange={(event) => setInviteCode(event.target.value)} placeholder="收到的邀请码" required minLength={20} maxLength={128} /><small>请使用收到邀请的邮箱，邀请码只可使用一次。</small></label>}{available && documents?.status === 'available' ? <p className="student-data-notice">{documents.dataNotice}</p> : <p className="account-notice" role="status">{legalError || (options?.legal.status === 'available' && !documents ? '正在读取隐私政策和用户协议…' : '隐私政策和用户协议尚未开放，暂时无法注册。')}</p>}<ConsentCheckbox checked={accepted} disabled={pending || !available} onChange={setAccepted} /></>}{(error || serverError) && <div role="alert" className="form-error">{error || serverError}</div>}<button className="primary full" type="submit" disabled={pending || !options || register && (!available || !accepted || options?.requireInvite && !inviteCode.trim())}>{pending ? '正在连接…' : register ? '继续' : '登录'}<ArrowRight size={16} /></button></form>{!register && <button className="text-button account-back" type="button" disabled={pending} onClick={() => { setForgot(true); setPassword(''); setAccepted(false); setError(''); }}>忘记密码？</button>}</>}{onCancelAction && <button className="text-button account-back" type="button" disabled={pending} onClick={onCancelAction}>取消邮箱验证</button>}<div className="auth-footnote">主理人和专家小组由 AI 提供。协议页面可在登录前阅读。</div></section></div><footer className="auth-footer"><span>{BRAND.name}</span><span>一起想，一起做。</span></footer></div>;
}
