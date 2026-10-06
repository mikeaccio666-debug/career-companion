import { describe, expect, it, vi } from 'vitest';

import {
  createPilotUa5ReadinessRequest,
  parsePilotUa5ReadinessEvent,
  parsePilotUa5ReadinessRequest,
  type PilotUa5ConnectedPort,
  type PilotUa5ReadinessStatus,
} from '../lib/pilotUa5ConnectedProtocol';
import { installPilotUa5ConnectedBackground } from '../connected-dev/backgroundRuntime';
import { createPilotUa5PanelRuntimeClient } from '../connected-dev/panelRuntimeClient';
import { createProductPanelUa5Adapter } from '../product-panel/ua5Adapter';

import { event, portPair } from './connectedPorts';

function readinessHarness(input: Readonly<{
  api: boolean;
  auth: boolean;
  tabId: number | null;
  liveWrite: boolean;
  siteAccess?: boolean;
  registered?: boolean;
  userAction?: boolean;
}>) {
  const extensionId = 'extension-id';
  const connectEvent = event<(port: PilotUa5ConnectedPort) => void>();
  const tabsConnect = vi.fn();
  const probeApiHealth = vi.fn(async () => input.api);
  const hasAuthToken = vi.fn(async () => input.auth);
  const hasSiteAccess = vi.fn(async () => input.siteAccess ?? true);
  const isPageRegistered = vi.fn(async () => input.registered ?? true);
  const hasUserAction = vi.fn(async () => input.userAction ?? true);
  installPilotUa5ConnectedBackground({
    enabled: true,
    extensionId,
    expectedSidepanelUrl: `chrome-extension://${extensionId}/sidepanel.html`,
    runtime: { onConnect: connectEvent },
    tabs: { connect: tabsConnect },
    probeApiHealth,
    hasAuthToken,
    hasSiteAccess,
    isPageRegistered,
    hasUserAction,
    selectActiveTab: async () => input.tabId,
    isLiveWriteAuthorized: () => input.liveWrite,
    consumeUserAction: () => input.userAction ?? true,
    revalidateRun: () => ({ allowed: true, writeNotAfterMs: Number.MAX_SAFE_INTEGER }),
    finishRunAuthorization: () => true,
    revokeRunAuthorization: () => {},
    consumeUndoAuthorization: () => false,
    createDiscoveryRequest: async () => null,
  });
  const client = createPilotUa5PanelRuntimeClient({
    runtime: {
      connect: ({ name }) => {
        const [panel, background] = portPair(name, {
          id: extensionId,
          url: `chrome-extension://${extensionId}/sidepanel.html`,
        });
        connectEvent.emit(background);
        return panel;
      },
    },
    requestId: () => 'a'.repeat(32),
    timeoutMs: 1_000,
  });
  return {
    client,
    hasAuthToken,
    hasSiteAccess,
    hasUserAction,
    isPageRegistered,
    probeApiHealth,
    tabsConnect,
  };
}

