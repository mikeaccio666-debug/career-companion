// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scanPilotUa1Discovery } from '@edaix/apply-kernel/pilotUa1Discovery';
import { parseWizardReadOnlyDeclaration } from '@edaix/apply-kernel/wizardIdentity';
import {
  parsePilotUa1DiscoveryPacket,
  type PilotUa1DiscoveryPacket,
} from '@edaix/contracts/draft';
import {
  createPilotUa1DiscoveryRequest,
  parsePilotUa1DiscoveryRequest,
  parsePilotUa1DiscoveryRuntimeResponse,
} from '../lib/pilotUa1DiscoveryProtocol';
import {
  createPilotUa1ContentRuntime,
  readPilotUa1DeclaredWizard,
  installPilotUa1ActionTrigger,
  installPilotUa1ContentTrigger,
  type PilotUa1LiveObservation,
  type PilotUa1RuntimeMessageApi,
} from '../lib/pilotUa1DiscoveryRuntime';

const EXTENSION_ID = 'ua1-test-extension';
const BACKGROUND_URL = `chrome-extension://${EXTENSION_ID}/background.js`;
const BACKGROUND_SENDER = Object.freeze({ id: EXTENSION_ID, url: BACKGROUND_URL });
const NOW = 10_000;
const LIFECYCLE_NONCE = '11'.repeat(16);

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
}

async function requestForCurrentPage(
  patch: Partial<ReturnType<typeof createPilotUa1DiscoveryRequest> extends infer T
    ? Exclude<T, null>
    : never> = {},
) {
  const targetUrlDigest = await digest(new URL(location.href).href);
  const request = createPilotUa1DiscoveryRequest({
    pageUrl: location.href,
    requestId: '22'.repeat(16),
    issuedAtMs: NOW,
    targetUrlDigest,
  });
  if (request === null) throw new Error('test request did not parse');
  return { ...request, ...patch };
}

type ContentRuntimeInput = Parameters<typeof createPilotUa1ContentRuntime>[0];

function contentRuntime(overrides: Partial<ContentRuntimeInput> = {}) {
  return createPilotUa1ContentRuntime({
    enabled: true,
    extensionId: EXTENSION_ID,
    expectedBackgroundUrl: BACKGROUND_URL,
    document,
    view: window,
    location,
    now: () => NOW,
    lifecycleNonce: LIFECYCLE_NONCE,
    openShadowRoot: (element) => element.shadowRoot,
    ...overrides,
  });
}

function positiveRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 160,
    height: 24,
    top: 0,
    right: 160,
    bottom: 24,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function exactTabReadback(url: string, status = 'complete') {
  return vi.fn(async (tabId: number) => ({ id: tabId, url, status }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/jobs/ua1?step=1#form');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(positiveRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('optional declared wizard capture within one UA-1 observation', () => {
  it('refuses a copied runtime handle without falling back to a syntax-only declaration', async () => {
    const wizardDeclaration = wizardFixture();
    let live: PilotUa1LiveObservation | null = null;
    const response = await contentRuntime({ wizardDeclaration,
      wizardRuntime: Object.freeze({ scope: 'LOCAL_SESSION', rulesetDigest: `sha256:${'a'.repeat(64)}`, runtimeBundleVersion: `rb1_${'b'.repeat(64)}` }),
      observeLive: (next) => { live = next; },
    })(await requestForCurrentPage(), BACKGROUND_SENDER);
    expect(response.ok).toBe(true);
    expect(readPilotUa1DeclaredWizard(live!)).toBeNull();
    live!.registry.dispose();
  });
  function wizardFixture() {
    document.body.innerHTML = '<main id="application"><nav id="steps">' +
      '<span id="step-one" aria-current="step" aria-controls="panel-one">One</span>' +
      '<span id="step-two" aria-controls="panel-two">Two</span></nav>' +
      '<section id="panel-one"><label for="name">First name</label><input id="name" value="User value"></section>' +
      '<section id="panel-two" hidden></section></main>';
    const parsed = parseWizardReadOnlyDeclaration({
      schemaVersion: 1, wizardKey: 'test-application', applicationRootSelector: '#application',
      indicatorContainerSelector: '#steps', steps: [
        { stepKey: 'one', indicatorSelector: '#step-one' },
        { stepKey: 'two', indicatorSelector: '#step-two' },
      ],
    });
    if (!parsed.ok) throw new Error('invalid fixture');
    return parsed.value;
  }

  it('captures the declared step after a stable interval without changing the old packet/response or user value', async () => {
    const wizardDeclaration = wizardFixture();
    let live: PilotUa1LiveObservation | null = null;
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const started = performance.now();
    const response = await contentRuntime({ wizardDeclaration, observeLive: (next) => { live = next; } })(
      await requestForCurrentPage(), BACKGROUND_SENDER,
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(440);
    expect(response).toEqual({ ok: true, detectedControlCount: 1 });
    expect(parsePilotUa1DiscoveryPacket(live!.observation.packet).ok).toBe(true);
    expect(Object.keys(live!.observation)).toEqual(['packet', 'structure']);
    expect(live!.declaredWizard?.step.stepKey).toBe('one');
    expect(live!.declaredWizard?.isCurrent()).toBe(true);
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('User value');
    expect(click).not.toHaveBeenCalled();
    live!.registry.dispose();
    expect(live!.declaredWizard?.isCurrent()).toBe(false);
  });

  it('keeps existing single-page observations unchanged when no declaration is supplied', async () => {
    wizardFixture();
    let live: PilotUa1LiveObservation | null = null;
    await contentRuntime({ observeLive: (next) => { live = next; } })(await requestForCurrentPage(), BACKGROUND_SENDER);
    expect(live).not.toHaveProperty('declaredWizard');
    live!.registry.dispose();
  });

  it('returns no wizard identity for an ambiguous declaration while retaining ordinary discovery', async () => {
    const wizardDeclaration = wizardFixture();
    document.getElementById('step-two')!.setAttribute('aria-current', 'step');
    let live: PilotUa1LiveObservation | null = null;
    const response = await contentRuntime({ wizardDeclaration, observeLive: (next) => { live = next; } })(
      await requestForCurrentPage(), BACKGROUND_SENDER,
    );
    expect(response.ok).toBe(true);
    expect(live!.declaredWizard).toBeNull();
    live!.registry.dispose();
  });

  it('rejects a transient step change even when the host restores the same final nodes and attributes', async () => {
    const wizardDeclaration = wizardFixture();
    const observeLive = vi.fn();
    const request = await requestForCurrentPage();
    const response = contentRuntime({ wizardDeclaration, observeLive })(request, BACKGROUND_SENDER);
    const timer = setTimeout(() => {
      const step = document.getElementById('step-one')!;
      step.setAttribute('aria-current', 'false');
      step.setAttribute('aria-current', 'step');
    }, 80);
    expect(await response).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    clearTimeout(timer);
    expect(observeLive).not.toHaveBeenCalled();
  });

  it.each(['panel replacement', 'hidden panel', 'history drift'])(
    'invalidates the live declared step after %s', async (change) => {
      const wizardDeclaration = wizardFixture();
      let live: PilotUa1LiveObservation | null = null;
      await contentRuntime({ wizardDeclaration, observeLive: (next) => { live = next; } })(
        await requestForCurrentPage(), BACKGROUND_SENDER,
      );
      const panel = document.getElementById('panel-one')!;
      if (change === 'panel replacement') panel.replaceWith(panel.cloneNode(true));
      if (change === 'hidden panel') panel.setAttribute('hidden', '');
      if (change === 'history drift') history.replaceState(null, '', '/jobs/ua1?step=2');
      expect(live!.declaredWizard?.isCurrent()).toBe(false);
      live!.registry.dispose();
    },
  );

  it('invalidates CSSOM-only visibility drift and stays invalid after a new authenticated attempt', async () => {
    const wizardDeclaration = wizardFixture();
    let live: PilotUa1LiveObservation | null = null;
    const handle = contentRuntime({ wizardDeclaration, observeLive: (next) => { live = next; } });
    expect(await handle(await requestForCurrentPage(), BACKGROUND_SENDER)).toEqual({ ok: true, detectedControlCount: 1 });
    const first = live!;
    const nativeStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = nativeStyle(element, pseudo);
      return element.id !== 'panel-one' ? style : new Proxy(style, {
        get(target, key, receiver) { return key === 'display' ? 'none' : Reflect.get(target, key, receiver); },
      });
    });
    expect(first.declaredWizard?.isCurrent()).toBe(false);
    vi.restoreAllMocks();
    // A new request owns a new generation even when it cannot capture the old one.
    await handle(await requestForCurrentPage({ requestId: '33'.repeat(16) }), BACKGROUND_SENDER);
    expect(first.declaredWizard?.isCurrent()).toBe(false);
    live!.registry.dispose();
  });

  it('retires declared evidence when its discovery request expires or its clock moves backwards', async () => {
    const wizardDeclaration = wizardFixture();
    let time = NOW;
    let live: PilotUa1LiveObservation | null = null;
    const request = await requestForCurrentPage();
    const handle = contentRuntime({ wizardDeclaration, now: () => time, observeLive: (next) => { live = next; } });
    await handle(request, BACKGROUND_SENDER);
    time = request.expiresAtMs + 1;
    expect(live!.declaredWizard?.isCurrent()).toBe(false);
    time = NOW;
    expect(live!.declaredWizard?.isCurrent()).toBe(false);
    await handle(await requestForCurrentPage({ requestId: '44'.repeat(16) }), BACKGROUND_SENDER);
    time = NOW - 1;
    expect(live!.declaredWizard?.isCurrent()).toBe(false);
    live!.registry.dispose();
  });

  it.each(['pagehide', 'popstate'])('rejects %s during the stable interval', async (name) => {
    const wizardDeclaration = wizardFixture(), observeLive = vi.fn();
    const request = await requestForCurrentPage();
    const pending = contentRuntime({ wizardDeclaration, observeLive })(request, BACKGROUND_SENDER);
    const timer = setTimeout(() => window.dispatchEvent(new Event(name)), 80);
    expect(await pending).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    clearTimeout(timer);
    expect(observeLive).not.toHaveBeenCalled();
  });

  it('rejects publication if the observation sink replaces the declared panel', async () => {
    const wizardDeclaration = wizardFixture(), observeLive = vi.fn();
    const response = await contentRuntime({
      wizardDeclaration, observeLive,
      observe: () => {
        const panel = document.getElementById('panel-one')!;
        panel.replaceWith(panel.cloneNode(true));
      },
    })(await requestForCurrentPage(), BACKGROUND_SENDER);
    expect(response).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    expect(observeLive).not.toHaveBeenCalled();
  });
});

