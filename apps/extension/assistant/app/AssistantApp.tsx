import { PrivateIntakeScene } from '../features/intake/PrivateIntakeScene';
import { RoleManager } from '../features/targets/RoleManager';
import { ProfileEditor } from '../features/profile/ProfileEditor';
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { AssistantController } from './controller';
import { createViewContext } from './view-context';
import { createAssistantView } from './view-model';
import { panelDimensions, boatRect, type Viewport } from '../shell/geometry';
import { createShellMotion } from '../shell/motion-controller';
import { THEME_VARS } from '../design/palette';
import { Boat } from '../shell/Boat';
import { useOverlayFocus } from '../shell/use-overlay-focus';
import { ShellHeader } from '../shell/ShellHeader';
import { Launcher } from '../shell/Launcher';
import { AssistantSheet } from '../shell/AssistantSheet';
import { AssistantModal } from '../shell/AssistantModal';
import { AssistantToast } from '../shell/AssistantToast';
import { WelcomeScene } from '../scenes/WelcomeScene';
import { HomeScene } from '../scenes/HomeScene';
import { ChatScene } from '../scenes/ChatScene';
import { ProfileScene } from '../scenes/ProfileScene';
import { DeckScene } from '../scenes/DeckScene';
import { BatchEndScene } from '../scenes/BatchEndScene';
import { ShortlistScene } from '../scenes/ShortlistScene';
import { PreparingScene } from '../scenes/PreparingScene';
import { CoverScene } from '../scenes/CoverScene';
import { AutofillScene } from '../scenes/AutofillScene';

