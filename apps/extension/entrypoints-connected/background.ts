/**
 * Connected-dev's dedicated MV3 worker.
 *
 * The worker contains only the fixed-realm Auth handoff, an exact session tab
 * registry, the one-run UA-5 port, and the owner-bound Profile payload client.
 * Legacy intent, submission, receipt, telemetry, and kernel-bridge runtimes are
 * intentionally absent from this entrypoint and therefore from the artifact.
 */

import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { sha256 } from '@noble/hashes/sha256';
import { createAuthClient, type AuthKeyValueStore } from '../lib/authClient';
import { createAuthHandoffHandler } from '../lib/authHandoff';
import { resolvePortalSenderOrigin } from '../lib/portalSenderRealm';
import { parsePilotWizardContextSelection, type PilotWizardContextSelectionResult } from '@edaix/contracts/draft/pilot-wizard-context';
import { createMissionApplicationTargetClient } from '../lib/missionApplicationTargetClient';
import { autofillPanelAffordance, type AutofillAffordance } from '../product-panel/affordance';
import { parseDockFillIntent } from '../lib/dockFillIntent';
import { parseDirectoryRequest } from '../lib/directoryRequest';
import { createProfileDirectoryTransport } from '../lib/profileDirectoryTransport';
import { createExecutionRuntimeBundleClient } from '../lib/executionRuntimeBundleClient';
import { createExecutionRuntimeBundleStore } from '../lib/executionRuntimeBundleStore';
import { createBackgroundExecutionRuntimeAuthority } from '../lib/executionRuntimeAuthority';
import { createPilotWizardSource } from '../lib/pilotWizardSource';
import {
  canonicalizePilotUa1ActionUrl,
  createPilotUa1DiscoveryRequest,
  parsePilotUa1DiscoveryRequest,
} from '../lib/pilotUa1DiscoveryProtocol';
import { createPilotUa5ProfilePayloadClient } from '../lib/pilotUa5ProfilePayloadClient';
import { CONNECTED_DEVELOPMENT_REALM, CONNECTED_STAGING_REALM } from '../lib/connectedRuntimeRealm';
import {
  isPilotUa5ControlledLocalAdmission,
  isPilotUa5ControlledLocalTuple,
} from '../lib/pilotUa5ControlledLocalAdmission';
import { installPilotUa5ConnectedBackground } from '../connected-dev/backgroundRuntime';
import {
  createPilotUa5ExactPageLeaseRegistry,
  type PilotUa5ExactPageFacts,
} from '../connected-dev/exactPageLease';
import {
  parsePilotUa5ConnectedPageReady,
  type PilotUa5ConnectedPort,
} from '../lib/pilotUa5ConnectedProtocol';

const stagingEnabled = typeof __VIBE_EXTENSION_CONNECTED_STAGING_ENABLED__ !== 'undefined' && __VIBE_EXTENSION_CONNECTED_STAGING_ENABLED__;
const connectedRealm = stagingEnabled ? CONNECTED_STAGING_REALM : CONNECTED_DEVELOPMENT_REALM;
const CONNECTED_DEV_API_BASE = connectedRealm.apiBase;
const CONNECTED_DEV_PORTAL_ORIGIN = connectedRealm.portalOrigin;
const CONNECTED_DEV_ATS_ORIGIN = 'https://job-boards.greenhouse.io';

