import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRequiredPlatformAccountClient } from './account-client';
import { MentorRatingScope } from './mentor-rating-scope';
const Scope = createContext<MentorRatingScope | null>(null);
export const useMentorRatingScope = () => useContext(Scope);
export function MentorRatingProvider({ children, visibleSessions }: { children: ReactNode; visibleSessions: readonly string[] }) {
  const client = useRequiredPlatformAccountClient();
  const scope = useMemo(() => new MentorRatingScope(client), [client]);
  const [notice, setNotice] = useState<{scope: MentorRatingScope; text: string} | null>(null);
  const pending = useSyncExternalStore(scope.subscribe, scope.snapshot, scope.snapshot);
  useEffect(() => {
    scope.start(document.hidden || !navigator.onLine);
    const visibility = () => { if (document.hidden || !navigator.onLine) { scope.suspend(); setNotice(null); } else scope.resume(); };
    const protect = (event: BeforeUnloadEvent) => { if (scope.snapshot().length) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('online', visibility);
    window.addEventListener('offline', visibility); window.addEventListener('beforeunload', protect);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', visibility);
      window.removeEventListener('offline', visibility); window.removeEventListener('beforeunload', protect); scope.stop(); };
  }, [scope]);
  async function recover(sessionId: string, retry: boolean) {
    const controller = scope.controller(sessionId); if (!controller || !client.isCurrent()) return;
    const result = await (retry ? controller.retry() : controller.observe());
    if (!client.isCurrent()) return;
    if (result) setNotice({scope, text: result.rating?.action === 'skip' ? '已核对：这次会后评分已跳过。' : '已核对：你的反馈已记录，仅内部可见。'});
    else if (!scope.controller(sessionId)?.snapshot().pending) setNotice({scope, text: '这次尚未确认保存。请重新读取会后反馈。'});
  }
  return <Scope.Provider value={scope}>{children}{client.isCurrent() && notice?.scope === scope && <p className="mentor-notice" role="status">{notice.text}</p>}{client.isCurrent() && pending.filter(item => !item.state.suspended && !visibleSessions.includes(item.sessionId)).map(item =>
    <section className="mentor-notice" aria-label="待核对的会后反馈" key={item.sessionId}>
      <p role="status">有一份会后反馈尚未核对。请求列表暂时看不到这条记录，也可以核对原来的提交。</p>
      {item.state.error && <p>{item.state.error}</p>}
      <div className="mentor-actions"><button type="button" disabled={item.state.busy} onClick={() => void recover(item.sessionId, false)}>核对这次反馈</button>
        <button type="button" disabled={item.state.busy} onClick={() => void recover(item.sessionId, true)}>用原操作重试</button></div>
    </section>)}</Scope.Provider>;
}
