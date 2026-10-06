// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPilotUa5PanelRuntimeClient } from '../connected-dev/panelRuntimeClient';
import { createProductPanelUa5Adapter } from '../product-panel/ua5Adapter';
import { mountProductPanel } from '../product-panel/panel';
import { respondingPort } from './connectedPorts';

const RUN = 'a'.repeat(32), INTENT = 'b'.repeat(32);
const scan = Object.freeze({ schemaVersion: 1 as const, observedControls: 3, hiddenNotObservedCount: 2,
  unobservedRegions: 1, structureAvailable: true, pageIdentity: 'UNVERIFIED' as const });
const projection = Object.freeze({ schemaVersion: 2 as const,
  binding: { origin: 'https://job-boards.greenhouse.io', pathname: '/team/jobs/42', domGeneration: 'a'.repeat(64) },
  discoveryComplete: true, rows: [{ questionId: 'field-old', required: true, state: 'PREFILLED' as const, reason: null }],
  unobservedRegions: [], summary: { observableQuestions: 1, requiredQuestions: 1, requiredCompleted: 1, terminalQuestions: 1, unobservedRegions: 0 } });
async function drain() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
afterEach(() => document.body.replaceChildren());

describe('connected read-only Continue presentation', () => {
  it('shows verified local step history across the real runtime client and a later read-only step', async () => {
    const wizard = { schemaVersion: 1, scope: 'LOCAL_SESSION', sessionDigest: 'c'.repeat(64), currentStep: null,
      checkpoints: [{ stepIndex: 0, identityDigest: 'd'.repeat(64), discoveryComplete: true,
        requiredDispositions: [{ questionId: 'field-old', disposition: { state: 'PREFILLED', semanticReadback: 'CURRENT' } }], unobservedRegions: [] }] };
    let n = 0;
    const client = createPilotUa5PanelRuntimeClient({ requestId: () => n++ === 0 ? RUN : String(n).repeat(32),
      runtime: { connect: () => respondingPort((message, emit) => {
        const request = message as { kind: string; requestId: string };
        const base = { version: 2, requestId: request.requestId, runRequestId: RUN };
        if (request.kind === 'pilot-ua5/start-current-page') emit({ kind: 'pilot-ua5/wizard-result', version: 2, requestId: RUN, result: { ok: true, projection }, wizard });
        if (request.kind === 'pilot-ua5/get-continue-offer') emit({ ...base, kind: 'pilot-ua5/continue-offer', offer: { intentId: INTENT, expiresAtMs: Date.now() + 30_000 } });
        if (request.kind === 'pilot-ua5/continue-read-only') emit({ ...base, kind: 'pilot-ua5/wizard-rescan-result', result: { ok: true, scan,
          wizard: { ...wizard, currentStep: { stepIndex: 1, identityDigest: 'e'.repeat(64) } } } });
      }) } });
    const adapter = createProductPanelUa5Adapter({ runCurrentPage: client.runCurrentPage, getContinueOffer: client.getContinueOffer,
      continueReadOnly: client.continueReadOnly, probeReadiness: async () => 'READY' });
    const root = document.createElement('div'); document.body.append(root);
    const mounted = mountProductPanel(root, adapter, { presentation: 'CONNECTED', reducedMotion: true, testOnlyIsTrustedUserAction: () => true });
    await adapter.requestStartAutofill({ kind: 'START_AUTOFILL' }); await drain();
    expect(root.textContent).toContain('Local step history');
    expect(root.textContent).toContain('Step 1');
    expect(root.textContent).not.toContain('100%');
    root.querySelector<HTMLButtonElement>('[data-action="continue-next-page"]')!.click(); await drain();
    expect(root.textContent).toContain('Scanned step 2');
    expect(root.textContent).toContain('Step 1');
    expect(root.textContent).not.toContain('Page identity unverified');
    expect(root.textContent).toContain('current-step completion unknown');
    expect(root.textContent).toContain('2 hidden controls not observed');
    root.querySelector<HTMLButtonElement>('[data-action="collapse-autofill"]')!.click();
    expect(root.querySelector('.pp-sticky-summary')?.textContent).not.toContain('100%');
    expect(root.querySelector('.pp-sticky-summary')?.textContent).toContain('Scanned step 2');
    mounted.destroy();
  });
  it('uses private canonical run correlation and consumes the offer once', async () => {
    const sent: unknown[] = [];
    let n = 0;
    const client = createPilotUa5PanelRuntimeClient({ requestId: () => n++ === 0 ? RUN : String(n).repeat(32),
      runtime: { connect: () => respondingPort((message, emit) => {
        sent.push(message);
        const request = message as { kind: string; requestId: string };
        const base = { version: 2, requestId: request.requestId, runRequestId: RUN };
        if (request.kind === 'pilot-ua5/start-current-page') emit({ kind: 'pilot-ua5/result', version: 2, requestId: RUN, result: { ok: true, projection } });
        if (request.kind === 'pilot-ua5/get-continue-offer') emit({ ...base, kind: 'pilot-ua5/continue-offer', offer: { intentId: INTENT, expiresAtMs: Date.now() + 30_000 } });
        if (request.kind === 'pilot-ua5/continue-read-only') emit({ ...base, kind: 'pilot-ua5/rescan-result', result: { ok: true, scan } });
      }) } });
    expect(await client.getContinueOffer()).toBeNull();
    await client.runCurrentPage(() => {});
    expect(await client.getContinueOffer()).toMatchObject({ intentId: INTENT });
    expect(await client.continueReadOnly(INTENT)).toEqual({ ok: true, scan });
    expect(await client.continueReadOnly(INTENT)).toMatchObject({ ok: false });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ runRequestId: RUN, intentId: INTENT });
  });

  it.each([false, true])('requires a trusted click and keeps prior completion as history (trusted=%s)', async (trusted) => {
    let finish!: (value: { ok: true; scan: typeof scan }) => void;
    const continueReadOnly = vi.fn(() => new Promise<{ ok: true; scan: typeof scan }>((resolve) => { finish = resolve; }));
    const runCurrentPage = vi.fn(async () => ({ ok: true as const, projection }));
    const adapter = createProductPanelUa5Adapter({ probeReadiness: async () => 'READY', runCurrentPage,
      getContinueOffer: async () => ({ intentId: INTENT, expiresAtMs: Date.now() + 30_000 }), continueReadOnly });
    const root = document.createElement('div'); document.body.append(root);
    const mounted = mountProductPanel(root, adapter, { presentation: 'CONNECTED', reducedMotion: true, testOnlyIsTrustedUserAction: () => trusted });
    await adapter.requestStartAutofill({ kind: 'START_AUTOFILL' }); await drain();
    const button = root.querySelector<HTMLButtonElement>('[data-action="continue-next-page"]');
    expect(button).not.toBeNull(); button!.click(); button!.click(); await drain();
    if (!trusted) { expect(continueReadOnly).not.toHaveBeenCalled(); mounted.destroy(); return; }
    expect(continueReadOnly).toHaveBeenCalledOnce();
    expect(root.textContent).toContain('Scanning the current page');
    finish({ ok: true, scan }); await drain();
    expect(root.textContent).toContain('3 controls observed');
    expect(root.textContent).toContain('2 hidden controls not observed');
    expect(root.textContent).toContain('Page identity unverified');
    expect(root.textContent).toContain('Previous run');
    expect(root.querySelector('[data-action="continue-next-page"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-action="collapse-autofill"]')!.click();
    expect(root.querySelector('.pp-sticky-summary')?.textContent).not.toContain('100%');
    expect(runCurrentPage).toHaveBeenCalledOnce(); mounted.destroy();
  });
});
