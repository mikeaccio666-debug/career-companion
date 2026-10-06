import { describe, expect, it, vi } from 'vitest';
import {
  PILOT_UA5_PROFILE_PAYLOAD_CONSTRAINTS,
  type PilotUa5ProfilePayloadRequest,
} from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import { createPilotUa5ProfilePayloadClient } from '../lib/pilotUa5ProfilePayloadClient';

import { binding, answerDigest, request, success } from './pilotUa5Fixtures';
import { parsePilotUa5ProfileCheck } from '@edaix/contracts/draft/pilot-ua5-profile-currentness';
const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const wireRequest = { schemaVersion: 2 as const, runRequestId: 'a'.repeat(32), request };
const bound = (payload = success()) => ({ ok: true, schemaVersion: 2, payload, originalBindingSeal: 'e30.e30.AA' });

describe('pilot UA-5 Profile payload client', () => {
  it('uses only the explicitly paired staging realm and never falls back to development', async () => {
    const fetchFn = vi.fn(async (_url: string) => json(bound()));
    const staging = {
      enabled: true, stagingEnabled: true,
      apiBase: 'https://staging-api.career-companion.invalid', portalOrigin: 'https://staging.career-companion.invalid',
      getAccessToken: async () => 'synthetic-access-token', fetchFn: fetchFn as never,
    };
    await expect(createPilotUa5ProfilePayloadClient(staging).resolve(wireRequest)).resolves.toMatchObject({ ok: true });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://staging-api.career-companion.invalid/api/v1/agent/pilot/ua5/profile-payloads');
    fetchFn.mockClear();
    for (const overrides of [
      { stagingEnabled: false }, { portalOrigin: 'https://edaix.io' },
      { apiBase: 'https://api.edaix.io' }, { apiBase: 'http://localhost:3000' },
      { portalOrigin: undefined },
    ]) {
      await expect(createPilotUa5ProfilePayloadClient({ ...staging, ...overrides }).resolve(wireRequest))
        .resolves.toMatchObject({ ok: false, code: 'PILOT_CAPABILITY_DISABLED' });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('stays inert without both the connected-dev gate and exact local API realm', async () => {
    const fetchFn = vi.fn();
    for (const input of [
      { enabled: false, apiBase: 'http://localhost:3000' },
      { enabled: true, apiBase: null },
      { enabled: true, apiBase: 'https://api.edaix.io' },
    ] as const) {
      const client = createPilotUa5ProfilePayloadClient({
        ...input,
        getAccessToken: async () => 'secret',
        fetchFn: fetchFn as never,
      });
      await expect(client.resolve(wireRequest)).resolves.toEqual({
        ok: false,
        schemaVersion: 2,
        code: 'PILOT_CAPABILITY_DISABLED',
      });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses bearer Auth and returns the strictly parsed owner-bound payload envelope', async () => {
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://localhost:3000/api/v1/agent/pilot/ua5/profile-payloads');
      expect(init).toMatchObject({
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
      expect(init.headers).toMatchObject({ authorization: 'Bearer access-token' });
      expect(JSON.parse(String(init.body))).toEqual(wireRequest);
      return json(bound());
    });
    const client = createPilotUa5ProfilePayloadClient({
      enabled: true,
      apiBase: 'http://localhost:3000',
      getAccessToken: async () => 'access-token',
      fetchFn: fetchFn as never,
    });

    const result = await client.resolve(wireRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected payload success');
    expect(result.payload.payloads[0]).toEqual({
      questionId: 'question.email',
      payloadRef: 'ua5.profile.question.email',
      answerDigest,
      value: 'ada@example.invalid',
    });
  });

  it('fails closed on missing Auth, malformed responses, and target drift', async () => {
    const noAuthFetch = vi.fn();
    const noAuth = createPilotUa5ProfilePayloadClient({
      enabled: true,
      apiBase: 'http://localhost:3000',
      getAccessToken: async () => null,
      fetchFn: noAuthFetch as never,
    });
    await expect(noAuth.resolve(wireRequest)).resolves.toMatchObject({
      ok: false,
      code: 'PILOT_UA5_PROFILE_UNAVAILABLE',
    });
    expect(noAuthFetch).not.toHaveBeenCalled();

    const malformed = createPilotUa5ProfilePayloadClient({
      enabled: true,
      apiBase: 'http://localhost:3000',
      getAccessToken: async () => 'token',
      fetchFn: vi.fn(async () => json({ ...bound(), leaked: true })) as never,
    });
    await expect(malformed.resolve(wireRequest)).resolves.toMatchObject({
      ok: false,
      code: 'PILOT_UA5_PROFILE_UNAVAILABLE',
    });

    const drifted = success();
    drifted.composition.authority.binding = {
      ...binding,
      domGeneration: hex('9'),
    };
    const drift = createPilotUa5ProfilePayloadClient({
      enabled: true,
      apiBase: 'http://localhost:3000',
      getAccessToken: async () => 'token',
      fetchFn: vi.fn(async () => json(bound(drifted))) as never,
    });
    await expect(drift.resolve(wireRequest)).resolves.toMatchObject({
      ok: false,
      code: 'PILOT_UA5_PROFILE_UNAVAILABLE',
    });
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

it('P1 rejects unsealed v1 HTTP responses and correlates the full currentness echo', async () => {
  const wireRequest = { schemaVersion: 2 as const, runRequestId: 'a'.repeat(32), request };
  const check = parsePilotUa5ProfileCheck({ runRequestId: wireRequest.runRequestId, ordinal: 1, binding,
    profileBinding: success().profileBinding, questionId: 'question.email', answerDigest })!;
  const replies: unknown[] = [success(), { ok: true, schemaVersion: 1, kind: 'MATCH_AT_READ', check: { ...check, ordinal: 2 } },
    { ok: true, schemaVersion: 1, kind: 'MATCH_AT_READ', check }];
  const fetchFn = vi.fn(async () => json(replies.shift()));
  const client = createPilotUa5ProfilePayloadClient({ enabled: true, apiBase: 'http://localhost:3000', getAccessToken: async () => 'token', fetchFn: fetchFn as never });
  expect((await client.resolve(wireRequest)).ok).toBe(false);
  expect((await client.check({ schemaVersion: 1, check, originalBindingSeal: 'e30.e30.AA' })).ok).toBe(false);
  expect((await client.check({ schemaVersion: 1, check, originalBindingSeal: 'e30.e30.AA' })).ok).toBe(true);
});

it.each(['token', 'fetch', 'body'])('P1 rejects late %s completion and does not revive an expired request', async (phase) => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const fetchFn = vi.fn(async () => {
      if (phase === 'fetch') await deferred;
      if (phase === 'body') return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => { await deferred; return JSON.stringify(bound()); } } as Response;
      return json(bound());
    });
    const client = createPilotUa5ProfilePayloadClient({ enabled: true, apiBase: 'http://localhost:3000',
      getAccessToken: async () => { if (phase === 'token') await deferred; return 'token'; }, fetchFn: fetchFn as never });
    const result = client.resolve(wireRequest);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await result).ok).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    if (phase === 'token') expect(fetchFn).not.toHaveBeenCalled();
    else expect(fetchFn).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it('P1 uses the earlier original deadline and final UTF-8 response bytes', async () => {
  let now = 1_000;
  const fetchFn = vi.fn(async () => { now = 1_100; return json(bound()); });
  const client = createPilotUa5ProfilePayloadClient({ enabled: true, apiBase: 'http://localhost:3000', now: () => now,
    getAccessToken: async () => 'token', fetchFn: fetchFn as never });
  expect((await client.resolve(wireRequest, 1_100)).ok).toBe(false);
  expect((await client.resolve(wireRequest, 1_000)).ok).toBe(false);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  const raw = JSON.stringify(bound());
  const cap = 512 * 1024, bytes = new TextEncoder().encode(raw).byteLength;
  for (const extra of [0, 1]) {
    const sized = createPilotUa5ProfilePayloadClient({ enabled: true, apiBase: 'http://localhost:3000', getAccessToken: async () => 'token',
      fetchFn: vi.fn(async () => new Response(raw + ' '.repeat(cap - bytes + extra), { headers: { 'content-type': 'application/json' } })) as never });
    expect((await sized.resolve(wireRequest)).ok).toBe(extra === 0);
  }
});
