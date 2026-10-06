import { describe, expect, it, vi } from 'vitest';

import { createDiscoveryCoordinator } from '../src/discoveryCoordinator';
import { createMockTransportPair } from '../src/transport';

const REF = {
  clientRequestId: 'discovery_1',
  missionId: '11111111-1111-4111-8111-111111111111',
  missionRevision: '8',
} as const;

const NOW = Date.parse('2026-08-24T16:00:00.000Z');
const authorizeStart = () => true;

const TARGET = {
  missionRevision: REF.missionRevision,
  canonicalOrigin: 'https://boards.greenhouse.io',
  pathname: '/acme/jobs/123',
  atsProvider: 'greenhouse',
  pathRuleId: 'greenhouse-job',
  verifierVersion: 'greenhouse-direct-v2',
  verifiedAt: '2026-08-24T15:59:00.000Z',
  freshUntil: '2026-08-24T16:09:00.000Z',
  policyVersion: 'application-target-v1',
  revision: '7',
} as const;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('read-only application discovery coordinator', () => {
  it('returns only verified target projection and field keys', async () => {
    const pair = createMockTransportPair();
    const resolve = vi.fn().mockResolvedValue({ ok: true, target: TARGET });
    const scan = vi.fn().mockResolvedValue({
      ok: true,
      vendor: 'greenhouse',
      fieldKeys: ['email', 'firstName', 'lastName'],
    });
    const outbound: unknown[] = [];
    pair.chatSide.onMessage((message) => outbound.push(message));
    const coordinator = createDiscoveryCoordinator({
      transport: pair.extensionSide,
      authorizeStart,
      targetResolver: { resolve },
      scanner: { scan },
      now: () => NOW,
    });

    pair.chatSide.send({ v: 1, kind: 'discovery/start', ...REF });
    await settle();

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenNthCalledWith(1, REF);
    expect(resolve).toHaveBeenNthCalledWith(2, REF);
    expect(scan).toHaveBeenCalledWith(TARGET);
    expect(outbound).toEqual([{
      v: 1,
      kind: 'discovery/result',
      ...REF,
      status: 'AVAILABLE',
      canonicalOrigin: TARGET.canonicalOrigin,
      pathname: TARGET.pathname,
      vendor: 'greenhouse',
      freshUntil: TARGET.freshUntil,
      fieldKeys: ['email', 'firstName', 'lastName'],
    }]);
    expect(JSON.stringify(outbound)).not.toMatch(/selector|value|label|html|scanDigest|jws|lease/i);
    coordinator.dispose();
  });

  it('has no write-run, profile, receipt, or submit side effects', async () => {
    const pair = createMockTransportPair();
    const forbidden = {
      issuer: vi.fn(),
      claimer: vi.fn(),
      profileProvider: vi.fn(),
      filler: vi.fn(),
      receiptUploader: vi.fn(),
      submitter: vi.fn(),
    };
    const coordinator = createDiscoveryCoordinator({
      transport: pair.extensionSide,
      authorizeStart,
      targetResolver: {
        resolve: vi.fn().mockResolvedValue({ ok: true, target: TARGET }),
      },
      scanner: {
        scan: vi.fn().mockResolvedValue({
          ok: true,
          vendor: 'greenhouse',
          fieldKeys: ['email'],
        }),
      },
      now: () => NOW,
      ...forbidden,
    });

    pair.chatSide.send({ v: 1, kind: 'discovery/start', ...REF });
    await settle();

    for (const sideEffect of Object.values(forbidden)) {
      expect(sideEffect).not.toHaveBeenCalled();
    }
    coordinator.dispose();
  });

  it.each([
    ['target authority', { resolve: { ok: false as const, code: 'TARGET_UNAVAILABLE' as const } }, 'TARGET_UNAVAILABLE'],
    ['runtime authority', { scan: { ok: false as const, code: 'RUNTIME_UNAVAILABLE' as const } }, 'RUNTIME_UNAVAILABLE'],
    ['exact tab', { scan: { ok: false as const, code: 'TAB_UNAVAILABLE' as const } }, 'TAB_UNAVAILABLE'],
    ['page scan', { scan: { ok: false as const, code: 'SCAN_UNAVAILABLE' as const } }, 'SCAN_UNAVAILABLE'],
  ])('fails closed when %s is unavailable', async (_label, failure, expectedCode) => {
    const pair = createMockTransportPair();
    const resolve = vi.fn().mockResolvedValue(
      'resolve' in failure ? failure.resolve : { ok: true, target: TARGET },
    );
    const scan = vi.fn().mockResolvedValue(
      'scan' in failure ? failure.scan : { ok: true, vendor: 'greenhouse', fieldKeys: [] },
    );
    const outbound: unknown[] = [];
    pair.chatSide.onMessage((message) => outbound.push(message));
    const coordinator = createDiscoveryCoordinator({
      transport: pair.extensionSide,
      authorizeStart,
      targetResolver: { resolve },
      scanner: { scan },
      now: () => NOW,
    });

    pair.chatSide.send({ v: 1, kind: 'discovery/start', ...REF });
    await settle();

    expect(outbound).toEqual([{
      v: 1,
      kind: 'discovery/result',
      ...REF,
      status: 'UNAVAILABLE',
      code: expectedCode,
    }]);
    if ('resolve' in failure) expect(scan).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('turns dependency exceptions into a stable fail-closed result without details', async () => {
    const pair = createMockTransportPair();
    const outbound: unknown[] = [];
    pair.chatSide.onMessage((message) => outbound.push(message));
    const coordinator = createDiscoveryCoordinator({
      transport: pair.extensionSide,
      authorizeStart,
      targetResolver: { resolve: vi.fn().mockRejectedValue(new Error('secret target URL')) },
      scanner: { scan: vi.fn() },
      now: () => NOW,
    });

    pair.chatSide.send({ v: 1, kind: 'discovery/start', ...REF });
    await settle();

    expect(outbound).toEqual([{
      v: 1,
      kind: 'discovery/result',
      ...REF,
      status: 'UNAVAILABLE',
      code: 'TARGET_UNAVAILABLE',
    }]);
    expect(JSON.stringify(outbound)).not.toContain('secret');
    coordinator.dispose();
  });

  it('fails closed when the canonical target expires or drifts during scan', async () => {
    const pair = createMockTransportPair();
    const resolve = vi.fn()
      .mockResolvedValueOnce({ ok: true, target: TARGET })
      .mockResolvedValueOnce({
        ok: true,
        target: { ...TARGET, pathname: '/acme/jobs/456', revision: '8' },
      });
    const outbound: unknown[] = [];
    pair.chatSide.onMessage((message) => outbound.push(message));
    const coordinator = createDiscoveryCoordinator({
      transport: pair.extensionSide,
      authorizeStart,
      targetResolver: { resolve },
      scanner: {
        scan: vi.fn().mockResolvedValue({
          ok: true,
          vendor: 'greenhouse',
          fieldKeys: ['email'],
        }),
      },
      now: () => NOW,
    });

    pair.chatSide.send({ v: 1, kind: 'discovery/start', ...REF });
    await settle();

    expect(outbound).toEqual([{
      v: 1,
      kind: 'discovery/result',
      ...REF,
      status: 'UNAVAILABLE',
      code: 'TARGET_UNAVAILABLE',
    }]);
    coordinator.dispose();

    const expiredPair = createMockTransportPair();
    const expiredOutbound: unknown[] = [];
    expiredPair.chatSide.onMessage((message) => expiredOutbound.push(message));
    const expiredCoordinator = createDiscoveryCoordinator({
      transport: expiredPair.extensionSide,
      authorizeStart,
      targetResolver: {
        resolve: vi.fn().mockResolvedValue({ ok: true, target: TARGET }),
      },
      scanner: {
        scan: vi.fn().mockResolvedValue({
          ok: true,
          vendor: 'greenhouse',
          fieldKeys: ['email'],
        }),
      },
      now: () => Date.parse(TARGET.freshUntil),
    });

    expiredPair.chatSide.send({ v: 1, kind: 'discovery/start', ...REF });
    await settle();

    expect(expiredOutbound).toEqual([{
      v: 1,
      kind: 'discovery/result',
      ...REF,
      status: 'UNAVAILABLE',
      code: 'TARGET_UNAVAILABLE',
    }]);
    expiredCoordinator.dispose();
  });
});