describe('connected-dev value-free readiness protocol', () => {
  it('accepts only the exact closed request and response shapes', () => {
    const request = createPilotUa5ReadinessRequest('a'.repeat(32));
    expect(parsePilotUa5ReadinessRequest(request)).toEqual(request);
    expect(parsePilotUa5ReadinessRequest({ ...request, url: 'https://private.invalid' }))
      .toBeNull();
    expect(parsePilotUa5ReadinessEvent({
      kind: 'pilot-ua5/readiness',
      version: 2,
      requestId: 'a'.repeat(32),
      status: 'READY',
    })).toEqual({
      kind: 'pilot-ua5/readiness',
      version: 2,
      requestId: 'a'.repeat(32),
      status: 'READY',
    });
    expect(parsePilotUa5ReadinessEvent({
      kind: 'pilot-ua5/readiness',
      version: 2,
      requestId: 'a'.repeat(32),
      status: 'READY',
      pathname: '/private',
    })).toBeNull();
  });

  it.each<readonly [string, Parameters<typeof readinessHarness>[0], PilotUa5ReadinessStatus]>([
    ['ordinary Greenhouse page is not authorized', { api: true, auth: true, tabId: 42, liveWrite: false }, 'LIVE_WRITE_NOT_AUTHORIZED'],
    ['site access is withheld', { api: true, auth: true, tabId: 42, liveWrite: true, siteAccess: false }, 'SITE_ACCESS_REQUIRED'],
    ['page is not registered', { api: true, auth: true, tabId: 42, liveWrite: true, registered: false }, 'PAGE_NOT_REGISTERED'],
    ['the browser action has not armed this page', { api: true, auth: true, tabId: 42, liveWrite: true, userAction: false }, 'USER_ACTION_REQUIRED'],
    ['localhost API is down', { api: false, auth: true, tabId: 42, liveWrite: true }, 'API_UNREACHABLE'],
    ['auth is absent', { api: true, auth: false, tabId: 42, liveWrite: true }, 'AUTH_REQUIRED'],
    ['all readiness proofs hold', { api: true, auth: true, tabId: 42, liveWrite: true }, 'READY'],
  ])('reports %s without returning identity or opening a content port', async (_label, input, expected) => {
    const harness = readinessHarness(input);
    await expect(harness.client.probeReadiness()).resolves.toBe(expected);
    expect(harness.tabsConnect).not.toHaveBeenCalled();
    if (expected === 'LIVE_WRITE_NOT_AUTHORIZED') {
      expect(harness.hasSiteAccess).not.toHaveBeenCalled();
      expect(harness.probeApiHealth).not.toHaveBeenCalled();
      expect(harness.hasAuthToken).not.toHaveBeenCalled();
    }
    if (expected === 'SITE_ACCESS_REQUIRED') {
      expect(harness.isPageRegistered).not.toHaveBeenCalled();
      expect(harness.probeApiHealth).not.toHaveBeenCalled();
      expect(harness.hasAuthToken).not.toHaveBeenCalled();
    }
    if (expected === 'PAGE_NOT_REGISTERED') {
      expect(harness.hasUserAction).not.toHaveBeenCalled();
      expect(harness.probeApiHealth).not.toHaveBeenCalled();
      expect(harness.hasAuthToken).not.toHaveBeenCalled();
    }
    if (expected === 'USER_ACTION_REQUIRED') {
      expect(harness.probeApiHealth).not.toHaveBeenCalled();
      expect(harness.hasAuthToken).not.toHaveBeenCalled();
    }
  });

  it.each([{ api: false, auth: true }, { api: true, auth: false }])(
    'preserves the stable start failure when API/Auth is unavailable: %j', async (runtime) => {
      const harness = readinessHarness({ ...runtime, tabId: 42, liveWrite: true });
      await expect(harness.client.runCurrentPage(() => {})).resolves.toEqual({
        ok: false, code: 'PILOT_CAPABILITY_DISABLED',
      });
      expect(harness.tabsConnect).not.toHaveBeenCalled();
    },
  );

  it('rechecks the code-owned real-write gate before every run', async () => {
    const harness = readinessHarness({ api: true, auth: true, tabId: 42, liveWrite: false });
    await expect(harness.client.runCurrentPage(() => {})).resolves.toEqual({
      ok: false,
      code: 'PILOT_NOT_USER_TRIGGERED',
    });
    expect(harness.tabsConnect).not.toHaveBeenCalled();
  });
});

describe('connected Product Panel readiness adapter', () => {
  it('starts with no READY entries and keeps an ordinary Greenhouse page read-only', async () => {
    let resolveProbe!: (
      status: Exclude<PilotUa5ReadinessStatus, 'CHECKING'>,
    ) => void;
    let probeCount = 0;
    const probeReadiness = vi.fn(() => {
      probeCount += 1;
      return probeCount === 1
        ? new Promise<Exclude<PilotUa5ReadinessStatus, 'CHECKING'>>((resolve) => {
            resolveProbe = resolve;
          })
        : Promise.resolve('LIVE_WRITE_NOT_AUTHORIZED' as const);
    });
    const runCurrentPage = vi.fn();
    const adapter = createProductPanelUa5Adapter({ probeReadiness, runCurrentPage });

    expect(Object.values(adapter.getSnapshot().entries)).not.toContain('READY');
    expect(adapter.getReadiness?.()).toBe('USER_ACTION_REQUIRED');
    await Promise.resolve();
    expect(probeReadiness).not.toHaveBeenCalled();
    const result = adapter.requestStartAutofill({ kind: 'START_AUTOFILL' });
    await vi.waitFor(() => expect(probeReadiness).toHaveBeenCalledTimes(1));
    resolveProbe('LIVE_WRITE_NOT_AUTHORIZED');
    await expect(result).resolves.toEqual({
      ok: false,
      code: 'LIVE_WRITE_NOT_AUTHORIZED',
    });
    expect(adapter.getReadiness?.()).toBe('LIVE_WRITE_NOT_AUTHORIZED');
    expect(runCurrentPage).not.toHaveBeenCalled();
  });

  it('maps a run-time Profile gate failure to a stable friendly reason', async () => {
    const adapter = createProductPanelUa5Adapter({
      probeReadiness: vi.fn(async () => 'READY' as const),
      runCurrentPage: vi.fn(async () => ({
        ok: false as const,
        code: 'PILOT_UA5_COMPOSITION_UNAVAILABLE' as const,
      })),
    });
    expect(adapter.getReadiness?.()).toBe('USER_ACTION_REQUIRED');
    await expect(adapter.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({
      ok: false,
      code: 'PROFILE_UNAVAILABLE',
    });
    expect(adapter.getReadiness?.()).toBe('PROFILE_UNAVAILABLE');
  });
});
