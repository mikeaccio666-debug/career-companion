import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoundPlatformClient } from './api';
import { CompanionWelcomeController, emptyWelcome } from './companion-welcome-controller';
import './companion-welcome-view.css';
export default function CompanionWelcomeView({ client, companionId, paused = false }: {
    client: BoundPlatformClient;
    companionId: string;
    paused?: boolean;
}) {
    const pause = useRef(paused);
    pause.current = paused;
    const [view, setView] = useState({ client, companionId, state: emptyWelcome() });
    const controller = useMemo(() => new CompanionWelcomeController(client, companionId, state => setView({ client, companionId, state }), () => pause.current), [client, companionId]);
    useEffect(() => {
        controller.start();
        const refresh = () => controller.refresh();
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('online', refresh);
        return () => { controller.stop(); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('online', refresh); };
    }, [controller]);
    useEffect(() => { controller.refresh(); }, [controller, paused]);
    if (!client.isCurrent())
        return null;
    const state = view.client === client && view.companionId === companionId ? view.state : emptyWelcome(), welcome = state.welcome, busy = state.loading || state.writing;
    return <section className="companion-welcome" aria-label="初见对话" aria-busy={busy}>
  {welcome && <><div className="companion-welcome-message"><span className="onboarding-ai">{welcome.intro.speaker.name} · AI 主理人</span><p>{welcome.intro.content}</p></div>
    {welcome.step === 'C1' && <div className="companion-welcome-choices"><button type="button" disabled={paused || busy || state.uncertain} onClick={() => controller.choose('begin')}>好</button>
      <button type="button" disabled={paused || busy || state.uncertain} onClick={() => controller.choose('direct_letter')}>直接写信吧</button></div>}
    {welcome.step === 'C2' && <p className="companion-welcome-progress" role="status">已记下：先聊聊你的处境。下一段对话正在接入。</p>}
    {welcome.step === 'C7' && <p className="companion-welcome-progress" role="status">已记下：用已有信息写第一封信。信件生成正在接入，第一封信还没有生成。</p>}
  </>}
  {!welcome && !state.error && <p className="companion-welcome-progress" role="status">{paused ? '初见暂时暂停，处理完上方事项后继续。' : '正在读取初见进度…'}</p>}
  {state.error && <p className="onboarding-notice" role="alert">{state.error}</p>}
  {state.uncertain && welcome?.step === 'C1' && <button className="onboarding-link" type="button" disabled={paused || busy} onClick={() => controller.retryChoice()}>用原来的选择重试</button>}
  {!welcome && state.error && <button className="onboarding-link" type="button" disabled={paused || busy} onClick={() => controller.retryOpen()}>继续初见</button>}
  {state.error && <button className="onboarding-link" type="button" disabled={busy} onClick={() => controller.refresh()}>重新读取初见进度</button>}
 </section>;
}