describe('strict internal trigger protocol', () => {
  it('rejects overlong/noncanonical targets, credentials, unknown fields, and hostile objects', async () => {
    const valid = await requestForCurrentPage();
    expect(parsePilotUa1DiscoveryRequest(valid)).not.toBeNull();
    expect(parsePilotUa1DiscoveryRequest({ ...valid, targetPathname: `/${'a'.repeat(2_048)}` }))
      .toBeNull();
    expect(parsePilotUa1DiscoveryRequest({ ...valid, targetPathname: '//jobs' })).toBeNull();
    expect(parsePilotUa1DiscoveryRequest({ ...valid, targetPathname: '/jobs/%2e%2e/admin' }))
      .toBeNull();
    expect(parsePilotUa1DiscoveryRequest({ ...valid, targetOrigin: `https://${'a'.repeat(244)}.test` }))
      .toBeNull();
    expect(parsePilotUa1DiscoveryRequest({ ...valid, extra: 'not-a-covert-channel' })).toBeNull();
    expect(createPilotUa1DiscoveryRequest({
      pageUrl: 'https://user:secret@example.test/jobs',
      requestId: valid.requestId,
      issuedAtMs: NOW,
      targetUrlDigest: valid.targetUrlDigest,
    })).toBeNull();

    let getterCalls = 0;
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'kind', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return valid.kind;
      },
    });
    expect(parsePilotUa1DiscoveryRequest(accessor)).toBeNull();
    expect(getterCalls, 'strict decode invoked a hostile request accessor').toBe(0);
    expect(parsePilotUa1DiscoveryRequest(new Proxy({}, {
      ownKeys() {
        throw new Error('hostile proxy');
      },
    }))).toBeNull();
  });

  it('accepts only bounded count/stable-code responses without invoking accessors', () => {
    expect(parsePilotUa1DiscoveryRuntimeResponse({ ok: true, detectedControlCount: 64 }))
      .toEqual({ ok: true, detectedControlCount: 64 });
    expect(parsePilotUa1DiscoveryRuntimeResponse({ ok: true, detectedControlCount: 65 }))
      .toBeNull();
    expect(parsePilotUa1DiscoveryRuntimeResponse({
      ok: false,
      code: 'PILOT_TARGET_DRIFT',
      packet: 'forbidden',
    })).toBeNull();
    let calls = 0;
    const hostile = { ok: true } as Record<string, unknown>;
    Object.defineProperty(hostile, 'detectedControlCount', {
      enumerable: true,
      get() {
        calls += 1;
        return 1;
      },
    });
    expect(parsePilotUa1DiscoveryRuntimeResponse(hostile)).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('content-local exact Element registry', () => {
  it('binds one digest/token pair to the exact scanned Element without widening the wire response', async () => {
    document.body.innerHTML = '<label for="email">Email</label><input id="email" type="email">';
    const target = document.querySelector<HTMLInputElement>('#email')!;
    let live: PilotUa1LiveObservation | null = null;
    const response = await contentRuntime({
      observeLive: (observation) => { live = observation; },
    })(await requestForCurrentPage(), BACKGROUND_SENDER);

    expect(response).toEqual({ ok: true, detectedControlCount: 1 });
    expect(JSON.stringify(response)).toBe('{"ok":true,"detectedControlCount":1}');
    expect(live).not.toBeNull();
    const packetControl = live!.observation.packet.controls[0]!;
    const sidecarControl = live!.observation.structure!.entries[0]!;
    expect(live!.registry.resolve({
      identityDigest: packetControl.identityDigest,
      elementToken: sidecarControl.elementToken,
    })).toBe(target);
    expect(live!.registry.resolve({
      identityDigest: packetControl.identityDigest,
      elementToken: '0'.repeat(64),
    })).toBeNull();
    expect(live!.registry.resolveForWrite({
      identityDigest: packetControl.identityDigest,
      elementToken: sidecarControl.elementToken,
    })).toBe(target);
  });

  it('fails fresh write resolution on CSSOM-only visibility drift', async () => {
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    let cssomHidden = false;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudoElement) => {
      const computed = nativeGetComputedStyle(element, pseudoElement);
      if (!cssomHidden || element.id !== 'email') return computed;
      return new Proxy(computed, {
        get(target, property, receiver) {
          return property === 'display' ? 'none' : Reflect.get(target, property, receiver);
        },
      });
    });
    document.body.innerHTML = [
      '<style id="host-rules"></style>',
      '<label for="email">Email</label><input id="email" type="email">',
    ].join('');
    let live: PilotUa1LiveObservation | null = null;
    await contentRuntime({ observeLive: (observation) => { live = observation; } })(
      await requestForCurrentPage(),
      BACKGROUND_SENDER,
    );
    const control = live!.observation.packet.controls[0]!;
    const entry = live!.observation.structure!.entries[0]!;
    const style = document.querySelector<HTMLStyleElement>('#host-rules')!;

    // CSSStyleSheet mutations do not enqueue a DOM MutationRecord.
    style.sheet!.insertRule('#email { display: none; }');
    // happy-dom does not recalculate inserted CSSOM rules, so this switch
    // supplies the computed result a real browser returns without creating a
    // DOM mutation. The production path still calls native getComputedStyle.
    cssomHidden = true;

    expect(live!.registry.resolveForWrite({
      identityDigest: control.identityDigest,
      elementToken: entry.elementToken,
    })).toBeNull();
    expect(live!.registry.isCurrent()).toBe(false);
  });

  it('fails fresh write resolution when geometry turns the exact control into a honeypot', async () => {
    document.body.innerHTML = '<label for="email">Email</label><input id="email" type="email">';
    let live: PilotUa1LiveObservation | null = null;
    await contentRuntime({ observeLive: (observation) => { live = observation; } })(
      await requestForCurrentPage(),
      BACKGROUND_SENDER,
    );
    const control = live!.observation.packet.controls[0]!;
    const entry = live!.observation.structure!.entries[0]!;
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(() => ({
      ...positiveRect(), width: 1, height: 1, right: 1,
    }) as DOMRect);

    expect(live!.registry.resolveForWrite({
      identityDigest: control.identityDigest,
      elementToken: entry.elementToken,
    })).toBeNull();
    expect(live!.registry.isCurrent()).toBe(false);
  });

  it('fails currentness on same-address replacement, detach/reattach and navigation drift', async () => {
    document.body.innerHTML = '<label for="field">Field</label><input id="field">';
    let first: PilotUa1LiveObservation | null = null;
    const firstRuntime = contentRuntime({
      observeLive: (observation) => { first = observation; },
    });
    await firstRuntime(await requestForCurrentPage(), BACKGROUND_SENDER);
    const original = document.querySelector<HTMLInputElement>('#field')!;
    const member = first!.observation.structure!.entries[0]!;
    const identityDigest = first!.observation.packet.controls[0]!.identityDigest;
    original.replaceWith(original.cloneNode() as HTMLInputElement);
    expect(first!.registry.isCurrent()).toBe(false);
    expect(first!.registry.resolve({ identityDigest, elementToken: member.elementToken })).toBeNull();

    document.body.innerHTML = '<label for="second">Second</label><input id="second">';
    let second: PilotUa1LiveObservation | null = null;
    await contentRuntime({ observeLive: (observation) => { second = observation; } })(
      await requestForCurrentPage({ requestId: '34'.repeat(16) }),
      BACKGROUND_SENDER,
    );
    const secondTarget = document.querySelector<HTMLInputElement>('#second')!;
    secondTarget.remove();
    document.body.append(secondTarget);
    expect(second!.registry.isCurrent()).toBe(false);

    document.body.innerHTML = '<label for="third">Third</label><input id="third">';
    let third: PilotUa1LiveObservation | null = null;
    await contentRuntime({ observeLive: (observation) => { third = observation; } })(
      await requestForCurrentPage({ requestId: '35'.repeat(16) }),
      BACKGROUND_SENDER,
    );
    history.replaceState(null, '', '/jobs/ua1?step=2#form');
    expect(third!.registry.isCurrent()).toBe(false);
  });

  it('retires a previous live registry before publishing a newer generation', async () => {
    document.body.innerHTML = '<label for="field">Field</label><input id="field">';
    const seen: PilotUa1LiveObservation[] = [];
    const handle = contentRuntime({ observeLive: (observation) => seen.push(observation) });
    await handle(await requestForCurrentPage(), BACKGROUND_SENDER);
    await handle(
      await requestForCurrentPage({ requestId: '36'.repeat(16) }),
      BACKGROUND_SENDER,
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]!.registry.isCurrent()).toBe(false);
    expect(seen[1]!.registry.isCurrent()).toBe(true);
  });
});

