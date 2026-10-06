import { attachLocalePreference, previewLocaleStorage } from '../i18n/preference';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantApp } from '../app/AssistantApp';
import { createAssistantController } from '../app/controller';
import { createSessionController } from '../features/session/controller';
import { createReadOnlyPorts } from '../features/session/read-only-ports';
import { emptyProfile } from '../features/session/read-model';
import type { ReadResult } from '../features/session/read-ports';
import type { UiResult } from '../ports/assistant-ports';
import { initialAssistantState } from '../state/initial';
import { previewData } from '../testing/fixtures';
import { createSessionFixture } from '../testing/session-fixture';
import '../design/tokens.css';

const fixture = createSessionFixture();
// Reuse the presentation catalog; no demo jobs or saved facts enter this state.
const data = { ...previewData, profile: emptyProfile(), resumeVersions: [], jobs: [], sampleReports: undefined };
const result = (value: ReadResult<void>): UiResult<void> => value.ok ? value : { ok: false, code: value.code === 'CANCELLED' ? 'CANCELLED' : 'UNAVAILABLE' };
const ui = createAssistantController(data, createReadOnlyPorts({
  login: async () => result(await session.login()), refresh: async () => result(await session.refresh()), logout: async () => result(await session.logout()),
}), initialAssistantState(data, { persona: 'out', entitlements: { ats: { access: 'unavailable' }, jobs: { access: 'unavailable' },
  letters: { access: 'unavailable' }, chat: { access: 'unavailable' }, voice: { access: 'unavailable' } } }));
const localePreference = attachLocalePreference(ui, previewLocaleStorage());
const session = createSessionController(ui, fixture.ports);
session.invalidate('out');

function Preview() {
  const state = useSyncExternalStore(ui.store.subscribe, ui.store.getSnapshot);
  const stage = useRef<HTMLDivElement>(null), [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight - 130 });
  useEffect(() => {
    const observer = new ResizeObserver(entries => { const { width, height } = entries[0].contentRect; setViewport({ width, height }); });
    if (stage.current) observer.observe(stage.current);
    void session.refresh();
    return () => observer.disconnect();
  }, []);
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#0A1128' }}>
    <header style={{ padding: '16px 20px', background: 'white', borderBottom: '1px solid #DDE3EC', fontSize: 13 }}>
      <b>ArgoLand.AI · S2 连接状态验证</b>
      <p style={{ margin: '6px 0 12px', color: '#59677D' }}>虚构账号与服务响应，用于检查读取状态和账号切换；此页未连接真实后端。</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <label>测试账号 <select aria-label="测试账号" defaultValue="A" onChange={e => { session.invalidate('out'); fixture.account(e.target.value === 'out' ? null : e.target.value as 'A' | 'B'); void session.refresh(); }}><option value="A">测试账号 A</option><option value="B">测试账号 B</option><option value="out">未登录</option></select></label>
        <label>简历读取 <select aria-label="简历读取场景" defaultValue="normal" onChange={e => { fixture.scenario(e.target.value as Parameters<typeof fixture.scenario>[0]); void session.refresh(); }}>
          <option value="normal">正常</option><option value="empty">空简历库</option><option value="processing">解析中</option><option value="unavailable">服务不可用</option><option value="locked">未获准读取</option><option value="slow">延迟 4 秒</option>
        </select></label>
        <button onClick={() => session.invalidate('expired')}>模拟连接过期</button>
        <button onClick={() => void session.refresh()}>刷新连接</button>
        <button onClick={() => void ui.dispatch('open-profile')}>查看资料</button>
        <button onClick={() => void ui.dispatch('open-resume')}>查看简历</button>
        <button onClick={() => void ui.dispatch('toolbar-open')}>唤回面板</button>
      </div>
      <div role="status" style={{ marginTop: 8, color: '#59677D' }}>连接：{state.session} · 资料：{state.reads?.personal} · 简历：{state.reads?.resumes}</div>
    </header>
    <main ref={stage} style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: '#EEF2F6' }}>
      <section style={{ maxWidth: 540, margin: 40, lineHeight: 1.8 }}><h1 style={{ fontSize: 26 }}>先确认连接，再显示资料。</h1><p>切换账号时，面板会清除上一位用户的数据。解析中的简历、空简历库与服务故障分别显示。</p></section>
      <AssistantApp controller={ui} viewport={viewport}/>
    </main>
  </div>;
}
const root = document.getElementById('root'); if (!root) throw new Error('ASSISTANT_SESSION_PREVIEW_ROOT_MISSING');
createRoot(root).render(<Preview/>);
if (import.meta.hot) import.meta.hot.dispose(() => { localePreference.dispose(); session.dispose(); ui.dispose(); });
