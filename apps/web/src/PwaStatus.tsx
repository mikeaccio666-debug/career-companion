import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { CloudOff, Info, Loader2, RefreshCw, X } from 'lucide-react';
import { pwaNotices, pwaRuntime, publicConnectionCopy, type PwaRuntime } from './pwa-runtime';
import { Brand } from './ui';
import './pwa.css';

export function PwaStatus({ runtime = pwaRuntime }: { runtime?: PwaRuntime }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const [dismissed, setDismissed] = useState<Partial<Record<string, boolean>>>({});
  const notices = pwaNotices(state).filter((notice) => !notice.dismissible || !dismissed[notice.id]);
  if (!notices.length) return null;
  return <section className="pwa-status-stack" aria-label="工作台连接与更新">
    {notices.map((notice) => <div className={`pwa-notice pwa-notice-${notice.id}`} key={notice.id}>
      {notice.id === 'offline' ? <CloudOff size={18} aria-hidden="true" /> : <Info size={18} aria-hidden="true" />}
      <div role="status" aria-live="polite"><strong>{notice.title}</strong><p>{notice.text}</p></div>
      {notice.dismissible && <button className="icon-button pwa-dismiss" type="button" aria-label={`收起${notice.title}提示`} onClick={() => setDismissed((prior) => ({ ...prior, [notice.id]: true }))}><X size={17} aria-hidden="true" /></button>}
    </div>)}
  </section>;
}

/** Status consumes normal layout space so it never overlays recording controls. */
export function PwaShell({ children }: { children: ReactNode }) {
  return <div className="pwa-shell"><PwaStatus /><div className="pwa-page-content">{children}</div></div>;
}

export function PublicConnectionView({ online, connecting, onRetry }: { online: boolean; connecting: boolean; onRetry(): void }) {
  const copy = publicConnectionCopy(online, connecting);
  return <main className="public-connection">
    <Brand />
    <section aria-labelledby="public-connection-title" aria-busy={connecting}>
      <div className="public-connection-icon" aria-hidden="true">{online && connecting ? <Loader2 size={25} className="spin" /> : <CloudOff size={25} />}</div>
      <h1 id="public-connection-title">{copy.title}</h1>
      <p role={connecting ? 'status' : 'alert'}>{copy.text}</p>
      <button className="primary" type="button" disabled={connecting} onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />{connecting ? '正在连接…' : '重试连接'}</button>
      <small>不会自动发送消息、重试任务或提交申请。</small>
    </section>
  </main>;
}