describe('browser-action is the sole request producer', () => {
  it('stays inert when disabled and sends an enabled click only to exact tab frame 0', async () => {
    let click: ((tab: { id?: number; url?: string }) => void) | undefined;
    const addListener = vi.fn((listener) => {
      click = listener;
    });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, detectedControlCount: 0 });
    const setBadgeText = vi.fn();
    const setTitle = vi.fn();
    const addTabUpdatedListener = vi.fn();
    const action = { onClicked: { addListener }, setBadgeText, setTitle };
    const tabs = {
      onUpdated: { addListener: addTabUpdatedListener },
      onRemoved: { addListener: vi.fn() },
      get: exactTabReadback('https://careers.example.test/jobs/1?step=2#questions'),
      sendMessage,
    };
    expect(installPilotUa1ActionTrigger({ enabled: false, action, tabs })).toBe(false);
    expect(addListener).not.toHaveBeenCalled();
    expect(addTabUpdatedListener).not.toHaveBeenCalled();

    expect(installPilotUa1ActionTrigger({
      enabled: true,
      action,
      tabs,
      now: () => NOW,
      getRandomValues: (bytes) => {
        bytes.fill(0xab);
        return bytes;
      },
      digestExactUrl: async () => 'aa'.repeat(32),
    })).toBe(true);
    expect(addTabUpdatedListener).toHaveBeenCalledTimes(1);
    click?.({ id: 73, url: 'https://careers.example.test/jobs/1?step=2#questions' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      73,
      expect.objectContaining({
        targetOrigin: 'https://careers.example.test',
        targetPathname: '/jobs/1',
        targetUrlDigest: 'aa'.repeat(32),
      }),
      { frameId: 0 },
    );
    await vi.waitFor(() => expect(setTitle).toHaveBeenLastCalledWith({
      tabId: 73,
      title: 'UA-1 discovery: OK (0)',
    }));
    expect(setBadgeText).toHaveBeenLastCalledWith({ tabId: 73, text: 'OK' });
  });

  it.each([
    {
      name: 'stable success',
      send: async () => ({ ok: true, detectedControlCount: 4 }),
      badgeText: 'OK',
      title: 'UA-1 discovery: OK (4)',
    },
    {
      name: 'stable failure',
      send: async () => ({ ok: false, code: 'PILOT_TARGET_DRIFT' }),
      badgeText: '!',
      title: 'UA-1 discovery: PILOT_TARGET_DRIFT',
    },
    {
      name: 'malformed response',
      send: async () => ({ ok: true, detectedControlCount: 4, page: 'forbidden' }),
      badgeText: '!',
      title: 'UA-1 discovery: PILOT_DISCOVERY_UNAVAILABLE',
    },
    {
      name: 'rejected delivery',
      send: async () => { throw new Error('message delivery failed'); },
      badgeText: '!',
      title: 'UA-1 discovery: PILOT_DISCOVERY_UNAVAILABLE',
    },
  ])('surfaces $name as one bounded value-free action terminal', async ({
    send,
    badgeText,
    title,
  }) => {
    let click!: (tab: { id?: number; url?: string }) => void;
    const sendMessage = vi.fn(send);
    const setBadgeText = vi.fn();
    const setTitle = vi.fn();
    installPilotUa1ActionTrigger({
      enabled: true,
      action: {
        onClicked: { addListener: (listener) => { click = listener; } },
        setBadgeText,
        setTitle,
      },
      tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        get: exactTabReadback('https://careers.example.test/jobs/terminal'),
        sendMessage,
      },
      now: () => NOW,
      getRandomValues: (bytes) => bytes,
      digestExactUrl: async () => 'aa'.repeat(32),
    });

    click({ id: 41, url: 'https://careers.example.test/jobs/terminal' });

    await vi.waitFor(() => expect(setTitle).toHaveBeenLastCalledWith({ tabId: 41, title }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(setBadgeText).toHaveBeenLastCalledWith({ tabId: 41, text: badgeText });
  });

  it('rejects non-http, credentialed, overlong and targetless tabs before hashing/sending', async () => {
    let click!: (tab: { id?: number; url?: string }) => void;
    const digestExactUrl = vi.fn(async () => 'aa'.repeat(32));
    const sendMessage = vi.fn().mockResolvedValue(null);
    installPilotUa1ActionTrigger({
      enabled: true,
      action: {
        onClicked: { addListener: (listener) => { click = listener; } },
        setBadgeText: vi.fn(),
        setTitle: vi.fn(),
      },
      tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        get: vi.fn(),
        sendMessage,
      },
      now: () => NOW,
      getRandomValues: (bytes) => bytes,
      digestExactUrl,
    });
    click({ id: 1, url: 'javascript:alert(1)' });
    click({ id: 1, url: 'https://u:p@example.test/jobs' });
    click({ id: 1, url: `https://example.test/jobs?q=${'x'.repeat(4_096)}` });
    click({ id: 1 });
    click({ url: 'https://example.test/jobs' });
    await Promise.resolve();
    expect(digestExactUrl).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('contains throwing clock/digest/browser APIs in the async click task without logging', async () => {
    const callbacks: Array<(tab: { id?: number; url?: string }) => void> = [];
    const consoleLog = vi.spyOn(console, 'log');
    const consoleError = vi.spyOn(console, 'error');
    const action = {
      onClicked: { addListener: (listener: (tab: { id?: number; url?: string }) => void) => {
        callbacks.push(listener);
      } },
      setBadgeText: vi.fn(),
      setTitle: vi.fn(),
    };
    installPilotUa1ActionTrigger({
      enabled: true,
      action,
      tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        get: exactTabReadback('https://careers.example.test/jobs/1'),
        sendMessage: vi.fn(),
      },
      now: () => { throw new Error('clock unavailable'); },
    });
    installPilotUa1ActionTrigger({
      enabled: true,
      action,
      tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        get: exactTabReadback('https://careers.example.test/jobs/1'),
        sendMessage: vi.fn(),
      },
      now: () => NOW,
      digestExactUrl: () => { throw new Error('digest unavailable'); },
    });
    installPilotUa1ActionTrigger({
      enabled: true,
      action,
      tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        get: exactTabReadback('https://careers.example.test/jobs/1'),
        sendMessage: (() => { throw new Error('tabs unavailable'); }) as never,
      },
      now: () => NOW,
      digestExactUrl: async () => 'aa'.repeat(32),
    });
    for (const click of callbacks) click({ id: 9, url: 'https://careers.example.test/jobs/1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(action.setBadgeText).toHaveBeenCalledTimes(6);
    expect(action.setTitle).toHaveBeenCalledTimes(6);
    expect(action.setTitle).toHaveBeenCalledWith({
      tabId: 9,
      title: 'UA-1 discovery: PILOT_DISCOVERY_UNAVAILABLE',
    });
  });

  it('clears the page A terminal on page B navigation even after the worker restarts', async () => {
    let click!: (tab: { id?: number; url?: string }) => void;
    const setBadgeText = vi.fn();
    const setTitle = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, detectedControlCount: 3 });
    installPilotUa1ActionTrigger({
      enabled: true,
      action: {
        onClicked: { addListener: (listener) => { click = listener; } },
        setBadgeText,
        setTitle,
      },
      tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        get: exactTabReadback('https://careers.example.test/jobs/a'),
        sendMessage,
      },
      now: () => NOW,
      getRandomValues: (bytes) => bytes,
      digestExactUrl: async () => 'aa'.repeat(32),
    });

    click({ id: 51, url: 'https://careers.example.test/jobs/a' });
    await vi.waitFor(() => expect(setTitle).toHaveBeenLastCalledWith({
      tabId: 51,
      title: 'UA-1 discovery: OK (3)',
    }));

    let restartedUpdate!: (
      tabId: number,
      change: { status?: string; urlChanged?: boolean },
    ) => void;
    const postRestartSendMessage = vi.fn();
    installPilotUa1ActionTrigger({
      enabled: true,
      action: {
        onClicked: { addListener: vi.fn() },
        setBadgeText,
        setTitle,
      },
      tabs: {
        onUpdated: { addListener: (listener) => { restartedUpdate = listener; } },
        onRemoved: { addListener: vi.fn() },
        get: exactTabReadback('https://careers.example.test/jobs/b'),
        sendMessage: postRestartSendMessage,
      },
    });

    restartedUpdate(51, { status: 'loading' });

    await vi.waitFor(() => expect(setTitle).toHaveBeenLastCalledWith({
      tabId: 51,
      title: 'Discover controls on this page',
    }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(postRestartSendMessage).not.toHaveBeenCalled();
    expect(setBadgeText.mock.calls).toEqual([
      [{ tabId: 51, text: '' }],
      [{ tabId: 51, text: 'OK' }],
      [{ tabId: 51, text: '' }],
    ]);
    expect(setTitle.mock.calls).toEqual([
      [{ tabId: 51, title: 'Discover controls on this page' }],
      [{ tabId: 51, title: 'UA-1 discovery: OK (3)' }],
      [{ tabId: 51, title: 'Discover controls on this page' }],
    ]);
  });

  it('drops a delayed page A success after page B advances the tab epoch', async () => {
    let click!: (tab: { id?: number; url?: string }) => void;
    let update!: (tabId: number, change: { status?: string; urlChanged?: boolean }) => void;
    let resolveResponse!: (response: unknown) => void;
    const sendMessage = vi.fn(() => new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    }));
    const setBadgeText = vi.fn();
    const setTitle = vi.fn();
    installPilotUa1ActionTrigger({
      enabled: true,
      action: {
        onClicked: { addListener: (listener) => { click = listener; } },
        setBadgeText,
        setTitle,
      },
      tabs: {
        onUpdated: { addListener: (listener) => { update = listener; } },
        onRemoved: { addListener: vi.fn() },
        get: exactTabReadback('https://careers.example.test/jobs/a'),
        sendMessage,
      },
      now: () => NOW,
      getRandomValues: (bytes) => bytes,
      digestExactUrl: async () => 'aa'.repeat(32),
    });

    click({ id: 52, url: 'https://careers.example.test/jobs/a' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    update(52, { urlChanged: true });
    await vi.waitFor(() => expect(setTitle).toHaveBeenLastCalledWith({
      tabId: 52,
      title: 'Discover controls on this page',
    }));
    resolveResponse({ ok: true, detectedControlCount: 7 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setBadgeText).toHaveBeenCalledTimes(2);
    expect(setBadgeText).toHaveBeenLastCalledWith({ tabId: 52, text: '' });
    expect(setTitle).toHaveBeenCalledTimes(2);
    expect(setTitle).toHaveBeenLastCalledWith({
      tabId: 52,
      title: 'Discover controls on this page',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('suppresses page A terminal when exact tab readback already observes page B', async () => {
    let click!: (tab: { id?: number; url?: string }) => void;
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, detectedControlCount: 5 });
    const setBadgeText = vi.fn();
    const setTitle = vi.fn();
    installPilotUa1ActionTrigger({
      enabled: true,
      action: {
        onClicked: { addListener: (listener) => { click = listener; } },
        setBadgeText,
        setTitle,
      },
      tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        get: exactTabReadback('https://careers.example.test/jobs/b'),
        sendMessage,
      },
      now: () => NOW,
      getRandomValues: (bytes) => bytes,
      digestExactUrl: async () => 'aa'.repeat(32),
    });

    click({ id: 53, url: 'https://careers.example.test/jobs/a' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setBadgeText.mock.calls).toEqual([
      [{ tabId: 53, text: '' }],
      [{ tabId: 53, text: '' }],
    ]);
    expect(setTitle.mock.calls).toEqual([[
      { tabId: 53, title: 'Discover controls on this page' },
    ], [
      { tabId: 53, title: 'Discover controls on this page' },
    ]]);
  });

  it.each([
    { name: 'missing', status: undefined },
    { name: 'loading', status: 'loading' },
    { name: 'unknown', status: 'prerendering' },
  ])('fails closed for $name exact-page readback status', async ({ status }) => {
    let click!: (tab: { id?: number; url?: string }) => void;
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, detectedControlCount: 5 });
    const setBadgeText = vi.fn();
    const setTitle = vi.fn();
    installPilotUa1ActionTrigger({
      enabled: true,
      action: {
        onClicked: { addListener: (listener) => { click = listener; } },
        setBadgeText,
        setTitle,
      },
      tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url: 'https://careers.example.test/jobs/a',
          status,
        })),
        sendMessage,
      },
      now: () => NOW,
      getRandomValues: (bytes) => bytes,
      digestExactUrl: async () => 'aa'.repeat(32),
    });

    click({ id: 56, url: 'https://careers.example.test/jobs/a' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setBadgeText.mock.calls).toEqual([
      [{ tabId: 56, text: '' }],
      [{ tabId: 56, text: '' }],
    ]);
    expect(setTitle.mock.calls).toEqual([
      [{ tabId: 56, title: 'Discover controls on this page' }],
      [{ tabId: 56, title: 'Discover controls on this page' }],
    ]);
  });

  it('does not send after navigation advances the epoch while the exact URL digest is pending', async () => {
    let click!: (tab: { id?: number; url?: string }) => void;
    let update!: (tabId: number, change: { status?: string; urlChanged?: boolean }) => void;
    let resolveDigest!: (digest: string | null) => void;
    const digestExactUrl = vi.fn(() => new Promise<string | null>((resolve) => {
      resolveDigest = resolve;
    }));
    const sendMessage = vi.fn();
    const setBadgeText = vi.fn();
    const setTitle = vi.fn();
    installPilotUa1ActionTrigger({
      enabled: true,
      action: {
        onClicked: { addListener: (listener) => { click = listener; } },
        setBadgeText,
        setTitle,
      },
      tabs: {
        onUpdated: { addListener: (listener) => { update = listener; } },
        onRemoved: { addListener: vi.fn() },
        get: exactTabReadback('https://careers.example.test/jobs/b'),
        sendMessage,
      },
      now: () => NOW,
      getRandomValues: (bytes) => bytes,
      digestExactUrl,
    });

    click({ id: 54, url: 'https://careers.example.test/jobs/a' });
    await vi.waitFor(() => expect(digestExactUrl).toHaveBeenCalledTimes(1));
    update(54, { status: 'loading' });
    resolveDigest('aa'.repeat(32));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(setBadgeText.mock.calls).toEqual([
      [{ tabId: 54, text: '' }],
      [{ tabId: 54, text: '' }],
    ]);
    expect(setTitle.mock.calls).toEqual([
      [{ tabId: 54, title: 'Discover controls on this page' }],
      [{ tabId: 54, title: 'Discover controls on this page' }],
    ]);
  });

  it('invalidates a delayed terminal when the clicked tab is removed', async () => {
    let click!: (tab: { id?: number; url?: string }) => void;
    let remove!: (tabId: number) => void;
    let resolveResponse!: (response: unknown) => void;
    const sendMessage = vi.fn(() => new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    }));
    const setBadgeText = vi.fn();
    const setTitle = vi.fn();
    installPilotUa1ActionTrigger({
      enabled: true,
      action: {
        onClicked: { addListener: (listener) => { click = listener; } },
        setBadgeText,
        setTitle,
      },
      tabs: {
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: (listener) => { remove = listener; } },
        get: exactTabReadback('https://careers.example.test/jobs/a'),
        sendMessage,
      },
      now: () => NOW,
      getRandomValues: (bytes) => bytes,
      digestExactUrl: async () => 'aa'.repeat(32),
    });

    click({ id: 55, url: 'https://careers.example.test/jobs/a' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    remove(55);
    resolveResponse({ ok: true, detectedControlCount: 6 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setBadgeText.mock.calls).toEqual([[{ tabId: 55, text: '' }]]);
    expect(setTitle.mock.calls).toEqual([[
      { tabId: 55, title: 'Discover controls on this page' },
    ]]);
  });
});

