import { attachLocalePreference, previewLocaleStorage } from '../../../i18n/preference';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantApp } from '../../../app/AssistantApp';
import { createAssistantController } from '../../../app/controller';
import { initialAssistantState } from '../../../state/initial';
import { createPreviewPorts } from '../../../testing/preview-ports';
import { previewData, entitlementScenarios } from '../../../testing/fixtures';
import { panelDimensions } from '../../../shell/geometry';
import '../../../design/tokens.css';

const ports = createPreviewPorts().ports;
const controller = createAssistantController(previewData, ports, initialAssistantState(previewData, { persona: 'connected', entitlements: { ats: entitlementScenarios.ats.granted, jobs: entitlementScenarios.jobs.plenty, letters: entitlementScenarios.letters, chat: entitlementScenarios.chat, voice: entitlementScenarios.voice } }));
const localePreference = attachLocalePreference(controller, previewLocaleStorage());
function Container() {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight }), [port, setPort] = useState<MessagePort | null>(null);
  useEffect(() => {
    let bound: MessagePort | null = null;
    const connect = (event: MessageEvent) => {
      if (bound || event.source !== parent || event.origin !== 'http://127.0.0.1:8871' || event.data?.type !== 'argo-lab-connect' || event.ports.length !== 1) return;
      bound = event.ports[0]; setPort(bound);
      bound.onmessage = incoming => { const v = incoming.data; if (v?.type === 'argo-lab-viewport' && Number.isFinite(v.width) && Number.isFinite(v.height) && v.width > 0 && v.height > 0 && v.width <= 16384 && v.height <= 16384) setViewport({ width: v.width, height: v.height }); };
    };
    window.addEventListener('message', connect); parent.postMessage({ type: 'argo-lab-ready' }, 'http://127.0.0.1:8871'); return () => { window.removeEventListener('message', connect); bound?.close(); localePreference.dispose(); controller.dispose(); };
  }, []);
  useEffect(() => {
    const dims = panelDimensions(state.scene, viewport);
    port?.postMessage({ type: 'argo-lab-layout', width: state.panelOpen ? dims.width + dims.margin * 2 : 100, height: state.panelOpen ? dims.height + dims.margin * 2 : Math.min(viewport.height, state.launcherTop + 110), open: state.panelOpen });
  }, [viewport, state.scene, state.panelOpen, state.launcherTop, port]);
  return <AssistantApp controller={controller} viewport={viewport}/>;
}
const root = document.getElementById('root'); if (!root) throw new Error('ASSISTANT_LAB_ROOT_MISSING');
createRoot(root).render(<Container/>);
