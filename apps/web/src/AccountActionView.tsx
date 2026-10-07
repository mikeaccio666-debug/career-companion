import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Mail, ShieldCheck } from 'lucide-react';
import { Brand, Badge } from './ui';
import { useRequiredPlatformAccountClient } from './account-client';
import { entity, request } from './api';
import { accountActionFailure, emailActionsDisabledText, passwordResetAcceptedText, passwordResetValidation, type AccountActionLink, type AuthOptions } from './account-actions';
import type { User } from './types';
import './account-actions.css';

function useActionRequest() {
  const [pending, setPending] = useState(false);
  const live = useRef(true), busy = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  async function run<T>(work: (signal: AbortSignal) => Promise<T>, applied: (value: T) => void, failed: (error: unknown) => void) {
    if (!live.current || busy.current) return;
    busy.current = true; setPending(true); const current = new AbortController(); controller.current = current;
    try { const value = await work(current.signal); if (live.current && !current.signal.aborted) applied(value); }
    catch (error) { if (live.current && !current.signal.aborted) failed(error); }
    finally { busy.current = false; if (controller.current === current) controller.current = null; if (live.current && !current.signal.aborted) setPending(false); }
  }
  return { pending, run };
}
function actionPost<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> { return request(path, { method: 'POST', body: JSON.stringify(body), signal }); }

function AccountCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="auth-page account-action-page"><div className="auth-top"><Brand /></div><main className="account-action-layout"><section className="auth-form-card"><div className="auth-form-icon"><ShieldCheck size={24} /></div><h2>{title}</h2><p>{description}</p>{children}</section></main></div>;
}

export function PasswordResetRequest({ options, initialEmail = '', onBack }: { options: AuthOptions | null; initialEmail?: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail), [message, setMessage] = useState(''), [error, setError] = useState('');
  const { pending, run } = useActionRequest();
  function submit(event: React.FormEvent) {
    event.preventDefault(); if (!options?.emailActionsEnabled) return; setError(''); setMessage('');
    void run((signal) => actionPost<{ accepted: boolean }>('/auth/password-reset/request', { email: email.trim() }, signal), (result) => { if (result.accepted !== true) { setError('服务没有接受申请，请重试。'); return; } setMessage(passwordResetAcceptedText); }, (failure) => setError(accountActionFailure(failure).text));
  }
  return <><form onSubmit={submit}><label>账号邮箱<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={pending} placeholder="you@example.com" /></label>{!options?.emailActionsEnabled && <p className="account-notice" role="status">{options ? emailActionsDisabledText : '正在确认账号邮件配置。'}</p>}{error && <div className="form-error" role="alert">{error}</div>}{message && <p className="account-notice" role="status">{message}</p>}<button className="primary full" type="submit" disabled={pending || !options?.emailActionsEnabled}>{pending ? '正在申请…' : '发送找回邮件'}<Mail size={16} /></button></form><button className="text-button account-back" type="button" disabled={pending} onClick={onBack}>返回登录</button></>;
}

export function EmailVerificationControls({ user, options, token, onVerified, onDiscardToken, onLogout }: { user: User; options: AuthOptions; token?: string; onVerified: (user: User) => void; onDiscardToken?: () => void; onLogout?: () => void }) {
  const accountClient = useRequiredPlatformAccountClient();
  const { pending, run } = useActionRequest(); const [message, setMessage] = useState(''), [error, setError] = useState('');
  function failed(failure: unknown) { const detail = accountActionFailure(failure); setError(detail.text); if (detail.discardToken) onDiscardToken?.(); }
  function resend() {
    if (!options.emailActionsEnabled) return; setMessage(''); setError('');
    void run((signal) => accountClient.request<{ accepted: boolean }>('/auth/email-verification/request', { method: 'POST', body: '{}', signal }), (result) => { if (result.accepted !== true) { setError('服务没有接受申请，请重试。'); return; } setMessage('验证邮件申请已接受，请查看收件箱和垃圾邮件。'); }, failed);
  }
  function verify() {
    if (!token || !options.emailActionsEnabled) return; setMessage(''); setError('');
    void run((signal) => accountClient.request('/auth/email-verification/complete', { method: 'POST', body: JSON.stringify({ token }), signal }), (data) => { const next = entity<User>(data, 'user'); if (!next?.id || next.id !== user.id || next.emailVerified !== true) { setError('服务没有确认这个账号的邮箱验证，请重试。'); return; } onVerified(next); }, failed);
  }
  return <div className="account-verification"><p className="account-notice">{user.emailVerified ? '邮箱已验证。' : <>当前账号：<strong>{user.email}</strong><br />{token ? '请确认这是收到验证邮件的账号，然后点击完成验证。' : '请打开邮箱里的验证链接，再手动完成验证。'}</>}</p>{!options.emailActionsEnabled && !user.emailVerified && <p className="account-notice" role="status">{emailActionsDisabledText}</p>}{error && <div className="form-error" role="alert">{error}</div>}{message && <p className="account-notice" role="status">{message}</p>}<div className="account-action-buttons">{token && <button className="primary full" type="button" disabled={pending || !options.emailActionsEnabled} onClick={verify}>{pending ? '正在处理…' : '完成邮箱验证'}<ShieldCheck size={16} /></button>}{!user.emailVerified && <button className="secondary" type="button" disabled={pending || !options.emailActionsEnabled} onClick={resend}>{pending ? '正在处理…' : '重新发送验证邮件'}<Mail size={15} /></button>}{onLogout && <button className="text-button" type="button" disabled={pending} onClick={onLogout}>退出并切换账号</button>}</div></div>;
}

