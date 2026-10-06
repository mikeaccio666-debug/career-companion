import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createTrustTelemetryClient,
  TrustTelemetryClientError,
  trustTelemetryErrorCode,
  type TrustTelemetryStore,
} from '../lib/trustTelemetryClient';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');
const IDS = [
  '123e4567-e89b-42d3-a456-426614174000',
  '223e4567-e89b-42d3-a456-426614174000',
  '323e4567-e89b-42d3-a456-426614174000',
  '423e4567-e89b-42d3-a456-426614174000',
];

const execution = () => ({
  vendor: 'greenhouse' as const,
  result: 'PARTIAL' as const,
  reasonCode: 'NO_VALUE' as const,
  counts: { fieldCount: 5, mappedCount: 4, filledCount: 3, skippedCount: 1, manualCount: 1 },
});

describe('Extension trust telemetry client', () => {
  it('maps background failures to a closed stable error contract', () => {
    expect(trustTelemetryErrorCode(new TrustTelemetryClientError('TELEMETRY_PROVIDER_DELETE_PENDING')))
      .toBe('TELEMETRY_PROVIDER_DELETE_PENDING');
    expect(trustTelemetryErrorCode(new Error('provider response body must not leak')))
      .toBe('TELEMETRY_LOCAL_FAILED');
  });

  it('is explicit-opt-in and sends nothing by default', async () => {
    const h = harness('ACCEPTED');
    await expect(h.client.captureExecution(execution())).resolves.toBe('DISABLED');
    expect(h.transport.send).not.toHaveBeenCalled();
    expect(h.values.get('trustTelemetryBuffer')).toBeUndefined();
  });

  it('buffers only strict events after opt-in, bounded to 100 items and 24 hours', async () => {
    const h = harness('RETRY');
    await h.client.setConsent(true);
    for (let index = 0; index < 102; index += 1) await h.client.captureExecution(execution());
    expect(h.values.get('trustTelemetryBuffer')).toHaveLength(100);
    expect(JSON.stringify(h.values.get('trustTelemetryBuffer'))).not.toContain('boardKey');
    expect(h.diag).toHaveBeenCalledWith('TELEMETRY_BUFFER_DROPPED');

    h.now.value += 24 * 60 * 60 * 1000 + 1;
    await h.client.flush();
    expect(h.values.get('trustTelemetryBuffer')).toEqual([]);
  });

  it('allows a per-click structure report without global consent and returns the exact copy fallback', async () => {
    const h = harness('RETRY');
    const report = await h.client.reportStructure({
      vendor: 'lever',
      rulePackVersion: 'bundled-v1',
      frameDepthBucket: 'ZERO',
      reasonCode: 'USER_REPORTED',
      counts: { fieldCount: 1, mappedCount: 0, filledCount: 0, skippedCount: 0, manualCount: 1 },
      shapes: [{ tag: 'INPUT', type: 'CHECKBOX', kind: 'UNSUPPORTED', confidenceBucket: 'ZERO', count: 1 }],
    });
    expect(report.status).toBe('COPY_AVAILABLE');
    expect(report.event.eventType).toBe('FORM_STRUCTURE_REPORT');
    expect(h.values.get('trustTelemetryBuffer')).toBeUndefined();
  });

  it('clears local diagnostics first and requests deletion for the previous identity', async () => {
    const h = harness('RETRY');
    await h.client.setConsent(true);
    await h.client.captureExecution(execution());
    const identity = h.values.get('trustTelemetryIdentity') as { id: string };
    h.transport.deleteIdentity.mockImplementation(async () => {
      expect(h.values.has('trustTelemetryIdentity')).toBe(false);
      expect(h.values.has('trustTelemetryBuffer')).toBe(false);
      return 'ACCEPTED';
    });
    await h.client.clear();
    expect(h.transport.deleteIdentity).toHaveBeenCalledWith(identity.id);
    expect(await h.client.getConsent()).toBe(false);
  });

  it('uses a deletion-only override without exposing it to ordinary telemetry sends', async () => {
    const h = harness('RETRY');
    await h.client.setConsent(true);
    await h.client.captureExecution(execution());
    const identity = h.values.get('trustTelemetryIdentity') as { id: string };
    const deletionOnly = vi.fn(async () => 'ACCEPTED' as const);

    await h.client.clear(deletionOnly);

    expect(deletionOnly).toHaveBeenCalledOnce();
    expect(deletionOnly).toHaveBeenCalledWith(identity.id);
    expect(h.transport.deleteIdentity).not.toHaveBeenCalled();
  });

  it('wires logout bearer to one deletion-only transport while public auth remains fenced', () => {
    const background = readFileSync(
      new URL('../entrypoints/background.ts', import.meta.url),
      'utf8',
    );
    expect(background).toMatch(/onBeforeLogout: async \(cleanupAccessToken\)/);
    expect(background).toMatch(/const token = deletionAccessToken;[\s\S]*deletionAccessToken = null;[\s\S]*return token;/);
    expect(background).toMatch(/refreshAccessToken: async \(\) => null/);
    expect(background).toMatch(/telemetryClient\.clear\(deletionOnlyTransport\.deleteIdentity\)/);
  });

  it('fails closed immediately when durable local clearing fails', async () => {
    const h = harness('ACCEPTED');
    await h.client.setConsent(true);
    await h.client.captureExecution(execution());
    const identity = h.values.get('trustTelemetryIdentity') as { id: string };
    const sentBeforeClear = h.transport.send.mock.calls.length;
    h.failRemove.key = 'trustTelemetryConsent';

    await expect(h.client.clear()).rejects.toMatchObject({ code: 'TELEMETRY_LOCAL_CLEAR_FAILED' });
    expect(h.values.get('trustTelemetryConsent')).toBe(true);
    expect(h.values.get('trustTelemetryDeletionPending')).toEqual({ clearPending: true, identityId: identity.id });
    await expect(h.client.captureExecution(execution())).resolves.toBe('DISABLED');
    expect(h.transport.send).toHaveBeenCalledTimes(sentBeforeClear);

    const restartedClient = h.restart();
    await expect(restartedClient.captureExecution(execution())).resolves.toBe('DISABLED');
    expect(h.transport.send).toHaveBeenCalledTimes(sentBeforeClear);
  });

  it('does not report opt-in success when durable consent storage fails', async () => {
    const h = harness('ACCEPTED');
    h.failSet.key = 'trustTelemetryConsent';

    await expect(h.client.setConsent(true)).rejects.toMatchObject({ code: 'TELEMETRY_STORAGE_UNAVAILABLE' });
    await expect(h.client.captureExecution(execution())).resolves.toBe('DISABLED');
    expect(h.transport.send).not.toHaveBeenCalled();
  });

  it('keeps provider deletion retryable without allowing later automatic sends', async () => {
    const h = harness('ACCEPTED', 'RETRY');
    await h.client.setConsent(true);
    await h.client.captureExecution(execution());
    const identity = h.values.get('trustTelemetryIdentity') as { id: string };
    const sentBeforeClear = h.transport.send.mock.calls.length;

    await expect(h.client.clear()).rejects.toMatchObject({ code: 'TELEMETRY_PROVIDER_DELETE_PENDING' });
    expect(h.values.has('trustTelemetryConsent')).toBe(false);
    expect(h.values.has('trustTelemetryIdentity')).toBe(false);
    expect(h.values.has('trustTelemetryBuffer')).toBe(false);
    expect(h.values.get('trustTelemetryDeletionPending')).toEqual({ clearPending: true, identityId: identity.id });
    await expect(h.client.captureExecution(execution())).resolves.toBe('DISABLED');
    expect(h.transport.send).toHaveBeenCalledTimes(sentBeforeClear);
    await expect(h.client.setConsent(true)).rejects.toMatchObject({ code: 'TELEMETRY_PROVIDER_DELETE_PENDING' });
    expect(h.values.has('trustTelemetryConsent')).toBe(false);

    h.transport.deleteIdentity.mockResolvedValue('ACCEPTED');
    await expect(h.client.clear()).resolves.toBeUndefined();
    expect(h.transport.deleteIdentity).toHaveBeenLastCalledWith(identity.id);
    expect(h.values.has('trustTelemetryDeletionPending')).toBe(false);
  });
});

function harness(
  result: 'ACCEPTED' | 'RETRY' | 'DISABLED',
  deletionResult: 'ACCEPTED' | 'RETRY' | 'DISABLED' = result,
) {
  const values = new Map<string, unknown>();
  const failSet: { key?: string } = {};
  const failRemove: { key?: string } = {};
  const store: TrustTelemetryStore = {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      if (failSet.key === key) throw new Error('simulated storage failure');
      values.set(key, value);
    },
    remove: async (key) => {
      if (failRemove.key === key) throw new Error('simulated storage failure');
      values.delete(key);
    },
  };
  const transport = {
    send: vi.fn(async () => result),
    deleteIdentity: vi.fn(async () => deletionResult),
  };
  const now = { value: NOW };
  let id = 0;
  const diag = vi.fn();
  const createClient = () => createTrustTelemetryClient({
    store,
    transport,
    now: () => now.value,
    uuid: () => IDS[id++ % IDS.length]!,
    onDiagnostic: diag,
    automaticDeliveryEnabled: true,
  });
  return {
    values,
    transport,
    now,
    diag,
    failSet,
    failRemove,
    client: createClient(),
    restart: createClient,
  };
}
