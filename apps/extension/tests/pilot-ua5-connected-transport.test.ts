import { success as fixturePayload } from './pilotUa5Fixtures';
import { parsePilotUa5BoundProfilePayloadResponse } from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import { describe, expect, it, vi } from 'vitest';

import type { PilotUa5RunProjection } from '@edaix/contracts/draft/pilot-ua5-certification';
import { pilotUa5ProfilePayloadFailure } from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import {
  PILOT_UA5_CONTENT_PORT_NAME,
  PILOT_UA5_PANEL_PORT_NAME,
  createPilotUa5ContentRunRequest,
  createPilotUa5ConnectedPageReady,
  createPilotUa5UndoRequest,
  createPilotUa5WriteCheckRequest,
  parsePilotUa5UndoRequest,
  parsePilotUa5UndoResult,
  parsePilotUa5WriteCheckRequest,
  parsePilotUa5WriteCheckResult,
  parsePilotUa5ConnectedPageReady,
  parsePilotUa5PanelEvent,
  parsePilotUa5ProgressEvent,
  pilotUa5ResultMessage,
  createPilotUa5CurrentResultRequest,
  parsePilotUa5PanelRequest,
  pilotUa5WriteCheckResultMessage,
  pilotUa5ProfilePayloadRequestMessage,
  type PilotUa5ConnectedPort,
  type PilotUa5LeafWriteAuthorization,
} from '../lib/pilotUa5ConnectedProtocol';
import { installPilotUa5ConnectedBackground } from '../connected-dev/backgroundRuntime';
import { installPilotUa5ConnectedContent } from '../connected-dev/contentRuntime';
import { createPilotUa5PanelRuntimeClient } from '../connected-dev/panelRuntimeClient';
import { createPilotUa5ExactPageLeaseRegistry } from '../connected-dev/exactPageLease';
import { createProductPanelUa5Adapter } from '../product-panel/ua5Adapter';

import { event, portPair, asyncPortPair } from './connectedPorts';

const PROJECTION: PilotUa5RunProjection = Object.freeze({
  schemaVersion: 2,
  binding: Object.freeze({
    origin: 'https://job-boards.greenhouse.io',
    pathname: '/company/jobs/42',
    domGeneration: 'a'.repeat(64),
  }),
  discoveryComplete: true,
  rows: Object.freeze([
    Object.freeze({
      questionId: 'email', required: true, state: 'FILLED' as const, reason: null,
    }),
  ]),
  unobservedRegions: Object.freeze([]),
  summary: Object.freeze({
    observableQuestions: 1,
    requiredQuestions: 1,
    requiredCompleted: 1,
    terminalQuestions: 1,
    unobservedRegions: 0,
  }),
});

const DISCOVERY = createPilotUa1DiscoveryRequest({
  pageUrl: 'https://job-boards.greenhouse.io/company/jobs/42?gh_jid=42',
  requestId: 'b'.repeat(32),
  issuedAtMs: 1_000,
  targetUrlDigest: 'c'.repeat(64),
})!;

const BACKGROUND_DEFAULTS = Object.freeze({
  enabled: true, extensionId: 'extension-id',
  expectedSidepanelUrl: 'chrome-extension://extension-id/sidepanel.html',
  probeApiHealth: async () => true,
  hasAuthToken: async () => true,
  selectActiveTab: async (): Promise<number | null> => 42,
  isLiveWriteAuthorized: async () => true,
  createDiscoveryRequest: async () => DISCOVERY,
  hasSiteAccess: async () => true,
  isPageRegistered: async () => true,
  hasUserAction: async () => true,
  consumeUserAction: async () => true,
  revalidateRun: async () => Object.freeze({
    allowed: true as const,
    writeNotAfterMs: Number.MAX_SAFE_INTEGER,
  }),
  finishRunAuthorization: () => true,
  revokeRunAuthorization: () => {},
  consumeUndoAuthorization: async () => true,
});