export function AccountGate({ user, options, onVerified, onLogout, serverError }: { user: User; options: AuthOptions; onVerified: (user: User) => void; onLogout: () => void; serverError?: string }) {
  return <AccountCard title="验证邮箱，继续你的求职旅程" description="先确认账号邮箱，再继续。">{serverError && <div className="form-error" role="alert">{serverError}</div>}<EmailVerificationControls user={user} options={options} onVerified={onVerified} onLogout={onLogout} /></AccountCard>;
}

export default function AccountActionView({ action, user, options, onVerified, onReset, onBack, onDiscardToken, onLogout }: { action: AccountActionLink; user: User | null; options: AuthOptions; onVerified: (user: User) => void; onReset: () => void; onBack: () => void; onDiscardToken: () => void; onLogout: () => void }) {
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [error, setError] = useState('');
  const { pending, run } = useActionRequest();
  function submit(event: React.FormEvent) {
    event.preventDefault(); if (action.kind !== 'password-reset' || !options.emailActionsEnabled) return;
    const invalid = passwordResetValidation(password, confirmation); if (invalid) { setError(invalid); return; } setError('');
    void run((signal) => actionPost<{ ok: boolean }>('/auth/password-reset/complete', { token: action.token, password }, signal), (result) => { if (result.ok !== true) { setError('服务没有确认密码更新，请重试。'); return; } setPassword(''); setConfirmation(''); onReset(); }, (failure) => { const detail = accountActionFailure(failure); setError(detail.text); if (detail.discardToken) { setPassword(''); setConfirmation(''); onDiscardToken(); } });
  }
  if (action.kind === 'invalid') return <AccountCard title="这个账号链接不可用" description="链接格式不完整、已失效或已使用。请重新申请邮件。">{action.purpose === 'password-reset' ? <PasswordResetRequest options={options} onBack={onBack} /> : user ? <><EmailVerificationControls user={user} options={options} onVerified={onVerified} onLogout={onLogout} /><button className="text-button account-back" type="button" onClick={onBack}>返回账号入口</button></> : <button className="primary full" type="button" onClick={onBack}>返回登录<ArrowRight size={16} /></button>}</AccountCard>;
  if (action.kind === 'verify-email') return <AccountCard title="完成邮箱验证" description="打开链接不会自动验证。确认当前账号后，由你完成最后一步。">{user && <EmailVerificationControls user={user} options={options} token={action.token} onVerified={onVerified} onDiscardToken={onDiscardToken} onLogout={onLogout} />}<button className="text-button account-back" type="button" disabled={pending} onClick={onBack}>返回账号入口</button></AccountCard>;
  return <AccountCard title="设置新密码" description="密码更新后，所有设备都需要重新登录。">{user && <p className="account-notice">请确认找回邮件对应你要更新的账号。</p>}<form onSubmit={submit}><label>新密码<input type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={password} disabled={pending} onChange={(event) => setPassword(event.target.value)} /></label><label>再次输入新密码<input type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={confirmation} disabled={pending} onChange={(event) => setConfirmation(event.target.value)} /></label>{!options.emailActionsEnabled && <p className="account-notice" role="status">{emailActionsDisabledText}</p>}{error && <div className="form-error" role="alert">{error}</div>}<button className="primary full" type="submit" disabled={pending || !options.emailActionsEnabled}>{pending ? '正在更新…' : '更新密码并返回登录'}<ArrowRight size={16} /></button></form>{error && <button className="text-button account-back" type="button" disabled={pending} onClick={onDiscardToken}>重新申请找回邮件</button>}<button className="text-button account-back" type="button" disabled={pending} onClick={onBack}>取消，返回账号入口</button></AccountCard>;
}
