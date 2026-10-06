import { describe, expect, it, vi } from 'vitest';

import { createChannelClient } from '../src/client';
import { createDiscoveryCoordinator } from '../src/discoveryCoordinator';
import { createExtensionHandshakeCoordinator } from '../src/handshakeCoordinator';
import { createMockTransportPair } from '../src/transport';

/** A future peer's inbound bytes are unknown. Keep ordinary send() typed. */
function createUnknownPeerPair() {
  const pair = createMockTransportPair();
  const inbound = new Set<(raw: unknown) => void>();
  return {
    chatSide: pair.chatSide,
    extensionSide: {
      send: pair.extensionSide.send,
      onMessage(handler: (raw: unknown) => void) {
        inbound.add(handler);
        return () => { inbound.delete(handler); };
      },
    },
    injectUnknown(raw: unknown) {
      queueMicrotask(() => { for (const handler of inbound) handler(raw); });
    },
  };
}

const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const MISSION_ID = '11111111-1111-4111-8111-111111111111';

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('authenticated Extension capability/version handshake', () => {
  // 2026-09-24：能力清单是协商用的词汇。门户多学了词（或点名了我们不会做的引导式填写），
  // 旧逻辑整条 hello 被当畸形丢掉、门户干等一分钟；现在照常回 READY，只报本扩展支持的那一份。
  it('answers a hello naming capabilities it does not support, or does not know, with its own supported set', async () => {
    const pair = createUnknownPeerPair();
    const readyEvents: unknown[] = [];
    pair.chatSide.onMessage((message) => readyEvents.push(message));
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.4.0',
      readReadiness: vi.fn(async () => 'READY' as const),
    });

    pair.injectUnknown({
      v: 1,
      kind: 'channel/hello',
      clientRequestId: 'future_portal',
      expectedOwnerId: OWNER_ID,
      requiredCapabilities: ['DISCOVERY_V1', 'FORM_PLAN_V1', 'GUIDED_AUTOFILL_V1', 'ZZZ_FUTURE_V9'],
    });
    await settle();
    await settle();

    expect(readyEvents).toEqual([{
      v: 1,
      kind: 'channel/ready',
      clientRequestId: 'future_portal',
      extensionVersion: '1.4.0',
      capabilities: ['DISCOVERY_V1', 'DOCK_AUTOFILL_V1'],
      state: 'READY',
    }]);
    // Only what was asked for and is supported can be spent; guided autofill never.
    expect(handshake.consumeReady('future_portal', 'GUIDED_AUTOFILL_V1')).toBe(false);
    handshake.dispose();

    const second = createUnknownPeerPair();
    const handshake2 = createExtensionHandshakeCoordinator({
      transport: second.extensionSide,
      extensionVersion: () => '1.4.0',
      readReadiness: vi.fn(async () => 'READY' as const),
    });
    second.injectUnknown({
      v: 1,
      kind: 'channel/hello',
      clientRequestId: 'future_portal_2',
      expectedOwnerId: OWNER_ID,
      requiredCapabilities: ['DISCOVERY_V1', 'ZZZ_FUTURE_V9'],
    });
    await settle();
    await settle();
    expect(handshake2.consumeReady('future_portal_2', 'DISCOVERY_V1')).toBe(true);
    handshake2.dispose();
  });

  it('uses a CSPRNG correlation and fails closed when it is unavailable', async () => {
    const pair = createMockTransportPair();
    const sent: unknown[] = [];
    pair.extensionSide.onMessage((message) => sent.push(message));
    const correlation = '30000000-0000-4000-8000-000000000001';
    const client = createChannelClient(pair.chatSide, undefined, {
      newDiscoveryRequestId: () => correlation,
    });
    expect(client.startDiscovery(MISSION_ID, '8', OWNER_ID)).toBe(correlation);
    await settle();
    expect(sent).toEqual([expect.objectContaining({
      kind: 'channel/hello',
      clientRequestId: correlation,
    })]);
    client.dispose();

    const unavailablePair = createMockTransportPair();
    const unavailableSent: unknown[] = [];
    unavailablePair.extensionSide.onMessage((message) => unavailableSent.push(message));
    const unavailable = createChannelClient(unavailablePair.chatSide, undefined, {
      newDiscoveryRequestId: () => { throw new Error('CSPRNG unavailable'); },
    });
    expect(unavailable.startDiscovery(MISSION_ID, '8', OWNER_ID)).toBe('');
    await settle();
    expect(unavailableSent).toEqual([]);
    unavailable.dispose();
  });

  it('never reuses a same-port discovery correlation after an ACK', async () => {
    const pair = createMockTransportPair();
    const sent: unknown[] = [];
    pair.extensionSide.onMessage((message) => sent.push(message));
    const client = createChannelClient(pair.chatSide);
    const requestId = 'same_owner_replay';
    expect(client.startDiscovery(MISSION_ID, '8', OWNER_ID, requestId)).toBe(requestId);
    pair.extensionSide.send({
      v: 1,
      kind: 'channel/ready',
      clientRequestId: requestId,
      extensionVersion: '1.0.0',
      capabilities: ['DISCOVERY_V1'],
      state: 'READY',
    });
    await settle();
    expect(client.startDiscovery(MISSION_ID, '9', OWNER_ID, requestId)).toBe('');
    expect(sent.filter((message) =>
      (message as { kind?: unknown }).kind === 'channel/hello')).toHaveLength(1);
    client.dispose();
  });

  it('coalesces a same-owner hello flood into one authority read and ACKs only the latest request', async () => {
    const pair = createMockTransportPair();
    const authority = deferred<'READY'>();
    const readiness = vi.fn(() => authority.promise);
    const readyEvents: unknown[] = [];
    pair.chatSide.onMessage((message) => readyEvents.push(message));
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.0.0',
      readReadiness: readiness,
    });

    for (let index = 0; index < 64; index += 1) {
      pair.chatSide.send({
        v: 1,
        kind: 'channel/hello',
        clientRequestId: `flood_${index}`,
        expectedOwnerId: OWNER_ID,
        requiredCapabilities: ['DISCOVERY_V1'],
      });
    }
    await settle();

    expect(readiness).toHaveBeenCalledTimes(1);
    authority.resolve('READY');
    await settle();

    expect(readiness).toHaveBeenCalledTimes(1);
    expect(readyEvents).toEqual([
      expect.objectContaining({
        kind: 'channel/ready',
        clientRequestId: 'flood_63',
        state: 'READY',
      }),
    ]);
    expect(handshake.consumeReady('flood_0', 'DISCOVERY_V1')).toBe(false);
    expect(handshake.consumeReady('flood_63', 'DISCOVERY_V1')).toBe(true);
    handshake.dispose();
  });

  it('rejects a duplicate hello before and after grant consumption on the Extension port', async () => {
    const pair = createMockTransportPair();
    const authority = deferred<'READY'>();
    const readiness = vi.fn(() => authority.promise);
    const readyEvents: unknown[] = [];
    pair.chatSide.onMessage((message) => readyEvents.push(message));
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.0.0',
      readReadiness: readiness,
    });
    const hello = {
      v: 1,
      kind: 'channel/hello',
      clientRequestId: 'extension_side_replay',
      expectedOwnerId: OWNER_ID,
      requiredCapabilities: ['DISCOVERY_V1'],
    } as const;

    pair.chatSide.send(hello);
    pair.chatSide.send(hello);
    await settle();
    expect(readiness).toHaveBeenCalledTimes(1);
    authority.resolve('READY');
    await settle();
    expect(readyEvents).toHaveLength(1);
    expect(handshake.consumeReady(hello.clientRequestId, 'DISCOVERY_V1')).toBe(true);

    pair.chatSide.send(hello);
    pair.chatSide.send({
      ...hello,
      expectedOwnerId: '33333333-3333-4333-8333-333333333333',
    });
    await settle();
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(readyEvents).toHaveLength(1);
    expect(handshake.consumeReady(hello.clientRequestId, 'DISCOVERY_V1')).toBe(false);
    handshake.dispose();
  });

  it('fails a saturated port closed without evicting old correlation history', async () => {
    const pair = createMockTransportPair();
    const readiness = vi.fn().mockResolvedValue('READY');
    const readyEvents: unknown[] = [];
    pair.chatSide.onMessage((message) => readyEvents.push(message));
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.0.0',
      readReadiness: readiness,
    });

    for (let index = 0; index < 257; index += 1) {
      pair.chatSide.send({
        v: 1,
        kind: 'channel/hello',
        clientRequestId: `bounded_${index}`,
        expectedOwnerId: OWNER_ID,
        requiredCapabilities: ['DISCOVERY_V1'],
      });
    }
    await settle();
    await settle();

    expect(readyEvents).toEqual([]);
    expect(handshake.consumeReady('bounded_255', 'DISCOVERY_V1')).toBe(false);
    pair.chatSide.send({
      v: 1,
      kind: 'channel/hello',
      clientRequestId: 'bounded_0',
      expectedOwnerId: OWNER_ID,
      requiredCapabilities: ['DISCOVERY_V1'],
    });
    await settle();
    expect(readyEvents).toEqual([]);
    handshake.dispose();
  });

  it('admits only the final different-owner hello after the active authority read settles', async () => {
    const pair = createMockTransportPair();
    const firstAuthority = deferred<'READY'>();
    const finalAuthority = deferred<'OWNER_MISMATCH'>();
    const readiness = vi.fn()
      .mockImplementationOnce(() => firstAuthority.promise)
      .mockImplementationOnce(() => finalAuthority.promise);
    const readyEvents: unknown[] = [];
    pair.chatSide.onMessage((message) => readyEvents.push(message));
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.0.0',
      readReadiness: readiness,
    });
    const finalOwnerId = '33333333-3333-4333-8333-333333333333';

    pair.chatSide.send({
      v: 1,
      kind: 'channel/hello',
      clientRequestId: 'active_owner',
      expectedOwnerId: OWNER_ID,
      requiredCapabilities: ['DISCOVERY_V1'],
    });
    for (let index = 0; index < 64; index += 1) {
      pair.chatSide.send({
        v: 1,
        kind: 'channel/hello',
        clientRequestId: `superseded_${index}`,
        expectedOwnerId: finalOwnerId,
        requiredCapabilities: ['DISCOVERY_V1'],
      });
    }
    await settle();

    expect(readiness).toHaveBeenCalledTimes(1);
    firstAuthority.resolve('READY');
    await settle();

    expect(readiness).toHaveBeenCalledTimes(2);
    expect(readiness).toHaveBeenLastCalledWith(finalOwnerId);
    expect(readyEvents).toEqual([]);
    finalAuthority.resolve('OWNER_MISMATCH');
    await settle();

    expect(readyEvents).toEqual([
      expect.objectContaining({
        kind: 'channel/ready',
        clientRequestId: 'superseded_63',
        state: 'OWNER_MISMATCH',
      }),
    ]);
    handshake.dispose();
  });

  it('does not start a coalesced read or ACK after disposal', async () => {
    const pair = createMockTransportPair();
    const activeAuthority = deferred<'READY'>();
    const readiness = vi.fn(() => activeAuthority.promise);
    const readyEvents: unknown[] = [];
    pair.chatSide.onMessage((message) => readyEvents.push(message));
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.0.0',
      readReadiness: readiness,
    });

    pair.chatSide.send({
      v: 1,
      kind: 'channel/hello',
      clientRequestId: 'active_before_dispose',
      expectedOwnerId: OWNER_ID,
      requiredCapabilities: ['DISCOVERY_V1'],
    });
    pair.chatSide.send({
      v: 1,
      kind: 'channel/hello',
      clientRequestId: 'pending_before_dispose',
      expectedOwnerId: '33333333-3333-4333-8333-333333333333',
      requiredCapabilities: ['DISCOVERY_V1'],
    });
    await settle();
    expect(readiness).toHaveBeenCalledTimes(1);

    handshake.dispose();
    activeAuthority.resolve('READY');
    await settle();

    expect(readiness).toHaveBeenCalledTimes(1);
    expect(readyEvents).toEqual([]);
    expect(handshake.consumeReady('pending_before_dispose', 'DISCOVERY_V1')).toBe(false);
  });

  it('sends no discovery command until current Extension proves owner/install readiness', async () => {
    const pair = createMockTransportPair();
    const sentToExtension: unknown[] = [];
    pair.extensionSide.onMessage((message) => sentToExtension.push(message));
    const readiness = vi.fn().mockResolvedValue('READY');
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.0.0',
      readReadiness: readiness,
    });
    const client = createChannelClient(pair.chatSide);

    const requestId = client.startDiscovery(MISSION_ID, '8', OWNER_ID);
    expect(sentToExtension).toEqual([]);
    await settle();

    expect(readiness).toHaveBeenCalledWith(OWNER_ID);
    expect(sentToExtension).toEqual([
      {
        v: 1,
        kind: 'channel/hello',
        clientRequestId: requestId,
        expectedOwnerId: OWNER_ID,
        requiredCapabilities: ['DISCOVERY_V1'],
      },
      {
        v: 1,
        kind: 'discovery/start',
        clientRequestId: requestId,
        missionId: MISSION_ID,
        missionRevision: '8',
      },
    ]);
    expect(handshake.consumeReady(requestId, 'DISCOVERY_V1')).toBe(true);
    expect(handshake.consumeReady(requestId, 'DISCOVERY_V1')).toBe(false);
    handshake.dispose();
    client.dispose();
  });

  it.each(['UNAUTHENTICATED', 'OWNER_MISMATCH', 'INSTALL_UNLINKED', 'AUTHORITY_UNAVAILABLE'] as const)(
    '%s ACK fails closed before target or DOM discovery',
    async (state) => {
      const pair = createMockTransportPair();
      const sentToExtension: unknown[] = [];
      pair.extensionSide.onMessage((message) => sentToExtension.push(message));
      const handshake = createExtensionHandshakeCoordinator({
        transport: pair.extensionSide,
        extensionVersion: () => '1.0.0',
        readReadiness: vi.fn().mockResolvedValue(state),
      });
      const client = createChannelClient(pair.chatSide);
      const events: unknown[] = [];
      client.onEvent((event) => events.push(event));

      client.startDiscovery(MISSION_ID, '8', OWNER_ID);
      await settle();

      expect(sentToExtension.filter((message) =>
        (message as { kind?: unknown }).kind === 'discovery/start')).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'channel/ready', state }));
      handshake.dispose();
      client.dispose();
    },
  );

  it('an old Extension with no ACK receives no discovery command', async () => {
    const pair = createMockTransportPair();
    const sentToExtension: unknown[] = [];
    pair.extensionSide.onMessage((message) => sentToExtension.push(message));
    const client = createChannelClient(pair.chatSide);

    client.startDiscovery(MISSION_ID, '8', OWNER_ID);
    await settle();

    expect(sentToExtension.map((message) => (message as { kind?: unknown }).kind))
      .toEqual(['channel/hello']);
    client.dispose();
  });

  it.each([
    ['unavailable', (): string => { throw new Error('manifest unavailable'); }],
    ['invalid', (): string => 'not-a-manifest-version'],
  ] as const)(
    'an %s manifest version performs no authority read and produces no guessed ACK',
    async (_label, extensionVersion) => {
      const pair = createMockTransportPair();
      const sentToExtension: unknown[] = [];
      pair.extensionSide.onMessage((message) => sentToExtension.push(message));
      const readiness = vi.fn().mockResolvedValue('READY');
      const handshake = createExtensionHandshakeCoordinator({
        transport: pair.extensionSide,
        extensionVersion,
        readReadiness: readiness,
      });
      const client = createChannelClient(pair.chatSide);

      client.startDiscovery(MISSION_ID, '8', OWNER_ID);
      await settle();

      expect(readiness).not.toHaveBeenCalled();
      expect(sentToExtension.map((message) => (message as { kind?: unknown }).kind))
        .toEqual(['channel/hello']);
      handshake.dispose();
      client.dispose();
    },
  );

  it.each([
    ['throwing', () => { throw new Error('clock unavailable'); }],
    ['non-finite', () => Number.NaN],
  ] as const)('a %s readiness clock fails closed without an ACK or grant', async (_label, now) => {
    const pair = createMockTransportPair();
    const readyEvents: unknown[] = [];
    pair.chatSide.onMessage((message) => readyEvents.push(message));
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.0.0',
      readReadiness: vi.fn().mockResolvedValue('READY'),
      now,
    });

    pair.chatSide.send({
      v: 1,
      kind: 'channel/hello',
      clientRequestId: 'hostile_clock',
      expectedOwnerId: OWNER_ID,
      requiredCapabilities: ['DISCOVERY_V1'],
    });
    await settle();

    expect(readyEvents).toEqual([]);
    expect(handshake.consumeReady('hostile_clock', 'DISCOVERY_V1')).toBe(false);
    handshake.dispose();
  });

  it('rejects an unconsumed READY grant at its exact bounded expiry', async () => {
    const pair = createMockTransportPair();
    let observedAt = 1_000;
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.0.0',
      readReadiness: vi.fn().mockResolvedValue('READY'),
      now: () => observedAt,
    });

    pair.chatSide.send({
      v: 1,
      kind: 'channel/hello',
      clientRequestId: 'expired_ready_grant',
      expectedOwnerId: OWNER_ID,
      requiredCapabilities: ['DISCOVERY_V1'],
    });
    await settle();

    observedAt += 30_000;
    expect(handshake.consumeReady('expired_ready_grant', 'DISCOVERY_V1')).toBe(false);
    handshake.dispose();
  });

  it('a clock failure during grant consumption fails closed without throwing', async () => {
    const pair = createMockTransportPair();
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockImplementationOnce(() => { throw new Error('clock unavailable'); });
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.0.0',
      readReadiness: vi.fn().mockResolvedValue('READY'),
      now,
    });

    pair.chatSide.send({
      v: 1,
      kind: 'channel/hello',
      clientRequestId: 'clock_fails_on_consume',
      expectedOwnerId: OWNER_ID,
      requiredCapabilities: ['DISCOVERY_V1'],
    });
    await settle();

    expect(handshake.consumeReady('clock_fails_on_consume', 'DISCOVERY_V1')).toBe(false);
    handshake.dispose();
  });

  it('direct discovery/start cannot bypass the Extension-side one-time READY grant', async () => {
    const pair = createMockTransportPair();
    const targetResolver = {
      resolve: vi.fn().mockResolvedValue({
        ok: false as const,
        code: 'TARGET_UNAVAILABLE' as const,
      }),
    };
    const scanner = {
      scan: vi.fn().mockResolvedValue({
        ok: false as const,
        code: 'SCAN_UNAVAILABLE' as const,
      }),
    };
    const handshake = createExtensionHandshakeCoordinator({
      transport: pair.extensionSide,
      extensionVersion: () => '1.0.0',
      readReadiness: vi.fn().mockResolvedValue('READY'),
    });
    const discovery = createDiscoveryCoordinator({
      transport: pair.extensionSide,
      targetResolver,
      scanner,
      authorizeStart: (ref) =>
        handshake.consumeReady(ref.clientRequestId, 'DISCOVERY_V1'),
    });

    pair.chatSide.send({
      v: 1,
      kind: 'discovery/start',
      clientRequestId: 'bypass_1',
      missionId: MISSION_ID,
      missionRevision: '8',
    });
    await settle();

    expect(targetResolver.resolve).not.toHaveBeenCalled();
    expect(scanner.scan).not.toHaveBeenCalled();
    discovery.dispose();
    handshake.dispose();
  });
});
