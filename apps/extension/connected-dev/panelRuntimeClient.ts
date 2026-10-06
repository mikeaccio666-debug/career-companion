import type { PilotUa5ProgressEvent, PilotUa5RunResult } from '../lib/pilotUa5Orchestrator';
import {
  PILOT_UA5_PANEL_PORT_NAME,
  createPilotUa5PanelRequest,
  createPilotUa5CurrentResultRequest,
  createPilotUa5ReadinessRequest,
  createPilotUa5ContinueOfferRequest,
  createPilotUa5ContinueRequest,
  parsePilotUa5ContinueOfferMessage,
  parsePilotUa5RescanResultMessage,
  parsePilotUa5PanelEvent,
  parsePilotUa5ReadinessEvent,
  pilotUa5ConnectedFailure,
  type PilotUa5ConnectedPort,
  type PilotUa5ReadinessStatus,
  type PilotUa5ContinueOffer,
  type PilotUa5ReadOnlyScanResult,
} from '../lib/pilotUa5ConnectedProtocol';

export function createPilotUa5PanelRuntimeClient(input: Readonly<{
  runtime: Readonly<{
    connect(options: { name: string }): PilotUa5ConnectedPort;
  }>;
  requestId?: () => string;
  timeoutMs?: number;
}>) {
  const timeoutMs = input.timeoutMs ?? 30_000;
  let pending = false;
  let currentRunRequestId: string | null = null;
  let continueOffer: PilotUa5ContinueOffer | null = null;
  // One bounded port subscription per operation. Parsers
  // remain operation-specific; there is no shared dispatch or authority store.
  const receive = async <T>(
    createRequest: (requestId: string) => unknown,
    read: (message: unknown, requestId: string) => T | undefined,
    unavailable: T,
  ): Promise<T> => {
    let requestId: string;
    let request: unknown;
    let port: PilotUa5ConnectedPort;
    try {
      requestId = (input.requestId ?? randomRequestId)();
      request = createRequest(requestId);
      if (request === null || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
        return unavailable;
      }
      port = input.runtime.connect({ name: PILOT_UA5_PANEL_PORT_NAME });
    } catch { return unavailable; }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        port.onMessage.removeListener?.(onMessage);
        port.onDisconnect.removeListener?.(onDisconnect);
        try { port.disconnect(); } catch { /* Delivery carries no write authority. */ }
        resolve(result);
      };
      const onMessage = (message: unknown) => {
        let result: T | undefined;
        try { result = read(message, requestId); } catch { result = unavailable; }
        if (result !== undefined) finish(result);
      };
      const onDisconnect = () => finish(unavailable);
      const timer = setTimeout(onDisconnect, timeoutMs);
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      try { port.postMessage(request); } catch { onDisconnect(); }
    });
  };
  const receiveResult = async (
    recovery: boolean,
    onProgress: (event: PilotUa5ProgressEvent) => void,
  ): Promise<PilotUa5RunResult> => {
    if (pending) return pilotUa5ConnectedFailure();
    pending = true;
    currentRunRequestId = null;
    continueOffer = null;
    try { return await receive(
    recovery ? createPilotUa5CurrentResultRequest : createPilotUa5PanelRequest,
    (message, requestId) => {
      const event = parsePilotUa5PanelEvent(message);
      if (event === null || (!recovery && event.requestId !== requestId)) return pilotUa5ConnectedFailure();
      if (event.kind === 'pilot-ua5/progress') {
        if (recovery) return pilotUa5ConnectedFailure();
        try { onProgress(event.event); } catch { /* Presentation only. */ }
        return undefined;
      }
      if (event.result.ok) currentRunRequestId = event.requestId;
      return event.result;
    },
    pilotUa5ConnectedFailure(),
    ); } finally { pending = false; }
  };
  const client = {
    probeReadiness: (): Promise<Exclude<PilotUa5ReadinessStatus, 'CHECKING'>> => receive(
      createPilotUa5ReadinessRequest,
      (message, requestId) => {
        const event = parsePilotUa5ReadinessEvent(message);
        return event?.requestId === requestId ? event.status : 'API_UNREACHABLE';
      },
      'API_UNREACHABLE',
    ),
    runCurrentPage: (onProgress: (event: PilotUa5ProgressEvent) => void) => receiveResult(false, onProgress),
    recoverCurrentPage: () => receiveResult(true, () => {}),
    async getContinueOffer(): Promise<PilotUa5ContinueOffer | null> {
      const runRequestId = currentRunRequestId;
      if (pending || runRequestId === null) return null;
      const offer = await receive(
        (requestId) => createPilotUa5ContinueOfferRequest(requestId, runRequestId),
        (message, requestId) => {
          const event = parsePilotUa5ContinueOfferMessage(message);
          return event?.requestId === requestId && event.runRequestId === runRequestId ? event.offer : null;
        }, null,
      );
      if (currentRunRequestId !== runRequestId) return null;
      continueOffer = offer;
      return offer;
    },
    async continueReadOnly(intentId: string): Promise<PilotUa5ReadOnlyScanResult> {
      const failure = Object.freeze({ ok: false as const, code: 'PILOT_NOT_USER_TRIGGERED' as const });
      const runRequestId = currentRunRequestId;
      if (pending || runRequestId === null || continueOffer?.intentId !== intentId) return failure;
      // Correlation stays private to the client; one UI intent cannot be retried.
      currentRunRequestId = null;
      continueOffer = null;
      pending = true;
      try {
        return await receive<PilotUa5ReadOnlyScanResult>(
          (requestId) => createPilotUa5ContinueRequest(requestId, runRequestId, intentId),
          (message, requestId) => {
            const event = parsePilotUa5RescanResultMessage(message);
            return event?.requestId === requestId && event.runRequestId === runRequestId ? event.result : failure;
          }, failure,
        );
      } finally { pending = false; }
    },
    async undoCurrentPage(_questionId: string): Promise<'RESTORED' | 'UNAVAILABLE'> {
      return 'UNAVAILABLE';
    },
  };
  return Object.freeze(client);
}

function randomRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
