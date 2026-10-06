import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { installPilotUa5ConnectedBackground } from '../connected-dev/backgroundRuntime';
import {
  createPilotUa5ExactPageLeaseRegistry,
  type PilotUa5ExactPageFacts,
} from '../connected-dev/exactPageLease';

const TARGET_ORIGIN = 'https://job-boards.greenhouse.io';
const TARGET_PATHNAME = '/edaix-canary/jobs/424242';
const TARGET_URL = `${TARGET_ORIGIN}${TARGET_PATHNAME}`;
const TARGET_DIGEST = 'd'.repeat(64);
const REQUEST_A = 'a'.repeat(32);
const REQUEST_B = 'b'.repeat(32);

const facts = (pageEpoch = 0): PilotUa5ExactPageFacts => Object.freeze({
  tabId: 42,
  origin: TARGET_ORIGIN,
  pathname: TARGET_PATHNAME,
  targetUrlDigest: TARGET_DIGEST,
  pageEpoch,
});

const binding = Object.freeze({ origin: TARGET_ORIGIN, pathname: TARGET_PATHNAME, domGeneration: '1'.repeat(64) });

function leaseFixture(leaseMs = 100) {
  let now = 1_000;
  const exact = facts();
  const leases = createPilotUa5ExactPageLeaseRegistry({ now: () => now, leaseMs });
  return { exact, leases, setTime: (value: number) => { now = value; } };
}

