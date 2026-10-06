/**
 * MAIN-world half of the React compatibility bridge.
 *
 * It owns no extension state and discovers nothing beyond the event target.
 * The target's current value is only held long enough to reject a stale
 * hydration retry; no value leaves this module through a response payload.
 */

import {
  APPLY_MAIN_WORLD_REQUEST_EVENT,
  APPLY_MAIN_WORLD_RESPONSE_EVENT,
  isMainWorldRequest,
  type MainWorldResponse,
} from './mainWorldProtocol';

type ReactChangeTarget = HTMLInputElement | HTMLTextAreaElement;
type ReactChangeHandler = (event: Event) => unknown;

export interface InstallMainWorldBridgeOptions {
  /** Test seams; the entrypoint always uses the bounded production defaults. */
  readonly retryDelayMs?: number;
  readonly hydrateTimeoutMs?: number;
}

interface PendingRequest {
  cancel(): void;
}

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_HYDRATE_TIMEOUT_MS = 3_000;

function isReactChangeTarget(value: EventTarget | null): value is ReactChangeTarget {
  return value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstChangeHandler(props: unknown): ReactChangeHandler | null {
  if (!isRecord(props)) return null;
  const onChange = props.onChange;
  if (typeof onChange === 'function') return onChange as ReactChangeHandler;
  return null;
}

function handlerOnTarget(target: ReactChangeTarget): ReactChangeHandler | null {
  for (const key of Object.getOwnPropertyNames(target)) {
    const value = Reflect.get(target, key) as unknown;
    if (key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$')) {
      const handler = firstChangeHandler(value);
      if (handler) return handler;
      continue;
    }
    if (!key.startsWith('__reactFiber$')) continue;
    if (!isRecord(value)) continue;
    const handler = firstChangeHandler(value.pendingProps) ?? firstChangeHandler(value.memoizedProps);
    if (handler) return handler;
  }
  return null;
}

function syntheticChangeEvent(target: ReactChangeTarget): Event {
  let defaultPrevented = false;
  let propagationStopped = false;
  const event = {
    type: 'change',
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    nativeEvent: new Event('input', { bubbles: true }),
    isTrusted: false,
    preventDefault() {
      defaultPrevented = true;
      event.defaultPrevented = true;
    },
    isDefaultPrevented: () => defaultPrevented,
    stopPropagation() {
      propagationStopped = true;
    },
    isPropagationStopped: () => propagationStopped,
    persist: () => undefined,
  } as Record<string, unknown>;
  Object.defineProperties(event, {
    target: { configurable: false, enumerable: true, value: target, writable: false },
    currentTarget: { configurable: false, enumerable: true, value: target, writable: false },
  });
  return new Proxy(event, {
    get(current, key, receiver) {
      return Reflect.get(current, key, receiver);
    },
  }) as unknown as Event;
}

function dispatchResponse(target: EventTarget, detail: MainWorldResponse): void {
  target.dispatchEvent(
    new CustomEvent(APPLY_MAIN_WORLD_RESPONSE_EVENT, {
      bubbles: false,
      composed: false,
      detail,
    }),
  );
}

/**
 * Install a target-only bridge listener. Its disposer is intentionally exposed
 * for tests; the MAIN entry registers exactly one instance for a document.
 */
export function installMainWorldBridge(
  hostDocument: Document,
  options: InstallMainWorldBridgeOptions = {},
): () => void {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const hydrateTimeoutMs = options.hydrateTimeoutMs ?? DEFAULT_HYDRATE_TIMEOUT_MS;
  const pendingByTarget = new WeakMap<ReactChangeTarget, Map<string, PendingRequest>>();

  const onRequest = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isMainWorldRequest(detail) || !isReactChangeTarget(event.target)) return;
    const target = event.target;
    const pending = pendingByTarget.get(target) ?? new Map<string, PendingRequest>();
    pendingByTarget.set(target, pending);

    if (detail.action === 'cancel') {
      pending.get(detail.requestId)?.cancel();
      return;
    }
    if (pending.has(detail.requestId)) return;

    const expectedValue = target.value;
    const deadline = Date.now() + hydrateTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let complete = false;
    const finish = (status: Extract<MainWorldResponse['status'], 'handled' | 'no-handler' | 'stale'>) => {
      if (complete) return;
      complete = true;
      if (timer !== null) clearTimeout(timer);
      pending.delete(detail.requestId);
      if (pending.size === 0) pendingByTarget.delete(target);
      if (target.isConnected) dispatchResponse(target, { requestId: detail.requestId, status });
    };
    const request: PendingRequest = {
      cancel: () => {
        if (complete) return;
        complete = true;
        if (timer !== null) clearTimeout(timer);
        pending.delete(detail.requestId);
        if (pending.size === 0) pendingByTarget.delete(target);
      },
    };
    pending.set(detail.requestId, request);
    dispatchResponse(target, { requestId: detail.requestId, status: 'accepted' });

    const attempt = () => {
      if (complete) return;
      if (!target.isConnected || target.value !== expectedValue) {
        finish('stale');
        return;
      }
      const handler = handlerOnTarget(target);
      if (handler) {
        try {
          handler(syntheticChangeEvent(target));
          finish('handled');
        } catch {
          finish('no-handler');
        }
        return;
      }
      if (Date.now() >= deadline) {
        finish('no-handler');
        return;
      }
      timer = setTimeout(attempt, retryDelayMs);
    };
    attempt();
  };

  hostDocument.addEventListener(APPLY_MAIN_WORLD_REQUEST_EVENT, onRequest, true);
  return () => hostDocument.removeEventListener(APPLY_MAIN_WORLD_REQUEST_EVENT, onRequest, true);
}
