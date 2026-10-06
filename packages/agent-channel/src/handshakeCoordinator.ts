import {
  CHANNEL_PROTOCOL_VERSION,
  EXTENSION_SUPPORTED_CHANNEL_CAPABILITIES,
  EXTENSION_CONNECTION_READINESS_STATES,
  parseChannelMessage,
  type ChannelCapability,
  type ChannelCommand,
  type ChannelErrorCode,
  type ExtensionConnectionReadinessState,
} from '@edaix/contracts/draft';

import type { ChannelTransport } from './transport';

export interface ExtensionHandshakeCoordinatorDeps {
  readonly transport: ChannelTransport;
  readonly extensionVersion: () => string;
  readonly readReadiness: (
    expectedOwnerId: string,
  ) => Promise<ExtensionConnectionReadinessState>;
  readonly onProtocolError?: (code: ChannelErrorCode) => void;
  readonly now?: () => number;
}

export interface ExtensionHandshakeCoordinator {
  /** 同 port、同 request 的 READY 能力票只可消费一次。 */
  consumeReady(clientRequestId: string, capability: ChannelCapability): boolean;
  dispose(): void;
}

const READINESS_SET: ReadonlySet<string> =
  new Set(EXTENSION_CONNECTION_READINESS_STATES);
const READY_GRANT_TTL_MS = 30_000;
// A port never evicts a used correlation: eviction would let an old hello be
// replayed as new. Once the bounded set is full, that port fails closed until
// it is disconnected and a fresh coordinator is created.
const MAX_TRACKED_HANDSHAKES = 256;
type ChannelHello = Extract<ChannelCommand, { readonly kind: 'channel/hello' }>;

interface AdmittedHello {
  readonly hello: ChannelHello;
  readonly extensionVersion: string;
}

/**
 * Extension 侧的认证握手。它只回传 binary capability 与闭集 readiness，
 * 不把 owner/install id、token 或任意凭证回显给 Portal。
 */
export function createExtensionHandshakeCoordinator(
  deps: ExtensionHandshakeCoordinatorDeps,
): ExtensionHandshakeCoordinator {
  let disposed = false;
  // One coordinator belongs to one external port. At most one authority read
  // may be in flight for that port, and a flood retains only its latest hello.
  let activeOwnerId: string | undefined;
  let latestHello: AdmittedHello | undefined;
  let correlationCapacityExhausted = false;
  const seenHelloIds = new Set<string>();
  const now = deps.now ?? Date.now;
  const readyGrants = new Map<string, {
    readonly capabilities: ReadonlySet<ChannelCapability>;
    readonly expiresAt: number;
  }>();

  function readExtensionVersion(hello: ChannelHello): string | undefined {
    try {
      const extensionVersion = deps.extensionVersion();
      // Validate the binary proof before the live Auth/install readiness read.
      // A missing or hostile manifest therefore performs zero authority work.
      const proof = {
        v: CHANNEL_PROTOCOL_VERSION,
        kind: 'channel/ready',
        clientRequestId: hello.clientRequestId,
        extensionVersion,
        capabilities: [...EXTENSION_SUPPORTED_CHANNEL_CAPABILITIES],
        state: 'AUTHORITY_UNAVAILABLE',
      } as const;
      return parseChannelMessage(proof).ok ? extensionVersion : undefined;
    } catch {
      return undefined;
    }
  }

  function sendReady(
    admitted: AdmittedHello,
    state: ExtensionConnectionReadinessState,
  ): void {
    const ready = {
      v: CHANNEL_PROTOCOL_VERSION,
      kind: 'channel/ready',
      clientRequestId: admitted.hello.clientRequestId,
      extensionVersion: admitted.extensionVersion,
      // 只报本扩展**支持**的能力（2026-09-24）：门户据此选引导式还是浮层式填写。
      // 请求里点名了什么都不改变这份回答；认得一个词不等于会做那件事。
      capabilities: [...EXTENSION_SUPPORTED_CHANNEL_CAPABILITIES],
      state,
    } as const;
    if (!parseChannelMessage(ready).ok) return;
    if (state === 'READY') {
      let issuedAt: number;
      try {
        issuedAt = now();
      } catch {
        return;
      }
      const expiresAt = issuedAt + READY_GRANT_TTL_MS;
      if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return;
      // 能消费的票只是「请求点名了 ∩ 本扩展支持」的那几项：门户点名了一个我们不会做的能力，
      // 那一项就没有票可兑。
      const supported: ReadonlySet<ChannelCapability> = new Set(EXTENSION_SUPPORTED_CHANNEL_CAPABILITIES);
      readyGrants.set(admitted.hello.clientRequestId, {
        capabilities: new Set(admitted.hello.requiredCapabilities.filter((capability) => supported.has(capability))),
        expiresAt,
      });
    }
    try {
      deps.transport.send(ready);
    } catch {
      readyGrants.delete(admitted.hello.clientRequestId);
    }
  }

  function startAuthorityRead(expectedOwnerId: string): void {
    activeOwnerId = expectedOwnerId;
    void (async () => {
      let state: ExtensionConnectionReadinessState = 'AUTHORITY_UNAVAILABLE';
      try {
        const resolved = await deps.readReadiness(expectedOwnerId);
        if (READINESS_SET.has(resolved)) state = resolved;
      } catch {
        state = 'AUTHORITY_UNAVAILABLE';
      }
      if (disposed) return;

      const admitted = latestHello;
      activeOwnerId = undefined;
      if (admitted === undefined) return;
      if (admitted.hello.expectedOwnerId !== expectedOwnerId) {
        startAuthorityRead(admitted.hello.expectedOwnerId);
        return;
      }

      // The finished authority result is valid for the newest same-owner
      // hello. Earlier correlations are superseded and never receive an ACK.
      latestHello = undefined;
      sendReady(admitted, state);
    })();
  }

  const unsubscribe = deps.transport.onMessage((raw) => {
    if (disposed) return;
    const parsed = parseChannelMessage(raw);
    if (!parsed.ok) {
      deps.onProtocolError?.(parsed.code);
      return;
    }
    if (parsed.value.kind !== 'channel/hello') return;
    const hello = parsed.value;
    if (correlationCapacityExhausted || seenHelloIds.has(hello.clientRequestId)) {
      return;
    }
    if (seenHelloIds.size >= MAX_TRACKED_HANDSHAKES) {
      correlationCapacityExhausted = true;
      latestHello = undefined;
      readyGrants.clear();
      return;
    }
    seenHelloIds.add(hello.clientRequestId);
    // Every newer hello supersedes every older correlation on this port. Only
    // the latest legal request may receive a grant or ACK.
    readyGrants.clear();
    latestHello = undefined;
    const extensionVersion = readExtensionVersion(hello);
    if (extensionVersion === undefined) return;
    latestHello = { hello, extensionVersion };
    if (activeOwnerId === undefined) startAuthorityRead(hello.expectedOwnerId);
  });

  return {
    consumeReady(clientRequestId, capability) {
      const grant = readyGrants.get(clientRequestId);
      // Delete before evaluating so exceptions/reentrancy cannot replay it.
      readyGrants.delete(clientRequestId);
      if (grant === undefined || !Number.isFinite(grant.expiresAt)) return false;
      let observedAt: number;
      try {
        observedAt = now();
      } catch {
        return false;
      }
      return Number.isFinite(observedAt) &&
        grant.expiresAt > observedAt &&
        grant.capabilities.has(capability);
    },
    dispose() {
      disposed = true;
      activeOwnerId = undefined;
      latestHello = undefined;
      readyGrants.clear();
      seenHelloIds.clear();
      unsubscribe();
    },
  };
}