describe('connected-dev exact-page gesture lease', () => {
  it.each(['DOM', 'pageEpoch'] as const)('irreversibly poisons an active run on %s drift', (drift) => {
    const { exact, leases } = leaseFixture();
    expect(leases.arm(exact)).toBe(true);
    expect(leases.consumePending(exact, REQUEST_A)).toBe(true);
    expect(leases.revalidateActive(exact, REQUEST_A, binding)).toBe(true);
    expect(drift === 'DOM'
      ? leases.revalidateActive(exact, REQUEST_A, { ...binding, domGeneration: '2'.repeat(64) })
      : leases.revalidateActive({ ...exact, pageEpoch: 1 }, REQUEST_A)).toBe(false);
    expect(leases.revalidateActive(exact, REQUEST_A, binding)).toBe(false);
    expect(leases.finishRun(REQUEST_A, true)).toBe(false);
    expect(leases.consumeUndo(exact, REQUEST_A)).toBe(false);
  });

  it('fails closed and clears lease authority when the observed clock moves backwards', () => {
    const { exact, leases, setTime } = leaseFixture(100);

    expect(leases.arm(exact)).toBe(true);
    expect(leases.consumePending(exact, REQUEST_A)).toBe(true);
    expect(leases.revalidateActive(exact, REQUEST_A, binding)).toBe(true);
    setTime(1_100);
    expect(leases.revalidateActive(exact, REQUEST_A, binding)).toBe(false);

    setTime(1_099);
    expect(leases.revalidateActive(exact, REQUEST_A, binding)).toBe(false);
    expect(leases.finishRun(REQUEST_A, true)).toBe(false);
    expect(leases.consumeUndo(exact, REQUEST_A)).toBe(false);

    setTime(1_101);
    expect(leases.arm(exact)).toBe(false);

    let finishNow = 2_000;
    const finishLeases = createPilotUa5ExactPageLeaseRegistry({
      now: () => finishNow,
      leaseMs: 100,
    });
    const other = Object.freeze({ ...exact, tabId: 43 });
    expect(finishLeases.arm(exact)).toBe(true);
    expect(finishLeases.consumePending(exact, REQUEST_A)).toBe(true);
    expect(finishLeases.revalidateActive(exact, REQUEST_A, binding)).toBe(true);
    expect(finishLeases.arm(other)).toBe(true);
    expect(finishLeases.consumePending(other, REQUEST_B)).toBe(true);
    expect(finishLeases.revalidateActive(other, REQUEST_B, binding)).toBe(true);
    finishNow = 2_050;
    expect(finishLeases.revalidateActive(other, REQUEST_B, binding)).toBe(true);
    finishNow = 2_049;
    expect(finishLeases.finishRun(REQUEST_A, false)).toBe(false);
    finishNow = 2_051;
    expect(finishLeases.revalidateActive(other, REQUEST_B, binding)).toBe(false);
  });

  it('expires at the boundary and rejects malformed or drifting page facts', () => {
    const { exact, leases, setTime } = leaseFixture(100);
    setTime(10);

    expect(leases.arm({ ...exact, origin: 'https://example.com' })).toBe(false);
    expect(leases.arm({ ...exact, pathname: `${exact.pathname}?private=1` })).toBe(false);
    expect(leases.arm({ ...exact, targetUrlDigest: 'not-a-digest' })).toBe(false);
    expect(leases.arm(exact)).toBe(true);
    expect(leases.hasPending({ ...exact, pageEpoch: 1 })).toBe(false);
    expect(leases.hasPending(exact)).toBe(true);

    setTime(110);
    expect(leases.hasPending(exact)).toBe(false);
    setTime(Number.NaN);
    expect(leases.arm(exact)).toBe(false);
    expect(createPilotUa5ExactPageLeaseRegistry({
      now: () => Number.MAX_SAFE_INTEGER,
      leaseMs: 1,
    }).arm(exact)).toBe(false);
  });

  it('preserves active and Undo ownership when the browser action only reopens the Panel', () => {
    const { leases, setTime } = leaseFixture(60_000);
    const first = facts(1);

    expect(leases.arm(first)).toBe(true);
    expect(leases.hasPending(first)).toBe(true);
    expect(leases.consumePending(first, REQUEST_A)).toBe(true);
    expect(leases.consumePending(first, REQUEST_B)).toBe(false);
    expect(leases.revalidateActive(first, REQUEST_A, binding)).toBe(true);
    // Reopening during an active run cannot revoke it or start a competing run.
    expect(leases.arm(first)).toBe(true);
    expect(leases.revalidateActive(first, REQUEST_A, binding)).toBe(true);
    expect(leases.consumePending(first, REQUEST_B)).toBe(false);

    expect(leases.finishRun(REQUEST_A, true)).toBe(true);
    expect(leases.revalidateActive(first, REQUEST_A, binding)).toBe(false);
    // Reopening after a successful run also preserves its restorative handle.
    setTime(1_001);
    expect(leases.arm(first)).toBe(true);
    expect(leases.consumeUndo(first, REQUEST_A)).toBe(true);
    expect(leases.consumeUndo(first, REQUEST_A)).toBe(false);
    expect(leases.consumePending(first, REQUEST_B)).toBe(true);
    leases.revokeTab(first.tabId);
    expect(leases.revalidateActive(first, REQUEST_B)).toBe(false);
    setTime(61_000);
    expect(leases.hasPending(first)).toBe(false);
  });

  it('starts a fresh active window and publishes a separate recovery window at expiry', () => {
    const { exact, leases, setTime } = leaseFixture(100);

    expect(leases.arm(exact)).toBe(true);
    setTime(1_090);
    expect(leases.consumePending(exact, REQUEST_A)).toBe(true);
    setTime(1_189);
    expect(leases.revalidateActive(exact, REQUEST_A, binding)).toBe(true);
    setTime(1_190);
    expect(leases.revalidateActive(exact, REQUEST_A, binding)).toBe(false);
    expect(leases.finishRun(REQUEST_A, true)).toBe(true);
    expect(leases.consumeUndo(exact, REQUEST_A)).toBe(true);

    expect(leases.arm(exact)).toBe(true);
    expect(leases.consumePending(exact, REQUEST_B)).toBe(true);
    expect(leases.revalidateActive(exact, REQUEST_B, binding)).toBe(true);
    setTime(1_390);
    expect(leases.hasRecovery(exact, REQUEST_B)).toBe(false);
    expect(leases.finishRun(REQUEST_B, true)).toBe(false);
    expect(leases.consumeUndo(exact, REQUEST_B)).toBe(false);
  });
});

type Tab = Readonly<{ id?: number; url?: string }>;
type PageReadySender = Readonly<{
  id?: string;
  frameId?: number;
  url?: string;
  tab?: Readonly<{ id?: number }>;
}>;
type InstalledCallbacks = Parameters<typeof installPilotUa5ConnectedBackground>[0];

