import { describe, expect, it, vi } from 'vitest';

import { createMissionApplicationTargetClient } from '../lib/missionApplicationTargetClient';

const MISSION_ID = '10000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-08-24T16:00:00.000Z');
const RESPONSE = {
  schemaVersion: 1,
  target: {
    missionRevision: '8',
    canonicalOrigin: 'https://boards.greenhouse.io',
    pathname: '/acme/jobs/123',
    atsProvider: 'GREENHOUSE',
    pathRuleId: 'greenhouse-application-v1',
    verifierVersion: 'greenhouse-direct-v2',
    verifiedAt: '2026-08-24T15:59:00.000Z',
    freshUntil: '2026-08-24T16:09:00.000Z',
    policyVersion: 'application-target-v1',
    revision: '7',
  },
} as const;

describe('Mission application target client', () => {
  it('returns only a fresh verified target and retries one LOGIN_REQUIRED response', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'LOGIN_REQUIRED' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(RESPONSE), { status: 200 }));
    const client = createMissionApplicationTargetClient({
      apiBase: 'https://api.edaix.io',
      getAccessToken: vi.fn().mockResolvedValue('old-token'),
      refreshAccessToken: vi.fn().mockResolvedValue('new-token'),
      fetchFn,
      now: () => NOW,
    });

    await expect(client.resolve(MISSION_ID)).resolves.toEqual({
      missionRevision: RESPONSE.target.missionRevision,
      canonicalOrigin: RESPONSE.target.canonicalOrigin,
      pathname: RESPONSE.target.pathname,
      atsProvider: RESPONSE.target.atsProvider,
      pathRuleId: RESPONSE.target.pathRuleId,
      verifierVersion: RESPONSE.target.verifierVersion,
      verifiedAt: RESPONSE.target.verifiedAt,
      freshUntil: RESPONSE.target.freshUntil,
      policyVersion: RESPONSE.target.policyVersion,
      revision: RESPONSE.target.revision,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      headers: expect.objectContaining({ authorization: 'Bearer new-token' }),
    });
  });

  it('fails closed for stale, malformed, or currently unmapped targets', async () => {
    for (const body of [
      { ...RESPONSE, target: { ...RESPONSE.target, freshUntil: '2026-08-24T16:00:00.000Z' } },
      { ...RESPONSE, target: { ...RESPONSE.target, pathname: '//evil.example/jobs/123' } },
      { ...RESPONSE, target: { ...RESPONSE.target, atsProvider: 'INDEED_APPLY' } },
    ]) {
      const client = createMissionApplicationTargetClient({
        apiBase: 'https://api.edaix.io',
        getAccessToken: async () => 'token',
        fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
        now: () => NOW,
      });
      await expect(client.resolve(MISSION_ID)).resolves.toBeNull();
    }
  });

  it('fails closed when target authority does not settle before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const client = createMissionApplicationTargetClient({
        apiBase: 'https://api.edaix.io',
        getAccessToken: () => new Promise(() => undefined),
        fetchFn: vi.fn(),
        now: () => NOW,
        timeoutMs: 25,
      });

      const resolution = client.resolve(MISSION_ID);
      await vi.advanceTimersByTimeAsync(25);

      await expect(resolution).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
