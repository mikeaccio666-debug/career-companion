import { TodayRestPanel } from './today-rest-view';
import { CompanionDailySettingsPanel } from './companion-daily-settings-view';
import './career-design-tokens.css';
import { useEffect, useMemo, useState } from 'react';
import type { PaidSuggestionsMode, CompanionPaidSettings } from '@companion/platform-contracts';
import { useRequiredPlatformAccountClient } from './account-client';
import { PaidSettingsController, emptyPaidSettings } from './companion-paid-settings-controller';
import './companion-paid-settings-view.css';
export function CompanionPaidSettingsPage({ onLogout }: {
    onLogout: () => void;
}) {
    const client = useRequiredPlatformAccountClient();
    const [view, setView] = useState(() => ({ client, state: emptyPaidSettings() })), [draft, setDraft] = useState<{
        source: Readonly<CompanionPaidSettings> | null;
        choice: PaidSuggestionsMode;
    }>({ source: null, choice: 'when_relevant' });
    const controller = useMemo(() => new PaidSettingsController(client, state => setView({ client, state })), [client]);
    const state = view.client === client && client.isCurrent() ? view.state : emptyPaidSettings();
    useEffect(() => { controller.start(!navigator.onLine); const offline = () => controller.suspend(), online = () => controller.resume(); window.addEventListener('offline', offline); window.addEventListener('online', online); return () => { window.removeEventListener('offline', offline); window.removeEventListener('online', online); controller.stop(); }; }, [controller]);
    const selected = draft.source === state.settings ? draft.choice : state.settings?.paidSuggestionsMode ?? 'when_relevant';
    useEffect(() => { if (!state.pending || !client.isCurrent())
        return; const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [state.pending, client]);
    const disabled = state.busy || state.suspended || !!state.pending;
    return <main className="companion-settings-page career-surface"><nav><a href="/">回到对话</a><a href="/me/mentors">真人服务</a><button type="button" onClick={onLogout}>退出登录</button></nav><section aria-labelledby="companion-settings-title"><h1 id="companion-settings-title">主理人</h1><h2>付费建议</h2><p>你来决定什么时候听到真人服务或付费项目的建议。免费帮助不受影响，你也可以主动查看真人服务。</p>
 {state.suspended && <p role="status">当前离线。连接恢复后会重新读取设置。</p>}{state.busy && <p role="status">正在确认设置…</p>}{state.error && <p role="alert">{state.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
 {state.loaded && state.settings && <form onSubmit={e => { e.preventDefault(); controller.begin(selected); }}><fieldset disabled={disabled}><legend>什么时候告诉你</legend>
 <label><input type="radio" name="paid-suggestions" value="when_relevant" checked={selected === 'when_relevant'} onChange={() => setDraft({ source: state.settings, choice: 'when_relevant' })}/><span>合适的时候告诉我<small>符合条件时，先给免费路径，再介绍真人能多帮什么。</small></span></label>
 <label><input type="radio" name="paid-suggestions" value="only_when_asked" checked={selected === 'only_when_asked'} onChange={() => setDraft({ source: state.settings, choice: 'only_when_asked' })}/><span>只在我问的时候<small>由我主动开启这类话题。</small></span></label>
 </fieldset>{state.settings.revision === 0 && <p className="settings-default">这是默认选项，尚未记录你的选择。</p>}<button type="submit" disabled={disabled}>保存选择</button></form>}
 <div className="companion-settings-actions"><button type="button" disabled={state.busy || state.suspended || !client.isCurrent()} onClick={() => void controller.refresh()}>重新读取</button>{state.pending && <><button type="button" disabled={state.busy || state.suspended} onClick={() => void controller.observe()}>核对这次保存</button><button type="button" disabled={state.busy || state.suspended} onClick={() => void controller.retry()}>用原操作重试</button></>}</div>
 </section><CompanionDailySettingsPanel /><TodayRestPanel /></main>;
}
