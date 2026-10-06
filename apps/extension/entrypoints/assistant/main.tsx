import { privateIntakeFeature } from '../../assistant/features/intake/feature';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantApp } from '../../assistant/app/AssistantApp';
import { createAssistantController } from '../../assistant/app/controller';
import { createSessionController } from '../../assistant/features/session/controller';
import { createReadOnlyPorts } from '../../assistant/features/session/read-only-ports';
import { acceptsLayoutConnection } from '../../assistant/runtime/layout-handshake';
import { createAssistantReadClient } from '../../assistant/runtime/client';
import { createPresentationData } from '../../assistant/presentation-data';
import { initialAssistantState } from '../../assistant/state/initial';
import { emptyProfile } from '../../assistant/features/session/read-model';
import { panelDimensions } from '../../assistant/shell/geometry';
import { resolveAssistantLocale } from '../../assistant/i18n';
import type { UiResult } from '../../assistant/ports/assistant-ports';
import type { ReadResult } from '../../assistant/features/session/read-ports';
import '../../assistant/design/tokens.css';

const data = { ...createPresentationData('en-US'), profile: emptyProfile(), jobs: [], resumeVersions: [] };
const result = (r: ReadResult<void>): UiResult<void> => r.ok ? r : { ok: false, code: r.code === 'CANCELLED' ? 'CANCELLED' : 'UNAVAILABLE' };
const clientCommerceExecute: import('../../assistant/features/commerce/ports').CommercePorts['execute'] = (command,signal) => client.commercePorts.execute(command,signal);
const intake = privateIntakeFeature(__VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED__, () => ({
  execute: (command, signal, onEvent) => client.privateIntakePorts.execute(command, signal, onEvent),
  record: (signal, transcript, state) => client.privateIntakePorts.record!(signal, transcript, state),
  stopRecording: () => client.privateIntakePorts.stopRecording?.(),
}));
const ui = createAssistantController(data, { ...createReadOnlyPorts({ login: async () => result(await session.login()),
  refresh: async () => result(await session.refresh()), logout: async () => result(await session.logout()) }),
    openBilling:async()=>result(await client.ports.openPortal(AbortSignal.timeout(12_000))),
    ...(__VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED__ ? { commerce: {execute:clientCommerceExecute}, autofill: {execute:(operation,selection,signal,reviewId)=>client.autofillPorts.execute(operation,selection,signal,reviewId)} } : {}),
    ...intake.ports,
    ...(__VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED__ ? { roles: { list: (cursor: string | null, signal: AbortSignal) => client.rolePorts.list(cursor, signal), create: (request: import('@edaix/contracts').CreateConversationRequest, signal: AbortSignal) => client.rolePorts.create(request, signal), read: (id: import('@edaix/contracts').Uuid, signal: AbortSignal) => client.rolePorts.read(id, signal), save: (id: import('@edaix/contracts').Uuid, patch: import('@edaix/contracts').RolePreferencesPatch, signal: AbortSignal) => client.rolePorts.save(id, patch, signal) } } : {}),
    ...(__VIBE_ASSISTANT_PROFILE_EDIT_ENABLED__ ? { profile: {
      save: (patch: import('@edaix/contracts').PatchCandidateProfileV2, signal: AbortSignal) => client.saveProfile(patch, signal),
      read: (signal: AbortSignal) => { const identity = session.currentIdentity(); return identity && client.ports.profileV2 ? client.ports.profileV2(identity, signal) : Promise.resolve({ ok: false as const, code: 'LOGIN_REQUIRED' as const }); },
    } } : {}) },
  { ...initialAssistantState(data, { persona: 'out', entitlements: { ats: { access: 'unavailable' }, jobs: { access: 'unavailable' },
    letters: { access: 'unavailable' }, chat: { access: 'unavailable' }, voice: { access: 'unavailable' } } }), intakeEnabled: intake.intakeEnabled, profileEditingEnabled: __VIBE_ASSISTANT_PROFILE_EDIT_ENABLED__, roleManagementEnabled: __VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED__ });
let fromWorker = false, previousLocale = resolveAssistantLocale(ui.ctx.state.locale);
const client = createAssistantReadClient({ invalidated: code => session.invalidate(code === 'OWNER_CHANGED' ? 'expired' : 'unavailable', { stage: 'CONNECTION', code }), locale: locale => {
  fromWorker = true; ui.ctx.patch({ locale }); fromWorker = false;
} }, { profileEditing: __VIBE_ASSISTANT_PROFILE_EDIT_ENABLED__, roleManagement: __VIBE_ASSISTANT_ROLE_MANAGEMENT_ENABLED__ });
const session = createSessionController(ui, client.ports);
ui.store.subscribe(() => {
  const locale = resolveAssistantLocale(ui.ctx.state.locale); document.documentElement.lang = locale;
  if (locale === previousLocale) return; previousLocale = locale;
  if (!fromWorker) void client.setLocale(locale).then(r => { if (!r.ok) ui.ctx.toast(ui.ctx.t('暂时无法完成此操作，请重试。')); });
});
function Container() {
  const state = useSyncExternalStore(ui.store.subscribe, ui.store.getSnapshot);
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });
  const [layout, setLayout] = useState<MessagePort | null>(null);
  useEffect(() => {
    let bound: MessagePort | null = null, disposed = false;
    let context: Awaited<ReturnType<typeof client.layoutContext>> = null;
    const connect = (event: MessageEvent) => {
      if (bound || !acceptsLayoutConnection(event, parent, context)) return;
      bound = event.ports[0]; setLayout(bound);
      bound.onmessage = incoming => {
        const v = incoming.data;
        if (v?.type === 'argo-lab-viewport' && Number.isFinite(v.width) && Number.isFinite(v.height) && v.width > 0 && v.height > 0 && v.width <= 16384 && v.height <= 16384) setViewport({ width: v.width, height: v.height });
        else if (v?.type === 'argo-lab-open') void ui.dispatch('toolbar-open');
      };
    };
    const refresh = () => { if (document.visibilityState === 'visible' && ui.ctx.state.panelOpen) void session.refresh(); };
    window.addEventListener('message', connect); document.addEventListener('visibilitychange', refresh);
    void client.layoutContext().then(value => {
      if (disposed || !value) return; context = value;
      parent.postMessage({ type: 'argo-lab-ready' }, value.origin);
    });
    void session.refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void session.verify(); }, 30_000);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('message', connect); document.removeEventListener('visibilitychange', refresh); bound?.close(); session.dispose(); client.dispose(); ui.dispose(); };
  }, []);
  useEffect(() => {
    const d = panelDimensions(state.scene, viewport);
    layout?.postMessage({ type: 'argo-lab-layout', width: state.panelOpen ? d.width + d.margin * 2 : 100,
      height: state.panelOpen ? d.height + d.margin * 2 : Math.min(viewport.height, state.launcherTop + 110), open: state.panelOpen });
  }, [state.scene, state.panelOpen, state.launcherTop, viewport, layout]);
  return <AssistantApp controller={ui} viewport={viewport}/>;
}
const root = document.getElementById('root'); if (!root) throw new Error('ASSISTANT_ROOT_MISSING');
createRoot(root).render(<Container/>);