const PROFILE_REQUEST = Object.freeze({
  schemaVersion: 1 as const,
  trigger: 'USER_CURRENT_PAGE_REQUEST' as const,
  discovery: Object.freeze({
    schemaVersion: 2 as const,
    binding: PROJECTION.binding,
    controls: Object.freeze([
      Object.freeze({
        identityDigest: 'd'.repeat(64),
        role: 'textbox' as const,
        inputType: 'email' as const,
        autocomplete: Object.freeze(['email']),
        required: true,
        accessibleName: 'Email',
        label: 'Email',
        legend: null,
        options: Object.freeze([]),
        fileAccept: null,
      }),
    ]),
    observation: Object.freeze({
      suppressedControls: Object.freeze([]),
      hiddenNotObservedCount: 0, opaqueBoundaries: [],
    }),
  }),
  structure: Object.freeze({
    schemaVersion: 1 as const,
    packetDigest: 'e'.repeat(64),
    epochIndex: 0,
    compilerVersion: 'semantic-compiler-1',
    counts: Object.freeze({ controls: 1, entries: 1, suppressed: 0, hiddenNotObserved: 0 }),
    entries: Object.freeze([
      Object.freeze({
        identityDigest: 'd'.repeat(64),
        elementToken: 'f'.repeat(64),
        groupKeyDigest: null,
        row: null,
        documentOrder: 0,
        memberOfGroupControl: null,
        placeholderShape: null,
        optionsOverflow: false,
        placeholderOptionIndexes: Object.freeze([]),
        disabled: false,
        readOnly: false,
        multiple: false,
      }),
    ]),
  }),
});

function boundPayload() {
  const payload = fixturePayload();
  const rewritten = JSON.parse(JSON.stringify(payload)
    .replaceAll('question.email', 'email')
    .replaceAll('b'.repeat(64), 'd'.repeat(64)));
  rewritten.composition.candidateRule.binding = PROJECTION.binding;
  rewritten.composition.authority.binding = PROJECTION.binding;
  rewritten.composition.projection.binding = PROJECTION.binding;
  const result = parsePilotUa5BoundProfilePayloadResponse({ ok: true, schemaVersion: 2, payload: rewritten, originalBindingSeal: 'e30.e30.AA' });
  if (!result.ok || !result.value.ok) throw new Error('TEST_FIXTURE_INVALID');
  return result.value;
}

