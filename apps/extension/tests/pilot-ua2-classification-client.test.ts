import type { PilotUa2ClassificationRequest } from '@edaix/contracts/draft';
import { describe, expect, it, vi } from 'vitest';
import { createPilotUa2ClassificationClient } from '../lib/pilotUa2ClassificationClient';

const request: PilotUa2ClassificationRequest = {
  schemaVersion: 1,
  trigger: 'USER_EXACT_PAGE',
  discovery: {
    schemaVersion: 2,
    binding: {
      origin: 'https://careers.example.test',
      pathname: '/jobs/engineer',
      domGeneration: '1'.repeat(64),
    },
    controls: [{
      identityDigest: '2'.repeat(64),
      role: 'textbox',
      inputType: 'email',
      autocomplete: ['email'],
      required: true,
      accessibleName: 'Email',
      fileAccept: null,
      label: null,
      legend: null,
      options: [],
    }],
    observation: { suppressedControls: [], hiddenNotObservedCount: 0, opaqueBoundaries: [] },
  },
};

const success = {
  ok: true,
  schemaVersion: 1,
  binding: request.discovery.binding,
  classifications: [{
    identityDigest: request.discovery.controls[0]!.identityDigest,
    kind: 'CANONICAL_FIELD',
    canonicalField: 'EMAIL',
    confidence: 'HIGH',
    provenance: { source: 'AUTOCOMPLETE', semanticDigest: '3'.repeat(64) },
    reasonCode: 'CANONICAL_AUTOCOMPLETE_MATCH',
  }],
  constraints: {
    writerAuthority: 'NOT_GRANTED',
    submit: 'HUMAN_ONLY',
    activationState: 'DEFAULT_OFF',
    releaseState: 'NOT_RELEASED',
  },
} as const;

describe('pilot UA-2 classification client', () => {
  it('is default-off without an exact API base and performs zero fetches', async () => {
    const fetchFn = vi.fn();
    const client = createPilotUa2ClassificationClient({
      apiBase: null,
      getAccessToken: async () => 'token',
      fetchFn: fetchFn as never,
    });
    await expect(client.classify(request)).resolves.toEqual({
      ok: false,
      schemaVersion: 1,
      code: 'PILOT_CAPABILITY_DISABLED',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sends only the parsed value-free packet with bearer Auth and validates exact response identity', async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('omit');
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ authorization: 'Bearer token' });
      expect(JSON.parse(init.body as string)).toEqual(request);
      return response(success);
    });
    const client = createPilotUa2ClassificationClient({
      apiBase: 'https://api.example.test',
      getAccessToken: async () => 'token',
      fetchFn: fetchFn as never,
    });
    await expect(client.classify(request)).resolves.toEqual(success);
  });

  it('fails closed on malformed input, missing Auth, HTTP failure and target drift', async () => {
    const fetchFn = vi.fn(async () => response(success));
    const malformed = { ...request, selector: '#email' };
    const client = createPilotUa2ClassificationClient({
      apiBase: 'https://api.example.test',
      getAccessToken: async () => null,
      fetchFn: fetchFn as never,
    });
    await expect(client.classify(malformed as never)).resolves.toMatchObject({
      ok: false,
      code: 'PILOT_CLASSIFICATION_INPUT_INVALID',
    });
    await expect(client.classify(request)).resolves.toMatchObject({
      ok: false,
      code: 'PILOT_CLASSIFICATION_UNAVAILABLE',
    });
    expect(fetchFn).not.toHaveBeenCalled();

    const driftClient = createPilotUa2ClassificationClient({
      apiBase: 'https://api.example.test',
      getAccessToken: async () => 'token',
      fetchFn: vi.fn(async () => response({
        ...success,
        binding: { ...success.binding, domGeneration: '9'.repeat(64) },
      })) as never,
    });
    await expect(driftClient.classify(request)).resolves.toMatchObject({
      ok: false,
      code: 'PILOT_TARGET_DRIFT',
    });

    const rejectedClient = createPilotUa2ClassificationClient({
      apiBase: 'https://api.example.test',
      getAccessToken: async () => 'token',
      fetchFn: vi.fn(async () => new Response('{}', { status: 503 })) as never,
    });
    await expect(rejectedClient.classify(request)).resolves.toMatchObject({
      ok: false,
      code: 'PILOT_CLASSIFICATION_UNAVAILABLE',
    });
  });
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