export default defineBackground(async () => {
  if (
    typeof __VIBE_EXTENSION_CONNECTED_DEV_ENABLED__ === 'undefined' ||
    !__VIBE_EXTENSION_CONNECTED_DEV_ENABLED__ ||
    __VIBE_API_BASE__ !== CONNECTED_DEV_API_BASE ||
    __VIBE_WEB_BASE__ !== CONNECTED_DEV_PORTAL_ORIGIN
  ) return;

  // `sidePanel.open` must be invoked directly inside the browser-action user
  // gesture. Automatic opening is disabled so that the same synchronous
  // handler can mint the only memory-resident exact-page lease.
  try {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {
      // The explicit action listener remains the only authority source.
    });
  } catch {
    // The explicit action listener remains the only authority source.
  }

  const configuredTargetOrigin =
    typeof __VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__ === 'string'
      ? __VIBE_EXTENSION_CONNECTED_DEV_TARGET_ORIGIN__
      : null;
  const configuredTargetPathname =
    typeof __VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__ === 'string'
      ? __VIBE_EXTENSION_CONNECTED_DEV_TARGET_PATHNAME__
      : null;
  const configuredNotAfterMs =
    typeof __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__ === 'number'
      ? __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_AFTER_MS__
      : 0;
  const writeActivationRequested =
    typeof __VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__ !== 'undefined' &&
    __VIBE_EXTENSION_CONNECTED_DEV_WRITE_ENABLED__ === true;
  const configuredTargetHref = configuredTargetOrigin === null || configuredTargetPathname === null
    ? null
    : canonicalizePilotUa1ActionUrl(`${configuredTargetOrigin}${configuredTargetPathname}`);
  const controlledLocalTuple = Object.freeze({
    connectedDev: __VIBE_EXTENSION_CONNECTED_DEV_ENABLED__ === true,
    stagingEnabled,
    writeEnabled: writeActivationRequested,
    apiBase: __VIBE_API_BASE__,
    portalOrigin: __VIBE_WEB_BASE__,
    targetUrl: configuredTargetHref,
    authority: typeof __VIBE_EXTENSION_CONNECTED_DEV_LOCAL_AUTHORITY__ === 'string'
      ? __VIBE_EXTENSION_CONNECTED_DEV_LOCAL_AUTHORITY__ : null,
    notBeforeMs: typeof __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE_MS__ === 'number'
      ? __VIBE_EXTENSION_CONNECTED_DEV_WRITE_NOT_BEFORE_MS__ : 0,
    notAfterMs: configuredNotAfterMs,
  });
  const controlledLocalValid = isPilotUa5ControlledLocalTuple(controlledLocalTuple);
  const configuredTargetValid =
    writeActivationRequested &&
    configuredTargetHref === `${configuredTargetOrigin}${configuredTargetPathname}` &&
    (controlledLocalValid || (
      configuredTargetOrigin === CONNECTED_DEV_ATS_ORIGIN &&
      /^\/[A-Za-z0-9._~-]+\/jobs\/[1-9][0-9]{0,19}$/u.test(configuredTargetPathname ?? '')
    )) &&
    Number.isSafeInteger(configuredNotAfterMs) &&
    configuredNotAfterMs > 0 && (!stagingEnabled ||
      (Number.isSafeInteger(controlledLocalTuple.notBeforeMs) && controlledLocalTuple.notBeforeMs > 0 &&
       configuredNotAfterMs > controlledLocalTuple.notBeforeMs && configuredNotAfterMs - controlledLocalTuple.notBeforeMs <= 15 * 60_000));
  const siteOrigin = controlledLocalValid ? configuredTargetOrigin! : CONNECTED_DEV_ATS_ORIGIN;
  const sitePermission = `${siteOrigin}/*`;
  let configuredTargetDigest: string | null = null;
  if (configuredTargetValid && configuredTargetHref !== null) {
    try {
      configuredTargetDigest = [...sha256(new TextEncoder().encode(configuredTargetHref))]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      configuredTargetDigest = null;
    }
  }
  const exactPageLeases = createPilotUa5ExactPageLeaseRegistry();
  const pageEpochByTab = new Map<number, number>();
  const registeredEpochByTab = new Map<number, number>();
  const actionArmTokenByTab = new Map<number, symbol>();
  const buildAuthorityCurrent = (): boolean => {
    const time = exactPageLeases.currentTime();
    return time !== null && configuredTargetValid && configuredTargetDigest !== null &&
      time < configuredNotAfterMs &&
      (!stagingEnabled || time >= controlledLocalTuple.notBeforeMs) &&
      (!controlledLocalValid || isPilotUa5ControlledLocalAdmission(controlledLocalTuple, time));
  };
  const currentPageEpoch = (tabId: number): number => pageEpochByTab.get(tabId) ?? 0;
  const revokeTab = (tabId: number, advanceEpoch: boolean): void => {
    actionArmTokenByTab.delete(tabId);
    exactPageLeases.revokeTab(tabId);
    registeredEpochByTab.delete(tabId);
    if (!advanceEpoch) {
      pageEpochByTab.delete(tabId);
      return;
    }
    const current = currentPageEpoch(tabId);
    pageEpochByTab.set(
      tabId,
      current >= Number.MAX_SAFE_INTEGER ? 0 : current + 1,
    );
  };
  const factsFromTab = (tab: Readonly<{
    id?: number;
    url?: string;
  }>): PilotUa5ExactPageFacts | null => {
    if (
      configuredTargetHref === null ||
      configuredTargetDigest === null ||
      typeof tab.id !== 'number' ||
      !Number.isSafeInteger(tab.id) ||
      tab.id < 0 ||
      tab.url !== configuredTargetHref
    ) return null;
    return Object.freeze({
      tabId: tab.id,
      origin: siteOrigin,
      pathname: configuredTargetPathname!,
      targetUrlDigest: configuredTargetDigest,
      pageEpoch: currentPageEpoch(tab.id),
    });
  };
  const readExactPageFacts = async (tabId: number): Promise<PilotUa5ExactPageFacts | null> => {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return null;
    try {
      return factsFromTab(await browser.tabs.get(tabId));
    } catch {
      return null;
    }
  };
  const hasExactSiteAccess = async (): Promise<boolean> => {
    try {
      return await browser.permissions.contains({
        origins: [sitePermission],
      }) === true;
    } catch {
      return false;
    }
  };

  // Keep both operations in the browser-action callback itself: Chrome only
  // accepts sidePanel.open while the user gesture is live, and the gesture is
  // also the sole source of the memory-only write lease. Permission is checked
  // immediately afterwards and again at every runtime gate.
  /**
   * Mint the one-shot write lease for a tab from a user gesture.
   *
   * Two gestures reach this, and neither is trusted more than the other: the
   * toolbar click, and a trusted click inside our own closed shadow root on the
   * page. The in-page one exists because some vendors take the application on a
   * surface the side panel cannot reach, so a fill that can only be started from
   * extension chrome is a fill that cannot happen there at all (owner ruling,
   * 2026-09-11).
   *
   * It earns no shortcut for it. Build authority, page facts, site access and
   * the same-page recheck are all applied here, once, so the two callers cannot
   * drift into granting different things — and the lease stays one-shot, so a
   * gesture buys exactly one run.
   */
  const armWriteLease = (tab: Readonly<{ id?: number; url?: string }>): void => {
    const tabId = tab.id;
    if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) return;
    if (!buildAuthorityCurrent()) return;
    const facts = factsFromTab(tab);
    if (facts === null || !exactPageLeases.arm(facts)) return;
    const actionArmToken = Symbol('pilot-ua5-action-arm');
    actionArmTokenByTab.set(tabId, actionArmToken);
    void (async () => {
      if (!await hasExactSiteAccess()) {
        if (actionArmTokenByTab.get(tabId) === actionArmToken) {
          actionArmTokenByTab.delete(tabId);
          exactPageLeases.revokeTab(tabId);
        }
        return;
      }
      const current = await readExactPageFacts(tabId);
      if (actionArmTokenByTab.get(tabId) !== actionArmToken) return;
      actionArmTokenByTab.delete(tabId);
      const samePage = current !== null &&
        current.tabId === facts.tabId &&
        current.origin === facts.origin &&
        current.pathname === facts.pathname &&
        current.targetUrlDigest === facts.targetUrlDigest &&
        current.pageEpoch === facts.pageEpoch;
      if (!samePage) {
        revokeTab(tabId, true);
      }
    })();
  };

  // Keep the panel open and the lease mint in the callback itself: Chrome only
  // accepts sidePanel.open while the user gesture is live.
  browser.action.onClicked.addListener((tab) => {
    const tabId = tab.id;
    if (typeof tabId === 'number' && Number.isSafeInteger(tabId) && tabId >= 0) {
      try {
        void browser.sidePanel.open({ tabId }).catch(() => {
          // The panel staying closed never grants write authority.
        });
      } catch {
        // The panel staying closed never grants write authority.
      }
    }
    armWriteLease(tab);
  });

  const storageLocal: AuthKeyValueStore = {
    async get(key) {
      return (await browser.storage.local.get(key))[key];
    },
    async set(key, value) {
      await browser.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await browser.storage.local.remove(key);
    },
  };
  const authClient = createAuthClient({
    apiBase: CONNECTED_DEV_API_BASE,
    store: storageLocal,
  });
  const handleAuthMessage = createAuthHandoffHandler({
    authClient,
    extensionId: browser.runtime.id,
    allowedOrigins: [CONNECTED_DEV_PORTAL_ORIGIN],
  });
  browser.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const kind = (message as { kind?: unknown } | null)?.kind;
    if (
      kind !== 'auth/handoff-begin' &&
      kind !== 'auth/handoff-complete' &&
      kind !== 'auth/connection-status'
    ) return;
    const origin = resolvePortalSenderOrigin(sender) ?? undefined;
    void handleAuthMessage(message, origin)
      .then((response) => sendResponse(response ?? { ok: false }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  });

  /**
   * The panel's door to the profile, held here because the token is held here.
   *
   * The panel gets to name one of eight operations; the route table and the
   * bearer stay on this side, so a panel that has been taken over still cannot
   * aim the user's token somewhere of its own choosing.
   */
  const directory = createProfileDirectoryTransport({
    apiBase: CONNECTED_DEV_API_BASE,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    const request = parseDirectoryRequest(message);
    if (request === null) return;
    const tabId = sender.tab?.id;
    // The same identity the page-ready report and the fill gesture must satisfy.
    if (
      sender.id !== browser.runtime.id ||
      sender.frameId !== 0 ||
      typeof tabId !== 'number' ||
      !Number.isSafeInteger(tabId) ||
      tabId < 0 ||
      typeof sender.url !== 'string' ||
      !sender.url.startsWith(`${siteOrigin}/`) ||
      registeredEpochByTab.get(tabId) !== currentPageEpoch(tabId)
    ) return;
    return directory.run(request.operation, request.body);
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    const intent = parseDockFillIntent(message);
    if (intent === null) return;
    const tabId = sender.tab?.id;
    // The same identity the page-ready report must satisfy. A gesture reported
    // by anyone but our own top frame, on a page we did not register, or naming
    // a page other than the one the sender is actually on, arms nothing.
    if (
      sender.id !== browser.runtime.id ||
      sender.frameId !== 0 ||
      typeof tabId !== 'number' ||
      !Number.isSafeInteger(tabId) ||
      tabId < 0 ||
      typeof sender.url !== 'string' ||
      intent.origin !== siteOrigin ||
      sender.url !== `${intent.origin}${intent.pathname}` ||
      registeredEpochByTab.get(tabId) !== currentPageEpoch(tabId)
    ) return;
    armWriteLease({ id: tabId, url: sender.url });
    // The side panel holds the run orchestration and is the only sender its port
    // admits, so the gesture asks it to start the run it already knows how to.
    // Whether anyone is listening is the page's answer too: a button that looks
    // like it did nothing is worse than one that says what is missing.
    return browser.runtime.sendMessage({ kind: 'pilot-ua5/dock-fill-requested' })
      .then(() => ({ started: true }))
      .catch(() => ({ started: false }));
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    const pageReady = parsePilotUa5ConnectedPageReady(message);
    if (pageReady === null) return;
    const tabId = sender.tab?.id;
    if (
      sender.id !== browser.runtime.id ||
      sender.frameId !== 0 ||
      typeof tabId !== 'number' ||
      !Number.isSafeInteger(tabId) ||
      tabId < 0 ||
      typeof sender.url !== 'string' ||
      pageReady.origin !== siteOrigin
    ) return;
    const activeFacts = writeActivationRequested
      ? factsFromTab({ id: tabId, url: sender.url })
      : null;
    if (
      sender.url !== `${pageReady.origin}${pageReady.pathname}` ||
      (writeActivationRequested && activeFacts === null)
    ) return;
    revokeTab(tabId, true);
    registeredEpochByTab.set(tabId, currentPageEpoch(tabId));
    // The reply is where the content script learns whether it may put anything
    // on the page, and what it may say there. Deciding it here is the only
    // correct place: connection and Mission binding are the worker's facts, and
    // a content script that guessed either would be standing on a user's form
    // on its own authority. A page we refused above gets no reply at all.
    return currentDockFace(tabId);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (
      !Number.isSafeInteger(tabId) ||
      tabId < 0 ||
      (changeInfo.status !== 'loading' && typeof changeInfo.url !== 'string')
    ) return;
    revokeTab(tabId, true);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return;
    revokeTab(tabId, false);
  });
  browser.permissions.onRemoved.addListener((removed) => {
    if (!removed.origins?.includes(sitePermission)) return;
    actionArmTokenByTab.clear();
    exactPageLeases.revokeAll();
    registeredEpochByTab.clear();

  });

  const profilePayloadClient = createPilotUa5ProfilePayloadClient({
    enabled: true,
    stagingEnabled, portalOrigin: CONNECTED_DEV_PORTAL_ORIGIN,
    apiBase: CONNECTED_DEV_API_BASE,
    getAccessToken: () => authClient.getAccessToken(),
  });
  const exactActiveTab = async (): Promise<number | null> => {
    let tabs: Array<Readonly<{ id?: number; url?: string }>>;
    try {
      tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      return null;
    }
    if (tabs.length !== 1) return null;
    const tab = tabs[0];
    if (tab === undefined) return null;
    return factsFromTab(tab)?.tabId ?? null;
  };

  const isExactPageRegistered = async (tabId: number): Promise<boolean> => {
    const facts = await readExactPageFacts(tabId);
    return facts !== null && registeredEpochByTab.get(tabId) === facts.pageEpoch;
  };

  const sameDiscoveryPage = (
    facts: PilotUa5ExactPageFacts,
    requestId: string,
    discovery: unknown,
  ): boolean => {
    const parsed = parsePilotUa1DiscoveryRequest(discovery);
    if (parsed === null) return false;
    let now: number;
    try { now = Date.now(); } catch { return false; }
    return parsed.requestId === requestId &&
      parsed.issuedAtMs <= now &&
      now < parsed.expiresAtMs &&
      parsed.targetOrigin === facts.origin &&
      parsed.targetPathname === facts.pathname &&
      parsed.targetUrlDigest === facts.targetUrlDigest;
  };

  const probeApiHealth = async (): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`${CONNECTED_DEV_API_BASE}/health/live`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const freshFacts = async (tabId: number, forward: boolean): Promise<PilotUa5ExactPageFacts | null> => {
    if ((forward && !buildAuthorityCurrent()) || !await hasExactSiteAccess() ||
        await exactActiveTab() !== tabId || !await isExactPageRegistered(tabId)) return null;
    return readExactPageFacts(tabId);
  };

  const missionTargetClient = createMissionApplicationTargetClient({
    apiBase: CONNECTED_DEV_API_BASE,
    getAccessToken: () => authClient.getAccessToken(),
    refreshAccessToken: () => authClient.forceRefresh(),
  });
  const wizardSource = createPilotWizardSource({
    allowedPortalOrigins: [CONNECTED_DEV_PORTAL_ORIGIN],
    getCurrentUserId: () => authClient.getUserId(),
    readConnectionReadiness: (owner) => authClient.readConnectionReadiness(owner),
    resolveTarget: (missionId) => missionTargetClient.resolve(missionId),
    runtimeAuthority: createBackgroundExecutionRuntimeAuthority({
      client: createExecutionRuntimeBundleClient({
        apiBase: CONNECTED_DEV_API_BASE,
        store: createExecutionRuntimeBundleStore(storageLocal),
        extensionVersion: () => browser.runtime.getManifest().version,
      }),
    }),
    readPageFacts: (tabId) => freshFacts(tabId, false),
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, 'authSession')) wizardSource.reset();
  });
  /**
   * The face this page may show, from the facts only the worker holds.
   *
   * One computation for both moments it is needed — the page's own report, and
   * a later change of mind in the portal — so the two can never disagree about
   * what the same page is allowed to offer.
   */
  const currentDockFace = async (tabId: number): Promise<Readonly<{ dock: AutofillAffordance }>> => ({
    dock: autofillPanelAffordance({
      site: null,
      // Whether this is an application form is not a question in this realm: the
      // build matches exactly one origin, and every path into here has already
      // been refused unless it is the configured target on a page this worker
      // registered. Asking the kernel's vendor registry again would answer a
      // question already answered — and would drag its whole rule vocabulary
      // into the worker, which is what pushed this artifact over its size gate.
      onApplyFormPath: true,
      connected: (await authClient.getAccessToken()) !== null,
      // The portal's own selection, asked rather than assumed. Read-only: it
      // issues no scan context and grants nothing — a run still earns its
      // authority through resolve(). Offering Autofill on a page the selected
      // Mission has nothing to do with would be a promise we cannot keep.
      missionBound: await wizardSource.missionBound(tabId),
    }),
  });

  /** Tell every page of ours that is open what it may show now. */
  const pushDockFaceToRegisteredTabs = async (): Promise<void> => {
    for (const tabId of [...registeredEpochByTab.keys()]) {
      try {
        const tab = await browser.tabs.get(tabId);
        const url = typeof tab.url === 'string' ? new URL(tab.url) : null;
        // A tab that moved since it registered is not the page we decided for.
        if (url === null || url.origin !== siteOrigin) continue;
        await browser.tabs.sendMessage(tabId, await currentDockFace(tabId));
      } catch {
        // A closed tab or a content script that is gone needs no face; the next
        // page-ready report asks again from scratch.
      }
    }
  };

  browser.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const request = parsePilotWizardContextSelection(message);
    if (!request) return;
    const reply = (ok: boolean): void => {
      const response: PilotWizardContextSelectionResult = {
        kind: 'pilot-ua5/wizard-context-selected', schemaVersion: 1, correlationId: request.correlationId, ok,
      };
      sendResponse(response);
    };
    void wizardSource.select(request, resolvePortalSenderOrigin(sender) ?? undefined)
      .then(async (ok) => {
        reply(ok);
        // The page the user is standing on has to hear about this. Without it a
        // panel opened before the job was chosen keeps saying "not in your
        // list" for a job that now is, and the user is told to go do something
        // they have already done.
        if (ok) await pushDockFaceToRegisteredTabs();
      })
      .catch(() => reply(false));
    return true;
  });

  installPilotUa5ConnectedBackground({
    enabled: true,
    extensionId: browser.runtime.id,
    expectedSidepanelUrl: browser.runtime.getURL('/sidepanel.html'),
    runtime: {
      onConnect: browser.runtime.onConnect as unknown as {
        addListener(listener: (port: PilotUa5ConnectedPort) => void): void;
      },
    },
    tabs: {
      connect: (tabId, options) =>
        browser.tabs.connect(tabId, options) as unknown as PilotUa5ConnectedPort,
    },
    probeApiHealth,
    hasAuthToken: async () => (await authClient.getAccessToken()) !== null,
    getCurrentUserId: () => authClient.getUserId(),
    wizardSource,
    readPageFacts: (tabId) => freshFacts(tabId, false),
    createReadOnlyDiscoveryRequest: async (tabId, requestId) => {
      const facts = await freshFacts(tabId, false);
      if (facts === null || configuredTargetHref === null) return null;
      let issuedAtMs: number;
      try { issuedAtMs = Date.now(); } catch { return null; }
      return createPilotUa1DiscoveryRequest({
        pageUrl: configuredTargetHref, requestId, issuedAtMs, targetUrlDigest: facts.targetUrlDigest,
      });
    },
    selectActiveTab: exactActiveTab,
    // Require the bounded staging build or the original exact local TEXT tuple.
    // Real Auth, action lease and original-Profile currentness still gate every leaf.
    isLiveWriteAuthorized: () => stagingEnabled ? buildAuthorityCurrent() : isPilotUa5ControlledLocalAdmission(
      controlledLocalTuple, exactPageLeases.currentTime(),
    ),
    hasSiteAccess: async (tabId) =>
      (await readExactPageFacts(tabId)) !== null && await hasExactSiteAccess(),
    isPageRegistered: isExactPageRegistered,
    hasUserAction: async (tabId) => {
      const facts = await freshFacts(tabId, true);
      return facts !== null && exactPageLeases.hasPending(facts);
    },
    consumeUserAction: async (tabId, requestId) => {
      const facts = await freshFacts(tabId, true);
      const consumed = facts !== null && exactPageLeases.consumePending(facts, requestId);
      if (consumed) {
        // From this point the run's own fresh gates and exact-page lease own
        // revocation. The click's older async verifier must not revoke them.
        actionArmTokenByTab.delete(tabId);
      }
      return consumed;
    },
    revalidateRun: async (tabId, requestId, discovery, binding) => {
      const facts = await freshFacts(tabId, true);
      // Every preceding browser/API check can suspend. Re-read the irreversible
      // build clock at the final grant boundary, then return the tighter of the
      // build cutoff and the active browser-action lease for content-local use.
      if (
        facts === null ||
        !sameDiscoveryPage(facts, requestId, discovery) ||
        !buildAuthorityCurrent()
      ) return false;
      const leaseWriteNotAfterMs = exactPageLeases.authorizeActive(
        facts,
        requestId,
        binding,
      );
      return leaseWriteNotAfterMs === null
        ? false
        : Object.freeze({
            allowed: true as const,
            writeNotAfterMs: Math.min(configuredNotAfterMs, leaseWriteNotAfterMs),
          });
    },
    finishRunAuthorization: (requestId, keepUndo) => {
      return exactPageLeases.finishRun(requestId, keepUndo);
    },
    revokeRunAuthorization: (requestId) => {
      exactPageLeases.revokeRun(requestId);
    },
    hasRecoveryAuthorization: async (tabId, runRequestId) => {
      const facts = await readExactPageFacts(tabId);
      return facts !== null && exactPageLeases.hasRecovery(facts, runRequestId);
    },
    consumeUndoAuthorization: async (tabId, runRequestId) => {
      const facts = await freshFacts(tabId, false);
      return facts !== null && exactPageLeases.consumeUndo(facts, runRequestId);
    },
    createDiscoveryRequest: async (tabId, requestId) => {
      const facts = await freshFacts(tabId, true);
      if (
        facts === null ||
        configuredTargetHref === null ||
        !exactPageLeases.revalidateActive(facts, requestId)
      ) return null;
      let issuedAtMs: number;
      try { issuedAtMs = Date.now(); } catch { return null; }
      return createPilotUa1DiscoveryRequest({
        pageUrl: configuredTargetHref,
        requestId,
        issuedAtMs,
        targetUrlDigest: facts.targetUrlDigest,
      });
    },
    resolveProfilePayloads: (request, deadline) => profilePayloadClient.resolve(request, deadline),
    checkProfileCurrentness: (request, deadline) => profilePayloadClient.check(request, deadline),
  });
});
