import { useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { executionAvailabilityCopy, type ExecutionAvailability, type ServiceReadinessState } from './service-readiness';
import './pwa.css';

export default function ExecutionAvailabilityNotice({ status, execution, onRefresh }: {
  status?: ServiceReadinessState['status']; execution?: ExecutionAvailability; onRefresh(): Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  }
  const copy = executionAvailabilityCopy(status, execution);
  if (!copy) return null;
  return <section className="pwa-status-stack" aria-label="执行服务状态">
    <div className="pwa-notice pwa-notice-unavailable">
      <Info size={18} aria-hidden="true" />
      <div role="status" aria-live="polite"><strong>{copy.title}</strong><p>{copy.text}</p></div>
      <button className="icon-button pwa-dismiss execution-availability-refresh" type="button" aria-label={refreshing ? '正在检查执行服务' : '重新检查执行服务'} disabled={refreshing} onClick={() => { void refresh(); }}><RefreshCw size={17} className={refreshing ? 'spin' : undefined} aria-hidden="true" /></button>
    </div>
  </section>;
}
