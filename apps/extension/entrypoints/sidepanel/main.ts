import { probeExecutionPort } from '../../field-lab/adapters/executionAdapter';
import type { FieldLabStageSnapshot } from '../../field-lab/shell';
import {
  mountProductPanel,
  PRODUCT_PANEL_PROTOTYPE_MARKER,
  type ProductPanelIntentResult,
} from '../../product-panel/panel';
import { createProductPanelPrototypeAdapter } from '../../product-panel/prototypeAdapter';
import { createProductPanelUa5Adapter } from '../../product-panel/ua5Adapter';
import { createPilotUa5PanelRuntimeClient } from '../../connected-dev/panelRuntimeClient';
import { browser } from 'wxt/browser';
import '../../product-panel/style.css';

const root = document.querySelector<HTMLElement>('#app');

async function runDefaultOffProbe(): Promise<readonly FieldLabStageSnapshot[]> {
  const execution = await probeExecutionPort();

  return Object.freeze([
    Object.freeze({
      id: 'discovery' as const,
      state: 'HELD_DEFAULT_OFF',
      detail: 'Certified UA-1 semantic epochs only; no Field Lab page fixture',
    }),
    Object.freeze({
      id: 'compiler' as const,
      state: 'HELD_DEFAULT_OFF',
      detail: '#164 compiler remains inside the production UA-4 runtime',
    }),
    Object.freeze({
      id: 'classification' as const,
      state: 'HELD_DEFAULT_OFF',
      detail: 'Question classification remains inside the production UA-4 runtime',
    }),
    Object.freeze({
      id: 'writer' as const,
      state: execution.state,
      detail: execution.code + ' · zero host calls',
    }),
    Object.freeze({
      id: 'terminal' as const,
      state: 'NOT_MATERIALIZED',
      detail: 'Default-off returned before any terminal ledger',
    }),
  ]);
}

async function confirmDefaultOffBoundary(): Promise<ProductPanelIntentResult> {
  const snapshots = await runDefaultOffProbe();
  const writer = snapshots.find((snapshot) => snapshot.id === 'writer');
  const terminal = snapshots.find((snapshot) => snapshot.id === 'terminal');
  return writer?.state === 'CALLED_FAIL_CLOSED' && terminal?.state === 'NOT_MATERIALIZED'
    ? { ok: true }
    : { ok: false, code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE' };
}

if (root !== null && __VIBE_EXTENSION_FIELD_LAB_ENABLED__) {
  document.title = 'EdAIX Field Lab';
  root.dataset.prototypeMarker = PRODUCT_PANEL_PROTOTYPE_MARKER;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  mountProductPanel(
    root,
    createProductPanelPrototypeAdapter(confirmDefaultOffBoundary),
    { reducedMotion },
  );
} else if (root !== null && __VIBE_EXTENSION_CONNECTED_DEV_ENABLED__) {
  document.title = 'EdAIX Connected Lab';
  root.dataset.connectedDev = 'pilot-ua5/current-page';
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const client = createPilotUa5PanelRuntimeClient({
    runtime: browser.runtime,
  });
  const mount = mountProductPanel(
    root,
    createProductPanelUa5Adapter({
      probeReadiness: client.probeReadiness,
      runCurrentPage: client.runCurrentPage,
      undoCurrentPage: client.undoCurrentPage,
      recoverCurrentPage: client.recoverCurrentPage,
      getContinueOffer: client.getContinueOffer,
      continueReadOnly: client.continueReadOnly,
    }),
    { reducedMotion, presentation: 'CONNECTED' },
  );
  // The user pressed Autofill on the in-page panel. The worker checked that
  // gesture and armed its one-shot lease from it; the run itself lives here.
  browser.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { kind?: unknown } | null)?.kind !== 'pilot-ua5/dock-fill-requested') return;
    mount.startFromPageGesture();
  });
} else {
  document.documentElement.replaceChildren();
}
