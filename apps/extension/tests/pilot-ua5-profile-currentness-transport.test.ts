import { describe, expect, it, vi } from 'vitest';
import { parsePilotUa5BoundProfilePayloadResponse } from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import { parsePilotUa5ProfileCheck, type PilotUa5ProfileCheck } from '@edaix/contracts/draft/pilot-ua5-profile-currentness';
import { success, binding, request as profileRequest } from './pilotUa5Fixtures';
import { event, portPair } from './connectedPorts';
import { createPilotUa1DiscoveryRequest } from '../lib/pilotUa1DiscoveryProtocol';
import { installPilotUa5ConnectedContent, type PilotUa5ConnectedRunCurrentPage } from '../connected-dev/contentRuntime';
import { installPilotUa5ConnectedBackground } from '../connected-dev/backgroundRuntime';
import {
  PILOT_UA5_CONTENT_PORT_NAME, PILOT_UA5_PANEL_PORT_NAME, createPilotUa5ContentRunRequest,
  createPilotUa5WriteCheckRequest, pilotUa5WriteCheckResultMessage,
  parsePilotUa5ProfileCheckRequest, pilotUa5ProfileCheckResultMessage, pilotUa5ProfileCheckRequestMessage,
  pilotUa5ProfilePayloadRequestMessage, parsePilotUa5WriteCheckRequest,
  type PilotUa5ConnectedPort,
} from '../lib/pilotUa5ConnectedProtocol';

const id = 'a'.repeat(32), extensionId = 'extension-id', backgroundUrl = `chrome-extension://${extensionId}/background.js`;
const discovery = createPilotUa1DiscoveryRequest({ pageUrl: `${binding.origin}${binding.pathname}`, requestId: id,
  issuedAtMs: 1_000, targetUrlDigest: 'a'.repeat(64) })!;
const bound = () => {
  const parsed = parsePilotUa5BoundProfilePayloadResponse({ ok: true, schemaVersion: 2, payload: success(), originalBindingSeal: 'e30.e30.AA' });
  if (!parsed.ok || !parsed.value.ok) throw new Error('TEST_FIXTURE_INVALID');
  return parsed.value;
};
const checkOf = (ordinal = 1) => parsePilotUa5ProfileCheck({ runRequestId: id, ordinal, binding,
  profileBinding: bound().payload.profileBinding, questionId: 'question.email', answerDigest: bound().payload.payloads[0]!.answerDigest })!;
const failure = { ok: false, code: 'PILOT_UA5_WRITER_UNAVAILABLE' } as const;
const expected = () => ({ profileBinding: checkOf().profileBinding, questionId: checkOf().questionId, answerDigest: checkOf().answerDigest });

function contentHarness(run: PilotUa5ConnectedRunCurrentPage, respond?: (message: unknown, port: PilotUa5ConnectedPort) => void) {
  const connects = event<(port: PilotUa5ConnectedPort) => void>();
  const [background, content] = portPair(PILOT_UA5_CONTENT_PORT_NAME, { id: extensionId, url: backgroundUrl });
  const sent: unknown[] = [];
  background.onMessage.addListener((message) => { sent.push(message); respond?.(message, background); });
  installPilotUa5ConnectedContent({ enabled: true, extensionId, expectedBackgroundUrl: backgroundUrl,
    runtime: { onConnect: connects }, runCurrentPage: run });
  connects.emit(content);
  background.postMessage(createPilotUa5ContentRunRequest(id, discovery));
  return { background, sent };
}
const grantPage = (message: unknown, port: PilotUa5ConnectedPort) => {
  const page = parsePilotUa5WriteCheckRequest(message);
  if (page) port.postMessage(pilotUa5WriteCheckResultMessage(id, page.ordinal, true, 31_000, page.questionId));
};