const scenes = { welcome: WelcomeScene, home: HomeScene, chat: ChatScene, profile: ProfileScene, deck: DeckScene, batchend: BatchEndScene, shortlist: ShortlistScene, preparing: PreparingScene, cover: CoverScene, autofill: AutofillScene };
export function AssistantApp({ controller, viewport }: { controller: AssistantController; viewport: Viewport }) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const root = useRef<HTMLDivElement>(null), dimensions = useRef(viewport); dimensions.current = viewport;
  useOverlayFocus(root, state.modal ? 'modal' : state.sheet?.kind ?? null);
  const geometry = panelDimensions(state.scene, viewport), rect = boatRect(state.scene, geometry);
  const view = createAssistantView(createViewContext(state, controller.ctx.data, geometry));
  const events = useMemo(() => ({ onInput: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => controller.input(e.currentTarget), onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => controller.input(e.currentTarget), onStreamDone: controller.intake.streamDone, reduced: state.reduced, active: state.panelOpen }), [controller, state.reduced, state.panelOpen]);
  useLayoutEffect(() => { if (!root.current) return; controller.ctx.motion = createShellMotion(root.current, controller.ctx, () => dimensions.current); return () => { controller.ctx.motion = null; }; }, [controller]);
  useLayoutEffect(() => { controller.rendered(); });
  const Scene = scenes[state.scene];
  const drag = useRef<{ y: number; top: number; moved: boolean } | null>(null), suppress = useRef(false);
  return <div ref={root} lang={view.locale} className="argo-root" data-reduced={state.reduced ? 'true' : 'false'} style={{ ...THEME_VARS, position: 'absolute', inset: 0, pointerEvents: 'none' }}
    onClick={e => { const el = (e.target as Element).closest<HTMLElement>('[data-act]'); if (!el || !root.current?.contains(el)) return; if (suppress.current && el.dataset.act === 'launcher-open') { suppress.current = false; return; } void controller.dispatch(el.dataset.act ?? '', el.dataset.arg ?? ''); }}
    onKeyDown={e => { if (!/INPUT|TEXTAREA|SELECT/.test((e.target as Element).tagName) && state.scene === 'deck' && !state.sheet && !state.modal && ['ArrowLeft', 'ArrowRight', 'z', 'Z'].includes(e.key)) { e.preventDefault(); void controller.dispatch(e.key === 'ArrowRight' ? 'deck-accept' : e.key === 'ArrowLeft' ? 'deck-skip' : 'deck-undo'); return; } if (e.key === 'Escape') { e.stopPropagation(); void controller.dispatch(state.modal ? 'modal-action' : state.sheet ? 'sheet-close' : 'panel-close', 'noop'); } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.target as HTMLElement).hasAttribute('data-chat-input')) { e.preventDefault(); void controller.dispatch('chat-send'); } }}
    onPointerDown={e => { if (!(e.target as Element).closest('[data-act="launcher-open"]')) return; drag.current = { y: e.clientY, top: state.launcherTop, moved: false }; (e.target as Element).closest<HTMLElement>('[data-act="launcher-open"]')?.setPointerCapture(e.pointerId); }}
    onPointerMove={e => { if (!drag.current) return; const distance = e.clientY - drag.current.y; if (Math.abs(distance) > 5) drag.current.moved = true; if (drag.current.moved) controller.ctx.patch({ launcherTop: Math.max(12, Math.min(viewport.height - 100, drag.current.top + distance)) }); }}
    onPointerUp={() => { suppress.current = drag.current?.moved ?? false; drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    {view.launcher.visible && <div style={{ pointerEvents: 'auto' }}><Launcher view={view} events={events}/></div>}
    {view.launcher.hiddenNote && <div style={{ position: 'absolute', right: 20, bottom: 20, padding: '12px 16px', background: '#fff', borderRadius: 14, fontSize: 12 }}>{view.t('隐藏入口（从工具栏可唤回）')}</div>}
    <div data-panel="1" role="dialog" aria-label={view.t("ArgoLand.AI 求职助手")} inert={!state.panelOpen} style={{ pointerEvents: state.panelOpen ? 'auto' : 'none', visibility: state.panelOpen ? 'visible' : 'hidden', position: 'absolute', right: geometry.margin, bottom: geometry.margin, width: geometry.width, height: geometry.height, borderRadius: 28, background: 'linear-gradient(180deg,#FFFFFF 0%,#F7FAFD 100%)', boxShadow: '0 1px 1px rgba(10,17,40,.04),0 2px 6px rgba(10,17,40,.06),0 30px 70px -24px rgba(10,17,40,.35)', overflow: 'hidden', zIndex: 30, display: 'flex', flexDirection: 'column', outline: '1px solid rgba(255,255,255,.8)' }}>
      <Boat rect={rect} compact={state.scene !== 'welcome'} reduced={state.reduced} open={state.panelOpen}/>
      <select aria-label={view.t('语言')} value={view.locale} onChange={event => void controller.dispatch('set-locale', event.target.value)} style={{ position: 'absolute', right: 58, top: 17, zIndex: 21, maxWidth: 96, height: 28, border: '1px solid var(--argo-line)', borderRadius: 8, background: '#fff', color: 'var(--argo-muted)', fontSize: 11 }}>
        <option value="en-US">English</option><option value="zh-CN">简体中文</option>
      </select>
      <button data-act="panel-close" aria-label={view.t("收起 ArgoLand.AI")} className="argo-close" style={{ position: 'absolute', right: 14, top: 14, zIndex: 20, width: 34, height: 34, border: 0, borderRadius: '50%', background: 'rgba(10,17,40,.05)', color: '#4F5B73', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
      {view.ui.showHeader && <ShellHeader view={view} events={events}/>}
      {state.scene === 'chat' && state.intakeEnabled !== false && controller.ctx.ports.mode === 'connected' ? <PrivateIntakeScene controller={controller}/> : state.scene === 'profile' && state.profileEditor && state.profileEditingEnabled && state.session === 'connected' ? <ProfileEditor controller={controller}/> : <Scene key={`${controller.store.scope().epoch}-${state.scene}`} view={view} events={events}/>}
      {view.sheet.open && (state.sheet?.kind === 'targets' && state.roleManagementEnabled && state.session === 'connected' ? <RoleManager controller={controller}/> : <AssistantSheet view={view} events={events}/>)}
      {view.modal.open && <AssistantModal view={view} events={events}/>}
      {view.toast.show && <AssistantToast view={view} events={events}/>}
    </div>
  </div>;
}