describe('connected-dev protocol', () => {
  it('snapshots each progress event once and rejects a stateful Proxy union switch', async () => {
    let ownKeysReads = 0;
    let shape: 'INVALID_OBSERVED' | 'VALID_COMPOSED' = 'INVALID_OBSERVED';
    const switching = new Proxy(Object.create(null) as Record<string, unknown>, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => {
        ownKeysReads += 1;
        shape = ownKeysReads === 1 ? 'INVALID_OBSERVED' : 'VALID_COMPOSED';
        return shape === 'INVALID_OBSERVED'
          ? ['phase', 'observedControls']
          : ['phase', 'observableQuestions', 'authorizedQuestions'];
      },
      getOwnPropertyDescriptor: (_target, key) => ({
        configurable: true,
        enumerable: true,
        writable: false,
        value: shape === 'INVALID_OBSERVED'
          ? key === 'phase' ? 'INVALID' : 7
          : key === 'phase' ? 'COMPOSED' : key === 'observableQuestions' ? 7 : 2,
      }),
    });
    expect(parsePilotUa5ProgressEvent(switching)).toBeNull();
    expect(ownKeysReads).toBe(1);
  });

  it('accepts only an exact HTTPS page-ready identity', () => {
    const hello = createPilotUa5ConnectedPageReady(
      'https://job-boards.greenhouse.io',
      '/company/jobs/42',
    );
    expect(hello).toEqual({
      kind: 'pilot-ua5/page-ready',
      version: 2,
      origin: 'https://job-boards.greenhouse.io',
      pathname: '/company/jobs/42',
    });
    expect(parsePilotUa5ConnectedPageReady({ ...hello, value: 'private' })).toBeNull();
    expect(createPilotUa5ConnectedPageReady('http://job-boards.greenhouse.io', '/x')).toBeNull();
    expect(createPilotUa5ConnectedPageReady('https://user@example.com', '/x')).toBeNull();
    expect(createPilotUa5ConnectedPageReady('https://example.com', '/x?secret=1')).toBeNull();
  });

  it('keeps the Panel wire value-free and rejects extra fields', () => {
    const request = Object.freeze({
      kind: 'pilot-ua5/start-current-page', version: 2, requestId: 'a'.repeat(32),
    });
    expect(parsePilotUa5PanelRequest(request)).toEqual(request);
    expect(parsePilotUa5PanelRequest({ ...request, url: 'https://private.invalid' })).toBeNull();
    expect(parsePilotUa5PanelRequest({ ...request, values: { email: 'private@example.com' } }))
      .toBeNull();

    expect(parsePilotUa5PanelEvent({
      kind: 'pilot-ua5/progress',
      version: 2,
      requestId: 'a'.repeat(32),
      event: { phase: 'OBSERVED', observedControls: 1 },
    })).not.toBeNull();
    expect(parsePilotUa5PanelEvent({
      kind: 'pilot-ua5/progress',
      version: 2,
      requestId: 'a'.repeat(32),
      event: { phase: 'OBSERVED', observedControls: 1, label: 'Email' },
    })).toBeNull();
    expect(parsePilotUa5PanelEvent({
      kind: 'pilot-ua5/profile-payload-result',
      version: 2,
      requestId: 'a'.repeat(32),
      response: pilotUa5ProfilePayloadFailure('PILOT_CAPABILITY_DISABLED'),
    })).toBeNull();
  });

  it('keeps per-leaf authorization and targeted Undo closed and value-free', () => {
    const writeCheck = createPilotUa5WriteCheckRequest('a'.repeat(32), 1, PROJECTION.binding, 'email');
    expect(parsePilotUa5WriteCheckRequest(writeCheck)).toEqual(writeCheck);
    expect(parsePilotUa5WriteCheckRequest({
      ...writeCheck,
      value: 'private@example.test',
    })).toBeNull();
    const grant = {
      kind: 'pilot-ua5/write-check-result',
      version: 2,
      requestId: 'a'.repeat(32),
      ordinal: 1,
      questionId: 'email',
      allowed: true,
      writeNotAfterMs: Number.MAX_SAFE_INTEGER,
    };
    expect(parsePilotUa5WriteCheckResult(grant)).toEqual(grant);
    expect(pilotUa5WriteCheckResultMessage('a'.repeat(32), 1, true, Number.MAX_SAFE_INTEGER, 'email')).toEqual(grant);

    const undo = createPilotUa5UndoRequest('b'.repeat(32), 'a'.repeat(32), 'email');
    expect(parsePilotUa5UndoRequest(undo)).toEqual(undo);
    expect(parsePilotUa5UndoRequest({ ...undo, previous: 'private@example.test' }))
      .toBeNull();
    const restored = {
      kind: 'pilot-ua5/undo-result',
      version: 2,
      requestId: 'b'.repeat(32),
      runRequestId: 'a'.repeat(32),
      questionId: 'email',
      status: 'RESTORED',
    };
    expect(parsePilotUa5UndoResult(restored)).toEqual(restored);
  });
});

