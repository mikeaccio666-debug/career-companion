import { describe, expect, it, vi } from 'vitest';

import type { VerifiedApplicationTarget } from '@edaix/agent-channel';
import { parseIsoDateTime } from '@edaix/contracts';
import { createExactTabDiscoveryScanner } from '../lib/discoveryScanner';
import type { BridgeEvent, BridgePortLike, BridgeRequest } from '../lib/bridgeProtocol';
import type { RuntimeExecutionAuthorization } from '../lib/executionRuntimeAuthority';

const TARGET: VerifiedApplicationTarget = {
  missionRevision: '8',
  canonicalOrigin: 'https://boards.greenhouse.io',
  pathname: '/acme/jobs/123',
  atsProvider: 'GREENHOUSE',
  pathRuleId: 'greenhouse-application-v1',
  verifierVersion: 'greenhouse-direct-v2',
  verifiedAt: requireIsoDateTime('2026-08-24T15:59:00.000Z'),
  freshUntil: requireIsoDateTime('2026-08-24T16:09:00.000Z'),
  policyVersion: 'application-target-v1',
  revision: '7',
};

function requireIsoDateTime(value: string) {
  const parsed = parseIsoDateTime(value);
  if (parsed === null) throw new Error('INVALID_TEST_ISO_DATE_TIME');
  return parsed;
}
const AUTHORIZATION: RuntimeExecutionAuthorization = {
  schemaVersion: 1,
  purpose: 'DISCOVERY',
  runtimeBundleVersion: `rb1_${'1'.repeat(64)}`,
  releaseRevision: '7',
  policyVersion: 'policy-v1',
  rulesReleaseVersion: 'rules-v1',
  rulesReleaseDigest: `sha256:${'2'.repeat(64)}`,
  atsProvider: 'GREENHOUSE',
  pathRuleId: 'greenhouse-application-v1',
  vendor: 'greenhouse',
  rulesetVersion: 'greenhouse-rules-v1',
  rulesetDigest: `sha256:${'3'.repeat(64)}`,
};

function portFor(scan: null | {
  jobId: string;
  canonicalOrigin: string;
  fieldKeys: readonly string[];
}) {
  const requests: BridgeRequest[] = [];
  const messages: Array<(value: unknown) => void> = [];
  const disconnects: Array<() => void> = [];
  const port: BridgePortLike = {
    postMessage(message) {
      const request = message as BridgeRequest;
      requests.push(request);
      if (request.kind !== 'bridge/discovery-scan') return;
      const event: BridgeEvent = {
        kind: 'bridge/discovery-result',
        requestId: request.requestId,
        scan: scan === null ? null : {
          ...scan,
          scanDigest: `sha256:${'4'.repeat(64)}`,
        },
      };
      queueMicrotask(() => messages.forEach((handler) => handler(event)));
    },
    onMessage: { addListener: (handler) => messages.push(handler) },
    onDisconnect: { addListener: (handler) => disconnects.push(handler) },
    disconnect() {},
  };
  return { port, requests };
}

