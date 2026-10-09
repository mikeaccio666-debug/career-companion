import { useEffect, useMemo, useState } from 'react';
import { useRequiredPlatformAccountClient } from './account-client';
import { DailySettingsController, emptyDailySettings } from './companion-daily-settings-controller';
import { DailySettingsForm } from './companion-daily-settings-form';
import './companion-daily-settings-view.css';
export function CompanionDailySettingsPanel() {
  const client = useRequiredPlatformAccountClient();
  const [view, setView] = useState(() => ({ client, state: emptyDailySettings() }));
  const controller = useMemo(() => new DailySettingsController(client, state => setView({ client, state })), [client]);
  const state = view.client === client && client.isCurrent() ? view.state : emptyDailySettings();
  useEffect(() => { controller.start(!navigator.onLine); const offline = () => controller.suspend(), online = () => controller.resume(); window.addEventListener('offline', offline); window.addEventListener('online', online); return () => { window.removeEventListener('offline', offline); window.removeEventListener('online', online); controller.stop(); }; }, [controller]);
  useEffect(() => { if (!state.pending || !client.isCurrent()) return; const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [state.pending, client]);
  const disabled = state.busy || state.suspended || !!state.pending;
  return <section className="daily-settings-panel" aria-labelledby="daily-settings-title"><h2 id="daily-settings-title">每天的节奏</h2><p>晨报尚未开放；现在可以先保存时间偏好。等功能开放后，再按这些设置安排。</p>
    {state.suspended && <p role="status">当前离线。连接恢复后会重新读取设置。</p>}{state.busy && <p role="status">正在确认时间偏好…</p>}{state.error && <p role="alert">{state.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
    {state.loaded && state.settings && <DailySettingsForm key={client.account.accountId + ':' + client.account.generation + ':' + state.settings.companionId + ':' + state.settings.revision} preferences={state.settings.preferences} disabled={disabled} onSave={value => controller.begin(value)}/>}
    <div className="companion-settings-actions"><button type="button" disabled={state.busy || state.suspended || !client.isCurrent()} onClick={() => void controller.refresh()}>重新读取时间偏好</button>{state.pending && <><button type="button" disabled={state.busy || state.suspended} onClick={() => void controller.observe()}>核对这次保存</button><button type="button" disabled={state.busy || state.suspended} onClick={() => void controller.retry()}>用原操作重试</button></>}</div>
  </section>;
}
