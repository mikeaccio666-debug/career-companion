import { attachLocalePreference, previewLocaleStorage } from '../i18n/preference';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantApp } from '../app/AssistantApp';
import { createAssistantController } from '../app/controller';
import { initialAssistantState } from '../state/initial';
import { previewData, entitlementScenarios } from '../testing/fixtures';
import { createPreviewPorts } from '../testing/preview-ports';
import { HostPage } from './HostPage';
import { hostView } from './host-view';
import { createViewContext } from '../app/view-context';
import { panelDimensions } from '../shell/geometry';
import { THEME_VARS } from '../design/palette';
import type { Scene } from '../state/types';
import '../design/tokens.css';

const baseEntitlements = { ats: entitlementScenarios.ats.granted, jobs: entitlementScenarios.jobs.plenty, letters: entitlementScenarios.letters, chat: entitlementScenarios.chat, voice: entitlementScenarios.voice };
const fixture = createPreviewPorts();
const initial = (persona: 'out' | 'new' | 'connected') => initialAssistantState(previewData, { persona, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, entitlements: baseEntitlements });
const controller = createAssistantController(previewData, fixture.ports, initial('connected'));
const localePreference = attachLocalePreference(controller, previewLocaleStorage());
const labels: Record<Scene, string> = { welcome: '欢迎', home: '首页', chat: '资料对话', profile: '完整资料', deck: '岗位卡片', batchend: '本组结束', shortlist: '申请清单', preparing: '准备中', cover: '求职信', autofill: '填写演示' };

function Preview() {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const stage = useRef<HTMLDivElement>(null), [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight - 78 });
  const [persona, setPersona] = useState<'out' | 'new' | 'connected'>('connected');
  useEffect(() => { const observer = new ResizeObserver(entries => { const { width, height } = entries[0].contentRect; setViewport({ width, height }); }); if (stage.current) observer.observe(stage.current); return () => observer.disconnect(); }, []);
  const context = createViewContext(state, previewData, panelDimensions(state.scene, viewport));
  const events = { onInput: () => {}, onChange: () => {}, onStreamDone: () => {}, reduced: state.reduced, active: state.panelOpen };
  async function jump(scene: Scene) {
    if (scene === 'chat') { await controller.intake.start(); return; }
    if (scene === 'deck') { await controller.jobs.discover(true); return; }
    if (['shortlist', 'preparing', 'cover', 'autofill'].includes(scene) && !state.deck.selected.length) controller.ctx.patch(s => ({ ...s, deck: { ...s.deck, selected: previewData.jobs.slice(0, 3).map(j => j.id) } }));
    if (scene === 'preparing') { await controller.materials.prepare(); return; }
    if (scene === 'cover') controller.ctx.patch({ coverId: state.coverId || previewData.jobs[0].id });
    if (scene === 'autofill') { const id = previewData.jobs[0].id; controller.ctx.patch(s => ({ ...s, fillId: id, prep: { ...s.prep, [id]: 'ready' }, preparedResume: { ...s.preparedResume, [id]: s.resumeId } })); }
    await controller.ctx.go(scene); await controller.ctx.open();
  }
  return <div style={{ ...THEME_VARS, height: '100%', display: 'flex', flexDirection: 'column' }}>
    <header style={{ flex: '0 0 auto', minHeight: 78, padding: '10px 20px', borderBottom: '1px solid #DDE3EC', background: '#fff', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, fontSize: 12, zIndex: 100 }}>
      <div style={{ marginRight: 10 }}><b style={{ fontSize: 14 }}>ArgoLand.AI · React 预览</b><div style={{ color: '#6B778C', marginTop: 3 }}>Fable 实施 · 演示数据 · 本机预览</div></div>
      <label>身份 <select aria-label="预览身份" value={persona} onChange={e => { const value = e.target.value as typeof persona; setPersona(value); controller.reset(initial(value)); }}><option value="connected">已连接 · 有简历</option><option value="new">已连接 · 新用户</option><option value="out">未连接</option></select></label>
      <label>场景 <select aria-label="预览场景" value={state.scene} onChange={e => void jump(e.target.value as Scene)}>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>ATS <select aria-label="ATS 权益场景" defaultValue="granted" onChange={e => controller.ctx.patch(s => ({ ...s, entitlements: { ...s.entitlements, ats: structuredClone(entitlementScenarios.ats[e.target.value]) } }))}>{Object.keys(entitlementScenarios.ats).map(key => <option key={key}>{key}</option>)}</select></label>
      <label>岗位额度 <select aria-label="岗位额度场景" defaultValue="plenty" onChange={e => controller.ctx.patch(s => ({ ...s, entitlements: { ...s.entitlements, jobs: structuredClone(entitlementScenarios.jobs[e.target.value]) } }))}>{Object.keys(entitlementScenarios.jobs).map(key => <option key={key}>{key}</option>)}</select></label>
      <label>下一次故障 <select aria-label="下一次故障" defaultValue="" onChange={e => { const [method, code] = e.target.value.split(':'); if (method) fixture.failNext(method as Parameters<typeof fixture.failNext>[0], code as Parameters<typeof fixture.failNext>[1]); e.target.value = ''; }}><option value="">正常</option><option value="saveCandidate:SAVE_FAILED">保存失败</option><option value="saveCandidate:CONFLICT">保存冲突</option><option value="parseResume:PARSE_FAILED">解析失败</option><option value="score:UNAVAILABLE">评分失败</option><option value="prepare:UNAVAILABLE">准备失败</option><option value="transcribe:VOICE_DENIED">麦克风拒绝</option><option value="transcribe:VOICE_NO_DEVICE">没有麦克风</option><option value="transcribe:VOICE_UNCLEAR">转写不清晰</option><option value="generateLetter:UNAVAILABLE">生成失败</option><option value="run:PAGE_CHANGED">页面变化</option></select></label>
      <button onClick={() => void controller.dispatch('toggle-motion')}>{state.reduced ? '恢复动画' : '减少动画'}</button>
      <button onClick={() => controller.reset(initial(persona))}>重置</button>
      <button onClick={() => void controller.dispatch('toolbar-open')}>工具栏唤回</button>
    </header>
    <main ref={stage} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', background: '#EEF2F6' }}>
      <HostPage view={{ host: hostView(context) }} events={events}/>
      <AssistantApp controller={controller} viewport={viewport}/>
    </main>
  </div>;
}
const root = document.getElementById('root');
if (!root) throw new Error('ASSISTANT_PREVIEW_ROOT_MISSING');
createRoot(root).render(<Preview/>);
if (import.meta.hot) import.meta.hot.dispose(() => controller.dispose());