describe('exact-tab read-only discovery scanner', () => {
  it('binds backend mapping to one exact pathname and returns only vendor + keys', async () => {
    const bridge = portFor({
      jobId: TARGET.pathname,
      canonicalOrigin: TARGET.canonicalOrigin,
      fieldKeys: ['email', 'firstName', 'lastName'],
    });
    const connectToTab = vi.fn(() => bridge.port);
    const revalidate = vi.fn().mockResolvedValue(true);
    const scanner = createExactTabDiscoveryScanner({
      runtimeAuthority: {
        authorizeDiscovery: vi.fn().mockResolvedValue({ ok: true, value: AUTHORIZATION }),
        revalidate,
      },
      queryTabs: async () => [
        { tabId: 7, canonicalOrigin: TARGET.canonicalOrigin, pathname: TARGET.pathname, at: 10 },
        { tabId: 8, canonicalOrigin: TARGET.canonicalOrigin, pathname: '/acme/jobs/456', at: 11 },
      ],
      connectToTab,
    });

    await expect(scanner.scan(TARGET)).resolves.toEqual({
      ok: true,
      vendor: 'greenhouse',
      fieldKeys: ['email', 'firstName', 'lastName'],
    });
    expect(connectToTab).toHaveBeenCalledWith(7);
    expect(revalidate).toHaveBeenCalledWith(AUTHORIZATION);
    expect(bridge.requests).toEqual([{
      kind: 'bridge/discovery-scan',
      requestId: 'discovery_bridge_1',
      runtime: AUTHORIZATION,
    }]);
    expect(JSON.stringify(await scanner.scan({ ...TARGET, pathname: '/acme/jobs/999' })))
      .not.toMatch(/scanDigest|selector|value|label|html/i);
  });

  it('does not connect for missing, wrong, or duplicate exact tabs', async () => {
    const connectToTab = vi.fn();
    const create = (tabs: Parameters<typeof createExactTabDiscoveryScanner>[0]['queryTabs'] extends () => Promise<infer T> ? T : never) =>
      createExactTabDiscoveryScanner({
        runtimeAuthority: {
          authorizeDiscovery: vi.fn().mockResolvedValue({ ok: true, value: AUTHORIZATION }),
          revalidate: vi.fn().mockResolvedValue(true),
        },
        queryTabs: async () => tabs,
        connectToTab,
      });

    await expect(create([]).scan(TARGET)).resolves.toEqual({ ok: false, code: 'TAB_UNAVAILABLE' });
    await expect(create([
      { tabId: 7, canonicalOrigin: TARGET.canonicalOrigin, pathname: '/acme/jobs/456', at: 10 },
    ]).scan(TARGET)).resolves.toEqual({ ok: false, code: 'TAB_UNAVAILABLE' });
    await expect(create([
      { tabId: 7, canonicalOrigin: TARGET.canonicalOrigin, pathname: TARGET.pathname, at: 10 },
      { tabId: 8, canonicalOrigin: TARGET.canonicalOrigin, pathname: TARGET.pathname, at: 11 },
    ]).scan(TARGET)).resolves.toEqual({ ok: false, code: 'TAB_UNAVAILABLE' });
    expect(connectToTab).not.toHaveBeenCalled();
  });

  it('fails closed on runtime unavailability, target mismatch, or post-scan drift', async () => {
    const bridge = portFor({
      jobId: '/acme/jobs/other',
      canonicalOrigin: TARGET.canonicalOrigin,
      fieldKeys: ['email'],
    });
    const create = (authorization: unknown, revalidated = true) =>
      createExactTabDiscoveryScanner({
        runtimeAuthority: {
          authorizeDiscovery: vi.fn().mockResolvedValue(authorization),
          revalidate: vi.fn().mockResolvedValue(revalidated),
        },
        queryTabs: async () => [
          { tabId: 7, canonicalOrigin: TARGET.canonicalOrigin, pathname: TARGET.pathname, at: 10 },
        ],
        connectToTab: () => bridge.port,
      });

    await expect(create({ ok: false, code: 'RUNTIME_AUTHORITY_UNAVAILABLE' }).scan(TARGET))
      .resolves.toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' });
    await expect(create({ ok: true, value: AUTHORIZATION }).scan(TARGET))
      .resolves.toEqual({ ok: false, code: 'SCAN_UNAVAILABLE' });

    const exactBridge = portFor({
      jobId: TARGET.pathname,
      canonicalOrigin: TARGET.canonicalOrigin,
      fieldKeys: ['email'],
    });
    const drifted = createExactTabDiscoveryScanner({
      runtimeAuthority: {
        authorizeDiscovery: vi.fn().mockResolvedValue({ ok: true, value: AUTHORIZATION }),
        revalidate: vi.fn().mockResolvedValue(false),
      },
      queryTabs: async () => [
        { tabId: 7, canonicalOrigin: TARGET.canonicalOrigin, pathname: TARGET.pathname, at: 10 },
      ],
      connectToTab: () => exactBridge.port,
    });
    await expect(drifted.scan(TARGET)).resolves.toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' });
  });

  it.each([
    ['unknown key', ['email', 'ssn']],
    ['non-canonical order', ['lastName', 'firstName']],
    ['duplicate key', ['email', 'email']],
  ])('rejects a hostile bridge projection with %s', async (_label, fieldKeys) => {
    const bridge = portFor({
      jobId: TARGET.pathname,
      canonicalOrigin: TARGET.canonicalOrigin,
      fieldKeys,
    });
    const scanner = createExactTabDiscoveryScanner({
      runtimeAuthority: {
        authorizeDiscovery: vi.fn().mockResolvedValue({ ok: true, value: AUTHORIZATION }),
        revalidate: vi.fn().mockResolvedValue(true),
      },
      queryTabs: async () => [
        { tabId: 7, canonicalOrigin: TARGET.canonicalOrigin, pathname: TARGET.pathname, at: 10 },
      ],
      connectToTab: () => bridge.port,
    });

    await expect(scanner.scan(TARGET)).resolves.toEqual({
      ok: false,
      code: 'SCAN_UNAVAILABLE',
    });
  });
});
