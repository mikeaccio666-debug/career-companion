/**
 * Isolated-world half of the narrow React compatibility bridge.
 *
 * A valid WriteTicket and active authority are required even though the bridge
 * itself only emits an opaque event. That keeps it impossible to turn this
 * transport into a page-visible automation trigger outside an approved Fill.
 */

import type { ApplyWritableElement } from '../contracts';
import { checkActiveCapability, type HostWriteAuthority } from '../grant';
import type { WriteTicket } from '../undo';
import {
  APPLY_MAIN_WORLD_REQUEST_EVENT,
  APPLY_MAIN_WORLD_RESPONSE_EVENT,
  isMainWorldResponse,
  type MainWorldRequest,
} from './mainWorldProtocol';

export const MAIN_WORLD_BRIDGE_TIMEOUT_MS = 3_000;

export type MainWorldBridgeOutcome =
  | 'handled'
  | 'no-handler'
  | 'stale'
  | 'timeout'
  | 'aborted'
  | 'unavailable'
  | 'invalid';

export interface MainWorldBridge {
  readonly settled: Promise<MainWorldBridgeOutcome>;
  abort(): void;
}

export interface BeginMainWorldBridgeOptions {
  /** Test seam only; production always keeps the bounded three-second deadline. */
  readonly timeoutMs?: number;
}

export type BeginMainWorldBridge = (
  target: HTMLInputElement | HTMLTextAreaElement,
  authority: HostWriteAuthority,
  ticket: WriteTicket,
  options?: BeginMainWorldBridgeOptions,
) => MainWorldBridge;

let requestSequence = 0;

function unavailableBridge(): MainWorldBridge {
  return { settled: Promise.resolve('unavailable'), abort: () => undefined };
}

function nextRequestId(): string {
  requestSequence += 1;
  const words = new Uint32Array(2);
  try {
    globalThis.crypto.getRandomValues(words);
    return `vibe-main-${words[0]!.toString(36)}-${words[1]!.toString(36)}-${requestSequence.toString(36)}`;
  } catch {
    // The id is correlation, never authorization. A monotonic fallback keeps
    // non-browser unit tests fail-closed without inventing a value channel.
    return `vibe-main-fallback-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
  }
}

function responseRequestId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = (value as { requestId?: unknown }).requestId;
  return typeof candidate === 'string' ? candidate : null;
}

function dispatchRequest(target: EventTarget, detail: MainWorldRequest): void {
  target.dispatchEvent(
    new CustomEvent(APPLY_MAIN_WORLD_REQUEST_EVENT, {
      bubbles: false,
      composed: false,
      detail,
    }),
  );
}

/**
 * Start the bridge while the native value is still present on the target.
 * Completion is deliberately not a success verdict: C6 still reads the DOM
 * after this promise settles. If no MAIN listener accepts synchronously, the
 * caller immediately falls back to the normal native event path.
 */
export const beginMainWorldReactChange: BeginMainWorldBridge = (
  target,
  authority,
  ticket,
  options = {},
): MainWorldBridge => {
  void ticket;
  const access = checkActiveCapability(authority, 'set-text');
  if (!access.ok || !target.isConnected) return unavailableBridge();

  const requestId = nextRequestId();
  const timeoutMs = options.timeoutMs ?? MAIN_WORLD_BRIDGE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return unavailableBridge();

  const controller = new AbortController();
  let accepted = false;
  let cancelSent = false;
  let finished = false;
  let resolveSettled: (outcome: MainWorldBridgeOutcome) => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const settled = new Promise<MainWorldBridgeOutcome>((resolve) => {
    resolveSettled = resolve;
  });

  const sendCancel = () => {
    if (!accepted || cancelSent || !target.isConnected) return;
    cancelSent = true;
    try {
      dispatchRequest(target, { requestId, action: 'cancel' });
    } catch {
      // A detached or hostile page may reject dispatch. Either way, this
      // isolated side is already closed and C6 remains the final verdict.
    }
  };

  const finish = (outcome: MainWorldBridgeOutcome, cancelMain = false) => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimeout(timer);
    target.removeEventListener(APPLY_MAIN_WORLD_RESPONSE_EVENT, onResponse);
    controller.signal.removeEventListener('abort', onAbort);
    if (cancelMain) sendCancel();
    resolveSettled(outcome);
  };

  const onAbort = () => finish('aborted', true);
  const onResponse = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (responseRequestId(detail) !== requestId) return;
    if (!isMainWorldResponse(detail)) {
      // A page can observe and forge this public transport. Before a listener
      // has accepted the request, malformed terminal data proves nothing and
      // must not suppress the real MAIN listener later in the capture path.
      if (accepted) finish('invalid', true);
      return;
    }
    if (detail.status === 'accepted') {
      accepted = true;
      return;
    }
    // MAIN always synchronously accepts before it can emit a terminal status.
    // Ignore an early forged terminal response; it cannot become a success or
    // prevent the bounded timeout/cancel path from closing the real request.
    if (!accepted) return;
    finish(detail.status);
  };

  target.addEventListener(APPLY_MAIN_WORLD_RESPONSE_EVENT, onResponse);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(() => finish('timeout', true), timeoutMs);

  try {
    dispatchRequest(target, { requestId, action: 'react-change' });
  } catch {
    finish('unavailable');
  }
  // MAIN receives the request during dispatch and must synchronously prove it
  // installed a listener. Do not hold a Fill for three seconds merely because
  // content-script ordering happened to run isolated world first.
  if (!finished && !accepted) finish('unavailable');

  return {
    settled,
    // Runner calls this again after C6 even when a terminal ACK already
    // arrived. That final cancel is what stops a real MAIN retry if a page
    // forged the earlier response while the request was still propagating.
    abort: () => {
      if (finished) sendCancel();
      else controller.abort();
    },
  };
};