describe('P1 content phase consumption', () => {
  it('waits for the page grant, consumes the full match once and closes on replay', async () => {
    const allowed: boolean[] = [];
    let duplicate: unknown;
    const h = contentHarness(async (_d, _p, ports) => {
      expect(await ports.authorizeLeafWrite!(binding, 'question.email')).toMatchObject({ allowed: true });
      allowed.push(await ports.isProfileCurrent!(expected()));
      // The same successful response cannot fulfill a second pending question.
      h.background.postMessage(duplicate);
      allowed.push(await ports.isProfileCurrent!(expected()));
      return failure;
    }, (message, port) => {
      grantPage(message, port);
      const check = parsePilotUa5ProfileCheckRequest(message);
      if (check) {
        duplicate = pilotUa5ProfileCheckResultMessage(id, check.check.ordinal, { ok: true, schemaVersion: 1, kind: 'MATCH_AT_READ', check: check.check });
        port.postMessage(duplicate);
      }
    });
    await vi.waitFor(() => expect(allowed).toEqual([true, false]));
    expect(h.sent.filter((m) => parsePilotUa5ProfileCheckRequest(m))).toHaveLength(1);
  });
  it.each(['question', 'digest', 'page', 'profile', 'ordinal', 'run', 'version'])('rejects a %s mismatch without allowing a leaf', async (mutation) => {
    const allowed: boolean[] = [];
    contentHarness(async (_d, _p, ports) => {
      await ports.authorizeLeafWrite!(binding, 'question.email');
      allowed.push(await ports.isProfileCurrent!(expected()));
      expect(ports.signal.aborted).toBe(true);
      return failure;
    }, (message, port) => {
      grantPage(message, port);
      const checked = parsePilotUa5ProfileCheckRequest(message);
      if (!checked) return;
      const check = structuredClone(checked.check);
      if (mutation === 'question') Object.assign(check, { questionId: 'other' });
      if (mutation === 'digest') Object.assign(check, { answerDigest: 'd'.repeat(64) });
      if (mutation === 'page') Object.assign(check.binding, { pathname: '/other' });
      if (mutation === 'profile') Object.assign(check.profileBinding, { revision: '8' });
      if (mutation === 'ordinal') Object.assign(check, { ordinal: 2 });
      if (mutation === 'run') Object.assign(check, { runRequestId: 'b'.repeat(32) });
      const response = { kind: 'pilot-ua5/profile-check-result', version: mutation === 'version' ? 1 : 2,
        requestId: check.runRequestId, ordinal: check.ordinal, result: { ok: true, schemaVersion: 1, kind: 'MATCH_AT_READ', check } };
      port.postMessage(response);
    });
    await vi.waitFor(() => expect(allowed).toEqual([false]));
  });
  it.each(['before page', 'double pending', 'disconnect', 'timeout'])('rejects %s and retires the pending proof', async (mode) => {
    vi.useFakeTimers();
    try {
      const allowed: boolean[] = [];
      const h = contentHarness(async (_d, _p, ports) => {
        if (mode !== 'before page') await ports.authorizeLeafWrite!(binding, 'question.email');
        const first = ports.isProfileCurrent!(expected());
        if (mode === 'double pending') allowed.push(await ports.isProfileCurrent!(expected()));
        allowed.push(await first);
        return failure;
      }, grantPage);
      await vi.advanceTimersByTimeAsync(0);
      if (mode === 'disconnect') h.background.disconnect();
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(6_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(allowed).toEqual(mode === 'double pending' ? [false, false] : [false]);
      h.background.postMessage(pilotUa5ProfileCheckResultMessage(id, 1, { ok: true, schemaVersion: 1, kind: 'MATCH_AT_READ', check: checkOf() }));
      await vi.advanceTimersByTimeAsync(0);
      expect(allowed.every((value) => value === false)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

function backgroundHarness(checker: NonNullable<Parameters<typeof installPilotUa5ConnectedBackground>[0]['checkProfileCurrentness']>) {
  const connects = event<(port: PilotUa5ConnectedPort) => void>();
  let content!: PilotUa5ConnectedPort;
  const messages: unknown[] = [];
  const state = { allowed: true, now: 1_000 };
  const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  installPilotUa5ConnectedBackground({ enabled: true, extensionId, expectedSidepanelUrl: sidepanelUrl,
    runtime: { onConnect: connects }, now: () => state.now,
    tabs: { connect: (_tab, options) => {
      const [bg, host] = portPair(options.name, { id: extensionId, url: backgroundUrl }); content = host;
      host.onMessage.addListener((message) => { messages.push(message);
        if ((message as { kind: string }).kind === 'pilot-ua5/run-exact-page') host.postMessage(pilotUa5ProfilePayloadRequestMessage(id, profileRequest)); });
      return bg;
    } },
    probeApiHealth: async () => true, hasAuthToken: async () => true, selectActiveTab: async () => 1,
    isLiveWriteAuthorized: () => state.allowed, hasSiteAccess: () => true, isPageRegistered: () => true, hasUserAction: () => true,
    consumeUserAction: () => true, revalidateRun: () => state.allowed ? { allowed: true, writeNotAfterMs: 31_000 } : false,
    finishRunAuthorization: () => true, revokeRunAuthorization: () => {}, consumeUndoAuthorization: () => false,
    createDiscoveryRequest: async () => discovery, resolveProfilePayloads: async () => bound(), checkProfileCurrentness: checker,
  });
  const [panel, bg] = portPair(PILOT_UA5_PANEL_PORT_NAME, { id: extensionId, url: sidepanelUrl });
  connects.emit(bg); panel.postMessage({ kind: 'pilot-ua5/start-current-page', version: 2, requestId: id });
  return { state, messages, content: () => content };
}
describe('P1 background holds original source and rechecks runtime', () => {
  it.each(['match', 'runtime revoked', 'deadline', 'wrong echo', 'disconnect'])('settles %s with a fresh read and no seal in content messages', async (mode) => {
    let complete!: (value: unknown) => void;
    const check = vi.fn((_request: unknown, _deadline: number) => new Promise((resolve) => { complete = resolve; }));
    const h = backgroundHarness(check as never);
    await vi.waitFor(() => expect(h.messages.some((m) => (m as { kind: string }).kind === 'pilot-ua5/profile-payload-result')).toBe(true));
    h.content().postMessage(createPilotUa5WriteCheckRequest(id, 1, binding, 'question.email'));
    await vi.waitFor(() => expect(h.messages.some((m) => (m as { kind: string }).kind === 'pilot-ua5/write-check-result')).toBe(true));
    h.content().postMessage(pilotUa5ProfileCheckRequestMessage(checkOf()));
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(check.mock.calls[0]?.[0]).toMatchObject({ originalBindingSeal: bound().originalBindingSeal, check: checkOf() });
    if (mode === 'runtime revoked') h.state.allowed = false;
    if (mode === 'deadline') h.state.now = 31_000;
    if (mode === 'disconnect') h.content().disconnect();
    complete({ ok: true, schemaVersion: 1, kind: 'MATCH_AT_READ', check: mode === 'wrong echo' ? { ...checkOf(), answerDigest: 'd'.repeat(64) } : checkOf() });
    await vi.waitFor(() => {
      const results = h.messages.filter((m) => (m as { kind: string }).kind === 'pilot-ua5/profile-check-result') as Array<{ result: { ok: boolean } }>;
      if (mode === 'disconnect') expect(results).toHaveLength(0);
      else expect(results.map((r) => r.result.ok)).toEqual([mode === 'match']);
    });
    expect(JSON.stringify(h.messages)).not.toContain(bound().originalBindingSeal);
    h.content().postMessage(pilotUa5ProfileCheckRequestMessage(checkOf()));
    expect(check).toHaveBeenCalledTimes(1);
  });
});