describe('exact-page content runtime', () => {
  it('gate false performs no scan/observer work', async () => {
    const observerFactory = vi.fn();
    const scanPacket = vi.fn();
    const handle = createPilotUa1ContentRuntime({
      enabled: false,
      extensionId: EXTENSION_ID,
      expectedBackgroundUrl: BACKGROUND_URL,
      observerFactory,
      scanPacket,
    });
    expect(await handle(await requestForCurrentPage(), BACKGROUND_SENDER)).toEqual({
      ok: false,
      code: 'PILOT_CAPABILITY_DISABLED',
    });
    expect(observerFactory).not.toHaveBeenCalled();
    expect(scanPacket).not.toHaveBeenCalled();
  });

  it('requires exact background sender, top frame, fresh TTL and single-use request', async () => {
    document.body.innerHTML = '<label for="email">Email</label><input id="email" type="email">';
    const request = await requestForCurrentPage();

    expect(await contentRuntime()(request, {
      id: EXTENSION_ID,
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
    })).toEqual({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });
    expect(await contentRuntime()(request, { id: 'another', url: BACKGROUND_URL }))
      .toEqual({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });
    expect(await contentRuntime()(request, { id: EXTENSION_ID }))
      .toEqual({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });
    expect(await contentRuntime()(request, {
      id: EXTENSION_ID,
      url: BACKGROUND_URL,
      tab: undefined,
    })).toEqual({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });
    let senderGetterCalls = 0;
    const accessorSender = { url: BACKGROUND_URL } as { id?: string; url?: string };
    Object.defineProperty(accessorSender, 'id', {
      enumerable: true,
      get() {
        senderGetterCalls += 1;
        return EXTENSION_ID;
      },
    });
    expect(await contentRuntime()(request, accessorSender))
      .toEqual({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });
    expect(senderGetterCalls).toBe(0);
    expect(await contentRuntime()(request, new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error('hostile sender');
      },
    }))).toEqual({ ok: false, code: 'PILOT_NOT_USER_TRIGGERED' });

    const framedView = { top: {}, self: {} } as unknown as Window;
    expect(await contentRuntime({ view: framedView })(request, BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });

    expect(await contentRuntime({ now: () => NOW + 5_001 })(request, BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    expect(await contentRuntime({ now: () => NOW - 1 })(request, BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });

    const handle = contentRuntime();
    expect(await handle(request, BACKGROUND_SENDER)).toEqual({ ok: true, detectedControlCount: 1 });
    expect(await handle(request, BACKGROUND_SENDER)).toEqual({
      ok: false,
      code: 'PILOT_TARGET_DRIFT',
    });
  });

  it('validates the clock before touching replay tombstones', async () => {
    document.body.innerHTML = '<input aria-label="Name">';
    let currentTime = Number.NaN;
    const handle = contentRuntime({ now: () => currentTime });
    const request = await requestForCurrentPage();
    expect(await handle(request, BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    currentTime = NOW;
    expect(await handle(request, BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 1 });
  });

  it('binds transient exact href and rejects pathname, query, hash and mid-scan navigation drift', async () => {
    document.body.innerHTML = '<input type="text" aria-label="Name">';
    const exact = await requestForCurrentPage();

    history.replaceState(null, '', '/jobs/other?step=1#form');
    expect(await contentRuntime()(exact, BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    history.replaceState(null, '', '/jobs/ua1?step=2#form');
    expect(await contentRuntime()(exact, BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    history.replaceState(null, '', '/jobs/ua1?step=1#other');
    expect(await contentRuntime()(exact, BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });

    history.replaceState(null, '', '/jobs/ua1?step=1#form');
    let digestCalls = 0;
    const handle = contentRuntime({
      digest: async (value) => {
        digestCalls += 1;
        if (digestCalls === 2) history.replaceState(null, '', '/jobs/ua1?step=9#form');
        return digest(value);
      },
    });
    expect(await handle(exact, BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
  });

  it('emits one bounded value-free outcome per visible native/ARIA/contenteditable control', async () => {
    document.body.innerHTML = `
      <fieldset><legend>Contact</legend>
        <label for="email">Email <span hidden>secret hidden copy</span></label>
        <input id="email" type="email" autocomplete="work email" required value="alex@example.test">
        <div role="checkbox" aria-label="Updates"></div>
        <div contenteditable aria-label="Short answer">private draft</div>
        <div contenteditable="true" aria-label="Long answer">private rich draft</div>
        <div contenteditable="plaintext-only" aria-label="Plain answer">private plain draft</div>
        <div contenteditable="false" aria-label="Not a control"></div>
      </fieldset>`;
    let packet: PilotUa1DiscoveryPacket | null = null;
    const handle = contentRuntime({
      scanPacket: (value) => {
        const parsed = parsePilotUa1DiscoveryPacket(value);
        if (parsed.ok) packet = parsed.value;
        return scanPilotUa1Discovery(value);
      },
    });
    expect(await handle(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 5 });
    expect(packet).not.toBeNull();
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toMatch(/alex@example\.test|private draft|private rich|private plain|secret hidden/);
    expect(packet!.controls).toHaveLength(5);
    expect(packet!.controls[0]).toMatchObject({
      role: 'textbox',
      inputType: 'email',
      autocomplete: ['work', 'email'],
      required: true,
      accessibleName: 'Email',
      label: 'Email',
      legend: 'Contact',
    });
  });

  it('excludes hidden/offscreen/honeypot controls while retaining a visible file-label proxy', async () => {
    document.body.innerHTML = `
      <label for="visible">Visible</label><input id="visible">
      <input aria-label="hidden attr" hidden>
      <input aria-label="display none" style="display:none">
      <input aria-label="offscreen" style="position:absolute;left:-9999px">
      <label>Please leave this field blank<input aria-label="Website"></label>
      <input id="beecatcher" aria-label="Website">
      <label for="multi">Ordinary field</label><label for="multi">Please leave blank</label>
      <input id="multi" aria-label="Ordinary field">
      <span id="trap-name">For robots only</span>
      <input aria-label="Ordinary field" aria-labelledby="trap-name">
      <label for="resume">Upload resume</label>
      <input id="resume" type="file" aria-label="hidden internal secret" style="opacity:0;width:1px;height:1px">
    `;
    expect(await contentRuntime()(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 2 });
  });

  it('counts proxy-rendered native file/radio/checkbox controls once at the native identity', async () => {
    document.body.innerHTML = `
      <label for="resume" role="button">Upload resume</label>
      <input id="resume" type="file" style="opacity:0;width:1px;height:1px">
      <label for="consent" role="checkbox">I agree</label>
      <input id="consent" type="checkbox" style="opacity:0;width:1px;height:1px">
      <label for="work-mode" role="radio">Remote</label>
      <input id="work-mode" type="radio" style="width:0;height:0">
    `;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.id === 'work-mode') {
        return { ...positiveRect(), width: 0, height: 0, right: 0 } as DOMRect;
      }
      return positiveRect();
    });
    let packet: PilotUa1DiscoveryPacket | null = null;
    const handle = contentRuntime({
      scanPacket: (value) => {
        const parsed = parsePilotUa1DiscoveryPacket(value);
        if (parsed.ok) packet = parsed.value;
        return scanPilotUa1Discovery(value);
      },
    });

    expect(await handle(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 3 });
    expect(packet!.controls.map(({ role, inputType, label }) => ({ role, inputType, label })))
      .toEqual([
        { role: 'textbox', inputType: 'file', label: 'Upload resume' },
        { role: 'checkbox', inputType: 'checkbox', label: 'I agree' },
        { role: 'radio', inputType: 'radio', label: 'Remote' },
      ]);
  });

  it('pairs native controls with visible interaction surfaces without CSS heuristics', async () => {
    document.body.innerHTML = `
      <label for="resume-css-agnostic" role="button">Upload resume</label>
      <input id="resume-css-agnostic" type="file" style="opacity:0;width:1px;height:1px">
      <div role="combobox">
        <span>Preferred location</span>
        <input type="text" tabindex="0" style="opacity:1;width:4px">
      </div>
    `;
    const packets: PilotUa1DiscoveryPacket[] = [];
    const outcomes: string[][] = [];
    const handle = contentRuntime({
      scanPacket: (value) => {
        const parsed = parsePilotUa1DiscoveryPacket(value);
        if (parsed.ok) packets.push(parsed.value);
        const result = scanPilotUa1Discovery(value);
        if (result.ok) outcomes.push(result.value.outcomes.map((outcome) => outcome.outcome));
        return result;
      },
    });

    expect(await handle(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 2 });
    expect(packets[0]!.controls.map(({ role, inputType, label }) => ({
      role,
      inputType,
      label,
    }))).toEqual([
      { role: 'textbox', inputType: 'file', label: 'Upload resume' },
      { role: 'textbox', inputType: 'text', label: 'Preferred location' },
    ]);
    expect(outcomes).toEqual([[
      'VISIBLE_CONTROL_DETECTED',
      'VISIBLE_CONTROL_DETECTED',
    ]]);
  });

  it('discovers an anonymous file input and never uses accept as identity authority', async () => {
    document.body.innerHTML = `
      <label>Upload a file
        <input type="file" accept=".pdf" style="opacity:0;width:1px;height:1px">
      </label>
    `;
    const packets: PilotUa1DiscoveryPacket[] = [];
    const outcomes: string[][] = [];
    const handle = contentRuntime({
      scanPacket: (value) => {
        const parsed = parsePilotUa1DiscoveryPacket(value);
        if (parsed.ok) packets.push(parsed.value);
        const result = scanPilotUa1Discovery(value);
        if (result.ok) outcomes.push(result.value.outcomes.map((outcome) => outcome.outcome));
        return result;
      },
    });
    expect(await handle(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 1 });
    document.querySelector('input')!.setAttribute('accept', 'image/*');
    expect(await handle(
      await requestForCurrentPage({ requestId: '34'.repeat(16) }),
      BACKGROUND_SENDER,
    )).toEqual({ ok: true, detectedControlCount: 1 });
    expect(packets).toHaveLength(2);
    expect(packets[0]!.controls[0]).toMatchObject({
      inputType: 'file',
      accessibleName: 'Upload a file',
      label: 'Upload a file',
    });
    expect(packets[1]!.controls[0]!.identityDigest)
      .toBe(packets[0]!.controls[0]!.identityDigest);
    expect(outcomes).toEqual([
      ['VISIBLE_CONTROL_DETECTED'],
      ['VISIBLE_CONTROL_DETECTED'],
    ]);
  });

  it('requires a fresh explicit trigger for a same-URL in-place apply surface', async () => {
    const packets: PilotUa1DiscoveryPacket[] = [];
    const handle = contentRuntime({
      scanPacket: (value) => {
        const parsed = parsePilotUa1DiscoveryPacket(value);
        if (parsed.ok) packets.push(parsed.value);
        return scanPilotUa1Discovery(value);
      },
    });
    const exactHref = location.href;
    const firstRequest = await requestForCurrentPage();
    expect(await handle(firstRequest, BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 0 });

    document.body.innerHTML = '<label for="name">Name</label><input id="name">';
    expect(location.href).toBe(exactHref);
    expect(await handle(firstRequest, BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
    expect(await handle(
      await requestForCurrentPage({ requestId: '35'.repeat(16) }),
      BACKGROUND_SENDER,
    )).toEqual({ ok: true, detectedControlCount: 1 });
    expect(packets).toHaveLength(2);
    expect(packets[1]!.binding.domGeneration).not.toBe(packets[0]!.binding.domGeneration);
  });

  it('uses button name-from-content precedence and screens every bounded semantic signal', async () => {
    document.body.innerHTML = `
      <button id="ordinary" title="Fallback title">Continue</button>
      <button title="Ordinary title">Leave this field blank</button>
      <div role="button" title="Ordinary title">For robots only</div>
      <label for="placeholder-trap">Email</label>
      <input id="placeholder-trap" placeholder="Leave this field blank" title="Ordinary title">
      <label for="title-trap">Phone</label>
      <input id="title-trap" title="For robots only">
    `;
    let packet: PilotUa1DiscoveryPacket | null = null;
    const handle = contentRuntime({
      scanPacket: (value) => {
        const parsed = parsePilotUa1DiscoveryPacket(value);
        if (parsed.ok) packet = parsed.value;
        return scanPilotUa1Discovery(value);
      },
    });
    expect(await handle(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 1 });
    expect(packet!.controls).toHaveLength(1);
    expect(packet!.controls[0]).toMatchObject({
      role: 'button',
      accessibleName: 'Continue',
    });
    expect(JSON.stringify(packet)).not.toMatch(/Leave this field blank|For robots only/);
  });

  it('never reads current state and never invokes setters, events, clicks, writes or Submit', async () => {
    document.body.innerHTML = `<form>
      <label for="field">Field</label><input id="field" type="checkbox">
      <label for="notes">Notes</label><textarea id="notes"></textarea>
      <label for="choice">Choice</label><select id="choice"><option>One</option></select>
    </form>`;
    const input = document.querySelector<HTMLInputElement>('#field')!;
    const textarea = document.querySelector<HTMLTextAreaElement>('#notes')!;
    const select = document.querySelector<HTMLSelectElement>('#choice')!;
    const option = select.querySelector('option')!;
    let currentStateReads = 0;
    let writes = 0;
    for (const key of ['value', 'checked', 'files'] as const) {
      Object.defineProperty(input, key, {
        configurable: true,
        get() {
          currentStateReads += 1;
          throw new Error(`forbidden ${key} read`);
        },
        set() {
          writes += 1;
        },
      });
    }
    for (const [target, key] of [
      [textarea, 'value'],
      [select, 'selectedIndex'],
      [option, 'selected'],
      [input, 'innerHTML'],
      [input, 'outerHTML'],
    ] as const) {
      Object.defineProperty(target, key, {
        configurable: true,
        get() {
          currentStateReads += 1;
          throw new Error(`forbidden ${key} read`);
        },
        set() {
          writes += 1;
        },
      });
    }
    const dispatch = vi.spyOn(input, 'dispatchEvent');
    const click = vi.spyOn(input, 'click');
    const setAttribute = vi.spyOn(input, 'setAttribute');
    const removeAttribute = vi.spyOn(input, 'removeAttribute');
    const append = vi.spyOn(input, 'append');
    const replaceWith = vi.spyOn(input, 'replaceWith');
    const remove = vi.spyOn(input, 'remove');
    const focus = vi.spyOn(input, 'focus');
    const scrollIntoView = vi.spyOn(input, 'scrollIntoView');
    const fetch = vi.spyOn(window, 'fetch');
    const consoleLog = vi.spyOn(console, 'log');
    const consoleError = vi.spyOn(console, 'error');
    const form = document.querySelector('form')!;
    const submit = vi.spyOn(form, 'submit');
    const requestSubmit = vi.spyOn(form, 'requestSubmit');
    expect(await contentRuntime()(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 3 });
    expect(currentStateReads).toBe(0);
    expect(writes).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(setAttribute).not.toHaveBeenCalled();
    expect(removeAttribute).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(replaceWith).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    for (const [target, key] of [
      [textarea, 'value'],
      [select, 'selectedIndex'],
      [option, 'selected'],
      [input, 'innerHTML'],
      [input, 'outerHTML'],
    ] as const) delete (target as unknown as Record<string, unknown>)[key];
  });

  it('hostile getters, mutation and CSSOM-equivalent visibility drift fail closed; an opaque frame is accounted', async () => {
    document.body.innerHTML = '<input id="field" aria-label="Field">';
    const hostile = document.querySelector<HTMLInputElement>('#field')!;
    Object.defineProperty(hostile, 'getAttribute', {
      configurable: true,
      get() {
        throw new Error('hostile getter');
      },
    });
    expect(await contentRuntime()(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    delete (hostile as unknown as { getAttribute?: unknown }).getAttribute;

    // An unhidden frame is no longer a whole-scan failure: it is an accounted
    // opaque boundary (see pilot-ua1-reachability.test.ts), so the scan returns
    // its zero observed controls and the boundary rides the observation wire.
    document.body.innerHTML = '<iframe title="opaque boundary"></iframe>';
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: '33'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 0 });

    document.body.innerHTML = '<input aria-label="Before">';
    let mutationDigestCalls = 0;
    const mutationRuntime = contentRuntime({
      digest: async (value) => {
        mutationDigestCalls += 1;
        if (mutationDigestCalls === 2) {
          document.body.append(document.createElement('input'));
        }
        return digest(value);
      },
    });
    expect(await mutationRuntime(
      await requestForCurrentPage({ requestId: '44'.repeat(16) }),
      BACKGROUND_SENDER,
    )).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });

    document.body.innerHTML = '<input id="style-field" aria-label="Style field">';
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    let hiddenAfterHash = false;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = originalGetComputedStyle(element);
      if (element.id !== 'style-field' || !hiddenAfterHash) return style;
      return new Proxy(style, {
        get(target, property, _receiver) {
          if (property === 'display') return 'none';
          return Reflect.get(target, property, target);
        },
      });
    });
    let cssDigestCalls = 0;
    const cssRuntime = contentRuntime({
      digest: async (value) => {
        cssDigestCalls += 1;
        if (cssDigestCalls === 5) hiddenAfterHash = true;
        return digest(value);
      },
    });
    expect(await cssRuntime(
      await requestForCurrentPage({ requestId: '55'.repeat(16) }),
      BACKGROUND_SENDER,
    )).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });

    document.body.innerHTML = '<div id="late-shadow-host"></div>';
    const host = document.querySelector('#late-shadow-host')!;
    let shadowDigestCalls = 0;
    const shadowRuntime = contentRuntime({
      digest: async (value) => {
        shadowDigestCalls += 1;
        if (shadowDigestCalls === 4) {
          const shadow = host.attachShadow({ mode: 'open' });
          shadow.innerHTML = '<input aria-label="Late control">';
        }
        return digest(value);
      },
    });
    expect(await shadowRuntime(
      await requestForCurrentPage({ requestId: '66'.repeat(16) }),
      BACKGROUND_SENDER,
    )).toEqual({ ok: false, code: 'PILOT_TARGET_DRIFT' });
  });

  it('fails whole-scan on semantic/option/autocomplete bounds instead of truncating', async () => {
    document.body.innerHTML = `<label for="x">${'x'.repeat(257)}</label><input id="x">`;
    expect(await contentRuntime()(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });

    document.body.innerHTML = '<input autocomplete="home work mobile fax pager" aria-label="Phone">';
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: '33'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });

    document.body.innerHTML = '<select aria-label="Choice"><option></option></select>';
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: '44'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });

    document.body.innerHTML = `<select aria-label="Choice">${
      Array.from({ length: 33 }, (_, index) => `<option>Choice ${index}</option>`).join('')
    }</select>`;
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: '55'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });

    document.body.innerHTML = `<span id="first">${'a'.repeat(256)}</span>` +
      '<span id="second">Leave blank</span><input aria-labelledby="first second">';
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: '66'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });

    document.body.innerHTML = '<input id="clip" aria-label="Field">';
    const original = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = original(element);
      if (element.id !== 'clip') return style;
      return new Proxy(style, {
        get(target, property, _receiver) {
          if (property === 'clipPath') return `polygon(${'1px '.repeat(300)})`;
          return Reflect.get(target, property, target);
        },
      });
    });
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: '77'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });

    document.body.innerHTML = '<div role="unknown textbox" aria-label="Question"></div>';
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: '88'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 1 });
    document.body.innerHTML = '<div role="link textbox" aria-label="Not a textbox"></div>';
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: '89'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 0 });
    document.body.innerHTML = `<div role="${'x'.repeat(129)}" aria-label="Question"></div>`;
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: '99'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
    document.body.innerHTML = '<select aria-label="Choice"><option>Leave this field blank</option></select>';
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: 'aa'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
  });

  it('enforces the exact bounded semantic ceiling over the answer surface with zero partial success', async () => {
    // The semantic walk visits only elements that can matter to the answer
    // surface: control candidates, labels, frames and their ancestors. Prose
    // outside it spends no budget (pilot-ua1-reachability.test.ts), so the
    // exact ceiling is measured over visited candidates: html + body + 4094
    // labels = 4096 nodes.
    const mount = (count: number) => {
      document.body.innerHTML = Array.from({ length: count }, () => '<label>Note</label>').join('');
    };
    mount(4_094);
    expect(await contentRuntime()(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 0 });
    mount(4_095);
    expect(await contentRuntime()(await requestForCurrentPage({ requestId: '33'.repeat(16) }), BACKGROUND_SENDER))
      .toEqual({ ok: false, code: 'PILOT_DISCOVERY_UNAVAILABLE' });
  }, 30_000);

  it('installs no listener while disabled and ignores every non-UA1 runtime message', () => {
    let listener: Parameters<PilotUa1RuntimeMessageApi['onMessage']['addListener']>[0] | undefined;
    const runtime: PilotUa1RuntimeMessageApi = {
      id: EXTENSION_ID,
      getURL: () => BACKGROUND_URL,
      onMessage: { addListener: (next) => { listener = next; } },
    };
    expect(installPilotUa1ContentTrigger({ enabled: false, runtime })).toBe(false);
    expect(listener).toBeUndefined();
    expect(installPilotUa1ContentTrigger({ enabled: true, runtime })).toBe(true);
    const response = vi.fn();
    expect(listener?.({ kind: 'generic/run' }, BACKGROUND_SENDER, response)).toBeUndefined();
    expect(response).not.toHaveBeenCalled();
  });

  it('disconnects all mutation observers at the end of the one request', async () => {
    document.body.innerHTML = '<input aria-label="Name">';
    const observers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
    const observerFactory: NonNullable<ContentRuntimeInput['observerFactory']> = () => {
      const observer = {
        observe: vi.fn(),
        takeRecords: vi.fn(() => []),
        disconnect: vi.fn(),
      };
      observers.push(observer);
      return observer;
    };
    const handle = contentRuntime({ observerFactory });
    expect(observers).toHaveLength(0);
    expect(await handle(await requestForCurrentPage(), BACKGROUND_SENDER))
      .toEqual({ ok: true, detectedControlCount: 1 });
    expect(observers.length).toBeGreaterThan(0);
    for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });
});