const wiring = vi.hoisted(() => ({
  actionListeners: [] as Array<(tab: Tab) => void>,
  externalListeners: [] as Array<(message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown>,
  pushedToTabs: [] as Array<Readonly<{ tabId: number; message: unknown }>>,
  missionSelected: false,
  pageReadyListeners: [] as Array<(
    message: unknown,
    sender: PageReadySender,
  ) => unknown>,
  permissionRemovedListeners: [] as Array<(
    removed: Readonly<{ origins?: string[] }>,
  ) => void>,
  tabRemovedListeners: [] as Array<(tabId: number) => void>,
  tabUpdatedListeners: [] as Array<(
    tabId: number,
    changeInfo: Readonly<{ status?: string; url?: string }>,
  ) => void>,
  installed: null as InstalledCallbacks | null,
  permissionAllowed: true,
  tab: {
    id: 42,
    url: 'https://job-boards.greenhouse.io/edaix-canary/jobs/424242',
  } as Tab,
  authHandler: vi.fn(async () => null),
  getAccessToken: vi.fn(async () => null),
  permissionContains: vi.fn(),
  sidePanelOpen: vi.fn(async () => undefined),
  sidePanelBehavior: vi.fn(async () => undefined),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
}));

vi.mock('wxt/utils/define-background', () => ({
  defineBackground: (main: () => unknown) => ({ main }),
}));
vi.mock('wxt/browser', () => ({
  browser: {
    action: {
      onClicked: { addListener: (listener: (tab: Tab) => void) => wiring.actionListeners.push(listener) },
    },
    permissions: {
      contains: wiring.permissionContains,
      onRemoved: {
        addListener: (
          listener: (removed: Readonly<{ origins?: string[] }>) => void,
        ) => wiring.permissionRemovedListeners.push(listener),
      },
    },
    runtime: {
      id: 'extension-id',
      getURL: (path: string) => `chrome-extension://extension-id${path}`,
      onConnect: { addListener: vi.fn() },
      onMessage: {
        addListener: (
          listener: (message: unknown, sender: PageReadySender) => unknown,
        ) => wiring.pageReadyListeners.push(listener),
      },
      sendMessage: vi.fn(async () => undefined),
      onMessageExternal: {
        addListener: (
          listener: (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown,
        ) => wiring.externalListeners.push(listener),
      },
    },
    sidePanel: {
      open: wiring.sidePanelOpen,
      setPanelBehavior: wiring.sidePanelBehavior,
    },
    storage: {
      onChanged: { addListener: vi.fn() },
      local: {
        get: vi.fn(async () => ({})),
        remove: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
      },
    },
    tabs: {
      connect: vi.fn(),
      get: wiring.tabsGet,
      sendMessage: vi.fn(async (tabId: number, message: unknown) => {
        wiring.pushedToTabs.push({ tabId, message });
      }),
      onRemoved: {
        addListener: (listener: (tabId: number) => void) => wiring.tabRemovedListeners.push(listener),
      },
      onUpdated: {
        addListener: (
          listener: (
            tabId: number,
            changeInfo: Readonly<{ status?: string; url?: string }>,
          ) => void,
        ) => wiring.tabUpdatedListeners.push(listener),
      },
      query: wiring.tabsQuery,
    },
  },
}));
vi.mock('../lib/authClient', () => ({
  createAuthClient: () => ({ getAccessToken: wiring.getAccessToken }),
}));
vi.mock('../lib/authHandoff', () => ({
  createAuthHandoffHandler: () => wiring.authHandler,
}));
vi.mock('../lib/pilotUa5ProfilePayloadClient', () => ({
  createPilotUa5ProfilePayloadClient: () => ({ resolve: vi.fn() }),
}));
// The portal handshake itself is proven in pilot-wizard-source.test.ts; here the
// question is only whether a successful selection reaches the page that is open.
vi.mock('../lib/pilotWizardSource', () => ({
  createPilotWizardSource: () => ({
    select: async () => { wiring.missionSelected = true; return true; },
    missionBound: async () => wiring.missionSelected,
    resolve: async () => null,
    validate: async () => false,
    reset: () => {},
  }),
}));
vi.mock('../connected-dev/backgroundRuntime', () => ({
  installPilotUa5ConnectedBackground: (input: InstalledCallbacks) => {
    wiring.installed = input;
    return true;
  },
}));

async function bootBackground(): Promise<InstalledCallbacks> {
  const { default: entrypoint } = await import('../entrypoints-connected/background');
  await (entrypoint as unknown as { main(): Promise<void> }).main();
  if (wiring.installed === null) throw new Error('background callbacks were not installed');
  return wiring.installed;
}

async function registerExactPage(origin = TARGET_ORIGIN, pathname = TARGET_PATHNAME): Promise<unknown> {
  const listener = wiring.pageReadyListeners.at(-1);
  if (listener === undefined) throw new Error('page-ready listener was not installed');
  return await listener({
    kind: 'pilot-ua5/page-ready',
    version: 2,
    origin,
    pathname,
  }, {
    id: 'extension-id',
    frameId: 0,
    url: wiring.tab.url,
    tab: { id: 42 },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T16:00:00.000Z'));
  wiring.actionListeners.length = 0;
  wiring.pageReadyListeners.length = 0;
  wiring.externalListeners.length = 0;
  wiring.pushedToTabs.length = 0;
  wiring.missionSelected = false;
  wiring.permissionRemovedListeners.length = 0;
  wiring.tabRemovedListeners.length = 0;
  wiring.tabUpdatedListeners.length = 0;
  wiring.installed = null;
  wiring.permissionAllowed = true;
  wiring.tab = { id: 42, url: TARGET_URL };
  wiring.permissionContains.mockImplementation(async () => wiring.permissionAllowed);
  wiring.tabsGet.mockImplementation(async () => wiring.tab);
  wiring.tabsQuery.mockImplementation(async () => [wiring.tab]);
  vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_ENABLED__', true);
  vi.stubGlobal('__VIBE_API_BASE__', 'http://localhost:3000');
  vi.stubGlobal('__VIBE_WEB_BASE__', 'http://localhost:3100');
  vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__', true);
  vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__', TARGET_ORIGIN);
  vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__', TARGET_PATHNAME);
  vi.stubGlobal(
    '__VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__',
    Date.parse('2026-09-05T00:00:00.000Z'),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('connected-dev background exact-page activation wiring', () => {
  it('opens synchronously, consumes one click, binds the exact run, and exposes one Undo', async () => {
    const callbacks = await bootBackground();
    await registerExactPage();
    const click = wiring.actionListeners.at(-1);
    if (click === undefined) throw new Error('action listener was not installed');

    click(wiring.tab);
    expect(wiring.sidePanelOpen).toHaveBeenCalledWith({ tabId: 42 });
    // Build approval does not supply eventless ABA or Profile currentness proof.
    expect(callbacks.isLiveWriteAuthorized()).toBe(false);
    await expect(callbacks.selectActiveTab()).resolves.toBe(42);
    await expect(callbacks.hasSiteAccess(42)).resolves.toBe(true);
    await expect(callbacks.isPageRegistered(42)).resolves.toBe(true);
    await expect(callbacks.hasUserAction(42)).resolves.toBe(true);
    await expect(callbacks.consumeUserAction(42, REQUEST_A)).resolves.toBe(true);
    await expect(callbacks.consumeUserAction(42, REQUEST_B)).resolves.toBe(false);

    const discovery = await callbacks.createDiscoveryRequest(42, REQUEST_A);
    expect(discovery).toMatchObject({
      requestId: REQUEST_A,
      targetOrigin: TARGET_ORIGIN,
      targetPathname: TARGET_PATHNAME,
    });
    const binding = Object.freeze({
      origin: TARGET_ORIGIN,
      pathname: TARGET_PATHNAME,
      domGeneration: '4'.repeat(64),
    });
    await expect(callbacks.revalidateRun(42, REQUEST_A, discovery!, binding))
      .resolves.toMatchObject({ allowed: true });

    callbacks.finishRunAuthorization(REQUEST_A, true);
    await expect(callbacks.consumeUndoAuthorization(42, REQUEST_A)).resolves.toBe(true);
    await expect(callbacks.consumeUndoAuthorization(42, REQUEST_A)).resolves.toBe(false);
  });

  it('does not let an older asynchronous click revoke a newer exact-page lease', async () => {
    const callbacks = await bootBackground();
    await registerExactPage();
    const click = wiring.actionListeners.at(-1)!;
    let resolveFirst!: (allowed: boolean) => void;
    let resolveSecond!: (allowed: boolean) => void;
    const first = new Promise<boolean>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<boolean>((resolve) => { resolveSecond = resolve; });
    wiring.permissionContains
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second)
      .mockImplementation(async () => true);

    click(wiring.tab);
    click(wiring.tab);
    resolveSecond(true);
    await Promise.resolve();
    await Promise.resolve();
    resolveFirst(false);
    await Promise.resolve();
    await Promise.resolve();

    await expect(callbacks.hasUserAction(42)).resolves.toBe(true);
    await expect(callbacks.consumeUserAction(42, REQUEST_A)).resolves.toBe(true);
  });

  it('does not let the consumed click\'s delayed permission result revoke its active run', async () => {
    const callbacks = await bootBackground();
    await registerExactPage();
    const click = wiring.actionListeners.at(-1)!;
    let resolveClickPermission!: (allowed: boolean) => void;
    const clickPermission = new Promise<boolean>((resolve) => {
      resolveClickPermission = resolve;
    });
    wiring.permissionContains
      .mockImplementationOnce(() => clickPermission)
      .mockImplementation(async () => true);

    click(wiring.tab);
    await expect(callbacks.consumeUserAction(42, REQUEST_A)).resolves.toBe(true);

    resolveClickPermission(false);
    await Promise.resolve();
    await Promise.resolve();

    const discovery = await callbacks.createDiscoveryRequest(42, REQUEST_A);
    expect(discovery).not.toBeNull();
    await expect(callbacks.revalidateRun(42, REQUEST_A, discovery!, {
      origin: TARGET_ORIGIN,
      pathname: TARGET_PATHNAME,
      domGeneration: '9'.repeat(64),
    })).resolves.toMatchObject({ allowed: true });
    expect(callbacks.finishRunAuthorization(REQUEST_A, true)).toBe(true);
    await expect(callbacks.consumeUndoAuthorization(42, REQUEST_A)).resolves.toBe(true);
  });

  it('revokes page authority on navigation, tab removal, and host-permission removal', async () => {
    const callbacks = await bootBackground();
    await registerExactPage();
    const click = wiring.actionListeners.at(-1)!;
    click(wiring.tab);
    await expect(callbacks.hasUserAction(42)).resolves.toBe(true);

    wiring.tabUpdatedListeners.at(-1)!(42, { status: 'loading' });
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
    await expect(callbacks.isPageRegistered(42)).resolves.toBe(false);

    await registerExactPage();
    click(wiring.tab);
    wiring.permissionRemovedListeners.at(-1)!({ origins: [`${TARGET_ORIGIN}/*`] });
    wiring.permissionAllowed = false;
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
    await expect(callbacks.hasSiteAccess(42)).resolves.toBe(false);
    await expect(callbacks.isPageRegistered(42)).resolves.toBe(false);

    wiring.permissionAllowed = true;
    await registerExactPage();
    click(wiring.tab);
    wiring.tabRemovedListeners.at(-1)!(42);
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
  });

  it.each([
    `${TARGET_URL}?candidate=private`,
    `${TARGET_URL}#application`,
    `https://job-boards.greenhouse.io:443${TARGET_PATHNAME}`,
    `https://user:password@job-boards.greenhouse.io${TARGET_PATHNAME}`,
    `${TARGET_ORIGIN}/another/jobs/424242`,
  ])('rejects a non-exact active URL before a lease can be armed: %s', async (url) => {
    wiring.tab = { id: 42, url };
    const callbacks = await bootBackground();
    await registerExactPage();
    wiring.actionListeners.at(-1)!(wiring.tab);

    expect(wiring.sidePanelOpen).toHaveBeenCalledWith({ tabId: 42 });
    await expect(callbacks.selectActiveTab()).resolves.toBeNull();
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
    await expect(callbacks.isPageRegistered(42)).resolves.toBe(false);
  });

  it('keeps the passive connected-dev artifact unable to mint a write lease', async () => {
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__', false);
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__', null);
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__', null);
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__', 0);
    const callbacks = await bootBackground();
    wiring.actionListeners.at(-1)!(wiring.tab);

    expect(wiring.sidePanelOpen).toHaveBeenCalledWith({ tabId: 42 });
    expect(callbacks.isLiveWriteAuthorized()).toBe(false);
    await expect(callbacks.selectActiveTab()).resolves.toBeNull();
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
  });

  it('closes forward writes at hard expiry without destroying committed recovery', async () => {
    const callbacks = await bootBackground();
    vi.setSystemTime(new Date('2026-09-04T23:59:59.000Z'));
    await registerExactPage();
    wiring.actionListeners.at(-1)!(wiring.tab);
    await expect(callbacks.hasUserAction(42)).resolves.toBe(true);
    await expect(callbacks.consumeUserAction(42, REQUEST_A)).resolves.toBe(true);
    const discovery = await callbacks.createDiscoveryRequest(42, REQUEST_A);
    expect(discovery).not.toBeNull();
    await expect(callbacks.revalidateRun(42, REQUEST_A, discovery!, {
      origin: TARGET_ORIGIN,
      pathname: TARGET_PATHNAME,
      domGeneration: '7'.repeat(64),
    })).resolves.toMatchObject({ allowed: true });
    expect(callbacks.finishRunAuthorization(REQUEST_A, true)).toBe(true);

    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'));
    expect(callbacks.isLiveWriteAuthorized()).toBe(false);
    await expect(callbacks.selectActiveTab()).resolves.toBe(42);
    await expect(callbacks.hasSiteAccess(42)).resolves.toBe(true);
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
    await expect(callbacks.consumeUndoAuthorization(42, REQUEST_A)).resolves.toBe(true);
    await expect(callbacks.consumeUndoAuthorization(42, REQUEST_A)).resolves.toBe(false);
  });

  it('denies a revalidation that began before hard expiry but completed after it', async () => {
    const callbacks = await bootBackground();
    vi.setSystemTime(new Date('2026-09-04T23:59:59.000Z'));
    await registerExactPage();
    wiring.actionListeners.at(-1)!(wiring.tab);
    await expect(callbacks.hasUserAction(42)).resolves.toBe(true);
    await expect(callbacks.consumeUserAction(42, REQUEST_A)).resolves.toBe(true);
    const discovery = await callbacks.createDiscoveryRequest(42, REQUEST_A);
    expect(discovery).not.toBeNull();

    let releasePermission!: (allowed: boolean) => void;
    const delayedPermission = new Promise<boolean>((resolve) => {
      releasePermission = resolve;
    });
    wiring.permissionContains.mockImplementationOnce(() => delayedPermission);
    const revalidation = callbacks.revalidateRun(42, REQUEST_A, discovery!, {
      origin: TARGET_ORIGIN,
      pathname: TARGET_PATHNAME,
      domGeneration: '8'.repeat(64),
    });
    await vi.waitFor(() => expect(wiring.permissionContains).toHaveBeenCalled());

    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'));
    releasePermission(true);
    await expect(revalidation).resolves.toBe(false);
  });
});

describe('approved local TEXT admission through the actual worker', () => {
  const origin = 'https://127.0.0.1:9443';
  const pathname = '/__edaix_controlled__/p1-native-text';
  const start = Date.parse('2026-09-06T03:00:00.000Z');
  const end = start + 15 * 60_000;

  function localGlobals() {
    vi.setSystemTime(start);
    wiring.tab = { id: 42, url: `${origin}${pathname}` };
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__', origin);
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__', pathname);
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_LOCAL_AUTHORITY__',
      'FIRST_LOCAL_TEXT_ADMISSION_APPROVED_828AAC2E_2026-09-05');
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE_MS__', start);
    vi.stubGlobal('__VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__', end);
  }

  it('requires the real action lease after a valid local build, then bounds the per-run proof', async () => {
    localGlobals();
    const callbacks = await bootBackground();
    expect(callbacks.isLiveWriteAuthorized()).toBe(true);
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
    await expect(callbacks.consumeUserAction(42, REQUEST_A)).resolves.toBe(false);
    await registerExactPage(origin, pathname);
    wiring.actionListeners.at(-1)!(wiring.tab);
    await expect(callbacks.hasSiteAccess(42)).resolves.toBe(true);
    expect(wiring.permissionContains).toHaveBeenCalledWith({ origins: [`${origin}/*`] });
    await expect(callbacks.hasUserAction(42)).resolves.toBe(true);
    await expect(callbacks.consumeUserAction(42, REQUEST_A)).resolves.toBe(true);
    const discovery = await callbacks.createDiscoveryRequest(42, REQUEST_A);
    expect(discovery).toMatchObject({ targetOrigin: origin, targetPathname: pathname });
    await expect(callbacks.revalidateRun(42, REQUEST_A, discovery!, {
      origin, pathname, domGeneration: '8'.repeat(64),
    })).resolves.toMatchObject({ allowed: true });
    vi.setSystemTime(end);
    expect(callbacks.isLiveWriteAuthorized()).toBe(false);
    await expect(callbacks.revalidateRun(42, REQUEST_A, discovery!, {
      origin, pathname, domGeneration: '8'.repeat(64),
    })).resolves.toBe(false);
    vi.setSystemTime(start);
    expect(callbacks.isLiveWriteAuthorized()).toBe(false);
  });

  it('keeps local read-only discovery separate from the consumed and revoked write lease', async () => {
    localGlobals();
    const callbacks = await bootBackground();
    await registerExactPage(origin, pathname);
    wiring.actionListeners.at(-1)!(wiring.tab);
    await expect(callbacks.consumeUserAction(42, REQUEST_A)).resolves.toBe(true);
    const original = await callbacks.createDiscoveryRequest(42, REQUEST_A);
    expect(original).not.toBeNull();
    callbacks.revokeRunAuthorization(REQUEST_A); // Continue retires the original run first.

    const readOnly = await callbacks.createReadOnlyDiscoveryRequest!(42, REQUEST_B);
    expect(readOnly).toMatchObject({
      requestId: REQUEST_B, targetOrigin: origin, targetPathname: pathname,
      targetUrlDigest: original!.targetUrlDigest,
    });
    await expect(callbacks.readPageFacts!(42)).resolves.toMatchObject({ origin, pathname, tabId: 42 });
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
    await expect(callbacks.consumeUserAction(42, REQUEST_B)).resolves.toBe(false);
    await expect(callbacks.revalidateRun(42, REQUEST_A, original!)).resolves.toBe(false);
    await expect(callbacks.revalidateRun(42, REQUEST_B, readOnly!)).resolves.toBe(false);

    vi.setSystemTime(end);
    expect(callbacks.isLiveWriteAuthorized()).toBe(false);
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
    wiring.permissionAllowed = false;
    await expect(callbacks.createReadOnlyDiscoveryRequest!(42, REQUEST_B)).resolves.toBeNull();
    await expect(callbacks.readPageFacts!(42)).resolves.toBeNull();
  });

  it('denies before the fixed window and after an await crosses its end', async () => {
    localGlobals();
    const callbacks = await bootBackground();
    vi.setSystemTime(start - 1);
    expect(callbacks.isLiveWriteAuthorized()).toBe(false);
    vi.setSystemTime(end - 1_000);
    await registerExactPage(origin, pathname);
    wiring.actionListeners.at(-1)!(wiring.tab);
    await expect(callbacks.consumeUserAction(42, REQUEST_A)).resolves.toBe(true);
    const discovery = await callbacks.createDiscoveryRequest(42, REQUEST_A);
    wiring.permissionContains.mockImplementationOnce(async () => {
      vi.setSystemTime(end);
      return true;
    });
    await expect(callbacks.revalidateRun(42, REQUEST_A, discovery!, {
      origin, pathname, domGeneration: '8'.repeat(64),
    })).resolves.toBe(false);
  });

  it.each([
    ['__VIBE_EXTENSION_CONNECTED_DEV_LOCAL_AUTHORITY__', null],
    ['__VIBE_EXTENSION_CONNECTED_DEV_LOCAL_AUTHORITY__', 'true'],
    ['__VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__', false],
    ['__VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE_MS__', NaN],
    ['__VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__', end + 1],
    ['__VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__', 'https://127.0.0.1:9444'],
    ['__VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__', `${pathname}/next`],
  ])('rejects an incomplete or broadened runtime tuple (%s)', async (key, value) => {
    localGlobals();
    vi.stubGlobal(key, value);
    const callbacks = await bootBackground();
    expect(callbacks.isLiveWriteAuthorized()).toBe(false);
    await registerExactPage(origin, pathname);
    wiring.actionListeners.at(-1)!(wiring.tab);
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
  });

  it.each(['?x=1', '#x', '/next'])('rejects a changed target %s despite a valid build tuple', async (suffix) => {
    localGlobals();
    const callbacks = await bootBackground();
    await registerExactPage(origin, pathname);
    wiring.actionListeners.at(-1)!(wiring.tab);
    wiring.tab = { id: 42, url: `${origin}${pathname}${suffix}` };
    await expect(callbacks.selectActiveTab()).resolves.toBeNull();
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
  });

  it('revokes the local lease when site permission is removed', async () => {
    localGlobals();
    const callbacks = await bootBackground();
    await registerExactPage(origin, pathname);
    wiring.actionListeners.at(-1)!(wiring.tab);
    await expect(callbacks.hasUserAction(42)).resolves.toBe(true);
    wiring.permissionRemovedListeners.at(-1)!({ origins: [`${origin}/*`] });
    await expect(callbacks.hasUserAction(42)).resolves.toBe(false);
    await expect(callbacks.isPageRegistered(42)).resolves.toBe(false);
  });
});

describe('the page-ready reply carries the dock face', () => {
  // The content script must not decide this: whether the browser is connected
  // and whether the page belongs to a Mission are facts only the worker holds,
  // and the reply is the one moment it is already speaking to that page.
  it('answers a registered page with a face it is allowed to show', async () => {
    await bootBackground();
    const reply = await registerExactPage();
    expect(reply).toEqual({ dock: { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' } });
  });
  it('answers nothing at all for a page it refuses to register', async () => {
    await bootBackground();
    const reply = await registerExactPage(TARGET_ORIGIN, '/somewhere-else');
    expect(reply, 'a refused page gets no face, not a hidden one').toBeUndefined();
  });
});

describe('choosing the job after the page is already open', () => {
  const PORTAL_ORIGIN = 'http://localhost:3100';
  const selectMission = async (): Promise<void> => {
    const listener = wiring.externalListeners.at(-1);
    if (listener === undefined) throw new Error('portal listener was not installed');
    await new Promise<void>((resolve) => {
      listener(
        { kind: 'pilot-ua5/select-wizard-context', schemaVersion: 1,
          correlationId: '12345678-1234-4234-8234-123456789abc',
          missionId: '22345678-1234-4234-8234-123456789abc',
          expectedOwnerId: '32345678-1234-4234-8234-123456789abc', missionRevision: '7' },
        { origin: PORTAL_ORIGIN, url: `${PORTAL_ORIGIN}/applications` },
        () => { resolve(); },
      );
    });
    // The portal is answered first and the open page told after, so the push is
    // still in flight when the reply lands.
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
  };
  it('pushes the face computed now, rather than leaving the page stale', async () => {
    await bootBackground();
    await registerExactPage();
    wiring.pushedToTabs.length = 0;
    await selectMission();
    // What is pushed is the face the worker would decide today, not a canned
    // one — here PORTAL_UNLINKED, because this harness has no signed-in
    // session. Which face each set of facts earns is pinned by
    // autofill-dock-decision's own tests; what is proven here is that the open
    // page is told again at all.
    expect(wiring.pushedToTabs).toEqual([
      { tabId: 42, message: { dock: { kind: 'UNAVAILABLE', reason: 'PORTAL_UNLINKED' } } },
    ]);
  });
  it('pushes to nobody when no page of ours is open', async () => {
    await bootBackground();
    await selectMission();
    expect(wiring.pushedToTabs).toEqual([]);
  });
});

describe('the in-page gesture arms the same lease the toolbar does', () => {
  // Ruled by the product owner, 2026-09-11: some vendors take the application on
  // a site the side panel cannot reach, so the panel's own button has to be able
  // to start a fill. It earns no shortcut for it — the same page facts, the same
  // site access, the same one-shot lease.
  // Chrome hands a runtime message to every listener, so the test does too;
  // asking only the last one would silently skip whichever registered first.
  const deliver = async (message: unknown, sender: unknown): Promise<void> => {
    for (const listener of wiring.pageReadyListeners) await listener(message as never, sender as never);
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
  };
  const dockGesture = async (over: Record<string, unknown> = {}): Promise<void> => {
    await deliver(
      { kind: 'pilot-ua5/dock-fill-intent', version: 2, origin: TARGET_ORIGIN, pathname: TARGET_PATHNAME, ...over },
      { id: 'extension-id', frameId: 0, url: wiring.tab.url, tab: { id: 42 } },
    );
  };

  it('arms a one-shot write lease, without opening the side panel', async () => {
    const callbacks = await bootBackground();
    await registerExactPage();
    expect(await callbacks.hasUserAction(42)).toBe(false);
    await dockGesture();
    expect(await callbacks.hasUserAction(42)).toBe(true);
    expect(wiring.sidePanelOpen, 'the page may not open extension UI').not.toHaveBeenCalled();
    expect(await callbacks.consumeUserAction(42, REQUEST_A)).toBe(true);
    expect(await callbacks.consumeUserAction(42, REQUEST_B), 'one gesture, one run').toBe(false);
  });
  it('arms nothing from a subframe', async () => {
    const callbacks = await bootBackground();
    await registerExactPage();
    await deliver(
      { kind: 'pilot-ua5/dock-fill-intent', version: 2, origin: TARGET_ORIGIN, pathname: TARGET_PATHNAME },
      { id: 'extension-id', frameId: 3, url: wiring.tab.url, tab: { id: 42 } },
    );
    expect(await callbacks.hasUserAction(42)).toBe(false);
  });
  it('arms nothing for a page it never registered', async () => {
    const callbacks = await bootBackground();
    await dockGesture();
    expect(await callbacks.hasUserAction(42)).toBe(false);
  });
  it('arms nothing when the reported page is not the one the sender is on', async () => {
    const callbacks = await bootBackground();
    await registerExactPage();
    await dockGesture({ pathname: '/somewhere-else' });
    expect(await callbacks.hasUserAction(42)).toBe(false);
  });
});
