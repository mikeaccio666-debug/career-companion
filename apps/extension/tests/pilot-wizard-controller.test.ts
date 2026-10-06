// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { syntheticWizardRuntime } from '../../../e2e/fixtures/t10-wizard-runtime';
import { createPilotWizardController } from '../lib/pilotWizardController';
import { createPilotUa1ContentRuntime, type PilotUa1LiveObservation } from '../lib/pilotUa1DiscoveryRuntime';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import { pilotUa5SemanticDigest } from '../lib/pilotUa5SemanticDigest';
const now = Date.parse('2026-09-06T00:00:00.000Z');
beforeEach(() => {
  history.replaceState(null, '', '/wizard');
  document.body.innerHTML = '<main id="application"><nav id="steps">' + [0, 1, 2].map((i) =>
    `<span id="step-${i}" aria-controls="panel-${i}"${i === 0 ? ' aria-current="step"' : ''}>Step</span>`).join('') +
    '</nav><section id="panel-0"><input value="User value"></section><section id="panel-1" hidden></section><section id="panel-2" hidden></section></main>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 30, width: 200, height: 30, toJSON: () => ({}) } as DOMRect);
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });
it.each([false, true])('keeps popup question accounting and exact options in a declared wizard (independent caption=%s)', async (independentCaption) => {
  document.getElementById('panel-0')!.innerHTML = '<input id="city" aria-label="City" role="combobox" aria-expanded="true" aria-controls="cities">' +
    `<ul id="cities" role="listbox"${independentCaption ? ' aria-label="Citizenship"' : ''}>` +
    '<li role="option">Remote</li><li role="option">On site</li></ul>';
  const source = await syntheticWizardRuntime(now);
  let epoch: object = {};
  const controller = createPilotWizardController({ document, view: window, location, now: () => now,
    readStoredRuntimeBundle: async () => source.stored, extensionVersion: () => '0.0.0', readAuthorityEpoch: () => epoch });
  const request = createPilotUa1DiscoveryRequest({ pageUrl: location.href, targetUrlDigest: pilotUa5SemanticDigest(location.href),
    requestId: '1'.repeat(32), issuedAtMs: now })!;
  const runtime = await controller.prepare({ schemaVersion: 1, scope: 'LOCAL_SESSION', sessionId: '2'.repeat(32),
    requestId: request.requestId, expiresAtMs: now + 30_000, authorization: source.authorization }, request, new AbortController().signal);
  expect(runtime).not.toBeNull();
  let live: PilotUa1LiveObservation | null = null;
  const observe = createPilotUa1ContentRuntime({ enabled: true, extensionId: 'test', expectedBackgroundUrl: 'chrome-extension://test/background.js',
    document, view: window, location, now: () => now, openShadowRoot: (element) => element.shadowRoot,
    wizardRuntime: runtime!, observeLive: (next) => { live = next; } });
  expect(await observe(request, { id: 'test', url: 'chrome-extension://test/background.js' }))
    .toEqual({ ok: true, detectedControlCount: independentCaption ? 4 : 1 });
  const observed = live as PilotUa1LiveObservation | null;
  expect(observed).not.toBeNull();
  const { packet, structure } = observed!.observation;
  expect(packet.observation.suppressedControls).toHaveLength(independentCaption ? 0 : 3);
  const trigger = packet.controls.find((control) => control.role === 'combobox')!;
  const identity = structure!.entries.find((entry) => entry.identityDigest === trigger.identityDigest)!;
  const options = observed!.registry.resolveOptionsForWrite(identity);
  expect(options?.container).toBe(document.getElementById('cities'));
  expect(options?.options.map((option) => option.element)).toEqual([...document.querySelectorAll('#cities [role="option"]')]);
  expect(controller.observe(observed!)).toBe(true);
  expect(controller.snapshot()).toMatchObject({ currentStep: { stepIndex: 0 }, checkpoints: [] });
  epoch = {};
  expect(controller.snapshot()).toBeNull();
  observed!.registry.dispose(); controller.reset();
});

it('binds the existing strict bundle reader to the sole UA-1 observation and clears on source epoch drift', async () => {
  const source = await syntheticWizardRuntime(now);
  let epoch: object = {};
  const controller = createPilotWizardController({ document, view: window, location, now: () => now,
    readStoredRuntimeBundle: async () => source.stored, extensionVersion: () => '0.0.0', readAuthorityEpoch: () => epoch });
  const request = createPilotUa1DiscoveryRequest({ pageUrl: location.href, targetUrlDigest: pilotUa5SemanticDigest(location.href),
    requestId: '1'.repeat(32), issuedAtMs: now })!;
  const context = { schemaVersion: 1, scope: 'LOCAL_SESSION', sessionId: '2'.repeat(32), requestId: request.requestId,
    expiresAtMs: now + 30_000, authorization: source.authorization } as const;
  const runtime = await controller.prepare(context, request, new AbortController().signal);
  expect(runtime).not.toBeNull();
  let live: PilotUa1LiveObservation | null = null;
  const observe = createPilotUa1ContentRuntime({ enabled: true, extensionId: 'test', expectedBackgroundUrl: 'chrome-extension://test/background.js',
    document, view: window, location, now: () => now, openShadowRoot: (element) => element.shadowRoot,
    wizardRuntime: runtime!, observeLive: (next) => { live = next; } });
  expect(await observe(request, { id: 'test', url: 'chrome-extension://test/background.js' })).toEqual({ ok: true, detectedControlCount: 1 });
  expect(controller.observe(live!)).toBe(true);
  expect(controller.snapshot()).toMatchObject({ schemaVersion: 1, scope: 'LOCAL_SESSION', currentStep: { stepIndex: 0 }, checkpoints: [] });
  expect(controller.record(live!, { ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' })).toBe(false);
  expect(controller.observe({ ...live! })).toBe(false);
  epoch = {};
  expect(controller.snapshot()).toBeNull();
  live!.registry.dispose(); controller.reset();
});
it('rejects missing, stale and mismatched source contexts before exposing a wizard identity', async () => {
  const source = await syntheticWizardRuntime(now), epoch = {};
  const controller = createPilotWizardController({ document, view: window, location, now: () => now,
    readStoredRuntimeBundle: async () => source.stored, extensionVersion: () => '0.0.0', readAuthorityEpoch: () => epoch });
  const request = createPilotUa1DiscoveryRequest({ pageUrl: location.href, targetUrlDigest: pilotUa5SemanticDigest(location.href),
    requestId: '1'.repeat(32), issuedAtMs: now })!;
  const context = { schemaVersion: 1, scope: 'LOCAL_SESSION', sessionId: '2'.repeat(32), requestId: request.requestId,
    expiresAtMs: now + 30_000, authorization: source.authorization };
  for (const candidate of [null, { ...context, expiresAtMs: now }, { ...context, requestId: '3'.repeat(32) },
    { ...context, authorization: { ...source.authorization, rulesetDigest: `sha256:${'e'.repeat(64)}` } }]) {
    expect(await controller.prepare(candidate, request, new AbortController().signal)).toBeNull();
  }
  expect(controller.snapshot()).toBeNull(); controller.reset();
});
