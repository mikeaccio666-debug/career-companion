import { useEffect, useRef, useState } from 'react';
import type { PublicLegalDocuments, StudentConsentStatus } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import type { AuthOptions } from './account-actions';
import { acceptStudentConsent, readPublicLegalDocuments } from './legal-api';
import { isCurrentStudentConsent, legalDocumentsMatch, termsAcceptance } from './student-entry-state';
import { Brand } from './ui';
import type { User } from './types';

export function ConsentCheckbox({ checked, disabled = false, onChange }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className="student-consent-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span>我已阅读<a href="/privacy" target="_blank" rel="noopener noreferrer">隐私政策</a>和<a href="/terms" target="_blank" rel="noopener noreferrer">用户协议</a></span></label>;
}
export default function AccountConsentView({ user, options, consent, checking, serverError, onRetry, onConsented, onLogout }: { user: User; options: AuthOptions; consent: StudentConsentStatus | null; checking: boolean; serverError?: string; onRetry: () => void; onConsented: (status: StudentConsentStatus) => void; onLogout: () => void }) {
  const client = useRequiredPlatformAccountClient();
  const [documents, setDocuments] = useState<PublicLegalDocuments | null>(null), [accepted, setAccepted] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const live = useRef(true), busy = useRef(false), submission = useRef<AbortController | null>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; submission.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setAccepted(false); setDocuments(null); setError('');
    void readPublicLegalDocuments(controller.signal).then((value) => { if (!controller.signal.aborted && client.isCurrent()) setDocuments(value); }).catch(() => { if (!controller.signal.aborted && client.isCurrent()) setError('暂时无法读取完整协议，请稍后重试。'); });
    return () => controller.abort();
  }, [client, options]);
  const available = legalDocumentsMatch(options, documents);
  const canAccept = !!consent && consent.userId === user.id && consent.status !== 'unavailable';
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!live.current || busy.current || checking || !client.isCurrent() || !available || !accepted || !canAccept) return;
    busy.current = true; setPending(true); setError(''); const controller = new AbortController(); submission.current = controller;
    try {
      const status = await acceptStudentConsent(client, termsAcceptance(options, documents, accepted), controller.signal);
      if (!live.current || controller.signal.aborted || !client.isCurrent()) return;
      if (!isCurrentStudentConsent(options, user.id, status)) throw new Error('服务没有确认当前协议，请重新读取后再试。');
      setAccepted(false); onConsented(status);
    } catch { if (live.current && !controller.signal.aborted && client.isCurrent()) { setAccepted(false); setError('协议确认未完成，请重新检查协议状态后重试。'); } }
    finally { busy.current = false; if (submission.current === controller) submission.current = null; if (live.current && !controller.signal.aborted && client.isCurrent()) setPending(false); }
  }
  return <div className="auth-page account-action-page"><div className="auth-top"><Brand /></div><main className="account-action-layout"><section className="auth-form-card student-entry-card"><h1>先确认你的数据去向</h1><p>当前账号：{user.email}。继续前，请阅读并确认当前隐私政策和用户协议。</p>{checking ? <p role="status">正在确认账号的协议状态…</p> : null}{documents?.status === 'available' && available ? <p className="student-data-notice">{documents.dataNotice}</p> : <p className="account-notice" role="status">隐私政策和用户协议暂未开放，当前无法继续。</p>}<form onSubmit={submit}><ConsentCheckbox checked={accepted} disabled={pending || checking || !available || !canAccept} onChange={setAccepted} />{(error || serverError) && <div className="form-error" role="alert">{error || serverError}</div>}<button className="primary full" type="submit" disabled={pending || checking || !available || !accepted || !canAccept}>{pending ? '正在确认…' : '确认并继续'}</button></form><div className="account-action-buttons"><button className="text-button" type="button" disabled={pending || checking} onClick={onRetry}>重新检查协议状态</button><button className="text-button" type="button" disabled={pending} onClick={onLogout}>退出并切换账号</button></div></section></main></div>;
}

export function StudentWelcome({ user, onLogout }: { user: User; onLogout: () => void }) {
  return <div className="auth-page account-action-page"><div className="auth-top"><Brand /></div><main className="account-action-layout"><section className="auth-form-card student-entry-card student-welcome"><h1>{user.name || '你'}，账号已准备好</h1><p role="status">账号和协议确认已完成。接下来的初见流程尚未开放，暂时停留在这里。</p><p>初见开放后，你可以认识自己的主理人，为它起名，再开始求职旅程。</p><div className="account-action-buttons"><a href="/privacy" target="_blank" rel="noopener noreferrer">隐私政策</a><a href="/terms" target="_blank" rel="noopener noreferrer">用户协议</a><button className="text-button" type="button" onClick={onLogout}>退出并切换账号</button></div></section></main></div>;
}
