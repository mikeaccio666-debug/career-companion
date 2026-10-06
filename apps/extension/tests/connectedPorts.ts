import type { PilotUa5ConnectedPort } from '../lib/pilotUa5ConnectedProtocol';

export function event<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener(listener: T) { listeners.add(listener); },
    removeListener(listener: T) { listeners.delete(listener); },
    emit(...args: Parameters<T>) {
      for (const listener of [...listeners]) listener(...args);
    },
    size: () => listeners.size,
  };
}

/** Queued delivery models Chrome ports; synchronous mode probes reentrancy. */
export function portPair(
  name: string,
  sender: PilotUa5ConnectedPort['sender'],
  queued = false,
): readonly [PilotUa5ConnectedPort, PilotUa5ConnectedPort] {
  const messages = [event<(message: unknown) => void>(), event<(message: unknown) => void>()] as const;
  const disconnects = [event<() => void>(), event<() => void>()] as const;
  let disconnected = false;
  const deliver = (callback: () => void) => queued ? queueMicrotask(callback) : callback();
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    deliver(() => { disconnects[0].emit(); disconnects[1].emit(); });
  };
  const makePort = (side: 0 | 1): PilotUa5ConnectedPort => ({
    name,
    ...(side === 1 ? { sender } : {}),
    postMessage(message) {
      if (queued && disconnected) throw new Error('TEST_PORT_DISCONNECTED');
      deliver(() => messages[side === 0 ? 1 : 0].emit(message));
    },
    onMessage: messages[side],
    onDisconnect: disconnects[side],
    disconnect,
  });
  return [makePort(0), makePort(1)];
}

export const asyncPortPair = (name: string, sender: PilotUa5ConnectedPort['sender']) =>
  portPair(name, sender, true);

export function respondingPort(respond: (message: unknown, emit: (message: unknown) => void) => void) {
  const [client, server] = portPair('edaix-pilot-ua5-panel-v2', undefined);
  server.onMessage.addListener((message) => respond(message, (response) => server.postMessage(response)));
  return client;
}