describe('connected-dev sidepanel → background → content transport', () => {
  it.each(['connected', 'panel-closed', 'content-result-lost', 'unproven-result',
    'finish-false', 'finish-throw', 'tab-revoke', 'clock-revoke', 'recovery-expired', 'partial-write'] as const)(
    'retains canonical result with Undo frozen through %s', async (delivery) => {
    const projection: PilotUa5RunProjection = delivery === 'partial-write'
      ? { ...PROJECTION, rows: [{ questionId: 'email', required: true, state: 'POLICY_BLOCKED',
          reason: 'HOST_REJECTED', writeEffect: 'MAY_HAVE_CHANGED' }],
          summary: { ...PROJECTION.summary, requiredCompleted: 0 } } : PROJECTION;
    const extensionId = 'extension-id';
    const backgroundUrl = `chrome-extension://${extensionId}/background.js`;
    const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
    const backgroundConnect = event<(port: PilotUa5ConnectedPort) => void>();
    const contentConnect = event<(port: PilotUa5ConnectedPort) => void>();
    const settlementDenied = ['finish-false', 'finish-throw', 'tab-revoke', 'clock-revoke'].includes(delivery);
    let now = 1_000;
    const facts = { tabId: 42, ...projection.binding, targetUrlDigest: 'c'.repeat(64), pageEpoch: 0 };
    const leases = createPilotUa5ExactPageLeaseRegistry({ now: () => now, leaseMs: 100 });
    expect(leases.arm(facts)).toBe(true);
    const consumeUserAction = vi.fn(() => leases.consumePending(facts, DISCOVERY.requestId));
    const createDiscoveryRequest = vi.fn(async () => DISCOVERY);
    const consumeUndoAuthorization = vi.fn(() => leases.consumeUndo(facts, DISCOVERY.requestId));
    const revokeRunAuthorization = vi.fn((id: string) => leases.revokeRun(id));
    const panelMessages: unknown[] = [];
    const contentMessages: unknown[] = [];

    let panelPort: PilotUa5ConnectedPort;
    let retained: ReturnType<typeof pilotUa5ResultMessage> = null;
    const getCurrentResult = vi.fn(() => retained);
    const panelRuntime = {
      connect: ({ name }: { name: string }) => {
        const [panel, background] = asyncPortPair(name, { id: extensionId, url: sidepanelUrl });
        backgroundConnect.emit(background);
        panel.onMessage.addListener((message) => panelMessages.push(message));
        panelPort = panel;
        return panel;
      },
    };
    const tabs = {
      connect: vi.fn((_tabId: number, options: { name: string; frameId: number }) => {
        const [background, content] = asyncPortPair(options.name, { id: extensionId, url: backgroundUrl });
        if (delivery === 'content-result-lost' && retained === null) {
          const post = content.postMessage;
          content.postMessage = (message) => {
            if (parsePilotUa5PanelEvent(message)?.kind === 'pilot-ua5/result') {
              throw new Error('TEST_RESULT_DELIVERY_LOST');
            }
            post(message);
          };
        }
        contentConnect.emit(content);
        content.onMessage.addListener((message) => contentMessages.push(message));
        return background;
      }),
    };
    const runCurrentPage = vi.fn(async (_discovery, onProgress, ports) => {
      onProgress({ phase: 'OBSERVED', observedControls: 1 });
      const payload = await ports.resolveProfilePayloads(PROFILE_REQUEST);
      expect(payload).toEqual(boundPayload().payload);
      // Yield past the Profile response before the leaf fence, as Chrome ports do.
      await Promise.resolve();
      if (delivery !== 'unproven-result') expect(await ports.authorizeLeafWrite?.(projection.binding, 'email'))
        .toMatchObject({ allowed: true });
      if (delivery !== 'unproven-result') expect(await ports.isProfileCurrent({ profileBinding: boundPayload().payload.profileBinding, questionId: 'email', answerDigest: boundPayload().payload.payloads[0]!.answerDigest })).toBe(true);
      await Promise.resolve();
      if (delivery === 'tab-revoke') leases.revokeTab(42);
      if (delivery === 'clock-revoke') now = 999;
      if (delivery === 'panel-closed') panelPort.disconnect();
      onProgress({ phase: 'COMPOSED', observableQuestions: 1, authorizedQuestions: 1 });
      onProgress({ phase: 'SETTLED', requiredCompleted: projection.summary.requiredCompleted, requiredQuestions: 1 });
      retained = pilotUa5ResultMessage(DISCOVERY.requestId, { ok: true, projection: projection });
      return Object.freeze({ ok: true as const, projection: projection });
    });
    const undoCurrentPage = vi.fn(async () => 'RESTORED' as const);
    const finishRunAuthorization = vi.fn((id: string, keepUndo: boolean) => {
      const settled = leases.finishRun(id, keepUndo);
      // A faulty callback may mutate its registry before returning false/throwing.
      if (delivery === 'finish-throw') throw new Error('TEST_FINISH_UNAVAILABLE');
      return delivery === 'finish-false' ? false : settled;
    });
    const revalidateRun = vi.fn(async (_tabId, id, _discovery, binding) => {
      const writeNotAfterMs = leases.authorizeActive(facts, id, binding);
      return writeNotAfterMs === null ? false : { allowed: true as const, writeNotAfterMs };
    });

    expect(installPilotUa5ConnectedContent({
      enabled: true, extensionId, expectedBackgroundUrl: backgroundUrl,
      runtime: { onConnect: contentConnect },
      runCurrentPage,
      undoCurrentPage,
      getCurrentResult,
    })).toBe(true);
    expect(installPilotUa5ConnectedBackground({
      ...BACKGROUND_DEFAULTS,
      runtime: { onConnect: backgroundConnect },
      tabs,
      consumeUserAction, finishRunAuthorization, revokeRunAuthorization, consumeUndoAuthorization,
      hasRecoveryAuthorization: () => leases.hasRecovery(facts, DISCOVERY.requestId),
      revalidateRun, createDiscoveryRequest, now: () => now,
      resolveProfilePayloads: async () => boundPayload(),
      checkProfileCurrentness: async ({ check }) => ({ ok: true, schemaVersion: 1, kind: 'MATCH_AT_READ', check }),
    })).toBe(true);

    const requestIds = [DISCOVERY.requestId, 'a'.repeat(32)];
    const client = createPilotUa5PanelRuntimeClient({ runtime: panelRuntime,
      requestId: () => requestIds.shift() ?? 'f'.repeat(32), timeoutMs: 25 });
    const progress: unknown[] = [];
    const result = await client.runCurrentPage((event) => progress.push(event));

    expect(tabs.connect).toHaveBeenCalledWith(42, {
      name: PILOT_UA5_CONTENT_PORT_NAME,
      frameId: 0,
    });
    expect(runCurrentPage).toHaveBeenCalledWith(
      DISCOVERY,
      expect.any(Function),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        resolveProfilePayloads: expect.any(Function),
        authorizeLeafWrite: expect.any(Function),
      }),
    );
    if (delivery !== 'panel-closed') expect(progress).toEqual([
      { phase: 'OBSERVED', observedControls: 1 },
      { phase: 'COMPOSED', observableQuestions: 1, authorizedQuestions: 1 },
      { phase: 'SETTLED', requiredCompleted: projection.summary.requiredCompleted, requiredQuestions: 1 },
    ]);
    expect(result.ok).toBe(['connected', 'recovery-expired', 'partial-write'].includes(delivery));
    await vi.waitFor(() => expect(finishRunAuthorization).toHaveBeenCalledTimes(1));
    if (settlementDenied) {
      expect(result).toEqual({ ok: false, code: 'PILOT_UA5_WRITER_UNAVAILABLE' });
      await expect(client.undoCurrentPage('email')).resolves.toBe('UNAVAILABLE');
      expect(consumeUndoAuthorization).not.toHaveBeenCalled();
      const adapter = createProductPanelUa5Adapter({ runCurrentPage: async () => result });
      await expect(adapter.requestStartAutofill!({ kind: 'START_AUTOFILL' })).resolves.toEqual({
        ok: false, code: 'RECOVERY_REQUIRED',
      });
      expect(adapter.getSnapshot().run).toBeNull();
    }
    now = 1_050; // Recovering the clock must not resurrect a revoked run.
    // A newly mounted Panel has no previous UI state. Recovery reads content,
    // does not rerun discovery/Profile/leaf authorization or renew its deadline.
    const reopened = createPilotUa5PanelRuntimeClient({ runtime: panelRuntime,
      requestId: () => 'd'.repeat(32), timeoutMs: 50 });
    const checksBeforeRecovery = revalidateRun.mock.calls.length;
    const recovered = await reopened.recoverCurrentPage();
    expect(recovered.ok).toBe(!settlementDenied && delivery !== 'unproven-result');
    if (settlementDenied) expect(revokeRunAuthorization).toHaveBeenCalledExactlyOnceWith(DISCOVERY.requestId);
    if (recovered.ok) expect(recovered.projection).toEqual(projection);
    expect(getCurrentResult).toHaveBeenCalledTimes(1);
    expect(runCurrentPage).toHaveBeenCalledTimes(1);
    expect(revalidateRun).toHaveBeenCalledTimes(checksBeforeRecovery);
    expect(revalidateRun).toHaveBeenLastCalledWith(42, DISCOVERY.requestId, DISCOVERY, projection.binding);
    expect(finishRunAuthorization).toHaveBeenCalledTimes(1);
    expect(finishRunAuthorization).toHaveBeenCalledWith(DISCOVERY.requestId, delivery !== 'unproven-result');
    expect(consumeUserAction).toHaveBeenCalledTimes(1);
    expect(createDiscoveryRequest).toHaveBeenCalledTimes(1);
    // No run/scan/Profile/grant replay or Submit message can enter recovery.
    expect(contentMessages.map((message) => (message as { kind: string }).kind)).toEqual([
      'pilot-ua5/run-exact-page', 'pilot-ua5/profile-payload-result',
      ...(delivery === 'unproven-result' ? [] : ['pilot-ua5/write-check-result', 'pilot-ua5/profile-check-result']), 'pilot-ua5/get-current-result',
    ]);
    if (settlementDenied) expect(panelMessages.some((message) => {
      const event = parsePilotUa5PanelEvent(message);
      return event?.kind === 'pilot-ua5/result' && event.result.ok;
    })).toBe(false);
    if (delivery === 'recovery-expired') {
      now = 1_200; // Lookup at 1_050 did not renew consumeAt + 2 × leaseMs.
      expect(leases.hasRecovery(facts, DISCOVERY.requestId)).toBe(false);
    }
    await expect(reopened.undoCurrentPage('email')).resolves.toBe('UNAVAILABLE');
    expect(undoCurrentPage).not.toHaveBeenCalled();
    expect(consumeUndoAuthorization).not.toHaveBeenCalled();
    expect(PILOT_UA5_PANEL_PORT_NAME).toBe('edaix-pilot-ua5-panel-v2');
  });

  it.each(['wrong-sender', 'missing-tab', 'content-disconnect', 'disabled'] as const)(
    'fails closed for %s', async (failure) => {
    const backgroundConnect = event<(port: PilotUa5ConnectedPort) => void>();
    const contentConnect = vi.fn(({ name }: { name: string }) => {
      const [background, content] = asyncPortPair(name, undefined);
      content.onMessage.addListener(() => content.disconnect());
      return background;
    });
    const connect = vi.fn(({ name }: { name: string }) => {
      const [panel, background] = portPair(name, {
        id: 'extension-id',
        url: failure === 'wrong-sender' ? 'https://host.invalid/not-the-sidepanel'
          : BACKGROUND_DEFAULTS.expectedSidepanelUrl,
      });
      backgroundConnect.emit(background);
      return panel;
    });
    expect(installPilotUa5ConnectedBackground({
      ...BACKGROUND_DEFAULTS,
      enabled: failure !== 'disabled',
      runtime: { onConnect: backgroundConnect },
      tabs: { connect: (_tabId, options) => contentConnect(options) },
      selectActiveTab: async () => failure === 'missing-tab' ? null : 42,
    })).toBe(failure !== 'disabled');
    const client = createPilotUa5PanelRuntimeClient({
      runtime: { connect },
      requestId: () => 'd'.repeat(32),
      timeoutMs: 50,
    });
    await expect(client.runCurrentPage(() => {})).resolves.toEqual({
      ok: false,
      code: failure === 'missing-tab' ? 'PILOT_NOT_USER_TRIGGERED' : 'PILOT_CAPABILITY_DISABLED',
    });
    expect(contentConnect).toHaveBeenCalledTimes(failure === 'content-disconnect' ? 1 : 0);
    expect(installPilotUa5ConnectedContent({
      enabled: false,
      extensionId: 'extension-id',
      expectedBackgroundUrl: 'chrome-extension://extension-id/background.js',
      runtime: { onConnect: event<(port: PilotUa5ConnectedPort) => void>() },
      runCurrentPage: async () => ({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' }),
    })).toBe(false);
  });

  it('isolates a busy new run and a late old grant across content-port disconnect', async () => {
    const connects = event<(port: PilotUa5ConnectedPort) => void>();
    const signals: AbortSignal[] = [];
    const grants: PilotUa5LeafWriteAuthorization[] = [];
    installPilotUa5ConnectedContent({
      enabled: true, extensionId: 'extension-id',
      expectedBackgroundUrl: 'chrome-extension://extension-id/background.js',
      runtime: { onConnect: connects },
      runCurrentPage: async (_discovery, _progress, ports) => {
        signals.push(ports.signal);
        grants.push(await ports.authorizeLeafWrite!(PROJECTION.binding, 'email'));
        return { ok: false, code: 'PILOT_UA5_WRITER_UNAVAILABLE' };
      },
    });
    const open = (requestId: string) => {
      const [background, content] = portPair(PILOT_UA5_CONTENT_PORT_NAME, {
        id: 'extension-id', url: 'chrome-extension://extension-id/background.js',
      });
      connects.emit(content);
      background.postMessage(createPilotUa5ContentRunRequest(requestId, { ...DISCOVERY, requestId }));
      return background;
    };
    const old = open(DISCOVERY.requestId);
    open('c'.repeat(32)); // Busy rejection owns only its own port/controller.
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    old.disconnect();
    await vi.waitFor(() => expect(grants).toEqual([false]));
    const currentId = 'd'.repeat(32);
    const current = open(currentId);
    expect(signals).toHaveLength(2);
    old.postMessage(pilotUa5WriteCheckResultMessage(DISCOVERY.requestId, 1, true, Number.MAX_SAFE_INTEGER, 'email'));
    expect(signals[1]!.aborted).toBe(false);
    expect(grants).toEqual([false]);
    current.postMessage(pilotUa5WriteCheckResultMessage(currentId, 1, true, Number.MAX_SAFE_INTEGER, 'email'));
    await vi.waitFor(() => expect(grants).toEqual([
      false, { allowed: true, writeNotAfterMs: Number.MAX_SAFE_INTEGER },
    ]));
  });

  it('permits only one private Profile payload request per run', async () => {
    const extensionId = 'extension-id';
    const backgroundConnect = event<(port: PilotUa5ConnectedPort) => void>();
    const contentConnect = event<(port: PilotUa5ConnectedPort) => void>();
    const resolveProfilePayloads = vi.fn(async () =>
      ({ ...pilotUa5ProfilePayloadFailure('PILOT_CAPABILITY_DISABLED'), schemaVersion: 2 as const }));
    contentConnect.addListener((port) => {
      let requestId = '';
      let responseSeen = false;
      port.onMessage.addListener((message) => {
        const run = message as { kind?: unknown; requestId?: unknown };
        if (run.kind === 'pilot-ua5/run-exact-page' && typeof run.requestId === 'string') {
          requestId = run.requestId;
          port.postMessage(pilotUa5ProfilePayloadRequestMessage(requestId, PROFILE_REQUEST));
          return;
        }
        if (!responseSeen && run.kind === 'pilot-ua5/profile-payload-result') {
          responseSeen = true;
          setTimeout(() => {
            port.postMessage(pilotUa5ProfilePayloadRequestMessage(requestId, PROFILE_REQUEST));
          }, 0);
        }
      });
    });
    installPilotUa5ConnectedBackground({
      ...BACKGROUND_DEFAULTS,
      runtime: { onConnect: backgroundConnect },
      tabs: {
        connect: (_tabId, options) => {
          const [background, content] = portPair(options.name, {
            id: extensionId,
            url: `chrome-extension://${extensionId}/background.js`,
          });
          contentConnect.emit(content);
          return background;
        },
      },
      resolveProfilePayloads,
    });
    const client = createPilotUa5PanelRuntimeClient({
      runtime: {
        connect: ({ name }) => {
          const [panel, background] = portPair(name, {
            id: extensionId,
            url: `chrome-extension://${extensionId}/sidepanel.html`,
          });
          backgroundConnect.emit(background);
          return panel;
        },
      },
      requestId: () => '9'.repeat(32),
      timeoutMs: 1_000,
    });

    await expect(client.runCurrentPage(() => {})).resolves.toEqual({
      ok: false,
      code: 'PILOT_CAPABILITY_DISABLED',
    });
    expect(resolveProfilePayloads).toHaveBeenCalledTimes(1);
  });
});

it('rejects legacy Undo directly in background before consuming authority or opening content', () => {
  const onConnect = event<(port: PilotUa5ConnectedPort) => void>();
  const connect = vi.fn();
  const consumeUndoAuthorization = vi.fn(async () => true);
  installPilotUa5ConnectedBackground({ ...BACKGROUND_DEFAULTS,
    runtime: { onConnect }, tabs: { connect }, consumeUndoAuthorization,
  });
  const [panel, background] = portPair(PILOT_UA5_PANEL_PORT_NAME, {
    id: 'extension-id', url: 'chrome-extension://extension-id/sidepanel.html',
  });
  const responses: unknown[] = [];
  panel.onMessage.addListener((value) => responses.push(value));
  onConnect.emit(background);
  panel.postMessage(createPilotUa5UndoRequest('a'.repeat(32), DISCOVERY.requestId, 'email'));
  expect(responses).toEqual([expect.objectContaining({ kind: 'pilot-ua5/undo-result', status: 'UNAVAILABLE' })]);
  expect(consumeUndoAuthorization).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

it('rejects legacy Undo directly in content even with an injected restore callback', () => {
  const onConnect = event<(port: PilotUa5ConnectedPort) => void>();
  const undoCurrentPage = vi.fn(async () => 'RESTORED' as const);
  const runCurrentPage = vi.fn();
  installPilotUa5ConnectedContent({ enabled: true, extensionId: 'extension-id',
    expectedBackgroundUrl: 'chrome-extension://extension-id/background.js',
    runtime: { onConnect }, runCurrentPage, undoCurrentPage,
  });
  const [background, content] = portPair(PILOT_UA5_CONTENT_PORT_NAME, {
    id: 'extension-id', url: 'chrome-extension://extension-id/background.js',
  });
  const responses: unknown[] = [];
  background.onMessage.addListener((value) => responses.push(value));
  onConnect.emit(content);
  background.postMessage(createPilotUa5UndoRequest('a'.repeat(32), DISCOVERY.requestId, 'email'));
  expect(responses).toEqual([expect.objectContaining({ kind: 'pilot-ua5/undo-result', status: 'UNAVAILABLE' })]);
  expect(undoCurrentPage).not.toHaveBeenCalled();
  expect(runCurrentPage).not.toHaveBeenCalled();
});

it('P1 requires v2, a question on the page grant, and the exact profile check echo', async () => {
  const protocol = await import('../lib/pilotUa5ConnectedProtocol');
  expect(protocol.PILOT_UA5_CONNECTED_PROTOCOL_VERSION).toBe(2);
  const check = { runRequestId: 'a'.repeat(32), ordinal: 1, binding: PROJECTION.binding,
    profileBinding: { fieldSchemaVersion: 1, fieldKeys: ['email'], revision: '1', deletionEpoch: '0', snapshotDigest: `sha256:${'a'.repeat(64)}` },
    questionId: 'email', answerDigest: 'a'.repeat(64) };
  const message = protocol.pilotUa5ProfileCheckRequestMessage(check);
  expect(message).toMatchObject({ kind: 'pilot-ua5/profile-check', version: 2, requestId: check.runRequestId, check });
  expect(protocol.parsePilotUa5ProfileCheckRequest({ ...message, requestId: 'b'.repeat(32) })).toBeNull();
  expect(protocol.parsePilotUa5ProfileCheckRequest({ ...message, originalBindingSeal: 'private' })).toBeNull();
  expect(protocol.parsePilotUa5ProfileCheckResult({ kind: 'pilot-ua5/profile-check-result', version: 2,
    requestId: check.runRequestId, ordinal: 2, result: { ok: true, schemaVersion: 1, kind: 'MATCH_AT_READ', check } })).toBeNull();
  expect(parsePilotUa5WriteCheckRequest({ kind: 'pilot-ua5/write-check', version: 2, requestId: check.runRequestId, ordinal: 1, binding: check.binding })).toBeNull();
});
